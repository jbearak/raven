/**
 * Tag canvas/panel "background" rects in a sanitized httpgd SVG with
 * `class="raven-bg"` so the plot viewer's "Apply VS Code theme" overlay
 * can hide them without a hand-maintained colour allowlist.
 *
 * A <rect> is tagged when EITHER:
 *
 *   1. It is the first <rect> direct child of <svg> — httpgd's outer
 *      canvas always sits in that slot, regardless of fill.
 *
 *   2. It is a <rect> direct child of a <g> AND has neither
 *      `stroke-linejoin` nor `stroke-linecap` attributes. ggplot2's
 *      element_rect (used for `panel.background`, `plot.background`,
 *      etc.) and httpgd's inner canvas rect render with no linejoin/
 *      linecap (their grid defaults match httpgd's defaults). Data
 *      rects (geom_rect / geom_bar / geom_col / geom_tile) ALWAYS
 *      carry both attributes because GeomRect's defaults
 *      (`linejoin = "mitre"`, `lineend = "butt"`) differ from
 *      httpgd's "round" / "round" defaults and are therefore emitted.
 *
 * This was verified empirically by capturing real httpgd output for
 * ggplot's `theme_gray()` scatter and bar charts (see the
 * `tests/fixtures/httpgd/ggplot-*.svg` snapshots): the inner-canvas
 * rect arrives as `stroke="#FFFFFF" fill="#FFFFFF"` (stroke matches
 * fill, not "none"), and the panel.bg rect lives alongside data bars
 * in the same `<g>`. A "stroke=none AND only-rect-in-g" rule misses
 * both. Filtering by linejoin/linecap presence catches them and
 * rejects the bars correctly.
 *
 * The previous mechanism was a CSS `rect[fill="#FFFFFF" i], rect[fill=
 * "#EBEBEB" i]` allowlist — brittle: every non-default ggplot theme
 * (`theme_dark()` = grey50, user-customized themes) needed a new entry,
 * and a legitimate `geom_rect()` annotation that happened to land on
 * an allowlisted colour would silently vanish. Tagging by structure
 * generalizes across themes and is colour-agnostic.
 *
 * Determinism: this function is a pure transform of the SVG text, so
 * the fetch effect's cache (keyed by `(sessionId, plotId, width, height)`)
 * can store the post-tag bytes alongside any other tagged output for
 * the same input.
 */
export function tag_background_rects(svgText: string): string {
    if (!svgText) return svgText;
    // The webview's document is the real browser document; in bun tests
    // it's jsdom's document installed into globalThis via beforeAll.
    const doc = (globalThis as { document?: Document }).document;
    if (!doc) return svgText;
    return tag_background_rects_with_document(svgText, doc);
}

/**
 * Same as `tag_background_rects`, but takes the DOM Document explicitly
 * instead of reading `globalThis.document`. Used by the Knit Preview's
 * host-side SVG inlining pipeline, which runs in Node.js with a jsdom-
 * provided document — `globalThis.document` is unset in that context, so
 * the bare `tag_background_rects` falls through to a no-op.
 *
 * The plot viewer's webview path keeps using `tag_background_rects`
 * unchanged; the parameterized form here is a strict superset of its
 * behavior with the Document plumbed in.
 */
export function tag_background_rects_with_document(svgText: string, doc: Document): string {
    if (!svgText) return svgText;

    // Parse via a detached <div> + innerHTML: DOMPurify's output is
    // HTML-style (not strictly well-formed XML), and the HTML parser
    // is the forgiving path. `<svg>` triggers foreign-content insertion,
    // so the SVG namespace and element semantics are preserved.
    const container = doc.createElement('div');
    container.innerHTML = svgText;
    const svg = container.querySelector('svg');
    if (!svg) return svgText;

    // `querySelectorAll` returns a static NodeList and handles
    // namespaced (SVG) elements consistently across browsers — safer
    // than `getElementsByTagName` for descendant-of-SVG queries.
    const rects = svg.querySelectorAll('rect');
    for (const rect of rects) {
        if (is_background_rect(rect)) {
            // classList.add() is idempotent, handles whitespace
            // normalization, and works uniformly on SVG and HTML
            // elements.
            rect.classList.add('raven-bg');
        }
    }

    // Serialize the SVG element directly, not the wrapping <div>.
    // Reading `container.innerHTML` would re-serialize the SVG inside
    // the HTML <div>, which in some browsers strips the `xmlns`
    // declaration when the namespace is implicit. `svg.outerHTML`
    // preserves attribute fidelity.
    return svg.outerHTML;
}

function is_background_rect(rect: Element): boolean {
    const parent = rect.parentElement;
    if (!parent) return false;

    if (parent.localName === 'svg') {
        // Rule 1: tag the first <rect> direct child of <svg> regardless
        // of fill — httpgd's outer canvas is always there. A subsequent
        // <rect> direct child of <svg> (rare in practice) is treated
        // as content and left alone.
        return first_rect_child(parent) === rect;
    }

    if (parent.localName === 'g') {
        // Rule 2: ggplot2 backgrounds (element_rect) and httpgd's
        // inner canvas render WITHOUT `stroke-linejoin` / `stroke-
        // linecap` attributes — their R-side defaults match httpgd's
        // SVG defaults, so the attributes aren't emitted. Data rects
        // (GeomRect / GeomBar / GeomCol / GeomTile) ALWAYS carry both
        // attributes because GeomRect defaults to `linejoin = "mitre"`
        // / `lineend = "butt"`, which differ from httpgd's defaults
        // and get emitted explicitly. The presence test cleanly
        // separates them.
        if (rect.hasAttribute('stroke-linejoin')) return false;
        if (rect.hasAttribute('stroke-linecap')) return false;
        return true;
    }

    return false;
}

function first_rect_child(parent: Element): Element | null {
    for (let n = parent.firstElementChild; n !== null; n = n.nextElementSibling) {
        if (n.localName === 'rect') return n;
    }
    return null;
}
