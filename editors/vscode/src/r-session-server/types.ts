/** Event types emitted by the loopback R session server. Plot bridge
 *  events are unchanged from before the data viewer was added; the data
 *  viewer adds the `view-data-requested` variant. */

export type SessionInfo = {
    sessionId: string;
    httpgdBaseUrl: string;
    httpgdToken: string;
    ended: boolean;
    /** httpgd state.upid from the most recent /plot-available for this session,
     *  or 0 if none seen yet. Used as a cache-busting query parameter so plot
     *  updates that reuse an existing id (e.g. `points()` on a live plot) are
     *  not served stale from the browser cache. */
    lastUpid: number;
};

export type PlotEvent =
    | { type: 'session-ready'; session: SessionInfo }
    | { type: 'plot-available'; sessionId: string; hsize: number; upid: number }
    | { type: 'session-ended'; sessionId: string };

export type ViewDataEvent = {
    type: 'view-data-requested';
    sessionId: string;
    panelName: string;
    /** Canonicalized absolute path to the Arrow file. Always strictly
     *  contained in the per-server allowed data-viewer directory. */
    filePath: string;
    nrow: number;
};

export type DataViewerWarningEvent = {
    type: 'data-viewer-warning';
    sessionId: string;
    reason: 'missing-arrow';
    message: string;
};

export type PlotWarningEvent = {
    type: 'plot-warning';
    sessionId: string;
    reason: 'missing-httpgd' | 'outdated-httpgd';
    message: string;
};

export type RSessionEvent = PlotEvent | ViewDataEvent | DataViewerWarningEvent | PlotWarningEvent;
export type RSessionEventListener = (event: RSessionEvent) => void;
