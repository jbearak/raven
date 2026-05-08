import type { WebviewToExtensionMessage } from '../messages';

/**
 * Classify a click event whose target may be inside (or be) an <a> element,
 * and post the appropriate WebviewToExtensionMessage.
 *
 * Returns true if the event was handled (preventDefault was called). Returns
 * false if the link is a pure in-page hash anchor (#section) — the caller's
 * default browser behavior (native scroll) should run.
 *
 * @param event    - Event-like object with `target` and `preventDefault`.
 *                   Accepts both MouseEvent and KeyboardEvent without casts.
 * @param href     - The raw href attribute from the closest <a> ancestor, or
 *                   null if the anchor has no href. Computed by the caller.
 * @param isDropped - True if the anchor carries `data-raven-dropped="1"`,
 *                   indicating server-neutralized link. Computed by the caller.
 * @param postMessage - Callback to send a message to the extension host.
 */
export function classifyAndDispatch(
    event: { target: EventTarget | null; preventDefault: () => void },
    href: string | null,
    isDropped: boolean,
    postMessage: (msg: WebviewToExtensionMessage) => void,
): boolean {
    const rawHref = href ?? '';

    // Anchors rewritten by server neutralization carry data-raven-dropped="1".
    // Treat them as disallowed links regardless of the href.
    if (isDropped) {
        event.preventDefault();
        postMessage({
            type: 'report-error',
            payload: { message: `Blocked neutralized link: ${rawHref}` },
        });
        return true;
    }

    // Pure hash anchor (#section) — let browser scroll natively.
    // Must start with '#' and must not contain '://' (rules out any scheme).
    if (rawHref.startsWith('#') && !rawHref.includes('://')) {
        // No preventDefault — native scroll.
        return false;
    }

    // raven-help://topic/<pkg>/<topic>[#anchor]
    if (rawHref.startsWith('raven-help://topic/')) {
        event.preventDefault();
        try {
            const url = new URL(rawHref);
            // pathname is /<pkg>/<topic>
            const parts = url.pathname.replace(/^\//, '').split('/');
            if (parts.length < 2 || !parts[0] || !parts[1]) {
                throw new Error(`Malformed raven-help URL: ${rawHref}`);
            }
            const pkg = decodeURIComponent(parts[0]);
            const topic = decodeURIComponent(parts[1]);
            const rawAnchor = url.hash.startsWith('#') ? url.hash.slice(1) : null;
            const anchorDecoded = rawAnchor ? decodeURIComponent(rawAnchor) : null;
            postMessage({
                type: 'navigate',
                payload: { topic, package: pkg, anchor: anchorDecoded },
            });
        } catch (err) {
            postMessage({
                type: 'report-error',
                payload: { message: `Invalid raven-help URL: ${rawHref} — ${String(err)}` },
            });
        }
        return true;
    }

    // External URLs — https, http, mailto.
    //
    // Hand-off to VS Code's built-in webview link handling. VS Code shows a
    // single "Do you want to open this URL?" trust prompt and then opens
    // the user's default browser. If we preventDefault and post an
    // open-external message, both that path and our manual openExternal
    // call fire — the user gets a duplicate browser-open AND a stray
    // dialog. Returning false here is the documented webview pattern.
    if (
        rawHref.startsWith('https://') ||
        rawHref.startsWith('http://') ||
        rawHref.startsWith('mailto:')
    ) {
        return false;
    }

    // Everything else (javascript:, data:, file://, relative paths, other
    // schemes, empty href, etc.) — prevent and report.
    event.preventDefault();
    postMessage({
        type: 'report-error',
        payload: { message: `Disallowed link: ${rawHref}` },
    });
    return true;
}
