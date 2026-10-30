// Data-viewer benchmark harness (design F0). Not a test file: `bun test`
// only discovers *.test.ts / *.spec.ts, so this runs only when invoked:
//
//   bun tests/bun/bench/data-viewer/bench.ts [options]
//
// Options:
//   --fixtures A,C,D,G     which fixtures (default all four). Add `R` to
//                          time the real R View() writer end to end (R
//                          side plus open → first rows) on D- and
//                          A-shaped frames; needs R with arrow, else it's
//                          reported as skipped.
//   --scale 1              row multiplier for A and C (CI uses less)
//   --samples 10           samples per fast measure (median and p95)
//   --sort-samples 3       samples per full sort
//   --dir <path>           fixture cache (default $TMPDIR/raven-dv-bench)
//   --out <file>           write the JSON report there (also printed)
//   --baseline <file>      compare medians against a previous report
//   --threshold 0.15       regression threshold on the median ratio
//   --fail-on-regression   exit 1 when a regression repeats on a re-run
//   --metrics a,b          only these measures (default all)
//   --src <dir>            data-viewer sources to measure (default the
//                          working tree; point at a copy of an older
//                          revision to measure "before")
//
// Each measure runs one discarded warm-up, then N samples. Alongside the
// timings it records the longest event-loop block seen during the samples
// (perf_hooks.monitorEventLoopDelay), which is what the "host never
// blocked > 50 ms" budget is about.
//
// When the measured sources have the worker engine (F4), the `worker_*`
// measures drive it as the extension does: sort and filter in the scan
// worker (cold = a fresh worker with no cached keys, warm = keys cached),
// the 64 × 32 sorted gather through the reader thread, and the commit
// protocol's prepare/commit round trip. Their `max_block_ms` is the
// extension host's event loop while the worker computes.
//
// Profiles (Phase 4): `profile_numeric` is one numeric column's full
// profile in process (budget < 400 ms on A); `worker_profile_numeric`
// the same through a fresh scan worker; `worker_getrows_during_profile`
// times viewport reads through the reader thread while profiles of every
// column run in the scan worker (compare with
// `reader_thread_unsorted_256x32`: profiles must not stall reads).
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureFixture } from './fixtures';
import type { FixtureInfo, FixtureName } from './fixtures';

type Stat = { median_ms: number; p95_ms: number; n: number; max_block_ms: number };
type Report = {
    meta: Record<string, unknown>;
    results: Record<string, Record<string, Stat>>;
};

function arg(name: string, def?: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    if (i < 0) return def;
    const v = process.argv[i + 1];
    return v === undefined || v.startsWith('--') ? 'true' : v;
}

const FIXTURES = (arg('fixtures', 'A,C,D,G') as string).split(',').map(s => s.trim()) as FixtureName[];
const SCALE = Number(arg('scale', '1'));
const SAMPLES = Number(arg('samples', '10'));
const SORT_SAMPLES = Number(arg('sort-samples', '3'));
const DIR = arg('dir', join(tmpdir(), 'raven-dv-bench')) as string;
const SRC = resolve(arg('src', join(import.meta.dir, '../../../../editors/vscode/src/data-viewer')) as string);
const THRESHOLD = Number(arg('threshold', '0.15'));
const METRICS = arg('metrics')?.split(',').map(s => s.trim());

const readerMod = await import(join(SRC, 'arrow-reader.ts'));
const sortMod = await import(join(SRC, 'sort.ts'));
const filterMod = await import(join(SRC, 'filter.ts'));
const effMod = existsSync(join(SRC, 'effective-permutation.ts'))
    ? await import(join(SRC, 'effective-permutation.ts'))
    : undefined;
const { ArrowSliceReader } = readerMod;
const workerMod = existsSync(join(SRC, 'worker-engine.ts'))
    ? await import(join(SRC, 'worker-engine.ts'))
    : undefined;
const profileMod = existsSync(join(SRC, 'profile-engine.ts'))
    ? await import(join(SRC, 'profile-engine.ts'))
    : undefined;
const CTX = { labelsOn: true, formatOn: true, digits: 3 };

/** The panel's composition before F3 (recomputed on every getRows). */
function composeLegacy(perm: Uint32Array, filtered: Uint32Array, nrow: number): Uint32Array {
    const survives = new Uint8Array(nrow);
    for (let i = 0; i < filtered.length; i++) survives[filtered[i]] = 1;
    const out = new Uint32Array(filtered.length);
    let j = 0;
    for (let i = 0; i < perm.length; i++) if (survives[perm[i]]) out[j++] = perm[i];
    return out;
}

