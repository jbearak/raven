/**
 * ArrowSliceReader — opens one Apache Arrow IPC (file format) file and
 * serves row windows, column scans, and per-column null counts on demand.
 *
 * Loading model. The file is opened as a FileHandle. apache-arrow's
 * AsyncRecordBatchFileReader reads the footer, the schema, and the
 * dictionary batches at `open()`; nothing else is read up front. Record
 * batch data is then read **per column** straight from the file (see
 * `arrow-ipc.ts` for framing and header parsing):
 *
 *   - **Batch geometry** comes from the writer's `raven.nrow` and
 *     `raven.chunk_rows` schema metadata: batch starts are arithmetic,
 *     verified by the footer's block count (`ceil(nrow / chunk_rows)`)
 *     and the last batch's header length. The writer never emits a batch
 *     longer than `chunk_rows`, so with those two checks every earlier
 *     batch is exactly `chunk_rows` long. When the metadata is missing or
 *     a check fails, every batch header is parsed for its exact length;
 *     only if that fails are batches decoded to count rows.
 *   - **Unsorted windows and scans** use projected chunk reads: only the
 *     buffers of the requested columns are read, coalesced, and rebuilt
 *     with `makeData`. Viewport chunks go through a byte-bounded LRU keyed
 *     by (batch, column); scans (sort, filter, histogram) bypass it so a
 *     full-column pass never evicts the viewport.
 *   - **Permuted windows** (sorted or filtered) gather individual
 *     elements: rows are grouped by batch, and each value and validity
 *     bit is read at its computed offset with synchronous `readSync`
 *     (page-cache hits; a libuv round trip per read would dominate). The
 *     validity read is skipped when the batch header reports
 *     `null_count == 0` for that column, and reads within 4 KiB of each
 *     other are coalesced. Column types the gather doesn't decode fall
 *     back to a projected chunk read for that column.
 *   - **Null counts** ({@link ArrowSliceReader.nullCounts}) sum each
 *     batch header's `FieldNode.null_count`, without reading any data.
 *     They are never computed on the open path.
 *   - **Dictionaries** come from the dictionary batches the arrow reader
 *     loads at open, never from decoding batch 0.
 *
 * Files the projected path can't serve (nested types, delta or repeated
 * dictionary batches, compressed bodies) fall back to whole-batch decoding
 * through `readRecordBatch`. The R writer emits none of those; the spike
 * test (`tests/bun/data-viewer-arrow-projected-spike.test.ts`) pins that,
 * along with every apache-arrow 21.1.0 API this module relies on.
 *
 * Every cell this reader returns is identical to what decoding the whole
 * batch and calling `encodeArrowCell` would produce; the reader tests
 * compare the two paths cell by cell.
 *
 * Call close() when done to release the underlying FileHandle.
 */

import { open as fsOpen } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { readSync } from 'node:fs';
import { AsyncRecordBatchFileReader, makeData, makeVector, Type } from 'apache-arrow';
import type { DataType } from 'apache-arrow';
import {
    encodeNumber,
    encodeString,
    encodeDate,
    encodeTimestampMicros,
    TRUNC_LIMIT_BYTES,
} from './wire-format';
import type { Cell } from './wire-format';
import { formatDeclaresInteger } from './format-string';
import {
    addNullCounts,
    assignGroup,
    buildColumnLayouts,
    coalescedReadSync,
    parseRecordBatchHeader,
    planCoalescedReads,
    recordBatchLength,
} from './arrow-ipc';
import type { ColumnLayout, FileBlock, ParsedHeader, ReadRequest } from './arrow-ipc';
import { ByteLru } from './byte-lru';
import { throwIfAborted } from './abort';

/** Default cardinality threshold above which a dictionary is not shipped
 *  in the init/replace message. The webview must request labels on demand
 *  via getLabels for those columns. */
export const DEFAULT_DICTIONARY_THRESHOLD = 100_000;

/** Default byte budget for cached projected column chunks. */
export const DEFAULT_CHUNK_CACHE_BYTES = 128 * 1024 * 1024;
/** Default byte budget for parsed record-batch headers. */
export const DEFAULT_HEADER_CACHE_BYTES = 32 * 1024 * 1024;
/** Element-gather reads closer than this are merged into one read. */
export const GATHER_COALESCE_GAP = 4096;
/** Projected chunk reads of adjacent buffers closer than this are merged. */
const CHUNK_COALESCE_GAP = 64 * 1024;

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
    /** Source-file format string (Stata %w.dC, SAS/SPSS F8.0, etc.).
     *  Used to detect integer-display Float columns so Format doesn't
     *  render "5" as "5.000". See format-string.ts. */
    format?: string;
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
    /** Optional half-open range of positions in `columns` the caller needs
     *  now (e.g. the horizontally visible ones). When present, only those
     *  columns are read and each returned row has `end - start` cells,
     *  in `columns` order. */
    columnRange?: { start: number; end: number };
    /** Latest viewport generation seen by the panel. Older requests are
     *  skipped (returned with `stale: true`). */
    viewportGeneration: number;
    /** Optional row permutation. When present, `start..end` indexes into
     *  the permutation; the reader fetches the underlying rows
     *  `permutation[start..end]` and returns them in visible order. */
    permutation?: Uint32Array;
};

