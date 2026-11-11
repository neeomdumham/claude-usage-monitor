import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import postgres from 'postgres';
import { createApp, migrate } from './app.ts';

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
});

const dist = process.env.DASHBOARD_DIST ?? new URL('../../dashboard/dist', import.meta.url).pathname;
if (existsSync(dist)) {
  app.use('/*', serveStatic({ root: dist }));
  app.get('/*', serveStatic({ path: `${dist}/index.html` }));
}

// Raw-event retention from owner policy.
setInterval(async () => {
  await sql`
    delete from usage_events where event_time < now() - make_interval(days =>
      (select (data->>'retentionDays')::int from policies order by revision desc limit 1))`.catch(console.error);
}, 3600_000);

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`server on :${port}`);
