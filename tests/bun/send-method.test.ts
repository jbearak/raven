import { describe, expect, test } from "bun:test";

import {
  choose_send_transport,
  type SendMethod,
} from "../../editors/vscode/src/send-to-r/send-method";

describe("choose_send_transport", () => {
  const cases: Array<{
    name: string;
    code: string;
    sendMethod: SendMethod;
    expected: string;
  }> = [
    {
      name: "auto sends single-line code by direct paste",
      code: "x <- 1",
      sendMethod: "auto",
      expected: "direct-paste",
    },
    {
      name: "auto sends multi-line code via temp file",
      code: "x <- 1\ny <- 2",
      sendMethod: "auto",
      expected: "tempfile",
    },
    {
      name: "paste sends single-line code by direct paste",
      code: "x <- 1",
      sendMethod: "paste",
      expected: "direct-paste",
    },
    {
      name: "paste sends multi-line code by bracketed paste",
      code: "x <- 1\ny <- 2",
      sendMethod: "paste",
      expected: "bracketed-paste",
    },
    {
      name: "tempfile sends single-line code via temp file",
      code: "x <- 1",
      sendMethod: "tempfile",
      expected: "tempfile",
    },
    {
      name: "tempfile sends multi-line code via temp file",
      code: "x <- 1\ny <- 2",
      sendMethod: "tempfile",
      expected: "tempfile",
    },
  ];

  for (const { name, code, sendMethod, expected } of cases) {
    test(name, () => {
      expect(choose_send_transport(code, sendMethod)).toBe(expected);
    });
  }

  test("unknown send method falls back to auto", () => {
    expect(choose_send_transport("x <- 1", "bogus" as SendMethod)).toBe(
      "direct-paste",
    );
    expect(choose_send_transport("x <- 1\ny <- 2", "bogus" as SendMethod)).toBe(
      "tempfile",
    );
  });
});
