/**
 * Sort engine for the data viewer.
 *
 * Produces a row permutation from one or more {@link SortKey}s, sourced
 * from an open {@link ArrowSliceReader}. In the extension it runs in the
 * scan worker (`scan-core.ts`), never on the extension host's event loop.
 *
 * Invariants:
 *   - **Stable.** Every pass is a stable radix sort of the current
 *     permutation (`radix.ts`), and the initial permutation is ascending
 *     row index, so ties always end in original row order. Row index is
 *     never a sort key.
 *   - **Multi-key sorts are LSD over keys**: a pass on the last key, then
 *     on each earlier one.
 *   - **Missing values last in both directions**: NaN just before NA, both
 *     after every present value (R's `order(..., na.last = TRUE)` puts both
 *     last; we separate them so NaN and NA rows don't interleave).
 *   - **`-0` ties with `+0`.**
 *   - **WYSIWYG label routing**: when `labelsOn` is true, factor and
 *     value-labelled columns sort by the displayed label; when false, by
 *     the underlying code or value. Factor codes are level order, so an
 *     ordered factor sorts by its levels with Labels off.
 *   - **Format independence**: `formatOn` / `digits` never affect order.
 *   - **Strings sort by rank**: the distinct values are sorted once and
 *     each row maps to a `Uint32Array` rank, which is radix-sorted. Values
 *     the collator calls equal (e.g. NFC vs NFD forms) share a rank, so
 *     their rows tie. Three orders ({@link StringOrder}): Natural (the
 *     default, `Intl.Collator(locale, {numeric: true})`), Locale (the same
 *     collator without `numeric`), and C (Unicode code point order, as
 *     `sort(method = "radix")` and `dplyr::arrange()` use). The locale is
 *     always the explicit UI language the host passes in, never the
 *     runtime default, so Copy as R code can name it.
 *
 * Performance: each key column is materialized once over **all** rows
 * into an encoded key and cached in a {@link SortKeyCache}, so flipping a
 * direction, adding a key, or re-sorting a different subset of rows (the
 * survivors of a filter, #328) never re-reads the file.
 */

import type { ArrowSliceReader, ColumnSchema } from './arrow-reader';
import type { SortKey, StringOrder } from './messages';
import { iterateBatches } from './batch-iter';
import { throwIfAborted } from './abort';
import {
    CLS_NA,
    CLS_NAN,
    compareCodePoints,
    encodeBigInt64,
    encodeFloat64,
    encodeRanks,
    radixSortByKey,
    rankDistinct,
} from './radix';
import type { CancelCheck, EncodedKey } from './radix';

export type { StringOrder } from './messages';

/** Toolbar snapshot used to derive sort keys WYSIWYG. */
export type SortContext = {
    labelsOn: boolean;
    formatOn: boolean;
    digits: number;
    /** String order; defaults to Natural. */
    stringOrder?: StringOrder;
    /** BCP 47 tag for Natural and Locale orders (VS Code's UI language).
     *  `undefined` falls back to the runtime default (tests only). */
    locale?: string;
};

/** Called while a key is being built or sorted. `phase` names the step;
 *  `done`/`total` measure it when known. */
export type SortProgress = (phase: 'read' | 'rank' | 'sort', done: number, total: number) => void;

export type SortOptions = {
    signal?: AbortSignal;
    /** Rows to sort (e.g. a filter's survivors, in original order).
     *  Defaults to every row. The result is a permutation of these. */
    rows?: Uint32Array;
    /** Materialized keys to reuse and fill. */
    cache?: SortKeyCache;
    onProgress?: SortProgress;
};

/** Cached encoded keys, keyed by column and by whatever changes the
 *  key's meaning (labels, string order, locale). Owned by one reader. */
/**
 * Encoded sort keys per (column, order, locale), least recently used first,
 * bounded by bytes: a numeric key costs ~9 bytes per row, so an unbounded
 * cache would hold ~90 MB per sorted column of a 10M-row frame for the
 * worker's lifetime. A sort already holds references to the keys it is
 * using, so evicting them mid-sort is harmless.
 */
