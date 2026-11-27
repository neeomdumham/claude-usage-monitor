// Requires TEST_DATABASE_URL pointing at a disposable database (schema is wiped per test).
import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import type { UsageEvent } from '@usage-monitor/contracts';
import { readFileSync } from 'node:fs';
import { checkInactiveDevices, cleanup, createApp, currentPolicy, migrate } from './app.ts';
import { runGitSync } from './gitsync.ts';

const url = process.env.TEST_DATABASE_URL;
const sql = url ? postgres(url, { onnotice: () => {} }) : (null as never);
const webhookCalls: { url: string; body: any }[] = [];
// Fake GitLab API + outbound webhook capture.
const fakeFetch = (async (u: string, init?: RequestInit) => {
  if (init?.method === 'POST' && (u.includes('hooks.slack.com') || u.includes('discord.com/api/webhooks') || u.includes('webhook.test'))) {
    webhookCalls.push({ url: u, body: JSON.parse(String(init.body ?? '{}')) });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const body = u.includes('/groups/')
    ? [{ id: 7, path_with_namespace: 'Office/API' }]
    : [
      { id: 'c1', author_email: 'Rafi@Office.dev', committed_date: new Date().toISOString(), stats: { additions: 10, deletions: 2 } },
      { id: 'c2', author_email: 'stranger@x.dev', committed_date: new Date().toISOString(), stats: { additions: 1, deletions: 0 } },
    ];
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
const app = url ? createApp({
  sql, ownerPassword: 'pw', sessionSecret: 'secret', secureCookies: false,
  git: { gitlab: { url: 'https://gitlab.com', token: 't', group: 'office' } }, fetch: fakeFetch,
}) : (null as never);

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

const invite = async (body: object) => (await owner('/api/dashboard/invites', { method: 'POST', body: JSON.stringify(body) })).json();
let ipSeq = 0; // the enroll rate limiter lives as long as the app, so each call gets its own address
const redeem = (token: string, ip = `10.1.${++ipSeq >> 8}.${ipSeq & 255}`) => app.request('/api/enroll', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
  body: JSON.stringify({ invite: token, hostname: 'mbp', os: 'Darwin', pluginVersion: 'plugin-test' }),
});
/** New person + one device; returns that device's token. */
async function enroll(name: string): Promise<string> {
  return (await (await redeem((await invite({ name })).token)).json()).token;
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

  test('two devices of one person rank as one row; a token used by two people is flagged', async () => {
    const inv = await invite({ name: 'Rafi' });
    const office = (await (await redeem(inv.token)).json()).token;
    const home = (await (await redeem(inv.token)).json()).token;
    const other = await enroll('Nila');
    await agent(office, '/api/agent/events', { events: [ev('r1', FP_A)], snapshots: [snap('seven_day', 5, nowSec() + 3600)] });
    await agent(home, '/api/agent/events', { events: [ev('r2', FP_B)], snapshots: [] });
    await agent(other, '/api/agent/events', { events: [ev('r3', FP_A)], snapshots: [] });
    const o = await overview();
    const rafi = o.ranking.find((r: any) => r.name === 'Rafi');
    assert.equal(rafi.requests, 2);
    assert.deepEqual(rafi.sharedTokens, ['a'.repeat(12)]);
    assert.equal(o.ranking.length, 2);
    const p = await (await owner(`/api/dashboard/people/${rafi.personId}/profile`)).json();
    assert.ok(p.flags.some((f: any) => f.key.endsWith(`:shared-${'a'.repeat(12)}`) && f.title.includes('Nila')));
  });

  test('events without a token fingerprint still rank under their person', async () => {
    const t1 = await enroll('laptop-a');
    const t2 = await enroll('laptop-b');
    await agent(t1, '/api/agent/events', { events: [ev('r1', null), ev('r2', null)], snapshots: [snap('seven_day', 5, nowSec() + 3600)] });
    await agent(t2, '/api/agent/events', { events: [ev('r3', null)], snapshots: [] });
    const o = await overview();
    assert.deepEqual(o.ranking.map((r: any) => [r.name, r.requests, r.tokens.length]), [['laptop-a', 2, 0], ['laptop-b', 1, 0]]);
  });

  test('invite: up to two devices, then used up; expired, replaced or revoked links fail', async () => {
    const inv = await invite({ name: 'Rafi' });
    assert.equal((await redeem(inv.token)).status, 200);
    assert.equal((await redeem(inv.token)).status, 200);
    assert.equal((await redeem(inv.token)).status, 401);

    const again = await invite({ personId: inv.personId });
    const newer = await invite({ personId: inv.personId }); // a fresh link replaces the previous one
    assert.equal((await redeem(again.token)).status, 401);
    await sql`update invites set expires_at = now() - interval '1 second' where person_id = ${inv.personId} and revoked_at is null`;
    assert.equal((await redeem(newer.token)).status, 401);

    const last = await invite({ personId: inv.personId });
    await owner(`/api/dashboard/people/${inv.personId}/invites`, { method: 'DELETE' });
    assert.equal((await redeem(last.token)).status, 401);
  });

  test('invite: concurrent redemptions never exceed max uses', async () => {
    const inv = await invite({ name: 'Rafi' });
    const codes = (await Promise.all([1, 2, 3, 4].map(() => redeem(inv.token)))).map((r) => r.status).sort();
    assert.deepEqual(codes, [200, 200, 401, 401]);
    assert.equal((await sql`select count(*)::int as n from installations`)[0].n, 2);
  });

  test('invite: repeated failures from one address are rate limited', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await redeem('ccm_inv_' + 'x'.repeat(32), '10.9.9.9')).status, 401);
    const good = await invite({ name: 'Rafi' });
    assert.equal((await redeem(good.token, '10.9.9.9')).status, 429);
    assert.equal((await redeem(good.token, '10.9.9.10')).status, 200);
  });

  test('pre-invite devices still rank on their own', async () => {
    await sql`insert into installations (name, token_hash) values ('legacy', ${'f'.repeat(64)})`;
    const [{ id }] = await sql`select id from installations where name = 'legacy'`;
    await sql`insert into usage_events (source_event_id, installation_id, model, event_time, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
      values ('x1', ${id}, 'm', now(), 1, 1, 0, 0)`;
    const t = await enroll('a');
    await agent(t, '/api/agent/events', { events: [], snapshots: [snap('seven_day', 5, nowSec() + 3600)] });
    const o = await overview();
    assert.deepEqual(o.ranking.map((r: any) => [r.name, r.personId, r.installationId]), [['legacy', null, Number(id)]]);
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
    const prompt = { resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: [
      ['event.name', 'user_prompt'], ['event.timestamp', new Date().toISOString()], ['session.id', 'sess-x'],
      ['prompt', 'SECRET PROMPT'], ['event.sequence', '3'],
    ].map(([key, v]) => ({ key, value: { stringValue: v } })).concat([{ key: 'prompt_length', value: { intValue: '13' } as any }]) }] }] }] };
    for (let i = 0; i < 2; i++) {
      await app.request('/v1/logs', { method: 'POST', body: JSON.stringify(prompt), headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });
    }
    const act = await sql`select event_name, attrs from activity_events`;
    assert.equal(act.length, 1);
    assert.deepEqual(act[0].attrs, { prompt_length: 13 });
  });

  test('session binding attributes telemetry to the setup-token fingerprint, even when it arrives late', async () => {
    const t = await enroll('a');
    await agent(t, '/api/agent/events', { events: [], snapshots: [snap('seven_day', 5, nowSec() + 3600)] });
    await app.request('/v1/logs', { method: 'POST', body: JSON.stringify(otlp('sess-1', 'req_1')), headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });
    assert.equal((await agent(t, '/api/agent/sessions', { sessionId: 'sess-1', credentialFp: FP_A })).status, 200);
    const o = await overview();
    assert.equal(o.ranking.length, 1);
    assert.deepEqual(o.ranking[0].tokens, ['a'.repeat(12)]);
    // another installation cannot rebind someone else's session
    const t2 = await enroll('b');
    await agent(t2, '/api/agent/sessions', { sessionId: 'sess-1', credentialFp: FP_B });
    assert.deepEqual((await overview()).ranking[0].tokens, ['a'.repeat(12)]);
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

  test('revoked devices are rejected', async () => {
    const res = await redeem((await invite({ name: 'x' })).token);
    const { installationId, token, person } = await res.json();
    assert.equal(person, 'x');
    assert.ok(token.startsWith('ccm_dev_'));
    await owner(`/api/dashboard/installations/${installationId}`, { method: 'PATCH', body: '{"revoked":true}' });
    assert.equal((await agent(token, '/api/agent/policy')).status, 401);
  });

  test('analytics: metrics, prompt labels and GitLab commits roll up per person with flags', async () => {
    const inv = await invite({ name: 'Rafi' });
    const t = (await (await redeem(inv.token)).json()).token;
    await owner(`/api/dashboard/people/${inv.personId}/git-emails`, { method: 'PUT', body: JSON.stringify({ emails: ['rafi@office.dev'] }) });
    await agent(t, '/api/agent/events', { events: [ev('r1', FP_A)], snapshots: [snap('seven_day', 10, nowSec() + 3600)] });

    const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);
    const metrics = { resourceMetrics: [{ resource: { attributes: [{ key: 'vcs.repository.url.full', value: { stringValue: 'git@gitlab.com:office/api.git' } }] },
      scopeMetrics: [{ metrics: [{ name: 'claude_code.commit.count', sum: { aggregationTemporality: 1, dataPoints: [
        { attributes: [], startTimeUnixNano: ns(Date.now() - 120_000), timeUnixNano: ns(Date.now() - 60_000), asDouble: 2 },
      ] } }] }] }] };
    const postMetrics = () => app.request('/v1/metrics', { method: 'POST', body: JSON.stringify(metrics), headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });
    assert.equal((await postMetrics()).status, 200);
    assert.equal((await postMetrics()).status, 200); // retried export
    assert.equal((await agent(t, '/api/agent/labels', { sessionId: 's1', category: 'credential-pasted' })).status, 200);
    assert.equal((await agent(t, '/api/agent/labels', { sessionId: 's1', category: 'free text', prompt: 'x' })).status, 400);
    assert.deepEqual(await (await owner('/api/dashboard/git/sync', { method: 'POST' })).json(), { gitlab: { projects: 1, commits: 2 } });
    assert.deepEqual(await (await owner('/api/dashboard/git/sync', { method: 'POST' })).json(), { gitlab: { projects: 1, commits: 0 } });

    const a = await (await owner('/api/dashboard/analytics?range=7d')).json();
    const rafi = a.people.find((p: any) => p.name === 'Rafi');
    assert.equal(rafi.claude.commits, 2);
    assert.deepEqual(rafi.gitlab, { commits: 1, additions: 10, deletions: 2 });
    assert.equal(rafi.labels['credential-pasted'], 1);
    assert.ok(a.flags.some((f: any) => f.pid === inv.personId && f.severity === 'alert' && f.key.endsWith(':credential')));
    const repo = a.repos.find((r: any) => r.repo === 'gitlab.com/office/api');
    assert.equal(repo.claude.commits, 2);
    assert.equal(repo.gitlab.commits, 1, 'unmapped org authors are excluded from team repo commit totals');
    assert.equal(a.git.unmappedAuthors.length, 1);
    assert.equal(a.git.unmappedAuthors[0].email, 'stranger@x.dev');
    assert.equal(a.git.unmappedAuthors[0].commits, 1);
    assert.deepEqual(a.git.unmappedAuthors[0].repos, ['gitlab.com/office/api']);
  });

  test('audit log records admin and device actions; flags can be reviewed; CSV export is formula-safe', async () => {
    const inv = await invite({ name: '=cmd()' });
    const t = (await (await redeem(inv.token)).json()).token;
    await agent(t, '/api/agent/labels', { sessionId: null, category: 'credential-pasted' });
    await owner('/api/dashboard/policy', { method: 'PATCH', body: '{"flagNightPct":30}' });
    const a = await (await owner('/api/dashboard/audit')).json();
    const actions = a.events.map((e: any) => e.action);
    for (const x of ['auth.login', 'person.added', 'invite.created', 'device.joined', 'prompt.labelled', 'settings.changed']) assert.ok(actions.includes(x), x);
    assert.deepEqual(a.events.find((e: any) => e.action === 'settings.changed').details.changed, ['flagNightPct']);
    const filtered = await (await owner(`/api/dashboard/audit?personId=${inv.personId}&action=device.joined`)).json();
    assert.equal(filtered.events.length, 1);
    assert.equal(filtered.events[0].details.hostname, 'mbp');
    const csv = await (await owner('/api/dashboard/audit.csv')).text();
    assert.ok(csv.startsWith('time,actor,action'));
    assert.ok(csv.includes("'=cmd()") && !csv.includes(',=cmd()'));

    const before = await (await owner('/api/dashboard/analytics?range=7d')).json();
    const flag = before.flags.find((f: any) => f.key.endsWith(':credential'));
    assert.equal(flag.review, null);
    await owner('/api/dashboard/flags/review', { method: 'POST', body: JSON.stringify({ key: flag.key, note: 'test key, rotated' }) });
    const after = await (await owner('/api/dashboard/analytics?range=7d')).json();
    assert.equal(after.flags.find((f: any) => f.key === flag.key).review.note, 'test key, rotated');
    assert.ok((await (await owner('/api/dashboard/overview')).json()).latestPluginVersion);
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
  test('owner login: wrong password and tampered cookies are refused', async () => {
    const bad = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"nope"}' });
    assert.equal(bad.status, 401);
    const [failed] = await sql`select count(*)::int as n from audit_log where action = 'auth.login_failed'`;
    assert.equal(failed.n, 1);
    const [name, value] = cookie.split('=');
    const forged = `${name}=${encodeURIComponent(String(Date.now() + 9e9))}.${decodeURIComponent(value).split('.').pop()}`;
    for (const c of ['', forged, `${cookie}x`]) {
      assert.equal((await app.request('/api/dashboard/overview', { headers: { cookie: c } })).status, 401, c || 'no cookie');
    }
    assert.equal((await owner('/api/dashboard/overview')).status, 200);
  });

  test('join rate limit keys on the address the proxy adds, not one the client claims', async () => {
    const bad = (claimed: string) => app.request('/api/enroll', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `${claimed}, 203.0.113.9` },
      body: JSON.stringify({ invite: 'ccm_inv_' + 'x'.repeat(30) }),
    });
    for (let i = 0; i < 5; i++) assert.equal((await bad(`198.51.100.${i}`)).status, 401);
    assert.equal((await bad('198.51.100.99')).status, 429);
  });

  test('OTLP bodies over 5 MB are refused', async () => {
    const t = await enroll('big');
    const res = await app.request('/v1/metrics', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
      body: JSON.stringify({ pad: 'x'.repeat(5 * 1024 * 1024 + 1) }),
    });
    assert.equal(res.status, 413);
  });

  test('GitLab sync follows pages, re-scans a 7-day overlap, dedupes, and audits failures', async () => {
    const seen: string[] = [];
    const commit = (id: string) => ({ id, author_email: 'A@x.dev', committed_date: new Date().toISOString(), stats: { additions: 1, deletions: 1 } });
    let fail = false;
    const gl = (async (u: string) => {
      seen.push(u);
      if (fail) return new Response('nope', { status: 503 });
      const page = new URL(u).searchParams.get('page');
      const body = u.includes('/groups/') ? [{ id: 9, path_with_namespace: 'Office/Web' }]
        : page === '1' ? [commit('a'), commit('b')] : [commit('b'), commit('c')];
      return new Response(JSON.stringify(body), { headers: { 'x-next-page': !u.includes('/groups/') && page === '1' ? '2' : '' } });
    }) as typeof fetch;
    const cfg = { gitlab: { url: 'https://gitlab.example', token: 't', group: 'office' } };
    assert.deepEqual(await runGitSync(sql, cfg, gl), { gitlab: { projects: 1, commits: 3 } });
    assert.deepEqual(await runGitSync(sql, cfg, gl), { gitlab: { projects: 1, commits: 0 } }, 'second run inserts nothing new');
    const since = new Date(new URL(seen.filter((u) => u.includes('/commits')).pop()!).searchParams.get('since')!);
    const lag = (Date.now() - since.getTime()) / 86400_000;
    assert.ok(lag > 6.9 && lag < 7.1, `re-scan starts 7 days back, got ${lag}`);
    const [{ repo }] = await sql`select distinct repo from git_commits`;
    assert.equal(repo, 'gitlab.example/office/web');
    fail = true;
    await assert.rejects(runGitSync(sql, cfg, gl));
    const actions = (await sql`select action from audit_log where action like 'git.%' order by id`).map((r) => r.action);
    assert.deepEqual(actions, ['git.sync', 'git.sync', 'git.sync_failed']);
  });

  test('retention cleanup drops raw data past the policy window and keeps the rest', async () => {
    const t = await enroll('old');
    await agent(t, '/api/agent/events', { events: [ev('recent', FP_A), ev('ancient', FP_A, 40 * 86400)], snapshots: [] });
    await sql`insert into audit_log (at, actor, action) values (now() - interval '400 days', 'system', 'old.thing')`;
    await cleanup(sql);
    assert.deepEqual((await sql`select source_event_id from usage_events`).map((r) => r.source_event_id), ['recent']);
    assert.equal((await sql`select count(*)::int as n from audit_log where action = 'old.thing'`)[0].n, 0);
    assert.ok((await sql`select count(*)::int as n from audit_log`)[0].n > 0, 'recent audit entries stay');
  });

  const setPolicy = (patch: object) => owner('/api/dashboard/policy', { method: 'PATCH', body: JSON.stringify(patch) });
  const kvs = (o: Record<string, string>) => Object.entries(o).map(([key, v]) => ({ key, value: { stringValue: v } }));
  const promptLog = (seq: number, prompt: string) => ({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: kvs({
    'event.name': 'user_prompt', 'session.id': 's9', 'event.timestamp': new Date(Date.now() - 60_000 + seq).toISOString().slice(0, 17) + '00.000Z', 'event.sequence': String(seq), prompt }) }] }] }] });
  const otlpPost = (t: string, path: string, body: unknown) => app.request(path, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify(body) });

  test('content capture: off by default, follows the switch at arrival time, listed for the owner only', async () => {
    const t = await enroll('Nila');
    await otlpPost(t, '/v1/logs', promptLog(1, 'before the switch'));
    assert.equal((await sql`select count(*)::int as n from content_events`)[0].n, 0, 'default policy stores no content');
    assert.equal((await setPolicy({ capturePrompts: true, captureFileContent: true })).status, 200);
    await otlpPost(t, '/v1/logs', promptLog(2, 'my key is sk-ant-oat01-abcdefghijklmnopqrstuvwxyz'));
    await otlpPost(t, '/v1/logs', promptLog(2, 'my key is sk-ant-oat01-abcdefghijklmnopqrstuvwxyz')); // retry
    const trace = { resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'claude_code.tool', spanId: 'x1', startTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
      attributes: kvs({ tool_name: 'Edit', file_path: '/repo/a.ts' }), events: [{ name: 'tool.output', attributes: kvs({ diff: '-a\n+b' }) }] }] }] }] };
    assert.equal((await otlpPost(t, '/v1/traces', trace)).status, 200);
    const list = await (await owner('/api/dashboard/content')).json();
    assert.deepEqual(list.items.map((i: any) => [i.kind, i.text, i.person]), [
      ['diff', '-a\n+b', 'Nila'], ['prompt', 'my key is [redacted]', 'Nila']]);
    assert.equal(list.capture.prompts, true);
    assert.deepEqual((await (await owner('/api/dashboard/content?kind=diff&q=a.ts')).json()).items.length, 1);
    assert.equal((await agent(t, '/api/dashboard/content')).status, 401);
    await setPolicy({ capturePrompts: false });
    await otlpPost(t, '/v1/logs', promptLog(3, 'after switching off'));
    assert.equal((await sql`select count(*)::int as n from content_events where kind = 'prompt'`)[0].n, 1);
    // content keeps its own, shorter retention
    await setPolicy({ contentRetentionDays: 1 });
    await sql`update content_events set event_time = now() - interval '2 days' where kind = 'prompt'`;
    await cleanup(sql);
    assert.deepEqual((await sql`select kind from content_events`).map((r) => r.kind), ['diff']);
  });

  test('GitLab commit messages and diffs only while git details capture is on, and /commits excludes unmapped org authors', async () => {
    const dev = await invite({ name: 'Arif' });
    await owner(`/api/dashboard/people/${dev.personId}/git-emails`, { method: 'PUT', body: JSON.stringify({ emails: ['a@x.dev'] }) });
    const gl = (async (u: string) => {
      const body = u.includes('/groups/') ? [{ id: 3, path_with_namespace: 'Office/Api' }]
        : u.includes('/diff') ? [{ old_path: 'a.ts', new_path: 'a.ts', diff: '+const token = "glpat-abcdefghijklmnopqrstu";' }]
        : [
          { id: 'd1', author_email: 'a@x.dev', committed_date: new Date().toISOString(), message: 'fix login', stats: { additions: 1, deletions: 0 } },
          { id: 'd2', author_email: 'outsider@org.dev', committed_date: new Date().toISOString(), message: 'external push', stats: { additions: 50, deletions: 0 } },
        ];
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
    const cfg = { gitlab: { url: 'https://gitlab.example', token: 't', group: 'office' } };
    await runGitSync(sql, cfg, gl);
    assert.deepEqual([...await sql`select message, diff from git_commits where sha = 'd1'`], [{ message: null, diff: null }]);
    await runGitSync(sql, cfg, gl, 30, 'system', true);
    const [row] = await sql`select message, diff from git_commits where sha = 'd1'`;
    assert.equal(row.message, 'fix login');
    assert.equal(row.diff, '--- a.ts\n+++ a.ts\n+const token = "[redacted]";');
    // Only enrolled teammate Arif's commit appears in /api/dashboard/commits and repoGit/gitlabDaily; outsider stays in unmappedAuthors.
    const commitFeed = await (await owner('/api/dashboard/commits')).json();
    assert.deepEqual(commitFeed.commits.map((c: any) => [c.sha, c.person, c.message]), [['d1', 'Arif', 'fix login']]);
    const a = await (await owner('/api/dashboard/analytics?range=7d')).json();
    assert.equal(a.repos.find((r: any) => r.repo === 'gitlab.example/office/api')?.gitlab.commits, 1);
    assert.equal(a.git.gitlabDaily.reduce((s: number, x: any) => s + x.commits, 0), 1);
    assert.deepEqual(a.git.unmappedAuthors.map((u: any) => u.email), ['outsider@org.dev']);
    await setPolicy({ contentRetentionDays: 1 });
    await sql`update git_commits set committed_at = now() - interval '2 days'`;
    await cleanup(sql);
    assert.deepEqual([...await sql`select message, diff from git_commits where sha = 'd1'`], [{ message: null, diff: null }], 'commit stays, content goes');
  });

  test('GitHub sync: follows Link pages, skips archived and empty repos, fetches each new commit once, runs beside GitLab', async () => {
    const seen: string[] = [];
    let details = 0;
    const commit = (sha: string) => ({ sha, commit: { author: { email: 'Rafi@Office.dev' }, committer: { date: new Date().toISOString() }, message: 'add ghp_' + 'a'.repeat(36) } });
    const gh = (async (u: string) => {
      seen.push(u);
      const json = (body: unknown, headers: Record<string, string> = {}, status = 200) => new Response(JSON.stringify(body), { headers, status });
      if (u.includes('gitlab.example')) return json(u.includes('/groups/') ? [] : []);
      if (u.includes('/orgs/Tulip-Tech/repos')) return json([{ id: 1, full_name: 'Tulip-Tech/VelaOps' }, { id: 2, full_name: 'Tulip-Tech/old', archived: true }, { id: 3, full_name: 'Tulip-Tech/empty' }]);
      if (u.includes('/repos/Tulip-Tech/empty/commits')) return new Response('{}', { status: 409 });
      if (u.includes('/orgs/Locked/')) return json({ message: 'Resource not accessible by personal access token' }, {}, 403);
      const one = u.match(/\/commits\/(\w+)$/);
      if (one) {
        details++;
        return json({ stats: { additions: 5, deletions: 1 }, files: [{ filename: 'a.ts', patch: '@@ -1 +1 @@\n+const k = "sk-ant-' + 'x'.repeat(30) + '";' }] });
      }
      return u.includes('page=2') ? json([commit('s2')]) : json([commit('s1')], { link: `<${u}&page=2>; rel="next"` });
    }) as typeof fetch;
    const git = { github: { token: 't', org: 'Tulip-Tech' }, gitlab: { url: 'https://gitlab.example', token: 't', group: 'office' } };
    assert.deepEqual(await runGitSync(sql, git, gh), { gitlab: { projects: 0, commits: 0 }, github: { repos: 2, commits: 2 } });
    assert.ok(seen.every((u) => !u.includes('/repos/Tulip-Tech/old/')), 'archived repos are skipped');
    assert.deepEqual([...await sql`select repo, sha, author_email, additions, deletions, message, diff from git_commits order by sha`], [
      { repo: 'github.com/tulip-tech/velaops', sha: 's1', author_email: 'rafi@office.dev', additions: 5, deletions: 1, message: null, diff: null },
      { repo: 'github.com/tulip-tech/velaops', sha: 's2', author_email: 'rafi@office.dev', additions: 5, deletions: 1, message: null, diff: null }]);
    assert.equal(details, 2);
    await runGitSync(sql, git, gh);
    assert.equal(details, 2, 'known commits are not fetched again');
    await runGitSync(sql, git, gh, 30, 'system', true);
    assert.equal(details, 4, 'switching details on fetches the diff once');
    const [row] = await sql`select message, diff from git_commits where sha = 's1'`;
    assert.equal(row.message, 'add [redacted]');
    assert.equal(row.diff, '--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n+const k = "[redacted]";');
    const since = new Date(new URL(seen.filter((u) => u.includes('/repos/Tulip-Tech/VelaOps/commits?')).pop()!).searchParams.get('since')!);
    assert.ok(Math.abs((Date.now() - since.getTime()) / 86400_000 - 7) < 0.1, 're-scans 7 days back');
    await assert.rejects(runGitSync(sql, { github: { token: 't', org: 'Locked' } }, gh), /GitHub 403 on .*: Resource not accessible by personal access token/);
    const before = seen.length;
    const [x, y] = await Promise.all([runGitSync(sql, git, gh), runGitSync(sql, git, gh)]);
    assert.equal(x, y, 'a sync started while one runs joins it');
    assert.equal(seen.filter((u) => u.includes('/orgs/Tulip-Tech/repos')).length, seen.slice(0, before).filter((u) => u.includes('/orgs/Tulip-Tech/repos')).length + 1);
  });

  test('overview reports the plugin version from plugin.json', async () => {
    const { version } = JSON.parse(readFileSync(new URL('../../../plugin/.claude-plugin/plugin.json', import.meta.url), 'utf8'));
    assert.equal((await (await owner('/api/dashboard/overview')).json()).latestPluginVersion, version);
  });

  test('multi-team RBAC: team leads see seat meters and only their own team; superadmin controls content toggle and admins', async () => {
    const loginAs = async (email: string, password: string) => {
      const r = await app.request('/api/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      assert.equal(r.status, 200, `login failed for ${email}`);
      const c = r.headers.get('set-cookie')!.split(';')[0];
      return (path: string, init: RequestInit = {}) =>
        app.request(path, { ...init, headers: { 'content-type': 'application/json', cookie: c, ...(init.headers ?? {}) } });
    };

    const backend = await (await owner('/api/dashboard/teams', { method: 'POST', body: JSON.stringify({ name: 'Backend', workNamespaces: ['github.com/tulip-tech/api'] }) })).json();
    const frontend = await (await owner('/api/dashboard/teams', { method: 'POST', body: JSON.stringify({ name: 'Frontend' }) })).json();

    // Create a Team Lead for Backend and a second Superadmin.
    const shamimRes = await owner('/api/dashboard/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'shamim@company.com', name: 'Shamim', password: 'lead-password-1', role: 'team_lead', teamIds: [backend.id] }),
    });
    assert.equal(shamimRes.status, 201);
    const shamimUser = await shamimRes.json();

    const ctoRes = await owner('/api/dashboard/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'cto@company.com', name: 'CTO', password: 'super-password-1', role: 'superadmin' }),
    });
    assert.equal(ctoRes.status, 201);

    const shamim = await loginAs('shamim@company.com', 'lead-password-1');
    const cto = await loginAs('cto@company.com', 'super-password-1');

    // /api/auth/me reflects viewer identity and assigned team.
    const me = await (await shamim('/api/auth/me')).json();
    assert.equal(me.viewer.role, 'team_lead');
    assert.deepEqual(me.viewer.teamIds, [backend.id]);

    // Shamim invites Rafi (defaults to Backend); cannot invite into Frontend.
    assert.equal((await shamim('/api/dashboard/invites', { method: 'POST', body: JSON.stringify({ name: 'Forbidden', teamId: frontend.id }) })).status, 403);
    const rafiInv = await (await shamim('/api/dashboard/invites', { method: 'POST', body: JSON.stringify({ name: 'Rafi' }) })).json();
    const rafiDev = await (await redeem(rafiInv.token)).json();

    // Superadmin invites Nila into Frontend and Solo unassigned.
    const nilaInv = await invite({ name: 'Nila', teamId: frontend.id });
    const nilaDev = await (await redeem(nilaInv.token)).json();
    const soloInv = await invite({ name: 'Solo' });
    const soloDev = await (await redeem(soloInv.token)).json();

    await setPolicy({ capturePrompts: true });
    await agent(rafiDev.token, '/api/agent/events', { events: [ev('r-be', FP_A)], snapshots: [snap('seven_day', 42, nowSec() + 3600)] });
    await agent(nilaDev.token, '/api/agent/events', { events: [ev('r-fe', FP_B)], snapshots: [] });
    await agent(soloDev.token, '/api/agent/events', { events: [ev('r-so', null)], snapshots: [] });
    await otlpPost(rafiDev.token, '/v1/logs', promptLog(11, 'backend prompt'));
    await otlpPost(nilaDev.token, '/v1/logs', promptLog(12, 'frontend prompt'));

    // Shamim sees global meters, ONLY Backend team, ONLY Rafi across overview and analytics.
    const leadOverview = await (await shamim('/api/dashboard/overview')).json();
    assert.equal(leadOverview.meters[0].usedPercentage, 42);
    assert.deepEqual(leadOverview.teams.map((t: any) => t.name), ['Backend']);
    assert.deepEqual(leadOverview.people.map((p: any) => p.name), ['Rafi']);
    assert.deepEqual(leadOverview.ranking.map((r: any) => r.name), ['Rafi']);
    assert.equal(leadOverview.installations.length, 1);

    const leadAnalytics = await (await shamim('/api/dashboard/analytics?range=7d')).json();
    assert.deepEqual(leadAnalytics.people.map((p: any) => p.name), ['Rafi']);

    // Cross-team & superadmin-only operations are forbidden (403) for Team Lead.
    assert.equal((await shamim(`/api/dashboard/people/${nilaInv.personId}/profile`)).status, 403);
    assert.equal((await shamim(`/api/dashboard/people/${nilaInv.personId}`, { method: 'PATCH', body: JSON.stringify({ name: 'Hacked' }) })).status, 403);
    assert.equal((await shamim(`/api/dashboard/installations/${nilaDev.installationId}`, { method: 'PATCH', body: JSON.stringify({ revoked: true }) })).status, 403);
    assert.equal((await shamim('/api/dashboard/policy', { method: 'PATCH', body: JSON.stringify({ retentionDays: 7 }) })).status, 403);
    assert.equal((await shamim('/api/dashboard/users')).status, 403);
    assert.equal((await shamim('/api/dashboard/teams', { method: 'POST', body: JSON.stringify({ name: 'Rogue' }) })).status, 403);
    assert.equal((await shamim('/api/dashboard/git/sync', { method: 'POST' })).status, 403);
    assert.equal((await shamim('/api/dashboard/content')).status, 403, 'captured content blocked for leads by default');

    // Superadmin enables leadsCanViewContent: Shamim now sees ONLY Rafi's captured content.
    assert.equal((await cto('/api/dashboard/policy', { method: 'PATCH', body: JSON.stringify({ leadsCanViewContent: true }) })).status, 200);
    const leadContent = await (await shamim('/api/dashboard/content')).json();
    assert.deepEqual(leadContent.items.map((i: any) => [i.person, i.text]), [['Rafi', 'backend prompt']]);

    // Superadmin can scope overview/analytics by ?teamId= or see all 3 people unfiltered.
    assert.deepEqual((await (await cto('/api/dashboard/overview')).json()).people.map((p: any) => p.name), ['Rafi', 'Nila', 'Solo']);
    assert.deepEqual((await (await cto(`/api/dashboard/overview?teamId=${frontend.id}`)).json()).people.map((p: any) => p.name), ['Nila']);

    // Disabling a Team Lead immediately invalidates their active session cookie.
    assert.equal((await cto(`/api/dashboard/users/${shamimUser.id}`, { method: 'PATCH', body: JSON.stringify({ disabled: true }) })).status, 200);
    assert.equal((await shamim('/api/dashboard/overview')).status, 401);

    // Superadmin cannot self-disable or self-demote.
    const ctoMe = await (await cto('/api/auth/me')).json();
    assert.equal((await cto(`/api/dashboard/users/${ctoMe.viewer.id}`, { method: 'PATCH', body: JSON.stringify({ disabled: true }) })).status, 400);
    assert.equal((await cto(`/api/dashboard/users/${ctoMe.viewer.id}`, { method: 'PATCH', body: JSON.stringify({ role: 'team_lead' }) })).status, 400);
  });

  test('repo guard policy merge, guard events, disabled-plugin / ghost-burn / inactive alerts, and Slack/Discord webhook cooldown', async () => {
    webhookCalls.length = 0;
    const setPolicy = (p: object) => owner('/api/dashboard/policy', { method: 'PATCH', body: JSON.stringify(p) });

    // 1. Team namespaces merge into /api/agent/policy for team members.
    const team = await (await owner('/api/dashboard/teams', {
      method: 'POST',
      body: JSON.stringify({ name: 'Backend', workNamespaces: ['github.com/tulip-tech/api'] }),
    })).json();
    const leadRes = await owner('/api/dashboard/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'lead@co.dev', name: 'Shamim', password: 'lead-password-1', role: 'team_lead', teamIds: [team.id] }),
    });
    assert.equal(leadRes.status, 201);
    const leadLogin = await app.request('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'lead@co.dev', password: 'lead-password-1' }),
    });
    const leadCookie = leadLogin.headers.get('set-cookie')!.split(';')[0];
    const lead = (path: string, init: RequestInit = {}) =>
      app.request(path, { ...init, headers: { 'content-type': 'application/json', cookie: leadCookie, ...(init.headers ?? {}) } });

    const rafiInv = await invite({ name: 'Rafi', teamId: team.id });
    const rafiDev = await (await redeem(rafiInv.token)).json();
    const soloInv = await invite({ name: 'Solo' });
    const soloDev = await (await redeem(soloInv.token)).json();

    await setPolicy({
      workNamespaces: ['github.com/tulip-tech/core'],
      outsideRepoMode: 'block',
      noRepoMode: 'warn',
      inactiveDaysAlert: 3,
      unaccountedJumpPct: 15,
      webhookUrl: 'https://hooks.slack.com/services/T0/B0/XYZ',
    });

    const rafiPol = await (await agent(rafiDev.token, '/api/agent/policy')).json();
    assert.equal(rafiPol.data.outsideRepoMode, 'block');
    assert.equal(rafiPol.data.noRepoMode, 'warn');
    assert.deepEqual(rafiPol.data.workNamespaces.sort(), ['github.com/tulip-tech/api', 'github.com/tulip-tech/core']);

    // 2. Test webhook button (Slack formatting) + forbidden for team lead.
    assert.equal((await lead('/api/dashboard/alerts/test-webhook', { method: 'POST', body: '{}' })).status, 403);
    const testHook = await owner('/api/dashboard/alerts/test-webhook', { method: 'POST', body: '{}' });
    assert.equal(testHook.status, 200);
    assert.equal(webhookCalls.length, 1);
    assert.ok(Array.isArray(webhookCalls[0].body.blocks), 'Slack webhook uses blocks');

    // 3. Guard blocked event creates critical alert, audit log, activity event, and dispatches webhook once (cooldown on repeat).
    const g1 = await agent(rafiDev.token, '/api/agent/guard', {
      sessionId: 's-out-1', hook: 'UserPromptSubmit', action: 'blocked', reason: 'outside_repo', repo: 'github.com/personal/side', toolName: null,
    });
    assert.equal(g1.status, 200);
    await agent(rafiDev.token, '/api/agent/guard', {
      sessionId: 's-out-1', hook: 'UserPromptSubmit', action: 'blocked', reason: 'outside_repo', repo: 'github.com/personal/side', toolName: null,
    });
    assert.equal(webhookCalls.length, 2, 'second identical alert within 60m cooldown does not re-notify webhook');

    // 4. Plugin disabled detector: stale heartbeat (>90s) + OTLP request for unbound session -> critical alert.
    await sql`update installations set last_heartbeat_at = now() - interval '10 minutes' where id = ${rafiDev.installationId}`;
    const otlpRes = await app.request('/v1/logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${rafiDev.token}` },
      body: JSON.stringify(otlp('sess-hooks-off', 'req-hooks-off')),
    });
    assert.equal(otlpRes.status, 200);
    assert.equal(webhookCalls.length, 3, 'plugin_disabled triggers webhook');

    // 5. Unaccounted 5h meter jump ("ghost burn") triggers critical seat-wide alert (Discord format switch).
    await setPolicy({ webhookUrl: 'https://discord.com/api/webhooks/123/abc' });
    const reset = nowSec() + 18000;
    await agent(rafiDev.token, '/api/agent/events', { events: [], snapshots: [snap('five_hour', 10, reset)] });
    await agent(rafiDev.token, '/api/agent/events', { events: [], snapshots: [snap('five_hour', 32, reset)] });
    assert.equal(webhookCalls.length, 4, 'unaccounted 5h jump (+22%) triggers Discord webhook');
    assert.ok(Array.isArray(webhookCalls[3].body.embeds), 'Discord webhook uses embeds');

    // 6. Inactive device detector flags teammates silent > inactiveDaysAlert days.
    await sql`update installations set last_heartbeat_at = now() - interval '5 days' where id = ${soloDev.installationId}`;
    const inactiveCount = await checkInactiveDevices(sql, fakeFetch, (await currentPolicy(sql)).data);
    assert.equal(inactiveCount, 1);

    // 7. Alerts API: superadmin sees all 4; Backend Team Lead sees ONLY Rafi's 2 team alerts (never seat-wide or Solo's).
    const allAlerts = await (await owner('/api/dashboard/alerts')).json();
    assert.equal(allAlerts.unacknowledgedCount, 4);
    assert.deepEqual(allAlerts.alerts.map((a: any) => a.kind).sort(), ['inactive_device', 'outside_blocked', 'plugin_disabled', 'unaccounted_burn']);
    const blocked = allAlerts.alerts.find((a: any) => a.kind === 'outside_blocked');
    assert.equal(blocked.occurrences, 2);

    const leadAlerts = await (await lead('/api/dashboard/alerts')).json();
    assert.equal(leadAlerts.unacknowledgedCount, 2);
    assert.deepEqual(leadAlerts.alerts.map((a: any) => a.kind).sort(), ['outside_blocked', 'plugin_disabled']);

    // Team lead cannot ack Solo's or seat-wide alerts, CAN ack Rafi's.
    const ghostAlert = allAlerts.alerts.find((a: any) => a.kind === 'unaccounted_burn');
    assert.equal((await lead(`/api/dashboard/alerts/${ghostAlert.id}/ack`, { method: 'POST' })).status, 403);
    assert.equal((await lead(`/api/dashboard/alerts/${blocked.id}/ack`, { method: 'POST' })).status, 200);
    assert.equal((await (await lead('/api/dashboard/alerts')).json()).unacknowledgedCount, 1);

    // 8. A fresh heartbeat from Rafi's device proves hooks are active again and auto-clears plugin_disabled.
    const hbRes = await agent(rafiDev.token, '/api/agent/heartbeat', {
      clientVersion: 'plugin-0.5.8', appliedPolicyRevision: 1,
      capabilities: { otlpDirect: true, statuslineBridge: true, repoGuard: true, tokenFingerprint: true },
      queueDepth: 0, droppedCount: 0,
    });
    assert.equal(hbRes.status, 200);
    assert.equal((await (await lead('/api/dashboard/alerts')).json()).unacknowledgedCount, 0);

    // 9. Superadmin email update + OWNER_EMAIL migration of owner@local in place.
    const usersBefore = (await (await owner('/api/dashboard/users')).json()).users;
    const ownerUser = usersBefore.find((u: any) => u.email === 'owner@local');
    assert.ok(ownerUser);
    const updEmail = await owner(`/api/dashboard/users/${ownerUser.id}`, {
      method: 'PATCH', body: JSON.stringify({ email: 'moeen@tulip-tech.com' }),
    });
    assert.equal(updEmail.status, 200);
    const usersAfter = (await (await owner('/api/dashboard/users')).json()).users;
    assert.ok(usersAfter.some((u: any) => u.id === ownerUser.id && u.email === 'moeen@tulip-tech.com'));
  });

  test('five_hour/day range alignment, sessions ledger with xhigh effort & duration, range-aware profile, and 365-day calendar API', async () => {
    await owner('/api/dashboard/policy', { method: 'PATCH', body: JSON.stringify({ workNamespaces: ['github.com/tulip-tech/'] }) });
    const rafiInv = await invite({ name: 'Rafi' });
    const rafiDev = await (await redeem(rafiInv.token)).json();
    await owner(`/api/dashboard/people/${rafiInv.personId}/git-emails`, { method: 'PUT', body: JSON.stringify({ emails: ['rafi@co.dev'] }) });

    const now = Date.now();
    const fiveReset = Math.floor((now + 2 * 3600_000) / 1000);
    await agent(rafiDev.token, '/api/agent/sessions', { sessionId: 'sess-xhigh', credentialFp: FP_A });
    await agent(rafiDev.token, '/api/agent/events', {
      snapshots: [snap('five_hour', 28, fiveReset)],
      events: [
        { ...ev('e1', FP_A, 1800, 500), sessionId: 'sess-xhigh', model: 'claude-opus-5-5', effort: 'xhigh', costUsd: 1.8, repo: 'github.com/tulip-tech/lolerflow' },
        { ...ev('e2', FP_A, 600, 400), sessionId: 'sess-xhigh', model: 'claude-opus-5-5', effort: 'high', costUsd: 0.9, repo: 'github.com/tulip-tech/lolerflow' },
        // Older session 3 days ago (outside current 5h window, inside 7d and calendar).
        { ...ev('e3', FP_A, 3 * 86400, 200), sessionId: 'sess-old', model: 'claude-sonnet-5-5', effort: 'medium', costUsd: 0.4, repo: 'github.com/personal/side' },
      ],
    });

    // Current 5h range only includes sess-xhigh (2 requests, $2.70), never sess-old.
    const a5h = await (await owner('/api/dashboard/analytics?range=five_hour')).json();
    assert.equal(a5h.range.key, 'five_hour');
    assert.equal(a5h.people[0].requests, 2);
    assert.equal(a5h.efforts.find((x: any) => x.effort === 'xhigh')?.requests, 1);

    // Profile respects ?range=five_hour vs ?range=7d.
    const p5h = await (await owner(`/api/dashboard/people/${rafiInv.personId}/profile?range=five_hour`)).json();
    const p7d = await (await owner(`/api/dashboard/people/${rafiInv.personId}/profile?range=7d`)).json();
    assert.equal(p5h.totals.requests, 2);
    assert.equal(p7d.totals.requests, 3);

    // Sessions endpoint exposes maxEffort, duration spanSec, hooksActive, repoClass, and effort filter.
    const sAll = await (await owner('/api/dashboard/sessions?range=7d')).json();
    assert.equal(sAll.summary.totalSessions, 2);
    assert.equal(sAll.summary.xhighSessions, 1);
    assert.equal(sAll.summary.outsideSessions, 1);
    assert.equal(sAll.summary.unhookedSessions, 1, 'sess-old had no SessionStart binding');
    const xh = sAll.sessions.find((s: any) => s.sessionId === 'sess-xhigh');
    assert.equal(xh.maxEffort, 'xhigh');
    assert.equal(xh.hooksActive, true);
    assert.equal(xh.repoClass, 'work');
    assert.equal(xh.spanSec, 1200);

    const sOnlyXhigh = await (await owner('/api/dashboard/sessions?range=7d&effort=xhigh')).json();
    assert.deepEqual(sOnlyXhigh.sessions.map((s: any) => s.sessionId), ['sess-xhigh']);

    // Day-specific range works for drill-down from the GitHub-style calendar.
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date(now - 600_000));
    const sDay = await (await owner(`/api/dashboard/sessions?range=day:${todayStr}`)).json();
    assert.deepEqual(sDay.sessions.map((s: any) => s.sessionId), ['sess-xhigh']);

    // Activity calendar returns daily buckets, totals, and available years.
    const cal = await (await owner('/api/dashboard/activity/calendar')).json();
    assert.equal(cal.mode, 'rolling');
    assert.equal(cal.totals.requests, 3);
    assert.equal(cal.totals.xhighRequests, 1);
    assert.equal(cal.totals.outsideRequests, 1);
    assert.ok(cal.years.includes(new Date().getUTCFullYear()));
    const calYear = await (await owner(`/api/dashboard/activity/calendar?year=${cal.years[0]}`)).json();
    assert.equal(calYear.mode, 'year');
    assert.equal(calYear.startDay, `${cal.years[0]}-01-01`);
  });

  test('reconnect invite refreshes an existing device token in place without creating a duplicate device', async () => {
    const rafiInv = await invite({ name: 'Rafi' });
    const first = await (await redeem(rafiInv.token, 'rafi-mbp')).json();
    await agent(first.token, '/api/agent/events', {
      snapshots: [],
      events: [{ ...ev('e-before', FP_A, 600, 300), sessionId: 's-before', costUsd: 1.25 }],
    });

    const recRes = await owner('/api/dashboard/invites', {
      method: 'POST',
      body: JSON.stringify({ installationId: first.installationId }),
    });
    assert.equal(recRes.status, 200);
    const rec = await recRes.json();
    assert.equal(rec.maxUses, 1);
    assert.equal(rec.installationId, first.installationId);

    const secondRes = await redeem(rec.token, 'rafi-mbp');
    assert.equal(secondRes.status, 200);
    const second = await secondRes.json();
    assert.equal(second.installationId, first.installationId);
    assert.notEqual(second.token, first.token);

    // Single-use reconnect invite cannot be redeemed twice; old token is immediately rejected.
    assert.equal((await redeem(rec.token, 'rafi-mbp')).status, 401);
    assert.equal((await agent(first.token, '/api/agent/events', { snapshots: [], events: [] })).status, 401);
    assert.equal((await agent(second.token, '/api/agent/events', {
      snapshots: [],
      events: [{ ...ev('e-after', FP_A, 120, 200), sessionId: 's-after', costUsd: 0.75 }],
    })).status, 200);

    const ov = await (await owner('/api/dashboard/overview')).json();
    assert.equal(ov.installations.length, 1);
    assert.equal(ov.installations[0].id, first.installationId);
    const prof = await (await owner(`/api/dashboard/people/${rafiInv.personId}/profile?range=7d`)).json();
    assert.equal(prof.totals.requests, 2);
  });
  // ---------- Claude accounts: several seats/logins, each with its own allowance ----------
  const UUID_A = '11111111-aaaa-4aaa-8aaa-111111111111';
  const UUID_B = '22222222-bbbb-4bbb-8bbb-222222222222';
  /** One api_request as Claude Code exports it, from the account with this uuid. */
  const acctLog = (uuid: string | null, req: string, cost = '0.50', secondsAgo = 60) => ({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: kvs({
    'event.name': 'api_request', 'event.timestamp': new Date(Date.now() - secondsAgo * 1000).toISOString(), 'session.id': `s-${req}`,
    request_id: req, model: 'claude-x', cost_usd: cost, 'user.email': 'seat@example.com', 'organization.id': 'org-1',
    ...(uuid ? { 'user.account_uuid': uuid } : {}) }) }] }] }] });
  const loginAs = async (email: string, password: string) => {
    const r = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const c = r.headers.get('set-cookie')!.split(';')[0];
    return (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { 'content-type': 'application/json', cookie: c, ...(init.headers ?? {}) } });
  };

  test('accounts: each uuid is its own account (hashed, never the email); readings never overwrite another account', async () => {
    const a = await enroll('Rafi'), b = await enroll('Nila');
    await otlpPost(a, '/v1/logs', acctLog(UUID_A, 'ra1'));
    await otlpPost(b, '/v1/logs', acctLog(UUID_B, 'nb1'));
    await otlpPost(b, '/v1/logs', acctLog(UUID_B, 'nb2')); // known key: no second account
    const accts = await sql`select label, account_key from accounts order by id`;
    assert.equal(accts.length, 2);
    assert.deepEqual(accts.map((r) => r.label), ['Unlabeled account 1', 'Unlabeled account 2']);
    const dump = JSON.stringify(await sql`select * from usage_events`) + JSON.stringify(accts);
    for (const secret of [UUID_A, UUID_B, 'seat@example.com', 'org-1']) assert.ok(!dump.includes(secret), `${secret} not stored`);
    const alerts = await (await owner('/api/dashboard/alerts')).json();
    assert.equal(alerts.alerts.filter((x: any) => x.kind === 'account_detected').length, 2);

    // Phase 0 reproduction: B's reading with a later reset must not move A's meter, window or burn line.
    const resetA = nowSec() + 3 * 86400, resetB = nowSec() + 5 * 86400;
    await agent(a, '/api/agent/events', { events: [], snapshots: [snap('seven_day', 63, resetA)] });
    await agent(b, '/api/agent/events', { events: [], snapshots: [snap('seven_day', 18, resetB)] });
    const o = await overview();
    assert.deepEqual(o.meters.map((m: any) => m.usedPercentage).sort(), [18, 63]);
    assert.equal(new Set(o.meters.map((m: any) => m.accountId)).size, 2);
    const [idA] = (await sql`select account_id from installations where account_id is not null order by id`).map((r) => Number(r.account_id));
    const onlyA = await (await owner(`/api/dashboard/analytics?range=window&accountId=${idA}`)).json();
    assert.equal(Date.parse(onlyA.range.end) / 1000, resetA);
    assert.deepEqual(onlyA.burn.map((x: any) => x.pct), [63]);
    // estimates: everyone's points on an account add up to its meter
    const cardA = o.accounts.find((x: any) => x.id === idA);
    assert.equal(cardA.people.length, 1);
    assert.equal(cardA.people[0].ptsWeek, 63);
    assert.equal(cardA.otherTeams, null);
    // a device can't claim an account key over the agent API
    await agent(a, '/api/agent/events', { events: [{ ...ev('forged', null), accountKey: 'f'.repeat(64) }], snapshots: [] });
    assert.equal((await sql`select account_id from usage_events where source_event_id = 'forged'`)[0].account_id, null);
  });

  test('accounts: an invite\'s account learns its key from the first device; usage on B never hides ghost burn on A', async () => {
    const team = await (await owner('/api/dashboard/teams', { method: 'POST', body: JSON.stringify({ name: 'Backend' }) })).json();
    const acct = await (await owner('/api/dashboard/accounts', { method: 'POST', body: JSON.stringify({ label: 'Seat A', teamId: team.id }) })).json();
    const inv = await invite({ name: 'Rafi', teamId: team.id, accountId: acct.id });
    const a = (await (await redeem(inv.token)).json()).token;
    const b = await enroll('Nila');
    await otlpPost(a, '/v1/logs', acctLog(UUID_A, 'ra1', '0.50', 3600)); // an hour ago: outside the jump interval
    assert.deepEqual((await sql`select id, label from accounts`).map((r) => [Number(r.id), r.label]), [[acct.id, 'Seat A']], 'claimed, not a new account');
    assert.equal((await (await owner('/api/dashboard/alerts')).json()).alerts.length, 0);
    await otlpPost(b, '/v1/logs', acctLog(UUID_B, 'nb1'));

    await setPolicy({ unaccountedJumpPct: 15 });
    const reset = nowSec() + 18000;
    await agent(a, '/api/agent/events', { events: [], snapshots: [snap('five_hour', 10, reset)] });
    for (let i = 0; i < 6; i++) await otlpPost(b, '/v1/logs', acctLog(UUID_B, `busy${i}`)); // heavy use on B only
    await agent(a, '/api/agent/events', { events: [], snapshots: [snap('five_hour', 32, reset)] });
    const burn = (await (await owner('/api/dashboard/alerts')).json()).alerts.filter((x: any) => x.kind === 'unaccounted_burn');
    assert.equal(burn.length, 1);
    assert.match(burn[0].title, /Seat A/);
    assert.equal(burn[0].teamId, team.id, 'the owner team sees its own account\'s ghost burn');
  });

  test('accounts: leads see only accounts their teams own or use, and other teams only as a total', async () => {
    const be = await (await owner('/api/dashboard/teams', { method: 'POST', body: JSON.stringify({ name: 'Backend' }) })).json();
    const fe = await (await owner('/api/dashboard/teams', { method: 'POST', body: JSON.stringify({ name: 'Frontend' }) })).json();
    await owner('/api/dashboard/users', { method: 'POST', body: JSON.stringify({ email: 'lead@co.dev', name: 'Shamim', password: 'lead-password-1', role: 'team_lead', teamIds: [be.id] }) });
    const lead = await loginAs('lead@co.dev', 'lead-password-1');
    const rafi = (await (await redeem((await invite({ name: 'Rafi', teamId: be.id })).token)).json()).token;
    const nila = (await (await redeem((await invite({ name: 'Nila', teamId: fe.id })).token)).json()).token;
    const imran = (await (await redeem((await invite({ name: 'Imran', teamId: fe.id })).token)).json()).token;
    await otlpPost(rafi, '/v1/logs', acctLog(UUID_A, 'r1', '1.00'));
    await otlpPost(nila, '/v1/logs', acctLog(UUID_A, 'n1', '3.00')); // Frontend also uses A
    await otlpPost(imran, '/v1/logs', acctLog(UUID_B, 'i1')); // B is Frontend-only
    await agent(rafi, '/api/agent/events', { events: [], snapshots: [snap('seven_day', 40, nowSec() + 86400)] });
    await agent(imran, '/api/agent/events', { events: [], snapshots: [snap('seven_day', 90, nowSec() + 2 * 86400)] });

    const o = await (await lead('/api/dashboard/overview')).json();
    assert.deepEqual(o.meters.map((m: any) => m.usedPercentage), [40], 'never Frontend-only account B');
    assert.equal(o.accounts.length, 1);
    assert.deepEqual(o.accounts[0].people.map((p: any) => [p.name, p.ptsWeek]), [['Rafi', 10]]);
    assert.equal(o.accounts[0].otherTeams.ptsWeek, 30, 'Nila only as an other-teams total');
    assert.deepEqual((await (await lead('/api/dashboard/analytics?range=window')).json()).burn.map((x: any) => x.pct), [40]);
    const list = await (await lead('/api/dashboard/accounts')).json();
    assert.deepEqual(list.accounts[0].devices.map((d: any) => d.personName), ['Rafi']);
    assert.equal(list.accounts[0].otherTeamDevices, 1);
    // a lead can't invite onto, or rename, an account their teams don't use
    const idB = (await sql`select account_id from installations where account_id <> ${o.accounts[0].id}`)[0].account_id;
    assert.equal((await lead('/api/dashboard/invites', { method: 'POST', body: JSON.stringify({ name: 'X', accountId: Number(idB) }) })).status, 403);
    assert.equal((await lead(`/api/dashboard/accounts/${idB}`, { method: 'PATCH', body: JSON.stringify({ label: 'Mine' }) })).status, 403);
    // the superadmin's team filter applies the same rule
    const feView = await (await owner(`/api/dashboard/overview?teamId=${fe.id}`)).json();
    assert.deepEqual(feView.meters.map((m: any) => m.usedPercentage).sort(), [40, 90]);
  });

  test('membership: leads claim unassigned people (409 if taken), superadmins move anyone, team delete can move members', async () => {
    const be = await (await owner('/api/dashboard/teams', { method: 'POST', body: JSON.stringify({ name: 'Backend' }) })).json();
    const fe = await (await owner('/api/dashboard/teams', { method: 'POST', body: JSON.stringify({ name: 'Frontend' }) })).json();
    await owner('/api/dashboard/users', { method: 'POST', body: JSON.stringify({ email: 'lead@co.dev', name: 'Shamim', password: 'lead-password-1', role: 'team_lead', teamIds: [be.id] }) });
    const lead = await loginAs('lead@co.dev', 'lead-password-1');
    const solo = await invite({ name: 'Solo' });
    const nila = await invite({ name: 'Nila', teamId: fe.id });
    assert.deepEqual((await (await lead('/api/dashboard/people/unassigned')).json()).people.map((p: any) => p.name), ['Solo']);
    assert.deepEqual((await (await lead('/api/dashboard/people/unassigned?includeAssigned=true')).json()).people.map((p: any) => p.name), ['Solo'], 'leads never list other teams');
    assert.deepEqual((await (await owner('/api/dashboard/people/unassigned?includeAssigned=true')).json()).people.map((p: any) => [p.name, p.teamId]), [['Nila', fe.id], ['Solo', null]]);
    const move = (as: typeof lead, id: number, teamId: number | null) => as(`/api/dashboard/people/${id}`, { method: 'PATCH', body: JSON.stringify({ teamId }) });
    assert.equal((await move(lead, solo.personId, be.id)).status, 200);
    assert.equal((await move(lead, nila.personId, be.id)).status, 409, 'already in Frontend');
    assert.equal((await move(lead, solo.personId, fe.id)).status, 403, 'not their team');
    assert.equal((await move(owner, nila.personId, be.id)).status, 200);
    const [entry] = await sql`select details from audit_log where action = 'person.team_changed' order by id desc limit 1`;
    assert.equal(entry.details.fromName, 'Frontend');
    assert.equal(entry.details.toName, 'Backend');
    assert.equal((await owner(`/api/dashboard/teams/${be.id}?moveTo=${fe.id}`, { method: 'DELETE' })).status, 200);
    assert.deepEqual((await sql`select distinct team_id from people`).map((r) => Number(r.team_id)), [fe.id]);
  });

  test('accounts: "attribute older readings" files pre-detection rows under each device\'s account', async () => {
    const a = await enroll('Rafi');
    const reset = nowSec() + 86400;
    await agent(a, '/api/agent/events', { events: [ev('old', null)], snapshots: [snap('seven_day', 20, reset)] }); // before detection
    await otlpPost(a, '/v1/logs', acctLog(UUID_A, 'new'));
    await agent(a, '/api/agent/events', { events: [], snapshots: [snap('seven_day', 25, reset)] });
    assert.equal((await sql`select count(*)::int as n from quota_snapshots where account_id is null`)[0].n, 1);
    const res = await (await owner('/api/dashboard/accounts/attribute', { method: 'POST' })).json();
    assert.deepEqual(res, { readings: 1, requests: 1 });
    assert.equal((await sql`select count(*)::int as n from quota_snapshots where account_id is null`)[0].n, 0);
    await sql`update quota_snapshots set last_observed_at = now() - interval '40 days'`;
    await cleanup(sql);
    assert.equal((await sql`select count(*)::int as n from quota_snapshots`)[0].n, 0, 'old readings expire with retention');
  });
});
