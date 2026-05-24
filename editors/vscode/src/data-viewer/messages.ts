/**
 * Protocol types for the data-viewer postMessage channel.
 *
 * Every message after the initial `webviewReady` handshake carries the
 * panel's monotonic `panelGeneration`. Receivers drop messages tagged with
 * an older generation than the receiver's current one — this is how stale
 * `getRows` / `copy` / `labels` responses are filtered out after a `replace`.
 */

import type { Cell } from './wire-format';
import type { ColumnSchema } from './arrow-reader';
import type { ToolbarState } from './toolbar-state';

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
        toolbar: ToolbarState;
        settings: Settings;
        dictionaries: Record<number, string[]>;
        /** schemaHash for the active dataset. Echoed back by saveLayout
         *  / saveToolbar so the host stores under the hash that was
         *  current when the user toggled, even if a later replace
         *  swapped the dataset before the debounce fired. */
        schemaHash: string;
        objectClass?: string;
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
        toolbar: ToolbarState;
        dictionaries: Record<number, string[]>;
        schemaHash: string;
        objectClass?: string;
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
    }
    | {
        /** Test-only: dispatch a synthetic KeyboardEvent on `window` from
         *  inside the webview, so the integration test harness can drive
         *  the same onKeyDown handler a real keypress would invoke.
         *  Production code paths never post this message; the webview can
         *  only receive messages from its own extension host, so exposing
         *  it does not introduce an external attack surface. */
        type: 'testKey';
        panelGeneration: number;
        key: string;
    }
    | {
        /** Test-only: scroll the grid to a fractional vertical position.
         *  fraction=0 jumps to top, fraction=1 jumps to bottom. The
         *  production UI no longer has Raven-owned scrollbar pointer
         *  handlers; this routes through the grid's imperative scroll API.
         *
         *  Production code paths never post this message; the webview
         *  can only receive messages from its own extension host, so
         *  exposing it does not introduce an external attack surface. */
        type: 'testScrollToFraction';
        panelGeneration: number;
        fraction: number;
    };

export type WebviewToExtension =
    | {
        type: 'webviewReady';
    }
    | {
        type: 'lifecycle';
        event: string;
        panelGeneration: number;
        nrow: number;
        columns: number;
        visibleRows: number;
        /** Start row index of the currently rendered window (inclusive).
         *  Used by the test API to verify scroll position. Always reflects
         *  visibleRangeStart at the moment postLifecycle was called. */
        visibleRangeStart: number;
        /** End row index of the currently rendered window (exclusive).
         *  Equal to visibleRangeStart + visibleRows. */
        visibleRangeEnd: number;
        /** Start row index of the rows actually visible within the
         *  viewport (inclusive), excluding overscan rows above or below
         *  the viewport. Used by integration tests that need to prove the
         *  last row is on screen, not merely fetched. */
        viewportRangeStart: number;
        /** End row index of the rows actually visible within the
         *  viewport (exclusive). */
        viewportRangeEnd: number;
        /** Active selection focus cell, or null when no cell is selected. */
        focusCell: { row: number; col: number } | null;
        timestamp: number;
    }
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
        /** schemaHash for the dataset the layout was captured against —
         *  used as the store key so a debounced save that lands after a
         *  replace still goes to the right slot. */
        schemaHash: string;
        layout: Layout;
    }
    | {
        type: 'saveToolbar';
        panelGeneration: number;
        schemaHash: string;
        toolbar: ToolbarState;
    }
    | {
        type: 'copy';
        panelGeneration: number;
        requestId: number;
        range: { rowStart: number; rowEnd: number; colIndices: number[] };
        labelsOn: boolean;
        formatOn: boolean;
        digits: number;
        /** When true, prepend a tab-separated row of column names so the
         *  paste lands with headers. Set by the webview for column /
         *  select-all selections. */
        includeHeader: boolean;
    };

/** Hard cap on the number of cells the extension will materialize for a
 *  single copy request. Above this we refuse the copy and surface a
 *  toast in the panel. */
export const COPY_CELL_LIMIT = 5_000_000;
