// Session-level ledger (with effort/xhigh, duration, repo, hook status) and 365-day / year-selectable activity calendar.
import type { PolicyData } from '@usage-monitor/contracts';
import type { Sql } from './app.ts';
import { resolveRange } from './analytics.ts';
import { classifyRepo } from './profile.ts';

const EFFORT_RANK: Record<string, number> = { xhigh: 4, high: 3, medium: 2, low: 1 };

export type SessionFilter = {
  rangeKey: string;
  teamIds: number[] | null;
  personId?: number | null;
  repo?: string | null;
  effort?: string | null;
  sort?: 'recent' | 'cost' | 'effort';
  limit?: number;
};

export async function listSessions(sql: Sql, policy: PolicyData, opts: SessionFilter) {
  const tz = policy.displayTimezone;
  const r = await resolveRange(sql, opts.rangeKey, tz);
  const all = opts.teamIds === null;
  const tids = opts.teamIds ?? [];
  const personId = opts.personId ?? null;
  const repoFilter = opts.repo ?? null;
  const effortFilter = opts.effort ?? null;
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));

  const [summaryRow] = await sql`
    with sess as (
      select e.installation_id, coalesce(e.session_id, 'ev:' || e.id::text) as skey, e.session_id,
        count(*)::int as requests,
        coalesce(sum(e.cost_usd), 0)::float8 as cost_usd,
        bool_or(e.effort = 'xhigh') as has_xhigh,
        count(*) filter (where e.effort = 'xhigh')::int as xhigh_req,
        coalesce(sum(e.cost_usd) filter (where e.effort = 'xhigh'), 0)::float8 as xhigh_cost,
        mode() within group (order by e.repo) filter (where e.repo is not null) as top_repo,
        bool_or(sb.session_id is not null) as hooks_active
      from usage_events e
      join installations i on i.id = e.installation_id
      left join people p on p.id = i.person_id
      left join session_bindings sb on sb.installation_id = e.installation_id and sb.session_id = e.session_id
      where e.event_time >= ${r.start} and e.event_time < ${r.end}
        and (${all} or p.team_id = any(${tids}::bigint[]))
        and (${personId}::bigint is null or i.person_id = ${personId})
        and (${repoFilter}::text is null or e.repo = ${repoFilter})
      group by 1, 2, 3
    )
    select count(*)::int as total_sessions,
      coalesce(sum(requests), 0)::int as total_requests,
      coalesce(sum(cost_usd), 0)::float8 as total_cost_usd,
      count(*) filter (where has_xhigh)::int as xhigh_sessions,
      coalesce(sum(xhigh_req), 0)::int as xhigh_requests,
      coalesce(sum(xhigh_cost), 0)::float8 as xhigh_cost_usd,
      count(*) filter (where session_id is not null and not hooks_active)::int as unhooked_sessions,
      coalesce(array_agg(top_repo) filter (where top_repo is not null), '{}') as repos
    from sess`;

  const orderSql = opts.sort === 'cost'
    ? sql`cost_usd desc, ended_at desc`
    : opts.sort === 'effort'
      ? sql`effort_rank desc, cost_usd desc, ended_at desc`
      : sql`ended_at desc`;

  const baseRows = await sql`
    select e.installation_id,
      coalesce(e.session_id, 'ev:' || min(e.id)::text) as skey,
      e.session_id,
      i.name as device_name,
      i.person_id,
      coalesce(p.name, i.name) as person_name,
      p.team_id,
      t.name as team_name,
      t.work_namespaces as team_namespaces,
      min(e.event_time) as started_at,
      max(e.event_time) as ended_at,
      greatest(0, extract(epoch from max(e.event_time) - min(e.event_time))::int) as span_sec,
      mode() within group (order by e.repo) filter (where e.repo is not null) as repo,
      mode() within group (order by e.model) as top_model,
      count(*)::int as requests,
      coalesce(sum(e.cost_usd), 0)::float8 as cost_usd,
      coalesce(sum(e.input_tokens), 0)::float8 as input_tokens,
      coalesce(sum(e.output_tokens), 0)::float8 as output_tokens,
      coalesce(sum(e.cache_read_tokens), 0)::float8 as cache_read_tokens,
      coalesce(array_agg(distinct e.entrypoint) filter (where e.entrypoint is not null), '{}') as entrypoints,
      max(case e.effort when 'xhigh' then 4 when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end)::int as effort_rank,
      bool_or(sb.session_id is not null) as hooks_active
    from usage_events e
    join installations i on i.id = e.installation_id
    left join people p on p.id = i.person_id
    left join teams t on t.id = p.team_id
    left join session_bindings sb on sb.installation_id = e.installation_id and sb.session_id = e.session_id
    where e.event_time >= ${r.start} and e.event_time < ${r.end}
      and (${all} or p.team_id = any(${tids}::bigint[]))
      and (${personId}::bigint is null or i.person_id = ${personId})
      and (${repoFilter}::text is null or e.repo = ${repoFilter})
    group by e.installation_id, e.session_id, i.name, i.person_id, p.name, p.team_id, t.name, t.work_namespaces
    having (${effortFilter}::text is null or bool_or(e.effort = ${effortFilter}))
    order by ${orderSql}
    limit ${limit}`;

  const realSessionIds = [...new Set(baseRows.flatMap((x) => (x.session_id ? [x.session_id as string] : [])))];
  const instIds = [...new Set(baseRows.map((x) => Number(x.installation_id)))];

  const [effortRows, actRows, metricRows] = realSessionIds.length && instIds.length
    ? await Promise.all([
      sql`select installation_id, session_id, model, effort, count(*)::int as requests, coalesce(sum(cost_usd), 0)::float8 as cost_usd
          from usage_events
          where installation_id = any(${instIds}::bigint[]) and session_id = any(${realSessionIds})
            and event_time >= ${r.start} and event_time < ${r.end}
          group by 1, 2, 3, 4 order by cost_usd desc`,
      sql`select installation_id, session_id,
            count(*) filter (where event_name = 'user_prompt')::int as prompts,
            count(*) filter (where event_name = 'tool_result')::int as tool_calls,
            count(*) filter (where event_name = 'guard_event' and attrs->>'action' = 'blocked')::int as guard_blocked,
            count(*) filter (where event_name = 'guard_event' and attrs->>'action' = 'warned')::int as guard_warned
          from activity_events
          where installation_id = any(${instIds}::bigint[]) and session_id = any(${realSessionIds})
            and event_time >= ${r.start} and event_time < ${r.end}
          group by 1, 2`,
      sql`select installation_id, session_id,
            coalesce(sum(value) filter (where name = 'commit.count'), 0)::float8 as commits,
            coalesce(sum(value) filter (where name = 'lines_of_code.count' and attrs->>'type' = 'added'), 0)::float8 as lines_added,
            coalesce(sum(value) filter (where name = 'lines_of_code.count' and attrs->>'type' = 'removed'), 0)::float8 as lines_removed,
            coalesce(sum(value) filter (where name = 'active_time.total' and attrs->>'type' = 'cli'), 0)::float8 as active_cli_sec,
            coalesce(sum(value) filter (where name = 'active_time.total' and attrs->>'type' = 'user'), 0)::float8 as active_user_sec
          from metric_points
          where installation_id = any(${instIds}::bigint[]) and session_id = any(${realSessionIds})
            and end_time >= ${r.start} and end_time < ${r.end}
          group by 1, 2`,
    ])
    : [[], [], []];

  const key = (instId: number | string, sid: string | null) => `${instId}:${sid ?? ''}`;
  const effMap = new Map<string, { model: string; effort: string | null; requests: number; costUsd: number }[]>();
  for (const e of effortRows) {
    const k = key(e.installation_id, e.session_id);
    const list = effMap.get(k) ?? [];
    list.push({ model: e.model as string, effort: (e.effort as string | null) ?? null, requests: e.requests as number, costUsd: e.cost_usd as number });
    effMap.set(k, list);
  }
  const actMap = new Map(actRows.map((a) => [key(a.installation_id, a.session_id), a]));
  const metMap = new Map(metricRows.map((m) => [key(m.installation_id, m.session_id), m]));
  const rankToEffort = (n: number) => Object.entries(EFFORT_RANK).find(([, v]) => v === n)?.[0] ?? null;

  const outsideSessions = ((summaryRow?.repos as string[] | null) ?? [])
    .filter((rp) => classifyRepo(rp, policy.workNamespaces) === 'outside').length;

  return {
    range: { key: r.key, start: r.start.toISOString(), end: r.end.toISOString(), label: r.label },
    summary: {
      totalSessions: (summaryRow?.total_sessions as number) ?? 0,
      totalRequests: (summaryRow?.total_requests as number) ?? 0,
      totalCostUsd: (summaryRow?.total_cost_usd as number) ?? 0,
      xhighSessions: (summaryRow?.xhigh_sessions as number) ?? 0,
      xhighRequests: (summaryRow?.xhigh_requests as number) ?? 0,
      xhighCostUsd: (summaryRow?.xhigh_cost_usd as number) ?? 0,
      outsideSessions,
      unhookedSessions: (summaryRow?.unhooked_sessions as number) ?? 0,
    },
    sessions: baseRows.map((row) => {
      const k = key(row.installation_id, row.session_id);
      const a = actMap.get(k);
      const m = metMap.get(k);
      const ns = [...new Set([...policy.workNamespaces, ...((row.team_namespaces as string[] | null) ?? [])])];
      const repo = (row.repo as string | null) ?? null;
      return {
        sessionId: (row.session_id as string | null) ?? null,
        installationId: Number(row.installation_id),
        deviceName: row.device_name as string,
        personId: row.person_id === null ? null : Number(row.person_id),
        personName: row.person_name as string,
        teamId: row.team_id === null ? null : Number(row.team_id),
        teamName: (row.team_name as string | null) ?? null,
        startedAt: (row.started_at as Date).toISOString(),
        endedAt: (row.ended_at as Date).toISOString(),
        spanSec: row.span_sec as number,
        activeCliSec: Math.round((m?.active_cli_sec as number) ?? 0),
        activeUserSec: Math.round((m?.active_user_sec as number) ?? 0),
        repo,
        repoClass: classifyRepo(repo, ns),
        topModel: row.top_model as string,
        maxEffort: rankToEffort(row.effort_rank as number),
        efforts: effMap.get(k) ?? [],
        entrypoints: (row.entrypoints as string[]) ?? [],
        hooksActive: row.session_id ? Boolean(row.hooks_active) : true,
        requests: row.requests as number,
        costUsd: row.cost_usd as number,
        inputTokens: row.input_tokens as number,
        outputTokens: row.output_tokens as number,
        cacheReadTokens: row.cache_read_tokens as number,
        prompts: (a?.prompts as number) ?? 0,
        toolCalls: (a?.tool_calls as number) ?? 0,
        guardBlocked: (a?.guard_blocked as number) ?? 0,
        guardWarned: (a?.guard_warned as number) ?? 0,
        commits: (m?.commits as number) ?? 0,
        linesAdded: (m?.lines_added as number) ?? 0,
        linesRemoved: (m?.lines_removed as number) ?? 0,
      };
    }),
  };
}

