/**
 * Pure column-type categorisation for the filter editor. Maps a
 * ColumnSchema to a ColKind and supplies the predicate-kind option list
 * per kind. Kept React-free so it is unit-testable under bun and so the
 * popover stays focused on rendering.
 */
import type { ColumnSchema } from '../arrow-reader';

export type ColKind = 'numeric' | 'factor' | 'string' | 'bool' | 'date';

export function colKind(col: ColumnSchema): ColKind {
    const t = col.arrowType;
    if (t.startsWith('Int') || t.startsWith('Uint') || t.startsWith('Float')) return 'numeric';
    if (t.startsWith('Dictionary')) return 'factor';
    if (col.valueLabels) return 'factor';
    if (t.startsWith('Utf8') || t.startsWith('LargeUtf8')) return 'string';
    if (t === 'Bool') return 'bool';
    if (t.startsWith('Date') || t.startsWith('Timestamp')) return 'date';
    return 'string'; // safe fallback
}

export type KindOption = { value: string; label: string };

export function kindOptions(kind: ColKind): KindOption[] {
    switch (kind) {
        case 'numeric':
            return [
                { value: 'numCompare', label: 'Compare (=, ≠, <, ≤, >, ≥)' },
                { value: 'numBetween', label: 'Between' },
                { value: 'numNotBetween', label: 'Not between' },
                { value: 'isEmpty', label: 'Is empty / NA' },
                { value: 'isNotEmpty', label: 'Is not empty' },
            ];
        case 'factor':
            return [
                { value: 'setIn', label: 'Is one of' },
                { value: 'setNotIn', label: 'Is not one of' },
                { value: 'isEmpty', label: 'Is empty / NA' },
                { value: 'isNotEmpty', label: 'Is not empty' },
            ];
        case 'string':
            return [
                { value: 'strContains', label: 'Contains' },
                { value: 'strNotContains', label: 'Does not contain' },
                { value: 'strStartsWith', label: 'Starts with' },
                { value: 'strEndsWith', label: 'Ends with' },
                { value: 'strCompareEq', label: 'Equals (=)' },
                { value: 'strCompareNe', label: 'Not equals (≠)' },
                { value: 'strRegex', label: 'Matches regex' },
                { value: 'isEmpty', label: 'Is empty / NA' },
                { value: 'isNotEmpty', label: 'Is not empty' },
            ];
        case 'bool':
            return [
                { value: 'bool', label: 'Is true / false' },
                { value: 'isEmpty', label: 'Is empty / NA' },
                { value: 'isNotEmpty', label: 'Is not empty' },
            ];
        case 'date':
            return [
                { value: 'dateCompare', label: 'Compare (=, ≠, <, ≤, >, ≥)' },
                { value: 'dateBetween', label: 'Between' },
                { value: 'dateNotBetween', label: 'Not between' },
                { value: 'isEmpty', label: 'Is empty / NA' },
                { value: 'isNotEmpty', label: 'Is not empty' },
            ];
    }
}
