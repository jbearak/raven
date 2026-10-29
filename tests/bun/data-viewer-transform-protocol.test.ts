/**
 * The transform commit protocol (F4): TransformCoordinator's two-phase
 * install against controllable ports, the reader and scan cores' staged
 * state, and the worker engine's thread lifecycles (scan-worker
 * termination, reader restart and re-seed).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tableFromArrays, tableToIPC } from 'apache-arrow';
import { MemoryCounter, PermRegistry, sharePerm } from '../../editors/vscode/src/data-viewer/perm-buffer';
import { ProtocolError, ReaderCore } from '../../editors/vscode/src/data-viewer/reader-core';
import { EMPTY_SPEC, ScanCore } from '../../editors/vscode/src/data-viewer/scan-core';
import type { TransformSpec } from '../../editors/vscode/src/data-viewer/scan-core';
import { TransformCoordinator } from '../../editors/vscode/src/data-viewer/transform-coordinator';
import type { Descriptor, ReaderPort, ScanPort } from '../../editors/vscode/src/data-viewer/transform-coordinator';
import { LocalEngine } from '../../editors/vscode/src/data-viewer/engine';
import { WorkerEngine } from '../../editors/vscode/src/data-viewer/worker-engine';
import { ArrowSliceReader } from '../../editors/vscode/src/data-viewer/arrow-reader';
import type { FilterState, SortState } from '../../editors/vscode/src/data-viewer/messages';

const ROOT = join(__dirname, '..', '..', 'editors', 'vscode');
const TINY = join(ROOT, 'test-fixtures', 'data-viewer', 'tiny.arrow');
const THREADS = join(ROOT, 'src', 'data-viewer', 'threads');

const SORT_X_DESC: SortState = { keys: [{ columnIndex: 0, direction: 'desc' }], labelsOnWhenSorted: true };
const SORT_X_ASC: SortState = { keys: [{ columnIndex: 0, direction: 'asc' }], labelsOnWhenSorted: true };
const filterXGt = (v: number): FilterState => ({
    entries: [{ id: 'f', columnIndex: 0, predicate: { kind: 'numCompare', op: '>', value: v }, enabled: true, includeMissing: false }],
    labelsOnWhenFiltered: true,
});

/** A deferred promise. */
function deferred<T = void>() {
    let resolve!: (v?: T) => void;
    const promise = new Promise<T | undefined>(r => { resolve = r; });
    return { promise, resolve };
}

/** Ports over a real ReaderCore with a switch to hold acks. */
function harness(nrow = 5) {
    const counter = new MemoryCounter();
    const core = new ReaderCore({ nrow } as any);
    const log: string[] = [];
    let holdPrepared: ReturnType<typeof deferred> | undefined;
    let holdCommitted: ReturnType<typeof deferred> | undefined;
    const reader: ReaderPort = {
        prepare: async (gen, perm) => {
            log.push(`prepare ${gen}`);
            core.prepare(gen, perm);
            if (holdPrepared) await holdPrepared.promise;
        },
        commit: async (gen) => {
            log.push(`commit ${gen}`);
            core.commit(gen);
            if (holdCommitted) await holdCommitted.promise;
        },
        abort: (gen) => { log.push(`abort ${gen}`); core.abort(gen); },
        adopted: (gen) => { log.push(`adopted ${gen}`); core.adopted(gen); },
        releaseAdoptions: () => { log.push('release'); core.releaseAdoptions(); },
    };
    const scanLog: string[] = [];
    const scan: ScanPort = {
        commit: (gen) => scanLog.push(`commit ${gen}`),
        abort: (gen) => scanLog.push(`abort ${gen}`),
    };
    const coordinator = new TransformCoordinator(new PermRegistry(counter), reader, scan, nrow);
    const desc = (values: number[], spec: Partial<TransformSpec> = {}): Descriptor => {
        const perm = sharePerm(Uint32Array.from(values), counter);
        coordinator.registry.retain(perm);
        return { gen: coordinator.allocGeneration(), perm, nrowFiltered: values.length, spec: { ...EMPTY_SPEC, ...spec } };
    };
    return {
        counter, core, log, scanLog, coordinator, desc,
        holdPrepared: () => (holdPrepared = deferred()),
        holdCommitted: () => (holdCommitted = deferred()),
        release: () => { holdPrepared?.resolve(); holdCommitted?.resolve(); holdPrepared = holdCommitted = undefined; },
    };
}

