import type { LoadPayload } from './messages';

export type HistoryEntry = {
    topic: string;
    package: string;
    anchor: string | null;
    scrollY: number;
};

export type FetchResponse =
    | ({ ok: true } & LoadPayload & { helpDir: string; libPaths: string[] })
    | { ok: false; reason: string; message: string };

export type StateMachineDeps = {
    /** Issue an HTTP-style request to the LSP. The state machine doesn't care
     * how this is implemented; it just receives the response. */
    fetch: (
        topic: string,
        pkg: string,
        requestId: number,
    ) => Promise<FetchResponse>;
    /** Webview message: `load` — display this content. */
    onLoad?: (load: LoadPayload, scrollY: number) => void;
    /** Webview message: `loading` — show a placeholder while waiting. */
    onLoading?: () => void;
    /** Webview message: `error` — show inline error. The current topic stays;
     * stacks are not mutated on failure. */
    onError?: (e: { reason: string; message: string }) => void;
    /** Webview message: `history-state` — update back/forward button enable. */
    onHistoryChange?: (s: { canBack: boolean; canForward: boolean }) => void;
};

const STACK_CAP = 50;

/**
 * State machine for the help panel's back/forward navigation.
 *
 * Spec invariants:
 * - Failed fetches do NOT mutate the back/forward stacks. The user stays on
 *   the previous topic.
 * - Stale fetches (superseded by a newer request) are dropped silently.
 * - Stacks are capped at 50 entries; oldest is dropped FIFO when capacity
 *   is exceeded.
 */
export function createHelpStateMachine(deps: StateMachineDeps) {
    const back: HistoryEntry[] = [];
    const forward: HistoryEntry[] = [];
    let current: HistoryEntry | null = null;
    let nextId = 0;
    let inFlight = 0;

    function notifyHist() {
        deps.onHistoryChange?.({
            canBack: back.length > 0,
            canForward: forward.length > 0,
        });
    }

    /**
     * Internal: dispatch a fetch and apply the result if it isn't superseded.
     *
     * On success, sets the new `current` entry and calls `onLoad`.
     * On failure, calls `onError` and leaves `current` unchanged — the caller
     * is responsible for restoring the back/forward stacks if it had already
     * pushed to them in anticipation of success. (See `navigate`/`back`/
     * `forward` for the rollback pattern.)
     */
    async function load(
        t: string,
        p: string,
        anchor: string | null,
        scrollY: number,
    ): Promise<{ ok: boolean; stale: boolean }> {
        nextId += 1;
        const id = nextId;
        inFlight = id;
        deps.onLoading?.();
        const res = await deps.fetch(t, p, id);
        if (id !== inFlight) return { ok: false, stale: true };
        if (res.ok) {
            current = { topic: t, package: p, anchor, scrollY };
            deps.onLoad?.(
                {
                    topic: res.topic,
                    package: res.package,
                    title: res.title,
                    html: res.html,
                    anchor,
                    scrollY,
                },
                scrollY,
            );
        } else {
            deps.onError?.({ reason: res.reason, message: res.message });
        }
        notifyHist();
        return { ok: res.ok, stale: false };
    }

    return {
        async navigate(t: string, p: string, anchor: string | null = null) {
            // Spec: failures do not mutate stacks. So we only push to back AFTER
            // confirming success (or always, but rollback on failure).
            // The simplest correct approach: push to back IF the load succeeds.
            // Fresh navigations land at scrollY=0; only back/forward restore.
            const previousCurrent = current;
            const result = await load(t, p, anchor, 0);
            if (result.stale) return;
            if (result.ok && previousCurrent) {
                back.push(previousCurrent);
                if (back.length > STACK_CAP) back.shift();
                forward.length = 0;
                notifyHist();
            }
        },
        async back() {
            if (back.length === 0) return;
            const target = back[back.length - 1]!;
            const previousCurrent = current;
            const result = await load(
                target.topic,
                target.package,
                target.anchor,
                target.scrollY,
            );
            if (result.stale) return;
            if (result.ok) {
                back.pop();
                if (previousCurrent) {
                    forward.push(previousCurrent);
                    if (forward.length > STACK_CAP) forward.shift();
                }
                notifyHist();
            }
        },
        async forward() {
            if (forward.length === 0) return;
            const target = forward[forward.length - 1]!;
            const previousCurrent = current;
            const result = await load(
                target.topic,
                target.package,
                target.anchor,
                target.scrollY,
            );
            if (result.stale) return;
            if (result.ok) {
                forward.pop();
                if (previousCurrent) {
                    back.push(previousCurrent);
                    if (back.length > STACK_CAP) back.shift();
                }
                notifyHist();
            }
        },
        setScrollY(y: number) {
            if (current) current.scrollY = y;
        },
        canBack(): boolean {
            return back.length > 0;
        },
        canForward(): boolean {
            return forward.length > 0;
        },
    };
}
