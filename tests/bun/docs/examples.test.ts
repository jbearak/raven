// Doc blocks bound to the executable example corpus must equal the corpus
// byte-for-byte, and any block that looks like Raven CLI output must be
// either bound or explicitly exempted (design §5.1). The corpus itself is
// checked against the real binary by crates/raven/tests/docs_examples.rs.

import { describe, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { corpusDir, expectedBlock, looksLikeOutput, parseMarker } from "./_lib/examples";
import { loadManifest, repoRoot, userPagePaths } from "./_lib/manifest";
import { parse } from "./_lib/markdown";
import { expectNoViolations } from "./_lib/report";

const manifest = loadManifest();
const files = [...manifest.readmes, ...userPagePaths(manifest), "docs/README.md"].filter((f) =>
  existsSync(path.join(repoRoot, f)),
);

describe("doc examples", () => {
  for (const file of files) {
    test(file, () => {
      const doc = parse(readFileSync(path.join(repoRoot, file), "utf8"));
      const violations: string[] = [];
      for (const fence of doc.fences) {
        const marker = parseMarker(fence.marker);
        if (marker?.kind === "example") {
          const want = expectedBlock(marker);
          if ("error" in want) violations.push(`${file}:${fence.line}: ${want.error}`);
          else if (want.text !== fence.body)
            violations.push(`${file}:${fence.line}: block differs from corpus example "${marker.name}"`);
          continue;
        }
        if (marker?.kind === "exempt") continue;
        const why = looksLikeOutput(fence);
        if (why)
          violations.push(
            `${file}:${fence.line}: ${why} in an unmarked block; add <!-- example: … --> or <!-- example-exempt: reason -->`,
          );
      }
      expectNoViolations("examples", `examples ${file}`, violations);
    });
  }
});

test("every corpus example has cmd, stdout.txt, stderr.txt, and exit", () => {
  if (!existsSync(corpusDir)) return;
  const violations: string[] = [];
  for (const name of readdirSync(corpusDir)) {
    for (const f of ["cmd", "stdout.txt", "stderr.txt", "exit"])
      if (!existsSync(path.join(corpusDir, name, f))) violations.push(`${name}: missing ${f}`);
  }
  expectNoViolations("examples", "corpus layout", violations);
});
