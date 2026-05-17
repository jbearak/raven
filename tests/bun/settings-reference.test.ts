import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

test("settings reference renders indentationUnit allowed values", () => {
  const settingsReference = readFileSync(
    path.join(repoRoot, "docs", "settings-reference.md"),
    "utf8",
  );
  const row = settingsReference
    .split("\n")
    .find((line) => line.startsWith("| `raven.linting.indentationUnit` |"));
  if (!row) {
    throw new Error("Missing raven.linting.indentationUnit row");
  }
  if (!row.includes("integer (1–8)") || !row.includes('`"auto"`')) {
    throw new Error(
      `Expected indentationUnit row to document integer 1–8 and "auto"; got:\n${row}`,
    );
  }
});
