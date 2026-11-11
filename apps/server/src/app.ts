import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';
import postgres from 'postgres';
import { z } from 'zod';
import {
  AgentBatch, DEFAULT_POLICY, EnrollRequest, Heartbeat, PolicyData, QuotaSnapshot, WINDOW_SECONDS,
} from '@usage-monitor/contracts';

export type Sql = ReturnType<typeof postgres>;
export type AppConfig = { sql: Sql; ownerPassword: string; sessionSecret: string; secureCookies: boolean };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const SESSION_HOURS = 12;
const INVITE_MINUTES = 15;

export async function migrate(sql: Sql) {
  await sql.unsafe(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  await sql`insert into policies (data) select ${sql.json(DEFAULT_POLICY)} where not exists (select 1 from policies)`;
}

async function currentPolicy(sql: Sql) {
  const [row] = await sql`select revision, data from policies order by revision desc limit 1`;
  return { revision: row.revision as number, data: PolicyData.parse(row.data) };
}

const json = async (c: Context) => c.req.json().catch(() => null);

export function createApp({ sql, ownerPassword, sessionSecret, secureCookies }: AppConfig) {
  const app = new Hono<{ Variables: { installationId: number } }>();
  app.use('/api/*', bodyLimit({ maxSize: 1024 * 1024 }));

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

  // ---------- enrollment ----------
  app.post('/api/enroll', async (c) => {
    const body = EnrollRequest.safeParse(await json(c));
    if (!body.success) return c.json({ error: 'invalid request' }, 400);
    const [inv] = await sql`
      update invitations set used_at = now()
      where code_hash = ${sha256(body.data.code)} and used_at is null and expires_at > now()
      returning name`;
    if (!inv) return c.json({ error: 'invalid or expired code' }, 400);
    const token = randomBytes(32).toString('base64url');
    const [inst] = await sql`insert into installations (name, token_hash) values (${inv.name}, ${sha256(token)}) returning id`;
    return c.json({ installationId: Number(inst.id), token });
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
      const credIds = new Map<string, number>();
      for (const fp of new Set(events.flatMap((e) => (e.credentialFp ? [e.credentialFp] : [])))) {
        const [cred] = await tx`
          insert into credentials (fingerprint) values (${fp})
          on conflict (fingerprint) do update set last_seen_at = now() returning id`;
        credIds.set(fp, Number(cred.id));
        await tx`
          insert into credential_bindings (installation_id, credential_id) values (${inst}, ${cred.id})
          on conflict (installation_id, credential_id) do update set last_seen_at = now()`;
      }
      if (events.length) {
        const rows = events.map((e) => ({
          source_event_id: e.sourceEventId, installation_id: inst,
          credential_id: e.credentialFp ? credIds.get(e.credentialFp)! : null,
          session_id: e.sessionId, prompt_id: e.promptId, request_id: e.requestId,
          agent_id: e.agentId, parent_agent_id: e.parentAgentId, model: e.model,
          event_time: new Date(e.eventTime), input_tokens: e.inputTokens, output_tokens: e.outputTokens,
          cache_read_tokens: e.cacheReadTokens, cache_creation_tokens: e.cacheCreationTokens,
          cost_usd: e.costUsd, duration_ms: e.durationMs,
        }));
        const res = await tx`insert into usage_events ${tx(rows)} on conflict (source_event_id) do nothing`;
        inserted = res.count;
      }
      for (const s of snapshots) await upsertSnapshot(tx as unknown as Sql, s, inst);
    });
    return c.json({ accepted: events.length, inserted, snapshots: snapshots.length });
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
      ranking = (await sql`
        select c.id, c.label, c.fingerprint, count(*)::int as requests,
          sum(e.input_tokens)::float8 as input_tokens, sum(e.output_tokens)::float8 as output_tokens,
          sum(e.cache_read_tokens)::float8 as cache_read_tokens,
          sum(e.cache_creation_tokens)::float8 as cache_creation_tokens,
          coalesce(sum(e.cost_usd), 0)::float8 as est_cost_usd
        from usage_events e left join credentials c on c.id = e.credential_id
        where e.event_time >= ${start} and e.event_time < ${end}
        group by c.id order by est_cost_usd desc, output_tokens desc`).map((r) => ({
        credentialId: r.id === null ? null : Number(r.id),
        label: r.label ?? (r.id === null ? 'Unknown auth' : null),
        fingerprintPrefix: r.fingerprint ? (r.fingerprint as string).slice(0, 12) : null,
        requests: r.requests, inputTokens: r.input_tokens, outputTokens: r.output_tokens,
        cacheReadTokens: r.cache_read_tokens, cacheCreationTokens: r.cache_creation_tokens,
        estCostUsd: r.est_cost_usd,
        quotaContribution: null, // no verified upstream source; see docs/CAPABILITY-REPORT.md
      }));
    }

    const installations = (await sql`
      select id, name, last_heartbeat_at, applied_policy_revision, capabilities, client_version,
        queue_depth, dropped_count, revoked_at from installations order by id`).map((i) => ({
      id: Number(i.id), name: i.name, lastHeartbeatAt: i.last_heartbeat_at?.toISOString() ?? null,
      appliedPolicyRevision: i.applied_policy_revision, capabilities: i.capabilities,
      clientVersion: i.client_version, queueDepth: i.queue_depth, droppedCount: i.dropped_count,
      revoked: i.revoked_at !== null,
    }));

    return c.json({ policy, meters, window, ranking, installations });
  });

  app.post('/api/dashboard/invitations', async (c) => {
    const body = z.strictObject({ name: z.string().min(1).max(60) }).safeParse(await json(c));
    if (!body.success) return c.json({ error: 'name required' }, 400);
    const code = randomBytes(9).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_MINUTES * 60_000);
    await sql`insert into invitations (code_hash, name, expires_at) values (${sha256(code)}, ${body.data.name}, ${expiresAt})`;
    return c.json({ code, expiresAt: expiresAt.toISOString() });
  });

  app.patch('/api/dashboard/credentials/:id', async (c) => {
    const body = z.strictObject({ label: z.string().min(1).max(60) }).safeParse(await json(c));
    if (!body.success) return c.json({ error: 'label required' }, 400);
    const res = await sql`update credentials set label = ${body.data.label} where id = ${Number(c.req.param('id'))}`;
    return res.count ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
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
