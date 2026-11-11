// Status-line bridge: forwards stdin to the previously configured status line (output preserved),
// and spools any account allowance readings. Must never break or slow the user's status line.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { QuotaSnapshot } from '@usage-monitor/contracts';
import { HOME, loadState, spoolWrite } from './state.ts';

/** Every rate_limits window with a percentage + boundary becomes its own meter; none inherit another's value. */
export function snapshotsFromStatusline(payload: unknown, now: Date): QuotaSnapshot[] {
  const rl = (payload as any)?.rate_limits;
  if (!rl || typeof rl !== 'object') return []; // absent = unavailable, never zero
  const out: QuotaSnapshot[] = [];
  for (const [meterKey, w] of Object.entries<any>(rl)) {
    if (meterKey === 'spend_limit') continue; // gateway dollars, not a subscription allowance
    const parsed = QuotaSnapshot.safeParse({
      meterKey, label: null, usedPercentage: w?.used_percentage, resetsAt: w?.resets_at,
      observedAt: now.toISOString(), source: 'statusline',
    });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

const LAST = join(HOME, 'statusline-last.json');
const REPEAT_SEC = 60; // re-spool an unchanged reading at most once a minute (keeps freshness, bounds writes)

export function runStatusline() {
  const input = readFileSync(0, 'utf8');
  let state;
  try { state = loadState(); } catch { state = null; }

  if (state?.chainedStatusLine) {
    const r = spawnSync('/bin/sh', ['-c', state.chainedStatusLine], { input, encoding: 'utf8', timeout: 5000 });
    if (r.stdout) process.stdout.write(r.stdout);
  }

  try {
    const snaps = snapshotsFromStatusline(JSON.parse(input), new Date());
    if (!snaps.length || !state) return;
    const key = JSON.stringify(snaps.map((s) => [s.meterKey, s.usedPercentage, s.resetsAt]));
    let last: { key?: string; at?: number } = {};
    try { last = JSON.parse(readFileSync(LAST, 'utf8')); } catch {}
    const nowSec = Date.now() / 1000;
    if (last.key === key && nowSec - (last.at ?? 0) < REPEAT_SEC) return;
    spoolWrite({ events: [], snapshots: snaps });
    writeFileSync(LAST, JSON.stringify({ key, at: nowSec }), { mode: 0o600 });
  } catch {
    // swallow: the status line must keep rendering even if monitoring fails
  }
}
