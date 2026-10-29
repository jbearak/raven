// Every link in the user docs, both READMEs, the hub, and llms.txt must
// resolve, including `#anchor` fragments. Code that shows doc URLs to users
// (the `raven check` footer, VS Code notifications, setting descriptions)
// must also point at files and anchors that exist.

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { checkTarget, repoUrlsIn } from "./_lib/links";
import { loadManifest, repoRoot, userPagePaths } from "./_lib/manifest";
import { parse } from "./_lib/markdown";

const manifest = loadManifest();
const docFiles = [...manifest.readmes, ...userPagePaths(manifest), "docs/README.md"].filter((f) =>
  existsSync(path.join(repoRoot, f)),
);

describe("doc links resolve", () => {
  for (const file of docFiles) {
    test(file, () => {
      const doc = parse(readFileSync(path.join(repoRoot, file), "utf8"));
      const errors = doc.links
        .map((l) => [l.line, checkTarget(file, l.target)] as const)
        .filter(([, e]) => e !== null)
        .map(([line, e]) => `${file}:${line}: ${e}`);
      expect(errors).toEqual([]);
    });
  }

  test("llms.txt", () => {
    const file = "llms.txt";
    if (!existsSync(path.join(repoRoot, file))) return;
    const errors = repoUrlsIn(readFileSync(path.join(repoRoot, file), "utf8"))
      .map((u) => checkTarget(file, u))
      .filter((e) => e !== null);
    expect(errors).toEqual([]);
  });
});

test("doc URLs in code resolve", () => {
  const files = execFileSync("git", ["ls-files", "crates", "editors", "scripts"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !f.endsWith(".md") && !f.includes("/fixtures/") && !f.includes("node_modules"));
  const errors: string[] = [];
  for (const f of files) {
    let src: string;
    try {
      src = readFileSync(path.join(repoRoot, f), "utf8");
    } catch {
      continue;
    }
    if (src.includes("\0")) continue;
    for (const url of repoUrlsIn(src)) {
      const e = checkTarget(f, url);
      if (e) errors.push(`${f}: ${e}`);
    }
  }
  expect(errors).toEqual([]);
});
