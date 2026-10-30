/**
 * The Columns sidebar: one row per column with a visibility checkbox,
 * name, type tag, label, missing bar with %, distinct count and a
 * sparkline; search by name or label; sort by position, name, type,
 * % missing or distinct; show all / hide all. Clicking a row (or Enter)
 * scrolls the grid to the column and selects it; expanding a row (→, or
 * its disclosure button) shows the type-specific stats.
 *
 * It's a `tree` of `treeitem`s with one tab stop: ↑/↓/Home/End move the
 * active row (`aria-activedescendant`), →/← expand and collapse, Enter
 * jumps, Space toggles visibility. Rows are virtualized (fixed collapsed
 * height, measured expanded height), so 2,000+ columns render only what
 * is on screen; the visible rows and the expanded one are reported
 * (`onVisibleChange`) so their profiles are computed, and only theirs.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ColumnSchema } from '../arrow-reader';
import { displayTypeTag } from '../display-format';
import type { ColumnProfile, ProfileState } from '../profile';
import type { Cell } from '../wire-format';
import {
    bandChart,
    formatEstimate,
    formatShare,
    profileStatLines,
    profileStateText,
    sidebarRows,
    type SidebarSort,
} from './summary-model';

export const SIDEBAR_DEFAULT_PX = 260;
export const SIDEBAR_MIN_PX = 180;
export const SIDEBAR_MAX_PX = 640;
const ROW_PX = 48;
const LINE_PX = 18;
const OVERSCAN = 6;

type Props = {
    columns: readonly ColumnSchema[];
    hiddenColumns: readonly number[];
    profiles: Readonly<Record<number, ProfileState>>;
    /** NA count from the header scan, if known. */
    missing: (source: number) => number | undefined;
    nrow: number;
    width: number;
    /** Format a value cell of a column as the grid would. */
    formatValue: (source: number, cell: Cell) => string;
    /** Focus this column's row (Shift+Alt+S); a new nonce refocuses. */
    focusRequest: { source: number; nonce: number } | null;
    /** The grid's selected column, highlighted here. */
    selectedSource: number | undefined;
    onToggle: (source: number) => void;
    onShowAll: () => void;
    onHideAll: () => void;
    onJump: (source: number) => void;
    onResize: (width: number) => void;
    /** Columns on screen in the sidebar, then the expanded one. */
    onVisibleChange: (sources: number[]) => void;
    onClose: () => void;
};

const SORT_LABELS: Record<SidebarSort, string> = {
    position: 'Position',
    name: 'Name',
    type: 'Type',
    missing: '% missing',
    distinct: 'Distinct',
};

function profileOf(s: ProfileState | undefined): ColumnProfile | undefined {
    return s?.state === 'ready' ? s.profile : undefined;
}

