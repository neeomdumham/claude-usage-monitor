import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AuditPage, DevicesPage, ModelsPage, PeoplePage } from './Admin.tsx';
import { Activity, Git, Repositories } from './Analytics.tsx';
import { CaptureSettings, ContentPage, RecentCommits } from './Content.tsx';
import { FlagItem, Home } from './Home.tsx';
import {
  ago, call, lastSeen, personColors, personStatus,
  type AdminAlert, type AlertKind, type Analytics as AData, type GuardMode, type Meter as M, type Overview, type PolicyData,
} from './lib.ts';
import { Meter } from './Meter.tsx';
import { GitEmails, InviteModal, PersonName, type Invite } from './People.tsx';
import { Profile } from './Profile.tsx';
import { TeamsPage } from './Teams.tsx';
import { AlertBanner, Avatar, Card, PageHead, Pill } from './ui.tsx';

const RANGES: [string, string][] = [
  ['five_hour', 'Current 5h'],
  ['window', 'This allowance week'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
];

type NavGroup = {
  section?: string;
  items: { href: string; label: string; icon: ReactNode; superadminOnly?: boolean; contentGate?: boolean }[];
};

const NAV: NavGroup[] = [
  { items: [{ href: '/dashboard', label: 'Dashboard', icon: <path d="M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z" /> }] },
  {
    section: 'Team',
    items: [
      { href: '/people', label: 'People', icon: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6" /></> },
      { href: '/devices', label: 'Devices', icon: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></> },
      { href: '/teams', label: 'Teams & Admins', superadminOnly: true, icon: <><path d="M12 3 4 7v6c0 5 3.4 7.7 8 9 4.6-1.3 8-4 8-9V7l-8-4Z" /><path d="M9.5 12.5 11 14l3.5-3.5" /></> },
    ],
  },
  {
    section: 'Usage',
    items: [
      { href: '/repositories', label: 'Repositories', icon: <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19V5M8 7h7" /> },
      { href: '/activity', label: 'Activity', icon: <path d="M3 12h4l3-8 4 16 3-8h4" /> },
      { href: '/git', label: 'Git', icon: <><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="9" r="2.5" /><path d="M6 8.5v7M18 11.5c0 4-6 3-10 5" /></> },
      { href: '/models', label: 'Models & cost', icon: <path d="M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /> },
      { href: '/content', label: 'Captured content', contentGate: true, icon: <path d="M8 9l-4 3 4 3M16 9l4 3-4 3M13.5 5l-3 14" /> },
    ],
  },
  {
    section: 'System',
    items: [
      { href: '/audit', label: 'Audit log', icon: <path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7" /> },
      { href: '/settings', label: 'Settings', superadminOnly: true, icon: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 15H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9.7 4.4V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></> },
    ],
  },
];

function readRoute() {
  const raw = window.location.hash.replace(/^#/, '') || '/dashboard';
  const [path, query = ''] = raw.split('?');
  return { path: path.startsWith('/') ? path : '/dashboard', query: Object.fromEntries(new URLSearchParams(query)) };
}

export function App() {
  const [data, setData] = useState<Overview | null>(null);
  const [an, setAn] = useState<AData | null>(null);
  const [alerts, setAlerts] = useState<AdminAlert[]>([]);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [range, setRange] = useState('window');
  const [teamId, setTeamId] = useState('');
  const [route, setRoute] = useState(readRoute);
  const [loadedAt, setLoadedAt] = useState(Date.now());
  const [navOpen, setNavOpen] = useState(false);
  const [quickInviteOpen, setQuickInviteOpen] = useState(false);
  const [quickInvite, setQuickInvite] = useState<Invite | null>(null);
  const [, tick] = useState(0);
  const go = useCallback((r: string) => { window.location.hash = r; setNavOpen(false); window.scrollTo(0, 0); }, []);

  const load = useCallback(async () => {
    const tq = teamId ? `&teamId=${encodeURIComponent(teamId)}` : '';
    const tqFirst = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
    const res = await Promise.all([
      call<Overview>(`/api/dashboard/overview${tqFirst}`),
      call<AData>(`/api/dashboard/analytics?range=${encodeURIComponent(range)}${tq}`),
      call<{ alerts: AdminAlert[] }>(`/api/dashboard/alerts${tqFirst}`),
    ]).catch(() => null);
    if (!res) return;
    const [o, x, al] = res;
    if (o.status === 401) return setAuthed(false);
    setAuthed(true);
    setData(o.data);
    setAn(x.data);
    setAlerts(al.status === 200 ? (al.data?.alerts ?? []) : []);
    setLoadedAt(Date.now());
  }, [range, teamId]);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    load();
    const poll = setInterval(load, 60_000);
    const clock = setInterval(() => tick((n) => n + 1), 30_000);
    return () => { clearInterval(poll); clearInterval(clock); };
  }, [load]);

  if (authed === false) return <Login onDone={load} />;
  if (!data || !an) return <p className="px-8 py-16 text-muted">Loading…</p>;

  const viewer = data.viewer;
  const isSuper = viewer.role === 'superadmin';
  const canSeeContent = isSuper || data.policy.data.leadsCanViewContent;
  const tz = data.policy.data.displayTimezone;
  // Never trap empty workspaces on /people: every route renders honestly.
  const path = route.path;
  const section = '/' + path.split('/')[1];
  const usesRange = ['/dashboard', '/people', '/repositories', '/activity', '/git', '/models'].includes(section);
  const openFlags = an.flags.filter((f) => !f.review).length;

  const visibleNav = NAV.map((g) => ({
    ...g,
    items: g.items.filter((it) => (!it.superadminOnly || isSuper) && (!it.contentGate || canSeeContent)),
  })).filter((g) => g.items.length > 0);

  const inspectAlert = (al: AdminAlert) => {
    if (al.personId) go(`/people/${al.personId}`);
    else if (al.kind === 'unaccounted_burn') go('/dashboard');
    else go('/devices');
  };

  const ackAlert = async (id: number) => {
    await call(`/api/dashboard/alerts/${id}/ack`, 'POST');
    await load();
  };

  const page = (() => {
    const personMatch = path.match(/^\/people\/(\d+)$/);
    if (personMatch) return <PersonPage id={Number(personMatch[1])} data={data} a={an} range={range} go={go} reload={load} />;
    switch (section) {
      case '/people': return <PeoplePage data={data} a={an} teamId={teamId} go={go} reload={load} />;
      case '/devices': return <DevicesPage data={data} go={go} reload={load} />;
      case '/teams': return <TeamsPage data={data} go={go} onSelectTeam={setTeamId} reload={load} />;
      case '/repositories': return <Repositories a={an} />;
      case '/activity': return <Activity a={an} teamId={teamId} people={data.people} go={go} />;
      case '/git': return (
        <div className="space-y-10">
          <Git a={an} team={data.people} isSuper={isSuper} go={go} onChange={load} />
          <RecentCommits tz={data.policy.data.displayTimezone} range={range} teamId={teamId} people={data.people} />
        </div>
      );
      case '/content': return canSeeContent
        ? <ContentPage data={data} teamId={teamId} initial={route.query} />
        : <Card title="Captured content"><p className="text-sm text-muted">Captured content is restricted to superadmins. A superadmin can enable team lead access on the Teams & Admins page.</p></Card>;
      case '/models': return <ModelsPage a={an} />;
      case '/audit': return <AuditPage data={data} teamId={teamId} initial={route.query} />;
      case '/settings': return isSuper
        ? <SettingsPage data={data} onDone={load} />
        : <Card title="Settings"><p className="text-sm text-muted">Global settings are managed by superadmins.</p></Card>;
      default: return (
        <Home
          data={data} a={an} range={range} teamId={teamId}
          onRange={setRange}
          onInvite={() => { setQuickInvite(null); setQuickInviteOpen(true); }}
          go={go} reload={load}
        />
      );
    }
  })();

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[232px_1fr] lg:bg-[linear-gradient(to_right,var(--nav)_232px,var(--paper)_232px)]">
      <aside className={`${navOpen ? 'fixed inset-0 z-40 block' : 'hidden'} bg-[var(--nav)] text-[var(--nav-ink)] lg:sticky lg:top-0 lg:block lg:h-screen`}>
        <div className="flex h-full flex-col border-r border-white/5 px-3 py-5">
          <div className="flex items-center justify-between px-2">
            <a href="#/dashboard" onClick={() => setNavOpen(false)} className="flex items-center gap-2 font-semibold text-[var(--nav-ink)]">
              <span className="reading text-3xl text-[var(--nav-muted)]" aria-hidden>%</span>
              <span>Claude usage</span>
            </a>
            <button type="button" className="rounded p-1 lg:hidden" aria-label="Close menu" onClick={() => setNavOpen(false)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <nav aria-label="Main" className="mt-6 flex-1 space-y-5 overflow-y-auto">
            {visibleNav.map((g, i) => (
              <div key={i}>
                {g.section && <p className="px-2 pb-1 text-xs text-[var(--nav-muted)]">{g.section}</p>}
                <ul className="space-y-0.5">
                  {g.items.map((item) => {
                    const active = section === item.href || (item.href === '/dashboard' && section === '/');
                    return (
                      <li key={item.href}>
                        <a href={`#${item.href}`} onClick={() => setNavOpen(false)} aria-current={active ? 'page' : undefined}
                          className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm ${active ? 'bg-[var(--nav-hover)] font-medium text-white shadow-[inset_2px_0_0_var(--nav-ink)]' : 'text-[var(--nav-ink)]/85 hover:bg-[var(--nav-hover)]'}`}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{item.icon}</svg>
                          <span className="flex-1">{item.label}</span>
                          {item.href === '/dashboard' && (openFlags + alerts.length) > 0 && (
                            <span className={`rounded-full px-1.5 text-xs font-medium text-paper ${alerts.some((x) => x.severity === 'critical') ? 'bg-limit' : 'bg-ahead'}`}>
                              {openFlags + alerts.length}
                            </span>
                          )}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
          <div className="mt-4 border-t border-white/10 px-2 pt-3 text-xs text-[var(--nav-muted)]">
            <p className="font-medium text-[var(--nav-ink)]">{viewer.name}</p>
            <p>{isSuper ? 'Superadmin' : 'Team lead'} · {tz.replace('_', ' ')}</p>
            <p className="mt-0.5">Updated {ago(new Date(loadedAt).toISOString())}</p>
            <button type="button" className="mt-1.5 hover:text-white" onClick={async () => { await call('/api/auth/logout', 'POST'); setTeamId(''); window.location.hash = '/dashboard'; setAuthed(false); }}>Sign out</button>
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-20 border-b border-rule bg-paper/95 backdrop-blur">
          <div className="mx-auto flex w-full max-w-[1440px] flex-wrap items-center gap-3 px-4 py-3 sm:px-10">
            <button type="button" className="inline-flex items-center justify-center rounded-md border border-rule p-1.5 lg:hidden" aria-label="Open menu" onClick={() => setNavOpen(true)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
            <GlobalSearch data={data} a={an} nav={visibleNav} go={go} />
            {data.teams.length > 0 && (isSuper || data.teams.length > 1) && (
              <select
                aria-label="Filter by team"
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
                className="rounded-md border border-rule bg-card px-2.5 py-1.5 text-sm"
              >
                <option value="">{isSuper ? 'All teams' : 'All my teams'}</option>
                {data.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
            {usesRange && (
              <div role="radiogroup" aria-label="Date range" className="flex w-full overflow-x-auto rounded-md bg-band p-1 text-xs sm:ml-auto sm:w-auto sm:text-sm">
                {RANGES.map(([k, l]) => (
                  <button key={k} role="radio" aria-checked={range === k} onClick={() => setRange(k)}
                    className={`flex-1 whitespace-nowrap rounded px-2.5 py-1 sm:flex-none sm:px-3 ${range === k ? 'bg-card font-medium shadow-[0_0_0_1px_var(--rule)]' : 'text-ink/80 hover:text-ink'}`}>{l}</button>
                ))}
              </div>
            )}
          </div>
        </header>

        <AlertBanner alerts={alerts} onAck={ackAlert} onInspect={inspectAlert} />

        <main className="mx-auto w-full max-w-[1440px] px-4 py-8 sm:px-10">{page}</main>

        <InviteModal
          open={quickInviteOpen}
          invite={quickInvite}
          teams={data.teams}
          defaultTeamId={teamId ? Number(teamId) : (viewer.role === 'team_lead' ? viewer.teamIds[0] ?? null : null)}
          requireTeam={viewer.role === 'team_lead'}
          onClose={() => { setQuickInviteOpen(false); setQuickInvite(null); }}
          onCreated={(i) => { setQuickInvite(i); load(); }}
        />
      </div>
    </div>
  );
}

function GlobalSearch({ data, a, nav, go }: { data: Overview; a: AData; nav: NavGroup[]; go: (r: string) => void }) {
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
    ...nav.flatMap((g) => g.items).filter((it) => it.label.toLowerCase().includes(t)).map((it) => ({ label: it.label, kind: 'Page', route: it.href })),
  ].slice(0, 8);
  return (
    <div className="relative w-full max-w-sm">
      <input ref={ref} type="search" value={q} placeholder="Search people, devices, repositories   /"
        aria-label="Search people, devices, repositories"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => { if (e.key === 'Enter' && results[0]) { go(results[0].route); setQ(''); ref.current?.blur(); } }}
        className="w-full rounded-md border border-rule bg-card px-3 py-1.5 text-sm" />
      {open && results.length > 0 && (
        <ul className="absolute z-30 mt-1 w-full rounded-lg bg-card py-1 text-sm shadow-[var(--shadow-float)] ring-1 ring-rule">
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

function PersonPage({ id, data, a, range, go, reload }: { id: number; data: Overview; a: AData; range: string; go: (r: string) => void; reload: () => void }) {
  const p = data.people.find((x) => x.id === id);
  const [invite, setInvite] = useState<Invite | null>(null);
  if (!p) return <p className="text-muted">That person doesn’t exist. <a className="underline" href="#/people">Back to people</a></p>;
  const color = personColors(a.people.map((x) => x.pid));
  const devices = data.installations.filter((d) => d.personId === id);
  const status = personStatus(p, data.installations);
  const flags = a.flags.filter((f) => f.pid === id);
  const seen = lastSeen(devices.filter((d) => !d.revoked));
  const canSeeContent = data.viewer.role === 'superadmin' || data.policy.data.leadsCanViewContent;

  const newLink = async () => {
    const r = await call('/api/dashboard/invites', 'POST', { personId: id });
    if (r.status === 200) { setInvite({ ...r.data, name: p.name }); reload(); }
  };

  const changeTeam = async (nextTeamId: string) => {
    await call(`/api/dashboard/people/${id}`, 'PATCH', { teamId: nextTeamId ? Number(nextTeamId) : null });
    reload();
  };

  return (
    <div className="space-y-8">
      <a href="#/people" className="text-sm text-muted hover:text-ink">← People</a>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <Avatar name={p.name} color={color(id)} />
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <PersonName p={p} onChange={reload} title />
              <Pill tone={status.tone}>{status.label}</Pill>
              {data.teams.length > 0 && (
                <select
                  aria-label="Assigned team"
                  value={p.teamId ? String(p.teamId) : ''}
                  onChange={(e) => changeTeam(e.target.value)}
                  className="rounded-md border border-rule bg-card px-2 py-0.5 text-xs"
                >
                  {data.viewer.role === 'superadmin' && <option value="">Unassigned team</option>}
                  {data.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              )}
            </div>
            <p className="mt-1 text-sm text-muted">Added {ago(p.createdAt)}{seen ? ` · last active ${ago(seen)}` : ''}</p>
            <GitEmails p={p} onChange={reload} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canSeeContent && <a className="rounded-md border border-rule bg-card px-3 py-1.5 text-sm hover:bg-band" href={`#/content?personId=${id}`}>Captured content</a>}
          <a className="rounded-md border border-rule bg-card px-3 py-1.5 text-sm hover:bg-band" href={`#/audit?personId=${id}`}>Audit log</a>
          <button type="button" className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-paper" onClick={newLink}>
            {devices.length ? 'New link for another device' : 'Send a new link'}
          </button>
        </div>
      </div>

      <InviteModal open={Boolean(invite)} invite={invite} onClose={() => setInvite(null)} onCreated={() => {}} />

      <div className="grid gap-6 lg:grid-cols-3">
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

      <Profile personId={id} range={range} hideHeader />
    </div>
  );
}

function SettingsPage({ data, onDone }: { data: Overview; onDone: () => void }) {
  const meters = data.meters;
  return (
    <div className="space-y-10">
      <PageHead title="Settings" sub="On-device repository blocking, admin alert webhooks, flag thresholds, capture switches and allowance readings." />

      <div className="grid gap-8 xl:grid-cols-2">
        <Card title="Repository guard (on-device)" sub="Block or warn when a teammate runs Claude Code outside allowed work repositories. Block mode stops prompts before tokens are spent (exit 2) and blocks cross-repo Edit/Write/Bash escapes.">
          <GuardSettings policy={data.policy.data} revision={data.policy.revision} onDone={onDone} />
        </Card>
        <Card title="Admin alerts & webhook" sub="Sends instant notifications to Slack, Discord, or any JSON webhook when critical alerts fire (60-minute cooldown per alert).">
          <WebhookSettings policy={data.policy.data} onDone={onDone} />
        </Card>
      </div>

      <div className="grid gap-8 xl:grid-cols-2">
        <Card title="Thresholds & retention" sub="Flags appear in Needs you and on each person’s profile. Changes apply immediately.">
          <Settings policy={data.policy.data} revision={data.policy.revision} onDone={onDone} />
        </Card>
        <Card title="Content capture" sub="Off by default. Each switch adds content to what devices send; the server drops anything switched off.">
          <CaptureSettings policy={data.policy.data} onDone={onDone} />
        </Card>
      </div>

      <Card title="Allowance readings & plugin">
        {meters.length > 0 && (
          <div className="mb-4 grid gap-5 sm:grid-cols-2">{meters.map((m) => <Meter key={m.meterKey} m={m} tz={data.policy.data.displayTimezone} />)}</div>
        )}
        {!meters.length && <NoReadings />}
        <ManualReading meters={meters} onDone={onDone} />
        <p className="mt-4 border-t border-rule pt-4 text-sm text-muted">
          Latest plugin version: <strong className="text-ink">{data.latestPluginVersion ?? 'unknown'}</strong>. Teammates update with{' '}
          <code>claude plugin update usage-monitor@usage-monitor-tools</code> and restart Claude Code.
        </p>
      </Card>
    </div>
  );
}

function GuardSettings({ policy, revision, onDone }: { policy: PolicyData; revision: number; onDone: () => void }) {
  const [work, setWork] = useState(policy.workNamespaces.join('\n'));
  const [outsideMode, setOutsideMode] = useState<GuardMode>(policy.outsideRepoMode);
  const [noRepoMode, setNoRepoMode] = useState<GuardMode>(policy.noRepoMode);
  const [msg, setMsg] = useState('');
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const workNamespaces = work.split('\n').map((l) => l.trim().toLowerCase().replace(/^https?:\/\//, '')).filter(Boolean);
    const r = await call('/api/dashboard/policy', 'PATCH', { workNamespaces, outsideRepoMode: outsideMode, noRepoMode });
    setMsg(r.status === 200 ? `Saved as policy revision ${r.data.revision}. Devices refresh guard rules within 60 seconds.` : 'Could not save guard settings.');
    if (r.status === 200) onDone();
  };
  const field = 'rounded-md border border-rule bg-paper px-3 py-2 text-sm';
  return (
    <form onSubmit={save} className="space-y-4">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Allowed work namespaces (one per line)</span>
        <textarea className={`${field} h-24 font-mono text-xs`} placeholder={'github.com/tulip-tech/\ngitlab.com/your-company/'} value={work} onChange={(e) => setWork(e.target.value)} />
        <span className="text-xs text-muted">Merged with each teammate’s team-specific namespaces. Empty disables outside-repo blocking.</span>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Outside-work repository</span>
          <select aria-label="Outside-work repository mode" className={field} value={outsideMode} onChange={(e) => setOutsideMode(e.target.value as GuardMode)}>
            <option value="off">Off (log only)</option>
            <option value="warn">Warn user & alert admin</option>
            <option value="block">Block with exit 2 (0 tokens)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Directory with no git repo</span>
          <select aria-label="No-repository mode" className={field} value={noRepoMode} onChange={(e) => setNoRepoMode(e.target.value as GuardMode)}>
            <option value="off">Off (allow scratch folders)</option>
            <option value="warn">Warn user & alert admin</option>
            <option value="block">Block with exit 2</option>
          </select>
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper">Save guard rules</button>
      </div>
      <p className="text-xs text-muted">{msg || 'Devices refresh guard rules automatically on each session and every 60 seconds.'}</p>
    </form>
  );
}

const ALERT_EVENT_LABELS: [AlertKind, string][] = [
  ['plugin_disabled', 'Plugin hooks disabled (telemetry without SessionStart)'],
  ['outside_blocked', 'Outside-work session blocked (exit 2)'],
  ['outside_warned', 'Outside-work session warned'],
  ['unaccounted_burn', 'Unaccounted 5h quota jump (off-radar burn)'],
  ['inactive_device', 'Teammate silent past inactivity threshold'],
];

function WebhookSettings({ policy, onDone }: { policy: PolicyData; onDone: () => void }) {
  const [url, setUrl] = useState(policy.webhookUrl);
  const [events, setEvents] = useState<AlertKind[]>(policy.webhookEvents);
  const [inactiveDays, setInactiveDays] = useState(String(policy.inactiveDaysAlert));
  const [jumpPct, setJumpPct] = useState(String(policy.unaccountedJumpPct));
  const [msg, setMsg] = useState('');
  const [testing, setTesting] = useState(false);

  const toggleEvent = (k: AlertKind) =>
    setEvents((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await call('/api/dashboard/policy', 'PATCH', {
      webhookUrl: url.trim(),
      webhookEvents: events,
      inactiveDaysAlert: Number(inactiveDays),
      unaccountedJumpPct: Number(jumpPct),
    });
    setMsg(r.status === 200 ? `Saved as policy revision ${r.data.revision}.` : r.data?.error ?? 'Check webhook URL (must start with https:// or http://) and numeric bounds.');
    if (r.status === 200) onDone();
  };

  const sendTest = async () => {
    setTesting(true);
    setMsg('');
    const r = await call('/api/dashboard/alerts/test-webhook', 'POST', url.trim() ? { url: url.trim() } : {});
    setTesting(false);
    setMsg(r.status === 200 ? `Test webhook delivered (HTTP ${r.data?.status ?? 200}).` : `Webhook failed: ${r.data?.error ?? 'check URL'}`);
  };

  const field = 'rounded-md border border-rule bg-paper px-3 py-2 text-sm';
  return (
    <form onSubmit={save} className="space-y-4">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Webhook URL (Slack, Discord, or generic JSON)</span>
        <input type="url" className={field} placeholder="https://hooks.slack.com/services/..." value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Inactive teammate alert (days)</span>
          <input type="number" min={0} max={90} className={field} value={inactiveDays} onChange={(e) => setInactiveDays(e.target.value)} />
          <span className="text-xs text-muted">0 disables silence alerts.</span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Unaccounted 5h jump (%)</span>
          <input type="number" min={0} max={100} className={field} value={jumpPct} onChange={(e) => setJumpPct(e.target.value)} />
          <span className="text-xs text-muted">Flags ghost usage when 5h quota spikes.</span>
        </label>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Notify webhook on</legend>
        {ALERT_EVENT_LABELS.map(([k, label]) => (
          <label key={k} className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={events.includes(k)} onChange={() => toggleEvent(k)} className="size-4 accent-[var(--fill)]" />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <button className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper">Save alert settings</button>
        <button type="button" disabled={testing || !url.trim()} onClick={sendTest}
          className="rounded-md border border-rule bg-card px-3.5 py-2 text-sm font-medium hover:bg-band disabled:opacity-50">
          {testing ? 'Sending…' : 'Send test webhook'}
        </button>
      </div>
      {msg && <p className="text-xs text-muted">{msg}</p>}
    </form>
  );
}

function NoReadings() {
  return (
    <div className="max-w-[60ch]">
      <h2 className="text-lg font-medium">No allowance reading yet</h2>
      <p className="mt-2 text-muted">
        Readings arrive when a teammate’s Claude Code finishes a response. Invite someone on the People page, or enter
        today’s numbers by hand from Settings › Usage on claude.ai.
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
      <p className="py-4 text-sm text-muted">
        Some meters, like the weekly Fable limit, aren’t reported by Claude Code.{' '}
        <button className="font-medium text-ink underline" onClick={() => setOpen(true)}>Enter a reading by hand</button>
      </p>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await call('/api/dashboard/quota-snapshots', 'POST', {
      meterKey: f.meterKey, label: f.label || null, usedPercentage: Number(f.pct),
      resetsAt: Math.round(Date.parse(f.resets) / 1000),
    });
    if (r.status !== 200) return setError('Check the percentage (0 to 100) and the reset time.');
    setOpen(false); setError(''); onDone();
  };
  const field = 'rounded-md border border-rule bg-paper px-3 py-1.5';
  return (
    <form onSubmit={submit} className="my-4 rounded-lg border border-rule p-5">
      <h2 className="text-lg font-semibold">Enter a reading by hand</h2>
      <p className="mt-1 text-sm text-muted">Copy the numbers from Settings › Usage on claude.ai. Shown as entered by hand, never as live.</p>
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
      flagOutsideWorkPct: Number(outsidePct), flagNightPct: Number(nightPct),
      flagSpikeMultiple: Number(spike), flagSdkPct: Number(sdkPct), flagBypassPct: Number(bypassPct), flagNoRepoPct: Number(noRepoPct),
    });
    setMsg(r.status === 200 ? `Saved as policy revision ${r.data.revision}. Devices pick up changes on their next session.` : 'Not saved: stale-after is 1 to 1440 minutes, history 1 to 365 days, thresholds 1 to 100%.');
    if (r.status === 200) onDone();
  };
  const field = 'rounded-md border border-rule bg-paper px-3 py-1.5';
  return (
    <form onSubmit={save} className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">Mark readings stale after (minutes)
          <input className={`${field} w-28`} type="number" min={1} max={1440} value={staleMin} onChange={(e) => setStaleMin(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">Keep request history (days)
          <input className={`${field} w-28`} type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">Show times in
          <input className={`${field} w-44`} value={tz} onChange={(e) => setTz(e.target.value)} />
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
      </div>
      <button className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper">Save settings</button>
      <p className="text-xs text-muted">{msg || `Policy revision ${revision}. Devices pick up changes on their next session.`}</p>
    </form>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const payload = email.trim() ? { email: email.trim(), password } : { password };
    const r = await call('/api/auth/login', 'POST', payload);
    if (r.status === 200) onDone();
    else setError(email.trim() ? 'Invalid email or password.' : 'That password is wrong. It is OWNER_PASSWORD in the server’s .env.');
  };
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-rule bg-card p-6">
        <p className="reading text-[4.5rem] text-fill" aria-hidden>%</p>
        <h1 className="mt-3 text-2xl font-semibold">Claude usage</h1>
        <p className="mt-1 text-sm text-muted">Sign in to inspect your team’s Claude Code allowance, sessions and guardrails.</p>
        <div className="mt-5">
          <label className="flex flex-col gap-1 text-sm">Email
            <input type="email" autoComplete="username" value={email} placeholder="lead@company.com (optional for superadmin)"
              onChange={(e) => setEmail(e.target.value)} className="rounded-md border border-rule bg-paper px-3 py-2 text-sm" />
          </label>
          <p className="mt-1 text-xs text-muted">Leave blank to sign in with the primary superadmin secret.</p>
        </div>
        <label className="mt-4 flex flex-col gap-1 text-sm">Owner password
          <input type="password" autoFocus autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} className="rounded-md border border-rule bg-paper px-3 py-2 text-base" />
        </label>
        {error && <p className="mt-2 text-sm text-limit">{error}</p>}
        <button className="mt-5 w-full rounded-md bg-ink py-2.5 font-medium text-paper">Sign in</button>
      </form>
    </main>
  );
}
