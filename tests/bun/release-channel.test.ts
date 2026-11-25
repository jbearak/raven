import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

const repoRoot = path.resolve(__dirname, "..", "..");
const channelScript = path.join(repoRoot, "scripts", "release-channel.sh");
const tagGuardScript = path.join(repoRoot, "scripts", "check-release-tag.sh");

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

describe("check-release-tag.sh", () => {
  function guard(tag: string, manifest: string): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(tagGuardScript, [tag], { encoding: "utf8", input: manifest });
    return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
  }
  const manifest = (version: string) =>
    `[workspace]\nmembers = ["crates/raven"]\n\n[workspace.package]\nversion = "${version}"\nedition = "2024"\n`;

  test.each([
    ["v0.24.0", "0.24.0", "stable"],
    ["v0.23.9", "0.23.9", "pre-release"],
    ["v0.21.1", "0.21.1", "stable"],
    ["v1.0.0", "1.0.0", "stable"],
  ])("accepts %s on workspace version %s as %s", (tag, version, expected) => {
    expect(guard(tag, manifest(version))).toEqual({ status: 0, stdout: expected, stderr: "" });
  });

  test.each([
    // The reported case: the tag is pushed without the version bump.
    ["v0.24.0", "0.23.9"],
    ["v0.23.9", "0.24.0"],
    ["v0.23.8", "0.23.9"],
    ["v0.24.0", "0.24.0-rc.1"],
  ])("rejects %s on workspace version %s and names both", (tag, version) => {
    const result = guard(tag, manifest(version));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Tag ${tag} does not match the workspace version ${version}`);
  });

  test.each([
    ["a tag without the v prefix", "0.24.0", manifest("0.24.0")],
    ["a suffixed tag", "v0.24.0-beta.1", manifest("0.24.0-beta.1")],
    ["an empty manifest", "v0.24.0", ""],
    ["invalid TOML", "v0.24.0", "not toml [[[\n"],
    ["a version in another table", "v0.24.0", '[package]\nversion = "0.24.0"\n'],
    ["a version that is not a string", "v0.24.0", "[workspace.package]\nversion = 1\n"],
  ])("rejects %s", (_name, tag, input) => {
    const result = guard(tag, input);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ERROR:");
  });

  test("accepts this checkout's own version", () => {
    const cargoToml = readFileSync(path.join(repoRoot, "Cargo.toml"), "utf8");
    const version = /^version = "(.*)"$/m.exec(cargoToml)?.[1];
    expect(guard(`v${version}`, cargoToml).status).toBe(0);
  });
});

describe("release workflows check the tag before building or publishing", () => {
  /** Job ids and their inline `needs`, read from the workflow text. */
  function jobNeeds(workflow: string): Map<string, string[]> {
    const jobs = new Map<string, string[]>();
    let current: string | undefined;
    for (const line of workflow.slice(workflow.indexOf("\njobs:\n") + 1).split("\n")) {
      const job = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (job) {
        current = job[1];
        jobs.set(current, []);
        continue;
      }
      const needs = /^ {4}needs:\s*(\S.*)$/.exec(line);
      if (needs && current) {
        jobs.set(
          current,
          needs[1]
            .replace(/[[\]]/g, "")
            .split(",")
            .map((name) => name.trim()),
        );
      }
    }
    return jobs;
  }

  function jobText(workflow: string, job: string): string {
    const start = workflow.indexOf(`\n  ${job}:\n`);
    const next = /\n {2}[A-Za-z0-9_-]+:\n/.exec(workflow.slice(start + 1));
    return workflow.slice(start, next ? start + 1 + next.index : undefined);
  }

  test.each([
    [
      "release-build.yml",
      "release-channel",
      // The tag push checks out the tagged commit, so its Cargo.toml is the tagged one.
      'channel=$(./scripts/check-release-tag.sh "$GITHUB_REF_NAME" < Cargo.toml)',
    ],
    [
      "release-publish.yml",
      "validate",
      // The manual fallback checks out the dispatch branch, so it reads the tagged commit.
      'channel=$(git show "refs/tags/${TAG}^{commit}:Cargo.toml" | ./scripts/check-release-tag.sh "$TAG")',
    ],
  ])("%s: %s runs the guard and every other job needs it", (file, guardJob, command) => {
    const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", file), "utf8");
    const jobs = jobNeeds(workflow);
    expect(jobs.get(guardJob)).toEqual([]);

    const guardText = jobText(workflow, guardJob);
    expect(guardText).toContain(command);
    if (command.includes("|")) {
      // GitHub runs an unlabelled `run:` as `bash -e`, without pipefail.
      expect(guardText.indexOf("set -euo pipefail")).toBeGreaterThan(-1);
      expect(guardText.indexOf("set -euo pipefail")).toBeLessThan(guardText.indexOf(command));
    }

    const reachesGuard = (job: string, seen = new Set<string>()): boolean => {
      if (job === guardJob) return true;
      if (seen.has(job)) return false;
      seen.add(job);
      return (jobs.get(job) ?? []).some((needed) => reachesGuard(needed, seen));
    };
    const others = [...jobs.keys()].filter((job) => job !== guardJob);
    expect(others.length).toBeGreaterThan(0);
    for (const job of others) {
      expect({ job, reachesGuard: reachesGuard(job) }).toEqual({ job, reachesGuard: true });
    }
  });
});

describe("bump-version.sh edits", () => {
  // Runs the real script past --dry-run, with git, cargo, and npm replaced by
  // shims that only log their arguments, so nothing is committed or pushed.
  const gsed = spawnSync("sh", ["-c", "command -v gsed"], { encoding: "utf8" }).stdout.trim();
  const scratchDirs: string[] = [];
  afterAll(() => {
    for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  });

  function shim(dir: string, name: string, body: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(path.join(dir, name), 0o755);
  }

  const cargoToml = (version: string) =>
    `[workspace.package]\nversion = "${version}"\nedition = "2024"\n\n[workspace.dependencies]\nserde = { version = "1" }\n`;
  const cliDocs = (version: string) =>
    [
      `raven ${version}`,
      `raven check ${version} — static analysis`,
      `{"raven_version":"${version}","files":[]} {"raven_version":"${version}"}`,
      "Not rewritten: 0.23.9 was the previous release.",
      "",
    ].join("\n");

  function bump(sedShim?: string): { status: number | null; output: string; root: string; log: string } {
    const root = mkdtempSync(path.join(tmpdir(), "raven-bump-edits-"));
    scratchDirs.push(root);
    for (const dir of ["scripts", "docs", path.join("editors", "vscode")]) {
      mkdirSync(path.join(root, dir), { recursive: true });
    }
    for (const script of ["bump-version.sh", "release-channel.sh"]) {
      copyFileSync(path.join(repoRoot, "scripts", script), path.join(root, "scripts", script));
    }
    writeFileSync(path.join(root, "Cargo.toml"), cargoToml("0.23.9"));
    writeFileSync(path.join(root, "docs", "cli.md"), cliDocs("0.23.9"));

    const bin = path.join(root, "shim-bin");
    const log = path.join(root, "commands.log");
    // `git rev-parse` fails so the tag reads as new; `git status` prints nothing (clean tree).
    shim(bin, "git", `echo "git $*" >> "${log}"\ncase " $* " in *" rev-parse "*) exit 1 ;; esac`);
    shim(bin, "cargo", `echo "cargo $*" >> "${log}"`);
    shim(bin, "npm", `echo "npm $*" >> "${log}"`);
    if (sedShim) shim(bin, "sed", `exec "${sedShim}" "$@"`);

    const result = spawnSync("bash", [path.join(root, "scripts", "bump-version.sh"), "patch"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    });
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      root,
      log: readFileSync(log, "utf8"),
    };
  }

  // Apple sed needs `-i ''` or `-i.bak`; GNU sed takes `-i` or `-i.bak` and reads
  // the '' in `-i ''` as the script. CI's system sed is GNU; macOS covers GNU
  // through Homebrew's gsed when it is installed.
  const seds: [string, string | undefined][] = [["the system sed", undefined]];
  if (gsed) seds.push(["GNU sed (gsed)", gsed]);

  test.each(seds)("rewrites Cargo.toml and docs/cli.md with %s and leaves no backups", (_name, sedShim) => {
    const result = bump(sedShim);
    expect({ status: result.status, output: result.output }).toMatchObject({ status: 0 });
    expect(readFileSync(path.join(result.root, "Cargo.toml"), "utf8")).toBe(cargoToml("0.23.10"));
    expect(readFileSync(path.join(result.root, "docs", "cli.md"), "utf8")).toBe(cliDocs("0.23.10"));
    expect(readdirSync(result.root).sort()).toEqual(
      ["Cargo.toml", "commands.log", "docs", "editors", "scripts", "shim-bin"].sort(),
    );
    expect(readdirSync(path.join(result.root, "docs"))).toEqual(["cli.md"]);
    // The script got past both edits to staging, the commit, and the tag.
    expect(result.log).toContain("add Cargo.toml Cargo.lock editors/vscode/package.json docs/cli.md\n");
    expect(result.log).toContain("commit -m chore: bump version to 0.23.10\n");
    expect(result.log).toContain("tag v0.23.10\n");
  });
});
