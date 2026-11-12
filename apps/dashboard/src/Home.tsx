import { useEffect, useState } from 'react';
import { BurnChart, ShareBars, StackedBars, type Series } from './charts.tsx';
import { Meter } from './Meter.tsx';
import {
  ago, call, compact, daysBetween, describeAudit, isOutdated, pct, personColors, until, usd,
  type Analytics as A, type AuditEvent, type Flag, type Overview,
} from './lib.ts';

export type Go = (route: string) => void;

export function Home({ data, a, go, reload }: { data: Overview; a: A; go: Go; reload: () => void }) {
  const tz = data.policy.data.displayTimezone;
  const color = personColors(a.people.map((p) => p.pid));
  const weekly = data.meters.find((m) => m.meterKey === 'seven_day');
  const session = data.meters.find((m) => m.meterKey === 'five_hour');
  const [recent, setRecent] = useState<AuditEvent[] | null>(null);
  useEffect(() => { call<{ events: AuditEvent[] }>('/api/dashboard/audit?limit=20').then((r) => setRecent((r.data?.events ?? []).filter((e) => e.action !== 'auth.login').slice(0, 7))); }, [data, a]);

  // A token shared by two people is raised under both of them; the home list shows it once.
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
  const sessions = a.people.reduce((s, p) => s + p.sessions, 0);
  const days = daysBetween(a.range.start, a.range.end, a.timezone);
  const suggestions = suggest(data, a);

  const start = Date.parse(a.range.start) / 1000, end = Date.parse(a.range.end) / 1000;
  const line = (key: string) => a.burn.filter((x) => x.meterKey === key)
    .flatMap((b) => [[Math.max(start, b.t0), b.pct], [Math.max(start, b.t1), b.pct]] as [number, number][]).sort((x, y) => x[0] - y[0]);
  const series: Series[] = a.people.filter((p) => p.requests > 0).map((p) => ({
    id: String(p.pid), label: p.name, color: color(p.pid), values: days.map((d) => a.daily.find((x) => x.day === d && x.pid === p.pid)?.cost ?? 0),
  }));
  const needs = open.length + suggestions.length;

  return (
    <div className="space-y-10">
      <section aria-label="Allowance" className="grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {weekly ? <Meter m={weekly} tz={tz} hero /> : (
          <div>
            <h2 className="text-lg font-medium">Weekly allowance</h2>
            <p className="mt-2 text-sm text-muted">No reading yet. It arrives with the next Claude Code response from any teammate, or enter one in Settings.</p>
          </div>
        )}
        <div className="space-y-6 lg:border-l lg:border-rule lg:pl-10">
          {session && <Meter m={session} tz={tz} />}
          <dl className="grid grid-cols-3 gap-4 border-t border-rule pt-5">
            <Stat label="People active" value={`${active}`} note={`of ${data.people.length}, ${live.length} devices`} />
            <Stat label="Sessions" value={compact(sessions)} note={RANGE_NOTE[a.range.key] ?? 'in range'} />
            <Stat label="API-price value" value={usd(total)} note="an estimate, not a bill" />
          </dl>
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
          {open.length > 6 && <button className="mt-2 text-sm text-muted underline underline-offset-2 hover:text-ink" onClick={() => go('/people')}>{open.length - 6} more on the People page</button>}
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
            <h2 id="who" className="text-lg font-semibold">Who's spending it</h2>
            <button className="text-sm text-muted hover:text-ink" onClick={() => go('/people')}>All people</button>
          </header>
          {total > 0 ? (
            <>
              <ShareBars rows={a.people.filter((p) => p.cost > 0).sort((x, y) => y.cost - x.cost).slice(0, 6).map((p) => ({
                id: p.pid, label: p.name, color: color(p.pid), value: p.cost, note: `${pct(p.cost, total)}%`,
                onClick: p.isPerson ? () => go(`/people/${p.pid}`) : undefined,
              }))} />
              <div className="mt-6">
                <StackedBars label="Daily work by person" days={days} series={series} format={usd} height={150} />
              </div>
            </>
          ) : <p className="text-sm text-muted">No measured work in this range yet.</p>}
        </section>
      </div>

      <div className="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section aria-labelledby="burn" className="min-w-0">
          <header className="mb-4 border-b border-ink pb-2">
            <h2 id="burn" className="text-lg font-semibold">Weekly allowance over time</h2>
          </header>
          <BurnChart start={start} end={end} tz={a.timezone} pace={a.range.key === 'window'} height={200}
            lines={[{ id: 'w', label: 'Weekly', color: 'var(--fill)', points: line('seven_day'), width: 2.5 }]} />
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
                  <span className={e.action.endsWith('failed') ? 'text-limit' : ''}>{describeAudit(e)}</span>
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

