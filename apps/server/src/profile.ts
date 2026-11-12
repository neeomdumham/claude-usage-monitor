// Per-person usage profile for the owner dashboard: what kind of work, when, with which tools.
// Content-free by construction: it only reads columns and allowlisted attrs written by otlp.ts.
import type { PolicyData } from '@usage-monitor/contracts';
import type { Sql } from './app.ts';

const DAYS = 7;
const NIGHT = { from: 0, to: 6 }; // ponytail: fixed 00:00-06:00 local; make it a policy field if anyone works shifts

export type RepoClass = 'work' | 'outside' | 'none';
export const classifyRepo = (repo: string | null, workNamespaces: string[]): RepoClass =>
  !repo ? 'none' : workNamespaces.some((ns) => repo.startsWith(ns.toLowerCase().replace(/\/*$/, '/')) || repo === ns.toLowerCase().replace(/\/*$/, '')) ? 'work' : 'outside';

export type Flag = { key: string; title: string; evidence: string; caveat: string };

export async function profile(sql: Sql, personId: number, policy: PolicyData) {
  const [person] = await sql`select id, name from people where id = ${personId}`;
  if (!person) return null;
  const since = new Date(Date.now() - DAYS * 86400_000);
  const tz = policy.displayTimezone;
  const mine = sql`select id from installations where person_id = ${personId}`;

  const [totals, hours, repos, models, sources, tools, decisions, compactions, prompts, subagents, errors, shared] = await Promise.all([
    sql`select count(*)::int as requests, coalesce(sum(cost_usd), 0)::float8 as cost, coalesce(sum(output_tokens), 0)::float8 as output
        from usage_events where installation_id in (${mine}) and event_time >= ${since}`,
    sql`select extract(isodow from event_time at time zone ${tz})::int as dow, extract(hour from event_time at time zone ${tz})::int as hour,
          count(*)::int as requests
        from usage_events where installation_id in (${mine}) and event_time >= ${since} group by 1, 2`,
    sql`select repo, count(*)::int as requests, coalesce(sum(cost_usd), 0)::float8 as cost
        from usage_events where installation_id in (${mine}) and event_time >= ${since} group by 1 order by cost desc`,
    sql`select model, coalesce(effort, '') as effort, count(*)::int as requests, coalesce(sum(cost_usd), 0)::float8 as cost
        from usage_events where installation_id in (${mine}) and event_time >= ${since} group by 1, 2 order by cost desc`,
    sql`select coalesce(query_source, 'unknown') as source, count(*)::int as requests, coalesce(sum(cost_usd), 0)::float8 as cost
        from usage_events where installation_id in (${mine}) and event_time >= ${since} group by 1 order by cost desc`,
    sql`select attrs->>'tool_name' as tool, count(*)::int as calls,
          count(*) filter (where attrs->>'success' = 'false')::int as failures
        from activity_events where installation_id in (${mine}) and event_time >= ${since} and event_name = 'tool_result'
        group by 1 order by calls desc limit 15`,
    sql`select coalesce(attrs->>'permission_mode', 'unknown') as mode, count(*)::int as n
        from activity_events where installation_id in (${mine}) and event_time >= ${since} and event_name = 'tool_decision'
        group by 1 order by n desc`,
    sql`select coalesce(attrs->>'trigger', 'unknown') as trigger, count(*)::int as n
        from activity_events where installation_id in (${mine}) and event_time >= ${since} and event_name = 'compaction' group by 1`,
    sql`select count(*)::int as n, coalesce(avg((attrs->>'prompt_length')::numeric), 0)::float8 as avg_length
        from activity_events where installation_id in (${mine}) and event_time >= ${since} and event_name = 'user_prompt'`,
    sql`select coalesce(attrs->>'agent_type', 'unknown') as agent, count(*)::int as n
        from activity_events where installation_id in (${mine}) and event_time >= ${since} and event_name = 'subagent_completed'
        group by 1 order by n desc limit 10`,
    sql`select coalesce(attrs->>'status_code', 'unknown') as status, count(*)::int as n
        from activity_events where installation_id in (${mine}) and event_time >= ${since} and event_name = 'api_error'
        group by 1 order by n desc`,
    // This person's setup tokens that also showed up on someone else's devices.
    sql`select distinct left(c.fingerprint, 12) as fp, p.name as other
        from credential_bindings b
        join installations i on i.id = b.installation_id and i.person_id = ${personId}
        join credentials c on c.id = b.credential_id
        join credential_bindings b2 on b2.credential_id = b.credential_id
        join installations i2 on i2.id = b2.installation_id and i2.person_id <> ${personId}
        join people p on p.id = i2.person_id
        where b.last_seen_at >= ${since}`,
  ]);

  const t = totals[0];
  const byClass = { work: 0, outside: 0, none: 0 };
  const repoRows = repos.map((r) => {
    const cls = classifyRepo(r.repo, policy.workNamespaces);
    byClass[cls] += r.cost;
    return { repo: r.repo as string | null, class: cls, requests: r.requests as number, cost: r.cost as number };
  });
  const nightRequests = hours.filter((h) => h.hour >= NIGHT.from && h.hour < NIGHT.to).reduce((s, h) => s + h.requests, 0);

  return {
    person: { id: Number(person.id), name: person.name as string },
    days: DAYS,
    timezone: tz,
    totals: { requests: t.requests as number, cost: t.cost as number, outputTokens: t.output as number },
    hours: hours.map((h) => ({ dow: h.dow as number, hour: h.hour as number, requests: h.requests as number })),
    repos: repoRows,
    repoShare: byClass, // cost by class
    workNamespacesSet: policy.workNamespaces.length > 0,
    models: models.map((m) => ({ model: m.model as string, effort: (m.effort as string) || null, requests: m.requests as number, cost: m.cost as number })),
    querySources: sources.map((s) => ({ source: s.source as string, requests: s.requests as number, cost: s.cost as number })),
    tools: tools.map((x) => ({ tool: x.tool as string, calls: x.calls as number, failures: x.failures as number })),
    permissionModes: decisions.map((d) => ({ mode: d.mode as string, n: d.n as number })),
    compactions: compactions.map((x) => ({ trigger: x.trigger as string, n: x.n as number })),
    prompts: { count: prompts[0].n as number, avgLength: Math.round(prompts[0].avg_length as number) },
    subagents: subagents.map((x) => ({ agent: x.agent as string, n: x.n as number })),
    apiErrors: errors.map((x) => ({ status: x.status as string, n: x.n as number })),
    flags: flags({
      policy, totalCost: t.cost, totalRequests: t.requests, byClass, nightRequests,
      shared: shared.map((s) => ({ fp: s.fp as string, other: s.other as string })),
    }),
  };
}

type FlagInput = {
  policy: PolicyData; totalCost: number; totalRequests: number;
  byClass: Record<RepoClass, number>; nightRequests: number; shared: { fp: string; other: string }[];
};

/** Thresholds come from owner policy. Each flag carries its evidence and what it can't prove. */
export function flags({ policy, totalCost, totalRequests, byClass, nightRequests, shared }: FlagInput): Flag[] {
  const out: Flag[] = [];
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

  const outside = pct(byClass.outside, totalCost);
  if (policy.workNamespaces.length && totalCost > 0 && outside >= policy.flagOutsideWorkPct) {
    out.push({
      key: 'outside-work', title: `${outside}% of measured work was outside work repositories`,
      evidence: `$${byClass.outside.toFixed(2)} of $${totalCost.toFixed(2)} (API prices) in repos not under your work namespaces, last ${DAYS} days.`,
      caveat: 'Forks, personal scratch repos for work tasks, or a namespace missing from Settings also count as outside.',
    });
  }
  const night = pct(nightRequests, totalRequests);
  if (totalRequests >= 20 && night >= policy.flagNightPct) {
    out.push({
      key: 'night', title: `${night}% of requests between 00:00 and 06:00`,
      evidence: `${nightRequests} of ${totalRequests} requests, ${policy.displayTimezone} time.`,
      caveat: 'Long-running agents and scheduled jobs keep working overnight without anyone at the keyboard.',
    });
  }
  for (const s of shared) {
    out.push({
      key: `shared-${s.fp}`, title: `Setup token ${s.fp} is also used by ${s.other}`,
      evidence: 'The same token fingerprint was reported from devices that belong to two people.',
      caveat: 'A token copied while helping someone set up shows the same way. Ask before assuming.',
    });
  }
  return out;
}
