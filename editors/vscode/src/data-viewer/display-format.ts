/**
 * Display formatting for data-viewer cells, shared by the webview grid
 * (`webview/cell-render.ts`) and the host's TSV copy (`tsv.ts`) so what
 * is copied is what was shown. Pure: no DOM, no `vscode`.
 *
 * Invariants:
 *   - NA is never an empty string on screen: it prints the literal `NA`
 *     (styled by the caller). `NaN` stays a distinct wire kind and prints
 *     `NaN`. Copy keeps NA as an empty field.
 *   - A nonzero number never displays as zero: anything that would round
 *     to zero at the column's decimals, or has |x| ≥ 1e15, prints in
 *     scientific with an R-style two-digit exponent (`1.23e-10`).
 *   - Timestamps are formatted from the `{ms, us}` wire value in the
 *     column's zone with one cached `Intl.DateTimeFormat` per zone, never
 *     per cell, with `hourCycle: 'h23'` and fixed fractional digits.
 */

import type { ColumnSchema } from './arrow-reader';
import { formatRYear, type Cell } from './wire-format';

/** Pads a whole number so its decimal point lines up with `x.ddd` in a
 *  monospace font. U+2007 FIGURE SPACE is digit-wide in every font that
 *  has tabular figures. */
export const FIGURE_SPACE = ' ';

/** Text drawn for timestamps outside the JS `Date` range. */
export const OUT_OF_RANGE_TEXT = '<out of range>';

// ---------------------------------------------------------------------
// Source display formats (Stata / SPSS / SAS)
// ---------------------------------------------------------------------

/** A recognized source display format. Anything else falls back to the
 *  toolbar digits. */
export type NumberFormatSpec =
    | {
        kind: 'fixed';
        decimals: number;
        thousands: boolean;
        prefix: string;
        suffix: string;
    }
    | { kind: 'significant'; digits: number }
    | { kind: 'zeroPadded'; width: number };

/**
 * Parse the named subset of display formats the viewer honors:
 *
 *   Stata     `%w.df`, `%w.dfc` (thousands), `%w.0f`, `%w.dg` (d > 0,
 *             significant digits; `%w.0g` means "as needed" and falls back)
 *   SPSS/SAS  `Fw.d`, `COMMAw.d`, `DOLLARw.d` (prefix `$`, thousands),
 *             `PCTw.d` / `PERCENTw.d` (suffix `%`, value unchanged),
 *             `Zw.` (zero-padded integer)
 */
export function parseDisplayFormat(fmt: string | undefined): NumberFormatSpec | undefined {
    if (!fmt) return undefined;
    const t = fmt.trim();
    const stata = /^%-?0?(\d+)\.(\d+)(f|fc|g|gc)$/.exec(t);
    if (stata) {
        const decimals = Number(stata[2]);
        if (stata[3].startsWith('g')) {
            return decimals > 0 ? { kind: 'significant', digits: decimals } : undefined;
        }
        return { kind: 'fixed', decimals, thousands: stata[3] === 'fc', prefix: '', suffix: '' };
    }
    const named = /^([A-Z]*)(\d+)\.(\d*)$/.exec(t.toUpperCase());
    if (!named) return undefined;
    const [, name, width, dec] = named;
    const decimals = dec === '' ? 0 : Number(dec);
    switch (name) {
        case '':
        case 'F':
            return { kind: 'fixed', decimals, thousands: false, prefix: '', suffix: '' };
        case 'COMMA':
            return { kind: 'fixed', decimals, thousands: true, prefix: '', suffix: '' };
        case 'DOLLAR':
            return { kind: 'fixed', decimals, thousands: true, prefix: '$', suffix: '' };
        case 'PCT':
        case 'PERCENT':
            return { kind: 'fixed', decimals, thousands: false, prefix: '', suffix: '%' };
        case 'Z':
            return dec === '' || decimals === 0 ? { kind: 'zeroPadded', width: Number(width) } : undefined;
        default:
            return undefined;
    }
}

// ---------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------

/** R's exponent style: sign always, at least two digits (`1e-07`,
 *  `1.5e+20`). */
function rExponent(s: string): string {
    return s.replace(/e([+-]?)(\d+)$/, (_m, sign: string, digits: string) =>
        `e${sign === '-' ? '-' : '+'}${digits.padStart(2, '0')}`);
}

/** Shortest round-trip text with R-style exponents (Format off). */
export function formatFullPrecision(x: number): string {
    return rExponent(String(x));
}

