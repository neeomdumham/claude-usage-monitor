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
  if (errors.length) {
    await audit(sql, { actor, action: 'git.sync_failed', details: { ...result, errors } });
    throw new Error(errors.join('; '));
  }
  await audit(sql, { actor, action: 'git.sync', details: result });
  return result;
}
