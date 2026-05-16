import { spawnSync } from "node:child_process";
import path from "node:path";

import { test } from "bun:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const generatorPath = path.join(
  repoRoot,
  "editors",
  "vscode",
  "scripts",
  "generate-settings-reference.mjs",
);

test("docs/settings-reference.md matches the generator output", () => {
  const result = spawnSync("bun", [generatorPath, "--check"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const stderr = result.stderr ?? "";
    const stdout = result.stdout ?? "";
    throw new Error(
      `Settings reference is stale. Run:\n` +
        `  bun editors/vscode/scripts/generate-settings-reference.mjs\n\n` +
        `Generator stderr:\n${stderr}${stdout}`,
    );
  }
});
