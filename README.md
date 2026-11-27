# claude-usage-monitor

A self-hosted monitor for teams that share Claude accounts (Team seats or logins) through their own setup tokens. It
shows each account's allowance meters (weekly and 5-hour) and how much of that each person, team, and device uses. By default
it collects usage metadata only; a superadmin can switch on capture of prompts, commands, file contents, diffs and
commit messages, and teammates are told when they do. Only admins (superadmins and team leads) see the dashboard.

| Path | What |
|---|---|
| `apps/server` | Hono API + Postgres. Also serves the built dashboard |
| `apps/dashboard` | React + Vite + Tailwind single page |
| `plugin` | Claude Code plugin teammates install. Shell only, no daemon |
| `packages/contracts` | zod wire schemas |
| `e2e` | Playwright browser tests for the dashboard |

Anthropic reports allowance per account, not per person or setup token. The monitor tells accounts apart by a hash of
the account id Claude Code reports, and shows each person's share of an account as a labeled estimate (their share of
its API-price work in the window, times its meter).

## Quick start (Docker)

```sh
cp .env.example .env            # set OWNER_PASSWORD and SESSION_SECRET (openssl rand -hex 32)
docker compose up -d --build    # http://localhost:8787
```

To look around without real data, start the demo: a made-up team on a throwaway database.

```sh
docker compose --profile demo up --build demo   # http://localhost:5174
```

Demo accounts:
- **Superadmin:** leave Email blank (or `owner@local`), password `demo`
- **Backend Team Lead:** `shamim@northwind.dev`, password `demo-lead`

## Add a teammate

Teammates never open the dashboard.

1. In the dashboard, open **People › Invite a teammate** and enter their name. You get a link
   (`https://<monitor>/join#ccm_inv_…`) and a one-line install command. The link works on up to 2 of their devices
   for 72 hours. A new link for the same person cancels the old one.
2. Send them the command, or just the link. They run:
   ```sh
   claude plugin install usage-monitor --marketplace https://github.com/neeomdumham/claude-usage-monitor.git --config 'invite=https://<monitor>/join#ccm_inv_…'
   ```
   Or, inside Claude Code, `/plugin install` and paste the link when asked. Opening the link in a browser shows the
   same instructions and nothing else. Then they restart Claude Code.
3. Their next session joins. Claude Code shows a one-time notice of what is collected, and the device appears
   under their name. Measuring starts with the session after that.

The plugin needs `sh` and `curl` (Git Bash on Windows) and one of node, python3 or macOS's built-in JavaScript to
edit settings. It changes the user's `~/.claude/settings.json` (backup kept as `settings.json.usage-monitor-backup`):
- telemetry env vars pointing at `<monitor>/v1/logs`, with repository and entrypoint tagging;
- an `otelHeadersHelper` that adds the device token;
- a `statusLine` wrapper that still renders the previous status line;
- Claude Code's own auto-update for this plugin's marketplace (`extraKnownMarketplaces.usage-monitor-tools.autoUpdate`),
  unless an admin turns **Keep the plugin up to date** off in Settings.

Everything collected, and everything that never is: [`TRANSPARENCY.md`](TRANSPARENCY.md). Share it with the team
before they install.

**Shared-token detection** works only when the setup token is in `settings.json` (`env.CLAUDE_CODE_OAUTH_TOKEN`).
If a teammate exports it in their shell profile instead, no fingerprint is reported; their usage still counts under
their name.

**Removing it from a device:** `sh plugin/scripts/uninstall.sh` (from a clone of this repo) restores the previous
status line and removes the plugin's settings, then `claude plugin uninstall usage-monitor@usage-monitor-tools`.

### Messages teammates may see

Every message starts with `usage-monitor:`. Settings changes, content capture switches, prompt labels, and
**Alert admin only (silent)** guard rules never notify teammates. By default the plugin never blocks a session; if a
superadmin enables **Repository guard** (`block` mode for outside-work or no-repo sessions), `UserPromptSubmit` and
`PreToolUse` exit `2` before burning allowance or modifying files outside configured work namespaces and show the
block reason below.

