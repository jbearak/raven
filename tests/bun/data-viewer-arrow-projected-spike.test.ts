// F2 spike: pins the apache-arrow 21.1.0 surface the projected reader
// (editors/vscode/src/data-viewer/arrow-reader.ts, arrow-ipc.ts) builds on,
// against files written by the real `View()` writer when R + arrow are
// available, and equivalent JS-written files otherwise. It demonstrates:
//
//   1. footer block access and message framing (continuation marker,
//      8-byte alignment of metadata and body);
//   2. `Message.decode` of a RecordBatch header, and node/buffer mapping
//      that agrees with arrow-ipc's in-place parse; the writer emits no
//      nested types;
//   3. reconstruction of every emitted column type from projected buffers
//      with `makeData`, dictionaries from the reader's loaded ones; the
//      writer emits one dictionary batch per field and no deltas;
//   4. element gather: one value and validity bit read at computed byte
//      offsets for fixed-width, string, and dictionary-index columns;
//   5. timing: open of a 2,000-column file and a sorted 64 × 32 gather
//      (budgets 500 ms / 15 ms; the full-size measurements live in the
//      benchmark, tests/bun/bench/data-viewer/).
//
// If a future apache-arrow changes any of this, this file fails first.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'bun';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Message, RecordBatchFileReader, makeData, makeVector } from 'apache-arrow';
import {
    ArrowSliceReader,
    encodeArrowCell,
} from '../../editors/vscode/src/data-viewer/arrow-reader';
import {
    buildColumnLayouts,
    parseRecordBatchHeader,
} from '../../editors/vscode/src/data-viewer/arrow-ipc';
import {
    generate_profile_source,
    write_profile_file,
} from '../../editors/vscode/src/plot/r-bootstrap-profile';
import { hash01, writeArrowFixture } from './_helpers/arrow-fixture-writer';