export type GetRowsResponse = {
    /** Outer length = end - start (clamped). Inner length = number of
     *  columns served (`columns.length`, or the `columnRange` width). */
    rows: Cell[][];
    stale: boolean;
    /** When a permutation was supplied, the original 0-based row indices
     *  for each row in `rows` (length matches `rows`). Lets the webview
     *  render the original row number in the gutter. */
    originalRowIndices?: number[];
};

export type OpenOptions = {
    dictionaryThreshold?: number;
    /** Byte budget for the viewport chunk cache. */
    chunkCacheBytes?: number;
    /** Byte budget for the parsed-header cache. */
    headerCacheBytes?: number;
};

/** How the reader derived batch row ranges at open. */
export type GeometrySource = 'metadata' | 'headers' | 'decoded';

/** A record batch restricted to some columns, as handed to full-column
 *  scans by `batch-iter.ts`. `getChildAt` throws for a column that
 *  wasn't requested. */
export type ScanBatch = {
    numRows: number;
    getChildAt(columnIndex: number): any;
};

export type NullCountOptions = {
    /** Called after each batch header with the running per-column sums. */
    onProgress?: (batchesDone: number, batchesTotal: number, counts: Float64Array) => void;
    signal?: AbortSignal;
};

/** How a column's cells are decoded by the element gather. `null` means
 *  "not gatherable": the gather reads a projected chunk instead. */
type GatherKind =
    | { k: 'int'; width: 1 | 2 | 4 | 8 }
    | { k: 'float'; width: 4 | 8 }
    | { k: 'bool' }
    | { k: 'utf8'; large: boolean }
    | { k: 'dict'; width: 1 | 2 | 4 | 8; signed: boolean }
    | { k: 'date32' }
    | { k: 'ts' }
    | null;

type ColumnInfo = {
    type: DataType;
    arrowType: string;
    tz: string;
    layout: ColumnLayout;
    gather: GatherKind;
    dictionary: any;
};

export class ArrowSliceReader {
    readonly schema: ReaderSchema;
    readonly nrow: number;
    readonly batchStarts: Uint32Array;
    /** How `batchStarts` was derived (see the module doc). */
    readonly geometrySource: GeometrySource;
    /** False when the file needs whole-batch decoding (see the module doc). */
    readonly projectable: boolean;
    /** Optional callback fired once per batch read from disk by a
     *  viewport or scan read (tests). */
    onBatchLoad?: (batchIndex: number) => void;

    private readonly reader: any;
    private readonly fileHandle: FileHandle;
    private readonly blocks: FileBlock[];
    private readonly cols: ColumnInfo[];
    private readonly headerCache: ByteLru<number, ParsedHeader>;
    private readonly chunkCache: ByteLru<string, any>;
    /** Whole decoded batches, used only when `projectable` is false.
     *  Byte-bounded like the chunk cache (same budget): a decoded batch's
     *  size varies with frame width and string content. */
    private readonly wholeBatchCache: ByteLru<number, any>;
    private readonly utf8 = new TextDecoder('utf-8');
    private latestViewportGen = 0;
    private closed = false;

    private constructor(init: {
        reader: any;
        fileHandle: FileHandle;
        schema: ReaderSchema;
        nrow: number;
        batchStarts: Uint32Array;
        geometrySource: GeometrySource;
        projectable: boolean;
        blocks: FileBlock[];
        cols: ColumnInfo[];
        headerCache: ByteLru<number, ParsedHeader>;
        chunkCacheBytes: number;
    }) {
        this.reader = init.reader;
        this.fileHandle = init.fileHandle;
        this.schema = init.schema;
        this.nrow = init.nrow;
        this.batchStarts = init.batchStarts;
        this.geometrySource = init.geometrySource;
        this.projectable = init.projectable;
        this.blocks = init.blocks;
        this.cols = init.cols;
        this.headerCache = init.headerCache;
        this.chunkCache = new ByteLru(init.chunkCacheBytes);
        this.wholeBatchCache = new ByteLru(init.chunkCacheBytes);
    }

