/**
 * The data engine behind one panel's reader: where transforms are
 * computed (the scan worker), where viewport reads are served (the reader
 * thread), and the commit protocol between them
 * ({@link TransformCoordinator}).
 *
 * Two implementations share the same cores (`scan-core.ts`,
 * `reader-core.ts`):
 *   - `WorkerEngine` (`worker-engine.ts`): the extension's engine. The scan
 *     worker and the reader thread are `worker_threads`, so a sort never
 *     blocks the extension host's event loop and scrolling never waits
 *     behind a sort.
 *   - {@link LocalEngine}: the same state machines in process, with an
 *     async hop at every protocol message. Used by headless tests and as
 *     the fallback when the worker bundles aren't on disk.
 */
import type { ArrowSliceReader, GetRowsRequest, GetRowsResponse } from './arrow-reader';
import type { HistogramBin } from './messages';
import type { ColumnProfile, ValueCounts } from './profile';
import { MemoryCounter, PermRegistry } from './perm-buffer';
import { ReaderCore } from './reader-core';
import { ScanCore } from './scan-core';
import type { ComputeOptions, ComputeResult, TransformRequest } from './scan-core';
import { TransformCoordinator } from './transform-coordinator';
import type { Descriptor } from './transform-coordinator';
import type { SortProgress } from './sort';

/** A computed transform, held as a candidate by the scan worker. Carries
 *  one registry reference: pass it to `coordinator.install` or
 *  {@link DataEngine.discard}. */
export type ComputedTransform = Descriptor & {
    sortError?: string;
    filterError?: string;
};

export type EngineComputeOptions = {
    signal?: AbortSignal;
    partial?: boolean;
    onProgress?: SortProgress;
    /** Terminate the worker if the task runs past this. Rejects with a
     *  non-abort error, so the caller rolls back and reports it. */
    deadlineMs?: number;
    /** Cancel by terminating the worker rather than a cooperative flag
     *  (regex filters, which can't check a flag mid-match). */
    terminateOnCancel?: boolean;
};

export type ViewportRequest = Omit<GetRowsRequest, 'permutation'>;

export interface DataEngine {
    readonly coordinator: TransformCoordinator;
    readonly counter: MemoryCounter;
    compute(req: TransformRequest, opts?: EngineComputeOptions): Promise<ComputedTransform>;
    /** Drop a computed transform that won't be installed. */
    discard(t: ComputedTransform): void;
    getRows(req: ViewportRequest, gen: number | undefined): Promise<GetRowsResponse>;
    getCellText(
        row: number, columnIndex: number, maxBytes: number, gen: number | undefined,
    ): Promise<{ text: string | null; truncated: boolean }>;
    nullCounts(signal: AbortSignal, onProgress: (counts: ArrayLike<number>) => void): Promise<ArrayLike<number>>;
    histogram(columnIndex: number, signal: AbortSignal): Promise<HistogramBin[]>;
    /** One column's profile, at the lowest priority: it pauses while
     *  viewport reads or other scans run. */
    profile(columnIndex: number, signal: AbortSignal): Promise<ColumnProfile>;
    valueCounts(
        columnIndex: number, order: 'desc' | 'asc', limit: number, signal: AbortSignal,
    ): Promise<ValueCounts>;
    /** True (once) if the scan worker restarted since the last call, so
     *  its key and rank caches are gone. */
    takeScanRestarted(): boolean;
    dispose(): Promise<void>;
}

/** Yield a macrotask so in-process protocol steps interleave like
 *  messages between threads would. */
const hop = () => new Promise<void>(r => setImmediate(r));

export class LocalEngine implements DataEngine {
    readonly counter = new MemoryCounter();
    readonly coordinator: TransformCoordinator;
    readonly scan: ScanCore;
    readonly readerCore: ReaderCore;
    /** Viewport reads in flight (profiles pause while non-zero). */
    readonly priority = new Int32Array(1);

    constructor(reader: ArrowSliceReader) {
        this.scan = new ScanCore(reader, this.counter, this.priority);
        this.readerCore = new ReaderCore(reader);
        const core = this.readerCore;
        const scan = this.scan;
        this.coordinator = new TransformCoordinator(
            new PermRegistry(this.counter),
            {
                prepare: async (gen, perm) => { await hop(); core.prepare(gen, perm); },
                commit: async (gen) => { await hop(); core.commit(gen); },
                abort: (gen) => core.abort(gen),
                adopted: (gen) => core.adopted(gen),
                releaseAdoptions: () => core.releaseAdoptions(),
            },
            {
                commit: (gen, spec) => scan.commit(gen, spec),
                abort: (gen) => scan.abort(gen),
            },
            reader.nrow,
        );
    }

    async compute(req: TransformRequest, opts: EngineComputeOptions = {}): Promise<ComputedTransform> {
        const gen = this.coordinator.allocGeneration();
        const copts: ComputeOptions = {
            signal: opts.signal,
            partial: opts.partial,
            onProgress: opts.onProgress,
        };
        const r: ComputeResult = await this.scan.compute(gen, req, copts);
        this.coordinator.registry.retain(r.perm);
        return r;
    }

    discard(t: ComputedTransform): void {
        this.scan.abort(t.gen);
        this.coordinator.registry.release(t.perm);
    }

    async getRows(req: ViewportRequest, gen: number | undefined): Promise<GetRowsResponse> {
        this.priority[0]++;
        try {
            return await this.readerCore.getRows(req, gen);
        } finally {
            this.priority[0]--;
        }
    }

    getCellText(row: number, columnIndex: number, maxBytes: number, gen: number | undefined) {
        return this.readerCore.getCellText(row, columnIndex, maxBytes, gen);
    }

    nullCounts(signal: AbortSignal, onProgress: (counts: ArrayLike<number>) => void) {
        return this.scan.nullCounts(signal, onProgress);
    }

    histogram(columnIndex: number, signal: AbortSignal) {
        return this.scan.histogram(columnIndex, signal);
    }

    profile(columnIndex: number, signal: AbortSignal) {
        return this.scan.profile(columnIndex, signal);
    }

    valueCounts(columnIndex: number, order: 'desc' | 'asc', limit: number, signal: AbortSignal) {
        return this.scan.valueCounts(columnIndex, order, limit, signal);
    }

    takeScanRestarted(): boolean { return false; }

    async dispose(): Promise<void> {
        this.coordinator.dispose();
    }
}
