#!/usr/bin/env node
/**
 * Print one release's section of `CHANGELOG.md`, for the GitHub Release body.
 *
 * The heading is left out — the release page already carries the tag — and a version with no
 * section is a failure, not an empty body: `.github/workflows/release.yml` runs this before
 * publishing anything, so a tag pushed without notes is refused immediately.
 *
 *     node scripts/changelog-section.mjs 0.5.7
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function changelogSection(changelog, version) {
  const lines = changelog.split("\n");
  const heading = `## ${version}`;
  const start = lines.findIndex(
    (line) =>
      line.startsWith(heading) &&
      (line.length === heading.length || /\s/.test(line[heading.length] ?? "")),
  );
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i]?.startsWith("## ")) {
      end = i;
      break;
    }
  }
  return `${lines
    .slice(start + 1, end)
    .join("\n")
    .trim()}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2]?.replace(/^v/, "");
  if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    process.stderr.write("\n  usage: node scripts/changelog-section.mjs <version>\n\n");
    process.exit(2);
  }
  const section = changelogSection(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"), version);
  if (!section || section.trim() === "") {
    process.stderr.write(
      `\n  CHANGELOG.md has no section for ${version}\n  hint: run \`pnpm run changelog:draft\`, edit ## Unreleased, then \`pnpm run release:cut ${version}\`. A release with no notes is refused rather than published empty.\n\n`,
    );
    process.exit(1);
  }
  process.stdout.write(section);
}