    /**
     * Open a file and derive its batch geometry (see the module doc).
     *
     * Throws if the file cannot be opened or the IPC footer can't be parsed.
     * The FileHandle is kept open for the lifetime of the reader; call
     * close() to release it. Files larger than the Node.js Buffer 2 GiB
     * limit are supported because the file is never fully loaded into memory.
     */
    static async open(filePath: string, opts: OpenOptions = {}): Promise<ArrowSliceReader> {
        const fh = await fsOpen(filePath, 'r');
        try {
            const reader = await (await (AsyncRecordBatchFileReader.from(fh) as any)).open();
            const threshold = opts.dictionaryThreshold ?? DEFAULT_DICTIONARY_THRESHOLD;
            const fields: any[] = reader.schema.fields;
            const types: DataType[] = fields.map(f => f.type);
            const layouts = buildColumnLayouts(types);
            const blocks: FileBlock[] = [...reader.footer.recordBatches()].map((b: any) => ({
                offset: Number(b.offset),
                metaDataLength: Number(b.metaDataLength),
                bodyLength: Number(b.bodyLength),
            }));
            const dictionaries: Map<number, any> = reader.dictionaries;

            // One dictionary batch per dictionary-encoded field (no deltas, no
            // replacements) is what makes the loaded dictionary valid for
            // every batch.
            const dictIds = new Set<number>();
            for (const t of types) if (t.typeId === Type.Dictionary) dictIds.add((t as any).id);
            const singleDictionaries = reader.footer.numDictionaries === dictIds.size;
            const headerCache = new ByteLru<number, ParsedHeader>(
                opts.headerCacheBytes ?? DEFAULT_HEADER_CACHE_BYTES,
            );

            const schemaMd: Map<string, string> | undefined = reader.schema.metadata;
            const geometry = await ArrowSliceReader.deriveGeometry(
                reader, fh.fd, blocks, schemaMd, headerCache,
            );
            const projectable = layouts.every(l => l.flat)
                && singleDictionaries
                && !geometry.compressed;

            // Schema-level "raven.fields" KV: a JSON map { columnName: { metaKey: metaValue } }.
            // R arrow's public API doesn't expose per-field metadata writes, so
            // the bootstrap profile encodes per-column metadata into this single
            // schema-level entry. Per-field Field.metadata (when present from
            // any non-R producer) takes precedence.
            const ravenFieldsRaw = schemaMd?.get('raven.fields');
            const ravenFields: Record<string, Record<string, string>> =
                ravenFieldsRaw ? (safeParseJson(ravenFieldsRaw) ?? {}) : {};

            const cols: ColumnInfo[] = [];
            const schemaCols: ColumnSchema[] = fields.map((f: any, i: number) => {
                const md: Map<string, string> = f.metadata;
                const fieldMd = ravenFields[f.name] ?? {};
                const lookup = (key: string): string | undefined =>
                    md.get(key) ?? fieldMd[key];
                const arrowType = String(f.type);
                const isDict = f.type.typeId === Type.Dictionary;
                const dict = isDict ? dictionaries.get(f.type.id) : undefined;
                const dictLen: number = dict?.length ?? 0;
                let dictionary: string[] | undefined;
                if (isDict && dictLen <= threshold) {
                    dictionary = [];
                    for (let d = 0; d < dictLen; d++) dictionary.push(dict.get(d) as string);
                }
                cols.push({
                    type: f.type,
                    arrowType,
                    tz: arrowType.startsWith('Timestamp')
                        ? ((f.type as any).timezone ?? 'UTC')
                        : 'UTC',
                    layout: layouts[i],
                    gather: gatherKindFor(f.type, arrowType),
                    dictionary: dict,
                });
                const variableLabel =
                    lookup('raven.variable_label') ?? md.get('label') ?? undefined;
                const valueLabelsRaw = lookup('raven.value_labels');
                const valueLabels = valueLabelsRaw ? safeParseJson(valueLabelsRaw) : undefined;
                const format = lookup('raven.format') ?? undefined;
                const isIntType = /^Int\d+$/.test(arrowType);
                const isFloatIntFormatted =
                    arrowType.startsWith('Float') && formatDeclaresInteger(format);
                return {
                    name: f.name,
                    arrowType,
                    originalClass: lookup('raven.original_class') ?? undefined,
                    variableLabel,
                    valueLabels,
                    format,
                    dictionary,
                    dictionaryShipped: isDict && dictLen <= threshold,
                    isInteger: isIntType || isFloatIntFormatted,
                };
            });

            return new ArrowSliceReader({
                reader,
                fileHandle: fh,
                schema: { columns: schemaCols },
                nrow: geometry.nrow,
                batchStarts: geometry.batchStarts,
                geometrySource: geometry.source,
                projectable,
                blocks,
                cols,
                headerCache,
                chunkCacheBytes: opts.chunkCacheBytes ?? DEFAULT_CHUNK_CACHE_BYTES,
            });
        } catch (err) {
            // Ownership of fh only transfers when construction succeeds; on any
            // failure between fsOpen and the new ArrowSliceReader, close it here.
            await fh.close().catch(() => undefined);
            throw err;
        }
    }

