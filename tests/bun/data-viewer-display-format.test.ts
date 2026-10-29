// Display formatting shared by the grid and TSV copy (display-format.ts):
// NA/NaN, number rules, named source display formats, timestamps, type
// tags, and alignment. Timestamp expectations are R's own output
// (format(x, "%Y-%m-%d %H:%M:%OS6")) for the same instants.
import { describe, expect, test } from 'bun:test';
import type { ColumnSchema } from '../../editors/vscode/src/data-viewer/arrow-reader';
import {
    describeTypeTag,
    displayTypeTag,
    FIGURE_SPACE,
    formatCell,
    formatFullPrecision,
    formatNumber,
    formatTimestamp,
    isRightAligned,
    parseDisplayFormat,
} from '../../editors/vscode/src/data-viewer/display-format';
import { encodeTimestampMicros } from '../../editors/vscode/src/data-viewer/wire-format';

const dbl: ColumnSchema = { name: 'd', arrowType: 'Float64', isInteger: false, dictionaryShipped: false, typeTag: '<dbl>' };
const int: ColumnSchema = { name: 'i', arrowType: 'Int32', isInteger: true, dictionaryShipped: false, typeTag: '<int>' };
const chr: ColumnSchema = { name: 's', arrowType: 'Utf8', isInteger: false, dictionaryShipped: false, typeTag: '<chr>' };
const on = { labelsOn: true, formatOn: true, digits: 3 };
const pad = { ...on, alignPad: true };

function ts(col: Partial<ColumnSchema>): ColumnSchema {
    return { name: 't', arrowType: 'Timestamp<MICROSECOND>', isInteger: false, dictionaryShipped: false, typeTag: '<dttm>', ...col };
}

/** Wire cell for `seconds` since 1970 (exact for these fixtures). */
function tsCell(seconds: number, extraMicros = 0n) {
    return encodeTimestampMicros(BigInt(Math.round(seconds * 1000)) * 1000n + extraMicros);
}

describe('formatCell: missing values', () => {
    test('NA is the literal NA, styled missing; copy keeps an empty field', () => {
        expect(formatCell(null, dbl, undefined, on)).toEqual({ text: 'NA', missing: true, copyText: '' });
        expect(formatCell(null, chr, undefined, on).text).toBe('NA');
    });
    test('NaN stays distinct from NA', () => {
        expect(formatCell({ _: 'nan' }, dbl, undefined, on)).toEqual({ text: 'NaN', missing: true, copyText: 'NaN' });
    });
    test('an empty string prints nothing and is not missing', () => {
        expect(formatCell('', chr, undefined, on)).toEqual({ text: '', missing: false, copyText: '' });
    });
    test('Inf and -Inf', () => {
        expect(formatCell({ _: 'inf' }, dbl, undefined, on).text).toBe('Inf');
        expect(formatCell({ _: '-inf' }, dbl, undefined, on).text).toBe('-Inf');
    });
    test('logicals print as R does', () => {
        expect(formatCell(true, undefined, undefined, on).text).toBe('TRUE');
        expect(formatCell(false, undefined, undefined, on).text).toBe('FALSE');
    });
});

describe('formatCell: numbers', () => {
    test.each([
        [1.23456, '1.235'],
        [1e-10, '1e-10'],
        [1.234e-10, '1.23e-10'],
        [0.0004, '4e-04'],
        [-0.0004, '-4e-04'],
        [0, '0'],
        [1e15, '1e+15'],
        [-2.5e16, '-2.5e+16'],
        [999999999999999.9, '1e+15'],
        [123456.789, '123456.789'],
    ])('Format on, 3 digits: %p → %s', (x, want) => {
        expect(formatCell(x, dbl, undefined, on).text).toBe(want);
    });
    test('whole-number doubles keep their short form, padded to align the decimal point', () => {
        expect(formatCell(5, dbl, undefined, pad).text).toBe(`5${FIGURE_SPACE.repeat(4)}`);
        expect(formatCell(5, dbl, undefined, pad).copyText).toBe('5');
        expect(formatCell(5, dbl, undefined, { ...pad, digits: 0 }).text).toBe('5');
        // Integers aren't padded.
        expect(formatCell(5, int, undefined, pad).text).toBe('5');
    });
    test('Format off prints full precision with R-style exponents', () => {
        expect(formatCell(0.1 + 0.2, dbl, undefined, { ...on, formatOn: false }).text).toBe('0.30000000000000004');
        expect(formatFullPrecision(1e-7)).toBe('1e-07');
        expect(formatFullPrecision(1e21)).toBe('1e+21');
        expect(formatFullPrecision(123456789012)).toBe('123456789012');
    });
    test('integers ignore digits', () => {
        expect(formatCell(42, int, undefined, { ...on, digits: 5 }).text).toBe('42');
    });
});

