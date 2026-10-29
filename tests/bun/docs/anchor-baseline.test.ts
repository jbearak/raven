// Every anchor the docs exposed before the 2026-10 redesign must keep
// resolving: old releases of the CLI, the VS Code extension, and its
// Marketplace page link to them. See scripts/docs/anchor-baseline.ts.

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { repoRoot } from "./_lib/manifest";
import { anchorsOf, parse } from "./_lib/markdown";

const baseline: Record<string, string[]> = JSON.parse(
  readFileSync(path.join(repoRoot, "tests", "bun", "fixtures", "docs-anchor-baseline.json"), "utf8"),
).anchors;

test("every legacy doc anchor still resolves", () => {
  const missing: string[] = [];
  for (const [file, slugs] of Object.entries(baseline)) {
    const abs = path.join(repoRoot, file);
    if (!existsSync(abs)) {
      missing.push(`${file} (file removed)`);
      continue;
    }
    const have = anchorsOf(parse(readFileSync(abs, "utf8")));
    for (const slug of slugs) if (!have.has(slug)) missing.push(`${file}#${slug}`);
  }
  expect(missing, `Keep each as a heading or an <a id="…"></a> at the matching content`).toEqual([]);
});
