// Server-side sync of every commit in the owner's GitHub organization, alongside the GitLab group sync. Same rows,
// same rules: sha, author email, time and +/- counts; message and diff only while captureGitDetails is on.
import type { Sql } from './app.ts';
import { MAX_DIFF, saveCommits, type CommitRow } from './gitlab.ts';
import { redact } from './redact.ts';

export type GithubConfig = { token: string; org: string };
type Fetch = typeof fetch;
const API = 'https://api.github.com';

export function githubConfig(env = process.env): GithubConfig | null {
  if (!env.GITHUB_TOKEN || !env.GITHUB_ORG) return null;
  return { token: env.GITHUB_TOKEN, org: env.GITHUB_ORG };
}

const get = (cfg: GithubConfig, f: Fetch, url: string) => f(url.startsWith('http') ? url : API + url, {
  headers: { authorization: `Bearer ${cfg.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
});

/** All pages of a GitHub list endpoint, following the Link header. 409 (empty repository) yields nothing. */
async function* pages(cfg: GithubConfig, f: Fetch, path: string) {
  let url: string | undefined = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
  while (url) {
    const res = await get(cfg, f, url);
    if (res.status === 409) return;
    if (!res.ok) {
      // GitHub says why (token pending approval, SSO not authorized, rate limited...); keep that in the audit log.
      const why = await res.json().then((b: any) => String(b?.message ?? ''), () => '');
      throw new Error(`GitHub ${res.status} on ${path}${why ? `: ${why}` : ''}`);
    }
    yield (await res.json()) as any[];
    url = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
  }
}

/** Pull commits newer than each repository's high-water mark. Returns how many commits were new or updated. */
export async function syncGithub(sql: Sql, cfg: GithubConfig, f: Fetch = fetch, retentionDays = 30, details = false): Promise<{ repos: number; commits: number }> {
  let repos = 0, commits = 0;
  for await (const batch of pages(cfg, f, `/orgs/${encodeURIComponent(cfg.org)}/repos?type=all`)) {
    for (const r of batch) {
      if (r.archived) continue;
      repos++;
      const repo = `github.com/${String(r.full_name).toLowerCase()}`;
      const [state] = await sql`select synced_until from github_sync where repo_id = ${r.id}`;
      // Same 7-day re-scan as GitLab: `since` is the commit date, and pushes can come days later.
      const since = state ? new Date(state.synced_until.getTime() - 7 * 86400_000) : new Date(Date.now() - retentionDays * 86400_000);
      const started = new Date();
      // ponytail: default branch only (GitHub has no all-branches commit list); commits land there once merged.
      for await (const list of pages(cfg, f, `/repos/${r.full_name}/commits?since=${since.toISOString()}`)) {
        // The list has no line counts, so each commit we don't have yet (or lack the diff of) costs one request,
        // which also returns the diff. ponytail: sequential; fine for a small org within 5,000 requests/hour.
        const shas = list.map((c) => String(c.sha));
        const known = new Map((await sql`select sha, diff is not null as has_diff from git_commits
          where repo = ${repo} and sha in ${sql(shas.concat(''))}`).map((x) => [x.sha as string, x.has_diff as boolean]));
        const rows: CommitRow[] = [];
        for (const c of list) {
          const sha = String(c.sha);
          if (known.has(sha) && (!details || known.get(sha))) continue;
          const res = await get(cfg, f, `/repos/${r.full_name}/commits/${sha}`);
          if (!res.ok) continue; // one unreadable commit isn't worth failing the sync
          const d = (await res.json()) as any;
          rows.push({
            repo, sha, author_email: String(c.commit?.author?.email ?? '').toLowerCase(),
            committed_at: new Date(c.commit?.committer?.date ?? c.commit?.author?.date),
            additions: Number(d.stats?.additions ?? 0), deletions: Number(d.stats?.deletions ?? 0),
            message: details && c.commit?.message ? redact(String(c.commit.message)).slice(0, 4000) : null,
            diff: details ? redact((d.files ?? []).map((x: any) => `--- ${x.previous_filename ?? x.filename}\n+++ ${x.filename}\n${x.patch ?? ''}`).join('\n')).slice(0, MAX_DIFF) : null,
          });
        }
        commits += await saveCommits(sql, rows);
      }
      await sql`insert into github_sync (repo_id, repo, synced_until) values (${r.id}, ${repo}, ${started})
        on conflict (repo_id) do update set repo = excluded.repo, synced_until = excluded.synced_until`;
    }
  }
  return { repos, commits };
}
