import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const perfWorkflow = readFileSync(
  path.join(repoRoot, ".github", "workflows", "perf.yml"),
  "utf8",
);

function stepNamed(name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = perfWorkflow.match(
    new RegExp(
      `^      - name: ${escaped}\\n(?<body>.*?)(?=^      - name: |(?![\\s\\S]))`,
      "ms",
    ),
  );
  if (!match?.groups?.body) {
    throw new Error(`Missing perf.yml step named ${name}`);
  }
  return match.groups.body;
}

describe("perf workflow criterion baseline cache", () => {
  test("PR benchmark runs restore baselines without saving branch-scoped caches", () => {
    const restore = stepNamed("Restore Criterion baseline cache");
    expect(restore).toContain("uses: actions/cache/restore@");
    expect(restore).toContain("path: target/criterion");
    expect(restore).toContain("criterion-main-baseline-v2-${{ runner.os }}-main-");
    expect(restore).toContain("restore-keys:");
    expect(restore).not.toContain("criterion-baseline-${{ runner.os }}-");

    const save = stepNamed("Save Criterion baseline cache");
    expect(save).toContain("uses: actions/cache/save@");
    expect(save).toContain(
      "if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
    );
    expect(save).toContain("path: target/criterion");
    expect(save).toContain("criterion-main-baseline-v2-${{ runner.os }}-main-");
  });

  test("combined actions/cache is not used for criterion baselines", () => {
    const baselineStep = stepNamed("Restore Criterion baseline cache");
    expect(baselineStep).not.toContain("uses: actions/cache@");
  });

  test("PR comparison checks critcmp baseline names with the baseline listing command", () => {
    const compare = stepNamed("Compare benchmarks against main baseline");
    expect(compare).toContain("critcmp --baselines");
    expect(compare).not.toContain("critcmp --list");
  });
});