    /** Batch geometry, cheapest source first (see the module doc). */
    private static async deriveGeometry(
        reader: any,
        fd: number,
        blocks: FileBlock[],
        md: Map<string, string> | undefined,
        headerCache: ByteLru<number, ParsedHeader>,
    ): Promise<{ nrow: number; batchStarts: Uint32Array; source: GeometrySource; compressed: boolean }> {
        const n = blocks.length;
        const mdNrow = parseCount(md?.get('raven.nrow'));
        const mdChunk = parseCount(md?.get('raven.chunk_rows'));
        if (mdNrow !== undefined && mdChunk !== undefined && mdChunk > 0 && mdNrow > 0
            && n === Math.ceil(mdNrow / mdChunk)) {
            try {
                const last = parseRecordBatchHeader(readPrefixSync(fd, blocks[n - 1]), blocks[n - 1]);
                if (last.length === mdNrow - (n - 1) * mdChunk) {
                    headerCache.set(n - 1, last, last.bytes);
                    const starts = new Uint32Array(n + 1);
                    for (let i = 0; i < n; i++) starts[i] = i * mdChunk;
                    starts[n] = mdNrow;
                    return { nrow: mdNrow, batchStarts: starts, source: 'metadata', compressed: last.compressed };
                }
            } catch {
                // Fall through to per-header parsing.
            }
        }
        try {
            const starts = new Uint32Array(n + 1);
            let acc = 0;
            let compressed = false;
            for (let i = 0; i < n; i++) {
                const h = parseRecordBatchHeader(readPrefixSync(fd, blocks[i]), blocks[i]);
                headerCache.set(i, h, h.bytes);
                compressed ||= h.compressed;
                acc += h.length;
                starts[i + 1] = acc;
            }
            return { nrow: acc, batchStarts: starts, source: 'headers', compressed };
        } catch {
            // Last resort: decode every batch to count its rows.
            const starts = new Uint32Array(n + 1);
            let acc = 0;
            for (let i = 0; i < n; i++) {
                const b = await reader.readRecordBatch(i);
                acc += b.numRows;
                starts[i + 1] = acc;
            }
            return { nrow: acc, batchStarts: starts, source: 'decoded', compressed: true };
        }
    }

    setLatestViewportGeneration(g: number): void {
        this.latestViewportGen = g;
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.chunkCache.clear();
        this.headerCache.clear();
        this.wholeBatchCache.clear();
        await this.fileHandle.close();
    }

    /** Bytes currently held by the viewport chunk cache (tests, bench). */
    get chunkCacheBytes(): number { return this.chunkCache.bytes; }
    get wholeBatchCacheBytes(): number { return this.wholeBatchCache.bytes; }

    /** The loaded dictionary (an arrow Vector) for a dictionary-encoded
     *  column, or undefined. */
    dictionaryVector(columnIndex: number): any {
        return this.cols[columnIndex]?.dictionary;
    }

    /**
     * Exact per-column NA counts, summed from every record batch header's
     * `FieldNode.null_count`. Reads only headers (never data), reading the
     * FieldNode structs in place. Not part of `open()`; callers run it
     * after first paint. `onProgress` sees the running sums after each
     * batch; `signal` aborts between batches.
     */
    async nullCounts(opts: NullCountOptions = {}): Promise<Float64Array> {
        const counts = new Float64Array(this.cols.length);
        const layouts = this.cols.map(c => c.layout);
        const total = this.blocks.length;
        for (let i = 0; i < total; i++) {
            throwIfAborted(opts.signal);
            const cached = this.headerCache.get(i);
            if (cached) {
                for (let c = 0; c < layouts.length; c++) {
                    counts[c] += cached.nodeNullCount[layouts[c].nodeIndex] ?? 0;
                }
            } else {
                addNullCounts(await this.readPrefix(i), layouts, counts);
            }
            opts.onProgress?.(i + 1, total, counts);
        }
        return counts;
    }

    async getRows(req: GetRowsRequest): Promise<GetRowsResponse> {
        if (req.viewportGeneration < this.latestViewportGen) {
            return { rows: [], stale: true };
        }
        const start = Math.max(0, req.start);
        // When a permutation is supplied, clamp to its length (not this.nrow)
        // so a stale request that arrived with the pre-filter row count never
        // reads past the end of the permutation.
        const end = Math.min(req.permutation ? req.permutation.length : this.nrow, req.end);
        if (end <= start) return { rows: [], stale: false };
        const columns = req.columnRange
            ? req.columns.slice(Math.max(0, req.columnRange.start), Math.max(0, req.columnRange.end))
            : req.columns;

        if (req.permutation) {
            return this.getRowsPermuted(req, columns, start, end);
        }

        const rowCount = end - start;
        const rows: Cell[][] = [];
        for (let r = 0; r < rowCount; r++) rows.push(new Array(columns.length));

        const startBatch = upperBoundLE(this.batchStarts, start);
        const endBatch = upperBoundLE(this.batchStarts, end - 1);

        for (let bi = startBatch; bi <= endBatch; bi++) {
            // Re-check generation between batches so a long read aborts
            // promptly when the user keeps scrolling.
            if (req.viewportGeneration < this.latestViewportGen) {
                return { rows: [], stale: true };
            }
            const chunks = await this.viewportChunks(bi, columns);
            const batchRowStart = this.batchStarts[bi];
            const batchRows = this.batchStarts[bi + 1] - batchRowStart;
            const localLo = Math.max(0, start - batchRowStart);
            const localHi = Math.min(batchRows, end - batchRowStart);
            for (let ci = 0; ci < columns.length; ci++) {
                const info = this.cols[columns[ci]];
                const child = chunks[ci];
                for (let r = localLo; r < localHi; r++) {
                    rows[batchRowStart + r - start][ci] = encodeArrowCell(child, r, info.arrowType, info.tz);
                }
            }
        }
        return { rows, stale: false };
    }

