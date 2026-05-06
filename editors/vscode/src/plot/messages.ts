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
};

export type StateUpdatePayload = {
    activeSession: ActiveSessionInfo | null;
    sessionEnded: boolean;
};

export type ExtensionToWebviewMessage =
    | { type: 'state-update'; payload: StateUpdatePayload }
    | { type: 'theme-changed'; payload: Record<string, never> };

export type WebviewToExtensionMessage =
    | { type: 'webview-ready'; payload: Record<string, never> }
    | { type: 'request-save-plot'; payload: { plotId: string; format: SaveFormat } }
    | { type: 'request-open-externally'; payload: { plotId: string } }
    | { type: 'report-error'; payload: { message: string } };

const EXTENSION_TO_WEBVIEW_TYPES = new Set<string>([
    'state-update',
    'theme-changed',
]);

const WEBVIEW_TO_EXTENSION_TYPES = new Set<string>([
    'webview-ready',
    'request-save-plot',
    'request-open-externally',
    'report-error',
]);

export function isExtensionToWebviewMessage(value: unknown): value is ExtensionToWebviewMessage {
    if (!value || typeof value !== 'object') return false;
    const t = (value as { type?: unknown }).type;
    return typeof t === 'string' && EXTENSION_TO_WEBVIEW_TYPES.has(t);
}

export function isWebviewToExtensionMessage(value: unknown): value is WebviewToExtensionMessage {
    if (!value || typeof value !== 'object') return false;
    const t = (value as { type?: unknown }).type;
    return typeof t === 'string' && WEBVIEW_TO_EXTENSION_TYPES.has(t);
}
