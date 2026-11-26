# Handoff — `claude-usage-monitor` v0.5.7

Last updated: 2026-11-26  
Plan: [docs/01-PLAN-0.5.7.md](./01-PLAN-0.5.7.md)

## Completed Milestones

### Milestone 1 — Multi-Team RBAC (`Superadmin` + `Team Lead`) & Auth (Committed)
- Multi-team schema (`teams`, `users`, `user_teams`, `people.team_id`, `invites.created_by_user_id`, `audit_log.user_id`), `scrypt` password hashing + backward-compatible `OWNER_PASSWORD` bootstrap, team-scoped dashboard APIs, and `leadsCanViewContent` toggle.

### Milestone 2 — Outside-Repo Blocking (`exit 2`) & Disabled-Plugin / Ghost-Burn Webhook Alerts (Committed)
- Plugin `UserPromptSubmit` (`exit 2`) & `PreToolUse` (`pre-tool-guard.sh` `exit 2`) repository guard hooks + team-merged `/api/agent/policy` + `POST /api/agent/guard`.
- `admin_alerts` table, 4 detectors (`plugin_disabled`, `outside_blocked`/`outside_warned`, `unaccounted_burn`, hourly `inactive_device`), Slack/Discord/JSON webhooks with 60m cooldown, and `/api/dashboard/alerts` endpoints.

### Milestone 3 — Data Accuracy Fixes: Git Scoping, 5h/Range Alignment, Session & Effort API, 365-Day Calendar API (Ready to Commit)
- **Strict Git Commit Scoping** ([apps/server/src/app.ts](../apps/server/src/app.ts), [apps/server/src/analytics.ts](../apps/server/src/analytics.ts)):
  - Switched `/api/dashboard/commits`, `repoGit`, and `gitDaily` to strict `INNER JOIN people p ON g.author_email = ANY(p.git_emails)` (team-scoped) so unmapped org pushes never leak into team Git charts, repo commit totals, or recent commits.
  - Enriched `unmappedAuthors` with `repos` and `lastCommitAt` to power the 1-click **"Map teammate emails"** modal.
  - Added optional `?range=` and `?repo=` filtering on `/api/dashboard/commits` and `?sessionId=` filtering on `/api/dashboard/content`.
- **Unified Range Resolution & Range-Aware Profile** ([apps/server/src/analytics.ts](../apps/server/src/analytics.ts), [apps/server/src/profile.ts](../apps/server/src/profile.ts)):
  - Extended `resolveRange` with `five_hour`, `window`, `7d`, `30d`, `day:YYYY-MM-DD`, and `range:YYYY-MM-DD..YYYY-MM-DD` (timezone-accurate in Postgres) plus human `label`.
  - Updated `GET /api/dashboard/people/:id/profile?range=...` to honor the active range (removing hardcoded 7d), merge team `work_namespaces`, and return `efforts`, `guard`, `teamId`/`teamName`, and `gitEmails`.
  - Added `efforts` (`xhigh`/`high`/`medium`) and `guard` counts to `/api/dashboard/analytics`.
- **Session Ledger & 365-Day Calendar APIs** ([apps/server/src/sessions.ts](../apps/server/src/sessions.ts), [apps/server/src/app.ts](../apps/server/src/app.ts)):
  - Added `GET /api/dashboard/sessions` returning per-session `startedAt`, `endedAt`, `spanSec`, `activeCliSec`, `repo`, `repoClass`, `deviceName`, `hooksActive`, `requests`, `prompts`, `commits`, `costUsd`, `maxEffort` (`xhigh` > `high` > `medium`), `efforts[]`, and `summary` counts.
  - Added `GET /api/dashboard/activity/calendar` returning 365-day rolling or calendar-year daily buckets (`requests`, `sessions`, `costUsd`, `commits`, `xhighRequests`, `outsideRequests`, `activePeople`) and available `years[]`.
- **Demo Seed & Tests** ([apps/server/src/seed-demo.ts](../apps/server/src/seed-demo.ts), [apps/server/src/app.test.ts](../apps/server/src/app.test.ts)):
  - Seeded `Backend`/`Frontend` teams, Team Lead `shamim@northwind.dev` (`demo-lead`), realistic `xhigh`/`high`/`medium` effort distribution, and a sample unacknowledged `outside_blocked` alert.

## Next Up

- **Milestone 4**: Run `/impeccable doctor`, read `craft-floor.md`, and implement UI/UX Overhaul Part 1 (centered `1440px` layout, loud alert banner, native `<Modal>`, portaled `<RowMenu>`, 5h/Weekly Dashboard + Recent/High-Effort Sessions, Invite Modal, Unified People Table, Tabbed Person Detail, Teams & Admins page). Verify in Google Chrome + Docker.
- **Milestone 5**: UI/UX Overhaul Part 2 (clickable 52-week/year GitHub-style Activity Calendar, Git page + Email Mapping modal, Captured Content, 4-card Settings) + Unslop/Hallmark/Impeccable gates + Playwright E2E in Chrome/Docker.
- **Milestone 6**: GitHub Actions CI + native `arm64` GHCR + AWS OIDC SSM deploy (`v0.5.7`).
