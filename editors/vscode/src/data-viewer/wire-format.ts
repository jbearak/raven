/**
 * Wire format for cells shipped extension → webview as JSON.
 *
 * Strict JSON cannot represent NaN, ±Inf, dates, or microsecond
 * timestamps directly, so the protocol uses sentinel objects of the
 * form { _: <kind>, v?: <value> }. The decoder side (cell-render.ts)
 * inverts this back to display strings.
 *
 * Dictionary-encoded columns (factors and shipped value-labelled
 * columns) carry a 0-based integer index in row payloads; the dictionary
 * itself is shipped once per panel in the init/replace messages.
 */

export type Cell =
    | null                          // NA / null
    | number                        // valid finite number, OR raw 0-based dict index
    | string                        // utf8 (raw, not factor)
    | boolean
    | { _: 'nan' }
    | { _: 'inf' }
    | { _: '-inf' }
    | { _: 'date'; v: string }      // YYYY-MM-DD
    | { _: 'ts'; ms: number; us: number } // floor(µs/1000) and µs − 1000·ms
    | { _: 'tsx'; s: string }       // timestamp outside the JS Date range
    | { _: 'trunc'; v: string };    // 1 KiB-truncated cell with trailing …

export const TRUNC_LIMIT_BYTES = 1024;

/** A non-finite number inside a JSON message that is not a cell. */
type NonFiniteNumber = { $nf: 'NaN' | 'Inf' | '-Inf' };

/**
 * Deep copy of `value` with every NaN and ±Inf number replaced by a
 * `{ $nf }` sentinel, so it survives the JSON transport (which turns them
 * into `null`). For messages whose number fields can be non-finite:
 * profiles (`mean`, `sd`, quantiles, top values) and value counts. Cells
 * already carry their own sentinels (`{ _: 'inf' }`, …) and pass through
 * unchanged. The webview inverts it with {@link decodeNonFinite}.
 */
export function encodeNonFinite<T>(value: T): T {
    return mapNumbers(value, (x): unknown => (Number.isFinite(x)
        ? x
        : { $nf: Number.isNaN(x) ? 'NaN' : x > 0 ? 'Inf' : '-Inf' } satisfies NonFiniteNumber)) as T;
}

/**
 * {@link encodeNonFinite} when `value` holds a non-finite number, else
 * `value` itself (no copy). For messages whose payload can carry filter
 * values typed or picked by the user (`numCompare` with `Infinity`, a
 * Value Counts selection of `Inf`), sent in either direction, and for the
 * filter state the host and webview persist as JSON.
 */
export function encodeNonFiniteIfAny<T>(value: T): T {
    return hasNonFinite(value) ? encodeNonFinite(value) : value;
}

function hasNonFinite(v: unknown): boolean {
    if (typeof v === 'number') return !Number.isFinite(v);
    if (Array.isArray(v)) return v.some(hasNonFinite);
    if (v !== null && typeof v === 'object') return Object.values(v).some(hasNonFinite);
    return false;
}

/** Inverse of {@link encodeNonFinite}. */
export function decodeNonFinite<T>(value: T): T {
    return mapTree(value) as T;
}

function mapNumbers(v: unknown, f: (x: number) => unknown): unknown {
    if (typeof v === 'number') return f(v);
    if (Array.isArray(v)) return v.map(x => mapNumbers(x, f));
    if (v !== null && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) out[k] = mapNumbers(x, f);
        return out;
    }
    return v;
}

function mapTree(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(mapTree);
    if (v !== null && typeof v === 'object') {
        const nf = (v as Partial<NonFiniteNumber>).$nf;
        if (nf !== undefined && Object.keys(v).length === 1) {
            return nf === 'Inf' ? Infinity : nf === '-Inf' ? -Infinity : NaN;
        }
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) out[k] = mapTree(x);
        return out;
    }
    return v;
}

