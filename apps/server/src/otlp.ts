// OTLP/HTTP JSON logs -> allowlisted UsageEvents + ActivityEvents, plus ContentItems only for the content kinds
// the owner switched on (policy capture*). Anything else is dropped here.
import { ActivityEvent, MetricPoint, UsageEvent, type PolicyData } from '@usage-monitor/contracts';
import { redact } from './redact.ts';

export type Capture = Pick<PolicyData, 'capturePrompts' | 'captureToolDetails' | 'captureFileContent' | 'captureErrors'>;
export const NO_CAPTURE: Capture = { capturePrompts: false, captureToolDetails: false, captureFileContent: false, captureErrors: false };
export const CONTENT_KINDS = ['prompt', 'command', 'tool_input', 'error', 'file_read', 'file_write', 'diff', 'output'] as const;
export type ContentItem = {
  sourceEventId: string; sessionId: string | null; kind: (typeof CONTENT_KINDS)[number]; eventTime: string;
  repo: string | null; toolName: string | null; filePath: string | null; branch: string | null; text: string; truncated: boolean;
};
const MAX_TEXT = 64 * 1024;
function item(base: Omit<ContentItem, 'text' | 'truncated' | 'kind' | 'sourceEventId'>, id: string, kind: ContentItem['kind'], raw: unknown, truncated = false): ContentItem | null {
  if (typeof raw !== 'string' || !raw) return null;
  const text = redact(raw).slice(0, MAX_TEXT);
  return { ...base, sourceEventId: `${id}:${kind}`, kind, text, truncated: truncated || raw.length > MAX_TEXT, filePath: base.filePath && redact(base.filePath) };
}

/**
 * Per event, the only attributes kept. Everything content-bearing is absent on purpose: `prompt`,
 * `tool_parameters`, `tool_input`, `error`, `vcs.ref.*`, `workspace.host_paths`, `user.*`.
 */
type OtlpActivity = Exclude<ActivityEvent['eventName'], 'prompt_label'>; // labels only come from /api/agent/labels
export const ACTIVITY_ATTRS: Record<OtlpActivity, string[]> = {
  user_prompt: ['prompt_length', 'command_name', 'command_source'],
  tool_result: ['tool_name', 'success', 'duration_ms', 'decision_type', 'decision_source', 'tool_input_size_bytes', 'tool_result_size_bytes'],
  tool_decision: ['tool_name', 'decision', 'source', 'permission_mode'],
  api_error: ['model', 'status_code', 'attempt', 'query_source'],
  compaction: ['trigger', 'success', 'pre_tokens', 'post_tokens', 'duration_ms'],
  subagent_completed: ['agent_type', 'is_built_in', 'is_async', 'total_tool_uses', 'duration_ms', 'model'],
  skill_activated: ['skill.name', 'invocation_trigger', 'skill.source'],
  permission_mode_changed: ['from_mode', 'to_mode', 'trigger'],
};

/**
 * `vcs.repository.url.full` -> `host/owner/name`. Strips scheme, credentials (`user:token@`) and `.git`,
 * so a remote with an embedded token never gets stored.
 */
export function normalizeRepo(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  const s = u.trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^@/]*@/, '')
    .replace(/^([^/:]+):(?!\d)/, '$1/') // scp-style git@host:owner/repo
    .replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
  return s && s.length <= 200 ? s : null;
}

type AnyValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean };
type KeyValue = { key: string; value?: AnyValue };
export type Attrs = Record<string, string | number | boolean | undefined>;

function flatten(list: KeyValue[] | undefined): Attrs {
  const out: Attrs = {};
  for (const kv of list ?? []) {
    const v = kv.value ?? {};
    out[kv.key] = v.stringValue ?? (v.intValue !== undefined ? Number(v.intValue) : undefined) ?? v.doubleValue ?? v.boolValue;
  }
  return out;
}

const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
const int = (v: unknown) => (typeof v === 'number' ? Math.max(0, Math.trunc(v)) : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : 0);
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' && !isNaN(Number(v)) ? Number(v) : null);

/**
 * Stable identity for one api_request event, used by the server to make retried uploads harmless
 * (`usage_events.source_event_id` is unique; duplicates are silently ignored).
 *
 * Available attributes (Claude Code docs, v2.1.310+): `request_id` (Anthropic API request id),
 * `client_request_id`, `session.id`, `prompt.id`, `event.sequence` (per-session counter),
 * `agent_id`, `event.timestamp`.
 *
 * Return null to drop the event (it will be counted, never guessed).
 */
export function sourceEventId(a: Attrs): string | null {
  // Prefer Anthropic's request id (globally unique); fall back to the per-session counter for
  // versions/paths without it. Prefixes keep the two schemes from ever colliding.
  const req = a['request_id'];
  if (typeof req === 'string' && req) return `req:${req}`;
  const session = a['session.id'];
  const seq = a['event.sequence'];
  if (typeof session === 'string' && session && typeof seq === 'number') return `seq:${session}:${seq}`;
  return null;
}

