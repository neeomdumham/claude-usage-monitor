# claude-usage-monitor

Self-hosted monitor for one Claude Team seat used through several setup tokens. It shows the account's real allowance meters and the measured workload per person, with a content-free profile of how each person uses it. Per-credential quota stays "Unavailable", because no upstream source reports it (see `docs/CAPABILITY-REPORT.md`).

| Path | What |
|---|---|
| `apps/server` | Hono API + Postgres. Also serves the built dashboard |
| `apps/dashboard` | React + Vite + Tailwind single page |
| `plugin` | Claude Code plugin teammates install: joins with the owner's invite link, points telemetry + status line at the server. Shell only, no daemon |
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

## Add a teammate

Teammates never open the dashboard.

1. Owner, in the dashboard: **Invite a teammate**, then enter their name. You get a link (`https://<monitor>/join#ccm_inv_…`) and a one-line install command. The link works on up to 2 of their devices for 72 hours. Making a new link for the same person cancels the old one.
2. Send them the command, or just the link. The teammate runs:
   ```
   claude plugin install usage-monitor --marketplace https://gitlab.com/moeen-mahmud/claude-usage-monitor.git --config 'invite=https://<monitor>/join#ccm_inv_…'
   ```
   Or, inside Claude Code, `/plugin install` and paste the link when asked. Opening the link in a browser shows the same instructions (no dashboard access). Then they restart Claude Code.
3. Their first session joins: the plugin trades the invite for a device token and shows a one-time notice of what is collected. The device appears under their name with hostname, OS and join time. Measuring starts with the next session.

What the plugin changes in user settings (backup kept as `settings.json.usage-monitor-backup`):
- telemetry env vars pointing at `<server>/v1/logs`, including repository and entrypoint tagging;
- an `otelHeadersHelper` that adds the device token;
- a `statusLine` wrapper that still renders the previous status line.

Everything collected, and everything that never is: [`TRANSPARENCY.md`](TRANSPARENCY.md).

Without a token in `settings.json` (for example, exported in a shell profile), no token fingerprint is reported; usage still counts under the person.

**Recovery (owner-run):** `sh plugin/scripts/uninstall.sh` restores the previous status line and removes the plugin's settings, then run `claude plugin uninstall usage-monitor@usage-monitor-tools`.
