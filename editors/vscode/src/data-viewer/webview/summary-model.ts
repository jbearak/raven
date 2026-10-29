/**
 * Pure logic behind the column summaries in the webview: the header
 * band's geometry and hit-testing, the filters a band click or a value
 * count builds, number formatting with `≈` for estimates, and the
 * Columns sidebar's search, sort and per-type stat lines. React- and
 * canvas-free, so bun tests drive it directly.
 *
 * Filters built here match exactly what was clicked:
 *   - A histogram brush over bins `from..to` filters `lo <= x < hi`, or
 *     `lo <= x <= hi` when it includes the last (closed) bin, with the
 *     bins' own edges. The profile engine bins by comparing against the
 *     same edges (`histograms.ts` `binIndex`), so the filtered row count
 *     equals the brushed bars' total.
 *   - A top-value bar or value-count rows build a set filter in the form
 *     the filter engine matches for that column kind and the Labels
 *     toggle (`filter.ts`): factor labels (Labels on) or 0-based codes
 *     (off), labelled-numeric codes, value-label text or raw strings.
 */
import type { ColumnSchema } from '../arrow-reader';
import type { FilterPredicate, HistogramBin } from '../messages';
import type { ColumnProfile, CountedEntry, Estimate, ProfileState } from '../profile';
import type { Cell } from '../wire-format';
import { displayTypeTag } from '../display-format';

/** Height of the summary band under the header text. */
export const BAND_PX = 28;
/** Top values drawn as bars in the band. */
export const BAND_TOP_N = 5;

// ---------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------

/** A count with thousands separators. */
export function formatCount(n: number): string {
    return Math.round(n).toLocaleString('en-US');
}

/** A short count for the band: 950, 1.2k, 31k, 7.6M. */
export function formatCompact(n: number): string {
    const a = Math.abs(n);
    if (a < 1000) return String(Math.round(n));
    const units: [number, string][] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
    for (const [u, s] of units) {
        if (a >= u) {
            const v = n / u;
            return `${v >= 100 ? Math.round(v) : Number(v.toPrecision(2))}${s}`;
        }
    }
    return String(n);
}

/** An estimate, prefixed `≈` unless exact. */
export function formatEstimate(e: Estimate, compact = false): string {
    const text = compact ? formatCompact(e.value) : formatCount(e.value);
    return e.exact ? text : `≈ ${text}`;
}

/** A share as the band prints it: `0%`, `<1%`, `12%`, `>99%`, `100%`. */
export function formatShare(part: number, total: number): string {
    if (total <= 0) return '0%';
    if (part === 0) return '0%';
    if (part === total) return '100%';
    const pct = (part / total) * 100;
    if (pct < 1) return '<1%';
    if (pct > 99) return '>99%';
    return `${Math.round(pct)}%`;
}

/** A statistic with up to 4 significant digits past the integer part. */
export function formatStat(x: number | undefined): string {
    if (x === undefined) return '—';
    if (Number.isNaN(x)) return 'NaN';
    if (x === Infinity) return 'Inf';
    if (x === -Infinity) return '-Inf';
    const a = Math.abs(x);
    if (a !== 0 && (a >= 1e15 || a < 1e-4)) return x.toExponential(3);
    if (Number.isInteger(x)) return x.toLocaleString('en-US');
    return Number(x.toPrecision(Math.max(4, Math.ceil(Math.log10(a + 1)) + 3))).toLocaleString('en-US', {
        maximumFractionDigits: 6,
    });
}

/** The NA share and distinct count the band prints after its chart:
 *  `12% NA · 31`. NaN counts as missing, as in the missing bar. */
export function bandText(p: ColumnProfile): string {
    return `${formatShare(p.na + p.nan, p.rows)} NA · ${formatEstimate(p.distinct, true)}`;
}

// ---------------------------------------------------------------------
// Band geometry and hit-testing
// ---------------------------------------------------------------------