describe('TransformCoordinator: two-phase install', () => {
    test('commit: reader serves the new generation; the old buffer is freed', async () => {
        const h = harness();
        const a = h.desc([4, 3, 2, 1, 0]);
        expect(await h.coordinator.install(a)).toBe(true);
        expect(h.core.committed).toBe(a.gen);
        expect(Array.from(h.core.permFor(a.gen)!)).toEqual([4, 3, 2, 1, 0]);
        const b = h.desc([0, 1]);
        expect(await h.coordinator.install(b)).toBe(true);
        // Only b's buffer is live (no adoption required).
        expect(h.counter.bytes).toBe(8);
        expect(h.scanLog).toEqual([`commit ${a.gen}`, `commit ${b.gen}`]);
    });

    test('cancel before prepare: nothing is sent, the buffer is released', async () => {
        const h = harness();
        const a = h.desc([1, 0]);
        expect(await h.coordinator.install(a, { shouldAbort: () => true })).toBe(false);
        expect(h.log).toEqual([]);
        expect(h.scanLog).toEqual([`abort ${a.gen}`]);
        expect(h.core.committed).toBe(0);
        expect(h.counter.bytes).toBe(0);
    });

    test('cancel between prepared and commit: abort; reader keeps serving N−1', async () => {
        const h = harness();
        const first = h.desc([4, 3, 2, 1, 0]);
        await h.coordinator.install(first);
        const gate = h.holdPrepared();
        let cancelled = false;
        const p = h.coordinator.install(h.desc([0, 1, 2]), { shouldAbort: () => cancelled });
        await Bun.sleep(1);
        expect(h.core.candidateGeneration).toBeDefined();
        cancelled = true;
        gate.resolve();
        expect(await p).toBe(false);
        expect(h.core.candidateGeneration).toBeUndefined();
        expect(h.core.committed).toBe(first.gen);
        expect(h.log.at(-1)).toMatch(/^abort /);
        expect(h.counter.bytes).toBe(20);
    });

    test('cancel after commit was sent is a no-op', async () => {
        const h = harness();
        const gate = h.holdCommitted();
        let cancelled = false;
        const a = h.desc([1, 0]);
        const p = h.coordinator.install(a, { shouldAbort: () => cancelled });
        await Bun.sleep(1);
        expect(h.log).toEqual([`prepare ${a.gen}`, `commit ${a.gen}`]);
        cancelled = true; // lands after the point of no return
        gate.resolve();
        expect(await p).toBe(true);
        expect(h.coordinator.committed).toBe(a);
    });

    test('a late prepared ack for an aborted generation is ignored', () => {
        const core = new ReaderCore({ nrow: 3 } as any);
        core.prepare(7, Uint32Array.from([2, 1, 0]));
        core.abort(7);
        // The superseding candidate arrives; then a late "prepared 7" would
        // not resurrect 7: commit 7 is a protocol error.
        core.prepare(8, Uint32Array.from([0]));
        expect(() => core.commit(7)).toThrow(ProtocolError);
        core.commit(8);
        expect(core.committed).toBe(8);
    });

    test('preempt (a paint) aborts an install still waiting to commit', async () => {
        const h = harness();
        h.coordinator.adoptionRequired = true;
        h.coordinator.adoptionTimeoutMs = 0;
        const a = h.desc([1, 0]);
        await h.coordinator.install(a);
        const b = h.desc([0, 1]);
        const pb = h.coordinator.install(b); // waits for adopted a
        await Bun.sleep(1);
        h.coordinator.releaseAdoptions(); // the paint is a reload
        const paint = h.desc([1]);
        const pPaint = h.coordinator.install(paint, { preempt: true });
        // b was prepared but not committed: the paint aborts it rather than
        // queueing behind work it will overwrite.
        expect(await pb).toBe(false);
        expect(h.log).toContain(`abort ${b.gen}`);
        expect(await pPaint).toBe(true);
        expect(h.coordinator.committed).toBe(paint);
    });
});

