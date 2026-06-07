/**
 * Real-layout test for the data-viewer toolbar chip wrapping.
 *
 * Runs inside a real VS Code webview (real Chromium, real flexbox). The
 * harness mounts the production toolbar markup with the real
 * `useToolbarWrap` hook and `styles.css`, pins its width, and posts its
 * measured layout back here. These cases assert the geometry the fast unit
 * tests (`tests/bun/data-viewer-toolbar-wrap.test.ts`) cannot reach: that
 * the real CSS actually wraps, the real ResizeObserver fires, and the hook
 * toggles `is-wrapped` in a real browser.
 *
 * Skipped when `RAVEN_SKIP_LAYOUT_TESTS=1` (escape hatch for sandboxes
 * that can't render a webview).
 */

import * as assert from 'assert';
import { openHarnessPanel, type HarnessController, type LayoutSnapshot } from './toolbar-wrap-harness-panel';

const ROW_TEXT = '74 rows';

// Distinct widths so the hook's clientWidth-change guard always fires
// between transitions.
const WIDE_PX = 1200;
const NARROW_PX = 400;
const MANY_CHIPS = 10;

interface SetStateOverrides {
    sortChipCount?: number;
    filterChipCount?: number;
    hiddenColCount?: number;
    rowCountText?: string;
}

function state(overrides: SetStateOverrides): Record<string, unknown> {
    return {
        type: 'test:setState',
        sortChipCount: overrides.sortChipCount ?? 0,
        filterChipCount: overrides.filterChipCount ?? 0,
        hiddenColCount: overrides.hiddenColCount ?? 0,
        rowCountText: overrides.rowCountText ?? ROW_TEXT,
    };
}

// ----- Invariant assertions -----

function assertSingleRow(snap: LayoutSnapshot, opts: { chipsPresent: boolean }): void {
    assert.strictEqual(snap.isWrapped, false, 'expected isWrapped === false');
    assert.ok(
        snap.toolbarFlexWrap === 'nowrap' || snap.toolbarFlexWrap === '',
        `expected flex-wrap nowrap/'' got "${snap.toolbarFlexWrap}"`,
    );
    assert.notStrictEqual(snap.chipsOrder, '1', 'chips must not be ordered onto row 2');
    if (opts.chipsPresent) {
        // "Same flex row" = the two boxes' vertical extents overlap.
        // Comparing tops directly is fragile: when the strip's inner
        // `overflow-x: auto` shows a *classic* horizontal scrollbar
        // (Linux/Windows Chromium, including Ubuntu CI), the chips
        // region grows ~8 px taller than the actions box, and the
        // toolbar's `align-items: center` then offsets the shorter
        // actions box downward by half that — past any tight pixel
        // threshold. On macOS overlay scrollbars take no space, which
        // is why this passed locally and failed in CI. Mirrors
        // `assertActionsOnTopRow`'s overlap check for lead vs actions.
        const verticallyOverlaps =
            snap.chipsRect.top < snap.actionsRect.bottom
            && snap.actionsRect.top < snap.chipsRect.bottom;
        assert.ok(
            verticallyOverlaps,
            `chips should share the actions row (chips=[${snap.chipsRect.top}, ${snap.chipsRect.bottom}], actions=[${snap.actionsRect.top}, ${snap.actionsRect.bottom}])`,
        );
    } else {
        // An empty chip group is a zero-height, vertically-centered flex
        // item, so its top won't match the taller actions box; the
        // meaningful single-row invariant is just that it is not on a row
        // below the actions.
        assert.ok(
            snap.chipsRect.top < snap.actionsRect.bottom,
            `empty chips should not be on a row below actions (chips.top=${snap.chipsRect.top}, actions.bottom=${snap.actionsRect.bottom})`,
        );
    }
}

function assertWrapped(snap: LayoutSnapshot): void {
    assert.strictEqual(snap.isWrapped, true, 'expected isWrapped === true');
    assert.strictEqual(
        snap.toolbarFlexWrap,
        'wrap',
        `expected flex-wrap wrap got "${snap.toolbarFlexWrap}"`,
    );
    assert.strictEqual(snap.chipsOrder, '1', 'wrapped chips should have order 1');
    assert.strictEqual(
        snap.chipsFlexBasis,
        '100%',
        `expected chips flex-basis 100% got "${snap.chipsFlexBasis}"`,
    );
    assert.ok(
        snap.chipsRect.top > snap.actionsRect.bottom,
        `wrapped chips should sit below the actions row (chips.top=${snap.chipsRect.top}, actions.bottom=${snap.actionsRect.bottom})`,
    );
}