function quantile(sorted: number[], q: number): number {
    if (sorted.length === 0) return NaN;
    const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
    return sorted[Math.max(0, idx)];
}

async function measure(
    samples: number,
    fn: (i: number) => Promise<void>,
): Promise<Stat> {
    await fn(-1);   // warm-up, discarded
    const times: number[] = [];
    const h = monitorEventLoopDelay({ resolution: 1 });
    h.enable();
    for (let i = 0; i < samples; i++) {
        const t0 = performance.now();
        await fn(i);
        times.push(performance.now() - t0);
        // Let the monitor's timer observe the gap the sample just caused.
        await new Promise(r => setTimeout(r, 2));
    }
    h.disable();
    times.sort((a, b) => a - b);
    return {
        median_ms: round(quantile(times, 0.5)),
        p95_ms: round(quantile(times, 0.95)),
        n: samples,
        max_block_ms: round(h.max / 1e6),
    };
}

/** Like {@link measure}, but `setup`/`teardown` run outside the timing
 *  and the event-loop monitor (e.g. a fresh worker per cold sample). */
async function measureEach<T>(
    samples: number,
    setup: () => Promise<T>,
    fn: (ctx: T, i: number) => Promise<void>,
    teardown: (ctx: T) => Promise<void>,
): Promise<Stat> {
    const times: number[] = [];
    let maxBlock = 0;
    for (let i = -1; i < samples; i++) {
        const ctx = await setup();
        const h = monitorEventLoopDelay({ resolution: 1 });
        h.enable();
        const t0 = performance.now();
        await fn(ctx, i);
        const dt = performance.now() - t0;
        await new Promise(r => setTimeout(r, 2));
        h.disable();
        await teardown(ctx);
        if (i < 0) continue; // warm-up
        times.push(dt);
        maxBlock = Math.max(maxBlock, h.max / 1e6);
    }
    times.sort((a, b) => a - b);
    return {
        median_ms: round(quantile(times, 0.5)),
        p95_ms: round(quantile(times, 0.95)),
        n: samples,
        max_block_ms: round(maxBlock),
    };
}

function round(x: number): number { return Math.round(x * 100) / 100; }

/** Deterministic spread of window starts across the frame. */
function startFor(i: number, rows: number, window: number): number {
    const span = Math.max(1, rows - window);
    return Math.floor((((i + 1) * 2_654_435_761) >>> 0) / 4294967296 * span);
}

type Measures = Record<string, () => Promise<Stat>>;

async function measuresFor(fx: FixtureInfo): Promise<{ measures: Measures; teardown: () => Promise<void> }> {
    const reader = await ArrowSliceReader.open(fx.path);
    const width = Math.min(32, fx.ncol);
    const firstCols = Array.from({ length: width }, (_, c) => c);
    // Columns for the 64 × 32 gather: a block away from the left edge
    // when the frame is wide enough (exercises column projection).
    const gatherCols = fx.ncol > 64
        ? Array.from({ length: 32 }, (_, c) => Math.floor(fx.ncol / 2) + c)
        : firstCols;
    // Shared, untimed setup: one numeric sort and one filter.
    const perm: Uint32Array = await sortMod.computePermutation(
        reader, [{ columnIndex: fx.numericColumn, direction: 'asc' }], CTX);
    const filtered: Uint32Array = await filterMod.computeFilteredIndices(reader, {
        entries: [{
            id: 'bench', columnIndex: fx.filterColumn, enabled: true, includeMissing: false,
            predicate: { kind: 'numBetween', lo: fx.filterRange[0], hi: fx.filterRange[1], inclusive: true },
        }],
        labelsOnWhenFiltered: true,
    }, CTX);
    const cached = effMod?.composeEffectivePermutation(perm, filtered, reader.nrow);

    const measures: Measures = {
        open_first_rows: () => measure(SAMPLES, async () => {
            const r = await ArrowSliceReader.open(fx.path);
            await r.getRows({ start: 0, end: 64, columns: firstCols, viewportGeneration: 1 });
            await r.close();
        }),
        getrows_sort_filter: () => measure(SAMPLES, async i => {
            // Host time per getRows with sort + filter active. Before F3
            // the panel recomposed the permutation on every call.
            const eff = cached ?? composeLegacy(perm, filtered, reader.nrow);
            const start = startFor(i, eff.length, 64);
            await reader.getRows({
                start, end: start + 64, columns: firstCols, viewportGeneration: 1, permutation: eff,
            });
        }),
        numeric_sort: () => measure(SORT_SAMPLES, async () => {
            await sortMod.computePermutation(
                reader, [{ columnIndex: fx.numericColumn, direction: 'desc' }], CTX);
        }),
        sorted_gather_64x32: () => measure(SAMPLES, async i => {
            const start = startFor(i, perm.length, 64);
            await reader.getRows({
                start, end: start + 64, columns: gatherCols, viewportGeneration: 1, permutation: perm,
            });
        }),
    };
    if (fx.stringColumn !== undefined) {
        measures.string_sort = () => measure(SORT_SAMPLES, async () => {
            await sortMod.computePermutation(
                reader, [{ columnIndex: fx.stringColumn!, direction: 'asc' }], CTX);
        });
    }
    if (profileMod) {
        measures.profile_numeric = () => measure(SAMPLES, async () => {
            await profileMod.computeProfile(reader, fx.numericColumn, { signal: new AbortController().signal });
        });
    }
    if (workerMod) Object.assign(measures, workerMeasures(fx, firstCols, gatherCols));
    if (typeof reader.nullCounts === 'function') {
        measures.null_count_scan = () => measure(SAMPLES, async () => {
            const r = await ArrowSliceReader.open(fx.path);   // cold header cache
            await r.nullCounts();
            await r.close();
        });
    }
    return { measures, teardown: () => reader.close() };
}

