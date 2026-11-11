# claude-usage-monitor

Self-hosted monitor for one Claude Team seat used through several setup tokens. It shows the account's real allowance meters and the measured workload per credential. Per-credential quota stays "Unavailable", because no upstream source reports it (see `docs/CAPABILITY-REPORT.md`).

| Path | What |
|---|---|
| `apps/server` | Hono API + Postgres. Also serves the built dashboard |
| `apps/dashboard` | React + Vite + Tailwind single page |
| `packages/client` | `usage-monitor` CLI: enroll, local daemon (OTLP receiver + offline spool), status-line bridge, `claude` launcher |
| `packages/contracts` | zod wire schemas |

Requires Node 24+ (runs `.ts` natively) and pnpm.

## Dev

```sh
pnpm install
cp .env.example .env              # set OWNER_PASSWORD, SESSION_SECRET
docker compose up -d db           # Postgres on 127.0.0.1:54329
pnpm dev:server                   # :8787
pnpm dev:dashboard                # :5173, proxies /api

# tests (server tests need a disposable DB; the schema is wiped)
docker compose exec db psql -U monitor -c "create database monitor_test"
TEST_DATABASE_URL=postgres://monitor:monitor@localhost:54329/monitor_test pnpm test
pnpm typecheck
```

## Client (one installation)

```sh
node packages/client/src/cli.ts enroll https://monitor.example.com <code>   # code from the dashboard
node packages/client/src/cli.ts daemon                                       # keep running
node packages/client/src/cli.ts install-statusline   # wraps your existing statusLine; uninstall-statusline restores it
CLAUDE_CODE_OAUTH_TOKEN=... node packages/client/src/cli.ts claude           # launches Claude Code with telemetry + credential fingerprint
```

## Production

```sh
OWNER_PASSWORD=... SESSION_SECRET=$(openssl rand -hex 32) docker compose --profile app up -d --build
```

Put it behind HTTPS. Clients refuse to enroll over plain HTTP outside localhost.
