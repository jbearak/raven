/**
 * The find bar (Cmd/Ctrl+F) and the go-to-row bar (Cmd/Ctrl+G), docked
 * above the grid. Both are DOM inputs; Escape closes them and returns
 * focus to the grid.
 */
import { useEffect, useRef, useState } from 'react';
import { describeFindCount, parseRowTarget, type RowTarget } from './workflow-model';

/** Typing pauses this long before a search starts. */
const FIND_DEBOUNCE_MS = 200;

export type FindStatus = { searching: boolean; count?: number; index?: number; error?: string };

export function FindBar({ status, focusNonce, onQuery, onStep, onCancel, onClose }: {
    status: FindStatus;
    /** Changes to refocus (and select) the input, e.g. Cmd+F again. */
    focusNonce: number;
    onQuery: (query: string) => void;
    onStep: (direction: 1 | -1) => void;
    onCancel: () => void;
    onClose: () => void;
}) {
    const [query, setQuery] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);
    const timerRef = useRef<number | null>(null);
    const sentRef = useRef('');
    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, [focusNonce]);
    useEffect(() => () => {
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    }, []);
    const send = (q: string) => {
        if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null; }
        sentRef.current = q;
        onQuery(q);
    };
    const onChange = (q: string) => {
        setQuery(q);
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => send(q), FIND_DEBOUNCE_MS);
    };
    const text = describeFindCount(status);
    return (
        <div className="grid-bar find-bar" role="search">
            <input
                ref={inputRef}
                className="grid-bar-input"
                type="text"
                value={query}
                placeholder="Find in visible columns"
                aria-label="Find in visible columns"
                spellCheck={false}
                onChange={e => onChange(e.target.value)}
                onKeyDown={e => {
                    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        // A pending query searches first; Enter then steps.
                        if (query !== sentRef.current) send(query);
                        else onStep(e.shiftKey ? -1 : 1);
                    }
                }}
            />
            <span className="grid-bar-status" role="status" aria-live="polite">{text}</span>
            {status.searching && (
                <button type="button" className="grid-bar-button" onClick={onCancel} title="Stop searching">
                    Cancel
                </button>
            )}
            <button
                type="button"
                className="grid-bar-button"
                aria-label="Previous match"
                title="Previous match (Shift+Enter)"
                disabled={!status.count}
                onClick={() => onStep(-1)}
            >
                ↑
            </button>
            <button
                type="button"
                className="grid-bar-button"
                aria-label="Next match"
                title="Next match (Enter)"
                disabled={!status.count}
                onClick={() => onStep(1)}
            >
                ↓
            </button>
            <button type="button" className="grid-bar-button" aria-label="Close find" title="Close (Escape)" onClick={onClose}>
                ✕
            </button>
        </div>
    );
}

export function GoToRowBar({ message, focusNonce, onGo, onClose }: {
    /** Why the last target failed, if it did. */
    message: string;
    focusNonce: number;
    onGo: (target: RowTarget) => void;
    onClose: () => void;
}) {
    const [value, setValue] = useState('');
    const [invalid, setInvalid] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, [focusNonce]);
    return (
        <div className="grid-bar goto-bar">
            <input
                ref={inputRef}
                className="grid-bar-input"
                type="text"
                inputMode="numeric"
                value={value}
                placeholder="R row number, or #position"
                aria-label="Go to row: R row number, or # and a display position"
                aria-invalid={invalid}
                spellCheck={false}
                onChange={e => { setValue(e.target.value); setInvalid(false); }}
                onKeyDown={e => {
                    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        const target = parseRowTarget(value);
                        if (!target) { setInvalid(true); return; }
                        onGo(target);
                    }
                }}
            />
            <span className="grid-bar-status" role="status" aria-live="polite">
                {invalid ? 'Type a row number, like 120 or #5' : message}
            </span>
            <button type="button" className="grid-bar-button" aria-label="Close go to row" title="Close (Escape)" onClick={onClose}>
                ✕
            </button>
        </div>
    );
}