export class SortKeyCache {
    static readonly DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
    private readonly map = new Map<string, EncodedKey>();
    private total = 0;
    constructor(private readonly maxBytes = SortKeyCache.DEFAULT_MAX_BYTES) {}
    get(k: string): EncodedKey | undefined {
        const v = this.map.get(k);
        if (v) { this.map.delete(k); this.map.set(k, v); }
        return v;
    }
    set(k: string, v: EncodedKey): void {
        const prev = this.map.get(k);
        if (prev) { this.total -= keyBytes(prev); this.map.delete(k); }
        this.map.set(k, v);
        this.total += keyBytes(v);
        for (const [old, ov] of this.map) {
            if (this.total <= this.maxBytes || old === k) break;
            this.map.delete(old);
            this.total -= keyBytes(ov);
        }
    }
    has(k: string): boolean { return this.map.has(k); }
    clear(): void { this.map.clear(); this.total = 0; }
    get size(): number { return this.map.size; }
    /** Approximate bytes held, for the memory counter and bench. */
    get bytes(): number { return this.total; }
}

function keyBytes(k: EncodedKey): number {
    return k.hi.byteLength + (k.lo?.byteLength ?? 0) + k.cls.byteLength;
}

/**
 * Build a row permutation that, applied to the unsorted rows (or to
 * `opts.rows`), yields rows in the order described by `keys`. An empty
 * `keys` returns the input order.
 */
export async function computePermutation(
    reader: ArrowSliceReader,
    keys: readonly SortKey[],
    ctx: SortContext,
    opts: SortOptions = {},
): Promise<Uint32Array> {
    const { signal } = opts;
    const check: CancelCheck = () => throwIfAborted(signal);
    let perm: Uint32Array;
    if (opts.rows) {
        perm = new Uint32Array(opts.rows);
    } else {
        perm = new Uint32Array(reader.nrow);
        for (let i = 0; i < perm.length; i++) perm[i] = i;
    }
    if (keys.length === 0) return perm;

    const encoded: EncodedKey[] = [];
    for (const k of keys) {
        encoded.push(await materializeSortKey(reader, k.columnIndex, ctx, opts));
    }
    check();
    for (let k = keys.length - 1; k >= 0; k--) {
        opts.onProgress?.('sort', keys.length - 1 - k, keys.length);
        perm = radixSortByKey(perm, encoded[k], keys[k].direction === 'desc', check);
    }
    check();
    return perm;
}

/** Cache key for a column's sort key under `ctx`. */
export function sortKeyId(schema: ColumnSchema, columnIndex: number, ctx: SortContext): string {
    const kind = keyKind(schema, ctx);
    const strOrder = `${ctx.stringOrder ?? 'natural'}:${ctx.locale ?? ''}`;
    switch (kind) {
        case 'string':
        case 'dictLabel':
        case 'valueLabel':
            return `${columnIndex}:${kind}:${strOrder}`;
        default:
            return `${columnIndex}:${kind}`;
    }
}

type KeyKind =
    | 'dictLabel' | 'dictCode' | 'valueLabel'
    | 'int64' | 'uint64' | 'timestamp' | 'number' | 'string';

function keyKind(schema: ColumnSchema, ctx: SortContext): KeyKind {
    const t = schema.arrowType;
    if (t.startsWith('Dictionary')) return ctx.labelsOn ? 'dictLabel' : 'dictCode';
    // Value-labelled columns (haven_labelled, foreign::value.labels,
    // readstata13) show a label for any Int*/Float/Utf8 cell that has one;
    // with Labels on, sort by what's displayed.
    if (ctx.labelsOn && schema.valueLabels
        && (t.startsWith('Int') || t.startsWith('Uint') || t.startsWith('Float')
            || t === 'Utf8' || t === 'LargeUtf8')) {
        return 'valueLabel';
    }
    // 64-bit integers exceed Number's 2^53 safe range; keep them exact.
    if (t === 'Int64') return 'int64';
    if (t === 'Uint64') return 'uint64';
    if (t.startsWith('Timestamp')) return 'timestamp';
    if (t.startsWith('Int') || t.startsWith('Uint') || t.startsWith('Float')
        || t === 'Bool' || t.startsWith('Date')) {
        return 'number';
    }
    return 'string';
}

/** The encoded key for one column over all rows, from `opts.cache` when
 *  present. */
