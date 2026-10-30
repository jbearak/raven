/**
 * Find in grid: which rows show a query in any of the given columns.
 *
 * Runs in the scan worker (`scan-core.ts`). It matches the **displayed
 * text**, the same `formatCell` the grid draws with the same Labels,
 * Format and digits, case-insensitively, so what you find is what you see.
 * Missing cells display `NA` and `NaN` and match those words.
 *
 * Matches come back as **display positions**, ascending: source rows are
 * mapped through the effective permutation the webview is showing, so
 * next/previous walk the grid top to bottom.
 *
 * Refinement: when the new query contains the previous one (the user
 * typed more) and nothing else changed, only the previous matches can
 * still match, so only their rows are tested, and batches without a
 * candidate are skipped (RStudio).
 *
 * Per distinct value, not per cell, where it's cheap: a dictionary column
 * tests each level once, and a string column is tested through a bounded
 * memo.
 */
import type { ArrowSliceReader, ColumnSchema } from './arrow-reader';
import { encodeArrowCell } from './arrow-reader';
import { formatCell } from './display-format';
import { iterateBatches } from './batch-iter';
import { throwIfAborted } from './abort';

export type FindQuery = {
    query: string;
    /** Source columns to search (the visible ones). */
    columns: number[];
    labelsOn: boolean;
    formatOn: boolean;
    digits: number;
};

/** The source rows (ascending) matching `q`; `within` restricts the
 *  search to a previous match set. */
export async function findSourceRows(
    reader: ArrowSliceReader,
    q: FindQuery,
    within: Uint32Array | undefined,
    signal?: AbortSignal,
): Promise<Uint32Array> {
    const needle = q.query.toLowerCase();
    const cols = q.columns.filter(c => reader.schema.columns[c] !== undefined);
    if (needle === '' || cols.length === 0) return new Uint32Array(0);
    const nrow = reader.nrow;
    const hit = new Uint8Array(nrow);
    let candidates: Uint8Array | undefined;
    if (within) {
        candidates = new Uint8Array(nrow);
        for (let i = 0; i < within.length; i++) candidates[within[i]] = 1;
    }
    const testers = cols.map(ci => cellTester(reader, ci, reader.schema.columns[ci], q, needle));
    // Batches without a candidate row are never read.
    let wi = 0;
    const want = within
        ? (start: number, end: number) => {
            while (wi < within.length && within[wi] < start) wi++;
            return wi < within.length && within[wi] < end;
        }
        : undefined;
    for await (const { batch, start, length } of iterateBatches(reader, cols, signal, want)) {
        const children = cols.map(ci => batch.getChildAt(ci));
        for (let r = 0; r < length; r++) {
            const row = start + r;
            if (candidates && candidates[row] === 0) continue;
            for (let k = 0; k < cols.length; k++) {
                if (testers[k](children[k], r)) { hit[row] = 1; break; }
            }
        }
        throwIfAborted(signal);
    }
    let count = 0;
    for (let i = 0; i < nrow; i++) count += hit[i];
    const out = new Uint32Array(count);
    let j = 0;
    for (let i = 0; i < nrow; i++) if (hit[i]) out[j++] = i;
    return out;
}

/** Map source rows (ascending) to display positions (ascending) under
 *  `perm`, the effective permutation (`undefined` ⇔ natural order). */
export function toDisplayPositions(sourceRows: Uint32Array, perm: Uint32Array | undefined, nrow: number): Uint32Array {
    if (!perm) return sourceRows;
    const mark = new Uint8Array(nrow);
    for (let i = 0; i < sourceRows.length; i++) mark[sourceRows[i]] = 1;
    let count = 0;
    for (let p = 0; p < perm.length; p++) count += mark[perm[p]];
    const out = new Uint32Array(count);
    let j = 0;
    for (let p = 0; p < perm.length; p++) if (mark[perm[p]]) out[j++] = p;
    return out;
}

const MEMO_MAX = 100_000;

function cellTester(
    reader: ArrowSliceReader,
    ci: number,
    col: ColumnSchema,
    q: FindQuery,
    needle: string,
): (child: any, row: number) => boolean {
    const opts = { labelsOn: q.labelsOn, formatOn: q.formatOn, digits: q.digits };
    const matches = (text: string) => text.toLowerCase().includes(needle);
    const naHit = matches('NA');
    if (col.arrowType.startsWith('Dictionary')) {
        // Test each level's displayed text once.
        let levels = col.dictionary;
        if (!levels && typeof reader.dictionaryVector === 'function') {
            const vec = reader.dictionaryVector(ci);
            if (vec) {
                levels = [];
                for (let d = 0; d < vec.length; d++) {
                    const v = vec.get(d);
                    levels.push(v === null || v === undefined ? '' : String(v));
                }
            }
        }
        const pass: boolean[] = [];
        const passFor = (code: number): boolean => {
            let p = pass[code];
            if (p === undefined) {
                p = matches(formatCell(code, col, levels, { ...opts, resolvedLabel: levels?.[code] }).text);
                pass[code] = p;
            }
            return p;
        };
        return (child, r) => {
            const cell = encodeArrowCell(child, r, col.arrowType);
            return cell === null ? naHit : passFor(cell as number);
        };
    }
    const memo = new Map<string, boolean>();
    const isString = col.arrowType === 'Utf8' || col.arrowType === 'LargeUtf8';
    return (child, r) => {
        if (isString && !col.valueLabels) {
            const v = child.get(r);
            if (v === null || v === undefined) return naHit;
            const s = String(v);
            let m = memo.get(s);
            if (m === undefined) {
                m = matches(s);
                if (memo.size < MEMO_MAX) memo.set(s, m);
            }
            return m;
        }
        const cell = encodeArrowCell(child, r, col.arrowType);
        return matches(formatCell(cell, col, undefined, opts).text);
    };
}
