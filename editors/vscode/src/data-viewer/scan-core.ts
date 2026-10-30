/**
 * The scan worker's state: sort and filter computation, their caches, and
 * the staged (committed vs candidate) transform state.
 *
 * Runs inside the scan worker (`threads/scan-worker.ts`), or in process
 * for headless tests (`engine.ts`'s `LocalEngine`).
 *
 * Staging. The worker keeps the *committed* transform spec (the sort and
 * filter the reader is serving) apart from *candidate* specs that
 * transforms are building:
 *   - {@link compute} fills in any component the request omits from the
 *     committed spec, so a cancelled filter never leaks into the following
 *     sort: the sort composes with the committed filter.
 *   - `commit N` promotes candidate N (or adopts the spec the host sends,
 *     when the host installed a descriptor the worker didn't compute, such
 *     as a rollback), and `abort N` discards it.
 *   - A restarted worker is {@link seed}ed from the host's record of the
 *     last committed spec before it accepts a transform.
 *
 * Caches. Sort keys are materialized over **all** rows per column and
 * kept ({@link SortKeyCache}); filter masks are kept per entry. So a sort
 * under an active filter sorts only the survivors (#328), and clearing the
 * filter later re-sorts all rows from cached keys without reading the
 * file. Termination discards both caches with the worker.
 *
 * Profiles ({@link profile}, `profile-engine.ts`) run at the lowest
 * priority. Between record batches a profile scan waits while any
 * viewport read is in flight (the host counts them in the shared
 * `priority` cell) or any sort, filter, histogram or null-count scan is
 * running here, so a profile never delays the grid or a transform. The
 * host runs one profile at a time (`profile-scheduler.ts`). Profiles,
 * the 50-bin histograms their second pass produces, and their value
 * counts are cached per column for this reader.
 */
import type { ArrowSliceReader } from './arrow-reader';
import type { FilterEntry, FilterState, HistogramBin, SortState } from './messages';
import { EMPTY_FILTER, EMPTY_SORT } from './messages';
import { computePermutation, SortKeyCache } from './sort';
import type { SortContext, SortProgress } from './sort';
import { computeEntryMask, maskToIndices } from './filter';
import type { FilterContext } from './filter';
import { computeHistogramForColumn } from './histograms';
import { isAbortError, throwIfAborted } from './abort';
import { computeProfile, countValues, valueCountsFrom } from './profile-engine';
import type { CountSummary } from './profile-engine';
import type { ColumnProfile, ValueCounts } from './profile';
import { allocPerm, MemoryCounter, sharePerm } from './perm-buffer';

/** Everything that determines an effective permutation. */
export type TransformSpec = {
    sort: SortState;
    sortCtx: SortContext;
    filter: FilterState;
    filterCtx: FilterContext;
};

/** A compute request: omitted components come from the committed spec. */
export type TransformRequest = Partial<TransformSpec>;

export type ComputeResult = {
    gen: number;
    /** The effective permutation over a `SharedArrayBuffer`, or
     *  `undefined` for natural order. */
    perm: Uint32Array | undefined;
    /** Rows visible under the result. */
    nrowFiltered: number;
    /** The spec actually computed. In partial mode a failed component is
     *  replaced by its empty state. */
    spec: TransformSpec;
    sortError?: string;
    filterError?: string;
};

export type ComputeOptions = {
    signal?: AbortSignal;
    /** Restore mode: a component that fails is dropped and reported in
     *  `sortError`/`filterError` while the other is still composed. An
     *  abort always propagates. */
    partial?: boolean;
    onProgress?: SortProgress;
};

const DEFAULT_CTX = { labelsOn: true, formatOn: true, digits: 3 };

export const EMPTY_SPEC: TransformSpec = {
    sort: EMPTY_SORT,
    sortCtx: DEFAULT_CTX,
    filter: EMPTY_FILTER,
    filterCtx: DEFAULT_CTX,
};

/** Masks kept per entry; each is `nrow` bytes. */
const MASK_CACHE_ENTRIES = 16;
/** Value-count summaries kept (each up to 100k entries). */
const COUNT_CACHE_ENTRIES = 8;
/** How often a paused profile re-checks the priority gate. */
const PAUSE_POLL_MS = 2;

