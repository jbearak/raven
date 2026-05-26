import { useEffect, useRef, type MouseEvent } from 'react';
import { useDismiss } from './use-dismiss';

/** Sort-related slice of context-menu props. Always supplied when the
 *  menu opens for a column header; omitted for cell context menus,
 *  where sort makes no sense. */
export type SortMenuProps = {
    /** Current direction for this column in the active sort, or 'none'
     *  if this column isn't a sort key. Drives the asc/desc check
     *  rendering. */
    activeDirection: 'asc' | 'desc' | 'none';
    /** True iff any column is currently sorted. Controls the Clear-all
     *  item's enabled state. */
    anySorted: boolean;
    /** True iff at least one other column is in the sort. Drives the
     *  "Add to sort" items' visibility — they're meaningless when
     *  no other column is sorted (the sort would just be this column). */
    otherColumnsSorted: boolean;
    /** Called when the user picks Sort ascending / Sort descending.
     *  `append` is true when the user held Shift on the click — equivalent
     *  to picking the dedicated "Add to sort" item. */
    onSort: (direction: 'asc' | 'desc', append: boolean) => void;
    /** Called when the user picks Add ascending / Add descending. Always
     *  appends as the next priority key. */
    onAddToSort: (direction: 'asc' | 'desc') => void;
    /** Remove this column from the sort. Called only when the column is
     *  currently a sort key (the item is hidden otherwise). */
    onClearColumn: () => void;
    /** Clear the entire sort. Called only when `anySorted` is true. */
    onClearAll: () => void;
};

/** Filter-related slice of context-menu props. Always supplied when the
 *  menu opens for a column header; omitted for cell context menus. */
export type FilterMenuProps = {
    /** True iff this column has an active filter entry. */
    hasFilter: boolean;
    /** True iff any column has a filter entry. */
    anyFiltered: boolean;
    /** Open the filter editor for a new filter on this column. */
    onAddFilter: () => void;
    /** Remove the filter entry for this column. */
    onClearColumn: () => void;
    /** Clear all filter entries. */
    onClearAll: () => void;
};

type Props = {
    leftPx: number;
    topPx: number;
    copyLabel?: string;
    onCopy: () => void;
    onHideColumn?: () => void;
    onClose: () => void;
    /** Only present for column context menus. */
    sort?: SortMenuProps;
    /** Only present for column context menus. */
    filter?: FilterMenuProps;
};

const MARGIN_PX = 4;

export function ColumnContextMenu({
    leftPx,
    topPx,
    copyLabel = 'Copy',
    onCopy,
    onHideColumn,
    onClose,
    sort,
    filter,
}: Props) {
    const menuRef = useRef<HTMLDivElement>(null);
    useDismiss(menuRef, onClose);

    useEffect(() => {
        const el = menuRef.current;
        const parent = el?.offsetParent as HTMLElement | null;
        if (!el || !parent) return;

        let left = leftPx;
        let top = topPx;
        if (left + el.offsetWidth > parent.clientWidth - MARGIN_PX) {
            left = parent.clientWidth - el.offsetWidth - MARGIN_PX;
        }
        if (top + el.offsetHeight > parent.clientHeight - MARGIN_PX) {
            top = parent.clientHeight - el.offsetHeight - MARGIN_PX;
        }
        el.style.left = `${Math.max(MARGIN_PX, left)}px`;
        el.style.top = `${Math.max(MARGIN_PX, top)}px`;
    }, [leftPx, topPx]);

    return (
        <div
            ref={menuRef}
            className="context-menu"
            style={{ left: `${leftPx}px`, top: `${topPx}px` }}
            role="menu"
        >
            <button type="button" className="context-menu-item" onClick={onCopy} role="menuitem">
                {copyLabel}
            </button>
            {onHideColumn && (
                <button type="button" className="context-menu-item" onClick={onHideColumn} role="menuitem">
                    Hide column
                </button>
            )}
            {sort && (
                <>
                    <div className="context-menu-divider" role="separator" />
                    <button
                        type="button"
                        className={
                            sort.activeDirection === 'asc'
                                ? 'context-menu-item active'
                                : 'context-menu-item'
                        }
                        onClick={(e: MouseEvent<HTMLButtonElement>) => sort.onSort('asc', e.shiftKey)}
                        role="menuitemcheckbox"
                        aria-checked={sort.activeDirection === 'asc'}
                    >
                        <span className="context-menu-check">
                            {sort.activeDirection === 'asc' ? '✓' : ''}
                        </span>
                        Sort ascending
                        <span className="context-menu-shortcut">⇧⌥A</span>
                    </button>
                    <button
                        type="button"
                        className={
                            sort.activeDirection === 'desc'
                                ? 'context-menu-item active'
                                : 'context-menu-item'
                        }
                        onClick={(e: MouseEvent<HTMLButtonElement>) => sort.onSort('desc', e.shiftKey)}
                        role="menuitemcheckbox"
                        aria-checked={sort.activeDirection === 'desc'}
                    >
                        <span className="context-menu-check">
                            {sort.activeDirection === 'desc' ? '✓' : ''}
                        </span>
                        Sort descending
                        <span className="context-menu-shortcut">⇧⌥D</span>
                    </button>
                    {sort.otherColumnsSorted && sort.activeDirection === 'none' && (
                        <>
                            <div className="context-menu-divider" role="separator" />
                            <button
                                type="button"
                                className="context-menu-item"
                                onClick={() => sort.onAddToSort('asc')}
                                role="menuitem"
                            >
                                <span className="context-menu-check" />
                                Add ascending to sort
                            </button>
                            <button
                                type="button"
                                className="context-menu-item"
                                onClick={() => sort.onAddToSort('desc')}
                                role="menuitem"
                            >
                                <span className="context-menu-check" />
                                Add descending to sort
                            </button>
                        </>
                    )}
                    {sort.activeDirection !== 'none' && (
                        <button
                            type="button"
                            className="context-menu-item"
                            onClick={sort.onClearColumn}
                            role="menuitem"
                        >
                            <span className="context-menu-check" />
                            Clear sort on this column
                        </button>
                    )}
                    {sort.anySorted && (
                        <button
                            type="button"
                            className="context-menu-item"
                            onClick={sort.onClearAll}
                            role="menuitem"
                        >
                            <span className="context-menu-check" />
                            Clear all sorts
                            <span className="context-menu-shortcut">⇧⌥0</span>
                        </button>
                    )}
                </>
            )}
            {filter && (
                <>
                    <div className="context-menu-divider" role="separator" />
                    <button
                        type="button"
                        className="context-menu-item"
                        onClick={filter.onAddFilter}
                        role="menuitem"
                    >
                        Filter…
                        <span className="context-menu-shortcut">⇧⌥F</span>
                    </button>
                    {filter.hasFilter && (
                        <button
                            type="button"
                            className="context-menu-item"
                            onClick={filter.onClearColumn}
                            role="menuitem"
                        >
                            Clear filter on this column
                        </button>
                    )}
                    {filter.anyFiltered && (
                        <button
                            type="button"
                            className="context-menu-item"
                            onClick={filter.onClearAll}
                            role="menuitem"
                        >
                            Clear all filters
                            <span className="context-menu-shortcut">⇧⌥9</span>
                        </button>
                    )}
                </>
            )}
        </div>
    );
}
