#!/usr/bin/env bun
// Checks the built docs site's search index: each query must find its
// expected page. Run after `zensical build`. Usage: bun docs/site/search-check.ts [site-dir]

import { readFileSync } from "node:fs";
import path from "node:path";

const siteDir = process.argv[2] ?? path.join(import.meta.dir, "..", "..", "target", "docs-site");
const index: { items: { location: string; title: string; text: string }[] } = JSON.parse(
  readFileSync(path.join(siteDir, "search.json"), "utf8"),
);

// query → page (site location prefix) that must contain it
const expectations: [string, string][] = [
  ["nolint", "diagnostics/"],
  ["rConsole.activation", "coexistence/"],
  ["sourced-by", "directives/"],
  ["exit code", "cli/"],
];

let failed = false;
for (const [query, page] of expectations) {
  const q = query.toLowerCase();
  const hits = index.items.filter((i) => `${i.title} ${i.text}`.toLowerCase().includes(q));
  if (!hits.some((h) => h.location.startsWith(page))) {
    console.error(`search "${query}": expected a hit on ${page}, got ${hits.map((h) => h.location).slice(0, 5).join(", ") || "nothing"}`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`search index OK (${expectations.length} queries, ${index.items.length} entries)`);
