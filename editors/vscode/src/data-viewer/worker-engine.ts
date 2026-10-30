/**
 * The extension's data engine: a reader thread and a scan worker per
 * panel reader, both `worker_threads` opening their own
 * `ArrowSliceReader` on the file path (a `FileHandle` can't be
 * transferred), so decoding never runs on the extension host thread.
 *
 * Thread lifecycles:
 *   - **Reader thread.** If it exits unexpectedly it is restarted, seeded
 *     with the coordinator's committed generation, the N−1 it retains
 *     during an adoption interval, and any candidate, and every request
 *     still waiting for a reply (gathers, prepare, commit) is re-issued.
 *   - **Scan worker.** A busy worker can't read messages, so a regex
 *     filter (or any task past its deadline) is cancelled by
 *     `worker.terminate()`. The host awaits it, rejects the cancelled
 *     compute (an `AbortError`, or a timeout error for a deadline), starts
 *     a fresh worker seeded from the coordinator's committed record, and
 *     re-issues the histogram and null-count requests that were waiting.
 *     Termination discards the key and rank caches;
 *     {@link WorkerEngine.takeScanRestarted} lets the next sort say so.
 *     Ordinary cancels use the request's shared flag instead.
 */
import { Worker } from 'node:worker_threads';
import type { GetRowsResponse } from './arrow-reader';
import type { HistogramBin } from './messages';
import type { ColumnProfile, ValueCounts } from './profile';
import type { FindQuery } from './find';
import { MemoryCounter, PermRegistry } from './perm-buffer';
import type { ComputeResult, TransformRequest } from './scan-core';
import { TransformCoordinator } from './transform-coordinator';
import type {
    ComputedTransform,
    DataEngine,
    EngineComputeOptions,
    ViewportRequest,
} from './engine';
import type { ReaderRequest, ScanRequest, ThreadInit, ThreadReply } from './threads/protocol';

export type WorkerEngineOptions = {
    filePath: string;
    nrow: number;
    readerScript: string;
    scanScript: string;
    /** Called with a line for the Raven output channel. */
    log?: (line: string) => void;
};

type Pending = {
    msg: { id: number } & Record<string, unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
    onProgress?: (v: unknown) => void;
    /** Re-issue on a restarted thread instead of rejecting. */
    reissue: boolean;
};

/** A request lost to an unexpected thread exit (crash, OOM). */
function restartError(message: string): Error {
    const e = new Error(message);
    e.name = 'WorkerRestartError';
    return e;
}

function abortError(message: string): Error {
    const e = new Error(message);
    e.name = 'AbortError';
    return e;
}

/** One worker thread with request/reply correlation and restart. */
class ThreadClient {
    private worker: Worker | undefined;
    /** Resolves once the current thread opened its file. */
    private started: Promise<void> = Promise.resolve();
    /** Resolves once the current thread is also seeded; callers wait on
     *  this, so nothing reaches a restarted thread before its seed. */
    private ready: Promise<void> = Promise.resolve();
    private readonly pending = new Map<number, Pending>();
    private nextId = 1;
    /** Workers terminated on purpose; their `exit` is not a crash. */
    private readonly retired = new WeakSet<Worker>();
    private disposed = false;
    /** Seeds a fresh thread before re-issued requests run. `call` here
     *  bypasses the seeded gate. */
    onRestart: ((call: (msg: Record<string, unknown>) => Promise<unknown>) => Promise<void>) | undefined;
    /** Requests that should be re-issued after an *unexpected* exit. */
    reissueAllOnCrash = false;
    restarts = 0;

    constructor(
        private readonly script: string,
        private readonly init: ThreadInit,
        private readonly name: string,
        private readonly log: (line: string) => void,
    ) {
        this.start();
    }

