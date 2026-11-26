// High-visibility admin alerting: persistent DB alerts + Slack/Discord/JSON webhook delivery with cooldown.
import type { AlertKind, GuardEvent, PolicyData, QuotaSnapshot, UsageEvent } from '@usage-monitor/contracts';
import type { Sql } from './app.ts';
import { audit } from './audit.ts';

export type WebhookPayload = {
  kind: AlertKind | 'test';
  severity: 'warn' | 'critical' | 'info';
  title: string;
  message: string;
  person?: string | null;
  device?: string | null;
  repo?: string | null;
  occurrences?: number;
  details?: Record<string, unknown>;
  timestamp: string;
};

export type AlertInput = {
  kind: AlertKind;
  severity: 'warn' | 'critical';
  dedupeKey: string;
  teamId?: number | null;
  personId?: number | null;
  installationId?: number | null;
  personName?: string | null;
  deviceName?: string | null;
  repo?: string | null;
  title: string;
  message: string;
  details?: Record<string, unknown>;
};

const WEBHOOK_COOLDOWN_MS = 60 * 60_000;
const PLUGIN_HEARTBEAT_GRACE_MS = 90_000;

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);
function isoWeek(d = new Date()): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((t.getTime() - yearStart.getTime()) / 86400_000) + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function formatWebhookBody(url: string, p: WebhookPayload): Record<string, unknown> {
  const metaFields: { name: string; value: string }[] = [];
  if (p.person) metaFields.push({ name: 'Person', value: p.person });
  if (p.device) metaFields.push({ name: 'Device', value: p.device });
  if (p.repo) metaFields.push({ name: 'Repository', value: p.repo });
  if (p.occurrences && p.occurrences > 1) metaFields.push({ name: 'Occurrences', value: String(p.occurrences) });

  if (/hooks\.slack(-gov)?\.com/i.test(url)) {
    const tag = p.severity === 'critical' ? '[CRITICAL]' : p.severity === 'warn' ? '[WARN]' : '[INFO]';
    const blocks: unknown[] = [
      { type: 'header', text: { type: 'plain_text', text: `${tag} ${p.title}`.slice(0, 150) } },
      { type: 'section', text: { type: 'mrkdwn', text: p.message } },
    ];
    if (metaFields.length) {
      blocks.push({
        type: 'section',
        fields: metaFields.map((m) => ({ type: 'mrkdwn', text: `*${m.name}*\n${m.value}` })),
      });
    }
    return { text: `${tag} ${p.title} — ${p.message}`, blocks };
  }

  if (/discord(app)?\.com\/api\/webhooks/i.test(url)) {
    const color = p.severity === 'critical' ? 0xd94848 : p.severity === 'warn' ? 0xd99b26 : 0x2f855a;
    return {
      content: `**${p.title}**`,
      embeds: [{
        title: p.title,
        description: p.message,
        color,
        fields: metaFields.map((m) => ({ name: m.name, value: m.value, inline: true })),
        timestamp: p.timestamp,
      }],
    };
  }

  return {
    event: p.kind,
    severity: p.severity,
    title: p.title,
    message: p.message,
    person: p.person ?? null,
    device: p.device ?? null,
    repo: p.repo ?? null,
    occurrences: p.occurrences ?? 1,
    details: p.details ?? {},
    timestamp: p.timestamp,
  };
}

export async function sendWebhook(f: typeof fetch, url: string, payload: WebhookPayload): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'claude-usage-monitor/0.5.7' },
      body: JSON.stringify(formatWebhookBody(url, payload)),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message || 'network error' };
  }
}

export async function raiseAlert(sql: Sql, f: typeof fetch, policy: PolicyData, input: AlertInput): Promise<number> {
  const [row] = await sql`
    insert into admin_alerts (kind, severity, dedupe_key, team_id, person_id, installation_id, title, message, details)
    values (${input.kind}, ${input.severity}, ${input.dedupeKey}, ${input.teamId ?? null}, ${input.personId ?? null},
      ${input.installationId ?? null}, ${input.title}, ${input.message}, ${sql.json((input.details ?? {}) as any)})
    on conflict (dedupe_key) do update set
      severity = excluded.severity,
      title = excluded.title,
      message = excluded.message,
      details = excluded.details,
      last_seen_at = now(),
      occurrences = admin_alerts.occurrences + 1,
      acknowledged_at = case
        when admin_alerts.acknowledged_at is not null and admin_alerts.acknowledged_at < now() - interval '30 minutes'
        then null else admin_alerts.acknowledged_at end,
      acknowledged_by_user_id = case
        when admin_alerts.acknowledged_at is not null and admin_alerts.acknowledged_at < now() - interval '30 minutes'
        then null else admin_alerts.acknowledged_by_user_id end
    returning id, occurrences, last_notified_at`;

  const shouldNotify = Boolean(policy.webhookUrl) && policy.webhookEvents.includes(input.kind) && (
    row.last_notified_at === null || Date.now() - (row.last_notified_at as Date).getTime() >= WEBHOOK_COOLDOWN_MS
  );
  if (shouldNotify) {
    await sql`update admin_alerts set last_notified_at = now() where id = ${row.id}`;
    const res = await sendWebhook(f, policy.webhookUrl, {
      kind: input.kind,
      severity: input.severity,
      title: input.title,
      message: input.message,
      person: input.personName ?? null,
      device: input.deviceName ?? null,
      repo: input.repo ?? null,
      occurrences: Number(row.occurrences),
      details: input.details ?? {},
      timestamp: new Date().toISOString(),
    });
    if (!res.ok) {
      await audit(sql, {
        actor: 'system', action: 'webhook.failed',
        personId: input.personId ?? null, installationId: input.installationId ?? null,
        details: { kind: input.kind, status: res.status, error: res.error ?? null },
      });
    }
  }
  return Number(row.id);
}