// The toolbar lives in the production `.data-viewer-root` grid, itself
// inside the width-pinned `#harness-root` (the viewport analog,
// `overflow:hidden` like the real `#root`). Nothing the user needs may sit
// past its right edge — if the toolbar grows to its content's width and
// overflows the grid container, the action buttons are clipped off-screen.
function assertWithinViewport(snap: LayoutSnapshot): void {
    assert.ok(
        snap.toolbarRect.right <= snap.rootRect.right + 2,
        `toolbar must not overflow the viewport (toolbar.right=${snap.toolbarRect.right}, root.right=${snap.rootRect.right})`,
    );
    assert.ok(
        snap.actionsRect.right <= snap.rootRect.right + 2,
        `action buttons must stay within the viewport (actions.right=${snap.actionsRect.right}, root.right=${snap.rootRect.right})`,
    );
}

function assertActionsPinnedRight(snap: LayoutSnapshot): void {
    assert.ok(
        snap.actionsRect.right >= snap.toolbarRect.right - 12,
        `actions should stay pinned to the right edge (actions.right=${snap.actionsRect.right}, toolbar.right=${snap.toolbarRect.right})`,
    );
}

function assertActionsOnTopRow(snap: LayoutSnapshot): void {
    // The row-count text is shorter than the action buttons and both are
    // vertically centered, so their tops differ by the centering offset
    // (~half the height delta), not zero. The robust "same top row"
    // invariant is that their vertical extents overlap — which still
    // fails (correctly) if the actions were pushed down onto the wrapped
    // chip row, since that row does not overlap the row count.
    const verticallyOverlaps =
        snap.actionsRect.top < snap.leadRect.bottom
        && snap.leadRect.top < snap.actionsRect.bottom;
    assert.ok(
        verticallyOverlaps,
        `actions should remain on the top row with the row count (actions=[${snap.actionsRect.top}, ${snap.actionsRect.bottom}], lead=[${snap.leadRect.top}, ${snap.leadRect.bottom}])`,
    );
}

// Mirror the hook's needed_px so the columns-badge and hysteresis cases
// can self-calibrate a width at the wrap boundary from a measured
// single-row snapshot (taken wide enough that no region overflows).
// Uses the same intrinsic widths the hook does — bounding-rect widths
// would under-report when strips contain nested overflow:auto.
const TOOLBAR_GAP_PX = 8;
function measureNeededPx(snap: LayoutSnapshot): number {
    const widths = [snap.leadIntrinsicWidth, snap.chipsIntrinsicWidth, snap.actionsIntrinsicWidth]
        .filter(w => w > 0);
    const contentPx = widths.reduce((sum, w) => sum + w, 0);
    const gapsPx = Math.max(0, widths.length - 1) * TOOLBAR_GAP_PX;
    return contentPx + gapsPx;
}

function hasRootWidth(snap: LayoutSnapshot, widthPx: number): boolean {
    return Math.round(snap.rootRect.width) === widthPx;
}

