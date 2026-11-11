import { useState } from 'react';
import { call, compact, type Row } from './lib.ts';

const WINDOWS = [
  { key: 'five_hour', label: 'Current session' },
  { key: 'seven_day', label: 'This week' },
];

function rowName(r: Row) {
  if (r.credentialId !== null) return r.label ?? `Token ${r.fingerprintPrefix}`;
  return r.installationName ? `${r.installationName}'s token` : 'Unidentified token';
}

export function Workload({ rows, win, onWin, onChange }: {
  rows: Row[] | null; win: string; onWin: (w: string) => void; onChange: () => void;
}) {
  const total = rows?.reduce((s, r) => s + r.estCostUsd, 0) ?? 0;
  const share = (r: Row) => (total > 0 ? r.estCostUsd / total : rows!.length ? r.requests / rows!.reduce((s, x) => s + x.requests, 0) : 0);

  return (
    <section aria-labelledby="workload" className="py-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 id="workload" className="text-2xl font-semibold">Who's using it</h2>
          <p className="mt-1 max-w-[60ch] text-sm text-muted">
            Each token's share of the work measured in this window. Claude doesn't report how much of the
            allowance each token used, so shares here are of measured work, not of the allowance.
          </p>
        </div>
        <div role="radiogroup" aria-label="Window" className="flex rounded-md bg-band p-1 text-sm">
          {WINDOWS.map((w) => (
            <button
              key={w.key} role="radio" aria-checked={win === w.key} onClick={() => onWin(w.key)}
              className={`rounded px-3 py-1.5 ${win === w.key ? 'bg-paper font-medium shadow-[0_0_0_1px_var(--rule)]' : 'text-muted hover:text-ink'}`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {rows === null ? (
        <p className="mt-8 text-sm text-muted">
          No current reading for this window yet, so its start and end are unknown. Usage appears here once a device reports the window.
        </p>
      ) : rows.length === 0 ? (
        <p className="mt-8 text-sm text-muted">No measured requests in this window.</p>
      ) : (
        <ol className="mt-8 space-y-7">
          {rows.map((r) => {
            const s = share(r);
            return (
              <li key={`${r.credentialId}-${r.installationId}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                  <Name row={r} onChange={onChange} />
                  <p className="text-sm"><span className="reading text-3xl">{Math.round(s * 100)}%</span> <span className="text-muted">of measured work</span></p>
                </div>
                <div className="mt-2 h-1.5 rounded-[2px] bg-track" aria-hidden>
                  <div className="fill-in h-full rounded-[2px] bg-fill" style={{ width: `${s * 100}%` }} />
                </div>
                <p className="mt-2 text-sm text-muted">
                  {r.requests.toLocaleString()} requests, {compact(r.outputTokens)} output and {compact(r.inputTokens + r.cacheCreationTokens)} input tokens,
                  {' '}{compact(r.cacheReadTokens)} cache reads. ${r.estCostUsd.toFixed(2)} at API prices.
                  <span className="ml-1">Allowance share: not reported.</span>
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function Name({ row, onChange }: { row: Row; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.label ?? '');
  const isDevice = row.credentialId === null && row.installationId !== null;
  if (row.credentialId === null && !isDevice) return <h3 className="text-lg font-medium text-muted">Unidentified token</h3>;

  if (!editing) {
    return (
      <div className="flex items-baseline gap-3">
        <h3 className="text-lg font-medium">{rowName(row)}</h3>
        {row.label && row.fingerprintPrefix && <span className="text-xs text-muted">token {row.fingerprintPrefix}</span>}
        <button className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => setEditing(true)}>
          Rename
        </button>
      </div>
    );
  }
  const save = async () => {
    if (isDevice) await call(`/api/dashboard/installations/${row.installationId}`, 'PATCH', { name: value });
    else await call(`/api/dashboard/credentials/${row.credentialId}`, 'PATCH', { label: value });
    setEditing(false);
    onChange();
  };
  return (
    <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <input
        autoFocus aria-label={isDevice ? 'Device name' : 'Token name'} value={value} maxLength={60}
        onChange={(e) => setValue(e.target.value)} placeholder={isDevice ? 'Device name' : 'e.g. Rafi'}
        className="rounded-md border border-rule bg-paper px-2 py-1 text-base"
      />
      <button className="rounded-md bg-ink px-3 py-1 text-sm text-paper">Save name</button>
      <button type="button" className="text-sm text-muted" onClick={() => setEditing(false)}>Cancel</button>
    </form>
  );
}
