// OTLP/HTTP JSON logs -> allowlisted UsageEvents + ActivityEvents.
// Only the fields named below ever leave this function; prompts, tool data and paths are never read.
import { ActivityEvent, MetricPoint, UsageEvent } from '@usage-monitor/contracts';

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

export function parseOtlp(body: unknown): { events: UsageEvent[]; activity: ActivityEvent[]; skipped: number } {
  const events: UsageEvent[] = [];
  const activity: ActivityEvent[] = [];
  let skipped = 0;
  for (const rl of (body as any)?.resourceLogs ?? []) {
    const resource = flatten(rl?.resource?.attributes);
    for (const sl of rl?.scopeLogs ?? []) {
      for (const rec of sl?.logRecords ?? []) {
        const a = { ...resource, ...flatten(rec?.attributes) };
        const name = str(a['event.name']) ?? str(rec?.body?.stringValue)?.replace(/^claude_code\./, '');
        if (name && name in ACTIVITY_ATTRS) {
          const act = toActivity(name as OtlpActivity, a, rec);
          if (act) activity.push(act); else skipped++;
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
  return { events, activity, skipped };
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