export type BandRect = { x: number; y: number; width: number; height: number };

/** What a band shows. */
export type BandChart =
    | { kind: 'histogram'; bins: HistogramBin[]; brushable: boolean }
    | { kind: 'bars'; values: CountedEntry[] }
    | { kind: 'logical'; t: number; f: number; na: number }
    | { kind: 'none' };

export function bandChart(p: ColumnProfile): BandChart {
    switch (p.kind) {
        case 'numeric':
        case 'date':
            return p.histogram && p.histogram.length > 0
                ? { kind: 'histogram', bins: p.histogram, brushable: p.kind === 'numeric' }
                : { kind: 'none' };
        case 'factor':
        case 'labelled':
        case 'character':
            return p.top && p.top.values.length > 0
                ? { kind: 'bars', values: p.top.values.slice(0, BAND_TOP_N) }
                : { kind: 'none' };
        case 'logical':
            return { kind: 'logical', t: p.trueCount ?? 0, f: p.falseCount ?? 0, na: p.na };
        default:
            return { kind: 'none' };
    }
}

/** Where the chart and the text go inside the band: the text keeps its
 *  measured width at the right, the chart takes the rest (it's dropped
 *  when narrower than 24 px; the text is dropped first if both can't
 *  fit). */
export function bandGeometry(band: BandRect, textWidth: number): { chart: BandRect | undefined; textX: number | undefined } {
    const gap = 6;
    const minChart = 24;
    if (band.width >= textWidth + gap + minChart) {
        return {
            chart: { x: band.x, y: band.y, width: band.width - textWidth - gap, height: band.height },
            textX: band.x + band.width - textWidth,
        };
    }
    if (band.width >= minChart) return { chart: band, textX: undefined };
    return { chart: undefined, textX: undefined };
}

/** Slots of `n` equal bars across `rect` (1 px gaps when they fit). */
export function barSlot(rect: BandRect, n: number, i: number): { x: number; width: number } {
    const step = rect.width / n;
    const gap = step >= 4 ? 1 : 0;
    return { x: rect.x + i * step, width: Math.max(1, step - gap) };
}

/** The bar (bin or top value) under canvas x, or undefined. */
export function chartIndexAt(chart: BandChart, rect: BandRect, x: number): number | undefined {
    const n = chart.kind === 'histogram' ? chart.bins.length : chart.kind === 'bars' ? chart.values.length : 0;
    if (n === 0 || x < rect.x || x > rect.x + rect.width) return undefined;
    return Math.min(n - 1, Math.max(0, Math.floor(((x - rect.x) / rect.width) * n)));
}

/** Which bin or bar a band point hits, given the band and its text width. */
export type BandHit = { kind: 'bin' | 'bar'; index: number };

export function bandHit(p: ColumnProfile, band: BandRect, textWidth: number, x: number, y: number): BandHit | undefined {
    if (y < band.y || y > band.y + band.height) return undefined;
    const chart = bandChart(p);
    const { chart: rect } = bandGeometry(band, textWidth);
    if (!rect) return undefined;
    const index = chartIndexAt(chart, rect, x);
    if (index === undefined) return undefined;
    if (chart.kind === 'histogram') return { kind: 'bin', index };
    if (chart.kind === 'bars') return { kind: 'bar', index };
    return undefined;
}

// ---------------------------------------------------------------------
// Filters from summaries
// ---------------------------------------------------------------------

/** The filter for brushed bins `a..b` (either order): `[lo, hi)`, or
 *  `[lo, hi]` when the range includes the last bin. */
export function brushPredicate(bins: readonly HistogramBin[], a: number, b: number): FilterPredicate {
    const from = Math.max(0, Math.min(a, b));
    const to = Math.min(bins.length - 1, Math.max(a, b));
    return {
        kind: 'numBetween',
        lo: bins[from].lo,
        hi: bins[to].hi,
        inclusive: true,
        upperInclusive: to === bins.length - 1,
    };
}

