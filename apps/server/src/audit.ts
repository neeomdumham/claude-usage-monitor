// Append-only audit trail of admin, device and system actions. Details hold ids and counts, never content.
import type { Sql } from './app.ts';

export type AuditEntry = {
  actor: 'owner' | 'device' | 'system';
  action: string;
  personId?: number | null;
  installationId?: number | null;
  details?: Record<string, unknown>;
};

export async function audit(sql: Sql, e: AuditEntry) {
  await sql`insert into audit_log (actor, action, person_id, installation_id, details)
    values (${e.actor}, ${e.action}, ${e.personId ?? null}, ${e.installationId ?? null}, ${sql.json((e.details ?? {}) as any)})`
    .catch((err) => console.error('audit write failed', err.message)); // never fail the request over the log
}
