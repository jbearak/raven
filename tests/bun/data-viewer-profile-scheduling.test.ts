/**
 * Profile scheduling (design "Summaries" → Scheduling): one profile at a
 * time, columns that leave the interest are cancelled, nothing runs
 * without interest or while hidden, and a running profile pauses while
 * viewport reads or transforms run (preemption), both in process and
 * through the real scan worker.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArrowSliceReader } from '../../editors/vscode/src/data-viewer/arrow-reader';
import { LocalEngine } from '../../editors/vscode/src/data-viewer/engine';
import { WorkerEngine } from '../../editors/vscode/src/data-viewer/worker-engine';
import { ProfileScheduler } from '../../editors/vscode/src/data-viewer/profile-scheduler';
import type { ProfileUpdate } from '../../editors/vscode/src/data-viewer/profile-scheduler';
import type { ColumnProfile } from '../../editors/vscode/src/data-viewer/profile';
import { isAbortError, isInterruption } from '../../editors/vscode/src/data-viewer/abort';
import { hash01, writeArrowFixture } from './_helpers/arrow-fixture-writer';

const DIR = mkdtempSync(join(tmpdir(), 'raven-dv-sched-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));
const THREADS = join(import.meta.dir, '../../editors/vscode/src/data-viewer/threads');

const NROW = 400_000;
const PATH = join(DIR, 'sched.arrow');
writeArrowFixture(PATH, {
    nrow: NROW,
    chunkRows: 2048,
    columns: [
        { name: 'a', kind: 'dbl', gen: i => hash01(i, 1) * 100 },
        { name: 'b', kind: 'dbl', gen: i => hash01(i, 2) },
        { name: 'c', kind: 'int', gen: i => Math.floor(hash01(i, 3) * 50) },
    ],
});

/** A runner whose runs the test resolves by hand. */
function fakeRunner() {
    const runs: { ci: number; signal: AbortSignal; resolve: (p: ColumnProfile) => void; reject: (e: unknown) => void }[] = [];
    const run = (ci: number, signal: AbortSignal) => new Promise<ColumnProfile>((resolve, reject) => {
        runs.push({ ci, signal, resolve, reject });
        signal.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
        }, { once: true });
    });
    return { runs, run };
}

const profileFor = (ci: number): ColumnProfile => ({
    columnIndex: ci, kind: 'numeric', rows: 1, na: 0, nan: 0, distinct: { value: 1, exact: true },
});
const tick = () => new Promise(r => setTimeout(r, 0));