export type CalendarFilter = {
  year?: number | null;
  teamIds: number[] | null;
  personId?: number | null;
};

export async function activityCalendar(sql: Sql, policy: PolicyData, opts: CalendarFilter) {
  const tz = policy.displayTimezone;
  const all = opts.teamIds === null;
  const tids = opts.teamIds ?? [];
  const personId = opts.personId ?? null;
  const currentYear = Number(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric' }).format(new Date()));
  const year = opts.year && opts.year >= 2020 && opts.year <= currentYear + 1 ? opts.year : null;

  const [bounds] = year
    ? await sql`
        select (${`${year}-01-01`}::date::timestamp at time zone ${tz}) as s,
               (${`${year + 1}-01-01`}::date::timestamp at time zone ${tz}) as e,
               ${`${year}-01-01`}::text as start_day,
               ${`${year}-12-31`}::text as end_day`
    : await sql`
        with today as (select (now() at time zone ${tz})::date as d)
        select ((d - 364)::timestamp at time zone ${tz}) as s,
               ((d + 1)::timestamp at time zone ${tz}) as e,
               (d - 364)::text as start_day,
               d::text as end_day
        from today`;

  const start = bounds.s as Date;
  const end = bounds.e as Date;

  const [usageDaily, usageRepos, commitDaily, yearRows] = await Promise.all([
    sql`select (e.event_time at time zone ${tz})::date::text as day,
          count(*)::int as requests,
          count(distinct e.session_id)::int as sessions,
          coalesce(sum(e.cost_usd), 0)::float8 as cost_usd,
          count(*) filter (where e.effort = 'xhigh')::int as xhigh_requests,
          count(distinct coalesce(i.person_id, -i.id))::int as active_people
        from usage_events e
        join installations i on i.id = e.installation_id
        left join people p on p.id = i.person_id
        where e.event_time >= ${start} and e.event_time < ${end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
          and (${personId}::bigint is null or i.person_id = ${personId})
        group by 1 order by 1`,
    sql`select (e.event_time at time zone ${tz})::date::text as day, e.repo, count(*)::int as requests
        from usage_events e
        join installations i on i.id = e.installation_id
        left join people p on p.id = i.person_id
        where e.event_time >= ${start} and e.event_time < ${end} and e.repo is not null
          and (${all} or p.team_id = any(${tids}::bigint[]))
          and (${personId}::bigint is null or i.person_id = ${personId})
        group by 1, 2`,
    sql`select (g.committed_at at time zone ${tz})::date::text as day, count(*)::int as commits
        from git_commits g join people p on g.author_email = any(p.git_emails)
        where g.committed_at >= ${start} and g.committed_at < ${end}
          and (${all} or p.team_id = any(${tids}::bigint[]))
          and (${personId}::bigint is null or p.id = ${personId})
        group by 1 order by 1`,
    sql`select distinct y from (
          select extract(year from e.event_time at time zone ${tz})::int as y
          from usage_events e join installations i on i.id = e.installation_id left join people p on p.id = i.person_id
          where (${all} or p.team_id = any(${tids}::bigint[])) and (${personId}::bigint is null or i.person_id = ${personId})
          union
          select extract(year from g.committed_at at time zone ${tz})::int as y
          from git_commits g join people p on g.author_email = any(p.git_emails)
          where (${all} or p.team_id = any(${tids}::bigint[])) and (${personId}::bigint is null or p.id = ${personId})
        ) t order by y desc`,
  ]);

  const outsideByDay = new Map<string, number>();
  if (policy.workNamespaces.length) {
    for (const r of usageRepos) {
      if (classifyRepo(r.repo as string, policy.workNamespaces) === 'outside') {
        outsideByDay.set(r.day as string, (outsideByDay.get(r.day as string) ?? 0) + (r.requests as number));
      }
    }
  }

  const byDay = new Map<string, {
    day: string; requests: number; sessions: number; costUsd: number; commits: number;
    xhighRequests: number; outsideRequests: number; activePeople: number;
  }>();
  const ensure = (day: string) => byDay.get(day) ?? byDay.set(day, {
    day, requests: 0, sessions: 0, costUsd: 0, commits: 0, xhighRequests: 0, outsideRequests: 0, activePeople: 0,
  }).get(day)!;

  for (const u of usageDaily) {
    const d = ensure(u.day as string);
    d.requests = u.requests as number;
    d.sessions = u.sessions as number;
    d.costUsd = u.cost_usd as number;
    d.xhighRequests = u.xhigh_requests as number;
    d.outsideRequests = outsideByDay.get(d.day) ?? 0;
    d.activePeople = u.active_people as number;
  }
  for (const c of commitDaily) {
    ensure(c.day as string).commits = c.commits as number;
  }

  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  const totals = days.reduce((acc, d) => ({
    requests: acc.requests + d.requests,
    sessions: acc.sessions + d.sessions,
    costUsd: acc.costUsd + d.costUsd,
    commits: acc.commits + d.commits,
    xhighRequests: acc.xhighRequests + d.xhighRequests,
    outsideRequests: acc.outsideRequests + d.outsideRequests,
    activeDays: acc.activeDays + (d.requests > 0 || d.commits > 0 ? 1 : 0),
  }), { requests: 0, sessions: 0, costUsd: 0, commits: 0, xhighRequests: 0, outsideRequests: 0, activeDays: 0 });

  const years = [...new Set([currentYear, ...yearRows.map((x) => Number(x.y))])].sort((a, b) => b - a);
  return {
    mode: year ? 'year' : 'rolling',
    year,
    timezone: tz,
    startDay: bounds.start_day as string,
    endDay: bounds.end_day as string,
    years,
    totals,
    days,
  };
}