    private start(): void {
        const w = new Worker(this.script, { workerData: this.init });
        this.worker = w;
        this.started = new Promise<void>((resolve, reject) => {
            const onMsg = (m: ThreadReply) => {
                if (m.type === 'ready') { w.off('message', onMsg); resolve(); }
                else if (m.type === 'openFailed') { w.off('message', onMsg); reject(new Error(m.error)); }
            };
            w.on('message', onMsg);
        });
        this.started.catch(() => undefined);
        this.ready = this.started;
        w.on('message', (m: ThreadReply) => this.onMessage(m));
        w.on('error', err => this.log(`${this.name} thread error: ${String(err)}`));
        w.on('exit', code => { void this.onExit(w, code); });
    }

    private onMessage(m: ThreadReply): void {
        if (m.type === 'log') { this.log(m.message); return; }
        if (m.type !== 'reply' && m.type !== 'progress') return;
        const p = this.pending.get(m.id);
        if (!p) return; // superseded or re-issued under a new id
        if (m.type === 'progress') { p.onProgress?.(m.value); return; }
        this.pending.delete(m.id);
        if (m.ok) p.resolve(m.value);
        else {
            const e = new Error(m.error.message);
            e.name = m.error.name;
            p.reject(e);
        }
    }

    private async onExit(w: Worker, code: number): Promise<void> {
        if (this.worker !== w || this.disposed || this.retired.has(w)) return;
        this.log(`${this.name} thread exited (${code}); restarting`);
        await this.restartAndReissue(this.reissueAllOnCrash);
    }

    /** Start a fresh thread, seed it, then re-issue or reject waiting
     *  requests. */
    private async restartAndReissue(reissueAll: boolean): Promise<void> {
        const waiting = [...this.pending.values()];
        this.pending.clear();
        this.restarts++;
        this.start();
        const toReissue: Pending[] = [];
        for (const p of waiting) {
            if (reissueAll || p.reissue) toReissue.push(p);
            // Not an AbortError: the panel treats those as a user cancel and
            // skips its rollback and warning paths, which a crash needs.
            else p.reject(restartError(`${this.name} thread restarted`));
        }
        const seeded = (async () => {
            await this.started;
            await this.onRestart?.(msg => this.send0(msg));
        })();
        this.ready = seeded;
        try {
            await seeded;
        } catch (err) {
            for (const p of toReissue) p.reject(err);
            return;
        }
        for (const p of toReissue) {
            const id = this.nextId++;
            p.msg = { ...p.msg, id };
            this.pending.set(id, p);
            this.worker!.postMessage(p.msg);
        }
    }

    async call<T>(
        msg: Record<string, unknown>,
        opts: { onProgress?: (v: unknown) => void; reissue?: boolean; onId?: (id: number) => void } = {},
    ): Promise<T> {
        await this.ready;
        return this.send0<T>(msg, opts);
    }

    /** Post a request on the current thread without waiting for its seed. */
    private send0<T>(
        msg: Record<string, unknown>,
        opts: { onProgress?: (v: unknown) => void; reissue?: boolean; onId?: (id: number) => void } = {},
    ): Promise<T> {
        if (this.disposed) return Promise.reject(abortError(`${this.name} thread disposed`));
        const id = this.nextId++;
        opts.onId?.(id);
        const full = { ...msg, id };
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, {
                msg: full,
                resolve: resolve as (v: unknown) => void,
                reject,
                onProgress: opts.onProgress,
                reissue: opts.reissue ?? false,
            });
            this.worker!.postMessage(full);
        });
    }

    /** One-way message (no reply). */
    send(msg: Record<string, unknown>): void {
        void this.ready.then(() => { if (!this.disposed) this.worker!.postMessage(msg); });
    }

    /** Terminate (awaited), then restart; the waiting request `victim`
     *  is rejected with `reason`, the rest follow their re-issue policy. */
    async terminateAndRestart(victimId: number | undefined, reason: Error): Promise<void> {
        const w = this.worker;
        if (victimId !== undefined) {
            const p = this.pending.get(victimId);
            this.pending.delete(victimId);
            p?.reject(reason);
        }
        if (w) this.retired.add(w);
        // Requests issued while the old thread dies wait for the new one.
        const done = (async () => {
            await w?.terminate();
            if (!this.disposed) await this.restartAndReissue(false);
        })();
        this.ready = done.then(() => undefined, () => undefined);
        await done;
    }

    /** Test hook: kill the thread as if it crashed. */
    async crashForTest(): Promise<void> {
        await this.worker?.terminate();
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        if (this.worker) this.retired.add(this.worker);
        for (const p of this.pending.values()) p.reject(abortError(`${this.name} thread disposed`));
        this.pending.clear();
        await this.worker?.terminate();
    }
}