export function encodeNumber(x: number | null): Cell {
    if (x === null) return null;
    if (Number.isNaN(x)) return { _: 'nan' };
    if (x === Infinity) return { _: 'inf' };
    if (x === -Infinity) return { _: '-inf' };
    return x;
}

export function encodeString(x: string | null): Cell {
    if (x === null) return null;
    if (Buffer.byteLength(x, 'utf8') > TRUNC_LIMIT_BYTES) {
        return { _: 'trunc', v: truncateUtf8(x, TRUNC_LIMIT_BYTES) + '…' };
    }
    return x;
}

export function encodeDate(daysSinceEpoch: number | null): Cell {
    if (daysSinceEpoch === null) return null;
    const ms = daysSinceEpoch * 86_400_000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return { _: 'trunc', v: '<out of range>' };
    const m = pad2(d.getUTCMonth() + 1);
    const day = pad2(d.getUTCDate());
    return { _: 'date', v: `${formatRYear(d.getUTCFullYear())}-${m}-${day}` };
}

/** Largest |µs| a JS `Date` can hold: ±8.64e15 ms, as microseconds. */
const MAX_TS_MICROS = 8_640_000_000_000_000_000n;

/**
 * Encode a microsecond-precision timestamp as `{ms, us}`.
 *
 * `ms = floor(µs / 1000)` and `us = µs − 1000·ms` ∈ [0, 999]. Floor, not
 * truncation, keeps pre-1970 values correct, and both parts are exact
 * doubles across the whole JS `Date` range, unlike raw epoch microseconds
 * (which pass 2^53 around year 2255). The webview formats the instant in
 * the column's zone (see `display-format.ts`); the wire carries no zone.
 *
 * The range check runs on the int64 before decomposition: a value outside
 * ±8.64e18 µs can't be a `Date`, so it travels as `{_: 'tsx', s}` with the
 * exact seconds since 1970 as a decimal string, and renders as
 * `<out of range>`.
 *
 * @param us  microseconds since epoch (Arrow's TimestampMicrosecond raw
 *            BigInt64Array value), or null
 */
export function encodeTimestampMicros(us: bigint | null): Cell {
    if (us === null) return null;
    if (us > MAX_TS_MICROS || us < -MAX_TS_MICROS) {
        return { _: 'tsx', s: microsToSecondsText(us) };
    }
    // BigInt division truncates toward zero; correct to floor division.
    let ms = us / 1000n;
    let rem = us - ms * 1000n;
    if (rem < 0n) { ms -= 1n; rem += 1000n; }
    return { _: 'ts', ms: Number(ms), us: Number(rem) };
}

/** Exact decimal seconds for an int64 microsecond count. */
function microsToSecondsText(us: bigint): string {
    const neg = us < 0n;
    const abs = neg ? -us : us;
    const whole = abs / 1_000_000n;
    const frac = (abs % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
    return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** A year as R's `format()` prints it: at least four digits with a
 *  leading minus counted in the width (`sprintf("%04d")`), astronomical
 *  numbering (year 0 is 1 BC). So -44 → `-044`, 0 → `0000`, 10000 →
 *  `10000`. */
export function formatRYear(year: number): string {
    const digits = String(Math.abs(year));
    return year < 0 ? `-${digits.padStart(3, '0')}` : digits.padStart(4, '0');
}

function pad2(n: number): string { return n < 10 ? `0${n}` : `${n}`; }

/** Truncate a UTF-8 string to at most `maxBytes` of valid UTF-8. */
function truncateUtf8(s: string, maxBytes: number): string {
    const buf = Buffer.from(s, 'utf8');
    if (buf.length <= maxBytes) return s;
    // Drop bytes until the prefix decodes cleanly. Step back at most 3 bytes
    // (max UTF-8 continuation length).
    for (let cut = maxBytes; cut > Math.max(0, maxBytes - 4); cut--) {
        const candidate = buf.subarray(0, cut).toString('utf8');
        if (!candidate.endsWith('�')) return candidate;
    }
    return buf.subarray(0, Math.max(0, maxBytes - 4)).toString('utf8');
}
