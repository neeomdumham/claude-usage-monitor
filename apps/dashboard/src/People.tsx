import { useState } from 'react';
import { call, installCommand, inviteLink, type Person } from './lib.ts';

export type Invite = { personId: number; name: string; token: string; expiresAt: string; maxUses: number };

export function PersonName({ p, onChange, title = false }: { p: Person; onChange: () => void; title?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(p.name);
  if (!editing) {
    return (
      <div className="flex items-baseline gap-3">
        {title ? <h1 className="text-2xl font-semibold">{p.name}</h1> : <h3 className="text-lg font-medium">{p.name}</h3>}
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

/** Commit emails that count as this person in the GitLab commit sync. */
export function GitEmails({ p, onChange }: { p: Person; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(p.gitEmails.join(', '));
  const [error, setError] = useState('');
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
    <div className="mt-2 flex items-center justify-between gap-3 rounded-md bg-band px-3 py-2">
      <code className="overflow-x-auto text-sm whitespace-nowrap" aria-label={label}>{text}</code>
      <button
        className="shrink-0 text-xs font-medium text-muted hover:text-ink"
        onClick={async () => { await navigator.clipboard.writeText(text).catch(() => {}); setDone(true); setTimeout(() => setDone(false), 1500); }}
      >
        {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function InviteForm({ first, startOpen = first, onCreated }: { first: boolean; startOpen?: boolean; onCreated: (i: Invite) => void }) {
  const [open, setOpen] = useState(startOpen);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  if (!open) {
    return <button className="mt-6 rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper" onClick={() => setOpen(true)}>Invite a teammate</button>;
  }
  const create = async () => {
    setError('');
    const r = await call('/api/dashboard/invites', 'POST', { name });
    if (r.status !== 200) return setError('Enter the teammate’s name first.');
    onCreated({ ...r.data, name });
    setName('');
    if (!first) setOpen(false);
  };
  return (
    <form className="mt-8 rounded-lg border border-rule p-6" onSubmit={(e) => { e.preventDefault(); create(); }}>
      <h3 className="text-lg font-semibold">Invite a teammate</h3>
      <p className="mt-1 max-w-[62ch] text-sm text-muted">
        You get a link to send them. It works on up to two of their devices for 72 hours, and they keep using their own setup token.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          aria-label="Teammate’s name" placeholder="e.g. Rafi" value={name} maxLength={60} autoFocus={!first}
          onChange={(e) => setName(e.target.value)} className="w-64 rounded-md border border-rule bg-paper px-3 py-1.5"
        />
        <button className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-paper">Create link</button>
        {!first && <button type="button" className="text-sm text-muted" onClick={() => setOpen(false)}>Cancel</button>}
        {error && <span className="text-sm text-limit">{error}</span>}
      </div>
    </form>
  );
}

export function InviteCard({ invite, onClose }: { invite: Invite; onClose: () => void }) {
  const link = inviteLink(invite.token);
  return (
    <div className="mt-8 rounded-lg border-2 border-fill p-6" role="status">
      <h3 className="text-lg font-semibold">Send this to {invite.name}</h3>
      <p className="mt-1 max-w-[62ch] text-sm text-muted">
        This is the only time the link is shown. It works on {invite.maxUses} devices until{' '}
        {new Date(invite.expiresAt).toLocaleString()}. Making a new one cancels it.
      </p>
      <p className="mt-5 font-medium">One line in their terminal, then restart Claude Code</p>
      <Copy text={installCommand(link)} label="Install command" />
      <p className="mt-5 font-medium">Or just the link, if they install from /plugin and paste it when asked</p>
      <Copy text={link} label="Invite link" />
      <button className="mt-5 text-sm text-muted hover:text-ink" onClick={onClose}>Done</button>
    </div>
  );
}
