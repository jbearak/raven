import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import type { StringOrder } from '../messages';
import { useDismiss } from './use-dismiss';

/** The string orders as the "Sort text by" submenu shows them, in menu
 *  order. `label` is the menu item, `chip` the Sort strip's reminder,
 *  `example` a two-value order shown beside the item, `title` its
 *  tooltip. */
export const STRING_ORDERS: { order: StringOrder; label: string; chip: string; example: string; title: string }[] = [
    {
        order: 'natural', label: 'Natural', chip: 'Natural', example: 'file2, file10',
        title: 'Alphabetical in your VS Code display language, with runs of digits compared as numbers',
    },
    {
        order: 'locale', label: 'Alphabetical', chip: 'Alphabetical', example: 'file10, file2',
        title: 'Alphabetical in your VS Code display language, one character at a time',
    },
    {
        order: 'c', label: 'As dplyr (fast)', chip: 'As dplyr', example: 'Z, a',
        title: 'Unicode code point order (uppercase before lowercase), as dplyr::arrange() and sort(method = "radix")',
    },
];

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
    /** String order for text and label keys, remembered per panel. */
    stringOrder: StringOrder;
    onStringOrder: (order: StringOrder) => void;
    /** Open the docs' explanation of the string orders. */
    onExplainStringOrder: () => void;
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
    /** "Copy with row names": the same copy with the rowname column (or,
     *  without one, the R row numbers) prepended. */
    onCopyWithRowNames?: () => void;
    onHideColumn?: () => void;
    /** Pin or unpin the column (column menus only); `pinned` says which. */
    pin?: { pinned: boolean; onToggle: () => void };
    /** Open the column's value counts (column menus only). */
    onValueCounts?: () => void;
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
    onCopyWithRowNames,
    onHideColumn,
    pin,
    onValueCounts,
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
            {onCopyWithRowNames && (
                <button type="button" className="context-menu-item" onClick={onCopyWithRowNames} role="menuitem">
                    Copy with row names
                </button>
            )}
            {onHideColumn && (
                <button type="button" className="context-menu-item" onClick={onHideColumn} role="menuitem">
                    Hide column
                </button>
            )}
            {pin && (
                <button type="button" className="context-menu-item" onClick={pin.onToggle} role="menuitem">
                    {pin.pinned ? 'Unpin column' : 'Pin column'}
                </button>
            )}
            {onValueCounts && (
                <button type="button" className="context-menu-item" onClick={onValueCounts} role="menuitem">
                    Value counts…
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
                    <div className="context-menu-divider" role="separator" />
                    <SortTextBySubmenu sort={sort} />
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
                        {filter.hasFilter ? 'Edit filter…' : 'Filter…'}
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

/** "Sort text by ▸": the string orders, then Explain…. Opens on hover,
 *  click, or ArrowRight, to the right unless that would overflow the
 *  panel. */
function SortTextBySubmenu({ sort }: { sort: SortMenuProps }) {
    const [open, setOpen] = useState(false);
    const [flip, setFlip] = useState(false);
    const submenuRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const el = submenuRef.current;
        if (!open || !el) return;
        // The panel the column menu is positioned in.
        const menu = el.parentElement?.closest<HTMLElement>('.context-menu');
        const bounds = (menu?.offsetParent ?? document.documentElement).getBoundingClientRect();
        const rect = el.getBoundingClientRect();
        setFlip(rect.right > bounds.right - MARGIN_PX);
        // Lift it to stay inside a short pane, as the parent menu does.
        const overflow = rect.bottom - (bounds.bottom - MARGIN_PX);
        if (overflow > 0) el.style.top = `${el.offsetTop - overflow}px`;
    }, [open]);

    return (
        <div
            className="context-submenu-anchor"
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => { setOpen(false); setFlip(false); }}
        >
            <button
                type="button"
                className="context-menu-item context-submenu-trigger"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(true)}
                onKeyDown={e => { if (e.key === 'ArrowRight') { e.preventDefault(); setOpen(true); } }}
            >
                <span className="context-menu-check" />
                Sort text by
                <span className="context-menu-shortcut">▸</span>
            </button>
            {open && (
                <div
                    ref={submenuRef}
                    className={flip ? 'context-menu context-submenu flip' : 'context-menu context-submenu'}
                    role="menu"
                    onKeyDown={e => { if (e.key === 'ArrowLeft') { e.stopPropagation(); setOpen(false); } }}
                >
                    {STRING_ORDERS.map(({ order, label, example, title }) => (
                        <button
                            key={order}
                            type="button"
                            className={sort.stringOrder === order ? 'context-menu-item active' : 'context-menu-item'}
                            onClick={() => sort.onStringOrder(order)}
                            role="menuitemradio"
                            aria-checked={sort.stringOrder === order}
                            title={title}
                        >
                            <span className="context-menu-check">{sort.stringOrder === order ? '✓' : ''}</span>
                            {label}
                            <span className="context-menu-shortcut">{example}</span>
                        </button>
                    ))}
                    <div className="context-menu-divider" role="separator" />
                    <button
                        type="button"
                        className="context-menu-item context-submenu-trigger"
                        onClick={sort.onExplainStringOrder}
                        role="menuitem"
                    >
                        <span className="context-menu-check" />
                        Explain…
                    </button>
                </div>
            )}
        </div>
    );
}
