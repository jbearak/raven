/**
 * Protocol types for the data-viewer postMessage channel.
 *
 * Every message in either direction carries the panel's monotonic
 * `panelGeneration`. Receivers drop messages tagged with an older
 * generation than the receiver's current one — this is how stale
 * `getRows` / `copy` / `labels` responses are filtered out after a
 * `replace`.
 */

import type { Cell } from './wire-format';
import type { ColumnSchema } from './arrow-reader';

export type Layout = {
    /** Per-column pixel widths, keyed by the column's index in the
     *  current schema. Indices are stable for a given schema hash, and
     *  unlike names they don't collide when a data frame has duplicate
     *  column names (e.g. via `data.frame(x = 1, x = 2,
     *  check.names = FALSE)`). */
    columnWidths: Record<number, number>;
    /** Hidden column indices. */
    hiddenColumns: number[];
};

export type Settings = {
    missingValueStyle: 'foreground' | 'background' | 'none';
    defaultDigits: number;
};

export type ExtensionToWebview =
    | {
        type: 'init';
        panelGeneration: number;
        nrow: number;
        columns: ColumnSchema[];
        layout: Layout;
        settings: Settings;
        dictionaries: Record<number, string[]>;
    }
    | {
        type: 'rows';
        panelGeneration: number;
        requestId: number;
        viewportGeneration: number;
        start: number;
        end: number;
        rows: Cell[][];
        stale: boolean;
    }
    | {
        type: 'labels';
        panelGeneration: number;
        requestId: number;
        columnIndex: number;
        labels: Record<number, string>;
    }
    | {
        type: 'replace';
        panelGeneration: number;
        nrow: number;
        columns: ColumnSchema[];
        layout: Layout;
        dictionaries: Record<number, string[]>;
    }
    | {
        type: 'copyDone';
        panelGeneration: number;
        requestId: number;
        ok: boolean;
        error?: string;
    }
    | {
        type: 'error';
        panelGeneration: number;
        message: string;
    };

export type WebviewToExtension =
    | {
        type: 'getRows';
        panelGeneration: number;
        requestId: number;
        viewportGeneration: number;
        start: number;
        end: number;
        columns: number[];
    }
    | {
        type: 'getLabels';
        panelGeneration: number;
        requestId: number;
        columnIndex: number;
        indices: number[];
    }
    | {
        type: 'saveLayout';
        panelGeneration: number;
        layout: Layout;
    }
    | {
        type: 'copy';
        panelGeneration: number;
        requestId: number;
        range: { rowStart: number; rowEnd: number; colIndices: number[] };
        labelsOn: boolean;
        formatOn: boolean;
        digits: number;
    };

/** Hard cap on the number of cells the extension will materialize for a
 *  single copy request. Above this we refuse the copy and surface a
 *  toast in the panel. */
export const COPY_CELL_LIMIT = 5_000_000;