/** Scientific with `sig` significant digits, trailing mantissa zeros
 *  dropped (`1e+15`, `1.23e-10`). */
export function formatScientific(x: number, sig: number): string {
    const s = x.toExponential(Math.max(0, Math.min(20, sig - 1)));
    const [mant, exp] = s.split('e');
    const trimmed = mant.includes('.') ? mant.replace(/0+$/, '').replace(/\.$/, '') : mant;
    return rExponent(`${trimmed}e${exp}`);
}

/** Decimals a double can actually carry at this magnitude: fixed
 *  notation never prints digits past the 15th significant one (so
 *  `999999999999999.9` doesn't print float noise as `…999.875`). */
function usableDecimals(x: number, decimals: number): number {
    if (x === 0) return decimals;
    const intDigits = Math.floor(Math.log10(Math.abs(x))) + 1;
    return Math.min(decimals, Math.max(0, 15 - intDigits));
}

function needsScientific(x: number, decimals: number): boolean {
    if (x === 0) return false;
    if (Math.abs(x) >= 1e15) return true;
    const rounded = Number(x.toFixed(usableDecimals(x, decimals)));
    return rounded === 0 || Math.abs(rounded) >= 1e15;
}

function withThousands(fixed: string): string {
    const neg = fixed.startsWith('-');
    const body = neg ? fixed.slice(1) : fixed;
    const dot = body.indexOf('.');
    const int = dot < 0 ? body : body.slice(0, dot);
    const frac = dot < 0 ? '' : body.slice(dot);
    return `${neg ? '-' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac}`;
}

export type NumberFormatOptions = {
    formatOn: boolean;
    /** Toolbar digits, used when no source format applies. */
    digits: number;
    /** Integer-typed column (or integer-formatted double). */
    isInteger: boolean;
    spec?: NumberFormatSpec;
    /** Append figure spaces to whole numbers in a decimal column so the
     *  decimal points align. Off for copy. */
    alignPad: boolean;
};

/** Format a finite number for display. */
export function formatNumber(x: number, o: NumberFormatOptions): string {
    if (!o.formatOn) return formatFullPrecision(x);
    const spec = o.spec;
    if (spec?.kind === 'zeroPadded') {
        const r = Math.round(x);
        const digits = String(Math.abs(r)).padStart(Math.max(1, spec.width - (r < 0 ? 1 : 0)), '0');
        return `${r < 0 ? '-' : ''}${digits}`;
    }
    if (spec?.kind === 'significant') {
        if (x !== 0 && (Math.abs(x) >= 1e15 || Math.abs(x) < 1e-4)) return formatScientific(x, spec.digits);
        return formatFullPrecision(Number(x.toPrecision(spec.digits)));
    }
    if (spec?.kind === 'fixed') {
        if (needsScientific(x, spec.decimals)) return formatScientific(x, Math.max(1, spec.decimals));
        const fixed = x.toFixed(usableDecimals(x, spec.decimals));
        return `${spec.prefix}${spec.thousands ? withThousands(fixed) : fixed}${spec.suffix}`;
    }
    if (o.isInteger) return Number.isInteger(x) ? String(x) : formatFullPrecision(x);
    if (needsScientific(x, o.digits)) return formatScientific(x, Math.max(1, o.digits));
    // Whole-number doubles keep their short form (no misleading `5.000`),
    // padded so the decimal point still lines up.
    if (Number.isInteger(x)) {
        return o.alignPad && o.digits > 0 ? String(x) + FIGURE_SPACE.repeat(o.digits + 1) : String(x);
    }
    return x.toFixed(usableDecimals(x, o.digits));
}

// ---------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------

type TimestampFormatter = {
    dtf: Intl.DateTimeFormat;
    zone: string;
    /** True when the requested zone was rejected and UTC is used. */
    unrecognized: boolean;
};

const formatterCache = new Map<string, TimestampFormatter>();

// `fractionalSecondDigits` (ES2021) and `longOffset` (ES2022) postdate the
// TypeScript lib this package targets; every supported runtime has them.
type ModernDateTimeFormatOptions = Omit<Intl.DateTimeFormatOptions, 'timeZoneName'> & {
    fractionalSecondDigits?: 1 | 2 | 3;
    timeZoneName?: 'longOffset';
};

function makeDtf(zone: string): Intl.DateTimeFormat {
    const options: ModernDateTimeFormatOptions = {
        timeZone: zone,
        era: 'short',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
        hourCycle: 'h23',
        timeZoneName: 'longOffset',
    };
    return new Intl.DateTimeFormat('en-US', options as Intl.DateTimeFormatOptions);
}