/** Total of the brushed bins `a..b`. */
export function brushedTotal(bins: readonly HistogramBin[], a: number, b: number): number {
    let t = 0;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) t += bins[i]?.count ?? 0;
    return t;
}

/** Whether value-count rows of this column can build a filter. */
export function canFilterValues(col: ColumnSchema, kind: ColumnProfile['kind']): boolean {
    if (kind === 'date') return !col.arrowType.startsWith('Timestamp');
    return kind !== 'other';
}

/** The filter matching any of `entries` (counted values of `col`), or
 *  undefined when the column can't be filtered by value. */
export function setFilterFor(
    col: ColumnSchema,
    kind: ColumnProfile['kind'],
    entries: readonly CountedEntry[],
    labelsOn: boolean,
): FilterPredicate | undefined {
    if (entries.length === 0 || !canFilterValues(col, kind)) return undefined;
    if (kind === 'logical') {
        if (entries.length === 1) return { kind: 'bool', value: entries[0].value === true };
        return { kind: 'setIn', values: entries.map(e => String(e.value)) };
    }
    if (kind === 'date') {
        // One date: an equality the date filter evaluates exactly.
        if (entries.length !== 1) return undefined;
        return { kind: 'dateCompare', op: '=', value: isoDay(entries[0].value as number) };
    }
    if (kind === 'factor') {
        return {
            kind: 'setIn',
            values: entries.map(e => (labelsOn ? e.label ?? '' : String(e.value))),
        };
    }
    const t = col.arrowType;
    const numeric = t.startsWith('Int') || t.startsWith('Uint') || t.startsWith('Float');
    if (kind === 'labelled' && numeric) return { kind: 'setIn', values: entries.map(e => e.value as number) };
    if (kind === 'labelled' && labelsOn) {
        return { kind: 'setIn', values: entries.map(e => e.label ?? String(e.value)) };
    }
    return { kind: 'setIn', values: entries.map(e => String(e.value)) };
}

function isoDay(days: number): string {
    return new Date(days * 86_400_000).toISOString().slice(0, 10);
}

/** A counted value as a wire cell, so it formats like the grid. */
export function entryCell(col: ColumnSchema, kind: ColumnProfile['kind'], value: CountedEntry['value']): Cell {
    if (kind === 'date' && typeof value === 'number') {
        if (col.arrowType.startsWith('Timestamp')) {
            const ms = Math.floor(value / 1000);
            return { _: 'ts', ms, us: value - ms * 1000 };
        }
        return { _: 'date', v: isoDay(value) };
    }
    return value as Cell;
}

// ---------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------

export type SidebarSort = 'position' | 'name' | 'type' | 'missing' | 'distinct';

export type SidebarColumnInfo = {
    /** NA (+ NaN, when profiled) rows, if known. */
    missing: number | undefined;
    distinct: number | undefined;
};

/** Source indices matching `query` (name or label, case-insensitive),
 *  in `sort` order. Unknown % missing / distinct sort last; ties keep
 *  position order. */
export function sidebarRows(
    columns: readonly ColumnSchema[],
    info: (source: number) => SidebarColumnInfo,
    query: string,
    sort: SidebarSort,
    descending = false,
): number[] {
    const needle = query.trim().toLowerCase();
    const rows: number[] = [];
    for (let i = 0; i < columns.length; i++) {
        const c = columns[i];
        if (needle && !c.name.toLowerCase().includes(needle)
            && !(c.variableLabel ?? '').toLowerCase().includes(needle)) continue;
        rows.push(i);
    }
    if (sort === 'position') return descending ? rows.reverse() : rows;
    const dir = descending ? -1 : 1;
    const key = (i: number): string | number | undefined => {
        switch (sort) {
            case 'name': return columns[i].name.toLowerCase();
            case 'type': return displayTypeTag(columns[i]);
            case 'missing': return info(i).missing;
            case 'distinct': return info(i).distinct;
        }
    };
    const keys = new Map(rows.map(i => [i, key(i)]));
    return rows.sort((a, b) => {
        const ka = keys.get(a), kb = keys.get(b);
        if (ka === undefined && kb === undefined) return a - b;
        if (ka === undefined) return 1;
        if (kb === undefined) return -1;
        const c = typeof ka === 'number' && typeof kb === 'number'
            ? ka - kb
            : String(ka) < String(kb) ? -1 : String(ka) > String(kb) ? 1 : 0;
        return c !== 0 ? c * dir : a - b;
    });
}

