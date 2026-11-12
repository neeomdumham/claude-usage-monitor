// Flag thresholds: each flag fires at its threshold and stays quiet just under it or on too little data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY } from '@usage-monitor/contracts';
import { flagsFor, type PersonStats } from './analytics.ts';

const TODAY = '2026-11-12';
const policy = { ...DEFAULT_POLICY, workNamespaces: ['gitlab.com/office'] };
const base: PersonStats = {
  pid: 1, name: 'Rafi', isPerson: true, requests: 100, cost: 10, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  cacheCreationTokens: 0, cacheHit: 0, sessions: 5, activeDays: 5, nightPct: 0, sdkPct: 0, subagentPct: 0, topModel: null,
  repoCost: { work: 10, outside: 0, none: 0 }, prompts: 0, avgPromptLength: 0, toolCalls: 0, toolFailures: 0,
  decisions: 0, bypassPct: 0, compactions: 0, apiErrors: 0, labels: {},
  claude: { commits: 0, prs: 0, added: 0, removed: 0, activeUserSec: 0, activeCliSec: 0, editsAccepted: 0, editsRejected: 0 },
  gitlab: { commits: 0, additions: 0, deletions: 0 }, overlaps: 0, sharedTokens: [], daily: [],
};
const keys = (over: Partial<PersonStats>, p = policy) => flagsFor({ ...base, ...over }, p, TODAY).map((f) => f.key.split(':')[1]);
const days = (costs: number[], today: number) => [
  ...costs.map((cost, i) => ({ day: `2026-11-0${i + 1}`, cost })), { day: TODAY, cost: today },
];

test('a typical person raises nothing', () => assert.deepEqual(keys({}), []));

test('alerts: pasted secret, jailbreak phrasing, a token shared with someone else', () => {
  assert.deepEqual(keys({ labels: { 'credential-pasted': 1 } }), ['credential']);
  assert.deepEqual(keys({ labels: { 'jailbreak-attempt': 1 } }), ['jailbreak']);
  assert.deepEqual(keys({ sharedTokens: [{ fp: 'abc123', other: 'Nila' }] }), ['shared-abc123']);
});

test('label watches need three matches', () => {
  assert.deepEqual(keys({ labels: { 'non-work': 2, 'bulk-generation': 2 } }), []);
  assert.deepEqual(keys({ labels: { 'non-work': 3, 'bulk-generation': 3 } }), ['non-work', 'bulk']);
});

test('spike: 3x the median of at least five active days, and at least $2', () => {
  assert.deepEqual(keys({ daily: days([1, 1, 1, 1, 1], 3) }), ['spike']);
  assert.deepEqual(keys({ daily: days([1, 1, 1, 1, 1], 2.9) }), []);
  assert.deepEqual(keys({ daily: days([1, 1, 1, 1], 9) }), [], 'four days is too short a baseline');
  assert.deepEqual(keys({ daily: days([0.3, 0.3, 0.3, 0.3, 0.3], 1.9) }), [], 'under $2 never flags');
});

test('outside work repos: only once work namespaces are set', () => {
  assert.deepEqual(keys({ repoCost: { work: 6, outside: 4, none: 0 } }), ['outside']);
  assert.deepEqual(keys({ repoCost: { work: 6.1, outside: 3.9, none: 0 } }), []);
  assert.deepEqual(keys({ repoCost: { work: 6, outside: 4, none: 0 } }, DEFAULT_POLICY), []);
  assert.deepEqual(keys({ repoCost: { work: 0.5, outside: 0.4, none: 0 } }), [], 'under $1 total');
});

test('no repository at all', () => {
  assert.deepEqual(keys({ repoCost: { work: 4, outside: 0, none: 6 } }), ['no-repo']);
  assert.deepEqual(keys({ repoCost: { work: 4.1, outside: 0, none: 5.9 } }), []);
});

test('night, scripted and bypass shares need enough volume', () => {
  assert.deepEqual(keys({ nightPct: 25 }), ['night']);
  assert.deepEqual(keys({ nightPct: 24 }), []);
  assert.deepEqual(keys({ nightPct: 90, requests: 19 }), []);
  assert.deepEqual(keys({ sdkPct: 50 }), ['sdk']);
  assert.deepEqual(keys({ sdkPct: 90, requests: 49 }), []);
  assert.deepEqual(keys({ decisions: 20, bypassPct: 25 }), ['bypass']);
  assert.deepEqual(keys({ decisions: 19, bypassPct: 90 }), []);
});

test('overlapping sessions on two devices', () => assert.deepEqual(keys({ overlaps: 1 }), ['overlap']));

test('alerts sort before watches', () => {
  const f = flagsFor({ ...base, overlaps: 1, labels: { 'credential-pasted': 1 } }, policy, TODAY);
  assert.deepEqual(f.map((x) => x.severity), ['alert', 'watch']);
});
