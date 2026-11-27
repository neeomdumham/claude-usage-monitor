# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Self-hosted monitor for Claude accounts (Team seats or logins) shared by several teams through setup tokens. Every
meter, window and burn line is per account (`accounts`, keyed by sha256 of the OTLP `user.account_uuid`). A Claude Code plugin on each
device reports usage to a Hono + Postgres server; admins view it in a React dashboard. See `README.md` for the
product, `TRANSPARENCY.md` for exactly what is and isn't collected.

## Commands

Everything is meant to run in Docker (the host may lack Postgres). Node >= 24, pnpm workspace.

```sh
docker compose --profile test run --rm --build test          # typecheck + server tests + dashboard build
docker compose --profile test run --rm --build plugin-test   # plugin hook scripts vs a real server (sh/dash, node/python)
docker compose --profile e2e up --build --abort-on-container-exit --exit-code-from e2e db-e2e app-e2e e2e
docker compose --profile e2e down -v                         # Playwright on the prod image; screenshots in e2e/out/
docker compose --profile dev up --build dev                  # hot reload, http://localhost:5173 (Postgres on 127.0.0.1:54329)
docker compose --profile demo up --build demo                # seeded fake team, http://localhost:5174, password `demo`
```

Host-side scripts (root `package.json`): `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm dev:server`, `pnpm dev:dashboard`.

Server tests need `TEST_DATABASE_URL` pointing at a **disposable** database (the schema is wiped per test). Single test
or file:

```sh
docker compose --profile test run --rm --build test \
  sh -c "node --test --test-name-pattern='enroll' apps/server/src/app.test.ts"
```

`plugin/test/run.sh` header has the macOS JXA variant. `scripts/e2e-real.sh` drives the real Claude Code CLI on the
seat with a real setup token (local only, never CI).

## Architecture

**No build step for the server.** Node runs `.ts` directly via type stripping (`tsconfig.base.json` has
`erasableSyntaxOnly`): no enums, namespaces, or parameter properties; imports use `.ts` extensions.
`packages/contracts` is consumed as raw `.ts` through a workspace symlink (the Dockerfile keeps it a symlink because
Node refuses to strip types under `node_modules`).

**Schema/migrations:** `apps/server/src/schema.sql` is idempotent (`create … if not exists`, `alter … add column if
not exists`) and re-applied on every boot by `migrate()` in `app.ts`. There is no migration tool; new schema changes
must be expressible that way.

**Policy:** admin settings live as revisioned JSON rows in `policies`. `currentPolicy()` merges `DEFAULT_POLICY` under
the stored row, so adding a field to `PolicyData` (contracts) needs a default and old revisions keep parsing.

**Three auth surfaces in `app.ts`** (one big `createApp()`):
- `/api/auth/*`, `/api/dashboard/*`: cookie session (`requireViewer`), roles superadmin / team lead. Team leads are
  scoped to their own team's data on every dashboard query; `requireSuperadmin` gates settings and team admin.
- `/api/enroll`: redeems an invite (`ccm_inv_…`, stored sha256-hashed, 2 uses, 72h) for a device token.
- `/api/agent/*` and `/v1/*` (OTLP logs/traces/metrics): device bearer token (`requireInstallation`).

**Data flow from a device:**
1. Plugin `SessionStart` (`plugin/scripts/session-start.sh`) enrolls on first run, then rewrites the user's
   `~/.claude/settings.json` (OTEL env vars → `<monitor>/v1/logs`, `otelHeadersHelper`, and a `statusLine` wrapper that
   still runs the user's previous status line) and binds the session.
2. Claude Code's own OpenTelemetry export posts to `/v1/logs`; `otlp.ts` keeps only allowlisted event attributes and
   only the content kinds the policy has switched on (`redact.ts` scrubs secrets before storage).
3. `statusline.sh` scrapes `rate_limits` (5h/weekly allowance %) from the status-line JSON and posts snapshots to
   `/api/agent/events`. This is the only source of allowance meters; per-token quota is not available from Anthropic.
4. `UserPromptSubmit` / `PreToolUse` hooks enforce the repository guard (`exit 2` blocks) from a cached policy and
   report guard events / on-device prompt labels (category only, never text).

**Plugin constraints:** POSIX `sh` only (busybox sh, dash, Git Bash), no daemon. JSON edits go through
`settings_tool` in `lib.sh`: node → macOS JXA (`osascript -l JavaScript settings.cjs`) → python3 (`settings.py`).
`settings.cjs` must stay JXA-compatible and `settings.py` must stay behaviorally identical to it. `normalize_repo` in
`lib.sh` must match `normalizeRepo` in `otlp.ts`. Hooks must stay fast and silent; only a `block` prints to stderr.

**Background jobs** (`main.ts`, hourly `setInterval`): retention cleanup, inactive-device alerts, and optional
GitLab/GitHub commit sync (`gitsync.ts`). Alerts and webhooks are in `alerts.ts`. All outbound HTTP takes an injected
`fetch` so tests use a fake.

**Dashboard:** single-page React 19 + Tailwind 4, no router library or state library; Vite proxies `/api` to `:8787`
in dev, and in prod the server serves `apps/dashboard/dist`.

## Rules that are easy to miss

- Changing what is collected means updating `TRANSPARENCY.md` (and the plugin.json description if it changes).
- The plugin has its own version (`plugin/.claude-plugin/plugin.json`), separate from the server. Bump it whenever
  files under `plugin/` (other than `plugin/test`) change; the release guard refuses otherwise. The server reads it to
  flag devices as "Needs update".
- Add every new wire field to `packages/contracts`; anything not in the zod schemas is rejected or dropped.
- Releases: `pnpm run changelog:draft` → `pnpm run release:cut <ver> [--bump-plugin]` → commit, push, tag `v<ver>`;
  `.github/workflows/release.yml` tests, builds arm64 to GHCR, and deploys to EC2 over SSM. Details in `RELEASING.md`.
