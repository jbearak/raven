/**
 * Pure seed/build helpers for the FilterPopover form — the bidirectional
 * mapping between a persisted FilterPredicate and the editor's per-kind form
 * state. Extracted from filter-popover.tsx (no React) so the round-trip
 * (predicate → form state → predicate) is unit-testable.
 *
 * Invariant: `predicateToKindValue`, `seedFromEntry`, and `buildPredicate` must
 * stay in lockstep with the FilterPredicate union in messages.ts and the
 * kind-select option values in filter-column-kind.ts. Adding a predicate kind
 * means touching all three; the round-trip test in
 * tests/bun/data-viewer-filter-popover-seed.test.ts guards that.
 */
import type { FilterPredicate, NumBound } from '../messages';

// ── Value-editor state shapes ───────────────────────────────────────────────

export type NumCompareState = { op: '=' | '!=' | '<' | '<=' | '>' | '>='; value: string };
/** `upperInclusive` carries a histogram brush's half-open bound through
 *  an edit; toggling Inclusive drops it. */
export type NumBetweenState = { lo: string; hi: string; inclusive: boolean; upperInclusive?: boolean };
export type SetState = { selected: (string | number)[] };
export type StrState = { value: string; caseSensitive: boolean };
export type StrRegexState = { pattern: string; caseSensitive: boolean; regexError: string | null };
export type DateCompareState = { op: '=' | '!=' | '<' | '<=' | '>' | '>='; value: string };
export type DateBetweenState = { lo: string; hi: string; inclusive: boolean };
export type BoolState = { value: boolean };
/** The set's free-text value list. `values` holds the set an existing
 *  filter was seeded from: its text joins them with newlines, which can't
 *  round-trip a value holding a comma or line break, so the list is read
 *  back from the text only once the text is edited. */
export type SetFreeTextState = { text: string; values?: readonly (string | number)[] };

/** The popover's full per-kind form state. All sub-states are kept alive so
 *  switching the kind-select and switching back doesn't lose typed values. */
export type FormState = {
    numCompare: NumCompareState;
    numBetween: NumBetweenState;
    set: SetState;
    str: StrState;
    strRegex: StrRegexState;
    dateCompare: DateCompareState;
    dateBetween: DateBetweenState;
    bool: BoolState;
    freeText: SetFreeTextState;
};

/** Blank state — what the popover opens with when adding a filter to an
 *  unfiltered column. */
export function defaultFormState(): FormState {
    return {
        numCompare: { op: '=', value: '' },
        numBetween: { lo: '', hi: '', inclusive: true },
        set: { selected: [] },
        str: { value: '', caseSensitive: false },
        strRegex: { pattern: '', caseSensitive: false, regexError: null },
        dateCompare: { op: '=', value: '' },
        dateBetween: { lo: '', hi: '', inclusive: true },
        bool: { value: true },
        freeText: { text: '' },
    };
}

