// Owner analytics: one payload per range feeding every dashboard tab.
// Content-free: reads only allowlisted columns/attrs. A "person" key (pid) is the person id, or the negated
// installation id for devices enrolled before invites existed, so legacy devices still show up on their own.
import type { PolicyData } from '@usage-monitor/contracts';
import type { Sql } from './app.ts';
import { ALL_ACCOUNTS, inAccounts, type AccountScope } from './auth.ts';
import { classifyRepo } from './profile.ts';

export type Range = { key: string; start: Date; end: Date; label: string };
const DAY = 86400_000;
const FIVE_HOURS = 5 * 3600_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Resolve a range key: 'five_hour', 'window', '7d', '30d', 'day:YYYY-MM-DD', or 'range:YYYY-MM-DD..YYYY-MM-DD'. */
export async function resolveRange(sql: Sql, key: string, tz = 'UTC', acct: AccountScope = ALL_ACCOUNTS): Promise<Range> {
  const end = new Date();
  if (key === 'five_hour') {
    const w = await liveWindows(sql, 'five_hour', acct);
    if (w) return { key: 'five_hour', start: new Date(w.first.getTime() - FIVE_HOURS), end: w.last, label: w.n > 1 ? `Current 5h windows (${w.n} accounts)` : 'Current 5h window' };
    return { key: 'five_hour', start: new Date(end.getTime() - FIVE_HOURS), end, label: 'Last 5 hours' };
  }
  if (key.startsWith('day:')) {
    const d = key.slice(4);
    if (DATE_RE.test(d)) {
      const [row] = await sql`
        select (${d}::date::timestamp at time zone ${tz}) as s,
               ((${d}::date + 1)::timestamp at time zone ${tz}) as e`;
      if (row) return { key, start: row.s as Date, end: row.e as Date, label: d };
    }
  }
  if (key.startsWith('range:')) {
    const [a, b] = key.slice(6).split('..');
    if (a && b && DATE_RE.test(a) && DATE_RE.test(b) && a <= b) {
      const [row] = await sql`
        select (${a}::date::timestamp at time zone ${tz}) as s,
               ((${b}::date + 1)::timestamp at time zone ${tz}) as e`;
      if (row) {
        const start = row.s as Date;
        const maxEnd = new Date(start.getTime() + 366 * DAY);
        const boundedEnd = (row.e as Date) > maxEnd ? maxEnd : (row.e as Date);
        return { key, start, end: boundedEnd, label: a === b ? a : `${a} to ${b}` };
      }
    }
  }
  if (key === '30d') return { key: '30d', start: new Date(end.getTime() - 30 * DAY), end, label: 'Last 30 days' };
  if (key === 'window') {
    const w = await liveWindows(sql, 'seven_day', acct);
    if (w) return { key: 'window', start: new Date(w.first.getTime() - 7 * DAY), end: w.last, label: w.n > 1 ? `Allowance weeks (${w.n} accounts)` : 'This allowance week' };
  }
  return { key: key === 'window' ? 'window' : '7d', start: new Date(end.getTime() - 7 * DAY), end, label: key === 'window' ? 'This allowance week' : 'Last 7 days' };
}

/**
 * Each visible account's current window (its latest live reading). Accounts reset at different times, so with
 * several the range runs from the earliest window start to the latest reset.
 * ponytail: a combined range is approximate per account; pick one account (?accountId=) for an exact window.
 */
async function liveWindows(sql: Sql, meter: string, acct: AccountScope) {
  const [w] = await sql`
    select min(resets_at) as first, max(resets_at) as last, count(*)::int as n from (
      select distinct on (account_id) resets_at from quota_snapshots
      where meter_key = ${meter} and resets_at > now() and ${inAccounts(sql, 'account_id', acct)}
      order by account_id, last_observed_at desc) w`;
  return w.n ? { first: w.first as Date, last: w.last as Date, n: w.n as number } : null;
}

const PID = (i: string) => `coalesce(${i}.person_id, -${i}.id)`;