export function ColumnsSidebar(props: Props) {
    const { columns, profiles, missing, nrow } = props;
    const [query, setQuery] = useState('');
    const [sort, setSort] = useState<SidebarSort>('position');
    const [descending, setDescending] = useState(false);
    const [expanded, setExpanded] = useState<number | undefined>(undefined);
    const [active, setActive] = useState<number | undefined>(undefined);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewport, setViewport] = useState(400);
    const listRef = useRef<HTMLDivElement>(null);
    const hidden = useMemo(() => new Set(props.hiddenColumns), [props.hiddenColumns]);

    const info = useCallback((source: number) => {
        const p = profileOf(profiles[source]);
        const na = p ? p.na + p.nan : missing(source);
        return {
            missing: na === undefined ? undefined : na / Math.max(1, nrow),
            distinct: p?.distinct.value,
        };
    }, [missing, nrow, profiles]);

    const rows = useMemo(
        () => sidebarRows(columns, info, query, sort, descending),
        [columns, descending, info, query, sort],
    );

    const expandedLines = useMemo(() => {
        if (expanded === undefined) return [];
        const p = profileOf(profiles[expanded]);
        if (!p) return [];
        return profileStatLines(p, cell => props.formatValue(expanded, cell));
    }, [expanded, profiles, props]);

    /** Row tops (prefix sums); the expanded row is taller. */
    const offsets = useMemo(() => {
        const out = new Float64Array(rows.length + 1);
        for (let i = 0; i < rows.length; i++) {
            const extra = rows[i] === expanded ? Math.max(1, expandedLines.length) * LINE_PX + 10 : 0;
            out[i + 1] = out[i] + ROW_PX + extra;
        }
        return out;
    }, [expanded, expandedLines.length, rows]);

    let first = 0;
    while (first < rows.length && offsets[first + 1] <= scrollTop) first++;
    let last = first;
    while (last < rows.length && offsets[last] < scrollTop + viewport) last++;
    const from = Math.max(0, first - OVERSCAN);
    const to = Math.min(rows.length, last + OVERSCAN);

    useLayoutEffect(() => {
        const el = listRef.current;
        if (!el) return;
        setViewport(el.clientHeight || 400);
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(() => setViewport(el.clientHeight || 400));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Report what's on screen (and the expanded row) for profiling.
    const onVisibleChange = props.onVisibleChange;
    const visibleKey = `${rows.slice(first, last).join(',')}|${expanded ?? ''}`;
    useEffect(() => {
        const vis = rows.slice(first, last);
        if (expanded !== undefined && !vis.includes(expanded)) vis.unshift(expanded);
        onVisibleChange(vis);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visibleKey, onVisibleChange]);
    useEffect(() => () => onVisibleChange([]), [onVisibleChange]);

    const scrollToRow = useCallback((i: number) => {
        const el = listRef.current;
        if (!el || i < 0) return;
        const top = offsets[i];
        const bottom = offsets[i + 1];
        if (top < el.scrollTop) el.scrollTop = top;
        else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
        setScrollTop(el.scrollTop);
    }, [offsets]);

    // Shift+Alt+S: open on, and focus, the requested column's row (after
    // clearing a search that hides it).
    const focusRequest = props.focusRequest;
    const handledFocusRef = useRef<number | undefined>(undefined);
    useEffect(() => {
        if (!focusRequest || handledFocusRef.current === focusRequest.nonce) return;
        const i = rows.indexOf(focusRequest.source);
        if (i < 0) {
            if (query) setQuery('');
            else handledFocusRef.current = focusRequest.nonce;
            return;
        }
        handledFocusRef.current = focusRequest.nonce;
        setActive(focusRequest.source);
        scrollToRow(i);
        listRef.current?.focus();
    }, [focusRequest, query, rows, scrollToRow]);

    const move = (delta: number | 'home' | 'end') => {
        if (rows.length === 0) return;
        const cur = active === undefined ? -1 : rows.indexOf(active);
        const i = delta === 'home' ? 0 : delta === 'end' ? rows.length - 1
            : Math.max(0, Math.min(rows.length - 1, cur + delta));
        setActive(rows[i]);
        scrollToRow(i);
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        switch (e.key) {
            case 'ArrowDown': e.preventDefault(); move(1); return;
            case 'ArrowUp': e.preventDefault(); move(-1); return;
            case 'Home': e.preventDefault(); move('home'); return;
            case 'End': e.preventDefault(); move('end'); return;
            case 'PageDown': e.preventDefault(); move(Math.max(1, Math.floor(viewport / ROW_PX))); return;
            case 'PageUp': e.preventDefault(); move(-Math.max(1, Math.floor(viewport / ROW_PX))); return;
            case 'ArrowRight':
                if (active !== undefined) { e.preventDefault(); setExpanded(active); }
                return;
            case 'ArrowLeft':
                if (active !== undefined && expanded === active) { e.preventDefault(); setExpanded(undefined); }
                return;
            case 'Enter':
                if (active !== undefined) { e.preventDefault(); props.onJump(active); }
                return;
            case ' ':
                if (active !== undefined) { e.preventDefault(); props.onToggle(active); }
                return;
            case 'Escape':
                e.preventDefault();
                props.onClose();
                return;
        }
    };

    // Resize from the left edge.
    const onResizeStart = (e: React.PointerEvent) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = props.width;
        const onMove = (ev: PointerEvent) => {
            const w = Math.round(startW + (startX - ev.clientX));
            props.onResize(Math.max(SIDEBAR_MIN_PX, Math.min(SIDEBAR_MAX_PX, w)));
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    };

    const rowId = (source: number) => `columns-sidebar-row-${source}`;
    const shownCount = columns.length - hidden.size;

    return (
        <aside
            className="columns-sidebar"
            style={{ width: `${props.width}px` }}
            aria-label="Columns"
        >
            <div
                className="columns-sidebar-resize"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize the Columns sidebar"
                aria-valuenow={props.width}
                aria-valuemin={SIDEBAR_MIN_PX}
                aria-valuemax={SIDEBAR_MAX_PX}
                tabIndex={-1}
                onPointerDown={onResizeStart}
            />
            <div className="columns-sidebar-head">
                <span className="columns-sidebar-title">
                    Columns <span className="columns-sidebar-count">{shownCount} of {columns.length} shown</span>
                </span>
                <button type="button" className="columns-sidebar-close" aria-label="Close the Columns sidebar" onClick={props.onClose}>
                    ×
                </button>
            </div>
            <input
                type="search"
                className="columns-sidebar-search"
                placeholder="Search name or label"
                aria-label="Search columns by name or label"
                value={query}
                onChange={e => { setQuery(e.target.value); setScrollTop(0); if (listRef.current) listRef.current.scrollTop = 0; }}
            />
            <div className="columns-sidebar-controls">
                <label>
                    Sort
                    <select value={sort} onChange={e => setSort(e.target.value as SidebarSort)} aria-label="Sort columns by">
                        {(Object.keys(SORT_LABELS) as SidebarSort[]).map(k => (
                            <option key={k} value={k}>{SORT_LABELS[k]}</option>
                        ))}
                    </select>
                </label>
                <button
                    type="button"
                    className="popover-action-btn"
                    aria-label={descending ? 'Descending; switch to ascending' : 'Ascending; switch to descending'}
                    aria-pressed={descending}
                    onClick={() => setDescending(d => !d)}
                >
                    {descending ? '↓' : '↑'}
                </button>
                <span className="columns-sidebar-spacer" />
                <button type="button" className="popover-action-btn" onClick={props.onShowAll}>Show all</button>
                <button type="button" className="popover-action-btn" onClick={props.onHideAll}>Hide all</button>
            </div>
            <div
                ref={listRef}
                className="columns-sidebar-list"
                role="tree"
                aria-label="Columns"
                tabIndex={0}
                aria-activedescendant={active !== undefined && rows.includes(active) ? rowId(active) : undefined}
                onKeyDown={onKeyDown}
                onScroll={e => setScrollTop((e.target as HTMLDivElement).scrollTop)}
            >
                <div style={{ height: `${offsets[rows.length]}px`, position: 'relative' }}>
                    {rows.slice(from, to).map((source, k) => {
                        const i = from + k;
                        const col = columns[source];
                        const state = profiles[source];
                        const p = profileOf(state);
                        const na = p ? p.na + p.nan : missing(source);
                        const isExpanded = expanded === source;
                        const rowClass = ['columns-sidebar-row'];
                        if (active === source) rowClass.push('is-active');
                        if (props.selectedSource === source) rowClass.push('is-selected');
                        if (hidden.has(source)) rowClass.push('is-hidden');
                        return (
                            <div
                                key={source}
                                id={rowId(source)}
                                className={rowClass.join(' ')}
                                role="treeitem"
                                aria-level={1}
                                aria-setsize={rows.length}
                                aria-posinset={i + 1}
                                aria-expanded={isExpanded}
                                aria-selected={active === source}
                                aria-label={rowLabel(col, na, nrow, state)}
                                style={{ top: `${offsets[i]}px`, height: `${offsets[i + 1] - offsets[i]}px` }}
                                onClick={() => { setActive(source); props.onJump(source); }}
                            >
                                <div className="columns-sidebar-row-main">
                                    <button
                                        type="button"
                                        className="columns-sidebar-disclosure"
                                        tabIndex={-1}
                                        aria-hidden="true"
                                        onClick={e => { e.stopPropagation(); setActive(source); setExpanded(isExpanded ? undefined : source); }}
                                    >
                                        {isExpanded ? '▾' : '▸'}
                                    </button>
                                    <input
                                        type="checkbox"
                                        tabIndex={-1}
                                        aria-label={`Show ${col.name}`}
                                        checked={!hidden.has(source)}
                                        onClick={e => e.stopPropagation()}
                                        onChange={() => props.onToggle(source)}
                                    />
                                    <span className="columns-sidebar-name" title={col.name}>{col.name}</span>
                                    <span className="columns-sidebar-tag">{displayTypeTag(col)}</span>
                                    <span className="columns-sidebar-spacer" />
                                    <Sparkline state={state} />
                                </div>
                                <div className="columns-sidebar-row-sub">
                                    <span className="columns-sidebar-label" title={col.variableLabel}>{col.variableLabel ?? ''}</span>
                                    <MissingBar count={na} total={nrow} />
                                    <span className="columns-sidebar-distinct" title={state?.state === 'failed' ? state.error : undefined}>
                                        {state?.state === 'failed' ? '—' : p ? `${formatEstimate(p.distinct, true)} distinct` : ''}
                                    </span>
                                </div>
                                {isExpanded && (
                                    <div className="columns-sidebar-stats" role="group" aria-label={`${col.name} summary`}>
                                        {!p && <div className="columns-sidebar-stat">{profileStateText(state) ?? 'Summary: computing…'}</div>}
                                        {expandedLines.map((l, j) => (
                                            <div key={j} className="columns-sidebar-stat">
                                                <span className="columns-sidebar-stat-label">{l.label}</span>
                                                <span className="columns-sidebar-stat-value">{l.value}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
                {rows.length === 0 && <div className="columns-popover-empty">No matching columns</div>}
            </div>
        </aside>
    );
}

function rowLabel(col: ColumnSchema, na: number | undefined, nrow: number, state: ProfileState | undefined): string {
    const parts = [col.name, displayTypeTag(col)];
    if (col.variableLabel) parts.push(col.variableLabel);
    if (na !== undefined) parts.push(`${formatShare(na, nrow)} missing`);
    if (state?.state === 'ready') parts.push(`${formatEstimate(state.profile.distinct)} distinct`);
    if (state?.state === 'failed') parts.push(`summary failed: ${state.error}`);
    return parts.join(', ');
}

function MissingBar({ count, total }: { count: number | undefined; total: number }) {
    if (count === undefined) return <span className="columns-sidebar-missing is-loading" />;
    const share = total > 0 ? count / total : 0;
    return (
        <span className="columns-sidebar-missing" title={`${count.toLocaleString('en-US')} NA`}>
            <span className="columns-sidebar-missing-track">
                <span className="columns-sidebar-missing-fill" style={{ width: `${Math.round(share * 100)}%` }} />
            </span>
            <span className="columns-sidebar-missing-text">{formatShare(count, total)}</span>
        </span>
    );
}

/** A small SVG of the band's chart. */
function Sparkline({ state }: { state: ProfileState | undefined }) {
    if (!state) return <span className="columns-sidebar-spark" />;
    if (state.state === 'loading') return <span className="columns-sidebar-spark is-loading" aria-hidden="true" />;
    if (state.state === 'failed') return <span className="columns-sidebar-spark" title={state.error}>—</span>;
    const chart = bandChart(state.profile);
    const W = 60, H = 16;
    let bars: { x: number; w: number; h: number }[] = [];
    if (chart.kind === 'histogram') {
        const max = Math.max(1, ...chart.bins.map(b => b.count));
        const step = W / chart.bins.length;
        bars = chart.bins.map((b, i) => ({ x: i * step, w: Math.max(1, step - 0.5), h: b.count ? Math.max(1, (b.count / max) * H) : 0 }));
    } else if (chart.kind === 'bars') {
        const max = Math.max(1, chart.values[0]?.count ?? 1);
        const step = W / 5;
        bars = chart.values.map((e, i) => ({ x: i * step, w: step - 1, h: Math.max(1, (e.count / max) * H) }));
    } else if (chart.kind === 'logical') {
        const total = Math.max(1, chart.t + chart.f + chart.na);
        return (
            <svg className="columns-sidebar-spark" width={W} height={H} aria-hidden="true">
                <rect x={0} y={4} width={(chart.t / total) * W} height={8} className="spark-bar" />
                <rect x={(chart.t / total) * W} y={4} width={(chart.f / total) * W} height={8} className="spark-bar is-muted" />
                <rect x={((chart.t + chart.f) / total) * W} y={4} width={(chart.na / total) * W} height={8} className="spark-na" />
            </svg>
        );
    }
    return (
        <svg className="columns-sidebar-spark" width={W} height={H} aria-hidden="true">
            {bars.map((b, i) => <rect key={i} x={b.x} y={H - b.h} width={b.w} height={b.h} className="spark-bar" />)}
        </svg>
    );
}
