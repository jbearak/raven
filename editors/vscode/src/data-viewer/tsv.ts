/**
 * Pure TSV rendering for the extension-side copy path.
 *
 * Lives in its own module so it has no `vscode` runtime dependency and
 * can be unit-tested under Bun without a vscode module mock.
 */

import type { Cell } from './wire-format';
import type { ColumnSchema } from './arrow-reader';

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
    if (cell === null) return '';
    if (typeof cell === 'object' && cell && '_' in cell) {
        switch (cell._) {
            case 'nan': return 'NaN';
            case 'inf': return 'Inf';
            case '-inf': return '-Inf';
            case 'date':  return sanitize(cell.v);
            case 'ts':    return sanitize(cell.v);
            case 'trunc': return sanitize(cell.v);
        }
    }
    // Dictionary cell with shipped dictionary.
    if (typeof cell === 'number' && col?.dictionaryShipped && dict) {
        return labelsOn && dict[cell] !== undefined
            ? sanitize(dict[cell])
            : String(cell + 1);
    }
    // Dictionary cell without a shipped dictionary (high cardinality).
    if (typeof cell === 'number' && col?.arrowType.startsWith('Dictionary')) {
        if (labelsOn && resolved && resolved[cell] !== undefined) {
            return sanitize(resolved[cell]);
        }
        return String(cell + 1);
    }
    if (labelsOn && col?.valueLabels
        && (typeof cell === 'number' || typeof cell === 'string')) {
        const lbl = col.valueLabels[String(cell)];
        if (lbl !== undefined) return sanitize(lbl);
    }
    if (typeof cell === 'number' && col && !col.isInteger && formatOn) {
        return cell.toFixed(digits);
    }
    return sanitize(String(cell));
}
