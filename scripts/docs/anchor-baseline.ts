#!/usr/bin/env bun
// Records the frozen legacy-anchor baseline for the docs (see
// docs/superpowers/specs/2026-10-29-docs-redesign-design.md §4.1).
//
// Usage: bun scripts/docs/anchor-baseline.ts <base-commit>
//
// Reads README.md, editors/vscode/README.md, and every manifest page that
// existed at <base-commit>, and writes every heading slug and explicit
// `<a id>` they exposed, plus every `docs/*.md#anchor` that code, tests, or
// workflows linked to, into tests/bun/fixtures/docs-anchor-baseline.json.
// The fixture is committed once and never regenerated: published links from
// old releases point at these anchors forever.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { anchorsOf, parse } from "../../tests/bun/docs/_lib/markdown";
import { loadManifest, repoRoot, userPagePaths } from "../../tests/bun/docs/_lib/manifest";

const base = process.argv[2];
if (!base) {
  console.error("usage: bun scripts/docs/anchor-baseline.ts <base-commit>");
  process.exit(2);
}

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function showAt(file: string): string | null {
  try {
    return git("show", `${base}:${file}`);
  } catch {
    return null;
  }
}

const manifest = loadManifest();
const files = [...manifest.readmes, ...userPagePaths(manifest)];
const baseline: Record<string, string[]> = {};

for (const file of files) {
  const src = showAt(file);
  if (src === null) continue;
  baseline[file] = [...anchorsOf(parse(src))].sort();
}

// Anchors that code, tests, scripts, and workflows link to at BASE.
const tracked = git("ls-tree", "-r", "--name-only", base, "crates", "editors", "scripts", "tests", ".github")
  .split("\n")
  .filter((f) => f && !f.includes("node_modules") && !f.includes("/fixtures/"));
for (const f of tracked) {
  const src = showAt(f);
  if (src === null || src.includes("\0")) continue;
  const dir = path.posix.dirname(f);
  for (const m of src.matchAll(/((?:[\w./-]*\/)?(?:docs\/)?[a-z0-9-]+\.md)#([A-Za-z0-9_-]+)/g)) {
    let target = m[1];
    const blob = target.indexOf("blob/main/");
    if (blob >= 0) target = target.slice(blob + "blob/main/".length);
    else if (!target.startsWith("docs/")) target = path.posix.normalize(path.posix.join(dir, target));
    if (!(target in baseline)) continue;
    if (!baseline[target].includes(m[2])) baseline[target].push(m[2]);
  }
}

for (const k of Object.keys(baseline)) baseline[k].sort();
const out = path.join(repoRoot, "tests", "bun", "fixtures", "docs-anchor-baseline.json");
writeFileSync(
  out,
  `${JSON.stringify({ $comment: `Frozen at ${base}. Never regenerate; see scripts/docs/anchor-baseline.ts.`, anchors: baseline }, null, 2)}\n`,
);
const total = Object.values(baseline).reduce((n, a) => n + a.length, 0);
console.log(`wrote ${total} anchors across ${Object.keys(baseline).length} files to ${path.relative(repoRoot, out)}`);
