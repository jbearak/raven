import { describe, expect, test } from "bun:test";

import {
  snapshotReflectsMessage,
  type LayoutSnapshot,
} from "../../editors/vscode/src/test/toolbar-wrap-protocol";

const rect = {
  top: 0,
  bottom: 0,
  left: 0,
  right: 0,
  width: 0,
  height: 0,
};

function snapshot(overrides: Partial<LayoutSnapshot> = {}): LayoutSnapshot {
  return {
    type: "test:layoutSnapshot",
    seq: 1,
    isWrapped: false,
    toolbarRect: rect,
    chipsRect: rect,
    actionsRect: rect,
    leadRect: rect,
    rootRect: rect,
    leadIntrinsicWidth: 0,
    chipsIntrinsicWidth: 1,
    actionsIntrinsicWidth: 100,
    chipsScrollWidth: 0,
    chipsClientWidth: 0,
    sortStripScrollWidth: 0,
    sortStripClientWidth: 0,
    filterStripScrollWidth: 0,
    toolbarFlexWrap: "nowrap",
    chipsOrder: "0",
    chipsFlexBasis: "auto",
    widthPx: 2000,
    sortChipCount: 6,
    filterChipCount: 0,
    hiddenColCount: 0,
    rowCountText: "74 rows",
    ...overrides,
  };
}

describe("toolbar-wrap harness protocol", () => {
  test("setState waits for the requested hidden-column badge state", () => {
    const message = {
      type: "test:setState",
      sortChipCount: 6,
      filterChipCount: 0,
      hiddenColCount: 999,
      rowCountText: "74 rows",
    };

    expect(snapshotReflectsMessage(message, snapshot({ hiddenColCount: 0 }))).toBe(false);
    expect(snapshotReflectsMessage(message, snapshot({ hiddenColCount: 999 }))).toBe(true);
  });

  test("setWidth waits for the requested harness width state", () => {
    expect(
      snapshotReflectsMessage(
        { type: "test:setWidth", widthPx: 520 },
        snapshot({ widthPx: 2000 }),
      ),
    ).toBe(false);
    expect(
      snapshotReflectsMessage(
        { type: "test:setWidth", widthPx: 520 },
        snapshot({ widthPx: 520 }),
      ),
    ).toBe(true);
  });

  test("reset waits for cleared state", () => {
    expect(
      snapshotReflectsMessage(
        { type: "test:reset" },
        snapshot({ widthPx: 400, sortChipCount: 10, hiddenColCount: 7 }),
      ),
    ).toBe(false);
    expect(
      snapshotReflectsMessage(
        { type: "test:reset" },
        snapshot({ widthPx: null, sortChipCount: 0, hiddenColCount: 0, rowCountText: "" }),
      ),
    ).toBe(true);
  });
});