describe('ProfileScheduler', () => {
    test('one profile at a time, in interest order; results are posted and cached', async () => {
        const { runs, run } = fakeRunner();
        const posted: ProfileUpdate[] = [];
        const s = new ProfileScheduler(run, u => posted.push(...u), isAbortError);
        s.setInterest([2, 0, 1]);
        expect(posted).toEqual([[2, { state: 'loading' }], [0, { state: 'loading' }], [1, { state: 'loading' }]]);
        expect(runs.map(r => r.ci)).toEqual([2]);
        runs[0].resolve(profileFor(2));
        await tick();
        expect(runs.map(r => r.ci)).toEqual([2, 0]);
        expect(posted).toContainEqual([2, { state: 'ready', profile: profileFor(2) }]);
        // Re-interest in a cached column posts it at once without a run.
        posted.length = 0;
        s.setInterest([2, 0, 1]);
        expect(posted).toEqual([[2, { state: 'ready', profile: profileFor(2) }]]);
        expect(runs.length).toBe(2);
    });

    test('a column that leaves the interest is cancelled and dropped; the next one starts', async () => {
        const { runs, run } = fakeRunner();
        const posted: ProfileUpdate[] = [];
        const s = new ProfileScheduler(run, u => posted.push(...u), isAbortError);
        s.setInterest([0, 1]);
        expect(runs[0].ci).toBe(0);
        s.setInterest([1]);
        expect(runs[0].signal.aborted).toBe(true);
        expect(posted).toContainEqual([0, null]);
        await tick();
        expect(runs.map(r => r.ci)).toEqual([0, 1]);
        expect(s.cached(0)).toBeUndefined();
    });

    test('no interest, nothing runs; hidden pauses and resumes', async () => {
        const { runs, run } = fakeRunner();
        const s = new ProfileScheduler(run, () => {}, isAbortError);
        s.setInterest([]);
        expect(runs.length).toBe(0);
        s.setActive(false);
        s.setInterest([3]);
        expect(runs.length).toBe(0);
        s.setActive(true);
        expect(runs.map(r => r.ci)).toEqual([3]);
        s.setActive(false);
        expect(runs[0].signal.aborted).toBe(true);
        await tick();
        s.setActive(true);
        expect(runs.map(r => r.ci)).toEqual([3, 3]);
    });

    test('a failure is cached as failed, never as loading', async () => {
        const { runs, run } = fakeRunner();
        const posted: ProfileUpdate[] = [];
        const s = new ProfileScheduler(run, u => posted.push(...u), isAbortError);
        s.setInterest([0]);
        runs[0].reject(new Error('decode failed'));
        await tick();
        expect(s.cached(0)).toEqual({ state: 'failed', error: 'decode failed' });
        expect(posted.at(-1)).toEqual([0, { state: 'failed', error: 'decode failed' }]);
        s.setInterest([0]);
        expect(runs.length).toBe(1);
    });

    test('a worker restart it did not ask for is retried, then failed', async () => {
        const { runs, run } = fakeRunner();
        // The panel's predicate, with the error a restarted ThreadClient
        // actually rejects with (worker-engine.ts restartError).
        const s = new ProfileScheduler(run, () => {}, isInterruption);
        s.setInterest([0]);
        for (let i = 0; i < 3; i++) {
            const e = new Error('scan thread restarted');
            e.name = 'WorkerRestartError';
            runs[i].reject(e);
            await tick();
        }
        expect(runs.length).toBe(3);
        expect(s.cached(0)?.state).toBe('failed');
    });
});

describe('ProfileScheduler.refresh: a sort made exact quartiles available', () => {
    const sampled = (ci: number): ColumnProfile => ({ ...profileFor(ci), quantiles: { p25: 1, p50: 2, p75: 3, exact: false } });
    const exact = (ci: number): ColumnProfile => ({ ...profileFor(ci), quantiles: { p25: 1.5, p50: 2.5, p75: 3.5, exact: true } });

    /** A scheduler holding `first` for column 0, the client no longer
     *  asking for anything (it has the profile). */
    async function holding(first: ColumnProfile) {
        const { runs, run } = fakeRunner();
        const posted: ProfileUpdate[] = [];
        const s = new ProfileScheduler(run, u => posted.push(...u), isAbortError);
        s.setInterest([0]);
        runs[0].resolve(first);
        await tick();
        s.setInterest([]);
        posted.length = 0;
        return { s, runs, posted };
    }

    test('a sampled profile runs again and the replacement is posted without interest', async () => {
        const { s, runs, posted } = await holding(sampled(0));
        s.refresh(0);
        expect(runs.map(r => r.ci)).toEqual([0, 0]);
        // The client keeps what it has meanwhile: no loading, no drop.
        expect(posted).toEqual([]);
        runs[1].resolve(exact(0));
        await tick();
        expect(posted).toEqual([[0, { state: 'ready', profile: exact(0) }]]);
        expect(s.cached(0)).toEqual({ state: 'ready', profile: exact(0) });
        // Now exact: a later sort changes nothing.
        s.refresh(0);
        expect(runs.length).toBe(2);
    });

    test('a refresh that comes back still sampled is not posted again', async () => {
        // The sort key couldn't give quartiles (an integer64 column, say).
        const { s, runs, posted } = await holding(sampled(0));
        const held = s.cached(0);
        s.refresh(0);
        runs[1].resolve(sampled(0));
        await tick();
        expect(posted).toEqual([]);
        expect(s.cached(0)).toBe(held);
        // Nor while the client is looking at the column.
        s.setInterest([0]);
        posted.length = 0;
        s.refresh(0);
        runs[2].resolve(sampled(0));
        await tick();
        expect(posted).toEqual([]);
        expect(s.cached(0)).toBe(held);
    });

    test('an exact, failed or unknown profile is left alone', async () => {
        const { s, runs } = await holding(exact(0));
        s.refresh(0);
        s.refresh(7);
        expect(runs.length).toBe(1);
        const f = fakeRunner();
        const failed = new ProfileScheduler(f.run, () => {}, isAbortError);
        failed.setInterest([0]);
        f.runs[0].reject(new Error('decode failed'));
        await tick();
        failed.refresh(0);
        expect(f.runs.length).toBe(1);
    });

    test('an interest change does not cancel it; columns the client waits for go first', async () => {
        const { s, runs, posted } = await holding(sampled(0));
        s.refresh(0);
        s.setInterest([1]);
        expect(runs[1].signal.aborted).toBe(false);
        runs[1].resolve(exact(0));
        await tick();
        expect(posted).toContainEqual([0, { state: 'ready', profile: exact(0) }]);
        expect(runs.map(r => r.ci)).toEqual([0, 0, 1]);
        // Queued behind a wanted column.
        const b = await holding(sampled(0));
        b.s.setInterest([1]);
        b.s.refresh(0);
        expect(b.runs.map(r => r.ci)).toEqual([0, 1]);
        b.runs[1].resolve(profileFor(1));
        await tick();
        expect(b.runs.map(r => r.ci)).toEqual([0, 1, 0]);
    });

    test('a hidden panel pauses it; a failure keeps the profile the client has', async () => {
        const { s, runs, posted } = await holding(sampled(0));
        s.setActive(false);
        s.refresh(0);
        expect(runs.length).toBe(1);
        s.setActive(true);
        expect(runs.length).toBe(2);
        s.setActive(false);
        expect(runs[1].signal.aborted).toBe(true);
        await tick();
        s.setActive(true);
        expect(runs.length).toBe(3);
        runs[2].reject(new Error('decode failed'));
        await tick();
        expect(posted).toEqual([]);
        expect(s.cached(0)).toEqual({ state: 'ready', profile: sampled(0) });
        expect(runs.length).toBe(3);
    });
});

