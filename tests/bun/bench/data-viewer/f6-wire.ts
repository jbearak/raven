// F6 experiment: tile replies as JSON `Cell[][]` versus per-column typed
// arrays (`Float64Array` values + a `Uint8Array` validity/NaN tag per
// column), on the small wide fixture G (20k × 2,000 doubles). Not a test.
//
//   bun tests/bun/bench/data-viewer/f6-wire.ts [--dir <fixture cache>] [--samples 200]
//
// VS Code's `Webview.postMessage` has no transfer list: a JSON message is
// stringified and parsed, while ArrayBuffers in the message are copied
// out of band. Neither VS Code's IPC nor the webview process can run
// here, so each variant measures the work both ends do on the scroll
// path, with the closest in-process stand-in for the transport:
//
//   json:  JSON.stringify(reply) → JSON.parse → TileCache.putBlock
//   typed: build columns from the reader's cells (charged to typed, so the
//          comparison is conservative) → structuredClone (a copy, like VS
//          Code's ArrayBuffer path) → decode to cells → TileCache.putBlock
//
// Typed arrays are adopted only if they cut this scroll-path time by more
// than 20% (design F6).
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureFixture } from './fixtures';

const SRC = join(import.meta.dir, '../../../../editors/vscode/src/data-viewer');
const { ArrowSliceReader } = await import(join(SRC, 'arrow-reader.ts'));
const { TileCache, tileGeometry } = await import(join(SRC, 'webview/tile-cache.ts'));

function arg(name: string, def: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i < 0 ? def : process.argv[i + 1];
}
const DIR = arg('dir', join(tmpdir(), 'raven-dv-bench'));
const SAMPLES = Number(arg('samples', '200'));

type Cell = number | string | null | { _: string };

/** Columnar encoding of a numeric reply: value + tag (0 value, 1 NA,
 *  2 NaN, 3 Inf, 4 -Inf) per cell. */
function toTyped(rows: Cell[][]): { values: Float64Array[]; tags: Uint8Array[] } {
    const n = rows.length;
    const w = rows[0]?.length ?? 0;
    const values: Float64Array[] = [];
    const tags: Uint8Array[] = [];
    for (let c = 0; c < w; c++) {
        const v = new Float64Array(n);
        const t = new Uint8Array(n);
        for (let r = 0; r < n; r++) {
            const x = rows[r][c];
            if (typeof x === 'number') v[r] = x;
            else if (x === null) t[r] = 1;
            else if (typeof x === 'object') t[r] = x._ === 'nan' ? 2 : x._ === 'inf' ? 3 : 4;
        }
        values.push(v);
        tags.push(t);
    }
    return { values, tags };
}

const TAG_CELLS: Cell[] = [0, null, { _: 'nan' }, { _: 'inf' }, { _: '-inf' }];
function fromTyped(p: { values: Float64Array[]; tags: Uint8Array[] }, n: number): Cell[][] {
    const w = p.values.length;
    const rows: Cell[][] = new Array(n);
    for (let r = 0; r < n; r++) {
        const row: Cell[] = new Array(w);
        for (let c = 0; c < w; c++) row[c] = p.tags[c][r] === 0 ? p.values[c][r] : TAG_CELLS[p.tags[c][r]];
        rows[r] = row;
    }
    return rows;
}

function stats(xs: number[]): { median_ms: number; p95_ms: number } {
    const s = [...xs].sort((a, b) => a - b);
    const q = (f: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(f * s.length) - 1))];
    return { median_ms: Math.round(q(0.5) * 1000) / 1000, p95_ms: Math.round(q(0.95) * 1000) / 1000 };
}

const fx = ensureFixture(DIR, 'G', 1);
const reader = await ArrowSliceReader.open(fx.path);
const columns = Array.from({ length: fx.ncol }, (_, c) => c);
const perm = new Uint32Array(fx.nrow);
for (let i = 0; i < perm.length; i++) perm[i] = (i * 7919) % fx.nrow;

const report: Record<string, unknown> = { fixture: 'G', nrow: fx.nrow, ncol: fx.ncol, samples: SAMPLES };
for (const [label, permuted] of [['unsorted', false], ['sorted', true]] as const) {
    const geom = tileGeometry(permuted, fx.ncol);
    const R = geom.rowsPerTile;
    const C = geom.colsPerTile;
    const json: number[] = [];
    const typed: number[] = [];
    let jsonBytes = 0;
    let typedBytes = 0;
    for (let i = -10; i < SAMPLES; i++) {
        const start = (((i + 11) * 2_654_435_761) >>> 0) % (fx.nrow - R);
        const rowStart = start - (start % R);
        const colStart = C * (((i + 11) * 40_503) % Math.floor(fx.ncol / C));
        const reply = await reader.getRows({
            start: rowStart, end: rowStart + R, columns,
            columnRange: { start: colStart, end: colStart + C },
            viewportGeneration: 1, permutation: permuted ? perm : undefined,
        });
        const msg = { type: 'rows', start: rowStart, end: rowStart + R, rows: reply.rows, originalRowIndices: reply.originalRowIndices };

        // Alternate the order so neither variant always runs on a warm cache.
        const runJson = () => {
            const t0 = performance.now();
            const wire = JSON.stringify(msg);
            const got = JSON.parse(wire);
            const cache = new TileCache(geom);
            cache.putBlock(got.start, colStart, got.rows, got.originalRowIndices, fx.nrow, fx.ncol);
            const dt = performance.now() - t0;
            if (i >= 0) { json.push(dt); jsonBytes = wire.length; }
        };
        const runTyped = () => {
            const t0 = performance.now();
            const cols = toTyped(reply.rows as Cell[][]);
            const orig = reply.originalRowIndices ? Uint32Array.from(reply.originalRowIndices) : undefined;
            const wire = structuredClone({ type: 'rows', start: rowStart, end: rowStart + R, ...cols, orig });
            const rows = fromTyped(wire, R);
            const cache = new TileCache(geom);
            cache.putBlock(wire.start, colStart, rows, wire.orig ? Array.from(wire.orig) : undefined, fx.nrow, fx.ncol);
            const dt = performance.now() - t0;
            if (i >= 0) {
                typed.push(dt);
                typedBytes = cols.values.reduce((a, v) => a + v.byteLength, 0)
                    + cols.tags.reduce((a, v) => a + v.byteLength, 0) + (orig?.byteLength ?? 0);
            }
        };
        if (i % 2 === 0) { runJson(); runTyped(); } else { runTyped(); runJson(); }
    }
    const j = stats(json);
    const t = stats(typed);
    report[label] = {
        tile: `${R} x ${C}`,
        json: { ...j, bytes: jsonBytes },
        typed: { ...t, bytes: typedBytes },
        typed_vs_json_median: Math.round((t.median_ms / j.median_ms - 1) * 1000) / 10 + '%',
    };
}
await reader.close();
console.log(JSON.stringify(report, null, 2));
