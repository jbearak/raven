/** Display-time formatting for grid cells. Pure function; no DOM.
 *
 *  Inverse of the wire-format encoders used by ArrowSliceReader,
 *  with Labels / Format toggles applied. The webview decides per-cell
 *  rendering by calling this once per visible cell. */

import type { Cell } from '../wire-format';
import type { ColumnSchema } from '../arrow-reader';

export type FormattedCell = { text: string; missing: boolean };

export function formatCell(
    cell: Cell,
    col: ColumnSchema | undefined,
    dictionary: string[] | undefined,
    labelsOn: boolean,
    formatOn: boolean,
    digits: number,
): FormattedCell {
    if (cell === null) return { text: '', missing: true };
    if (typeof cell === 'object' && cell && '_' in cell) {
        switch (cell._) {
            case 'nan':  return { text: 'NaN',  missing: true  };
            case 'inf':  return { text: 'Inf',  missing: false };
            case '-inf': return { text: '-Inf', missing: false };
            case 'date': return { text: cell.v, missing: false };
            case 'ts':   return { text: cell.v, missing: false };
            case 'trunc':return { text: cell.v, missing: false };
        }
    }
    // Dictionary-encoded cell: 0-based index.
    if (typeof cell === 'number' && col?.dictionaryShipped) {
        if (labelsOn && dictionary && dictionary[cell] !== undefined) {
            return { text: dictionary[cell], missing: false };
        }
        // Display 1-based code so it matches as.integer(factor) in R.
        return { text: String(cell + 1), missing: false };
    }
    // haven_labelled: non-dict numeric/string column with raven.value_labels.
    if (labelsOn && col?.valueLabels
        && (typeof cell === 'number' || typeof cell === 'string')) {
        const lbl = col.valueLabels[String(cell)];
        if (lbl !== undefined) return { text: lbl, missing: false };
    }
    if (typeof cell === 'number' && col && !col.isInteger && formatOn) {
        return { text: cell.toFixed(digits), missing: false };
    }
    return { text: String(cell), missing: false };
}