export async function materializeSortKey(
    reader: ArrowSliceReader,
    columnIndex: number,
    ctx: SortContext,
    opts: SortOptions = {},
): Promise<EncodedKey> {
    const schema = reader.schema.columns[columnIndex];
    if (!schema) {
        throw new Error(`computePermutation: unknown columnIndex ${columnIndex}`);
    }
    const id = sortKeyId(schema, columnIndex, ctx);
    const hit = opts.cache?.get(id);
    if (hit) return hit;
    const key = await buildKey(reader, columnIndex, schema, ctx, opts);
    opts.cache?.set(id, key);
    return key;
}

async function buildKey(
    reader: ArrowSliceReader,
    columnIndex: number,
    schema: ColumnSchema,
    ctx: SortContext,
    opts: SortOptions,
): Promise<EncodedKey> {
    const { signal } = opts;
    const check: CancelCheck = () => throwIfAborted(signal);
    const nrow = reader.nrow;
    const cls = new Uint8Array(nrow);
    const kind = keyKind(schema, ctx);
    let done = 0;
    const progress = (len: number) => {
        done += len;
        opts.onProgress?.('read', done, nrow);
    };

    if (kind === 'number') {
        const values = new Float64Array(nrow);
        const isFloat = schema.arrowType.startsWith('Float');
        for await (const { batch, start, length } of iterateBatches(reader, [columnIndex], signal)) {
            const child = batch.getChildAt(columnIndex);
            const data = child.data[0];
            const fast = isFloat || /^U?[Ii]nt(8|16|32)$/.test(schema.arrowType);
            const vals = fast ? data.values : undefined;
            const off: number = data.offset ?? 0;
            for (let r = 0; r < length; r++) {
                const i = start + r;
                if (isNullAt(data, r)) { cls[i] = CLS_NA; continue; }
                const v = vals ? vals[off + r] : child.get(r);
                if (v === null || v === undefined) { cls[i] = CLS_NA; continue; }
                const x = typeof v === 'number' ? v : Number(v);
                if (Number.isNaN(x)) { cls[i] = CLS_NAN; continue; }
                values[i] = x;
            }
            progress(length);
        }
        return encodeFloat64(values, cls);
    }

    if (kind === 'int64' || kind === 'uint64' || kind === 'timestamp') {
        const values = kind === 'uint64' ? new BigUint64Array(nrow) : new BigInt64Array(nrow);
        for await (const { batch, start, length } of iterateBatches(reader, [columnIndex], signal)) {
            const child = batch.getChildAt(columnIndex);
            const data = child.data[0];
            const off: number = data.offset ?? 0;
            for (let r = 0; r < length; r++) {
                const i = start + r;
                if (isNullAt(data, r)) { cls[i] = CLS_NA; continue; }
                const v = kind === 'timestamp' ? data.values[off + r] : child.get(r);
                if (v === null || v === undefined) { cls[i] = CLS_NA; continue; }
                values[i] = typeof v === 'bigint' ? v : BigInt(v as number);
            }
            progress(length);
        }
        return encodeBigInt64(values, cls, kind !== 'uint64');
    }

    if (kind === 'dictCode') {
        const codes = new Float64Array(nrow);
        for await (const { batch, start, length } of iterateBatches(reader, [columnIndex], signal)) {
            const data = batch.getChildAt(columnIndex).data[0];
            const off: number = data.offset ?? 0;
            for (let r = 0; r < length; r++) {
                const i = start + r;
                if (isNullAt(data, r)) { cls[i] = CLS_NA; continue; }
                codes[i] = Number(data.values[off + r]);
            }
            progress(length);
        }
        return encodeFloat64(codes, cls);
    }

    const compare = stringComparator(ctx);

    if (kind === 'dictLabel') {
        const codes = new Uint32Array(nrow);
        let maxCode = -1;
        for await (const { batch, start, length } of iterateBatches(reader, [columnIndex], signal)) {
            const data = batch.getChildAt(columnIndex).data[0];
            const off: number = data.offset ?? 0;
            for (let r = 0; r < length; r++) {
                const i = start + r;
                if (isNullAt(data, r)) { cls[i] = CLS_NA; continue; }
                const c = Number(data.values[off + r]);
                codes[i] = c;
                if (c > maxCode) maxCode = c;
            }
            progress(length);
        }
        const labels = await dictionaryLabels(reader, columnIndex, schema, codes, cls, maxCode);
        check();
        opts.onProgress?.('rank', 0, labels.length);
        const dictRank = rankDistinct(labels, compare, check);
        const ranks = new Uint32Array(nrow);
        for (let i = 0; i < nrow; i++) {
            if (cls[i] === 0) ranks[i] = dictRank[codes[i]] ?? 0;
        }
        return encodeRanks(ranks, cls);
    }

    // string / valueLabel: map each row to a distinct-value id while
    // reading, rank the distinct values once, then map ids to ranks.
    const ids = new Uint32Array(nrow);
    const idOf = new Map<string, number>();
    const distinct: string[] = [];
    const valueLabels = kind === 'valueLabel' ? (schema.valueLabels ?? {}) : undefined;
    for await (const { batch, start, length } of iterateBatches(reader, [columnIndex], signal)) {
        const child = batch.getChildAt(columnIndex);
        for (let r = 0; r < length; r++) {
            const i = start + r;
            const v = child.get(r);
            if (v === null || v === undefined) { cls[i] = CLS_NA; continue; }
            if (typeof v === 'number' && Number.isNaN(v)) { cls[i] = CLS_NAN; continue; }
            let s = typeof v === 'bigint' ? v.toString() : String(v);
            if (valueLabels) s = valueLabels[s] ?? s;
            let id = idOf.get(s);
            if (id === undefined) {
                id = distinct.length;
                idOf.set(s, id);
                distinct.push(s);
            }
            ids[i] = id;
        }
        progress(length);
    }
    check();
    opts.onProgress?.('rank', 0, distinct.length);
    const distinctRank = rankDistinct(distinct, compare, check);
    for (let i = 0; i < nrow; i++) {
        ids[i] = cls[i] === 0 ? distinctRank[ids[i]] : 0;
    }
    return encodeRanks(ids, cls);
}

