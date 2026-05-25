// Unit tests for the share-popover positioning helper.
//
// The function is pure and deterministic: given a button rect, popover
// size, and viewport size, it returns the popover's clamped (left,
// top). These tests enumerate every clamp branch:
//
//   1. WIDE / TALL: popover fits below-and-right-anchored.
//   2. NEAR-BOTTOM: below overflows, MORE room above → flip-above.
//   3. NEAR-BOTTOM, EQUAL: below overflows but above ≤ below → clamp
//      bottom edge to viewport-padding (don't flip).
//   4. WIDE BUTTON NEAR LEFT: preferred left < padding → slide right.
//   5. POPOVER WIDER THAN BUTTON-RIGHT-SPACE: right-edge clamp wins,
//      left becomes negative (off-left).
//   6. POPOVER WIDER THAN VIEWPORT: right edge clamps; left negative.
//   7. POPOVER TALLER THAN VIEWPORT: top clamps to padding (top wins).
//   8. PRESERVED INVARIANTS: the function is pure (no I/O, no DOM).

import { describe, test, expect } from 'bun:test';
import {
    POPOVER_TRIGGER_GAP,
    POPOVER_VIEWPORT_PADDING,
    compute_share_popover_position,
} from '../../editors/vscode/src/plot/webview/share-popover-position';

const PAD = POPOVER_VIEWPORT_PADDING;
const GAP = POPOVER_TRIGGER_GAP;

describe('compute_share_popover_position — typical case', () => {
    test('button at center of wide viewport: right-anchored, below', () => {
        // Viewport 1000x800, button centered at x=400-500 / y=20-40.
        // Popover 120x120.
        // Expected: right-anchored under button (left = 500-120 = 380),
        //           below button (top = 40 + 4 = 44).
        const result = compute_share_popover_position(
            { top: 20, right: 500, bottom: 40 },
            { width: 120, height: 120 },
            { width: 1000, height: 800 },
        );
        expect(result).toEqual({ left: 380, top: 44 });
    });

    test('button near right edge: popover fits within viewport', () => {
        // Viewport 200x600, button at x=170-190 / y=20-40. Popover 120x120.
        // Preferred left = 190 - 120 = 70. Right edge: 70 + 120 = 190 <
        // 200 - 4 = 196 → no slide. Final: { left: 70, top: 44 }.
        const result = compute_share_popover_position(
            { top: 20, right: 190, bottom: 40 },
            { width: 120, height: 120 },
            { width: 200, height: 600 },
        );
        expect(result).toEqual({ left: 70, top: 44 });
    });
});

