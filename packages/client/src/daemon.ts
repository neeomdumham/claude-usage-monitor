// Local daemon: OTLP/HTTP JSON receiver on loopback + bounded spool uploader + heartbeat + policy cache.
import { createServer } from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import { DEFAULT_POLICY, Policy, type AgentBatch } from '@usage-monitor/contracts';
import { loadState, saveState, spoolList, spoolTrim, spoolWrite, type State } from './state.ts';
import { toUsageEvents } from './otlp.ts';

export const CLIENT_VERSION = '0.1.0';
const MAX_BODY = 5 * 1024 * 1024;

async function api(state: State, path: string, init?: RequestInit) {
  return fetch(new URL(path, state.serverUrl), {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
    signal: AbortSignal.timeout(15_000),
  });
}

/** Upload spooled files oldest-first. Returns false on a retryable failure. */
async function flush(state: State): Promise<boolean> {
  state.droppedCount += spoolTrim();
  let files = spoolList();
  while (files.length) {
    const batch: AgentBatch = { events: [], snapshots: [] };
    const taken: string[] = [];
    for (const f of files) {
      let b: AgentBatch;
      try { b = JSON.parse(readFileSync(f, 'utf8')); } catch { rmSync(f, { force: true }); state.droppedCount++; continue; }
      if (taken.length && (batch.events.length + b.events.length > 500 || batch.snapshots.length + b.snapshots.length > 100)) break;
      batch.events.push(...b.events);
      batch.snapshots.push(...b.snapshots);
      taken.push(f);
    }
    if (!taken.length) break;
    const res = await api(state, '/api/agent/events', { method: 'POST', body: JSON.stringify(batch) }).catch(() => null);
    if (!res || res.status >= 500 || res.status === 429) return false;
    if (res.status === 401) { console.error('monitoring credential rejected (revoked?)'); return false; }
    if (!res.ok) { console.error('server rejected batch', res.status, await res.text()); state.droppedCount += taken.length; }
    for (const f of taken) rmSync(f, { force: true });
    files = files.slice(taken.length);
  }
  return true;
}

async function heartbeat(state: State) {
  await api(state, '/api/agent/heartbeat', {
    method: 'POST',
    body: JSON.stringify({
      clientVersion: CLIENT_VERSION,
      appliedPolicyRevision: state.policy?.revision ?? null,
      capabilities: { otlpReceiver: true, statuslineBridge: state.statuslineBridge },
      queueDepth: spoolList().length,
      droppedCount: state.droppedCount,
    }),
  }).catch(() => null);
}

async function refreshPolicy(state: State) {
  const res = await api(state, '/api/agent/policy').catch(() => null);
  if (!res?.ok) return; // keep the last valid policy during outages
  const p = Policy.safeParse(await res.json().catch(() => null));
  if (p.success) state.policy = p.data;
}

const jitter = (ms: number) => ms * (0.5 + Math.random());

export async function runDaemon() {
  const state = loadState();
  const policy = () => state.policy?.data ?? DEFAULT_POLICY;

  createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/logs') { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) req.destroy(); else chunks.push(c); });
    req.on('end', () => {
      try {
        const { events, skipped } = toUsageEvents(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        state.droppedCount += skipped;
        spoolWrite({ events, snapshots: [] });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      } catch {
        res.writeHead(400).end();
      }
    });
  }).listen(state.otlpPort, '127.0.0.1', () => console.log(`OTLP receiver on 127.0.0.1:${state.otlpPort}`));

  let failures = 0;
  const flushLoop = async () => {
    const ok = await flush(state).catch(() => false);
    failures = ok ? 0 : failures + 1;
    saveState(state);
    const base = policy().batchIntervalSec * 1000;
    setTimeout(flushLoop, ok ? base : jitter(Math.min(base * 2 ** failures, 600_000)));
  };
  const heartbeatLoop = async () => { await heartbeat(state); setTimeout(heartbeatLoop, policy().heartbeatIntervalSec * 1000); };
  const policyLoop = async () => { await refreshPolicy(state); saveState(state); setTimeout(policyLoop, policy().policyRefreshSec * 1000); };

  await policyLoop();
  void heartbeatLoop();
  void flushLoop();
}
