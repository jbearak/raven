/**
 * Pure helpers behind the workflow features: go-to-row parsing, the
 * find bar's count text, and the status line's selection summary.
 */
import type { Cell } from '../wire-format';

export type CodeFlavorName = 'dplyr' | 'base' | 'data.table';

/** A go-to-row target: an R row number (`120`, `1,200`), or a display
 *  position with a `#` prefix (`#5`). Both 1-based. */
export type RowTarget = { kind: 'rowNumber' | 'position'; n: number };

export function parseRowTarget(input: string): RowTarget | null {
    const t = input.trim();
    const m = /^(#)?\s*([\d,_ ]+)$/.exec(t);
    if (!m) return null;
    const n = Number(m[2].replace(/[,_ ]/g, ''));
    if (!Number.isSafeInteger(n) || n < 1) return null;
    return { kind: m[1] ? 'position' : 'rowNumber', n };
}

export function formatInt(n: number): string {
    return n.toLocaleString('en-US');
}

/** The find bar's count: `3 of 120`, `No matches`, `Searching…`. */
export function describeFindCount(
    state: { searching: boolean; count?: number; index?: number; error?: string },
): string {
    if (state.error) return state.error;
    if (state.searching) return 'Searching…';
    if (state.count === undefined) return '';
    if (state.count === 0) return 'No matches';
    const i = state.index !== undefined && state.index >= 0 ? state.index + 1 : 0;
    return i > 0 ? `${formatInt(i)} of ${formatInt(state.count)}` : `${formatInt(state.count)} matches`;
}

/** Cells summarized in full; a larger selection shows its count only. */
export const SELECTION_SUMMARY_MAX_CELLS = 100_000;

export type SelectionSummary = {
    cells: number;
    /** Present when every selected numeric cell is loaded and the
     *  selection is within {@link SELECTION_SUMMARY_MAX_CELLS}. */
    numeric?: { count: number; na: number; sum: number };
};

/**
 * Summarize a rectangular selection of `rows` × `cols` cells. `numericCol`
 * says which display columns hold numbers; `cellAt` returns a loaded cell,
 * or `undefined` when its tile isn't cached. NaN counts as NA, as the
 * grid shows it; ±Inf are summed (R would too).
 */
export function summarizeSelection(
    rows: { start: number; end: number },
    cols: readonly number[],
    numericCol: (col: number) => boolean,
    cellAt: (col: number, row: number) => Cell | undefined,
): SelectionSummary {
    const height = Math.max(0, rows.end - rows.start);
    const cells = height * cols.length;
    const numCols = cols.filter(numericCol);
    if (numCols.length === 0 || cells === 0 || cells > SELECTION_SUMMARY_MAX_CELLS) return { cells };
    let count = 0;
    let na = 0;
    let sum = 0;
    for (const c of numCols) {
        for (let r = rows.start; r < rows.end; r++) {
            const cell = cellAt(c, r);
            if (cell === undefined) return { cells };
            if (cell === null) { na++; continue; }
            if (typeof cell === 'number') { count++; sum += cell; continue; }
            if (typeof cell === 'object') {
                if (cell._ === 'nan') { na++; continue; }
                if (cell._ === 'inf') { count++; sum += Infinity; continue; }
                if (cell._ === '-inf') { count++; sum -= Infinity; continue; }
            }
        }
    }
    return { cells, numeric: { count, na, sum } };
}

/** Status-line text for a summary: `6 cells · 1 NA · Σ 120.4 · mean 20.07`. */
export function describeSelection(s: SelectionSummary, format: (x: number) => string): string {
    if (s.cells <= 1) return '';
    const parts = [`${formatInt(s.cells)} cells`];
    if (s.numeric) {
        const { count, na, sum } = s.numeric;
        if (na > 0) parts.push(`${formatInt(na)} NA`);
        if (count > 0) {
            parts.push(`Σ ${format(sum)}`);
            parts.push(`mean ${format(sum / count)}`);
        }
    }
    return parts.join(' · ');
}

/** A compact number for the status line: up to 4 significant digits
 *  after the point, scientific past 1e15 or below 1e-4. */
export function formatStat(x: number): string {
    if (!Number.isFinite(x)) return Number.isNaN(x) ? 'NaN' : x > 0 ? 'Inf' : '-Inf';
    const a = Math.abs(x);
    if (a !== 0 && (a >= 1e15 || a < 1e-4)) return x.toExponential(3).replace(/\.?0+e/, 'e');
    if (Number.isInteger(x)) return x.toLocaleString('en-US');
    return x.toLocaleString('en-US', { maximumFractionDigits: a >= 1000 ? 2 : 4 });
}
