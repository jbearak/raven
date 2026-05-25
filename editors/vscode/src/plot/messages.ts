/**
 * Typed wire protocol between the VS Code extension host (Node) and the
 * Svelte plot-viewer webview (browser).
 *
 * Rules:
 *  - No VS Code or DOM imports — this module must be importable from both sides.
 *  - Pure types + small runtime type-guards only.
 */

export type SaveFormat = 'png' | 'svg' | 'pdf';

export type ActiveSessionInfo = {
    sessionId: string;
    httpgdBaseUrl: string;
    httpgdToken: string;
    /** httpgd `state.upid` for the last plot event. Used by the webview as a
     *  cache-busting query parameter so re-rendered plots that reuse an id
     *  (e.g. `points()` on a live plot) are not served stale by the browser. */
    upid: number;
};

/**
 * State-update payload. The host posts this on `webview-ready`, on every
 * /plot-available event, and on every set-theme-applied broadcast.
 *
 * `themeApplied` mirrors the host's `globalState[THEME_PREFERENCE_KEY]`
 * — broadcasting it on every state-update keeps all open panels in
 * sync. See plot-viewer-panel.ts and PlotServices.broadcastStateUpdate.
 */
export type StateUpdatePayload = {
    activeSession: ActiveSessionInfo | null;
    sessionEnded: boolean;
    themeApplied: boolean;
};

export type ExtensionToWebviewMessage =
    | { type: 'state-update'; payload: StateUpdatePayload };

export type WebviewToExtensionMessage =
    | { type: 'webview-ready'; payload: Record<string, never> }
    | { type: 'request-save-plot'; payload: { plotId: string; format: SaveFormat } }
    | { type: 'request-open-externally'; payload: { plotId: string } }
    | { type: 'report-error'; payload: { message: string } }
    | { type: 'set-theme-applied'; payload: { applied: boolean } };

const EXTENSION_TO_WEBVIEW_TYPES = new Set<ExtensionToWebviewMessage['type']>([
    'state-update',
]);

const WEBVIEW_TO_EXTENSION_TYPES = new Set<WebviewToExtensionMessage['type']>([
    'webview-ready',
    'request-save-plot',
    'request-open-externally',
    'report-error',
    'set-theme-applied',
]);

export function isExtensionToWebviewMessage(value: unknown): value is ExtensionToWebviewMessage {
    if (!value || typeof value !== 'object') return false;
    const msg = value as { type?: unknown; payload?: unknown };
    const t = msg.type;
    if (typeof t !== 'string' || !EXTENSION_TO_WEBVIEW_TYPES.has(t as ExtensionToWebviewMessage['type'])) {
        return false;
    }
    const p = msg.payload;
    if (!p || typeof p !== 'object') return false;

    switch (t) {
        case 'state-update': {
            const payload = p as Record<string, unknown>;
            const activeSession = payload.activeSession;
            if (activeSession !== null) {
                if (typeof activeSession !== 'object') return false;
                const s = activeSession as Record<string, unknown>;
                if (typeof s.sessionId !== 'string' ||
                    s.sessionId.length === 0 ||
                    s.sessionId.includes(':') ||
                    typeof s.httpgdBaseUrl !== 'string' ||
                    typeof s.httpgdToken !== 'string' ||
                    typeof s.upid !== 'number' ||
                    !Number.isInteger(s.upid) ||
                    s.upid < 0) {
                    // - sessionId must not contain `:` because the
                    //   svgCache uses `${sessionId}:${plotId}:...` as
                    //   its key; a session id with a colon would
                    //   collide with cross-session boundaries
                    //   (sessionId "a:b" colliding with sessionId "a"
                    //   for plotId "b").
                    // - upid must be a non-negative integer:
                    //   `Number.isInteger` excludes NaN, ±Infinity,
                    //   and fractional values; the `>= 0` check
                    //   rejects negative upids that pass isInteger.
                    //   httpgd never emits any of those, so locking
                    //   the guard down loses nothing.
                    return false;
                }
            }
            return typeof payload.sessionEnded === 'boolean'
                && typeof payload.themeApplied === 'boolean';
        }
        default:
            return false;
    }
}

export function isWebviewToExtensionMessage(value: unknown): value is WebviewToExtensionMessage {
    if (!value || typeof value !== 'object') return false;
    const msg = value as { type?: unknown; payload?: unknown };
    const t = msg.type;
    if (typeof t !== 'string' || !WEBVIEW_TO_EXTENSION_TYPES.has(t as WebviewToExtensionMessage['type'])) {
        return false;
    }
    const p = msg.payload;
    if (!p || typeof p !== 'object') return false;

    switch (t) {
        case 'webview-ready':
            return true;
        case 'request-save-plot': {
            const payload = p as Record<string, unknown>;
            return typeof payload.plotId === 'string' &&
                   (payload.format === 'png' || payload.format === 'svg' || payload.format === 'pdf');
        }
        case 'request-open-externally': {
            const payload = p as Record<string, unknown>;
            return typeof payload.plotId === 'string';
        }
        case 'report-error': {
            const payload = p as Record<string, unknown>;
            return typeof payload.message === 'string';
        }
        case 'set-theme-applied': {
            const payload = p as Record<string, unknown>;
            return typeof payload.applied === 'boolean';
        }
        default:
            return false;
    }
}