describe('quartiles after a sort', () => {
    /** Type-7 quartiles of column `a`, from a full sort done here. */
    function trueQuartiles(): { p25: number; p50: number; p75: number } {
        const v = Float64Array.from({ length: NROW }, (_, i) => hash01(i, 1) * 100).sort();
        const q = (p: number) => {
            const h = (NROW - 1) * p, l = Math.floor(h);
            return v[l] + (h - l) * (v[Math.min(NROW - 1, l + 1)] - v[l]);
        };
        return { p25: q(0.25), p50: q(0.5), p75: q(0.75) };
    }
    const signal = () => new AbortController().signal;
    const sortBy = (engine: LocalEngine, columnIndex: number) => engine.compute({
        sort: { keys: [{ columnIndex, direction: 'desc' }], labelsOnWhenSorted: true },
    }).then(t => engine.discard(t));

    test('a profile cached before the sort gets exact quartiles after it', async () => {
        const reader = await ArrowSliceReader.open(PATH);
        const engine = new LocalEngine(reader);
        const before = await engine.profile(0, signal());
        expect(before.quantiles?.exact).toBe(false);
        expect(before.quantiles?.p50).not.toBe(trueQuartiles().p50);
        await sortBy(engine, 0);
        const after = await engine.profile(0, signal());
        expect(after.quantiles).toEqual({ ...trueQuartiles(), exact: true });
        // Everything else is the profile it already had.
        expect({ ...after, quantiles: undefined }).toEqual({ ...before, quantiles: undefined });
        // A sort on another column leaves a sampled profile sampled.
        const other = await engine.profile(1, signal());
        expect(other.quantiles?.exact).toBe(false);
        await engine.dispose();
        await reader.close();
    });

    test('the exact quartiles of a cached profile wait at the priority gate like a scan', async () => {
        const reader = await ArrowSliceReader.open(PATH);
        const engine = new LocalEngine(reader);
        await engine.profile(0, signal());
        await sortBy(engine, 0);
        engine.priority[0] = 1; // a viewport read in flight
        let done = false;
        const p = engine.profile(0, signal()).then(r => { done = true; return r; });
        await new Promise(r => setTimeout(r, 30));
        expect(done).toBe(false);
        engine.priority[0] = 0;
        expect((await p).quantiles?.exact).toBe(true);
        await engine.dispose();
        await reader.close();
    });

    test('a profile whose scan a sort interrupted is exact when it finishes', async () => {
        const reader = await ArrowSliceReader.open(PATH);
        const engine = new LocalEngine(reader);
        const prof = engine.profile(0, signal());
        await new Promise(r => setTimeout(r, 1));
        await sortBy(engine, 0);
        expect(engine.scan.profilePauses).toBeGreaterThan(0);
        expect((await prof).quantiles).toEqual({ ...trueQuartiles(), exact: true });
        await engine.dispose();
        await reader.close();
    });
});