describe('source display formats', () => {
    const withFmt = (format: string): ColumnSchema => ({ ...dbl, format });
    test.each([
        ['%9.2f', 1234.5, '1234.50'],
        ['%9.2fc', 1234567.891, '1,234,567.89'],
        ['%9.0f', 12.6, '13'],
        ['%-9.0f', 12.4, '12'],
        ['%9.3g', 3.14159, '3.14'],
        ['%9.3g', 1234567, '1230000'],
        ['F8.2', 3.14159, '3.14'],
        ['F8.', 3.6, '4'],
        ['COMMA10.1', 9876543.21, '9,876,543.2'],
        ['DOLLAR10.2', 1234.5, '$1,234.50'],
        ['DOLLAR10.2', -1234.5, '$-1,234.50'],
        ['PCT6.1', 45.25, '45.3%'],
        ['PERCENT6.0', 45, '45%'],
        ['Z5.', 42, '00042'],
        ['Z5.', -42, '-0042'],
    ])('%s: %p → %s', (fmt, x, want) => {
        expect(formatCell(x, withFmt(fmt), undefined, pad).text).toBe(want);
    });
    test('unrecognized formats fall back to the digits dropdown', () => {
        expect(parseDisplayFormat('%10.0g')).toBeUndefined();
        expect(parseDisplayFormat('%tc')).toBeUndefined();
        expect(parseDisplayFormat('E10.3')).toBeUndefined();
        expect(parseDisplayFormat('DATE9.')).toBeUndefined();
        expect(formatCell(1.23456, withFmt('BEST12.'), undefined, on).text).toBe('1.235');
    });
    test('a fixed format still falls back to scientific rather than rounding to zero', () => {
        expect(formatCell(1e-9, withFmt('%9.2f'), undefined, on).text).toBe('1e-09');
    });
    test('Format off ignores the source format', () => {
        expect(formatCell(1234.5, withFmt('DOLLAR10.2'), undefined, { ...on, formatOn: false }).text).toBe('1234.5');
    });
    test('formatNumber with a significant-digit spec on tiny values', () => {
        expect(formatNumber(0.000012345, {
            formatOn: true, digits: 3, isInteger: false, spec: { kind: 'significant', digits: 3 }, alignPad: false,
        })).toBe('1.23e-05');
    });
});

