/**
 * Pure TSV rendering for the extension-side copy path.
 *
 * Lives in its own module so it has no `vscode` runtime dependency and
 * can be unit-tested under Bun without a vscode module mock.
 */

import type { Cell } from './wire-format';
import type { ColumnSchema } from './arrow-reader';
import { formatCell } from './display-format';

/** Map of column index → (dictionary index → label string), for columns
 *  whose dictionaries weren't shipped up front (cardinality above the
 *  threshold). The copy path passes labels it has resolved via
 *  `reader.getLabels` so what's copied matches what the grid showed. */
export type ResolvedLabels = Record<number, Record<number, string>>;

export function render_tsv(
    rows: Cell[][],
    colIndices: number[],
    columns: ColumnSchema[],
    dictionaries: Record<number, string[]>,
    labelsOn: boolean,
    formatOn: boolean,
    digits: number,
    resolvedLabels: ResolvedLabels = {},
    includeHeader: boolean = false,
): string {
    const lines: string[] = [];
    if (includeHeader) {
        const header = colIndices
            .map(i => sanitize(columns[i]?.name ?? ''))
            .join('\t');
        lines.push(header);
    }
    for (const row of rows) {
        const parts: string[] = [];
        for (let j = 0; j < row.length; j++) {
            const colIdx = colIndices[j];
            parts.push(format_cell_for_tsv(
                row[j], columns[colIdx], dictionaries[colIdx],
                resolvedLabels[colIdx],
                labelsOn, formatOn, digits,
            ));
        }
        lines.push(parts.join('\t'));
    }
    return lines.join('\n');
}

const sanitize = (s: string): string => s.replace(/[\t\n\r]/g, ' ');

function format_cell_for_tsv(
    cell: Cell,
    col: ColumnSchema | undefined,
    dict: string[] | undefined,
    resolved: Record<number, string> | undefined,
    labelsOn: boolean,
    formatOn: boolean,
    digits: number,
): string {
    const resolvedLabel = typeof cell === 'number' ? resolved?.[cell] : undefined;
    return sanitize(formatCell(cell, col, dict, { labelsOn, formatOn, digits, resolvedLabel }).copyText);
}

/**
 * "Copy with row names" on a frame without a rowname column: prefix each
 * data line with its 1-based R row number (from the host's permutation
 * when one is active, else `rowStart + i + 1`), and the header line with
 * an empty field.
 */
export function prependRowNumbers(
    tsv: string,
    rowStart: number,
    originalRowIndices: readonly number[] | undefined,
    includeHeader: boolean,
): string {
    const lines = tsv.split('\n');
    return lines.map((line, i) => {
        if (includeHeader && i === 0) return `\t${line}`;
        const r = i - (includeHeader ? 1 : 0);
        const original = originalRowIndices?.[r] ?? rowStart + r;
        return `${original + 1}\t${line}`;
    }).join('\n');
}
