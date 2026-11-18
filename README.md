# claude-usage-monitor

A self-hosted monitor for one Claude Team seat that several teammates use through their own setup tokens. It shows
the account's allowance meters (weekly and 5-hour) and how much of that each person and device uses. By default
it collects usage metadata only; the owner can switch on capture of prompts, commands, file contents, diffs and
commit messages, and teammates are told when they do. Only the owner sees the dashboard.

| Path | What |
|---|---|
| `apps/server` | Hono API + Postgres. Also serves the built dashboard |
| `apps/dashboard` | React + Vite + Tailwind single page |
| `plugin` | Claude Code plugin teammates install. Shell only, no daemon |
| `packages/contracts` | zod wire schemas |
| `e2e` | Playwright browser tests for the dashboard |

Per-token quota is shown as "Unavailable": Anthropic reports allowance per account, not per setup token.

## Quick start (Docker)

```sh
cp .env.example .env            # set OWNER_PASSWORD and SESSION_SECRET (openssl rand -hex 32)
docker compose up -d --build    # http://localhost:8787
```

To look around without real data, start the demo: a made-up team on a throwaway database.

```sh
docker compose --profile demo up --build demo   # http://localhost:5174, password: demo
```

## Add a teammate

Teammates never open the dashboard.

1. In the dashboard, open **People › Invite a teammate** and enter their name. You get a link
   (`https://<monitor>/join#ccm_inv_…`) and a one-line install command. The link works on up to 2 of their devices
   for 72 hours. A new link for the same person cancels the old one.
2. Send them the command, or just the link. They run:
   ```sh
   claude plugin install usage-monitor --marketplace https://gitlab.com/moeen-mahmud/claude-usage-monitor.git --config 'invite=https://<monitor>/join#ccm_inv_…'
   ```
   Or, inside Claude Code, `/plugin install` and paste the link when asked. Opening the link in a browser shows the
   same instructions and nothing else. Then they restart Claude Code.
3. Their next session joins. Claude Code shows a one-time notice of what is collected, and the device appears
   under their name. Measuring starts with the session after that.

The plugin needs `sh` and `curl` (Git Bash on Windows) and one of node, python3 or macOS's built-in JavaScript to
edit settings. It changes the user's `~/.claude/settings.json` (backup kept as `settings.json.usage-monitor-backup`):
- telemetry env vars pointing at `<monitor>/v1/logs`, with repository and entrypoint tagging;
- an `otelHeadersHelper` that adds the device token;
- a `statusLine` wrapper that still renders the previous status line.

Everything collected, and everything that never is: [`TRANSPARENCY.md`](TRANSPARENCY.md). Share it with the team
before they install.

**Shared-token detection** works only when the setup token is in `settings.json` (`env.CLAUDE_CODE_OAUTH_TOKEN`).
If a teammate exports it in their shell profile instead, no fingerprint is reported; their usage still counts under
their name.

**Removing it from a device:** `sh plugin/scripts/uninstall.sh` (from a clone of this repo) restores the previous
status line and removes the plugin's settings, then `claude plugin uninstall usage-monitor@usage-monitor-tools`.

### Messages teammates may see

Every message starts with `usage-monitor:`. The plugin never blocks a session.

| Message | Fix |
|---|---|
| paste the invite link … in /plugin | No link was given at install. `/plugin` › usage-monitor › Configure options, paste it, restart |
| that invite link doesn't look right / is incomplete / is malformed | The link was cut off when copied. Send it again; everything after `#` is needed |
| couldn't join … the invite is used up, expired or replaced | Make a new link in the dashboard and have them update it in `/plugin` |
| could not update …settings.json | The device has none of node, python3 or macOS. Install one of them |
| this prompt was labelled "…" on your device | Informational: a prompt matched a keyword category. Only the label was sent |
| your admin changed what this monitor captures … / turned off content capture | Informational: a content capture switch changed in Settings. Applies from their next session |

## Dashboard

