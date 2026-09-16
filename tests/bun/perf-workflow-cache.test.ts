import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, test } from "bun:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const workflow = readFileSync(
  path.join(repoRoot, ".github", "workflows", "perf.yml"),
  "utf8",
);

describe("performance comparison", () => {
  test("uses the exact event base and never restores cached measurements", () => {
    expect(workflow).toContain("github.event.pull_request.base.sha || github.event.before");
    expect(workflow).toContain("--base .perf-base --candidate .");
    expect(workflow).toContain("--threshold 5");
    expect(workflow).not.toContain("criterion-main-baseline");
    expect(workflow).not.toContain("path: target/criterion");
    expect(workflow).not.toContain("critcmp");
    expect(workflow).not.toContain("continue-on-error");
    expect(workflow).not.toContain("pull_request_target");
  });

  test("retains evidence after failure and does not try to comment on forks", () => {
    expect(workflow).toContain("- name: Upload benchmark evidence\n        if: always()");
    expect(workflow).toContain("raven-performance/results/");
    expect(workflow).toContain("raven-performance/metadata.json");
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  });

  test("paired measurement and regression decisions work on synthetic data", () => {
    const result = spawnSync("python3", ["scripts/test-compare-performance.py"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
