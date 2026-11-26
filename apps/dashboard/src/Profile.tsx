import { useEffect, useMemo, useState } from 'react';
import { HourHeatmap } from './charts.tsx';
import {
  call, compact, formatDateTime, formatDuration, formatPermissionMode, formatQuerySource, pct, usd,
  type Profile as P, type SessionsResponse,
} from './lib.ts';
import { Chips, EffortBadge, Kpi, Pill, Th } from './ui.tsx';

const CLASS_LABEL = { work: 'Work repositories', outside: 'Outside work repositories', none: 'No repository' };
type ProfileTab = 'sessions' | 'repos' | 'how';
type SessionFilter = 'all' | 'xhigh' | 'outside';

export function Profile({ personId, range = 'window', hideHeader = false }: {
  personId: number; range?: string; hideHeader?: boolean;
}) {
  const [p, setP] = useState<P | null>(null);
  const [sessions, setSessions] = useState<SessionsResponse | null>(null);
  const [tab, setTab] = useState<ProfileTab>('sessions');
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>('all');

  useEffect(() => {
    setP(null);
    Promise.all([
      call<P>(`/api/dashboard/people/${personId}/profile?range=${encodeURIComponent(range)}`),
      call<SessionsResponse>(`/api/dashboard/sessions?range=${encodeURIComponent(range)}&personId=${personId}&limit=50`),
    ]).then(([pr, sr]) => {
      if (pr.status === 200) setP(pr.data);
      if (sr.status === 200) setSessions(sr.data);
    });
  }, [personId, range]);

  const filteredSessions = useMemo(() => {
    const list = sessions?.sessions ?? [];
    if (sessionFilter === 'xhigh') return list.filter((s) => s.maxEffort === 'xhigh' || s.efforts.some((e) => e.effort === 'xhigh'));
    if (sessionFilter === 'outside') return list.filter((s) => s.repoClass === 'outside' || s.repoClass === 'none');
    return list;
  }, [sessions, sessionFilter]);

  if (!p) return <p className="py-6 text-sm text-muted">Loading profile…</p>;

  const repoTotal = p.repoShare.work + p.repoShare.outside + p.repoShare.none;
  const outsideShare = pct(p.repoShare.outside, repoTotal);
  const xhigh = p.efforts?.find((e) => e.effort === 'xhigh');
  const rangeLabel = p.range?.label ?? `Last ${p.days} days`;

  return (
    <section aria-labelledby="profile" className={hideHeader ? 'space-y-8' : 'space-y-8 py-8'}>
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-ink pb-3">
        <div>
          <h2 id="profile" className="text-xl font-semibold">
            {hideHeader ? `Usage breakdown (${rangeLabel})` : p.person.name}
          </h2>
          <p className="mt-1 text-sm text-muted">
            All enrolled devices: {p.totals.requests.toLocaleString()} requests, {compact(p.totals.outputTokens)} output tokens, {usd(p.totals.cost)} at API prices.
          </p>
        </div>
        <div role="tablist" aria-label="Profile sections" className="inline-flex rounded-md bg-band p-1 text-sm">
          {([
            ['sessions', `Sessions (${sessions?.summary.totalSessions ?? p.totals.sessions ?? 0})`],
            ['repos', 'Repositories & hours'],
            ['how', 'Models & tools'],
          ] as [ProfileTab, string][]).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
              className={`rounded px-3 py-1 font-medium ${tab === k ? 'bg-card text-ink shadow-[0_0_0_1px_var(--rule)]' : 'text-muted hover:text-ink'}`}>
              {l}
            </button>
          ))}
        </div>
      </header>

      <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-5">
        <Kpi label="Work (API est.)" value={usd(p.totals.cost)} foot={rangeLabel} />
        <Kpi label="Sessions" value={sessions?.summary.totalSessions ?? p.totals.sessions ?? 0}
          pill={sessions?.summary.unhookedSessions ? <Pill tone="bad">{sessions.summary.unhookedSessions} unbound</Pill> : undefined}
          foot={`${p.totals.requests.toLocaleString()} API requests`} />
        <Kpi label="xhigh effort" value={xhigh ? xhigh.requests.toLocaleString() : '0'}
          pill={xhigh && xhigh.requests > 0 ? <Pill tone="bad">{usd(xhigh.cost)}</Pill> : <Pill tone="neutral">none</Pill>}
          foot={xhigh && xhigh.sessions ? `${xhigh.sessions} session${xhigh.sessions === 1 ? '' : 's'}` : 'No xhigh usage'} />
        <Kpi label="Outside work" value={p.workNamespacesSet ? `${outsideShare}%` : '—'}
          pill={p.workNamespacesSet && outsideShare > 0 ? <Pill tone={outsideShare >= 40 ? 'warn' : 'neutral'}>{usd(p.repoShare.outside)}</Pill> : undefined}
          foot={p.workNamespacesSet ? `${pct(p.repoShare.work, repoTotal)}% in work repos` : 'Set work namespaces in Settings'} />
        <Kpi label="Guard blocks" value={p.guard?.blocked ?? 0}
          pill={(p.guard?.blocked ?? 0) > 0 ? <Pill tone="bad">blocked</Pill> : <Pill tone="good">clear</Pill>}
          foot={(p.guard?.warned ?? 0) > 0 ? `${p.guard!.warned} warnings` : 'On-device repo guard'} />
      </div>

      {tab === 'sessions' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">Every Claude Code session with start time, duration, repository, peak effort level and plugin hook status.</p>
            <Chips
              label="Filter sessions"
              value={sessionFilter}
              onChange={setSessionFilter}
              options={[
                ['all', 'All', sessions?.sessions.length ?? 0],
                ['xhigh', 'xhigh effort', sessions?.summary.xhighSessions ?? 0],
                ['outside', 'Outside / no repo', sessions?.summary.outsideSessions ?? 0],
              ]}
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-rule">
                <tr>
                  <Th>Started</Th>
                  <Th>Duration</Th>
                  <Th>Device</Th>
                  <Th>Repository</Th>
                  <Th>Peak effort & model</Th>
                  <Th right>Prompts</Th>
                  <Th right>Req</Th>
                  <Th right>Cost</Th>
                  <Th>Hooks</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {filteredSessions.map((s) => (
                  <tr key={`${s.installationId}:${s.sessionId ?? s.startedAt}`} className="hover:bg-band/40">
                    <td className="whitespace-nowrap px-3 py-2.5">{formatDateTime(s.startedAt, p.timezone)}</td>
                    <td className="whitespace-nowrap px-3 tabular-nums">
                      {formatDuration(s.activeCliSec > 0 ? s.activeCliSec : s.spanSec)}
                      {s.spanSec > 0 && s.activeCliSec > 0 && <span className="block text-xs text-muted">span {formatDuration(s.spanSec)}</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 text-muted">{s.deviceName}</td>
                    <td className="px-3">
                      <div className="flex items-center gap-1.5">
                        <span className="max-w-[220px] truncate font-mono text-xs" title={s.repo ?? undefined}>{s.repo ?? 'No repository'}</span>
                        {s.repoClass === 'outside' && p.workNamespacesSet && <Pill tone="warn">outside</Pill>}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <EffortBadge effort={s.maxEffort} />
                        <span className="font-mono text-xs text-muted">{s.topModel.replace(/^claude-/, '')}</span>
                      </div>
                    </td>
                    <td className="px-3 text-right tabular-nums text-muted">{s.prompts || '—'}</td>
                    <td className="px-3 text-right tabular-nums">{s.requests.toLocaleString()}</td>
                    <td className="px-3 text-right font-medium tabular-nums">{usd(s.costUsd)}</td>
                    <td className="px-3">{s.hooksActive ? <Pill tone="good">Active</Pill> : <Pill tone="bad">Unbound</Pill>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!filteredSessions.length && <p className="py-6 text-center text-sm text-muted">No sessions match in this range.</p>}
          </div>
        </div>
      )}

      {tab === 'repos' && (
        <div className="space-y-10">
          <div>
            <h3 className="text-lg font-semibold">Repositories</h3>
            {!p.workNamespacesSet && (
              <p className="mt-1 text-sm text-ahead">List your work namespaces in Settings to split work from outside repositories.</p>
            )}
            <ul className="mt-4 grid gap-4 sm:grid-cols-3">
              {(['work', 'outside', 'none'] as const).filter((c) => p.workNamespacesSet || c !== 'work').map((c) => (
                <Bar key={c} label={c === 'outside' && !p.workNamespacesSet ? 'With a repository' : CLASS_LABEL[c]}
                  value={p.repoShare[c]} total={repoTotal} note={`${pct(p.repoShare[c], repoTotal)}% · ${usd(p.repoShare[c])}`} />
              ))}
            </ul>
            {p.repos.length > 0 && (
              <div className="mt-6 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-rule">
                    <tr><Th>Repository</Th><Th>Class</Th><Th right>Sessions</Th><Th right>Requests</Th><Th right>Cost</Th></tr>
                  </thead>
                  <tbody className="divide-y divide-rule">
                    {p.repos.map((r) => (
                      <tr key={r.repo ?? '-'}>
                        <td className="px-3 py-2.5">{r.repo ? <span className="font-mono text-xs">{r.repo}</span> : <span className="text-muted">No repository</span>}</td>
                        <td className="px-3">
                          {r.class === 'work' ? <Pill tone="good">work</Pill> : r.class === 'outside' && p.workNamespacesSet ? <Pill tone="warn">outside work</Pill> : <Pill tone="neutral">{r.class === 'none' ? 'no repo' : 'repo'}</Pill>}
                        </td>
                        <td className="px-3 text-right tabular-nums">{r.sessions ?? '—'}</td>
                        <td className="px-3 text-right tabular-nums">{r.requests.toLocaleString()}</td>
                        <td className="px-3 text-right font-medium tabular-nums">{usd(r.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div>
            <h3 className="text-lg font-semibold">When they work</h3>
            <div className="mt-2"><HourHeatmap cells={p.hours} tz={p.timezone} /></div>
          </div>
        </div>
      )}

      {tab === 'how' && <How p={p} />}

      <p className="max-w-[68ch] border-t border-rule pt-5 text-xs text-muted">
        Scope note: numbers cover Claude Code telemetry only (not claude.ai web chat). Prompt and file contents stay on the device unless explicitly enabled in Settings.
      </p>
    </section>
  );
}

function Bar({ label, value, total, note }: { label: string; value: number; total: number; note: string }) {
  const s = total > 0 ? value / total : 0;
  return (
    <li className="rounded-lg border border-rule bg-card p-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted">{note}</span>
      </div>
      <div className="mt-2 h-1.5 rounded-[2px] bg-track" aria-hidden>
        <div className="h-full rounded-[2px] bg-fill" style={{ width: `${s * 100}%` }} />
      </div>
    </li>
  );
}

function DetailList({ title, rows, empty }: { title: string; rows: { label: string; meta: string; badge?: string | null }[]; empty: string }) {
  return (
    <div className="rounded-lg border border-rule bg-card p-4">
      <h4 className="text-sm font-semibold">{title}</h4>
      {rows.length === 0 ? <p className="mt-2 text-sm text-muted">{empty}</p> : (
        <dl className="mt-2 divide-y divide-rule text-sm">
          {rows.map((r) => (
            <div key={r.label + (r.badge ?? '')} className="flex items-center justify-between gap-3 py-2">
              <dt className="flex min-w-0 items-center gap-2 truncate">
                <span className="truncate">{r.label}</span>
                {r.badge && <EffortBadge effort={r.badge} />}
              </dt>
              <dd className="shrink-0 text-xs text-muted tabular-nums">{r.meta}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function How({ p }: { p: P }) {
  const decisions = p.permissionModes.reduce((s, m) => s + m.n, 0);
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <DetailList
        title="Models & effort"
        empty="No requests in this range."
        rows={p.models.map((m) => ({
          label: m.model.replace(/^claude-/, ''),
          badge: m.effort,
          meta: `${m.requests.toLocaleString()} req · ${usd(m.cost)}`,
        }))}
      />
      <DetailList
        title="Request sources"
        empty="No requests in this range."
        rows={p.querySources.map((q) => ({
          label: formatQuerySource(q.source),
          meta: `${q.requests.toLocaleString()} req · ${usd(q.cost)}`,
        }))}
      />
      <DetailList
        title="Tools used"
        empty="No tool calls reported."
        rows={p.tools.map((t) => ({
          label: t.tool,
          meta: `${t.calls.toLocaleString()} call${t.calls === 1 ? '' : 's'}${t.failures ? ` (${t.failures} failed)` : ''}`,
        }))}
      />
      <DetailList
        title="Permission modes"
        empty="No tool decisions reported."
        rows={p.permissionModes.map((m) => ({
          label: formatPermissionMode(m.mode),
          meta: `${pct(m.n, decisions)}% (${m.n.toLocaleString()})`,
        }))}
      />
      <DetailList
        title="Prompts & context"
        empty="No prompts recorded."
        rows={[
          { label: 'Prompts sent', meta: p.prompts.count.toLocaleString() },
          { label: 'Average prompt length', meta: `${p.prompts.avgLength.toLocaleString()} chars` },
          ...p.compactions.map((c) => ({ label: `Compactions (${c.trigger})`, meta: String(c.n) })),
        ]}
      />
      <DetailList
        title="Subagents & API errors"
        empty="No subagents or errors."
        rows={[
          ...p.subagents.map((s) => ({ label: `Subagent: ${s.agent}`, meta: `${s.n} runs` })),
          ...p.apiErrors.map((e) => ({ label: `API error ${e.status}`, meta: `${e.n}×` })),
        ]}
      />
    </div>
  );
}
