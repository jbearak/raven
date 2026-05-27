/**
 * filter-popover-seed — the bidirectional mapping between a persisted
 * FilterPredicate and the FilterPopover's per-kind form state. Pure, no React,
 * so it runs under bun directly.
 *
 * The round-trip property (predicate → seedFromEntry → buildPredicate ≡
 * predicate) is the regression guard for "reopening a filtered column shows its
 * active settings": if a new predicate kind is added to messages.ts without
 * wiring predicateToKindValue / seedFromEntry / buildPredicate in lockstep, a
 * round-trip case breaks.
 */
import { describe, test, expect } from 'bun:test';
import {
    predicateToKindValue,
    seedFromEntry,
    buildPredicate,
    defaultFormState,
} from '../../editors/vscode/src/data-viewer/webview/filter-popover-seed';
import type { FilterPredicate } from '../../editors/vscode/src/data-viewer/messages';

/** Open a saved predicate into the form, then rebuild it — what the popover
 *  does on Edit → Apply with no user change. `setUsesChecklist` mirrors the
 *  column kind: true for labelled-numeric / shipped-dictionary columns whose
 *  set membership is a checklist; false for the free-text value list. */
function roundTrip(p: FilterPredicate, setUsesChecklist = false): FilterPredicate | null {
    const kind = predicateToKindValue(p);
    const state = seedFromEntry(p);
    return buildPredicate(kind, state, { setUsesChecklist });
}

describe('seed/build round-trip — every predicate kind survives open → apply', () => {
    // [name, predicate, setUsesChecklist?]
    const cases: [string, FilterPredicate, boolean?][] = [
        ['numCompare', { kind: 'numCompare', op: '>=', value: 42 }],
        ['numBetween', { kind: 'numBetween', lo: 1, hi: 9, inclusive: true }],
        ['numNotBetween', { kind: 'numNotBetween', lo: -3.5, hi: 2.5, inclusive: false }],
        ['setIn numeric codes (checklist)', { kind: 'setIn', values: [1, 2, 8] }, true],
        ['setNotIn string labels (checklist)', { kind: 'setNotIn', values: ['Male', 'Female'] }, true],
        ['setIn string values (free-text)', { kind: 'setIn', values: ['a', 'b'] }, false],
        ['strContains', { kind: 'strContains', value: 'foo', caseSensitive: false, negate: false }],
        ['strContains negated', { kind: 'strContains', value: 'bar', caseSensitive: true, negate: true }],
        ['strStartsWith', { kind: 'strStartsWith', value: 'pre', caseSensitive: false }],
        ['strEndsWith', { kind: 'strEndsWith', value: 'suf', caseSensitive: true }],
        ['strCompare =', { kind: 'strCompare', op: '=', value: 'x', caseSensitive: false }],
        ['strCompare !=', { kind: 'strCompare', op: '!=', value: 'y', caseSensitive: true }],
        ['strRegex', { kind: 'strRegex', pattern: '^a.*z$', caseSensitive: false }],
        ['dateCompare', { kind: 'dateCompare', op: '<', value: '2024-01-01' }],
        ['dateBetween', { kind: 'dateBetween', lo: '2024-01-01', hi: '2024-12-31', inclusive: true }],
        ['dateNotBetween', { kind: 'dateNotBetween', lo: '2024-06-01', hi: '2024-06-30', inclusive: false }],
        ['bool true', { kind: 'bool', value: true }],
        ['bool false', { kind: 'bool', value: false }],
        ['isEmpty', { kind: 'isEmpty' }],
        ['isNotEmpty', { kind: 'isNotEmpty' }],
    ];
    for (const [name, p, checklist] of cases) {
        test(name, () => {
            expect(roundTrip(p, checklist ?? false)).toEqual(p);
        });
    }
});

describe('predicateToKindValue — disambiguates the negate/op pairs', () => {
    test('setIn vs setNotIn', () => {
        expect(predicateToKindValue({ kind: 'setIn', values: [1] })).toBe('setIn');
        expect(predicateToKindValue({ kind: 'setNotIn', values: [1] })).toBe('setNotIn');
    });
    test('strContains negate flag maps to two kinds', () => {
        expect(predicateToKindValue({ kind: 'strContains', value: 'x', caseSensitive: false, negate: false })).toBe('strContains');
        expect(predicateToKindValue({ kind: 'strContains', value: 'x', caseSensitive: false, negate: true })).toBe('strNotContains');
    });
    test('strCompare op maps to eq/ne kinds', () => {
        expect(predicateToKindValue({ kind: 'strCompare', op: '=', value: 'x', caseSensitive: false })).toBe('strCompareEq');
        expect(predicateToKindValue({ kind: 'strCompare', op: '!=', value: 'x', caseSensitive: false })).toBe('strCompareNe');
    });
});

describe('buildPredicate — incomplete input yields no predicate', () => {
    test('blank value-requiring kinds build to null', () => {
        const blank = defaultFormState();
        for (const kind of ['numCompare', 'numBetween', 'setIn', 'strContains', 'strRegex', 'dateCompare']) {
            expect(buildPredicate(kind, blank, { setUsesChecklist: false })).toBeNull();
        }
    });
    test('isEmpty / isNotEmpty need no input', () => {
        const blank = defaultFormState();
        expect(buildPredicate('isEmpty', blank, { setUsesChecklist: false })).toEqual({ kind: 'isEmpty' });
        expect(buildPredicate('isNotEmpty', blank, { setUsesChecklist: false })).toEqual({ kind: 'isNotEmpty' });
    });
});
