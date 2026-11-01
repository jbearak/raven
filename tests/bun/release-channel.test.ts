import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const channelScript = path.join(repoRoot, "scripts", "release-channel.sh");

function channel(version: string): { status: number | null; stdout: string } {
  const result = spawnSync(channelScript, [version], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout.trim() };
}

describe("release-channel.sh", () => {
  test.each([
    ["0.24.0", "stable"],
    ["v0.24.3", "stable"],
    ["1.0.0", "stable"],
    ["0.23.0", "pre-release"],
    ["v0.25.7", "pre-release"],
    ["1.1.0", "pre-release"],
    // Odd minors up to 0.21 shipped as stable before the scheme existed.
    ["0.21.1", "stable"],
    ["0.21.2", "stable"],
    ["0.19.0", "stable"],
  ])("%s is %s", (version, expected) => {
    expect(channel(version)).toEqual({ status: 0, stdout: expected });
  });

  test.each(["1.0.0-beta.1", "0.23", "01.2.3", "v", "latest"])("rejects %s", (version) => {
    const result = channel(version);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("bump-version.sh --dry-run", () => {
  // bump-version.sh reads the current version from <script dir>/../Cargo.toml,
  // so each case runs a copy of the scripts against a scratch Cargo.toml.
  const scratch = mkdtempSync(path.join(tmpdir(), "raven-bump-version-"));
  mkdirSync(path.join(scratch, "scripts"));
  for (const script of ["bump-version.sh", "release-channel.sh"]) {
    copyFileSync(path.join(repoRoot, "scripts", script), path.join(scratch, "scripts", script));
  }
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  function dryRun(current: string, bump: string): string {
    writeFileSync(path.join(scratch, "Cargo.toml"), `[workspace.package]\nversion = "${current}"\n`);
    const result = spawnSync("bash", [path.join(scratch, "scripts", "bump-version.sh"), "--dry-run", bump], {
      encoding: "utf8",
    });
    return result.status === 0 ? result.stdout.trim() : `exit ${result.status}`;
  }

  test.each([
    ["0.21.1", "patch", "0.21.2 stable"],
    ["0.21.1", "preview", "0.23.0 pre-release"],
    ["0.21.1", "minor", "0.22.0 stable"],
    ["0.23.0", "patch", "0.23.1 pre-release"],
    ["0.23.0", "preview", "0.23.1 pre-release"],
    ["0.23.4", "minor", "0.24.0 stable"],
    ["0.24.0", "patch", "0.24.1 stable"],
    ["0.24.1", "preview", "0.25.0 pre-release"],
    ["0.24.1", "minor", "0.26.0 stable"],
    ["0.25.0", "major", "1.0.0 stable"],
    ["0.24.0", "0.27.0", "0.27.0 pre-release"],
    ["0.24.0", "v0.25.0", "0.25.0 pre-release"],
    ["0.24.0", "1.0.0-beta.1", "exit 1"],
  ])("from %s, %s gives %s", (current, bump, expected) => {
    expect(dryRun(current, bump)).toBe(expected);
  });
});