export class ScanCore {
    readonly keys = new SortKeyCache();
    private readonly masks = new Map<string, Uint8Array>();
    private survivors: { key: string; rows: Uint32Array | undefined } | undefined;
    private committedState: { gen: number; spec: TransformSpec } = { gen: 0, spec: EMPTY_SPEC };
    private readonly candidates = new Map<number, TransformSpec>();
    /** Sorts, filters, histograms and null-count scans running here. */
    private highPriority = 0;
    private readonly profiles = new Map<number, ColumnProfile>();
    private readonly histograms = new Map<number, HistogramBin[]>();
    private readonly countSummaries = new Map<number, CountSummary>();
    /** Times a profile scan waited at the priority gate (tests). */
    profilePauses = 0;

    /**
     * @param priority  shared cell the host increments while a viewport
     *                  read is in flight; profiles wait while it's non-zero.
     */
    constructor(
        readonly reader: ArrowSliceReader,
        readonly counter: MemoryCounter,
        private readonly priority?: Int32Array,
    ) {}

    /** Run higher-priority work: profiles pause while it runs. */
    private async urgent<T>(fn: () => Promise<T>): Promise<T> {
        this.highPriority++;
        try {
            return await fn();
        } finally {
            this.highPriority--;
        }
    }

    /** True while a profile scan must wait. */
    get profileGateClosed(): boolean {
        return this.highPriority > 0 || (this.priority !== undefined && Atomics.load(this.priority, 0) > 0);
    }

    private pauseFor(signal?: AbortSignal): () => Promise<void> {
        return async () => {
            while (this.profileGateClosed) {
                this.profilePauses++;
                throwIfAborted(signal);
                await new Promise(r => setTimeout(r, PAUSE_POLL_MS));
            }
        };
    }

    get committed(): { gen: number; spec: TransformSpec } { return this.committedState; }
    get candidateGenerations(): number[] { return [...this.candidates.keys()]; }

    /** Restarted worker: adopt the host's committed record. */
    seed(gen: number, spec: TransformSpec): void {
        this.committedState = { gen, spec };
        this.candidates.clear();
    }

    /** Promote candidate `gen`, or adopt `spec` when the host installed a
     *  descriptor this worker didn't compute. Older candidates are gone. */
    commit(gen: number, spec?: TransformSpec): void {
        const s = this.candidates.get(gen) ?? spec;
        if (s) this.committedState = { gen, spec: s };
        for (const g of [...this.candidates.keys()]) if (g <= gen) this.candidates.delete(g);
    }

    abort(gen: number): void {
        this.candidates.delete(gen);
    }

    /** Compute the effective permutation for `req` (omitted components
     *  from the committed spec) and stage it as candidate `gen`. */
    compute(gen: number, req: TransformRequest, opts: ComputeOptions = {}): Promise<ComputeResult> {
        return this.urgent(() => this.compute0(gen, req, opts));
    }

    private async compute0(gen: number, req: TransformRequest, opts: ComputeOptions): Promise<ComputeResult> {
        const base = this.committedState.spec;
        const spec: TransformSpec = {
            sort: req.sort ?? base.sort,
            sortCtx: req.sortCtx ?? base.sortCtx,
            filter: req.filter ?? base.filter,
            filterCtx: req.filterCtx ?? base.filterCtx,
        };
        let filterError: string | undefined;
        let sortError: string | undefined;

        let rows: Uint32Array | undefined;
        try {
            rows = await this.survivorsFor(spec.filter, spec.filterCtx, opts.signal);
        } catch (err) {
            if (!opts.partial || isAbortError(err)) throw err;
            filterError = errorText(err);
            spec.filter = EMPTY_FILTER;
            rows = undefined;
        }

        let perm: Uint32Array | undefined;
        if (spec.sort.keys.length > 0) {
            try {
                const sorted = await computePermutation(this.reader, spec.sort.keys, {
                    ...spec.sortCtx,
                    stringOrder: spec.sort.stringOrder ?? spec.sortCtx.stringOrder,
                }, {
                    signal: opts.signal,
                    rows,
                    cache: this.keys,
                    onProgress: opts.onProgress,
                });
                perm = sharePerm(sorted, this.counter);
            } catch (err) {
                if (!opts.partial || isAbortError(err)) throw err;
                sortError = errorText(err);
                spec.sort = EMPTY_SORT;
            }
        }
        if (!perm && rows) perm = sharePerm(rows, this.counter);
        this.candidates.set(gen, spec);
        return {
            gen,
            perm,
            nrowFiltered: perm ? perm.length : this.reader.nrow,
            spec,
            sortError,
            filterError,
        };
    }

