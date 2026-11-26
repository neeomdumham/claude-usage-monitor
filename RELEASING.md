# Releasing

One server version, one tag (`v<version>`), semver. Short, user-facing bullets in `CHANGELOG.md`.

1. **Draft the notes:** `pnpm run changelog:draft` reads `feat`, `fix`, and `perf` commits since the last `v*` tag (using `git-cliff` + `cliff.toml`, or the built-in Node parser) and writes a draft under `## Unreleased` in `CHANGELOG.md`. Edit the bullets into clear, one-line notes for someone installing or operating the monitor (**Breaking** marked).
2. **Cut the release** from a clean, up-to-date `main`:

   ```sh
   pnpm run release:cut 0.5.8
   # or, if files under plugin/ changed:
   pnpm run release:cut 0.5.8 --bump-plugin
   ```

   This validates the version, refuses empty `## Unreleased` notes or unbumped plugin changes, dates `## <version> — YYYY-MM-DD` in `CHANGELOG.md`, and prints the git commands. It never commits, tags, or pushes.
3. **Review the diff, commit, push, and tag:**

   ```sh
   git add CHANGELOG.md && git commit -m "chore(release): 0.5.8" && git push origin main
   git tag -a v0.5.8 -m "v0.5.8" && git push origin v0.5.8
   ```

4. **Watch the workflow:** `.github/workflows/release.yml` verifies `CHANGELOG.md` has a section for `<version>`, checks the plugin bump guard, runs all three Docker test suites (`test`, `plugin-test`, `e2e`), builds `linux/arm64` natively on `ubuntu-24.04-arm`, pushes `ghcr.io/neeomdumham/claude-usage-monitor:{<version>,<major.minor>,latest}`, creates the GitHub Release using the `CHANGELOG.md` section as its body, and deploys to the EC2 host over AWS SSM via GitHub OIDC (`Production` environment).

A pre-release tag (such as `v0.5.8-rc.1`) copies `## Unreleased` without consuming it, marks the GitHub Release as a pre-release, and pushes only its exact GHCR tag (never `:latest` or `:<major.minor>`).

**Manual fallback / rollback:** `sh scripts/release.sh <version> --deploy-only` redeploys or rolls back to any previously published tag over SSM from your machine.
