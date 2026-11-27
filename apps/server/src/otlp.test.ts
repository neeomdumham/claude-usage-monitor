import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_CAPTURE, normalizeRepo, parseOtlp as toUsageEvents, parseOtlp, parseTraces } from './otlp.ts';
import { redact } from './redact.ts';

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

test('the Claude account id arrives only as a sha256 key; the raw uuid, org and email never pass', () => {
  const uuid = '9f1c2d3e-0000-4000-8000-123456789abc';
  const [e] = toUsageEvents(otlp([{ ...apiRequest('req_1', 1), 'user.account_uuid': uuid, 'user.account_id': 'user_01X', 'organization.id': 'org-9' }])).events;
  assert.equal(e.accountKey, createHash('sha256').update(uuid).digest('hex'));
  const out = JSON.stringify(e);
  for (const leaked of [uuid, 'user_01X', 'org-9', 'someone@example.com']) assert.ok(!out.includes(leaked), leaked);
  assert.equal(toUsageEvents(otlp([apiRequest('req_2', 2)])).events[0].accountKey, null, 'no uuid exported: no key');
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

const ALL = { capturePrompts: true, captureToolDetails: true, captureFileContent: true, captureErrors: true };
const at = { 'session.id': 'sess-1', 'event.timestamp': '2026-11-17T10:00:00.000Z', 'vcs.repository.url.full': 'https://gitlab.com/office/api.git' };
const contentRecords = () => otlp([
  { ...at, 'event.name': 'user_prompt', 'event.sequence': 1, prompt: 'refactor the parser', prompt_length: 19 },
  { ...at, 'event.name': 'tool_result', 'event.sequence': 2, tool_name: 'Bash', success: 'true', 'vcs.ref.head.name': 'feature/x',
    tool_parameters: JSON.stringify({ bash_command: 'git', full_command: 'git push https://me:glpat-abcdefghijklmnopqrstu@gitlab.com/x.git' }) },
  { ...at, 'event.name': 'tool_result', 'event.sequence': 3, tool_name: 'Read', success: 'false', tool_input: '{"file_path":"/x/.env"}', error: 'ENOENT' },
  { ...at, 'event.name': 'tool_decision', 'event.sequence': 4, tool_name: 'Bash', decision: 'reject', tool_parameters: JSON.stringify({ full_command: 'rm -rf /' }) },
  { ...at, 'event.name': 'tool_decision', 'event.sequence': 5, tool_name: 'Bash', decision: 'accept', tool_parameters: JSON.stringify({ full_command: 'ls' }) },
  { ...at, 'event.name': 'api_error', 'event.sequence': 6, model: 'm', status_code: 529, error: 'Overloaded' },
]);

test('content is kept only for the kinds switched on', () => {
  assert.deepEqual(parseOtlp(contentRecords(), NO_CAPTURE).content, []);
  assert.deepEqual(parseOtlp(contentRecords(), { ...NO_CAPTURE, capturePrompts: true }).content.map((c) => c.kind), ['prompt']);
  assert.deepEqual(parseOtlp(contentRecords(), { ...NO_CAPTURE, captureErrors: true }).content.map((c) => [c.kind, c.text]), [['error', 'Overloaded']]);
  const tools = parseOtlp(contentRecords(), { ...NO_CAPTURE, captureToolDetails: true }).content;
  // accepted tool_decision is skipped (its tool_result carries the same call); the refused one is kept
  assert.deepEqual(tools.map((c) => [c.kind, c.toolName, c.text]), [
    ['command', 'Bash', 'git push https://[redacted]@gitlab.com/x.git'],
    ['tool_input', 'Read', '{"file_path":"/x/.env"}'],
    ['error', 'Read', 'ENOENT'],
    ['command', 'Bash', 'rm -rf /'],
  ]);
  assert.equal(tools[0].branch, 'feature/x');
  assert.equal(tools[0].repo, 'gitlab.com/office/api');
  assert.equal(new Set(tools.map((c) => c.sourceEventId)).size, tools.length);
  // metadata path is unchanged by capture
  assert.deepEqual(parseOtlp(contentRecords(), ALL).activity, parseOtlp(contentRecords(), NO_CAPTURE).activity);
});

test('traces: Read content, Edit diff and Bash output with paths, only with file content on', () => {
  const span = (id: string, tool: string, ev: Record<string, string>) => ({
    name: 'claude_code.tool', spanId: id, startTimeUnixNano: '1763373600000000000',
    attributes: [kv('tool_name', tool), kv('session.id', 'sess-1'), ...(ev.file_path ? [kv('file_path', ev.file_path)] : [])],
    events: [{ name: 'tool.output', timeUnixNano: '1763373601000000000', attributes: Object.entries(ev).map(([k, v]) => kv(k, v)) }],
  });
  const body = { resourceSpans: [{ resource: { attributes: [kv('vcs.repository.url.full', 'git@gitlab.com:office/api.git')] }, scopeSpans: [{ spans: [
    span('a', 'Read', { file_path: '/repo/.env', content: 'DB_PASSWORD=hunter2hunter\nPORT=80' }),
    span('b', 'Edit', { file_path: '/repo/a.ts', diff: JSON.stringify([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }]) }),
    span('c', 'Bash', { output: 'ok', bash_command: 'ls' }),
    { name: 'claude_code.llm_request', spanId: 'd', attributes: [], events: [] },
  ] }] }] };
  assert.deepEqual(parseTraces(body, { ...ALL, captureFileContent: false }), []);
  const out = parseTraces(body, ALL);
  assert.deepEqual(out.map((c) => [c.kind, c.filePath, c.text]), [
    ['file_read', '/repo/.env', 'DB_PASSWORD=[redacted]\nPORT=80'],
    ['diff', '/repo/a.ts', '@@ -1,1 +1,1 @@\n-old\n+new'],
    ['output', null, 'ok'],
  ]);
  assert.equal(out[0].repo, 'gitlab.com/office/api');
  assert.equal(out[0].eventTime, '2025-11-17T10:00:01.000Z');
});

test('redaction covers the setup token, keys, PEM blocks and assignments', () => {
  const cases: [string, string][] = [
    ['export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abcdefghijklmnopqrstuvwxyz', 'export CLAUDE_CODE_OAUTH_TOKEN=[redacted]'],
    ['aws AKIAABCDEFGHIJKLMNOP done', 'aws [redacted] done'],
    ['curl -H "Authorization: Bearer abc.def.ghijklmnop"', 'curl -H "Authorization: Bearer [redacted]"'],
    ['{"apiKey": "zzzzzzzzzz"}', '{"apiKey": "[redacted]"}'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\nafter', '[redacted]\nafter'],
    ['postgres://monitor:s3cret@db:5432/x', 'postgres://[redacted]@db:5432/x'],
    ['mytool --token abcdefgh run', 'mytool --token [redacted] run'],
    ['plain code: const total = a + b;', 'plain code: const total = a + b;'],
    ['git commit -m "fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>"', 'git commit -m "fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>"'],
    ['Authorization: s3cr3tvalue', 'Authorization: [redacted]'],
  ];
  for (const [input, want] of cases) assert.equal(redact(input), want, input);
});
