import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';
import postgres from 'postgres';
import { z } from 'zod';
import {
  AgentBatch, DEFAULT_POLICY, DEVICE_PREFIX, EnrollRequest, GuardEvent, Heartbeat, INVITE_PREFIX, PolicyData, PromptLabel,
  QuotaSnapshot, SessionBinding, WINDOW_SECONDS, type ActivityEvent, type MetricPoint, type UsageEvent,
} from '@usage-monitor/contracts';
import {
  alertAccountDetected, checkInactiveDevices, detectPluginDisabled, detectUnaccountedBurn, recordGuardEvent, sendWebhook,
} from './alerts.ts';
import { analytics, resolveRange } from './analytics.ts';
import { audit } from './audit.ts';
import {
  accountScope, authenticateUser, canAccessPerson, decodeSessionCookie, encodeSessionCookie, hashPassword, inAccounts,
  loadViewer, resolveTeamScope, slugifyTeam, type Viewer,
} from './auth.ts';
import { gitConfigured, runGitSync, type GitSources } from './gitsync.ts';
import { CONTENT_KINDS, parseMetrics, parseOtlp, parseTraces, type ContentItem } from './otlp.ts';
import { profile } from './profile.ts';
import { activityCalendar, listSessions } from './sessions.ts';

export type Sql = ReturnType<typeof postgres>;
export type AppConfig = {
  sql: Sql; ownerPassword: string; ownerEmail?: string; sessionSecret: string; secureCookies: boolean;
  git?: GitSources; fetch?: typeof fetch;
};

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const SESSION_HOURS = 12;
const INVITE_HOURS = 72;
const INVITE_MAX_USES = 2; // e.g. office + home laptop
const ENROLL_FAILS = { max: 5, windowMs: 15 * 60_000 };

