// Wire contracts shared by client, server and dashboard.
// Everything a client may send is listed here; anything else is rejected or dropped.
import { z } from 'zod';

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const id = z.string().min(1).max(200);
const short = z.string().max(100);
const repo = z.string().max(200);

/** Non-request activity events the server keeps; attribute names per event are allowlisted in otlp.ts. */
export const ACTIVITY_EVENTS = [
  'user_prompt', 'tool_result', 'tool_decision', 'api_error', 'compaction',
  'subagent_completed', 'skill_activated', 'permission_mode_changed',
  'prompt_label', // from the plugin's on-device classifier: a category only, never text
  'guard_event',  // from the plugin's on-device repo guard (warned/blocked outside-work attempt)
] as const;

/** Categories the on-device prompt classifier may report. The prompt itself never leaves the laptop. */
export const PROMPT_LABELS = ['credential-pasted', 'jailbreak-attempt', 'bulk-generation', 'non-work'] as const;
export const PromptLabel = z.strictObject({ sessionId: id.nullable(), category: z.enum(PROMPT_LABELS) });

/** On-device repository guard modes and reported enforcement events. */
export const GUARD_MODES = ['off', 'warn', 'block'] as const;
export const GuardMode = z.enum(GUARD_MODES);
export type GuardMode = z.infer<typeof GuardMode>;

export const GuardEvent = z.strictObject({
  sessionId: id.nullable(),
  hook: z.enum(['UserPromptSubmit', 'PreToolUse']),
  action: z.enum(['warned', 'blocked']),
  reason: z.enum(['outside_repo', 'no_repo', 'path_escape']),
  repo: repo.nullable(),
  toolName: short.nullable().optional(),
});
export type GuardEvent = z.infer<typeof GuardEvent>;

/** High-visibility admin alert categories (dashboard banner + outbound webhook). */
export const ALERT_KINDS = [
  'plugin_disabled',
  'outside_blocked',
  'outside_warned',
  'unaccounted_burn',
  'inactive_device',
  'account_detected', // a Claude account nobody set up yet started reporting; name it on the Accounts page
] as const;
export const AlertKind = z.enum(ALERT_KINDS);
export type AlertKind = z.infer<typeof AlertKind>;

/** One delta data point of an allowlisted Claude Code OTel metric (commits, PRs, lines, active time, ...). */
export const MetricPoint = z.strictObject({
  name: z.enum(['commit.count', 'pull_request.count', 'lines_of_code.count', 'code_edit_tool.decision', 'active_time.total', 'session.count']),
  sessionId: id.nullable(),
  repo: repo.nullable(),
  attrs: z.record(z.string().max(60), short),
  startTime: z.iso.datetime({ offset: true }),
  endTime: z.iso.datetime({ offset: true }),
  value: z.number().nonnegative(),
});
export type MetricPoint = z.infer<typeof MetricPoint>;
export const ActivityEvent = z.strictObject({
  sourceEventId: id,
  sessionId: id.nullable(),
  eventName: z.enum(ACTIVITY_EVENTS),
  eventTime: z.iso.datetime({ offset: true }),
  repo: repo.nullable(),
  attrs: z.record(z.string().max(60), z.union([short, z.number(), z.boolean()])),
});
export type ActivityEvent = z.infer<typeof ActivityEvent>;

/** One Claude Code API request, reduced to allowlisted metadata (no prompts, paths, tool data). */
export const UsageEvent = z.strictObject({
  sourceEventId: id,
  credentialFp: sha256Hex.nullable(), // null = unknown/unverified auth bucket
  sessionId: id.nullable(),
  promptId: id.nullable(),
  requestId: id.nullable(),
  agentId: id.nullable(),
  parentAgentId: id.nullable(),
  model: z.string().min(1).max(100),
  eventTime: z.iso.datetime({ offset: true }),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheReadTokens: z.int().nonnegative(),
  cacheCreationTokens: z.int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(), // API-priced estimate, NOT subscription consumption
  durationMs: z.int().nonnegative().nullable(),
  querySource: short.nullish(), // main thread vs subagent vs other
  effort: short.nullish(),
  speed: short.nullish(),
  repo: repo.nullish(),         // normalized remote, e.g. gitlab.com/office/api (never a local path)
  entrypoint: short.nullish(),
  accountKey: sha256Hex.nullish(), // sha256 of Claude Code's user.account_uuid; set by the server's OTLP parser only
});
export type UsageEvent = z.infer<typeof UsageEvent>;

/** An account-level allowance reading. Observer identity is never debit identity. */
export const QuotaSnapshot = z.strictObject({
  meterKey: z.string().regex(/^[a-z0-9_]{1,40}$/),
  label: z.string().max(60).nullable(), // upstream/owner label, e.g. "Weekly · Fable"
  usedPercentage: z.number().min(0).max(100),
  resetsAt: z.int().positive(), // unix epoch seconds, upstream boundary
  observedAt: z.iso.datetime({ offset: true }),
  source: z.enum(['statusline', 'stream-json', 'manual']),
});
export type QuotaSnapshot = z.infer<typeof QuotaSnapshot>;

export const AgentBatch = z.strictObject({
  events: z.array(UsageEvent).max(500),
  snapshots: z.array(QuotaSnapshot).max(100),
});
export type AgentBatch = z.infer<typeof AgentBatch>;

