# Changelog

## Unreleased

_Nothing yet._

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