describe('profile priority in the scan worker', () => {
    test('in process: viewport reads in flight hold a profile at the gate', async () => {
        const reader = await ArrowSliceReader.open(PATH);
        const engine = new LocalEngine(reader);
        engine.priority[0] = 1; // a viewport read in flight
        let done = false;
        const p = engine.profile(0, new AbortController().signal).then(r => { done = true; return r; });
        await new Promise(r => setTimeout(r, 50));
        expect(done).toBe(false);
        expect(engine.scan.profilePauses).toBeGreaterThan(0);
        engine.priority[0] = 0;
        const prof = await p;
        expect(prof.rows).toBe(NROW);
        await engine.dispose();
        await reader.close();
    });

    test('in process: a sort preempts a running profile and finishes first', async () => {
        const reader = await ArrowSliceReader.open(PATH);
        const engine = new LocalEngine(reader);
        const order: string[] = [];
        const prof = engine.profile(1, new AbortController().signal).then(() => order.push('profile'));
        await new Promise(r => setTimeout(r, 1));
        const sort = engine.compute({
            sort: { keys: [{ columnIndex: 0, direction: 'asc' }], labelsOnWhenSorted: true },
        }).then(t => { order.push('sort'); engine.discard(t); });
        await Promise.all([prof, sort]);
        expect(order).toEqual(['sort', 'profile']);
        expect(engine.scan.profilePauses).toBeGreaterThan(0);
        await engine.dispose();
        await reader.close();
    });

    test('in process: cancelling a paused profile rejects it with an abort', async () => {
        const reader = await ArrowSliceReader.open(PATH);
        const engine = new LocalEngine(reader);
        engine.priority[0] = 1;
        const ac = new AbortController();
        const p = engine.profile(0, ac.signal).then(() => undefined, e => e);
        await new Promise(r => setTimeout(r, 10));
        ac.abort();
        const err = await p;
        expect(isAbortError(err)).toBe(true);
        await engine.dispose();
        await reader.close();
    });

    test('worker threads: viewport reads are served while a profile runs, and the profile still completes', async () => {
        const engine = await WorkerEngine.start({
            filePath: PATH,
            nrow: NROW,
            readerScript: join(THREADS, 'reader-thread.ts'),
            scanScript: join(THREADS, 'scan-worker.ts'),
        });
        try {
            const ac = new AbortController();
            const prof = engine.profile(2, ac.signal);
            const times: number[] = [];
            for (let i = 0; i < 20; i++) {
                const t0 = performance.now();
                await engine.getRows({ start: i * 1000, end: i * 1000 + 64, columns: [0, 1, 2], viewportGeneration: i + 1 }, 0);
                times.push(performance.now() - t0);
            }
            const p = await prof;
            expect(p.kind).toBe('numeric');
            expect(p.distinct).toEqual({ value: 50, exact: true });
            const vc = await engine.valueCounts(2, 'asc', 5, ac.signal);
            expect(vc.entries.length).toBe(5);
            expect(vc.exact).toBe(true);
            expect(vc.entries[0].count).toBeLessThanOrEqual(vc.entries[4].count);
        } finally {
            await engine.dispose();
        }
    });
});
