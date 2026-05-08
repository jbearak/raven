import { describe, test, expect } from 'bun:test';
import {
    encodeNumber, encodeString, encodeDate, encodeTimestampMicros,
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
    test('UTC microsecond timestamps encode to ISO-8601 with Z', () => {
        const us = BigInt(Date.UTC(2024, 0, 15, 12, 0, 0)) * 1000n;
        const r = encodeTimestampMicros(us, 'UTC') as { _: string; v: string };
        expect(r._).toBe('ts');
        expect(r.v).toBe('2024-01-15T12:00:00Z');
    });
    test('sub-second microseconds are preserved', () => {
        const us = BigInt(Date.UTC(2024, 0, 15, 12, 0, 0)) * 1000n + 123456n;
        const r = encodeTimestampMicros(us, 'UTC') as { _: string; v: string };
        expect(r.v).toBe('2024-01-15T12:00:00.123456Z');
    });
    test('null is null', () => {
        expect(encodeTimestampMicros(null, 'UTC')).toBeNull();
    });
});