describe('compute_share_popover_position — vertical clamps', () => {
    test('button near bottom: more room above → flip-above', () => {
        // Viewport 1000x300, button at y=240-260 (close to bottom).
        // Popover 120x120.
        // Below overflow: 260 + 4 + 120 = 384 > 300 - 4 = 296. Yes.
        // Room above (button.top = 240) > room below (300-260 = 40).
        // topAbove = 240 - 4 - 120 = 116, ≥ 4 → flip.
        // Expected: top = 116.
        const result = compute_share_popover_position(
            { top: 240, right: 500, bottom: 260 },
            { width: 120, height: 120 },
            { width: 1000, height: 300 },
        );
        expect(result.top).toBe(116);
    });

    test('button vertically centered, popover taller than room-below: topAbove < PAD → clamp', () => {
        // Overflow + (roomAbove == roomBelow) + (topAbove < PAD).
        //
        // ALGORITHM INVARIANT BEING VERIFIED: when there is no usable
        // room above the button (topAbove < PAD), the algorithm MUST
        // fall through to the bottom-clamp regardless of room comparison.
        //
        // Geometry: viewport 400 tall, button centered at y=190-210,
        // popover 250 tall.
        //   - Overflow: 210 + 4 + 250 = 464 > 396 ✓.
        //   - topAbove = 190 - 4 - 250 = -64. -64 < PAD=4 → flip gate
        //     fails on the topAbove side, short-circuiting the AND.
        //     roomAbove vs roomBelow is irrelevant (both 190 here).
        //   - Fallback: max(PAD, 400 - 4 - 250) = 146.
        //
        // NOTE on strict > vs >= in `roomAbove > roomBelow`: under
        // overflow, equal rooms force topAbove < PAD (algebraically:
        // a + b == V and overflow ⇒ topAbove < PAD), so the strict
        // comparator is short-circuited by the AND gate. Choosing
        // strict > over >= is therefore defensive only (matches the
        // intuition that ties keep the default below-position) — it
        // has no observable effect under the current algorithm.
        const result = compute_share_popover_position(
            { top: 190, right: 500, bottom: 210 },
            { width: 120, height: 250 },
            { width: 1000, height: 400 },
        );
        expect(result.top).toBe(146);
    });

    test('button shifted, popover too tall for either side: topAbove < PAD → clamp', () => {
        // Mirror test with roomAbove > roomBelow by 2px but popover
        // still too tall for the flip to fit. Verifies the AND gate's
        // topAbove side dominates when above doesn't have room.
        //
        // Geometry: viewport 400, button at y=191-211, popover 250.
        //   - roomAbove = 191, roomBelow = 400 - 211 = 189 (above wins by 2).
        //   - Overflow: 211 + 4 + 250 = 465 > 396 ✓.
        //   - topAbove = 191 - 4 - 250 = -63. -63 < PAD → flip fails.
        //   - Fallback: max(PAD, 400 - 4 - 250) = 146.
        const result = compute_share_popover_position(
            { top: 191, right: 500, bottom: 211 },
            { width: 120, height: 250 },
            { width: 1000, height: 400 },
        );
        expect(result.top).toBe(146);
    });

    test('button near bottom with usable room above AND overflow: flip-above', () => {
        // This is the CASE THAT ACTUALLY EXERCISES THE FLIP BRANCH.
        // We need overflow AND topAbove >= PAD AND roomAbove > roomBelow
        // simultaneously — requires button positioned such that there
        // IS genuine room above the popover.
        //
        // Geometry: viewport 400, button at y=200-220, popover 180.
        //   - Overflow: 220 + 4 + 180 = 404 > 396 ✓.
        //   - topAbove = 200 - 4 - 180 = 16. 16 >= PAD=4 ✓.
        //   - roomAbove = 200, roomBelow = 400 - 220 = 180. 200 > 180 ✓.
        //   - All three gates pass → flip. top = topAbove = 16.
        const result = compute_share_popover_position(
            { top: 200, right: 500, bottom: 220 },
            { width: 120, height: 180 },
            { width: 1000, height: 400 },
        );
        expect(result.top).toBe(16);
    });

    test('button moderately near bottom with no overflow: no flip', () => {
        // Sanity: when there IS no overflow, the flip code path is
        // never reached regardless of roomAbove/roomBelow.
        //
        // Viewport 1000x400, button at y=190-210. Popover 120x120.
        // Below: 210 + 4 + 120 = 334 < 396 ✓ (no overflow). Expected
        // top = 214 (below).
        const result = compute_share_popover_position(
            { top: 190, right: 500, bottom: 210 },
            { width: 120, height: 120 },
            { width: 1000, height: 400 },
        );
        expect(result.top).toBe(214);
    });

    test('button scrolled above viewport (button.bottom < PAD): trailing top-clamp wins', () => {
        // Edge case the trailing `if (top < PAD) top = PAD` exists for:
        // when the button's bottom is at or above the viewport's top
        // edge, `top = button.bottom + GAP` lands at a value below PAD
        // (possibly negative), and no overflow path executes because
        // the popover would happily fit below the (off-screen) button.
        // Without the final clamp, the popover would render at
        // negative top.
        //
        // Viewport 1000x800, button at y=-20 to -5 (above viewport).
        // Popover 100x100.
        // top = -5 + 4 = -1. Below overflow? -1 + 100 = 99 < 800-4=796 → no.
        // Trailing clamp: -1 < 4 → top = 4 = PAD.
        const result = compute_share_popover_position(
            { top: -20, right: 500, bottom: -5 },
            { width: 100, height: 100 },
            { width: 1000, height: 800 },
        );
        expect(result.top).toBe(PAD);
    });

    test('button at very bottom: flip-above when room above > below', () => {
        // Viewport 1000x500, button at y=480-495 (just above bottom).
        // Popover 100x100.
        // Below: 495 + 4 + 100 = 599 > 496. Overflow.
        // Room above 480 > room below 5 → flip.
        // topAbove = 480 - 4 - 100 = 376.
        const result = compute_share_popover_position(
            { top: 480, right: 500, bottom: 495 },
            { width: 100, height: 100 },
            { width: 1000, height: 500 },
        );
        expect(result.top).toBe(376);
    });

    test('popover taller than viewport: top clamps to padding (top wins)', () => {
        // Viewport 1000x100 (very short). Button at y=20-40. Popover
        // 100x300 (taller than viewport).
        // Below: 40 + 4 + 300 = 344 > 96. Overflow.
        // topAbove = 20 - 4 - 300 = -284. Not ≥ 4.
        // Fallback clamp: max(4, 100 - 4 - 300) = max(4, -204) = 4.
        // Final top < PAD check: 4 < 4 false → top = 4.
        const result = compute_share_popover_position(
            { top: 20, right: 500, bottom: 40 },
            { width: 100, height: 300 },
            { width: 1000, height: 100 },
        );
        expect(result.top).toBe(PAD);
    });
});

