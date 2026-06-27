/**
 * Part 1 of #519: computePermutation / computeFilteredIndices accept an
 * optional AbortSignal and reject with an AbortError when cancelled,
 * while the signal-less path stays byte-identical. The panel uses this
 * to make the saved sort/filter restore on open interruptible.
 */
import { describe, test, expect } from 'bun:test';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArrowSliceReader } from '../../editors/vscode/src/data-viewer/arrow-reader';
import { computePermutation } from '../../editors/vscode/src/data-viewer/sort';
import { computeFilteredIndices } from '../../editors/vscode/src/data-viewer/filter';
import { isAbortError } from '../../editors/vscode/src/data-viewer/abort';
import type { FilterState } from '../../editors/vscode/src/data-viewer/messages';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = (n: string) =>
    join(HERE, '..', '..', 'editors/vscode/test-fixtures/data-viewer', n);
const CTX = { labelsOn: true, formatOn: true, digits: 3 };

async function rejectsAbort(p: Promise<unknown>): Promise<void> {
    let err: unknown;
    try { await p; } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(isAbortError(err)).toBe(true);
}

describe('computePermutation with AbortSignal', () => {
    test('signal that never aborts yields the same result as no signal', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const keys = [{ columnIndex: 0, direction: 'desc' as const }];
        const baseline = await computePermutation(r, keys, CTX);
        const withSignal = await computePermutation(r, keys, CTX, {
            signal: new AbortController().signal,
        });
        expect(Array.from(withSignal)).toEqual(Array.from(baseline));
        await r.close();
    });

    test('already-aborted signal rejects with AbortError', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const c = new AbortController();
        c.abort();
        await rejectsAbort(computePermutation(
            r, [{ columnIndex: 0, direction: 'asc' }], CTX, { signal: c.signal },
        ));
        await r.close();
    });

    test('aborting during the read rejects with AbortError', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const c = new AbortController();
        const p = computePermutation(
            r, [{ columnIndex: 0, direction: 'asc' }], CTX, { signal: c.signal },
        );
        // computePermutation has already suspended at its first column-read
        // await; aborting now is observed at the next checkpoint.
        c.abort();
        await rejectsAbort(p);
        await r.close();
    });
});

const NOT_EMPTY: FilterState = {
    entries: [{
        id: 'f1',
        columnIndex: 0,
        predicate: { kind: 'isNotEmpty' },
        enabled: true,
        includeMissing: false,
    }],
    labelsOnWhenFiltered: true,
};

describe('computeFilteredIndices with AbortSignal', () => {
    test('signal that never aborts yields the same result as no signal', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const baseline = await computeFilteredIndices(r, NOT_EMPTY, CTX);
        const withSignal = await computeFilteredIndices(r, NOT_EMPTY, CTX, {
            signal: new AbortController().signal,
        });
        expect(withSignal && Array.from(withSignal))
            .toEqual(baseline ? Array.from(baseline) : undefined);
        await r.close();
    });

    test('already-aborted signal rejects with AbortError', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const c = new AbortController();
        c.abort();
        await rejectsAbort(computeFilteredIndices(r, NOT_EMPTY, CTX, {
            signal: c.signal,
        }));
        await r.close();
    });

    test('aborting during the read rejects with AbortError', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const c = new AbortController();
        const p = computeFilteredIndices(r, NOT_EMPTY, CTX, { signal: c.signal });
        c.abort();
        await rejectsAbort(p);
        await r.close();
    });
});
