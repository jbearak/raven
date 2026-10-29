/**
 * A least-recently-used map bounded by the summed byte size its callers
 * declare per entry, not by entry count. The data viewer's reader keeps
 * projected column chunks and parsed batch headers in these: a chunk's
 * size varies by orders of magnitude with column type and batch geometry,
 * so an entry-count bound can't cap memory.
 *
 * An entry larger than the whole budget is not retained (it would evict
 * everything and then itself).
 */
export class ByteLru<K, V> {
    private readonly map = new Map<K, { value: V; bytes: number }>();
    private total = 0;

    constructor(readonly maxBytes: number) {}

    get size(): number { return this.map.size; }
    get bytes(): number { return this.total; }

    /** Look up and mark as most recently used. */
    get(key: K): V | undefined {
        const e = this.map.get(key);
        if (!e) return undefined;
        this.map.delete(key);
        this.map.set(key, e);
        return e.value;
    }

    set(key: K, value: V, bytes: number): void {
        const prev = this.map.get(key);
        if (prev) {
            this.total -= prev.bytes;
            this.map.delete(key);
        }
        if (bytes > this.maxBytes) return;
        this.map.set(key, { value, bytes });
        this.total += bytes;
        while (this.total > this.maxBytes) {
            const oldest = this.map.keys().next().value as K;
            const e = this.map.get(oldest)!;
            this.map.delete(oldest);
            this.total -= e.bytes;
        }
    }

    clear(): void {
        this.map.clear();
        this.total = 0;
    }
}