describe('compute_share_popover_position — horizontal clamps', () => {
    test('button near left edge: preferred left negative → slide right to padding', () => {
        // Viewport 1000x600, button at x=30-50 / y=20-40. Popover 120x60.
        // Preferred left = 50 - 120 = -70 → clamp to PAD = 4.
        // Right: 4 + 120 = 124 < 996 → no further clamp.
        const result = compute_share_popover_position(
            { top: 20, right: 50, bottom: 40 },
            { width: 120, height: 60 },
            { width: 1000, height: 600 },
        );
        expect(result.left).toBe(PAD);
    });

    test('popover wider than space-to-button-right: right-edge wins, left negative', () => {
        // Viewport 80x600, button at x=30-50 / y=20-40. Popover 120x60.
        // Preferred left = 50 - 120 = -70 → clamp to PAD = 4.
        // Right: 4 + 120 = 124 > 80 - 4 = 76 → slide left.
        // left = 80 - 4 - 120 = -44 → off-left.
        // Final state: popover's RIGHT edge at innerW - PAD = 76.
        const result = compute_share_popover_position(
            { top: 20, right: 50, bottom: 40 },
            { width: 120, height: 60 },
            { width: 80, height: 600 },
        );
        expect(result.left).toBe(-44);
        expect(result.left + 120).toBe(80 - PAD); // right edge in view
    });

    test('popover wider than viewport: right edge wins', () => {
        // Viewport 50x600, button at x=20-40 / y=20-40. Popover 120x60.
        // Preferred left = 40 - 120 = -80 → clamp to PAD = 4.
        // Right: 4 + 120 = 124 > 50 - 4 = 46 → slide left.
        // left = 50 - 4 - 120 = -74.
        // Right edge = -74 + 120 = 46 = innerW - PAD ✓.
        const result = compute_share_popover_position(
            { top: 20, right: 40, bottom: 40 },
            { width: 120, height: 60 },
            { width: 50, height: 600 },
        );
        expect(result.left + 120).toBe(50 - PAD);
    });

    test('button beyond viewport right edge (during resize): popover still clamps to viewport', () => {
        // Degenerate / transient case: button.right > viewport.width.
        // Could happen during a viewport-shrink animation before our
        // resize handler fires. Popover should still land inside the
        // viewport.
        // Viewport 100x600, button at x=80-120 / y=20-40 (button right
        // is past viewport edge). Popover 80x60.
        // Preferred left = 120 - 80 = 40 → ≥ PAD, no slide.
        // Right: 40 + 80 = 120 > 100 - 4 = 96 → slide left.
        // left = 100 - 4 - 80 = 16. Right edge = 96.
        const result = compute_share_popover_position(
            { top: 20, right: 120, bottom: 40 },
            { width: 80, height: 60 },
            { width: 100, height: 600 },
        );
        expect(result.left).toBe(16);
        expect(result.left + 80).toBe(100 - PAD);
    });
});

describe('compute_share_popover_position — purity', () => {
    test('does not mutate the input button rect', () => {
        const button = { top: 20, right: 500, bottom: 40 };
        const buttonCopy = { ...button };
        compute_share_popover_position(
            button,
            { width: 120, height: 120 },
            { width: 1000, height: 800 },
        );
        expect(button).toEqual(buttonCopy);
    });

    test('returns the same output for the same input (idempotent)', () => {
        const args = [
            { top: 30, right: 250, bottom: 50 },
            { width: 96, height: 130 },
            { width: 400, height: 600 },
        ] as const;
        const a = compute_share_popover_position(args[0], args[1], args[2]);
        const b = compute_share_popover_position(args[0], args[1], args[2]);
        expect(a).toEqual(b);
    });
});

describe('compute_share_popover_position — constant defaults', () => {
    test('POPOVER_VIEWPORT_PADDING is a small positive integer', () => {
        expect(PAD).toBeGreaterThan(0);
        expect(PAD).toBeLessThan(16);
        expect(Number.isInteger(PAD)).toBe(true);
    });

    test('POPOVER_TRIGGER_GAP is a small positive integer', () => {
        expect(GAP).toBeGreaterThan(0);
        expect(GAP).toBeLessThan(16);
        expect(Number.isInteger(GAP)).toBe(true);
    });
});
