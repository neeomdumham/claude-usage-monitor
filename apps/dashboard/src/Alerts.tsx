// Alerts: every admin alert in scope, open and acknowledged, so nothing lives only in the banner.
import { useCallback, useEffect, useState } from 'react';
import { ago, call, type AdminAlert } from './lib.ts';
import { Card, Chips, PageHead, Pill } from './ui.tsx';

type Show = 'open' | 'done' | 'all';

export function AlertsPage({ teamId, openCount, onAck, onInspect }: {
  teamId: string; openCount: number; onAck: (id: number) => Promise<void>; onInspect: (a: AdminAlert) => void;
}) {
  const [rows, setRows] = useState<AdminAlert[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [show, setShow] = useState<Show>('open');
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    const q = new URLSearchParams({ includeAcknowledged: 'true', ...(teamId ? { teamId } : {}) });
    const r = await call<{ alerts: AdminAlert[] }>(`/api/dashboard/alerts?${q}`);
    if (r.status === 200) { setRows(r.data.alerts); setFailed(false); } else setFailed(true);
  }, [teamId]);
  // openCount changes when the banner acknowledges one, so this list follows it.
  useEffect(() => { load(); }, [load, openCount]);

  const ack = async (id: number) => { setBusy(id); try { await onAck(id); await load(); } finally { setBusy(null); } };
  const open = (rows ?? []).filter((a) => !a.acknowledgedAt);
  const done = (rows ?? []).filter((a) => a.acknowledgedAt);
  const list = show === 'open' ? open : show === 'done' ? done : rows ?? [];

  return (
    <div className="space-y-6">
      <PageHead title="Alerts"
        sub="Everything the monitor flagged for admins: new Claude accounts, disabled plugin hooks, guard blocks, unexplained 5-hour jumps and silent devices. Acknowledging hides an alert from the banner; it comes back if the same thing happens again." />
      <Chips label="Show" value={show} onChange={setShow}
        options={[['open', 'Open', open.length], ['done', 'Acknowledged', done.length], ['all', 'All', rows?.length ?? 0]]} />
      <Card>
        {!rows && !failed && <p role="status" className="py-6 text-center text-sm text-muted">Loading alerts…</p>}
        {failed && (
          <p role="alert" className="py-6 text-center text-sm text-limit">
            Couldn’t load alerts. <button type="button" className="font-medium underline" onClick={load}>Try again</button>
          </p>
        )}
        {rows && !list.length && (
          <p className="py-6 text-center text-sm text-muted">{show === 'open' ? 'No open alerts.' : 'Nothing here yet.'}</p>
        )}
        <ul className="divide-y divide-rule">
          {list.map((a) => (
            <li key={a.id} className="flex flex-wrap items-start justify-between gap-3 py-4">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <Pill tone={a.acknowledgedAt ? 'neutral' : a.severity === 'critical' ? 'bad' : 'warn'}>
                    {a.acknowledgedAt ? 'Acknowledged' : a.severity === 'critical' ? 'Critical' : 'Warning'}
                  </Pill>
                  {a.title}
                  {a.occurrences > 1 && <span className="text-xs font-normal text-muted">{a.occurrences} times</span>}
                </p>
                <p className="text-sm text-muted">{a.message}</p>
                <p className="text-xs text-muted">
                  {a.teamName ?? 'All teams'}, first seen {ago(a.createdAt)}, last {ago(a.lastSeenAt)}
                  {a.acknowledgedAt && `, acknowledged ${ago(a.acknowledgedAt)}${a.acknowledgedBy ? ` by ${a.acknowledgedBy}` : ''}`}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" onClick={() => onInspect(a)} className="rounded-md border border-rule bg-card px-3 py-1.5 text-sm hover:bg-band">Inspect</button>
                {!a.acknowledgedAt && (
                  <button type="button" disabled={busy === a.id} onClick={() => ack(a.id)}
                    className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-paper disabled:opacity-50">
                    {busy === a.id ? 'Saving…' : 'Acknowledge'}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
