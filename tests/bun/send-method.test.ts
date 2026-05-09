import { describe, expect, test } from "bun:test";

import {
  choose_send_transport,
  type SendMethod,
} from "../../editors/vscode/src/send-to-r/send-method";

const lines = (n: number): string =>
  Array.from({ length: n }, (_, i) => `x${i} <- ${i}`).join("\n");

describe("choose_send_transport", () => {
  const cases: Array<{
    name: string;
    code: string;
    sendMethod: SendMethod;
    threshold: number;
    expected: string;
  }> = [
    // auto with default threshold (25)
    {
      name: "auto sends single-line code by direct paste",
      code: lines(1),
      sendMethod: "auto",
      threshold: 25,
      expected: "direct-paste",
    },
    {
      name: "auto sends 2-line block by bracketed paste (below threshold)",
      code: lines(2),
      sendMethod: "auto",
      threshold: 25,
      expected: "bracketed-paste",
    },
    {
      name: "auto sends 24-line block by bracketed paste (just below threshold)",
      code: lines(24),
      sendMethod: "auto",
      threshold: 25,
      expected: "bracketed-paste",
    },
    {
      name: "auto sends 25-line block via temp file (at threshold)",
      code: lines(25),
      sendMethod: "auto",
      threshold: 25,
      expected: "tempfile",
    },
    {
      name: "auto sends 50-line block via temp file (above threshold)",
      code: lines(50),
      sendMethod: "auto",
      threshold: 25,
      expected: "tempfile",
    },

    // auto with threshold = 2 reproduces legacy behavior (any multi-line → tempfile)
    {
      name: "auto with threshold=2 sends single-line code by direct paste",
      code: lines(1),
      sendMethod: "auto",
      threshold: 2,
      expected: "direct-paste",
    },
    {
      name: "auto with threshold=2 sends 2-line code via temp file",
      code: lines(2),
      sendMethod: "auto",
      threshold: 2,
      expected: "tempfile",
    },

    // auto with threshold below 2 is degenerate but well-defined: everything → tempfile
    {
      name: "auto with threshold=1 sends single-line code via temp file (degenerate)",
      code: lines(1),
      sendMethod: "auto",
      threshold: 1,
      expected: "tempfile",
    },
    {
      name: "auto with threshold=0 clamps to 1 (single-line → tempfile)",
      code: lines(1),
      sendMethod: "auto",
      threshold: 0,
      expected: "tempfile",
    },

    // paste mode ignores threshold
    {
      name: "paste sends single-line code by direct paste",
      code: lines(1),
      sendMethod: "paste",
      threshold: 25,
      expected: "direct-paste",
    },
    {
      name: "paste sends multi-line code by bracketed paste",
      code: lines(2),
      sendMethod: "paste",
      threshold: 25,
      expected: "bracketed-paste",
    },
    {
      name: "paste ignores threshold for large blocks",
      code: lines(100),
      sendMethod: "paste",
      threshold: 5,
      expected: "bracketed-paste",
    },

    // tempfile mode ignores threshold
    {
      name: "tempfile sends single-line code via temp file",
      code: lines(1),
      sendMethod: "tempfile",
      threshold: 25,
      expected: "tempfile",
    },
    {
      name: "tempfile sends multi-line code via temp file",
      code: lines(2),
      sendMethod: "tempfile",
      threshold: 25,
      expected: "tempfile",
    },
  ];

  for (const { name, code, sendMethod, threshold, expected } of cases) {
    test(name, () => {
      expect(choose_send_transport(code, sendMethod, threshold)).toBe(expected);
    });
  }

  test("unknown send method falls back to auto", () => {
    expect(choose_send_transport(lines(1), "bogus" as SendMethod, 25)).toBe(
      "direct-paste",
    );
    expect(choose_send_transport(lines(5), "bogus" as SendMethod, 25)).toBe(
      "bracketed-paste",
    );
    expect(choose_send_transport(lines(30), "bogus" as SendMethod, 25)).toBe(
      "tempfile",
    );
  });
});