/** Map a persisted FilterPredicate back to the kind-select option value. */
export function predicateToKindValue(p: FilterPredicate): string {
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

/** Recover the initial editor state from a persisted FilterPredicate. The
 *  matching sub-state is filled; all others keep their blank defaults.
 *  `int64` says the column is Int64 / Uint64, as in {@link buildPredicate}. */
export function seedFromEntry(p: FilterPredicate, int64 = false): FormState {
    const base = defaultFormState();
    switch (p.kind) {
        case 'numCompare':
            base.numCompare = { op: p.op, value: boundText(p.value, int64) };
            break;
        case 'numBetween':
            base.numBetween = {
                lo: boundText(p.lo, int64), hi: boundText(p.hi, int64), inclusive: p.inclusive,
                ...(p.upperInclusive !== undefined ? { upperInclusive: p.upperInclusive } : {}),
            };
            break;
        case 'numNotBetween':
            base.numBetween = { lo: boundText(p.lo, int64), hi: boundText(p.hi, int64), inclusive: p.inclusive };
            break;
        case 'setIn':
        case 'setNotIn':
            base.set = { selected: p.values };
            base.freeText = { text: p.values.join('\n'), values: p.values };
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

/** The text a bound shows in its input. On an Int64 / Uint64 column an
 *  integer-valued double is spelled out digit for digit: `String` gives the
 *  shortest spelling that reads back as the same double
 *  (`1000000000000000100` for 1000000000000000128), which {@link parseBound}
 *  would then take for a different exact integer. */
function boundText(b: NumBound, int64: boolean): string {
    return int64 && typeof b === 'number' && Number.isInteger(b) ? BigInt(b).toString() : String(b);
}

/** The between-range form state after a histogram thumb moved, the thumbs
 *  now at `lo` / `hi`. A field whose text already reads as its thumb's
 *  position is the one that didn't move and keeps its text, so a bound
 *  typed past 2^53 isn't replaced by the double the thumb sits at. */
export function brushNumBetween(s: NumBetweenState, lo: number, hi: number, int64 = false): NumBetweenState {
    return {
        lo: parseFloat(s.lo) === lo ? s.lo : boundText(lo, int64),
        hi: parseFloat(s.hi) === hi ? s.hi : boundText(hi, int64),
        inclusive: s.inclusive,
    };
}

/** Resolve set-membership values. Checklist columns (labelled-numeric, shipped
 *  dictionary) carry the selected codes/labels directly — preserving numeric
 *  types; free-text columns parse the comma/newline list into strings. */
function effectiveSetValues(s: FormState, setUsesChecklist: boolean): (string | number)[] {
    if (setUsesChecklist) {
        return s.set.selected;
    }
    const seeded = s.freeText.values;
    if (seeded && s.freeText.text === seeded.join('\n')) return [...seeded];
    return s.freeText.text
        .split(/[\n,]+/)
        .map(t => t.trim())
        .filter(Boolean);
}

/** A typed numeric bound, or null when it isn't a number. On an Int64 /
 *  Uint64 column, an integer a double can't hold exactly stays decimal
 *  text, so the filter compares the integer that was typed
 *  (`9007199254740993`, not the 2^53 it would round to). */
export function parseBound(text: string, int64 = false): NumBound | null {
    const t = text.trim();
    if (int64 && /^[+-]?[0-9]+$/.test(t)) {
        const exact = BigInt(t);
        const n = Number(t);
        if (!Number.isFinite(n) || BigInt(n) !== exact) return exact.toString();
    }
    const v = parseFloat(text);
    return isNaN(v) ? null : v;
}

/** Build the FilterPredicate from the form state, or null when the input is
 *  incomplete (empty value, unparseable number, regex error). `kind` is the
 *  kind-select option value; `setUsesChecklist` reflects the column kind,
 *  and `int64` says the column is Int64 / Uint64 (see {@link parseBound}). */
export function buildPredicate(
    kind: string,
    s: FormState,
    opts: { setUsesChecklist: boolean; int64?: boolean },
): FilterPredicate | null {
    switch (kind) {
        case 'isEmpty': return { kind: 'isEmpty' };
        case 'isNotEmpty': return { kind: 'isNotEmpty' };
        case 'numCompare': {
            const v = parseBound(s.numCompare.value, opts.int64);
            if (v === null) return null;
            return { kind: 'numCompare', op: s.numCompare.op, value: v };
        }
        case 'numBetween': {
            const lo = parseBound(s.numBetween.lo, opts.int64);
            const hi = parseBound(s.numBetween.hi, opts.int64);
            if (lo === null || hi === null) return null;
            return {
                kind: 'numBetween', lo, hi, inclusive: s.numBetween.inclusive,
                ...(s.numBetween.upperInclusive !== undefined ? { upperInclusive: s.numBetween.upperInclusive } : {}),
            };
        }
        case 'numNotBetween': {
            const lo = parseBound(s.numBetween.lo, opts.int64);
            const hi = parseBound(s.numBetween.hi, opts.int64);
            if (lo === null || hi === null) return null;
            return { kind: 'numNotBetween', lo, hi, inclusive: s.numBetween.inclusive };
        }
        case 'setIn': {
            const vals = effectiveSetValues(s, opts.setUsesChecklist);
            if (vals.length === 0) return null;
            return { kind: 'setIn', values: vals };
        }
        case 'setNotIn': {
            const vals = effectiveSetValues(s, opts.setUsesChecklist);
            if (vals.length === 0) return null;
            return { kind: 'setNotIn', values: vals };
        }
        case 'strContains':
            if (!s.str.value) return null;
            return { kind: 'strContains', value: s.str.value, caseSensitive: s.str.caseSensitive, negate: false };
        case 'strNotContains':
            if (!s.str.value) return null;
            return { kind: 'strContains', value: s.str.value, caseSensitive: s.str.caseSensitive, negate: true };
        case 'strStartsWith':
            if (!s.str.value) return null;
            return { kind: 'strStartsWith', value: s.str.value, caseSensitive: s.str.caseSensitive };
        case 'strEndsWith':
            if (!s.str.value) return null;
            return { kind: 'strEndsWith', value: s.str.value, caseSensitive: s.str.caseSensitive };
        case 'strCompareEq':
            if (!s.str.value) return null;
            return { kind: 'strCompare', op: '=', value: s.str.value, caseSensitive: s.str.caseSensitive };
        case 'strCompareNe':
            if (!s.str.value) return null;
            return { kind: 'strCompare', op: '!=', value: s.str.value, caseSensitive: s.str.caseSensitive };
        case 'strRegex':
            if (!s.strRegex.pattern || s.strRegex.regexError) return null;
            return { kind: 'strRegex', pattern: s.strRegex.pattern, caseSensitive: s.strRegex.caseSensitive };
        case 'dateCompare':
            if (!s.dateCompare.value) return null;
            return { kind: 'dateCompare', op: s.dateCompare.op, value: s.dateCompare.value };
        case 'dateBetween':
            if (!s.dateBetween.lo || !s.dateBetween.hi) return null;
            return { kind: 'dateBetween', lo: s.dateBetween.lo, hi: s.dateBetween.hi, inclusive: s.dateBetween.inclusive };
        case 'dateNotBetween':
            if (!s.dateBetween.lo || !s.dateBetween.hi) return null;
            return { kind: 'dateNotBetween', lo: s.dateBetween.lo, hi: s.dateBetween.hi, inclusive: s.dateBetween.inclusive };
        case 'bool':
            return { kind: 'bool', value: s.bool.value };
    }
    return null;
}
