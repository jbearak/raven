/**
 * Streaming estimators behind column profiles (`profile-engine.ts`):
 * hashing, a capped exact counter for numbers, HyperLogLog, Space-Saving,
 * and a reservoir sample. Pure code, no Arrow or Node imports, so the
 * tests and the bench drive them directly.
 *
 * Exactness contract (design "Summaries"):
 *   - {@link HyperLogLog} is a set sketch: its registers are a max over
 *     the hashes of the distinct values seen, independent of order and
 *     multiplicity. So a sketch built from an exact distinct set at the
 *     moment the set overflows equals, register for register, a sketch
 *     that ran from row 0. The profile engine relies on that to skip
 *     per-row hashing while the exact set is under its cap.
 *   - {@link SpaceSaving} guarantees, for every monitored value, `count -
 *     error <= true count <= count`, and that any unmonitored value's true
 *     count is at most the smallest counter. {@link SpaceSaving.seed}
 *     starts it from exact counts (error 0) of the stream so far, which
 *     keeps both guarantees for the whole stream from row 0.
 *   - {@link Reservoir} holds every value while fewer than its capacity
 *     have been offered, so quantiles from it are exact in that case and
 *     estimates (marked ≈) beyond it.
 */

const F64 = new Float64Array(1);
const F64_U32 = new Uint32Array(F64.buffer);

function rotl(x: number, r: number): number {
    return (x << r) | (x >>> (32 - r));
}

function fmix32(h: number): number {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}

