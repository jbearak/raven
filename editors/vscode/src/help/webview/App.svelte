<script lang="ts">
    import { onMount, onDestroy, tick } from 'svelte';
    import { initial_state, reduce } from './state';
    import type { ViewerState } from './state';
    import {
        isExtensionToWebviewMessage,
    } from '../messages';
    import type { WebviewToExtensionMessage } from '../messages';

    interface Props {
        vscode: { postMessage(msg: WebviewToExtensionMessage): void };
    }

    let { vscode }: Props = $props();
    let state = $state<ViewerState>(initial_state());
    let contentEl: HTMLDivElement | undefined = $state();
    let scroll_timer: ReturnType<typeof setTimeout> | null = null;

    function dispatch(action: import('./state').ViewerAction) {
        state = reduce(state, action);
    }

    async function on_message(event: MessageEvent) {
        const msg = event.data;
        if (!isExtensionToWebviewMessage(msg)) return;
        switch (msg.type) {
            case 'load':
                dispatch({ type: 'LOAD', payload: msg.payload });
                // After Svelte renders the new HTML, scroll to anchor if present.
                if (msg.payload.anchor) {
                    const anchor = msg.payload.anchor;
                    await tick();
                    const target = document.getElementById(anchor);
                    if (target) {
                        target.scrollIntoView({ behavior: 'auto', block: 'start' });
                    } else if (contentEl) {
                        contentEl.scrollTop = 0;
                    }
                } else if (contentEl) {
                    await tick();
                    contentEl.scrollTop = 0;
                }
                break;
            case 'loading':
                dispatch({ type: 'LOADING' });
                break;
            case 'error':
                dispatch({ type: 'ERROR', payload: msg.payload });
                break;
            case 'theme-changed':
                // VS Code CSS variables update automatically; nothing to do.
                break;
            case 'history-state':
                dispatch({
                    type: 'HISTORY_STATE',
                    canBack: msg.payload.canBack,
                    canForward: msg.payload.canForward,
                });
                break;
        }
    }

    function on_scroll() {
        if (!contentEl) return;
        const y = contentEl.scrollTop;
        if (scroll_timer !== null) {
            clearTimeout(scroll_timer);
        }
        scroll_timer = setTimeout(() => {
            scroll_timer = null;
            vscode.postMessage({ type: 'scroll', payload: { y } });
        }, 150);
    }

    /**
     * Delegated click handler for the help content area.
     *
     * Classification rules (from spec §"Webview UI"):
     *   raven-help://topic/<pkg>/<topic>[#anchor]  → navigate
     *   https:// / http:// / mailto:               → open-external
     *   #anchor only (no scheme)                   → no-op (native scroll)
     *   anything else                              → report-error + preventDefault
     */
    function on_content_click(event: MouseEvent) {
        // Walk up from event target to find the nearest <a> element.
        let target = event.target as Element | null;
        while (target && target.tagName.toUpperCase() !== 'A') {
            target = target.parentElement;
        }
        if (!target || target.tagName.toUpperCase() !== 'A') return;

        const anchor = target as HTMLAnchorElement;
        const href = anchor.getAttribute('href') ?? '';

        // Anchors rewritten by server neutralization carry data-raven-dropped="1".
        // Treat them as disallowed links.
        if (anchor.dataset['ravenDropped'] === '1') {
            event.preventDefault();
            vscode.postMessage({
                type: 'report-error',
                payload: { message: `Blocked neutralized link: ${href}` },
            });
            return;
        }

        // Pure hash anchor (#section) — let browser scroll natively.
        if (href.startsWith('#') && !href.includes('://')) {
            // No preventDefault — native scroll.
            return;
        }

        // raven-help://topic/<pkg>/<topic>[#anchor]
        if (href.startsWith('raven-help://topic/')) {
            event.preventDefault();
            try {
                const url = new URL(href);
                // path is /<pkg>/<topic>
                const parts = url.pathname.replace(/^\//, '').split('/');
                if (parts.length < 2 || !parts[0] || !parts[1]) {
                    throw new Error(`Malformed raven-help URL: ${href}`);
                }
                const pkg = decodeURIComponent(parts[0]);
                const topic = decodeURIComponent(parts[1]);
                const rawAnchor = url.hash.startsWith('#') ? url.hash.slice(1) : null;
                const anchorDecoded = rawAnchor ? decodeURIComponent(rawAnchor) : null;
                vscode.postMessage({
                    type: 'navigate',
                    payload: { topic, package: pkg, anchor: anchorDecoded },
                });
            } catch (err) {
                vscode.postMessage({
                    type: 'report-error',
                    payload: { message: `Invalid raven-help URL: ${href} — ${String(err)}` },
                });
            }
            return;
        }

        // External URLs — http, https, mailto.
        if (
            href.startsWith('https://') ||
            href.startsWith('http://') ||
            href.startsWith('mailto:')
        ) {
            event.preventDefault();
            vscode.postMessage({ type: 'open-external', payload: { url: href } });
            return;
        }

        // Everything else (javascript:, data:, relative paths with no scheme, etc.)
        event.preventDefault();
        vscode.postMessage({
            type: 'report-error',
            payload: { message: `Disallowed link: ${href}` },
        });
    }

    onMount(() => {
        window.addEventListener('message', on_message);
        vscode.postMessage({ type: 'webview-ready', payload: {} });
    });

    onDestroy(() => {
        window.removeEventListener('message', on_message);
        if (scroll_timer !== null) {
            clearTimeout(scroll_timer);
        }
    });

    /**
     * Keyboard companion to on_content_click: fire click classification on
     * Enter/Space keydown over an <a> element so keyboard navigation works.
     */
    function on_content_keydown(event: KeyboardEvent) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        // Synthesise a MouseEvent-compatible object for on_content_click.
        // We only need `target`, `preventDefault`, and `parentElement`.
        on_content_click(event as unknown as MouseEvent);
    }

    function go_back() {
        vscode.postMessage({ type: 'back', payload: {} });
    }

    function go_forward() {
        vscode.postMessage({ type: 'forward', payload: {} });
    }
</script>

<main>
    <header class="toolbar">
        <button
            onclick={go_back}
            disabled={!state.canBack}
            title="Back"
        >←</button>
        <button
            onclick={go_forward}
            disabled={!state.canForward}
            title="Forward"
        >→</button>
        {#if state.phase === 'viewing' && state.current}
            <span class="topic-label">{state.current.package}::{state.current.topic}</span>
        {/if}
    </header>

    {#if state.phase === 'loading'}
        <div class="banner banner-loading">Loading…</div>
    {:else if state.phase === 'error' && state.lastError}
        <div class="banner banner-error">
            <span class="error-reason">{state.lastError.reason}:</span>
            {state.lastError.message}
        </div>
    {/if}

    <div
        class="content-area"
        bind:this={contentEl}
        onscroll={on_scroll}
        role="region"
        aria-label="R help content"
    >
        {#if state.phase === 'viewing' && state.current}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <div
                class="help-content"
                onclick={on_content_click}
                onkeydown={on_content_keydown}
                role="document"
                tabindex="-1"
            >
                {@html state.current.html}
            </div>
        {:else if state.phase === 'idle'}
            <div class="placeholder">Open a topic to see R help here.</div>
        {:else if state.phase === 'error'}
            <div class="placeholder">Failed to load help.</div>
        {/if}
    </div>
</main>
