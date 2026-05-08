/**
 * ArrowSliceReader — opens one Apache Arrow IPC (file format) file and
 * serves row windows on demand.
 *
 * Loading model: the file is opened as a FileHandle and handed to
 * apache-arrow's AsyncRecordBatchFileReader, which reads only the IPC
 * footer at open time and issues seek+read syscalls per batch on demand.
 * The full file is never loaded into memory, so files larger than the
 * Node.js Buffer 2 GiB limit are handled correctly. RSS is bounded by
 * the decoded-batch LRU cache rather than the file size.
 *
 * Call close() when done to release the underlying FileHandle.
 *
 * The exact API surface used here is pinned by
 * tests/bun/data-viewer-arrow-spike.test.ts.
 */

import { open as fsOpen } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { AsyncRecordBatchFileReader } from 'apache-arrow';
import {
    Cell,
    encodeNumber,
    encodeString,
    encodeDate,
    encodeTimestampMicros,
} from './wire-format';

/** Default cardinality threshold above which a dictionary is not shipped
 *  in the init/replace message. The webview must request labels on demand
 *  via getLabels for those columns. */
export const DEFAULT_DICTIONARY_THRESHOLD = 100_000;

export type ColumnSchema = {
    name: string;
    /** String form of the Arrow type for cheap discrimination on the wire. */
    arrowType: string;
    /** Original R class chain captured by the bootstrap profile. */
    originalClass?: string;
    /** Variable label (haven, foreign, readstata13). Shown in header tooltip. */
    variableLabel?: string;
    /** Value labels for non-dictionary numeric/string columns (haven_labelled
     *  via raven.value_labels). Looked up by stringified cell value. */
    valueLabels?: Record<string, string>;
    /** Stata format string (captured but unused in v1). */
    formatStata?: string;
    /** Dictionary level strings, present iff dictionaryShipped. */
    dictionary?: string[];
    /** True iff this column is dictionary-encoded AND its dictionary fits
     *  under the cardinality threshold. */
    dictionaryShipped: boolean;
    /** True iff the column type is integer (Format toggle ignores these). */
    isInteger: boolean;
};

export type ReaderSchema = {
    columns: ColumnSchema[];
};

export type GetRowsRequest = {
    start: number;
    end: number;
    /** Column indices into `schema.columns`, in the order rows should be
     *  returned. Hidden columns are intentionally omitted by the caller. */
    columns: number[];
    /** Latest viewport generation seen by the panel. Older requests are
     *  skipped (returned with `stale: true`). */
    viewportGeneration: number;
};

export type GetRowsResponse = {
    /** Outer length = end - start (clamped). Inner length = columns.length. */
    rows: Cell[][];
    stale: boolean;
};

export type OpenOptions = {
    dictionaryThreshold?: number;
};

export class ArrowSliceReader {
    readonly schema: ReaderSchema;
    readonly nrow: number;
    readonly batchStarts: Uint32Array;
    /** Optional callback fired exactly once per `readRecordBatch(i)` for tests. */
    onBatchLoad?: (batchIndex: number) => void;

    private readonly reader: any;
    private readonly fileHandle: FileHandle;
    /** Cache of loaded record batches so repeat reads of the same window
     *  don't re-decode. Keyed by batch index; bounded by entry count
     *  (decoded batches are typed-array-backed and modest in size). */
    private batchCache = new Map<number, any>();
    private static readonly BATCH_CACHE_MAX = 16;
    private latestViewportGen = 0;

    private constructor(reader: any, fileHandle: FileHandle, schema: ReaderSchema, nrow: number, batchStarts: Uint32Array) {
        this.reader = reader;
        this.fileHandle = fileHandle;
        this.schema = schema;
        this.nrow = nrow;
        this.batchStarts = batchStarts;
    }