const eventTime = (a: Attrs, rec: any) => str(a['event.timestamp']) ??
  (rec?.timeUnixNano ? new Date(Number(BigInt(rec.timeUnixNano) / 1_000_000n)).toISOString() : null);

function toActivity(name: OtlpActivity, a: Attrs, rec: any): ActivityEvent | null {
  const session = str(a['session.id']);
  const ts = eventTime(a, rec);
  // event.sequence is per process; timestamp keeps a resumed session's restarted counter from colliding.
  const attrs: ActivityEvent['attrs'] = {};
  for (const k of ACTIVITY_ATTRS[name]) {
    const v = a[k];
    if (typeof v === 'string') attrs[k] = v.slice(0, 100);
    else if (typeof v === 'number' || typeof v === 'boolean') attrs[k] = v;
  }
  const parsed = ActivityEvent.safeParse({
    sourceEventId: `${name}:${session}:${a['event.sequence']}:${ts}`,
    sessionId: session, eventName: name, eventTime: ts, repo: normalizeRepo(a['vcs.repository.url.full']), attrs,
  });
  return parsed.success ? parsed.data : null;
}

/** Content carried by a log event, kept only for switched-on kinds. Bash commands come from tool_parameters. */
function contentOf(name: OtlpActivity, a: Attrs, act: ActivityEvent, cap: Capture): ContentItem[] {
  let params: any = null;
  try { params = typeof a['tool_parameters'] === 'string' ? JSON.parse(a['tool_parameters']) : null; } catch { /* not JSON: kept raw */ }
  // Claude Code reports the branch with commits Claude makes (vcs.ref.head.name, or git_branch in the parameters).
  const branch = cap.captureToolDetails ? str(a['vcs.ref.head.name']) ?? str(params?.git_branch) : null;
  const base = { sessionId: act.sessionId, eventTime: act.eventTime, repo: act.repo, toolName: str(a['tool_name']), filePath: null, branch };
  const out: (ContentItem | null)[] = [];
  const id = act.sourceEventId;
  if (name === 'user_prompt' && cap.capturePrompts) out.push(item(base, id, 'prompt', a['prompt'] ?? a['prompt_text']));
  if (name === 'api_error' && cap.captureErrors) out.push(item(base, id, 'error', a['error']));
  // tool_result has every call; tool_decision adds the ones that were refused and never ran.
  const toolEvent = name === 'tool_result' || (name === 'tool_decision' && a['decision'] !== 'accept');
  if (toolEvent && cap.captureToolDetails) {
    const command = params?.full_command ?? params?.bash_command;
    if (command) out.push(item(base, id, 'command', command)); // tool_input would repeat it
    else {
      out.push(item(base, id, 'tool_input', a['tool_parameters']));
      out.push(item(base, `${id}:in`, 'tool_input', a['tool_input']));
    }
    if (name === 'tool_result') out.push(item(base, id, 'error', a['error']));
  }
  return out.filter((x): x is ContentItem => x !== null);
}

export function parseOtlp(body: unknown, cap: Capture = NO_CAPTURE): { events: UsageEvent[]; activity: ActivityEvent[]; content: ContentItem[]; skipped: number } {
  const events: UsageEvent[] = [];
  const activity: ActivityEvent[] = [];
  const content: ContentItem[] = [];
  let skipped = 0;
  for (const rl of (body as any)?.resourceLogs ?? []) {
    const resource = flatten(rl?.resource?.attributes);
    for (const sl of rl?.scopeLogs ?? []) {
      for (const rec of sl?.logRecords ?? []) {
        const a = { ...resource, ...flatten(rec?.attributes) };
        const name = str(a['event.name']) ?? str(rec?.body?.stringValue)?.replace(/^claude_code\./, '');
        if (name && name in ACTIVITY_ATTRS) {
          const act = toActivity(name as OtlpActivity, a, rec);
          if (act) { activity.push(act); content.push(...contentOf(name as OtlpActivity, a, act, cap)); } else skipped++;
          continue;
        }
        if (name !== 'api_request') continue; // every other event type is not collected at all
        const fp = str(a['monitor.credential_fp']);
        const ts = eventTime(a, rec);
        const candidate = {
          sourceEventId: sourceEventId(a),
          credentialFp: fp && /^[0-9a-f]{64}$/.test(fp) ? fp : null,
          sessionId: str(a['session.id']),
          promptId: str(a['prompt.id']),
          requestId: str(a['request_id']),
          agentId: str(a['agent_id']),
          parentAgentId: str(a['parent_agent_id']),
          model: str(a['model']),
          eventTime: ts,
          inputTokens: int(a['input_tokens']),
          outputTokens: int(a['output_tokens']),
          cacheReadTokens: int(a['cache_read_tokens']),
          cacheCreationTokens: int(a['cache_creation_tokens']),
          costUsd: num(a['cost_usd']),
          durationMs: num(a['duration_ms']) === null ? null : int(a['duration_ms']),
          querySource: str(a['query_source']),
          effort: str(a['effort']),
          speed: str(a['speed']),
          repo: normalizeRepo(a['vcs.repository.url.full']),
          entrypoint: str(a['app.entrypoint']),
        };
        const parsed = UsageEvent.safeParse(candidate);
        if (parsed.success) events.push(parsed.data);
        else skipped++;
      }
    }
  }
  return { events, activity, content, skipped };
}