suite('data-viewer toolbar chip wrapping (real layout)', function () {
    // Real-layout cases open a webview and await settled layout, so give
    // each case generous headroom over the snapshot polling.
    this.timeout(60000);

    let harness: HarnessController | undefined;

    suiteSetup(async function () {
        if (process.env.RAVEN_SKIP_LAYOUT_TESTS === '1') {
            // eslint-disable-next-line no-invalid-this
            this.skip();
        }
        harness = openHarnessPanel();
        await harness.waitForReady();
    });

    suiteTeardown(async () => {
        if (harness) {
            await harness.dispose();
            harness = undefined;
        }
    });

    setup(async () => {
        assert.ok(harness, 'harness not initialized');
        await harness!.reset();
    });

    test('no chips, wide → single row', async () => {
        await harness!.apply({ type: 'test:setWidth', widthPx: WIDE_PX });
        const snap = await harness!.apply(state({}), s => s.isWrapped === false);
        assertSingleRow(snap, { chipsPresent: false });
        assertActionsPinnedRight(snap);
    });

    test('many sort chips, narrow → wrapped, buttons pinned right', async () => {
        await harness!.apply({ type: 'test:setWidth', widthPx: NARROW_PX });
        const snap = await harness!.apply(
            state({ sortChipCount: MANY_CHIPS }),
            s => s.isWrapped === true,
        );
        assertWrapped(snap);
        assertActionsPinnedRight(snap);
        assertActionsOnTopRow(snap);
    });

    test('resizes wide → unwraps, then narrow → re-wraps', async () => {
        // Start wrapped at a narrow width with chips present.
        await harness!.apply({ type: 'test:setWidth', widthPx: NARROW_PX });
        const wrapped = await harness!.apply(
            state({ sortChipCount: MANY_CHIPS }),
            s => s.isWrapped === true,
        );
        assertWrapped(wrapped);

        // Widen: chips fit again, so the toolbar unwraps and chips return
        // to the actions row.
        const unwrapped = await harness!.apply(
            { type: 'test:setWidth', widthPx: WIDE_PX },
            s => s.isWrapped === false,
        );
        assertSingleRow(unwrapped, { chipsPresent: true });
        assertActionsPinnedRight(unwrapped);

        // Re-narrow to NARROW_PX (distinct from the preceding WIDE_PX, so
        // the hook's clientWidth-change guard fires): re-wraps.
        const rewrapped = await harness!.apply(
            { type: 'test:setWidth', widthPx: NARROW_PX },
            s => s.isWrapped === true,
        );
        assertWrapped(rewrapped);
    });

    test('many filter chips only, narrow → wrapped', async () => {
        await harness!.apply({ type: 'test:setWidth', widthPx: NARROW_PX });
        const snap = await harness!.apply(
            state({ filterChipCount: MANY_CHIPS }),
            s => s.isWrapped === true,
        );
        assertWrapped(snap);
        assertActionsPinnedRight(snap);
        assertActionsOnTopRow(snap);
        assert.ok(
            snap.filterStripScrollWidth > 0,
            'filter strip should be present and measured',
        );
    });

    test('wrapped chips that overflow row 2 keep actions on-screen', async () => {
        // The reported bug: with enough sort+filter chips at a narrow
        // width, the toolbar grew to its content's width inside the
        // `.data-viewer-root` grid and overflowed, pushing
        // Labels/Format/Columns off-screen instead of constraining the
        // chip row.
        await harness!.apply({ type: 'test:setWidth', widthPx: NARROW_PX });
        const snap = await harness!.apply(
            state({ sortChipCount: MANY_CHIPS, filterChipCount: MANY_CHIPS }),
            s => s.isWrapped === true,
        );
        assertWrapped(snap);
        assertWithinViewport(snap);
        assertActionsPinnedRight(snap);
        assertActionsOnTopRow(snap);
    });

    test('overflowing chips on row 2 expose the scroll tier', async () => {
        // Many sort chips (only) at a mid width: even on its own
        // full-width row the strip overflows, so the strip is
        // horizontally scrollable.
        const MID_PX = 520;
        const OVERFLOW_CHIPS = 24;
        await harness!.apply({ type: 'test:setWidth', widthPx: MID_PX });
        const snap = await harness!.apply(
            state({ sortChipCount: OVERFLOW_CHIPS }),
            s => s.isWrapped === true,
        );
        assertWrapped(snap);
        // The strip must fit within the viewport so its scrollbar is
        // reachable — not be sized to its content and clipped off-screen.
        assertWithinViewport(snap);
        assert.ok(
            snap.sortStripClientWidth <= snap.rootRect.width + 2,
            `sort strip should fit within the viewport (sortStripClientWidth=${snap.sortStripClientWidth}, root.width=${snap.rootRect.width})`,
        );
        // Genuine horizontal scroll: the strip's own content exceeds its
        // own client width.
        assert.ok(
            snap.sortStripScrollWidth > snap.sortStripClientWidth,
            `sort strip should be horizontally scrollable (scroll=${snap.sortStripScrollWidth}, client=${snap.sortStripClientWidth})`,
        );
    });

    test('Columns badge widens actions and can flip the wrap (regression)', async () => {
        // The bug guarded by `layout.hiddenColumns.length` in the
        // App.tsx contentDeps: the Columns count badge widens the action
        // buttons without changing the toolbar width, so the wrap must
        // re-measure on the hiddenColCount content-dep.
        const CHIPS = 6;
        const BADGE = 999;

        // Measure intrinsic widths at a width wide enough that nothing
        // wraps or overflows, with and without the badge.
        await harness!.apply(
            { type: 'test:setWidth', widthPx: 2000 },
            s => hasRootWidth(s, 2000),
        );
        const noBadge = await harness!.apply(
            state({ sortChipCount: CHIPS, hiddenColCount: 0 }),
            s => s.isWrapped === false && s.chipsIntrinsicWidth > 0,
        );
        const withBadge = await harness!.apply(
            state({ sortChipCount: CHIPS, hiddenColCount: BADGE }),
            s => s.isWrapped === false && s.chipsIntrinsicWidth > 0,
        );

        // (a) The badge makes the actions region wider.
        assert.ok(
            withBadge.actionsRect.width > noBadge.actionsRect.width,
            `Columns badge should widen the actions region (no=${noBadge.actionsRect.width}, with=${withBadge.actionsRect.width})`,
        );

        // (b) Tune the width to the boundary so the badge alone flips
        // the decision.
        const neededNoBadge = measureNeededPx(noBadge);
        const neededWithBadge = measureNeededPx(withBadge);
        const noBadgeFitMarginPx = 8;
        const boundaryPx = Math.ceil(neededNoBadge + noBadgeFitMarginPx);
        assert.ok(
            boundaryPx < neededWithBadge,
            `Columns badge must leave room to place the boundary between states (no=${neededNoBadge}, with=${neededWithBadge}, boundary=${boundaryPx})`,
        );

        await harness!.reset();
        await harness!.apply(
            { type: 'test:setWidth', widthPx: boundaryPx },
            s => hasRootWidth(s, boundaryPx),
        );
        const single = await harness!.apply(
            state({ sortChipCount: CHIPS, hiddenColCount: 0 }),
            s => s.isWrapped === false && s.chipsIntrinsicWidth > 0,
        );
        assertSingleRow(single, { chipsPresent: true });

        // Adding the badge (a content-dep change, NOT a width change)
        // must push it over the boundary and wrap.
        const wrapped = await harness!.apply(
            state({ sortChipCount: CHIPS, hiddenColCount: BADGE }),
            s => s.isWrapped === true,
        );
        assertWrapped(wrapped);
    });

    test('does not flap within the hysteresis band', async () => {
        const CHIPS = MANY_CHIPS;

        // Measure the wrap boundary from a wide single-row snapshot.
        await harness!.apply({ type: 'test:setWidth', widthPx: 2000 });
        const wide = await harness!.apply(
            state({ sortChipCount: CHIPS }),
            s => s.isWrapped === false,
        );
        const neededPx = measureNeededPx(wide);

        // Comfortably wide → single-row.
        const single = await harness!.apply(
            { type: 'test:setWidth', widthPx: neededPx + 60 },
            s => s.isWrapped === false,
        );
        assertSingleRow(single, { chipsPresent: true });

        // Just under needed → wraps.
        const wrapped = await harness!.apply(
            { type: 'test:setWidth', widthPx: neededPx - 20 },
            s => s.isWrapped === true,
        );
        assertWrapped(wrapped);

        // Back up but still inside the 8px hysteresis band → stays
        // wrapped. Poll for a settled snapshot rather than accepting the
        // first one: if the band logic were broken and it unwrapped, the
        // is_wrapped===true predicate never matches and the returned
        // (is_wrapped===false) snapshot fails the assertion below.
        const stillWrapped = await harness!.apply(
            { type: 'test:setWidth', widthPx: neededPx + 4 },
            s => s.isWrapped === true,
            3000,
        );
        assert.strictEqual(
            stillWrapped.isWrapped,
            true,
            `should stay wrapped within the hysteresis band (needed≈${neededPx}, width=${neededPx + 4})`,
        );

        // Clearly past the band → unwraps.
        const unwrapped = await harness!.apply(
            { type: 'test:setWidth', widthPx: neededPx + 60 },
            s => s.isWrapped === false,
        );
        assertSingleRow(unwrapped, { chipsPresent: true });
    });
});
