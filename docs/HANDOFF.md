# Handoff — `claude-usage-monitor` v0.5.7

Last updated: 2026-11-26  
Plan: [docs/01-PLAN-0.5.7.md](./01-PLAN-0.5.7.md)

## Completed Milestones

### Milestone 1 — Multi-Team RBAC (`Superadmin` + `Team Lead`) & Auth (Committed)
- Multi-team schema (`teams`, `users`, `user_teams`, `people.team_id`, `invites.created_by_user_id`, `audit_log.user_id`), `scrypt` password hashing + backward-compatible `OWNER_PASSWORD` bootstrap, team-scoped dashboard APIs, and `leadsCanViewContent` toggle.

### Milestone 2 — Outside-Repo Blocking (`exit 2`) & Disabled-Plugin / Ghost-Burn Webhook Alerts (Ready to Commit)
- **Contracts** ([packages/contracts/src/index.ts](../packages/contracts/src/index.ts)):
  - Added `GUARD_MODES` (`off | warn | block`), `GuardEvent`, `ALERT_KINDS` (`plugin_disabled`, `outside_blocked`, `outside_warned`, `unaccounted_burn`, `inactive_device`), and `guard_event` activity event.
  - Extended `PolicyData` / `DEFAULT_POLICY` with `outsideRepoMode`, `noRepoMode`, `inactiveDaysAlert`, `unaccountedJumpPct`, `webhookUrl`, and `webhookEvents`.
- **Plugin Guard Hooks** ([plugin/hooks/hooks.json](../plugin/hooks/hooks.json), [plugin/scripts/lib.sh](../plugin/scripts/lib.sh), [plugin/scripts/session-start.sh](../plugin/scripts/session-start.sh), [plugin/scripts/classify-prompt.sh](../plugin/scripts/classify-prompt.sh), [plugin/scripts/pre-tool-guard.sh](../plugin/scripts/pre-tool-guard.sh)):
  - `session-start.sh` caches effective org + team `workNamespaces` and guard modes in `$DATA/guard-policy`, sends `appliedPolicyRevision` and `repoGuard: true` in heartbeat.
  - `classify-prompt.sh` (`UserPromptSubmit`) evaluates the working directory's git remote against allowed namespaces and returns `exit 2` + stderr before any Anthropic API call (0 tokens spent) when blocked, or injects a warning in `warn` mode; fires async telemetry to `POST /api/agent/guard`.
  - `pre-tool-guard.sh` (`PreToolUse` on `Edit|Write|MultiEdit|NotebookEdit|Bash`) blocks cross-directory file edits and `cd`/`pushd`/`git -C` escapes into outside repos with `exit 2`.
- **Server Alert Engine & Webhook API** ([apps/server/src/schema.sql](../apps/server/src/schema.sql), [apps/server/src/alerts.ts](../apps/server/src/alerts.ts), [apps/server/src/app.ts](../apps/server/src/app.ts), [apps/server/src/main.ts](../apps/server/src/main.ts)):
  - Added `admin_alerts` table with deduplication, occurrence counting, 60-minute webhook cooldown, and auto-reopen after 30 minutes if an acknowledged issue recurs.
  - Added 4 detectors: `detectPluginDisabled` (OTLP telemetry arriving without `session_bindings` + stale heartbeat >90s), `recordGuardEvent` (`POST /api/agent/guard`), `detectUnaccountedBurn` (`five_hour` jump >= `unaccountedJumpPct` with <$0.25 measured usage), and hourly `checkInactiveDevices`.
  - Added Slack, Discord, and generic JSON webhook auto-formatting + `GET /api/dashboard/alerts`, `POST /api/dashboard/alerts/:id/ack`, and `POST /api/dashboard/alerts/test-webhook`.
  - `/api/agent/policy` now merges the device's team `work_namespaces` with global `workNamespaces`.
- **Tests**:
  - `docker compose --profile test run --rm --build test`: `tsc` clean, **46/46** server tests passing, `vite build` clean.
  - `docker compose --profile test run --rm --build plugin-test`: **242/242** passing (`shellcheck` POSIX `sh` clean + `sh`/`dash` × `node`/`python3` hook tests including exit-2 prompt & `PreToolUse` escape blocking).

## Next Up

- **Milestone 3**: Data accuracy fixes — strict `INNER JOIN` Git commit scoping (eliminating unmapped org pushes), `five_hour` / date-range alignment, `GET /api/dashboard/sessions` (with `xhigh` effort & duration), and `GET /api/dashboard/activity/calendar` (365-day / year-selectable buckets).
- **Milestone 4**: Run `/impeccable doctor`, read `craft-floor.md`, and implement UI/UX Overhaul Part 1 (centered `1440px` layout, loud alert banner, native `<Modal>`, portaled `<RowMenu>`, 5h/Weekly Dashboard + Recent/High-Effort Sessions, Invite Modal, Unified People Table, Tabbed Person Detail, Teams & Admins page).
- **Milestone 5**: UI/UX Overhaul Part 2 (clickable 52-week/year GitHub-style Activity Calendar, Git page + Email Mapping modal, Captured Content, 4-card Settings) + Unslop/Hallmark/Impeccable gates + Playwright E2E.
- **Milestone 6**: GitHub Actions CI + native `arm64` GHCR + AWS OIDC SSM deploy (`v0.5.7`).
