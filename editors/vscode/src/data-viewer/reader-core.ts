/**
 * The reader thread's state: which transform generations it serves, and
 * the viewport reads (row windows, copy rows, cell text) under them.
 *
 * Runs inside the reader thread (`threads/reader-thread.ts`), or in
 * process for headless tests (`engine.ts`'s `LocalEngine`); both drive
 * the same methods.
 *
 * Generations (the commit protocol is described in `transform-coordinator.ts`):
 *   - **Committed** generations are served. Normally one; two during the
 *     adoption interval, when the webview may still be showing N−1 after
 *     `committed N`. Generation 0 is natural order and is committed at
 *     start.
 *   - A **candidate** is prepared but not committed. It is never served:
 *     webview requests name the generation the webview shows, which is
 *     always committed.
 *   - `commit N` swaps the candidate in atomically (one synchronous
 *     method), keeping N−1 until `adopted N` or a release.
 *
 * A request naming a generation the reader doesn't hold is a protocol
 * error ({@link ProtocolError}); the caller logs and drops it.
 */
import type { ArrowSliceReader, GetRowsRequest, GetRowsResponse } from './arrow-reader';

export class ProtocolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ProtocolError';
    }
}

/** Permutation per committed generation; `undefined` ⇔ natural order. */
export type GenerationSeed = { committed: number; live: [number, Uint32Array | undefined][] };

export class ReaderCore {
    private live = new Map<number, Uint32Array | undefined>([[0, undefined]]);
    private committedGen = 0;
    private candidate: { gen: number; perm: Uint32Array | undefined } | undefined;

    constructor(readonly reader: ArrowSliceReader) {}

    get committed(): number { return this.committedGen; }
    get candidateGeneration(): number | undefined { return this.candidate?.gen; }
    /** Committed generations held, ascending. */
    get liveGenerations(): number[] { return [...this.live.keys()].sort((a, b) => a - b); }

    /** Store `perm` as the candidate for `gen`, replacing any older one.
     *  Serving is unchanged. */
    prepare(gen: number, perm: Uint32Array | undefined): void {
        this.candidate = { gen, perm };
    }

    /** Swap the candidate for `gen` in as committed. The previous committed
     *  generation stays live until {@link adopted} or {@link releaseAdoptions}. */
    commit(gen: number): void {
        if (this.candidate?.gen !== gen) {
            throw new ProtocolError(`commit ${gen} without a prepared candidate`);
        }
        this.live.set(gen, this.candidate.perm);
        this.committedGen = gen;
        this.candidate = undefined;
    }

    /** Discard the candidate for `gen`, if it is still the candidate. */
    abort(gen: number): void {
        if (this.candidate?.gen === gen) this.candidate = undefined;
    }

    /** The webview now shows `gen`: drop older committed generations. */
    adopted(gen: number): void {
        if (!this.live.has(gen)) return;
        for (const g of [...this.live.keys()]) if (g < gen) this.live.delete(g);
    }

    /** Keep only the newest committed generation (webview reload, panel
     *  dispose, re-seed). */
    releaseAdoptions(): void {
        for (const g of [...this.live.keys()]) if (g !== this.committedGen) this.live.delete(g);
    }

    /** Replace all state (a restarted reader thread). */
    seed(seed: GenerationSeed): void {
        this.live = new Map(seed.live);
        this.committedGen = seed.committed;
        this.candidate = undefined;
        if (!this.live.has(seed.committed)) this.live.set(seed.committed, undefined);
    }

    /** The permutation for `gen` (`undefined` ⇒ the committed one). */
    permFor(gen: number | undefined): Uint32Array | undefined {
        const g = gen ?? this.committedGen;
        if (!this.live.has(g)) {
            throw new ProtocolError(
                `request for generation ${g}; reader holds ${this.liveGenerations.join(', ')}`,
            );
        }
        return this.live.get(g);
    }

    /** Rows visible under `gen` (all rows for natural order). */
    rowCount(gen: number | undefined): number {
        return this.permFor(gen)?.length ?? this.reader.nrow;
    }

    getRows(
        req: Omit<GetRowsRequest, 'permutation'>,
        gen: number | undefined,
    ): Promise<GetRowsResponse> {
        const permutation = this.permFor(gen);
        // Copy reads pass MAX_SAFE_INTEGER so they're never stale; viewport
        // reads mark themselves the newest, so older ones still in flight
        // stop early.
        if (req.viewportGeneration < Number.MAX_SAFE_INTEGER) {
            this.reader.setLatestViewportGeneration(req.viewportGeneration);
        }
        return this.reader.getRows({ ...req, permutation });
    }

    getCellText(
        row: number,
        columnIndex: number,
        maxBytes: number,
        gen: number | undefined,
    ): Promise<{ text: string | null; truncated: boolean }> {
        return this.reader.getCellText(row, columnIndex, maxBytes, this.permFor(gen));
    }

    getLabels(columnIndex: number, indices: number[]): Promise<Record<number, string>> {
        return this.reader.getLabels(columnIndex, indices);
    }
}