    /**
     * Open a file and pre-index its batches.
     *
     * Throws if the file cannot be opened or the IPC footer can't be parsed.
     * The FileHandle is kept open for the lifetime of the reader; call
     * close() to release it. Files larger than the Node.js Buffer 2 GiB
     * limit are supported because the file is never fully loaded into memory.
     */
    static async open(filePath: string, opts: OpenOptions = {}): Promise<ArrowSliceReader> {
        const fh = await fsOpen(filePath, 'r');
        const reader = await (await (AsyncRecordBatchFileReader.from(fh) as any)).open();
        const threshold = opts.dictionaryThreshold ?? DEFAULT_DICTIONARY_THRESHOLD;

        // Pass 1: build batchStarts and pre-cache batches we need to count
        // dictionary cardinalities. We have to peek at one batch per
        // dictionary-encoded column to read its dictionary length, since
        // the schema alone doesn't reveal cardinality.
        const numBatches = reader.numRecordBatches;
        const starts: number[] = [0];
        let acc = 0;
        const firstBatch = numBatches > 0 ? await reader.readRecordBatch(0) : null;
        for (let i = 0; i < numBatches; i++) {
            const b = i === 0 ? firstBatch : await reader.readRecordBatch(i);
            acc += b.numRows;
            starts.push(acc);
        }
        const batchStarts = new Uint32Array(starts);
        const nrow = acc;

        // Schema-level "raven.fields" KV: a JSON map { columnName: { metaKey: metaValue } }.
        // R arrow's public API doesn't expose per-field metadata writes, so
        // the bootstrap profile encodes per-column metadata into this single
        // schema-level entry. Per-field Field.metadata (when present from
        // any non-R producer) takes precedence.
        const schemaMd: Map<string, string> | undefined = reader.schema.metadata;
        const ravenFieldsRaw = schemaMd?.get('raven.fields');
        const ravenFields: Record<string, Record<string, string>> =
            ravenFieldsRaw ? (safeParseJson(ravenFieldsRaw) ?? {}) : {};

        // Pass 2: build the schema, sampling first-batch dictionaries for
        // dict-encoded columns.
        const cols: ColumnSchema[] = reader.schema.fields.map((f: any) => {
            const md: Map<string, string> = f.metadata;
            const fieldMd = ravenFields[f.name] ?? {};
            const lookup = (key: string): string | undefined =>
                md.get(key) ?? fieldMd[key];
            const arrowType = String(f.type);
            const isDict = arrowType.startsWith('Dictionary');
            let dictLen = 0;
            let dictionary: string[] | undefined;
            if (isDict && firstBatch) {
                const child = firstBatch.getChild(f.name);
                const dict = (child as any).data?.[0]?.dictionary;
                dictLen = dict?.length ?? 0;
                if (dictLen <= threshold) {
                    dictionary = [];
                    for (let i = 0; i < dictLen; i++) dictionary.push(dict.get(i) as string);
                }
            }
            const variableLabel =
                lookup('raven.variable_label') ?? md.get('label') ?? undefined;
            const valueLabelsRaw = lookup('raven.value_labels');
            const valueLabels = valueLabelsRaw ? safeParseJson(valueLabelsRaw) : undefined;
            return {
                name: f.name,
                arrowType,
                originalClass: lookup('raven.original_class') ?? undefined,
                variableLabel,
                valueLabels,
                formatStata: lookup('raven.format') ?? undefined,
                dictionary,
                dictionaryShipped: isDict && dictLen <= threshold,
                isInteger: /^Int\d+$/.test(arrowType),
            };
        });

        return new ArrowSliceReader(
            reader,
            fh,
            { columns: cols },
            nrow,
            batchStarts,
        );
    }

    setLatestViewportGeneration(g: number): void {
        this.latestViewportGen = g;
    }

    async close(): Promise<void> {
        await this.fileHandle.close();
    }

    private async getBatch(i: number): Promise<any> {
        const cached = this.batchCache.get(i);
        if (cached) {
            // LRU touch.
            this.batchCache.delete(i);
            this.batchCache.set(i, cached);
            return cached;
        }
        const b = await this.reader.readRecordBatch(i);
        this.onBatchLoad?.(i);
        this.batchCache.set(i, b);
        while (this.batchCache.size > ArrowSliceReader.BATCH_CACHE_MAX) {
            const oldest = this.batchCache.keys().next().value as number;
            this.batchCache.delete(oldest);
        }
        return b;
    }

