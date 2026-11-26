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

### Milestone 4 — UI/UX Overhaul Part 1: Centered Shell, Alert Banner, Modals, Dashboard, People, Profile & Teams (Ready to Commit)
- **Design Checks**: Ran `/impeccable doctor --json --target apps/dashboard` (`0` findings), loaded `craft-floor.md`, verified `impeccable detect --json --changed` (`[]`).
- **Shell & Navigation Bug Fix** ([apps/dashboard/src/App.tsx](../apps/dashboard/src/App.tsx), [apps/dashboard/src/index.css](../apps/dashboard/src/index.css)):
  - Removed the forced empty-state redirect that trapped users on `/people` when switching to `/dashboard`.
  - Centered header inner bar and `<main>` (`mx-auto w-full max-w-[1440px]`), themed browser surfaces (`::selection`, `caret-color`, scrollbars, `<dialog>` backdrop/shadow tokens).
  - Added `Current 5h` (`five_hour`) to header range picker, team filter dropdown, role-aware sidebar (`Teams & Admins`, hides `Settings`/restricted `Captured content` for leads), email+password login (preserving legacy `OWNER_PASSWORD` flow), and sign-out hash/team reset.
- **Primitives** ([apps/dashboard/src/ui.tsx](../apps/dashboard/src/ui.tsx), [apps/dashboard/src/People.tsx](../apps/dashboard/src/People.tsx), [apps/dashboard/src/Meter.tsx](../apps/dashboard/src/Meter.tsx)):
  - Native `<Modal>` (`<dialog>`), portaled `position: fixed` `<RowMenu>` with auto-flip (eliminating inline table scrollbars), persistent `<AlertBanner>` with Inspect + 1-click Acknowledge, `<EffortBadge>`, and clickable `<Meter>` cards.
- **Pages**:
  - **Dashboard** ([apps/dashboard/src/Home.tsx](../apps/dashboard/src/Home.tsx)): clickable Weekly vs Current 5h meters, range-synced KPI strip with `xhigh` effort metric, Recent & High-Effort Sessions table (`Recent` | `xhigh effort` | `Highest cost` | `Outside work`) with duration/repo/model/effort/hooks, deduplicated recent sync noise, and empty-state CTA.
  - **People** ([apps/dashboard/src/Admin.tsx](../apps/dashboard/src/Admin.tsx)): modal Invite Teammate flow (`InviteModal`) and single unified sortable People table with `Summary` | `Usage & effort` | `Guardrails & Git` view presets.
  - **Person Detail** ([apps/dashboard/src/Profile.tsx](../apps/dashboard/src/Profile.tsx)): range-synced 5-KPI header + 3 tabs (`Sessions` ledger, `Repositories & hours`, `Models & tools` with human-readable request source/permission labels) + inline team selector.
  - **Teams & Admins** ([apps/dashboard/src/Teams.tsx](../apps/dashboard/src/Teams.tsx)): department CRUD, admin/team-lead account management modals, and `leadsCanViewContent` toggle.

## Next Up

- **Milestone 5**: UI/UX Overhaul Part 2 — clickable 52-week/year GitHub-style Activity Calendar + Selected Period Inspector (`#/activity`), organized Git page + Email Mapping modal (`#/git`), organized Captured Content (`#/content`), 4-card Settings (`#/settings` with Repository Guard, Webhook & Alerts + Test Webhook button, Flag Thresholds, Allowance Meters) + Unslop/Hallmark/Impeccable gates + full Playwright E2E.
- **Milestone 6**: GitHub Actions CI + native `arm64` GHCR + AWS OIDC SSM deploy (`v0.5.7`).
