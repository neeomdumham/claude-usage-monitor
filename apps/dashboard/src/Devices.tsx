import { useState } from 'react';
import { ago, call, type Installation } from './lib.ts';

// Keep in sync with plugin/.claude-plugin and the repo-root marketplace manifest.
export const MARKETPLACE_URL = 'https://gitlab.com/moeen-mahmud/claude-usage-monitor.git';
export const PLUGIN_REF = 'usage-monitor@usage-monitor-tools';

function status(i: Installation) {
  if (i.revoked) return { text: 'Removed', cls: 'text-muted' };
  if (!i.lastHeartbeatAt) return { text: 'Waiting for its first session', cls: 'text-ahead' };
  const quiet = Date.now() - Date.parse(i.lastHeartbeatAt) > 24 * 3600_000;
  return quiet
    ? { text: `Quiet, last session ${ago(i.lastHeartbeatAt)}`, cls: 'text-muted' }
    : { text: `Active, last session ${ago(i.lastHeartbeatAt)}`, cls: 'text-fill' };
}

export function Devices({ devices, onChange }: { devices: Installation[]; onChange: () => void }) {
  return (
    <section aria-labelledby="devices" className="py-12">
      <h2 id="devices" className="text-2xl font-semibold">Devices</h2>
      {devices.length === 0 ? (
        <p className="mt-2 max-w-[60ch] text-sm text-muted">
          No devices yet. Add the first one below; it starts reporting from its next Claude Code session.
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-rule border-y border-rule">
          {devices.map((d) => <DeviceRow key={d.id} d={d} onChange={onChange} />)}
        </ul>
      )}
      <AddDevice first={devices.length === 0} />
    </section>
  );
}

function DeviceRow({ d, onChange }: { d: Installation; onChange: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const s = status(d);
  const setRevoked = async (revoked: boolean) => {
    await call(`/api/dashboard/installations/${d.id}`, 'PATCH', { revoked });
    setConfirming(false);
    onChange();
  };
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-4">
      <div>
        <p className={`font-medium ${d.revoked ? 'text-muted line-through' : ''}`}>{d.name}</p>
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
    </li>
  );
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="mt-2 flex items-center justify-between gap-3 rounded-md bg-band px-3 py-2">
      <code className="overflow-x-auto text-sm whitespace-nowrap">{text}</code>
      <button
        className="shrink-0 text-xs font-medium text-muted hover:text-ink"
        onClick={async () => { await navigator.clipboard.writeText(text).catch(() => {}); setDone(true); setTimeout(() => setDone(false), 1500); }}
      >
        {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function AddDevice({ first }: { first: boolean }) {
  const [open, setOpen] = useState(first);
  const [name, setName] = useState('');
  const [invite, setInvite] = useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState('');

  if (!open) {
    return <button className="mt-6 rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper" onClick={() => setOpen(true)}>Add a device</button>;
  }

  const create = async () => {
    setError('');
    const r = await call('/api/dashboard/invitations', 'POST', { name });
    if (r.status === 200) setInvite(r.data);
    else setError('Give the device a name first.');
  };
  const minutes = invite ? Math.max(0, Math.round((Date.parse(invite.expiresAt) - Date.now()) / 60000)) : 0;

  return (
    <div className="mt-8 rounded-lg border border-rule p-6">
      <h3 className="text-lg font-semibold">Add a device</h3>
      <p className="mt-1 max-w-[62ch] text-sm text-muted">
        The person on that device keeps using their own setup token. Nothing else to configure: the plugin starts
        reporting from their next Claude Code session.
      </p>
      <ol className="mt-6 space-y-6">
        <li>
          <p className="font-medium">1. Name the device and create its code</p>
          <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); create(); }}>
            <input
              aria-label="Device name" placeholder="e.g. Rafi's MacBook" value={name} maxLength={60}
              onChange={(e) => setName(e.target.value)}
              className="w-64 rounded-md border border-rule bg-paper px-3 py-1.5"
            />
            <button className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-paper">Create code</button>
            {error && <span className="text-sm text-limit">{error}</span>}
          </form>
          {invite && (
            <div className="mt-3">
              <p className="text-sm">Code for {name}, works once for the next {minutes} min:</p>
              <Copy text={invite.code} />
            </div>
          )}
        </li>
        <li>
          <p className="font-medium">2. In Claude Code on that device, add the plugin</p>
          <Copy text={`/plugin marketplace add ${MARKETPLACE_URL}`} />
          <Copy text={`/plugin install ${PLUGIN_REF}`} />
        </li>
        <li>
          <p className="font-medium">3. Enter this server and the code when the plugin asks</p>
          <Copy text={window.location.origin} />
        </li>
        <li>
          <p className="font-medium">4. Restart Claude Code</p>
          <p className="mt-1 text-sm text-muted">The device shows up above after that first session, and its usage after the next one.</p>
        </li>
      </ol>
      {!first && <button className="mt-6 text-sm text-muted hover:text-ink" onClick={() => { setOpen(false); setInvite(null); }}>Done</button>}
    </div>
  );
}