/** Per metric, the only data-point attributes kept (plus session and repo). */
export const METRIC_ATTRS: Record<MetricPoint['name'], string[]> = {
  'commit.count': [],
  'pull_request.count': [],
  'lines_of_code.count': ['type'],
  'code_edit_tool.decision': ['tool_name', 'decision', 'source', 'language'],
  'active_time.total': ['type'],
  'session.count': ['start_type'],
};
const DELTA = 1;
const nanosToIso = (v: unknown) => {
  try { return new Date(Number(BigInt(String(v)) / 1_000_000n)).toISOString(); } catch { return null; }
};

/** OTLP/HTTP JSON metrics -> allowlisted delta points. Cumulative series are skipped (they'd double count). */
export function parseMetrics(body: unknown): { points: MetricPoint[]; skipped: number } {
  const points: MetricPoint[] = [];
  let skipped = 0;
  for (const rm of (body as any)?.resourceMetrics ?? []) {
    const resource = flatten(rm?.resource?.attributes);
    for (const sm of rm?.scopeMetrics ?? []) {
      for (const m of sm?.metrics ?? []) {
        const name = String(m?.name ?? '').replace(/^claude_code\./, '') as MetricPoint['name'];
        if (!(name in METRIC_ATTRS)) continue; // token/cost come from events; everything else isn't collected
        if (m?.sum?.aggregationTemporality !== DELTA) { skipped += m?.sum?.dataPoints?.length ?? 1; continue; }
        for (const dp of m.sum.dataPoints ?? []) {
          const a = { ...resource, ...flatten(dp?.attributes) };
          const attrs: Record<string, string> = {};
          for (const k of METRIC_ATTRS[name]) if (a[k] !== undefined) attrs[k] = String(a[k]).slice(0, 100);
          const parsed = MetricPoint.safeParse({
            name, sessionId: str(a['session.id']), repo: normalizeRepo(a['vcs.repository.url.full']), attrs,
            startTime: nanosToIso(dp?.startTimeUnixNano), endTime: nanosToIso(dp?.timeUnixNano),
            value: num(dp?.asDouble) ?? num(dp?.asInt) ?? -1,
          });
          if (parsed.success) points.push(parsed.data); else skipped++;
        }
      }
    }
  }
  return { points, skipped };
}

/** Edit diffs arrive as structured-patch JSON ([{oldStart, oldLines, newStart, newLines, lines}]); show them unified. */
export function unifiedDiff(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw.startsWith('[')) return raw;
  try {
    const hunks = JSON.parse(raw);
    if (!Array.isArray(hunks) || !hunks.every((h) => Array.isArray(h?.lines))) return raw;
    return hunks.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}`).join('\n');
  } catch { return raw; } // truncated JSON: keep it as sent
}

const TOOL_OUTPUT_KIND: Record<string, ContentItem['kind']> = { Read: 'file_read', Write: 'file_write', Edit: 'diff', MultiEdit: 'diff' };

/**
 * OTLP/HTTP JSON traces -> file paths, contents, diffs and command output, from the `claude_code.tool` span's
 * `tool.output` event (Claude Code beta tracing). Only when the owner switched file content on.
 */
export function parseTraces(body: unknown, cap: Capture): ContentItem[] {
  if (!cap.captureFileContent) return [];
  const out: ContentItem[] = [];
  for (const rs of (body as any)?.resourceSpans ?? []) {
    const resource = flatten(rs?.resource?.attributes);
    for (const ss of rs?.scopeSpans ?? []) {
      for (const span of ss?.spans ?? []) {
        if (span?.name !== 'claude_code.tool') continue;
        const a = { ...resource, ...flatten(span.attributes) };
        const tool = str(a['tool_name']);
        for (const ev of span.events ?? []) {
          if (ev?.name !== 'tool.output') continue;
          const e = { ...a, ...flatten(ev.attributes) };
          const kind: ContentItem['kind'] = (tool ? TOOL_OUTPUT_KIND[tool] : undefined) ?? 'output';
          const raw = unifiedDiff(e['diff']) ?? e['content'] ?? e['output'];
          const base = {
            sessionId: str(e['session.id']), eventTime: nanosToIso(ev.timeUnixNano ?? span.startTimeUnixNano) ?? new Date().toISOString(),
            repo: normalizeRepo(e['vcs.repository.url.full']), toolName: tool, filePath: str(e['file_path']), branch: null,
          };
          const truncated = ['diff', 'content', 'output'].some((k) => e[`${k}_truncated`] === true || e[`${k}_truncated`] === 'true');
          const it = item(base, `trace:${span.spanId}:${String(ev.timeUnixNano ?? '')}`, kind, raw, truncated);
          if (it) out.push(it);
          else if (base.filePath) out.push({ ...base, sourceEventId: `trace:${span.spanId}:path`, kind, text: '', truncated: false, filePath: redact(base.filePath) });
        }
      }
    }
  }
  return out;
}
