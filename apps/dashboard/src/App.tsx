import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AuditPage, DevicesPage, ModelsPage, PeoplePage } from './Admin.tsx';
import { Activity, Git, Repositories } from './Analytics.tsx';
import { FlagItem, Home } from './Home.tsx';
import { ago, call, lastSeen, personColors, personStatus, type Analytics as AData, type Meter as M, type Overview, type PolicyData } from './lib.ts';
import { Meter } from './Meter.tsx';
import { GitEmails, InviteCard, PersonName, type Invite } from './People.tsx';
import { Profile } from './Profile.tsx';
import { Avatar, Card, PageHead, Pill } from './ui.tsx';

const RANGES: [string, string][] = [['window', 'This allowance week'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']];
const NAV: { section?: string; items: [string, string, ReactNode][] }[] = [
  { items: [['/dashboard', 'Dashboard', <path d="M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z" />]] },
  { section: 'Team', items: [
    ['/people', 'People', <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6" /></>],
    ['/devices', 'Devices', <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>],
  ] },
  { section: 'Usage', items: [
    ['/repositories', 'Repositories', <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19V5M8 7h7" />],
    ['/activity', 'Activity', <path d="M3 12h4l3-8 4 16 3-8h4" />],
    ['/git', 'Git', <><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="9" r="2.5" /><path d="M6 8.5v7M18 11.5c0 4-6 3-10 5" /></>],
    ['/models', 'Models & cost', <path d="M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />],
  ] },
  { section: 'System', items: [
    ['/audit', 'Audit log', <path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7" />],
    ['/settings', 'Settings', <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 15H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9.7 4.4V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></>],
  ] },
];

/** Hash routes (#/people/3?x=1), so every page and profile can be bookmarked and the back button works. */
function readRoute() {
  const raw = window.location.hash.replace(/^#/, '') || '/dashboard';
  const [path, query = ''] = raw.split('?');
  return { path: path.startsWith('/') ? path : '/dashboard', query: Object.fromEntries(new URLSearchParams(query)) };
}

export function App() {
  const [data, setData] = useState<Overview | null>(null);
  const [an, setAn] = useState<AData | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [range, setRange] = useState('window');
  const [route, setRoute] = useState(readRoute);
  const [loadedAt, setLoadedAt] = useState(Date.now());
  const [navOpen, setNavOpen] = useState(false);
  const [, tick] = useState(0);
  const go = useCallback((r: string) => { window.location.hash = r; setNavOpen(false); window.scrollTo(0, 0); }, []);

  const load = useCallback(async () => {
    // Server briefly unreachable (restart, network): keep showing the last data until the next poll.
    const res = await Promise.all([call<Overview>('/api/dashboard/overview'), call<AData>(`/api/dashboard/analytics?range=${range}`)]).catch(() => null);
    if (!res) return;
    const [o, x] = res;
    if (o.status === 401) return setAuthed(false);
    setAuthed(true);
    setData(o.data);
    setAn(x.data);
    setLoadedAt(Date.now());
  }, [range]);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    load();
    const poll = setInterval(load, 60_000);
    const clock = setInterval(() => tick((n) => n + 1), 30_000); // keeps countdowns honest between polls
    return () => { clearInterval(poll); clearInterval(clock); };
  }, [load]);

  if (authed === false) return <Login onDone={load} />;
  if (!data || !an) return <p className="px-8 py-16 text-muted">Loading…</p>;

  const tz = data.policy.data.displayTimezone;
  const path = data.installations.length === 0 && data.people.length === 0 && route.path === '/dashboard' ? '/people' : route.path;
  const section = '/' + path.split('/')[1];
  const usesRange = ['/dashboard', '/people', '/repositories', '/activity', '/git', '/models'].includes(section);
  const openFlags = an.flags.filter((f) => !f.review).length;

  const page = (() => {
    const personMatch = path.match(/^\/people\/(\d+)$/);
    if (personMatch) return <PersonPage id={Number(personMatch[1])} data={data} a={an} go={go} reload={load} />;
    switch (section) {
      case '/people': return <PeoplePage data={data} a={an} go={go} reload={load} />;
      case '/devices': return <DevicesPage data={data} go={go} reload={load} />;
      case '/repositories': return <Card><Repositories a={an} /></Card>;
      case '/activity': return <Card><Activity a={an} /></Card>;
      case '/git': return <Card><Git a={an} team={data.people} onChange={load} /></Card>;
      case '/models': return <ModelsPage a={an} />;
      case '/audit': return <AuditPage data={data} initial={route.query} />;
      case '/settings': return <SettingsPage data={data} onDone={load} />;
      default: return <Home data={data} a={an} go={go} reload={load} />;
    }
  })();

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[232px_1fr] lg:bg-[linear-gradient(to_right,var(--nav)_232px,var(--paper)_232px)]">
      <aside className={`${navOpen ? 'fixed inset-0 z-40 block' : 'hidden'} bg-[var(--nav)] text-[var(--nav-ink)] lg:sticky lg:top-0 lg:block lg:h-screen`}>
        <div className="flex h-full flex-col border-r border-white/5 px-3 py-5">
          <div className="flex items-center justify-between px-2">
            <p className="flex items-center gap-2 font-semibold"><span className="reading text-3xl text-[var(--nav-muted)]" aria-hidden>%</span>Claude usage</p>
            <button className="lg:hidden" aria-label="Close menu" onClick={() => setNavOpen(false)}>✕</button>
          </div>
          <nav aria-label="Main" className="mt-6 flex-1 space-y-5 overflow-y-auto">
            {NAV.map((g, i) => (
              <div key={i}>
                {g.section && <p className="px-2 pb-1 text-xs text-[var(--nav-muted)]">{g.section}</p>}
                <ul className="space-y-0.5">
                  {g.items.map(([href, label, icon]) => {
                    const active = section === href;
                    return (
                      <li key={href}>
                        <a href={`#${href}`} onClick={() => setNavOpen(false)} aria-current={active ? 'page' : undefined}
                          className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm ${active ? 'bg-[var(--nav-hover)] font-medium text-white shadow-[inset_2px_0_0_var(--nav-ink)]' : 'text-[var(--nav-ink)]/85 hover:bg-[var(--nav-hover)]'}`}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{icon}</svg>
                          <span className="flex-1">{label}</span>
                          {href === '/dashboard' && openFlags > 0 && <span className="rounded-full bg-ahead px-1.5 text-xs font-medium text-white">{openFlags}</span>}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
          <div className="mt-4 border-t border-white/10 px-2 pt-3 text-xs text-[var(--nav-muted)]">
            <p className="font-medium text-[var(--nav-ink)]">Owner</p>
            <p>Updated {ago(new Date(loadedAt).toISOString())}, {tz.replace('_', ' ')}</p>
            <button className="mt-1 hover:text-white" onClick={async () => { await call('/api/auth/logout', 'POST'); setAuthed(false); }}>Sign out</button>
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-rule bg-paper/95 px-4 py-3 backdrop-blur sm:px-8">
          <button className="rounded-md border border-rule px-2 py-1 lg:hidden" aria-label="Open menu" onClick={() => setNavOpen(true)}>☰</button>
          <GlobalSearch data={data} a={an} go={go} />
          {usesRange && (
            <div role="radiogroup" aria-label="Date range" className="flex w-full rounded-md bg-band p-1 text-sm sm:ml-auto sm:w-auto">
              {RANGES.map(([k, l]) => (
                <button key={k} role="radio" aria-checked={range === k} onClick={() => setRange(k)}
                  className={`flex-1 whitespace-nowrap rounded px-2 py-1 sm:flex-none sm:px-3 ${range === k ? 'bg-card font-medium shadow-[0_0_0_1px_var(--rule)]' : 'text-muted hover:text-ink'}`}>{l}</button>
              ))}
            </div>
          )}
        </header>
        <main className="max-w-[1440px] px-4 py-8 sm:px-10">{page}</main>
      </div>
    </div>
  );
}

/** One box to jump to a person, device, repository or page. "/" focuses it. */
function GlobalSearch({ data, a, go }: { data: Overview; a: AData; go: (r: string) => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target as HTMLElement).closest('input, textarea, select')) { e.preventDefault(); ref.current?.focus(); }
    };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, []);
  const t = q.trim().toLowerCase();
  const results: { label: string; kind: string; route: string }[] = !t ? [] : [
    ...data.people.filter((p) => p.name.toLowerCase().includes(t) || p.gitEmails.some((e) => e.includes(t))).map((p) => ({ label: p.name, kind: 'Person', route: `/people/${p.id}` })),
    ...data.installations.filter((d) => d.name.toLowerCase().includes(t) || d.hostname?.toLowerCase().includes(t)).map((d) => ({ label: d.name, kind: 'Device', route: d.personId ? `/people/${d.personId}` : '/devices' })),
    ...a.repos.filter((r) => r.repo?.includes(t)).map((r) => ({ label: r.repo!, kind: 'Repository', route: '/repositories' })),
    ...NAV.flatMap((g) => g.items).filter(([, l]) => l.toLowerCase().includes(t)).map(([r, l]) => ({ label: l, kind: 'Page', route: r })),
  ].slice(0, 8);
  return (
    <div className="relative w-full max-w-md">
      <input ref={ref} type="search" value={q} placeholder="Search people, devices, repositories   /"
        aria-label="Search people, devices, repositories" aria-expanded={open && results.length > 0}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => { if (e.key === 'Enter' && results[0]) { go(results[0].route); setQ(''); ref.current?.blur(); } }}
        className="w-full rounded-md border border-rule bg-card px-3 py-1.5 text-sm" />
      {open && results.length > 0 && (
        <ul className="absolute z-30 mt-1 w-full rounded-lg border border-rule bg-card py-1 text-sm shadow-[0_4px_16px_rgb(0_0_0/0.12)]">
          {results.map((r) => (
            <li key={r.kind + r.label + r.route}>
              <button className="flex w-full justify-between gap-3 px-3 py-1.5 text-left hover:bg-band" onMouseDown={() => { go(r.route); setQ(''); }}>
                <span>{r.label}</span><span className="text-xs text-muted">{r.kind}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PersonPage({ id, data, a, go, reload }: { id: number; data: Overview; a: AData; go: (r: string) => void; reload: () => void }) {
  const p = data.people.find((x) => x.id === id);
  const [invite, setInvite] = useState<Invite | null>(null);
  if (!p) return <p className="text-muted">That person doesn't exist. <a className="underline" href="#/people">Back to people</a></p>;
  const color = personColors(a.people.map((x) => x.pid));
  const devices = data.installations.filter((d) => d.personId === id);
  const status = personStatus(p, data.installations);
  const flags = a.flags.filter((f) => f.pid === id);
  const seen = lastSeen(devices.filter((d) => !d.revoked));
  const newLink = async () => {
    const r = await call('/api/dashboard/invites', 'POST', { personId: id });
    if (r.status === 200) { setInvite({ ...r.data, name: p.name }); reload(); }
  };
  return (
    <div className="space-y-8">
      <a href="#/people" className="text-sm text-muted hover:text-ink">People</a>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <Avatar name={p.name} color={color(id)} />
          <div>
            <div className="flex items-center gap-3"><PersonName p={p} onChange={reload} title /><Pill tone={status.tone}>{status.label}</Pill></div>
            <p className="text-sm text-muted">Added {ago(p.createdAt)}{seen ? `, last active ${ago(seen)}` : ''}</p>
            <GitEmails p={p} onChange={reload} />
          </div>
        </div>
        <div className="flex gap-2">
          <a className="rounded-md border border-rule bg-card px-3 py-1.5 text-sm hover:bg-band" href={`#/audit?personId=${id}`}>Audit log</a>
          <button className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-paper" onClick={newLink}>{devices.length ? 'New link for another device' : 'Send a new link'}</button>
        </div>
      </div>
      {invite && <InviteCard invite={invite} onClose={() => setInvite(null)} />}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Flags" sub="In the selected range. Mark one reviewed to hide it for a week; it returns if the pattern continues.">
          {flags.length ? <ul className="divide-y divide-rule">{flags.map((f) => <FlagItem key={f.key} f={f} go={go} reload={reload} onPersonPage />)}</ul>
            : <p className="text-sm text-muted">Nothing crosses your thresholds.</p>}
        </Card>
        <Card title="Devices" sub={p.openInvite ? `Link open: ${p.openInvite.uses} of ${p.openInvite.maxUses} joined` : undefined}>
          {devices.length ? (
            <ul className="divide-y divide-rule text-sm">
              {devices.map((d) => (
                <li key={d.id} className="py-2">
                  <p className={`font-medium ${d.revoked ? 'text-muted line-through' : ''}`}>{d.name}</p>
                  <p className="text-xs text-muted">{[d.os, d.clientVersion?.replace(/^plugin-/, 'plugin '), d.lastHeartbeatAt ? `last session ${ago(d.lastHeartbeatAt)}` : 'no session yet'].filter(Boolean).join(', ')}</p>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">No device yet.</p>}
          <a href="#/devices" className="mt-3 inline-block text-sm text-muted hover:text-ink">Manage devices</a>
        </Card>
      </div>
      <Card><Profile personId={id} hideHeader /></Card>
    </div>
  );
}

function SettingsPage({ data, onDone }: { data: Overview; onDone: () => void }) {
  const meters = data.meters;
  return (
    <div className="space-y-10">
      <PageHead title="Settings" sub="Thresholds, work repositories, retention and readings. Changes are recorded in the audit log." />
      <Card><Settings policy={data.policy.data} revision={data.policy.revision} onDone={onDone} /></Card>
      <Card title="Allowance readings">
        {meters.length > 0 && (
          <div className="mb-2 grid gap-x-10 sm:grid-cols-2">{meters.map((m) => <Meter key={m.meterKey} m={m} tz={data.policy.data.displayTimezone} />)}</div>
        )}
        {!meters.length && <NoReadings />}
        <ManualReading meters={meters} onDone={onDone} />
      </Card>
      <Card title="Plugin" sub="What teammates install. Invites are created on the People page.">
        <p className="text-sm">Latest version: <strong>{data.latestPluginVersion ?? 'unknown'}</strong>. Devices on older versions show "update" on the Devices page; teammates run <code>claude plugin update usage-monitor@usage-monitor-tools</code> and restart.</p>
      </Card>
    </div>
  );
}

function NoReadings() {
  return (
    <div className="max-w-[60ch]">
      <h2 className="text-lg font-medium">No allowance reading yet</h2>
      <p className="mt-2 text-muted">
        Readings arrive when a teammate's Claude Code finishes a response. Invite someone below, or enter
        today's numbers by hand from Settings › Usage on claude.ai.
      </p>
    </div>
  );
}

function ManualReading({ meters, onDone }: { meters: M[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const manualKeys = meters.filter((m) => m.source === 'manual');
  const [f, setF] = useState({ meterKey: 'seven_day_fable', label: 'This week, Fable', pct: '', resets: '' });
  const [error, setError] = useState('');

  if (!open) {
    return (
      <p className="py-6 text-sm text-muted">
        Some meters, like the weekly Fable limit, aren't reported by Claude Code.{' '}
        <button className="font-medium text-ink underline underline-offset-2" onClick={() => setOpen(true)}>Enter a reading by hand</button>
      </p>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await call('/api/dashboard/quota-snapshots', 'POST', {
      meterKey: f.meterKey, label: f.label || null, usedPercentage: Number(f.pct),
      resetsAt: Math.round(Date.parse(f.resets) / 1000), // datetime-local is the browser's own timezone
    });
    if (r.status !== 200) return setError('Check the percentage (0 to 100) and the reset time.');
    setOpen(false); setError(''); onDone();
  };
  const field = 'rounded-md border border-rule bg-paper px-3 py-1.5';
  return (
    <form onSubmit={submit} className="my-6 rounded-lg border border-rule p-6">
      <h2 className="text-lg font-semibold">Enter a reading by hand</h2>
      <p className="mt-1 text-sm text-muted">Copy the numbers from Settings › Usage on claude.ai. It's shown as entered by you, never as live.</p>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">Meter
          <input className={field} list="manual-meters" value={f.label}
            onChange={(e) => setF({ ...f, label: e.target.value, meterKey: keyFor(e.target.value, manualKeys) })} />
          <datalist id="manual-meters">{manualKeys.map((m) => <option key={m.meterKey} value={m.label ?? m.meterKey} />)}</datalist>
        </label>
        <label className="flex flex-col gap-1 text-sm">Used (%)
          <input className={`${field} w-24`} type="number" min={0} max={100} step="any" required value={f.pct} onChange={(e) => setF({ ...f, pct: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-sm">Resets at (your local time)
          <input className={field} type="datetime-local" required value={f.resets} onChange={(e) => setF({ ...f, resets: e.target.value })} />
        </label>
        <button className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper">Save reading</button>
        <button type="button" className="px-2 py-2 text-sm text-muted" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {error && <p className="mt-3 text-sm text-limit">{error}</p>}
    </form>
  );
}

/** Reuse an existing manual meter's key when its label is picked; otherwise derive one from the label. */
function keyFor(label: string, manual: M[]) {
  const hit = manual.find((m) => (m.label ?? m.meterKey) === label);
  if (hit) return hit.meterKey;
  const slug = label.toLowerCase().replace(/this week|weekly/g, 'seven_day').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return (slug || 'manual').slice(0, 40);
}

function Settings({ policy, revision, onDone }: { policy: PolicyData; revision: number; onDone: () => void }) {
  const [staleMin, setStaleMin] = useState(String(Math.round(policy.freshnessThresholdSec / 60)));
  const [days, setDays] = useState(String(policy.retentionDays));
  const [tz, setTz] = useState(policy.displayTimezone);
  const [work, setWork] = useState(policy.workNamespaces.join('\n'));
  const [outsidePct, setOutsidePct] = useState(String(policy.flagOutsideWorkPct));
  const [nightPct, setNightPct] = useState(String(policy.flagNightPct));
  const [spike, setSpike] = useState(String(policy.flagSpikeMultiple));
  const [sdkPct, setSdkPct] = useState(String(policy.flagSdkPct));
  const [bypassPct, setBypassPct] = useState(String(policy.flagBypassPct));
  const [noRepoPct, setNoRepoPct] = useState(String(policy.flagNoRepoPct));
  const [msg, setMsg] = useState('');
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await call('/api/dashboard/policy', 'PATCH', {
      freshnessThresholdSec: Number(staleMin) * 60, retentionDays: Number(days), displayTimezone: tz,
      workNamespaces: work.split('\n').map((l) => l.trim().toLowerCase().replace(/^https?:\/\//, '')).filter(Boolean),
      flagOutsideWorkPct: Number(outsidePct), flagNightPct: Number(nightPct),
      flagSpikeMultiple: Number(spike), flagSdkPct: Number(sdkPct), flagBypassPct: Number(bypassPct), flagNoRepoPct: Number(noRepoPct),
    });
    setMsg(r.status === 200 ? 'Settings saved.' : 'Not saved: stale-after is 1 to 1440 minutes, history 1 to 365 days, thresholds 1 to 100%.');
    if (r.status === 200) onDone();
  };
  const field = 'rounded-md border border-rule bg-paper px-3 py-1.5';
  return (
    <details open>
      <summary className="cursor-pointer font-semibold">Thresholds and retention</summary>
      <form onSubmit={save} className="mt-4 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">Mark readings stale after (minutes)
          <input className={`${field} w-28`} type="number" min={1} max={1440} value={staleMin} onChange={(e) => setStaleMin(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">Keep request history (days)
          <input className={`${field} w-28`} type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">Show times in
          <input className={`${field} w-48`} value={tz} onChange={(e) => setTz(e.target.value)} />
        </label>
        <label className="flex w-full flex-col gap-1 text-sm">Work repositories, one namespace per line
          <textarea className={`${field} h-24 max-w-md`} placeholder={'gitlab.com/your-company/\ngithub.com/your-company/'} value={work} onChange={(e) => setWork(e.target.value)} />
          <span className="text-muted">Anything else counts as outside work in each person's profile.</span>
        </label>
        <label className="flex flex-col gap-1 text-sm">Flag outside-work share at (%)
          <input className={`${field} w-28`} type="number" min={1} max={100} value={outsidePct} onChange={(e) => setOutsidePct(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">Flag 00:00 to 06:00 share at (%)
          <input className={`${field} w-28`} type="number" min={1} max={100} value={nightPct} onChange={(e) => setNightPct(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">Flag a day at (× their usual)
          <input className={`${field} w-28`} type="number" min={1.5} max={20} step={0.5} value={spike} onChange={(e) => setSpike(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">Flag scripted share at (%)
          <input className={`${field} w-28`} type="number" min={1} max={100} value={sdkPct} onChange={(e) => setSdkPct(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">Flag bypassed permissions at (%)
          <input className={`${field} w-28`} type="number" min={1} max={100} value={bypassPct} onChange={(e) => setBypassPct(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">Flag no-repository share at (%)
          <input className={`${field} w-28`} type="number" min={1} max={100} value={noRepoPct} onChange={(e) => setNoRepoPct(e.target.value)} />
        </label>
        <button className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper">Save settings</button>
      </form>
      <p className="mt-3 text-sm text-muted">{msg || `Policy revision ${revision}. Devices pick up changes on their next session.`}</p>
    </details>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await call('/api/auth/login', 'POST', { password });
    if (r.status === 200) onDone();
    else setError('That password is wrong. It is OWNER_PASSWORD in the server’s .env.');
  };
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm">
        {/* Lets password managers file the owner password under a name; there is only one account. */}
        <input type="text" name="username" autoComplete="username" value="owner" readOnly hidden />
        <p className="reading text-[5.5rem] text-fill" aria-hidden>%</p>
        <h1 className="mt-4 text-2xl font-semibold">Claude usage</h1>
        <p className="mt-1 text-sm text-muted">Sign in to see the seat's allowance and who's drawing on it.</p>
        <label className="mt-6 flex flex-col gap-1 text-sm">Owner password
          <input type="password" autoFocus autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} className="rounded-md border border-rule bg-paper px-3 py-2 text-base" />
        </label>
        {error && <p className="mt-2 text-sm text-limit">{error}</p>}
        <button className="mt-4 w-full rounded-md bg-ink py-2.5 font-medium text-paper">Sign in</button>
      </form>
    </main>
  );
}
