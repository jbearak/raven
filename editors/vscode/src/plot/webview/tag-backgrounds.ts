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
 *   2. It is the only <rect> direct child of a <g> parent AND has
 *      `stroke="none"` (or no stroke attribute). This catches panel
 *      backgrounds (e.g. ggplot2's `panel.background` rect, sitting
 *      alone before the data layer) while leaving bar-chart bars
 *      (multiple <rect> siblings in a <g>) and `geom_rect()`
 *      annotations (which typically carry a stroke) untouched.
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

    // Parse via a detached <div> + innerHTML rather than DOMParser:
    // DOMPurify's output is HTML-style (not strictly well-formed XML
    // — closing tags, attribute quote conventions, etc.), and an
    // HTML-aware parser is the forgiving path. The browser's HTML
    // parser switches to foreign-content mode for `<svg>`, so the SVG
    // namespace and element semantics are preserved.
    const container = doc.createElement('div');
    container.innerHTML = svgText;
    const svg = container.querySelector('svg');
    if (!svg) return svgText;

    // `getElementsByTagName` returns a live HTMLCollection. We add
    // class attributes only (no element insertions/removals), so the
    // collection length stays stable and the index-based iteration is
    // safe.
    const rects = svg.getElementsByTagName('rect');
    for (let i = 0; i < rects.length; i++) {
        const rect = rects[i];
        if (is_background_rect(rect)) {
            add_class(rect, 'raven-bg');
        }
    }

    return container.innerHTML;
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
        // Rule 2: a single <rect> direct child of <g> with no stroke
        // is a background. Bar-chart bars come in multiples (count > 1
        // disqualifies); geom_rect() annotations typically carry a
        // stroke (non-`none` stroke disqualifies).
        const directRects = collect_direct_rect_children(parent);
        if (directRects.length !== 1) return false;
        const stroke = rect.getAttribute('stroke');
        return stroke === null || stroke === 'none';
    }

    return false;
}

function first_rect_child(parent: Element): Element | null {
    for (let n = parent.firstElementChild; n !== null; n = n.nextElementSibling) {
        if (n.localName === 'rect') return n;
    }
    return null;
}

function collect_direct_rect_children(parent: Element): Element[] {
    const out: Element[] = [];
    for (let n = parent.firstElementChild; n !== null; n = n.nextElementSibling) {
        if (n.localName === 'rect') out.push(n);
    }
    return out;
}

function add_class(el: Element, cls: string): void {
    const existing = el.getAttribute('class');
    if (!existing) {
        el.setAttribute('class', cls);
        return;
    }
    // Idempotent: a caller that runs the tagger twice should not get a
    // doubled class token.
    const tokens = existing.split(/\s+/);
    for (const t of tokens) {
        if (t === cls) return;
    }
    el.setAttribute('class', `${existing} ${cls}`);
}
