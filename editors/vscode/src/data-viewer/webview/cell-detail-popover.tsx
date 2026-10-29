import { useEffect, useRef } from 'react';
import { useDismiss } from './use-dismiss';

/**
 * Read-only popover with one cell's full value, opened with Enter or a
 * double-click on a truncated cell, a long string, or a list-column
 * placeholder. Canvas cells have no native text selection, so this and
 * Copy are how a long value is read. `text` is undefined while the host
 * fetches the untruncated value (capped at 64 KiB).
 */
export function CellDetailPopover({
    title,
    text,
    truncated,
    leftPx,
    topPx,
    onCopy,
    onClose,
}: {
    title: string;
    text: string | null | undefined;
    truncated: boolean;
    leftPx: number;
    topPx: number;
    onCopy: (text: string) => void;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    useDismiss(ref, onClose);

    useEffect(() => {
        ref.current?.focus();
    }, []);

    useEffect(() => {
        const el = ref.current;
        const parent = el?.offsetParent as HTMLElement | null;
        if (!el || !parent) return;
        const margin = 4;
        const left = Math.min(leftPx, parent.clientWidth - el.offsetWidth - margin);
        const top = Math.min(topPx, parent.clientHeight - el.offsetHeight - margin);
        el.style.left = `${Math.max(margin, left)}px`;
        el.style.top = `${Math.max(margin, top)}px`;
    }, [leftPx, topPx, text]);

    const body = text === undefined ? 'Loading…' : text === null ? 'NA' : text;
    return (
        <div
            ref={ref}
            className="cell-detail"
            role="dialog"
            aria-label={`Value of ${title}`}
            tabIndex={-1}
            style={{ left: `${leftPx}px`, top: `${topPx}px` }}
            onKeyDown={e => {
                if (e.key === 'Escape') {
                    e.stopPropagation();
                    onClose();
                }
            }}
        >
            <div className="cell-detail-header">
                <span className="cell-detail-title">{title}</span>
                <button
                    type="button"
                    className="cell-detail-copy"
                    disabled={typeof text !== 'string'}
                    onClick={() => { if (typeof text === 'string') onCopy(text); }}
                >
                    Copy
                </button>
            </div>
            <pre className={text === null ? 'cell-detail-body missing' : 'cell-detail-body'}>{body}</pre>
            {truncated && <div className="cell-detail-note">Showing the first 64 KiB.</div>}
        </div>
    );
}
