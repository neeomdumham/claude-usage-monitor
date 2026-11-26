import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import postgres from 'postgres';
import { checkInactiveDevices, cleanup, createApp, currentPolicy, migrate } from './app.ts';
import { githubConfig } from './github.ts';
import { gitlabConfig } from './gitlab.ts';
import { gitConfigured, runGitSync } from './gitsync.ts';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const sql = postgres(env('DATABASE_URL'), { onnotice: () => {} });
await migrate(sql);

const git = { gitlab: gitlabConfig(), github: githubConfig() };
const app = createApp({
  sql,
  ownerPassword: env('OWNER_PASSWORD'),
  ownerEmail: process.env.OWNER_EMAIL,
  sessionSecret: env('SESSION_SECRET'),
  secureCookies: process.env.SECURE_COOKIES !== 'false',
  git,
});

const dist = process.env.DASHBOARD_DIST ?? new URL('../../dashboard/dist', import.meta.url).pathname;
if (existsSync(dist)) {
  app.use('/*', serveStatic({ root: dist }));
  app.get('/*', serveStatic({ path: `${dist}/index.html` }));
}

// Raw-event retention & inactive-device checks from owner policy.
setInterval(() => cleanup(sql).catch(console.error), 3600_000);
setInterval(() => currentPolicy(sql).then(({ data }) => checkInactiveDevices(sql, fetch, data)).catch(console.error), 3600_000);

// Hourly commit sync (GitLab group and/or GitHub organization), when configured.
if (gitConfigured(git)) {
  const sync = () => currentPolicy(sql)
    .then(({ data }) => runGitSync(sql, git, fetch, data.retentionDays, 'system', data.captureGitDetails)).then((r) => console.log('git sync', r)).catch((e) => console.error('git sync failed', e.message));
  sync();
  setInterval(sync, 3600_000);
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`server on :${port}`);