/**
 * Detector 1: Plugin hooks disabled.
 * OTLP env vars live in ~/.claude/settings.json, so disabling the plugin stops SessionStart (no session_bindings
 * and no heartbeat) while OTLP api_request telemetry keeps arriving.
 */
export async function detectPluginDisabled(
  sql: Sql, f: typeof fetch, policy: PolicyData, instId: number, events: UsageEvent[],
) {
  const sessionIds = [...new Set(events.flatMap((e) => (e.sessionId ? [e.sessionId] : [])))];
  if (!sessionIds.length) return;
  const [inst] = await sql`
    select i.id, i.name as device_name, i.person_id, i.last_heartbeat_at, i.created_at,
      p.name as person_name, p.team_id
    from installations i
    left join people p on p.id = i.person_id
    where i.id = ${instId}`;
  if (!inst) return;
  const refTime = (inst.last_heartbeat_at as Date | null) ?? (inst.created_at as Date);
  if (Date.now() - refTime.getTime() < PLUGIN_HEARTBEAT_GRACE_MS) return;

  const bound = new Set(
    (await sql`select session_id from session_bindings where installation_id = ${instId} and session_id = any(${sessionIds})`)
      .map((r) => r.session_id as string),
  );
  const unbound = sessionIds.filter((s) => !bound.has(s));
  if (!unbound.length) return;

  const who = (inst.person_name as string | null) ?? (inst.device_name as string);
  const lastHb = inst.last_heartbeat_at ? (inst.last_heartbeat_at as Date).toISOString() : 'never';
  await raiseAlert(sql, f, policy, {
    kind: 'plugin_disabled',
    severity: 'critical',
    dedupeKey: `plugin_disabled:inst:${instId}:${utcDay()}`,
    teamId: inst.team_id === null ? null : Number(inst.team_id),
    personId: inst.person_id === null ? null : Number(inst.person_id),
    installationId: instId,
    personName: inst.person_name as string | null,
    deviceName: inst.device_name as string,
    title: `Plugin hooks disabled on ${who}'s device`,
    message: `API telemetry arrived from ${inst.device_name} without a SessionStart binding or recent heartbeat (last heartbeat: ${lastHb}). The usage-monitor plugin may have been disabled in Claude Code.`,
    details: { unboundSessions: unbound.slice(0, 5), lastHeartbeatAt: inst.last_heartbeat_at ? lastHb : null },
  });
}

/** Detector 2: Outside-repo / no-repo / path-escape block or warning reported by plugin hooks. */
export async function recordGuardEvent(
  sql: Sql, f: typeof fetch, policy: PolicyData, instId: number, ev: GuardEvent,
) {
  const [inst] = await sql`
    select i.id, i.name as device_name, i.person_id, p.name as person_name, p.team_id
    from installations i
    left join people p on p.id = i.person_id
    where i.id = ${instId}`;
  const personId = inst?.person_id === null || inst?.person_id === undefined ? null : Number(inst.person_id);
  const teamId = inst?.team_id === null || inst?.team_id === undefined ? null : Number(inst.team_id);
  const who = (inst?.person_name as string | null) ?? (inst?.device_name as string | null) ?? `device #${instId}`;
  const kind: AlertKind = ev.action === 'blocked' ? 'outside_blocked' : 'outside_warned';
  const target = ev.repo ?? 'outside any git repository';

  await audit(sql, {
    actor: 'device',
    action: ev.action === 'blocked' ? 'guard.blocked' : 'guard.warned',
    personId,
    installationId: instId,
    details: { hook: ev.hook, reason: ev.reason, repo: ev.repo, toolName: ev.toolName ?? null },
  });

  const verb = ev.action === 'blocked' ? 'Blocked' : 'Warned';
  const subject = ev.reason === 'path_escape'
    ? `${ev.toolName ?? 'tool'} access escaping to ${target}`
    : ev.reason === 'no_repo'
      ? 'session outside any git repository'
      : `session in outside repository ${target}`;

  await raiseAlert(sql, f, policy, {
    kind,
    severity: ev.action === 'blocked' ? 'critical' : 'warn',
    dedupeKey: `${kind}:inst:${instId}:${ev.repo ?? ev.reason}:${utcDay()}`,
    teamId,
    personId,
    installationId: instId,
    personName: (inst?.person_name as string | null) ?? null,
    deviceName: (inst?.device_name as string | null) ?? null,
    repo: ev.repo,
    title: `${verb} ${who} — ${ev.reason === 'no_repo' ? 'no work repo' : (ev.repo ?? 'outside work')}`,
    message: `${verb} ${who} (${inst?.device_name ?? 'device'}) on ${ev.hook}: ${subject}.`,
    details: { hook: ev.hook, action: ev.action, reason: ev.reason, repo: ev.repo, toolName: ev.toolName ?? null, sessionId: ev.sessionId },
  });
}