    /** Permuted variant: `start..end` indexes into `req.permutation`, and
     *  we read the underlying rows it points at — in any order — but
     *  return them in visible (sorted) order. */
    private async getRowsPermuted(
        req: GetRowsRequest,
        columns: number[],
        start: number,
        end: number,
    ): Promise<GetRowsResponse> {
        const permutation = req.permutation!;
        const visibleCount = end - start;
        const originalRowIndices: number[] = new Array(visibleCount);
        for (let i = 0; i < visibleCount; i++) {
            originalRowIndices[i] = permutation[start + i];
        }
        const rows: Cell[][] = new Array(visibleCount);
        for (let i = 0; i < visibleCount; i++) rows[i] = new Array(columns.length);

        // Group requested rows by their containing batch, in ascending
        // batch order.
        const byBatch = new Map<number, { local: number[]; out: number[] }>();
        for (let i = 0; i < visibleCount; i++) {
            const rawRow = originalRowIndices[i];
            const bi = upperBoundLE(this.batchStarts, rawRow);
            let g = byBatch.get(bi);
            if (!g) { g = { local: [], out: [] }; byBatch.set(bi, g); }
            g.local.push(rawRow - this.batchStarts[bi]);
            g.out.push(i);
        }
        const batchIndices = [...byBatch.keys()].sort((a, b) => a - b);

        if (!this.projectable) {
            for (const bi of batchIndices) {
                if (req.viewportGeneration < this.latestViewportGen) {
                    return { rows: [], stale: true };
                }
                const chunks = await this.viewportChunks(bi, columns);
                this.encodeFromChunks(byBatch.get(bi)!, columns, chunks, rows);
            }
            return { rows, stale: false, originalRowIndices };
        }

        // Columns the gather can decode, and the ones that need a chunk.
        const gatherCols: number[] = [];
        const chunkCols: number[] = [];
        for (let ci = 0; ci < columns.length; ci++) {
            (this.cols[columns[ci]].gather ? gatherCols : chunkCols).push(ci);
        }
        if (gatherCols.length > 0) {
            this.gather(batchIndices, byBatch, columns, gatherCols, rows);
        }
        for (const bi of batchIndices) {
            if (chunkCols.length === 0) break;
            if (req.viewportGeneration < this.latestViewportGen) {
                return { rows: [], stale: true };
            }
            const sub = chunkCols.map(ci => columns[ci]);
            const chunks = await this.viewportChunks(bi, sub);
            const g = byBatch.get(bi)!;
            for (let k = 0; k < chunkCols.length; k++) {
                const ci = chunkCols[k];
                const info = this.cols[columns[ci]];
                for (let j = 0; j < g.local.length; j++) {
                    rows[g.out[j]][ci] = encodeArrowCell(chunks[k], g.local[j], info.arrowType, info.tz);
                }
            }
        }
        return { rows, stale: false, originalRowIndices };
    }

    private encodeFromChunks(
        g: { local: number[]; out: number[] },
        columns: number[],
        chunks: any[],
        rows: Cell[][],
    ): void {
        for (let ci = 0; ci < columns.length; ci++) {
            const info = this.cols[columns[ci]];
            for (let j = 0; j < g.local.length; j++) {
                rows[g.out[j]][ci] = encodeArrowCell(chunks[ci], g.local[j], info.arrowType, info.tz);
            }
        }
    }

