<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import {
        bg_for_fetch,
        initial_state,
        pick_current_svg,
        reduce,
        svg_cache_key,
    } from './state';
    import type { ViewerState, SvgEntry } from './state';
    import {
        create_httpgd_client,
        plot_url,
    } from './httpgd-client';
    import type { HttpgdClient } from './httpgd-client';
    import type {
        WebviewToExtensionMessage,
        SaveFormat,
    } from '../messages';
    import { isExtensionToWebviewMessage } from '../messages';
    import { sanitize_svg } from './sanitize';
    import { tag_background_rects } from './tag-backgrounds';

    interface Props {
        vscode: { postMessage(msg: WebviewToExtensionMessage): void };
    }

    let { vscode }: Props = $props();
    let state = $state<ViewerState>(initial_state());
    let client: HttpgdClient | null = null;
    let viewportEl: HTMLDivElement | undefined = $state();
    let dimensions = $state({ width: 800, height: 600 });
    let copy_status = $state<'' | 'copying' | 'copied'>('');
    let copy_status_timer: ReturnType<typeof setTimeout> | null = null;
    let resize_timer: ReturnType<typeof setTimeout> | null = null;
    // Tracks the in-flight SVG fetcher so a superseded fetch is aborted
    // when a fresh `(plotId, upid, dimensions, themeApplied)` lands.
    let last_fetcher: AbortController | null = null;
    // Tracks the URL the current `last_fetcher` is fetching. A spurious
    // effect run (e.g. toggle flip on a cold cache) would otherwise
    // abort the in-flight fetch and re-issue the identical request;
    // comparing URLs lets us preserve the in-flight controller across
    // such cases.
    let last_fetcher_url: string | null = null;

    function dispatch(action: import('./state').ViewerAction) {
        state = reduce(state, action);
    }

    function refresh_plots() {
        if (!client) return;
        client.fetchPlotIds().then(ids => {
            dispatch({ type: 'SET_PLOT_IDS', plotIds: ids });
        }).catch(err => {
            vscode.postMessage({
                type: 'report-error',
                payload: { message: `httpgd plot list: ${String(err)}` },
            });
        });
    }

    function attach_session(active: ViewerState['activeSession'], sessionEnded: boolean) {
        // Skip close+recreate when the same live session is delivering a
        // redundant state-update — the cross-panel broadcast that
        // accompanies every `set-theme-applied` would otherwise tear
        // down and recreate the httpgd WebSocket on every toggle flip
        // for every open panel. Comparing sessionId+token+ended state
        // is sufficient: a real swap changes at least one of them.
        const current = state.activeSession;
        const sameLiveSession =
            current !== null
            && active !== null
            && !sessionEnded
            && !state.sessionEnded
            && current.sessionId === active.sessionId
            && current.httpgdToken === active.httpgdToken
            && current.httpgdBaseUrl === active.httpgdBaseUrl;
        if (sameLiveSession) {
            // Reducer no-op short-circuits when activeSession+sessionEnded
            // are unchanged; this branch just preserves the existing
            // WebSocket connection across redundant state-updates.
            dispatch({ type: 'SET_ACTIVE_SESSION', activeSession: active, sessionEnded: false });
            return;
        }
        client?.close();
        if (!active || sessionEnded) {
            dispatch({ type: 'SET_ACTIVE_SESSION', activeSession: active, sessionEnded });
            if (sessionEnded) dispatch({ type: 'SESSION_ENDED' });
            return;
        }
        dispatch({ type: 'SET_ACTIVE_SESSION', activeSession: active, sessionEnded: false });
        client = create_httpgd_client(active.httpgdBaseUrl, active.httpgdToken);
        client.subscribe(refresh_plots);
    }

    function on_message(event: MessageEvent) {
        // Defense-in-depth: validate inbound host messages with the
        // same guard the host uses for inbound webview messages. The
        // host is trusted today, but reusing the wire-protocol guard
        // makes the round-2 sessionId/upid restrictions actually
        // enforce on the webview side too, and shields against any
        // future host bug that might post a malformed payload.
        if (!isExtensionToWebviewMessage(event.data)) return;
        const msg = event.data;
        switch (msg.type) {
            case 'state-update':
                attach_session(msg.payload.activeSession, msg.payload.sessionEnded);
                // No-echo invariant: we MUST NOT post `set-theme-applied`
                // in response to a `state-update`. The button click is
                // the only outbound source. The reducer's
                // SET_THEME_APPLIED case short-circuits when the value
                // is unchanged so the broadcast echo costs nothing.
                dispatch({
                    type: 'SET_THEME_APPLIED',
                    themeApplied: msg.payload.themeApplied,
                });
                break;
        }
    }

    // Track whether on_resize has produced a real measurement yet so
    // the first call (from onMount) updates synchronously rather than
    // waiting 100ms. Without this, the first fetch fires against the
    // 800x600 default and a second fetch follows once the debounced
    // update lands — visible as a brief render delay at panel open.
    let dimensions_synced = false;

    function on_resize() {
        if (!viewportEl) return;
        const next = {
            width: Math.max(50, Math.floor(viewportEl.clientWidth)),
            height: Math.max(50, Math.floor(viewportEl.clientHeight)),
        };
        // First successful measurement: apply immediately so the
        // initial fetch uses the real viewport. The flag is set ONLY
        // after we have a real measurement; otherwise an early
        // onMount call with `viewportEl === undefined` would consume
        // the "first call" budget and the next genuine resize would
        // be debounced.
        if (!dimensions_synced) {
            dimensions_synced = true;
            dimensions = next;
            return;
        }
        // Subsequent calls debounce 100ms — a 1s drag at 60fps would
        // otherwise produce ~60 distinct (width, height) pairs and
        // flood the svgCache, evicting other plots' history.
        if (resize_timer) clearTimeout(resize_timer);
        resize_timer = setTimeout(() => {
            resize_timer = null;
            dimensions = next;
        }, 100);
    }

    onMount(() => {
        // ORDERING INVARIANT (AGENTS.md §"Key invariants" → "Plot
        // viewer" → "onMount-ordering"): install the message listener
        // BEFORE posting `webview-ready`. The host responds to webview-ready
        // synchronously with a state-update; if the listener isn't
        // installed yet, that initial state-update is dropped and the
        // panel boots with stale/default state.
        //
        // The seed read happens AFTER the listener install (and before
        // the post) so a hypothetical synchronous postMessage by the
        // seed dispatch's reactive side effects can still be captured
        // by the listener. Today no such postMessage occurs, but the
        // listener-first order makes the invariant robust against
        // future changes.
        window.addEventListener('message', on_message);
        window.addEventListener('resize', on_resize);

        // Read the initial themeApplied seed from the script tag baked
        // into the shell HTML at panel-create time. This makes the
        // first paint reflect the persisted value (before the
        // webview-ready round-trip's state-update arrives). Clear the
        // global after reading so a panel restore (`webview.html =`
        // re-assignment re-running the bundle) doesn't replay a stale
        // seed over a meanwhile-updated value.
        const seed = (window as unknown as {
            __ravenInitialPlotState?: { themeApplied?: boolean };
        }).__ravenInitialPlotState;
        if (seed && typeof seed.themeApplied === 'boolean') {
            dispatch({ type: 'SET_THEME_APPLIED', themeApplied: seed.themeApplied });
        }
        delete (window as unknown as Record<string, unknown>).__ravenInitialPlotState;

        on_resize();
        vscode.postMessage({ type: 'webview-ready', payload: {} });
    });

    onDestroy(() => {
        client?.close();
        last_fetcher?.abort();
        if (resize_timer) {
            clearTimeout(resize_timer);
            resize_timer = null;
        }
        if (copy_status_timer) {
            clearTimeout(copy_status_timer);
            copy_status_timer = null;
        }
        window.removeEventListener('message', on_message);
        window.removeEventListener('resize', on_resize);
    });

    function go_prev() { dispatch({ type: 'GO_PREV' }); }
    function go_next() { dispatch({ type: 'GO_NEXT' }); }

    async function remove_current() {
        if (!client || state.phase !== 'viewing') return;
        const id = state.plotIds[state.currentIndex];
        if (!id) return;
        try {
            await client.remove(id);
            refresh_plots();
        } catch (err) {
            vscode.postMessage({
                type: 'report-error',
                payload: { message: `httpgd remove: ${String(err)}` },
            });
        }
    }

    function save_plot(format: SaveFormat) {
        if (state.phase !== 'viewing') return;
        const id = state.plotIds[state.currentIndex];
        if (!id) return;
        vscode.postMessage({ type: 'request-save-plot', payload: { plotId: id, format } });
    }

    function open_externally() {
        if (state.phase !== 'viewing') return;
        const id = state.plotIds[state.currentIndex];
        if (!id) return;
        vscode.postMessage({ type: 'request-open-externally', payload: { plotId: id } });
    }

    function toggle_theme_applied() {
        const next = !state.themeApplied;
        // Optimistic local update for instant UI feedback; the host's
        // broadcast will re-assert (no-op short-circuit catches it).
        dispatch({ type: 'SET_THEME_APPLIED', themeApplied: next });
        vscode.postMessage({
            type: 'set-theme-applied',
            payload: { applied: next },
        });
    }

    function set_copy_status(status: '' | 'copying' | 'copied', clear_after_ms?: number) {
        copy_status = status;
        if (copy_status_timer) {
            clearTimeout(copy_status_timer);
            copy_status_timer = null;
        }
        if (clear_after_ms !== undefined) {
            copy_status_timer = setTimeout(() => {
                copy_status = '';
                copy_status_timer = null;
            }, clear_after_ms);
        }
    }

    async function copy_current() {
        if (state.phase !== 'viewing' || !state.activeSession) return;
        const id = state.plotIds[state.currentIndex];
        if (!id) return;
        const session = state.activeSession;
        const url = plot_url(session.httpgdBaseUrl, session.httpgdToken, id, {
            format: 'png',
            width: dimensions.width,
            height: dimensions.height,
            // Match the save flow: render against httpgd's default
            // background so pasted images don't carry the editor's dark
            // theme. The toggle does NOT influence Copy/Save — exported
            // images stay portable across themes.
            bg: null,
            upid: session.upid,
        });
        set_copy_status('copying');
        try {
            const r = await fetch(url);
            if (!r.ok) throw new Error(`httpgd ${r.status}`);
            const blob = await r.blob();
            await navigator.clipboard.write([
                new ClipboardItem({ 'image/png': blob }),
            ]);
            set_copy_status('copied', 1500);
        } catch (err) {
            set_copy_status('', 0);
            vscode.postMessage({
                type: 'report-error',
                payload: { message: `copy plot: ${String(err)}` },
            });
        }
    }

    // Right-click on the plot host suppresses the default browser menu
    // (Cut/Copy/Paste don't apply) and runs the copy action directly.
    // The handler is on the host <div>; contextmenu bubbles up from the
    // inner SVG nodes that {@html} insertion produces.
    function on_plot_context_menu(e: MouseEvent) {
        e.preventDefault();
        void copy_current();
    }

    // The fetch effect resolves the live plot's SVG into the cache. On
    // cache hit (already fetched for this plotId/upid/dimensions), it
    // returns without doing network work; on cache miss, it aborts the
    // previous in-flight fetch and starts a new one.
    //
    // Reads `state.themeApplied` via `bg_for_fetch` so Svelte registers
    // it as a dep — today `bg_for_fetch` returns the same value for
    // both branches so the toggle flip refires the effect but the
    // cache-hit short-circuit returns before fetching. A future
    // divergence in bg_for_fetch would automatically refetch (and the
    // cache key would need to extend to include themeApplied at that
    // point — see state.ts comment).
    $effect(() => {
        const session = state.activeSession;
        const plotId = state.plotIds[state.currentIndex];
        const upid = session?.upid ?? 0;
        const w = dimensions.width;
        const h = dimensions.height;
        if (!session || !plotId) return;
        if (state.sessionEnded) return; // post-quit: no fetch, draw from cache only

        // Cache-hit short-circuit BEFORE the abort/assign block. A
        // cache-hit effect run does NOT abort the prior in-flight
        // fetcher; we want that fetch to complete and populate the
        // cache (the user navigated away then back; the bytes are
        // still wanted).
        const cacheKey = svg_cache_key(session.sessionId, plotId, w, h);
        const cached = state.svgCache.get(cacheKey);
        if (cached && cached.upid === upid) return;

        const capturedUpid = upid;
        const capturedSessionId = session.sessionId;

        const url = plot_url(session.httpgdBaseUrl, session.httpgdToken, plotId, {
            format: 'svg',
            width: w,
            height: h,
            bg: bg_for_fetch(state.themeApplied),
            upid,
        });
        // If we'd be issuing the same URL the in-flight fetcher is
        // already pursuing, keep the existing fetch alive instead of
        // aborting and re-issuing identical bytes. This matters for
        // spurious effect runs (toggle flip on a cold cache today
        // re-fires the effect because `bg_for_fetch` is read as a dep;
        // the URL is identical so we let the original fetch finish).
        // `last_fetcher_url` is cleared after success/error inside the
        // `.then`/`.catch` chain so a re-fetch of the same URL (e.g.
        // after FIFO eviction at cap 50 plots) is not silently skipped.
        if (last_fetcher && last_fetcher_url === url && !last_fetcher.signal.aborted) {
            return;
        }
        last_fetcher?.abort();
        const controller = new AbortController();
        last_fetcher = controller;
        last_fetcher_url = url;
        // Capture the controller into a closure so the cleanup below
        // clears `last_fetcher` only if it's still pointing at THIS
        // fetch (another fetch may have superseded ours by the time
        // we resolve).
        const myController = controller;
        const clear_fetcher = () => {
            if (last_fetcher === myController) {
                last_fetcher = null;
                last_fetcher_url = null;
            }
        };

        void fetch(url, { signal: controller.signal })
            .then(r => (r.ok ? r.text() : null))
            .then(text => {
                if (!text || controller.signal.aborted) return;
                // Bail if the session disconnected while in flight — a
                // fetch that resolves AFTER R quits would otherwise
                // pollute the cache.
                if (state.sessionEnded) return;
                // Drop if the session swapped or upid moved while in
                // flight (TOCTOU on single-bump cases).
                if (state.activeSession?.sessionId !== capturedSessionId) return;
                if (state.activeSession?.upid !== capturedUpid) return;
                // Freshness re-check: skip if a same-or-newer entry
                // already exists in the cache (defends against the
                // narrower race where two concurrent fetches for the
                // same cacheKey can both reach this point — first
                // writer wins; the bytes-identical no-op short-circuit
                // in the reducer handles same-bytes naturally).
                const existing = state.svgCache.get(cacheKey);
                if (existing && existing.upid >= capturedUpid) return;
                const sanitized = sanitize_svg(text);
                if (!sanitized) return;
                // Heuristic structural tagging of canvas/panel
                // background rects (see ./tag-backgrounds for the
                // rules). The overlay CSS targets `rect.raven-bg` so
                // we get colour-agnostic background hiding without a
                // hand-maintained allowlist. The tagger is a pure
                // function of the SVG text, so caching the post-tag
                // bytes is sound.
                const tagged = tag_background_rects(sanitized);
                dispatch({
                    type: 'SET_SVG_CACHE_ENTRY',
                    cacheKey,
                    entry: { svgText: tagged, upid: capturedUpid },
                });
            })
            .catch(() => {
                // Aborted or transport error — leave the cache alone;
                // the viewport falls back to the placeholder via
                // `pick_current_svg() === null`.
            })
            .finally(() => {
                // Clear the in-flight tracker so a future re-fetch of
                // the same URL (e.g. after FIFO eviction at cap 50) is
                // not silently skipped by the URL-equality short-
                // circuit above. `clear_fetcher` only nulls the
                // globals if `last_fetcher` is still pointing at THIS
                // controller — a superseded fetch's cleanup doesn't
                // disturb its successor.
                clear_fetcher();
            });
    });

    let currentSvg: SvgEntry | null = $derived(pick_current_svg(state, dimensions));