const RANGE_NOTE: Record<string, string> = { window: 'this allowance week', '7d': 'last 7 days', '30d': 'last 30 days' };

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="reading mt-1.5 text-3xl">{value}</dd>
      <dd className="mt-1 text-xs text-muted">{note}</dd>
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

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
  if (old) out.push({ title: `${old} device${old > 1 ? 's run' : ' runs'} an older plugin`, detail: `Ask them to run claude plugin update. Latest is ${data.latestPluginVersion}.`, route: '/devices' });
  if (!data.policy.data.workNamespaces.length) out.push({ title: 'List your work repositories', detail: 'Needed to tell work from outside work.', route: '/settings' });
  if (!a.git.gitlabConfigured) out.push({ title: 'Connect GitLab', detail: 'Count every commit, not only the ones Claude made.', route: '/git' });
  if (a.git.unmappedAuthors.length) out.push({ title: `${a.git.unmappedAuthors.length} commit emails aren't matched`, detail: 'Assign them to people so commits count.', route: '/git' });
  if (!data.meters.length) out.push({ title: 'No allowance reading yet', detail: 'Enter one by hand, or wait for a teammate to use Claude Code.', route: '/settings' });
  return out.slice(0, 5);
}

/** A flag with its evidence, and a way to mark it reviewed with a note. */
export function FlagItem({ f, n, go, reload, compact: small = false, onPersonPage = false }: { f: Flag; n?: number; go: Go; reload: () => void; compact?: boolean; onPersonPage?: boolean }) {
  const [reviewing, setReviewing] = useState(false);
  const [note, setNote] = useState('');
  const bar = f.review ? 'bg-rule' : f.severity === 'alert' ? 'bg-limit' : 'bg-ahead';
  return (
    <li className="flex gap-3 py-3">
      <span className={`w-1 shrink-0 rounded-full ${bar}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {n !== undefined && <span className="mr-1.5 text-muted">{n}</span>}
          <span className={`mr-2 text-xs font-normal ${f.review ? 'text-muted' : f.severity === 'alert' ? 'text-limit' : 'text-ahead'}`}>{f.review ? 'Reviewed' : f.severity === 'alert' ? 'Alert' : 'Watch'}</span>
          {f.title}
          {!onPersonPage && <span className="ml-2 text-xs font-normal">
            {f.pid > 0 ? <button className="text-muted underline underline-offset-2 hover:text-ink" onClick={() => go(`/people/${f.pid}`)}>{f.person}</button> : <span className="text-muted">{f.person}</span>}
          </span>}
        </p>
        {!small && <p className="mt-0.5 text-sm">{f.evidence}</p>}
        <p className="mt-0.5 text-xs text-muted">{small ? f.evidence : `Keep in mind: ${f.caveat}`}</p>
        {f.review ? (
          <p className="mt-1 text-xs text-muted">Reviewed {ago(f.review.at)}{f.review.note ? `: "${f.review.note}"` : ''}</p>
        ) : reviewing ? (
          <form className="mt-2 flex flex-wrap gap-2" onSubmit={async (e) => {
            e.preventDefault();
            await call('/api/dashboard/flags/review', 'POST', { key: f.key, note });
            setReviewing(false); reload();
          }}>
            <input autoFocus aria-label="Review note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. talked to them, expected" className="min-w-0 flex-1 rounded-md border border-rule bg-paper px-2 py-1 text-sm" />
            <button className="rounded-md bg-ink px-2.5 py-1 text-xs font-medium text-paper">Mark reviewed</button>
            <button type="button" className="text-xs text-muted" onClick={() => setReviewing(false)}>Cancel</button>
          </form>
        ) : (
          <div className="mt-1.5 flex gap-2">
            {f.pid > 0 && !onPersonPage && <button className="rounded-md border border-rule px-2.5 py-0.5 text-xs hover:bg-band" onClick={() => go(`/people/${f.pid}`)}>Review</button>}
            <button className="rounded-md border border-rule px-2.5 py-0.5 text-xs hover:bg-band" onClick={() => setReviewing(true)}>Mark reviewed</button>
          </div>
        )}
      </div>
    </li>
  );
}
