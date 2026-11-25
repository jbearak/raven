/**
 * Host-side scheduling of column profiles for one panel reader.
 *
 * The webview says which columns it is looking at (`setProfileInterest`:
 * the visible columns while the summary band is on, the sidebar's visible
 * rows, an expanded row, an open value-counts popover), minus the ones it
 * already holds. The scheduler:
 *   - runs **one profile at a time**, in interest order, so a sort or
 *     filter never queues behind several scans (and the scan worker
 *     pauses the one that runs while higher-priority work is active);
 *   - **cancels** the running profile when its column leaves the
 *     interest (scrolled away, sidebar closed), and forgets queued ones;
 *   - runs **nothing** while the interest is empty or the panel is
 *     hidden ({@link setActive});
 *   - caches results (ready or failed) for the reader's lifetime, so a
 *     column scrolled back into view, or a reloaded webview, gets its
 *     profile at once;
 *   - **refreshes** a cached profile whose quartiles are sampled when a
 *     sort commits on its column ({@link refresh}): the client never asks
 *     again for a profile it holds, so the replacement is posted
 *     unprompted, after everything the client is waiting for.
 *
 * Every state change is reported through `post` as `[column, state]`,
 * with `null` meaning "no longer pending" (a cancelled column).
 */
import type { ColumnProfile, ProfileState, ProfileUpdate } from './profile';

export type { ProfileUpdate } from './profile';

export type ProfileRunner = (columnIndex: number, signal: AbortSignal) => Promise<ColumnProfile>;

/** A profile whose run was aborted by something other than a cancel (a
 *  scan-worker restart) is retried this many times, then failed. */
const MAX_RESTARTS = 2;

export class ProfileScheduler {
    private wanted: number[] = [];
    private readonly results = new Map<number, ProfileState>();
    /** Columns the client was told are loading. */
    private readonly announced = new Set<number>();
    private readonly restarts = new Map<number, number>();
    /** Columns whose cached profile is to be computed again. */
    private readonly stale = new Set<number>();
    private running: { columnIndex: number; abort: AbortController; refresh: boolean } | undefined;
    private active = true;
    private disposed = false;
    /** Columns started, in order (tests and the bench). */
    readonly started: number[] = [];

    constructor(
        private readonly run: ProfileRunner,
        private readonly post: (updates: ProfileUpdate[]) => void,
        private readonly isAbort: (err: unknown) => boolean,
    ) {}

    get runningColumn(): number | undefined { return this.running?.columnIndex; }

    /** A finished profile (ready or failed), if any. */
    resultFor(columnIndex: number): ProfileState | undefined { return this.results.get(columnIndex); }

    /** The columns the client wants profiled, most wanted first. */
    setInterest(columns: readonly number[]): void {
        if (this.disposed) return;
        const next = [...new Set(columns.filter(c => Number.isInteger(c) && c >= 0))];
        const wanted = new Set(next);
        const updates: ProfileUpdate[] = [];
        for (const c of next) {
            const done = this.results.get(c);
            if (done) {
                updates.push([c, done]);
            } else if (!this.announced.has(c)) {
                this.announced.add(c);
                updates.push([c, { state: 'loading' }]);
            }
        }
        for (const c of [...this.announced]) {
            if (wanted.has(c)) continue;
            this.announced.delete(c);
            updates.push([c, null]);
        }
        this.wanted = next;
        // A refresh doesn't depend on the interest: the client holds the
        // profile it replaces whether or not the column is in view.
        if (this.running && !this.running.refresh && !wanted.has(this.running.columnIndex)) this.running.abort.abort();
        if (updates.length > 0) this.post(updates);
        this.pump();
    }

    /** Pause (hidden panel) or resume. Pausing cancels the running scan;
     *  the interest is kept. */
    setActive(active: boolean): void {
        if (this.active === active) return;
        this.active = active;
        if (!active) this.running?.abort.abort();
        else this.pump();
    }

    /** A new client (webview reload): it holds nothing yet. */
    resetClient(): void {
        this.announced.clear();
        this.wanted = [];
        this.running?.abort.abort();
    }

    /**
     * A sort committed on `columnIndex`: if its cached profile has sampled
     * quartiles, run it again (the scan worker now has the column's sort
     * key, which gives exact ones) and post the result. A profile that is
     * already exact, failed, or not yet computed is left alone.
     */
    refresh(columnIndex: number): void {
        if (this.disposed) return;
        const done = this.results.get(columnIndex);
        if (done?.state !== 'ready' || done.profile.quantiles?.exact !== false) return;
        this.stale.add(columnIndex);
        this.pump();
    }

    /** A cached profile, if any. */
    cached(columnIndex: number): ProfileState | undefined {
        return this.results.get(columnIndex);
    }

    dispose(): void {
        this.disposed = true;
        this.running?.abort.abort();
        this.wanted = [];
    }

    private pump(): void {
        if (this.disposed || !this.active || this.running) return;
        let next = this.wanted.find(c => !this.results.has(c));
        const refresh = next === undefined;
        if (refresh) next = this.stale.values().next().value;
        if (next === undefined) return;
        const columnIndex = next;
        const abort = new AbortController();
        this.running = { columnIndex, abort, refresh };
        this.started.push(columnIndex);
        void this.run(columnIndex, abort.signal).then(
            profile => {
                if (refresh) this.stale.delete(columnIndex);
                // A refresh that is still sampled (the sort key can't give
                // quartiles) is what the client already shows.
                this.finish(columnIndex, abort, { state: 'ready', profile }, refresh && profile.quantiles?.exact === true);
            },
            err => {
                if (refresh) {
                    // Cancelled (hidden panel, reloaded webview): still
                    // stale, so it runs again. Any other failure keeps
                    // the profile the client has.
                    if (!abort.signal.aborted) this.stale.delete(columnIndex);
                    return this.finish(columnIndex, abort, undefined);
                }
                if (abort.signal.aborted) return this.finish(columnIndex, abort, undefined);
                if (this.isAbort(err)) {
                    const n = (this.restarts.get(columnIndex) ?? 0) + 1;
                    this.restarts.set(columnIndex, n);
                    if (n <= MAX_RESTARTS) return this.finish(columnIndex, abort, undefined);
                }
                return this.finish(columnIndex, abort, {
                    state: 'failed',
                    error: err instanceof Error ? err.message : String(err),
                });
            },
        );
    }

    private finish(
        columnIndex: number, abort: AbortController, state: ProfileState | undefined, unprompted = false,
    ): void {
        if (this.running?.abort === abort) this.running = undefined;
        if (this.disposed) return;
        if (state) {
            this.results.set(columnIndex, state);
            if (unprompted || this.announced.delete(columnIndex) || this.wanted.includes(columnIndex)) {
                this.post([[columnIndex, state]]);
            }
        }
        this.pump();
    }
}
