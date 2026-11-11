# claude-usage-monitor

Self-hosted monitor for one Claude Team seat used through several setup tokens. It shows the account's real allowance meters and the measured workload per credential. Per-credential quota stays "Unavailable", because no upstream source reports it (see `docs/CAPABILITY-REPORT.md`).

| Path | What |
|---|---|
| `apps/server` | Hono API + Postgres. Also serves the built dashboard |
| `apps/dashboard` | React + Vite + Tailwind single page |
| `packages/client` | `usage-monitor` CLI: enroll, local daemon (OTLP receiver + offline spool), status-line bridge, `claude` launcher |
| `packages/contracts` | zod wire schemas |

Everything server-side runs in Docker. Only the client runs natively on each device (Node 24+), because it has to sit next to Claude Code.

## Run, test, deploy (Docker)

```sh
cp .env.example .env                                  # set OWNER_PASSWORD, SESSION_SECRET

docker compose --profile dev up --build               # hot reload: dashboard http://localhost:5173, API :8787
docker compose --profile test run --rm --build test   # typecheck + tests (throwaway Postgres) + build; CI runs the same
docker compose --profile app up -d --build            # prod image locally: http://localhost:8787
```

Postgres is published on `127.0.0.1:54329` for inspection (`psql postgres://monitor:monitor@localhost:54329/monitor`).

**Deploy:** CI pushes `registry.gitlab.com/moeen-mahmud/claude-usage-monitor:{latest,<sha>}` on `main`. On the host, copy `docker-compose.yml` and `.env`, set `APP_IMAGE` to that image and `SECURE_COOKIES=true`, then run `docker compose --profile app pull && docker compose --profile app up -d`. Put HTTPS in front: clients refuse to enroll over plain HTTP outside localhost.

## Client (one installation)

```sh
node packages/client/src/cli.ts enroll https://monitor.example.com <code>   # code from the dashboard
node packages/client/src/cli.ts daemon                                       # keep running
node packages/client/src/cli.ts install-statusline   # wraps your existing statusLine; uninstall-statusline restores it
CLAUDE_CODE_OAUTH_TOKEN=... node packages/client/src/cli.ts claude           # launches Claude Code with telemetry + credential fingerprint
```