describe('timestamps', () => {
    const ny = ts({ timeZone: 'America/New_York', timeZoneSource: 'column', subsecondDigits: 0 });
    test('non-UTC zones show local clock time, not UTC (DST gap)', () => {
        expect(formatCell(tsCell(1710053999), ny, undefined, on).text).toBe('2024-03-10 01:59:59');
        expect(formatCell(tsCell(1710054000), ny, undefined, on).text).toBe('2024-03-10 03:00:00');
    });
    test('DST overlap: both 01:30s print as R does, with distinct offsets in the tooltip', () => {
        const a = formatCell(tsCell(1730611800), ny, undefined, on);
        const b = formatCell(tsCell(1730615400), ny, undefined, on);
        expect(a.text).toBe('2024-11-03 01:30:00');
        expect(b.text).toBe('2024-11-03 01:30:00');
        expect(a.tooltip).toBe('UTC-04:00');
        expect(b.tooltip).toBe('UTC-05:00');
    });
    test('midnight never prints as 24:00 (hourCycle h23)', () => {
        const utc = ts({ timeZone: 'UTC', subsecondDigits: 0 });
        expect(formatCell(tsCell(Date.UTC(2024, 0, 2) / 1000), utc, undefined, on).text).toBe('2024-01-02 00:00:00');
    });
    test('pre-1970 values with fractional seconds use floor decomposition', () => {
        const utc3 = ts({ timeZone: 'UTC', subsecondDigits: 3 });
        const utc6 = ts({ timeZone: 'UTC', subsecondDigits: 6 });
        expect(formatCell(tsCell(-0.25), utc6, undefined, on).text).toBe('1969-12-31 23:59:59.750000');
        expect(formatCell(encodeTimestampMicros(-1n), utc6, undefined, on).text).toBe('1969-12-31 23:59:59.999999');
        expect(formatCell(encodeTimestampMicros(-1001n), utc3, undefined, on).text).toBe('1969-12-31 23:59:59.998');
    });
    test('fractional digits are fixed per column, not per value', () => {
        const utc3 = ts({ timeZone: 'UTC', subsecondDigits: 3 });
        expect(formatCell(tsCell(0), utc3, undefined, on).text).toBe('1970-01-01 00:00:00.000');
        expect(formatCell(tsCell(0.5), utc3, undefined, on).text).toBe('1970-01-01 00:00:00.500');
    });
    test('microsecond digits 4-6 come from the wire us part', () => {
        const utc6 = ts({ timeZone: 'UTC', subsecondDigits: 6 });
        expect(formatCell(encodeTimestampMicros(123456n), utc6, undefined, on).text).toBe('1970-01-01 00:00:00.123456');
    });
    test.each([
        [-63587160000, '-045-01-02 12:00:00'],
        [-62167176000, '0000-01-01 12:00:00'],
        [-62135553600, '0001-01-01 12:00:00'],
        [253402257600, '9999-12-31 12:00:00'],
        [253402344000, '10000-01-01 12:00:00'],
    ])('years outside 1-9999 match R: %d → %s', (secs, want) => {
        expect(formatCell(tsCell(secs), ts({ timeZone: 'UTC' }), undefined, on).text).toBe(want);
    });
    test('the 9999-12-31 23:59:59.999999 sentinel', () => {
        const us = BigInt(Date.UTC(9999, 11, 31, 23, 59, 59)) * 1000n + 999_999n;
        expect(formatCell(encodeTimestampMicros(us), ts({ timeZone: 'UTC', subsecondDigits: 6 }), undefined, on).text)
            .toBe('9999-12-31 23:59:59.999999');
    });
    test('out-of-range values render <out of range>, styled missing, raw seconds in the tooltip', () => {
        const cell = encodeTimestampMicros(8_640_000_000_000_000_001n);
        const out = formatCell(cell, ts({ timeZone: 'UTC' }), undefined, on);
        expect(out.text).toBe('<out of range>');
        expect(out.missing).toBe(true);
        expect(out.tooltip).toBe('8640000000000.000001 seconds since 1970-01-01 UTC');
    });
    test('a zone Intl rejects falls back to UTC and says so in the tag', () => {
        const bad = ts({ timeZone: 'Not/AZone', timeZoneSource: 'column' });
        expect(formatCell(tsCell(0), bad, undefined, on).text).toBe('1970-01-01 00:00:00');
        expect(displayTypeTag(bad)).toBe('<dttm UTC; "Not/AZone" unrecognized>');
    });
    test('formatTimestamp reports the UTC offset in effect', () => {
        expect(formatTimestamp(0, 0, 'UTC', 0).offset).toBe('UTC+00:00');
        expect(formatTimestamp(Date.UTC(2024, 6, 1), 0, 'Asia/Kolkata', 0).offset).toBe('UTC+05:30');
    });
});

