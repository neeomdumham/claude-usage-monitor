// Requires TEST_DATABASE_URL pointing at a disposable database (schema is wiped per test).
import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import type { UsageEvent } from '@usage-monitor/contracts';
import { createApp, migrate } from './app.ts';

const url = process.env.TEST_DATABASE_URL;
const sql = url ? postgres(url, { onnotice: () => {} }) : (null as never);
const app = url ? createApp({ sql, ownerPassword: 'pw', sessionSecret: 'secret', secureCookies: false }) : (null as never);

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);
const nowSec = () => Math.floor(Date.now() / 1000);

let cookie = '';
const owner = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) } });
const agent = (token: string, path: string, body?: unknown) =>
  app.request(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });

async function enroll(name: string): Promise<string> {
  const inv = await (await owner('/api/dashboard/invitations', { method: 'POST', body: JSON.stringify({ name }) })).json();
  const res = await app.request('/api/enroll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: inv.code }) });
  return (await res.json()).token;
}

function ev(id: string, fp: string | null, secondsAgo = 60, output = 100): UsageEvent {
  return {
    sourceEventId: id, credentialFp: fp, sessionId: 's1', promptId: null, requestId: id, agentId: null,
    parentAgentId: null, model: 'claude-x', eventTime: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    inputTokens: 10, outputTokens: output, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01, durationMs: 5,
  };
}
const snap = (meterKey: string, pct: number, resetsAt: number) => ({
  meterKey, label: null, usedPercentage: pct, resetsAt, observedAt: new Date().toISOString(), source: 'statusline' as const,
});
// Minimal OTLP/HTTP JSON body for one api_request, plus content/identity attributes that must be dropped.
const otlp = (sessionId: string, requestId: string, prompt = 'x') => ({
  resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ logRecords: [{ attributes: [
    ['event.name', 'api_request'], ['event.timestamp', new Date(Date.now() - 60_000).toISOString()],
    ['session.id', sessionId], ['request_id', requestId], ['model', 'claude-x'], ['prompt', prompt],
    ['user.email', 'someone@example.com'],
  ].map(([key, v]) => ({ key, value: { stringValue: v } })).concat(
    ['input_tokens', 'output_tokens'].map((key) => ({ key, value: { intValue: '7' } as any })),
  ) }] }] }],
});
const overview = async (window = 'seven_day') => (await owner(`/api/dashboard/overview?window=${window}`)).json();