    /**
     * Element gather for permuted windows (see the module doc). Fills
     * `rows[out][ci]` for every gatherable column position `ci`. Two read
     * phases: validity bits, fixed-width values and string offset pairs,
     * then string bytes. Each phase is one coalesced set of `readSync`s.
     */
    private gather(
        batchIndices: number[],
        byBatch: Map<number, { local: number[]; out: number[] }>,
        columns: number[],
        gatherCols: number[],
        rows: Cell[][],
    ): void {
        type Elem = {
            out: number;
            ci: number;
            info: ColumnInfo;
            local: number;
            validity?: ReadRequest;
            value: ReadRequest;
            bytes?: ReadRequest;
            dataPos: number;
        };
        const elems: Elem[] = [];
        const phase1: ReadRequest[] = [];
        for (const bi of batchIndices) {
            const h = this.headerSync(bi);
            const g = byBatch.get(bi)!;
            this.onBatchLoad?.(bi);
            for (const ci of gatherCols) {
                const info = this.cols[columns[ci]];
                const kind = info.gather!;
                const { nodeIndex, bufferIndex } = info.layout;
                const vBuf = bufferIndex;
                const dBuf = bufferIndex + 1;
                const hasValidity = h.nodeNullCount[nodeIndex] > 0 && h.bufferLength[vBuf] > 0;
                const vBase = h.bodyOffset + h.bufferOffset[vBuf];
                const dBase = h.bodyOffset + h.bufferOffset[dBuf];
                const strData = kind.k === 'utf8' ? h.bodyOffset + h.bufferOffset[bufferIndex + 2] : 0;
                for (let j = 0; j < g.local.length; j++) {
                    const r = g.local[j];
                    let value: ReadRequest;
                    switch (kind.k) {
                        case 'bool': value = { pos: dBase + (r >> 3), len: 1 }; break;
                        case 'utf8': value = kind.large
                            ? { pos: dBase + r * 8, len: 16 }
                            : { pos: dBase + r * 4, len: 8 };
                            break;
                        case 'date32': value = { pos: dBase + r * 4, len: 4 }; break;
                        case 'ts': value = { pos: dBase + r * 8, len: 8 }; break;
                        default: value = { pos: dBase + r * kind.width, len: kind.width };
                    }
                    const e: Elem = { out: g.out[j], ci, info, local: r, value, dataPos: strData };
                    phase1.push(value);
                    if (hasValidity) {
                        e.validity = { pos: vBase + (r >> 3), len: 1 };
                        phase1.push(e.validity);
                    }
                    elems.push(e);
                }
            }
        }
        const read = (buf: Uint8Array, pos: number) =>
            readSync(this.fileHandle.fd, buf, 0, buf.length, pos);
        coalescedReadSync(read, phase1, GATHER_COALESCE_GAP);

        // Phase 2: string bytes, capped at what encodeString can show
        // (it truncates to TRUNC_LIMIT_BYTES; +4 keeps the cut identical).
        const phase2: ReadRequest[] = [];
        for (const e of elems) {
            if (e.info.gather!.k !== 'utf8' || isNullElem(e)) continue;
            const dv = viewOf(e.value);
            const large = (e.info.gather as { large: boolean }).large;
            const o0 = large ? Number(dv.getBigInt64(0, true)) : dv.getInt32(0, true);
            const o1 = large ? Number(dv.getBigInt64(8, true)) : dv.getInt32(4, true);
            const len = Math.min(o1 - o0, TRUNC_LIMIT_BYTES + 4);
            if (len <= 0) continue;
            e.bytes = { pos: e.dataPos + o0, len };
            phase2.push(e.bytes);
        }
        coalescedReadSync(read, phase2, GATHER_COALESCE_GAP);

        for (const e of elems) {
            rows[e.out][e.ci] = isNullElem(e) ? null : this.decodeElem(e);
        }

        function isNullElem(e: Elem): boolean {
            if (!e.validity) return false;
            return ((e.validity.buf![e.validity.at!] >> (e.local & 7)) & 1) === 0;
        }
    }

    private decodeElem(e: { info: ColumnInfo; local: number; value: ReadRequest; bytes?: ReadRequest }): Cell {
        const kind = e.info.gather!;
        const dv = viewOf(e.value);
        switch (kind.k) {
            case 'int':
                switch (kind.width) {
                    case 1: return dv.getInt8(0);
                    case 2: return dv.getInt16(0, true);
                    case 4: return dv.getInt32(0, true);
                    case 8: return Number(dv.getBigInt64(0, true));
                }
                break;
            case 'float':
                return encodeNumber(kind.width === 8 ? dv.getFloat64(0, true) : dv.getFloat32(0, true));
            case 'bool':
                return ((dv.getUint8(0) >> (e.local & 7)) & 1) === 1;
            case 'utf8': {
                const b = e.bytes;
                const s = b ? this.utf8.decode(b.buf!.subarray(b.at!, b.at! + b.len)) : '';
                return encodeString(s);
            }
            case 'dict':
                switch (kind.width) {
                    case 1: return kind.signed ? dv.getInt8(0) : dv.getUint8(0);
                    case 2: return kind.signed ? dv.getInt16(0, true) : dv.getUint16(0, true);
                    case 4: return kind.signed ? dv.getInt32(0, true) : dv.getUint32(0, true);
                    case 8: return Number(kind.signed ? dv.getBigInt64(0, true) : dv.getBigUint64(0, true));
                }
                break;
            case 'date32':
                return encodeDate(dv.getInt32(0, true));
            case 'ts':
                return encodeTimestampMicros(dv.getBigInt64(0, true), e.info.tz);
        }
        return null;
    }