describe('TransformCoordinator: adoption interval', () => {
    test('requests name N−1 or N during the interval; others are protocol errors', async () => {
        const h = harness();
        h.coordinator.adoptionRequired = true;
        h.coordinator.adoptionTimeoutMs = 0;
        const a = h.desc([4, 3, 2, 1, 0]);
        await h.coordinator.install(a);
        h.coordinator.adopted(a.gen);
        const b = h.desc([0, 1, 2]);
        await h.coordinator.install(b);
        // Committed b, webview still shows a.
        expect(Array.from(h.core.permFor(a.gen)!)).toEqual([4, 3, 2, 1, 0]);
        expect(Array.from(h.core.permFor(b.gen)!)).toEqual([0, 1, 2]);
        expect(() => h.core.permFor(0)).toThrow(ProtocolError);
        h.coordinator.adopted(b.gen);
        expect(() => h.core.permFor(a.gen)).toThrow(ProtocolError);
        expect(h.core.liveGenerations).toEqual([b.gen]);
    });

    test('back-to-back: commit N+1 waits for adopted N; at most two committed + one candidate live', async () => {
        const h = harness(1000);
        h.coordinator.adoptionRequired = true;
        h.coordinator.adoptionTimeoutMs = 0;
        const n = h.desc(Array.from({ length: 100 }, (_, i) => i));
        await h.coordinator.install(n);
        h.coordinator.adopted(n.gen);
        const n1 = h.desc(Array.from({ length: 100 }, (_, i) => 99 - i));
        await h.coordinator.install(n1); // committed, not adopted
        const n2 = h.desc(Array.from({ length: 100 }, (_, i) => i));
        const p2 = h.coordinator.install(n2);
        await Bun.sleep(5);
        // n2 is only a candidate: commit waits for adopted n1.
        expect(h.log.filter(l => l === `commit ${n2.gen}`)).toEqual([]);
        expect(h.core.candidateGeneration).toBe(n2.gen);
        // Live: n (retained N−1), n1 (committed), n2 (candidate) = 3 buffers.
        expect(h.coordinator.registry.live).toBe(3);
        expect(h.counter.bytes).toBe(3 * 400);
        // Copy during the wait never hangs: both shown generations serve.
        expect(h.core.permFor(n.gen)).toBeDefined();
        expect(h.core.permFor(n1.gen)).toBeDefined();
        h.coordinator.adopted(n1.gen);
        expect(await p2).toBe(true);
        expect(h.coordinator.registry.live).toBe(2); // n1 retained, n2 committed
    });

    test('a reload during the wait releases it before its own install', async () => {
        const h = harness();
        h.coordinator.adoptionRequired = true;
        h.coordinator.adoptionTimeoutMs = 0;
        await h.coordinator.install(h.desc([1, 0]));
        const waiting = h.coordinator.install(h.desc([0, 1]));
        await Bun.sleep(1);
        h.coordinator.releaseAdoptions();
        expect(await waiting).toBe(true);
        expect(h.log).toContain('release');
    });

    test('a missing ack past the timeout is reported and released', async () => {
        const h = harness();
        h.coordinator.adoptionRequired = true;
        h.coordinator.adoptionTimeoutMs = 30;
        const timedOut: number[] = [];
        h.coordinator.onAdoptionTimeout = g => timedOut.push(g);
        const a = h.desc([1, 0]);
        await h.coordinator.install(a);
        const b = h.desc([0, 1]);
        expect(await h.coordinator.install(b)).toBe(true);
        expect(timedOut).toEqual([a.gen]);
    });
});

