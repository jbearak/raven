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
import type { FilterPredicate } from '../messages';

// ── Value-editor state shapes ───────────────────────────────────────────────

export type NumCompareState = { op: '=' | '!=' | '<' | '<=' | '>' | '>='; value: string };
export type NumBetweenState = { lo: string; hi: string; inclusive: boolean };
export type SetState = { selected: (string | number)[] };
export type StrState = { value: string; caseSensitive: boolean };
export type StrRegexState = { pattern: string; caseSensitive: boolean; regexError: string | null };
export type DateCompareState = { op: '=' | '!=' | '<' | '<=' | '>' | '>='; value: string };
export type DateBetweenState = { lo: string; hi: string; inclusive: boolean };
export type BoolState = { value: boolean };
export type SetFreeTextState = { text: string };

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
 *  matching sub-state is filled; all others keep their blank defaults. */
export function seedFromEntry(p: FilterPredicate): FormState {
    const base = defaultFormState();
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

/** Resolve set-membership values. Checklist columns (labelled-numeric, shipped
 *  dictionary) carry the selected codes/labels directly — preserving numeric
 *  types; free-text columns parse the comma/newline list into strings. */
function effectiveSetValues(s: FormState, setUsesChecklist: boolean): (string | number)[] {
    if (setUsesChecklist) {
        return s.set.selected;
    }
    return s.freeText.text
        .split(/[\n,]+/)
        .map(t => t.trim())
        .filter(Boolean);
}

/** Build the FilterPredicate from the form state, or null when the input is
 *  incomplete (empty value, unparseable number, regex error). `kind` is the
 *  kind-select option value; `setUsesChecklist` reflects the column kind. */
export function buildPredicate(
    kind: string,
    s: FormState,
    opts: { setUsesChecklist: boolean },
): FilterPredicate | null {
    switch (kind) {
        case 'isEmpty': return { kind: 'isEmpty' };
        case 'isNotEmpty': return { kind: 'isNotEmpty' };
        case 'numCompare': {
            const v = parseFloat(s.numCompare.value);
            if (isNaN(v)) return null;
            return { kind: 'numCompare', op: s.numCompare.op, value: v };
        }
        case 'numBetween': {
            const lo = parseFloat(s.numBetween.lo);
            const hi = parseFloat(s.numBetween.hi);
            if (isNaN(lo) || isNaN(hi)) return null;
            return { kind: 'numBetween', lo, hi, inclusive: s.numBetween.inclusive };
        }
        case 'numNotBetween': {
            const lo = parseFloat(s.numBetween.lo);
            const hi = parseFloat(s.numBetween.hi);
            if (isNaN(lo) || isNaN(hi)) return null;
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