export type PersonStats = {
  pid: number; name: string; isPerson: boolean; teamId?: number | null; teamName?: string | null;
  requests: number; cost: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; cacheHit: number;
  sessions: number; activeDays: number; nightPct: number; sdkPct: number; subagentPct: number; topModel: string | null;
  repoCost: { work: number; outside: number; none: number };
  prompts: number; avgPromptLength: number; toolCalls: number; toolFailures: number;
  decisions: number; bypassPct: number; compactions: number; apiErrors: number;
  labels: Record<string, number>;
  claude: { commits: number; prs: number; added: number; removed: number; activeUserSec: number; activeCliSec: number; editsAccepted: number; editsRejected: number };
  gitlab: { commits: number; additions: number; deletions: number };
  overlaps: number; sharedTokens: { fp: string; other: string }[];
  daily: { day: string; cost: number }[]; // last 29 local days, for the personal baseline
};

export async function peopleStats(sql: Sql, r: Range, policy: PolicyData, teamIds: number[] | null = null): Promise<PersonStats[]> {
  const tz = policy.displayTimezone;
  const pid = sql.unsafe(PID('i'));
  const all = teamIds === null;
  const tids = teamIds ?? [];
  const [usage, repos, act, labels, metrics, gitlab, daily, overlaps, shared] = await Promise.all([
    sql`select ${pid} as pid, coalesce(p.name, i.name) as name, bool_or(i.person_id is not null) as is_person,
          count(*)::int as requests, coalesce(sum(e.cost_usd), 0)::float8 as cost,
          sum(e.input_tokens)::float8 as input, sum(e.output_tokens)::float8 as output,
          sum(e.cache_read_tokens)::float8 as cache_read, sum(e.cache_creation_tokens)::float8 as cache_creation,
          count(distinct e.session_id)::int as sessions,
          count(distinct (e.event_time at time zone ${tz})::date)::int as active_days,
          count(*) filter (where extract(hour from e.event_time at time zone ${tz}) < 6)::int as night,
          count(*) filter (where e.entrypoint like 'sdk%')::int as sdk,
          coalesce(sum(e.cost_usd) filter (where e.query_source = 'subagent'), 0)::float8 as subagent_cost,
          mode() within group (order by e.model) as top_model
        from usage_events e join installations i on i.id = e.installation_id left join people p on p.id = i.person_id
        where e.event_time >= ${r.start} and e.event_time < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1, 2`,
    sql`select ${pid} as pid, e.repo, coalesce(sum(e.cost_usd), 0)::float8 as cost
        from usage_events e join installations i on i.id = e.installation_id left join people p on p.id = i.person_id
        where e.event_time >= ${r.start} and e.event_time < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1, 2`,
    sql`select ${pid} as pid,
          count(*) filter (where a.event_name = 'tool_decision')::int as decisions,
          count(*) filter (where a.event_name = 'tool_decision' and a.attrs->>'permission_mode' = 'bypassPermissions')::int as bypass,
          count(*) filter (where a.event_name = 'user_prompt')::int as prompts,
          coalesce(avg((a.attrs->>'prompt_length')::numeric) filter (where a.event_name = 'user_prompt'), 0)::float8 as avg_prompt,
          count(*) filter (where a.event_name = 'tool_result')::int as tool_calls,
          count(*) filter (where a.event_name = 'tool_result' and a.attrs->>'success' = 'false')::int as tool_failures,
          count(*) filter (where a.event_name = 'compaction')::int as compactions,
          count(*) filter (where a.event_name = 'api_error')::int as api_errors
        from activity_events a join installations i on i.id = a.installation_id left join people p on p.id = i.person_id
        where a.event_time >= ${r.start} and a.event_time < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1`,
    sql`select ${pid} as pid, a.attrs->>'category' as category, count(*)::int as n
        from activity_events a join installations i on i.id = a.installation_id left join people p on p.id = i.person_id
        where a.event_name = 'prompt_label' and a.event_time >= ${r.start} and a.event_time < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1, 2`,
    sql`select ${pid} as pid,
          coalesce(sum(m.value) filter (where m.name = 'commit.count'), 0)::float8 as commits,
          coalesce(sum(m.value) filter (where m.name = 'pull_request.count'), 0)::float8 as prs,
          coalesce(sum(m.value) filter (where m.name = 'lines_of_code.count' and m.attrs->>'type' = 'added'), 0)::float8 as added,
          coalesce(sum(m.value) filter (where m.name = 'lines_of_code.count' and m.attrs->>'type' = 'removed'), 0)::float8 as removed,
          coalesce(sum(m.value) filter (where m.name = 'active_time.total' and m.attrs->>'type' = 'user'), 0)::float8 as active_user,
          coalesce(sum(m.value) filter (where m.name = 'active_time.total' and m.attrs->>'type' = 'cli'), 0)::float8 as active_cli,
          coalesce(sum(m.value) filter (where m.name = 'code_edit_tool.decision' and m.attrs->>'decision' = 'accept'), 0)::float8 as accepted,
          coalesce(sum(m.value) filter (where m.name = 'code_edit_tool.decision' and m.attrs->>'decision' = 'reject'), 0)::float8 as rejected
        from metric_points m join installations i on i.id = m.installation_id left join people p on p.id = i.person_id
        where m.end_time >= ${r.start} and m.end_time < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1`,
    sql`select p.id as pid, count(*)::int as commits, sum(g.additions)::int as additions, sum(g.deletions)::int as deletions
        from git_commits g join people p on g.author_email = any(p.git_emails)
        where g.committed_at >= ${r.start} and g.committed_at < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1`,
    sql`select ${pid} as pid, (e.event_time at time zone ${tz})::date::text as day, coalesce(sum(e.cost_usd), 0)::float8 as cost
        from usage_events e join installations i on i.id = e.installation_id left join people p on p.id = i.person_id
        where e.event_time >= ${new Date(r.end.getTime() - 29 * DAY)} and e.event_time < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1, 2 order by 2`,
    // Sessions running at the same time on two different devices of one person.
    sql`with s as (
          select ${pid} as pid, e.installation_id as inst, e.session_id, min(e.event_time) as st, max(e.event_time) as en
          from usage_events e join installations i on i.id = e.installation_id left join people p on p.id = i.person_id
          where e.event_time >= ${r.start} and e.event_time < ${r.end} and e.session_id is not null
            and (${all} or p.team_id = any(${tids}::bigint[]))
          group by 1, 2, 3)
        select a.pid, count(*)::int as n from s a join s b
          on a.pid = b.pid and a.inst < b.inst and a.st < b.en and b.st < a.en group by 1`,
    // Setup tokens seen on devices of more than one person.
    sql`select distinct ${pid} as pid, left(c.fingerprint, 12) as fp, coalesce(p2.name, i2.name) as other
        from credential_bindings b
        join installations i on i.id = b.installation_id
        left join people p on p.id = i.person_id
        join credentials c on c.id = b.credential_id
        join credential_bindings b2 on b2.credential_id = b.credential_id
        join installations i2 on i2.id = b2.installation_id
        left join people p2 on p2.id = i2.person_id
        where ${pid} <> coalesce(i2.person_id, -i2.id) and b.last_seen_at >= ${r.start}
          and (${all} or p.team_id = any(${tids}::bigint[]))`,
  ]);

  const by = (rows: readonly any[], id: number): any[] => rows.filter((x) => Number(x.pid) === id);
  // Everyone with activity in range, plus invited people with none (so the table lists the whole team).
  const named = await sql`
    select p.id, p.name, p.team_id, t.name as team_name
    from people p left join teams t on t.id = p.team_id
    where (${all} or p.team_id = any(${tids}::bigint[]))
    order by p.name`;
  const ids = new Map<number, { name: string; isPerson: boolean; teamId: number | null; teamName: string | null }>();
  for (const p of named) ids.set(Number(p.id), { name: p.name, isPerson: true, teamId: p.team_id === null ? null : Number(p.team_id), teamName: (p.team_name as string | null) ?? null });
  for (const u of usage) if (!ids.has(Number(u.pid))) ids.set(Number(u.pid), { name: u.name, isPerson: u.is_person, teamId: null, teamName: null });

  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
  return [...ids].map(([id, who]) => {
    const u = by(usage, id)[0];
    const a = by(act, id)[0];
    const m = by(metrics, id)[0];
    const g = by(gitlab, id)[0];
    const repoCost = { work: 0, outside: 0, none: 0 };
    for (const x of by(repos, id)) repoCost[classifyRepo(x.repo, policy.workNamespaces)] += x.cost;
    const requests = u?.requests ?? 0;
    const cacheDen = (u?.input ?? 0) + (u?.cache_read ?? 0) + (u?.cache_creation ?? 0);
    return {
      pid: id, name: who.name, isPerson: who.isPerson, teamId: who.teamId, teamName: who.teamName,
      requests, cost: u?.cost ?? 0, inputTokens: u?.input ?? 0, outputTokens: u?.output ?? 0,
      cacheReadTokens: u?.cache_read ?? 0, cacheCreationTokens: u?.cache_creation ?? 0,
      cacheHit: cacheDen ? (u.cache_read / cacheDen) : 0,
      sessions: u?.sessions ?? 0, activeDays: u?.active_days ?? 0,
      nightPct: pct(u?.night ?? 0, requests), sdkPct: pct(u?.sdk ?? 0, requests),
      subagentPct: pct(u?.subagent_cost ?? 0, u?.cost ?? 0), topModel: u?.top_model ?? null,
      repoCost,
      prompts: a?.prompts ?? 0, avgPromptLength: Math.round(a?.avg_prompt ?? 0),
      toolCalls: a?.tool_calls ?? 0, toolFailures: a?.tool_failures ?? 0,
      decisions: a?.decisions ?? 0, bypassPct: pct(a?.bypass ?? 0, a?.decisions ?? 0),
      compactions: a?.compactions ?? 0, apiErrors: a?.api_errors ?? 0,
      labels: Object.fromEntries(by(labels, id).map((l) => [l.category, l.n])),
      claude: {
        commits: m?.commits ?? 0, prs: m?.prs ?? 0, added: m?.added ?? 0, removed: m?.removed ?? 0,
        activeUserSec: m?.active_user ?? 0, activeCliSec: m?.active_cli ?? 0,
        editsAccepted: m?.accepted ?? 0, editsRejected: m?.rejected ?? 0,
      },
      gitlab: { commits: g?.commits ?? 0, additions: g?.additions ?? 0, deletions: g?.deletions ?? 0 },
      overlaps: by(overlaps, id)[0]?.n ?? 0,
      sharedTokens: by(shared, id).map((s) => ({ fp: s.fp, other: s.other })),
      daily: by(daily, id).map((d) => ({ day: d.day, cost: d.cost })),
    };
  });
}