</script>

<main>
    <header class="toolbar">
        <button onclick={go_prev}
                disabled={state.phase !== 'viewing' || state.currentIndex === 0}
                title="Previous plot">‹</button>
        <button onclick={go_next}
                disabled={state.phase !== 'viewing' || state.currentIndex === state.plotIds.length - 1}
                title="Next plot">›</button>
        <span class="counter">
            {#if state.phase === 'viewing'}
                {state.currentIndex + 1} / {state.plotIds.length}
            {/if}
        </span>
        <button onclick={remove_current}
                disabled={state.phase !== 'viewing'}
                title="Remove current plot">✕</button>
        <span class="spacer"></span>
        <button onclick={copy_current}
                disabled={state.phase !== 'viewing'}
                title="Copy plot to clipboard (PNG)">Copy</button>
        <button onclick={() => save_plot('png')}
                disabled={state.phase !== 'viewing'}
                title="Save as PNG">PNG</button>
        <button onclick={() => save_plot('svg')}
                disabled={state.phase !== 'viewing'}
                title="Save as SVG">SVG</button>
        <button onclick={() => save_plot('pdf')}
                disabled={state.phase !== 'viewing'}
                title="Save as PDF">PDF</button>
        <button onclick={open_externally}
                disabled={state.phase !== 'viewing'}
                title="Open in external viewer">↗</button>
        <button class="theme-toggle"
                class:is-on={state.themeApplied}
                aria-pressed={state.themeApplied}
                onclick={toggle_theme_applied}
                title="Recolor the plot to match the active VS Code theme">
            <span class="checkmark" aria-hidden="true">{state.themeApplied ? '✓' : ' '}</span>
            Apply VS Code theme
        </button>
    </header>

    {#if state.sessionEnded && currentSvg}
        <div class="banner">R session ended. Showing last plot.</div>
    {/if}

    <div class="viewport" bind:this={viewportEl}>
        {#if state.phase === 'loading'}
            <div class="placeholder">Connecting to R…</div>
        {:else if state.phase === 'empty'}
            <div class="placeholder">No plots yet — run <code>plot(1:10)</code> to see one here.</div>
        {:else if state.sessionEnded && !currentSvg}
            <div class="placeholder">R session ended.</div>
        {:else if currentSvg}
            <!-- role="img" semantically marks the host as the plot
                 image — it's not an interactive control but it does
                 carry an alternative-text label and a right-click →
                 Copy gesture. The aria-label uses the same "Plot N"
                 form the prior <img alt> carried. -->
            <div class="plot-host"
                 class:apply-vscode-theme={state.themeApplied}
                 role="img"
                 aria-label={`Plot ${state.currentIndex + 1}`}
                 draggable="false"
                 oncontextmenu={on_plot_context_menu}>
                {@html currentSvg.svgText}
            </div>
        {:else if state.phase === 'viewing'}
            <!-- viewing phase with no cached SVG yet — fetch is
                 in-flight or the cache was just invalidated (upid bump
                 between the host's state-update arriving and
                 refresh_plots completing). Showing a placeholder
                 prevents the blank-viewport flash that the
                 `only_upid_changed` reducer branch would otherwise
                 expose on every plot update. -->
            <div class="placeholder">Loading plot…</div>
        {/if}
        {#if copy_status === 'copied'}
            <div class="toast">Copied</div>
        {/if}
    </div>
</main>

<style>
    /* Theme overlay applied when state.themeApplied is true. Scoped to
     * the .plot-host wrapper so the rest of the toolbar/banner is not
     * affected by the overrides.
     *
     * `:global(...)` is required because the SVG nodes inserted via
     * {@html} do not carry Svelte's component-scoping hash — only the
     * .plot-host element itself does. Without :global(), the selectors
     * would be rewritten to .svg.httpgd.svelte-abc123, which the
     * httpgd-emitted SVG can never match.
     *
     * `!important` is required because httpgd emits inline `stroke=`/
     * `fill=` attributes on the SVG elements, and inline-attribute
     * specificity wins over a class selector without it. */
    .plot-host {
        max-width: 100%;
        max-height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .plot-host :global(svg) {
        max-width: 100%;
        max-height: 100%;
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
    .plot-host.apply-vscode-theme :global(svg.httpgd rect:not(.raven-bg)) {
        stroke: var(--vscode-editor-foreground) !important;
    }

    /* Hide the canvas/panel background rects that `tag_background_rects`
     * (in ./tag-backgrounds.ts) flagged with `class="raven-bg"`. The
     * webview body's `--vscode-editor-background` shows through.
     *
     * The previous mechanism was a `rect[fill="#FFFFFF" i],
     * rect[fill="#EBEBEB" i]` allowlist: every non-default ggplot theme
     * (`theme_dark()` → grey50, user-customized themes, theme_minimal
     * with no panel bg at all) required a new entry, and any user-drawn
     * shape that happened to match an allowlisted colour silently
     * disappeared. Structural tagging is colour-agnostic and stable
     * across themes — see `tag-backgrounds.ts` for the heuristic. */
    .plot-host.apply-vscode-theme :global(svg.httpgd rect.raven-bg) {
        fill: none !important;
        stroke: none !important;
    }

    /* Toolbar toggle styling — mirrors the knit-preview "Apply VS Code
     * theme" button: an accent border when on, a pre-allocated checkmark
     * slot so toggling doesn't shift the label horizontally. */
    .theme-toggle .checkmark {
        display: inline-block;
        width: 1ch;
        text-align: center;
        white-space: pre;
    }

    .theme-toggle.is-on {
        border-color: var(--vscode-focusBorder) !important;
    }
</style>