export class WorkerEngine implements DataEngine {
    readonly counter = new MemoryCounter();
    readonly coordinator: TransformCoordinator;
    readonly reader: ThreadClient;
    readonly scan: ThreadClient;
    private scanRestarted = false;
    /** Viewport reads in flight, shared with the scan worker, whose
     *  profile scans pause while it's non-zero. */
    private readonly prioritySab = new SharedArrayBuffer(4);
    private readonly priority = new Int32Array(this.prioritySab);

    private constructor(opts: WorkerEngineOptions) {
        const log = opts.log ?? (() => {});
        const init: ThreadInit = { filePath: opts.filePath, counter: this.counter.sab };
        this.reader = new ThreadClient(opts.readerScript, init, 'reader', log);
        this.scan = new ThreadClient(opts.scanScript, { ...init, priority: this.prioritySab }, 'scan', log);
        const reader = this.reader;
        const scan = this.scan;
        this.coordinator = new TransformCoordinator(
            new PermRegistry(this.counter),
            {
                prepare: async (gen, perm) => { await reader.call({ op: 'prepare', gen, perm }); },
                commit: async (gen) => { await reader.call({ op: 'commit', gen }); },
                abort: (gen) => reader.send({ op: 'abort', gen } satisfies ReaderRequest),
                adopted: (gen) => reader.send({ op: 'adopted', gen } satisfies ReaderRequest),
                releaseAdoptions: () => reader.send({ op: 'releaseAdoptions' } satisfies ReaderRequest),
            },
            {
                commit: (gen, spec) => scan.send({ op: 'commit', gen, spec } satisfies ScanRequest),
                abort: (gen) => scan.send({ op: 'abort', gen } satisfies ScanRequest),
            },
            opts.nrow,
        );
        // A restarted reader serves exactly what it served before: the
        // committed generation, the retained N−1, and the candidate.
        this.reader.reissueAllOnCrash = true;
        this.reader.onRestart = async (call) => {
            const seed = this.coordinator.readerSeed();
            await call({
                op: 'seed',
                seed: { committed: seed.committed, live: seed.live },
                candidate: seed.candidate,
            });
        };
        this.scan.onRestart = async (call) => {
            this.scanRestarted = true;
            const c = this.coordinator.committed;
            await call({ op: 'seed', gen: c.gen, spec: c.spec });
        };
    }

    /** Start both threads; resolves once both opened the file. */
    static async start(opts: WorkerEngineOptions): Promise<WorkerEngine> {
        const e = new WorkerEngine(opts);
        try {
            await Promise.all([
                e.reader.call({ op: 'seed', seed: { committed: 0, live: [[0, undefined]] } }),
                e.scan.call({ op: 'seed', gen: 0, spec: e.coordinator.committed.spec }),
            ]);
        } catch (err) {
            await e.dispose();
            throw err;
        }
        return e;
    }