/**
 * Detector 3: Unaccounted 5h allowance jump ("ghost burn").
 * If the shared seat's five_hour meter jumps by >= policy.unaccountedJumpPct while almost zero usage
 * was logged by monitored devices in that interval, someone is likely using the setup token off-radar.
 */
export async function detectUnaccountedBurn(
  sql: Sql, f: typeof fetch, policy: PolicyData, s: QuotaSnapshot,
  prev: { usedPct: number; observedAt: Date } | null,
) {
  if (s.meterKey !== 'five_hour' || policy.unaccountedJumpPct <= 0 || !prev) return;
  const delta = Math.round((s.usedPercentage - prev.usedPct) * 100) / 100;
  if (delta < policy.unaccountedJumpPct) return;

  const from = new Date(prev.observedAt.getTime() - 60_000);
  const to = new Date(new Date(s.observedAt).getTime() + 60_000);
  const [measured] = await sql`
    select count(*)::int as requests, coalesce(sum(cost_usd), 0)::float8 as cost
    from usage_events
    where event_time >= ${from} and event_time <= ${to}`;
  if ((measured.cost as number) >= 0.25 || (measured.requests as number) >= 5) return;

  const bucket = Math.floor(s.usedPercentage / 5) * 5;
  await raiseAlert(sql, f, policy, {
    kind: 'unaccounted_burn',
    severity: 'critical',
    dedupeKey: `unaccounted_burn:${s.resetsAt}:${bucket}`,
    teamId: null,
    title: `Unaccounted 5h allowance jump (+${delta}%)`,
    message: `The shared 5-hour allowance jumped from ${prev.usedPct}% to ${s.usedPercentage}% (+${delta}%) with only ${measured.requests} monitored requests ($${(measured.cost as number).toFixed(2)}) recorded. Someone may be using the setup token without the plugin active.`,
    details: {
      previousPct: prev.usedPct, currentPct: s.usedPercentage, deltaPct: delta,
      measuredRequests: measured.requests, measuredCostUsd: measured.cost,
      from: prev.observedAt.toISOString(), to: s.observedAt,
    },
  });
}

/**
 * Detector 4: Inactive / silent enrolled teammates.
 * Runs hourly: flags teammates who previously sent heartbeats but have gone completely silent across all
 * active devices for longer than policy.inactiveDaysAlert days.
 */
export async function checkInactiveDevices(sql: Sql, f: typeof fetch, policy: PolicyData): Promise<number> {
  if (policy.inactiveDaysAlert <= 0) return 0;
  const rows = await sql`
    with per_person as (
      select p.id as person_id, p.name as person_name, p.team_id,
        max(i.last_heartbeat_at) as last_hb,
        max(ev.last_ev) as last_ev,
        (array_agg(i.id order by i.last_heartbeat_at desc nulls last))[1] as latest_inst_id,
        (array_agg(i.name order by i.last_heartbeat_at desc nulls last))[1] as latest_device
      from people p
      join installations i on i.person_id = p.id and i.revoked_at is null
      left join lateral (
        select max(event_time) as last_ev from usage_events where installation_id = i.id
      ) ev on true
      group by p.id
    )
    select person_id, person_name, team_id, latest_inst_id, latest_device,
      greatest(last_hb, coalesce(last_ev, last_hb)) as last_seen
    from per_person
    where last_hb is not null
      and greatest(last_hb, coalesce(last_ev, last_hb)) < now() - make_interval(days => ${policy.inactiveDaysAlert})`;

  let raised = 0;
  const wk = isoWeek();
  for (const r of rows) {
    const days = Math.floor((Date.now() - (r.last_seen as Date).getTime()) / 86400_000);
    await raiseAlert(sql, f, policy, {
      kind: 'inactive_device',
      severity: 'warn',
      dedupeKey: `inactive_device:person:${r.person_id}:${wk}`,
      teamId: r.team_id === null ? null : Number(r.team_id),
      personId: Number(r.person_id),
      installationId: Number(r.latest_inst_id),
      personName: r.person_name as string,
      deviceName: r.latest_device as string,
      title: `No plugin activity from ${r.person_name} for ${days}d`,
      message: `${r.person_name} (${r.latest_device}) has not sent a plugin heartbeat or usage event in ${days} days (threshold: ${policy.inactiveDaysAlert}d). Verify their plugin is still enabled.`,
      details: { lastSeenAt: (r.last_seen as Date).toISOString(), inactiveDays: days, thresholdDays: policy.inactiveDaysAlert },
    });
    raised++;
  }
  return raised;
}
