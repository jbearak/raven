/**
 * Inline relative `<img src>` references in a rendered HTML document
 * as `data:` URLs read from disk. The function is the workaround for
 * a nested-iframe subresource issue in the Knit Output panel.
 *
 * Why this exists
 * ---------------
 *
 * The Knit Output webview shell wraps the rendered HTML in a nested
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
 * Knit-emitted SVG figures get an extra marker attribute:
 * `data-raven-knit-plot="1"` is added to the `<img>` when the resolved
 * path is under `<docDir>/figure/`. The webview shell's iframe-load
 * promotion pass (`promoteKnitPlotSvgs` in `knit-output.ts`) walks those
 * marked `<img>` elements, decodes the data URL, parses the SVG via the
 * iframe's real DOM, applies an allowlist sanitization pass, tags
 * background rects, and swaps the `<img>` for an inline `<svg
 * class="raven-knit-plot">`. Inline SVG is the substrate the Knit
 * Output panel's "Apply VS Code theme" toggle needs — parent CSS does
 * NOT cascade into `<img>`-loaded SVG regardless of URL scheme. User-
 * included SVGs outside the `figure/` directory get no marker and keep
 * their original colors.
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
 *   - SVG sanitization happens webview-side, NOT here — see
 *     `promoteKnitPlotSvgs` in `knit-output.ts`. The threat model
 *     matches the plot viewer (the user's R code can already RCE on
 *     the host); the iframe sandbox plus the panel CSP (`default-src
 *     'none'`, `style-src ${cspSource} 'unsafe-inline'`, no `connect-src`)
 *     block scripts and external-resource exfiltration vectors, and
 *     the promotion pass strips the obvious leftovers (`<script>`,
 *     `<style>`, `<foreignObject>`, `<a>`, `<use>`, `<image>`,
 *     `<feImage>`, `style=`, `on*=`) as defense in depth.
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

/**
 * Top-level directory (relative to the doc dir) where knitr writes
 * figures. Hardcoded to `'figure/'` to match `figPath` in
 * `buildKnitExpression` (knit-commands.ts). If we ever expose `fig.path`
 * as a configurable option, this becomes a parameter.
 */
const KNIT_FIGURE_DIR = 'figure';

/**
 * Attribute the webview's iframe-load promotion pass looks for to
 * identify SVG `<img>` tags it should promote to inline `<svg
 * class="raven-knit-plot">`. The host adds the attribute when the
 * resolved file lives under `<docDir>/figure/`; user-included SVGs
 * elsewhere in the doc dir are left untouched.
 */
const KNIT_PLOT_MARKER_ATTR = 'data-raven-knit-plot';

/**
 * Class that ends up on the root `<svg>` after the webview promotion
 * pass — the CSS overlay in `knit-output.ts:applyTheme()` scopes its
 * recoloring rules to this selector. Kept here as the single source of
 * truth so the promoter (which assembles class names as JS strings) and
 * downstream callers stay in lockstep.
 */
export const KNIT_PLOT_SVG_CLASS = 'raven-knit-plot';

/**
 * True when `resolvedPath` is a file under `<docDir>/figure/` (any depth).
 * Used to gate the `data-raven-knit-plot` marker addition to knit-
 * emitted plots — user-included SVGs (logos, icons) referenced
 * elsewhere in the doc dir keep their unmarked data-URL `<img>` so
 * their colors and fragment-identifier semantics are preserved.
 */
function isKnitFigurePath(resolvedPath: string, docDir: string): boolean {
    const rel = path.relative(docDir, resolvedPath);
    if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    const firstSegment = rel.split(/[\\/]/, 1)[0];
    // Case-insensitive compare matches the way path extensions are
    // normalized elsewhere in this function (`.svg` is `.toLowerCase()`'d).
    // Windows filesystems are case-insensitive and a future markdown
    // renderer may capitalize the segment.
    return firstSegment.toLowerCase() === KNIT_FIGURE_DIR;
}

export function inlineLocalImagesAsDataUrls(
    html: string,
    docDir: string,
    output?: InlineImagesOutputSink,
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
        let rewrittenAttrs = attrs.replace(srcMatch[0], `src="${dataUrl}"`);
        // Mark knit-emitted SVG figures so the webview shell's
        // iframe-load promotion pass can find them and swap them for
        // inline <svg>. The marker stays out of any other SVG path
        // (user-included logos referenced via `<img src="logo.svg">`
        // elsewhere in the doc) so those keep their data-URL `<img>`
        // and original colors.
        if (ext === '.svg' && isKnitFigurePath(resolved, docDir)) {
            rewrittenAttrs = `${rewrittenAttrs} ${KNIT_PLOT_MARKER_ATTR}="1"`;
        }
        return `<img${rewrittenAttrs}>`;
    });
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
