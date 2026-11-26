// Multi-admin authentication (superadmin + team_lead) and team visibility scoping.
// Backward-compatible with single OWNER_PASSWORD login: omitting email authenticates the bootstrap superadmin.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Sql } from './app.ts';

export type Role = 'superadmin' | 'team_lead';
export type Viewer = {
  id: number;
  email: string;
  name: string;
  role: Role;
  teamIds: number[];
};

const sha256 = (s: string) => createHash('sha256').update(s).digest();

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${key}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hex] = parts;
  if (!salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function slugifyTeam(name: string): string {
  const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return base || 'team';
}

export async function ensureBootstrapSuperadmin(sql: Sql, ownerPassword: string, ownerEmail = 'owner@local'): Promise<number> {
  const email = (ownerEmail || 'owner@local').trim().toLowerCase() || 'owner@local';
  const [existing] = await sql`select id from users where email = ${email}`;
  if (existing) {
    await sql`update users set role = 'superadmin', disabled_at = null where id = ${existing.id}`;
    return Number(existing.id);
  }
  // If OWNER_EMAIL was later configured in .env, migrate the default owner@local bootstrap row in place.
  if (email !== 'owner@local') {
    const [legacy] = await sql`select id from users where email = 'owner@local'`;
    if (legacy) {
      await sql`update users set email = ${email}, role = 'superadmin', disabled_at = null where id = ${legacy.id}`;
      return Number(legacy.id);
    }
  }
  const [created] = await sql`
    insert into users (email, name, password_hash, role)
    values (${email}, 'Owner', ${hashPassword(ownerPassword)}, 'superadmin')
    on conflict (email) do update set role = 'superadmin', disabled_at = null
    returning id`;
  return Number(created.id);
}

export async function loadViewer(sql: Sql, userId: number): Promise<Viewer | null> {
  const [row] = await sql`
    select u.id, u.email, u.name, u.role, u.disabled_at,
      coalesce(array_agg(ut.team_id order by ut.team_id) filter (where ut.team_id is not null), '{}') as team_ids
    from users u
    left join user_teams ut on ut.user_id = u.id
    where u.id = ${userId}
    group by u.id`;
  if (!row || row.disabled_at) return null;
  return {
    id: Number(row.id),
    email: row.email as string,
    name: row.name as string,
    role: row.role as Role,
    teamIds: (row.team_ids as (number | string)[]).map(Number),
  };
}

export async function authenticateUser(
  sql: Sql,
  ownerPassword: string,
  ownerEmail: string,
  emailInput: string | undefined,
  password: string,
): Promise<Viewer | null> {
  const normOwnerEmail = ownerEmail.trim().toLowerCase();
  const rawEmail = emailInput?.trim().toLowerCase() ?? '';
  const isOwnerAlias = !rawEmail || rawEmail === 'owner' || rawEmail === normOwnerEmail;

  if (isOwnerAlias && timingSafeEqual(sha256(password), sha256(ownerPassword))) {
    const uid = await ensureBootstrapSuperadmin(sql, ownerPassword, normOwnerEmail);
    return loadViewer(sql, uid);
  }

  const lookupEmail = !rawEmail || rawEmail === 'owner' ? normOwnerEmail : rawEmail;
  const [row] = await sql`select id, password_hash, disabled_at from users where email = ${lookupEmail}`;
  if (!row || row.disabled_at) return null;
  if (!verifyPassword(password, row.password_hash as string)) return null;
  return loadViewer(sql, Number(row.id));
}

export type TeamScope = {
  /** null = unrestricted (superadmin viewing everything); array = restrict strictly to people in these team IDs. */
  teamIds: number[] | null;
};

/** Resolve which team IDs the viewer is allowed to inspect, honoring an optional ?teamId= filter. */
export function resolveTeamScope(viewer: Viewer, requestedTeamId?: string | null): TeamScope {
  const req = requestedTeamId && /^\d+$/.test(requestedTeamId) ? Number(requestedTeamId) : null;
  if (viewer.role === 'superadmin') {
    return { teamIds: req !== null ? [req] : null };
  }
  if (req !== null) {
    return { teamIds: viewer.teamIds.includes(req) ? [req] : [] };
  }
  return { teamIds: viewer.teamIds };
}

export async function canAccessPerson(sql: Sql, viewer: Viewer, personId: number | null): Promise<boolean> {
  if (viewer.role === 'superadmin') return true;
  if (personId === null || !viewer.teamIds.length) return false;
  const [p] = await sql`select team_id from people where id = ${personId}`;
  return Boolean(p && p.team_id !== null && viewer.teamIds.includes(Number(p.team_id)));
}

export function encodeSessionCookie(uid: number, exp: number): string {
  return JSON.stringify({ uid, exp });
}

export function decodeSessionCookie(raw: string): { uid: number; exp: number } | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.uid === 'number' && typeof parsed?.exp === 'number' && parsed.exp > Date.now()) {
      return { uid: parsed.uid, exp: parsed.exp };
    }
    return null;
  } catch {
    return null;
  }
}
