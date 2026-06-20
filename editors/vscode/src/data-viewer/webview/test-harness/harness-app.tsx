/**
 * Real-layout test harness for the data-viewer toolbar chip wrapping.
 *
 * Mounts the *production* toolbar markup — the real `.toolbar` structure
 * with the real `useToolbarWrap` hook, the real `ToolbarSortStrip` /
 * `FilterStrip`, and the real `styles.css` — inside the real
 * `.data-viewer-root` grid (mirroring `App.tsx`), itself inside a
 * width-pinnable `#harness-root` (the viewport analog). Running in a real
 * VS Code webview (real Chromium), it measures its own layout and posts
 * the numbers back to the extension-host test, which asserts. This is the
 * "self-measure" pattern: the host cannot read the sandboxed webview's
 * DOM, so the webview reads itself and `postMessage`s the result.
 *
 * Reproducing the real `.data-viewer-root` grid is load-bearing: the
 * toolbar is a grid item, and its automatic minimum size is what would
 * otherwise overflow the viewport (pushing the action buttons off-screen
 * and defeating the chip strips' scroll). A plain width-pinned block
 * wrapper would mask that.
 *
 * Deliberately NOT shipped: built to `dist-test/` and excluded from the
 * packaged extension. It imports neither glide-data-grid nor any
 * row-loading code: the grid below the toolbar (the data layer) is
 * omitted; only the toolbar's own containing grid matters.
 */

import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
} from 'react';
import '../styles.css';
import { ToolbarSortStrip } from '../sort-strip';
import { FilterStrip } from '../filter-strip';
import { intrinsicWidthPx, useToolbarWrap } from '../use-toolbar-wrap';
import type { ColumnSchema } from '../../arrow-reader';
import type { FilterState, SortState } from '../../messages';

// Injected by VS Code in the real webview. Declared module-scoped here
// with a permissive `postMessage` so the harness can post `test:*`
// messages that are not part of the production WebviewToExtension union.
declare function acquireVsCodeApi(): {
    postMessage(message: unknown): void;
};

// acquireVsCodeApi may be called only once per webview, so acquire it
// once at module load and reuse it for every outbound message.
const vscodeApi = acquireVsCodeApi();

// Synthetic columns with fixed labels so each chip's intrinsic width is
// real-font-rendered and stable across machines. Sized well beyond the
// chip counts any test uses, so `columnIndex` always resolves to a column.
const HARNESS_COLUMN_COUNT = 64;

const HARNESS_COLUMNS: ColumnSchema[] = Array.from(
    { length: HARNESS_COLUMN_COUNT },
    // Short, uniform-width labels keep each chip narrow and stable, so
    // ~10 chips comfortably fit a single row at 1200px yet overflow at
    // 400px (the margins the suite relies on).
    (_unused, i) => ({
        name: `c${String(i).padStart(2, '0')}`,
        arrowType: 'Int32',
        dictionaryShipped: false,
        isInteger: true,
    }),
);

// ----- Inbound message protocol (host → webview) -----

interface ResetMessage {
    type: 'test:reset';
}
interface SetWidthMessage {
    type: 'test:setWidth';
    widthPx: number;
}
interface SetStateMessage {
    type: 'test:setState';
    sortChipCount: number;
    filterChipCount: number;
    hiddenColCount: number;
    rowCountText: string;
}
interface RequestSnapshotMessage {
    type: 'test:requestSnapshot';
}

type InboundMessage =
    | ResetMessage
    | SetWidthMessage
    | SetStateMessage
    | RequestSnapshotMessage;

// ----- Outbound snapshot payload (webview → host) -----

interface PlainRect {
    top: number;
    bottom: number;
    left: number;
    right: number;
    width: number;
    height: number;
}

function plainRect(element: Element | null): PlainRect | null {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        width: r.width,
        height: r.height,
    };
}

