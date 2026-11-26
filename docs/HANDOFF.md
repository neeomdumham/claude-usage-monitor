# Handoff — `claude-usage-monitor` v0.5.7

Last updated: 2026-11-26  
Plan: [docs/01-PLAN-0.5.7.md](./01-PLAN-0.5.7.md)

## Completed Milestones

### Milestone 1 — Multi-Team RBAC (`Superadmin` + `Team Lead`) & Auth (Committed)
- Multi-team schema (`teams`, `users`, `user_teams`, `people.team_id`, `invites.created_by_user_id`, `audit_log.user_id`), `scrypt` password hashing + backward-compatible `OWNER_PASSWORD` bootstrap, team-scoped dashboard APIs, and `leadsCanViewContent` toggle.

### Milestone 2 — Outside-Repo Blocking (`exit 2`) & Disabled-Plugin / Ghost-Burn Webhook Alerts (Committed)
- Plugin `UserPromptSubmit` (`exit 2`) & `PreToolUse` (`pre-tool-guard.sh` `exit 2`) repository guard hooks + team-merged `/api/agent/policy` + `POST /api/agent/guard`.
- `admin_alerts` table, 4 detectors (`plugin_disabled`, `outside_blocked`/`outside_warned`, `unaccounted_burn`, hourly `inactive_device`), Slack/Discord/JSON webhooks with 60m cooldown, and `/api/dashboard/alerts` endpoints.

### Milestone 3 — Data Accuracy Fixes: Git Scoping, 5h/Range Alignment, Session & Effort API, 365-Day Calendar API (Committed)
- Strict `INNER JOIN` Git scoping across `/commits`, `repoGit`, `gitDaily`; unified `five_hour`/`window`/`7d`/`30d`/`day:`/`range:` resolution; range-aware `/people/:id/profile`; `GET /api/dashboard/sessions` (`xhigh` effort + duration + `hooksActive`); `GET /api/dashboard/activity/calendar`; enriched `seed-demo.ts`.

### Milestone 4 — UI/UX Overhaul Part 1: Centered Shell, Alert Banner, Modals, Dashboard, People, Profile & Teams (Committed)
- Removed empty-state `/people` trap, centered `1440px` shell, native `<Modal>`, portaled `<RowMenu>`, loud `<AlertBanner>`, clickable 5h/Weekly Dashboard + Recent & High-Effort Sessions, Invite Modal, Unified People table, Tabbed Person Detail, and Teams & Admins page.

### Milestone 5 — UI/UX Overhaul Part 2: Clickable GitHub Activity Calendar, Git, Captured Content & Settings (Committed)
- Clickable 365-day / year-selectable `ContributionCalendar` + Selected Period Inspector, organized Git page + `Map teammate emails` modal, card-based Captured Content, 4-card Settings page, Hallmark `0/0/0`, Impeccable `[]`, 15/15 E2E tests.

### Milestone 6 — GitHub Actions CI + Native ARM64 GHCR + AWS OIDC SSM Release (`v0.5.7`) (Ready to Commit)
- **CI Workflow** ([.github/workflows/ci.yml](../.github/workflows/ci.yml)): Docker-first `test`, `plugin-test`, and `e2e` jobs on PRs and pushes to `main`, with pinned action SHAs and Playwright artifact upload on failure.
- **Release & Deploy Workflow** ([.github/workflows/release.yml](../.github/workflows/release.yml)): Triggered on `v*` tags and `workflow_dispatch`: validates semver + plugin version bump guard, runs all 3 Docker test suites, builds native `linux/arm64` on `ubuntu-24.04-arm`, pushes `ghcr.io/neeomdumham/claude-usage-monitor:{<ver>,<maj.min>,latest}`, creates the GitHub Release, and deploys over AWS SSM via GitHub OIDC (`Production` environment) using `deploy/box.sh` (health check + auto-rollback).
- **AWS CloudFormation OIDC Stack** ([deploy/ec2.yml](../deploy/ec2.yml)): Added least-privilege `GitHubDeployRole` (scoped to `repo:neeomdumham/claude-usage-monitor:environment:Production`, `cloudformation:DescribeStacks` on this stack, and `ssm:SendCommand` on this stack's EC2 instance + `AWS-RunShellScript`), optional `CreateGitHubOidcProvider` (default `false` since account `544471418460` already has it), and `GitHubDeployRoleArn` output. Works with `--capabilities CAPABILITY_IAM`.
- **Scripts & Docs**: Updated [deploy/box.sh](../deploy/box.sh), [scripts/release.sh](../scripts/release.sh) (default GHCR image), [README.md](../README.md), and [TRANSPARENCY.md](../TRANSPARENCY.md) for `v0.5.7`.

## Release `v0.5.8` Follow-up (Ready to Commit & Tag)

- **Silent plugin mode (`0.5.8`)**: removed user-facing `systemMessage` notifications on settings/capture changes (`session-start.sh`), guard `warn` mode (`Alert admin only (silent)`), and prompt labels (`classify-prompt.sh`); only `block` (`exit 2`) prints a stderr block reason.
- **Deprecated plugin visibility (`Needs update`)**: `isOutdated()` now flags `null`/legacy versions; added `Needs update` badge & filter on People, Person Detail, and Devices, plus copyable GitLab-to-GitHub marketplace migration command on Devices and Settings.
- **`OWNER_EMAIL` & editable admin email**: passed `OWNER_EMAIL` through Compose & env examples, migrated `owner@local` → `OWNER_EMAIL` in place on boot, and enabled editing admin emails in `Teams & Admins`.
- **Self-healing `plugin_disabled` alerts**: `POST /api/agent/heartbeat` auto-acknowledges open `plugin_disabled` alerts for that device.
- **EC2 CloudFormation safety lock**: pinned `ImageId` in `deploy/ec2.yml` to a static `String` (`ami-0895858ce99e82a9f`) + `DeletionPolicy: Retain` / `UpdateReplacePolicy: Retain` on `Instance`.