| Message | Fix |
|---|---|
| paste the invite link … in /plugin | No link was given at install. `/plugin` › usage-monitor › Configure options, paste it, restart |
| that invite link doesn't look right / is incomplete / is malformed | The link was cut off when copied. Send it again; everything after `#` is needed |
| couldn't join … the invite is used up, expired or replaced | Make a new link in the dashboard and have them update it in `/plugin` |
| could not update …settings.json | The device has none of node, python3 or macOS. Install one of them |
| blocked: repository … is outside your team's work namespaces | Repository guard is set to `block`. Switch into an approved work repository, or ask your admin to add the namespace |
| blocked: no git repository detected | Repository guard is set to `block` for non-repo folders. Run Claude Code inside a work git repository |

## Dashboard

The range picker (Current 5h, This week, 7 days, or 30 days) scopes every page:
- **Overview:** clickable Weekly and Current 5-hour allowance meters synced to the KPIs, persistent admin alert banner, who's spending it, weekly burn pace, and Recent & High-Effort Sessions (with `xhigh`/`high`/`medium` effort and session duration).
- **Teams & Admins:** create teams, assign superadmins and team leads, and filter the workspace by team. Superadmins see all teams and manage Settings; Team Leads see the 5h/weekly meters of the Claude accounts their teams own or use (other teams' people only as one total) and strictly their own team's people, sessions, repos, Git commits, flags, and invites. **Claude accounts** lists each account, its owner team and devices; a team's detail page adds existing people to it, and leads add people nobody has put in a team yet.
- **People** and **Devices:** invite modal, unified sortable table with preset views (Overview / Risk / Output), portaled row actions, and 3-tab range-aware person profiles (Overview, Sessions & effort, Work & Git).
- **Repositories:** cost, sessions and commits per repository, and who works where.
- **Activity:** clickable 365-day / year-selectable GitHub-style contribution calendar with Selected Period Inspector (sessions & commits for any clicked day or week), plus Weekly rhythm, Tools & errors, and Modes & labels tabs.
- **Git:** enrolled teammates' commits, PRs and lines from Claude Code plus GitLab/GitHub, with a **Map teammate emails** modal for unmapped org authors.
- **Captured content:** searchable card feed of prompts, commands, file contents, diffs and errors, filterable by person, kind, repo, and session. Empty until a switch is on (and hidden from Team Leads unless `leadsCanViewContent` is enabled).
- **Models & cost**, **Audit log** (filterable, CSV export) and **Settings** (Repository guard, Admin alerts & Slack/Discord/JSON webhook, Thresholds & retention, Content capture, Allowance readings & plugin).

### Repository guard & admin alerts

- **Repository guard (Settings › Repository guard):** choose `Off`, `Warn`, or `Block` independently for sessions outside your configured `workNamespaces` (`outsideRepoMode`) and folders without a git repo (`noRepoMode`). Applied on-device at session start via `UserPromptSubmit` (`exit 2` before any API call) and `PreToolUse` (`exit 2` blocking file/shell escapes outside the allowed worktree).
- **Admin alerts (Settings › Admin alerts & webhook):** surfaces a persistent top banner in the dashboard until acknowledged and optionally posts formatted notifications to a Slack, Discord, or generic JSON webhook (with a 60-minute per-alert cooldown and a **Send test webhook** button). Detects disabled plugin hooks (telemetry arriving without `SessionStart` bindings), outside-repo blocks/warnings, unaccounted 5-hour allowance jumps, and inactive devices.

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

All test suites run in Docker both locally and in GitHub Actions (`.github/workflows/ci.yml` on PRs and pushes to `main`, plus `.github/workflows/release.yml` before every release):

```sh
docker compose --profile test run --rm --build test          # typecheck, server tests, build
docker compose --profile test run --rm --build plugin-test   # POSIX shellcheck + plugin hooks (busybox sh & dash; node & python3)
docker compose --profile e2e up --build --abort-on-container-exit --exit-code-from e2e db-e2e app-e2e e2e
                                                             # Playwright browser tests on the prod image; screenshots in e2e/out/
```

On macOS, the header of `plugin/test/run.sh` has the command that covers the built-in JavaScript path against the same test stack.

`E2E_TOKEN_FILE=<file with a setup token> sh scripts/e2e-real.sh` installs the plugin into the real Claude Code CLI
and runs a few tiny Haiku requests on the seat. Local only: the token is mounted read-only and never printed or
sent to CI.

For hot-reload development: `docker compose --profile dev up --build dev` (http://localhost:5173). Postgres is on
`127.0.0.1:54329`.

## Release and deploy

**Server (once):** `deploy/ec2.yml` is a CloudFormation stack for one t4g.nano in Singapore (`ap-southeast-1`): HTTP/HTTPS only, no SSH (shell via Session Manager), fixed IP, encrypted disk with daily snapshots kept 7 days, and a least-privilege `GitHubDeployRole` for GitHub Actions OIDC SSM deploys. About $8/month.

1. Deploy or update the stack (if deploying into a fresh AWS account without an existing `token.actions.githubusercontent.com` OIDC provider, pass `--parameter-overrides CreateGitHubOidcProvider=true`):
   ```sh
   aws cloudformation deploy --profile velacrew-dev --region ap-southeast-1 \
     --stack-name usage-monitor --template-file deploy/ec2.yml --capabilities CAPABILITY_IAM
   ```
2. In Cloudflare, add an A record `claude-monitor` → the `PublicIp` output, **DNS only** (grey cloud): Caddy needs to
   answer the certificate challenge itself, and the app reads the caller's IP from Caddy.
3. On the box (first time only): `aws ssm start-session --profile velacrew-dev --region ap-southeast-1 --target <InstanceId>`, then
   `cd /opt/monitor && sudo cp env.example .env && sudo chmod 600 .env && sudo vi .env`.
4. In GitHub repo **Settings › Environments**, create an environment named `Production` (allow `v*` tags and `main` branch) and set secret/variable `AWS_DEPLOY_ROLE_ARN` to the `GitHubDeployRoleArn` stack output. After the first release push, confirm the `ghcr.io/neeomdumham/claude-usage-monitor` package visibility is **Public** so the EC2 box can pull without a PAT.

**Automated release (GitHub Actions):** see [`RELEASING.md`](RELEASING.md) and [`CHANGELOG.md`](CHANGELOG.md). Draft notes with `pnpm run changelog:draft`, cut the dated section with `pnpm run release:cut <version>`, commit and push `main`, then push the tag:

```sh
git tag -a v0.5.7 -m "v0.5.7" && git push origin v0.5.7
```

`.github/workflows/release.yml` automatically:
1. validates semver, confirms `CHANGELOG.md` has a section for `<version>`, and ensures plugin files didn't change since the previous `v*` tag without bumping `plugin/.claude-plugin/plugin.json`;
2. runs all three Docker test suites (`test`, `plugin-test`, `e2e`);
3. builds `linux/arm64` natively on `ubuntu-24.04-arm` and pushes `ghcr.io/neeomdumham/claude-usage-monitor:{<version>,<major.minor>,latest}`;
4. creates the GitHub Release using the `CHANGELOG.md` section as its body plus the image tags and plugin update note;
5. assumes `GitHubDeployRole` via AWS OIDC (no static AWS keys) and runs `deploy/box.sh` over SSM, which pulls the new image, restarts Compose, checks `/api/health`, and automatically rolls back to the previous image if it fails.

You can also trigger **Actions › Release & Deploy › Run workflow** manually (with optional `deploy` and `skip_tests` flags).

**Manual fallback / rollback:** `sh scripts/release.sh <version> --deploy-only` redeploys or rolls back to any already published tag from your machine (needs `aws` credentials for the `velacrew-dev` profile, account `544471418460`).

The plugin's version (`plugin/.claude-plugin/plugin.json`) is separate: bump it only when files under `plugin/`
(other than its tests) change. Devices on an older plugin show as **Needs update** across People, Devices, and Person
Detail. With **Keep the plugin up to date** on (the default, Settings), Claude Code installs new plugin versions in
the background once a device runs plugin 0.6.1 or later; teammates see one "Plugin updated" line. To update by hand:

```sh
claude plugin marketplace update usage-monitor-tools && claude plugin update usage-monitor@usage-monitor-tools
```

Teammates who originally installed from the older GitLab repository repoint the marketplace **in place** once (keeps their enrolled device token intact — do **not** run `marketplace remove`, which uninstalls the plugin and deletes its saved token):

```sh
git -C ~/.claude/plugins/marketplaces/usage-monitor-tools remote set-url origin https://github.com/neeomdumham/claude-usage-monitor.git && \
  sed -i.bak -E 's|https://gitlab\.com/[^"]*usage-monitor[^"]*\.git|https://github.com/neeomdumham/claude-usage-monitor.git|g' ~/.claude/settings.json ~/.claude/plugins/known_marketplaces.json && \
  rm -f ~/.claude/settings.json.bak ~/.claude/plugins/known_marketplaces.json.bak && \
  claude plugin marketplace update usage-monitor-tools && \
  claude plugin update usage-monitor@usage-monitor-tools
```