    /** Projected chunks (one arrow Vector per entry of `columns`) for a
     *  viewport read, through the chunk LRU. */
    private async viewportChunks(bi: number, columns: readonly number[]): Promise<any[]> {
        if (!this.projectable) {
            const batch = await this.wholeBatch(bi);
            return columns.map(c => batch.getChildAt(c));
        }
        const out: any[] = new Array(columns.length);
        const missing: number[] = [];
        for (let i = 0; i < columns.length; i++) {
            const hit = this.chunkCache.get(chunkKey(bi, columns[i]));
            if (hit) out[i] = hit;
            else if (!missing.includes(columns[i])) missing.push(columns[i]);
        }
        if (missing.length > 0) {
            this.onBatchLoad?.(bi);
            const read = await this.readColumns(bi, missing, true);
            for (const [c, { vector, bytes }] of read) {
                this.chunkCache.set(chunkKey(bi, c), vector, bytes);
            }
            for (let i = 0; i < columns.length; i++) {
                out[i] ??= read.get(columns[i])!.vector;
            }
        }
        return out;
    }

    /**
     * Read the buffers of `columns` in batch `bi` and rebuild each as an
     * arrow Vector over the loaded dictionary. With `copy`, every column
     * gets its own backing memory so the chunk cache's byte accounting
     * holds (a merged read would otherwise keep its neighbours alive).
     */
    private async readColumns(
        bi: number,
        columns: readonly number[],
        copy: boolean,
    ): Promise<Map<number, { vector: any; bytes: number }>> {
        const h = this.headerSync(bi);
        const requests: { col: number; bufs: (ReadRequest | undefined)[] }[] = [];
        const all: ReadRequest[] = [];
        for (const c of columns) {
            const { nodeIndex, bufferIndex, bufferCount } = this.cols[c].layout;
            const hasNulls = h.nodeNullCount[nodeIndex] > 0;
            const bufs: (ReadRequest | undefined)[] = [];
            for (let k = 0; k < bufferCount; k++) {
                const len = h.bufferLength[bufferIndex + k];
                if (len === 0 || (k === 0 && !hasNulls)) { bufs.push(undefined); continue; }
                const req: ReadRequest = { pos: h.bodyOffset + h.bufferOffset[bufferIndex + k], len };
                bufs.push(req);
                all.push(req);
            }
            requests.push({ col: c, bufs });
        }
        const groups = planCoalescedReads(all, CHUNK_COALESCE_GAP);
        await Promise.all(groups.map(async g => {
            const buf = new Uint8Array(g.end - g.start);
            let got = 0;
            while (got < buf.length) {
                const { bytesRead } = await this.fileHandle.read(buf, got, buf.length - got, g.start + got);
                if (bytesRead <= 0) throw new Error('arrow-reader: short read');
                got += bytesRead;
            }
            assignGroup(g, buf);
        }));
        const out = new Map<number, { vector: any; bytes: number }>();
        for (const { col, bufs } of requests) {
            const info = this.cols[col];
            const { nodeIndex } = info.layout;
            let bytes = 0;
            const views = bufs.map(r => {
                if (!r) return new Uint8Array(0);
                bytes += r.len;
                const v = r.buf!.subarray(r.at!, r.at! + r.len);
                return copy && v.length !== r.buf!.length ? v.slice() : v;
            });
            const data = buildData(
                info.type,
                h.nodeLength[nodeIndex],
                h.nodeNullCount[nodeIndex],
                views,
                info.dictionary,
            );
            out.set(col, { vector: makeVector(data), bytes: bytes + 64 });
        }
        return out;
    }

    /** Whole-batch decode, for files the projected path can't serve. */
    private async wholeBatch(bi: number): Promise<any> {
        const cached = this.wholeBatchCache.get(bi);
        if (cached) return cached;
        const b = await this.reader.readRecordBatch(bi);
        this.onBatchLoad?.(bi);
        this.wholeBatchCache.set(bi, b, b.data.byteLength);
        return b;
    }

    /**
     * One batch restricted to `columns` (all columns when omitted), for
     * full-column scans via `batch-iter.ts`. Bypasses the chunk cache so a
     * scan never evicts the viewport.
     */
    private async getBatch(i: number, columns?: readonly number[]): Promise<ScanBatch> {
        if (!this.projectable) {
            const b = await this.reader.readRecordBatch(i);
            this.onBatchLoad?.(i);
            return b;
        }
        const cols = columns ?? this.cols.map((_, c) => c);
        const read = await this.readColumns(i, cols, false);
        this.onBatchLoad?.(i);
        const numRows = this.batchStarts[i + 1] - this.batchStarts[i];
        return {
            numRows,
            getChildAt(c: number) {
                const v = read.get(c);
                if (!v) throw new Error(`ScanBatch: column ${c} was not read`);
                return v.vector;
            },
        };
    }