/** Measures through the worker engine (F4); see the header comment. */
function workerMeasures(fx: FixtureInfo, firstCols: number[], gatherCols: number[]): Measures {
    const startEngine = () => workerMod.WorkerEngine.start({
        filePath: fx.path,
        nrow: fx.nrow,
        readerScript: join(SRC, 'threads', 'reader-thread.ts'),
        scanScript: join(SRC, 'threads', 'scan-worker.ts'),
    });
    const numericSort = (dir: 'asc' | 'desc') => ({
        sort: { keys: [{ columnIndex: fx.numericColumn, direction: dir }], labelsOnWhenSorted: true },
        sortCtx: CTX,
    });
    const filter = {
        filter: {
            entries: [{
                id: 'bench', columnIndex: fx.filterColumn, enabled: true, includeMissing: false,
                predicate: { kind: 'numBetween', lo: fx.filterRange[0], hi: fx.filterRange[1], inclusive: true },
            }],
            labelsOnWhenFiltered: true,
        },
        filterCtx: CTX,
    };
    const stopEngine = (e: any) => e.dispose();
    const out: Measures = {
        worker_numeric_sort_cold: () => measureEach(SORT_SAMPLES, startEngine, async e => {
            e.discard(await e.compute(numericSort('desc')));
        }, stopEngine),
        worker_filter_cold: () => measureEach(SORT_SAMPLES, startEngine, async e => {
            e.discard(await e.compute(filter));
        }, stopEngine),
        // #328: with keys cached, re-sorting only a filter's survivors.
        worker_sort_survivors_warm: () => measureEach(SORT_SAMPLES, async () => {
            const e = await startEngine();
            await e.coordinator.install(await e.compute(filter));
            e.discard(await e.compute(numericSort('asc')));
            return e;
        }, async e => {
            e.discard(await e.compute(numericSort('desc')));
        }, stopEngine),
    };
    if (fx.stringColumn !== undefined) {
        for (const order of ['natural', 'c'] as const) {
            out[`worker_string_sort_${order}_cold`] = () => measureEach(SORT_SAMPLES, startEngine, async e => {
                e.discard(await e.compute({
                    sort: {
                        keys: [{ columnIndex: fx.stringColumn!, direction: 'asc' }],
                        labelsOnWhenSorted: true, stringOrder: order,
                    },
                    sortCtx: { ...CTX, locale: 'en-US' },
                }));
            }, stopEngine);
        }
    }
    // Reader-thread gather and the commit round trip share one engine with
    // a committed numeric sort.
    let shared: any;
    const sharedEngine = async () => {
        if (!shared) {
            shared = await startEngine();
            await shared.coordinator.install(await shared.compute(numericSort('asc')));
        }
        return shared;
    };
    out.reader_thread_sorted_gather_64x32 = async () => {
        const e = await sharedEngine();
        const gen = e.coordinator.committed.gen;
        return measure(SAMPLES, async i => {
            const start = startFor(i, fx.nrow, 64);
            await e.getRows({ start, end: start + 64, columns: gatherCols, viewportGeneration: i + 2 }, gen);
        });
    };
    out.reader_thread_unsorted_256x32 = async () => {
        const e = await startEngine();
        try {
            return await measure(SAMPLES, async i => {
                const start = startFor(i, fx.nrow, 256);
                await e.getRows({ start, end: start + 256, columns: firstCols, viewportGeneration: i + 2 }, 0);
            });
        } finally {
            await e.dispose();
        }
    };
    if (profileMod) {
        out.worker_profile_numeric = () => measureEach(SAMPLES, startEngine, async e => {
            await e.profile(fx.numericColumn, new AbortController().signal);
        }, stopEngine);
        out.worker_getrows_during_profile = async () => {
            const e = await startEngine();
            const ac = new AbortController();
            let profiling = true;
            let profiled = 0;
            const all = (async () => {
                for (let c = 0; c < fx.ncol && !ac.signal.aborted; c++) {
                    await e.profile(c, ac.signal).catch(() => undefined);
                    profiled++;
                }
                profiling = false;
            })();
            try {
                const m = await measure(SAMPLES, async i => {
                    const start = startFor(i, fx.nrow, 256);
                    await e.getRows({ start, end: start + 256, columns: firstCols, viewportGeneration: i + 2 }, 0);
                });
                console.error(`[bench] ${fx.name}: profiles still running after the samples: ${profiling} (${profiled} done)`);
                return m;
            } finally {
                ac.abort();
                await all;
                await e.dispose();
            }
        };
    }
    out.commit_protocol_round_trip = async () => {
        const e = await sharedEngine();
        const m = await measure(SAMPLES, async () => {
            // Re-install the committed buffer: prepare, commit, both acks.
            await e.coordinator.install(e.coordinator.reuse({ ...e.coordinator.committed }));
        });
        await e.dispose();
        shared = undefined;
        return m;
    };
    return out;
}

