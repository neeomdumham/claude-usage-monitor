#!/usr/bin/env node
/**
 * Cut a release in CHANGELOG.md (matching Dispach's release flow):
 *   - verifies semver and that the version is newer than the latest v* tag;
 *   - refuses a dirty tree unless --allow-dirty;
 *   - refuses an empty ## Unreleased section in CHANGELOG.md;
 *   - dates the changelog section (## <version> — YYYY-MM-DD), copying rather than consuming
 *     ## Unreleased for pre-releases;
 *   - checks the plugin version guard (and bumps plugin.json when --bump-plugin is passed);
 *   - never commits, tags, or pushes — prints the git commands for you to review and run.
 *
 *     pnpm run release:cut 0.5.8
 *     pnpm run release:cut 0.5.8 --bump-plugin
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const PLUGIN_JSON = join(ROOT, "plugin", ".claude-plugin", "plugin.json");

function fail(message, hint) {
  process.stderr.write(`\n  ${message}\n  hint: ${hint}\n\n`);
  process.exit(1);
}

function runGit(args) {
  const res = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? "" };
}

function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre.localeCompare(b.pre);
}

const argv = process.argv.slice(2);
const versionRaw = argv.find((a) => !a.startsWith("--"));
if (!versionRaw) fail("No version given", "pnpm run release:cut 0.5.8");
const version = versionRaw.replace(/^v/, "");
const parsed = parseSemver(version);
if (!parsed) fail(`"${version}" is not a valid semver`, "Use X.Y.Z or X.Y.Z-rc.1.");
const prerelease = Boolean(parsed.pre);

const lastTag = runGit(["tag", "--list", "v*", "--sort=-v:refname"]).stdout.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
if (lastTag) {
  const lastParsed = parseSemver(lastTag.replace(/^v/, ""));
  if (lastParsed && compareSemver(parsed, lastParsed) <= 0) {
    fail(`${version} is not newer than the latest tag ${lastTag}`, "Pick a higher semver number.");
  }
}

if (!argv.includes("--allow-dirty")) {
  const dirty = runGit(["status", "--porcelain"]).stdout.trim();
  if (dirty !== "") {
    fail("The working tree is not clean", "Commit or stash first, or pass --allow-dirty.");
  }
}

const changelog = readFileSync(CHANGELOG, "utf8");
const unreleased = /^## Unreleased\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(changelog);
const body = unreleased?.[1]?.trim() ?? "";
if (!unreleased || !body || body === "_Nothing yet._") {
  fail(
    "CHANGELOG.md has nothing under ## Unreleased",
    "Run `pnpm run changelog:draft`, edit the bullets under ## Unreleased, then run this again.",
  );
}

const touched = ["CHANGELOG.md"];
const pluginRaw = readFileSync(PLUGIN_JSON, "utf8");
const pluginVersion = JSON.parse(pluginRaw).version;
if (argv.includes("--bump-plugin")) {
  writeFileSync(PLUGIN_JSON, pluginRaw.replace(`"version": "${pluginVersion}"`, `"version": "${version}"`));
  touched.push("plugin/.claude-plugin/plugin.json");
} else if (lastTag) {
  const prevPluginJson = runGit(["show", `${lastTag}:plugin/.claude-plugin/plugin.json`]);
  if (prevPluginJson.code === 0) {
    const prevPluginVer = JSON.parse(prevPluginJson.stdout).version;
    const pluginChanged =
      runGit([
        "diff",
        "--quiet",
        lastTag,
        "HEAD",
        "--",
        "plugin",
        ":(exclude)plugin/test",
        ":(exclude)plugin/.claude-plugin/plugin.json",
      ]).code !== 0;
    if (pluginChanged && prevPluginVer === pluginVersion) {
      fail(
        `Plugin files changed since ${lastTag} but plugin.json is still ${pluginVersion}`,
        `Pass --bump-plugin or bump plugin/.claude-plugin/plugin.json before releasing.`,
      );
    }
  }
}

const date = new Date().toISOString().slice(0, 10);
const dated = prerelease
  ? changelog.replace(
      /^(## Unreleased\n[\s\S]*?)(?=^## |(?![\s\S]))/m,
      `$1\n## ${version} — ${date}\n\n${body}\n\n`,
    )
  : changelog.replace(
      /^## Unreleased\n/m,
      `## Unreleased\n\n_Nothing yet._\n\n## ${version} — ${date}\n`,
    );
writeFileSync(CHANGELOG, dated);

process.stdout.write(`\n  ${lastTag || "0.0.0"} → v${version}\n`);
for (const file of touched) process.stdout.write(`    ${file}\n`);
process.stdout.write(`
  Review the diff, then:

    git add ${touched.join(" ")} && git commit -m "chore(release): ${version}" && git push origin main
    git tag -a v${version} -m "v${version}" && git push origin v${version}

  ${
    prerelease
      ? "A pre-release tag publishes a GitHub Pre-release and pushes only its exact GHCR tag (never :latest)."
      : "The tag runs CI, pushes linux/arm64 to GHCR, publishes the GitHub Release from CHANGELOG.md, and deploys over SSM."
  }
  Watch it at https://github.com/neeomdumham/claude-usage-monitor/actions

`);
