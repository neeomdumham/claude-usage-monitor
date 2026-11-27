# Changelog

## Unreleased

_Nothing yet._

## 0.6.2 — 2026-11-27

### Fixed

- One Claude account no longer shows as two rows. Account names are unique (case and spaces ignored), and renaming an account to a name that's already taken offers **Merge into …**: its devices, readings and requests move to the other row, which takes on the detected account id if it had none. Two rows that each reported their own account id can't be merged. Rows sharing a name show **Same name twice**, and an account set by hand shows **Set by hand, not confirmed yet** until one of its devices reports.

## 0.6.1 — 2026-11-27

### Added

- **Alerts page** (`#/alerts`): every admin alert in scope, open and acknowledged, with Inspect and Acknowledge. The nav badge for alerts moved from Dashboard to Alerts, and the banner links to the page.
- **Plugin updates itself**: a Settings switch, **Keep the plugin up to date on every device** (on by default), makes the plugin turn on Claude Code's own marketplace auto-update in each teammate's user settings, using the repository that device installed from. New plugin versions then install in the background; teammates see one "Plugin updated" line. Devices need one last manual update to a plugin with this switch. Needs `--bump-plugin`.
- **Put a device on a Claude account by hand**: the Claude accounts page lists devices that haven't reported an account and lets you pick one. The device's next request confirms it: an account with no device yet takes on the account it reports, and a device that reports a different, known account moves there.

### Changed

- Naming an account closes its "new Claude account" alert.
- People › Status now says what an open link means ("Spare link, 2 joins left, expires in 2 d") instead of "0/2 joined, link open".

## 0.6.0 — 2026-11-27

### Added

- **Several Claude accounts, kept apart**: the server reads the Claude account id Claude Code attaches to every request (`user.account_uuid`), keeps only its SHA-256 hash, and files each request and allowance reading under that account when it arrives. A new account is linked to the account its invite named, or appears as "Unlabeled account N" with an `account_detected` alert. No plugin update needed.
- **Allowance per account**: Home shows one card per account (owner team, weekly and 5h meters, pace) with each person's estimated points on it, labeled as an estimate; people on other teams show as one total. The burn chart draws one line per account. A header **Account** filter picks one account's window and burn line.
- **Claude accounts page** (`#/accounts`): name accounts, set the owner team (or shared), see the devices on each, add an account before inviting people onto it, and (superadmin) file pre-detection readings under each device's account.
- **Team membership**:
  - A team detail page (`#/teams/:id`) lists members and owned accounts, with **Add members** for people already enrolled.
  - **Move to team…** on People, and a **Not in a team yet** panel where superadmins and leads add unassigned people.
  - Leads can claim only unassigned people, atomically, so two leads never take the same person.
  - Deleting a team can move its members and accounts to another team.
  - The audit log names both teams on a move.
- Invites can name the Claude account the new device will use. Devices and Person › Devices show each device's account. Manual readings (e.g. weekly Fable) are entered per account.

### Fixed

- One account's status-line reading no longer replaces another's on the gauges, and "This allowance week" / "Current 5h" no longer jump to whichever account reported last.
- The burn chart and the meters now respect team scope: a team lead sees only accounts their teams own or use.
- The unaccounted 5h jump alert counts usage on the jumping account only (heavy use on another account no longer hides it) and goes to the account's owner team.
- The team filter and account filter are kept in the URL, so a reload or a shared link shows the same view.
- Old allowance readings are now removed with the rest of the raw data after the retention period.
- Changing a person's team shows whether it worked.

## 0.5.9 — 2026-11-26

### Added

- **Reconnect device (refresh token in place)**: added a single-use **Reconnect device (refresh token)** action on **Devices** and **Refresh token** on **Person Detail › Devices** (`POST /api/dashboard/invites` with `{ installationId }`). Redeeming the link rotates `token_hash` on the existing device row (`same installationId`, full usage/session history preserved, old lost token immediately invalidated, zero duplicate device rows).

### Fixed

- **Safe GitLab-to-GitHub plugin migration command**: updated the copyable migration command on **Devices** and **Settings** (and `README.md`) to repoint the `usage-monitor-tools` git remote and marketplace JSON **in place** instead of calling `claude plugin marketplace remove` (which uninstalls the plugin and deletes `~/.claude/plugins/data/` in Claude Code `2.1.x`).

## 0.5.8 — 2026-11-26

### Added

- **Deprecated plugin visibility (`Needs update`)**: shows a `Needs update` badge on **People**, **Person Detail**, and **Devices** (with an `Outdated` / `Needs update` filter), treats legacy/null `clientVersion` values as needing an update, and displays the one-click copyable GitLab-to-GitHub marketplace migration command on **Devices** and **Settings**.
- **Configurable `OWNER_EMAIL` & editable admin email**: passes `OWNER_EMAIL` through `deploy/compose.yml`, `docker-compose.yml`, and env templates; automatically migrates `owner@local` to `OWNER_EMAIL` on startup without creating duplicate accounts; allows editing admin emails directly in **Teams & Admins**.

### Changed

- **Silent plugin mode (no user notifications on settings changes or admin-only alerts)**: removed user-facing `systemMessage` notifications from `session-start.sh` on capture/settings changes, and made repository guard `warn` mode (`Alert admin only (silent)`) and on-device prompt labels silent to the user while still alerting admins. Only `block` mode (`exit 2`) prints a short block reason on stderr. Bumped plugin to `0.5.8`.
- **EC2 CloudFormation protection**: pinned `ImageId` in `deploy/ec2.yml` to a static `String` parameter (`ami-0895858ce99e82a9f`) and added `DeletionPolicy: Retain` / `UpdateReplacePolicy: Retain` on `Instance` so routine stack updates never silently replace the live server.

