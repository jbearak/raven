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
    | { _: 'ts'; v: string }        // ISO-8601 with offset (Z for UTC)
    | { _: 'trunc'; v: string };    // 1 KiB-truncated cell with trailing …

export const TRUNC_LIMIT_BYTES = 1024;

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
    const y = d.getUTCFullYear();
    const m = pad2(d.getUTCMonth() + 1);
    const day = pad2(d.getUTCDate());
    return { _: 'date', v: `${y}-${m}-${day}` };
}

/**
 * Encode a microsecond-precision timestamp.
 *
 * @param us  microseconds since epoch (Arrow's TimestampMicrosecond raw
 *            BigInt64Array value), or null
 * @param tz  IANA timezone or 'UTC'. We currently only render UTC with 'Z';
 *            non-UTC tz strings are appended verbatim — Arrow JS doesn't
 *            ship a timezone library, and v1's R bootstrap normalizes to
 *            UTC anyway.
 */
export function encodeTimestampMicros(us: bigint | null, tz: string): Cell {
    if (us === null) return null;
    const ms = Number(us / 1000n);
    const usRem = Number(us - BigInt(ms) * 1000n);
    const d = new Date(ms);
    const base = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
        `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
    const ms3 = d.getUTCMilliseconds();
    const fractional = ms3 || usRem
        ? `.${pad3(ms3)}${usRem ? pad3(usRem) : ''}`.replace(/0+$/, '').replace(/\.$/, '')
        : '';
    const suffix = tz === 'UTC' ? 'Z' : tz;
    return { _: 'ts', v: `${base}${fractional}${suffix}` };
}

function pad2(n: number): string { return n < 10 ? `0${n}` : `${n}`; }
function pad3(n: number): string {
    return n < 10 ? `00${n}` : n < 100 ? `0${n}` : `${n}`;
}

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
