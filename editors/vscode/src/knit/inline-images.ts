/**
 * Inline relative `<img src>` references in a rendered HTML document
 * as `data:` URLs read from disk. The function is the workaround for
 * a nested-iframe subresource issue in the Knit Preview panel.
 *
 * Why this exists
 * ---------------
 *
 * The Knit Preview webview shell wraps the rendered HTML in a nested
 * `<iframe srcdoc>` (see `knit-output.ts`). VS Code's webview
 * resource handler intercepts requests issued from the OUTER webview
 * document, but it does NOT intercept subresource fetches (`<img>`,
 * `<link>`, `<video>`, etc.) issued from a NESTED iframe — the
 * Electron protocol handler only sees top-level webview navigations.
 *
 * The visible failure mode: a `<base href="webview-resource://…">`
 * resolves an `<img src="figure/plot-1.png">` to a URL like
 * `https://file+.vscode-resource.vscode-cdn.net/.../figure/plot-1.png`,
 * which escapes the protocol handler and hits the real network
 * stack. The DNS lookup for `file+.vscode-resource.vscode-cdn.net`
 * fails, the image element fires `load` with `naturalWidth === 0`,
 * and the user sees the broken-image icon — even though the same
 * `.html` opened directly in a browser renders the image fine.
 *
 * The fix: pre-process the HTML at panel-render time, read each
 * relative image file from disk, encode as a `data:` URL, and
 * substitute it back into the `src` attribute. `data:` URLs are
 * scheme-internal and never touch the protocol handler, so they
 * survive the nested-iframe boundary unchanged.
 *
 * Only the in-memory copy handed to the iframe is rewritten. The
 * on-disk `.html` the post-knit renderer wrote keeps file-relative
 * `<img>` paths, so "Open in Browser" still produces a small file
 * with the original asset references.
 *
 * Security notes
 * --------------
 *
 *   - Absolute URLs (http/https/data/file/etc.) are passed through
 *     untouched; this function only touches relative paths.
 *   - The resolved file MUST live under `docDir` (after `..`
 *     collapse). Path traversal attempts (`<img src="../../etc/...">`)
 *     are left in place so the user gets a visible failure instead
 *     of a silent file-read.
 *   - Unknown extensions (anything not in
 *     `mimeForImageExtension`) are passed through; we don't read
 *     arbitrary file types off disk in case a future markdown
 *     pipeline starts producing `<img>` to non-image resources.
 *
 * Tests live in `tests/bun/inline-local-images.test.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * The minimum surface a logging sink needs to receive an inlining
 * failure message. Production code passes a `vscode.OutputChannel`;
 * tests can pass an in-memory collector or omit.
 */
export interface InlineImagesOutputSink {
    appendLine(line: string): void;
}

export interface InlineImagesOptions {
    /**
     * Mark local `figure/*.svg` images so the Knit Preview shell can
     * replace them with sanitized inline SVG nodes inside the sandboxed
     * iframe. The marker is opt-in because this helper is also useful
     * as a plain "data URL all local images" transform in tests and
     * future callers.
     */
    markSvgPlots?: boolean;
}

