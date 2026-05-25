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
 * SVG figures take a different path: the `<img src="figure/foo.svg">`
 * is replaced INLINE with the SVG markup itself (after DOMPurify
 * sanitization and structural background-rect tagging — see
 * `editors/vscode/src/plot/webview/sanitize.ts` and
 * `tag-backgrounds.ts`). Inline SVG is the substrate that lets the
 * Knit Output panel's "Apply VS Code theme" toggle recolor plot text
 * and strokes via CSS overlay — parent CSS does NOT cascade into
 * `<img>`-loaded SVG, regardless of whether the src is a file URL or
 * a data URI. The CSS rules live in `knit-output.ts:applyTheme()` and
 * mirror the plot viewer's recoloring scope exactly.
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
 *   - SVG bytes flow through `create_svg_sanitizer` (DOMPurify's SVG
 *     profile + FORBID_TAGS + FORBID_ATTR['style']). The threat model
 *     matches the plot viewer: defense in depth, not a primary security
 *     boundary — the user's R code can already exfil/RCE on the host,
 *     but the iframe's `style-src 'unsafe-inline'` makes CSS-exfiltration
 *     via `<style>` / `style=` worth blocking.
 *
 * Tests live in `tests/bun/inline-local-images.test.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { create_svg_sanitizer } from '../plot/webview/sanitize';
import { tag_background_rects_with_document } from '../plot/webview/tag-backgrounds';

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
 * True when `resolvedPath` is a file under `<docDir>/figure/` (any depth).
 * Used to gate inline-SVG substitution to knit-emitted plots — user-
 * included SVGs (logos, icons) referenced elsewhere in the doc dir keep
 * their data-URL path so their colors and fragment-identifier semantics
 * are preserved.
 */
function isKnitFigurePath(resolvedPath: string, docDir: string): boolean {
    const rel = path.relative(docDir, resolvedPath);
    if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    const firstSegment = rel.split(/[\\/]/, 1)[0];
    // Case-insensitive compare matches the way path extensions are
    // normalized elsewhere in this function (`.svg` is `.toLowerCase()`'d).
    // Windows filesystems are case-insensitive and a future markdown
    // renderer or user-customized `fig.path` may capitalize the segment.
    return firstSegment.toLowerCase() === KNIT_FIGURE_DIR;
}

/**
 * Class applied to the root `<svg>` of an inlined knit-preview plot. The
 * CSS overlay in `knit-output.ts:applyTheme()` scopes its recoloring rules
 * to `svg.raven-knit-plot` so unrelated SVGs in the rendered document
 * (e.g. user-included logos referenced via `<img src="logo.svg">`) are
 * untouched. Distinct from the plot viewer's `svg.httpgd` selector — the
 * two pipelines render into separate webviews and never share a DOM, but
 * keeping distinct markers avoids accidental cross-pipeline styling if the
 * panels are ever consolidated.
 */
export const KNIT_PLOT_SVG_CLASS = 'raven-knit-plot';

/**
 * Lazy-built jsdom context shared by every SVG processed in this extension
 * activation. JSDOM construction is multi-MB and ~50ms cold; deferring
 * the import until the first knit that emits an SVG keeps activation
 * fast for users who never knit. After first use we hold the window for
 * DOMPurify and the document for the background-rect tagger; both are
 * stateless across calls.
 */
interface SvgHostContext {
    sanitize: (text: string) => string;
    document: Document;
}
let _svgHostContext: SvgHostContext | null = null;

function getSvgHostContext(): SvgHostContext {
    if (_svgHostContext) return _svgHostContext;
    // require() rather than top-level import: jsdom is multi-megabyte; the
    // deferred load keeps cold extension activation fast for users who
    // never knit. jsdom is declared as a runtime dependency in
    // editors/vscode/package.json.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { JSDOM } = require('jsdom') as {
        JSDOM: new (html: string) => { window: { document: Document } & object };
    };
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    _svgHostContext = {
        sanitize: create_svg_sanitizer(dom.window),
        document: dom.window.document,
    };
    return _svgHostContext;
}

/**
 * Drop the lazy jsdom context. The module-scoped reference survives a
 * VS Code disable→enable cycle (the JS module isn't unloaded), so we
 * null it here to free the jsdom window's resources. Mirrors the
 * `disposeKnitGrammarRegistryForDeactivation` pattern in
 * `post-knit-renderer.ts` — see that function for the broader rationale.
 */
export function disposeSvgHostContextForDeactivation(): void {
    _svgHostContext = null;
}

/**
 * Reset the lazy jsdom context. Tests use this to start from a fresh
 * sanitizer + document so they can assert against deterministic state.
 */
export function __resetSvgHostContextForTest(): void {
    _svgHostContext = null;
}

/**
 * Turn raw SVG text from disk into the inline `<svg>` markup we drop into
 * the rendered HTML in place of an `<img src="figure/*.svg">` element.
 *
 * Pipeline (mirrors the plot viewer's webview ingest):
 *   1. DOMPurify sanitization (SVG profile, FORBID_TAGS, FORBID_ATTR=style).
 *   2. Parse the sanitized SVG into the jsdom document, add the
 *      `raven-knit-plot` class to the root `<svg>` so the CSS overlay
 *      in `knit-output.ts:applyTheme()` can target it, and tag
 *      structural background rects with `raven-bg` so the overlay can
 *      hide them without a color allowlist.
 *   3. Serialize the SVG back to a string via `outerHTML`.
 *
 * The DOM walk (class addition + bg-rect tagging) reuses the same parse
 * via `tag_background_rects_with_document`'s existing pipeline. We
 * `classList.add` on the parsed root before the tagger runs so the
 * single parse-and-serialize covers both mutations.
 *
 * Returns null if the sanitizer threw or if the parsed SVG didn't
 * survive a round-trip — the caller leaves the `<img>` in place so the
 * user sees a broken-image icon rather than silently missing content.
 */
function buildInlineKnitPlotSvg(
    svgText: string,
    sourcePath: string,
    output: InlineImagesOutputSink | undefined,
): string | null {
    try {
        const ctx = getSvgHostContext();
        const sanitized = ctx.sanitize(svgText);
        if (sanitized.length === 0) {
            output?.appendLine(
                `[panel] inline SVG sanitizer returned empty output for ${sourcePath}`,
            );
            return null;
        }
        // Parse via the same detached-<div> + innerHTML route the
        // background-rect tagger uses, add the marker class on the root
        // <svg> with the standard DOM API (classList.add is idempotent
        // and handles SVG attributes correctly), then hand the
        // already-classed text to tag_background_rects_with_document
        // for the bg-rect pass. A string-level regex for the class
        // addition would risk breaking on missing attribute separators
        // and would double-parse the SVG.
        const container = ctx.document.createElement('div');
        container.innerHTML = sanitized;
        const svg = container.querySelector('svg');
        if (!svg) return null;
        svg.classList.add(KNIT_PLOT_SVG_CLASS);
        return tag_background_rects_with_document(svg.outerHTML, ctx.document);
    } catch (err) {
        output?.appendLine(
            `[panel] could not inline SVG ${sourcePath}: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
        return null;
    }
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

        if (ext === '.svg' && isKnitFigurePath(resolved, docDir)) {
            // SVG plots use a separate substrate from PNG/JPEG/etc.: instead
            // of a data URL inside an `<img>` (which CSS can't recolor),
            // the bytes are inlined as raw `<svg>` markup so the Knit
            // Output panel's "Apply VS Code theme" overlay can recolor
            // text and strokes via CSS. The SVG fragment identifier
            // (`#viewname`) is intentionally dropped here — inline SVG
            // has no URL to navigate to, and knitr's svglite never emits
            // named `<view>` elements.
            //
            // Scoping to the `figure/` subdir mirrors knitr's default
            // `fig.path` (set by `buildKnitExpression`). User-included
            // SVG logos referenced via `<img src="logo.svg">` (elsewhere
            // in the doc dir) fall through to the data-URL path below,
            // so they keep their original colors and fragment-identifier
            // semantics.
            let svgText: string;
            try {
                svgText = fs.readFileSync(resolved, 'utf8');
            } catch (err) {
                output?.appendLine(
                    `[panel] could not read SVG ${resolved}: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
                return match;
            }
            const inlineSvg = buildInlineKnitPlotSvg(svgText, resolved, output);
            // Fall through to the broken-image-icon path on failure (the
            // `<img>` stays in place, pointing at a relative path the
            // nested-iframe can't resolve — same failure mode as before
            // for any other unsupported asset).
            return inlineSvg ?? match;
        }

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
