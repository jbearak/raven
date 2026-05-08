import * as path from 'path';

export type RewriteContext = {
    /** Absolute path to the help directory of the currently rendered topic
     * (the response's `helpDir`). */
    helpDir: string;
    /** All R `.libPaths()` from the response. Currently informational; kept for
     * future cross-package image support if it becomes a v2 goal. */
    libPaths: string[];
    /** Convert an absolute filesystem path to a webview URI. Injected by the
     * panel host (it has access to the actual `webview.asWebviewUri`). */
    asWebviewUri(absPath: string): string;
    /** Existence check. The webview would render a broken-image glyph for a
     * missing local file, so we drop the src instead — preferring an empty
     * `<img>` over a 404 indicator. Production wires this to `fs.existsSync`;
     * tests stub it. */
    fileExists(absPath: string): boolean;
};

/**
 * Rewrite `<img src="...">` URLs per the spec's image-serving classification:
 *
 * - `data:` schemes pass through unchanged (CSP allows `data:` for inline icons).
 * - `http:`, `https:`, `ftp:`, `mailto:`, `ws:`, `wss:`, `file:` are dropped
 *   (`src=""`) — no remote/file image fetches from the help viewer.
 * - Relative paths are resolved under `helpDir`, canonicalized, validated to
 *   stay under `helpDir`, then rewritten via `asWebviewUri`.
 * - Anything else (malformed schemes, control chars, etc.) is dropped.
 *
 * The rewrite is implemented as a regex sweep of `<img ... src="...">` rather
 * than DOM-parsing because the input is already sanitized by ammonia
 * server-side and is well-formed.
 */
export function rewriteImageSrcs(html: string, ctx: RewriteContext): string {
    const re = /(<img\b[^>]*\bsrc=)"([^"]*)"/gi;
    return html.replace(re, (_match, prefix, src) => {
        const newSrc = classifyAndResolve(src, ctx);
        return `${prefix}"${newSrc}"`;
    });
}

function classifyAndResolve(src: string, ctx: RewriteContext): string {
    if (src.startsWith('data:')) return src;
    if (
        src.startsWith('http:') ||
        src.startsWith('https:') ||
        src.startsWith('ftp:') ||
        src.startsWith('mailto:') ||
        src.startsWith('ws:') ||
        src.startsWith('wss:') ||
        src.startsWith('file:')
    ) {
        return '';
    }
    // Treat as relative path.
    const abs = path.resolve(ctx.helpDir, src);
    const canonHelpDir = path.resolve(ctx.helpDir);
    const rel = path.relative(canonHelpDir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return '';
    if (!ctx.fileExists(abs)) return '';
    return ctx.asWebviewUri(abs);
}
