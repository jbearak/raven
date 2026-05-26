/**
 * Toolbar sort chip strip.
 *
 * One chip per active sort key, in priority order. Each chip shows the
 * column name and its direction arrow. A kebab opens a tiny popover for
 * per-key actions (Flip, Remove, Move to first). A trailing ✕ clears
 * the whole sort.
 *
 * Rendered only when there is at least one active sort key — the empty
 * strip would just be wasted toolbar real estate.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import type { ColumnSchema } from '../arrow-reader';
import type { SortKey, SortState } from '../messages';
import { useDismiss } from './use-dismiss';

type Props = {
    sort: SortState;
    columns: ColumnSchema[];
    /** Replace the active sort with `keys`. The caller is responsible
     *  for posting a setSort message to the host. */
    onChange: (keys: SortKey[]) => void;
    onClearAll: () => void;
};

export function ToolbarSortStrip({ sort, columns, onChange, onClearAll }: Props) {
    if (sort.keys.length === 0) return null;
    return (
        <div className="sort-strip" role="group" aria-label="Active sort keys">
            <span className="sort-strip-label">Sort:</span>
            <div className="sort-strip-chips">
                {sort.keys.map((k, i) => (
                    <SortChip
                        key={`${k.columnIndex}-${i}`}
                        sortKey={k}
                        priority={i + 1}
                        columnName={columns[k.columnIndex]?.name ?? `col ${k.columnIndex}`}
                        onChange={onChange}
                        sortKeys={sort.keys}
                        index={i}
                    />
                ))}
            </div>
            <button
                type="button"
                className="sort-strip-clear"
                aria-label="Clear all sorts"
                title="Clear all sorts"
                onClick={onClearAll}
            >
                ✕
            </button>
        </div>
    );
}

function SortChip({
    sortKey,
    priority,
    columnName,
    sortKeys,
    index,
    onChange,
}: {
    sortKey: SortKey;
    priority: number;
    columnName: string;
    sortKeys: SortKey[];
    index: number;
    onChange: (keys: SortKey[]) => void;
}) {
    // Coords are captured at open time. The popover renders with
    // position: fixed using these coords so it escapes the chip-strip
    // container's `overflow-x: auto` clip (the strip needs horizontal
    // scrolling for many sort keys, but `overflow: auto` would
    // otherwise clip absolutely-positioned descendants).
    //
    // Open captures provisional coords from the chip's bottom-left; a
    // layout effect below measures the rendered popover and clamps to
    // the viewport so a chip near the right edge or bottom of the
    // toolbar doesn't push the popover off-screen.
    const [popoverCoords, setPopoverCoords] = useState<{ left: number; top: number } | null>(null);
    const popoverRef = useRef<HTMLDivElement>(null);
    const chipRef = useRef<HTMLButtonElement>(null);
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
    const arrow = sortKey.direction === 'asc' ? '▲' : '▼';
    const single = sortKeys.length === 1;

    const togglePopover = () => {
        if (popoverOpen) {
            setPopoverCoords(null);
            return;
        }
        const rect = chipRef.current?.getBoundingClientRect();
        if (!rect) return;
        setPopoverCoords({ left: rect.left, top: rect.bottom + 4 });
    };

    const flip = () => {
        const direction = sortKey.direction === 'asc' ? 'desc' : 'asc';
        onChange(sortKeys.map((k, i) => i === index ? { ...k, direction } : k));
        setPopoverCoords(null);
    };
    const remove = () => {
        onChange(sortKeys.filter((_, i) => i !== index));
        setPopoverCoords(null);
    };
    const moveFirst = () => {
        if (index === 0) return setPopoverCoords(null);
        const next = [...sortKeys];
        next.splice(index, 1);
        next.unshift(sortKey);
        onChange(next);
        setPopoverCoords(null);
    };

    return (
        <>
            <button
                ref={chipRef}
                type="button"
                className={popoverOpen ? 'sort-chip open' : 'sort-chip'}
                data-priority={priority}
                aria-haspopup="menu"
                aria-expanded={popoverOpen}
                aria-label={`Sort key ${priority}: ${columnName} ${sortKey.direction}ending. Open actions.`}
                onClick={togglePopover}
            >
                <span className="sort-chip-name">{columnName}</span>
                <span className="sort-chip-arrow">{arrow}</span>
            </button>
            {popoverOpen && popoverCoords && (
                <div
                    ref={popoverRef}
                    className="sort-chip-popover"
                    role="menu"
                    style={{ left: `${popoverCoords.left}px`, top: `${popoverCoords.top}px` }}
                >
                    <button
                        type="button"
                        className="sort-chip-popover-item"
                        role="menuitem"
                        onClick={flip}
                    >
                        Flip direction
                    </button>
                    <button
                        type="button"
                        className="sort-chip-popover-item"
                        role="menuitem"
                        onClick={remove}
                    >
                        Remove from sort
                    </button>
                    {!single && (
                        <button
                            type="button"
                            className="sort-chip-popover-item"
                            role="menuitem"
                            disabled={index === 0}
                            onClick={moveFirst}
                        >
                            Move to first
                        </button>
                    )}
                </div>
            )}
        </>
    );
}
