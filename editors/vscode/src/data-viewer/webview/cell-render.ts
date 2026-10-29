/** Display-time formatting for grid cells. The rules live in
 *  `../display-format.ts`, shared with the host's TSV copy so a copy
 *  carries what the grid showed; this module is the webview's entry. */

export {
    formatCell,
    type CellFormatOptions,
    type FormattedCell,
} from '../display-format';