function mixK(h: number, k: number): number {
    k = Math.imul(k, 0xcc9e2d51);
    k = rotl(k, 15);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = rotl(h, 13);
    return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

/** MurmurHash3 (x86, 32-bit) of a double's 8 bytes. `-0` hashes as `+0`,
 *  so R-equal values collide on purpose. */
export function hashNumber(x: number): number {
    F64[0] = x === 0 ? 0 : x;
    let h = mixK(0x9747b28c, F64_U32[0]);
    h = mixK(h, F64_U32[1]);
    return fmix32(h ^ 8);
}

/** MurmurHash3 (x86, 32-bit) over a string's UTF-16 code units. */
export function hashString(s: string): number {
    let h = 0x9747b28c;
    const n = s.length;
    let i = 0;
    for (; i + 1 < n; i += 2) h = mixK(h, s.charCodeAt(i) | (s.charCodeAt(i + 1) << 16));
    if (i < n) {
        let k = s.charCodeAt(i);
        k = Math.imul(k, 0xcc9e2d51);
        k = rotl(k, 15);
        k = Math.imul(k, 0x1b873593);
        h ^= k;
    }
    return fmix32(h ^ (n * 2));
}

export function hashKey(v: string | number): number {
    return typeof v === 'number' ? hashNumber(v) : hashString(v);
}

/**
 * HyperLogLog with 2^14 registers (standard error ≈ 0.81%), on 32-bit
 * hashes: the top 14 bits pick the register, the leading zeros of the
 * other 18 give the rank. Small cardinalities use linear counting, as in
 * Flajolet et al.
 */
export class HyperLogLog {
    static readonly P = 14;
    readonly registers = new Uint8Array(1 << HyperLogLog.P);

    addHash(h: number): void {
        const idx = h >>> (32 - HyperLogLog.P);
        const w = (h << HyperLogLog.P) >>> 0;
        // Rank: position of the first 1 bit in the remaining 18 bits.
        const rank = w === 0 ? 32 - HyperLogLog.P + 1 : Math.clz32(w) + 1;
        if (rank > this.registers[idx]) this.registers[idx] = rank;
    }

    estimate(): number {
        const m = this.registers.length;
        let sum = 0;
        let zeros = 0;
        for (let j = 0; j < m; j++) {
            const r = this.registers[j];
            sum += 2 ** -r;
            if (r === 0) zeros++;
        }
        const alpha = 0.7213 / (1 + 1.079 / m);
        let e = (alpha * m * m) / sum;
        if (e <= 2.5 * m && zeros > 0) {
            e = m * Math.log(m / zeros);
        } else if (e > 2 ** 32 / 30) {
            e = -(2 ** 32) * Math.log(1 - e / 2 ** 32);
        }
        return Math.round(e);
    }
}

/**
 * Exact counts of distinct doubles, open addressing over the double's
 * bits, up to `cap` distinct values. {@link add} returns `false` once a
 * new value would exceed the cap (the counter then stops accepting new
 * values; existing ones keep counting). NaN must not be added (callers
 * count it separately); `-0` counts as `+0`.
 */
export class NumberCounter {
    private readonly keys: Float64Array;
    private readonly counts: Uint32Array;
    private readonly mask: number;
    size = 0;

    constructor(readonly cap: number) {
        let capacity = 1;
        while (capacity < cap * 2.5) capacity <<= 1;
        this.keys = new Float64Array(capacity);
        this.counts = new Uint32Array(capacity);
        this.mask = capacity - 1;
    }

    add(x: number): boolean {
        if (x === 0) x = 0;
        const keys = this.keys;
        const counts = this.counts;
        let i = hashNumber(x) & this.mask;
        for (;;) {
            const c = counts[i];
            if (c === 0) {
                if (this.size >= this.cap) return false;
                keys[i] = x;
                counts[i] = 1;
                this.size++;
                return true;
            }
            if (keys[i] === x) {
                counts[i] = c + 1;
                return true;
            }
            i = (i + 1) & this.mask;
        }
    }

    *entries(): Generator<[number, number]> {
        for (let i = 0; i < this.counts.length; i++) {
            if (this.counts[i] !== 0) yield [this.keys[i], this.counts[i]];
        }
    }
}

export type CountedValue<K> = { value: K; count: number; error: number };

/**
 * Space-Saving (Metwally, Agrawal and El Abbadi) with `k` counters, kept
 * in a min-heap on count so each update costs O(log k). A new value
 * replaces the smallest counter and inherits its count as its error.
 */
export class SpaceSaving<K extends string | number> {
    private readonly index = new Map<K, number>();
    private readonly heapKeys: K[] = [];
    private readonly heapCounts: number[] = [];
    private readonly heapErrors: number[] = [];

    constructor(readonly k: number) {}

    get size(): number { return this.heapKeys.length; }

    /** Start from exact counts of the stream so far: the `k` largest are
     *  monitored with error 0. Keeps the Space-Saving guarantees (see the
     *  module doc). Call on an empty summary. */
    seed(exact: Iterable<[K, number]>): void {
        const all = [...exact].sort((a, b) => b[1] - a[1]).slice(0, this.k);
        for (const [key, count] of all) this.push(key, count, 0);
    }

    add(key: K, by = 1): void {
        const at = this.index.get(key);
        if (at !== undefined) {
            this.heapCounts[at] += by;
            this.siftDown(at);
            return;
        }
        if (this.heapKeys.length < this.k) {
            this.push(key, by, 0);
            return;
        }
        // Replace the minimum.
        const min = this.heapCounts[0];
        this.index.delete(this.heapKeys[0]);
        this.heapKeys[0] = key;
        this.heapCounts[0] = min + by;
        this.heapErrors[0] = min;
        this.index.set(key, 0);
        this.siftDown(0);
    }

    /** The smallest monitored count: an upper bound on the true count of
     *  every unmonitored value (0 while counters are free). */
    get floor(): number {
        return this.heapKeys.length < this.k ? 0 : this.heapCounts[0];
    }

    /** Monitored values by estimated count, descending (ties by smaller
     *  error first). */
    top(): CountedValue<K>[] {
        const out: CountedValue<K>[] = this.heapKeys.map((value, i) => ({
            value, count: this.heapCounts[i], error: this.heapErrors[i],
        }));
        out.sort((a, b) => b.count - a.count || a.error - b.error);
        return out;
    }

    private push(key: K, count: number, error: number): void {
        const i = this.heapKeys.length;
        this.heapKeys.push(key);
        this.heapCounts.push(count);
        this.heapErrors.push(error);
        this.index.set(key, i);
        this.siftUp(i);
    }

    private swap(a: number, b: number): void {
        const ka = this.heapKeys[a], kb = this.heapKeys[b];
        this.heapKeys[a] = kb; this.heapKeys[b] = ka;
        const ca = this.heapCounts[a]; this.heapCounts[a] = this.heapCounts[b]; this.heapCounts[b] = ca;
        const ea = this.heapErrors[a]; this.heapErrors[a] = this.heapErrors[b]; this.heapErrors[b] = ea;
        this.index.set(kb, a);
        this.index.set(ka, b);
    }

    private siftUp(i: number): void {
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.heapCounts[p] <= this.heapCounts[i]) return;
            this.swap(i, p);
            i = p;
        }
    }

    private siftDown(i: number): void {
        const n = this.heapKeys.length;
        for (;;) {
            const l = 2 * i + 1;
            const r = l + 1;
            let m = i;
            if (l < n && this.heapCounts[l] < this.heapCounts[m]) m = l;
            if (r < n && this.heapCounts[r] < this.heapCounts[m]) m = r;
            if (m === i) return;
            this.swap(i, m);
            i = m;
        }
    }
}

