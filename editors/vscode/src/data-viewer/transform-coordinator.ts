/**
 * The host's commit authority for transform generations: the two-phase
 * install of a permutation into the reader thread and the scan worker.
 *
 * States, one meaning each:
 *   - **Committed**: the host's and the reader's state after `committed N`.
 *     {@link TransformCoordinator.committed} is the host's record and the
 *     source of truth (a restarted thread is seeded from it).
 *   - **Shown**: the generation the webview's requests name. It switches
 *     from N−1 to N when the webview processes the announcement for N, and
 *     the webview reports that switch with `adopted N`.
 *   - **Candidate**: prepared but not committed. Never served.
 *
 * Install of N ({@link TransformCoordinator.install}):
 *   1. `prepare N` to the reader, which stores the candidate and keeps
 *      serving N−1, and acks `prepared N`.
 *   2. Wait until the webview has adopted the current committed generation
 *      (or adoption was released). So at most two committed generations
 *      are live (the shown one and the one being adopted), plus one
 *      candidate.
 *   3. Unless cancelled or superseded (`shouldAbort`), `commit N` to the
 *      scan worker and the reader. Sending commit is the point of no
 *      return: a cancel after it is a no-op. Otherwise `abort N`, and the
 *      reader, never having stopped, keeps serving N−1.
 *   4. After `committed N` the caller announces N to the webview. The
 *      reader keeps N−1 until `adopted N` (the adoption interval), because
 *      the screen still shows N−1 until the webview processes the
 *      announcement.
 *
 * Installs are serialized. A paint or revert passes `preempt`, which
 * aborts any install still waiting to commit instead of queueing behind
 * work it will overwrite.
 *
 * Buffers: every descriptor handed to `install` carries one
 * {@link PermRegistry} reference, owned by the install. On commit it
 * becomes the committed generation's reference; on abort it is released.
 * The reference for N−1 is released at `adopted N`.
 *
 * A webview reload, panel dispose, or reader re-seed calls
 * {@link TransformCoordinator.releaseAdoptions} before its own install, so
 * that install never waits on an ack that can't come. An ack still
 * missing after {@link ADOPTION_TIMEOUT_MS} is reported through
 * `onAdoptionTimeout` and released.
 */
import type { TransformSpec } from './scan-core';
import { EMPTY_SPEC } from './scan-core';
import type { GenerationSeed } from './reader-core';
import { PermRegistry } from './perm-buffer';

export const ADOPTION_TIMEOUT_MS = 5000;

/** One transform generation: its effective permutation and the sort and
 *  filter state that produced it. */
export type Descriptor = {
    gen: number;
    perm: Uint32Array | undefined;
    nrowFiltered: number;
    spec: TransformSpec;
};

export interface ReaderPort {
    /** Resolves on `prepared gen`. */
    prepare(gen: number, perm: Uint32Array | undefined): Promise<void>;
    /** Resolves on `committed gen`. */
    commit(gen: number): Promise<void>;
    abort(gen: number): void;
    adopted(gen: number): void;
    releaseAdoptions(): void;
}

export interface ScanPort {
    commit(gen: number, spec: TransformSpec): void;
    abort(gen: number): void;
}

type PendingInstall = { gen: number; aborted: boolean; wake: () => void };

/** Transform generations are unique across every coordinator in the
 *  process, so a late `adopted` ack from a replaced dataset's engine can
 *  never match a generation of the new one. 0 is natural order at start. */
let nextGeneration = 1;

export class TransformCoordinator {
    private committedDesc: Descriptor;
    private retained: Descriptor | undefined;
    private awaiting: { gen: number; waiters: (() => void)[]; timer: ReturnType<typeof setTimeout> | undefined } | undefined;
    private candidateDesc: Descriptor | undefined;
    private mutex: Promise<void> = Promise.resolve();
    private readonly pending = new Set<PendingInstall>();
    private disposed = false;
    /** True when the webview acks announcements with `adopted`. A webview
     *  that doesn't (tests' fakes) never makes an install wait. */
    adoptionRequired = false;
    adoptionTimeoutMs = ADOPTION_TIMEOUT_MS;
    /** Called when an `adopted` ack is missing past the timeout. */
    onAdoptionTimeout: ((gen: number) => void) | undefined;

    constructor(
        readonly registry: PermRegistry,
        private readonly reader: ReaderPort,
        private readonly scan: ScanPort,
        nrow: number,
    ) {
        this.committedDesc = { gen: 0, perm: undefined, nrowFiltered: nrow, spec: EMPTY_SPEC };
    }

