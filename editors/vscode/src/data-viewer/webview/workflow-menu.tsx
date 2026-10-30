/**
 * The toolbar's `⋯` menu: Find, Go to row, Copy as R code (dplyr, with
 * base R and data.table in a submenu), and Refresh. Every item routes to
 * a callback; the menu holds only its open state.
 */
import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import { useDismiss } from './use-dismiss';
import type { CodeFlavorName } from './workflow-model';

type Props = {
    onFind: () => void;
    onGoToRow: () => void;
    onCopyCode: (flavor: CodeFlavorName) => void;
    onRefresh: () => void;
    /** Platform modifier label (`⌘` or `Ctrl+`). */
    mod: string;
};

export function WorkflowMenu({ onFind, onGoToRow, onCopyCode, onRefresh, mod }: Props) {
    const [open, setOpen] = useState(false);
    const [submenu, setSubmenu] = useState(false);
    const anchorRef = useRef<HTMLDivElement>(null);
    const close = useCallback(() => { setOpen(false); setSubmenu(false); }, []);
    useDismiss(anchorRef, close);
    const pick = (fn: () => void) => () => { close(); fn(); };
    const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
        const items = Array.from(anchorRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
            items[next]?.focus();
        }
    };
    return (
        <div className="workflow-menu-anchor" ref={anchorRef}>
            <button
                type="button"
                className={open ? 'toggle active' : 'toggle'}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label="More actions"
                title="More actions"
                onClick={() => { setOpen(o => !o); setSubmenu(false); }}
            >
                ⋯
            </button>
            {open && (
                <div className="context-menu workflow-menu" role="menu" onKeyDown={onMenuKey}>
                    <button type="button" className="context-menu-item" role="menuitem" onClick={pick(onFind)} autoFocus>
                        Find…
                        <span className="context-menu-shortcut">{mod}F</span>
                    </button>
                    <button type="button" className="context-menu-item" role="menuitem" onClick={pick(onGoToRow)}>
                        Go to row…
                        <span className="context-menu-shortcut">{mod}G</span>
                    </button>
                    <div className="context-menu-divider" role="separator" />
                    <button type="button" className="context-menu-item" role="menuitem" onClick={pick(() => onCopyCode('dplyr'))}>
                        Copy as R code (dplyr)
                    </button>
                    <div
                        className="workflow-submenu-anchor"
                        onMouseEnter={() => setSubmenu(true)}
                        onMouseLeave={() => setSubmenu(false)}
                    >
                        <button
                            type="button"
                            className="context-menu-item"
                            role="menuitem"
                            aria-haspopup="menu"
                            aria-expanded={submenu}
                            onClick={() => setSubmenu(s => !s)}
                            onKeyDown={e => { if (e.key === 'ArrowRight') { e.preventDefault(); setSubmenu(true); } }}
                        >
                            Copy as R code
                            <span className="context-menu-shortcut">▸</span>
                        </button>
                        {submenu && (
                            <div
                                className="context-menu workflow-submenu"
                                role="menu"
                                onKeyDown={e => { if (e.key === 'ArrowLeft') { e.stopPropagation(); setSubmenu(false); } }}
                            >
                                <button type="button" className="context-menu-item" role="menuitem" onClick={pick(() => onCopyCode('base'))}>
                                    base R
                                </button>
                                <button type="button" className="context-menu-item" role="menuitem" onClick={pick(() => onCopyCode('data.table'))}>
                                    data.table
                                </button>
                            </div>
                        )}
                    </div>
                    <div className="context-menu-divider" role="separator" />
                    <button type="button" className="context-menu-item" role="menuitem" onClick={pick(onRefresh)}>
                        Refresh…
                    </button>
                </div>
            )}
        </div>
    );
}