/**
 * Whether the first `n` entries of a count-descending Space-Saving list
 * are guaranteed to rank where they're listed: each one's lower bound
 * (`count - error`) is at least the next entry's upper bound (`count`),
 * and the last listed one's is at least `floor` (the upper bound of every
 * unmonitored value). Equal exact counts are a tie, not a misorder.
 */
export function guaranteedOrder(
    list: readonly { count: number; error: number }[],
    n: number,
    floor: number,
): boolean {
    const m = Math.min(n, list.length);
    for (let i = 0; i < m; i++) {
        const nextUpper = i + 1 < list.length ? list[i + 1].count : floor;
        if (list[i].count - list[i].error < nextUpper) return false;
    }
    return true;
}

/** mulberry32: a small seeded PRNG, so samples are reproducible. */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * A uniform reservoir sample of doubles (Li's Algorithm L: it draws how
 * many values to skip, so most offers cost one comparison).
 */
export class Reservoir {
    readonly values: Float64Array;
    /** Values offered so far. */
    seen = 0;
    private w = 0;
    private next = 0;
    private readonly rand: () => number;

    constructor(readonly capacity: number, seed = 0x5eed) {
        this.values = new Float64Array(capacity);
        this.rand = mulberry32(seed);
    }

    /** True while every offered value is held (quantiles are exact). */
    get complete(): boolean { return this.seen <= this.capacity; }

    add(x: number): void {
        const i = this.seen++;
        const k = this.capacity;
        if (i < k) {
            this.values[i] = x;
            if (i === k - 1) {
                this.w = Math.exp(Math.log(this.rand()) / k);
                this.next = k + Math.floor(Math.log(this.rand()) / Math.log(1 - this.w));
            }
            return;
        }
        if (i !== this.next) return;
        this.values[Math.floor(this.rand() * k)] = x;
        this.w *= Math.exp(Math.log(this.rand()) / k);
        this.next += Math.floor(Math.log(this.rand()) / Math.log(1 - this.w)) + 1;
    }

    /** The held values, sorted ascending. */
    sorted(): Float64Array {
        const n = Math.min(this.seen, this.capacity);
        return this.values.slice(0, n).sort();
    }
}

/** R's default `quantile(type = 7)` of an ascending array. */
export function quantileType7(sorted: ArrayLike<number>, p: number): number {
    const n = sorted.length;
    if (n === 0) return NaN;
    const h = (n - 1) * p;
    const lo = Math.floor(h);
    const hi = Math.min(n - 1, lo + 1);
    // Equal neighbours (including two infinities) need no interpolation.
    if (sorted[lo] === sorted[hi]) return sorted[lo];
    return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}
