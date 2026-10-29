#!/usr/bin/env bun
// Writes the content-preservation ledger skeleton for the docs redesign
// (design §5.4): one table per user page at <base-commit>, one row per H2/H3.
// Usage: bun scripts/docs/ledger-skeleton.ts <base-commit> > <ledger.md>

import { execFileSync } from "node:child_process";

import { parse } from "../../tests/bun/docs/_lib/markdown";
import { loadManifest, repoRoot, userPagePaths } from "../../tests/bun/docs/_lib/manifest";

const base = process.argv[2];
const manifest = loadManifest();
const out: string[] = [
  "# Docs redesign: content-preservation ledger",
  "",
  `Base: \`${base}\`. One row per H2/H3 section at the base commit. Disposition is one of: **kept**, **moved** (destination \`page#anchor\`), **internal** (moved to development.md), or **duplicate** (destination is the surviving home). Nothing is dropped unless it is a duplicate or internal.`,
  "",
];
for (const file of [...manifest.readmes, ...userPagePaths(manifest)]) {
  let src: string;
  try {
    src = execFileSync("git", ["show", `${base}:${file}`], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    continue;
  }
  const doc = parse(src);
  out.push(`## ${file}`, "", "| Section | Disposition | Destination / notes |", "|---|---|---|");
  for (const h of doc.headings.filter((h) => h.level === 2 || h.level === 3)) {
    out.push(`| ${"&nbsp;&nbsp;".repeat(h.level - 2)}${h.text.replace(/\|/g, "\\|")} (\`#${h.slug}\`) | | |`);
  }
  out.push("");
}
console.log(out.join("\n"));
