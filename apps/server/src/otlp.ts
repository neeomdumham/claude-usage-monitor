// OTLP/HTTP JSON logs -> allowlisted UsageEvents.
// Only the fields named below ever leave this function; prompts, tool data and paths are never read.
import { UsageEvent } from '@usage-monitor/contracts';

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

export function toUsageEvents(body: unknown): { events: UsageEvent[]; skipped: number } {
  const events: UsageEvent[] = [];
  let skipped = 0;
  for (const rl of (body as any)?.resourceLogs ?? []) {
    const resource = flatten(rl?.resource?.attributes);
    for (const sl of rl?.scopeLogs ?? []) {
      for (const rec of sl?.logRecords ?? []) {
        const a = { ...resource, ...flatten(rec?.attributes) };
        const isApiRequest = a['event.name'] === 'api_request' || rec?.body?.stringValue === 'claude_code.api_request';
        if (!isApiRequest) continue; // other event types are not collected at all
        const fp = str(a['monitor.credential_fp']);
        const ts = str(a['event.timestamp']) ??
          (rec?.timeUnixNano ? new Date(Number(BigInt(rec.timeUnixNano) / 1_000_000n)).toISOString() : null);
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
        };
        const parsed = UsageEvent.safeParse(candidate);
        if (parsed.success) events.push(parsed.data);
        else skipped++;
      }
    }
  }
  return { events, skipped };
}