export function HarnessApp() {
    const [widthPx, setWidthPx] = useState<number | null>(null);
    const [sortChipCount, setSortChipCount] = useState(0);
    const [filterChipCount, setFilterChipCount] = useState(0);
    const [hiddenColCount, setHiddenColCount] = useState(0);
    const [rowCountText, setRowCountText] = useState('');
    // Bumped per setWidth/reset so a snapshot is emitted even when the
    // wrap state does not change (e.g. wide → wider, both single-row).
    const [widthSetCounter, setWidthSetCounter] = useState(0);
    // Bumped on an explicit snapshot request.
    const [snapshotRequestCounter, setSnapshotRequestCounter] = useState(0);

    const rootRef = useRef<HTMLDivElement>(null);
    const toolbarRef = useRef<HTMLDivElement>(null);
    const rowCountRef = useRef<HTMLSpanElement>(null);
    const toolbarChipsRef = useRef<HTMLDivElement>(null);
    const toolbarActionsRef = useRef<HTMLDivElement>(null);
    const snapshotSeqRef = useRef(0);

    // Build synthetic SortState / FilterState from the requested counts.
    // Memoized on the counts so their identity (and thus the hook's
    // contentDeps) is stable until a count changes — matching production,
    // where `sort.keys` / `filter.entries` change identity only when the
    // user edits them.
    const sort = useMemo<SortState>(
        () => ({
            keys: Array.from({ length: sortChipCount }, (_unused, i) => ({
                columnIndex: i,
                direction: 'asc' as const,
            })),
            labelsOnWhenSorted: true,
        }),
        [sortChipCount],
    );

    const filter = useMemo<FilterState>(
        () => ({
            entries: Array.from({ length: filterChipCount }, (_unused, i) => ({
                id: `f${i}`,
                columnIndex: i,
                predicate: {
                    kind: 'numCompare' as const,
                    op: '>' as const,
                    value: 0,
                },
                enabled: true,
                includeMissing: false,
            })),
            labelsOnWhenFiltered: true,
        }),
        [filterChipCount],
    );

    // The real hook, wired with the same four refs and contentDeps shape
    // as App.tsx.
    const isWrapped = useToolbarWrap(
        {
            toolbar: toolbarRef,
            lead: rowCountRef,
            chips: toolbarChipsRef,
            actions: toolbarActionsRef,
        },
        [sort.keys, filter.entries, rowCountText, hiddenColCount],
    );

    const noop = useCallback(() => {}, []);

    // Read the live layout from the DOM (not React state) and post it to
    // the host. Reading `is-wrapped` and the computed styles directly is
    // the ground truth the assertions check.
    const postSnapshot = useCallback(() => {
        const toolbar = toolbarRef.current;
        const chips = toolbarChipsRef.current;
        if (!toolbar || !chips) return;

        // For the "row-2 scroll tier" assertion, point at the element that
        // actually carries the horizontal scrollbar. Raven puts overflow-x
        // on an inner `.sort-strip-chips` / `.filter-strip-chips` (so the
        // strip label and clear-all stay visible while chips scroll); a
        // flat strip without that inner container falls back to itself.
        const sortStrip = chips.querySelector('.sort-strip-chips')
            ?? chips.querySelector('.sort-strip');
        const filterStrip = chips.querySelector('.filter-strip-chips')
            ?? chips.querySelector('.filter-strip');
        const toolbarStyle = getComputedStyle(toolbar);
        const chipsStyle = getComputedStyle(chips);

        // Compute the same intrinsic widths the hook uses, so calibration
        // tests can place themselves precisely at the wrap boundary even
        // when strips contain nested overflow:auto scroll containers
        // (bounding-rect widths would under-report by the clipped chip
        // content). See `intrinsicWidthPx` in `use-toolbar-wrap.ts`.
        const leadIntrinsic = rowCountRef.current
            ? intrinsicWidthPx(rowCountRef.current) : 0;
        const chipsIntrinsic = Array.from(chips.children as HTMLCollectionOf<HTMLElement>)
            .reduce((sum, strip) => sum + intrinsicWidthPx(strip), 0)
            + Math.max(0, chips.children.length - 1) * 8;
        const actionsIntrinsic = toolbarActionsRef.current
            ? intrinsicWidthPx(toolbarActionsRef.current) : 0;

        snapshotSeqRef.current += 1;
        vscodeApi.postMessage({
            type: 'test:layoutSnapshot',
            seq: snapshotSeqRef.current,
            isWrapped: toolbar.classList.contains('is-wrapped'),
            toolbarRect: plainRect(toolbar),
            chipsRect: plainRect(chips),
            actionsRect: plainRect(toolbarActionsRef.current),
            leadRect: plainRect(rowCountRef.current),
            leadIntrinsicWidth: leadIntrinsic,
            chipsIntrinsicWidth: chipsIntrinsic,
            actionsIntrinsicWidth: actionsIntrinsic,
            // The width-pinned viewport analog (mirrors the production
            // `#root`): the toolbar and its action buttons must stay
            // inside this box.
            rootRect: plainRect(rootRef.current),
            chipsScrollWidth: chips.scrollWidth,
            chipsClientWidth: chips.clientWidth,
            sortStripScrollWidth: sortStrip?.scrollWidth ?? 0,
            // The strip's own client width: a strip is genuinely
            // horizontally scrollable only when its scrollWidth exceeds
            // *this* (not the chip container's width).
            sortStripClientWidth: (sortStrip as HTMLElement | null)?.clientWidth ?? 0,
            filterStripScrollWidth: filterStrip?.scrollWidth ?? 0,
            toolbarFlexWrap: toolbarStyle.flexWrap,
            chipsOrder: chipsStyle.order,
            chipsFlexBasis: chipsStyle.flexBasis,
            widthPx,
            sortChipCount,
            filterChipCount,
            hiddenColCount,
            rowCountText,
        });
    }, [widthPx, sortChipCount, filterChipCount, hiddenColCount, rowCountText]);

    // Keep a ref to the latest `postSnapshot` so the message handler
    // (subscribed once) can read the live DOM synchronously on an explicit
    // `test:requestSnapshot`. The host only requests after its change has
    // been applied, so a synchronous read is already settled — and it does
    // NOT depend on `requestAnimationFrame` firing, which stalls when the
    // webview panel is not actively painting (headless/backgrounded runs).
    const postSnapshotRef = useRef(postSnapshot);
    useLayoutEffect(() => {
        postSnapshotRef.current = postSnapshot;
    });

    // Emit a snapshot after each state/width change settles. A double
    // requestAnimationFrame lets the ResizeObserver callback →
    // setIsWrapped → React commit finish before we read the layout.
    useLayoutEffect(() => {
        let raf2 = 0;
        const raf1 = requestAnimationFrame(() => {
            raf2 = requestAnimationFrame(() => {
                postSnapshot();
            });
        });
        return () => {
            cancelAnimationFrame(raf1);
            cancelAnimationFrame(raf2);
        };
    }, [
        isWrapped,
        sortChipCount,
        filterChipCount,
        hiddenColCount,
        rowCountText,
        widthSetCounter,
        snapshotRequestCounter,
        postSnapshot,
    ]);

    // Announce readiness only after the first ResizeObserver callback
    // sees a non-zero width, so the host never measures a pre-layout
    // 0-width toolbar.
    useEffect(() => {
        const toolbar = toolbarRef.current;
        if (!toolbar || typeof ResizeObserver === 'undefined') return;
        let announced = false;
        const observer = new ResizeObserver(() => {
            if (announced) return;
            if (toolbar.clientWidth > 0) {
                announced = true;
                observer.disconnect();
                vscodeApi.postMessage({ type: 'test:ready' });
            }
        });
        observer.observe(toolbar);
        return () => observer.disconnect();
    }, []);

    // Inbound test control messages.
    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            const message = event.data as InboundMessage | undefined;
            if (!message || typeof message.type !== 'string') return;
            switch (message.type) {
                case 'test:reset':
                    setWidthPx(null);
                    setSortChipCount(0);
                    setFilterChipCount(0);
                    setHiddenColCount(0);
                    setRowCountText('');
                    setWidthSetCounter(c => c + 1);
                    break;
                case 'test:setWidth':
                    setWidthPx(message.widthPx);
                    setWidthSetCounter(c => c + 1);
                    break;
                case 'test:setState':
                    setSortChipCount(message.sortChipCount);
                    setFilterChipCount(message.filterChipCount);
                    setHiddenColCount(message.hiddenColCount);
                    setRowCountText(message.rowCountText);
                    break;
                case 'test:requestSnapshot':
                    // Read synchronously now (robust against stalled rAF),
                    // and also bump the counter so the rAF-settled path
                    // emits a follow-up snapshot.
                    postSnapshotRef.current();
                    setSnapshotRequestCounter(c => c + 1);
                    break;
            }
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, []);

    // `#harness-root` is the viewport analog (mirrors the production
    // `#root`): `display: block` + `overflow: hidden`, with a pinned
    // `widthPx`. The toolbar lives inside a real `.data-viewer-root` grid
    // (mirroring `App.tsx`) so the harness reproduces the production
    // containing block — a single auto-track grid — not a width-pinned
    // block. Setting the width here makes the real ResizeObserver fire on
    // each change; a null width leaves the baseline at full-webview width.
    const wrapperStyle: CSSProperties = {
        display: 'block',
        overflow: 'hidden',
        width: widthPx === null ? undefined : `${widthPx}px`,
    };

    return (
        <div id="harness-root" ref={rootRef} style={wrapperStyle}>
            {/* Mirror the production container (`App.tsx`): the toolbar is
                a grid item in `.data-viewer-root`, not a child of a
                width-pinned block. */}
            <div className="data-viewer-root">
                <div
                    className={isWrapped ? 'toolbar is-wrapped' : 'toolbar'}
                    ref={toolbarRef}
                >
                    <span className="row-count" ref={rowCountRef}>
                        {rowCountText}
                    </span>
                    <div className="toolbar-chips" ref={toolbarChipsRef}>
                        <ToolbarSortStrip
                            sort={sort}
                            columns={HARNESS_COLUMNS}
                            onChange={noop}
                            onClearAll={noop}
                        />
                        <FilterStrip
                            filter={filter}
                            columns={HARNESS_COLUMNS}
                            onEdit={noop}
                            onToggleEnabled={noop}
                            onRemove={noop}
                            onClearAll={noop}
                        />
                    </div>
                    <div className="toolbar-actions" ref={toolbarActionsRef}>
                        <button className="toggle" type="button">Labels</button>
                        <button className="toggle" type="button">Format</button>
                        <select className="digits" aria-label="Digits" defaultValue={3}>
                            {[0, 1, 2, 3, 4, 5, 6].map(d => (
                                <option key={d} value={d}>{d}</option>
                            ))}
                        </select>
                        <div className="columns-popover-anchor">
                            <button className="toggle" type="button">
                                Columns
                                {hiddenColCount > 0 && (
                                    <span className="hidden-count-badge">
                                        {hiddenColCount}
                                    </span>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