describe('server', { skip: !url && 'TEST_DATABASE_URL not set' }, () => {
  beforeEach(async () => {
    await sql`drop schema public cascade`;
    await sql`create schema public`;
    await migrate(sql);
    const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
    cookie = res.headers.get('set-cookie')!.split(';')[0];
  });
  after(() => sql?.end());

  test('four identical account snapshots count as one account state', async () => {
    const reset = nowSec() + 3600;
    for (const name of ['a', 'b', 'c', 'd']) {
      const t = await enroll(name);
      await agent(t, '/api/agent/events', { events: [], snapshots: [snap('seven_day', 41, reset)] });
    }
    const o = await overview();
    assert.equal(o.meters.length, 1);
    assert.equal(o.meters[0].usedPercentage, 41);
    assert.equal((await sql`select count(*)::int as n from quota_snapshots`)[0].n, 1);
  });

  test('duplicate delivery is harmless', async () => {
    const t = await enroll('a');
    const batch = { events: [ev('r1', FP_A)], snapshots: [snap('seven_day', 10, nowSec() + 3600)] };
    await agent(t, '/api/agent/events', batch);
    await agent(t, '/api/agent/events', batch);
    const o = await overview();
    assert.equal(o.ranking.length, 1);
    assert.equal(o.ranking[0].requests, 1);
  });

  test('old offline events land in their original window; five-hour reset keeps weekly totals', async () => {
    const t = await enroll('a');
    await agent(t, '/api/agent/events', {
      events: [ev('old', FP_A, 6 * 3600), ev('new', FP_A, 60)],
      snapshots: [snap('five_hour', 3, nowSec() + 4 * 3600), snap('seven_day', 20, nowSec() + 86400)],
    });
    assert.equal((await overview('five_hour')).ranking[0].requests, 1);
    assert.equal((await overview('seven_day')).ranking[0].requests, 2);
  });

  test('missing model-specific meter does not inherit the weekly value; quota contribution stays unavailable', async () => {
    const t = await enroll('a');
    await agent(t, '/api/agent/events', { events: [ev('r1', FP_A)], snapshots: [snap('seven_day', 41, nowSec() + 3600)] });
    const o = await overview();
    assert.deepEqual(o.meters.map((m: any) => m.meterKey), ['seven_day']);
    assert.equal(o.ranking[0].quotaContribution, null);
  });

  test('shared credential across two installations aggregates once per real request', async () => {
    const t1 = await enroll('office');
    const t2 = await enroll('home');
    const reset = nowSec() + 3600;
    await agent(t1, '/api/agent/events', { events: [ev('r1', FP_A)], snapshots: [snap('seven_day', 5, reset)] });
    await agent(t2, '/api/agent/events', { events: [ev('r2', FP_A), ev('r3', FP_B)], snapshots: [] });
    const o = await overview();
    const a = o.ranking.find((r: any) => r.fingerprintPrefix === 'a'.repeat(12));
    assert.equal(a.requests, 2);
    assert.equal(o.ranking.length, 2);
    assert.equal((await sql`select count(*)::int as n from credential_bindings`)[0].n, 3);
  });

  test('unverified auth is attributed per device, never merged across devices', async () => {
    const t1 = await enroll('laptop-a');
    const t2 = await enroll('laptop-b');
    await agent(t1, '/api/agent/events', { events: [ev('r1', null), ev('r2', null)], snapshots: [snap('seven_day', 5, nowSec() + 3600)] });
    await agent(t2, '/api/agent/events', { events: [ev('r3', null)], snapshots: [] });
    const o = await overview();
    assert.equal(o.ranking.length, 2);
    for (const r of o.ranking) { assert.equal(r.credentialId, null); assert.ok(r.installationId); }
    assert.deepEqual(o.ranking.map((r: any) => [r.installationName, r.requests]), [['laptop-a', 2], ['laptop-b', 1]]);
  });

  test('OTLP /v1/logs: allowlist only, dedupes retries, rejects protobuf and missing auth', async () => {
    const t = await enroll('a');
    await agent(t, '/api/agent/events', { events: [], snapshots: [snap('seven_day', 5, nowSec() + 3600)] });
    const body = otlp('sess-x', 'req_1', 'SECRET PROMPT');
    const post = (token: string | null, ct = 'application/json') => app.request('/v1/logs', {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': ct, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    assert.equal((await post(t)).status, 200);
    assert.equal((await post(t)).status, 200); // exporter retry
    assert.equal((await post(null)).status, 401);
    assert.equal((await post(t, 'application/x-protobuf')).status, 415);
    const rows = await sql`select * from usage_events`;
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows).includes('SECRET') && !JSON.stringify(rows).includes('someone@example.com'));
  });

  test('session binding attributes telemetry to the setup-token fingerprint, even when it arrives late', async () => {
    const t = await enroll('a');
    await agent(t, '/api/agent/events', { events: [], snapshots: [snap('seven_day', 5, nowSec() + 3600)] });
    await app.request('/v1/logs', { method: 'POST', body: JSON.stringify(otlp('sess-1', 'req_1')), headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });
    assert.equal((await agent(t, '/api/agent/sessions', { sessionId: 'sess-1', credentialFp: FP_A })).status, 200);
    const o = await overview();
    assert.equal(o.ranking.length, 1);
    assert.equal(o.ranking[0].fingerprintPrefix, 'a'.repeat(12));
    assert.equal(o.ranking[0].installationId, null);
    // another installation cannot rebind someone else's session
    const t2 = await enroll('b');
    await agent(t2, '/api/agent/sessions', { sessionId: 'sess-1', credentialFp: FP_B });
    assert.equal((await overview()).ranking[0].fingerprintPrefix, 'a'.repeat(12));
  });

  test('no current window reading means unknown boundary, not an empty ranking', async () => {
    const t = await enroll('a');
    await agent(t, '/api/agent/events', { events: [ev('r1', FP_A)], snapshots: [snap('five_hour', 50, nowSec() - 10)] });
    const o = await overview('five_hour');
    assert.equal(o.ranking, null);
    assert.equal(o.meters[0].expired, true);
  });

  test('client credentials cannot change policy or read the dashboard', async () => {
    const t = await enroll('a');
    for (const [path, method] of [['/api/dashboard/policy', 'PATCH'], ['/api/dashboard/overview', 'GET']]) {
      const res = await app.request(path, { method, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{"retentionDays":1}' });
      assert.equal(res.status, 401);
    }
    assert.equal((await (await agent(t, '/api/agent/policy')).json()).data.retentionDays, 30);
    assert.equal((await agent('bogus', '/api/agent/policy')).status, 401);
  });

  test('enrollment codes are single-use; revoked installations are rejected', async () => {
    const inv = await (await owner('/api/dashboard/invitations', { method: 'POST', body: '{"name":"x"}' })).json();
    const use = () => app.request('/api/enroll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: inv.code }) });
    const first = await use();
    assert.equal(first.status, 200);
    assert.equal((await use()).status, 400);
    const { installationId, token } = await first.json();
    await owner(`/api/dashboard/installations/${installationId}`, { method: 'PATCH', body: '{"revoked":true}' });
    assert.equal((await agent(token, '/api/agent/policy')).status, 401);
  });

  test('batches with unknown (content) fields are rejected', async () => {
    const t = await enroll('a');
    const bad = { events: [{ ...ev('r1', FP_A), prompt: 'secret code' }], snapshots: [] };
    assert.equal((await agent(t, '/api/agent/events', bad)).status, 400);
  });

  test('owner policy change creates a new revision', async () => {
    const res = await owner('/api/dashboard/policy', { method: 'PATCH', body: '{"batchIntervalSec":45}' });
    assert.equal((await res.json()).revision, 2);
    assert.equal((await owner('/api/dashboard/policy', { method: 'PATCH', body: '{"batchIntervalSec":1}' })).status, 400);
  });
});
