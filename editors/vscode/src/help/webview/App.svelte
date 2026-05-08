<script lang="ts">
    import { onMount, onDestroy, tick } from 'svelte';
    import { initialState, reduce } from './state';
    import type { ViewerState } from './state';
    import {
        isExtensionToWebviewMessage,
    } from '../messages';
    import type { WebviewToExtensionMessage } from '../messages';
    import { classifyAndDispatch } from './click-handler';

    interface Props {
        vscode: { postMessage(msg: WebviewToExtensionMessage): void };
    }

    let { vscode }: Props = $props();
    let state = $state<ViewerState>(initialState());
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
                // After Svelte renders the new HTML, restore scroll position.
                // Anchor wins if present; otherwise apply the back/forward
                // scrollY (0 for fresh navigations).
                if (msg.payload.anchor) {
                    const anchor = msg.payload.anchor;
                    await tick();
                    const target = document.getElementById(anchor);
                    if (target) {
                        target.scrollIntoView({ behavior: 'auto', block: 'start' });
                    } else if (contentEl) {
                        contentEl.scrollTop = msg.payload.scrollY;
                    }
                } else if (contentEl) {
                    await tick();
                    contentEl.scrollTop = msg.payload.scrollY;
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
     * Delegated click handler for the help content area: walks up to the
     * closest <a> ancestor and dispatches via classifyAndDispatch in
     * click-handler.ts (where the spec's link-classification rules live).
     */
    function on_content_click(event: MouseEvent) {
        // Walk up from event target to find the nearest <a> element.
        let target = event.target as Element | null;
        while (target && target.tagName.toUpperCase() !== 'A') {
            target = target.parentElement;
        }
        if (!target || target.tagName.toUpperCase() !== 'A') return;

        const anchor = target as HTMLAnchorElement;
        const href = anchor.getAttribute('href');
        const isDropped = anchor.dataset['ravenDropped'] === '1';
        classifyAndDispatch(event, href, isDropped, vscode.postMessage.bind(vscode));
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
     * Delegated keydown handler on the content container.
     *
     * Activates links via Enter or Space so keyboard navigation works.
     * For Space, always calls preventDefault() first to suppress the browser's
     * page-scroll default — even when the link is a hash anchor.
     */
    function on_content_keydown(event: KeyboardEvent) {
        if (event.key !== 'Enter' && event.key !== ' ') return;

        // Walk up from event target to find the nearest <a> element.
        let target = event.target as Element | null;
        while (target && target.tagName.toUpperCase() !== 'A') {
            target = target.parentElement;
        }
        if (!target || target.tagName.toUpperCase() !== 'A') return;

        const anchor = target as HTMLAnchorElement;
        const href = anchor.getAttribute('href');
        const isDropped = anchor.dataset['ravenDropped'] === '1';

        // For Space, always suppress the page-scroll default before dispatching.
        // classifyAndDispatch returns false for hash anchors (no preventDefault
        // inside), but Space's native scroll should never fire here — the anchor
        // activation is handled by classifyAndDispatch or the native hash scroll.
        if (event.key === ' ') {
            event.preventDefault();
        }

        classifyAndDispatch(event, href, isDropped, vscode.postMessage.bind(vscode));
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
        {#if state.current}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <!--
                Keep showing the last successfully loaded topic even while we
                are in 'loading' or 'error' phases — the banner above already
                conveys the transient state. Replacing the content with a
                placeholder during a failed in-panel navigation made the back
                button surprising: from the user's perspective they were still
                on the previous topic, so back should take them one step back
                from there, not from the displaced placeholder.
            -->
            <div
                class="help-content"
                onclick={on_content_click}
                onkeydown={on_content_keydown}
                role="document"
                tabindex="-1"
            >
                <p class="topic-attribution">
                    <code>{state.current.package}::{state.current.topic}</code>
                </p>
                {@html state.current.html}
            </div>
        {:else if state.phase === 'error'}
            <div class="placeholder">Failed to load help.</div>
        {:else}
            <div class="placeholder">Open a topic to see R help here.</div>
        {/if}
    </div>
</main>
