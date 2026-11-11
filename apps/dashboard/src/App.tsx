import { useCallback, useEffect, useState, type FormEvent } from 'react';

type Meter = {
  meterKey: string; label: string | null; usedPercentage: number; resetsAt: number;
  observedAt: string; source: string; expired: boolean; stale: boolean;
};
type Row = {
  credentialId: number | null; label: string | null; fingerprintPrefix: string | null; requests: number;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number;
  estCostUsd: number; quotaContribution: null;
};
type Installation = {
  id: number; name: string; lastHeartbeatAt: string | null; appliedPolicyRevision: number | null;
  queueDepth: number; droppedCount: number; revoked: boolean; capabilities: Record<string, boolean>;
};
type Overview = {
  policy: { revision: number; data: { displayTimezone: string; heartbeatIntervalSec: number } };
  meters: Meter[]; window: string; ranking: Row[] | null; installations: Installation[];
};

const METER_LABELS: Record<string, string> = { five_hour: 'Current session', seven_day: 'Weekly · all models' };
const fmtTokens = (n: number) => Intl.NumberFormat('en', { notation: 'compact' }).format(n);
const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};
const countdown = (epoch: number) => {
  const s = Math.max(0, epoch - Date.now() / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : `${h}h ${m}m`;
};

async function call(path: string, method = 'GET', body?: unknown) {
  const res = await fetch(path, {
    method, headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const card = 'rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900';
const input = 'rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700';
const button = 'rounded-md bg-neutral-900 px-3 py-1 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900';

export function App() {
  const [data, setData] = useState<Overview | null>(null);
  const [authed, setAuthed] = useState(true);
  const [win, setWin] = useState('seven_day');

  const load = useCallback(async () => {
    const r = await call(`/api/dashboard/overview?window=${win}`);
    if (r.status === 401) return setAuthed(false);
    setAuthed(true);
    setData(r.data);
  }, [win]);

  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  if (!authed) return <Login onDone={load} />;
  if (!data) return <p className="p-8 text-sm">Loading…</p>;
  const tz = data.policy.data.displayTimezone;
  const fmtReset = (epoch: number) =>
    new Intl.DateTimeFormat('en', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(epoch * 1000);

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Claude usage</h1>
        <span className="text-xs text-neutral-500">times in {tz}</span>
      </header>

      <section className={card}>
        <h2 className="mb-4 font-medium">Account allowance</h2>
        {data.meters.length === 0 && <p className="text-sm text-neutral-500">No reading yet. Unavailable until a source reports.</p>}
        <div className="space-y-5">
          {data.meters.map((m) => (
            <div key={m.meterKey}>
              <div className="flex justify-between text-sm">
                <span>{m.label ?? METER_LABELS[m.meterKey] ?? m.meterKey}</span>
                <span>{m.expired ? 'window reset, awaiting reading' : `${m.usedPercentage}% used`}</span>
              </div>
              <div className="mt-1 h-2 rounded-full bg-neutral-200 dark:bg-neutral-800">
                {!m.expired && <div className="h-2 rounded-full bg-blue-600" style={{ width: `${m.usedPercentage}%` }} />}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-neutral-500">
                <span>resets {fmtReset(m.resetsAt)} (in {countdown(m.resetsAt)})</span>
                <span>source: {m.source}</span>
                <span>observed {ago(m.observedAt)}</span>
                {m.stale && <span className="text-amber-600">stale</span>}
                {m.source === 'manual' && <span className="text-amber-600">manual</span>}
              </div>
            </div>
          ))}
        </div>
        <ManualSnapshot onDone={load} />
      </section>

      <section className={card}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium">Credential workload</h2>
          <select className={input} value={win} onChange={(e) => setWin(e.target.value)}>
            <option value="five_hour">Current session window</option>
            <option value="seven_day">Weekly window</option>
          </select>
        </div>
        <p className="mb-3 text-xs text-neutral-500">
          Measured requests and tokens. Est. cost is API list price, not your subscription allowance.
          No upstream source reports per-credential quota, so contribution stays unavailable.
        </p>
        {data.ranking === null ? (
          <p className="text-sm text-neutral-500">Window boundary unknown: no current reading for this window.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-neutral-500">
                <tr><th className="py-1">Credential</th><th>Requests</th><th>Output</th><th>Input</th><th>Cache read</th><th>Est. cost</th><th>Quota contribution</th></tr>
              </thead>
              <tbody>
                {data.ranking.map((r) => (
                  <tr key={r.credentialId ?? 'unknown'} className="border-t border-neutral-100 dark:border-neutral-800">
                    <td className="py-1.5">
                      {r.credentialId === null ? <span className="text-neutral-500">Unknown auth</span>
                        : <CredentialLabel row={r} onDone={load} />}
                    </td>
                    <td>{r.requests}</td><td>{fmtTokens(r.outputTokens)}</td><td>{fmtTokens(r.inputTokens)}</td>
                    <td>{fmtTokens(r.cacheReadTokens)}</td><td>${r.estCostUsd.toFixed(2)}</td>
                    <td className="text-neutral-500">Unavailable</td>
                  </tr>
                ))}
                {data.ranking.length === 0 && <tr><td colSpan={7} className="py-2 text-neutral-500">No measured requests in this window.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={card}>
        <h2 className="mb-3 font-medium">Installations</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-neutral-500"><tr><th className="py-1">Name</th><th>Last seen</th><th>Policy rev</th><th>Queue</th><th>Dropped</th><th /></tr></thead>
          <tbody>
            {data.installations.map((i) => {
              const late = !i.lastHeartbeatAt || Date.now() - Date.parse(i.lastHeartbeatAt) > 3 * data.policy.data.heartbeatIntervalSec * 1000;
              return (
                <tr key={i.id} className="border-t border-neutral-100 dark:border-neutral-800">
                  <td className="py-1.5">{i.name}{i.revoked && <span className="ml-2 text-xs text-red-600">revoked</span>}</td>
                  <td className={late ? 'text-amber-600' : ''}>{i.lastHeartbeatAt ? ago(i.lastHeartbeatAt) : 'never'}</td>
                  <td>{i.appliedPolicyRevision ?? '–'}/{data.policy.revision}</td>
                  <td>{i.queueDepth}</td><td>{i.droppedCount}</td>
                  <td className="text-right">
                    <button className="text-xs underline" onClick={async () => { await call(`/api/dashboard/installations/${i.id}`, 'PATCH', { revoked: !i.revoked }); load(); }}>
                      {i.revoked ? 'restore' : 'revoke'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <Invite />
      </section>
    </main>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await call('/api/auth/login', 'POST', { password });
    if (r.status === 200) onDone(); else setError('Wrong password');
  };
  return (
    <form onSubmit={submit} className={`${card} mx-auto mt-24 max-w-xs space-y-3`}>
      <h1 className="font-medium">Owner login</h1>
      <input type="password" autoFocus className={`${input} w-full`} aria-label="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button className={button}>Sign in</button>
    </form>
  );
}

function CredentialLabel({ row, onDone }: { row: Row; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(row.label ?? '');
  if (!editing) {
    return (
      <button className="text-left" onClick={() => setEditing(true)} title="Rename">
        {row.label ?? <span className="text-neutral-500">unnamed</span>}
        <span className="ml-2 font-mono text-xs text-neutral-500">{row.fingerprintPrefix}</span>
      </button>
    );
  }
  return (
    <form className="flex gap-1" onSubmit={async (e) => { e.preventDefault(); await call(`/api/dashboard/credentials/${row.credentialId}`, 'PATCH', { label }); setEditing(false); onDone(); }}>
      <input className={input} autoFocus aria-label="Credential label" value={label} onChange={(e) => setLabel(e.target.value)} />
      <button className={button}>Save</button>
    </form>
  );
}

function ManualSnapshot({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ meterKey: 'seven_day_fable', label: 'Weekly · Fable', pct: '', resets: '' });
  const [error, setError] = useState('');
  if (!open) return <button className="mt-4 text-xs underline" onClick={() => setOpen(true)}>Enter a reading manually</button>;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await call('/api/dashboard/quota-snapshots', 'POST', {
      meterKey: f.meterKey, label: f.label || null, usedPercentage: Number(f.pct),
      resetsAt: Math.round(Date.parse(f.resets) / 1000), // datetime-local is in the browser's timezone
    });
    if (r.status !== 200) return setError('Check the values');
    setOpen(false); onDone();
  };
  return (
    <form onSubmit={submit} className="mt-4 flex flex-wrap items-end gap-2 text-sm">
      <label className="flex flex-col text-xs">Meter key<input className={input} value={f.meterKey} onChange={(e) => setF({ ...f, meterKey: e.target.value })} /></label>
      <label className="flex flex-col text-xs">Label<input className={input} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></label>
      <label className="flex flex-col text-xs">% used<input className={`${input} w-20`} type="number" min={0} max={100} required value={f.pct} onChange={(e) => setF({ ...f, pct: e.target.value })} /></label>
      <label className="flex flex-col text-xs">Resets at<input className={input} type="datetime-local" required value={f.resets} onChange={(e) => setF({ ...f, resets: e.target.value })} /></label>
      <button className={button}>Save</button>
      {error && <span className="text-red-600">{error}</span>}
    </form>
  );
}

function Invite() {
  const [name, setName] = useState('');
  const [result, setResult] = useState<{ code: string; expiresAt: string } | null>(null);
  return (
    <form className="mt-4 flex flex-wrap items-center gap-2 text-sm" onSubmit={async (e) => {
      e.preventDefault();
      const r = await call('/api/dashboard/invitations', 'POST', { name });
      if (r.status === 200) setResult(r.data);
    }}>
      <input className={input} placeholder="Installation name" aria-label="Installation name" required value={name} onChange={(e) => setName(e.target.value)} />
      <button className={button}>Create enrollment code</button>
      {result && <span className="font-mono text-xs">{result.code} <span className="text-neutral-500">(single use, expires in {Math.round((Date.parse(result.expiresAt) - Date.now()) / 60000)} min)</span></span>}
    </form>
  );
}
