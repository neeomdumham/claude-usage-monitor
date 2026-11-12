import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepo, parseOtlp as toUsageEvents } from './otlp.ts';

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

test('only allowlisted metadata passes the filter', () => {
  const content = { 'session.id': 'sess-1', 'event.timestamp': '2026-11-11T15:00:00.000Z', 'user.email': 'someone@example.com', 'workspace.host_paths': '/Users/x/repo' };
  const { events, activity } = toUsageEvents(otlp([
    apiRequest('req_1', 1),
    { ...content, 'event.name': 'user_prompt', 'event.sequence': 2, prompt: 'SECRET PROMPT', prompt_length: 13 },
    { ...content, 'event.name': 'tool_result', 'event.sequence': 3, tool_name: 'Bash', success: 'true', tool_parameters: '{"command":"cat SECRET"}', tool_input: 'SECRET', error: 'SECRET' },
    { ...content, 'event.name': 'tool_decision', 'event.sequence': 4, tool_name: 'Bash', decision: 'accept', permission_mode: 'bypassPermissions', tool_parameters: 'SECRET' },
    { ...content, 'event.name': 'compaction', 'event.sequence': 5, trigger: 'auto', pre_tokens: 1000, post_tokens: 100, error: 'SECRET' },
    { ...content, 'event.name': 'auth', 'event.sequence': 6, secretish: 'SECRET' }, // not collected at all
  ]));
  assert.equal(events.length, 1);
  assert.deepEqual(activity.map((a) => a.eventName), ['user_prompt', 'tool_result', 'tool_decision', 'compaction']);
  assert.deepEqual(activity[1].attrs, { tool_name: 'Bash', success: 'true' });
  const out = JSON.stringify({ events, activity });
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

test('repo remotes normalize and never keep embedded credentials', () => {
  assert.equal(normalizeRepo('https://oauth2:glpat-SECRET@gitlab.com/Office/API.git'), 'gitlab.com/office/api');
  assert.equal(normalizeRepo('git@gitlab.com:office/api.git'), 'gitlab.com/office/api');
  assert.equal(normalizeRepo('ssh://git@host:2222/team/x'), 'host:2222/team/x');
  assert.equal(normalizeRepo(''), null);
});

test('metrics: delta points pass with allowlisted attributes; cumulative and unknown metrics are skipped', async () => {
  const { parseMetrics } = await import('./otlp.ts');
  const dp = (attrs: Record<string, string>, v: number) => ({
    attributes: Object.entries(attrs).map(([k, val]) => kv(k, val)),
    startTimeUnixNano: '1794400000000000000', timeUnixNano: '1794400060000000000', asDouble: v,
  });
  const body = { resourceMetrics: [{
    resource: { attributes: [kv('vcs.repository.url.full', 'https://gitlab.com/Office/API.git'), kv('user.email', 'someone@example.com')] },
    scopeMetrics: [{ metrics: [
      { name: 'claude_code.lines_of_code.count', sum: { aggregationTemporality: 1, dataPoints: [dp({ type: 'added', 'session.id': 's1', model: 'x' }, 12)] } },
      { name: 'claude_code.commit.count', sum: { aggregationTemporality: 2, dataPoints: [dp({}, 3)] } },
      { name: 'claude_code.token.usage', sum: { aggregationTemporality: 1, dataPoints: [dp({ type: 'input' }, 99)] } },
    ] }],
  }] };
  const { points, skipped } = parseMetrics(body);
  assert.equal(points.length, 1);
  assert.deepEqual(points[0], {
    name: 'lines_of_code.count', sessionId: 's1', repo: 'gitlab.com/office/api', attrs: { type: 'added' },
    startTime: '2026-11-11T12:26:40.000Z', endTime: '2026-11-11T12:27:40.000Z', value: 12,
  });
  assert.equal(skipped, 1);
  assert.ok(!JSON.stringify(points).includes('someone@example.com'));
});
