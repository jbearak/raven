import { useEffect, useRef } from 'react';
import { useDismiss } from './use-dismiss';

type Props = {
    leftPx: number;
    topPx: number;
    copyLabel?: string;
    onCopy: () => void;
    onHideColumn?: () => void;
    onClose: () => void;
};

const MARGIN_PX = 4;

export function ColumnContextMenu({
    leftPx,
    topPx,
    copyLabel = 'Copy',
    onCopy,
    onHideColumn,
    onClose,
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
        </div>
    );
}