describe('type tags', () => {
    test('dttm carries the display zone and its source', () => {
        expect(displayTypeTag(ts({ timeZone: 'America/New_York', timeZoneSource: 'column' }))).toBe('<dttm America/New_York>');
        expect(displayTypeTag(ts({ timeZone: 'Europe/Paris', timeZoneSource: 'session' }))).toBe('<dttm Europe/Paris>');
        expect(displayTypeTag(ts({ timeZone: 'UTC', timeZoneSource: 'fallback' }))).toBe('<dttm UTC; session zone unknown>');
    });
    test('R tags pass through; files without them derive one from the Arrow type', () => {
        expect(displayTypeTag({ ...dbl, typeTag: '<dbl+lbl>' })).toBe('<dbl+lbl>');
        expect(displayTypeTag({ ...dbl, typeTag: undefined })).toBe('<dbl>');
        expect(displayTypeTag({ ...int, typeTag: undefined })).toBe('<int>');
        expect(displayTypeTag({ name: 'f', arrowType: 'Dictionary<Int32, Utf8>', isInteger: false, dictionaryShipped: true })).toBe('<fct>');
        expect(displayTypeTag({ name: 'b', arrowType: 'Bool', isInteger: false, dictionaryShipped: false })).toBe('<lgl>');
    });
    test.each([
        ['<int>', 'integer'], ['<dbl>', 'double'], ['<chr>', 'character'], ['<lgl>', 'logical'],
        ['<fct>', 'factor'], ['<ord>', 'ordered factor'], ['<date>', 'date'],
        ['<dttm America/New_York>', 'date-time'], ['<drtn secs>', 'duration'], ['<cpl>', 'complex'],
        ['<list>', 'list'], ['<dbl+lbl>', 'labelled double'], ['<int+lbl>', 'labelled integer'],
        ['<chr+lbl>', 'labelled character'],
    ])('%s reads as %s', (tag, words) => {
        expect(describeTypeTag(tag)).toBe(words);
    });
});

describe('alignment', () => {
    test('numbers, dates and times right; text, factors, logicals left', () => {
        expect(isRightAligned(int, true)).toBe(true);
        expect(isRightAligned(dbl, true)).toBe(true);
        expect(isRightAligned({ ...chr, typeTag: '<date>' }, true)).toBe(true);
        expect(isRightAligned(ts({}), true)).toBe(true);
        expect(isRightAligned({ ...chr, typeTag: '<drtn secs>' }, true)).toBe(true);
        expect(isRightAligned(chr, true)).toBe(false);
        expect(isRightAligned({ ...chr, typeTag: '<lgl>' }, true)).toBe(false);
        expect(isRightAligned({ ...int, typeTag: '<fct>' }, true)).toBe(false);
    });
    test('labelled numerics are right-aligned only while Labels is off', () => {
        const lbl = { ...dbl, typeTag: '<dbl+lbl>', valueLabels: { 1: 'lo' } };
        expect(isRightAligned(lbl, true)).toBe(false);
        expect(isRightAligned(lbl, false)).toBe(true);
    });
    test('the rowname column is left-aligned', () => {
        expect(isRightAligned({ ...chr, isRowname: true }, true)).toBe(false);
    });
});


describe('isLabel (labels never overflow to ###)', () => {
    const lbl = { ...dbl, typeTag: '<dbl+lbl>', valueLabels: { 1: '001234567890', 2: 'Strongly agree' } };
    test('a resolved value label is flagged, even when it looks numeric', () => {
        expect(formatCell(1, lbl, undefined, on)).toMatchObject({ text: '001234567890', isLabel: true });
        expect(formatCell(2, lbl, undefined, on)).toMatchObject({ text: 'Strongly agree', isLabel: true });
    });
    test('an unlabelled value, or Labels off, is a number', () => {
        expect(formatCell(3, lbl, undefined, on).isLabel).toBeUndefined();
        expect(formatCell(1, lbl, undefined, { ...on, labelsOn: false }).isLabel).toBeUndefined();
    });
});
