/**
 * Stable radix passes and string ranking for the data-viewer sort engine
 * (`sort.ts`). Everything here is synchronous and allocation-bounded; it
 * runs in the scan worker.
 *
 * Invariants:
 *   - **Stable.** Every pass is a counting sort per digit (LSD), which is
 *     stable, over the *current* permutation. So ties keep the order the
 *     permutation already had, and a multi-key sort is a sequence of
 *     passes from the last key to the first.
 *   - **Missing values never enter the bit encoding.** Rows are split into
 *     value, NaN and NA buckets first (by the key's `cls` byte); only the
 *     value bucket is radix-sorted, and the buckets are concatenated as
 *     value, NaN, NA in both directions.
 *   - **Descending complements the key bits**; the permutation is never
 *     reversed (that would reverse tie order).
 *   - **`-0` is normalized to `+0`** before encoding, so R-equal values tie.
 *   - **Cancellation** is checked every {@link CANCEL_STRIDE} elements
 *     processed and every {@link CANCEL_STRIDE} comparisons inside a
 *     ranking sort, through the caller's `check` callback (which throws).
 */

/** Elements (or comparisons) between cancellation checks. */
export const CANCEL_STRIDE = 65_536;

/** Bucket class per row: present value, NaN, or NA. */
export const CLS_VALUE = 0;
export const CLS_NAN = 1;
export const CLS_NA = 2;

/** Throws to cancel; called every {@link CANCEL_STRIDE} units of work. */
export type CancelCheck = () => void;

/**
 * An order-preserving unsigned key per row, as two 32-bit halves
 * (`hi` most significant). Comparing `(hi, lo)` as unsigned integers
 * orders rows like the source values. `lo` is absent for 32-bit keys.
 */
export type EncodedKey = {
    hi: Uint32Array;
    lo?: Uint32Array;
    /** Per-row {@link CLS_VALUE} / {@link CLS_NAN} / {@link CLS_NA}. */
    cls: Uint8Array;
};

const F64 = new Float64Array(1);
const F64_U32 = new Uint32Array(F64.buffer);
// Little-endian hosts only (every platform VS Code ships on).
const LO = 0;
const HI = 1;

/** Encode doubles to order-preserving 64-bit keys. Callers mark NaN and
 *  NA rows in `cls`; their slots are left as zero. */
export function encodeFloat64(values: Float64Array, cls: Uint8Array): EncodedKey {
    const n = values.length;
    const hi = new Uint32Array(n);
    const lo = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
        if (cls[i] !== CLS_VALUE) continue;
        let v = values[i];
        if (v === 0) v = 0; // -0 → +0
        F64[0] = v;
        let h = F64_U32[HI];
        let l = F64_U32[LO];
        if (h & 0x80000000) {
            h = ~h >>> 0;
            l = ~l >>> 0;
        } else {
            h = (h | 0x80000000) >>> 0;
        }
        hi[i] = h;
        lo[i] = l;
    }
    return { hi, lo, cls };
}

/** Encode 64-bit integers (signed or unsigned) to order-preserving keys. */
export function encodeBigInt64(
    values: BigInt64Array | BigUint64Array,
    cls: Uint8Array,
    signed: boolean,
): EncodedKey {
    const n = values.length;
    const hi = new Uint32Array(n);
    const lo = new Uint32Array(n);
    const view = new Uint32Array(values.buffer, values.byteOffset, n * 2);
    for (let i = 0; i < n; i++) {
        if (cls[i] !== CLS_VALUE) continue;
        lo[i] = view[2 * i + LO];
        hi[i] = signed ? (view[2 * i + HI] ^ 0x80000000) >>> 0 : view[2 * i + HI];
    }
    return { hi, lo, cls };
}

/** Ranks are already order-preserving unsigned 32-bit keys. */
export function encodeRanks(ranks: Uint32Array, cls: Uint8Array): EncodedKey {
    return { hi: ranks, cls };
}

/**
 * Stable sort of `perm` (row ids) by one encoded key, NA-last. Returns a
 * new array of the same length; `perm` is not modified.
 */