export async function migrate(sql: Sql) {
  await sql.unsafe(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  await sql`insert into policies (data) select ${sql.json(DEFAULT_POLICY)} where not exists (select 1 from policies)`;
}

export async function currentPolicy(sql: Sql) {
  const [row] = await sql`select revision, data from policies order by revision desc limit 1`;
  // Defaults first: revisions saved before a field existed still parse.
  return { revision: row.revision as number, data: PolicyData.parse({ ...DEFAULT_POLICY, ...row.data }) };
}

// The plugin ships in this repo; devices reporting an older version are flagged as outdated.
export const PLUGIN_VERSION: string | null = (() => {
  try { return JSON.parse(readFileSync(new URL('../../../plugin/.claude-plugin/plugin.json', import.meta.url), 'utf8')).version; } catch { return null; }
})();

const json = async (c: Context) => c.req.json().catch(() => null);
// The proxy in front (Caddy, nginx) appends the address it saw; earlier entries are whatever the client sent.
const clientIp = (c: Context) => c.req.header('x-forwarded-for')?.split(',').pop()?.trim() || null;

/** Raw-data retention from owner policy; the audit log keeps a year. Run hourly by main.ts. */
export async function cleanup(sql: Sql) {
  const cutoff = sql`now() - make_interval(days => (select (data->>'retentionDays')::int from policies order by revision desc limit 1))`;
  await sql`delete from usage_events where event_time < ${cutoff}`;
  await sql`delete from activity_events where event_time < ${cutoff}`;
  await sql`delete from metric_points where end_time < ${cutoff}`;
  await sql`delete from git_commits where committed_at < ${cutoff}`;
  await sql`delete from quota_snapshots where last_observed_at < ${cutoff}`;
  const contentCutoff = sql`now() - make_interval(days => (select coalesce((data->>'contentRetentionDays')::int, 14) from policies order by revision desc limit 1))`;
  await sql`delete from content_events where event_time < ${contentCutoff}`;
  await sql`update git_commits set message = null, diff = null where committed_at < ${contentCutoff} and (message is not null or diff is not null)`;
  await sql`delete from audit_log where at < now() - interval '365 days'`;
}

export function createApp({ sql, ownerPassword, ownerEmail = 'owner@local', sessionSecret, secureCookies, git = {}, fetch: f = fetch }: AppConfig) {
  const app = new Hono<{ Variables: { installationId: number; viewer: Viewer } }>();
  app.use('/api/*', bodyLimit({ maxSize: 1024 * 1024 }));
  app.use('/v1/*', bodyLimit({ maxSize: 5 * 1024 * 1024 })); // OTLP batches
  app.get('/api/health', (c) => c.json({ ok: true }));

  // ---------- admin auth (superadmin + team_lead; password-only login stays backward compatible) ----------
  app.post('/api/auth/login', async (c) => {
    const body = z.object({ email: z.string().max(200).optional(), password: z.string() }).safeParse(await json(c));
    const viewer = body.success
      ? await authenticateUser(sql, ownerPassword, ownerEmail, body.data.email, body.data.password)
      : null;
    const ip = clientIp(c);
    await audit(sql, {
      actor: 'owner', action: viewer ? 'auth.login' : 'auth.login_failed', userId: viewer?.id ?? null,
      details: { ip, email: viewer?.email ?? (body.success ? body.data.email ?? null : null) },
    });
    if (!viewer) return c.json({ error: 'invalid credentials' }, 401);
    const expires = Date.now() + SESSION_HOURS * 3600_000;
    await setSignedCookie(c, 'owner', encodeSessionCookie(viewer.id, expires), sessionSecret, {
      httpOnly: true, sameSite: 'Strict', secure: secureCookies, path: '/', maxAge: SESSION_HOURS * 3600,
    });
    return c.json({ ok: true, viewer });
  });
  app.post('/api/auth/logout', (c) => { deleteCookie(c, 'owner', { path: '/' }); return c.json({ ok: true }); });

  const requireViewer = async (c: Context, next: Next) => {
    const raw = await getSignedCookie(c, sessionSecret, 'owner');
    const session = typeof raw === 'string' ? decodeSessionCookie(raw) : null;
    if (!session) return c.json({ error: 'owner login required' }, 401);
    const viewer = await loadViewer(sql, session.uid);
    if (!viewer) return c.json({ error: 'owner login required' }, 401);
    c.set('viewer', viewer);
    await next();
  };
  const requireSuperadmin = async (c: Context, next: Next) => {
    if (c.get('viewer').role !== 'superadmin') return c.json({ error: 'superadmin access required' }, 403);
    await next();
  };

  app.get('/api/auth/me', requireViewer, (c) => c.json({ viewer: c.get('viewer') }));

  // ---------- installation auth: identity comes only from the bearer credential ----------
  const requireInstallation = async (c: Context, next: Next) => {
    const token = c.req.header('authorization')?.match(/^Bearer (\S+)$/)?.[1];
    if (!token) return c.json({ error: 'unauthorized' }, 401);
    const [row] = await sql`select id from installations where token_hash = ${sha256(token)} and revoked_at is null`;
    if (!row) return c.json({ error: 'unauthorized' }, 401);
    c.set('installationId', Number(row.id));
    await next();
  };

  // ---------- enrollment: the plugin trades an invite for a device token ----------
  // ponytail: in-memory failure counter keyed on the proxy-reported address; move to Postgres if the server ever
  // runs >1 instance. Without a proxy every caller shares the 'direct' bucket.
  const fails = new Map<string, { n: number; until: number }>();
  app.post('/api/enroll', async (c) => {
    const ip = clientIp(c) ?? 'direct';
    const f = fails.get(ip);
    if (f && f.until > Date.now() && f.n >= ENROLL_FAILS.max) return c.json({ error: 'too many attempts, try later' }, 429);
    const deny = async () => {
      await audit(sql, { actor: 'system', action: 'device.join_failed', details: { ip: ip === 'direct' ? null : ip } });
      const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + ENROLL_FAILS.windowMs };
      fails.set(ip, { ...cur, n: cur.n + 1 });
      return c.json({ error: 'invite invalid, used up or expired' }, 401); // one message: never say which
    };
    const body = EnrollRequest.safeParse(await json(c));
    if (!body.success) return await deny();
    const { invite, hostname, os, pluginVersion } = body.data;
    const token = DEVICE_PREFIX + randomBytes(32).toString('base64url');
    const result = await sql.begin(async (tx) => {
      // Atomic: two concurrent redemptions can't both take the last use.
      const [inv] = await tx`
        update invites set uses = uses + 1
        where secret_hash = ${sha256(invite)} and uses < max_uses and expires_at > now() and revoked_at is null
        returning person_id, target_installation_id, account_id`;
      if (!inv) return null;
      let instId: number;
      let reconnected = false;
      if (inv.target_installation_id !== null) {
        const [inst] = await tx`
          update installations
          set token_hash = ${sha256(token)},
              revoked_at = null,
              hostname = coalesce(${hostname ?? null}, hostname),
              os = coalesce(${os ?? null}, os),
              joined_ip = coalesce(${ip === 'direct' ? null : ip}, joined_ip),
              client_version = coalesce(${pluginVersion ?? null}, client_version),
              account_id = coalesce(${inv.account_id}::bigint, account_id)
          where id = ${inv.target_installation_id}
          returning id`;
        if (!inst) return null;
        instId = Number(inst.id);
        reconnected = true;
      } else {
        const [inst] = await tx`
          insert into installations (name, token_hash, person_id, hostname, os, joined_ip, client_version, account_id)
          values (${hostname || 'device'}, ${sha256(token)}, ${inv.person_id}, ${hostname ?? null}, ${os ?? null},
            ${ip === 'direct' ? null : ip}, ${pluginVersion ?? null}, ${inv.account_id})
          returning id`;
        instId = Number(inst.id);
      }
      const [p] = await tx`select name from people where id = ${inv.person_id}`;
      return { installationId: instId, token, person: p.name as string, personId: Number(inv.person_id), reconnected };
    });
    if (!result) return await deny();
    fails.delete(ip);
    const { personId, reconnected, ...reply } = result;
    await audit(sql, {
      actor: 'device', action: reconnected ? 'device.reconnected' : 'device.joined', personId, installationId: result.installationId,
      details: { hostname: hostname ?? null, os: os ?? null, ip: ip === 'direct' ? null : ip, pluginVersion: pluginVersion ?? null, reconnected },
    });
    return c.json(reply);
  });

  // ---------- agent API ----------
  app.use('/api/agent/*', requireInstallation);

  app.post('/api/agent/events', async (c) => {
    const body = AgentBatch.safeParse(await json(c));
    if (!body.success) return c.json({ error: 'invalid batch', issues: body.error.issues.slice(0, 5) }, 400);
    const inst = c.get('installationId');
    const { snapshots } = body.data;
    const events = body.data.events.map((e) => ({ ...e, accountKey: null })); // account keys come from OTLP only
    // A status-line reading carries no account; it belongs to the account the device last reported (stamped now,
    // never re-resolved later). ponytail: right after a device switches accounts, one reading can land on the old
    // account until its next OTLP export (~5s); previous-reading lookups go by resets_at, so no false ghost burn.
    const [dev] = await sql`select account_id from installations where id = ${inst}`;
    const accountId = dev.account_id === null ? null : Number(dev.account_id);
    const prevFiveHour = await previousFiveHourSnapshots(sql, snapshots, accountId);
    let inserted = 0;
    await sql.begin(async (tx) => {
      inserted = await ingestEvents(tx as unknown as Sql, inst, events);
      for (const s of snapshots) await upsertSnapshot(tx as unknown as Sql, s, inst, accountId);
    });
    const policy = (await currentPolicy(sql)).data;
    if (events.length) await detectPluginDisabled(sql, f, policy, inst, events);
    for (const s of snapshots) {
      if (s.meterKey === 'five_hour') {
        await detectUnaccountedBurn(sql, f, policy, s, prevFiveHour.get(s.resetsAt) ?? null, accountId);
      }
    }
    return c.json({ accepted: events.length, inserted, snapshots: snapshots.length });
  });

  // Plugin SessionStart hook: "this Claude Code session runs on credential X" (or unknown).
  app.post('/api/agent/sessions', async (c) => {
    const body = SessionBinding.safeParse(await json(c));
    if (!body.success) return c.json({ error: 'invalid session binding' }, 400);
    const inst = c.get('installationId');
    const credId = body.data.credentialFp ? await upsertCredential(sql, inst, body.data.credentialFp) : null;
    await sql`
      insert into session_bindings (session_id, installation_id, credential_id)
      values (${body.data.sessionId}, ${inst}, ${credId})
      on conflict (session_id) do update set credential_id = excluded.credential_id
      where session_bindings.installation_id = excluded.installation_id`;
    return c.json({ ok: true });
  });

  app.post('/api/agent/heartbeat', async (c) => {
    const body = Heartbeat.safeParse(await json(c));
    if (!body.success) return c.json({ error: 'invalid heartbeat' }, 400);
    const h = body.data;
    const instId = c.get('installationId');
    await sql`
      update installations set last_heartbeat_at = now(), client_version = ${h.clientVersion},
        applied_policy_revision = ${h.appliedPolicyRevision}, capabilities = ${sql.json(h.capabilities)},
        queue_depth = ${h.queueDepth}, dropped_count = ${h.droppedCount}
      where id = ${instId}`;
    // A fresh heartbeat proves hooks are active again: auto-clear any open plugin_disabled alert for this device.
    await sql`
      update admin_alerts set acknowledged_at = now()
      where installation_id = ${instId} and kind = 'plugin_disabled' and acknowledged_at is null`;
    return c.json({ ok: true });
  });

  app.get('/api/agent/policy', async (c) => {
    const pol = await currentPolicy(sql);
    const inst = c.get('installationId');
    const [teamRow] = await sql`
      select t.work_namespaces
      from installations i
      join people p on p.id = i.person_id
      join teams t on t.id = p.team_id
      where i.id = ${inst}`;
    const teamNs = (teamRow?.work_namespaces as string[] | undefined) ?? [];
    const workNamespaces = [...new Set([...pol.data.workNamespaces, ...teamNs])];
    return c.json({ revision: pol.revision, data: { ...pol.data, workNamespaces } });
  });

  // On-device repository guard telemetry (warned or blocked outside-work attempt).
  app.post('/api/agent/guard', async (c) => {
    const body = GuardEvent.safeParse(await json(c));
    if (!body.success) return c.json({ error: 'invalid guard event' }, 400);
    const inst = c.get('installationId');
    const ev = body.data;
    const at = new Date();
    const attrs: Record<string, string | number | boolean> = {
      hook: ev.hook, action: ev.action, reason: ev.reason,
      ...(ev.toolName ? { tool_name: ev.toolName } : {}),
    };
    await ingestActivity(sql, inst, [{
      sourceEventId: `guard:${randomBytes(12).toString('hex')}`, sessionId: ev.sessionId,
      eventName: 'guard_event', eventTime: at.toISOString(), repo: ev.repo, attrs,
    }]);
    await recordGuardEvent(sql, f, (await currentPolicy(sql)).data, inst, ev);
    return c.json({ ok: true });
  });

  // On-device prompt classifier result: a category only. The prompt text is never sent.
  app.post('/api/agent/labels', async (c) => {
    const body = PromptLabel.safeParse(await json(c));
    if (!body.success) return c.json({ error: 'invalid label' }, 400);
    const at = new Date();
    await ingestActivity(sql, c.get('installationId'), [{
      sourceEventId: `label:${randomBytes(12).toString('hex')}`, sessionId: body.data.sessionId,
      eventName: 'prompt_label', eventTime: at.toISOString(), repo: null, attrs: { category: body.data.category },
    }]);
    const [i] = await sql`select person_id from installations where id = ${c.get('installationId')}`;
    await audit(sql, { actor: 'device', action: 'prompt.labelled', personId: i?.person_id === null ? null : Number(i?.person_id), installationId: c.get('installationId'), details: { category: body.data.category } });
    return c.json({ ok: true });
  });

  app.use('/v1/*', requireInstallation);
  app.post('/v1/logs', async (c) => {
    if (!(c.req.header('content-type') ?? '').includes('json')) return c.json({ error: 'use http/json' }, 415);
    const body = await json(c);
    if (!body) return c.json({ error: 'invalid json' }, 400);
    // Allowlist: identity attributes never get past here; content only for kinds the owner switched on *now*.
    const policy = (await currentPolicy(sql)).data;
    const { events, activity, content } = parseOtlp(body, policy);
    if (events.length || activity.length || content.length) {
      const inst = c.get('installationId');
      const created = await sql.begin(async (tx) => {
        const accounts = await resolveAccounts(tx as unknown as Sql, inst, events);
        await ingestEvents(tx as unknown as Sql, inst, events, accounts.ids);
        await ingestActivity(tx as unknown as Sql, inst, activity);
        await ingestContent(tx as unknown as Sql, inst, content);
        return accounts.created;
      });
      for (const id of created) await alertAccountDetected(sql, f, policy, id, inst); // after commit: may send a webhook
      if (events.length) await detectPluginDisabled(sql, f, policy, inst, events);
    }
    return c.json({});
  });

  // Beta tracing: file paths, contents, diffs and command output. Dropped unless file content capture is on.
  app.post('/v1/traces', async (c) => {
    if (!(c.req.header('content-type') ?? '').includes('json')) return c.json({ error: 'use http/json' }, 415);
    const body = await json(c);
    if (!body) return c.json({ error: 'invalid json' }, 400);
    await ingestContent(sql, c.get('installationId'), parseTraces(body, (await currentPolicy(sql)).data));
    return c.json({});
  });

  app.post('/v1/metrics', async (c) => {
    if (!(c.req.header('content-type') ?? '').includes('json')) return c.json({ error: 'use http/json' }, 415);
    const body = await json(c);
    if (!body) return c.json({ error: 'invalid json' }, 400);
    const { points } = parseMetrics(body); // allowlist; cumulative series are skipped
    if (points.length) await ingestMetrics(sql, c.get('installationId'), points);
    return c.json({});
  });

  // ---------- dashboard API (superadmin + team_lead, scoped by team) ----------
  app.use('/api/dashboard/*', requireViewer);

  app.get('/api/dashboard/overview', async (c) => {
    const viewer = c.get('viewer');
    const scope = resolveTeamScope(viewer, c.req.query('teamId'));
    const all = scope.teamIds === null;
    const tids = scope.teamIds ?? [];
    const policy = await currentPolicy(sql);
    const now = Date.now() / 1000;
    const acct = await accountScope(sql, scope.teamIds, c.req.query('accountId'));
    // Latest reading per account and meter: accounts never overwrite each other.
    const meters = (await sql`
      select distinct on (account_id, meter_key) account_id, meter_key, label, used_percentage::float8 as pct,
        extract(epoch from resets_at)::float8 as resets_at, last_observed_at, source
      from quota_snapshots where ${inAccounts(sql, 'account_id', acct)}
      order by account_id, meter_key, last_observed_at desc`).map((m) => ({
      accountId: m.account_id === null ? null : Number(m.account_id),
      meterKey: m.meter_key as string,
      label: m.label as string | null,
      usedPercentage: m.pct as number,
      resetsAt: m.resets_at as number,
      observedAt: (m.last_observed_at as Date).toISOString(),
      source: m.source as string,
      expired: (m.resets_at as number) <= now, // window rolled over; value unknown until next reading
      stale: now - (m.last_observed_at as Date).getTime() / 1000 > policy.data.freshnessThresholdSec,
    }));
    const accounts = await accountCards(sql, acct, meters, scope.teamIds);

    const window = c.req.query('window') ?? 'seven_day';
    const live = meters.filter((m) => m.meterKey === window && !m.expired);
    let ranking = null; // null = window boundary unknown
    if (live.length && WINDOW_SECONDS[window]) {
      // Several accounts reset at different times: rank over the span covering all their current windows.
      const start = new Date((Math.min(...live.map((m) => m.resetsAt)) - WINDOW_SECONDS[window]) * 1000);
      const end = new Date(Math.max(...live.map((m) => m.resetsAt)) * 1000);
      ranking = rankPeople(await sql`
        with ev as (
          select e.*, coalesce(e.credential_id, sb.credential_id) as cred_id
          from usage_events e
          left join session_bindings sb on sb.session_id = e.session_id and sb.installation_id = e.installation_id
          where e.event_time >= ${start} and e.event_time < ${end}
        )
        select i.person_id, p.name as person_name,
          case when i.person_id is null then i.id end as inst_id,
          case when i.person_id is null then i.name end as installation_name,
          count(*)::int as requests,
          sum(ev.input_tokens)::float8 as input_tokens, sum(ev.output_tokens)::float8 as output_tokens,
          sum(ev.cache_read_tokens)::float8 as cache_read_tokens,
          sum(ev.cache_creation_tokens)::float8 as cache_creation_tokens,
          coalesce(sum(ev.cost_usd), 0)::float8 as est_cost_usd,
          coalesce(array_agg(distinct left(c.fingerprint, 12)) filter (where c.fingerprint is not null), '{}') as fps
        from ev
        join installations i on i.id = ev.installation_id
        left join people p on p.id = i.person_id
        left join credentials c on c.id = ev.cred_id
        where (${all} or p.team_id = any(${tids}::bigint[]))
        group by 1, 2, 3, 4 order by est_cost_usd desc, output_tokens desc`);
    }

    const installations = (await sql`
      select i.id, i.name, i.person_id, i.hostname, i.os, i.joined_ip, i.created_at, i.last_heartbeat_at, i.applied_policy_revision,
        i.capabilities, i.client_version, i.queue_depth, i.dropped_count, i.revoked_at, i.account_id, a.label as account_label
      from installations i left join people p on p.id = i.person_id left join accounts a on a.id = i.account_id
      where (${all} or p.team_id = any(${tids}::bigint[]))
      order by i.id`).map((i) => ({
      id: Number(i.id), name: i.name, personId: i.person_id === null ? null : Number(i.person_id),
      hostname: i.hostname, os: i.os, joinedIp: i.joined_ip, joinedAt: i.created_at.toISOString(),
      lastHeartbeatAt: i.last_heartbeat_at?.toISOString() ?? null,
      appliedPolicyRevision: i.applied_policy_revision, capabilities: i.capabilities,
      clientVersion: i.client_version, queueDepth: i.queue_depth, droppedCount: i.dropped_count,
      revoked: i.revoked_at !== null,
      accountId: i.account_id === null ? null : Number(i.account_id), accountLabel: (i.account_label as string | null) ?? null,
    }));

    const people = (await sql`
      select p.id, p.name, p.team_id, t.name as team_name, p.created_at, p.git_emails, inv.expires_at, inv.uses, inv.max_uses
      from people p
      left join teams t on t.id = p.team_id
      left join lateral (
        select expires_at, uses, max_uses from invites
        where person_id = p.id and revoked_at is null and expires_at > now() and uses < max_uses
        order by created_at desc limit 1
      ) inv on true
      where (${all} or p.team_id = any(${tids}::bigint[]))
      order by p.id`).map((p) => ({
      id: Number(p.id), name: p.name as string,
      teamId: p.team_id === null ? null : Number(p.team_id), teamName: (p.team_name as string | null) ?? null,
      createdAt: p.created_at.toISOString(), gitEmails: p.git_emails as string[],
      openInvite: p.expires_at ? { expiresAt: p.expires_at.toISOString(), uses: p.uses, maxUses: p.max_uses } : null,
    }));

    const teamFilter = viewer.role === 'superadmin';
    const teams = (await sql`
      select t.id, t.name, t.slug, t.work_namespaces, t.created_at,
        count(distinct p.id)::int as member_count,
        coalesce(array_agg(distinct u.name) filter (where u.id is not null and u.disabled_at is null), '{}') as lead_names
      from teams t
      left join people p on p.team_id = t.id
      left join user_teams ut on ut.team_id = t.id
      left join users u on u.id = ut.user_id and u.role = 'team_lead'
      where (${teamFilter} or t.id = any(${viewer.teamIds}::bigint[]))
      group by t.id order by t.name`).map((t) => ({
      id: Number(t.id), name: t.name as string, slug: t.slug as string,
      workNamespaces: t.work_namespaces as string[], createdAt: t.created_at.toISOString(),
      memberCount: t.member_count as number, leadNames: t.lead_names as string[],
    }));

    return c.json({ viewer, teams, policy, meters, accounts, window, ranking, installations, people, latestPluginVersion: PLUGIN_VERSION });
  });

  // ---------- teams & dashboard admins ----------
  app.get('/api/dashboard/teams', async (c) => {
    const viewer = c.get('viewer');
    const allTeams = viewer.role === 'superadmin';
    const rows = await sql`
      select t.id, t.name, t.slug, t.work_namespaces, t.created_at,
        count(distinct p.id)::int as member_count,
        coalesce(array_agg(distinct u.name) filter (where u.id is not null and u.disabled_at is null), '{}') as lead_names
      from teams t
      left join people p on p.team_id = t.id
      left join user_teams ut on ut.team_id = t.id
      left join users u on u.id = ut.user_id and u.role = 'team_lead'
      where (${allTeams} or t.id = any(${viewer.teamIds}::bigint[]))
      group by t.id order by t.name`;
    return c.json({
      teams: rows.map((t) => ({
        id: Number(t.id), name: t.name as string, slug: t.slug as string,
        workNamespaces: t.work_namespaces as string[], createdAt: t.created_at.toISOString(),
        memberCount: t.member_count as number, leadNames: t.lead_names as string[],
      })),
    });
  });

  app.post('/api/dashboard/teams', requireSuperadmin, async (c) => {
    const body = z.strictObject({
      name: z.string().trim().min(1).max(60),
      workNamespaces: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
    }).safeParse(await json(c));
    if (!body.success) return c.json({ error: 'team name required' }, 400);
    const ns = (body.data.workNamespaces ?? []).map((l) => l.toLowerCase().replace(/^https?:\/\//, ''));
    const base = slugifyTeam(body.data.name);
    let slug = base;
    for (let i = 2; (await sql`select 1 from teams where slug = ${slug}`).length > 0; i++) slug = `${base}-${i}`;
    const [row] = await sql`insert into teams (name, slug, work_namespaces) values (${body.data.name}, ${slug}, ${ns}) returning id, name, slug, work_namespaces, created_at`;
    await audit(sql, { actor: 'owner', action: 'team.created', userId: c.get('viewer').id, details: { teamId: Number(row.id), name: row.name } });
    return c.json({ id: Number(row.id), name: row.name, slug: row.slug, workNamespaces: row.work_namespaces, createdAt: row.created_at.toISOString() }, 201);
  });

  app.patch('/api/dashboard/teams/:id', requireSuperadmin, async (c) => {
    const body = z.strictObject({
      name: z.string().trim().min(1).max(60).optional(),
      workNamespaces: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
    }).refine((d) => d.name !== undefined || d.workNamespaces !== undefined).safeParse(await json(c));
    if (!body.success) return c.json({ error: 'invalid team update' }, 400);
    const id = Number(c.req.param('id'));
    const [cur] = await sql`select id, name, work_namespaces from teams where id = ${id}`;
    if (!cur) return c.json({ error: 'not found' }, 404);
    const nextName = body.data.name ?? (cur.name as string);
    const nextNs = body.data.workNamespaces !== undefined
      ? body.data.workNamespaces.map((l) => l.toLowerCase().replace(/^https?:\/\//, ''))
      : (cur.work_namespaces as string[]);
    await sql`update teams set name = ${nextName}, work_namespaces = ${nextNs} where id = ${id}`;
    await audit(sql, { actor: 'owner', action: 'team.updated', userId: c.get('viewer').id, details: { teamId: id, name: nextName } });
    return c.json({ ok: true });
  });

  app.delete('/api/dashboard/teams/:id', requireSuperadmin, async (c) => {
    const id = Number(c.req.param('id'));
    const moveTo = c.req.query('moveTo') ? Number(c.req.query('moveTo')) : null; // else members become unassigned
    const [cur] = await sql`select name from teams where id = ${id}`;
    if (!cur) return c.json({ error: 'not found' }, 404);
    if (moveTo !== null && (moveTo === id || !(await sql`select 1 from teams where id = ${moveTo}`).length)) return c.json({ error: 'invalid moveTo team' }, 400);
    await sql.begin(async (tx) => {
      if (moveTo !== null) {
        await tx`update people set team_id = ${moveTo} where team_id = ${id}`;
        await tx`update accounts set team_id = ${moveTo} where team_id = ${id}`;
      }
      await tx`delete from teams where id = ${id}`;
    });
    await audit(sql, { actor: 'owner', action: 'team.deleted', userId: c.get('viewer').id, details: { teamId: id, name: cur.name, moveTo } });
    return c.json({ ok: true });
  });

  app.get('/api/dashboard/users', requireSuperadmin, async (c) => {
    const rows = await sql`
      select u.id, u.email, u.name, u.role, u.disabled_at, u.created_at,
        coalesce(array_agg(ut.team_id order by ut.team_id) filter (where ut.team_id is not null), '{}') as team_ids
      from users u
      left join user_teams ut on ut.user_id = u.id
      group by u.id order by u.role desc, u.name`;
    return c.json({
      users: rows.map((u) => ({
        id: Number(u.id), email: u.email as string, name: u.name as string, role: u.role as 'superadmin' | 'team_lead',
        teamIds: (u.team_ids as (number | string)[]).map(Number),
        disabled: u.disabled_at !== null, createdAt: u.created_at.toISOString(),
      })),
    });
  });

  app.post('/api/dashboard/users', requireSuperadmin, async (c) => {
    const body = z.strictObject({
      email: z.email().max(200),
      name: z.string().trim().min(1).max(60),
      password: z.string().min(8).max(200),
      role: z.enum(['superadmin', 'team_lead']),
      teamIds: z.array(z.int().positive()).max(50).optional(),
    }).safeParse(await json(c));
    if (!body.success) return c.json({ error: 'valid email, name, role and password (8+ chars) required' }, 400);
    const email = body.data.email.trim().toLowerCase();
    const teamIds = [...new Set(body.data.teamIds ?? [])];
    try {
      const created = await sql.begin(async (tx) => {
        const [u] = await tx`
          insert into users (email, name, password_hash, role)
          values (${email}, ${body.data.name}, ${hashPassword(body.data.password)}, ${body.data.role})
          returning id, email, name, role, created_at`;
        if (teamIds.length) {
          for (const tid of teamIds) {
            await tx`insert into user_teams (user_id, team_id) values (${u.id}, ${tid}) on conflict do nothing`;
          }
        }
        return u;
      });
      await audit(sql, { actor: 'owner', action: 'user.created', userId: c.get('viewer').id, details: { targetUserId: Number(created.id), email, role: created.role, teamIds } });
      return c.json({ id: Number(created.id), email: created.email, name: created.name, role: created.role, teamIds, disabled: false, createdAt: created.created_at.toISOString() }, 201);
    } catch (e: any) {
      if (e?.code === '23505') return c.json({ error: 'email already exists' }, 409);
      if (e?.code === '23503') return c.json({ error: 'invalid team id' }, 400);
      throw e;
    }
  });

  app.patch('/api/dashboard/users/:id', requireSuperadmin, async (c) => {
    const body = z.strictObject({
      name: z.string().trim().min(1).max(60).optional(),
      email: z.string().trim().email().max(200).optional(),
      role: z.enum(['superadmin', 'team_lead']).optional(),
      teamIds: z.array(z.int().positive()).max(50).optional(),
      password: z.string().min(8).max(200).optional(),
      disabled: z.boolean().optional(),
    }).safeParse(await json(c));
    if (!body.success) return c.json({ error: 'invalid user update' }, 400);
    const id = Number(c.req.param('id'));
    const viewer = c.get('viewer');
    const [cur] = await sql`select id, email, name, role, disabled_at from users where id = ${id}`;
    if (!cur) return c.json({ error: 'not found' }, 404);
    if (id === viewer.id && (body.data.disabled === true || body.data.role === 'team_lead')) {
      return c.json({ error: 'cannot disable or demote your own superadmin account' }, 400);
    }
    const demotingOrDisabling = cur.role === 'superadmin' && cur.disabled_at === null &&
      (body.data.disabled === true || body.data.role === 'team_lead');
    if (demotingOrDisabling) {
      const [{ n }] = await sql`select count(*)::int as n from users where role = 'superadmin' and disabled_at is null`;
      if (n <= 1) return c.json({ error: 'at least one active superadmin is required' }, 400);
    }
    const nextEmail = body.data.email !== undefined ? body.data.email.toLowerCase() : undefined;
    try {
      await sql.begin(async (tx) => {
        if (body.data.name !== undefined) await tx`update users set name = ${body.data.name} where id = ${id}`;
        if (nextEmail !== undefined) await tx`update users set email = ${nextEmail} where id = ${id}`;
        if (body.data.role !== undefined) await tx`update users set role = ${body.data.role} where id = ${id}`;
        if (body.data.password !== undefined) await tx`update users set password_hash = ${hashPassword(body.data.password)} where id = ${id}`;
        if (body.data.disabled !== undefined) await tx`update users set disabled_at = ${body.data.disabled ? tx`now()` : null} where id = ${id}`;
        if (body.data.teamIds !== undefined) {
          await tx`delete from user_teams where user_id = ${id}`;
          for (const tid of [...new Set(body.data.teamIds)]) {
            await tx`insert into user_teams (user_id, team_id) values (${id}, ${tid}) on conflict do nothing`;
          }
        }
      });
    } catch (e: any) {
      if (e?.code === '23505') return c.json({ error: 'email already exists' }, 409);
      if (e?.code === '23503') return c.json({ error: 'invalid team id' }, 400);
      throw e;
    }
    await audit(sql, { actor: 'owner', action: 'user.updated', userId: viewer.id, details: { targetUserId: id, email: nextEmail ?? cur.email, role: body.data.role ?? cur.role, disabled: body.data.disabled } });
    return c.json({ ok: true });
  });

  // ---------- Claude accounts (one per seat/login; owned by a team or shared) ----------
  app.get('/api/dashboard/accounts', async (c) => {
    const viewer = c.get('viewer');
    const scope = resolveTeamScope(viewer, c.req.query('teamId'));
    const acct = await accountScope(sql, scope.teamIds);
    const rows = await sql`
      select a.id, a.label, a.team_id, t.name as team_name, a.account_key is not null as detected, a.created_at,
        (select max(last_observed_at) from quota_snapshots q where q.account_id = a.id) as last_reading_at,
        coalesce((select json_agg(json_build_object('id', i.id, 'name', i.name, 'personId', i.person_id, 'personName', p.name, 'teamId', p.team_id) order by i.id)
          from installations i left join people p on p.id = i.person_id
          where i.account_id = a.id and i.revoked_at is null), '[]') as devices
      from accounts a left join teams t on t.id = a.team_id
      where ${inAccounts(sql, 'a.id', acct)} order by a.id`;
    const [un] = await sql`
      select count(*)::int as devices from installations i left join people p on p.id = i.person_id
      where i.account_id is null and i.revoked_at is null and (${scope.teamIds === null} or p.team_id = any(${scope.teamIds ?? []}::bigint[]))`;
    const mine = (teamId: number | null) => viewer.role === 'superadmin' || (teamId !== null && viewer.teamIds.includes(teamId));
    return c.json({
      accounts: rows.map((r) => {
        const teamId = r.team_id === null ? null : Number(r.team_id);
        // Leads see other teams' devices on a shared account only as a count, never who.
        const devices = (r.devices as any[]).map((d) => ({ ...d, teamId: d.teamId === null ? null : Number(d.teamId) }));
        const visible = devices.filter((d) => viewer.role === 'superadmin' || (d.teamId !== null && viewer.teamIds.includes(d.teamId)));
        return {
          id: Number(r.id), label: r.label as string, teamId, teamName: (r.team_name as string | null) ?? null,
          detected: r.detected as boolean, createdAt: (r.created_at as Date).toISOString(),
          lastReadingAt: r.last_reading_at ? (r.last_reading_at as Date).toISOString() : null,
          devices: visible, otherTeamDevices: devices.length - visible.length, canEdit: mine(teamId),
        };
      }),
      unattributedDevices: un.devices as number,
    });
  });

  const AccountBody = z.strictObject({ label: z.string().trim().min(1).max(60), teamId: z.int().positive().nullable().optional() });
  app.post('/api/dashboard/accounts', async (c) => {
    const viewer = c.get('viewer');
    const body = AccountBody.safeParse(await json(c));
    if (!body.success) return c.json({ error: 'account name required' }, 400);
    let teamId = body.data.teamId ?? null;
    if (viewer.role === 'team_lead') {
      teamId ??= viewer.teamIds.length === 1 ? viewer.teamIds[0] : null;
      if (teamId === null || !viewer.teamIds.includes(teamId)) return c.json({ error: 'pick one of your teams' }, 403);
    }
    try {
      const [row] = await sql`insert into accounts (label, team_id) values (${body.data.label}, ${teamId}) returning id`;
      await audit(sql, { actor: 'owner', action: 'account.created', userId: viewer.id, details: { accountId: Number(row.id), label: body.data.label, teamId } });
      return c.json({ id: Number(row.id), label: body.data.label, teamId }, 201);
    } catch (e: any) {
      if (e?.code === '23503') return c.json({ error: 'invalid team id' }, 400);
      throw e;
    }
  });

  // Leads rename their own teams' accounts; only superadmins move an account to another team (or make it shared).
  app.patch('/api/dashboard/accounts/:id', async (c) => {
    const viewer = c.get('viewer');
    const body = AccountBody.partial().refine((d) => d.label !== undefined || d.teamId !== undefined).safeParse(await json(c));
    if (!body.success) return c.json({ error: 'label or teamId required' }, 400);
    const id = Number(c.req.param('id'));
    const [cur] = await sql`select label, team_id from accounts where id = ${id}`;
    if (!cur) return c.json({ error: 'not found' }, 404);
    const curTeam = cur.team_id === null ? null : Number(cur.team_id);
    if (viewer.role === 'team_lead' && (curTeam === null || !viewer.teamIds.includes(curTeam) || body.data.teamId !== undefined)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    try {
      await sql`update accounts set label = ${body.data.label ?? cur.label},
        team_id = ${body.data.teamId === undefined ? curTeam : body.data.teamId} where id = ${id}`;
    } catch (e: any) {
      if (e?.code === '23503') return c.json({ error: 'invalid team id' }, 400);
      throw e;
    }
    await audit(sql, { actor: 'owner', action: 'account.updated', userId: viewer.id, details: { accountId: id, from: cur.label, label: body.data.label ?? cur.label, teamId: body.data.teamId } });
    return c.json({ ok: true });
  });

  // Readings and requests from before account detection have no account. Give each one its device's current
  // account. Superadmin only and explicit: a device that switched accounts mid-window would be misfiled.
  app.post('/api/dashboard/accounts/attribute', requireSuperadmin, async (c) => {
    const result = await sql.begin(async (tx) => {
      const snaps = await tx`
        update quota_snapshots q set account_id = i.account_id from installations i
        where q.account_id is null and q.observer_installation_id = i.id and i.account_id is not null
          and not exists (select 1 from quota_snapshots d where d.account_id = i.account_id and d.meter_key = q.meter_key
            and d.resets_at = q.resets_at and d.used_percentage = q.used_percentage)`;
      // What's left for an attributed device duplicates a reading its account already has.
      await tx`delete from quota_snapshots q using installations i
        where q.account_id is null and q.observer_installation_id = i.id and i.account_id is not null`;
      const events = await tx`
        update usage_events e set account_id = i.account_id from installations i
        where e.account_id is null and e.installation_id = i.id and i.account_id is not null`;
      return { readings: snaps.count, requests: events.count };
    });
    await audit(sql, { actor: 'owner', action: 'account.attributed', userId: c.get('viewer').id, details: result });
    return c.json(result);
  });

  // Invite a new person ({name, teamId?}), another device for an existing person ({personId}),
  // or a single-use reconnect link that refreshes an existing device's token in place ({installationId}).
  // The plaintext token is returned once; the dashboard builds the link from its own origin.
  app.post('/api/dashboard/invites', async (c) => {
    const viewer = c.get('viewer');
    const accountId = z.int().positive().nullable().optional(); // which Claude account the new device will use
    const body = z.union([
      z.strictObject({ name: z.string().trim().min(1).max(60), teamId: z.int().positive().nullable().optional(), accountId }),
      z.strictObject({ personId: z.int(), accountId }),
      z.strictObject({ installationId: z.int().positive() }),
    ]).safeParse(await json(c));
    if (!body.success) return c.json({ error: 'name, personId or installationId required' }, 400);
    const inviteAccount = 'accountId' in body.data ? body.data.accountId ?? null : null;
    if (inviteAccount !== null) {
      const visible = await accountScope(sql, viewer.role === 'superadmin' ? null : viewer.teamIds);
      if (!visible.all && !visible.ids.includes(inviteAccount)) return c.json({ error: 'forbidden account' }, 403);
      if (!(await sql`select 1 from accounts where id = ${inviteAccount}`).length) return c.json({ error: 'unknown account' }, 400);
    }

    let resolvedTeamId: number | null = null;
    let targetInstallationId: number | null = null;
    let targetDeviceName: string | null = null;
    let existingPersonId: number | null = null;

    if ('installationId' in body.data) {
      const [inst] = await sql`select id, person_id, name from installations where id = ${body.data.installationId}`;
      if (!inst) return c.json({ error: 'device not found' }, 404);
      if (inst.person_id === null) return c.json({ error: 'device is not linked to a person' }, 400);
      existingPersonId = Number(inst.person_id);
      if (!(await canAccessPerson(sql, viewer, existingPersonId))) return c.json({ error: 'forbidden' }, 403);
      targetInstallationId = Number(inst.id);
      targetDeviceName = inst.name as string;
    } else if ('personId' in body.data) {
      existingPersonId = body.data.personId;
      if (!(await canAccessPerson(sql, viewer, existingPersonId))) return c.json({ error: 'forbidden' }, 403);
    } else {
      if (viewer.role === 'team_lead') {
        if (!viewer.teamIds.length) return c.json({ error: 'no team assigned to this lead' }, 403);
        const reqTeam = body.data.teamId ?? (viewer.teamIds.length === 1 ? viewer.teamIds[0] : null);
        if (reqTeam === null) return c.json({ error: 'teamId required' }, 400);
        if (!viewer.teamIds.includes(reqTeam)) return c.json({ error: 'forbidden team' }, 403);
        resolvedTeamId = reqTeam;
      } else {
        resolvedTeamId = body.data.teamId ?? null;
      }
    }

    const token = INVITE_PREFIX + randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_HOURS * 3600_000);
    const maxUses = targetInstallationId !== null ? 1 : INVITE_MAX_USES;
    const isNew = 'name' in body.data;
    const personId = await sql.begin(async (tx) => {
      const pid = existingPersonId !== null
        ? (await tx`select id from people where id = ${existingPersonId}`)[0]?.id
        : (await tx`insert into people (name, team_id) values (${(body.data as { name: string }).name}, ${resolvedTeamId}) returning id`)[0].id;
      if (!pid) return null;
      if (targetInstallationId !== null) {
        // Replace any prior pending reconnect invite for this exact device without cancelling other invites.
        await tx`update invites set revoked_at = now() where target_installation_id = ${targetInstallationId} and revoked_at is null`;
      } else {
        // A fresh person invite replaces any older general link for that person.
        await tx`update invites set revoked_at = now() where person_id = ${pid} and target_installation_id is null and revoked_at is null`;
      }
      await tx`insert into invites (secret_hash, person_id, max_uses, expires_at, created_by_user_id, target_installation_id, account_id)
        values (${sha256(token)}, ${pid}, ${maxUses}, ${expiresAt}, ${viewer.id}, ${targetInstallationId}, ${inviteAccount})`;
      return Number(pid);
    });
    if (personId === null) return c.json({ error: 'not found' }, 404);
    if (isNew) await audit(sql, { actor: 'owner', action: 'person.added', userId: viewer.id, personId, details: { name: (body.data as { name: string }).name, teamId: resolvedTeamId } });
    await audit(sql, {
      actor: 'owner', action: 'invite.created', userId: viewer.id, personId, installationId: targetInstallationId,
      details: { maxUses, expiresAt: expiresAt.toISOString(), accountId: inviteAccount, ...(targetInstallationId !== null ? { reconnectDevice: targetDeviceName } : {}) },
    });
    return c.json({
      personId, token, expiresAt: expiresAt.toISOString(), maxUses,
      ...(targetInstallationId !== null ? { installationId: targetInstallationId, deviceName: targetDeviceName } : {}),
    });
  });

  app.delete('/api/dashboard/people/:id/invites', async (c) => {
    const id = Number(c.req.param('id'));
    if (!(await canAccessPerson(sql, c.get('viewer'), id))) return c.json({ error: 'forbidden' }, 403);
    const res = await sql`update invites set revoked_at = now() where person_id = ${id} and revoked_at is null`;
    if (res.count) await audit(sql, { actor: 'owner', action: 'invite.cancelled', userId: c.get('viewer').id, personId: id });
    return c.json({ ok: true });
  });

  // People nobody has put in a team yet. Leads see only enough to claim someone (no usage).
  app.get('/api/dashboard/people/unassigned', async (c) => {
    const rows = await sql`
      select p.id, p.name, p.created_at, count(i.id) filter (where i.revoked_at is null)::int as devices
      from people p left join installations i on i.person_id = p.id
      where p.team_id is null group by p.id order by p.name`;
    return c.json({ people: rows.map((r) => ({ id: Number(r.id), name: r.name as string, createdAt: (r.created_at as Date).toISOString(), devices: r.devices as number })) });
  });

  // Superadmins move anyone. A lead renames and moves people within their teams, and claims unassigned people
  // into one of their teams (atomic: two leads can't both take the same person).
  app.patch('/api/dashboard/people/:id', async (c) => {
    const viewer = c.get('viewer');
    const id = Number(c.req.param('id'));
    const body = z.strictObject({
      name: z.string().trim().min(1).max(60).optional(),
      teamId: z.int().positive().nullable().optional(),
    }).refine((d) => d.name !== undefined || d.teamId !== undefined).safeParse(await json(c));
    if (!body.success) return c.json({ error: 'name or teamId required' }, 400);
    const lead = viewer.role === 'team_lead';
    const claimOnly = lead && body.data.name === undefined; // a team move alone may target an unassigned person
    if (!claimOnly && !(await canAccessPerson(sql, viewer, id))) return c.json({ error: 'forbidden' }, 403);
    if (body.data.teamId !== undefined && lead && (body.data.teamId === null || !viewer.teamIds.includes(body.data.teamId))) {
      return c.json({ error: 'forbidden team' }, 403);
    }
    const [old] = await sql`select p.name, p.team_id, t.name as team_name from people p left join teams t on t.id = p.team_id where p.id = ${id}`;
    if (!old) return c.json({ error: lead ? 'forbidden' : 'not found' }, lead ? 403 : 404);
    if (body.data.teamId !== undefined) {
      const moved = await sql`
        update people set team_id = ${body.data.teamId} where id = ${id}
          and (${!lead} or team_id is null or team_id = any(${viewer.teamIds}::bigint[]))
        returning (select name from teams where id = people.team_id) as team_name`;
      if (!moved.length) return c.json({ error: 'already in another team; ask a superadmin to move them' }, 409);
      await audit(sql, {
        actor: 'owner', action: 'person.team_changed', userId: viewer.id, personId: id,
        details: { from: old.team_id === null ? null : Number(old.team_id), to: body.data.teamId,
          fromName: (old.team_name as string | null) ?? null, toName: (moved[0].team_name as string | null) ?? null },
      });
    }
    if (body.data.name !== undefined) {
      await sql`update people set name = ${body.data.name} where id = ${id}`;
      await audit(sql, { actor: 'owner', action: 'person.renamed', userId: viewer.id, personId: id, details: { from: old.name, to: body.data.name } });
    }
    return c.json({ ok: true });
  });

  app.get('/api/dashboard/analytics', async (c) => {
    const scope = resolveTeamScope(c.get('viewer'), c.req.query('teamId'));
    const range = c.req.query('range') ?? 'window';
    const acct = await accountScope(sql, scope.teamIds, c.req.query('accountId'));
    return c.json(await analytics(sql, range, (await currentPolicy(sql)).data, gitConfigured(git), scope.teamIds, acct));
  });

  app.get('/api/dashboard/sessions', async (c) => {
    const scope = resolveTeamScope(c.get('viewer'), c.req.query('teamId'));
    const q = c.req.query();
    const sort = q.sort === 'cost' || q.sort === 'effort' ? q.sort : 'recent';
    const data = await listSessions(sql, (await currentPolicy(sql)).data, {
      rangeKey: q.range ?? 'window',
      teamIds: scope.teamIds,
      acct: await accountScope(sql, scope.teamIds, q.accountId, q.personId ? Number(q.personId) : null),
      personId: q.personId ? Number(q.personId) : null,
      repo: q.repo || null,
      effort: q.effort || null,
      sort,
      limit: q.limit ? Number(q.limit) : 50,
    });
    return c.json(data);
  });

  app.get('/api/dashboard/activity/calendar', async (c) => {
    const scope = resolveTeamScope(c.get('viewer'), c.req.query('teamId'));
    const q = c.req.query();
    const year = q.year ? Number(q.year) : null;
    const data = await activityCalendar(sql, (await currentPolicy(sql)).data, {
      year: Number.isFinite(year) ? year : null,
      teamIds: scope.teamIds,
      personId: q.personId ? Number(q.personId) : null,
    });
    return c.json(data);
  });

  app.put('/api/dashboard/people/:id/git-emails', async (c) => {
    const id = Number(c.req.param('id'));
    if (!(await canAccessPerson(sql, c.get('viewer'), id))) return c.json({ error: 'forbidden' }, 403);
    const body = z.strictObject({ emails: z.array(z.email().max(200)).max(10) }).safeParse(await json(c));
    if (!body.success) return c.json({ error: 'list valid email addresses' }, 400);
    const emails = [...new Set(body.data.emails.map((e) => e.toLowerCase()))];
    const res = await sql`update people set git_emails = ${emails} where id = ${id}`;
    if (res.count) await audit(sql, { actor: 'owner', action: 'person.git_emails', userId: c.get('viewer').id, personId: id, details: { emails: emails.length } });
    return res.count ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.post('/api/dashboard/git/sync', requireSuperadmin, async (c) => {
    if (!gitConfigured(git)) return c.json({ error: 'No commit sync is configured (GITLAB_TOKEN + GITLAB_GROUP, or GITHUB_TOKEN + GITHUB_ORG)' }, 400);
    try {
      const { retentionDays, captureGitDetails } = (await currentPolicy(sql)).data;
      return c.json(await runGitSync(sql, git, f, retentionDays, 'owner', captureGitDetails));
    } catch (e) {
      return c.json({ error: String((e as Error).message) }, 502);
    }
  });

  // Audit log: newest first, filterable, keyset-paged by id. CSV export uses the same filters.
  const auditQuery = (q: Record<string, string | undefined>, limit: number, teamIds: number[] | null) => {
    const text = q.q?.trim() ? `%${q.q.trim()}%` : null;
    const all = teamIds === null;
    const tids = teamIds ?? [];
    return sql`
      select a.id, a.at, a.actor, a.action, a.user_id, a.person_id, a.installation_id, a.details,
        u.name as user_name, p.name as person, i.name as device
      from audit_log a
      left join users u on u.id = a.user_id
      left join people p on p.id = a.person_id
      left join installations i on i.id = a.installation_id
      where (${all} or p.team_id = any(${tids}::bigint[]))
        and (${q.action ?? null}::text is null or a.action = ${q.action ?? null})
        and (${q.personId ?? null}::bigint is null or a.person_id = ${q.personId ? Number(q.personId) : null})
        and (${q.from ?? null}::date is null or a.at >= ${q.from ?? null}::date)
        and (${q.to ?? null}::date is null or a.at < ${q.to ?? null}::date + 1)
        and (${q.before ?? null}::bigint is null or a.id < ${q.before ? Number(q.before) : null})
        and (${text}::text is null or a.action ilike ${text} or a.details::text ilike ${text} or p.name ilike ${text} or i.name ilike ${text})
      order by a.id desc limit ${limit}`;
  };
  const auditRow = (r: any) => ({
    id: Number(r.id), at: r.at.toISOString(), actor: r.actor, action: r.action,
    userName: (r.user_name as string | null) ?? null,
    personId: r.person_id === null ? null : Number(r.person_id), person: r.person,
    installationId: r.installation_id === null ? null : Number(r.installation_id), device: r.device, details: r.details,
  });
  app.get('/api/dashboard/audit', async (c) => {
    const scope = resolveTeamScope(c.get('viewer'), c.req.query('teamId'));
    const all = scope.teamIds === null;
    const tids = scope.teamIds ?? [];
    const limit = Math.min(200, Number(c.req.query('limit') ?? 100) || 100);
    const rows = (await auditQuery(c.req.query(), limit, scope.teamIds)).map(auditRow);
    const actions = (await sql`
      select distinct a.action from audit_log a left join people p on p.id = a.person_id
      where (${all} or p.team_id = any(${tids}::bigint[])) order by 1`).map((r) => r.action as string);
    const [{ n }] = await sql`
      select count(*)::int as n from audit_log a left join people p on p.id = a.person_id
      where (${all} or p.team_id = any(${tids}::bigint[]))`;
    return c.json({ events: rows, actions, total: n });
  });
  app.get('/api/dashboard/audit.csv', async (c) => {
    const scope = resolveTeamScope(c.get('viewer'), c.req.query('teamId'));
    const rows = (await auditQuery(c.req.query(), 10_000, scope.teamIds)).map(auditRow);
    const esc = (v: unknown) => {
      let t = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
      if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; // spreadsheets evaluate these even when quoted; the apostrophe makes them text
      return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const csv = ['time,actor,action,person,device,details', ...rows.map((r) =>
      [r.at, r.actor, r.action, r.person, r.device, r.details].map(esc).join(','))].join('\n');
    return c.body(csv, 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="audit-log.csv"' });
  });

  // Captured content, newest first. Filters: personId, installationId, kind, repo, q (text/path search), before (id).
  app.get('/api/dashboard/content', async (c) => {
    const viewer = c.get('viewer');
    const policy = (await currentPolicy(sql)).data;
    if (viewer.role === 'team_lead' && !policy.leadsCanViewContent) {
      return c.json({ error: 'captured content is restricted to superadmins' }, 403);
    }
    const scope = resolveTeamScope(viewer, c.req.query('teamId'));
    const all = scope.teamIds === null;
    const tids = scope.teamIds ?? [];
    const q = c.req.query();
    const limit = Math.min(200, Number(q.limit ?? 50) || 50);
    const text = q.q?.trim() ? `%${q.q.trim()}%` : null;
    const rows = await sql`
      select e.id, e.event_time, e.kind, e.session_id, e.repo, e.tool_name, e.file_path, e.branch, e.text, e.truncated,
        e.installation_id, i.name as device, i.person_id, p.name as person
      from content_events e join installations i on i.id = e.installation_id left join people p on p.id = i.person_id
      where (${all} or p.team_id = any(${tids}::bigint[]))
        and (${q.personId ?? null}::bigint is null or i.person_id = ${q.personId ? Number(q.personId) : null})
        and (${q.installationId ?? null}::bigint is null or e.installation_id = ${q.installationId ? Number(q.installationId) : null})
        and (${q.sessionId ?? null}::text is null or e.session_id = ${q.sessionId ?? null})
        and (${q.kind ?? null}::text is null or e.kind = ${q.kind ?? null})
        and (${q.repo ?? null}::text is null or e.repo = ${q.repo ?? null})
        and (${q.before ?? null}::bigint is null or e.id < ${q.before ? Number(q.before) : null})
        and (${text}::text is null or e.text ilike ${text} or e.file_path ilike ${text})
      order by e.id desc limit ${limit}`;
    return c.json({
      items: rows.map((r) => ({
        id: Number(r.id), eventTime: r.event_time.toISOString(), kind: r.kind, sessionId: r.session_id, repo: r.repo,
        toolName: r.tool_name, filePath: r.file_path, branch: r.branch, text: r.text, truncated: r.truncated,
        installationId: Number(r.installation_id), device: r.device,
        personId: r.person_id === null ? null : Number(r.person_id), person: r.person,
      })),
      kinds: CONTENT_KINDS,
      capture: { prompts: policy.capturePrompts, toolDetails: policy.captureToolDetails, fileContent: policy.captureFileContent,
        errors: policy.captureErrors, gitDetails: policy.captureGitDetails, retentionDays: policy.contentRetentionDays },
    });
  });

  // GitLab/GitHub commits strictly scoped to enrolled teammates (INNER JOIN people). Filter: range, personId, repo, before.
  app.get('/api/dashboard/commits', async (c) => {
    const scope = resolveTeamScope(c.get('viewer'), c.req.query('teamId'));
    const all = scope.teamIds === null;
    const tids = scope.teamIds ?? [];
    const q = c.req.query();
    const range = q.range
      ? await resolveRange(sql, q.range, (await currentPolicy(sql)).data.displayTimezone,
        await accountScope(sql, scope.teamIds, q.accountId, q.personId ? Number(q.personId) : null))
      : null;
    const rows = await sql`
      select g.repo, g.sha, g.author_email, g.committed_at, g.additions, g.deletions, g.message, g.diff, p.id as person_id, p.name as person
      from git_commits g join people p on g.author_email = any(p.git_emails)
      where (${all} or p.team_id = any(${tids}::bigint[]))
        and (${q.personId ?? null}::bigint is null or p.id = ${q.personId ? Number(q.personId) : null})
        and (${q.repo ?? null}::text is null or g.repo = ${q.repo ?? null})
        and (${range ? range.start : null}::timestamptz is null or g.committed_at >= ${range ? range.start : null})
        and (${range ? range.end : null}::timestamptz is null or g.committed_at < ${range ? range.end : null})
        and (${q.before ?? null}::timestamptz is null or g.committed_at < ${q.before ?? null}::timestamptz)
      order by g.committed_at desc limit 50`;
    return c.json({ commits: rows.map((r) => ({
      repo: r.repo, sha: r.sha, authorEmail: r.author_email, committedAt: r.committed_at.toISOString(),
      additions: r.additions, deletions: r.deletions, message: r.message, diff: r.diff,
      personId: Number(r.person_id), person: r.person as string,
    })) });
  });

  // Owner/lead reviews a flag ("talked to them"): hidden for a week, back if the pattern continues.
  app.post('/api/dashboard/flags/review', async (c) => {
    const viewer = c.get('viewer');
    const body = z.strictObject({ key: z.string().min(1).max(200), note: z.string().max(500).default('') }).safeParse(await json(c));
    if (!body.success) return c.json({ error: 'invalid review' }, 400);
    const pid = Number(body.data.key.split(':')[0]);
    if (viewer.role === 'team_lead' && !(pid > 0 && await canAccessPerson(sql, viewer, pid))) {
      return c.json({ error: 'forbidden' }, 403);
    }
    await sql`insert into flag_reviews (flag_key, note) values (${body.data.key}, ${body.data.note})
      on conflict (flag_key) do update set note = excluded.note, reviewed_at = now()`;
    await audit(sql, { actor: 'owner', action: 'flag.reviewed', userId: viewer.id, personId: pid > 0 ? pid : null, details: { flag: body.data.key.split(':').slice(1).join(':'), note: body.data.note } });
    return c.json({ ok: true });
  });

  app.get('/api/dashboard/people/:id/profile', async (c) => {
    const id = Number(c.req.param('id'));
    if (!(await canAccessPerson(sql, c.get('viewer'), id))) return c.json({ error: 'forbidden' }, 403);
    const p = await profile(sql, id, (await currentPolicy(sql)).data, c.req.query('range') ?? 'window');
    return p ? c.json(p) : c.json({ error: 'not found' }, 404);
  });

  app.patch('/api/dashboard/installations/:id', async (c) => {
    const viewer = c.get('viewer');
    const body = z.strictObject({ name: z.string().min(1).max(60).optional(), revoked: z.boolean().optional() })
      .safeParse(await json(c));
    if (!body.success) return c.json({ error: 'invalid request' }, 400);
    const id = Number(c.req.param('id'));
    const [dev] = await sql`select name, person_id from installations where id = ${id}`;
    if (!dev) return c.json({ error: 'not found' }, 404);
    const personId = dev.person_id === null ? null : Number(dev.person_id);
    if (!(await canAccessPerson(sql, viewer, personId))) return c.json({ error: 'forbidden' }, 403);
    const who = { userId: viewer.id, personId, installationId: id };
    if (body.data.name) {
      await sql`update installations set name = ${body.data.name} where id = ${id}`;
      await audit(sql, { actor: 'owner', action: 'device.renamed', ...who, details: { from: dev.name, to: body.data.name } });
    }
    if (body.data.revoked !== undefined) {
      await sql`update installations set revoked_at = ${body.data.revoked ? sql`now()` : null} where id = ${id}`;
      await audit(sql, { actor: 'owner', action: body.data.revoked ? 'device.removed' : 'device.restored', ...who, details: { device: dev.name } });
    }
    return c.json({ ok: true });
  });

  // ---------- admin alerts (loud dashboard banner + webhook test/ack) ----------
  app.get('/api/dashboard/alerts', async (c) => {
    const viewer = c.get('viewer');
    const scope = resolveTeamScope(viewer, c.req.query('teamId'));
    const all = scope.teamIds === null;
    const tids = scope.teamIds ?? [];
    const includeAck = c.req.query('includeAcknowledged') === 'true';
    const rows = await sql`
      select a.id, a.kind, a.severity, a.team_id, t.name as team_name, a.person_id, p.name as person_name,
        a.installation_id, i.name as device_name, a.title, a.message, a.details,
        a.created_at, a.last_seen_at, a.occurrences, a.last_notified_at, a.acknowledged_at,
        u.name as acknowledged_by
      from admin_alerts a
      left join teams t on t.id = a.team_id
      left join people p on p.id = a.person_id
      left join installations i on i.id = a.installation_id
      left join users u on u.id = a.acknowledged_by_user_id
      where (${all} or a.team_id = any(${tids}::bigint[]))
        and (${includeAck} or a.acknowledged_at is null)
      order by a.acknowledged_at is not null, a.severity = 'critical' desc, a.last_seen_at desc
      limit 100`;
    const [{ n }] = await sql`
      select count(*)::int as n from admin_alerts a
      where (${all} or a.team_id = any(${tids}::bigint[])) and a.acknowledged_at is null`;
    return c.json({
      unacknowledgedCount: n,
      alerts: rows.map((r) => ({
        id: Number(r.id),
        kind: r.kind as string,
        severity: r.severity as 'warn' | 'critical',
        teamId: r.team_id === null ? null : Number(r.team_id),
        teamName: (r.team_name as string | null) ?? null,
        personId: r.person_id === null ? null : Number(r.person_id),
        personName: (r.person_name as string | null) ?? null,
        installationId: r.installation_id === null ? null : Number(r.installation_id),
        deviceName: (r.device_name as string | null) ?? null,
        title: r.title as string,
        message: r.message as string,
        details: r.details,
        createdAt: (r.created_at as Date).toISOString(),
        lastSeenAt: (r.last_seen_at as Date).toISOString(),
        occurrences: r.occurrences as number,
        lastNotifiedAt: r.last_notified_at ? (r.last_notified_at as Date).toISOString() : null,
        acknowledgedAt: r.acknowledged_at ? (r.acknowledged_at as Date).toISOString() : null,
        acknowledgedBy: (r.acknowledged_by as string | null) ?? null,
      })),
    });
  });

  app.post('/api/dashboard/alerts/:id/ack', async (c) => {
    const viewer = c.get('viewer');
    const id = Number(c.req.param('id'));
    const [cur] = await sql`select id, kind, team_id, person_id from admin_alerts where id = ${id}`;
    if (!cur) return c.json({ error: 'not found' }, 404);
    const tid = cur.team_id === null ? null : Number(cur.team_id);
    if (viewer.role === 'team_lead' && (tid === null || !viewer.teamIds.includes(tid))) {
      return c.json({ error: 'forbidden' }, 403);
    }
    await sql`update admin_alerts set acknowledged_at = now(), acknowledged_by_user_id = ${viewer.id} where id = ${id}`;
    await audit(sql, {
      actor: 'owner', action: 'alert.acknowledged', userId: viewer.id,
      personId: cur.person_id === null ? null : Number(cur.person_id),
      details: { alertId: id, kind: cur.kind },
    });
    return c.json({ ok: true });
  });

  app.post('/api/dashboard/alerts/test-webhook', requireSuperadmin, async (c) => {
    const body = z.strictObject({
      url: z.string().max(500).refine((s) => s === '' || /^https?:\/\/.+/.test(s), 'must be an http(s) URL').optional(),
    }).safeParse(await json(c) ?? {});
    if (!body.success) return c.json({ error: 'invalid webhook URL' }, 400);
    const targetUrl = body.data.url || (await currentPolicy(sql)).data.webhookUrl;
    if (!targetUrl) return c.json({ error: 'no webhook URL configured' }, 400);
    const res = await sendWebhook(f, targetUrl, {
      kind: 'test',
      severity: 'info',
      title: 'Test alert from claude-usage-monitor',
      message: `Webhook verified by ${c.get('viewer').name}. High-priority alerts (disabled plugin hooks, blocked outside-work sessions, unaccounted quota jumps) will be delivered here.`,
      timestamp: new Date().toISOString(),
    });
    await audit(sql, {
      actor: 'owner', action: res.ok ? 'webhook.tested' : 'webhook.failed',
      userId: c.get('viewer').id, details: { status: res.status, ok: res.ok, error: res.error ?? null },
    });
    return res.ok ? c.json({ ok: true, status: res.status }) : c.json({ error: res.error ?? `HTTP ${res.status}`, status: res.status }, 502);
  });

  app.post('/api/dashboard/quota-snapshots', requireSuperadmin, async (c) => {
    const body = QuotaSnapshot.omit({ source: true, observedAt: true })
      .extend({ accountId: z.int().positive().nullable().optional() }).safeParse(await json(c));
    if (!body.success) return c.json({ error: 'invalid snapshot' }, 400);
    const { accountId = null, ...reading } = body.data;
    if (accountId !== null && !(await sql`select 1 from accounts where id = ${accountId}`).length) return c.json({ error: 'unknown account' }, 400);
    const snap: QuotaSnapshot = { ...reading, source: 'manual', observedAt: new Date().toISOString() };
    const prev = await previousFiveHourSnapshots(sql, [snap], accountId);
    await upsertSnapshot(sql, snap, null, accountId);
    if (snap.meterKey === 'five_hour') {
      await detectUnaccountedBurn(sql, f, (await currentPolicy(sql)).data, snap, prev.get(snap.resetsAt) ?? null, accountId);
    }
    await audit(sql, { actor: 'owner', action: 'reading.entered', userId: c.get('viewer').id, details: { meter: reading.meterKey, pct: reading.usedPercentage, accountId } });
    return c.json({ ok: true });
  });

  app.patch('/api/dashboard/policy', requireSuperadmin, async (c) => {
    const current = await currentPolicy(sql);
    const next = PolicyData.safeParse({ ...current.data, ...(await json(c)) });
    if (!next.success) return c.json({ error: 'invalid policy', issues: next.error.issues }, 400);
    const [row] = await sql`insert into policies (data) values (${sql.json(next.data)}) returning revision`;
    const changed = Object.keys(next.data).filter((k) => JSON.stringify((next.data as any)[k]) !== JSON.stringify((current.data as any)[k]));
    await audit(sql, { actor: 'owner', action: 'settings.changed', userId: c.get('viewer').id, details: { revision: row.revision, changed } });
    return c.json({ revision: row.revision, data: next.data });
  });

  return app;
}

async function upsertCredential(sql: Sql, inst: number, fp: string): Promise<number> {
  const [cred] = await sql`
    insert into credentials (fingerprint) values (${fp})
    on conflict (fingerprint) do update set last_seen_at = now() returning id`;
  await sql`
    insert into credential_bindings (installation_id, credential_id) values (${inst}, ${cred.id})
    on conflict (installation_id, credential_id) do update set last_seen_at = now()`;
  return Number(cred.id);
}

/**
 * Map each account key in a batch to an account: a known key keeps its account; the device's own account (set by
 * its invite) learns its key from the first one reported; anything else becomes a new "Unlabeled account N" owned
 * by the person's team. The device's current account follows its newest event.
 */
async function resolveAccounts(sql: Sql, inst: number, events: UsageEvent[]) {
  const ids = new Map<string, number>();
  const created: number[] = [];
  let newest: UsageEvent | null = null;
  for (const e of events) if (e.accountKey && (!newest || e.eventTime > newest.eventTime)) newest = e;
  for (const key of new Set(events.flatMap((e) => (e.accountKey ? [e.accountKey] : [])))) {
    const [known] = await sql`select id from accounts where account_key = ${key}`;
    if (known) { ids.set(key, Number(known.id)); continue; }
    const [claimed] = await sql`
      update accounts set account_key = ${key}
      where account_key is null and id = (select account_id from installations where id = ${inst}) returning id`;
    if (claimed) { ids.set(key, Number(claimed.id)); continue; }
    const [row] = await sql`
      insert into accounts (label, team_id, account_key)
      select 'Unlabeled account ' || (select count(*) + 1 from accounts), p.team_id, ${key}
      from installations i left join people p on p.id = i.person_id where i.id = ${inst}
      on conflict (account_key) do update set account_key = excluded.account_key
      returning id, (xmax = 0) as inserted`;
    ids.set(key, Number(row.id));
    if (row.inserted) created.push(Number(row.id));
  }
  if (newest) await sql`update installations set account_id = ${ids.get(newest.accountKey!)!} where id = ${inst}`;
  return { ids, created };
}

/** Insert allowlisted events; retried deliveries are no-ops via source_event_id. Returns rows inserted. */
async function ingestEvents(sql: Sql, inst: number, events: UsageEvent[], accountIds = new Map<string, number>()): Promise<number> {
  if (!events.length) return 0;
  const credIds = new Map<string, number>();
  for (const fp of new Set(events.flatMap((e) => (e.credentialFp ? [e.credentialFp] : [])))) {
    credIds.set(fp, await upsertCredential(sql, inst, fp));
  }
  const rows = events.map((e) => ({
    source_event_id: e.sourceEventId, installation_id: inst,
    credential_id: e.credentialFp ? credIds.get(e.credentialFp)! : null,
    session_id: e.sessionId, prompt_id: e.promptId, request_id: e.requestId,
    agent_id: e.agentId, parent_agent_id: e.parentAgentId, model: e.model,
    event_time: new Date(e.eventTime), input_tokens: e.inputTokens, output_tokens: e.outputTokens,
    cache_read_tokens: e.cacheReadTokens, cache_creation_tokens: e.cacheCreationTokens,
    cost_usd: e.costUsd, duration_ms: e.durationMs,
    query_source: e.querySource ?? null, effort: e.effort ?? null, speed: e.speed ?? null,
    repo: e.repo ?? null, entrypoint: e.entrypoint ?? null,
    account_id: e.accountKey ? accountIds.get(e.accountKey) ?? null : null,
  }));
  return (await sql`insert into usage_events ${sql(rows)} on conflict (source_event_id) do nothing`).count;
}

async function ingestActivity(sql: Sql, inst: number, events: ActivityEvent[]) {
  if (!events.length) return;
  const rows = events.map((e) => ({
    source_event_id: e.sourceEventId, installation_id: inst, session_id: e.sessionId, event_name: e.eventName,
    event_time: new Date(e.eventTime), repo: e.repo, attrs: sql.json(e.attrs),
  }));
  await sql`insert into activity_events ${sql(rows)} on conflict (source_event_id) do nothing`;
}

async function ingestContent(sql: Sql, inst: number, items: ContentItem[]) {
  if (!items.length) return;
  const rows = items.map((e) => ({
    source_event_id: e.sourceEventId, installation_id: inst, session_id: e.sessionId, kind: e.kind,
    event_time: new Date(e.eventTime), repo: e.repo, tool_name: e.toolName, file_path: e.filePath, branch: e.branch,
    text: e.text, truncated: e.truncated,
  }));
  await sql`insert into content_events ${sql(rows)} on conflict (source_event_id) do nothing`;
}

async function ingestMetrics(sql: Sql, inst: number, points: MetricPoint[]) {
  const rows = points.map((p) => ({
    // Same series + interval = same point; a retried export inserts nothing.
    source_key: sha256(JSON.stringify([inst, p.name, p.sessionId, p.repo, Object.entries(p.attrs).sort(), p.startTime, p.endTime])),
    installation_id: inst, name: p.name, session_id: p.sessionId, repo: p.repo, attrs: sql.json(p.attrs),
    start_time: new Date(p.startTime), end_time: new Date(p.endTime), value: p.value,
  }));
  await sql`insert into metric_points ${sql(rows)} on conflict (source_key) do nothing`;
}

type MeterRow = { accountId: number | null; meterKey: string; usedPercentage: number; resetsAt: number; expired: boolean };
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * One card per visible account: owner team, and each person's labeled ESTIMATE of the points they used in each
 * live window = meter % x their share of that account's API-price cost in the window. Never summed across accounts.
 * People outside the viewer's teams collapse into one otherTeams line. Events without an account key count toward
 * their device's current account.
 */
async function accountCards(sql: Sql, acct: Awaited<ReturnType<typeof accountScope>>, meters: MeterRow[], teamIds: number[] | null) {
  const rows = await sql`
    select a.id, a.label, a.team_id, t.name as team_name, a.account_key is not null as detected
    from accounts a left join teams t on t.id = a.team_id
    where ${inAccounts(sql, 'a.id', acct)} order by a.id`;
  const cards: { id: number | null; label: string; teamId: number | null; teamName: string | null; detected: boolean }[] = rows.map((r) => ({
    id: Number(r.id), label: r.label as string, teamId: r.team_id === null ? null : Number(r.team_id),
    teamName: (r.team_name as string | null) ?? null, detected: r.detected as boolean,
  }));
  if (meters.some((m) => m.accountId === null)) cards.push({ id: null, label: 'Unattributed', teamId: null, teamName: null, detected: false });
  const mine = (teamId: unknown) => teamIds === null || (teamId !== null && teamIds.includes(Number(teamId)));
  return Promise.all(cards.map(async (card) => {
    type Est = { personId: number | null; name: string; teamId: number | null; cost5h: number; pts5h: number | null; costWeek: number; ptsWeek: number | null };
    const people = new Map<string, Est>();
    const otherTeams = { cost5h: 0, pts5h: 0, costWeek: 0, ptsWeek: 0 };
    for (const [meterKey, costKey, ptsKey] of [['five_hour', 'cost5h', 'pts5h'], ['seven_day', 'costWeek', 'ptsWeek']] as const) {
      const m = meters.find((x) => x.accountId === card.id && x.meterKey === meterKey && !x.expired);
      if (!m) continue;
      const rows = await sql`
        select i.person_id, coalesce(p.name, i.name) as name, p.team_id, coalesce(sum(e.cost_usd), 0)::float8 as cost
        from usage_events e join installations i on i.id = e.installation_id left join people p on p.id = i.person_id
        where coalesce(e.account_id, i.account_id) is not distinct from ${card.id}::bigint
          and e.event_time >= ${new Date((m.resetsAt - WINDOW_SECONDS[meterKey]) * 1000)} and e.event_time < ${new Date(m.resetsAt * 1000)}
        group by i.person_id, coalesce(p.name, i.name), p.team_id`;
      const total = rows.reduce((n, r) => n + (r.cost as number), 0);
      for (const r of rows) {
        const cost = r.cost as number;
        const pts = total > 0 ? (m.usedPercentage * cost) / total : 0;
        if (!mine(r.team_id)) { otherTeams[costKey] += cost; otherTeams[ptsKey] += pts; continue; }
        const key = `${r.person_id ?? `dev:${r.name}`}`;
        const e = people.get(key) ?? { personId: r.person_id === null ? null : Number(r.person_id), name: r.name as string,
          teamId: r.team_id === null ? null : Number(r.team_id), cost5h: 0, pts5h: null, costWeek: 0, ptsWeek: null };
        e[costKey] = cost;
        e[ptsKey] = round1(pts);
        people.set(key, e);
      }
    }
    return {
      ...card,
      people: [...people.values()].sort((a, b) => (b.ptsWeek ?? 0) - (a.ptsWeek ?? 0) || (b.pts5h ?? 0) - (a.pts5h ?? 0)),
      otherTeams: otherTeams.costWeek || otherTeams.cost5h
        ? { ...otherTeams, pts5h: round1(otherTeams.pts5h), ptsWeek: round1(otherTeams.ptsWeek) } : null,
    };
  }));
}

/** One row per person (devices merged); pre-invite devices stand alone. Flags tokens seen under several people. */
function rankPeople(rows: any[]) {
  const owners = new Map<string, number>();
  for (const r of rows) for (const fp of r.fps as string[]) owners.set(fp, (owners.get(fp) ?? 0) + 1);
  return rows.map((r) => ({
    personId: r.person_id === null ? null : Number(r.person_id),
    installationId: r.inst_id === null ? null : Number(r.inst_id),
    name: (r.person_name ?? r.installation_name) as string,
    requests: r.requests, inputTokens: r.input_tokens, outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens, cacheCreationTokens: r.cache_creation_tokens,
    estCostUsd: r.est_cost_usd,
    tokens: r.fps as string[],                                         // setup-token fingerprint prefixes
    sharedTokens: (r.fps as string[]).filter((fp) => owners.get(fp)! > 1), // same token under another person
    quotaContribution: null, // no verified upstream source; see docs/CAPABILITY-REPORT.md
  }));
}

async function previousFiveHourSnapshots(sql: Sql, snapshots: QuotaSnapshot[], accountId: number | null): Promise<Map<number, { usedPct: number; observedAt: Date }>> {
  const out = new Map<number, { usedPct: number; observedAt: Date }>();
  const resets = [...new Set(snapshots.filter((s) => s.meterKey === 'five_hour').map((s) => s.resetsAt))];
  for (const r of resets) {
    const [row] = await sql`
      select used_percentage::float8 as pct, last_observed_at
      from quota_snapshots
      where meter_key = 'five_hour' and resets_at = ${new Date(r * 1000)} and account_id is not distinct from ${accountId}::bigint
      order by last_observed_at desc limit 1`;
    if (row) out.set(r, { usedPct: row.pct as number, observedAt: row.last_observed_at as Date });
  }
  return out;
}

export { checkInactiveDevices };

async function upsertSnapshot(sql: Sql, s: QuotaSnapshot, observer: number | null, accountId: number | null) {
  const observed = new Date(s.observedAt);
  // Same (account, meter, boundary, value) = same account state, no matter how many devices report it.
  // greatest() keeps a delayed older observation from rolling freshness backwards.
  await sql`
    insert into quota_snapshots (meter_key, label, used_percentage, resets_at, first_observed_at,
      last_observed_at, source, observer_installation_id, account_id)
    values (${s.meterKey}, ${s.label}, ${Math.round(s.usedPercentage * 100) / 100},
      ${new Date(s.resetsAt * 1000)}, ${observed}, ${observed}, ${s.source}, ${observer}, ${accountId})
    on conflict (account_id, meter_key, resets_at, used_percentage) do update set
      last_observed_at = greatest(quota_snapshots.last_observed_at, excluded.last_observed_at),
      first_observed_at = least(quota_snapshots.first_observed_at, excluded.first_observed_at),
      source = case when excluded.last_observed_at > quota_snapshots.last_observed_at
                    then excluded.source else quota_snapshots.source end,
      label = coalesce(excluded.label, quota_snapshots.label)`;
}
