// Server-side sync of every commit in the owner's GitLab group, so Claude-made commits can be compared
// with all real output. Stores sha, author email, time and +/- counts only: never messages or diffs.
import type { Sql } from './app.ts';
import { audit } from './audit.ts';

export type GitlabConfig = { url: string; token: string; group: string };
type Fetch = typeof fetch;

export function gitlabConfig(env = process.env): GitlabConfig | null {
  if (!env.GITLAB_TOKEN || !env.GITLAB_GROUP) return null;
  return { url: (env.GITLAB_URL ?? 'https://gitlab.com').replace(/\/+$/, ''), token: env.GITLAB_TOKEN, group: env.GITLAB_GROUP };
}

/** All pages of a GitLab list endpoint (keyset-free: follows x-next-page). */
async function* pages(cfg: GitlabConfig, path: string, f: Fetch) {
  let page = '1';
  while (page) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await f(`${cfg.url}/api/v4${path}${sep}per_page=100&page=${page}`, { headers: { 'PRIVATE-TOKEN': cfg.token } });
    if (!res.ok) throw new Error(`GitLab ${res.status} on ${path}`);
    yield (await res.json()) as any[];
    page = res.headers.get('x-next-page') ?? '';
  }
}

/** Pull commits newer than each project's high-water mark. Returns how many commits were new. */
export async function syncGitlab(sql: Sql, cfg: GitlabConfig, f: Fetch = fetch, retentionDays = 30): Promise<{ projects: number; commits: number }> {
  const host = new URL(cfg.url).host;
  const group = encodeURIComponent(cfg.group);
  let projects = 0, commits = 0;
  for await (const batch of pages(cfg, `/groups/${group}/projects?include_subgroups=true&archived=false&simple=true`, f)) {
    for (const p of batch) {
      projects++;
      const repo = `${host}/${String(p.path_with_namespace).toLowerCase()}`;
      const [state] = await sql`select synced_until from git_sync where project_id = ${p.id}`;
      // `since` filters on commit date, and commits are often pushed days after they're made: re-scan a
      // 7-day overlap (inserts dedupe). ponytail: misses commits pushed >7 days late; widen if that matters.
      const since = state ? new Date(state.synced_until.getTime() - 7 * 86400_000) : new Date(Date.now() - retentionDays * 86400_000);
      const started = new Date();
      for await (const list of pages(cfg, `/projects/${p.id}/repository/commits?all=true&with_stats=true&since=${since.toISOString()}`, f)) {
        const rows = list.map((c) => ({
          repo, sha: String(c.id), author_email: String(c.author_email ?? '').toLowerCase(),
          committed_at: new Date(c.committed_date ?? c.created_at),
          additions: Number(c.stats?.additions ?? 0), deletions: Number(c.stats?.deletions ?? 0),
        }));
        if (rows.length) commits += (await sql`insert into git_commits ${sql(rows)} on conflict (repo, sha) do nothing`).count;
      }
      await sql`insert into git_sync (project_id, repo, synced_until) values (${p.id}, ${repo}, ${started})
        on conflict (project_id) do update set repo = excluded.repo, synced_until = excluded.synced_until`;
    }
  }
  return { projects, commits };
}

/** Sync and record the outcome in the audit log. Used by the hourly job and the dashboard button. */
export async function runGitSync(sql: Sql, cfg: GitlabConfig, f: Fetch = fetch, retentionDays = 30, actor: 'owner' | 'system' = 'system') {
  try {
    const r = await syncGitlab(sql, cfg, f, retentionDays);
    await audit(sql, { actor, action: 'git.sync', details: r });
    return r;
  } catch (e) {
    await audit(sql, { actor, action: 'git.sync_failed', details: { error: String((e as Error).message).slice(0, 200) } });
    throw e;
  }
}