    /** Surviving rows (ascending) for `filter`, `undefined` when no entry
     *  is enabled. Combines cached per-entry masks. */
    private async survivorsFor(
        filter: FilterState,
        ctx: FilterContext,
        signal?: AbortSignal,
    ): Promise<Uint32Array | undefined> {
        const active = filter.entries.filter(e => e.enabled);
        if (active.length === 0) return undefined;
        const key = JSON.stringify(active.map(e => entryKey(e, ctx)));
        if (this.survivors?.key === key) return this.survivors.rows;
        const nrow = this.reader.nrow;
        let combined: Uint8Array | undefined;
        for (const e of active) {
            const k = entryKey(e, ctx);
            let mask = this.masks.get(k);
            if (!mask) {
                mask = await computeEntryMask(this.reader, e, ctx, { signal });
                this.masks.set(k, mask);
                while (this.masks.size > MASK_CACHE_ENTRIES) {
                    this.masks.delete(this.masks.keys().next().value as string);
                }
            }
            if (!combined) {
                combined = new Uint8Array(mask);
            } else {
                for (let i = 0; i < nrow; i++) combined[i] &= mask[i];
            }
        }
        const rows = maskToIndices(combined!);
        this.survivors = { key, rows };
        return rows;
    }

    nullCounts(
        signal: AbortSignal | undefined,
        onProgress: (counts: Float64Array) => void,
    ): Promise<Float64Array> {
        return this.urgent(() => this.reader.nullCounts({
            signal,
            onProgress: (_done, _total, counts) => onProgress(counts),
        }));
    }

    /** The 50-bin popover histogram, from the cache a profile filled when
     *  there is one. */
    async histogram(columnIndex: number, signal?: AbortSignal): Promise<HistogramBin[]> {
        const hit = this.histograms.get(columnIndex);
        if (hit) return hit;
        const bins = await this.urgent(() => computeHistogramForColumn(this.reader, columnIndex, { signal }));
        this.histograms.set(columnIndex, bins);
        return bins;
    }

    /** One column's profile (cached), at the lowest priority. */
    async profile(columnIndex: number, signal?: AbortSignal): Promise<ColumnProfile> {
        const hit = this.profiles.get(columnIndex);
        if (hit) return hit;
        const col = this.reader.schema.columns[columnIndex];
        const r = await computeProfile(this.reader, columnIndex, {
            signal,
            pause: this.pauseFor(signal),
            sortKey: col ? this.keys.get(`${columnIndex}:number`) : undefined,
        });
        this.profiles.set(columnIndex, r.profile);
        if (r.histogram50 && !this.histograms.has(columnIndex)) this.histograms.set(columnIndex, r.histogram50);
        if (r.counts) this.rememberCounts(r.counts);
        return r.profile;
    }

    /** Value counts for one column, from the profile's count summary when
     *  cached, else a counting scan at profile priority. */
    async valueCounts(
        columnIndex: number,
        order: 'desc' | 'asc',
        limit: number,
        signal?: AbortSignal,
    ): Promise<ValueCounts> {
        let s = this.countSummaries.get(columnIndex);
        if (!s) {
            s = await countValues(this.reader, columnIndex, { signal, pause: this.pauseFor(signal) });
            this.rememberCounts(s);
        }
        return valueCountsFrom(s, order, limit);
    }

    private rememberCounts(s: CountSummary): void {
        this.countSummaries.delete(s.columnIndex);
        this.countSummaries.set(s.columnIndex, s);
        while (this.countSummaries.size > COUNT_CACHE_ENTRIES) {
            this.countSummaries.delete(this.countSummaries.keys().next().value as number);
        }
    }

    /** An identity-free empty permutation (tests). */
    alloc(length: number): Uint32Array {
        return allocPerm(length, this.counter);
    }
}

function entryKey(e: FilterEntry, ctx: FilterContext): string {
    return JSON.stringify([e.columnIndex, e.predicate, e.includeMissing, ctx.labelsOn]);
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** True when a filter spec contains a regex predicate (its evaluation can
 *  run unboundedly inside `RegExp`, so cancelling it terminates the
 *  worker instead of waiting for a cooperative check). */
export function hasRegex(filter: FilterState | undefined): boolean {
    return !!filter?.entries.some(e => e.enabled && e.predicate.kind === 'strRegex');
}
