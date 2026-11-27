import { useEffect, useState } from 'react';
import { call, installCommand, inviteLink, type AccountCard, type Person, type Team } from './lib.ts';
import { Modal } from './ui.tsx';

export type Invite = {
  personId: number;
  name: string;
  token: string;
  expiresAt: string;
  maxUses: number;
  installationId?: number;
  deviceName?: string;
};

export function PersonName({ p, onChange, title = false }: { p: Person; onChange: () => void; title?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(p.name);
  if (!editing) {
    return (
      <div className="flex items-baseline gap-3">
        {title ? <h1 className="text-2xl font-semibold tracking-[-0.02em]">{p.name}</h1> : <h3 className="text-lg font-medium">{p.name}</h3>}
        <button className="text-xs text-muted hover:text-ink hover:underline" onClick={() => setEditing(true)}>Rename</button>
      </div>
    );
  }
  return (
    <form className="flex items-center gap-2" onSubmit={async (e) => {
      e.preventDefault();
      await call(`/api/dashboard/people/${p.id}`, 'PATCH', { name: value });
      setEditing(false); onChange();
    }}>
      <input autoFocus aria-label="Name" value={value} maxLength={60} onChange={(e) => setValue(e.target.value)}
        className="rounded-md border border-rule bg-paper px-2 py-1" />
      <button className="rounded-md bg-ink px-3 py-1 text-sm text-paper">Save name</button>
      <button type="button" className="text-sm text-muted" onClick={() => setEditing(false)}>Cancel</button>
    </form>
  );
}

/** Commit emails that count as this person in the GitLab/GitHub commit sync. */
export function GitEmails({ p, onChange }: { p: Person; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(p.gitEmails.join(', '));
  const [error, setError] = useState('');
  useEffect(() => { setValue(p.gitEmails.join(', ')); }, [p.gitEmails]);
  if (!editing) {
    return (
      <p className="mt-1 text-sm text-muted">
        Commit emails: {p.gitEmails.length ? p.gitEmails.join(', ') : 'none yet'}{' '}
        <button className="text-xs hover:text-ink hover:underline" onClick={() => setEditing(true)}>Edit</button>
      </p>
    );
  }
  return (
    <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={async (e) => {
      e.preventDefault();
      const emails = value.split(/[\s,]+/).filter(Boolean);
      const r = await call(`/api/dashboard/people/${p.id}/git-emails`, 'PUT', { emails });
      if (r.status !== 200) return setError('Use valid email addresses, separated by commas.');
      setEditing(false); setError(''); onChange();
    }}>
      <input autoFocus aria-label={`Commit emails for ${p.name}`} value={value} onChange={(e) => setValue(e.target.value)}
        placeholder="rafi@company.com, 123+rafi@users.noreply.github.com" className="w-96 max-w-full rounded-md border border-rule bg-paper px-2 py-1 text-sm" />
      <button className="rounded-md bg-ink px-3 py-1 text-sm text-paper">Save emails</button>
      <button type="button" className="text-sm text-muted" onClick={() => setEditing(false)}>Cancel</button>
      {error && <span className="text-sm text-limit">{error}</span>}
    </form>
  );
}

export function Copy({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="mt-2 flex items-center justify-between gap-3 rounded-md border border-rule bg-band px-3 py-2">
      <code tabIndex={0} className="overflow-x-auto text-sm whitespace-nowrap" aria-label={label}>{text}</code>
      <button
        type="button"
        className="shrink-0 text-xs font-medium text-muted hover:text-ink"
        onClick={async () => { await navigator.clipboard.writeText(text).catch(() => {}); setDone(true); setTimeout(() => setDone(false), 1500); }}
      >
        {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** Modal dialog for inviting a new teammate or displaying a freshly generated device invite link. */
export function InviteModal({ open, onClose, invite, onCreated, teams = [], accounts = [], defaultTeamId = null, requireTeam = false }: {
  open: boolean;
  onClose: () => void;
  invite: Invite | null;
  onCreated: (i: Invite) => void;
  teams?: Team[];
  accounts?: AccountCard[];
  defaultTeamId?: number | null;
  requireTeam?: boolean;
}) {
  const [name, setName] = useState('');
  const [teamId, setTeamId] = useState<string>(defaultTeamId ? String(defaultTeamId) : (requireTeam && teams[0] ? String(teams[0].id) : ''));
  const [accountId, setAccountId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const named = accounts.filter((a) => a.id !== null);

  useEffect(() => {
    if (open && !invite) {
      setName('');
      setAccountId('');
      setError('');
      setTeamId(defaultTeamId ? String(defaultTeamId) : (requireTeam && teams[0] ? String(teams[0].id) : ''));
    }
  }, [open, invite, defaultTeamId, requireTeam, teams]);

  const create = async () => {
    setError('');
    if (!name.trim()) return setError('Enter the teammate’s name first.');
    if (requireTeam && !teamId) return setError('Pick a team for this teammate.');
    setBusy(true);
    const payload: Record<string, unknown> = { name: name.trim() };
    if (teamId) payload.teamId = Number(teamId);
    if (accountId) payload.accountId = Number(accountId);
    const r = await call('/api/dashboard/invites', 'POST', payload);
    setBusy(false);
    if (r.status !== 200) return setError(r.data?.error ?? 'Could not create invite link.');
    onCreated({ ...r.data, name: name.trim() });
    setName('');
  };

  if (invite) {
    const link = inviteLink(invite.token);
    const isReconnect = Boolean(invite.installationId);
    return (
      <Modal
        open={open}
        onClose={onClose}
        title={isReconnect ? `Reconnect ${invite.deviceName ?? 'device'} (${invite.name})` : `Send this to ${invite.name}`}
        sub={isReconnect
          ? `Shown once. Single-use link valid until ${new Date(invite.expiresAt).toLocaleString()}. Refreshes this device’s token in place (same device ID and full history, no duplicate device).`
          : `Shown once. Works on up to ${invite.maxUses} devices until ${new Date(invite.expiresAt).toLocaleString()}. Creating a new link cancels this one.`}
      >
        <div role="status">
          <p className="text-sm font-medium">One line in their terminal, then restart Claude Code</p>
          <Copy text={installCommand(link)} label="Install command" />
          <p className="mt-5 text-sm font-medium">Or just the link, if they install from /plugin and paste it when asked</p>
          <Copy text={link} label="Invite link" />
          <div className="mt-6 flex justify-end">
            <button type="button" className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper" onClick={onClose}>Done</button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Invite a teammate"
      sub="Generate a one-time link valid for 72 hours across up to 2 devices. Teammates keep using the Claude setup token or login they already have."
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create(); }}>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Teammate’s name
          <input
            aria-label="Teammate’s name"
            placeholder="e.g. Rafi"
            value={name}
            maxLength={60}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-rule bg-paper px-3 py-2 text-sm font-normal"
          />
        </label>
        {teams.length > 0 && (
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Team
            <select
              aria-label="Team"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              className="w-full rounded-md border border-rule bg-paper px-3 py-2 text-sm font-normal"
            >
              {!requireTeam && <option value="">Unassigned</option>}
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        )}
        {named.length > 0 && (
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Claude account they’ll use
            <select
              aria-label="Claude account"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="w-full rounded-md border border-rule bg-paper px-3 py-2 text-sm font-normal"
            >
              <option value="">Detect it from their first request</option>
              {named.map((a) => <option key={a.id} value={a.id!}>{a.label}{a.teamName ? ` (${a.teamName})` : ''}</option>)}
            </select>
            <span className="text-xs font-normal text-muted">Optional. The device reports its account either way; picking one files it under that name instead of a new unlabeled account.</span>
          </label>
        )}
        {error && <p className="text-sm text-limit">{error}</p>}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" className="rounded-md border border-rule px-3.5 py-2 text-sm text-muted hover:bg-band hover:text-ink" onClick={onClose}>Cancel</button>
          <button disabled={busy} className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper disabled:opacity-50">{busy ? 'Creating…' : 'Create link'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Kept as a lightweight wrapper for places that only need the result view. */
export function InviteCard({ invite, onClose }: { invite: Invite; onClose: () => void }) {
  return <InviteModal open invite={invite} onClose={onClose} onCreated={() => {}} />;
}