describe('ScanCore: staged state', () => {
    let reader: ArrowSliceReader | undefined;
    afterEach(async () => { await reader?.close(); reader = undefined; });

    test('cancel a filter, then sort: the sort uses the committed filter', async () => {
        reader = await ArrowSliceReader.open(TINY);
        const core = new ScanCore(reader, new MemoryCounter());
        const f = await core.compute(1, { filter: filterXGt(1) });
        core.commit(1);
        // A second filter is computed but cancelled (aborted).
        await core.compute(2, { filter: filterXGt(3) });
        core.abort(2);
        const s = await core.compute(3, { sort: SORT_X_DESC });
        expect(Array.from(s.perm!)).toEqual([4, 3, 2, 1]); // x > 1, desc
        expect(f.nrowFiltered).toBe(4);
    });

    test('#328: sorting under a filter sorts survivors; clearing the filter re-sorts all rows from cached keys', async () => {
        reader = await ArrowSliceReader.open(TINY);
        const core = new ScanCore(reader, new MemoryCounter());
        await core.compute(1, { filter: filterXGt(2) });
        core.commit(1);
        let reads = 0;
        const orig = (reader as any).getBatch.bind(reader);
        (reader as any).getBatch = (...a: any[]) => { reads++; return orig(...a); };
        const s = await core.compute(2, { sort: SORT_X_DESC });
        core.commit(2);
        expect(Array.from(s.perm!)).toEqual([4, 3, 2]);
        const readsAfterSort = reads;
        const cleared = await core.compute(3, { filter: { entries: [], labelsOnWhenFiltered: true } });
        expect(Array.from(cleared.perm!)).toEqual([4, 3, 2, 1, 0]);
        expect(reads).toBe(readsAfterSort); // no re-read
        const flipped = await core.compute(4, { sort: SORT_X_ASC });
        expect(Array.from(flipped.perm!)).toEqual([2, 3, 4]);
        expect(reads).toBe(readsAfterSort);
    });

    test('a partial (restore) compute keeps the component that succeeded', async () => {
        reader = await ArrowSliceReader.open(TINY);
        const core = new ScanCore(reader, new MemoryCounter());
        const bad: SortState = { keys: [{ columnIndex: 99, direction: 'asc' }], labelsOnWhenSorted: true };
        const r = await core.compute(1, { sort: bad, filter: filterXGt(3) }, { partial: true });
        expect(r.sortError).toBeDefined();
        expect(r.filterError).toBeUndefined();
        expect(Array.from(r.perm!)).toEqual([3, 4]);
        expect(r.spec.sort.keys).toEqual([]);
    });
});

describe('LocalEngine', () => {
    test('compute + install + gather; dispose frees every buffer', async () => {
        const reader = await ArrowSliceReader.open(TINY);
        const engine = new LocalEngine(reader);
        const t = await engine.compute({ sort: SORT_X_DESC });
        expect(await engine.coordinator.install(t)).toBe(true);
        const rows = await engine.getRows({ start: 0, end: 5, columns: [0], viewportGeneration: 1 }, t.gen);
        expect(rows.rows.map(r => r[0])).toEqual([5, 4, 3, 2, 1]);
        expect(engine.counter.bytes).toBe(20);
        await engine.dispose();
        expect(engine.counter.bytes).toBe(0);
        await reader.close();
    });
});

/** A file whose string column makes `^(a+)+$` backtrack for minutes. */
async function catastrophicFixture(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'raven-protocol-'));
    const path = join(dir, 'regex.arrow');
    const s = Array.from({ length: 8 }, () => 'a'.repeat(40) + '!');
    const x = Int32Array.from({ length: 8 }, (_, i) => i + 1);
    await writeFile(path, tableToIPC(tableFromArrays({ x, s }), 'file'));
    return path;
}

