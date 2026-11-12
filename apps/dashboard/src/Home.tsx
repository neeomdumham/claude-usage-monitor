import { useEffect, useState } from 'react';
import { BurnChart, ShareBars, StackedBars, type Series } from './charts.tsx';
import {
  ago, call, clock, compact, daysBetween, describeAudit, isOutdated, meterName, pace, pct, personColors, until, usd,
  type Analytics as A, type AuditEvent, type Flag, type Meter, type Overview,
} from './lib.ts';
import { Card, Kpi, Pill, type Tone } from './ui.tsx';

export type Go = (route: string) => void;

function meterPill(m: Meter | undefined): { tone: Tone; text: string } {
  if (!m) return { tone: 'neutral', text: 'No reading' };
  if (m.expired) return { tone: 'neutral', text: 'Reset' };
  if (m.usedPercentage >= 90) return { tone: 'bad', text: 'Near limit' };
  const p = pace(m);
  if (p?.hitsLimitAt) return { tone: 'warn', text: 'Ahead of pace' };
  return { tone: 'good', text: 'On pace' };
}

export function Home({ data, a, go, reload }: { data: Overview; a: A; go: Go; reload: () => void }) {
  const tz = data.policy.data.displayTimezone;
  const color = personColors(a.people.map((p) => p.pid));
  const weekly = data.meters.find((m) => m.meterKey === 'seven_day');
  const session = data.meters.find((m) => m.meterKey === 'five_hour');
  const [recent, setRecent] = useState<AuditEvent[] | null>(null);
  useEffect(() => { call<{ events: AuditEvent[] }>('/api/dashboard/audit?limit=20').then((r) => setRecent((r.data?.events ?? []).filter((e) => e.action !== 'auth.login').slice(0, 7))); }, [data, a]);

  const open = a.flags.filter((f) => !f.review);
  const live = data.installations.filter((d) => !d.revoked);
  const active = a.people.filter((p) => p.requests > 0).length;
  const invited = data.people.filter((p) => p.openInvite && !live.some((d) => d.personId === p.id)).length;
  const total = a.people.reduce((s, p) => s + p.cost, 0);
  const sessions = a.people.reduce((s, p) => s + p.sessions, 0);
  const requests = a.people.reduce((s, p) => s + p.requests, 0);
  const days = daysBetween(a.range.start, a.range.end, a.timezone);
  const activeByDay = days.map((d) => new Set(a.daily.filter((x) => x.day === d && x.requests > 0).map((x) => x.pid)).size);
  const costByDay = days.map((d) => a.daily.filter((x) => x.day === d).reduce((s, x) => s + x.cost, 0));
  const suggestions = suggest(data, a);
  const wp = meterPill(weekly), sp = meterPill(session);
  const weeklyPace = weekly ? pace(weekly) : null;

  const start = Date.parse(a.range.start) / 1000, end = Date.parse(a.range.end) / 1000;
  const line = (key: string) => a.burn.filter((x) => x.meterKey === key)
    .flatMap((b) => [[Math.max(start, b.t0), b.pct], [Math.max(start, b.t1), b.pct]] as [number, number][]).sort((x, y) => x[0] - y[0]);
  const series: Series[] = a.people.filter((p) => p.requests > 0).map((p) => ({
    id: String(p.pid), label: p.name, color: color(p.pid), values: days.map((d) => a.daily.find((x) => x.day === d && x.pid === p.pid)?.cost ?? 0),
  }));
  const needs = open.length + suggestions.length;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">{greeting()}</h1>
        <p className="mt-1 text-sm text-muted">
          {needs ? `${needs} thing${needs > 1 ? 's' : ''} need${needs > 1 ? '' : 's'} a look. ` : 'Nothing needs you right now. '}Here is how the seat is doing.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Weekly allowance" value={weekly && !weekly.expired ? `${Math.round(weekly.usedPercentage)}%` : '—'}
          pill={<Pill tone={wp.tone}>{wp.text}</Pill>}
          foot={weekly && !weekly.expired
            ? `Resets ${clock(weekly.resetsAt, tz, true)}${weeklyPace?.hitsLimitAt ? `, runs out ${clock(weeklyPace.hitsLimitAt, tz, true)}` : ''}`
            : 'Arrives with the next Claude Code response'} />
        <Kpi label={session ? meterName(session) : 'Current session'} value={session && !session.expired ? `${Math.round(session.usedPercentage)}%` : '—'}
          pill={<Pill tone={sp.tone}>{sp.text}</Pill>}
          foot={session && !session.expired ? `5-hour window, resets in ${until(session.resetsAt)}` : 'No current 5-hour window'} />
        <Kpi label="People using it" value={`${active}`} spark={activeByDay}
          pill={<Pill tone={invited ? 'info' : 'neutral'}>{invited ? `${invited} invited` : `of ${data.people.length}`}</Pill>}
          foot={`${live.length} device${live.length === 1 ? '' : 's'} connected, ${data.people.length} people in total`} />
        <Kpi label="Work at API prices" value={usd(total)} spark={costByDay}
          pill={<Pill>{compact(sessions)} sessions</Pill>}
          foot={`${requests.toLocaleString()} requests in range. An estimate for comparing work, not your bill`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Allowance over time" sub="Weekly and 5-hour readings, with the pace that would land exactly on 100% at reset.">
          <BurnChart start={start} end={end} tz={a.timezone} pace={a.range.key === 'window'} height={220}
            lines={[
              { id: 'w', label: 'Weekly', color: 'var(--fill)', points: line('seven_day'), width: 2.5 },
              { id: 's', label: '5-hour', color: 'color-mix(in oklab, var(--s7) 45%, var(--paper))', points: line('five_hour'), width: 1 },
            ]} />
        </Card>
        <Card title="Who's using it" sub="Share of measured work in this range." action={<button className="text-sm text-muted hover:text-ink" onClick={() => go('/people')}>All people</button>}>
          {total > 0 ? (
            <ShareBars rows={a.people.filter((p) => p.cost > 0).sort((x, y) => y.cost - x.cost).slice(0, 6).map((p) => ({
              id: p.pid, label: p.name, color: color(p.pid), value: p.cost, note: `${pct(p.cost, total)}%`,
              onClick: p.isPerson ? () => go(`/people/${p.pid}`) : undefined,
            }))} />
          ) : <p className="text-sm text-muted">No measured work in this range yet.</p>}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Things to look at" sub="Flags that cross your thresholds. Each one is a reason to ask."
          action={<Pill tone={open.some((f) => f.severity === 'alert') ? 'bad' : open.length ? 'warn' : 'good'}>{open.length ? `${open.length} open` : 'All clear'}</Pill>}>
          {open.length ? (
            <ol className="space-y-3">
              {open.slice(0, 6).map((f, i) => <FlagItem key={f.key} f={f} n={i + 1} go={go} reload={reload} compact />)}
            </ol>
          ) : <p className="text-sm text-muted">Nothing crosses your thresholds in this range.</p>}
          {open.length > 6 && <button className="mt-3 text-sm text-muted hover:text-ink" onClick={() => go('/people')}>{open.length - 6} more</button>}
        </Card>

        <Card title="What happened recently" sub="Joins, invites, labels and changes."
          action={<button className="rounded-md border border-rule px-2.5 py-1 text-xs hover:bg-band" onClick={() => go('/audit')}>See all</button>}>
          {recent === null ? <p className="text-sm text-muted">Loading…</p> : recent.length ? (
            <ul className="divide-y divide-rule">
              {recent.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-3 py-2">
                  <div>
                    <p className="text-sm">{describeAudit(e)}</p>
                    <p className="text-xs text-muted">{ago(e.at)}</p>
                  </div>
                  <Pill tone={e.action.endsWith('failed') ? 'bad' : e.action === 'prompt.labelled' ? 'warn' : 'neutral'}>{e.actor}</Pill>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">Nothing yet.</p>}
        </Card>

        <Card title="Suggestions" sub="Based on what the monitor can see.">
          {suggestions.length ? (
            <ul className="space-y-2">
              {suggestions.map((s) => (
                <li key={s.title}>
                  <button onClick={() => go(s.route)} className="w-full rounded-lg border border-rule bg-paper px-3 py-2.5 text-left hover:border-ink">
                    <p className="text-sm font-medium">{s.title}</p>
                    <p className="text-xs text-muted">{s.detail}</p>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">Everything is set up.</p>}
        </Card>
      </div>

      <Card title="Daily work by person" sub="Cost at API prices, per day in this range.">
        {series.length ? <StackedBars label="Daily work by person" days={days} series={series} format={usd} height={200} />
          : <p className="text-sm text-muted">No measured requests in this range.</p>}
      </Card>
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
    <li className="flex gap-3">
      <span className={`w-1 shrink-0 rounded-full ${bar}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {n !== undefined && <span className="mr-1.5 text-muted">{n}</span>}
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
