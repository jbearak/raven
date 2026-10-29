#!/usr/bin/env bun
// Rewrites relative links in user pages that point at files the docs site
// doesn't publish (internal pages, example YAML) to absolute blob/main URLs.
// Usage: bun scripts/docs/absolutize-unpublished-links.ts docs/a.md [docs/b.md ...]

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { repoRoot, userPagePaths } from "../../tests/bun/docs/_lib/manifest";

const published = new Set([...userPagePaths(), "docs/README.md"]);
for (const file of process.argv.slice(2)) {
  const abs = path.join(repoRoot, file);
  const src = readFileSync(abs, "utf8");
  const out = src.replace(/\]\(([^)\s#:]+)(#[^)\s]*)?\)/g, (m, target: string, frag = "") => {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
    if (!resolved.startsWith("docs/") || published.has(resolved) || resolved.startsWith("docs/images/")) return m;
    return `](https://github.com/jbearak/raven/blob/main/${resolved}${frag})`;
  });
  if (out !== src) {
    writeFileSync(abs, out);
    console.log(`updated ${file}`);
  }
}