### Fixed

- **Auto-clear `plugin_disabled` alerts on fresh heartbeat**: receiving a valid `POST /api/agent/heartbeat` from a device automatically clears any open `plugin_disabled` alert for that device so transient deploy or snapshot gaps self-heal on the next session.

## 0.5.7 — 2026-11-26

### Added

- **Multi-team RBAC (`Superadmin` and `Team Lead`)**: email + password login (`scrypt`) alongside backward-compatible `OWNER_PASSWORD` bootstrap; manage teams and admins under **Teams & Admins** (`#/teams`). Team leads see the seat's allowance meters and strictly their own team's people, sessions, repositories, Git commits, flags, and invites. Captured content stays hidden from team leads unless a superadmin enables `leadsCanViewContent`.
- **On-device Repository Guard (`off` / `warn` / `block`)**: configure `outsideRepoMode` and `noRepoMode` independently in **Settings**. In `block` mode, `UserPromptSubmit` (`exit 2` before any Anthropic API call) and `PreToolUse` (`exit 2` blocking file/shell escapes outside the worktree) stop unauthorized repository usage on the device and report minimal guard metadata to `POST /api/agent/guard`.
- **Admin alerts & outbound webhooks**: detects disabled plugin hooks (OTLP telemetry arriving without `SessionStart` bindings), outside-repo blocks/warnings, unaccounted 5-hour allowance jumps, and inactive devices. Surfaces a persistent top dashboard banner until acknowledged and posts formatted notifications to Slack, Discord, or generic JSON webhooks with a 60-minute cooldown and a **Send test webhook** button.
- **Session & effort ledger (`GET /api/dashboard/sessions`)**: surfaces `xhigh`, `high`, and `medium` effort badges, session duration, active CLI time, repository classification, and hook health on the Dashboard, Person Detail, and Activity Inspector.
- **Clickable 365-day Activity Calendar (`GET /api/dashboard/activity/calendar`)**: full-width 52-week / year-selectable GitHub-style contribution calendar with metric chips (`Requests`, `Cost`, `Sessions`, `Commits`), person filter, and a **Selected Period Inspector** showing sessions and enrolled teammate commits for any clicked day or week.
- **Automated GitHub Actions CI & AWS OIDC SSM release**: Docker-first CI (`.github/workflows/ci.yml`), tag-driven native `linux/arm64` GHCR build + GitHub Release from `CHANGELOG.md` + AWS OIDC SSM deploy (`.github/workflows/release.yml`), least-privilege `GitHubDeployRole` in `deploy/ec2.yml`, and `cliff.toml` / `pnpm run changelog:draft` / `pnpm run release:cut` tooling.

### Changed

- **Dashboard & shell layout**: centered `1440px` workspace shell, clickable Weekly vs Current 5-hour allowance meters synced to all KPIs, Recent & High-Effort Sessions table, and deduplicated 0-commit sync audit entries.
- **People, Profile, Git, Captured Content & Settings**: Invite Teammate moved into a native `<dialog>` modal; People unified into one sortable table with view presets and a portaled row menu; Person Detail reorganized into 3 range-aware tabs (`Overview`, `Sessions & effort`, `Work & Git`); Captured Content redesigned as a filterable card feed with copyable code/diff blocks; Settings reorganized into 4 cards.
- **Repository & container registry**: migrated repository URLs, plugin marketplace instructions, and container publishing to `github.com/neeomdumham/claude-usage-monitor` and `ghcr.io/neeomdumham/claude-usage-monitor`. Plugin bumped to `0.5.7`.

### Fixed

- **Git page org commit leak**: scoped `/api/dashboard/commits`, repository Git counts, and daily Git charts with a strict `INNER JOIN` on enrolled teammates' mapped `git_emails`. Unmapped GitHub/GitLab org authors now live in the **Map teammate emails** modal for one-click assignment.
- **Dashboard 5h vs weekly mismatch**: unified `five_hour`, `window`, `7d`, `30d`, `day:`, and `range:` resolution across Dashboard, Person Detail, and Activity so clicking Current 5h or Weekly updates every metric together.
- **Empty-workspace navigation lock**: removed the forced redirect that trapped users on `/people` when no teammates were enrolled yet.
- **Sign-out route cleanup**: signing out from `#/teams` resets active team filters and returns cleanly to `#/dashboard`.

## 0.5.6 — 2026-11-19

### Changed

- Updated plugin policy refresh handling and bumped plugin version to `0.5.6`.
- Added an AWS session pre-flight check to `scripts/release.sh` before building or tagging.

## 0.5.5 — 2026-11-19

### Changed

- Versioned the server independently from the Claude Code plugin so server-only releases do not prompt teammates to update the plugin.

### Fixed

- Reused an in-flight commit sync instead of starting a duplicate concurrent sync.

## 0.5.4 — 2026-11-18

### Fixed

- Included GitHub's returned error message when commit sync fails.

## 0.5.3 — 2026-11-18

### Fixed

- Labeled commit sync audit entries by source (GitHub vs GitLab) and displayed the underlying sync error in the dashboard.

## 0.5.2 — 2026-11-18

### Added

- Synced GitHub organization commits alongside GitLab commits.

## 0.5.1 — 2026-11-18

### Added

- Added `deploy/ec2.yml` CloudFormation template for a single Graviton (`t4g.nano`) EC2 host with Caddy HTTPS, daily EBS snapshots, and SSM-based `deploy/box.sh` deploys with health-check rollback.
