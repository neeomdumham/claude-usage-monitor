import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toUsageEvents } from './otlp.ts';
import { snapshotsFromStatusline } from './statusline.ts';
import { credentialFingerprint, telemetryEnv } from './launcher.ts';
import { spoolList, spoolTrim, spoolWrite } from './state.ts';

const kv = (key: string, v: string | number) =>
  ({ key, value: typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : { stringValue: v } });

function otlp(records: Record<string, string | number>[]) {
  return {
    resourceLogs: [{
      resource: { attributes: [kv('service.name', 'claude-code'), kv('monitor.credential_fp', 'c'.repeat(64))] },
      scopeLogs: [{ logRecords: records.map((r) => ({ body: { stringValue: `claude_code.${r['event.name']}` }, attributes: Object.entries(r).map(([k, v]) => kv(k, v)) })) }],
    }],
  };
}

const apiRequest = (requestId: string, seq: number) => ({
  'event.name': 'api_request', 'event.timestamp': '2026-11-11T15:00:00.000Z', 'event.sequence': seq,
  'session.id': 'sess-1', 'prompt.id': 'prompt-1', request_id: requestId, model: 'claude-haiku',
  input_tokens: 12, output_tokens: 34, cache_read_tokens: 5, cache_creation_tokens: 0, cost_usd: 0.0012, duration_ms: 800,
  // content-bearing / non-allowlisted attributes that must never pass through:
  prompt: 'SECRET PROMPT', 'user.email': 'someone@example.com', 'workspace.host_paths': '/Users/x/repo',
});

test('only allowlisted api_request metadata passes the filter', () => {
  const { events } = toUsageEvents(otlp([apiRequest('req_1', 1), { 'event.name': 'user_prompt', prompt: 'SECRET PROMPT' }]));
  assert.equal(events.length, 1);
  const out = JSON.stringify(events);
  for (const leaked of ['SECRET', 'someone@example.com', '/Users/x']) assert.ok(!out.includes(leaked), leaked);
  assert.equal(events[0].credentialFp, 'c'.repeat(64));
  assert.equal(events[0].outputTokens, 34);
});

test('dedupe key: same record is stable, different requests differ', () => {
  const a1 = toUsageEvents(otlp([apiRequest('req_1', 1)])).events[0];
  const a2 = toUsageEvents(otlp([apiRequest('req_1', 1)])).events[0];
  const b = toUsageEvents(otlp([apiRequest('req_2', 2)])).events[0];
  assert.ok(a1 && b, 'sourceEventId must produce an id for a normal api_request');
  assert.equal(a1.sourceEventId, a2.sourceEventId);
  assert.notEqual(a1.sourceEventId, b.sourceEventId);
});

test('status line: fixture yields both windows; absence is unavailable, not zero', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../docs/fixtures/statusline-rate-limits.json', import.meta.url), 'utf8'));
  const snaps = snapshotsFromStatusline(fixture, new Date());
  assert.deepEqual(snaps.map((s) => [s.meterKey, s.usedPercentage, s.resetsAt]), [['five_hour', 8, 1794417600], ['seven_day', 41, 1794441600]]);
  assert.deepEqual(snapshotsFromStatusline({ model: {} }, new Date()), []);
  assert.deepEqual(snapshotsFromStatusline({ rate_limits: { spend_limit: { used_percentage: 5, resets_at: 1 } } }, new Date()), []);
});

test('fingerprint: full sha256, never the token; overriding auth -> unknown', () => {
  const token = 'sk-ant-oat01-example-token-value';
  const fp = credentialFingerprint({ CLAUDE_CODE_OAUTH_TOKEN: token }, false);
  assert.match(fp!, /^[0-9a-f]{64}$/);
  assert.ok(!fp!.includes(token));
  assert.equal(credentialFingerprint({ CLAUDE_CODE_OAUTH_TOKEN: token, ANTHROPIC_API_KEY: 'x' }, false), null);
  assert.equal(credentialFingerprint({ CLAUDE_CODE_OAUTH_TOKEN: token }, true), null);
  assert.equal(credentialFingerprint({}, false), null);
  const env = telemetryEnv({ OTEL_RESOURCE_ATTRIBUTES: 'team=x' }, 47318, fp);
  assert.equal(env.OTEL_RESOURCE_ATTRIBUTES, `team=x,monitor.credential_fp=${fp}`);
  assert.equal(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, 'http://127.0.0.1:47318/v1/logs');
});

test('spool is bounded on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spool-'));
  for (let i = 0; i < 5; i++) spoolWrite({ events: [], snapshots: [{ meterKey: 'seven_day', label: null, usedPercentage: i, resetsAt: 1, observedAt: new Date().toISOString(), source: 'statusline' }] }, dir);
  assert.equal(spoolTrim(dir, 3), 2);
  assert.equal(spoolList(dir).length, 3);
});
