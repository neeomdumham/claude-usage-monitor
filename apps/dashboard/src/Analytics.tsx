import { useEffect, useMemo, useState } from 'react';
import {
  ContributionCalendar, dayLabel, HourHeatmap, StackedBars,
  type CalendarMetric, type CalendarSelection, type Series,
} from './charts.tsx';
import type { Go } from './Home.tsx';
import {
  ago, call, compact, daysBetween, formatDateTime, formatDuration, formatPermissionMode, formatQuerySource,
  pct, personColors, usd,
  type Analytics as A, type CalendarResponse, type Commit, type Person, type SessionsResponse,
} from './lib.ts';
import { Card, Chips, EffortBadge, Kpi, Modal, PageHead, Pill, Th } from './ui.tsx';

export function useColors(a: A) {
  return useMemo(() => personColors(a.people.map((p) => p.pid)), [a]);
}
const nameOf = (a: A, pid: number | null) => (pid === null ? 'Unmatched' : a.people.find((p) => p.pid === pid)?.name ?? `#${pid}`);

export function Repositories({ a }: { a: A }) {
  const color = useColors(a);
  const top = a.repos.slice(0, 12);
  const people = a.people.filter((p) => p.requests > 0);
  const maxCell = Math.max(1e-9, ...top.flatMap((r) => r.people.map((x) => x.cost)));
  const name = (r: A['repos'][number]) => r.repo ?? 'No repository';

  return (
    <div className="space-y-12">
      <section>
        <PageHead
          title="Repositories"
          sub="Where Claude Code work happened. Team commits come from synced GitLab/GitHub commits by enrolled teammates; Claude commits come from Claude Code telemetry."
        />
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="border-b border-rule">
              <tr>
                <Th>Repository</Th><Th right>Cost</Th><Th right>Requests</Th><Th right>Sessions</Th>
                <Th right>People</Th><Th right>Claude commits</Th><Th right>Team commits</Th>
                <Th right>Claude lines</Th><Th right>Team lines</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {a.repos.map((r) => (
                <tr key={name(r)} className="hover:bg-band/40">
                  <th scope="row" className="px-3 py-2.5 text-left font-medium">
                    <div className="flex items-center gap-2">
                      {r.repo ? <span className="font-mono text-xs">{r.repo}</span> : <span className="text-muted">No repository</span>}
                      {r.class === 'outside' && <Pill tone="warn">outside work</Pill>}
                    </div>
                  </th>
                  <td className="px-3 text-right font-medium">{usd(r.cost)}</td>
                  <td className="px-3 text-right">{r.requests.toLocaleString()}</td>
                  <td className="px-3 text-right">{r.sessions}</td>
                  <td className="px-3 text-right">
                    <span className="inline-flex gap-1">{r.people.map((x) => (
                      <span key={x.pid} title={nameOf(a, x.pid)} className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: color(x.pid) }} />
                    ))}</span>
                  </td>
                  <td className="px-3 text-right">{r.claude.commits || ''}</td>
                  <td className="px-3 text-right">{r.gitlab.commits || ''}</td>
                  <td className="px-3 text-right">{r.claude.added || r.claude.removed ? `+${compact(r.claude.added)} / -${compact(r.claude.removed)}` : ''}</td>
                  <td className="px-3 text-right">{r.gitlab.additions || r.gitlab.deletions ? `+${compact(r.gitlab.additions)} / -${compact(r.gitlab.deletions)}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!a.repos.length && <p className="py-6 text-center text-sm text-muted">No repository activity in this range.</p>}
        </div>
      </section>

      {people.length > 0 && top.length > 0 && (
        <Card title="Who works where" sub="API-priced work per person and repository. Stronger colour means higher spend.">
          <div className="overflow-x-auto">
            <table className="border-separate border-spacing-[3px] text-sm">
              <thead><tr><th />{people.map((p) => <th key={p.pid} scope="col" className="px-2 text-left font-normal text-muted">{p.name}</th>)}</tr></thead>
              <tbody>
                {top.map((r) => (
                  <tr key={name(r)}>
                    <th scope="row" className="max-w-[18rem] truncate pr-3 text-left font-normal">{name(r)}</th>
                    {people.map((p) => {
                      const v = r.people.find((x) => x.pid === p.pid)?.cost ?? 0;
                      return (
                        <td key={p.pid} className="h-8 min-w-16 rounded-[2px] px-2 text-right text-xs" aria-label={`${p.name} in ${name(r)}: ${usd(v)}`}
                          style={{ background: v ? `color-mix(in oklab, var(--fill) ${Math.round(8 + (37 * v) / maxCell)}%, var(--track))` : 'var(--track)' }}>
                          {v ? usd(v) : ''}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function SplitTable({ a, rows, title, note, highlight, counts, formatKey }: {
  a: A; rows: { pid: number; key: string; n: number }[]; title: string; note: string;
  highlight?: string; counts?: boolean; formatKey?: (k: string) => string;
}) {
  const keys = [...new Set(rows.map((r) => r.key))].sort();
  const pids = [...new Set(rows.map((r) => r.pid))];
  return (
    <section className="min-w-0 rounded-xl border border-rule bg-card p-5">
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="mt-0.5 text-xs text-muted">{note}</p>
      {!rows.length ? (
        <p className="mt-3 text-sm text-muted">Nothing reported in this range.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="border-b border-rule text-xs text-muted">
              <tr>
                <th className="py-1.5 text-left font-normal">Person</th>
                {keys.map((k) => <th key={k} scope="col" className="px-2 text-right font-normal">{formatKey ? formatKey(k) : k}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {pids.map((pid) => {
                const mine = rows.filter((r) => r.pid === pid);
                const total = mine.reduce((s, r) => s + r.n, 0);
                return (
                  <tr key={pid}>
                    <th scope="row" className="py-2 text-left font-medium">{nameOf(a, pid)}</th>
                    {keys.map((k) => {
                      const n = mine.find((r) => r.key === k)?.n ?? 0;
                      const hot = k === highlight && n > 0;
                      return <td key={k} className={`px-2 text-right ${hot ? 'font-semibold text-ahead' : ''}`}>{n ? (counts ? n : `${pct(n, total)}%`) : ''}</td>;
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

type ActivityTab = 'rhythm' | 'tools' | 'modes';

export function Activity({ a, teamId = '', people = [], go }: {
  a: A; teamId?: string; people?: Person[]; go?: Go;
}) {
  const color = useColors(a);
  const [year, setYear] = useState<number | null>(null);
  const [personId, setPersonId] = useState('');
  const [metric, setMetric] = useState<CalendarMetric>('requests');
  const [calendar, setCalendar] = useState<CalendarResponse | null>(null);
  const [selected, setSelected] = useState<CalendarSelection>(null);
  const [periodSessions, setPeriodSessions] = useState<SessionsResponse | null>(null);
  const [periodCommits, setPeriodCommits] = useState<Commit[]>([]);
  const [periodLoading, setPeriodLoading] = useState(false);
  const [tab, setTab] = useState<ActivityTab>('rhythm');

  useEffect(() => {
    const params = new URLSearchParams();
    if (year !== null) params.set('year', String(year));
    if (teamId) params.set('teamId', teamId);
    if (personId) params.set('personId', personId);
    call<CalendarResponse>(`/api/dashboard/activity/calendar?${params.toString()}`).then((r) => {
      if (r.status === 200 && r.data) setCalendar(r.data);
    });
  }, [year, teamId, personId]);

  useEffect(() => {
    if (!selected) {
      setPeriodSessions(null);
      setPeriodCommits([]);
      return;
    }
    const rangeParam = selected.kind === 'day' ? `day:${selected.day}` : `range:${selected.start}..${selected.end}`;
    const params = new URLSearchParams({ range: rangeParam, limit: '50' });
    if (teamId) params.set('teamId', teamId);
    if (personId) params.set('personId', personId);
    setPeriodLoading(true);
    Promise.all([
      call<SessionsResponse>(`/api/dashboard/sessions?${params.toString()}`),
      call<{ commits: Commit[] }>(`/api/dashboard/commits?${params.toString()}`),
    ]).then(([sRes, cRes]) => {
      if (sRes.status === 200) setPeriodSessions(sRes.data);
      if (cRes.status === 200 && cRes.data) setPeriodCommits(cRes.data.commits);
      setPeriodLoading(false);
    });
  }, [selected, teamId, personId]);

  const selectDay = (day: string) =>
    setSelected((cur) => (cur?.kind === 'day' && cur.day === day ? null : { kind: 'day', day }));
  const selectWeek = (start: string, end: string) =>
    setSelected((cur) => (cur?.kind === 'week' && cur.start === start && cur.end === end ? null : { kind: 'week', start, end }));

  const labelRows = a.people.flatMap((p) => Object.entries(p.labels).map(([key, n]) => ({ pid: p.pid, key, n })));
  const selectedTitle = selected
    ? selected.kind === 'day'
      ? dayLabel(selected.day)
      : `Week of ${dayLabel(selected.start, false)} to ${dayLabel(selected.end, false)}`
    : '';

  return (
    <div className="space-y-10">
      <PageHead
        title="Activity"
        sub="Yearly contribution calendar and work rhythm. Click any day square or week column to inspect exact sessions, repositories, effort levels and commits."
        action={
          people.length > 0 && (
            <select
              aria-label="Filter calendar by person"
              value={personId}
              onChange={(e) => { setPersonId(e.target.value); setSelected(null); }}
              className="rounded-md border border-rule bg-card px-3 py-1.5 text-sm"
            >
              <option value="">Everyone in scope</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )
        }
      />

      {/* Full-width clickable GitHub-style Contribution Calendar */}
      <section aria-labelledby="cal-heading" className="rounded-xl border border-rule bg-card p-5">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="cal-heading" className="text-base font-semibold">
              {calendar ? (calendar.year ? `${calendar.year} contribution activity` : 'Last 12 months activity') : 'Contribution activity'}
            </h2>
            {calendar && (
              <p className="mt-0.5 text-xs text-muted">
                {calendar.totals.activeDays} active days, {calendar.totals.requests.toLocaleString()} requests, {calendar.totals.sessions.toLocaleString()} sessions, {usd(calendar.totals.costUsd)}, {calendar.totals.commits.toLocaleString()} enrolled commits
              </p>
            )}
          </div>
          <Chips
            label="Calendar metric"
            value={metric}
            onChange={setMetric}
            options={[
              ['requests', 'Requests'],
              ['costUsd', 'Cost'],
              ['sessions', 'Sessions'],
              ['commits', 'Commits'],
            ]}
          />
        </header>

        {calendar ? (
          <ContributionCalendar
            data={calendar}
            metric={metric}
            selected={selected}
            onSelectDay={selectDay}
            onSelectWeek={selectWeek}
            onSelectYear={(y) => { setYear(y); setSelected(null); }}
          />
        ) : (
          <p className="py-6 text-sm text-muted">Loading contribution calendar…</p>
        )}
      </section>

      {/* Selected Day / Week Drill-Down Inspector */}
      {selected && (
        <section aria-label="Selected period details" className="rounded-xl border border-ink bg-card p-5">
          <header className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-rule pb-3">
            <div>
              <h2 className="text-lg font-semibold">{selectedTitle}</h2>
              <p className="text-xs text-muted">Detailed sessions, effort levels, repositories and enrolled commits for this period.</p>
            </div>
            <button type="button" onClick={() => setSelected(null)}
              className="rounded-md border border-rule bg-paper px-3 py-1 text-xs font-medium hover:border-ink">
              Clear selection
            </button>
          </header>

          {periodLoading || !periodSessions ? (
            <p className="py-4 text-sm text-muted">Loading details…</p>
          ) : (
            <div className="space-y-6">
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-5">
                <Kpi label="Sessions" value={periodSessions.summary.totalSessions} />
                <Kpi label="Requests" value={periodSessions.summary.totalRequests.toLocaleString()} />
                <Kpi label="API cost" value={usd(periodSessions.summary.totalCostUsd)} />
                <Kpi label="xhigh requests" value={periodSessions.summary.xhighRequests.toLocaleString()}
                  pill={periodSessions.summary.xhighRequests > 0 ? <Pill tone="bad">{usd(periodSessions.summary.xhighCostUsd)}</Pill> : undefined} />
                <Kpi label="Enrolled commits" value={periodCommits.length} />
              </div>

              {periodSessions.sessions.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b border-rule">
                      <tr><Th>Person</Th><Th>Started</Th><Th>Duration</Th><Th>Repository</Th><Th>Effort & model</Th><Th right>Req</Th><Th right>Cost</Th><Th>Hooks</Th></tr>
                    </thead>
                    <tbody className="divide-y divide-rule">
                      {periodSessions.sessions.map((s) => (
                        <tr key={`${s.installationId}:${s.sessionId ?? s.startedAt}`} className="hover:bg-band/40">
                          <td className="whitespace-nowrap px-3 py-2.5">
                            {s.personId && go ? (
                              <button type="button" onClick={() => go(`/people/${s.personId}`)} className="inline-flex items-center gap-2 font-medium hover:underline">
                                <span className="h-2 w-2 rounded-[2px]" style={{ background: color(s.personId) }} aria-hidden />
                                {s.personName}
                              </button>
                            ) : <span className="font-medium">{s.personName}</span>}
                          </td>
                          <td className="whitespace-nowrap px-3 text-muted">{formatDateTime(s.startedAt, a.timezone)}</td>
                          <td className="whitespace-nowrap px-3 tabular-nums">{formatDuration(s.activeCliSec > 0 ? s.activeCliSec : s.spanSec)}</td>
                          <td className="px-3">
                            <div className="flex items-center gap-1.5">
                              <span className="max-w-[220px] truncate font-mono text-xs">{s.repo ?? 'No repository'}</span>
                              {s.repoClass === 'outside' && <Pill tone="warn">outside</Pill>}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-3">
                            <div className="flex items-center gap-1.5">
                              <EffortBadge effort={s.maxEffort} />
                              <span className="font-mono text-xs text-muted">{s.topModel.replace(/^claude-/, '')}</span>
                            </div>
                          </td>
                          <td className="px-3 text-right tabular-nums">{s.requests.toLocaleString()}</td>
                          <td className="px-3 text-right font-medium tabular-nums">{usd(s.costUsd)}</td>
                          <td className="px-3">{s.hooksActive ? <Pill tone="good">Active</Pill> : <Pill tone="bad">Unbound</Pill>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-muted">No Claude Code sessions recorded in this period.</p>
              )}

              {periodCommits.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold">Enrolled commits ({periodCommits.length})</h3>
                  <ul className="divide-y divide-rule text-xs">
                    {periodCommits.slice(0, 12).map((c) => (
                      <li key={c.repo + c.sha} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                        <span className="flex flex-wrap items-center gap-2">
                          <strong className="font-medium text-ink">{c.person ?? c.authorEmail}</strong>
                          <span className="font-mono text-muted">{c.repo}</span>
                          <span className="rounded bg-band px-1 font-mono">{c.sha.slice(0, 8)}</span>
                          {c.message && <span className="text-ink">{c.message.split('\n')[0]}</span>}
                        </span>
                        <span className="tabular-nums text-muted">+{c.additions} / -{c.deletions}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* Organized 3-tab Operational Breakdown */}
      <section className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink pb-3">
          <div>
            <h2 className="text-lg font-semibold">When the team works</h2>
            <p className="text-sm text-muted">Operational breakdown for {a.range.label ?? a.range.key}.</p>
          </div>
          <div role="tablist" aria-label="Activity details" className="inline-flex rounded-md bg-band p-1 text-sm">
            {([
              ['rhythm', 'Weekly rhythm'],
              ['tools', 'Tools & errors'],
              ['modes', 'Modes & labels'],
            ] as [ActivityTab, string][]).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={`rounded px-3 py-1 font-medium ${tab === k ? 'bg-card text-ink shadow-[0_0_0_1px_var(--rule)]' : 'text-muted hover:text-ink'}`}>
                {l}
              </button>
            ))}
          </div>
        </div>

        {tab === 'rhythm' && (
          <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="rounded-xl border border-rule bg-card p-5">
              <HourHeatmap cells={a.activity.heatmap} tz={a.timezone} />
            </div>
            <div className="rounded-xl border border-rule bg-card p-5">
              <h3 className="text-base font-semibold">Effort distribution</h3>
              <p className="mt-0.5 text-xs text-muted">Requests and API-priced value by reasoning effort level.</p>
              {a.efforts && a.efforts.length > 0 ? (
                <dl className="mt-4 divide-y divide-rule text-sm">
                  {a.efforts.map((e) => (
                    <div key={e.effort} className="flex items-center justify-between gap-3 py-2.5">
                      <dt className="flex items-center gap-2"><EffortBadge effort={e.effort} /><span className="text-xs text-muted">{e.sessions} sessions</span></dt>
                      <dd className="tabular-nums text-right">
                        <span className="font-medium">{usd(e.cost)}</span>
                        <span className="ml-2 text-xs text-muted">{e.requests.toLocaleString()} req</span>
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : <p className="mt-4 text-sm text-muted">No effort data in this range.</p>}
            </div>
          </div>
        )}

        {tab === 'tools' && (
          <div className="space-y-6">
            <Card title="Tools" sub="Calls Claude executed on everyone’s behalf. Durations are per call.">
              <div className="overflow-x-auto">
                <table className="w-full text-sm tabular-nums">
                  <thead className="border-b border-rule">
                    <tr><Th>Tool</Th><Th right>Calls</Th><Th right>Failed</Th><Th right>Typical (p50)</Th><Th right>Slowest 5% (p95)</Th></tr>
                  </thead>
                  <tbody className="divide-y divide-rule">
                    {a.activity.tools.map((t) => (
                      <tr key={t.tool}>
                        <th scope="row" className="px-3 py-2 text-left font-medium">{t.tool}</th>
                        <td className="px-3 text-right">{t.calls.toLocaleString()}</td>
                        <td className="px-3 text-right">{t.failures ? `${pct(t.failures, t.calls)}%` : '0%'}</td>
                        <td className="px-3 text-right">{t.p50 === null ? '' : `${(t.p50 / 1000).toFixed(1)} s`}</td>
                        <td className="px-3 text-right">{t.p95 === null ? '' : `${(t.p95 / 1000).toFixed(1)} s`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!a.activity.tools.length && <p className="py-4 text-sm text-muted">No tool calls in this range.</p>}
              </div>
            </Card>
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="rounded-xl border border-rule bg-card p-5">
                <h3 className="text-base font-semibold">Subagents</h3>
                <ul className="mt-2 divide-y divide-rule text-sm">
                  {a.activity.subagents.map((s) => <li key={s.agent} className="flex justify-between py-2"><span>{s.agent}</span><span className="text-muted">{s.n} runs</span></li>)}
                  {!a.activity.subagents.length && <li className="py-2 text-muted">None in this range.</li>}
                </ul>
              </div>
              <div className="rounded-xl border border-rule bg-card p-5">
                <h3 className="text-base font-semibold">API errors</h3>
                <ul className="mt-2 divide-y divide-rule text-sm">
                  {a.activity.errors.map((e) => <li key={e.status} className="flex justify-between py-2"><span>HTTP {e.status}</span><span className="text-muted">{e.n}×</span></li>)}
                  {!a.activity.errors.length && <li className="py-2 text-muted">None in this range.</li>}
                </ul>
              </div>
            </div>
          </div>
        )}

        {tab === 'modes' && (
          <div className="grid gap-6 lg:grid-cols-2">
            <SplitTable a={a} rows={a.activity.permissionModes} title="Permission mode" note="Share of tool decisions made in each mode." highlight="bypassPermissions" formatKey={formatPermissionMode} />
            <SplitTable a={a} rows={a.activity.entrypoints} title="How Claude Code started" note="cli is interactive; sdk entries are scripts, CI or integrations." />
            <SplitTable a={a} rows={a.activity.querySources} title="Request sources" note="Interactive conversation vs subagents and background calls." formatKey={formatQuerySource} />
            <SplitTable a={a} rows={labelRows} title="On-device prompt labels" note="Matched locally by keyword; only the category leaves the device." highlight="credential-pasted" counts />
          </div>
        )}
      </section>
    </div>
  );
}

export function Git({ a, team, isSuper = true, go, onChange }: {
  a: A; team: Person[]; isSuper?: boolean; go?: Go; onChange: () => void;
}) {
  const color = useColors(a);
  const gl = a.git.gitlabConfigured;
  const [msg, setMsg] = useState('');
  const [mapOpen, setMapOpen] = useState(false);
  const days = daysBetween(a.range.start, a.range.end, a.timezone);
  const claude = a.people.reduce((s, p) => s + p.claude.commits, 0);
  const prs = a.people.reduce((s, p) => s + p.claude.prs, 0);
  const added = a.people.reduce((s, p) => s + p.claude.added, 0);
  const removed = a.people.reduce((s, p) => s + p.claude.removed, 0);
  const all = a.git.gitlabDaily.reduce((s, d) => s + d.commits, 0);
  const cost = a.people.reduce((s, p) => s + p.cost, 0);
  const acc = a.git.edits.reduce((s, e) => s + e.accepted, 0), rej = a.git.edits.reduce((s, e) => s + e.rejected, 0);

  const pids = [...new Set(a.git.gitlabDaily.map((d) => d.pid))];
  const allSeries: Series[] = pids.map((pid) => ({
    id: String(pid), label: nameOf(a, pid), color: pid === null ? 'var(--muted)' : color(pid),
    values: days.map((d) => a.git.gitlabDaily.find((x) => x.day === d && x.pid === pid)?.commits ?? 0),
  }));
  const claudeSeries: Series[] = [...new Set(a.git.claudeDaily.map((d) => d.pid))].map((pid) => ({
    id: String(pid), label: nameOf(a, pid), color: color(pid),
    values: days.map((d) => a.git.claudeDaily.find((x) => x.day === d && x.pid === pid)?.commits ?? 0),
  }));

  const sync = async () => {
    setMsg('Syncing…');
    const r = await call('/api/dashboard/git/sync', 'POST');
    const n = (r.data?.gitlab?.commits ?? 0) + (r.data?.github?.commits ?? 0);
    setMsg(r.status === 200 ? `Synced: ${n} new commits.` : r.data?.error ?? 'Sync failed.');
    onChange();
  };

  const assign = async (email: string, pid: number) => {
    const person = team.find((p) => p.id === pid);
    if (person) await call(`/api/dashboard/people/${pid}/git-emails`, 'PUT', { emails: [...person.gitEmails, email] });
    onChange();
  };

  return (
    <div className="space-y-10">
      <PageHead
        title="Git output"
        sub="Strictly scoped to enrolled teammates. Commits from non-enrolled org members stay hidden until you map their email."
        action={
          <div className="flex flex-wrap items-center gap-2">
            {a.git.unmappedAuthors.length > 0 && (
              <button
                type="button"
                onClick={() => setMapOpen(true)}
                className="rounded-md border border-rule bg-card px-3 py-1.5 text-sm font-medium hover:border-ink"
              >
                Map teammate emails ({a.git.unmappedAuthors.length})
              </button>
            )}
            {gl && isSuper && (
              <button type="button" className="rounded-md bg-ink px-3.5 py-1.5 text-sm font-medium text-paper" onClick={sync}>
                Sync commits now
              </button>
            )}
          </div>
        }
      />

      {(msg || a.git.lastSync) && gl && (
        <p className="-mt-6 text-xs text-muted">
          {msg || (a.git.lastSync ? `Last synced ${ago(a.git.lastSync)}` : 'Not synced yet')}
        </p>
      )}

      {!gl && (
        <p className="rounded-lg border border-rule bg-card px-5 py-4 text-sm">
          To compare Claude commits against all team commits, set <code>GITLAB_TOKEN</code> + <code>GITLAB_GROUP</code> and/or{' '}
          <code>GITHUB_TOKEN</code> + <code>GITHUB_ORG</code> in the server environment, then map each teammate’s commit email.
        </p>
      )}

      <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Team commits" value={gl ? all.toLocaleString() : 'n/a'}
          pill={gl && all > 0 ? <Pill tone="good">{Math.min(100, pct(claude, all))}% by Claude</Pill> : undefined}
          foot="Enrolled teammates only" />
        <Kpi label="Claude commits" value={claude.toLocaleString()}
          foot={`${prs} PRs / MRs${claude ? `, ${usd(cost / claude)} per commit` : ''}`} />
        <Kpi label="Lines Claude wrote" value={`+${compact(added)}`} foot={`-${compact(removed)} removed`} />
        <Kpi label="Edits accepted" value={acc + rej ? `${pct(acc, acc + rej)}%` : 'n/a'}
          foot={`${acc.toLocaleString()} accepted, ${rej.toLocaleString()} rejected`} />
      </div>

      <div className="grid gap-8 xl:grid-cols-2">
        {gl && (
          <Card title="Team commits by day" sub="Synced commits authored by enrolled teammates.">
            {all ? <StackedBars label="Team commits by day" days={days} series={allSeries} format={(n) => String(Math.round(n))} height={200} />
              : <p className="text-sm text-muted">No synced commits from enrolled teammates in this range.</p>}
          </Card>
        )}
        <Card title="Claude commits by day" sub="Commits reported directly by Claude Code telemetry.">
          {claude ? <StackedBars label="Claude commits by day" days={days} series={claudeSeries} format={(n) => String(Math.round(n))} height={200} />
            : <p className="text-sm text-muted">No commits reported by Claude in this range.</p>}
        </Card>
      </div>

      <Card title="Output by person">
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="border-b border-rule">
              <tr>
                <Th>Person</Th>
                <Th right>Claude commits</Th>
                <Th right>PRs</Th>
                <Th right>Claude lines</Th>
                {gl && <><Th right>Team commits</Th><Th right>Team lines</Th><Th right>Claude share</Th></>}
                <Th right>Hands-on</Th>
                <Th right>Claude active</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {a.people.map((p) => (
                <tr key={p.pid} className="hover:bg-band/40">
                  <th scope="row" className="px-3 py-2.5 text-left font-medium">
                    {p.isPerson && go ? (
                      <button type="button" onClick={() => go(`/people/${p.pid}`)} className="inline-flex items-center gap-2 hover:underline">
                        <span className="h-2 w-2 rounded-[2px]" style={{ background: color(p.pid) }} aria-hidden />
                        <span>{p.name}</span>
                        {p.teamName && <Pill tone="neutral">{p.teamName}</Pill>}
                      </button>
                    ) : p.name}
                  </th>
                  <td className="px-3 text-right">{p.claude.commits}</td>
                  <td className="px-3 text-right">{p.claude.prs}</td>
                  <td className="px-3 text-right">+{compact(p.claude.added)} / -{compact(p.claude.removed)}</td>
                  {gl && (
                    <>
                      <td className="px-3 text-right font-medium">{p.gitlab.commits}</td>
                      <td className="px-3 text-right">+{compact(p.gitlab.additions)} / -{compact(p.gitlab.deletions)}</td>
                      <td className="px-3 text-right">{p.gitlab.commits ? `${Math.min(100, pct(p.claude.commits, p.gitlab.commits))}%` : ''}</td>
                    </>
                  )}
                  <td className="px-3 text-right">{(p.claude.activeUserSec / 3600).toFixed(1)} h</td>
                  <td className="px-3 text-right">{(p.claude.activeCliSec / 3600).toFixed(1)} h</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal
        open={mapOpen}
        onClose={() => setMapOpen(false)}
        title="Map teammate commit emails"
        sub="These org emails pushed commits but are not linked to any enrolled teammate. Assign an email to immediately backfill their commit history."
      >
        {a.git.unmappedAuthors.length ? (
          <ul className="max-h-[60vh] divide-y divide-rule overflow-y-auto text-sm">
            {a.git.unmappedAuthors.map((u) => (
              <li key={u.email} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs font-medium">{u.email}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {u.commits} commit{u.commits === 1 ? '' : 's'}
                    {u.repos && u.repos.length > 0 ? ` in ${u.repos.slice(0, 2).join(', ')}${u.repos.length > 2 ? ` +${u.repos.length - 2}` : ''}` : ''}
                  </p>
                </div>
                <select
                  aria-label={`Assign ${u.email}`}
                  className="rounded-md border border-rule bg-paper px-2.5 py-1.5 text-xs"
                  defaultValue=""
                  onChange={(e) => e.target.value && assign(u.email, Number(e.target.value))}
                >
                  <option value="">Assign to…</option>
                  {team.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-4 text-sm text-muted">Every synced commit author is mapped.</p>
        )}
      </Modal>
    </div>
  );
}
