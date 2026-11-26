# `claude-usage-monitor` v0.5.7 — Implementation & Release Plan

Date: 2026-11-26  
Owner: Moeen  
Target Release: `v0.5.7` (`ghcr.io/neeomdumham/claude-usage-monitor`)

## Confirmed Decisions

1. **Outside-repo enforcement (Urgent #4):** Configurable in Settings: `outsideRepoMode` (`off` | `warn` | `block`) + separate `noRepoMode` (`off` | `warn` | `block`). Enforced on-device via `UserPromptSubmit` (`exit 2` before any Anthropic API call / token burn) + `PreToolUse` (`exit 2` blocking `Edit`/`Write`/`MultiEdit`/`NotebookEdit`/`Bash` escapes outside the allowed worktree).
2. **Disabled-plugin & ghost-burn alerts (Urgent #5):** Outbound **Webhook** (Slack / Discord / JSON auto-format + test webhook button) + **loud, persistent alert banner** at the top of the dashboard until acknowledged. Detects: (a) OTLP requests arriving without `SessionStart` bindings/heartbeats (*plugin hooks disabled*), (b) outside-repo block/warn attempts, (c) unaccounted `five_hour` meter jumps, and (d) inactive/silent teammates.
3. **Teams & RBAC (Feature #6):** Email + password login (`scrypt`), auto-seeding primary `superadmin` from `OWNER_PASSWORD` (100% backward-compatible). **Superadmins** manage all teams, global Settings, and extra Superadmins/Team Leads. **Team Leads** see the seat's 5h/weekly % gauge + strictly their own team's people, sessions, repos, git, flags, and invites; Superadmin toggle (`leadsCanViewContent`, default `false`) gates team Captured Content.
4. **Git commit scoping (Bug #3):** `INNER JOIN` against enrolled teammates' `git_emails` (scoped by team) across Recent Commits, Repo commit counts, and daily Git charts. Unmapped org author emails move into a **"Map teammate emails"** modal so 1-click assignment backfills history.
5. **Visual system & UI/UX (#1–7):** Preserve and sharpen **Forest & Lichen** light/dark palette + `Archivo Variable` `.reading` condensed numerals under **Hallmark (App-Screen Floor)**, **Impeccable (Operate)**, and **Unslop**. Run `/impeccable doctor` before UI implementation.
6. **CI & AWS SSM deploy (Misc #1):** `ci.yml` on PRs; `release.yml` on `v*` tag push + `workflow_dispatch` → native `ubuntu-24.04-arm` build → `ghcr.io/neeomdumham/claude-usage-monitor` → GitHub Release → AWS OIDC (`ap-southeast-1`, stack `usage-monitor`) SSM deploy via `deploy/box.sh` with health-check rollback.

## Milestones

- **Milestone 1 — Multi-Team RBAC (`Superadmin` + `Team Lead`) & Auth**
  - Schema (`teams`, `users`, `user_teams`, `people.team_id`, `invites.created_by_user_id`, `audit_log.user_id`)
  - `apps/server/src/auth.ts` (`scrypt` + bootstrap superadmin + viewer scoping)
  - Team/User CRUD + team-scoped dashboard API + `leadsCanViewContent` toggle + integration tests
- **Milestone 2 — Outside-Repo Blocking (`exit 2`) & Disabled-Plugin / Webhook Alerts**
  - Policy fields (`outsideRepoMode`, `noRepoMode`, `inactiveDaysAlert`, `unaccountedJumpPct`, `webhookUrl`, `webhookEvents`)
  - Plugin `UserPromptSubmit` (`exit 2` block) + `PreToolUse` (`pre-tool-guard.sh`) + `POST /api/agent/guard`
  - Server `alerts.ts` (`admin_alerts`, 4 detectors, Slack/Discord/JSON webhook with cooldown + test/ack endpoints)
  - Full `plugin/test/run.sh` + server alert/webhook tests
- **Milestone 3 — Data Accuracy Fixes: Git Scoping, 5h/Range Alignment, Session & Effort API, 365-Day Calendar API**
  - Strict `INNER JOIN` Git scoping across `/commits`, `repoGit`, `gitDaily`
  - Unified `five_hour` / `window` / `7d` / `30d` / `day:` / `range:` resolution + range-aware `/people/:id/profile`
  - `GET /api/dashboard/sessions` (with `xhigh`/`high`/`medium` effort & duration) + `GET /api/dashboard/activity/calendar`
  - Updated `seed-demo.ts` + server tests
- **Milestone 4 — UI/UX Overhaul Part 1: Shell, Alert Banner, Modals, Dashboard, People, Profile & Teams**
  - Run `/impeccable doctor` + load `craft-floor.md`
  - Centered `1440px` shell, Loud Alert Banner, native `<Modal>`, portaled `<RowMenu>`, 5h/Weekly Dashboard + Recent/High-Effort Sessions, Invite Modal, Unified People Table, Tabbed Person Detail with Session Ledger, Teams & Admins page
  - Docker + Browser verification (`1440px` & `390px`, light & dark, `0` console errors)
- **Milestone 5 — UI/UX Overhaul Part 2: Clickable GitHub Activity Calendar, Git, Captured Content & Settings**
  - Full-width clickable 52-week/year Contribution Calendar + Selected Period Inspector, Organized Git page + Email Mapping Modal, Organized Captured Content page, Reorganized 4-card Settings page
  - Unslop copy pass + Hallmark `sloplint --scope app` + Impeccable `detect --json --changed` + Playwright e2e (`1440px` & `390px`, light & dark, Axe = `0`)
- **Milestone 6 — GitHub Actions CI + Native ARM64 GHCR + AWS OIDC SSM Release (`v0.5.7`)**
  - `.github/workflows/ci.yml` + `.github/workflows/release.yml`
  - `deploy/ec2.yml` (`GitHubDeployRole` OIDC) + `scripts/release.sh` + `README.md` + `TRANSPARENCY.md`

## Acceptance Criteria

- All Docker test profiles pass: `test`, `plugin-test`, and `e2e` (desktop 1440px + mobile 390px, light + dark, 0 console errors, 0 serious/critical Axe violations).
- Zero regressions on legacy `OWNER_PASSWORD` login and existing plugin enrollments.
- Every milestone stops with real verification output, manual test steps, and chunked `git add ... && git commit -m "..."` blocks for owner review.
