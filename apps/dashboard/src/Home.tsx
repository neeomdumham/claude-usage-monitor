import { useEffect, useMemo, useState } from 'react';
import { BurnChart, ShareBars, StackedBars, type Series } from './charts.tsx';
import { Meter } from './Meter.tsx';
import {
  ago, call, compact, daysBetween, describeAudit, formatDateTime, formatDuration, isOutdated, pct, personColors, until, usd,
  type Analytics as A, type AuditEvent, type Flag, type Overview, type SessionsResponse,
} from './lib.ts';
import { Chips, EffortBadge, Kpi, Pill, Th } from './ui.tsx';

export type Go = (route: string) => void;

type SessionTab = 'recent' | 'xhigh' | 'cost' | 'outside';

export function Home({ data, a, range, teamId, onRange, onInvite, go, reload }: {
  data: Overview; a: A; range: string; teamId: string;
  onRange: (r: string) => void; onInvite: () => void; go: Go; reload: () => void;
}) {
  const tz = data.policy.data.displayTimezone;
  const color = personColors(a.people.map((p) => p.pid));
  const weekly = data.meters.find((m) => m.meterKey === 'seven_day');
  const fiveHour = data.meters.find((m) => m.meterKey === 'five_hour');
  const [recent, setRecent] = useState<AuditEvent[] | null>(null);
  const [sessionTab, setSessionTab] = useState<SessionTab>('recent');
  const [sessionsData, setSessionsData] = useState<SessionsResponse | null>(null);

  const teamQs = teamId ? `&teamId=${encodeURIComponent(teamId)}` : '';

  useEffect(() => {
    call<{ events: AuditEvent[] }>(`/api/dashboard/audit?limit=30${teamQs}`).then((r) => {
      const raw = (r.data?.events ?? []).filter((e) => e.action !== 'auth.login');
      // Deduplicate consecutive 0-commit sync heartbeats so real events stay visible.
      const deduped: AuditEvent[] = [];
      let seenZeroSync = false;
      for (const ev of raw) {
        const isZeroSync = ev.action === 'git.sync' &&
          ((ev.details?.github?.commits ?? 0) === 0) &&
          ((ev.details?.gitlab?.commits ?? ev.details?.commits ?? 0) === 0);
        if (isZeroSync) {
          if (seenZeroSync) continue;
          seenZeroSync = true;
        }
        deduped.push(ev);
        if (deduped.length >= 8) break;
      }
      setRecent(deduped);
    });
  }, [data, a, teamQs]);

  useEffect(() => {
    const sort = sessionTab === 'cost' ? 'cost' : sessionTab === 'xhigh' ? 'effort' : 'recent';
    const eff = sessionTab === 'xhigh' ? '&effort=xhigh' : '';
    call<SessionsResponse>(`/api/dashboard/sessions?range=${encodeURIComponent(range)}&sort=${sort}&limit=25${eff}${teamQs}`)
      .then((r) => { if (r.status === 200) setSessionsData(r.data); });
  }, [range, sessionTab, teamQs, data]);

  const shared = new Set<string>();
  const open = a.flags.filter((f) => !f.review).filter((f) => {
    const fp = f.key.match(/:shared-(.+)$/)?.[1];
    if (!fp) return true;
    if (shared.has(fp)) return false;
    shared.add(fp);
    return true;
  });

  const live = data.installations.filter((d) => !d.revoked);
  const active = a.people.filter((p) => p.requests > 0).length;
  const total = a.people.reduce((s, p) => s + p.cost, 0);
  const totalSessions = a.people.reduce((s, p) => s + p.sessions, 0);
  const xhighEffort = a.efforts?.find((e) => e.effort === 'xhigh');
  const days = daysBetween(a.range.start, a.range.end, a.timezone);
  const suggestions = suggest(data, a);

  const start = Date.parse(a.range.start) / 1000, end = Date.parse(a.range.end) / 1000;
  const line = (key: string) => a.burn.filter((x) => x.meterKey === key)
    .flatMap((b) => [[Math.max(start, b.t0), b.pct], [Math.max(start, b.t1), b.pct]] as [number, number][]).sort((x, y) => x[0] - y[0]);
  const series: Series[] = a.people.filter((p) => p.requests > 0).map((p) => ({
    id: String(p.pid), label: p.name, color: color(p.pid), values: days.map((d) => a.daily.find((x) => x.day === d && x.pid === p.pid)?.cost ?? 0),
  }));
  const needs = open.length + suggestions.length;
  const rangeLabel = a.range.label ?? RANGE_NOTE[a.range.key] ?? 'Selected range';
  const burnMeterKey = range === 'five_hour' ? 'five_hour' : 'seven_day';

  const visibleSessions = useMemo(() => {
    const list = sessionsData?.sessions ?? [];
    if (sessionTab === 'outside') return list.filter((s) => s.repoClass === 'outside' || s.repoClass === 'none').slice(0, 10);
    return list.slice(0, 10);
  }, [sessionsData, sessionTab]);

  return (
    <div className="space-y-10">
      {data.people.length === 0 && (
        <section className="rounded-xl border border-rule bg-card p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="max-w-[60ch]">
              <h1 className="text-xl font-semibold">No teammates enrolled yet</h1>
              <p className="mt-1 text-sm text-muted">
                Send an invite link to your first teammate. Once they start a Claude Code session, allowance gauges, sessions, effort levels and repository activity will appear here.
              </p>
            </div>
            <button type="button" onClick={onInvite} className="whitespace-nowrap rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper">
              Invite teammate
            </button>
          </div>
        </section>
      )}

      {/* Allowance meters: click either window to align every metric and table below */}
      <section aria-label="Allowance" className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {weekly ? (
          <Meter m={weekly} tz={tz} hero selected={range === 'window'} onSelect={() => onRange('window')} />
        ) : (
          <div className="rounded-xl border border-rule bg-card p-5">
            <h2 className="text-base font-semibold">This week, all models</h2>
            <p className="mt-2 text-sm text-muted">No reading yet. It arrives with the next Claude Code response from any teammate, or enter one in Settings.</p>
          </div>
        )}
        {fiveHour ? (
          <Meter m={fiveHour} tz={tz} selected={range === 'five_hour'} onSelect={() => onRange('five_hour')} />
        ) : (
          <div className="rounded-xl border border-rule bg-card p-5">
            <h2 className="text-sm font-semibold">Current 5h window</h2>
            <p className="mt-2 text-sm text-muted">Waiting for the next Claude Code status-line reading.</p>
          </div>
        )}
      </section>

      {/* Range-synced KPI strip */}
      <section aria-label="Window summary">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-medium text-muted">
            Showing breakdown for <strong className="text-ink">{rangeLabel}</strong>
          </p>
          {(a.guard?.blocked ?? 0) > 0 && (
            <Pill tone="bad">{a.guard!.blocked} outside-work attempt{a.guard!.blocked === 1 ? '' : 's'} blocked</Pill>
          )}
        </div>
        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi label="People active" value={active} foot={`of ${data.people.length} enrolled, ${live.length} live devices`} />
          <Kpi
            label="Sessions"
            value={compact(totalSessions)}
            pill={sessionsData?.summary.unhookedSessions ? <Pill tone="bad">{sessionsData.summary.unhookedSessions} hooks off</Pill> : undefined}
            foot={rangeLabel}
          />
          <Kpi label="API-price value" value={usd(total)} foot="Estimate from Claude Code, not a bill" />
          <Kpi
            label="xhigh effort"
            value={xhighEffort ? compact(xhighEffort.requests) : '0'}
            pill={xhighEffort && xhighEffort.requests > 0 ? <Pill tone="bad">{usd(xhighEffort.cost)}</Pill> : <Pill tone="neutral">none</Pill>}
            foot={xhighEffort && xhighEffort.sessions > 0 ? `Across ${xhighEffort.sessions} session${xhighEffort.sessions === 1 ? '' : 's'}` : 'No xhigh requests in this window'}
          />
        </div>
      </section>

      {/* Recent & high-effort sessions ledger: answers WHO used xhigh, WHEN, WHERE, and FOR HOW LONG */}
      <section aria-labelledby="sessions-heading" className="min-w-0">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-ink pb-2">
          <div>
            <h2 id="sessions-heading" className="text-lg font-semibold">Recent & high-effort sessions</h2>
            <p className="text-sm text-muted">When each session ran, how long it lasted, repository, model effort and plugin hook status ({rangeLabel}).</p>
          </div>
          <Chips
            label="Session view"
            value={sessionTab}
            onChange={setSessionTab}
            options={[
              ['recent', 'Recent'],
              ['xhigh', 'xhigh effort', sessionsData?.summary.xhighSessions],
              ['cost', 'Highest cost'],
              ['outside', 'Outside work', sessionsData?.summary.outsideSessions],
            ]}
          />
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-rule">
              <tr>
                <Th>Person</Th>
                <Th>Started</Th>
                <Th>Duration</Th>
                <Th>Repository</Th>
                <Th>Effort & model</Th>
                <Th right>Req</Th>
                <Th right>Cost</Th>
                <Th>Hooks</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {visibleSessions.map((s) => (
                <tr key={`${s.installationId}:${s.sessionId ?? s.startedAt}`} className="hover:bg-band/40">
                  <td className="whitespace-nowrap px-3 py-2.5">
                    {s.personId ? (
                      <button type="button" onClick={() => go(`/people/${s.personId}`)} className="inline-flex items-center gap-2 font-medium hover:underline">
                        <span className="h-2 w-2 rounded-[2px]" style={{ background: color(s.personId) }} aria-hidden />
                        {s.personName}
                      </button>
                    ) : <span className="font-medium">{s.personName}</span>}
                    <span className="block text-xs text-muted">{s.deviceName}{s.teamName ? ` · ${s.teamName}` : ''}</span>
                  </td>
                  <td className="whitespace-nowrap px-3 text-muted">{formatDateTime(s.startedAt, tz)}</td>
                  <td className="whitespace-nowrap px-3 tabular-nums">
                    {formatDuration(s.activeCliSec > 0 ? s.activeCliSec : s.spanSec)}
                    {s.spanSec > 0 && s.activeCliSec > 0 && <span className="block text-xs text-muted">span {formatDuration(s.spanSec)}</span>}
                  </td>
                  <td className="px-3">
                    <div className="flex items-center gap-1.5">
                      <span className="max-w-[220px] truncate font-mono text-xs" title={s.repo ?? undefined}>{s.repo ?? 'No repository'}</span>
                      {s.repoClass === 'outside' && data.policy.data.workNamespaces.length > 0 && <Pill tone="warn">outside</Pill>}
                      {s.guardBlocked > 0 && <Pill tone="bad">{s.guardBlocked} blocked</Pill>}
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
                  <td className="px-3">
                    {s.hooksActive ? <Pill tone="good">Active</Pill> : <Pill tone="bad">Unbound</Pill>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!visibleSessions.length && (
            <p className="py-6 text-center text-sm text-muted">
              {sessionTab === 'xhigh' ? 'No xhigh-effort sessions in this window.' : sessionTab === 'outside' ? 'No outside-work sessions in this window.' : 'No sessions recorded in this window.'}
            </p>
          )}
        </div>
      </section>

      <div className="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section aria-labelledby="needs">
          <header className="mb-4 flex items-baseline justify-between gap-3 border-b border-ink pb-2">
            <h2 id="needs" className="text-lg font-semibold">Needs you</h2>
            <p className="text-sm text-muted">{needs ? `${open.length} flag${open.length === 1 ? '' : 's'}, ${suggestions.length} setup step${suggestions.length === 1 ? '' : 's'}` : 'All clear'}</p>
          </header>
          {open.length ? (
            <ol className="divide-y divide-rule">
              {open.slice(0, 6).map((f) => <FlagItem key={f.key} f={f} go={go} reload={reload} compact />)}
            </ol>
          ) : <p className="py-2 text-sm text-muted">No flags cross your thresholds in this range.</p>}
          {open.length > 6 && <button className="mt-2 text-sm text-muted underline hover:text-ink" onClick={() => go('/people')}>{open.length - 6} more on the People page</button>}
          {suggestions.length > 0 && (
            <ul className="mt-6 grid gap-2 sm:grid-cols-2">
              {suggestions.map((s) => (
                <li key={s.title}>
                  <button onClick={() => go(s.route)} className="h-full w-full rounded-md border border-dashed border-rule px-3 py-2 text-left hover:border-ink">
                    <p className="text-sm font-medium">{s.title}</p>
                    <p className="text-xs text-muted">{s.detail}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="who" className="min-w-0">
          <header className="mb-4 flex items-baseline justify-between gap-3 border-b border-ink pb-2">
            <h2 id="who" className="text-lg font-semibold">Who’s spending it</h2>
            <button className="text-sm text-muted hover:text-ink" onClick={() => go('/people')}>All people</button>
          </header>
          {total > 0 ? (
            <>
              <ShareBars rows={a.people.filter((p) => p.cost > 0).sort((x, y) => y.cost - x.cost).slice(0, 6).map((p) => ({
                id: p.pid, label: p.name, color: color(p.pid), value: p.cost, note: `${pct(p.cost, total)}%`,
                onClick: p.isPerson ? () => go(`/people/${p.pid}`) : undefined,
              }))} />
              {days.length > 1 && (
                <div className="mt-6">
                  <StackedBars label="Daily work by person" days={days} series={series} format={usd} height={150} />
                </div>
              )}
            </>
          ) : <p className="text-sm text-muted">No measured work in this window yet.</p>}
        </section>
      </div>

      <div className="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section aria-labelledby="burn" className="min-w-0">
          <header className="mb-4 border-b border-ink pb-2">
            <h2 id="burn" className="text-lg font-semibold">
              {burnMeterKey === 'five_hour' ? '5-hour allowance over time' : 'Weekly allowance over time'}
            </h2>
          </header>
          <BurnChart start={start} end={end} tz={a.timezone} pace={range === 'window' || range === 'five_hour'} height={200}
            lines={[{ id: burnMeterKey, label: burnMeterKey === 'five_hour' ? '5-hour' : 'Weekly', color: 'var(--fill)', points: line(burnMeterKey), width: 2.5 }]} />
        </section>
        <section aria-labelledby="recent">
          <header className="mb-2 flex items-baseline justify-between gap-3 border-b border-ink pb-2">
            <h2 id="recent" className="text-lg font-semibold">What happened recently</h2>
            <button className="text-sm text-muted hover:text-ink" onClick={() => go('/audit')}>Audit log</button>
          </header>
          {recent === null ? <p className="text-sm text-muted">Loading…</p> : recent.length ? (
            <ul className="divide-y divide-rule">
              {recent.map((e) => (
                <li key={e.id} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                  <span className={e.action.endsWith('failed') || e.action === 'guard.blocked' ? 'text-limit' : ''}>{describeAudit(e)}</span>
                  <span className="shrink-0 text-xs text-muted">{ago(e.at)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">Nothing yet.</p>}
        </section>
      </div>
    </div>
  );
}

const RANGE_NOTE: Record<string, string> = { five_hour: 'current 5h window', window: 'this allowance week', '7d': 'last 7 days', '30d': 'last 30 days' };

function suggest(data: Overview, a: A) {
  const out: { title: string; detail: string; route: string }[] = [];
  const live = data.installations.filter((d) => !d.revoked);
  if (!data.people.length) out.push({ title: 'Invite your first teammate', detail: 'They join with a link; nothing to set up on their side.', route: '/people' });
  for (const p of data.people.filter((p) => !p.openInvite && !data.installations.some((d) => d.personId === p.id))) {
    out.push({ title: `Send ${p.name} a link`, detail: 'No device and no open invite.', route: '/people' });
  }
  for (const p of data.people.filter((p) => p.openInvite && Date.parse(p.openInvite.expiresAt) - Date.now() < 24 * 3600_000)) {
    out.push({ title: `${p.name}'s link expires in ${until(Date.parse(p.openInvite!.expiresAt) / 1000)}`, detail: `${p.openInvite!.uses} of ${p.openInvite!.maxUses} devices joined so far.`, route: '/people' });
  }
  const old = live.filter((d) => isOutdated(d.clientVersion, data.latestPluginVersion)).length;
  if (old) out.push({ title: `${old} device${old > 1 ? 's need' : ' needs'} a plugin update`, detail: `Running a deprecated plugin version. Latest is v${data.latestPluginVersion}; open Devices for the GitLab-to-GitHub update command.`, route: '/devices' });
  if (data.viewer.role === 'superadmin') {
    if (!data.policy.data.workNamespaces.length) out.push({ title: 'List your work repositories', detail: 'Needed to split work from outside repos and enable blocking.', route: '/settings' });
    if (!a.git.gitlabConfigured) out.push({ title: 'Connect GitLab or GitHub', detail: 'Count every commit, not only the ones Claude made.', route: '/git' });
    if (!data.meters.length) out.push({ title: 'No allowance reading yet', detail: 'Enter one by hand, or wait for a teammate to use Claude Code.', route: '/settings' });
  }
  if (a.git.unmappedAuthors.length) out.push({ title: `${a.git.unmappedAuthors.length} commit emails aren't matched`, detail: 'Map them to teammates on the Git page so their commits count.', route: '/git' });
  return out.slice(0, 5);
}

/** A flag with its evidence and review action (no one-sided border stripe). */
export function FlagItem({ f, n, go, reload, compact: small = false, onPersonPage = false }: { f: Flag; n?: number; go: Go; reload: () => void; compact?: boolean; onPersonPage?: boolean }) {
  const [reviewing, setReviewing] = useState(false);
  const [note, setNote] = useState('');
  return (
    <li className="py-3">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {n !== undefined && <span className="text-muted">{n}</span>}
          <Pill tone={f.review ? 'neutral' : f.severity === 'alert' ? 'bad' : 'warn'}>
            {f.review ? 'Reviewed' : f.severity === 'alert' ? 'Alert' : 'Watch'}
          </Pill>
          <span>{f.title}</span>
          {!onPersonPage && (
            <span className="text-xs font-normal">
              {f.pid > 0 ? <button className="text-muted underline hover:text-ink" onClick={() => go(`/people/${f.pid}`)}>{f.person}</button> : <span className="text-muted">{f.person}</span>}
            </span>
          )}
        </p>
        {!small && <p className="mt-1 text-sm">{f.evidence}</p>}
        <p className="mt-1 text-xs text-muted">{small ? f.evidence : `Keep in mind: ${f.caveat}`}</p>
        {f.review ? (
          <p className="mt-1.5 text-xs text-muted">Reviewed {ago(f.review.at)}{f.review.note ? `: "${f.review.note}"` : ''}</p>
        ) : reviewing ? (
          <form className="mt-2 flex flex-wrap gap-2" onSubmit={async (e) => {
            e.preventDefault();
            await call('/api/dashboard/flags/review', 'POST', { key: f.key, note });
            setReviewing(false); reload();
          }}>
            <input autoFocus aria-label="Review note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. talked to them, expected" className="min-w-0 flex-1 rounded-md border border-rule bg-paper px-2.5 py-1 text-sm" />
            <button className="rounded-md bg-ink px-2.5 py-1 text-xs font-medium text-paper">Mark reviewed</button>
            <button type="button" className="text-xs text-muted" onClick={() => setReviewing(false)}>Cancel</button>
          </form>
        ) : (
          <div className="mt-2 flex gap-2">
            {f.pid > 0 && !onPersonPage && <button className="rounded-md border border-rule px-2.5 py-1 text-xs hover:bg-band" onClick={() => go(`/people/${f.pid}`)}>Inspect person</button>}
            <button className="rounded-md border border-rule px-2.5 py-1 text-xs hover:bg-band" onClick={() => setReviewing(true)}>Mark reviewed</button>
          </div>
        )}
      </div>
    </li>
  );
}
