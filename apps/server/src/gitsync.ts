// Runs the configured commit syncs (GitLab group, GitHub organization) and writes their rows to git_commits.
import type { Sql } from './app.ts';
import { audit } from './audit.ts';
import { syncGithub, type GithubConfig } from './github.ts';
import { syncGitlab, type GitlabConfig } from './gitlab.ts';

export type GitSources = { gitlab?: GitlabConfig | null; github?: GithubConfig | null };

export const gitConfigured = (s: GitSources) => Boolean(s.gitlab || s.github);

// The sync that's running now. A button click during the hourly or startup sync joins it instead of starting a
// second run that fetches the same commits. ponytail: per process; the server runs as one instance.
let running: Promise<Record<string, unknown>> | null = null;

/** Sync every configured source and record the outcome in the audit log. One failing source doesn't stop the
 *  other; the run still throws so the caller can report it. Used by the hourly job and the dashboard button. */
export function runGitSync(sql: Sql, sources: GitSources, f: typeof fetch = fetch, retentionDays = 30,
  actor: 'owner' | 'system' = 'system', details = false) {
  running ??= syncAll(sql, sources, f, retentionDays, actor, details).finally(() => { running = null; });
  return running;
}

async function syncAll(sql: Sql, sources: GitSources, f: typeof fetch, retentionDays: number,
  actor: 'owner' | 'system', details: boolean) {
  const result: Record<string, unknown> = {};
  const errors: string[] = [];
  const jobs: [string, (() => Promise<unknown>) | null][] = [
    ['gitlab', sources.gitlab ? () => syncGitlab(sql, sources.gitlab!, f, retentionDays, details) : null],
    ['github', sources.github ? () => syncGithub(sql, sources.github!, f, retentionDays, details) : null],
  ];
  for (const [name, job] of jobs) {
    if (!job) continue;
    try { result[name] = await job(); } catch (e) { errors.push(`${name}: ${(e as Error).message}`.slice(0, 200)); }
  }
  await matchGitEmails(sql);
  if (errors.length) {
    await audit(sql, { actor, action: 'git.sync_failed', details: { ...result, errors } });
    throw new Error(errors.join('; '));
  }
  await audit(sql, { actor, action: 'git.sync', details: result });
  return result;
}

/**
 * Credit unmatched commit emails to the person whose device reported the same email hash. A hash reported by two
 * people is ambiguous: any automatic match on it is undone and the email waits for the admin to map. Reports are
 * self-asserted by enrolled devices, so this undo plus the audit trail is what limits a teammate claiming someone
 * else's email. Returns how many emails were matched.
 */
export async function matchGitEmails(sql: Sql) {
  const disputed = await sql`
    select h.person_id, h.email_hash, h.matched_email from person_email_hashes h
    where h.matched_email is not null and h.email_hash in (
      select email_hash from person_email_hashes group by email_hash having count(distinct person_id) > 1)`;
  for (const r of disputed) {
    await sql`update people set git_emails = array_remove(git_emails, ${r.matched_email as string}) where id = ${r.person_id}`;
    await sql`update person_email_hashes set matched_email = null where person_id = ${r.person_id} and email_hash = ${r.email_hash}`;
    await audit(sql, { actor: 'system', action: 'person.git_email_unmatched', personId: Number(r.person_id), details: { email: r.matched_email } });
  }
  const rows = await sql`
    with authors as (
      select distinct author_email as email from git_commits
      where author_email <> '' and not exists (select 1 from people p where author_email = any(p.git_emails))
    ), owners as (
      select email_hash, min(person_id) as person_id from person_email_hashes
      group by email_hash having count(distinct person_id) = 1
    )
    select a.email, o.person_id, o.email_hash from authors a
    join owners o on o.email_hash = encode(sha256(convert_to(trim(a.email), 'UTF8')), 'hex')`;
  let n = 0;
  for (const r of rows) {
    // 10 is the limit the manual editor accepts, so a matched list stays editable.
    const res = await sql`update people set git_emails = array_append(git_emails, ${r.email as string})
      where id = ${r.person_id} and not (${r.email as string} = any(git_emails)) and cardinality(git_emails) < 10`;
    if (!res.count) continue;
    n++;
    await sql`update person_email_hashes set matched_email = ${r.email as string} where person_id = ${r.person_id} and email_hash = ${r.email_hash}`;
    await audit(sql, { actor: 'system', action: 'person.git_email_matched', personId: Number(r.person_id), details: { email: r.email } });
  }
  return n;
}
