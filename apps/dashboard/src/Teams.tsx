// Superadmin page for managing teams/departments and dashboard admins (superadmins + team leads).
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Go } from './Home.tsx';
import { ago, call, type AdminUser, type Overview, type Team } from './lib.ts';
import { Card, Modal, PageHead, Pill, RowMenu, Th } from './ui.tsx';

export function TeamsPage({ data, go, onSelectTeam, reload }: {
  data: Overview; go: Go; onSelectTeam: (teamId: string) => void; reload: () => void;
}) {
  const [teams, setTeams] = useState<Team[]>(data.teams);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [teamModal, setTeamModal] = useState<{ mode: 'create' | 'edit'; team?: Team } | null>(null);
  const [userModal, setUserModal] = useState<{ mode: 'create' | 'edit'; user?: AdminUser } | null>(null);
  const [confirmDeleteTeam, setConfirmDeleteTeam] = useState<Team | null>(null);
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
                    <button type="button" className="hover:underline" onClick={() => { onSelectTeam(String(t.id)); go('/dashboard'); }}>
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
                      { label: 'View team dashboard', onClick: () => { onSelectTeam(String(t.id)); go('/dashboard'); } },
                      { label: 'Edit name & namespaces', onClick: () => setTeamModal({ mode: 'edit', team: t }) },
                      { label: 'Delete team', danger: true, onClick: () => setConfirmDeleteTeam(t) },
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
        sub="Superadmins manage all teams and global settings. Team leads see the seat's allowance meters and strictly their assigned team(s)."
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
                        { label: 'Edit role, teams or password', onClick: () => setUserModal({ mode: 'edit', user: u }) },
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
        sub="Teammates in this team will become unassigned (their usage history is kept)."
      >
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => setConfirmDeleteTeam(null)} className="rounded-md border border-rule px-3.5 py-2 text-sm text-muted hover:bg-band">Cancel</button>
          <button type="button" onClick={async () => {
            if (!confirmDeleteTeam) return;
            await call(`/api/dashboard/teams/${confirmDeleteTeam.id}`, 'DELETE');
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
    if (mode === 'create' && (!email.trim() || password.length < 8)) {
      return setError('Valid email and password (8+ characters) are required.');
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
        {mode === 'create' && (
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="shamim@company.com"
              className="rounded-md border border-rule bg-paper px-3 py-2 text-sm font-normal" />
          </label>
        )}
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
