/**
 * Toolbar filter chip strip.
 *
 * One chip per active filter entry. Each chip shows an enabled/disabled
 * toggle glyph and a predicate summary. A trailing kebab opens a tiny
 * popover for per-entry actions (Edit, Enable/Disable, Remove). A trailing
 * ✕ clears all filters.
 *
 * Rendered only when there is at least one filter entry — the empty strip
 * would just be wasted toolbar real estate.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import type { ColumnSchema } from '../arrow-reader';
import type { FilterEntry, FilterState } from '../messages';
import { summarizePredicate } from './predicate-summary';
import { useDismiss } from './use-dismiss';

type Props = {
    filter: FilterState;
    columns: ColumnSchema[];
    onEdit: (entry: FilterEntry) => void;
    onToggleEnabled: (id: string) => void;
    onRemove: (id: string) => void;
    onClearAll: () => void;
};

export function FilterStrip({ filter, columns, onEdit, onToggleEnabled, onRemove, onClearAll }: Props) {
    if (filter.entries.length === 0) return null;
    return (
        <div className="filter-strip" role="group" aria-label="Active filters">
            <span className="filter-strip-label">Filter:</span>
            <div className="filter-strip-chips">
                {filter.entries.map(entry => (
                    <FilterChip
                        key={entry.id}
                        entry={entry}
                        column={columns[entry.columnIndex]}
                        onEdit={onEdit}
                        onToggleEnabled={onToggleEnabled}
                        onRemove={onRemove}
                    />
                ))}
            </div>
            <button
                type="button"
                className="filter-strip-clear"
                aria-label="Clear all filters"
                title="Clear all filters"
                onClick={onClearAll}
            >
                ✕
            </button>
        </div>
    );
}

function FilterChip({
    entry,
    column,
    onEdit,
    onToggleEnabled,
    onRemove,
}: {
    entry: FilterEntry;
    column: ColumnSchema | undefined;
    onEdit: (entry: FilterEntry) => void;
    onToggleEnabled: (id: string) => void;
    onRemove: (id: string) => void;
}) {
    // Fixed-position popover coords captured at open time, clamped to
    // viewport via a layout effect — same pattern as SortChip. This escapes
    // the chip-strip container's `overflow-x: auto` clip.
    const [popoverCoords, setPopoverCoords] = useState<{ left: number; top: number } | null>(null);
    const popoverRef = useRef<HTMLDivElement>(null);
    const kebabRef = useRef<HTMLButtonElement>(null);
    useDismiss(popoverRef, () => setPopoverCoords(null));

    useLayoutEffect(() => {
        const el = popoverRef.current;
        if (!el || !popoverCoords) return;
        const MARGIN = 4;
        const rect = el.getBoundingClientRect();
        const maxLeft = Math.max(MARGIN, window.innerWidth - rect.width - MARGIN);
        const maxTop = Math.max(MARGIN, window.innerHeight - rect.height - MARGIN);
        const clampedLeft = Math.min(Math.max(MARGIN, popoverCoords.left), maxLeft);
        const clampedTop = Math.min(Math.max(MARGIN, popoverCoords.top), maxTop);
        if (clampedLeft !== popoverCoords.left || clampedTop !== popoverCoords.top) {
            setPopoverCoords({ left: clampedLeft, top: clampedTop });
        }
    }, [popoverCoords]);

    const popoverOpen = popoverCoords !== null;

    const togglePopover = () => {
        if (popoverOpen) {
            setPopoverCoords(null);
            return;
        }
        const rect = kebabRef.current?.getBoundingClientRect();
        if (!rect) return;
        setPopoverCoords({ left: rect.left, top: rect.bottom + 4 });
    };

    // Determine display text — guard against a column that was dropped.
    const missing = column === undefined;
    const summaryText = missing
        ? '(removed column)'
        : summarizePredicate(entry.predicate, column);

    const toggleGlyph = entry.enabled ? '✓' : '✗';
    const ariaLabel = `Filter: ${summaryText}. ${entry.enabled ? 'Enabled' : 'Disabled'}. Open actions.`;

    const handleEdit = () => {
        if (!missing) onEdit(entry);
    };

    const handleToggle = () => {
        onToggleEnabled(entry.id);
        setPopoverCoords(null);
    };

    const handleRemove = () => {
        onRemove(entry.id);
        setPopoverCoords(null);
    };

    const handleEditFromMenu = () => {
        if (!missing) onEdit(entry);
        setPopoverCoords(null);
    };

    return (
        <>
            <div className={entry.enabled ? 'filter-chip' : 'filter-chip disabled'}>
                <span className="filter-chip-toggle">{toggleGlyph}</span>
                <button
                    type="button"
                    className="filter-chip-body"
                    aria-label={ariaLabel}
                    aria-pressed={entry.enabled}
                    onClick={handleEdit}
                >
                    {summaryText}
                </button>
                <button
                    ref={kebabRef}
                    type="button"
                    className={popoverOpen ? 'filter-chip-kebab open' : 'filter-chip-kebab'}
                    aria-label="Filter actions"
                    aria-haspopup="menu"
                    aria-expanded={popoverOpen}
                    onClick={togglePopover}
                >
                    ⋯
                </button>
            </div>
            {popoverOpen && popoverCoords && (
                <div
                    ref={popoverRef}
                    className="filter-chip-popover"
                    role="menu"
                    style={{ left: `${popoverCoords.left}px`, top: `${popoverCoords.top}px` }}
                >
                    {!missing && (
                        <button
                            type="button"
                            className="filter-chip-popover-item"
                            role="menuitem"
                            onClick={handleEditFromMenu}
                        >
                            Edit
                        </button>
                    )}
                    <button
                        type="button"
                        className="filter-chip-popover-item"
                        role="menuitem"
                        onClick={handleToggle}
                    >
                        {entry.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                        type="button"
                        className="filter-chip-popover-item"
                        role="menuitem"
                        onClick={handleRemove}
                    >
                        Remove
                    </button>
                </div>
            )}
        </>
    );
}
