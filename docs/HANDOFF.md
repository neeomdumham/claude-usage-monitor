# Handoff — v0.5.7

Last updated: 2026-11-26  
Plan of record: [`docs/01-PLAN-0.5.7.md`](01-PLAN-0.5.7.md)

## Decisions Made

- Outside-repo guard: configurable `outsideRepoMode` + `noRepoMode` (`off` | `warn` | `block`), enforced via `UserPromptSubmit` + `PreToolUse` exit `2`.
- Admin alerts: outbound Webhook (Slack/Discord/JSON) + loud persistent dashboard banner until acknowledged.
- Multi-team RBAC: `superadmin` (seeded from `OWNER_PASSWORD`, backward-compatible) + `team_lead` (sees global 5h/weekly meter % + own team only; `leadsCanViewContent` toggle off by default).
- Git scoping: strict `INNER JOIN` to enrolled teammates' mapped `git_emails`; unmapped org emails move into a "Map teammate emails" modal.
- Visual system: preserve and elevate Forest & Lichen light/dark palette + Archivo condensed numerals; run `/impeccable doctor` before Milestone 4 UI work.
- CI/CD: `ci.yml` on PRs; `release.yml` on `v*` tags + manual dispatch → native `ubuntu-24.04-arm` → `ghcr.io/neeomdumham/claude-usage-monitor` → GitHub Release → AWS OIDC SSM deploy.

## Done and Verified

- Repo migrated to `https://github.com/neeomdumham/claude-usage-monitor.git` (`8e6ef47`).
- **Milestone 1 (Multi-Team RBAC & Auth):**
  - Added `teams`, `users`, `user_teams`, `people.team_id`, `invites.created_by_user_id`, `audit_log.user_id` (`apps/server/src/schema.sql`), `leadsCanViewContent` policy flag (`packages/contracts/src/index.ts`), `apps/server/src/auth.ts`, team-scoped dashboard APIs & team/user CRUD (`apps/server/src/app.ts`, `apps/server/src/analytics.ts`, `apps/server/src/audit.ts`, `apps/server/src/main.ts`), and full RBAC integration tests (`apps/server/src/app.test.ts`).
  - Verified with `docker compose --profile test run --rm --build test` → `tsc` clean, **45/45 tests passing**, `vite build` clean (`155ms`), test containers removed.

## Open Items

- [ ] Milestone 2: Outside-Repo Blocking (`UserPromptSubmit` + `PreToolUse` exit `2`) & Disabled-Plugin / Ghost-Burn Webhook Alerts
- [ ] Milestone 3: Git Scoping (`INNER JOIN`), 5h/Range Alignment, Session & Effort API, 365-Day Calendar API
- [ ] Milestone 4: UI/UX Overhaul Part 1 (run `/impeccable doctor` first)
- [ ] Milestone 5: UI/UX Overhaul Part 2 (Clickable GitHub Calendar, Git, Content, Settings + Unslop/Hallmark/Impeccable/Playwright)
- [ ] Milestone 6: GitHub Actions CI + GHCR + AWS OIDC SSM Release (`v0.5.7`)