/** Label strings indexed by dictionary code: the reader's loaded
 *  dictionary when available, else labels fetched for the codes present. */
async function dictionaryLabels(
    reader: ArrowSliceReader,
    columnIndex: number,
    schema: ColumnSchema,
    codes: Uint32Array,
    cls: Uint8Array,
    maxCode: number,
): Promise<string[]> {
    if (schema.dictionary) return schema.dictionary;
    const vec = typeof reader.dictionaryVector === 'function'
        ? reader.dictionaryVector(columnIndex)
        : undefined;
    if (vec) {
        const out: string[] = new Array(vec.length);
        for (let d = 0; d < vec.length; d++) {
            const v = vec.get(d);
            out[d] = v === null || v === undefined ? '' : String(v);
        }
        return out;
    }
    const need = new Set<number>();
    for (let i = 0; i < codes.length; i++) if (cls[i] === 0) need.add(codes[i]);
    const fetched = await reader.getLabels(columnIndex, [...need]);
    const out: string[] = new Array(maxCode + 1).fill('');
    for (const [k, v] of Object.entries(fetched)) out[Number(k)] = v;
    return out;
}

const collators = new Map<string, Intl.Collator>();

/** The comparator for a string order. Natural and Locale collators are
 *  cached per (locale, numeric). */
export function stringComparator(ctx: Pick<SortContext, 'stringOrder' | 'locale'>): (a: string, b: string) => number {
    const order = ctx.stringOrder ?? 'natural';
    if (order === 'c') return compareCodePoints;
    const numeric = order === 'natural';
    const id = `${ctx.locale ?? ''}|${numeric}`;
    let c = collators.get(id);
    if (!c) {
        c = new Intl.Collator(ctx.locale, { sensitivity: 'variant', numeric });
        collators.set(id, c);
    }
    return c.compare;
}

/** Whether row `row` of an Arrow data chunk is null (validity bit clear). */
export function isNullAt(data: any, row: number): boolean {
    const bm = data.nullBitmap;
    if (!bm || bm.length === 0 || data.nullCount === 0) return false;
    const bit = (data.offset ?? 0) + row;
    const byteIdx = bit >> 3;
    if (byteIdx >= bm.length) return false;
    return ((bm[byteIdx] >> (bit & 7)) & 1) === 0;
}