/** The cached formatter for `zone`; a zone `Intl` rejects (an R alias
 *  like `UTC+3` or `EST5EDT` on some ICU builds) falls back to UTC. */
export function timestampFormatter(zone: string): TimestampFormatter {
    let f = formatterCache.get(zone);
    if (!f) {
        try {
            f = { dtf: makeDtf(zone), zone, unrecognized: false };
        } catch {
            f = { dtf: makeDtf('UTC'), zone: 'UTC', unrecognized: true };
        }
        formatterCache.set(zone, f);
    }
    return f;
}

export type FormattedTimestamp = {
    /** `2024-03-01 09:00:00[.fff[fff]]` in the zone. */
    text: string;
    /** UTC offset in effect, e.g. `UTC-05:00`. */
    offset: string;
};

/**
 * Format an instant (`ms` since epoch plus `us` ∈ [0, 999]) in `zone`
 * with `digits` (0, 3 or 6) fixed fractional-second digits. Years print
 * as R does (`formatRYear`): astronomical numbering, so `Intl`'s BC era
 * year `y` becomes `1 − y`.
 */
export function formatTimestamp(ms: number, us: number, zone: string, digits: number): FormattedTimestamp {
    const f = timestampFormatter(zone);
    const parts: Record<string, string> = {};
    for (const p of f.dtf.formatToParts(new Date(ms))) parts[p.type] = p.value;
    let year = Number(parts.year);
    if (/^B/i.test(parts.era ?? '')) year = 1 - year;
    let text = `${formatRYear(year)}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
    if (digits >= 3) text += `.${parts.fractionalSecond ?? '000'}`;
    if (digits >= 6) text += String(us).padStart(3, '0');
    const gmt = parts.timeZoneName ?? 'GMT';
    const offset = gmt === 'GMT' ? 'UTC+00:00' : gmt.replace(/^GMT/, 'UTC');
    return { text, offset };
}

// ---------------------------------------------------------------------
// Type tags and alignment
// ---------------------------------------------------------------------

/** Header type tag. `<dttm>` gains the display zone (`<dttm UTC>`), and
 *  a zone `Intl` rejects is named (`<dttm UTC; "UTC+3" unrecognized>`).
 *  Files not written by Raven fall back to a tag derived from the Arrow
 *  type. */
export function displayTypeTag(col: ColumnSchema): string {
    const tag = col.typeTag ?? arrowTypeTag(col.arrowType);
    if (tag !== '<dttm>' || !col.timeZone) return tag;
    const f = timestampFormatter(col.timeZone);
    if (f.unrecognized) return `<dttm UTC; "${col.timeZone}" unrecognized>`;
    return col.timeZoneSource === 'fallback'
        ? '<dttm UTC; session zone unknown>'
        : `<dttm ${col.timeZone}>`;
}

function arrowTypeTag(arrowType: string): string {
    if (arrowType.startsWith('Dictionary')) return '<fct>';
    if (/^U?Int\d+$/.test(arrowType)) return '<int>';
    if (arrowType.startsWith('Float')) return '<dbl>';
    if (arrowType === 'Bool') return '<lgl>';
    if (arrowType.startsWith('Date')) return '<date>';
    if (arrowType.startsWith('Timestamp')) return '<dttm>';
    if (arrowType.startsWith('Duration')) return '<drtn>';
    if (arrowType.endsWith('Utf8')) return '<chr>';
    return `<${arrowType.toLowerCase()}>`;
}

/** Long, spoken form of a type tag for accessible names. */
export function describeTypeTag(tag: string): string {
    const base = tag.replace(/^<|>$/g, '').split(/[ ;]/)[0];
    const names: Record<string, string> = {
        int: 'integer', dbl: 'double', chr: 'character', lgl: 'logical',
        fct: 'factor', ord: 'ordered factor', date: 'date', dttm: 'date-time',
        drtn: 'duration', cpl: 'complex', list: 'list',
        'dbl+lbl': 'labelled double', 'int+lbl': 'labelled integer',
        'chr+lbl': 'labelled character',
    };
    return names[base] ?? base;
}

/** True when the column's numbers are drawn as numbers (right-aligned):
 *  int, dbl, Date, POSIXct, difftime, and labelled numerics while Labels
 *  is off. Character, factor, logical, and labelled columns showing
 *  labels are left-aligned, as in pillar. */
export function isRightAligned(col: ColumnSchema, labelsOn: boolean): boolean {
    const tag = col.typeTag ?? arrowTypeTag(col.arrowType);
    if (col.isRowname) return false;
    if (tag === '<fct>' || tag === '<ord>') return !labelsOn;
    if (tag.endsWith('+lbl>')) return !labelsOn && tag !== '<chr+lbl>';
    if (col.valueLabels && labelsOn) return false;
    return /^<(int|dbl|date|dttm|drtn)\b/.test(tag);
}

// ---------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------

export type FormattedCell = {
    /** Text to draw. */
    text: string;
    /** Draw in the missing style (NA, NaN, out-of-range timestamps). */
    missing: boolean;
    /** Text for clipboard copy (no alignment padding; NA is empty). */
    /** The text is a value label shown in place of the value: it clips
     *  like text, never as a numeric `###`, however numeric it looks. */
    isLabel?: true;
    copyText: string;
    /** Extra hover detail (a timestamp's UTC offset, raw seconds). */
    tooltip?: string;
};

