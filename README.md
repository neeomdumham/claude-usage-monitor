# claude-usage-monitor

Self-hosted monitor for one Claude Team seat used through several setup tokens. It shows the account's real allowance meters and the measured workload per credential. Per-credential quota stays "Unavailable", because no upstream source reports it (see `docs/CAPABILITY-REPORT.md`).

| Path | What |
|---|---|
| `apps/server` | Hono API + Postgres. Also serves the built dashboard |
| `apps/dashboard` | React + Vite + Tailwind single page |
| `plugin` | Claude Code plugin teammates install: enrolls the device, points telemetry + status line at the server. Shell only, no daemon |
| `packages/contracts` | zod wire schemas |

The server runs in Docker. Devices need nothing but the plugin: it uses `sh` + `curl` (Git Bash on Windows) and edits settings with node, macOS's built-in JavaScript, or python3, whichever exists.

## Run, test, deploy (Docker)

```sh
cp .env.example .env                                  # set OWNER_PASSWORD, SESSION_SECRET

docker compose --profile dev up --build dev           # hot reload: http://localhost:5173
docker compose --profile test run --rm --build test   # typecheck + tests (throwaway Postgres) + build; CI runs the same
docker compose up -d --build                          # prod image locally: http://localhost:8787
```

Postgres is published on `127.0.0.1:54329` for inspection (`psql postgres://monitor:monitor@localhost:54329/monitor`).

**Deploy:** CI pushes `registry.gitlab.com/moeen-mahmud/claude-usage-monitor:{latest,<sha>}` on `main`. On the host, copy `docker-compose.yml` and `.env`, set `APP_IMAGE` to that image and `SECURE_COOKIES=true`, then run `docker compose pull app && docker compose up -d`. Put HTTPS in front: clients refuse to enroll over plain HTTP outside localhost.

## Install on a device (teammates)

1. Owner: create an enrollment code in the dashboard (single use, 15 minutes).
2. Teammate, inside Claude Code:
   ```
   /plugin marketplace add https://gitlab.com/moeen-mahmud/claude-usage-monitor.git
   /plugin install usage-monitor@usage-monitor-tools
   ```
   Enter the server URL and the enrollment code when prompted, then restart Claude Code.
3. The first session enrolls the device and updates `~/.claude/settings.json` (a backup is kept as `settings.json.usage-monitor-backup`). Measuring starts with the next session.

What the plugin changes in user settings: telemetry env vars pointing at `<server>/v1/logs`, an `otelHeadersHelper` that adds the device's monitoring credential, and a `statusLine` wrapper that still renders the previous status line. Only allowance percentages, request token counts and the SHA-256 of a setup token set in the settings file `env` leave the machine. Prompts, code and the token itself never do.

Without a token in `settings.json` (for example, exported in a shell profile), the device itself stands in for the credential and the owner labels it.

**Recovery (owner-run):** `sh plugin/scripts/uninstall.sh` restores the previous status line and removes the plugin's settings, then run `claude plugin uninstall usage-monitor@usage-monitor-tools`.