    async getRows(req: GetRowsRequest): Promise<GetRowsResponse> {
        if (req.viewportGeneration < this.latestViewportGen) {
            return { rows: [], stale: true };
        }
        const start = Math.max(0, req.start);
        const end = Math.min(this.nrow, req.end);
        if (end <= start) return { rows: [], stale: false };

        const fields = this.reader.schema.fields;
        const rowCount = end - start;
        const rows: Cell[][] = [];
        for (let r = 0; r < rowCount; r++) rows.push(new Array(req.columns.length));

        const startBatch = upperBoundLE(this.batchStarts, start);
        const endBatch = upperBoundLE(this.batchStarts, end - 1);

        for (let bi = startBatch; bi <= endBatch; bi++) {
            // Re-check generation between batches so a long decode aborts
            // promptly when the user keeps scrolling.
            if (req.viewportGeneration < this.latestViewportGen) {
                return { rows: [], stale: true };
            }
            const batch = await this.getBatch(bi);
            const batchRowStart = this.batchStarts[bi];
            const localLo = Math.max(0, start - batchRowStart);
            const localHi = Math.min(batch.numRows, end - batchRowStart);

            for (let ci = 0; ci < req.columns.length; ci++) {
                const colIdx = req.columns[ci];
                const field = fields[colIdx];
                const child = batch.getChildAt(colIdx);
                const arrowType = String(field.type);
                const tz = arrowType.startsWith('Timestamp')
                    ? ((field.type as any).timezone ?? 'UTC')
                    : 'UTC';
                for (let r = localLo; r < localHi; r++) {
                    const cell = encodeArrowCell(child, r, arrowType, tz);
                    rows[batchRowStart + r - start][ci] = cell;
                }
            }
        }
        return { rows, stale: false };
    }

    async getLabels(columnIndex: number, indices: number[]): Promise<Record<number, string>> {
        const field = this.reader.schema.fields[columnIndex];
        const out: Record<number, string> = {};
        // Any batch that has the column will share the same dictionary
        // (we don't currently support per-batch dictionary deltas).
        const batch = await this.getBatch(0);
        const child = batch.getChild(field.name);
        const dict = (child as any).data?.[0]?.dictionary;
        if (!dict) return out;
        for (const i of indices) {
            if (i >= 0 && i < dict.length) {
                out[i] = dict.get(i) as string;
            }
        }
        return out;
    }
}

function upperBoundLE(starts: Uint32Array, v: number): number {
    // Largest i such that starts[i] <= v. starts has length numBatches+1
    // where starts[numBatches] == nrow, so we ignore the trailing sentinel.
    let lo = 0;
    let hi = starts.length - 2;
    let ans = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= v) { ans = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    return ans;
}

function safeParseJson<T = any>(s: string): T | undefined {
    try { return JSON.parse(s) as T; } catch { return undefined; }
}

/** True iff the i-th cell of `data` is null. Arrow JS sometimes ships an
 *  empty nullBitmap (length 0) for all-valid columns; check the bitmap
 *  byte exists before reading the bit. */
function isNullAt(data: any, row: number): boolean {
    const bm = data.nullBitmap;
    if (!bm || bm.length === 0) return false;
    const byteIdx = row >> 3;
    if (byteIdx >= bm.length) return false;
    return ((bm[byteIdx] >> (row & 7)) & 1) === 0;
}

function encodeArrowCell(child: any, row: number, arrowType: string, tz: string): Cell {
    if (arrowType.startsWith('Dictionary')) {
        const data = child.data[0];
        if (isNullAt(data, row)) return null;
        return data.values[row] as number;
    }
    if (arrowType.startsWith('Int')) {
        return child.get(row) ?? null;
    }
    if (arrowType.startsWith('Float')) {
        const v = child.get(row);
        return encodeNumber(v as number | null);
    }
    if (arrowType === 'Bool') {
        const v = child.get(row);
        return v as boolean | null;
    }
    if (arrowType === 'Utf8' || arrowType === 'LargeUtf8') {
        return encodeString(child.get(row) as string | null);
    }
    if (arrowType.startsWith('Date')) {
        const data = child.data[0];
        if (isNullAt(data, row)) return null;
        return encodeDate(data.values[row] as number);
    }
    if (arrowType.startsWith('Timestamp')) {
        const data = child.data[0];
        if (isNullAt(data, row)) return null;
        return encodeTimestampMicros(data.values[row] as bigint, tz);
    }
    // Fallback: stringify.
    const v = child.get(row);
    return v === null || v === undefined ? null : encodeString(String(v));
}