export type StatLine = { label: string; value: string };

/** The expanded sidebar row's stats for a profile. `fmt` formats a
 *  value cell as the grid would. */
export function profileStatLines(
    p: ColumnProfile,
    fmt: (cell: Cell) => string,
): StatLine[] {
    const lines: StatLine[] = [];
    const add = (label: string, value: string) => lines.push({ label, value });
    const present = p.rows - p.na - p.nan;
    add('n', `${formatCount(present)} of ${formatCount(p.rows)} rows`);
    add('NA', `${formatCount(p.na)} (${formatShare(p.na, p.rows)})`);
    switch (p.kind) {
        case 'numeric': {
            add('NaN', formatCount(p.nan));
            add('distinct', formatEstimate(p.distinct));
            const q = p.quantiles;
            const approx = q && !q.exact ? '≈ ' : '';
            add('min', p.min !== undefined ? fmt(p.min) : '—');
            add('p25', q ? approx + formatStat(q.p25) : '—');
            add('median', q ? approx + formatStat(q.p50) : '—');
            add('mean', formatStat(p.mean));
            add('p75', q ? approx + formatStat(q.p75) : '—');
            add('max', p.max !== undefined ? fmt(p.max) : '—');
            add('sd', formatStat(p.sd));
            break;
        }
        case 'factor':
        case 'labelled': {
            add('distinct', formatEstimate(p.distinct));
            const lv = p.levels;
            if (lv) {
                add(p.kind === 'factor' ? 'levels' : 'labels', `${formatCount(lv.used)} of ${formatCount(lv.declared)} used`);
                for (const e of lv.counts) {
                    add(e.label ?? String(e.value), `${formatCount(e.count)} (${formatShare(e.count, p.rows)})`);
                }
                if (lv.declared > lv.counts.length) add('', `${formatCount(lv.declared - lv.counts.length)} more`);
            }
            break;
        }
        case 'character': {
            add('distinct', formatEstimate(p.distinct));
            add('empty strings', formatCount(p.emptyStrings ?? 0));
            if (p.minLength !== undefined) add('length', `${p.minLength}–${p.maxLength}`);
            for (const e of p.top?.values.slice(0, 5) ?? []) {
                const c = p.top!.exact ? formatCount(e.count) : `≈ ${formatCount(e.count)} ± ${formatCount(e.error)}`;
                add(JSON.stringify(e.value), c);
            }
            if (p.top?.approximateOrder) add('', 'approximate order');
            break;
        }
        case 'logical':
            add('TRUE', formatCount(p.trueCount ?? 0));
            add('FALSE', formatCount(p.falseCount ?? 0));
            break;
        case 'date':
            add('distinct', formatEstimate(p.distinct));
            add('min', p.min !== undefined ? fmt(p.min) : '—');
            add('max', p.max !== undefined ? fmt(p.max) : '—');
            if (p.timeZone) add('time zone', p.timeZone);
            break;
        default:
            break;
    }
    return lines;
}

/** One line for a band or sidebar tooltip about a profile state. */
export function profileStateText(s: ProfileState | undefined): string | undefined {
    if (!s) return undefined;
    if (s.state === 'loading') return 'Summary: computing…';
    if (s.state === 'failed') return `Summary failed: ${s.error}`;
    return `Summary of all ${formatCount(s.profile.rows)} rows`;
}