export const SessionBinding = z.strictObject({ sessionId: id, credentialFp: sha256Hex.nullable() });

export const Heartbeat = z.strictObject({
  clientVersion: z.string().max(40),
  appliedPolicyRevision: z.int().nullable(),
  capabilities: z.record(z.string().max(40), z.boolean()),
  queueDepth: z.int().nonnegative(),
  droppedCount: z.int().nonnegative(),
});
export type Heartbeat = z.infer<typeof Heartbeat>;

/** Server-issued typed policy. Never commands or code. */
export const PolicyData = z.strictObject({
  batchIntervalSec: z.int().min(10).max(600),
  heartbeatIntervalSec: z.int().min(30).max(600),
  policyRefreshSec: z.int().min(30).max(600),
  retentionDays: z.int().min(1).max(365),
  freshnessThresholdSec: z.int().min(60).max(86400),
  displayTimezone: z.string().max(60),
  workNamespaces: z.array(z.string().min(1).max(200)).max(30), // repo prefixes that count as work, e.g. gitlab.com/office/
  flagOutsideWorkPct: z.int().min(1).max(100),
  flagNightPct: z.int().min(1).max(100),
  flagSpikeMultiple: z.number().min(1.5).max(20),  // last-24h cost vs the person's own median active day
  flagSdkPct: z.int().min(1).max(100),             // share of requests from scripted (sdk) entrypoints
  flagBypassPct: z.int().min(1).max(100),          // share of tool decisions made in bypassPermissions
  flagNoRepoPct: z.int().min(1).max(100),          // share of cost outside any git repository
  // Content capture, all off by default. The server enforces these on arrival; devices follow them next session.
  capturePrompts: z.boolean(),      // prompt text (OTEL_LOG_USER_PROMPTS); Claude's responses are never captured
  captureToolDetails: z.boolean(),  // commands, tool parameters/input, tool errors, branch (OTEL_LOG_TOOL_DETAILS)
  captureFileContent: z.boolean(),  // file paths, contents, diffs, command output (traces + OTEL_LOG_TOOL_CONTENT)
  captureErrors: z.boolean(),       // API error messages
  captureGitDetails: z.boolean(),   // GitLab commit messages and diffs (server-side sync)
  contentRetentionDays: z.int().min(1).max(365),
  leadsCanViewContent: z.boolean(), // whether team leads may read their own team's captured content
  // On-device repository guard + admin alerting (webhook & dashboard banner).
  outsideRepoMode: GuardMode,
  noRepoMode: GuardMode,
  inactiveDaysAlert: z.int().min(0).max(90),        // 0 disables inactivity alerts
  unaccountedJumpPct: z.int().min(0).max(100),      // 0 disables unaccounted 5h meter jump alerts
  webhookUrl: z.string().max(500).refine((s) => s === '' || /^https?:\/\/.+/.test(s), 'must be an http(s) URL or empty'),
  webhookEvents: z.array(AlertKind).max(10),
  // Devices turn on Claude Code's own marketplace auto-update for this plugin (user settings, no prompts).
  pluginAutoUpdate: z.boolean(),
});
export type PolicyData = z.infer<typeof PolicyData>;

export const DEFAULT_POLICY: PolicyData = {
  batchIntervalSec: 30,
  heartbeatIntervalSec: 60,
  policyRefreshSec: 60,
  retentionDays: 30,
  freshnessThresholdSec: 900,
  displayTimezone: 'Asia/Dhaka',
  workNamespaces: [],
  flagOutsideWorkPct: 40,
  flagNightPct: 25,
  flagSpikeMultiple: 3,
  flagSdkPct: 50,
  flagBypassPct: 25,
  flagNoRepoPct: 60,
  capturePrompts: false,
  captureToolDetails: false,
  captureFileContent: false,
  captureErrors: false,
  captureGitDetails: false,
  contentRetentionDays: 14,
  leadsCanViewContent: false,
  outsideRepoMode: 'off',
  noRepoMode: 'off',
  inactiveDaysAlert: 3,
  unaccountedJumpPct: 15,
  webhookUrl: '',
  webhookEvents: ['plugin_disabled', 'outside_blocked', 'unaccounted_burn', 'inactive_device', 'account_detected'],
  pluginAutoUpdate: true,
};

export const Policy = z.strictObject({ revision: z.int(), data: PolicyData });
export type Policy = z.infer<typeof Policy>;

export const INVITE_PREFIX = 'ccm_inv_';
export const DEVICE_PREFIX = 'ccm_dev_';
export const EnrollRequest = z.strictObject({
  invite: z.string().regex(/^ccm_inv_[A-Za-z0-9_-]{20,80}$/),
  hostname: z.string().max(100).nullish(),
  os: z.string().max(40).nullish(),
  pluginVersion: z.string().max(40).nullish(),
});
export const EnrollResponse = z.strictObject({ installationId: z.int(), token: z.string(), person: z.string() });
export type EnrollResponse = z.infer<typeof EnrollResponse>;

/** Upstream window lengths; boundaries always come from upstream resets_at. */
export const WINDOW_SECONDS: Record<string, number> = {
  five_hour: 5 * 3600,
  seven_day: 7 * 86400,
};
