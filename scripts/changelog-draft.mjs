#!/usr/bin/env node
/**
 * Draft the next release's notes from conventional commits, into `## Unreleased` in CHANGELOG.md.
 *
 * Uses `git-cliff` with `cliff.toml` when installed, and falls back to an equivalent built-in
 * conventional-commit parser so it runs cleanly on any Node 24 machine with zero extra binaries.
 * Never overwrites notes already written under `## Unreleased` — it prints the draft and exits 1.
 *
 *     pnpm run changelog:draft
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG = join(ROOT, "CHANGELOG.md");

function fail(message, hint) {
  process.stderr.write(`\n  ${message}\n  hint: ${hint}\n\n`);
  process.exit(1);
}

function runGit(args) {
  const res = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function latestTag() {
  const res = runGit(["tag", "--list", "v*", "--sort=-v:refname"]);
  if (res.code !== 0) return "";
  return res.stdout.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
}

function draftWithCliff(range) {
  const localBin = join(ROOT, "node_modules", ".bin", "git-cliff");
  const cmd = existsSync(localBin) ? localBin : "git-cliff";
  const res = spawnSync(
    cmd,
    ["--config", join(ROOT, "cliff.toml"), range, "--ignore-tags", ".*", "--strip", "all"],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (res.error || res.status !== 0) return null;
  return res.stdout.trim();
}

function draftWithNode(range) {
  const res = runGit(["log", range, "--pretty=format:%s%x1f%b%x1e"]);
  if (res.code !== 0) fail(`git log ${range} failed`, res.stderr.trim() || "Check your git history.");

  const groups = { Features: [], Fixes: [], Performance: [] };
  const map = { feat: "Features", fix: "Fixes", perf: "Performance" };

  for (const record of res.stdout.split("\x1e")) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const [subjectRaw = "", body = ""] = trimmed.split("\x1f");
    const subject = subjectRaw.trim();
    const match = /^(feat|fix|perf)(?:\([^)]+\))?(!)?:\s*(.+)$/.exec(subject);
    if (!match) continue;
    const [, type, bang, descRaw] = match;
    const breaking = Boolean(bang) || /^BREAKING CHANGE:/m.test(body);
    const desc = descRaw.trim().replace(/\s+/g, " ");
    const cap = desc.charAt(0).toUpperCase() + desc.slice(1);
    groups[map[type]].push(`- ${breaking ? "**Breaking:** " : ""}${cap}`);
  }

  const sections = [];
  for (const name of ["Features", "Fixes", "Performance"]) {
    if (groups[name].length > 0) {
      sections.push(`### ${name}\n\n${groups[name].join("\n")}`);
    }
  }
  return sections.join("\n\n").trim();
}

const from = process.argv[2] || latestTag();
if (!from) {
  fail("No previous v* tag found", "Pass a base ref (`node scripts/changelog-draft.mjs v0.5.6`) or fetch tags.");
}
if (runGit(["rev-parse", "--verify", "--quiet", `${from}^{commit}`]).code !== 0) {
  fail(`No tag or commit ${from}`, "Fetch tags with `git fetch --tags`.");
}

const range = `${from}..HEAD`;
const draft = draftWithCliff(range) ?? draftWithNode(range);
if (!draft) {
  fail(
    `No feat, fix or perf commits since ${from}`,
    "Nothing to draft; write the notes by hand under ## Unreleased.",
  );
}

const changelog = readFileSync(CHANGELOG, "utf8");
const unreleased = /^## Unreleased\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(changelog);
if (!unreleased) {
  fail("CHANGELOG.md has no ## Unreleased heading", "Add one under # Changelog.");
}
const existing = (unreleased[1] ?? "").trim();
if (existing !== "" && existing !== "_Nothing yet._") {
  process.stdout.write(`${draft}\n`);
  fail(
    "## Unreleased already has notes, so nothing was written",
    "The draft is printed above; merge what you want by hand.",
  );
}

writeFileSync(
  CHANGELOG,
  changelog.replace(/^## Unreleased\n[\s\S]*?(?=^## |(?![\s\S]))/m, `## Unreleased\n\n${draft}\n\n`),
);
process.stdout.write(
  `drafted ${range} into CHANGELOG.md under ## Unreleased — edit it, then pnpm run release:cut <version>\n`,
);
