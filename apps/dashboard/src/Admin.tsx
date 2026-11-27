// Admin list pages: People (unified table + invite modal), Devices, Models & cost, Audit log.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Go } from './Home.tsx';
import {
  PLUGIN_MIGRATE_CMD, PLUGIN_UPDATE_CMD,
  ago, call, compact, describeAudit, isOutdated, lastSeen, pct, personColors, personStatus, usd,
  type Analytics as A, type AuditEvent, type Installation, type Overview, type Person,
} from './lib.ts';
import { Copy, InviteModal, type Invite } from './People.tsx';
import { Avatar, Card, Chips, Kpi, Modal, PageHead, Pill, RowMenu, SearchBox, ShareCell, Th } from './ui.tsx';

const has = (q: string, ...fields: (string | null | undefined)[]) => !q || fields.some((f) => f?.toLowerCase().includes(q.toLowerCase()));

type PeoplePreset = 'summary' | 'usage' | 'guardrails';
type SortKey = 'name' | 'cost' | 'requests' | 'sessions' | 'outside' | 'flags';

export function PeoplePage({ data, a, teamId, go, reload }: {
  data: Overview; a: A; teamId: string; go: Go; reload: () => void;
}) {
  const color = personColors(a.people.map((p) => p.pid));
  const [filter, setFilter] = useState<'all' | 'active' | 'invited' | 'flagged' | 'outdated' | 'removed'>('all');
  const [preset, setPreset] = useState<PeoplePreset>('summary');
  const [sortBy, setSortBy] = useState<SortKey>('cost');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [q, setQ] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [moving, setMoving] = useState<Person | null>(null);
  const [teamMsg, setTeamMsg] = useState('');
  const [rev, setRev] = useState(0); // refetches the unassigned list after a move
  const isSuper = data.viewer.role === 'superadmin';
  const myTeams = isSuper ? data.teams : data.teams.filter((t) => data.viewer.teamIds.includes(t.id));
  const moveTo = async (person: { id: number; name: string }, teamId: number | null) => {
    const r = await call(`/api/dashboard/people/${person.id}`, 'PATCH', { teamId });
    const name = data.teams.find((t) => t.id === teamId)?.name;
    setTeamMsg(r.status === 200 ? `${person.name} ${name ? `moved to ${name}` : 'removed from their team'}.` : r.data?.error ?? `Could not move ${person.name}.`);
    setMoving(null); setRev((n) => n + 1); reload();
  };
  const total = a.people.reduce((s, p) => s + p.cost, 0);
  const openFlags = (pid: number) => a.flags.filter((f) => f.pid === pid && !f.review);
  const policy = data.policy.data;

  const rows = data.people.map((p) => {
    const devices = data.installations.filter((d) => d.personId === p.id);
    const liveDevices = devices.filter((d) => !d.revoked);
    const stats = a.people.find((x) => x.pid === p.id);
    const repoTotal = stats ? stats.repoCost.work + stats.repoCost.outside + stats.repoCost.none : 0;
    const outsidePct = stats && repoTotal ? pct(stats.repoCost.outside, repoTotal) : 0;
    const noRepoPct = stats && repoTotal ? pct(stats.repoCost.none, repoTotal) : 0;
    const needsUpdate = liveDevices.some((d) => isOutdated(d.clientVersion, data.latestPluginVersion));
    return {
      p, devices, stats, outsidePct, noRepoPct, needsUpdate,
      status: personStatus(p, data.installations),
      flags: openFlags(p.id),
      seen: lastSeen(liveDevices),
    };
  });

  const count = (k: string) => rows.filter((r) => (
    k === 'flagged' ? r.flags.length > 0
      : k === 'outdated' ? r.needsUpdate
        : k === 'invited' ? ['invited', 'notset'].includes(r.status.key)
          : r.status.key === k
  )).length;

  const toggleSort = (k: SortKey) => {
    if (sortBy === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(k); setSortDir(k === 'name' ? 'asc' : 'desc'); }
  };

  const shown = rows
    .filter((r) => (filter === 'all'
      || (filter === 'flagged' ? r.flags.length > 0
        : filter === 'outdated' ? r.needsUpdate
          : filter === 'invited' ? ['invited', 'notset'].includes(r.status.key)
            : r.status.key === filter))
      && has(q, r.p.name, r.p.teamName, ...r.devices.map((d) => d.name), ...r.p.gitEmails))
    .sort((x, y) => {
      const m = sortDir === 'asc' ? 1 : -1;
      switch (sortBy) {
        case 'name': return x.p.name.localeCompare(y.p.name) * m;
        case 'requests': return ((x.stats?.requests ?? 0) - (y.stats?.requests ?? 0)) * m;
        case 'sessions': return ((x.stats?.sessions ?? 0) - (y.stats?.sessions ?? 0)) * m;
        case 'outside': return (x.outsidePct - y.outsidePct) * m;
        case 'flags': return (x.flags.length - y.flags.length) * m;
        default: return ((x.stats?.cost ?? 0) - (y.stats?.cost ?? 0)) * m || x.p.name.localeCompare(y.p.name);
      }
    });

  const newLink = async (personId: number, name: string) => {
    const r = await call('/api/dashboard/invites', 'POST', { personId });
    if (r.status === 200) { setInvite({ ...r.data, name }); setInviteOpen(true); reload(); }
  };

  const sortBtn = (k: SortKey, label: string, right = false) => (
    <button type="button" onClick={() => toggleSort(k)} className={`inline-flex items-center gap-1 hover:text-ink ${right ? 'ml-auto' : ''}`}>
      <span>{label}</span>
      {sortBy === k && <span aria-hidden>{sortDir === 'asc' ? '↑' : '↓'}</span>}
    </button>
  );

  return (
    <div>
      <PageHead
        title="People"
        sub="Everyone using Claude in this scope, on any account. Teammates never see this page."
        action={
          <button
            type="button"
            className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper"
            onClick={() => { setInvite(null); setInviteOpen(true); }}
          >
            Invite a teammate
          </button>
        }
      />

      <InviteModal
        open={inviteOpen}
        invite={invite}
        teams={data.teams}
        defaultTeamId={teamId ? Number(teamId) : (data.viewer.role === 'team_lead' ? data.viewer.teamIds[0] ?? null : null)}
        requireTeam={data.viewer.role === 'team_lead'}
        onClose={() => { setInviteOpen(false); setInvite(null); }}
        onCreated={(i) => { setInvite(i); reload(); }}
        accounts={data.accounts}
      />
      {teamMsg && <p role="status" className="mb-4 text-sm text-muted">{teamMsg}</p>}
      {myTeams.length > 0 && <Unassigned teams={myTeams} onAdd={moveTo} key={rev} />}
      {moving && (
        <Modal open onClose={() => setMoving(null)} title={`Move ${moving.name}`} sub={isSuper ? 'Their usage history moves with them.' : 'You can move people between your own teams.'}>
          <div className="flex flex-wrap gap-2">
            {myTeams.filter((t) => t.id !== moving.teamId).map((t) => (
              <button key={t.id} type="button" className="rounded-md border border-rule bg-paper px-3 py-1.5 text-sm hover:border-ink" onClick={() => moveTo(moving, t.id)}>{t.name}</button>
            ))}
            {isSuper && moving.teamId !== null && (
              <button type="button" className="rounded-md border border-rule px-3 py-1.5 text-sm text-muted hover:border-ink" onClick={() => moveTo(moving, null)}>No team</button>
            )}
          </div>
        </Modal>
      )}

      <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="People" value={data.people.length} foot={`${data.installations.filter((d) => !d.revoked).length} devices connected`} />
        <Kpi label="Active" value={count('active')} pill={<Pill tone="good">{data.people.length ? `${count('active')} of ${data.people.length}` : 'none'}</Pill>} foot="A session in the last 7 days" />
        <Kpi label="Waiting to join" value={count('invited')} pill={count('invited') ? <Pill tone="info">link sent or due</Pill> : undefined} foot="Invited or not set up yet" />
        <Kpi label="Flagged" value={count('flagged')} pill={count('flagged') ? <Pill tone="warn">to review</Pill> : <Pill tone="good">clear</Pill>} foot="People with open flags in this range" />
      </div>

      <Card className="mt-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Chips
              label="Status filter"
              value={filter}
              onChange={setFilter}
              options={[
                ['all', 'All', rows.length],
                ['active', 'Active', count('active')],
                ['invited', 'Waiting', count('invited')],
                ['flagged', 'Flagged', count('flagged')],
                ['outdated', 'Needs update', count('outdated')],
                ['removed', 'Removed', count('removed')],
              ]}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div role="tablist" aria-label="Columns view" className="inline-flex rounded-md bg-band p-1 text-xs">
              {([['summary', 'Summary'], ['usage', 'Usage & effort'], ['guardrails', 'Guardrails & Git']] as [PeoplePreset, string][]).map(([k, l]) => (
                <button key={k} role="tab" aria-selected={preset === k} onClick={() => setPreset(k)}
                  className={`rounded px-2.5 py-1 font-medium ${preset === k ? 'bg-card text-ink shadow-[0_0_0_1px_var(--rule)]' : 'text-muted hover:text-ink'}`}>
                  {l}
                </button>
              ))}
            </div>
            <SearchBox value={q} onChange={setQ} placeholder="Search people, teams, devices" />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-rule">
              {preset === 'summary' && (
                <tr>
                  <Th>{sortBtn('name', 'Person')}</Th>
                  <Th>Status</Th>
                  <Th>Share</Th>
                  <Th right>{sortBtn('cost', 'Work', true)}</Th>
                  <Th right>{sortBtn('requests', 'Requests', true)}</Th>
                  <Th right>{sortBtn('sessions', 'Sessions', true)}</Th>
                  <Th>Last active</Th>
                  <Th>{sortBtn('flags', 'Flags')}</Th>
                  <Th />
                </tr>
              )}
              {preset === 'usage' && (
                <tr>
                  <Th>{sortBtn('name', 'Person')}</Th>
                  <Th right>{sortBtn('cost', 'Work', true)}</Th>
                  <Th right>{sortBtn('requests', 'Requests', true)}</Th>
                  <Th right>{sortBtn('sessions', 'Sessions', true)}</Th>
                  <Th right>Active days</Th>
                  <Th right>Cache hit</Th>
                  <Th right>Overnight</Th>
                  <Th right>Scripted</Th>
                  <Th right>Bypass</Th>
                  <Th>Top model</Th>
                  <Th />
                </tr>
              )}
              {preset === 'guardrails' && (
                <tr>
                  <Th>{sortBtn('name', 'Person')}</Th>
                  <Th right>{sortBtn('outside', 'Outside work', true)}</Th>
                  <Th right>No repo</Th>
                  <Th right>Claude commits</Th>
                  <Th right>Git commits</Th>
                  <Th>{sortBtn('flags', 'Flags')}</Th>
                  <Th />
                </tr>
              )}
            </thead>
            <tbody className="divide-y divide-rule">
              {shown.map(({ p, devices, stats, status, flags, seen, outsidePct, noRepoPct, needsUpdate }) => {
                const liveCount = devices.filter((d) => !d.revoked).length;
                const menu = (
                  <RowMenu label={`Actions for ${p.name}`} items={[
                    { label: 'Open profile', onClick: () => go(`/people/${p.id}`) },
                    { label: devices.length ? 'New link for another device' : 'Send a new link', onClick: () => newLink(p.id, p.name) },
                    ...(myTeams.some((t) => t.id !== p.teamId) ? [{ label: 'Move to team…', onClick: () => setMoving(p) }] : []),
                    ...(p.openInvite ? [{ label: 'Cancel open link', onClick: async () => { await call(`/api/dashboard/people/${p.id}/invites`, 'DELETE'); reload(); } }] : []),
                    { label: 'See their activity in the audit log', onClick: () => go(`/audit?personId=${p.id}`) },
                  ]} />
                );
                const personCell = (
                  <td className="px-3 py-3">
                    <button type="button" className="flex items-center gap-3 text-left" onClick={() => go(`/people/${p.id}`)}>
                      <Avatar name={p.name} color={color(p.id)} />
                      <span>
                        <span className="flex flex-wrap items-center gap-1.5 font-medium hover:underline">
                          <span>{p.name}</span>
                          {p.teamName && <Pill tone="neutral">{p.teamName}</Pill>}
                          {needsUpdate && <Pill tone="warn">Needs update</Pill>}
                        </span>
                        <span className="block text-xs text-muted">
                          {liveCount} device{liveCount === 1 ? '' : 's'}{p.gitEmails[0] ? `, ${p.gitEmails[0]}` : ''}
                        </span>
                      </span>
                    </button>
                  </td>
                );

                if (preset === 'usage') {
                  return (
                    <tr key={p.id} className="hover:bg-band/40">
                      {personCell}
                      <td className="px-3 text-right tabular-nums font-medium">{usd(stats?.cost ?? 0)}</td>
                      <td className="px-3 text-right tabular-nums">{(stats?.requests ?? 0).toLocaleString()}</td>
                      <td className="px-3 text-right tabular-nums">{stats?.sessions ?? 0}</td>
                      <td className="px-3 text-right tabular-nums">{stats?.activeDays ?? 0}</td>
                      <td className="px-3 text-right tabular-nums">{stats ? `${Math.round(stats.cacheHit * 100)}%` : '0%'}</td>
                      <td className={`px-3 text-right tabular-nums ${(stats?.nightPct ?? 0) >= policy.flagNightPct && (stats?.requests ?? 0) >= 20 ? 'font-medium text-ahead' : ''}`}>{stats ? `${stats.nightPct}%` : '0%'}</td>
                      <td className={`px-3 text-right tabular-nums ${(stats?.sdkPct ?? 0) >= policy.flagSdkPct && (stats?.requests ?? 0) >= 50 ? 'font-medium text-ahead' : ''}`}>{stats ? `${stats.sdkPct}%` : '0%'}</td>
                      <td className={`px-3 text-right tabular-nums ${(stats?.bypassPct ?? 0) >= policy.flagBypassPct && (stats?.decisions ?? 0) >= 20 ? 'font-medium text-ahead' : ''}`}>{stats ? `${stats.bypassPct}%` : '0%'}</td>
                      <td className="px-3 font-mono text-xs text-muted">{stats?.topModel?.replace(/^claude-/, '') ?? 'None'}</td>
                      <td className="px-3 text-right">{menu}</td>
                    </tr>
                  );
                }

                if (preset === 'guardrails') {
                  return (
                    <tr key={p.id} className="hover:bg-band/40">
                      {personCell}
                      <td className={`px-3 text-right tabular-nums ${policy.workNamespaces.length && outsidePct >= policy.flagOutsideWorkPct ? 'font-medium text-ahead' : ''}`}>
                        {policy.workNamespaces.length ? `${outsidePct}%` : 'n/a'}
                      </td>
                      <td className={`px-3 text-right tabular-nums ${noRepoPct >= policy.flagNoRepoPct ? 'font-medium text-ahead' : ''}`}>{noRepoPct}%</td>
                      <td className="px-3 text-right tabular-nums">{stats?.claude.commits ?? 0}</td>
                      <td className="px-3 text-right tabular-nums">{stats?.gitlab.commits ?? 0}</td>
                      <td className="px-3">{flags.length ? <Pill tone={flags.some((f) => f.severity === 'alert') ? 'bad' : 'warn'}>{flags.length} open</Pill> : <span className="text-muted">Clear</span>}</td>
                      <td className="px-3 text-right">{menu}</td>
                    </tr>
                  );
                }

                return (
                  <tr key={p.id} className="hover:bg-band/40">
                    {personCell}
                    <td className="px-3">
                      <Pill tone={status.tone}>{status.label}</Pill>
                      {p.openInvite && <p className="mt-1 text-xs text-muted">{p.openInvite.uses}/{p.openInvite.maxUses} joined, link open</p>}
                    </td>
                    <td className="px-3"><ShareCell value={pct(stats?.cost ?? 0, total)} color={color(p.id)} /></td>
                    <td className="px-3 text-right font-medium tabular-nums">{usd(stats?.cost ?? 0)}</td>
                    <td className="px-3 text-right tabular-nums">{(stats?.requests ?? 0).toLocaleString()}</td>
                    <td className="px-3 text-right tabular-nums">{stats?.sessions ?? 0}</td>
                    <td className="px-3 text-muted">{seen ? ago(seen) : 'Never'}</td>
                    <td className="px-3">{flags.length ? <Pill tone={flags.some((f) => f.severity === 'alert') ? 'bad' : 'warn'}>{flags.length} open</Pill> : <span className="text-muted">Clear</span>}</td>
                    <td className="px-3 text-right">{menu}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!shown.length && <p className="py-6 text-center text-sm text-muted">{data.people.length ? 'No one matches.' : 'No one yet. Invite your first teammate.'}</p>}
        </div>
      </Card>
    </div>
  );
}

/** People nobody has put in a team yet: superadmins and leads add them to one of their teams in one click. */
function Unassigned({ teams, onAdd }: { teams: { id: number; name: string }[]; onAdd: (p: { id: number; name: string }, teamId: number) => void }) {
  const [people, setPeople] = useState<{ id: number; name: string; devices: number; createdAt: string }[]>([]);
  useEffect(() => {
    call<{ people: typeof people }>('/api/dashboard/people/unassigned').then((r) => { if (r.status === 200) setPeople(r.data.people); });
  }, []);
  if (!people.length) return null;
  return (
    <Card className="mb-6" title={`Not in a team yet (${people.length})`} sub="Already enrolled, but no team sees them. Add them to a team so its lead can follow their usage.">
      <ul className="divide-y divide-rule text-sm">
        {people.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
            <span><span className="font-medium">{p.name}</span><span className="ml-2 text-xs text-muted">{p.devices} device{p.devices === 1 ? '' : 's'}, added {ago(p.createdAt)}</span></span>
            <span className="flex flex-wrap gap-2">
              {teams.map((t) => (
                <button key={t.id} type="button" className="rounded-md border border-rule px-2.5 py-1 text-xs hover:border-ink" onClick={() => onAdd(p, t.id)}>
                  Add to {t.name}
                </button>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function DevicesPage({ data, go, reload }: { data: Overview; go: Go; reload: () => void }) {
  const [filter, setFilter] = useState<'all' | 'active' | 'quiet' | 'outdated' | 'removed'>('all');
  const [q, setQ] = useState('');
  const [confirm, setConfirm] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; value: string } | null>(null);
  const [reconnectInvite, setReconnectInvite] = useState<Invite | null>(null);
  const person = (d: Installation) => data.people.find((p) => p.id === d.personId)?.name ?? null;
  const state = (d: Installation) => d.revoked ? 'removed' : d.lastHeartbeatAt && Date.now() - Date.parse(d.lastHeartbeatAt) < 24 * 3600_000 ? 'active' : 'quiet';
  const outdated = (d: Installation) => !d.revoked && isOutdated(d.clientVersion, data.latestPluginVersion);
  const count = (k: string) => data.installations.filter((d) => (k === 'outdated' ? outdated(d) : state(d) === k)).length;
  const shown = data.installations.filter((d) => (filter === 'all' || (filter === 'outdated' ? outdated(d) : state(d) === filter))
    && has(q, d.name, d.hostname, person(d), d.os));
  const setRevoked = async (id: number, revoked: boolean) => { await call(`/api/dashboard/installations/${id}`, 'PATCH', { revoked }); setConfirm(null); reload(); };
  const reconnectDevice = async (d: Installation) => {
    const r = await call('/api/dashboard/invites', 'POST', { installationId: d.id });
    if (r.status === 200) {
      setReconnectInvite({ ...r.data, name: person(d) ?? d.name, deviceName: d.name });
      reload();
    }
  };

  return (
    <div>
      <PageHead title="Devices" sub="Every computer reporting to the monitor. Removing one stops its data immediately." />
      <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Devices" value={data.installations.filter((d) => !d.revoked).length} foot={`${count('removed')} removed`} />
        <Kpi label="Active today" value={count('active')} pill={<Pill tone="good">last 24 h</Pill>} foot="Started a Claude Code session" />
        <Kpi label="Needs update" value={count('outdated')} pill={count('outdated') ? <Pill tone="warn">Needs update</Pill> : <Pill tone="good">all current</Pill>} foot={`Latest is ${data.latestPluginVersion ?? 'unknown'}`} />
        <Kpi label="Quiet" value={count('quiet')} foot="No session in the last 24 h" />
      </div>
      {count('outdated') > 0 && (
        <Card
          className="mt-5"
          title={`${count('outdated')} device${count('outdated') === 1 ? '' : 's'} running a deprecated plugin`}
          sub={`Latest plugin is v${data.latestPluginVersion}. Teammates who originally installed from GitLab must switch the marketplace to GitHub once, then restart Claude Code:`}
        >
          <Copy text={PLUGIN_MIGRATE_CMD} label="Switch marketplace to GitHub and update plugin" />
          <p className="mt-3 text-xs text-muted">
            Already on GitHub? Run <code>{PLUGIN_UPDATE_CMD}</code> and restart Claude Code.
          </p>
        </Card>
      )}
      <Card className="mt-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <Chips value={filter} onChange={setFilter} options={[['all', 'All', data.installations.length], ['active', 'Active', count('active')], ['quiet', 'Quiet', count('quiet')], ['outdated', 'Needs update', count('outdated')], ['removed', 'Removed', count('removed')]]} />
          <SearchBox value={q} onChange={setQ} placeholder="Search devices or people" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-rule"><tr><Th>Device</Th><Th>Person</Th><Th>Claude account</Th><Th>Status</Th><Th>Plugin</Th><Th>Joined</Th><Th>Last session</Th><Th /></tr></thead>
            <tbody className="divide-y divide-rule">
              {shown.map((d) => {
                const st = state(d);
                return (
                  <tr key={d.id} className="hover:bg-band/40">
                    <td className="px-3 py-3">
                      {renaming?.id === d.id ? (
                        <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); await call(`/api/dashboard/installations/${d.id}`, 'PATCH', { name: renaming.value }); setRenaming(null); reload(); }}>
                          <input autoFocus aria-label="Device name" value={renaming.value} maxLength={60} onChange={(e) => setRenaming({ id: d.id, value: e.target.value })} className="rounded-md border border-rule bg-paper px-2 py-1" />
                          <button className="rounded-md bg-ink px-2.5 py-1 text-xs text-paper">Save</button>
                        </form>
                      ) : (
                        <>
                          <p className={`font-medium ${d.revoked ? 'text-muted line-through' : ''}`}>{d.name}</p>
                          <p className="text-xs text-muted">{[d.hostname !== d.name && d.hostname, d.os].filter(Boolean).join(', ')}</p>
                        </>
                      )}
                    </td>
                    <td className="px-3">{d.personId ? <button className="hover:underline" onClick={() => go(`/people/${d.personId}`)}>{person(d)}</button> : <span className="text-muted">Before invites</span>}</td>
                    <td className="px-3">{d.accountLabel ?? <span className="text-muted">Not reported yet</span>}</td>
                    <td className="px-3"><Pill tone={st === 'active' ? 'good' : 'neutral'}>{st === 'active' ? 'Active' : st === 'removed' ? 'Removed' : d.lastHeartbeatAt ? 'Quiet' : 'Waiting'}</Pill></td>
                    <td className="px-3">
                      <span className="tabular-nums">{d.clientVersion?.replace(/^plugin-/, '') ?? 'Legacy / unknown'}</span>
                      {outdated(d) && <span className="ml-2"><Pill tone="warn">Needs update</Pill></span>}
                    </td>
                    <td className="px-3 text-muted">{ago(d.joinedAt)}{d.joinedIp ? `, ${d.joinedIp}` : ''}</td>
                    <td className="px-3 text-muted">{d.lastHeartbeatAt ? ago(d.lastHeartbeatAt) : 'Never'}</td>
                    <td className="px-3 text-right">
                      {confirm === d.id ? (
                        <span className="flex items-center justify-end gap-2 whitespace-nowrap">
                          <span className="text-xs">Stop accepting its data?</span>
                          <button className="rounded-md bg-limit px-2.5 py-1 text-xs text-paper" onClick={() => setRevoked(d.id, true)}>Remove device</button>
                          <button className="text-xs text-muted" onClick={() => setConfirm(null)}>Keep</button>
                        </span>
                      ) : (
                        <RowMenu label={`Actions for ${d.name}`} items={[
                          ...(d.personId ? [{ label: 'Reconnect device (refresh token)', onClick: () => reconnectDevice(d) }] : []),
                          { label: 'Rename', onClick: () => setRenaming({ id: d.id, value: d.name }) },
                          ...(d.personId ? [{ label: 'Open person', onClick: () => go(`/people/${d.personId}`) }] : []),
                          d.revoked ? { label: 'Restore device', onClick: () => setRevoked(d.id, false) } : { label: 'Remove device', danger: true, onClick: () => setConfirm(d.id) },
                        ]} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!shown.length && <p className="py-6 text-center text-sm text-muted">No devices match.</p>}
        </div>
      </Card>
      <InviteModal open={Boolean(reconnectInvite)} invite={reconnectInvite} onClose={() => setReconnectInvite(null)} onCreated={() => {}} />
    </div>
  );
}

export function ModelsPage({ a }: { a: A }) {
  const color = personColors(a.people.map((p) => p.pid));
  const total = a.models.reduce((s, m) => s + m.cost, 0);
  const calls = a.models.reduce((s, m) => s + m.calls, 0);
  const inTok = a.models.reduce((s, m) => s + m.input + m.cacheRead + m.cacheCreation, 0);
  const outTok = a.models.reduce((s, m) => s + m.output, 0);
  const cacheRead = a.models.reduce((s, m) => s + m.cacheRead, 0);
  const people = a.people.filter((p) => p.requests > 0);
  return (
    <div>
      <PageHead title="Models & cost" sub="Which models the team used and what that would cost at API prices. Claude seats are a flat fee; this compares work." />
      <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Work at API prices" value={usd(total)} foot="Estimate from Claude Code's own cost figures" />
        <Kpi label="Requests" value={compact(calls)} foot={`${a.models.length} model${a.models.length === 1 ? '' : 's'} used`} />
        <Kpi label="Tokens" value={compact(inTok + outTok)} foot={`${compact(inTok)} in, ${compact(outTok)} out`} />
        <Kpi label="Cache hit" value={`${pct(cacheRead, inTok)}%`} pill={<Pill tone={pct(cacheRead, inTok) >= 70 ? 'good' : 'warn'}>{pct(cacheRead, inTok) >= 70 ? 'healthy' : 'low'}</Pill>} foot="Input served from cache; higher is cheaper" />
      </div>
      <Card className="mt-12" title="Usage by model">
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="border-b border-rule"><tr><Th>Model</Th><Th right>Requests</Th><Th right>Input</Th><Th right>Output</Th><Th right>Cache read</Th><Th right>Cache write</Th><Th right>Cost</Th><Th>Share</Th></tr></thead>
            <tbody className="divide-y divide-rule">
              {a.models.map((m) => (
                <tr key={m.model}>
                  <td className="px-3 py-2.5 font-mono text-xs">{m.model}</td>
                  <td className="px-3 text-right">{m.calls.toLocaleString()}</td>
                  <td className="px-3 text-right">{compact(m.input)}</td>
                  <td className="px-3 text-right">{compact(m.output)}</td>
                  <td className="px-3 text-right">{compact(m.cacheRead)}</td>
                  <td className="px-3 text-right">{compact(m.cacheCreation)}</td>
                  <td className="px-3 text-right font-medium">{usd(m.cost)}</td>
                  <td className="px-3"><ShareCell value={pct(m.cost, total)} color="var(--fill)" /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!a.models.length && <p className="py-6 text-center text-sm text-muted">No requests in this range.</p>}
        </div>
      </Card>
      {people.length > 0 && a.models.length > 0 && (
        <Card className="mt-12" title="Model by person" sub="Cost per person on each model.">
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead className="border-b border-rule"><tr><Th>Model</Th>{people.map((p) => <Th key={p.pid} right>
                <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-[2px]" style={{ background: color(p.pid) }} />{p.name}</span>
              </Th>)}</tr></thead>
              <tbody className="divide-y divide-rule">
                {a.models.map((m) => (
                  <tr key={m.model}>
                    <td className="px-3 py-2.5 font-mono text-xs">{m.model}</td>
                    {people.map((p) => {
                      const c = m.people.find((x) => x.pid === p.pid);
                      return <td key={p.pid} className="px-3 text-right">{c ? <>{usd(c.cost)}<span className="ml-1 text-xs text-muted">{c.calls}</span></> : <span className="text-muted">0</span>}</td>;
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

export function AuditPage({ data, teamId, initial }: { data: Overview; teamId: string; initial: Record<string, string> }) {
  const [f, setF] = useState({ q: '', action: '', personId: initial.personId ?? '', from: '', to: '' });
  const [rows, setRows] = useState<AuditEvent[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [more, setMore] = useState(false);
  const qs = useMemo(() => {
    const entries: [string, string][] = Object.entries(f).filter(([, v]) => Boolean(v));
    if (teamId) entries.push(['teamId', teamId]);
    return new URLSearchParams(entries).toString();
  }, [f, teamId]);
  const load = useCallback(async (before?: number) => {
    const r = await call<{ events: AuditEvent[]; actions: string[]; total: number }>(`/api/dashboard/audit?limit=100&${qs}${before ? `&before=${before}` : ''}`);
    if (!r.data) return;
    setRows((cur) => (before ? [...cur, ...r.data.events] : r.data.events));
    setActions(r.data.actions); setTotal(r.data.total); setMore(r.data.events.length === 100);
  }, [qs]);
  useEffect(() => { const t = setTimeout(() => load(), 200); return () => clearTimeout(t); }, [load]);
  const field = 'rounded-md border border-rule bg-card px-2.5 py-1.5 text-sm';
  const tz = data.policy.data.displayTimezone;
  const time = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'short', timeStyle: 'medium' }).format(new Date(iso));

  return (
    <div>
      <PageHead title="Audit log" sub={`Every admin, device and system action, newest first. ${total.toLocaleString()} events, kept a year.`}
        action={
          <div className="flex gap-2">
            <button className="rounded-md border border-rule bg-card px-3 py-1.5 text-sm hover:bg-band" onClick={() => load()}>Refresh</button>
            <a className="rounded-md border border-rule bg-card px-3 py-1.5 text-sm hover:bg-band" href={`/api/dashboard/audit.csv?${qs}`}>Export CSV</a>
          </div>
        } />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SearchBox value={f.q} onChange={(q) => setF({ ...f, q })} placeholder="Search actions and details" />
        <select aria-label="Person" className={field} value={f.personId} onChange={(e) => setF({ ...f, personId: e.target.value })}>
          <option value="">Everyone</option>
          {data.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select aria-label="Action" className={field} value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}>
          <option value="">All actions</option>
          {actions.map((x) => <option key={x}>{x}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-muted">From <input type="date" className={field} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label className="flex items-center gap-1.5 text-sm text-muted">To <input type="date" className={field} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        {Object.values(f).some(Boolean) && <button className="text-sm text-muted hover:text-ink" onClick={() => setF({ q: '', action: '', personId: '', from: '', to: '' })}>Clear</button>}
      </div>
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-rule"><tr><Th>Time</Th><Th>Action</Th><Th>Who</Th><Th>What happened</Th></tr></thead>
            <tbody className="divide-y divide-rule">
              {rows.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-muted">{time(e.at)}</td>
                  <td className="px-3"><span className="rounded bg-band px-1.5 py-0.5 font-mono text-xs">{e.action}</span></td>
                  <td className="whitespace-nowrap px-3">{e.actor === 'owner' ? (e.userName ?? 'Admin') : e.actor === 'system' ? 'System' : e.person ?? e.device ?? 'Device'}</td>
                  <td className="px-3">{describeAudit(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <p className="py-6 text-center text-sm text-muted">No events match.</p>}
        </div>
        {more && <button className="mt-4 text-sm text-muted hover:text-ink" onClick={() => load(rows[rows.length - 1].id)}>Load older events</button>}
      </Card>
    </div>
  );
}
