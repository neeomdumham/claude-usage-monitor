import { useState } from 'react';
import { ago, call, installCommand, inviteLink, until, type Installation, type Person } from './lib.ts';

function status(i: Installation) {
  if (i.revoked) return { text: 'Removed', cls: 'text-muted' };
  if (!i.lastHeartbeatAt) return { text: 'Joined, waiting for its first session', cls: 'text-ahead' };
  const quiet = Date.now() - Date.parse(i.lastHeartbeatAt) > 24 * 3600_000;
  return quiet
    ? { text: `Quiet, last session ${ago(i.lastHeartbeatAt)}`, cls: 'text-muted' }
    : { text: `Active, last session ${ago(i.lastHeartbeatAt)}`, cls: 'text-fill' };
}

type Invite = { personId: number; name: string; token: string; expiresAt: string; maxUses: number };

export function People({ people, devices, onChange }: { people: Person[]; devices: Installation[]; onChange: () => void }) {
  const [invite, setInvite] = useState<Invite | null>(null);
  const legacy = devices.filter((d) => d.personId === null);

  const sendLink = async (p: Person) => {
    const r = await call('/api/dashboard/invites', 'POST', { personId: p.id });
    if (r.status === 200) { setInvite({ ...r.data, name: p.name }); onChange(); }
  };

  return (
    <section aria-labelledby="people" className="py-12">
      <h2 id="people" className="text-2xl font-semibold">People</h2>
      <p className="mt-1 max-w-[62ch] text-sm text-muted">
        Teammates never open this dashboard. You send each one a link; their Claude Code joins with it and
        shows up here, device by device.
      </p>

      {invite && <InviteCard invite={invite} onClose={() => setInvite(null)} />}

      {people.length > 0 && (
        <ul className="mt-8 divide-y divide-rule border-y border-rule">
          {people.map((p) => (
            <PersonRow key={p.id} p={p} devices={devices.filter((d) => d.personId === p.id)} onChange={onChange} onSendLink={() => sendLink(p)} />
          ))}
        </ul>
      )}

      {legacy.length > 0 && (
        <div className="mt-8">
          <h3 className="font-medium">Devices from before invites</h3>
          <ul className="mt-2 divide-y divide-rule border-y border-rule">
            {legacy.map((d) => <li key={d.id} className="py-3"><DeviceLine d={d} onChange={onChange} /></li>)}
          </ul>
        </div>
      )}

      <InviteForm first={people.length === 0} onCreated={(i) => { setInvite(i); onChange(); }} />
    </section>
  );
}

function PersonRow({ p, devices, onChange, onSendLink }: {
  p: Person; devices: Installation[]; onChange: () => void; onSendLink: () => void;
}) {
  const inv = p.openInvite;
  return (
    <li className="py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="text-lg font-medium">{p.name}</h3>
        <div className="flex gap-4 text-sm text-muted">
          {inv && (
            <button className="hover:text-ink" onClick={async () => { await call(`/api/dashboard/people/${p.id}/invites`, 'DELETE'); onChange(); }}>
              Cancel link
            </button>
          )}
          <button className="hover:text-ink" onClick={onSendLink}>{devices.length ? 'New link for another device' : 'New link'}</button>
        </div>
      </div>
      {inv && (
        <p className="mt-1 text-sm text-ahead">
          Link sent: {inv.uses} of {inv.maxUses} devices joined, works for {until(Date.parse(inv.expiresAt) / 1000)} more.
        </p>
      )}
      {devices.length === 0 && !inv && <p className="mt-1 text-sm text-muted">No device yet and no open link.</p>}
      {devices.length > 0 && (
        <ul className="mt-3 space-y-3 border-l-2 border-rule pl-4">
          {devices.map((d) => <li key={d.id}><DeviceLine d={d} onChange={onChange} /></li>)}
        </ul>
      )}
    </li>
  );
}

function DeviceLine({ d, onChange }: { d: Installation; onChange: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const s = status(d);
  const setRevoked = async (revoked: boolean) => {
    await call(`/api/dashboard/installations/${d.id}`, 'PATCH', { revoked });
    setConfirming(false);
    onChange();
  };
  const joined = [d.os, `joined ${ago(d.joinedAt)}`, d.joinedIp && `from ${d.joinedIp}`].filter(Boolean).join(', ');
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className={`font-medium ${d.revoked ? 'text-muted line-through' : ''}`}>{d.name}</p>
        <p className="text-sm text-muted">{joined}</p>
        <p className={`text-sm ${s.cls}`}>{s.text}</p>
      </div>
      {confirming ? (
        <div className="flex items-center gap-3 text-sm">
          <span>Stop accepting data from {d.name}?</span>
          <button className="rounded-md bg-limit px-3 py-1 text-paper" onClick={() => setRevoked(true)}>Remove device</button>
          <button className="text-muted" onClick={() => setConfirming(false)}>Keep</button>
        </div>
      ) : d.revoked ? (
        <button className="text-sm text-muted hover:text-ink" onClick={() => setRevoked(false)}>Restore device</button>
      ) : (
        <button className="text-sm text-muted hover:text-ink" onClick={() => setConfirming(true)}>Remove</button>
      )}
    </div>
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

function InviteForm({ first, onCreated }: { first: boolean; onCreated: (i: Invite) => void }) {
  const [open, setOpen] = useState(first);
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

function InviteCard({ invite, onClose }: { invite: Invite; onClose: () => void }) {
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
