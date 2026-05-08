/**
 * Typed wire protocol between the help-viewer extension host and the
 * Svelte webview. No VS Code or DOM imports here.
 *
 * Rules:
 *  - No VS Code or DOM imports — this module must be importable from both sides.
 *  - Pure types + small runtime type-guards only.
 */

export type LoadPayload = {
    topic: string;
    package: string;
    title: string;
    html: string;
    anchor: string | null;
    /** Pixel offset to scroll the content area to after the load lands.
     * Captured by the state machine on back/forward navigation; 0 for
     * fresh navigations. The webview applies it after Svelte renders the
     * new HTML, but only when there is no anchor (the anchor wins). */
    scrollY: number;
};

/**
 * Single source of truth for valid error reason codes. The TypeScript
 * `ErrorPayload.reason` union and the runtime `validReasons` set both
 * derive from this constant, so a typo in either place becomes impossible.
 */
export const REASONS = [
    'not-found',
    'package-not-installed',
    'render-failed',
    'timeout',
    'r-unavailable',
    'invalid-topic',
    'too-large',
] as const;

export type ErrorPayload = {
    reason: typeof REASONS[number];
    message: string;
};

export type ExtensionToWebviewMessage =
    | { type: 'load'; payload: LoadPayload }
    | { type: 'loading'; payload: Record<string, never> }
    | { type: 'error'; payload: ErrorPayload }
    | { type: 'theme-changed'; payload: Record<string, never> }
    | { type: 'history-state'; payload: { canBack: boolean; canForward: boolean } };

export type NavigatePayload = {
    topic: string;
    package: string;
    anchor: string | null;
};

// External-link clicks (https/http/mailto) are intentionally NOT in the
// wire protocol: VS Code's webview already handles those natively (single
// trust prompt + browser open). Posting our own open-external message
// would race with VS Code's handler and produce a duplicate browser open.
export type WebviewToExtensionMessage =
    | { type: 'webview-ready'; payload: Record<string, never> }
    | { type: 'navigate'; payload: NavigatePayload }
    | { type: 'report-error'; payload: { message: string } }
    | { type: 'scroll'; payload: { y: number } }
    | { type: 'back'; payload: Record<string, never> }
    | { type: 'forward'; payload: Record<string, never> };

const EXTENSION_TO_WEBVIEW_TYPES = new Set<ExtensionToWebviewMessage['type']>([
    'load',
    'loading',
    'error',
    'theme-changed',
    'history-state',
]);

const WEBVIEW_TO_EXTENSION_TYPES = new Set<WebviewToExtensionMessage['type']>([
    'webview-ready',
    'navigate',
    'report-error',
    'scroll',
    'back',
    'forward',
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
        case 'load': {
            const payload = p as Record<string, unknown>;
            return (
                typeof payload.topic === 'string' &&
                typeof payload.package === 'string' &&
                typeof payload.title === 'string' &&
                typeof payload.html === 'string' &&
                (payload.anchor === null || typeof payload.anchor === 'string') &&
                typeof payload.scrollY === 'number'
            );
        }
        case 'loading':
        case 'theme-changed':
            return true;
        case 'error': {
            const payload = p as Record<string, unknown>;
            const validReasons: Set<string> = new Set(REASONS);
            return (
                typeof payload.reason === 'string' &&
                validReasons.has(payload.reason) &&
                typeof payload.message === 'string'
            );
        }
        case 'history-state': {
            const payload = p as Record<string, unknown>;
            return typeof payload.canBack === 'boolean' && typeof payload.canForward === 'boolean';
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
        case 'back':
        case 'forward':
            return true;
        case 'navigate': {
            const payload = p as Record<string, unknown>;
            return (
                typeof payload.topic === 'string' &&
                typeof payload.package === 'string' &&
                (payload.anchor === null || typeof payload.anchor === 'string')
            );
        }
        case 'report-error': {
            const payload = p as Record<string, unknown>;
            return typeof payload.message === 'string';
        }
        case 'scroll': {
            const payload = p as Record<string, unknown>;
            return typeof payload.y === 'number';
        }
        default:
            return false;
    }
}