    async compute(req: TransformRequest, opts: EngineComputeOptions = {}): Promise<ComputedTransform> {
        const gen = this.coordinator.allocGeneration();
        const cancel = new SharedArrayBuffer(4);
        const flag = new Int32Array(cancel);
        // The compute's request id, once sent: the victim a termination rejects.
        let id: number | undefined;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
            Atomics.store(flag, 0, 1);
            if (opts.terminateOnCancel && id !== undefined) {
                void this.scan.terminateAndRestart(id, abortError('The data-viewer operation was aborted'));
            }
        };
        if (opts.signal?.aborted) throw abortError('The data-viewer operation was aborted');
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        if (opts.deadlineMs !== undefined) {
            deadline = setTimeout(() => {
                void this.scan.terminateAndRestart(
                    id, new Error(`Stopped after ${Math.round(opts.deadlineMs! / 1000)} s`),
                );
            }, opts.deadlineMs);
        }
        try {
            const r = await this.scan.call<ComputeResult>({
                op: 'compute', gen, req, partial: opts.partial ?? false, cancel,
            } satisfies Omit<Extract<ScanRequest, { op: 'compute' }>, 'id'>, {
                onId: i => { id = i; },
                onProgress: v => {
                    const p = v as { phase: 'read' | 'rank' | 'sort'; done: number; total: number };
                    opts.onProgress?.(p.phase, p.done, p.total);
                },
            });
            // The worker added the buffer's bytes to the shared counter;
            // the registry now owns subtracting them.
            this.coordinator.registry.retain(r.perm);
            return r;
        } finally {
            if (deadline) clearTimeout(deadline);
            opts.signal?.removeEventListener('abort', onAbort);
        }
    }

    discard(t: ComputedTransform): void {
        this.scan.send({ op: 'abort', gen: t.gen } satisfies ScanRequest);
        this.coordinator.registry.release(t.perm);
    }

    async getRows(req: ViewportRequest, gen: number | undefined): Promise<GetRowsResponse> {
        Atomics.add(this.priority, 0, 1);
        try {
            return await this.reader.call<GetRowsResponse>({ op: 'getRows', req, gen });
        } finally {
            Atomics.sub(this.priority, 0, 1);
        }
    }

    getCellText(row: number, columnIndex: number, maxBytes: number, gen: number | undefined) {
        return this.reader.call<{ text: string | null; truncated: boolean }>({
            op: 'cellText', row, columnIndex, maxBytes, gen,
        });
    }

    async nullCounts(signal: AbortSignal, onProgress: (counts: ArrayLike<number>) => void) {
        const cancel = new SharedArrayBuffer(4);
        const onAbort = () => Atomics.store(new Int32Array(cancel), 0, 1);
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            return await this.scan.call<number[]>({ op: 'nullCounts', cancel }, {
                onProgress: v => onProgress(v as number[]),
                reissue: true,
            });
        } finally {
            signal.removeEventListener('abort', onAbort);
        }
    }

    async histogram(columnIndex: number, signal: AbortSignal): Promise<HistogramBin[]> {
        const cancel = new SharedArrayBuffer(4);
        const onAbort = () => Atomics.store(new Int32Array(cancel), 0, 1);
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            return await this.scan.call<HistogramBin[]>({ op: 'histogram', columnIndex, cancel }, {
                reissue: true,
            });
        } finally {
            signal.removeEventListener('abort', onAbort);
        }
    }

    /** A cancellable scan-worker request: `signal` sets its shared flag.
     *  Not re-issued after a restart (the caller re-requests it). */
    private async cancellable<T>(msg: Record<string, unknown>, signal: AbortSignal): Promise<T> {
        if (signal.aborted) throw abortError('The data-viewer operation was aborted');
        const cancel = new SharedArrayBuffer(4);
        const onAbort = () => Atomics.store(new Int32Array(cancel), 0, 1);
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            return await this.scan.call<T>({ ...msg, cancel });
        } finally {
            signal.removeEventListener('abort', onAbort);
        }
    }

    profile(columnIndex: number, signal: AbortSignal): Promise<ColumnProfile> {
        return this.cancellable<ColumnProfile>({ op: 'profile', columnIndex }, signal);
    }

    valueCounts(columnIndex: number, order: 'desc' | 'asc', limit: number, signal: AbortSignal): Promise<ValueCounts> {
        return this.cancellable<ValueCounts>({ op: 'valueCounts', columnIndex, order, limit }, signal);
    }

    find(query: FindQuery, perm: Uint32Array | undefined, signal: AbortSignal): Promise<Uint32Array> {
        return this.cancellable<Uint32Array>({ op: 'find', query, perm }, signal);
    }

    takeScanRestarted(): boolean {
        const r = this.scanRestarted;
        this.scanRestarted = false;
        return r;
    }

    async dispose(): Promise<void> {
        this.coordinator.dispose();
        await Promise.all([this.reader.dispose(), this.scan.dispose()]);
    }
}