export type Flag = {
  key: string; pid: number; person: string; severity: 'alert' | 'watch';
  title: string; evidence: string; caveat: string;
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/**
 * Evidence-backed flags. Thresholds come from owner policy; each flag says what it can't prove.
 * Minimum volumes keep tiny samples from flagging anyone.
 */
export function flagsFor(s: PersonStats, policy: PolicyData, today: string): Flag[] {
  const out: Flag[] = [];
  const add = (key: string, severity: Flag['severity'], title: string, evidence: string, caveat: string) =>
    out.push({ key: `${s.pid}:${key}`, pid: s.pid, person: s.name, severity, title, evidence, caveat });
  const usd = (n: number) => `$${n.toFixed(2)}`;

  const L = s.labels;
  if (L['credential-pasted']) add('credential', 'alert', `Pasted what looks like a secret ${L['credential-pasted']}×`,
    'The on-device check matched an API key, token or private key pattern in a prompt. Only the label was sent.',
    'Example or revoked keys match too. They were shown a notice each time; rotating the key is the safe default.');
  if (L['jailbreak-attempt']) add('jailbreak', 'alert', `${L['jailbreak-attempt']} prompt${L['jailbreak-attempt'] > 1 ? 's' : ''} matched jailbreak phrasing`,
    'Phrases like "ignore previous instructions" or "no restrictions". Anthropic’s usage policy prohibits bypassing safeguards.',
    'Keyword match: discussing or testing prompt injection for work reads the same.');
  for (const s2 of s.sharedTokens) add(`shared-${s2.fp}`, 'alert', `Setup token ${s2.fp} is also used by ${s2.other}`,
    'The same token fingerprint was reported from devices that belong to two people.',
    'A token copied while helping someone set up shows the same way. Ask before assuming.');
  if ((L['non-work'] ?? 0) >= 3) add('non-work', 'watch', `${L['non-work']} prompts matched non-work topics`,
    'Keywords such as résumés, homework, freelance platforms or social media content.', 'Keyword match with low precision; read it as a reason to ask, not a finding.');
  if ((L['bulk-generation'] ?? 0) >= 3) add('bulk', 'watch', `${L['bulk-generation']} bulk-generation prompts`,
    'Prompts asking for dozens of articles, posts, emails or reviews at once.', 'Test fixtures and seed data can look like this.');
  if (s.overlaps > 0) add('overlap', 'watch', `Sessions ran on two of their devices at once, ${s.overlaps}×`,
    'Claude Code sessions with overlapping activity on different devices enrolled under this person.',
    'A long agent run left going on one machine while working on another looks identical.');

  const prior = s.daily.filter((d) => d.day !== today && d.cost > 0).map((d) => d.cost);
  const todayCost = s.daily.find((d) => d.day === today)?.cost ?? 0;
  const base = median(prior);
  if (prior.length >= 5 && todayCost >= 2 && todayCost >= policy.flagSpikeMultiple * base) {
    add('spike', 'watch', `Today is ${(todayCost / base).toFixed(1)}× their usual day`,
      `${usd(todayCost)} today vs a median of ${usd(base)} over their last ${prior.length} active days (API prices).`,
      'Deadlines, big refactors and long agent runs spike legitimately.');
  }
  const total = s.repoCost.work + s.repoCost.outside + s.repoCost.none;
  const outside = total ? Math.round((s.repoCost.outside / total) * 100) : 0;
  const none = total ? Math.round((s.repoCost.none / total) * 100) : 0;
  if (policy.workNamespaces.length && total >= 1 && outside >= policy.flagOutsideWorkPct) add('outside', 'watch', `${outside}% of work outside work repositories`,
    `${usd(s.repoCost.outside)} of ${usd(total)} in repositories not under your work namespaces.`,
    'Forks, scratch repos for work tasks, or a namespace missing from Settings count as outside.');
  if (total >= 1 && none >= policy.flagNoRepoPct) add('no-repo', 'watch', `${none}% of work ran outside any repository`,
    `${usd(s.repoCost.none)} of ${usd(total)} with no git remote: often chat-style use rather than coding.`,
    'Quick questions, docs and scratch folders also have no repository.');
  if (s.requests >= 20 && s.nightPct >= policy.flagNightPct) add('night', 'watch', `${s.nightPct}% of requests between 00:00 and 06:00`,
    `${policy.displayTimezone} time, over ${s.requests} requests.`, 'Agents and scheduled jobs keep working overnight with nobody at the keyboard.');
  if (s.requests >= 50 && s.sdkPct >= policy.flagSdkPct) add('sdk', 'watch', `${s.sdkPct}% of requests came from scripts`,
    'Headless or SDK entrypoints rather than the interactive CLI. Heavy scripted use of a shared account can mean automation or resale.',
    'CI jobs, editor integrations and their own tooling are legitimate scripted use.');
  if (s.decisions >= 20 && s.bypassPct >= policy.flagBypassPct) add('bypass', 'watch', `${s.bypassPct}% of tool calls ran with permissions bypassed`,
    `${s.decisions} tool decisions; bypassPermissions skips every approval prompt.`, 'Common inside sandboxes and containers, where it is safe.');
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'alert' ? -1 : 1));
}

