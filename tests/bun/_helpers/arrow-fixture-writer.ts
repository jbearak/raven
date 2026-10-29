// JS writer for data-viewer Arrow fixtures with the same geometry and
// metadata conventions as the R `View()` writer (`.raven_write_arrow` in
// editors/vscode/src/plot/r-bootstrap-profile.ts): uncompressed IPC file,
// every batch exactly `chunkRows` rows except the last, one dictionary
// batch per dictionary field, and schema metadata `raven.nrow`,
// `raven.chunk_rows`, `raven.session_tz`, `raven.fields`.
//
// Used by the reader tests, the projected-read spike (when R is absent),
// and the benchmark harness. Batches are generated and written one at a
// time, so multi-GB fixtures never sit in memory.
import { closeSync, openSync, writeSync } from 'node:fs';
import {
    Bool,
    DateDay,
    Dictionary,
    Field,
    Float64,
    Int32,
    Int8,
    RecordBatch,
    RecordBatchFileWriter,
    Schema,
    Struct,
    TimestampMicrosecond,
    Utf8,
    makeData,
    vectorFromArray,
} from 'apache-arrow';
import type { DataType } from 'apache-arrow';

/** Value generator for one column: row index → value, or null for NA. */
export type ColumnSpec =
    | { name: string; kind: 'dbl'; gen: (i: number) => number | null; fieldMd?: Record<string, string> }
    | { name: string; kind: 'int'; gen: (i: number) => number | null; fieldMd?: Record<string, string> }
    | { name: string; kind: 'lgl'; gen: (i: number) => boolean | null; fieldMd?: Record<string, string> }
    | { name: string; kind: 'chr'; gen: (i: number) => string | null; fieldMd?: Record<string, string> }
    | {
        name: string; kind: 'fct'; levels: string[]; gen: (i: number) => number | null;
        ordered?: boolean; fieldMd?: Record<string, string>;
    }
    | { name: string; kind: 'date'; gen: (i: number) => number | null; fieldMd?: Record<string, string> }
    | { name: string; kind: 'dttm'; tz?: string; gen: (i: number) => bigint | null; fieldMd?: Record<string, string> };

export type FixtureOptions = {
    nrow: number;
    columns: ColumnSpec[];
    /** Rows per batch; defaults to {@link chunkRowsFor} like the R writer. */
    chunkRows?: number;
    /** Extra schema metadata; set a key to `null` to omit a default one. */
    schemaMd?: Record<string, string | null>;
    /** Explicit batch lengths (overrides chunkRows) for irregular files. */
    batchLengths?: number[];
};

/** The R writer's batch size rule: `max(1024, min(65536, 2^21 %/% w))`
 *  rows, with `w` the estimated decoded bytes per row / 8. */
export function chunkRowsFor(rowBytes: number): number {
    const w = Math.max(1, rowBytes / 8);
    return Math.max(1024, Math.min(65536, Math.floor(2 ** 21 / w)));
}

/** Estimated decoded bytes per row, as the R writer computes it
 *  (character columns sample up to 1,000 evenly spaced values). */
export function estimateRowBytes(columns: ColumnSpec[], nrow: number): number {
    let total = 0;
    for (const c of columns) {
        switch (c.kind) {
            case 'fct': case 'int': case 'date': total += 4; break;
            case 'lgl': total += 1; break;
            case 'chr': {
                const k = Math.min(nrow, 1000);
                let sum = 0, n = 0;
                for (let j = 0; j < k; j++) {
                    const i = k <= 1 ? 0 : Math.round((j * (nrow - 1)) / (k - 1));
                    const v = c.gen(i);
                    if (v !== null) { sum += Buffer.byteLength(v, 'utf8'); n++; }
                }
                total += 4 + (n ? sum / n : 0);
                break;
            }
            default: total += 8;
        }
    }
    return total;
}

function arrowType(c: ColumnSpec, dictId: number): DataType {
    switch (c.kind) {
        case 'dbl': return new Float64();
        case 'int': return new Int32();
        case 'lgl': return new Bool();
        case 'chr': return new Utf8();
        case 'date': return new DateDay();
        case 'dttm': return new TimestampMicrosecond(c.tz ?? 'UTC');
        case 'fct':
            return new Dictionary(
                new Utf8(),
                c.levels.length < 128 ? new Int8() : new Int32(),
                dictId,
                c.ordered ?? false,
            );
    }
}

function bitmap(len: number): Uint8Array { return new Uint8Array((len + 7) >> 3); }

