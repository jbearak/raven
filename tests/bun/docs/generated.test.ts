import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { repoRoot } from "./_lib/manifest";

test("docs hub, llms.txt, and site nav match docs/user-pages.json", () => {
  const r = spawnSync("bun", [path.join(repoRoot, "scripts", "generate-docs-hub.ts"), "--check"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
});