export async function analytics(sql: Sql, rangeKey: string, policy: PolicyData, gitlabConfigured: boolean, teamIds: number[] | null = null, acct: AccountScope = ALL_ACCOUNTS) {
  const tz = policy.displayTimezone;
  const r = await resolveRange(sql, rangeKey, tz, acct);
  const pid = sql.unsafe(PID('i'));
  const all = teamIds === null;
  const tids = teamIds ?? [];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()); // YYYY-MM-DD
  const stats = await peopleStats(sql, r, policy, teamIds);

  const [burn, daily, repoPeople, repoClaude, repoGit, heat, tools, modes, entry, sources, errors, subagents, claudeDaily, gitDaily, edits, unmapped, sync, models, reviews, efforts, guardRows] = await Promise.all([
    sql`select account_id, meter_key, used_percentage::float8 as pct, extract(epoch from resets_at)::float8 as resets_at,
          extract(epoch from first_observed_at)::float8 as t0, extract(epoch from last_observed_at)::float8 as t1
        from quota_snapshots where meter_key in ('five_hour', 'seven_day') and last_observed_at >= ${r.start}
          and ${inAccounts(sql, 'account_id', acct)}
        order by first_observed_at`,
    sql`select (e.event_time at time zone ${tz})::date::text as day, ${pid} as pid,
          coalesce(sum(e.cost_usd), 0)::float8 as cost, count(*)::int as requests
        from usage_events e join installations i on i.id = e.installation_id left join people p on p.id = i.person_id
        where e.event_time >= ${r.start} and e.event_time < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1, 2 order by 1`,
    sql`select coalesce(e.repo, '') as repo, ${pid} as pid, coalesce(sum(e.cost_usd), 0)::float8 as cost,
          count(*)::int as requests, count(distinct e.session_id)::int as sessions
        from usage_events e join installations i on i.id = e.installation_id left join people p on p.id = i.person_id
        where e.event_time >= ${r.start} and e.event_time < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1, 2`,
    sql`select coalesce(m.repo, '') as repo,
          coalesce(sum(m.value) filter (where m.name = 'commit.count'), 0)::float8 as commits,
          coalesce(sum(m.value) filter (where m.name = 'pull_request.count'), 0)::float8 as prs,
          coalesce(sum(m.value) filter (where m.name = 'lines_of_code.count' and m.attrs->>'type' = 'added'), 0)::float8 as added,
          coalesce(sum(m.value) filter (where m.name = 'lines_of_code.count' and m.attrs->>'type' = 'removed'), 0)::float8 as removed
        from metric_points m join installations i on i.id = m.installation_id left join people p on p.id = i.person_id
        where m.end_time >= ${r.start} and m.end_time < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1`,
    // Strictly enrolled teammates (and scoped by team) so external org commits never leak into team Git totals.
    sql`select g.repo, count(*)::int as commits, sum(g.additions)::int as additions, sum(g.deletions)::int as deletions,
          count(distinct p.id)::int as authors
        from git_commits g join people p on g.author_email = any(p.git_emails)
        where g.committed_at >= ${r.start} and g.committed_at < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1`,
    sql`select extract(isodow from e.event_time at time zone ${tz})::int as dow, extract(hour from e.event_time at time zone ${tz})::int as hour,
          count(*)::int as requests
        from usage_events e join installations i on i.id = e.installation_id left join people p on p.id = i.person_id
        where e.event_time >= ${r.start} and e.event_time < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1, 2`,
    sql`select a.attrs->>'tool_name' as tool, count(*)::int as calls,
          count(*) filter (where a.attrs->>'success' = 'false')::int as failures,
          percentile_cont(0.5) within group (order by (a.attrs->>'duration_ms')::float8) as p50,
          percentile_cont(0.95) within group (order by (a.attrs->>'duration_ms')::float8) as p95
        from activity_events a join installations i on i.id = a.installation_id left join people p on p.id = i.person_id
        where a.event_name = 'tool_result' and a.event_time >= ${r.start} and a.event_time < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1 order by calls desc limit 20`,
    sql`select ${pid} as pid, coalesce(a.attrs->>'permission_mode', 'unknown') as key, count(*)::int as n
        from activity_events a join installations i on i.id = a.installation_id left join people p on p.id = i.person_id
        where a.event_name = 'tool_decision' and a.event_time >= ${r.start} and a.event_time < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1, 2`,
    sql`select ${pid} as pid, coalesce(e.entrypoint, 'unknown') as key, count(*)::int as n
        from usage_events e join installations i on i.id = e.installation_id left join people p on p.id = i.person_id
        where e.event_time >= ${r.start} and e.event_time < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1, 2`,
    sql`select ${pid} as pid, coalesce(e.query_source, 'unknown') as key, count(*)::int as n
        from usage_events e join installations i on i.id = e.installation_id left join people p on p.id = i.person_id
        where e.event_time >= ${r.start} and e.event_time < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1, 2`,
    sql`select coalesce(a.attrs->>'status_code', 'unknown') as status, count(*)::int as n
        from activity_events a join installations i on i.id = a.installation_id left join people p on p.id = i.person_id
        where a.event_name = 'api_error' and a.event_time >= ${r.start} and a.event_time < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1 order by n desc`,
    sql`select coalesce(a.attrs->>'agent_type', 'unknown') as agent, count(*)::int as n
        from activity_events a join installations i on i.id = a.installation_id left join people p on p.id = i.person_id
        where a.event_name = 'subagent_completed' and a.event_time >= ${r.start} and a.event_time < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1 order by n desc limit 10`,
    sql`select (m.end_time at time zone ${tz})::date::text as day, ${pid} as pid,
          coalesce(sum(m.value) filter (where m.name = 'commit.count'), 0)::float8 as commits,
          coalesce(sum(m.value) filter (where m.name = 'pull_request.count'), 0)::float8 as prs,
          coalesce(sum(m.value) filter (where m.name = 'lines_of_code.count' and m.attrs->>'type' = 'added'), 0)::float8 as added,
          coalesce(sum(m.value) filter (where m.name = 'lines_of_code.count' and m.attrs->>'type' = 'removed'), 0)::float8 as removed
        from metric_points m join installations i on i.id = m.installation_id left join people p on p.id = i.person_id
        where m.end_time >= ${r.start} and m.end_time < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1, 2 order by 1`,
    sql`select (g.committed_at at time zone ${tz})::date::text as day, p.id as pid, count(*)::int as commits
        from git_commits g join people p on g.author_email = any(p.git_emails)
        where g.committed_at >= ${r.start} and g.committed_at < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1, 2 order by 1`,
    sql`select coalesce(m.attrs->>'tool_name', 'unknown') as tool,
          coalesce(sum(m.value) filter (where m.attrs->>'decision' = 'accept'), 0)::float8 as accepted,
          coalesce(sum(m.value) filter (where m.attrs->>'decision' = 'reject'), 0)::float8 as rejected
        from metric_points m join installations i on i.id = m.installation_id left join people p on p.id = i.person_id
        where m.name = 'code_edit_tool.decision' and m.end_time >= ${r.start} and m.end_time < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1`,
    sql`select g.author_email as email, count(*)::int as commits,
          array_agg(distinct g.repo order by g.repo) as repos,
          max(g.committed_at) as last_commit_at
        from git_commits g
        where g.committed_at >= ${r.start} and g.committed_at < ${r.end}
          and not exists (select 1 from people p where g.author_email = any(p.git_emails))
        group by 1 order by commits desc limit 30`,
    sql`select greatest((select max(synced_until) from git_sync), (select max(synced_until) from github_sync)) as at`,
    sql`select e.model, ${pid} as pid, count(*)::int as calls,
          sum(e.input_tokens)::float8 as input, sum(e.output_tokens)::float8 as output,
          sum(e.cache_read_tokens)::float8 as cache_read, sum(e.cache_creation_tokens)::float8 as cache_creation,
          coalesce(sum(e.cost_usd), 0)::float8 as cost
        from usage_events e join installations i on i.id = e.installation_id left join people p on p.id = i.person_id
        where e.event_time >= ${r.start} and e.event_time < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1, 2`,
    sql`select flag_key, note, reviewed_at from flag_reviews where reviewed_at > now() - interval '7 days'`,
    sql`select coalesce(e.effort, 'unspecified') as effort, count(*)::int as requests,
          count(distinct e.session_id)::int as sessions, coalesce(sum(e.cost_usd), 0)::float8 as cost
        from usage_events e join installations i on i.id = e.installation_id left join people p on p.id = i.person_id
        where e.event_time >= ${r.start} and e.event_time < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1 order by cost desc`,
    sql`select count(*) filter (where a.attrs->>'action' = 'blocked')::int as blocked,
          count(*) filter (where a.attrs->>'action' = 'warned')::int as warned
        from activity_events a join installations i on i.id = a.installation_id left join people p on p.id = i.person_id
        where a.event_name = 'guard_event' and a.event_time >= ${r.start} and a.event_time < ${r.end}
          and (${all} or p.team_id = any(${tids}::bigint[]))`,
  ]);

  // One row per model, with each person's part of it.
  const byModel = new Map<string, any>();
  for (const m of models) {
    const o = byModel.get(m.model) ?? byModel.set(m.model, {
      model: m.model, calls: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0, people: [] as { pid: number; cost: number; calls: number }[],
    }).get(m.model);
    o.calls += m.calls; o.input += m.input; o.output += m.output; o.cacheRead += m.cache_read; o.cacheCreation += m.cache_creation; o.cost += m.cost;
    o.people.push({ pid: Number(m.pid), cost: m.cost, calls: m.calls });
  }
  const reviewed = new Map(reviews.map((x) => [x.flag_key as string, { note: x.note as string, at: (x.reviewed_at as Date).toISOString() }]));

  // Merge per-repo views into one row per repository.
  const repos = new Map<string, any>();
  const row = (repo: string) => repos.get(repo) ?? repos.set(repo, {
    repo: repo || null, class: classifyRepo(repo || null, policy.workNamespaces), cost: 0, requests: 0, sessions: 0,
    people: [] as { pid: number; cost: number }[], claude: { commits: 0, prs: 0, added: 0, removed: 0 },
    gitlab: { commits: 0, additions: 0, deletions: 0, authors: 0 },
  }).get(repo);
  for (const x of repoPeople) {
    const o = row(x.repo);
    o.cost += x.cost; o.requests += x.requests; o.sessions += x.sessions;
    o.people.push({ pid: Number(x.pid), cost: x.cost });
  }
  for (const x of repoClaude) Object.assign(row(x.repo).claude, { commits: x.commits, prs: x.prs, added: x.added, removed: x.removed });
  for (const x of repoGit) Object.assign(row(x.repo).gitlab, { commits: x.commits, additions: x.additions, deletions: x.deletions, authors: x.authors });

  const n = (rows: any[]) => rows.map((x) => ({ ...x, pid: x.pid === null ? null : Number(x.pid) }));
  return {
    range: { key: r.key, start: r.start.toISOString(), end: r.end.toISOString(), label: r.label },
    timezone: tz,
    people: stats.map(({ daily: _d, ...s }) => s),
    flags: stats.flatMap((s) => flagsFor(s, policy, today)).map((f) => ({ ...f, review: reviewed.get(f.key) ?? null })).sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'alert' ? -1 : 1)),
    burn: burn.map((b) => ({ accountId: b.account_id === null ? null : Number(b.account_id), meterKey: b.meter_key, pct: b.pct, resetsAt: b.resets_at, t0: b.t0, t1: b.t1 })),
    daily: n(daily),
    models: [...byModel.values()].sort((x, y) => y.cost - x.cost),
    efforts: efforts.map((e) => ({ effort: e.effort as string, requests: e.requests as number, sessions: e.sessions as number, cost: e.cost as number })),
    guard: { blocked: (guardRows[0]?.blocked as number) ?? 0, warned: (guardRows[0]?.warned as number) ?? 0 },
    repos: [...repos.values()].sort((a, b) => b.cost - a.cost),
    activity: {
      heatmap: heat, tools, permissionModes: n(modes), entrypoints: n(entry), querySources: n(sources), errors, subagents,
    },
    git: {
      gitlabConfigured, lastSync: sync[0]?.at?.toISOString() ?? null,
      claudeDaily: n(claudeDaily), gitlabDaily: n(gitDaily), edits,
      unmappedAuthors: unmapped.map((u) => ({
        email: u.email as string,
        commits: u.commits as number,
        repos: (u.repos as string[] | null) ?? [],
        lastCommitAt: u.last_commit_at ? (u.last_commit_at as Date).toISOString() : null,
      })),
    },
  };
}
