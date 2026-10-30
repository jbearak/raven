/**
 * Value counts (VisiData's frequency sheet): a dialog listing a column's
 * values with count, % of present rows and a bar, most common first or,
 * when every count is exact, rarest first. Clicking rows (or Space on the
 * active one) selects values; Apply filters to them with a set filter
 * (`summary-model.ts` `setFilterFor`), replacing the column's filter.
 *
 * Counts past the exact cap come from Space-Saving: each prints `≈ n ± e`
 * with its error bound, rarest-first is unavailable, and the list says
 * "approximate order" when the order isn't guaranteed.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { ColumnSchema } from '../arrow-reader';
import type { CountedEntry, ProfileKind, ValueCounts } from '../profile';
import type { Cell } from '../wire-format';
import { useDismiss } from './use-dismiss';
import { canFilterValues, formatCount, formatEstimate, formatShare } from './summary-model';

type Props = {
    column: ColumnSchema;
    kind: ProfileKind;
    result: ValueCounts | undefined;
    error: string | undefined;
    order: 'desc' | 'asc';
    leftPx: number;
    topPx: number;
    /** Display text of a counted value, as the grid formats it. */
    format: (entry: CountedEntry) => string;
    onOrder: (order: 'desc' | 'asc') => void;
    onApply: (entries: CountedEntry[]) => void;
    onClose: () => void;
};

const keyOf = (e: CountedEntry) => `${typeof e.value}:${String(e.value)}`;

export function ValueCountsPopover(props: Props) {
    const { column, result } = props;
    const ref = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const [selected, setSelected] = useState<Map<string, CountedEntry>>(new Map());
    const [active, setActive] = useState(0);
    useDismiss(ref, props.onClose);
    useEffect(() => { listRef.current?.focus(); }, [result]);

    const filterable = canFilterValues(column, props.kind);
    const single = props.kind === 'date';
    const toggle = (e: CountedEntry) => {
        if (!filterable) return;
        setSelected(prev => {
            const next = new Map(single ? [] : prev);
            if (prev.has(keyOf(e))) next.delete(keyOf(e));
            else next.set(keyOf(e), e);
            return next;
        });
    };
    const entries = result?.entries ?? [];
    const max = Math.max(1, ...entries.map(e => e.count));
    const onKeyDown = (ev: React.KeyboardEvent) => {
        if (ev.key === 'ArrowDown') { ev.preventDefault(); setActive(a => Math.min(entries.length - 1, a + 1)); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); setActive(a => Math.max(0, a - 1)); }
        else if (ev.key === ' ' && entries[active]) { ev.preventDefault(); toggle(entries[active]); }
        else if (ev.key === 'Enter' && selected.size > 0) { ev.preventDefault(); props.onApply([...selected.values()]); }
        else if (ev.key === 'Escape') { ev.preventDefault(); props.onClose(); }
    };
    useEffect(() => {
        document.getElementById(`value-count-${active}`)?.scrollIntoView?.({ block: 'nearest' });
    }, [active]);

    return (
        <div
            ref={ref}
            className="value-counts"
            role="dialog"
            aria-label={`Value counts for ${column.name}`}
            style={{ left: `${props.leftPx}px`, top: `${props.topPx}px` }}
        >
            <div className="value-counts-head">
                <span className="value-counts-title">{column.name}</span>
                {result && (
                    <span className="value-counts-meta">
                        {formatEstimate(result.distinct)} distinct · {formatCount(result.present)} present · all rows
                    </span>
                )}
            </div>
            <div className="value-counts-controls">
                <label>
                    <input
                        type="checkbox"
                        checked={props.order === 'asc'}
                        disabled={!result?.exact}
                        onChange={e => { setSelected(new Map()); props.onOrder(e.target.checked ? 'asc' : 'desc'); }}
                    />
                    Rarest first
                </label>
                {result && !result.exact && <span className="value-counts-note">counts ≈ (more than 100k values)</span>}
                {result?.approximateOrder && <span className="value-counts-note">approximate order</span>}
            </div>
            {props.error && <div className="value-counts-error" role="alert">— {props.error}</div>}
            {!result && !props.error && <div className="value-counts-loading" role="status">Counting…</div>}
            {result && (
                <div
                    ref={listRef}
                    className="value-counts-list"
                    role="listbox"
                    aria-multiselectable={!single}
                    aria-label={`Values of ${column.name}`}
                    tabIndex={0}
                    aria-activedescendant={entries.length ? `value-count-${active}` : undefined}
                    onKeyDown={onKeyDown}
                >
                    {entries.map((e, i) => {
                        const text = props.format(e);
                        const isSel = selected.has(keyOf(e));
                        const count = result.exact || e.error === 0
                            ? formatCount(e.count)
                            : `≈ ${formatCount(e.count)} ± ${formatCount(e.error)}`;
                        return (
                            <div
                                key={keyOf(e)}
                                id={`value-count-${i}`}
                                role="option"
                                aria-selected={isSel}
                                className={`value-counts-row${isSel ? ' is-selected' : ''}${i === active ? ' is-active' : ''}`}
                                onClick={() => { setActive(i); toggle(e); }}
                            >
                                <span className="value-counts-value" title={text}>{text}</span>
                                <span className="value-counts-count">{count}</span>
                                <span className="value-counts-pct">{formatShare(e.count, result.present)}</span>
                                <span className="value-counts-bar" aria-hidden="true">
                                    <span style={{ width: `${(e.count / max) * 100}%` }} />
                                </span>
                            </div>
                        );
                    })}
                    {entries.length === 0 && <div className="value-counts-loading">No values</div>}
                </div>
            )}
            <div className="value-counts-actions">
                <span className="value-counts-hint">
                    {filterable ? (single ? 'Click a date to filter to it' : 'Click values to filter to them') : 'Not filterable by value'}
                </span>
                <button type="button" className="popover-action-btn" onClick={props.onClose}>Close</button>
                <button
                    type="button"
                    className="popover-action-btn primary"
                    disabled={selected.size === 0}
                    onClick={() => props.onApply([...selected.values()])}
                >
                    Filter{selected.size > 0 ? ` (${selected.size})` : ''}
                </button>
            </div>
        </div>
    );
}

/** A counted value as the grid shows it. */
export function formatEntry(
    entry: CountedEntry,
    kind: ProfileKind,
    labelsOn: boolean,
    formatCell: (cell: Cell) => string,
    toCell: (value: CountedEntry['value']) => Cell,
): string {
    if (kind === 'factor') return labelsOn ? entry.label ?? String(Number(entry.value) + 1) : String(Number(entry.value) + 1);
    if (labelsOn && entry.label !== undefined) return entry.label;
    if (kind === 'character') return entry.value === '' ? '""' : String(entry.value);
    return formatCell(toCell(entry.value));
}
