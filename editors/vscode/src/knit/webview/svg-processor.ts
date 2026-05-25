/**
 * Webview-side SVG processor for the Knit Output panel.
 *
 * The Knit Output panel's shell HTML is a template-string JS payload
 * (no Svelte/React framework), but the SVG sanitization + background-
 * rect tagging it needs to do is non-trivial. Rather than reimplement
 * DOMPurify-based sanitization and the structural bg-rect tagger
 * inside the template string (where it can't be unit-tested and where
 * we already drifted from the plot viewer's reference implementation),
 * this entry point bundles the plot viewer's modules directly. The
 * extension build pipeline (`scripts/build.js`) emits this as an IIFE
 * to `dist/webviews/knit-svg/index.js` and the shell loads it via a
 * `<script src=webview-uri>` tag. The IIFE assigns its single exported
 * function to `window.RavenKnitSvg.processKnitPlotSvg`.
 *
 * The processor combines three steps that the plot viewer does
 * piecewise on each httpgd render:
 *   1. `sanitize_svg` (from ../../plot/webview/sanitize.ts) — DOMPurify
 *      SVG-profile + FORBID_TAGS + FORBID_ATTR['style'], preceded by
 *      `migrate_inline_styles_to_attributes` so fill/stroke/font
 *      survive the strip.
 *   2. `tag_background_rects` (from ../../plot/webview/tag-backgrounds.ts)
 *      — structural canvas/panel-bg tagger that adds class="raven-bg"
 *      to rects matching the heuristic.
 *   3. Add class="raven-knit-plot" to the root <svg> so the Knit
 *      Output panel's CSS overlay can scope its recoloring rules.
 *
 * Why both steps happen in the webview rather than in the extension
 * host: jsdom doesn't bundle cleanly via esbuild
 * (xhr-sync-worker.js's top-level `require.resolve` throws inside the
 * bundle). The webview already has a real DOM — the outer shell
 * document — which DOMPurify and the bg-rect tagger can use
 * unchanged.
 */
import { sanitize_svg } from '../../plot/webview/sanitize';
import { tag_background_rects } from '../../plot/webview/tag-backgrounds';

/**
 * Class added to the root <svg> of every processed knit plot. The CSS
 * overlay in knit-output.ts's applyTheme() scopes its recoloring
 * rules to `svg.raven-knit-plot`, so unrelated SVGs in the iframe
 * (e.g. user-included logos) are untouched. Mirrors the
 * `svg.httpgd` marker the plot viewer uses for the same scoping job.
 */
const KNIT_PLOT_CLASS = 'raven-knit-plot';

/**
 * Add a class to the root <svg> via the same parse-and-serialize
 * round-trip `tag_background_rects` uses. Returns the input unchanged
 * if the document doesn't have an <svg> root (e.g. the sanitizer
 * stripped everything).
 */
function add_root_svg_class(svgText: string, cls: string): string {
    if (!svgText) return svgText;
    const doc = (globalThis as { document?: Document }).document;
    if (!doc) return svgText;
    const container = doc.createElement('div');
    container.innerHTML = svgText;
    const svg = container.querySelector('svg');
    if (!svg) return svgText;
    svg.classList.add(cls);
    return svg.outerHTML;
}

/**
 * Process a knit-emitted SVG (as text) into the inline `<svg>` markup
 * that goes into the Knit Output iframe. Sanitizes, tags background
 * rects, and stamps the `raven-knit-plot` class on the root.
 *
 * Returns the empty string on failure so the caller can leave the
 * original `<img>` in place rather than insert a broken element.
 */
export function processKnitPlotSvg(svgText: string): string {
    try {
        const sanitized = sanitize_svg(svgText);
        if (!sanitized) return '';
        const tagged = tag_background_rects(sanitized);
        return add_root_svg_class(tagged, KNIT_PLOT_CLASS);
    } catch {
        return '';
    }
}
