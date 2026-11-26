// Per-person usage profile for the owner dashboard: what kind of work, when, with which tools.
// Content-free by construction: it only reads columns and allowlisted attrs written by otlp.ts.
import type { PolicyData } from '@usage-monitor/contracts';
import type { Sql } from './app.ts';
import { flagsFor, peopleStats, resolveRange } from './analytics.ts';

export type RepoClass = 'work' | 'outside' | 'none';
export const classifyRepo = (repo: string | null, workNamespaces: string[]): RepoClass =>
  !repo ? 'none' : workNamespaces.some((ns) => repo.startsWith(ns.toLowerCase().replace(/\/*$/, '/')) || repo === ns.toLowerCase().replace(/\/*$/, '')) ? 'work' : 'outside';

export async function profile(sql: Sql, personId: number, policy: PolicyData, rangeKey = 'window') {
  const [person] = await sql`
    select p.id, p.name, p.team_id, p.git_emails, t.name as team_name, t.work_namespaces as team_namespaces
    from people p left join teams t on t.id = p.team_id
    where p.id = ${personId}`;
  if (!person) return null;

  const tz = policy.displayTimezone;
  const r = await resolveRange(sql, rangeKey, tz);
  const workNamespaces = [...new Set([...policy.workNamespaces, ...((person.team_namespaces as string[] | null) ?? [])])];
  const mine = sql`select id from installations where person_id = ${personId}`;

  const [totals, hours, repos, models, efforts, sources, tools, decisions, compactions, prompts, subagents, errors, guard] = await Promise.all([
    sql`select count(*)::int as requests, count(distinct session_id)::int as sessions,
          coalesce(sum(cost_usd), 0)::float8 as cost, coalesce(sum(output_tokens), 0)::float8 as output
        from usage_events where installation_id in (${mine}) and event_time >= ${r.start} and event_time < ${r.end}`,
    sql`select extract(isodow from event_time at time zone ${tz})::int as dow, extract(hour from event_time at time zone ${tz})::int as hour,
          count(*)::int as requests
        from usage_events where installation_id in (${mine}) and event_time >= ${r.start} and event_time < ${r.end} group by 1, 2`,
    sql`select repo, count(*)::int as requests, count(distinct session_id)::int as sessions, coalesce(sum(cost_usd), 0)::float8 as cost
        from usage_events where installation_id in (${mine}) and event_time >= ${r.start} and event_time < ${r.end} group by 1 order by cost desc`,
    sql`select model, coalesce(effort, '') as effort, count(*)::int as requests, coalesce(sum(cost_usd), 0)::float8 as cost
        from usage_events where installation_id in (${mine}) and event_time >= ${r.start} and event_time < ${r.end} group by 1, 2 order by cost desc`,
    sql`select coalesce(effort, 'unspecified') as effort, count(*)::int as requests, count(distinct session_id)::int as sessions, coalesce(sum(cost_usd), 0)::float8 as cost
        from usage_events where installation_id in (${mine}) and event_time >= ${r.start} and event_time < ${r.end} group by 1 order by cost desc`,
    sql`select coalesce(query_source, 'unknown') as source, count(*)::int as requests, coalesce(sum(cost_usd), 0)::float8 as cost
        from usage_events where installation_id in (${mine}) and event_time >= ${r.start} and event_time < ${r.end} group by 1 order by cost desc`,
    sql`select attrs->>'tool_name' as tool, count(*)::int as calls,
          count(*) filter (where attrs->>'success' = 'false')::int as failures
        from activity_events where installation_id in (${mine}) and event_time >= ${r.start} and event_time < ${r.end} and event_name = 'tool_result'
        group by 1 order by calls desc limit 15`,
    sql`select coalesce(attrs->>'permission_mode', 'unknown') as mode, count(*)::int as n
        from activity_events where installation_id in (${mine}) and event_time >= ${r.start} and event_time < ${r.end} and event_name = 'tool_decision'
        group by 1 order by n desc`,
    sql`select coalesce(attrs->>'trigger', 'unknown') as trigger, count(*)::int as n
        from activity_events where installation_id in (${mine}) and event_time >= ${r.start} and event_time < ${r.end} and event_name = 'compaction' group by 1`,
    sql`select count(*)::int as n, coalesce(avg((attrs->>'prompt_length')::numeric), 0)::float8 as avg_length
        from activity_events where installation_id in (${mine}) and event_time >= ${r.start} and event_time < ${r.end} and event_name = 'user_prompt'`,
    sql`select coalesce(attrs->>'agent_type', 'unknown') as agent, count(*)::int as n
        from activity_events where installation_id in (${mine}) and event_time >= ${r.start} and event_time < ${r.end} and event_name = 'subagent_completed'
        group by 1 order by n desc limit 10`,
    sql`select coalesce(attrs->>'status_code', 'unknown') as status, count(*)::int as n
        from activity_events where installation_id in (${mine}) and event_time >= ${r.start} and event_time < ${r.end} and event_name = 'api_error'
        group by 1 order by n desc`,
    sql`select count(*) filter (where attrs->>'action' = 'blocked')::int as blocked,
          count(*) filter (where attrs->>'action' = 'warned')::int as warned
        from activity_events where installation_id in (${mine}) and event_time >= ${r.start} and event_time < ${r.end} and event_name = 'guard_event'`,
  ]);

  const t = totals[0];
  const byClass = { work: 0, outside: 0, none: 0 };
  const repoRows = repos.map((row) => {
    const cls = classifyRepo(row.repo, workNamespaces);
    byClass[cls] += row.cost;
    return { repo: row.repo as string | null, class: cls, requests: row.requests as number, sessions: row.sessions as number, cost: row.cost as number };
  });
  const effectivePolicy: PolicyData = { ...policy, workNamespaces };
  const stats = (await peopleStats(sql, r, effectivePolicy)).find((x) => x.pid === personId);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const days = Math.max(1, Math.round((r.end.getTime() - r.start.getTime()) / 86400_000));

  return {
    person: {
      id: Number(person.id),
      name: person.name as string,
      teamId: person.team_id === null ? null : Number(person.team_id),
      teamName: (person.team_name as string | null) ?? null,
      gitEmails: (person.git_emails as string[]) ?? [],
    },
    range: { key: r.key, start: r.start.toISOString(), end: r.end.toISOString(), label: r.label },
    days,
    timezone: tz,
    totals: { requests: t.requests as number, sessions: t.sessions as number, cost: t.cost as number, outputTokens: t.output as number },
    hours: hours.map((h) => ({ dow: h.dow as number, hour: h.hour as number, requests: h.requests as number })),
    repos: repoRows,
    repoShare: byClass,
    workNamespacesSet: workNamespaces.length > 0,
    models: models.map((m) => ({ model: m.model as string, effort: (m.effort as string) || null, requests: m.requests as number, cost: m.cost as number })),
    efforts: efforts.map((e) => ({ effort: e.effort as string, requests: e.requests as number, sessions: e.sessions as number, cost: e.cost as number })),
    guard: { blocked: (guard[0]?.blocked as number) ?? 0, warned: (guard[0]?.warned as number) ?? 0 },
    querySources: sources.map((s) => ({ source: s.source as string, requests: s.requests as number, cost: s.cost as number })),
    tools: tools.map((x) => ({ tool: x.tool as string, calls: x.calls as number, failures: x.failures as number })),
    permissionModes: decisions.map((d) => ({ mode: d.mode as string, n: d.n as number })),
    compactions: compactions.map((x) => ({ trigger: x.trigger as string, n: x.n as number })),
    prompts: { count: prompts[0].n as number, avgLength: Math.round(prompts[0].avg_length as number) },
    subagents: subagents.map((x) => ({ agent: x.agent as string, n: x.n as number })),
    apiErrors: errors.map((x) => ({ status: x.status as string, n: x.n as number })),
    flags: stats ? flagsFor(stats, effectivePolicy, today) : [],
  };
}
