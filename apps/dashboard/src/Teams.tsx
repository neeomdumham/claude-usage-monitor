// Superadmin page for managing teams/departments and dashboard admins (superadmins + team leads).
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Go } from './Home.tsx';
import { ago, call, type AccountRow, type AdminUser, type Overview, type Person, type Team } from './lib.ts';
import { Card, Modal, PageHead, Pill, RowMenu, Th } from './ui.tsx';

export function TeamsPage({ data, go, onSelectTeam, reload }: {
  data: Overview; go: Go; onSelectTeam: (teamId: string) => void; reload: () => void;
}) {
  const [teams, setTeams] = useState<Team[]>(data.teams);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [teamModal, setTeamModal] = useState<{ mode: 'create' | 'edit'; team?: Team } | null>(null);
  const [userModal, setUserModal] = useState<{ mode: 'create' | 'edit'; user?: AdminUser } | null>(null);
  const [confirmDeleteTeam, setConfirmDeleteTeam] = useState<Team | null>(null);
  const [moveTo, setMoveTo] = useState('');
  const [contentToggleBusy, setContentToggleBusy] = useState(false);

  const loadAll = useCallback(async () => {
    const [t, u] = await Promise.all([
      call<{ teams: Team[] }>('/api/dashboard/teams'),
      call<{ users: AdminUser[] }>('/api/dashboard/users'),
    ]);
    if (t.status === 200 && t.data) setTeams(t.data.teams);
    if (u.status === 200 && u.data) setUsers(u.data.users);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const refresh = () => { loadAll(); reload(); };

  const toggleLeadsContent = async (next: boolean) => {
    setContentToggleBusy(true);
    await call('/api/dashboard/policy', 'PATCH', { leadsCanViewContent: next });
    setContentToggleBusy(false);
    reload();
  };

  if (data.viewer.role !== 'superadmin') {
    return (
      <div>
        <PageHead title="Teams" sub="Only superadmins can manage departments and dashboard accounts." />
        <p className="text-sm text-muted">You are signed in as a team lead. Contact a superadmin to update team assignments.</p>
      </div>
    );
  }

  const teamName = (id: number) => teams.find((t) => t.id === id)?.name ?? `Team #${id}`;

  return (
    <div className="space-y-10">
      <PageHead
        title="Teams & Admins"
        sub="Organize teammates by department and grant team leads scoped access to their own team."
        action={
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setTeamModal({ mode: 'create' })}
              className="rounded-md border border-rule bg-card px-3.5 py-2 text-sm font-medium hover:bg-band">
              New team
            </button>
            <button type="button" onClick={() => setUserModal({ mode: 'create' })}
              className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper">
              Add admin or lead
            </button>
          </div>
        }
      />

      <Card
        title="Teams"
        sub="Team work namespaces merge automatically with global namespaces for on-device repository blocking."
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-rule">
              <tr><Th>Team</Th><Th>Leads</Th><Th right>Members</Th><Th>Team work namespaces</Th><Th>Created</Th><Th /></tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {teams.map((t) => (
                <tr key={t.id} className="hover:bg-band/40">
                  <td className="px-3 py-3 font-medium">
                    <button type="button" className="hover:underline" onClick={() => go(`/teams/${t.id}`)}>
                      {t.name}
                    </button>
                  </td>
                  <td className="px-3 text-muted">{t.leadNames.length ? t.leadNames.join(', ') : 'No lead assigned'}</td>
                  <td className="px-3 text-right tabular-nums">{t.memberCount}</td>
                  <td className="px-3 font-mono text-xs text-muted">
                    {t.workNamespaces.length ? t.workNamespaces.join(', ') : 'Inherits global only'}
                  </td>
                  <td className="px-3 text-muted">{ago(t.createdAt)}</td>
                  <td className="px-3 text-right">
                    <RowMenu label={`Actions for ${t.name}`} items={[
                      { label: 'Members & accounts', onClick: () => go(`/teams/${t.id}`) },
                      { label: 'View team dashboard', onClick: () => { onSelectTeam(String(t.id)); go('/dashboard'); } },
                      { label: 'Edit name & namespaces', onClick: () => setTeamModal({ mode: 'edit', team: t }) },
                      { label: 'Delete team', danger: true, onClick: () => { setMoveTo(''); setConfirmDeleteTeam(t); } },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!teams.length && (
            <p className="py-6 text-center text-sm text-muted">
              No teams yet. Create a department (e.g. Backend, Frontend) to assign team leads.
            </p>
          )}
        </div>
      </Card>

      <Card
        title="Dashboard accounts"
        sub="Superadmins manage all teams and global settings. Team leads see their assigned teams’ people, and the allowance of the Claude accounts those teams own or use."
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-rule">
              <tr><Th>Name</Th><Th>Email</Th><Th>Role</Th><Th>Teams</Th><Th>Status</Th><Th /></tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {users.map((u) => {
                const isMe = u.id === data.viewer.id;
                return (
                  <tr key={u.id} className="hover:bg-band/40">
                    <td className="px-3 py-3 font-medium">
                      {u.name} {isMe && <span className="ml-1 text-xs font-normal text-muted">(you)</span>}
                    </td>
                    <td className="px-3 font-mono text-xs text-muted">{u.email}</td>
                    <td className="px-3">
                      <Pill tone={u.role === 'superadmin' ? 'info' : 'neutral'}>
                        {u.role === 'superadmin' ? 'Superadmin' : 'Team lead'}
                      </Pill>
                    </td>
                    <td className="px-3 text-muted">
                      {u.role === 'superadmin' ? 'All teams' : u.teamIds.length ? u.teamIds.map(teamName).join(', ') : 'None assigned'}
                    </td>
                    <td className="px-3">
                      <Pill tone={u.disabled ? 'bad' : 'good'}>{u.disabled ? 'Disabled' : 'Active'}</Pill>
                    </td>
                    <td className="px-3 text-right">
                      <RowMenu label={`Actions for ${u.name}`} items={[
                        { label: 'Edit account details', onClick: () => setUserModal({ mode: 'edit', user: u }) },
                        ...(!isMe ? [{
                          label: u.disabled ? 'Re-enable account' : 'Disable account',
                          danger: !u.disabled,
                          onClick: async () => {
                            await call(`/api/dashboard/users/${u.id}`, 'PATCH', { disabled: !u.disabled });
                            refresh();
                          },
                        }] : []),
                      ]} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-rule bg-card px-4 py-3.5">
          <div>
            <p className="text-sm font-medium">Allow team leads to view captured content</p>
            <p className="text-xs text-muted">
              When off (default), only superadmins can open Captured content. When on, team leads can read prompts, commands and diffs for their own team only.
            </p>
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              disabled={contentToggleBusy}
              checked={data.policy.data.leadsCanViewContent}
              onChange={(e) => toggleLeadsContent(e.target.checked)}
              className="h-4 w-4 accent-[var(--fill)]"
            />
            {data.policy.data.leadsCanViewContent ? 'Enabled' : 'Superadmins only'}
          </label>
        </div>
      </Card>

      {teamModal && (
        <TeamFormModal
          mode={teamModal.mode}
          team={teamModal.team}
          onClose={() => setTeamModal(null)}
          onSaved={() => { setTeamModal(null); refresh(); }}
        />
      )}

      {userModal && (
        <UserFormModal
          mode={userModal.mode}
          user={userModal.user}
          teams={teams}
          isSelf={userModal.user?.id === data.viewer.id}
          onClose={() => setUserModal(null)}
          onSaved={() => { setUserModal(null); refresh(); }}
        />
      )}

      <Modal
        open={Boolean(confirmDeleteTeam)}
        onClose={() => setConfirmDeleteTeam(null)}
        title={`Delete team "${confirmDeleteTeam?.name ?? ''}"?`}
        sub="Usage history is kept. Its members and the Claude accounts it owns move to the team you pick, or become unassigned."
      >
        <label className="mb-4 flex flex-col gap-1.5 text-sm font-medium">Move members and accounts to
          <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className="rounded-md border border-rule bg-paper px-3 py-2 text-sm font-normal">
            <option value="">Nobody (members become unassigned)</option>
            {teams.filter((t) => t.id !== confirmDeleteTeam?.id).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => setConfirmDeleteTeam(null)} className="rounded-md border border-rule px-3.5 py-2 text-sm text-muted hover:bg-band">Cancel</button>
          <button type="button" onClick={async () => {
            if (!confirmDeleteTeam) return;
            await call(`/api/dashboard/teams/${confirmDeleteTeam.id}${moveTo ? `?moveTo=${moveTo}` : ''}`, 'DELETE');
            setConfirmDeleteTeam(null);
            refresh();
          }} className="rounded-md bg-limit px-4 py-2 text-sm font-medium text-paper">Delete team</button>
        </div>
      </Modal>
    </div>
  );
}

function TeamFormModal({ mode, team, onClose, onSaved }: {
  mode: 'create' | 'edit'; team?: Team; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(team?.name ?? '');
  const [ns, setNs] = useState((team?.workNamespaces ?? []).join('\n'));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!name.trim()) return setError('Team name is required.');
    const workNamespaces = ns.split('\n').map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '')).filter(Boolean);
    setBusy(true);
    const r = mode === 'create'
      ? await call('/api/dashboard/teams', 'POST', { name: name.trim(), workNamespaces })
      : await call(`/api/dashboard/teams/${team!.id}`, 'PATCH', { name: name.trim(), workNamespaces });
    setBusy(false);
    if (r.status >= 400) return setError(r.data?.error ?? 'Could not save team.');
    onSaved();
  };

  return (
    <Modal open onClose={onClose} title={mode === 'create' ? 'Create team' : `Edit ${team?.name}`}
      sub="Optional extra work namespaces are merged with global namespaces for teammates in this department.">
      <form onSubmit={submit} className="space-y-4">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Team name
          <input autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Backend"
            className="rounded-md border border-rule bg-paper px-3 py-2 text-sm font-normal" />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Team-specific work namespaces (one per line, optional)
          <textarea value={ns} onChange={(e) => setNs(e.target.value)} rows={3} placeholder={'github.com/tulip-tech/api\ngithub.com/tulip-tech/infra'}
            className="rounded-md border border-rule bg-paper px-3 py-2 font-mono text-xs font-normal" />
        </label>
        {error && <p className="text-sm text-limit">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-md border border-rule px-3.5 py-2 text-sm text-muted hover:bg-band">Cancel</button>
          <button disabled={busy} className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper disabled:opacity-50">
            {busy ? 'Saving…' : mode === 'create' ? 'Create team' : 'Save changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function UserFormModal({ mode, user, teams, isSelf, onClose, onSaved }: {
  mode: 'create' | 'edit'; user?: AdminUser; teams: Team[]; isSelf: boolean; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'superadmin' | 'team_lead'>(user?.role ?? 'team_lead');
  const [teamIds, setTeamIds] = useState<number[]>(user?.teamIds ?? (teams[0] ? [teams[0].id] : []));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const toggleTeam = (id: number) =>
    setTeamIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!name.trim()) return setError('Name is required.');
    if (!email.trim()) return setError('Valid email is required.');
    if (mode === 'create' && password.length < 8) {
      return setError('Password (8+ characters) is required.');
    }
    if (mode === 'edit' && password && password.length < 8) {
      return setError('New password must be at least 8 characters.');
    }
    setBusy(true);
    const r = mode === 'create'
      ? await call('/api/dashboard/users', 'POST', {
          name: name.trim(), email: email.trim(), password, role,
          teamIds: role === 'team_lead' ? teamIds : [],
        })
      : await call(`/api/dashboard/users/${user!.id}`, 'PATCH', {
          name: name.trim(),
          ...(email.trim().toLowerCase() !== user!.email.toLowerCase() ? { email: email.trim() } : {}),
          ...(!isSelf ? { role } : {}),
          teamIds: role === 'team_lead' ? teamIds : [],
          ...(password ? { password } : {}),
        });
    setBusy(false);
    if (r.status >= 400) return setError(r.data?.error ?? 'Could not save account.');
    onSaved();
  };

  return (
    <Modal open onClose={onClose} title={mode === 'create' ? 'Add dashboard admin or team lead' : `Edit ${user?.name}`}
      sub="Team leads sign in with their email and password and can only view and invite members of their assigned teams.">
      <form onSubmit={submit} className="space-y-4">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Full name
          <input autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Shamim Hasan"
            className="rounded-md border border-rule bg-paper px-3 py-2 text-sm font-normal" />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="shamim@company.com"
            className="rounded-md border border-rule bg-paper px-3 py-2 text-sm font-normal" />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {mode === 'create' ? 'Password (8+ characters)' : 'Reset password (leave blank to keep current)'}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password"
            className="rounded-md border border-rule bg-paper px-3 py-2 text-sm font-normal" />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Role
          <select value={role} disabled={isSelf} onChange={(e) => setRole(e.target.value as any)}
            className="rounded-md border border-rule bg-paper px-3 py-2 text-sm font-normal disabled:opacity-60">
            <option value="team_lead">Team lead (scoped to assigned teams)</option>
            <option value="superadmin">Superadmin (all teams & settings)</option>
          </select>
        </label>
        {role === 'team_lead' && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Assigned teams</legend>
            {teams.length ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {teams.map((t) => (
                  <label key={t.id} className="flex cursor-pointer items-center gap-2 rounded-md border border-rule bg-paper px-3 py-2 text-sm">
                    <input type="checkbox" checked={teamIds.includes(t.id)} onChange={() => toggleTeam(t.id)} className="h-4 w-4 accent-[var(--fill)]" />
                    <span>{t.name}</span>
                  </label>
                ))}
              </div>
            ) : <p className="text-xs text-muted">Create a team first so this lead can manage members.</p>}
          </fieldset>
        )}
        {error && <p className="text-sm text-limit">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-md border border-rule px-3.5 py-2 text-sm text-muted hover:bg-band">Cancel</button>
          <button disabled={busy} className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper disabled:opacity-50">
            {busy ? 'Saving…' : mode === 'create' ? 'Create account' : 'Save changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** One team: its members, the Claude accounts it owns, its leads, and adding existing people to it. */
export function TeamDetail({ id, data, go, reload }: { id: number; data: Overview; go: Go; reload: () => void }) {
  const [view, setView] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  const [everyone, setEveryone] = useState<Person[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState('');
  const team = data.teams.find((t) => t.id === id);

  const load = useCallback(async () => {
    const [v, all, a] = await Promise.all([
      call<Overview>(`/api/dashboard/overview?teamId=${id}`),
      call<Overview>('/api/dashboard/overview'),
      call<{ accounts: AccountRow[] }>('/api/dashboard/accounts'),
    ]);
    setFailed(v.status !== 200);
    if (v.status === 200) setView(v.data);
    if (all.status === 200) setEveryone(all.data.people);
    if (a.status === 200) setAccounts(a.data.accounts.filter((x) => x.teamId === id));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (!team) return <p className="text-muted">That team doesn’t exist. <a className="underline" href="#/teams">Back to teams</a></p>;
  const members = view?.people ?? [];
  const move = async (people: Person[], teamId: number | null) => {
    const results = await Promise.all(people.map((p) => call(`/api/dashboard/people/${p.id}`, 'PATCH', { teamId })));
    const failed = results.filter((r) => r.status !== 200).length;
    setMsg(failed ? `${people.length - failed} moved, ${failed} could not be moved.` : teamId === id ? `Added ${people.map((p) => p.name).join(', ')}.` : `Removed ${people[0]?.name}.`);
    load(); reload();
  };

  return (
    <div className="space-y-8">
      <a href="#/teams" className="text-sm text-muted hover:text-ink">← Teams & Admins</a>
      <PageHead
        title={team.name}
        sub={team.leadNames.length ? `Led by ${team.leadNames.join(', ')}.` : 'No lead assigned yet. Add one from Teams & Admins.'}
        action={<button type="button" className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper" onClick={() => setAdding(true)}>Add members</button>}
      />
      {msg && <p role="status" className="text-sm text-muted">{msg}</p>}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card title={view ? `Members (${members.length})` : 'Members'}>
          {failed ? (
            <p role="alert" className="text-sm text-limit">
              Couldn’t load this team’s members. <button type="button" className="font-medium underline" onClick={load}>Try again</button>
            </p>
          ) : !view ? <p role="status" className="text-sm text-muted">Loading members…</p> : members.length ? (
            <table className="w-full text-sm">
              <thead className="border-b border-rule"><tr><Th>Person</Th><Th>Claude account</Th><Th>Added</Th><Th /></tr></thead>
              <tbody className="divide-y divide-rule">
                {members.map((p) => {
                  const labels = [...new Set((view?.installations ?? []).filter((d) => d.personId === p.id && !d.revoked).map((d) => d.accountLabel ?? 'Not reported yet'))];
                  return (
                    <tr key={p.id}>
                      <td className="px-3 py-2.5"><button className="font-medium hover:underline" onClick={() => go(`/people/${p.id}`)}>{p.name}</button></td>
                      <td className="px-3 text-muted">{labels.join(', ') || 'No device yet'}</td>
                      <td className="px-3 text-muted">{ago(p.createdAt)}</td>
                      <td className="px-3 text-right">
                        <RowMenu label={`Actions for ${p.name}`} items={[
                          ...data.teams.filter((t) => t.id !== id).map((t) => ({ label: `Move to ${t.name}`, onClick: () => move([p], t.id) })),
                          { label: 'Remove from team', danger: true, onClick: () => move([p], null) },
                        ]} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <p className="text-sm text-muted">No members yet. Add existing people, or invite someone new from People.</p>}
        </Card>
        <Card title="Claude accounts it owns" sub="Owned accounts show in this team’s dashboard and their alerts go to its leads. People from other teams may still use them.">
          {accounts.length ? (
            <ul className="divide-y divide-rule text-sm">
              {accounts.map((a) => (
                <li key={a.id} className="flex items-baseline justify-between gap-3 py-2">
                  <span className="font-medium">{a.label}</span>
                  <span className="text-xs text-muted">{a.devices.length} device{a.devices.length === 1 ? '' : 's'}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">None yet.</p>}
          <button type="button" className="mt-3 text-sm text-muted hover:text-ink" onClick={() => go('/accounts')}>Manage accounts</button>
        </Card>
      </div>
      {adding && (
        <AddMembersModal team={team} teams={data.teams} people={everyone.filter((p) => p.teamId !== id)}
          onClose={() => setAdding(false)} onAdd={async (ps) => { setAdding(false); await move(ps, id); }} />
      )}
    </div>
  );
}

function AddMembersModal({ team, teams, people, onClose, onAdd }: {
  team: Team; teams: Team[]; people: Person[]; onClose: () => void; onAdd: (p: Person[]) => void;
}) {
  const [picked, setPicked] = useState<number[]>([]);
  const [q, setQ] = useState('');
  const teamName = (tid: number | null) => (tid === null ? 'No team' : teams.find((t) => t.id === tid)?.name ?? 'Another team');
  const shown = people.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => Number(a.teamId !== null) - Number(b.teamId !== null) || a.name.localeCompare(b.name)); // unassigned first
  const toggle = (id: number) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  return (
    <Modal open onClose={onClose} title={`Add people to ${team.name}`} sub="Moving someone who is already in a team takes them out of it. Their usage history moves with them.">
      <input type="search" aria-label="Search people" placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)}
        className="mb-3 w-full rounded-md border border-rule bg-paper px-3 py-2 text-sm" />
      {shown.length ? (
        <ul className="max-h-80 divide-y divide-rule overflow-y-auto text-sm">
          {shown.map((p) => (
            <li key={p.id}>
              <label className="flex cursor-pointer items-center gap-3 py-2">
                <input type="checkbox" checked={picked.includes(p.id)} onChange={() => toggle(p.id)} className="size-4 accent-[var(--fill)]" />
                <span className="flex-1 font-medium">{p.name}</span>
                <span className={`text-xs ${p.teamId === null ? 'text-muted' : 'text-ahead'}`}>{teamName(p.teamId)}</span>
              </label>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted">Everyone is already in this team.</p>}
      <div className="flex justify-end gap-2 pt-4">
        <button type="button" onClick={onClose} className="rounded-md border border-rule px-3.5 py-2 text-sm text-muted hover:bg-band">Cancel</button>
        <button type="button" disabled={!picked.length} onClick={() => onAdd(people.filter((p) => picked.includes(p.id)))}
          className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper disabled:opacity-50">
          Add {picked.length || ''} {picked.length === 1 ? 'person' : 'people'}
        </button>
      </div>
    </Modal>
  );
}
