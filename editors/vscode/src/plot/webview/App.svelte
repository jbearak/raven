<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { initial_state, reduce } from './state';
    import type { ViewerState } from './state';
    import {
        create_httpgd_client,
        plot_url,
    } from './httpgd-client';
    import type { HttpgdClient } from './httpgd-client';
    import type {
        ExtensionToWebviewMessage,
        WebviewToExtensionMessage,
        SaveFormat,
    } from '../messages';

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

    function dispatch(action: import('./state').ViewerAction) {
        state = reduce(state, action);
    }

    function read_theme_bg(): string {
        const v = getComputedStyle(document.body)
            .getPropertyValue('--vscode-editor-background')
            .trim();
        return v || '#ffffff';
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
        const msg = event.data as ExtensionToWebviewMessage;
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
            case 'state-update':
                attach_session(msg.payload.activeSession, msg.payload.sessionEnded);
                break;
            case 'theme-changed':
                dispatch({ type: 'SET_THEME_BG', themeBg: read_theme_bg() });
                break;
        }
    }

    function on_resize() {
        if (!viewportEl) return;
        dimensions = {
            width: Math.max(50, Math.floor(viewportEl.clientWidth)),
            height: Math.max(50, Math.floor(viewportEl.clientHeight)),
        };
    }

    onMount(() => {
        dispatch({ type: 'SET_THEME_BG', themeBg: read_theme_bg() });
        window.addEventListener('message', on_message);
        window.addEventListener('resize', on_resize);
        on_resize();
        vscode.postMessage({ type: 'webview-ready', payload: {} });
    });

    onDestroy(() => {
        client?.close();
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
            // Match the save flow: render against httpgd's default background
            // so pasted images don't carry the editor's dark theme.
            bg: null,
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

    // Right-click on the plot suppresses the default browser menu (Cut/Copy/Paste
    // don't apply to an httpgd-rendered img) and runs the copy action directly.
    function on_plot_context_menu(e: MouseEvent) {
        e.preventDefault();
        void copy_current();
    }

    let current_url = $derived.by(() => {
        if (state.phase !== 'viewing' && state.phase !== 'disconnected') return '';
        if (!state.activeSession || state.plotIds.length === 0) return '';
        const id = state.plotIds[state.currentIndex];
        return plot_url(
            state.activeSession.httpgdBaseUrl,
            state.activeSession.httpgdToken,
            id,
            {
                format: 'svg',
                width: dimensions.width,
                height: dimensions.height,
                bg: state.themeBg,
            },
        );
    });
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
    </header>

    {#if state.sessionEnded}
        <div class="banner">R session ended. Showing last plot.</div>
    {/if}

    <div class="viewport" bind:this={viewportEl}>
        {#if state.phase === 'loading'}
            <div class="placeholder">Connecting to R…</div>
        {:else if state.phase === 'empty'}
            <div class="placeholder">No plots yet — run <code>plot(1:10)</code> to see one here.</div>
        {:else if state.phase === 'disconnected' && state.plotIds.length === 0}
            <div class="placeholder">R session ended.</div>
        {:else if current_url}
            <img class="plot"
                 src={current_url}
                 alt={`Plot ${state.currentIndex + 1}`}
                 oncontextmenu={on_plot_context_menu} />
        {/if}
        {#if copy_status === 'copied'}
            <div class="toast">Copied</div>
        {/if}
    </div>
</main>
