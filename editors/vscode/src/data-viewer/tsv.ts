/**
 * Pure TSV rendering for the extension-side copy path.
 *
 * Lives in its own module so it has no `vscode` runtime dependency and
 * can be unit-tested under Bun without a vscode module mock.
 */

import type { Cell } from './wire-format';
import type { ColumnSchema } from './arrow-reader';

export function render_tsv(
    rows: Cell[][],
    colIndices: number[],
    columns: ColumnSchema[],
    dictionaries: Record<number, string[]>,
    labelsOn: boolean,
    formatOn: boolean,
    digits: number,
): string {
    const lines: string[] = [];
    for (const row of rows) {
        const parts: string[] = [];
        for (let j = 0; j < row.length; j++) {
            const colIdx = colIndices[j];
            parts.push(format_cell_for_tsv(
                row[j], columns[colIdx], dictionaries[colIdx],
                labelsOn, formatOn, digits,
            ));
        }
        lines.push(parts.join('\t'));
    }
    return lines.join('\n');
}

function format_cell_for_tsv(
    cell: Cell,
    col: ColumnSchema | undefined,
    dict: string[] | undefined,
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
            case 'date': return cell.v;
            case 'ts': return cell.v;
            case 'trunc': return cell.v;
        }
    }
    if (typeof cell === 'number' && col?.dictionaryShipped && dict) {
        return labelsOn && dict[cell] !== undefined
            ? dict[cell].replace(/[\t\n\r]/g, ' ')
            : String(cell + 1);
    }
    if (labelsOn && col?.valueLabels
        && (typeof cell === 'number' || typeof cell === 'string')) {
        const lbl = col.valueLabels[String(cell)];
        if (lbl !== undefined) return lbl.replace(/[\t\n\r]/g, ' ');
    }
    if (typeof cell === 'number' && col && !col.isInteger && formatOn) {
        return cell.toFixed(digits);
    }
    return String(cell).replace(/[\t\n\r]/g, ' ');
}
