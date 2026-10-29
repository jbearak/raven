import { describe, expect, test } from "bun:test";

import { looksLikeOutput, parseMarker } from "./_lib/examples";

const fence = (info: string, body: string) => ({ info, body });

describe("output-like blocks are detected", () => {
  const positives: [string, string, string][] = [
    ["console", "$ raven check .", "`$ raven` command"],
    ["text", "my dir/analysis file.R:4:11 warning: x is not defined [undefined-variable]", "diagnostic line"],
    ["", "main.R:1:1 note: something", "diagnostic line"],
    ["", "lint.R:2:1 info: Line is too long [LineLength_Linter]", "diagnostic line"],
    ["", "1 issues (0 errors, 1 warnings, 0 infos, 0 hints, 0 notes)", "summary line"],
    ["", "Error: raven check: unknown flag: --bogus", "CLI message"],
    ["text", "note: R was not found on PATH", "CLI message"],
    ["", "Usage: raven check [OPTIONS] [PATHS...]", "usage text"],
    ["", "raven 0.21.1", "version string"],
    ["json", '[{"path": "a.R", "diagnostic": {"severity": 2, "code": "undefined-variable"}}]', "diagnostics JSON"],
    ["json", '{"$schema": "https://json.schemastore.org/sarif-2.1.0.json", "runs": []}', "SARIF document"],
  ];
  for (const [info, body, why] of positives) {
    test(body.slice(0, 50), () => expect(looksLikeOutput(fence(info, body))).toBe(why));
  }
});

describe("ordinary blocks are not flagged", () => {
  const negatives: [string, string][] = [
    ["json", '{ "raven.diagnostics.enabled": true, "r.lsp.enabled": false }'],
    ["jsonc", '// settings.json\n{ "editor.snippetSuggestions": "bottom" }'],
    ["toml", '[packages]\nenabled = false\n# error: not output'],
    ["r", 'stop("error: bad input")\nwarning: <- 1'],
    ["lua", 'vim.lsp.config("raven", { cmd = { "raven", "--stdio" } })'],
    ["sh", "brew install jbearak/raven/raven"],
    ["", "raven --stdio"],
  ];
  for (const [info, body] of negatives) {
    test(`${info}: ${body.slice(0, 40)}`, () => expect(looksLikeOutput(fence(info, body))).toBeNull());
  }
});

describe("markers", () => {
  test("example with attributes", () => {
    expect(parseMarker("example: usage-error stream=stderr")).toEqual({
      kind: "example",
      name: "usage-error",
      file: undefined,
      stream: "stderr",
    });
    expect(parseMarker("example: getting-started-before file=main.R")).toEqual({
      kind: "example",
      name: "getting-started-before",
      file: "main.R",
      stream: "stdout",
    });
  });
  test("exempt requires a reason", () => {
    expect(parseMarker("example-exempt: absolute paths vary per machine")).toEqual({
      kind: "exempt",
      reason: "absolute paths vary per machine",
    });
    expect(parseMarker("example-exempt:")).toBeNull();
  });
  test("other comments are not markers", () => {
    expect(parseMarker("prettier-ignore")).toBeNull();
  });
});
