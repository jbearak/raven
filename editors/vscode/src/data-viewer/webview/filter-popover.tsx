/**
 * FilterPopover — modal-like fixed-position popover for editing or adding
 * a single filter entry.
 *
 * Behaviour by column kind:
 *  Numeric (Int/Uint/Float)    → numCompare | numBetween | numNotBetween + histogram brush
 *  Labelled numeric (numeric type + valueLabels) → setIn / setNotIn (label
 *      checklist, stored & matched as codes) | numCompare | numBetween |
 *      numNotBetween. setIn/setNotIn pre-selected.
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
import type { FilterEntry, HistogramBin } from '../messages';
import { useDismiss } from './use-dismiss';
import { FilterHistogram } from './filter-histogram';
import { colKind, kindOptions, labelledNumericChoices } from './filter-column-kind';
import {
    buildPredicate,
    defaultFormState,
    predicateToKindValue,
    seedFromEntry,
    type BoolState,
    type DateBetweenState,
    type DateCompareState,
    type NumBetweenState,
    type NumCompareState,
    type SetFreeTextState,
    type SetState,
    type StrRegexState,
    type StrState,
} from './filter-popover-seed';

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
    // switching back doesn't lose values the user typed). When editing an
    // existing entry, the matching sub-state is seeded from its predicate.
    const seed = initial ? seedFromEntry(initial.predicate) : defaultFormState();

    const [numCompare, setNumCompare] = useState<NumCompareState>(seed.numCompare);
    const [numBetween, setNumBetween] = useState<NumBetweenState>(seed.numBetween);
    const [setSelected, setSetSelected] = useState<SetState>(seed.set);
    const [str, setStr] = useState<StrState>(seed.str);
    const [strRegex, setStrRegex] = useState<StrRegexState>(seed.strRegex);
    const [dateCompare, setDateCompare] = useState<DateCompareState>(seed.dateCompare);
    const [dateBetween, setDateBetween] = useState<DateBetweenState>(seed.dateBetween);
    const [boolVal, setBoolVal] = useState<BoolState>(seed.bool);
    const [freeText, setFreeText] = useState<SetFreeTextState>(seed.freeText);
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

    const isLabelledNumeric = kind === 'labelledNumeric';
    const labelledChoices = isLabelledNumeric ? labelledNumericChoices(column) : [];

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
    // Set membership resolves per column kind: checklist columns
    // (labelled-numeric or shipped dictionary) carry the selected codes/labels
    // directly; others parse the free-text value list.
    const setUsesChecklist = isLabelledNumeric || hasShippedDictionary === true;
    const predicate = buildPredicate(
        selectedKind,
        { numCompare, numBetween, set: setSelected, str, strRegex, dateCompare, dateBetween, bool: boolVal, freeText },
        { setUsesChecklist },
    );
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
                    isLabelledNumeric ? (
                        <>
                            <input
                                type="text"
                                className="filter-popover-input filter-popover-search"
                                placeholder="Search labels…"
                                value={factorSearch}
                                onChange={e => setFactorSearch(e.target.value)}
                            />
                            <div className="filter-popover-checklist">
                                {labelledChoices
                                    .filter(c => !factorSearch
                                        || c.label.toLowerCase().includes(factorSearch.toLowerCase())
                                        || String(c.code).includes(factorSearch))
                                    .map(c => {
                                        const checked = setSelected.selected.includes(c.code);
                                        return (
                                            <label key={c.code} className="filter-popover-check-row">
                                                <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    onChange={e => {
                                                        setSetSelected(s => ({
                                                            selected: e.target.checked
                                                                ? [...s.selected, c.code]
                                                                : s.selected.filter(x => x !== c.code),
                                                        }));
                                                    }}
                                                />
                                                <span className="filter-popover-label-text">{c.label}</span>
                                                <span className="filter-popover-code-dim">{c.code}</span>
                                            </label>
                                        );
                                    })}
                                {labelledChoices.length === 0 && (
                                    <div className="filter-popover-hint">No labels available</div>
                                )}
                            </div>
                        </>
                    ) : hasShippedDictionary ? (
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
