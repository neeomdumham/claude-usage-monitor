// Synthetic team for designing and testing the dashboard. Writes ONLY to the database in DATABASE_URL and refuses
// to touch one that already has people in it, so it can't pollute a real monitor.
//   docker compose --profile demo up --build demo   -> http://localhost:5174 (password: demo)
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { DEFAULT_POLICY } from '@usage-monitor/contracts';
import { migrate, PLUGIN_VERSION } from './app.ts';
const CURRENT = `plugin-${PLUGIN_VERSION}`;

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
await migrate(sql);
if ((await sql`select count(*)::int as n from people`)[0].n > 0) {
  console.log('seed-demo: database already has people, leaving it alone');
  process.exit(0);
}

// Deterministic randomness: the same demo every time, so screenshots are comparable.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const DAY = 86400_000;
const now = Date.now();

await sql`insert into policies (data) values (${sql.json({ ...DEFAULT_POLICY, workNamespaces: ['gitlab.com/northwind'] })})`;

type P = { name: string; devices: string[]; email: string; perDay: number; night: number; outside: number; none: number; sdk: number; models: string[]; labels?: string[] };
const TEAM: P[] = [
  { name: 'Rafi Ahmed', devices: ['rafi-mbp', 'rafi-desktop'], email: 'rafi@northwind.dev', perDay: 34, night: 0.03, outside: 0.05, none: 0.1, sdk: 0.05, models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5'] },
  { name: 'Nila Chowdhury', devices: ['nila-thinkpad'], email: 'nila@northwind.dev', perDay: 26, night: 0.02, outside: 0.04, none: 0.15, sdk: 0.02, models: ['claude-sonnet-5-5', 'claude-haiku-5-5'] },
  { name: 'Tanvir Hossain', devices: ['tanvir-mbp'], email: 'tanvir@northwind.dev', perDay: 41, night: 0.34, outside: 0.48, none: 0.2, sdk: 0.1, models: ['claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'], labels: ['non-work', 'non-work', 'non-work', 'credential-pasted'] },
  { name: 'Sadia Karim', devices: ['sadia-air', 'sadia-ci-box'], email: 'sadia@northwind.dev', perDay: 22, night: 0.08, outside: 0.02, none: 0.05, sdk: 0.62, models: ['claude-sonnet-5-5', 'claude-haiku-5-5'] },
  { name: 'Imran Malik', devices: ['imran-mbp'], email: 'imran@northwind.dev', perDay: 6, night: 0, outside: 0, none: 0.3, sdk: 0, models: ['claude-sonnet-5-5'] },
];
const WORK = ['gitlab.com/northwind/api', 'gitlab.com/northwind/web', 'gitlab.com/northwind/mobile', 'gitlab.com/northwind/infra'];
const OUTSIDE = ['github.com/tanvir-h/side-project', 'github.com/someone/fork-of-ui'];
const PRICE: Record<string, number> = { 'claude-opus-5-5': 0.09, 'claude-sonnet-5-5': 0.03, 'claude-haiku-5-5': 0.006 };
const TOOLS = ['Read', 'Edit', 'Bash', 'Grep', 'Write', 'Glob', 'WebFetch', 'Agent'];

// One setup token per person; Sadia's CI box runs on Rafi's token, which the dashboard should flag.
const creds: number[] = [];
for (const p of TEAM) creds.push((await sql`insert into credentials (fingerprint) values (${sha(`token:${p.name}`)}) returning id`)[0].id);

let n = 0;
for (const [pi, p] of TEAM.entries()) {
  const joined = new Date(now - (29 - pi) * DAY);
  const [person] = await sql`insert into people (name, created_at, git_emails) values (${p.name}, ${joined}, ${[p.email]}) returning id`;
  await sql`insert into audit_log (at, actor, action, person_id, details) values (${joined}, 'owner', 'person.added', ${person.id}, ${sql.json({ name: p.name })})`;
  for (const [di, host] of p.devices.entries()) {
    const [inst] = await sql`insert into installations (name, token_hash, person_id, hostname, os, created_at, last_heartbeat_at, client_version, capabilities)
      values (${host}, ${sha(host)}, ${person.id}, ${host}, ${pick(['Darwin', 'Linux'])}, ${joined},
        ${new Date(now - (di ? 3 * DAY : rnd() * 3600_000))}, ${pi === 4 ? 'plugin-0.2.0' : CURRENT}, ${sql.json({ otlpDirect: true, statuslineBridge: true, tokenFingerprint: true })})
      returning id`;
    await sql`insert into audit_log (at, actor, action, person_id, installation_id, details) values (${joined}, 'device', 'device.joined', ${person.id}, ${inst.id}, ${sql.json({ hostname: host, os: 'Darwin', pluginVersion: CURRENT })})`;
    const credId = host === 'sadia-ci-box' ? creds[0] : creds[pi];
    await sql`insert into credential_bindings (installation_id, credential_id) values (${inst.id}, ${credId}) on conflict do nothing`;

    const usage: any[] = [], activity: any[] = [], metrics: any[] = [];
    for (let d = 29 - pi; d >= 0; d--) {
      const weekend = new Date(now - d * DAY).getUTCDay() % 6 === 0;
      const count = Math.round((p.perDay / p.devices.length) * (weekend ? 0.2 : 1) * (0.6 + rnd() * 0.8) * (d === 0 && pi === 0 ? 3.5 : 1));
      for (let s = 0; s < Math.max(1, Math.round(count / 12)); s++) {
        const session = `demo-${host}-${d}-${s}`;
        const night = rnd() < p.night;
        // Dhaka is UTC+6: 03:00-09:00 UTC is office hours there, 18:00-24:00 UTC is midnight to 06:00.
        const startH = night ? 18 + rnd() * 5 : 3 + rnd() * 8;
        const start = now - d * DAY - (now % DAY) + startH * 3600_000;
        const r = rnd();
        const repo = r < p.none ? null : r < p.none + p.outside ? pick(OUTSIDE) : pick(WORK);
        const sdk = rnd() < p.sdk;
        if (start > now) continue;
        await sql`insert into session_bindings (session_id, installation_id, credential_id) values (${session}, ${inst.id}, ${credId}) on conflict do nothing`;
        for (let k = 0; k < 12; k++) {
          const t = new Date(start + k * (60 + rnd() * 240) * 1000);
          if (t.getTime() > now) break;
          const model = pick(p.models);
          const out = Math.round(300 + rnd() * 2500), inp = Math.round(2000 + rnd() * 9000);
          const cacheRead = Math.round(inp * (2 + rnd() * 8));
          usage.push({ source_event_id: `u${++n}`, installation_id: inst.id, credential_id: null, session_id: session, model, event_time: t,
            input_tokens: inp, output_tokens: out, cache_read_tokens: cacheRead, cache_creation_tokens: Math.round(inp * 0.3),
            cost_usd: +(PRICE[model] * (out / 1000) * 4 + PRICE[model] * (inp / 1000) * 0.2 + PRICE[model] * (cacheRead / 1000) * 0.02).toFixed(4),
            duration_ms: Math.round(2000 + rnd() * 20000), query_source: rnd() < 0.2 ? 'subagent' : 'repl_main_thread',
            effort: null, speed: null, repo, entrypoint: sdk ? 'sdk-cli' : 'cli', prompt_id: null, request_id: `req${n}`, agent_id: null, parent_agent_id: null });
          const tool = pick(TOOLS);
          activity.push({ source_event_id: `a${++n}`, installation_id: inst.id, session_id: session, event_name: 'tool_result', event_time: t, repo,
            attrs: sql.json({ tool_name: tool, success: rnd() < 0.93 ? 'true' : 'false', duration_ms: String(Math.round(50 + rnd() * 4000)) }) });
          activity.push({ source_event_id: `a${++n}`, installation_id: inst.id, session_id: session, event_name: 'tool_decision', event_time: t, repo,
            attrs: sql.json({ tool_name: tool, decision: 'accept', source: 'config', permission_mode: pi === 3 && rnd() < 0.4 ? 'bypassPermissions' : pick(['default', 'acceptEdits', 'auto']) }) });
          if (k % 3 === 0) activity.push({ source_event_id: `a${++n}`, installation_id: inst.id, session_id: session, event_name: 'user_prompt', event_time: t, repo,
            attrs: sql.json({ prompt_length: String(Math.round(40 + rnd() * 900)) }) });
        }
        if (rnd() < 0.15) activity.push({ source_event_id: `a${++n}`, installation_id: inst.id, session_id: session, event_name: 'compaction', event_time: new Date(start), repo, attrs: sql.json({ trigger: 'auto', success: 'true' }) });
        if (rnd() < 0.1) activity.push({ source_event_id: `a${++n}`, installation_id: inst.id, session_id: session, event_name: 'api_error', event_time: new Date(start), repo, attrs: sql.json({ status_code: pick(['429', '529', '500']) }) });
        if (rnd() < 0.3) activity.push({ source_event_id: `a${++n}`, installation_id: inst.id, session_id: session, event_name: 'subagent_completed', event_time: new Date(start), repo, attrs: sql.json({ agent_type: pick(['Explore', 'general-purpose', 'Plan']) }) });
        if (repo) {
          const end = new Date(Math.min(now, start + 1800_000));
          const base = { installation_id: inst.id, session_id: session, repo, start_time: new Date(start), end_time: end };
          metrics.push({ ...base, source_key: `m${++n}`, name: 'lines_of_code.count', attrs: sql.json({ type: 'added' }), value: Math.round(rnd() * 400) });
          metrics.push({ ...base, source_key: `m${++n}`, name: 'lines_of_code.count', attrs: sql.json({ type: 'removed' }), value: Math.round(rnd() * 150) });
          if (rnd() < 0.5) metrics.push({ ...base, source_key: `m${++n}`, name: 'commit.count', attrs: sql.json({}), value: 1 + Math.round(rnd() * 2) });
          if (rnd() < 0.1) metrics.push({ ...base, source_key: `m${++n}`, name: 'pull_request.count', attrs: sql.json({}), value: 1 });
          metrics.push({ ...base, source_key: `m${++n}`, name: 'code_edit_tool.decision', attrs: sql.json({ tool_name: 'Edit', decision: rnd() < 0.9 ? 'accept' : 'reject' }), value: 1 + Math.round(rnd() * 6) });
          metrics.push({ ...base, source_key: `m${++n}`, name: 'active_time.total', attrs: sql.json({ type: 'user' }), value: Math.round(300 + rnd() * 1500) });
          metrics.push({ ...base, source_key: `m${++n}`, name: 'active_time.total', attrs: sql.json({ type: 'cli' }), value: Math.round(600 + rnd() * 2400) });
        }
      }
    }
    for (let i = 0; i < usage.length; i += 500) await sql`insert into usage_events ${sql(usage.slice(i, i + 500))}`;
    for (let i = 0; i < activity.length; i += 500) await sql`insert into activity_events ${sql(activity.slice(i, i + 500))}`;
    for (let i = 0; i < metrics.length; i += 500) await sql`insert into metric_points ${sql(metrics.slice(i, i + 500))}`;
    if (di === 0) for (const [li, cat] of (p.labels ?? []).entries()) {
      await sql`insert into activity_events (source_event_id, installation_id, session_id, event_name, event_time, attrs)
        values (${`l${++n}`}, ${inst.id}, null, 'prompt_label', ${new Date(now - (li + 1) * 0.7 * DAY)}, ${sql.json({ category: cat })})`;
    }
  }
  // Commits in GitLab: most by Claude-using teammates, a few by people not mapped yet.
  for (let c = 0; c < Math.round(p.perDay * 1.5); c++) {
    await sql`insert into git_commits (repo, sha, author_email, committed_at, additions, deletions)
      values (${pick(WORK)}, ${sha(`${p.email}${c}`)}, ${p.email}, ${new Date(now - rnd() * 28 * DAY)}, ${Math.round(rnd() * 300)}, ${Math.round(rnd() * 120)})`;
  }
}
for (let c = 0; c < 18; c++) {
  await sql`insert into git_commits (repo, sha, author_email, committed_at, additions, deletions)
    values (${pick(WORK)}, ${sha(`ext${c}`)}, ${pick(['contractor@agency.io', 'ops-bot@northwind.dev'])}, ${new Date(now - rnd() * 28 * DAY)}, ${Math.round(rnd() * 200)}, ${Math.round(rnd() * 80)})`;
}
await sql`insert into git_sync (project_id, repo, synced_until) values (1, ${WORK[0]}, ${new Date(now - 40 * 60_000)})`;

// Allowance meters: the weekly window started 4 days ago; history climbs to today's reading.
const weekReset = Math.floor((now + 3 * DAY) / 1000), fiveReset = Math.floor((now + 2.2 * 3600_000) / 1000);
for (let h = 96; h >= 0; h -= 3) {
  const at = new Date(now - h * 3600_000);
  await sql`insert into quota_snapshots (meter_key, used_percentage, resets_at, first_observed_at, last_observed_at, source)
    values ('seven_day', ${Math.round((96 - h) * 0.66)}, ${new Date(weekReset * 1000)}, ${at}, ${at}, 'statusline') on conflict do nothing`;
}
for (let m = 160; m >= 0; m -= 20) {
  const at = new Date(now - m * 60_000);
  await sql`insert into quota_snapshots (meter_key, used_percentage, resets_at, first_observed_at, last_observed_at, source)
    values ('five_hour', ${Math.round((160 - m) * 0.38)}, ${new Date(fiveReset * 1000)}, ${at}, ${at}, 'statusline') on conflict do nothing`;
}
await sql`insert into audit_log (at, actor, action, details) values (${new Date(now - 40 * 60_000)}, 'system', 'git.sync', ${sql.json({ projects: 4, commits: 12 })})`;
console.log('seed-demo: done');
await sql.end();
