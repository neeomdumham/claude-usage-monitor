import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';
import postgres from 'postgres';
import { z } from 'zod';
import {
  AgentBatch, DEFAULT_POLICY, DEVICE_PREFIX, EnrollRequest, Heartbeat, INVITE_PREFIX, PolicyData, QuotaSnapshot,
  SessionBinding, WINDOW_SECONDS, type ActivityEvent, type UsageEvent,
} from '@usage-monitor/contracts';
import { parseOtlp } from './otlp.ts';
import { profile } from './profile.ts';

export type Sql = ReturnType<typeof postgres>;
export type AppConfig = { sql: Sql; ownerPassword: string; sessionSecret: string; secureCookies: boolean };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const SESSION_HOURS = 12;
const INVITE_HOURS = 72;
const INVITE_MAX_USES = 2; // e.g. office + home laptop
const ENROLL_FAILS = { max: 5, windowMs: 15 * 60_000 };

export async function migrate(sql: Sql) {
  await sql.unsafe(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  await sql`insert into policies (data) select ${sql.json(DEFAULT_POLICY)} where not exists (select 1 from policies)`;
}

async function currentPolicy(sql: Sql) {
  const [row] = await sql`select revision, data from policies order by revision desc limit 1`;
  // Defaults first: revisions saved before a field existed still parse.
  return { revision: row.revision as number, data: PolicyData.parse({ ...DEFAULT_POLICY, ...row.data }) };
}

const json = async (c: Context) => c.req.json().catch(() => null);

export function createApp({ sql, ownerPassword, sessionSecret, secureCookies }: AppConfig) {
  const app = new Hono<{ Variables: { installationId: number } }>();
  app.use('/api/*', bodyLimit({ maxSize: 1024 * 1024 }));
  app.get('/api/health', (c) => c.json({ ok: true }));

  // ---------- owner auth ----------
  app.post('/api/auth/login', async (c) => {
    const body = z.object({ password: z.string() }).safeParse(await json(c));
    const ok = body.success &&
      timingSafeEqual(Buffer.from(sha256(body.data.password)), Buffer.from(sha256(ownerPassword)));
    if (!ok) return c.json({ error: 'invalid credentials' }, 401);
    const expires = Date.now() + SESSION_HOURS * 3600_000;
    await setSignedCookie(c, 'owner', String(expires), sessionSecret, {
      httpOnly: true, sameSite: 'Strict', secure: secureCookies, path: '/', maxAge: SESSION_HOURS * 3600,
    });
    return c.json({ ok: true });
  });
  app.post('/api/auth/logout', (c) => { deleteCookie(c, 'owner', { path: '/' }); return c.json({ ok: true }); });

  const requireOwner = async (c: Context, next: Next) => {
    const v = await getSignedCookie(c, sessionSecret, 'owner');
    if (!v || Number(v) < Date.now()) return c.json({ error: 'owner login required' }, 401);
    await next();
  };

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
  // ponytail: in-memory failure counter keyed on X-Forwarded-For; move to Postgres if the server ever runs >1 instance.
  const fails = new Map<string, { n: number; until: number }>();
  app.post('/api/enroll', async (c) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'direct';
    const f = fails.get(ip);
    if (f && f.until > Date.now() && f.n >= ENROLL_FAILS.max) return c.json({ error: 'too many attempts, try later' }, 429);
    const deny = () => {
      const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + ENROLL_FAILS.windowMs };
      fails.set(ip, { ...cur, n: cur.n + 1 });
      return c.json({ error: 'invite invalid, used up or expired' }, 401); // one message: never say which
    };
    const body = EnrollRequest.safeParse(await json(c));
    if (!body.success) return deny();
    const { invite, hostname, os, pluginVersion } = body.data;
    const token = DEVICE_PREFIX + randomBytes(32).toString('base64url');
    const result = await sql.begin(async (tx) => {
      // Atomic: two concurrent redemptions can't both take the last use.
      const [inv] = await tx`
        update invites set uses = uses + 1
        where secret_hash = ${sha256(invite)} and uses < max_uses and expires_at > now() and revoked_at is null
        returning person_id`;
      if (!inv) return null;
      const [inst] = await tx`
        insert into installations (name, token_hash, person_id, hostname, os, joined_ip, client_version)
        values (${hostname || 'device'}, ${sha256(token)}, ${inv.person_id}, ${hostname ?? null}, ${os ?? null},
          ${ip === 'direct' ? null : ip}, ${pluginVersion ?? null})
        returning id`;
      const [p] = await tx`select name from people where id = ${inv.person_id}`;
      return { installationId: Number(inst.id), token, person: p.name as string };
    });
    if (!result) return deny();
    fails.delete(ip);
    return c.json(result);
  });

  // ---------- agent API ----------
  app.use('/api/agent/*', requireInstallation);

  app.post('/api/agent/events', async (c) => {
    const body = AgentBatch.safeParse(await json(c));
    if (!body.success) return c.json({ error: 'invalid batch', issues: body.error.issues.slice(0, 5) }, 400);
    const inst = c.get('installationId');
    const { events, snapshots } = body.data;
    let inserted = 0;
    await sql.begin(async (tx) => {
      inserted = await ingestEvents(tx as unknown as Sql, inst, events);
      for (const s of snapshots) await upsertSnapshot(tx as unknown as Sql, s, inst);
    });
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
    await sql`
      update installations set last_heartbeat_at = now(), client_version = ${h.clientVersion},
        applied_policy_revision = ${h.appliedPolicyRevision}, capabilities = ${sql.json(h.capabilities)},
        queue_depth = ${h.queueDepth}, dropped_count = ${h.droppedCount}
      where id = ${c.get('installationId')}`;
    return c.json({ ok: true });
  });

  app.get('/api/agent/policy', async (c) => c.json(await currentPolicy(sql)));

  app.use('/v1/*', requireInstallation);
  app.post('/v1/logs', async (c) => {
    if (!(c.req.header('content-type') ?? '').includes('json')) return c.json({ error: 'use http/json' }, 415);
    const body = await json(c);
    if (!body) return c.json({ error: 'invalid json' }, 400);
    const { events, activity } = parseOtlp(body); // allowlist: content and identity attributes never get past here
    if (events.length || activity.length) {
      await sql.begin(async (tx) => {
        await ingestEvents(tx as unknown as Sql, c.get('installationId'), events);
        await ingestActivity(tx as unknown as Sql, c.get('installationId'), activity);
      });
    }
    return c.json({});
  });

  // ---------- dashboard API (owner only) ----------
  app.use('/api/dashboard/*', requireOwner);

  app.get('/api/dashboard/overview', async (c) => {
    const policy = await currentPolicy(sql);
    const now = Date.now() / 1000;
    const meters = (await sql`
      select distinct on (meter_key) meter_key, label, used_percentage::float8 as pct,
        extract(epoch from resets_at)::float8 as resets_at, last_observed_at, source
      from quota_snapshots order by meter_key, last_observed_at desc`).map((m) => ({
      meterKey: m.meter_key as string,
      label: m.label as string | null,
      usedPercentage: m.pct as number,
      resetsAt: m.resets_at as number,
      observedAt: (m.last_observed_at as Date).toISOString(),
      source: m.source as string,
      expired: (m.resets_at as number) <= now, // window rolled over; value unknown until next reading
      stale: now - (m.last_observed_at as Date).getTime() / 1000 > policy.data.freshnessThresholdSec,
    }));

    const window = c.req.query('window') ?? 'seven_day';
    const meter = meters.find((m) => m.meterKey === window && !m.expired);
    let ranking = null; // null = window boundary unknown
    if (meter && WINDOW_SECONDS[window]) {
      const start = new Date((meter.resetsAt - WINDOW_SECONDS[window]) * 1000);
      const end = new Date(meter.resetsAt * 1000);
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
        group by 1, 2, 3, 4 order by est_cost_usd desc, output_tokens desc`);
    }

    const installations = (await sql`
      select id, name, person_id, hostname, os, joined_ip, created_at, last_heartbeat_at, applied_policy_revision,
        capabilities, client_version, queue_depth, dropped_count, revoked_at from installations order by id`).map((i) => ({
      id: Number(i.id), name: i.name, personId: i.person_id === null ? null : Number(i.person_id),
      hostname: i.hostname, os: i.os, joinedIp: i.joined_ip, joinedAt: i.created_at.toISOString(),
      lastHeartbeatAt: i.last_heartbeat_at?.toISOString() ?? null,
      appliedPolicyRevision: i.applied_policy_revision, capabilities: i.capabilities,
      clientVersion: i.client_version, queueDepth: i.queue_depth, droppedCount: i.dropped_count,
      revoked: i.revoked_at !== null,
    }));

    const people = (await sql`
      select p.id, p.name, p.created_at, inv.expires_at, inv.uses, inv.max_uses
      from people p
      left join lateral (
        select expires_at, uses, max_uses from invites
        where person_id = p.id and revoked_at is null and expires_at > now() and uses < max_uses
        order by created_at desc limit 1
      ) inv on true
      order by p.id`).map((p) => ({
      id: Number(p.id), name: p.name as string, createdAt: p.created_at.toISOString(),
      openInvite: p.expires_at ? { expiresAt: p.expires_at.toISOString(), uses: p.uses, maxUses: p.max_uses } : null,
    }));

    return c.json({ policy, meters, window, ranking, installations, people });
  });

  // Invite a new person ({name}) or another device for an existing one ({personId}).
  // The plaintext token is returned once; the dashboard builds the link from its own origin.
  app.post('/api/dashboard/invites', async (c) => {
    const body = z.union([
      z.strictObject({ name: z.string().trim().min(1).max(60) }),
      z.strictObject({ personId: z.int() }),
    ]).safeParse(await json(c));
    if (!body.success) return c.json({ error: 'name required' }, 400);
    const token = INVITE_PREFIX + randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_HOURS * 3600_000);
    const personId = await sql.begin(async (tx) => {
      const pid = 'personId' in body.data
        ? (await tx`select id from people where id = ${body.data.personId}`)[0]?.id
        : (await tx`insert into people (name) values (${body.data.name}) returning id`)[0].id;
      if (!pid) return null;
      // A fresh link replaces any older one, so only the latest link sent works.
      await tx`update invites set revoked_at = now() where person_id = ${pid} and revoked_at is null`;
      await tx`insert into invites (secret_hash, person_id, max_uses, expires_at)
        values (${sha256(token)}, ${pid}, ${INVITE_MAX_USES}, ${expiresAt})`;
      return Number(pid);
    });
    if (personId === null) return c.json({ error: 'not found' }, 404);
    return c.json({ personId, token, expiresAt: expiresAt.toISOString(), maxUses: INVITE_MAX_USES });
  });

  app.delete('/api/dashboard/people/:id/invites', async (c) => {
    await sql`update invites set revoked_at = now() where person_id = ${Number(c.req.param('id'))} and revoked_at is null`;
    return c.json({ ok: true });
  });

  app.patch('/api/dashboard/people/:id', async (c) => {
    const body = z.strictObject({ name: z.string().trim().min(1).max(60) }).safeParse(await json(c));
    if (!body.success) return c.json({ error: 'name required' }, 400);
    const res = await sql`update people set name = ${body.data.name} where id = ${Number(c.req.param('id'))}`;
    return res.count ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.get('/api/dashboard/people/:id/profile', async (c) => {
    const p = await profile(sql, Number(c.req.param('id')), (await currentPolicy(sql)).data);
    return p ? c.json(p) : c.json({ error: 'not found' }, 404);
  });

  app.patch('/api/dashboard/installations/:id', async (c) => {
    const body = z.strictObject({ name: z.string().min(1).max(60).optional(), revoked: z.boolean().optional() })
      .safeParse(await json(c));
    if (!body.success) return c.json({ error: 'invalid request' }, 400);
    const id = Number(c.req.param('id'));
    if (body.data.name) await sql`update installations set name = ${body.data.name} where id = ${id}`;
    if (body.data.revoked !== undefined) {
      await sql`update installations set revoked_at = ${body.data.revoked ? sql`now()` : null} where id = ${id}`;
    }
    return c.json({ ok: true });
  });

  app.post('/api/dashboard/quota-snapshots', async (c) => {
    const body = QuotaSnapshot.omit({ source: true, observedAt: true }).safeParse(await json(c));
    if (!body.success) return c.json({ error: 'invalid snapshot' }, 400);
    await upsertSnapshot(sql, { ...body.data, source: 'manual', observedAt: new Date().toISOString() }, null);
    return c.json({ ok: true });
  });

  app.patch('/api/dashboard/policy', async (c) => {
    const current = await currentPolicy(sql);
    const next = PolicyData.safeParse({ ...current.data, ...(await json(c)) });
    if (!next.success) return c.json({ error: 'invalid policy', issues: next.error.issues }, 400);
    const [row] = await sql`insert into policies (data) values (${sql.json(next.data)}) returning revision`;
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

/** Insert allowlisted events; retried deliveries are no-ops via source_event_id. Returns rows inserted. */
async function ingestEvents(sql: Sql, inst: number, events: UsageEvent[]): Promise<number> {
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

async function upsertSnapshot(sql: Sql, s: QuotaSnapshot, observer: number | null) {
  const observed = new Date(s.observedAt);
  // Same (meter, boundary, value) = same account state, no matter how many devices report it.
  // greatest() keeps a delayed older observation from rolling freshness backwards.
  await sql`
    insert into quota_snapshots (meter_key, label, used_percentage, resets_at, first_observed_at,
      last_observed_at, source, observer_installation_id)
    values (${s.meterKey}, ${s.label}, ${Math.round(s.usedPercentage * 100) / 100},
      ${new Date(s.resetsAt * 1000)}, ${observed}, ${observed}, ${s.source}, ${observer})
    on conflict (meter_key, resets_at, used_percentage) do update set
      last_observed_at = greatest(quota_snapshots.last_observed_at, excluded.last_observed_at),
      first_observed_at = least(quota_snapshots.first_observed_at, excluded.first_observed_at),
      source = case when excluded.last_observed_at > quota_snapshots.last_observed_at
                    then excluded.source else quota_snapshots.source end,
      label = coalesce(excluded.label, quota_snapshots.label)`;
}
