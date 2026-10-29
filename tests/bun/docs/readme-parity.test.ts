// The GitHub README and the Marketplace README must advertise the same
// feature pages, so the two can't drift apart again. Only the set of linked
// docs pages in each "What you get" section is compared; wording may differ.

import { test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { repoRoot } from "./_lib/manifest";
import { parse } from "./_lib/markdown";
import { expectNoViolations } from "./_lib/report";

const SECTION = "What you get";

function featurePages(file: string): Set<string> {
  const doc = parse(readFileSync(path.join(repoRoot, file), "utf8"));
  const start = doc.headings.find((h) => h.level === 2 && h.text === SECTION);
  if (!start) return new Set();
  const end = doc.headings.find((h) => h.line > start.line && h.level <= 2)?.line ?? Infinity;
  const pages = new Set<string>();
  for (const l of doc.links) {
    if (l.line <= start.line || l.line >= end) continue;
    const m = /(?:^|blob\/main\/)(docs\/[\w./-]+\.md)/.exec(l.target);
    if (m) pages.add(m[1]);
  }
  return pages;
}

test("both READMEs link the same feature pages", () => {
  const root = featurePages("README.md");
  const market = featurePages("editors/vscode/README.md");
  const v = [
    ...(root.size === 0 ? [`README.md has no "${SECTION}" section`] : []),
    ...(market.size === 0 ? [`editors/vscode/README.md has no "${SECTION}" section`] : []),
    ...[...root].filter((p) => !market.has(p)).map((p) => `only README.md links ${p}`),
    ...[...market].filter((p) => !root.has(p)).map((p) => `only editors/vscode/README.md links ${p}`),
  ];
  expectNoViolations("readme-parity", "readme parity", v);
});