describe('WorkerEngine: thread lifecycles', () => {
    let engine: WorkerEngine | undefined;
    afterEach(async () => { await engine?.dispose(); engine = undefined; });

    const start = (filePath: string, nrow: number) => WorkerEngine.start({
        filePath, nrow,
        readerScript: join(THREADS, 'reader-thread.ts'),
        scanScript: join(THREADS, 'scan-worker.ts'),
    });

    test('regex filter cancel terminates the worker; the next transform starts from committed state', async () => {
        const path = await catastrophicFixture();
        engine = await start(path, 8);
        const sorted = await engine.compute({ sort: SORT_X_DESC });
        await engine.coordinator.install(sorted);
        const abort = new AbortController();
        const regex: FilterState = {
            entries: [{ id: 'r', columnIndex: 1, predicate: { kind: 'strRegex', pattern: '^(a+)+$', caseSensitive: true }, enabled: true, includeMissing: false }],
            labelsOnWhenFiltered: true,
        };
        const p = engine.compute({ filter: regex }, { signal: abort.signal, terminateOnCancel: true });
        await Bun.sleep(200); // the worker is now stuck in RegExp
        const t0 = Date.now();
        abort.abort();
        const err = await p.then(() => undefined, e => e);
        expect(err?.name).toBe('AbortError');
        expect(Date.now() - t0).toBeLessThan(5000);
        // The restarted worker was seeded with the committed sort: a filter
        // composes with it (no regex leaked).
        const next = await engine.compute({ filter: filterXGt(5) });
        expect(Array.from(next.perm!)).toEqual([7, 6, 5]);
        expect(engine.takeScanRestarted()).toBe(true);
        engine.discard(next);
    }, 30_000);

    test('a deadline overrun terminates the worker with a non-abort error', async () => {
        const path = await catastrophicFixture();
        engine = await start(path, 8);
        const regex: FilterState = {
            entries: [{ id: 'r', columnIndex: 1, predicate: { kind: 'strRegex', pattern: '^(a+)+$', caseSensitive: true }, enabled: true, includeMissing: false }],
            labelsOnWhenFiltered: true,
        };
        const err = await engine.compute({ filter: regex }, { deadlineMs: 300 }).then(() => undefined, e => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.name).not.toBe('AbortError');
        // Still usable.
        const ok = await engine.compute({ sort: SORT_X_ASC });
        expect(ok.perm!.length).toBe(8);
        engine.discard(ok);
    }, 30_000);

    test('scan worker crash mid-transform rejects it; the next one runs from committed state', async () => {
        engine = await start(TINY, 5);
        const f = await engine.compute({ filter: filterXGt(1) });
        await engine.coordinator.install(f);
        const p = engine.compute({ sort: SORT_X_DESC });
        await engine.scan.crashForTest();
        await p.then(() => undefined, () => undefined);
        const next = await engine.compute({ sort: SORT_X_DESC });
        expect(Array.from(next.perm!)).toEqual([4, 3, 2, 1]);
        engine.discard(next);
    }, 30_000);

    test('reader restart with a committed generation re-seeds and re-serves it', async () => {
        engine = await start(TINY, 5);
        const t = await engine.compute({ sort: SORT_X_DESC });
        await engine.coordinator.install(t);
        await engine.reader.crashForTest();
        const rows = await engine.getRows({ start: 0, end: 5, columns: [0], viewportGeneration: 1 }, t.gen);
        expect(rows.rows.map(r => r[0])).toEqual([5, 4, 3, 2, 1]);
    }, 30_000);

    test('reader restart inside the adoption interval, with a candidate: both shown generations and the candidate survive', async () => {
        engine = await start(TINY, 5);
        const c = engine.coordinator;
        c.adoptionRequired = true;
        c.adoptionTimeoutMs = 0;
        const n = await engine.compute({ sort: SORT_X_DESC });
        await c.install(n);
        c.adopted(n.gen);
        const n1 = await engine.compute({ sort: SORT_X_ASC });
        await c.install(n1); // committed; webview still shows n
        const n2 = await engine.compute({ filter: filterXGt(3) });
        const p2 = c.install(n2); // candidate, waiting for adopted n1
        await Bun.sleep(50);
        await engine.reader.crashForTest();
        // Copy/row requests for what's on screen (n) and what's being
        // adopted (n1) are both served after the restart.
        const onScreen = await engine.getRows({ start: 0, end: 5, columns: [0], viewportGeneration: 2 }, n.gen);
        expect(onScreen.rows.map(r => r[0])).toEqual([5, 4, 3, 2, 1]);
        const adopting = await engine.getRows({ start: 0, end: 5, columns: [0], viewportGeneration: 3 }, n1.gen);
        expect(adopting.rows.map(r => r[0])).toEqual([1, 2, 3, 4, 5]);
        c.adopted(n1.gen);
        expect(await p2).toBe(true);
        const after = await engine.getRows({ start: 0, end: 5, columns: [0], viewportGeneration: 4 }, n2.gen);
        expect(after.rows.map(r => r[0])).toEqual([4, 5]);
    }, 30_000);

    test('a request naming a generation the reader does not hold is a protocol error', async () => {
        engine = await start(TINY, 5);
        const err = await engine.getRows({ start: 0, end: 1, columns: [0], viewportGeneration: 1 }, 123456)
            .then(() => undefined, e => e);
        expect(err?.name).toBe('ProtocolError');
    }, 30_000);
});
