import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentBatch, Policy } from '@usage-monitor/contracts';

export const HOME = process.env.USAGE_MONITOR_HOME ?? join(homedir(), '.config', 'claude-usage-monitor');
export const SPOOL = join(HOME, 'spool');
const STATE = join(HOME, 'state.json');
export const MAX_SPOOL_FILES = 5000; // fixed disk bound for the offline queue

/** Bootstrap identity + cached server policy. No product settings live here. */
export type State = {
  serverUrl: string;
  installationId: number;
  token: string;
  otlpPort: number;
  policy: Policy | null;
  droppedCount: number;
  chainedStatusLine: string | null; // the statusLine command we wrapped, restored on uninstall
  statuslineBridge: boolean;
};

export function loadState(): State {
  if (!existsSync(STATE)) throw new Error(`not enrolled (no ${STATE}); run: usage-monitor enroll <server-url> <code>`);
  return JSON.parse(readFileSync(STATE, 'utf8'));
}

export function saveState(s: State) {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSync(STATE + '.tmp', JSON.stringify(s, null, 2), { mode: 0o600 });
  renameSync(STATE + '.tmp', STATE);
  chmodSync(STATE, 0o600);
}

// One file per write, published by atomic rename: writers never race the uploader.
export function spoolWrite(batch: AgentBatch, dir = SPOOL) {
  if (!batch.events.length && !batch.snapshots.length) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  writeFileSync(join(dir, name + '.tmp'), JSON.stringify(batch), { mode: 0o600 });
  renameSync(join(dir, name + '.tmp'), join(dir, name + '.json'));
}

export function spoolList(dir = SPOOL): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => join(dir, f));
}

/** Enforce the disk bound by dropping the oldest files. Returns how many were dropped. */
export function spoolTrim(dir = SPOOL, max = MAX_SPOOL_FILES): number {
  const files = spoolList(dir);
  const excess = files.slice(0, Math.max(0, files.length - max));
  for (const f of excess) rmSync(f, { force: true });
  return excess.length;
}