    /** Parsed header for batch `bi`, through the header LRU. */
    private headerSync(bi: number): ParsedHeader {
        const hit = this.headerCache.get(bi);
        if (hit) return hit;
        const block = this.blocks[bi];
        const h = parseRecordBatchHeader(readPrefixSync(this.fileHandle.fd, block), block);
        if (h.compressed) throw new Error('arrow-reader: compressed record batch');
        this.headerCache.set(bi, h, h.bytes);
        return h;
    }

    private async readPrefix(bi: number): Promise<Uint8Array> {
        const block = this.blocks[bi];
        const buf = new Uint8Array(block.metaDataLength);
        const { bytesRead } = await this.fileHandle.read(buf, 0, buf.length, block.offset);
        if (bytesRead !== buf.length) throw new Error('arrow-reader: short header read');
        return buf;
    }

    async getLabels(columnIndex: number, indices: number[]): Promise<Record<number, string>> {
        const out: Record<number, string> = {};
        // One dictionary per field (no deltas): the reader loaded it at open.
        const dict = this.cols[columnIndex]?.dictionary;
        if (!dict) return out;
        for (const i of indices) {
            if (i >= 0 && i < dict.length) {
                out[i] = dict.get(i) as string;
            }
        }
        return out;
    }
}

function chunkKey(bi: number, col: number): string {
    return `${bi}:${col}`;
}

function viewOf(r: ReadRequest): DataView {
    return new DataView(r.buf!.buffer, r.buf!.byteOffset + r.at!, r.len);
}

function readPrefixSync(fd: number, block: FileBlock): Uint8Array {
    const buf = new Uint8Array(block.metaDataLength);
    let got = 0;
    while (got < buf.length) {
        const n = readSync(fd, buf, got, buf.length - got, block.offset + got);
        if (n <= 0) throw new Error('arrow-reader: short header read');
        got += n;
    }
    return buf;
}

/** Rebuild one column's Data from its buffers (validity, then values;
 *  var-width types have offsets before values). */
function buildData(
    type: DataType,
    length: number,
    nullCount: number,
    bufs: Uint8Array[],
    dictionary: any,
): any {
    const nullBitmap = nullCount > 0 ? bufs[0] : new Uint8Array(0);
    switch (type.typeId) {
        case Type.Null:
            return makeData({ type: type as any, length });
        case Type.Dictionary:
            return makeData({ type: type as any, length, nullCount, nullBitmap, data: bufs[1], dictionary });
        case Type.Utf8:
        case Type.LargeUtf8:
        case Type.Binary:
        case Type.LargeBinary:
            return makeData({
                type: type as any, length, nullCount, nullBitmap,
                valueOffsets: bufs[1] as any, data: bufs[2],
            });
        default:
            return makeData({ type: type as any, length, nullCount, nullBitmap, data: bufs[1] as any });
    }
}

/** Which gather decoder serves a column, mirroring `encodeArrowCell`'s
 *  type dispatch so both paths produce identical cells. */
function gatherKindFor(type: any, arrowType: string): GatherKind {
    if (type.typeId === Type.Dictionary) {
        const idx = type.indices;
        return { k: 'dict', width: (idx.bitWidth / 8) as 1 | 2 | 4 | 8, signed: !!idx.isSigned };
    }
    if (/^Int(8|16|32|64)$/.test(arrowType)) {
        return { k: 'int', width: (type.bitWidth / 8) as 1 | 2 | 4 | 8 };
    }
    if (arrowType === 'Float64') return { k: 'float', width: 8 };
    if (arrowType === 'Float32') return { k: 'float', width: 4 };
    if (arrowType === 'Bool') return { k: 'bool' };
    if (arrowType === 'Utf8') return { k: 'utf8', large: false };
    if (arrowType === 'LargeUtf8') return { k: 'utf8', large: true };
    if (type.typeId === Type.Date && type.unit === 0 /* DateUnit.DAY */) return { k: 'date32' };
    if (type.typeId === Type.Timestamp) return { k: 'ts' };
    return null;
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

/** A non-negative integer from schema metadata, or undefined. */
function parseCount(s: string | undefined): number | undefined {
    if (s === undefined || !/^\d+$/.test(s.trim())) return undefined;
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : undefined;
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

/** Encode one cell of an arrow Vector for the wire. Exported so the
 *  reader tests can compare every read path against it. */
export function encodeArrowCell(child: any, row: number, arrowType: string, tz: string): Cell {
    if (arrowType.startsWith('Dictionary')) {
        const data = child.data[0];
        if (isNullAt(data, row)) return null;
        return data.values[row] as number;
    }
    if (arrowType.startsWith('Int')) {
        const v = child.get(row);
        if (v === null || v === undefined) return null;
        // Int64 columns yield bigint; Cell type and JSON.stringify can't carry it.
        return typeof v === 'bigint' ? Number(v) : (v as number);
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
        const raw = data.values[row];
        // Date32 stores days since epoch as int32; Date64 stores ms since epoch as int64 (bigint).
        if (typeof raw === 'bigint') {
            return encodeDate(Number(raw / 86_400_000n));
        }
        return encodeDate(raw as number);
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
