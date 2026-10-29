/**
 * Permutation buffers shared between the extension host, the scan worker
 * and the reader thread.
 *
 * Every permutation is a `Uint32Array` over its own `SharedArrayBuffer`,
 * written once by the thread that computes it and **never mutated after
 * it is posted**. Sharing (not transferring) means nothing is detached:
 * all three threads can hold the same immutable buffer.
 *
 * Memory is accounted in one shared counter ({@link MemoryCounter}): the
 * allocating thread adds the bytes with `Atomics.add`, and the host, the
 * commit authority, subtracts them when its {@link PermRegistry} drops the
 * last reference (no committed generation, candidate, or rollback
 * descriptor holds the buffer). The counter is the source of truth for
 * "how much permutation memory is live", which the back-to-back transform
 * tests and the bench assert on.
 */

/** Shared byte counter over a `SharedArrayBuffer` (one `BigInt64`). */
export class MemoryCounter {
    readonly sab: SharedArrayBuffer;
    private readonly cell: BigInt64Array;

    constructor(sab?: SharedArrayBuffer) {
        this.sab = sab ?? new SharedArrayBuffer(8);
        this.cell = new BigInt64Array(this.sab);
    }

    add(bytes: number): void { Atomics.add(this.cell, 0, BigInt(bytes)); }
    sub(bytes: number): void { Atomics.sub(this.cell, 0, BigInt(bytes)); }
    get bytes(): number { return Number(Atomics.load(this.cell, 0)); }
}

/** A permutation of `length` row ids over a fresh `SharedArrayBuffer`,
 *  with its bytes added to `counter`. */
export function allocPerm(length: number, counter: MemoryCounter): Uint32Array {
    const sab = new SharedArrayBuffer(Math.max(4, length * 4));
    counter.add(sab.byteLength);
    return new Uint32Array(sab, 0, length);
}

/** Copy `src` into a new shared permutation buffer. */
export function sharePerm(src: Uint32Array, counter: MemoryCounter): Uint32Array {
    const out = allocPerm(src.length, counter);
    out.set(src);
    return out;
}

/**
 * Host-side reference counts for permutation buffers. A holder (the
 * committed generation, the one retained for the adoption interval, a
 * candidate, a rollback descriptor) retains a buffer while it needs it and
 * releases it after; the last release subtracts the buffer's bytes from
 * the counter. Buffers the counter never saw (a plain `Uint32Array` from a
 * test stub) are tracked but not subtracted.
 */
export class PermRegistry {
    private readonly refs = new Map<ArrayBufferLike, number>();

    constructor(readonly counter: MemoryCounter) {}

    retain(perm: Uint32Array | undefined): void {
        if (!perm) return;
        this.refs.set(perm.buffer, (this.refs.get(perm.buffer) ?? 0) + 1);
    }

    release(perm: Uint32Array | undefined): void {
        if (!perm) return;
        const n = this.refs.get(perm.buffer);
        if (n === undefined) return;
        if (n > 1) {
            this.refs.set(perm.buffer, n - 1);
            return;
        }
        this.refs.delete(perm.buffer);
        if (perm.buffer instanceof SharedArrayBuffer) this.counter.sub(perm.buffer.byteLength);
    }

    /** Number of distinct buffers with at least one holder. */
    get live(): number { return this.refs.size; }

    /** Drop every reference (panel dispose). */
    releaseAll(): void {
        for (const buf of this.refs.keys()) {
            if (buf instanceof SharedArrayBuffer) this.counter.sub(buf.byteLength);
        }
        this.refs.clear();
    }
}
