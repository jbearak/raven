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

    // Inlined codicon SVGs (from @vscode/codicons 0.0.45, MIT). Kept
    // inline (rather than importing the font) so we don't add a runtime
    // font dependency or change the webview CSP — `fill="currentColor"`
    // makes them inherit the surrounding button's foreground colour.
    const SYMBOL_COLOR_ICON =
        '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true" focusable="false"><path d="M8.00101 1C4.13401 1 1.00101 3.8 1.00101 7.667C1.00101 8.956 2.04501 10 3.33401 10C4.75101 10 4.72101 9 6.00001 9C6.64401 9 7.00001 9.606 7.00001 10.25V11.5C7.00001 13.433 8.56701 15 10.5 15C13.653 15 14.999 11.215 14.999 8C14.999 4.134 11.866 1 8.00001 1H8.00101ZM10.5 14C9.12201 14 8.00001 12.878 8.00001 11.5V10.25C8.00001 8.967 7.14001 8 6.00001 8C5.04001 8 4.49801 8.412 4.13901 8.685C3.85401 8.902 3.72401 9 3.33401 9C2.59901 9 2.00101 8.402 2.00101 7.667C2.00101 4.436 4.58001 2 8.00101 2C11.309 2 14 4.692 14 8C14 10.412 13.068 14 10.501 14H10.5ZM12 11C12 11.552 11.552 12 11 12C10.448 12 10 11.552 10 11C10 10.448 10.448 10 11 10C11.552 10 12 10.448 12 11ZM13 8C13 8.552 12.552 9 12 9C11.448 9 11 8.552 11 8C11 7.448 11.448 7 12 7C12.552 7 13 7.448 13 8ZM6.00001 5C6.00001 5.552 5.55201 6 5.00001 6C4.44801 6 4.00001 5.552 4.00001 5C4.00001 4.448 4.44801 4 5.00001 4C5.55201 4 6.00001 4.448 6.00001 5ZM10 5C10 4.448 10.448 4 11 4C11.552 4 12 4.448 12 5C12 5.552 11.552 6 11 6C10.448 6 10 5.552 10 5ZM9.00001 4C9.00001 4.552 8.55201 5 8.00001 5C7.44801 5 7.00001 4.552 7.00001 4C7.00001 3.448 7.44801 3 8.00001 3C8.55201 3 9.00001 3.448 9.00001 4Z"/></svg>';
    const SHARE_ICON =
        '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true" focusable="false"><path d="M11.307 1.10533C11.1562 0.988085 10.9519 0.966945 10.7803 1.05085C10.6088 1.13475 10.5 1.30904 10.5 1.5V3.49274C10.4571 3.49456 10.4122 3.49701 10.3654 3.5002C9.96247 3.52766 9.41128 3.61105 8.82119 3.83704C8.11343 4.10809 7.34877 4.58508 6.72601 5.41126C6.10338 6.23727 5.64499 7.38259 5.50206 8.95474C5.48301 9.16438 5.5973 9.36351 5.78793 9.4528C5.97857 9.54209 6.20471 9.50241 6.35356 9.35356C7.54248 8.16464 8.72298 7.57773 9.59562 7.28685C9.9558 7.16679 10.2643 7.09693 10.5 7.0563V9C10.5 9.1969 10.6156 9.37546 10.7952 9.45612C10.9748 9.53678 11.185 9.50452 11.3322 9.37371L15.8322 5.37371C15.9432 5.27502 16.0046 5.13207 15.9997 4.98361C15.9949 4.83514 15.9242 4.69653 15.807 4.60533L11.307 1.10533ZM10.9429 4.49679L10.9457 4.49705C11.0865 4.51223 11.2279 4.46706 11.3335 4.37257C11.4394 4.27772 11.5 4.14223 11.5 4V2.52232L14.7186 5.02564L11.5 7.88658V6.5C11.5 6.22386 11.2762 6 11 6L10.9989 6L10.9976 6.00001L10.9943 6.00003L10.9848 6.00014L10.9552 6.00087C10.9307 6.00166 10.897 6.00316 10.8544 6.00599C10.7695 6.01166 10.6495 6.02268 10.4996 6.04409C10.1999 6.08691 9.77971 6.17139 9.2794 6.33816C8.55493 6.57965 7.66479 6.99299 6.7319 7.69863C6.9264 6.98158 7.2077 6.43355 7.52456 6.01319C8.01593 5.36132 8.61523 4.98675 9.17883 4.7709C9.65371 4.58903 10.1025 4.52044 10.4334 4.49788C10.5981 4.48666 10.7314 4.48699 10.8211 4.48988C10.866 4.49133 10.8997 4.49341 10.9209 4.49498L10.9429 4.49679ZM3.5 2C2.11929 2 1 3.11929 1 4.5V12.5C1 13.8807 2.11929 15 3.5 15H11.5C12.8807 15 14 13.8807 14 12.5V9.5C14 9.22386 13.7761 9 13.5 9C13.2239 9 13 9.22386 13 9.5V12.5C13 13.3284 12.3284 14 11.5 14H3.5C2.67157 14 2 13.3284 2 12.5V4.5C2 3.67157 2.67157 3 3.5 3H7.5C7.77614 3 8 2.77614 8 2.5C8 2.22386 7.77614 2 7.5 2H3.5Z"/></svg>';

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

    // The toolbar always renders in a compact "icon-only" form on the
    // right side: a single $(share) button that opens a popover with
    // Copy / PNG / SVG / PDF, the existing $(arrow-up-right) external
    // link, and a $(symbol-color) toggle for "Apply VS Code theme".
    // Keeping the icon-only layout permanent (rather than a responsive
    // collapse) means the toolbar height is invariant under panel
    // resize and the layout reads cleanly at every width.
    let share_popover_el: HTMLDivElement | undefined = $state();
    let share_btn_el: HTMLButtonElement | undefined = $state();
    const SHARE_POPOVER_ID = 'raven-plot-share-popover';
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

    // Position the share popover under the share button on each open.
    // Using the HTML popover API (`popover` attribute) means dismissal
    // is automatic on outside click or Escape — we only need to handle
    // positioning. The CSS rule `.share-popover { inset: auto }`
    // overrides the browser UA stylesheet's `[popover] { inset: 0;
    // margin: auto }` (which would center the popover) so the JS-set
    // `top` and `right` actually take effect. `right` anchors the
    // popover's right edge near the share button's right edge so the
    // menu reads as attached to it.
    //
    // `beforetoggle` fires synchronously before the popover becomes
    // visible (the `:popover-open` rule flips `display: none` → `flex`).
    // Setting position there avoids a one-frame flash at the centered
    // default before our values land — visible when the menu opens
    // because the popover is briefly painted at inset:0 / margin:auto
    // before our `style.top` / `style.right` overrides take effect on
    // the next style recalc.
    function on_share_popover_beforetoggle(e: ToggleEvent) {
        if (e.newState !== 'open') return;
        if (!share_popover_el || !share_btn_el) return;
        const r = share_btn_el.getBoundingClientRect();
        share_popover_el.style.top = `${r.bottom + 4}px`;
        share_popover_el.style.right = `${Math.max(4, window.innerWidth - r.right)}px`;
    }

    function close_share_popover() {
        share_popover_el?.hidePopover?.();
    }

    function copy_from_share() {
        close_share_popover();
        void copy_current();
    }

    function save_from_share(format: SaveFormat) {
        close_share_popover();
        save_plot(format);
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
                dispatch({
                    type: 'SET_SVG_CACHE_ENTRY',
                    cacheKey,
                    entry: { svgText: sanitized, upid: capturedUpid },
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
        <button class="icon-btn"
                bind:this={share_btn_el}
                popovertarget={SHARE_POPOVER_ID}
                disabled={state.phase !== 'viewing'}
                aria-label="Copy or export plot"
                title="Copy or export plot">
            {@html SHARE_ICON}
        </button>
        <button class="icon-btn"
                onclick={open_externally}
                disabled={state.phase !== 'viewing'}
                aria-label="Open in external viewer"
                title="Open in external viewer">↗</button>
        <button class="theme-toggle icon-btn"
                class:is-on={state.themeApplied}
                aria-pressed={state.themeApplied}
                aria-label="Apply VS Code theme"
                onclick={toggle_theme_applied}
                title="Apply VS Code theme">
            {@html SYMBOL_COLOR_ICON}
        </button>
    </header>
    <div id={SHARE_POPOVER_ID}
         bind:this={share_popover_el}
         popover="auto"
         class="share-popover"
         onbeforetoggle={on_share_popover_beforetoggle}>
        <button onclick={copy_from_share} disabled={state.phase !== 'viewing'}>Copy</button>
        <button onclick={() => save_from_share('png')} disabled={state.phase !== 'viewing'}>PNG</button>
        <button onclick={() => save_from_share('svg')} disabled={state.phase !== 'viewing'}>SVG</button>
        <button onclick={() => save_from_share('pdf')} disabled={state.phase !== 'viewing'}>PDF</button>
    </div>

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

    /* httpgd-rendered plots paint multiple background rects under the
     * data layer; the toggle has to hide all of them so
     * `--vscode-editor-background` can show through.
     *
     *   - `#FFFFFF` covers two distinct rects on every plot: the
     *     first-of-type direct child of <svg> (httpgd's canvas, also
     *     hit by the `:first-of-type` rule above) AND an inner rect
     *     wrapped in a `<g clip-path>` that the `:first-of-type`
     *     selector cannot reach.
     *   - `#EBEBEB` is `grey92`, the ggplot2 `theme_gray()` default
     *     for `panel.background`. ggplot2 is the dominant R plot
     *     ecosystem; without this entry the cartesian grid stays
     *     painted light-gray over the editor background.
     *
     * Extending the allowlist is intentionally conservative: we'd
     * rather miss a non-default ggplot theme's background (and have
     * the user toggle off) than hide a deliberate white/grey-filled
     * shape in their data (e.g. a `geom_rect()` panel) once the toggle
     * is on. Add new colors only when a real plot demonstrates the
     * miss. The `i` flag is CSS4 case-insensitive matching — defensive
     * against a future httpgd version emitting lowercase hex.
     *
     * Source order matters: this rule lives AFTER the stroke-recolor
     * rule above so the `stroke: none !important` here overrides the
     * editor-foreground stroke that would otherwise outline the inner
     * background rects (the two rules have equal CSS specificity, so
     * later-in-source wins). */
    .plot-host.apply-vscode-theme :global(svg.httpgd rect[fill="#FFFFFF" i]),
    .plot-host.apply-vscode-theme :global(svg.httpgd rect[fill="#EBEBEB" i]) {
        fill: none !important;
        stroke: none !important;
    }

    /* Toolbar toggle "on" state. Icon-only buttons need a strong
     * background-color shift to read as engaged — VS Code's canonical
     * `inputOption.activeBackground` token is intentionally subtle (a
     * semi-transparent tint over the input background) and tends to
     * disappear against the editor-widget background the toolbar sits
     * on. Using the primary button palette instead gives an unambiguous
     * "pressed" colour that survives every theme: the toggle fills with
     * the same accent VS Code uses for its primary action buttons, so
     * users immediately read it as active.
     *
     * `currentColor` flows through the inline SVG's `fill="currentColor"`,
     * so setting `color: button-foreground` recolors the codicon itself
     * — no extra rule needed for the SVG fill. The off-state border
     * isn't overridden because the prominent background carries the
     * indication on its own; layering a border on top reads as noise. */
    .theme-toggle.is-on {
        background: var(--vscode-button-background) !important;
        color: var(--vscode-button-foreground) !important;
    }

    .theme-toggle.is-on:hover:not(:disabled) {
        background: var(--vscode-button-hoverBackground) !important;
    }
</style>