/** Time the real R `View()` writer (design F0's end-to-end budget, minus
 *  the webview paint): R-side `View()` elapsed time measured inside R, and
 *  the reader's open → first rows on the file it wrote. */
/** A failed run with its prerequisites present: fails the bench. */
class BenchFailure extends Error {}

async function rWriterMeasures(): Promise<Record<string, Stat>> {
    const R = process.env.RAVEN_TEST_R_BIN ?? 'R';
    const profileMod = await import(join(import.meta.dir, '../../../../editors/vscode/src/plot/r-bootstrap-profile.ts'));
    const tmp = mkdtempSync(join(tmpdir(), 'raven-dv-bench-r-'));
    const dv = join(tmp, 'dv');
    mkdirSync(dv);
    const out: Record<string, Stat> = {};
    try {
        const profile = await profileMod.write_profile_file(tmp, profileMod.generate_profile_source());
        const shapes: Array<[string, number, number]> = [
            ['view_D_50k_x_30', 50_000, 30],
            ['view_A_10M_x_10', Math.round(10_000_000 * SCALE), 10],
        ];
        for (const [metric, rows, cols] of shapes) {
            const reps = Math.max(1, Math.min(SORT_SAMPLES, 5));
            const code = `
                if (!requireNamespace("arrow", quietly = TRUE)) { cat("NOARROW\n"); quit(save = "no") }
                set.seed(1)
                df <- as.data.frame(lapply(seq_len(${cols}), function(j)
                    if (j %% 3 == 0) sample(c("a","b","c",NA), ${rows}, TRUE) else rnorm(${rows})))
                invisible(View(df))   # warm-up
                t <- vapply(seq_len(${reps}), function(i) system.time(View(df))[["elapsed"]], 0)
                cat("TIMES", t * 1000, "\n")`;
            const p = Bun.spawn({
                cmd: [R, '--quiet', '--no-echo', '--no-save', '--no-restore', '-e', code],
                cwd: tmp,
                env: {
                    ...process.env, R_PROFILE_USER: profile, RAVEN_ORIGINAL_R_PROFILE_USER: '',
                    RAVEN_DATA_VIEWER_DIR: dv, RAVEN_R_SESSION_ID: 'bench',
                    RAVEN_SESSION_PORT: '', RAVEN_SESSION_TOKEN: '',
                },
                stdout: 'pipe', stderr: 'pipe',
            });
            const stdout = await new Response(p.stdout).text();
            const stderr = await new Response(p.stderr).text();
            await p.exited;
            if (stdout.includes('NOARROW')) { console.error('[bench] R: arrow not installed; skipped'); return out; }
            const line = stdout.split('\n').find(l => l.startsWith('TIMES'));
            // R and arrow are present, so no timings means View() failed:
            // a benchmark failure, not a skip.
            if (!line) throw new BenchFailure(`R View() produced no timings for ${metric}:\n${stderr.slice(-2000)}`);
            const times = line.split(/\s+/).slice(1).filter(Boolean).map(Number).sort((a, b) => a - b);
            out[`${metric}_r_side`] = {
                median_ms: round(quantile(times, 0.5)), p95_ms: round(quantile(times, 0.95)),
                n: times.length, max_block_ms: 0,
            };
            const files = readdirSync(dv).filter(f => f.endsWith('.arrow')).map(f => join(dv, f));
            const file = files[files.length - 1];
            const firstCols = Array.from({ length: cols }, (_, c) => c);
            out[`${metric}_open_first_rows`] = await measure(SAMPLES, async () => {
                const r = await ArrowSliceReader.open(file);
                await r.getRows({ start: 0, end: 64, columns: firstCols, viewportGeneration: 1 });
                await r.close();
            });
            for (const f of files) rmSync(f, { force: true });
        }
    } catch (e) {
        if (e instanceof BenchFailure) throw e;
        console.error(`[bench] R: unavailable (${(e as Error).message}); skipped`);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
    return out;
}

async function run(only?: Record<string, string[]>): Promise<Report> {
    const results: Report['results'] = {};
    for (const name of FIXTURES) {
        if (only && !only[name]) continue;
        if ((name as string) === 'R') {
            results.R = await rWriterMeasures();
            for (const [m, st] of Object.entries(results.R)) console.error(`[bench] R.${m}: ${JSON.stringify(st)}`);
            continue;
        }
        const fx = ensureFixture(DIR, name, SCALE);
        const { measures, teardown } = await measuresFor(fx);
        results[name] = {};
        for (const [metric, fn] of Object.entries(measures)) {
            if (only && !only[name].includes(metric)) continue;
            if (METRICS && !METRICS.includes(metric)) continue;
            results[name][metric] = await fn();
            console.error(`[bench] ${name}.${metric}: ${JSON.stringify(results[name][metric])}`);
        }
        await teardown();
    }
    return {
        meta: {
            date: new Date().toISOString(),
            runtime: `bun ${Bun.version}`,
            platform: `${process.platform}-${process.arch}`,
            scale: SCALE,
            samples: SAMPLES,
            sortSamples: SORT_SAMPLES,
            src: SRC,
        },
        results,
    };
}

/** Metrics whose median regressed by more than THRESHOLD vs `base`. */
function regressions(cur: Report, base: Report): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [fx, metrics] of Object.entries(cur.results)) {
        for (const [m, s] of Object.entries(metrics)) {
            const b = base.results[fx]?.[m];
            if (!b || !(b.median_ms > 0)) continue;
            const ratio = s.median_ms / b.median_ms - 1;
            console.error(`[bench] ${fx}.${m}: ${b.median_ms} → ${s.median_ms} ms (${(ratio * 100).toFixed(1)}%)`);
            if (ratio > THRESHOLD) (out[fx] ??= []).push(m);
        }
    }
    return out;
}

const report = await run();
const baselinePath = arg('baseline');
let failed = false;
if (baselinePath) {
    const base: Report = JSON.parse(readFileSync(baselinePath, 'utf8'));
    let reg = regressions(report, base);
    if (Object.keys(reg).length > 0) {
        // A regression only counts if it repeats on an automatic re-run.
        console.error(`[bench] re-running regressed measures: ${JSON.stringify(reg)}`);
        const again = await run(reg);
        reg = regressions(again, base);
        for (const [fx, ms] of Object.entries(reg)) {
            for (const m of ms) report.results[fx][m] = again.results[fx][m];
        }
    }
    report.meta.baseline = baselinePath;
    report.meta.threshold = THRESHOLD;
    report.meta.regressions = reg;
    failed = Object.keys(reg).length > 0;
}
const json = JSON.stringify(report, null, 2);
const outPath = arg('out');
if (outPath) writeFileSync(outPath, json + '\n');
console.log(json);
if (failed && arg('fail-on-regression') === 'true') process.exit(1);