    get committed(): Descriptor { return this.committedDesc; }
    /** The committed generation the webview may still be showing. */
    get retainedGeneration(): number | undefined { return this.retained?.gen; }
    /** The generation waiting for `adopted`, if any. */
    get awaitingAdoption(): number | undefined { return this.awaiting?.gen; }
    get candidate(): Descriptor | undefined { return this.candidateDesc; }

    allocGeneration(): number { return nextGeneration++; }

    /** A descriptor for a buffer some holder already has (a rollback
     *  snapshot, the committed generation), with its own reference. */
    reuse(d: Omit<Descriptor, 'gen'>): Descriptor {
        this.registry.retain(d.perm);
        return { ...d, gen: this.allocGeneration() };
    }

    /**
     * Install `desc` (which carries one registry reference). Resolves
     * true once committed, false if aborted.
     */
    async install(
        desc: Descriptor,
        opts: { shouldAbort?: () => boolean; preempt?: boolean } = {},
    ): Promise<boolean> {
        if (opts.preempt) this.abortPending();
        const me: PendingInstall = { gen: desc.gen, aborted: false, wake: () => {} };
        this.pending.add(me);
        const prev = this.mutex;
        let unlock!: () => void;
        this.mutex = new Promise<void>(r => { unlock = r; });
        await prev;
        const stop = () => this.disposed || me.aborted || (opts.shouldAbort?.() ?? false);
        try {
            if (stop()) return this.abortCandidate(desc, false);
            this.candidateDesc = desc;
            await this.reader.prepare(desc.gen, desc.perm);
            if (this.awaiting) {
                await new Promise<void>(resolve => {
                    me.wake = resolve;
                    this.awaiting?.waiters.push(resolve);
                    if (!this.awaiting) resolve();
                });
            }
            if (stop()) return this.abortCandidate(desc, true);
            // Point of no return.
            this.candidateDesc = undefined;
            this.scan.commit(desc.gen, desc.spec);
            await this.reader.commit(desc.gen);
            const previous = this.committedDesc;
            this.committedDesc = desc;
            if (this.adoptionRequired && !this.disposed) {
                this.retained = previous;
                this.startAwaiting(desc.gen);
            } else {
                this.reader.adopted(desc.gen);
                this.registry.release(previous.perm);
            }
            return true;
        } finally {
            this.pending.delete(me);
            unlock();
        }
    }

    /** Abort every install that hasn't sent commit yet. */
    abortPending(): void {
        for (const p of this.pending) {
            p.aborted = true;
            p.wake();
        }
    }

    /** The webview processed the announcement of `gen`. */
    adopted(gen: number): void {
        if (!this.awaiting || gen < this.awaiting.gen) return;
        this.finishAwaiting(() => this.reader.adopted(gen));
    }

    /** Release every pending adoption: reload, dispose, re-seed. */
    releaseAdoptions(): void {
        this.finishAwaiting(() => this.reader.releaseAdoptions());
    }

    /** State to seed a restarted reader thread with: the committed
     *  generation, the retained N−1 during an adoption interval, and the
     *  candidate being installed. */
    readerSeed(): GenerationSeed & { candidate?: [number, Uint32Array | undefined] } {
        const live: [number, Uint32Array | undefined][] = [];
        if (this.retained) live.push([this.retained.gen, this.retained.perm]);
        live.push([this.committedDesc.gen, this.committedDesc.perm]);
        return {
            committed: this.committedDesc.gen,
            live,
            ...(this.candidateDesc ? { candidate: [this.candidateDesc.gen, this.candidateDesc.perm] } : {}),
        };
    }

    dispose(): void {
        this.disposed = true;
        this.abortPending();
        this.releaseAdoptions();
        this.registry.releaseAll();
    }

    private abortCandidate(desc: Descriptor, prepared: boolean): false {
        if (this.candidateDesc === desc) this.candidateDesc = undefined;
        if (prepared) this.reader.abort(desc.gen);
        this.scan.abort(desc.gen);
        this.registry.release(desc.perm);
        return false;
    }

    private startAwaiting(gen: number): void {
        const timer = this.adoptionTimeoutMs > 0
            ? setTimeout(() => {
                if (this.awaiting?.gen !== gen) return;
                this.releaseAdoptions();
                this.onAdoptionTimeout?.(gen);
            }, this.adoptionTimeoutMs)
            : undefined;
        (timer as { unref?: () => void } | undefined)?.unref?.();
        this.awaiting = { gen, waiters: [], timer };
    }

    private finishAwaiting(tellReader: () => void): void {
        const a = this.awaiting;
        this.awaiting = undefined;
        if (a?.timer) clearTimeout(a.timer);
        tellReader();
        if (this.retained) {
            this.registry.release(this.retained.perm);
            this.retained = undefined;
        }
        for (const w of a?.waiters ?? []) w();
    }
}
