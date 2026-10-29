// Binding between documentation code blocks and the executable example
// corpus in docs/examples/snippets/ (design §5.1).
//
//   <!-- example: <name> -->                 console block: `$ raven <cmd>` + stdout.txt
//   <!-- example: <name> stream=stderr -->   console block: `$ raven <cmd>` + stderr.txt
//   <!-- example: <name> stream=both -->     console block: `$ raven <cmd>` + stdout + stderr
//   <!-- example: <name> file=<path> -->     block equals that corpus file
//   <!-- example-exempt: <reason> -->        output-like block that is deliberately not asserted

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { repoRoot } from "./manifest";
import type { Fence } from "./markdown";

export const corpusDir = path.join(repoRoot, "docs", "examples", "snippets");

/** The raven crate version, which the crate inherits from the workspace. */
export function crateVersion(): string {
  const toml = Bun.TOML.parse(readFileSync(path.join(repoRoot, "Cargo.toml"), "utf8")) as {
    workspace?: { package?: { version?: string } };
  };
  const version = toml.workspace?.package?.version;
  if (!version) throw new Error("no [workspace.package] version in Cargo.toml");
  return version;
}

export type Marker =
  | { kind: "example"; name: string; file?: string; stream: "stdout" | "stderr" | "both" }
  | { kind: "exempt"; reason: string };

export function parseMarker(comment: string | null): Marker | null {
  if (!comment) return null;
  const ex = /^example:\s*([\w-]+)((?:\s+\w+=\S+)*)\s*$/.exec(comment);
  if (ex) {
    const attrs = Object.fromEntries([...ex[2].matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));
    const stream = (attrs.stream ?? "stdout") as "stdout" | "stderr" | "both";
    return { kind: "example", name: ex[1], file: attrs.file, stream };
  }
  const exempt = /^example-exempt:\s*(.+)$/.exec(comment);
  if (exempt) return { kind: "exempt", reason: exempt[1].trim() };
  return null;
}

function read(name: string, file: string): string {
  return readFileSync(path.join(corpusDir, name, file), "utf8");
}

/** The exact block content a marker promises, or an error. */
export function expectedBlock(m: Extract<Marker, { kind: "example" }>): { text: string } | { error: string } {
  const dir = path.join(corpusDir, m.name);
  if (!existsSync(dir)) return { error: `no corpus example "${m.name}"` };
  const sub = (s: string) => s.replaceAll("{{version}}", crateVersion());
  if (m.file) {
    if (!existsSync(path.join(dir, m.file))) return { error: `example "${m.name}" has no file ${m.file}` };
    return { text: read(m.name, m.file).replace(/\n$/, "") };
  }
  const cmd = read(m.name, "cmd").trim();
  const stdout = sub(read(m.name, "stdout.txt"));
  const stderr = sub(read(m.name, "stderr.txt"));
  const body = m.stream === "stdout" ? stdout : m.stream === "stderr" ? stderr : stdout + stderr;
  return { text: `$ raven ${cmd}\n${body}`.replace(/\n$/, "") };
}

// ---- No silent escapes -------------------------------------------------

const DIAGNOSTIC_LINE = /^.+:\d+:\d+:? (error|warning|info|hint|note):\s/im;
const PATTERNS: [string, RegExp][] = [
  ["`$ raven` command", /^\s*[$>] raven(\s|$)/m],
  ["diagnostic line", DIAGNOSTIC_LINE],
  ["summary line", /^\d+ issues? \(/m],
  ["CLI message", /^(error|warning|note|raven):\s/im],
  ["usage text", /^Usage: raven\b/m],
  ["version string", /^raven \d+\.\d+\.\d+/m],
  ["SARIF document", /"\$schema"\s*:\s*"[^"]*sarif|"runs"\s*:\s*\[/i],
];

/** Why a block looks like Raven CLI output, or null if it doesn't. */
export function looksLikeOutput(fence: Pick<Fence, "info" | "body">): string | null {
  const lang = fence.info.split(/\s+/)[0].toLowerCase();
  // R, TOML, YAML and Lua sources can't be CLI output; skip them so R code like
  // `stop("error: ...")` doesn't trip the CLI-message pattern.
  if (["r", "toml", "yaml", "yml", "lua", "rmd", "qmd", "stan", "jags"].includes(lang)) return null;
  for (const [why, re] of PATTERNS) if (re.test(fence.body)) return why;
  if (/"severity"\s*:/.test(fence.body) && /"code"\s*:/.test(fence.body)) return "diagnostics JSON";
  return null;
}
