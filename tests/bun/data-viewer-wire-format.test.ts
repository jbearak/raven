import { describe, test, expect } from 'bun:test';
import {
    encodeNumber, encodeString, encodeDate, encodeTimestampMicros, formatRYear,
    TRUNC_LIMIT_BYTES,
} from '../../editors/vscode/src/data-viewer/wire-format';

describe('encodeNumber', () => {
    test('finite numbers pass through', () => {
        expect(encodeNumber(1.5)).toBe(1.5);
        expect(encodeNumber(0)).toBe(0);
        expect(encodeNumber(-42)).toBe(-42);
    });
    test('null is null', () => {
        expect(encodeNumber(null)).toBeNull();
    });
    test('NaN encodes as sentinel', () => {
        expect(encodeNumber(NaN)).toEqual({ _: 'nan' });
    });
    test('Infinity / -Infinity encode as sentinels', () => {
        expect(encodeNumber(Infinity)).toEqual({ _: 'inf' });
        expect(encodeNumber(-Infinity)).toEqual({ _: '-inf' });
    });
});

describe('encodeString', () => {
    test('short strings pass through', () => {
        expect(encodeString('hi')).toBe('hi');
        expect(encodeString('')).toBe('');
    });
    test('null is null', () => {
        expect(encodeString(null)).toBeNull();
    });
    test('strings over 1 KiB are truncated with ellipsis', () => {
        const long = 'x'.repeat(2000);
        const r = encodeString(long) as { _: string; v: string };
        expect(r._).toBe('trunc');
        expect(r.v.endsWith('…')).toBe(true);
        expect(Buffer.byteLength(r.v, 'utf8')).toBeLessThanOrEqual(TRUNC_LIMIT_BYTES + 3);
    });
    test('truncation is UTF-8 safe (no half code points)', () => {
        const emoji = '😀'.repeat(400); // 4 bytes each = 1600 bytes
        const r = encodeString(emoji) as { _: string; v: string };
        expect(r._).toBe('trunc');
        // All complete code points + trailing ellipsis.
        for (const ch of r.v) expect(ch.charCodeAt(0)).not.toBe(0xFFFD);
    });
});

describe('encodeDate', () => {
    test('round-trips a calendar date as YYYY-MM-DD', () => {
        const days = Math.floor(Date.UTC(2024, 0, 15) / 86_400_000);
        expect(encodeDate(days)).toEqual({ _: 'date', v: '2024-01-15' });
    });
    test('null is null', () => {
        expect(encodeDate(null)).toBeNull();
    });
    test('handles dates before 1970', () => {
        const days = Math.floor(Date.UTC(1969, 5, 1) / 86_400_000);
        expect(encodeDate(days)).toEqual({ _: 'date', v: '1969-06-01' });
    });
});

describe('encodeTimestampMicros', () => {
    // Wire value {ms, us}: ms = floor(µs / 1000), us ∈ [0, 999].
    test('decomposes epoch microseconds into {ms, us}', () => {
        const us = BigInt(Date.UTC(2024, 0, 15, 12, 0, 0)) * 1000n + 123456n;
        expect(encodeTimestampMicros(us)).toEqual({ _: 'ts', ms: Date.UTC(2024, 0, 15, 12, 0, 0) + 123, us: 456 });
    });
    test('null is null', () => {
        expect(encodeTimestampMicros(null)).toBeNull();
    });
    test('exact epoch', () => {
        expect(encodeTimestampMicros(0n)).toEqual({ _: 'ts', ms: 0, us: 0 });
    });
    test('pre-epoch values floor, never truncate (remainder stays in [0, 999])', () => {
        expect(encodeTimestampMicros(-1n)).toEqual({ _: 'ts', ms: -1, us: 999 });
        expect(encodeTimestampMicros(-1000n)).toEqual({ _: 'ts', ms: -1, us: 0 });
        expect(encodeTimestampMicros(-1001n)).toEqual({ _: 'ts', ms: -2, us: 999 });
        expect(encodeTimestampMicros(-999001n)).toEqual({ _: 'ts', ms: -1000, us: 999 });
    });
    test('9999-12-31 23:59:59.999999 stays exact', () => {
        const us = BigInt(Date.UTC(9999, 11, 31, 23, 59, 59, 999)) * 1000n + 999n;
        expect(encodeTimestampMicros(us)).toEqual({ _: 'ts', ms: Date.UTC(9999, 11, 31, 23, 59, 59, 999), us: 999 });
    });
    test('range check runs on the int64: ±8.64e15 ms is valid, one µs further is not', () => {
        const edge = 8_640_000_000_000_000_000n;
        expect(encodeTimestampMicros(edge)).toEqual({ _: 'ts', ms: 8.64e15, us: 0 });
        expect(encodeTimestampMicros(-edge)).toEqual({ _: 'ts', ms: -8.64e15, us: 0 });
        expect(encodeTimestampMicros(edge + 1n)).toEqual({ _: 'tsx', s: '8640000000000.000001' });
        expect(encodeTimestampMicros(-edge - 1n)).toEqual({ _: 'tsx', s: '-8640000000000.000001' });
    });
});

describe('formatRYear', () => {
    // R: format(as.Date(...)) / sprintf("%04d")
    test.each([[-44, '-044'], [0, '0000'], [1, '0001'], [9999, '9999'], [10000, '10000'], [-1234, '-1234']])(
        'year %d prints as %s', (y, want) => {
            expect(formatRYear(y)).toBe(want);
        });
    test('dates outside 1-9999 print like R', () => {
        expect(encodeDate(-735963)).toEqual({ _: 'date', v: '-045-01-02' });
        expect(encodeDate(-719528)).toEqual({ _: 'date', v: '0000-01-01' });
        expect(encodeDate(2932897)).toEqual({ _: 'date', v: '10000-01-01' });
    });
});