export function inlineLocalImagesAsDataUrls(
    html: string,
    docDir: string,
    output?: InlineImagesOutputSink,
    options: InlineImagesOptions = {},
): string {
    return html.replace(/<img\b([^>]*)>/gi, (match, attrs: string) => {
        const srcMatch = attrs.match(/\bsrc\s*=\s*"([^"]*)"/i)
            ?? attrs.match(/\bsrc\s*=\s*'([^']*)'/i);
        if (!srcMatch) return match;
        const src = srcMatch[1];

        // Already an absolute URL (any scheme, e.g. `https:`,
        // `data:`, `vscode-webview:`, `file:`) — pass through.
        if (/^(?:[a-z][a-z0-9+\-.]*:)/i.test(src)) return match;
        // Protocol-relative URL.
        if (src.startsWith('//')) return match;
        // Absolute filesystem path — pass through; we deliberately
        // don't read out-of-doc files, even when they're absolute.
        if (path.isAbsolute(src)) return match;

        // Split src into the path portion and any trailing
        // `?query` / `#fragment` suffix. htmlwidgets and similar
        // markdown renderers sometimes emit cache-busters
        // (`figure/plot.png?v=1`) and SVG view fragments
        // (`diagram.svg#layer-1`). If we feed the whole src to
        // `path.resolve` / `path.extname`, the suffix lands inside
        // the filename and:
        //   - the file-resolution `path.resolve(docDir, 'foo.png?v=1')`
        //     points at a non-existent file (silent failure: the
        //     src is returned unchanged and the broken-image icon
        //     still surfaces in the nested iframe);
        //   - `path.extname` returns `.png?v=1`, which doesn't map
        //     to a MIME and the inline pass bails out.
        //
        // Splitting on the first `?` or `#` recovers the original
        // file path. The fragment portion is re-attached to the
        // emitted data URL because SVG fragment identifiers can
        // navigate to a specific `<view>` element when used in
        // `<img src="x.svg#viewname">`. The query portion is
        // meaningless on a data URL (the URL itself IS the
        // content, so there's nothing to cache-bust) but is also
        // preserved for round-trip honesty — the cost is just a
        // few extra bytes in the rewritten HTML.
        const suffixStart = src.search(/[?#]/);
        const srcPath = suffixStart >= 0 ? src.slice(0, suffixStart) : src;
        const srcSuffix = suffixStart >= 0 ? src.slice(suffixStart) : '';

        // Strip a leading `./` (doesn't change semantics, just keeps
        // the path-traversal check simpler).
        const relative = srcPath.replace(/^\.\//, '');
        const resolved = path.resolve(docDir, relative);
        const docDirNorm = path.resolve(docDir) + path.sep;
        if (!(resolved + path.sep).startsWith(docDirNorm)) return match;
        const normalizedRelative = path.relative(path.resolve(docDir), resolved);

        const ext = path.extname(resolved).toLowerCase();
        const mime = mimeForImageExtension(ext);
        if (!mime) return match;

        let bytes: Buffer;
        try {
            bytes = fs.readFileSync(resolved);
        } catch (err) {
            output?.appendLine(
                `[panel] could not inline image ${resolved}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            return match;
        }

        const dataUrl = `data:${mime};base64,${bytes.toString('base64')}${srcSuffix}`;
        const rewrittenAttrs = attrs.replace(srcMatch[0], `src="${dataUrl}"`);
        const finalAttrs = options.markSvgPlots && ext === '.svg' && isKnitFigurePath(normalizedRelative)
            ? withImgAttribute(rewrittenAttrs, 'data-raven-plot-svg', 'true')
            : rewrittenAttrs;
        return `<img${finalAttrs}>`;
    });
}

function isKnitFigurePath(relativePath: string): boolean {
    const parts = relativePath.split(/[\\/]+/).filter(Boolean);
    return parts.length >= 2 && parts[0] === 'figure';
}

function withImgAttribute(attrs: string, name: string, value: string): string {
    const attrPattern = new RegExp(
        `\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`,
        'i',
    );
    const withoutExisting = attrs.replace(attrPattern, '');
    const attr = ` ${name}="${value}"`;
    const selfClosing = withoutExisting.match(/\s*\/\s*$/);
    if (!selfClosing) return withoutExisting + attr;
    return withoutExisting.slice(0, selfClosing.index) + attr + selfClosing[0];
}

export function mimeForImageExtension(ext: string): string | null {
    switch (ext) {
        case '.png': return 'image/png';
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.gif': return 'image/gif';
        case '.svg': return 'image/svg+xml';
        case '.webp': return 'image/webp';
        case '.bmp': return 'image/bmp';
        case '.ico': return 'image/x-icon';
        case '.avif': return 'image/avif';
        default: return null;
    }
}