export type CellFormatOptions = {
    labelsOn: boolean;
    formatOn: boolean;
    digits: number;
    /** Pad whole numbers for decimal alignment (grid only). */
    alignPad?: boolean;
    /** Label resolved on demand for a non-shipped dictionary index. */
    resolvedLabel?: string;
};

const parsedSpecs = new Map<string, NumberFormatSpec | undefined>();
function specFor(col: ColumnSchema | undefined): NumberFormatSpec | undefined {
    const fmt = col?.format;
    if (!fmt) return undefined;
    if (!parsedSpecs.has(fmt)) parsedSpecs.set(fmt, parseDisplayFormat(fmt));
    return parsedSpecs.get(fmt);
}

/** Whether the column displays through a recognized source format. */
export function usesSourceFormat(col: ColumnSchema): boolean {
    return col.arrowType.startsWith('Float') && specFor(col) !== undefined;
}

/** Inverse of the wire encoders, with Labels / Format applied. */
export function formatCell(
    cell: Cell,
    col: ColumnSchema | undefined,
    dictionary: string[] | undefined,
    o: CellFormatOptions,
): FormattedCell {
    const plain = (text: string): FormattedCell => ({ text, missing: false, copyText: text });
    if (cell === null) return { text: 'NA', missing: true, copyText: '' };
    if (typeof cell === 'object') {
        switch (cell._) {
            case 'nan': return { text: 'NaN', missing: true, copyText: 'NaN' };
            case 'inf': return plain('Inf');
            case '-inf': return plain('-Inf');
            case 'date': return plain(cell.v);
            case 'trunc': return plain(cell.v);
            case 'tsx': return {
                text: OUT_OF_RANGE_TEXT,
                missing: true,
                copyText: OUT_OF_RANGE_TEXT,
                tooltip: `${cell.s} seconds since 1970-01-01 UTC`,
            };
            case 'ts': {
                const ts = formatTimestamp(cell.ms, cell.us, col?.timeZone ?? 'UTC', col?.subsecondDigits ?? 0);
                return { text: ts.text, missing: false, copyText: ts.text, tooltip: ts.offset };
            }
        }
    }
    // Dictionary-encoded cell: 0-based index.
    if (typeof cell === 'number' && col?.arrowType.startsWith('Dictionary')) {
        const label = o.labelsOn
            ? (col.dictionaryShipped ? dictionary?.[cell] : o.resolvedLabel)
            : undefined;
        // Display 1-based code so it matches as.integer(factor) in R.
        return label !== undefined ? { ...plain(label), isLabel: true } : plain(String(cell + 1));
    }
    // haven_labelled: non-dict numeric/string column with raven.value_labels.
    if (o.labelsOn && col?.valueLabels
        && (typeof cell === 'number' || typeof cell === 'string')) {
        const lbl = col.valueLabels[String(cell)];
        if (lbl !== undefined) return { ...plain(lbl), isLabel: true };
    }
    if (typeof cell === 'number') {
        const opts: NumberFormatOptions = {
            formatOn: o.formatOn,
            digits: o.digits,
            isInteger: col?.isInteger ?? Number.isInteger(cell),
            spec: col?.arrowType.startsWith('Float') ? specFor(col) : undefined,
            alignPad: false,
        };
        const copyText = formatNumber(cell, opts);
        if (!o.alignPad) return plain(copyText);
        return { text: formatNumber(cell, { ...opts, alignPad: true }), missing: false, copyText };
    }
    if (typeof cell === 'boolean') return plain(cell ? 'TRUE' : 'FALSE');
    return plain(String(cell));
}

