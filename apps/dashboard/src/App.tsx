import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ago, call, type Meter as M, type Overview, type PolicyData } from './lib.ts';
import { Meter } from './Meter.tsx';
import { Workload } from './Workload.tsx';
import { Devices } from './Devices.tsx';

const column = 'mx-auto w-full max-w-[920px] px-4 sm:px-8';
const ORDER = ['seven_day', 'five_hour'];
const rank = (m: M) => (ORDER.includes(m.meterKey) ? ORDER.indexOf(m.meterKey) : ORDER.length);

export function App() {
  const [data, setData] = useState<Overview | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [win, setWin] = useState('seven_day');
  const [loadedAt, setLoadedAt] = useState(Date.now());
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    const r = await call<Overview>(`/api/dashboard/overview?window=${win}`);
    if (r.status === 401) return setAuthed(false);
    setAuthed(true);
    setData(r.data);
    setLoadedAt(Date.now());
  }, [win]);

  useEffect(() => {
    load();
    const poll = setInterval(load, 30_000);
    const clock = setInterval(() => tick((n) => n + 1), 30_000); // keeps countdowns honest between polls
    return () => { clearInterval(poll); clearInterval(clock); };
  }, [load]);

  if (authed === false) return <Login onDone={load} />;
  if (!data) return <p className={`${column} py-16 text-muted`}>Loading…</p>;

  const tz = data.policy.data.displayTimezone;
  const meters = [...data.meters].sort((a, b) => rank(a) - rank(b));
  const [hero, ...rest] = meters;

  return (
    <div className="min-h-screen">
      <header className={`${column} flex flex-wrap items-baseline justify-between gap-3 py-6`}>
        <div>
          <h1 className="text-xl font-semibold">Claude usage</h1>
          <p className="text-sm text-muted">One Team seat, every token that draws on it.</p>
        </div>
        <div className="flex items-baseline gap-4 text-sm text-muted">
          <span>Updated {ago(new Date(loadedAt).toISOString())}, times in {tz.replace('_', ' ')}</span>
          <button className="hover:text-ink" onClick={async () => { await call('/api/auth/logout', 'POST'); setAuthed(false); }}>Sign out</button>
        </div>
      </header>

      <main>
        <section aria-label="Account allowance" className="bg-band">
          <div className={`${column} py-10 sm:py-14`}>
            {hero ? <Meter m={hero} tz={tz} hero /> : <NoReadings />}
          </div>
        </section>

        <div className={column}>
          {rest.length > 0 && (
            <div className="divide-y divide-rule border-b border-rule">
              {rest.map((m) => <Meter key={m.meterKey} m={m} tz={tz} />)}
            </div>
          )}
          {data.installations.length === 0 ? (
            // First run: the only useful thing to do is add a device.
            <Devices devices={data.installations} onChange={load} />
          ) : (
            <>
              <ManualReading meters={meters} onDone={load} />
              <Workload rows={data.ranking} win={win} onWin={setWin} onChange={load} />
              <Devices devices={data.installations} onChange={load} />
            </>
          )}
          <Settings policy={data.policy.data} revision={data.policy.revision} onDone={load} />
        </div>
      </main>
    </div>
  );
}

function NoReadings() {
  return (
    <div className="max-w-[60ch]">
      <h2 className="text-lg font-medium">No allowance reading yet</h2>
      <p className="mt-2 text-muted">
        Readings arrive when an enrolled device finishes a Claude Code response. Add a device below, or enter
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
  const [msg, setMsg] = useState('');
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await call('/api/dashboard/policy', 'PATCH', {
      freshnessThresholdSec: Number(staleMin) * 60, retentionDays: Number(days), displayTimezone: tz,
    });
    setMsg(r.status === 200 ? 'Settings saved.' : 'Not saved: stale-after is 1 to 1440 minutes, history is 1 to 365 days.');
    if (r.status === 200) onDone();
  };
  const field = 'rounded-md border border-rule bg-paper px-3 py-1.5';
  return (
    <details className="border-t border-rule py-8">
      <summary className="cursor-pointer text-lg font-semibold">Settings</summary>
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