const R_BIN = process.env.RAVEN_TEST_R_BIN ?? 'R';
const DIR = mkdtempSync(join(tmpdir(), 'raven-dv-spike-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

async function rHasArrow(): Promise<boolean> {
    try {
        const p = spawn({
            cmd: [R_BIN, '--vanilla', '--quiet', '--no-echo', '-e',
                'cat(if (requireNamespace("arrow", quietly = TRUE)) "OK" else "NO")'],
            stdout: 'pipe', stderr: 'pipe',
        });
        const out = await new Response(p.stdout).text();
        await p.exited;
        return out.includes('OK');
    } catch {
        return false;
    }
}

/** Run `View(df)` through the real bootstrap profile and return the file
 *  it wrote. No session port is set, so the POST is skipped. */
async function viewWithR(rCode: string): Promise<string> {
    const tmp = mkdtempSync(join(DIR, 'r-'));
    const dv = join(tmp, 'dv');
    mkdirSync(dv);
    const profile = await write_profile_file(tmp, generate_profile_source());
    const p = spawn({
        cmd: [R_BIN, '--quiet', '--no-save', '--no-restore', '-e', rCode],
        cwd: tmp,
        env: {
            ...process.env,
            R_PROFILE_USER: profile,
            RAVEN_ORIGINAL_R_PROFILE_USER: '',
            RAVEN_DATA_VIEWER_DIR: dv,
            RAVEN_R_SESSION_ID: 'spike',
            RAVEN_SESSION_PORT: '',
            RAVEN_SESSION_TOKEN: '',
        },
        stdout: 'pipe', stderr: 'pipe',
    });
    const err = await new Response(p.stderr).text();
    await p.exited;
    const files = readdirSync(dv).filter(f => f.endsWith('.arrow'));
    if (files.length !== 1) throw new Error(`View() wrote ${files.length} files: ${err}`);
    return join(dv, files[0]);
}

// Every column class the writer handles; 70,000 rows so the file has two
// batches (65,536 + 4,464) at the writer's chunk size for this width.
const R_FRAME = `
n <- 70000L; k <- seq_len(n)
df <- data.frame(
  i  = ifelse(k %% 11L == 3L, NA_integer_, k),
  d  = ifelse(k %% 13L == 1L, NA_real_, k * 1.25),
  s  = ifelse(k %% 7L == 0L, NA_character_, paste0("s", k)),
  b  = ifelse(k %% 5L == 0L, NA, k %% 3L == 0L),
  f  = factor(ifelse(k %% 9L == 4L, NA, c("low", "mid", "high")[k %% 3L + 1L]), levels = c("low", "mid", "high")),
  o  = factor(paste0("l", k %% 300L), levels = paste0("l", 0:299), ordered = TRUE),
  dt = as.Date("2024-01-01") + k,
  ts = as.POSIXct("2024-01-01", tz = "America/New_York") + k * 1.5,
  dur = as.difftime(k, units = "secs"),
  cp = complex(real = k, imaginary = 1),
  stringsAsFactors = FALSE)
df$d[2] <- NaN; df$d[5] <- Inf; df$s[3] <- strrep("\\u00fc", 700); df$s[4] <- ""
if (requireNamespace("haven", quietly = TRUE)) df$lbl <- haven::labelled(rep(c(1, 2), length.out = n), c(a = 1, b = 2))
View(df)
`;

let SOURCE: 'R' | 'JS' = 'JS';
let FILE = '';

beforeAll(async () => {
    if (await rHasArrow()) {
        FILE = await viewWithR(R_FRAME);
        SOURCE = 'R';
    } else {
        FILE = join(DIR, 'js.arrow');
        writeArrowFixture(FILE, {
            nrow: 70_000,
            columns: [
                { name: 'i', kind: 'int', gen: i => (i % 11 === 3 ? null : i) },
                { name: 'd', kind: 'dbl', gen: i => (i % 13 === 1 ? null : i === 2 ? NaN : i * 1.25) },
                { name: 's', kind: 'chr', gen: i => (i % 7 === 0 ? null : i === 3 ? 'ü'.repeat(700) : `s${i}`) },
                { name: 'b', kind: 'lgl', gen: i => (i % 5 === 0 ? null : i % 3 === 0) },
                { name: 'f', kind: 'fct', levels: ['low', 'mid', 'high'], gen: i => (i % 9 === 4 ? null : i % 3) },
                { name: 'o', kind: 'fct', levels: Array.from({ length: 300 }, (_, j) => `l${j}`), ordered: true, gen: i => i % 300 },
                { name: 'dt', kind: 'date', gen: i => 19_723 + i },
                { name: 'ts', kind: 'dttm', tz: 'America/New_York', gen: i => 1_704_085_200_000_000n + BigInt(i) * 1_500_000n },
            ],
        });
    }
    console.log(`[spike] source file written by ${SOURCE}`);
}, 120_000);

function syncReader(): any {
    const r = RecordBatchFileReader.from(readFileSync(FILE)) as any;
    r.open();
    return r;
}

describe('F2 spike (apache-arrow 21.1.0)', () => {
    test('apache-arrow is the pinned version', () => {
        const pkg = JSON.parse(readFileSync(
            join(import.meta.dir, '../../editors/vscode/node_modules/apache-arrow/package.json'), 'utf8'));
        expect(pkg.version).toBe('21.1.0');
    });

    test('1. footer blocks and message framing', () => {
        const bytes = readFileSync(FILE);
        const r = syncReader();
        const blocks = [...r.footer.recordBatches()];
        expect(blocks.length).toBe(r.numRecordBatches);
        expect(blocks.length).toBeGreaterThanOrEqual(2);
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (const b of blocks) {
            const offset = Number(b.offset);
            expect(offset % 8).toBe(0);
            expect(b.metaDataLength % 8).toBe(0);
            expect(Number(b.bodyLength) % 8).toBe(0);
            expect(dv.getUint32(offset, true)).toBe(0xffffffff);   // continuation marker
            const fbLen = dv.getInt32(offset + 4, true);
            expect(8 + fbLen).toBeLessThanOrEqual(b.metaDataLength);
        }
        // Schema metadata the reader's arithmetic geometry relies on.
        const md: Map<string, string> = r.schema.metadata;
        const nrow = Number(md.get('raven.nrow'));
        const chunk = Number(md.get('raven.chunk_rows'));
        expect(nrow).toBe(70_000);
        expect(blocks.length).toBe(Math.ceil(nrow / chunk));
    });

    test('2. Message.decode of RecordBatch headers agrees with the in-place parse; no nested fields', () => {
        const bytes = readFileSync(FILE);
        const r = syncReader();
        const layouts = buildColumnLayouts(r.schema.fields.map((f: any) => f.type));
        expect(layouts.every(l => l.flat)).toBe(true);
        for (const b of r.footer.recordBatches()) {
            const offset = Number(b.offset);
            const prefix = new Uint8Array(bytes.buffer, bytes.byteOffset + offset, b.metaDataLength);
            const fbLen = new DataView(prefix.buffer, prefix.byteOffset).getInt32(4, true);
            const msg = Message.decode(prefix.subarray(8, 8 + fbLen));
            expect(msg.isRecordBatch()).toBe(true);
            expect(msg.bodyLength).toBe(Number(b.bodyLength));
            const header: any = msg.header();
            expect(header.compression).toBeNull();
            // One node per field: no nested types.
            expect(header.nodes.length).toBe(r.schema.fields.length);
            const mine = parseRecordBatchHeader(prefix, {
                offset, metaDataLength: b.metaDataLength, bodyLength: Number(b.bodyLength),
            });
            expect(mine.length).toBe(header.length);
            expect(Array.from(mine.nodeLength)).toEqual(header.nodes.map((n: any) => n.length));
            expect(Array.from(mine.nodeNullCount)).toEqual(header.nodes.map((n: any) => n.nullCount));
            expect(Array.from(mine.bufferOffset)).toEqual(header.buffers.map((x: any) => x.offset));
            expect(Array.from(mine.bufferLength)).toEqual(header.buffers.map((x: any) => x.length));
            expect(mine.bodyOffset).toBe(offset + b.metaDataLength);
        }
    });

    test('3. makeData rebuilds every column from projected buffers; one dictionary batch per field, no deltas', () => {
        const bytes = readFileSync(FILE);
        const r = syncReader();
        const fields = r.schema.fields;
        const dictFields = fields.filter((f: any) => String(f.type).startsWith('Dictionary'));
        expect(r.footer.numDictionaries).toBe(dictFields.length);
        for (const b of r.footer.dictionaryBatches()) {
            const offset = Number(b.offset);
            const fbLen = bytes.readInt32LE(offset + 4);
            const msg = Message.decode(bytes.subarray(offset + 8, offset + 8 + fbLen));
            expect(msg.isDictionaryBatch()).toBe(true);
            expect((msg.header() as any).isDelta).toBe(false);
        }
        const layouts = buildColumnLayouts(fields.map((f: any) => f.type));
        const blocks = [...r.footer.recordBatches()];
        blocks.forEach((b: any, bi: number) => {
            const offset = Number(b.offset);
            const h = parseRecordBatchHeader(
                new Uint8Array(bytes.buffer, bytes.byteOffset + offset, b.metaDataLength),
                { offset, metaDataLength: b.metaDataLength, bodyLength: Number(b.bodyLength) },
            );
            const whole = r.readRecordBatch(bi);
            fields.forEach((f: any, c: number) => {
                const { nodeIndex, bufferIndex, bufferCount } = layouts[c];
                // Copy each buffer out of the file at its footer-derived
                // offset: only this column's bytes are touched.
                const buf = (k: number) => {
                    const pos = h.bodyOffset + h.bufferOffset[bufferIndex + k];
                    return new Uint8Array(bytes.subarray(pos, pos + h.bufferLength[bufferIndex + k]));
                };
                const nullCount = h.nodeNullCount[nodeIndex];
                const nullBitmap = nullCount > 0 ? buf(0) : new Uint8Array(0);
                const type = f.type;
                const t = String(type);
                const data = t.startsWith('Dictionary')
                    ? makeData({ type, length: h.length, nullCount, nullBitmap, data: buf(1), dictionary: r.dictionaries.get(type.id) })
                    : bufferCount === 3
                        ? makeData({ type, length: h.length, nullCount, nullBitmap, valueOffsets: buf(1), data: buf(2) } as any)
                        : makeData({ type, length: h.length, nullCount, nullBitmap, data: buf(1) } as any);
                const projected = makeVector(data);
                const tz = t.startsWith('Timestamp') ? (type.timezone ?? 'UTC') : 'UTC';
                const ref = whole.getChildAt(c);
                for (let row = 0; row < h.length; row += 97) {
                    expect(encodeArrowCell(projected, row, t, tz)).toEqual(encodeArrowCell(ref, row, t, tz));
                }
            });
        });
    });

    test('4. element gather: value + validity bit at computed offsets', () => {
        const bytes = readFileSync(FILE);
        const r = syncReader();
        const fields = r.schema.fields;
        const layouts = buildColumnLayouts(fields.map((f: any) => f.type));
        const b: any = [...r.footer.recordBatches()][0];
        const offset = Number(b.offset);
        const h = parseRecordBatchHeader(
            new Uint8Array(bytes.buffer, bytes.byteOffset + offset, b.metaDataLength),
            { offset, metaDataLength: b.metaDataLength, bodyLength: Number(b.bodyLength) },
        );
        const whole = r.readRecordBatch(0);
        const col = (name: string) => fields.findIndex((f: any) => f.name === name);
        const isValid = (c: number, row: number) => {
            const { nodeIndex, bufferIndex } = layouts[c];
            if (h.nodeNullCount[nodeIndex] === 0) return true;   // validity read skipped
            const pos = h.bodyOffset + h.bufferOffset[bufferIndex] + (row >> 3);
            return ((bytes[pos] >> (row & 7)) & 1) === 1;
        };
        for (const row of [0, 1, 2, 3, 6, 12, 1_000, 65_535]) {
            // Fixed width (double).
            const d = col('d');
            const dPos = h.bodyOffset + h.bufferOffset[layouts[d].bufferIndex + 1] + row * 8;
            const dGot = isValid(d, row) ? bytes.readDoubleLE(dPos) : null;
            const dRef = whole.getChildAt(d).get(row);
            if (dRef === null) expect(dGot).toBeNull();
            else if (Number.isNaN(dRef)) expect(Number.isNaN(dGot)).toBe(true);
            else expect(dGot).toBe(dRef);
            // String: offset pair, then bytes.
            const s = col('s');
            const oPos = h.bodyOffset + h.bufferOffset[layouts[s].bufferIndex + 1] + row * 4;
            const o0 = bytes.readInt32LE(oPos);
            const o1 = bytes.readInt32LE(oPos + 4);
            const sData = h.bodyOffset + h.bufferOffset[layouts[s].bufferIndex + 2];
            const sGot = isValid(s, row) ? bytes.toString('utf8', sData + o0, sData + o1) : null;
            expect(sGot).toBe(whole.getChildAt(s).get(row));
            // Dictionary index (int8 for 3 levels).
            const f = col('f');
            const fPos = h.bodyOffset + h.bufferOffset[layouts[f].bufferIndex + 1] + row;
            const fGot = isValid(f, row) ? bytes.readInt8(fPos) : null;
            expect(fGot).toBe(encodeArrowCell(whole.getChildAt(f), row, String(fields[f].type), 'UTC'));
        }
    });

    test('ArrowSliceReader on the writer file: metadata geometry, projected and gathered cells match', async () => {
        const r = await ArrowSliceReader.open(FILE);
        expect(r.geometrySource).toBe('metadata');
        expect(r.projectable).toBe(true);
        const sync = syncReader();
        const fields = sync.schema.fields;
        const ref: any[][] = [];
        for (let bi = 0; bi < sync.numRecordBatches; bi++) {
            const b = sync.readRecordBatch(bi);
            for (let row = 0; row < b.numRows; row++) {
                ref.push(fields.map((f: any, c: number) => {
                    const t = String(f.type);
                    return encodeArrowCell(b.getChildAt(c), row, t,
                        t.startsWith('Timestamp') ? (f.type.timezone ?? 'UTC') : 'UTC');
                }));
            }
        }
        const cols = fields.map((_: any, c: number) => c);
        const plain = await r.getRows({ start: 65_000, end: 66_000, columns: cols, viewportGeneration: 1 });
        expect(plain.rows).toEqual(ref.slice(65_000, 66_000));
        const perm = Uint32Array.from({ length: 2_000 }, (_, i) => Math.floor(hash01(i, 3) * 70_000));
        const permuted = await r.getRows({
            start: 0, end: 2_000, columns: cols, viewportGeneration: 1, permutation: perm,
        });
        expect(permuted.rows).toEqual(Array.from(perm, row => ref[row]));
        const counts = await r.nullCounts();
        fields.forEach((_: any, c: number) => {
            let n = 0;
            for (let bi = 0; bi < sync.numRecordBatches; bi++) n += sync.readRecordBatch(bi).getChildAt(c).nullCount;
            expect(counts[c]).toBe(n);
        });
        await r.close();
    }, 60_000);

    test('5. timing: 2,000-column open and a sorted 64 × 32 gather', async () => {
        const path = join(DIR, 'wide.arrow');
        const ncol = 2_000;
        const { chunkRows } = writeArrowFixture(path, {
            nrow: 4 * 1_048,
            columns: Array.from({ length: ncol }, (_, c) => ({
                name: `x${c}`, kind: 'dbl' as const, gen: (i: number) => (hash01(i, c) < 0.01 ? null : hash01(i, c + 1)),
            })),
        });
        expect(chunkRows).toBe(1_048);   // the writer formula at 2,000 doubles
        const opens: number[] = [];
        for (let k = 0; k < 5; k++) {
            const t0 = performance.now();
            const r = await ArrowSliceReader.open(path);
            opens.push(performance.now() - t0);
            await r.close();
        }
        const r = await ArrowSliceReader.open(path);
        const perm = Uint32Array.from({ length: r.nrow }, (_, i) => i);
        for (let i = perm.length - 1; i > 0; i--) {
            const j = Math.floor(hash01(i, 11) * (i + 1));
            [perm[i], perm[j]] = [perm[j], perm[i]];
        }
        const cols = Array.from({ length: 32 }, (_, c) => 500 + c);
        const gathers: number[] = [];
        for (let k = 0; k < 10; k++) {
            const start = k * 64;
            const t0 = performance.now();
            await r.getRows({ start, end: start + 64, columns: cols, viewportGeneration: 1, permutation: perm });
            gathers.push(performance.now() - t0);
        }
        await r.close();
        const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
        console.log(`[spike] open 2,000 cols: median ${median(opens).toFixed(1)} ms; `
            + `64x32 sorted gather: median ${median(gathers).toFixed(2)} ms`);
        // Budgets from the design (F2 spike contract). CI runners get 4x
        // headroom; the benchmark tracks the real numbers.
        const slack = process.env.CI ? 4 : 1;
        expect(median(opens)).toBeLessThan(500 * slack);
        expect(median(gathers)).toBeLessThan(15 * slack);
    }, 60_000);
});