function columnData(c: ColumnSpec, type: any, start: number, len: number, dictionary: any): any {
    const valid = bitmap(len);
    let nulls = 0;
    const mark = (i: number) => { valid[i >> 3] |= 1 << (i & 7); };
    switch (c.kind) {
        case 'dbl': case 'int': case 'date': {
            const values = c.kind === 'dbl' ? new Float64Array(len) : new Int32Array(len);
            for (let i = 0; i < len; i++) {
                const v = c.gen(start + i);
                if (v === null) nulls++; else { values[i] = v; mark(i); }
            }
            return makeData({ type, length: len, nullCount: nulls, nullBitmap: nulls ? valid : undefined, data: values as any });
        }
        case 'dttm': {
            const values = new BigInt64Array(len);
            for (let i = 0; i < len; i++) {
                const v = c.gen(start + i);
                if (v === null) nulls++; else { values[i] = v; mark(i); }
            }
            return makeData({ type, length: len, nullCount: nulls, nullBitmap: nulls ? valid : undefined, data: values as any });
        }
        case 'lgl': {
            const bits = bitmap(len);
            for (let i = 0; i < len; i++) {
                const v = c.gen(start + i);
                if (v === null) nulls++;
                else { mark(i); if (v) bits[i >> 3] |= 1 << (i & 7); }
            }
            return makeData({ type, length: len, nullCount: nulls, nullBitmap: nulls ? valid : undefined, data: bits });
        }
        case 'fct': {
            const codes = c.levels.length < 128 ? new Int8Array(len) : new Int32Array(len);
            for (let i = 0; i < len; i++) {
                const v = c.gen(start + i);
                if (v === null) nulls++; else { codes[i] = v; mark(i); }
            }
            return makeData({
                type, length: len, nullCount: nulls, nullBitmap: nulls ? valid : undefined,
                data: codes as any, dictionary,
            });
        }
        case 'chr': {
            const offsets = new Int32Array(len + 1);
            const parts: Buffer[] = [];
            let pos = 0;
            for (let i = 0; i < len; i++) {
                const v = c.gen(start + i);
                if (v === null) nulls++;
                else {
                    mark(i);
                    const b = Buffer.from(v, 'utf8');
                    parts.push(b);
                    pos += b.length;
                }
                offsets[i + 1] = pos;
            }
            const data = new Uint8Array(Buffer.concat(parts, pos));
            return makeData({
                type, length: len, nullCount: nulls, nullBitmap: nulls ? valid : undefined,
                valueOffsets: offsets, data,
            });
        }
    }
}

/** Drain everything the writer has queued so far into `fd`. The writer's
 *  byte queue is internal, but this is test-only code and avoids holding
 *  the whole file in memory. */
function drain(writer: any, fd: number): void {
    const values: Uint8Array[] = writer._sink._values;
    for (const v of values.splice(0, values.length)) writeSync(fd, v);
}

/** Write a fixture to `path`. Returns the chunk size used. */
export function writeArrowFixture(path: string, opts: FixtureOptions): { chunkRows: number; batches: number } {
    const { nrow, columns } = opts;
    const chunkRows = opts.chunkRows ?? chunkRowsFor(estimateRowBytes(columns, nrow));
    const lengths: number[] = opts.batchLengths ?? [];
    if (!opts.batchLengths) {
        for (let s = 0; s < nrow; s += chunkRows) lengths.push(Math.min(chunkRows, nrow - s));
    }
    let dictId = 0;
    const types = columns.map(c => arrowType(c, c.kind === 'fct' ? dictId++ : -1));
    const dictionaries = columns.map(c =>
        c.kind === 'fct' ? vectorFromArray(c.levels, new Utf8()) : undefined);
    const fieldMd: Record<string, Record<string, string>> = {};
    for (const c of columns) if (c.fieldMd) fieldMd[c.name] = c.fieldMd;
    const md = new Map<string, string>();
    const defaults: Record<string, string> = {
        'raven.nrow': String(nrow),
        'raven.chunk_rows': String(chunkRows),
        'raven.session_tz': 'UTC',
    };
    if (Object.keys(fieldMd).length) defaults['raven.fields'] = JSON.stringify(fieldMd);
    for (const [k, v] of Object.entries({ ...defaults, ...(opts.schemaMd ?? {}) })) {
        if (v !== null) md.set(k, v);
    }
    const fields = columns.map((c, i) => new Field(c.name, types[i], true));
    const schema = new Schema(fields, md);
    const writer = new RecordBatchFileWriter();
    const fd = openSync(path, 'w');
    try {
        let start = 0;
        for (const len of lengths) {
            const children = columns.map((c, i) => columnData(c, types[i], start, len, dictionaries[i]));
            const data = makeData({ type: new Struct(fields), length: len, children, nullCount: 0 });
            writer.write(new RecordBatch(schema, data));
            drain(writer, fd);
            start += len;
        }
        if (lengths.length === 0) writer.reset(undefined, schema);
        writer.finish();
        drain(writer, fd);
    } finally {
        closeSync(fd);
    }
    return { chunkRows, batches: lengths.length };
}

/** Small deterministic PRNG (mulberry32) so fixtures are reproducible. */
export function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A cheap deterministic hash of a row index into [0, 1). Lets column
 *  generators be pure functions of the row (batch-order independent). */
export function hash01(i: number, salt = 0): number {
    let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ salt;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}