The range picker (this allowance week, 7 or 30 days) scopes every page:
- **Overview:** allowance gauges with pace, items that need you, who's spending it, the week's burn.
- **People** and **Devices:** a comparison table, per-person profiles, rename and remove devices.
- **Repositories:** cost, sessions and commits per repository, and who works where.
- **Activity:** time-of-day heatmap, tools, permission modes, entrypoints and prompt labels.
- **Git:** commits, PRs and lines from Claude Code and, if configured, from GitLab and GitHub.
- **Captured content:** prompts, commands, file contents, diffs and errors, filterable by person, kind and text.
  Empty until a switch is on.
- **Models & cost**, **Audit log** (filterable, CSV export) and **Settings** (flag thresholds, retention, content
  capture).

### Content capture

Settings › Content capture has five switches, all off by default: prompt text, commands and tool input, file
contents and diffs, API error messages, and GitLab commit messages and diffs. Each device applies them at the start
of its next session and shows its user a notice naming what is now captured. The server drops content whose switch
is off, redacts anything shaped like a secret before storing it, and deletes it after its own retention period (14
days by default). File contents and diffs use Claude Code's beta tracing. Update TRANSPARENCY.md before changing what
is collected.

To count every commit, not only Claude's, set `GITLAB_TOKEN` (scope `read_api`) and `GITLAB_GROUP`, and/or
`GITHUB_TOKEN` and `GITHUB_ORG`, in `.env`. For GitHub, use a fine-grained token whose resource owner is the
organization, with access to all repositories and read-only Contents; an org admin may need to approve it. The server
syncs commits hourly (author email, time, +/− counts only; on GitHub, each repo's default branch). Map each
teammate's commit emails on their profile, including their `…@users.noreply.github.com` address.

## Testing

All of it runs in Docker, locally; there is no CI. `scripts/release.sh` runs the first three before every release.

```sh
docker compose --profile test run --rm --build test          # typecheck, server tests, build
docker compose --profile test run --rm --build plugin-test   # plugin hooks against a real server (busybox sh and dash; node and python3)
docker compose --profile e2e up --build --abort-on-container-exit --exit-code-from e2e db-e2e app-e2e e2e
                                                             # browser tests on the production image; screenshots in e2e/out/
```

On macOS, the header of `plugin/test/run.sh` has the command that covers the built-in JavaScript path against the same test stack.

`E2E_TOKEN_FILE=<file with a setup token> sh scripts/e2e-real.sh` installs the plugin into the real Claude Code CLI
and runs a few tiny Haiku requests on the seat. Local only: the token is mounted read-only and never printed or
sent to CI.

For hot-reload development: `docker compose --profile dev up --build dev` (http://localhost:5173). Postgres is on
`127.0.0.1:54329`.

## Release and deploy

**Server (once):** `deploy/ec2.yml` is a CloudFormation stack for one t4g.nano in Singapore: HTTP/HTTPS only, no SSH
(shell via Session Manager), fixed IP, encrypted disk with daily snapshots kept 7 days. About $8/month.

1. `aws cloudformation deploy --profile velacrew-dev --region ap-southeast-1 --stack-name usage-monitor --template-file deploy/ec2.yml --capabilities CAPABILITY_IAM`
2. In Cloudflare, add an A record `claude-monitor` → the `PublicIp` output, **DNS only** (grey cloud): Caddy needs to
   answer the certificate challenge itself, and the app reads the caller's IP from Caddy.
3. `aws ssm start-session --profile velacrew-dev --region ap-southeast-1 --target <InstanceId>`, then
   `cd /opt/monitor && sudo cp env.example .env && sudo chmod 600 .env && sudo vi .env`.

**Release:** bump `version` in `plugin/.claude-plugin/plugin.json`, commit, push, then `sh scripts/release.sh <version>`.
From this machine, with no CI, it:
1. checks the tree is clean and pushed and the version matches the plugin;
2. runs the three test commands above;
3. builds the arm64 image and pushes `moeenmahmud007/claude-usage-monitor:{<version>,<major.minor>,latest}`;
4. tags `v<version>` and creates the GitLab Release;
5. deploys over SSM: the server fetches `deploy/` at that tag and runs `box.sh`, which pulls, restarts, checks
   `/api/health` and rolls back to the previous image if it fails.

Needs `docker login`, `glab auth login` and the `velacrew-dev` AWS profile (account 544471418460). `--skip-tests` if you just ran them; `--deploy-only` to
redeploy or roll back to a released version. Devices on an older plugin show as outdated.
