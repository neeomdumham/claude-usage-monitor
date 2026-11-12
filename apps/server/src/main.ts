import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import postgres from 'postgres';
import { createApp, migrate } from './app.ts';
import { gitlabConfig, runGitSync } from './gitlab.ts';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const sql = postgres(env('DATABASE_URL'), { onnotice: () => {} });
await migrate(sql);

const app = createApp({
  sql,
  ownerPassword: env('OWNER_PASSWORD'),
  sessionSecret: env('SESSION_SECRET'),
  secureCookies: process.env.SECURE_COOKIES !== 'false',
  gitlab: gitlabConfig(),
});

const dist = process.env.DASHBOARD_DIST ?? new URL('../../dashboard/dist', import.meta.url).pathname;
if (existsSync(dist)) {
  app.use('/*', serveStatic({ root: dist }));
  app.get('/*', serveStatic({ path: `${dist}/index.html` }));
}

// Raw-event retention from owner policy.
setInterval(async () => {
  const cutoff = sql`now() - make_interval(days => (select (data->>'retentionDays')::int from policies order by revision desc limit 1))`;
  await sql`delete from usage_events where event_time < ${cutoff}`.catch(console.error);
  await sql`delete from activity_events where event_time < ${cutoff}`.catch(console.error);
  await sql`delete from metric_points where end_time < ${cutoff}`.catch(console.error);
  await sql`delete from git_commits where committed_at < ${cutoff}`.catch(console.error);
  await sql`delete from audit_log where at < now() - interval '365 days'`.catch(console.error);
}, 3600_000);

// Hourly GitLab commit sync, when configured.
const gl = gitlabConfig();
if (gl) {
  const sync = () => runGitSync(sql, gl).then((r) => console.log('gitlab sync', r)).catch((e) => console.error('gitlab sync failed', e.message));
  sync();
  setInterval(sync, 3600_000);
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`server on :${port}`);