export function radixSortByKey(
    perm: Uint32Array,
    key: EncodedKey,
    descending: boolean,
    check: CancelCheck,
): Uint32Array {
    const n = perm.length;
    let nValue = 0;
    let nNaN = 0;
    for (let i = 0; i < n; i++) {
        const c = key.cls[perm[i]];
        if (c === CLS_VALUE) nValue++;
        else if (c === CLS_NAN) nNaN++;
    }
    const out = new Uint32Array(n);
    let values: Uint32Array = new Uint32Array(nValue);
    let vi = 0;
    let nanAt = nValue;
    let naAt = nValue + nNaN;
    for (let i = 0; i < n; i++) {
        const r = perm[i];
        const c = key.cls[r];
        if (c === CLS_VALUE) values[vi++] = r;
        else if (c === CLS_NAN) out[nanAt++] = r;
        else out[naAt++] = r;
        if ((i & (CANCEL_STRIDE - 1)) === CANCEL_STRIDE - 1) check();
    }
    const flip = descending ? 0xffffffff : 0;
    // LSD: low word first, then high word. 16-bit digits for large inputs
    // (fewer passes), 8-bit for small ones (smaller count tables).
    const digitBits = nValue >= 1 << 16 ? 16 : 8;
    if (key.lo) values = radixWord(values, key.lo, flip, digitBits, check);
    values = radixWord(values, key.hi, flip, digitBits, check);
    out.set(values, 0);
    return out;
}

/** LSD passes over one 32-bit word; passes where every row shares the
 *  digit are skipped. */
function radixWord(
    rows: Uint32Array,
    word: Uint32Array,
    flip: number,
    digitBits: 8 | 16,
    check: CancelCheck,
): Uint32Array {
    const n = rows.length;
    if (n < 2) return rows;
    const radix = 1 << digitBits;
    const mask = radix - 1;
    const counts = new Uint32Array(radix);
    let src: Uint32Array = rows;
    let dst: Uint32Array = new Uint32Array(n);
    let work = 0;
    for (let shift = 0; shift < 32; shift += digitBits) {
        counts.fill(0);
        for (let i = 0; i < n; i++) {
            counts[(((word[src[i]] ^ flip) >>> shift) & mask)]++;
        }
        // A pass where one digit holds every row is a no-op.
        let trivial = false;
        for (let d = 0; d < radix; d++) {
            if (counts[d] === n) { trivial = true; break; }
            if (counts[d] !== 0) break;
        }
        if (trivial) continue;
        let sum = 0;
        for (let d = 0; d < radix; d++) {
            const c = counts[d];
            counts[d] = sum;
            sum += c;
        }
        for (let i = 0; i < n; i++) {
            const r = src[i];
            dst[counts[(((word[r] ^ flip) >>> shift) & mask)]++] = r;
            if (++work === CANCEL_STRIDE) { work = 0; check(); }
        }
        // `rows` is the caller's scratch array, so it can be overwritten.
        const t = src;
        src = dst;
        dst = t;
    }
    return src;
}

/**
 * Compare two strings by Unicode code point (= UTF-8 byte order), the C
 * locale's order. JS `<` compares UTF-16 code units, which puts astral
 * characters (surrogate pairs, 0xD800–0xDFFF) before U+E000–U+FFFF; the
 * first differing code unit is remapped so surrogates sort above them.
 */
export function compareCodePoints(a: string, b: string): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        let x = a.charCodeAt(i);
        let y = b.charCodeAt(i);
        if (x === y) continue;
        if (x >= 0xd800) x += x >= 0xe000 ? -0x800 : 0x2000;
        if (y >= 0xd800) y += y >= 0xe000 ? -0x800 : 0x2000;
        return x - y;
    }
    return a.length - b.length;
}

/**
 * Rank distinct strings: sort them once with `compare` and give each its
 * position, with values `compare` calls equal sharing a rank. Returns the
 * rank of `distinct[i]` at index `i`. `check` runs every
 * {@link CANCEL_STRIDE} comparisons (and may throw out of the sort).
 */
export function rankDistinct(
    distinct: readonly string[],
    compare: (a: string, b: string) => number,
    check: CancelCheck,
): Uint32Array {
    const u = distinct.length;
    const order = new Array<number>(u);
    for (let i = 0; i < u; i++) order[i] = i;
    let calls = 0;
    order.sort((i, j) => {
        if (++calls === CANCEL_STRIDE) { calls = 0; check(); }
        return compare(distinct[i], distinct[j]);
    });
    const ranks = new Uint32Array(u);
    let rank = 0;
    for (let k = 0; k < u; k++) {
        if (k > 0 && compare(distinct[order[k - 1]], distinct[order[k]]) !== 0) rank++;
        ranks[order[k]] = rank;
    }
    return ranks;
}
