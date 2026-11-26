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

### Milestone 5 — UI/UX Overhaul Part 2: Clickable GitHub Activity Calendar, Git, Captured Content & Settings (Ready to Commit)
- **Clickable GitHub-Style Activity Calendar** ([apps/dashboard/src/charts.tsx](../apps/dashboard/src/charts.tsx), [apps/dashboard/src/Analytics.tsx](../apps/dashboard/src/Analytics.tsx)):
  - Built full-width 52-week / year-selectable `ContributionCalendar` with metric chips (`Requests` | `Cost` | `Sessions` | `Commits`), person filter, year rail (`Last 12 months`, `2026`, …), and hover readout.
  - Clicking any day cell or week column header opens the **Selected Period Inspector** showing KPIs, exact sessions (`xhigh` effort, duration, repo, hooks), and enrolled teammate commits for that period.
  - Reorganized operational metrics underneath into 3 clean tabs (`Weekly rhythm` + Effort distribution, `Tools & errors`, `Modes & labels` with human-readable labels).
- **Organized Git Page** ([apps/dashboard/src/Analytics.tsx](../apps/dashboard/src/Analytics.tsx), [apps/dashboard/src/Content.tsx](../apps/dashboard/src/Content.tsx)):
  - Strictly shows enrolled teammates across charts, person breakdown, and `Recent team commits` (with person + repo filters, copyable diffs, and clean no-message text).
  - Unmapped org authors moved into the **`Map teammate emails (N)`** modal with repo context and 1-click assignment.
- **Organized Captured Content** ([apps/dashboard/src/Content.tsx](../apps/dashboard/src/Content.tsx)):
  - Card-based feed with Kind pills, Search + Person + Kind filters, clickable Repo & Session filter chips (`?sessionId=`), and recessed copyable code/diff blocks.
- **4-Card Settings Page** ([apps/dashboard/src/App.tsx](../apps/dashboard/src/App.tsx)):
  - Reorganized into: (1) **Repository guard (on-device)** (`workNamespaces`, `outsideRepoMode`, `noRepoMode`), (2) **Admin alerts & webhook** (URL, event checkboxes, `inactiveDaysAlert`, `unaccountedJumpPct`, **Send test webhook** button), (3) **Thresholds & retention** + **Content capture** (including `leadsCanViewContent`), and (4) **Allowance readings & plugin**.
- **Design & E2E Gates**: Hallmark `sloplint --scope app`, Impeccable `detect --json --changed`, Unslop copy pass, and 15-test Chromium E2E suite.

## Next Up

- **Milestone 6 (Final)**: GitHub Actions CI (`.github/workflows/ci.yml`), automated native `arm64` GHCR + GitHub Release + AWS OIDC SSM deploy (`.github/workflows/release.yml`), `deploy/ec2.yml` `GitHubDeployRole` OIDC template, `scripts/release.sh`, `README.md`, and `TRANSPARENCY.md` for `v0.5.7`.
