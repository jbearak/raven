/**
 * FilterPopover — modal-like fixed-position popover for editing or adding
 * a single filter entry.
 *
 * Behaviour by column kind:
 *  Numeric (Int/Uint/Float)    → numCompare | numBetween | numNotBetween + histogram brush
 *  Factor (Dictionary) / has valueLabels + dictionaryShipped  → setIn / setNotIn checklist
 *  Factor without shipped dict → setIn / setNotIn + free-text list
 *  String (Utf8/LargeUtf8)     → strContains / strStartsWith / strEndsWith / strCompare / strRegex
 *  Bool                        → bool (true/false radio)
 *  Date/Timestamp              → dateCompare | dateBetween | dateNotBetween
 *  Universal                   → isEmpty / isNotEmpty (for all kinds)
 *
 * Invariant: one filter per column — onApply replaces any existing entry
 *  for this columnIndex in the caller.
 */

import React, {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from 'react';
import type { ColumnSchema } from '../arrow-reader';
import type { FilterEntry, FilterPredicate, HistogramBin } from '../messages';
import { useDismiss } from './use-dismiss';
import { FilterHistogram } from './filter-histogram';
import { colKind, kindOptions, type ColKind, type KindOption } from './filter-column-kind';

/** A small uid helper that avoids a `crypto` availability issue in older
 *  webview runtimes. Falls back gracefully if crypto.randomUUID is present. */
function newId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

type Props = {
    column: ColumnSchema;
    columnIndex: number;
    histogram?: HistogramBin[];
    /** When editing an existing entry; undefined when adding a new one. */
    initial?: FilterEntry;
    onApply: (entry: FilterEntry) => void;
    onCancel: () => void;
    anchor: { leftPx: number; topPx: number };
};

/** Map a persisted FilterPredicate back to our internal kind-select value. */
function predicateToKindValue(p: FilterPredicate): string {
    switch (p.kind) {
        case 'numCompare': return 'numCompare';
        case 'numBetween': return 'numBetween';
        case 'numNotBetween': return 'numNotBetween';
        case 'setIn': return 'setIn';
        case 'setNotIn': return 'setNotIn';
        case 'strContains': return p.negate ? 'strNotContains' : 'strContains';
        case 'strStartsWith': return 'strStartsWith';
        case 'strEndsWith': return 'strEndsWith';
        case 'strCompare': return p.op === '=' ? 'strCompareEq' : 'strCompareNe';
        case 'strRegex': return 'strRegex';
        case 'dateCompare': return 'dateCompare';
        case 'dateBetween': return 'dateBetween';
        case 'dateNotBetween': return 'dateNotBetween';
        case 'bool': return 'bool';
        case 'isEmpty': return 'isEmpty';
        case 'isNotEmpty': return 'isNotEmpty';
    }
}

// ── Value-editor state shapes ───────────────────────────────────────────────

type NumCompareState = { op: '=' | '!=' | '<' | '<=' | '>' | '>='; value: string };
type NumBetweenState = { lo: string; hi: string; inclusive: boolean };
type SetState = { selected: (string | number)[] };
type StrState = { value: string; caseSensitive: boolean };
type StrRegexState = { pattern: string; caseSensitive: boolean; regexError: string | null };
type DateCompareState = { op: '=' | '!=' | '<' | '<=' | '>' | '>='; value: string };
type DateBetweenState = { lo: string; hi: string; inclusive: boolean };
type BoolState = { value: boolean };
type SetFreeTextState = { text: string };

// ── Default states ──────────────────────────────────────────────────────────

function defaultNumCompare(): NumCompareState {
    return { op: '=', value: '' };
}
function defaultNumBetween(): NumBetweenState {
    return { lo: '', hi: '', inclusive: true };
}
function defaultSet(): SetState {
    return { selected: [] };
}
function defaultStr(): StrState {
    return { value: '', caseSensitive: false };
}
function defaultStrRegex(): StrRegexState {
    return { pattern: '', caseSensitive: false, regexError: null };
}
function defaultDateCompare(): DateCompareState {
    return { op: '=', value: '' };
}
function defaultDateBetween(): DateBetweenState {
    return { lo: '', hi: '', inclusive: true };
}
function defaultBool(): BoolState {
    return { value: true };
}
function defaultFreeText(): SetFreeTextState {
    return { text: '' };
}

/** Recover the initial editor state from a persisted FilterEntry. */
function seedFromEntry(p: FilterPredicate): {
    numCompare: NumCompareState;
    numBetween: NumBetweenState;
    set: SetState;
    str: StrState;
    strRegex: StrRegexState;
    dateCompare: DateCompareState;
    dateBetween: DateBetweenState;
    bool: BoolState;
    freeText: SetFreeTextState;
} {
    const base = {
        numCompare: defaultNumCompare(),
        numBetween: defaultNumBetween(),
        set: defaultSet(),
        str: defaultStr(),
        strRegex: defaultStrRegex(),
        dateCompare: defaultDateCompare(),
        dateBetween: defaultDateBetween(),
        bool: defaultBool(),
        freeText: defaultFreeText(),
    };
    switch (p.kind) {
        case 'numCompare':
            base.numCompare = { op: p.op, value: String(p.value) };
            break;
        case 'numBetween':
            base.numBetween = { lo: String(p.lo), hi: String(p.hi), inclusive: p.inclusive };
            break;
        case 'numNotBetween':
            base.numBetween = { lo: String(p.lo), hi: String(p.hi), inclusive: p.inclusive };
            break;
        case 'setIn':
        case 'setNotIn':
            base.set = { selected: p.values };
            base.freeText = { text: p.values.join('\n') };
            break;
        case 'strContains':
        case 'strStartsWith':
        case 'strEndsWith':
            base.str = { value: p.value, caseSensitive: p.caseSensitive };
            break;
        case 'strCompare':
            base.str = { value: p.value, caseSensitive: p.caseSensitive };
            break;
        case 'strRegex':
            base.strRegex = { pattern: p.pattern, caseSensitive: p.caseSensitive, regexError: null };
            break;
        case 'dateCompare':
            base.dateCompare = { op: p.op, value: p.value };
            break;
        case 'dateBetween':
        case 'dateNotBetween':
            base.dateBetween = { lo: p.lo, hi: p.hi, inclusive: p.inclusive };
            break;
        case 'bool':
            base.bool = { value: p.value };
            break;
    }
    return base;
}

// ── Main component ──────────────────────────────────────────────────────────

export function FilterPopover({ column, columnIndex, histogram, initial, onApply, onCancel, anchor }: Props) {
    const kind = colKind(column);
    const options = kindOptions(kind);

    // Seed the kind-select from the existing entry or default to first option.
    const [selectedKind, setSelectedKind] = useState<string>(() => {
        if (initial) return predicateToKindValue(initial.predicate);
        return options[0].value;
    });

    // Per-kind value state (we keep all sub-states alive so switching kind and
    // switching back doesn't lose values the user typed).
    const seed = initial ? seedFromEntry(initial.predicate) : null;

    const [numCompare, setNumCompare] = useState<NumCompareState>(seed?.numCompare ?? defaultNumCompare());
    const [numBetween, setNumBetween] = useState<NumBetweenState>(seed?.numBetween ?? defaultNumBetween());
    const [setSelected, setSetSelected] = useState<SetState>(seed?.set ?? defaultSet());
    const [str, setStr] = useState<StrState>(seed?.str ?? defaultStr());
    const [strRegex, setStrRegex] = useState<StrRegexState>(seed?.strRegex ?? defaultStrRegex());
    const [dateCompare, setDateCompare] = useState<DateCompareState>(seed?.dateCompare ?? defaultDateCompare());
    const [dateBetween, setDateBetween] = useState<DateBetweenState>(seed?.dateBetween ?? defaultDateBetween());
    const [boolVal, setBoolVal] = useState<BoolState>(seed?.bool ?? defaultBool());
    const [freeText, setFreeText] = useState<SetFreeTextState>(seed?.freeText ?? defaultFreeText());
    const [includeMissing, setIncludeMissing] = useState(initial?.includeMissing ?? false);

    // Popover ref + positioning
    const popoverRef = useRef<HTMLDivElement>(null);
    const firstControlRef = useRef<HTMLSelectElement>(null);
    const [coords, setCoords] = useState({ left: anchor.leftPx, top: anchor.topPx });

    useDismiss(popoverRef, onCancel);

    // Clamp to viewport after render
    useLayoutEffect(() => {
        const el = popoverRef.current;
        if (!el) return;
        const MARGIN = 8;
        const rect = el.getBoundingClientRect();
        const maxLeft = Math.max(MARGIN, window.innerWidth - rect.width - MARGIN);
        const maxTop = Math.max(MARGIN, window.innerHeight - rect.height - MARGIN);
        setCoords({
            left: Math.min(Math.max(MARGIN, anchor.leftPx), maxLeft),
            top: Math.min(Math.max(MARGIN, anchor.topPx), maxTop),
        });
    }, [anchor.leftPx, anchor.topPx]);

    // Focus the kind select on open
    useEffect(() => {
        firstControlRef.current?.focus();
    }, []);

    // Histogram brush sync for between ranges
    const histoLo = parseFloat(numBetween.lo);
    const histoHi = parseFloat(numBetween.hi);
    const histoValid = !isNaN(histoLo) && !isNaN(histoHi);
    const histoDMin = histogram && histogram.length > 0 ? histogram[0].lo : 0;
    const histoDMax = histogram && histogram.length > 0 ? histogram[histogram.length - 1].hi : 0;

    // Whether this column has a shipped dictionary for checklist rendering
    const hasShippedDictionary = kind === 'factor' && column.dictionaryShipped && Array.isArray(column.dictionary);
    const dictValues: string[] = hasShippedDictionary ? (column.dictionary ?? []) : [];

    // ── Factor search state ───────────────────────────────────────────────
    const [factorSearch, setFactorSearch] = useState('');

    // ── Regex validation ─────────────────────────────────────────────────
    const validateRegex = (pattern: string, caseSensitive: boolean) => {
        if (!pattern) {
            setStrRegex(s => ({ ...s, pattern, regexError: null }));
            return;
        }
        try {
            new RegExp(pattern, caseSensitive ? '' : 'i');
            setStrRegex(s => ({ ...s, pattern, regexError: null }));
        } catch (e) {
            setStrRegex(s => ({ ...s, pattern, regexError: (e as Error).message }));
        }
    };

    // ── Build predicate ───────────────────────────────────────────────────
    function buildPredicate(): FilterPredicate | null {
        switch (selectedKind) {
            case 'isEmpty': return { kind: 'isEmpty' };
            case 'isNotEmpty': return { kind: 'isNotEmpty' };
            case 'numCompare': {
                const v = parseFloat(numCompare.value);
                if (isNaN(v)) return null;
                return { kind: 'numCompare', op: numCompare.op, value: v };
            }
            case 'numBetween': {
                const lo = parseFloat(numBetween.lo);
                const hi = parseFloat(numBetween.hi);
                if (isNaN(lo) || isNaN(hi)) return null;
                return { kind: 'numBetween', lo, hi, inclusive: numBetween.inclusive };
            }
            case 'numNotBetween': {
                const lo = parseFloat(numBetween.lo);
                const hi = parseFloat(numBetween.hi);
                if (isNaN(lo) || isNaN(hi)) return null;
                return { kind: 'numNotBetween', lo, hi, inclusive: numBetween.inclusive };
            }
            case 'setIn': {
                const vals = effectiveSetValues();
                if (vals.length === 0) return null;
                return { kind: 'setIn', values: vals };
            }
            case 'setNotIn': {
                const vals = effectiveSetValues();
                if (vals.length === 0) return null;
                return { kind: 'setNotIn', values: vals };
            }
            case 'strContains':
                if (!str.value) return null;
                return { kind: 'strContains', value: str.value, caseSensitive: str.caseSensitive, negate: false };
            case 'strNotContains':
                if (!str.value) return null;
                return { kind: 'strContains', value: str.value, caseSensitive: str.caseSensitive, negate: true };
            case 'strStartsWith':
                if (!str.value) return null;
                return { kind: 'strStartsWith', value: str.value, caseSensitive: str.caseSensitive };
            case 'strEndsWith':
                if (!str.value) return null;
                return { kind: 'strEndsWith', value: str.value, caseSensitive: str.caseSensitive };
            case 'strCompareEq':
                if (!str.value) return null;
                return { kind: 'strCompare', op: '=', value: str.value, caseSensitive: str.caseSensitive };
            case 'strCompareNe':
                if (!str.value) return null;
                return { kind: 'strCompare', op: '!=', value: str.value, caseSensitive: str.caseSensitive };
            case 'strRegex':
                if (!strRegex.pattern || strRegex.regexError) return null;
                return { kind: 'strRegex', pattern: strRegex.pattern, caseSensitive: strRegex.caseSensitive };
            case 'dateCompare':
                if (!dateCompare.value) return null;
                return { kind: 'dateCompare', op: dateCompare.op, value: dateCompare.value };
            case 'dateBetween':
                if (!dateBetween.lo || !dateBetween.hi) return null;
                return { kind: 'dateBetween', lo: dateBetween.lo, hi: dateBetween.hi, inclusive: dateBetween.inclusive };
            case 'dateNotBetween':
                if (!dateBetween.lo || !dateBetween.hi) return null;
                return { kind: 'dateNotBetween', lo: dateBetween.lo, hi: dateBetween.hi, inclusive: dateBetween.inclusive };
            case 'bool':
                return { kind: 'bool', value: boolVal.value };
        }
        return null;
    }

    function effectiveSetValues(): (string | number)[] {
        if (hasShippedDictionary) {
            return setSelected.selected;
        }
        // Free-text: split on comma or newline
        return freeText.text
            .split(/[\n,]+/)
            .map(s => s.trim())
            .filter(Boolean);
    }

    const predicate = buildPredicate();
    const canApply = predicate !== null && !(selectedKind === 'strRegex' && strRegex.regexError);

    const handleApply = () => {
        if (!canApply || !predicate) return;
        const entry: FilterEntry = {
            id: initial?.id ?? newId(),
            columnIndex,
            predicate,
            enabled: true,
            includeMissing,
        };
        onApply(entry);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && canApply) {
            e.preventDefault();
            handleApply();
        }
        // Escape is handled by useDismiss
    };

    const showMissingCheckbox = selectedKind !== 'isEmpty' && selectedKind !== 'isNotEmpty';

    const isTimestamp = column.arrowType.startsWith('Timestamp');
    const dateInputType = isTimestamp ? 'datetime-local' : 'date';

    return (
        <div
            ref={popoverRef}
            className="filter-popover"
            role="dialog"
            aria-label={`Filter on ${column.name}`}
            aria-modal="true"
            style={{ left: `${coords.left}px`, top: `${coords.top}px` }}
            onKeyDown={handleKeyDown}
        >
            {/* Header */}
            <div className="filter-popover-header">
                <span className="filter-popover-colname">{column.name}</span>
                {column.variableLabel && (
                    <span className="filter-popover-subtitle">{column.variableLabel}</span>
                )}
            </div>

            {/* Body */}
            <div className="filter-popover-body">
                {/* Kind selector */}
                <label className="filter-popover-field-label">Condition</label>
                <select
                    ref={firstControlRef}
                    className="filter-popover-select"
                    value={selectedKind}
                    onChange={e => setSelectedKind(e.target.value)}
                >
                    {options.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                </select>

                {/* Value editor */}
                {selectedKind === 'numCompare' && (
                    <div className="filter-popover-row">
                        <select
                            className="filter-popover-op-select"
                            value={numCompare.op}
                            onChange={e => setNumCompare(s => ({ ...s, op: e.target.value as NumCompareState['op'] }))}
                        >
                            {([['=', '='], ['!=', '≠'], ['<', '<'], ['<=', '≤'], ['>', '>'], ['>=', '≥']] as [NumCompareState['op'], string][]).map(([v, l]) => (
                                <option key={v} value={v}>{l}</option>
                            ))}
                        </select>
                        <input
                            type="number"
                            className="filter-popover-input"
                            placeholder="value"
                            value={numCompare.value}
                            onChange={e => setNumCompare(s => ({ ...s, value: e.target.value }))}
                        />
                    </div>
                )}

                {(selectedKind === 'numBetween' || selectedKind === 'numNotBetween') && (
                    <>
                        <div className="filter-popover-row">
                            <input
                                type="number"
                                className="filter-popover-input"
                                placeholder="low"
                                value={numBetween.lo}
                                onChange={e => setNumBetween(s => ({ ...s, lo: e.target.value }))}
                            />
                            <span className="filter-popover-between-sep">–</span>
                            <input
                                type="number"
                                className="filter-popover-input"
                                placeholder="high"
                                value={numBetween.hi}
                                onChange={e => setNumBetween(s => ({ ...s, hi: e.target.value }))}
                            />
                        </div>
                        <label className="filter-popover-check-row">
                            <input
                                type="checkbox"
                                checked={numBetween.inclusive}
                                onChange={e => setNumBetween(s => ({ ...s, inclusive: e.target.checked }))}
                            />
                            Inclusive (≤, ≥)
                        </label>
                        {histogram && histogram.length > 0 && (
                            <FilterHistogram
                                bins={histogram}
                                lo={histoValid ? histoLo : histoDMin}
                                hi={histoValid ? histoHi : histoDMax}
                                onChange={(lo, hi) => setNumBetween(s => ({ ...s, lo: String(lo), hi: String(hi) }))}
                            />
                        )}
                    </>
                )}

                {(selectedKind === 'setIn' || selectedKind === 'setNotIn') && (
                    hasShippedDictionary ? (
                        <>
                            <input
                                type="text"
                                className="filter-popover-input filter-popover-search"
                                placeholder="Search values…"
                                value={factorSearch}
                                onChange={e => setFactorSearch(e.target.value)}
                            />
                            <div className="filter-popover-checklist">
                                {dictValues
                                    .filter(v => !factorSearch || v.toLowerCase().includes(factorSearch.toLowerCase()))
                                    .map((v, i) => {
                                        const checked = setSelected.selected.includes(v);
                                        return (
                                            <label key={i} className="filter-popover-check-row">
                                                <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    onChange={e => {
                                                        setSetSelected(s => ({
                                                            selected: e.target.checked
                                                                ? [...s.selected, v]
                                                                : s.selected.filter(x => x !== v),
                                                        }));
                                                    }}
                                                />
                                                {v}
                                            </label>
                                        );
                                    })}
                                {dictValues.length === 0 && (
                                    <div className="filter-popover-hint">No values available</div>
                                )}
                            </div>
                        </>
                    ) : (
                        <>
                            <textarea
                                className="filter-popover-textarea"
                                placeholder="One value per line or comma-separated"
                                value={freeText.text}
                                rows={4}
                                onChange={e => setFreeText({ text: e.target.value })}
                            />
                            <div className="filter-popover-hint">
                                Dictionary not available — enter values manually
                            </div>
                        </>
                    )
                )}

                {(selectedKind === 'strContains' || selectedKind === 'strNotContains'
                    || selectedKind === 'strStartsWith' || selectedKind === 'strEndsWith'
                    || selectedKind === 'strCompareEq' || selectedKind === 'strCompareNe') && (
                    <>
                        <input
                            type="text"
                            className="filter-popover-input"
                            placeholder="value"
                            value={str.value}
                            onChange={e => setStr(s => ({ ...s, value: e.target.value }))}
                        />
                        <label className="filter-popover-check-row">
                            <input
                                type="checkbox"
                                checked={str.caseSensitive}
                                onChange={e => setStr(s => ({ ...s, caseSensitive: e.target.checked }))}
                            />
                            Case sensitive
                        </label>
                    </>
                )}

                {selectedKind === 'strRegex' && (
                    <>
                        <input
                            type="text"
                            className={strRegex.regexError ? 'filter-popover-input filter-popover-input-error' : 'filter-popover-input'}
                            placeholder="/pattern/ — no delimiters needed"
                            value={strRegex.pattern}
                            onChange={e => validateRegex(e.target.value, strRegex.caseSensitive)}
                            aria-invalid={strRegex.regexError !== null}
                        />
                        {strRegex.regexError && (
                            <div className="filter-popover-error" role="alert">
                                {strRegex.regexError}
                            </div>
                        )}
                        <label className="filter-popover-check-row">
                            <input
                                type="checkbox"
                                checked={strRegex.caseSensitive}
                                onChange={e => {
                                    const cs = e.target.checked;
                                    setStrRegex(s => {
                                        try {
                                            new RegExp(s.pattern, cs ? '' : 'i');
                                            return { ...s, caseSensitive: cs, regexError: null };
                                        } catch (ex) {
                                            return { ...s, caseSensitive: cs, regexError: (ex as Error).message };
                                        }
                                    });
                                }}
                            />
                            Case sensitive
                        </label>
                        <div className="filter-popover-hint">
                            Pattern is tested as{' '}
                            <code>{strRegex.caseSensitive ? '/…/' : '/…/i'}</code>
                        </div>
                    </>
                )}

                {selectedKind === 'dateCompare' && (
                    <div className="filter-popover-row">
                        <select
                            className="filter-popover-op-select"
                            value={dateCompare.op}
                            onChange={e => setDateCompare(s => ({ ...s, op: e.target.value as DateCompareState['op'] }))}
                        >
                            {([['=', '='], ['!=', '≠'], ['<', '<'], ['<=', '≤'], ['>', '>'], ['>=', '≥']] as [DateCompareState['op'], string][]).map(([v, l]) => (
                                <option key={v} value={v}>{l}</option>
                            ))}
                        </select>
                        <input
                            type={dateInputType}
                            className="filter-popover-input"
                            value={dateCompare.value}
                            onChange={e => setDateCompare(s => ({ ...s, value: e.target.value }))}
                        />
                    </div>
                )}

                {(selectedKind === 'dateBetween' || selectedKind === 'dateNotBetween') && (
                    <>
                        <div className="filter-popover-row">
                            <input
                                type={dateInputType}
                                className="filter-popover-input"
                                value={dateBetween.lo}
                                onChange={e => setDateBetween(s => ({ ...s, lo: e.target.value }))}
                            />
                            <span className="filter-popover-between-sep">–</span>
                            <input
                                type={dateInputType}
                                className="filter-popover-input"
                                value={dateBetween.hi}
                                onChange={e => setDateBetween(s => ({ ...s, hi: e.target.value }))}
                            />
                        </div>
                        <label className="filter-popover-check-row">
                            <input
                                type="checkbox"
                                checked={dateBetween.inclusive}
                                onChange={e => setDateBetween(s => ({ ...s, inclusive: e.target.checked }))}
                            />
                            Inclusive
                        </label>
                    </>
                )}

                {selectedKind === 'bool' && (
                    <div className="filter-popover-bool-group">
                        <label className="filter-popover-check-row">
                            <input
                                type="radio"
                                name="bool-filter"
                                checked={boolVal.value === true}
                                onChange={() => setBoolVal({ value: true })}
                            />
                            True
                        </label>
                        <label className="filter-popover-check-row">
                            <input
                                type="radio"
                                name="bool-filter"
                                checked={boolVal.value === false}
                                onChange={() => setBoolVal({ value: false })}
                            />
                            False
                        </label>
                    </div>
                )}

                {/* Include missing checkbox */}
                {showMissingCheckbox && (
                    <label className="filter-popover-check-row filter-popover-missing-row">
                        <input
                            type="checkbox"
                            checked={includeMissing}
                            onChange={e => setIncludeMissing(e.target.checked)}
                        />
                        Include NA / NaN
                    </label>
                )}
            </div>

            {/* Footer */}
            <div className="filter-popover-footer">
                <button
                    type="button"
                    className="filter-popover-btn filter-popover-btn-primary"
                    disabled={!canApply}
                    onClick={handleApply}
                >
                    Apply
                </button>
                <button
                    type="button"
                    className="filter-popover-btn"
                    onClick={onCancel}
                >
                    Cancel
                </button>
            </div>
        </div>
    );
}
