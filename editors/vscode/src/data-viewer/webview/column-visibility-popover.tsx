import { useEffect, useRef, useState } from 'react';
import type { ColumnSchema } from '../arrow-reader';
import { useDismiss } from './use-dismiss';

type Props = {
    columns: ColumnSchema[];
    hiddenColumns: readonly number[];
    onToggle: (index: number) => void;
    onShowAll: () => void;
    onHideAll: () => void;
    onClose: () => void;
};

export function ColumnVisibilityPopover({
    columns,
    hiddenColumns,
    onToggle,
    onShowAll,
    onHideAll,
    onClose,
}: Props) {
    const [filter, setFilter] = useState('');
    const popoverRef = useRef<HTMLDivElement>(null);
    const filterRef = useRef<HTMLInputElement>(null);
    const hidden = new Set(hiddenColumns);

    useDismiss(popoverRef, onClose);

    useEffect(() => {
        filterRef.current?.focus();
    }, []);

    const needle = filter.trim().toLowerCase();
    const filtered = columns
        .map((col, index) => ({ col, index }))
        .filter(({ col }) => {
            if (!needle) return true;
            return col.name.toLowerCase().includes(needle)
                || (col.variableLabel ?? '').toLowerCase().includes(needle)
                || col.arrowType.toLowerCase().includes(needle);
        });

    return (
        <div ref={popoverRef} className="columns-popover">
            <input
                ref={filterRef}
                type="text"
                className="columns-popover-filter"
                placeholder="Search columns..."
                value={filter}
                onChange={event => setFilter(event.target.value)}
            />
            <div className="columns-popover-actions">
                <button type="button" className="popover-action-btn" onClick={onShowAll}>
                    Show all
                </button>
                <button type="button" className="popover-action-btn" onClick={onHideAll}>
                    Hide all
                </button>
            </div>
            <div className="columns-popover-list">
                {filtered.map(({ col, index }) => (
                    <label key={index} className="columns-popover-item">
                        <input
                            type="checkbox"
                            checked={!hidden.has(index)}
                            onChange={() => onToggle(index)}
                        />
                        <span className="columns-popover-name">{col.name}</span>
                        {col.variableLabel && (
                            <span className="columns-popover-label">{col.variableLabel}</span>
                        )}
                    </label>
                ))}
                {filtered.length === 0 && (
                    <div className="columns-popover-empty">No matching columns</div>
                )}
            </div>
        </div>
    );
}
