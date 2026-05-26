/**
 * Filter engine — predicate evaluation against the same Arrow batches
 * the sort engine consumes. Returns `undefined` for an empty / all-
 * disabled state so the panel can skip storage.
 *
 * Covered in this file across Tasks 4–8:
 *   - Universal predicates and disabled chips (Task 4)
 *   - Numeric predicates (Task 5)
 *   - String predicates incl. regex (Task 6)
 *   - Date / Timestamp predicates (Task 7)
 *   - Set / factor / labelled predicates with Labels routing (Task 8)
 */

import { describe, test, expect } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArrowSliceReader } from '../../editors/vscode/src/data-viewer/arrow-reader';
import { computeFilteredIndices } from '../../editors/vscode/src/data-viewer/filter';
import type { FilterEntry, FilterState } from '../../editors/vscode/src/data-viewer/messages';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = (n: string) =>
    join(HERE, '..', '..', 'editors/vscode/test-fixtures/data-viewer', n);

const CTX_LABELS_ON = { labelsOn: true, formatOn: true, digits: 3 };

function state(entries: FilterEntry[]): FilterState {
    return { entries, labelsOnWhenFiltered: true };
}

function entry(id: string, columnIndex: number, predicate: FilterEntry['predicate'], opts: Partial<Omit<FilterEntry, 'id' | 'columnIndex' | 'predicate'>> = {}): FilterEntry {
    return {
        id,
        columnIndex,
        predicate,
        enabled: opts.enabled ?? true,
        includeMissing: opts.includeMissing ?? false,
    };
}

describe('computeFilteredIndices — empty / disabled state', () => {
    test('empty entries returns undefined', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const out = await computeFilteredIndices(r, state([]), CTX_LABELS_ON);
        expect(out).toBeUndefined();
        await r.close();
    });

    test('all-disabled entries returns undefined', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 0, { kind: 'isEmpty' }, { enabled: false });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(out).toBeUndefined();
        await r.close();
    });
});

describe('computeFilteredIndices — isEmpty / isNotEmpty', () => {
    test('isEmpty on y keeps rows where y is NA/NaN (rows 1,2)', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 1, { kind: 'isEmpty' });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(out).toBeInstanceOf(Uint32Array);
        expect(Array.from(out!)).toEqual([1, 2]);
        await r.close();
    });

    test('isNotEmpty on y keeps non-missing rows (0,3,4)', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 1, { kind: 'isNotEmpty' });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 3, 4]);
        await r.close();
    });

    test('isEmpty on a column with no missing values returns []', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 0, { kind: 'isEmpty' });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([]);
        await r.close();
    });
});

describe('computeFilteredIndices — multi-entry AND', () => {
    test('disabled entries are ignored', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const enabled = entry('a', 1, { kind: 'isNotEmpty' });
        const disabled = entry('b', 1, { kind: 'isEmpty' }, { enabled: false });
        const out = await computeFilteredIndices(r, state([enabled, disabled]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 3, 4]);
        await r.close();
    });
});

describe('computeFilteredIndices — includeMissing', () => {
    test('includeMissing makes NA rows pass an isNotEmpty entry trivially', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 1, { kind: 'isNotEmpty' }, { includeMissing: true });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 1, 2, 3, 4]);
        await r.close();
    });
});
