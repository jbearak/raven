import { SvelteMap } from 'svelte/reactivity';
import type { ActiveSessionInfo } from '../messages';

export type Phase = 'loading' | 'empty' | 'viewing' | 'disconnected';

/**
 * Single SVG bytes + the upid they were rendered against. Stored in the
 * webview's svgCache keyed by `${sessionId}:${plotId}:${width}:${height}`
 * — see `svg_cache_key`. The `upid` field distinguishes in-place updates
 * of the same plotId (e.g. `points()` after `plot()`); a cache entry
 * whose upid doesn't match the live session's upid is considered stale.
 */
export type SvgEntry = {
    svgText: string;
    upid: number;
};

export type ViewerState = {
    phase: Phase;
    activeSession: ActiveSessionInfo | null;
    plotIds: string[];
    currentIndex: number;
    sessionEnded: boolean;
    /** Mirrors host globalState (`raven.plot.applyVSCodeTheme`); toggled by the
     *  toolbar button and broadcast via `state-update`. Default false. */
    themeApplied: boolean;
    /**
     * Cache of fetched (and sanitized) SVG documents, keyed by
     * `${sessionId}:${plotId}:${width}:${height}` (see `svg_cache_key`).
     * Replaces the prior `<img>`-driven implicit browser cache with
     * an explicit FIFO bound (`SVG_CACHE_CAP`) so memory doesn't grow
     * unboundedly over a long R session.
     *
     * Eviction is FIFO over insertion order, with a per-plot
     * additional rule: at most one entry per `(sessionId, plotId)`
     * prefix survives a new insert (older sizes for the same plot are
     * stale once the panel has re-fetched). This prevents a resize
     * gesture from blowing the cap and evicting other plots' history.
     */
    svgCache: SvelteMap<string, SvgEntry>;
};

export type ViewerAction =
    | { type: 'SET_ACTIVE_SESSION'; activeSession: ActiveSessionInfo | null; sessionEnded: boolean }
    | { type: 'SET_PLOT_IDS'; plotIds: string[] }
    | { type: 'GO_PREV' }
    | { type: 'GO_NEXT' }
    | { type: 'SESSION_ENDED' }
    | { type: 'SET_THEME_APPLIED'; themeApplied: boolean }
    | { type: 'SET_SVG_CACHE_ENTRY'; cacheKey: string; entry: SvgEntry };

export const SVG_CACHE_CAP = 50;

/**
 * Cache key shape — single source of truth so the fetch effect, the
 * reducer dispatch, and the selector all agree. Including width/height
 * means resize triggers a refetch (httpgd bakes those into the SVG at
 * render time, so the same plotId at a different size IS a different
 * image).
 */
export function svg_cache_key(
    sessionId: string,
    plotId: string,
    width: number,
    height: number,
): string {
    return `${sessionId}:${plotId}:${width}:${height}`;
}

export function initial_state(): ViewerState {
    return {
        phase: 'loading',
        activeSession: null,
        plotIds: [],
        currentIndex: 0,
        sessionEnded: false,
        themeApplied: false,
        svgCache: new SvelteMap<string, SvgEntry>(),
    };
}

function evict_oldest(cache: SvelteMap<string, SvgEntry>): SvelteMap<string, SvgEntry> {
    // We re-create the iterator each pass (`cache.keys().next()`) rather
    // than hoisting one outside the loop. Map iteration with concurrent
    // `delete` is defined to skip deleted entries on the next `next()`,
    // but the per-pass form is clearer about intent and doesn't lean on
    // that subtlety. Do not refactor.
    while (cache.size > SVG_CACHE_CAP) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
    return cache;
}

/**
 * Drop any prior cache entries for the same `(sessionId, plotId)` prefix
 * EXCEPT the one we just inserted. Keeps the cache bounded at "one entry
 * per plot" across a resize gesture so an unsettled drag doesn't evict
 * other plots' history.
 *
 * Cache-key shape: "sessionId:plotId:w:h" — the prefix to match is
 * everything up to the second-to-last `:`.
 */
function purge_other_sizes(cache: SvelteMap<string, SvgEntry>, newCacheKey: string): void {
    const lastSep = newCacheKey.lastIndexOf(':');
    if (lastSep < 0) return;
    const secondLastSep = newCacheKey.lastIndexOf(':', lastSep - 1);
    if (secondLastSep < 0) return;
    const prefix = newCacheKey.slice(0, secondLastSep + 1); // "sessionId:plotId:"
    for (const key of Array.from(cache.keys())) {
        if (key !== newCacheKey && key.startsWith(prefix)) cache.delete(key);
    }
}

function active_session_equal(
    a: ActiveSessionInfo | null,
    b: ActiveSessionInfo | null,
): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;
    return a.sessionId === b.sessionId
        && a.httpgdBaseUrl === b.httpgdBaseUrl
        && a.httpgdToken === b.httpgdToken
        && a.upid === b.upid;
}

/**
 * True when only `upid` differs between two non-null sessions
 * (sessionId, baseUrl, token unchanged). httpgd bumps `upid` on every
 * /plot-available, so the host re-broadcasts a state-update on every
 * plot event — without this branch, the reducer would treat each one
 * as a full session swap and clear `plotIds` / `currentIndex` until
 * the WebSocket-driven `refresh_plots` re-fills them, producing a
 * brief "empty" flash on every plot update.
 */
function only_upid_changed(
    a: ActiveSessionInfo | null,
    b: ActiveSessionInfo | null,
): boolean {
    if (a === null || b === null) return false;
    return a.sessionId === b.sessionId
        && a.httpgdBaseUrl === b.httpgdBaseUrl
        && a.httpgdToken === b.httpgdToken
        && a.upid !== b.upid;
}

export function reduce(state: ViewerState, action: ViewerAction): ViewerState {
    switch (action.type) {
        case 'SET_ACTIVE_SESSION': {
            // No-op short-circuit: a redundant `state-update` (e.g. the
            // broadcast echo where activeSession/sessionEnded are
            // unchanged from what's already in state) returns the SAME
            // reference so Svelte's $state proxy skips the cascade.
            if (
                active_session_equal(state.activeSession, action.activeSession)
                && state.sessionEnded === action.sessionEnded
            ) {
                return state;
            }
            // upid-only change: every /plot-available event broadcasts a
            // state-update with a bumped upid. Without this branch, the
            // reducer falls through to the full "session swap" path and
            // resets `plotIds: []`, `currentIndex: 0` — the user's view
            // momentarily empties on every plot update until
            // `refresh_plots` re-fills via the WebSocket subscription.
            // Update only `activeSession` and preserve everything else.
            if (
                !action.sessionEnded
                && !state.sessionEnded
                && only_upid_changed(state.activeSession, action.activeSession)
            ) {
                return { ...state, activeSession: action.activeSession };
            }
            // Preserve plot history when transitioning to a session-ended
            // state so the "Showing last plot" banner has a plot to show.
            // SESSION_ENDED follows this dispatch and flips the phase to
            // 'disconnected' (see App.svelte attach_session).
            if (action.sessionEnded) {
                return {
                    ...state,
                    activeSession: action.activeSession,
                    sessionEnded: true,
                };
            }
            const phase: Phase = action.activeSession ? 'empty' : 'loading';
            // Drop any cached entries for sessions other than the one
            // we're now bound to. The svgCache key shape is
            // `${sessionId}:${plotId}:${w}:${h}`, so prefix-matching by
            // the new sessionId keeps the entries we'll re-display (if
            // we ever loop back) and evicts dead-session bytes that
            // would otherwise linger until FIFO eviction at cap 50.
            // When `action.activeSession` is null (disconnect), drop
            // everything — there's nothing valid to keep.
            const newSessionId = action.activeSession?.sessionId;
            let svgCache = state.svgCache;
            if (
                state.svgCache.size > 0
                && (newSessionId === undefined || newSessionId !== state.activeSession?.sessionId)
            ) {
                const nextCache = new SvelteMap<string, SvgEntry>();
                if (newSessionId !== undefined) {
                    const keep = `${newSessionId}:`;
                    for (const [k, v] of state.svgCache) {
                        if (k.startsWith(keep)) nextCache.set(k, v);
                    }
                }
                svgCache = nextCache;
            }
            return {
                ...state,
                activeSession: action.activeSession,
                sessionEnded: false,
                phase,
                plotIds: [],
                currentIndex: 0,
                svgCache,
            };
        }
        case 'SET_PLOT_IDS': {
            // Filter out any plotIds containing `:` — the svgCache key
            // shape is `${sessionId}:${plotId}:${w}:${h}`, so a plotId
            // with an embedded `:` would corrupt prefix matching in
            // `purge_other_sizes` and `pick_current_svg`'s post-quit
            // walk. httpgd plotIds are short UUIDs without colons, so
            // this filter is defensive (no observed regressions); if
            // a future httpgd version ever emits colon-bearing ids,
            // we'd just lose history for those plots rather than
            // corrupt the cache for others.
            const plotIds = action.plotIds.filter(id => !id.includes(':'));
            if (plotIds.length === 0) {
                return {
                    ...state,
                    plotIds: [],
                    currentIndex: 0,
                    phase: state.activeSession ? 'empty' : state.phase,
                };
            }
            return {
                ...state,
                plotIds,
                currentIndex: plotIds.length - 1,
                phase: 'viewing',
            };
        }
        case 'GO_PREV':
            return { ...state, currentIndex: Math.max(0, state.currentIndex - 1) };
        case 'GO_NEXT': {
            if (state.plotIds.length === 0) {
                return { ...state, currentIndex: 0 };
            }
            return {
                ...state,
                currentIndex: Math.min(state.plotIds.length - 1, state.currentIndex + 1),
            };
        }
        case 'SESSION_ENDED':
            return { ...state, phase: 'disconnected', sessionEnded: true };
        case 'SET_THEME_APPLIED': {
            // No-op short-circuit: when a broadcast echoes back the same
            // value (panel A flips, host broadcasts to A and B, A sees its
            // own value), return the SAME state reference so Svelte's
            // $state skips the cascade. Without this, every broadcast
            // would trigger a full reactive pass for every open panel,
            // including the originator.
            if (state.themeApplied === action.themeApplied) return state;
            return { ...state, themeApplied: action.themeApplied };
        }
        case 'SET_SVG_CACHE_ENTRY': {
            // Bytes-identical short-circuit: skip the Map rebuild if the
            // incoming entry equals the existing one. The fetch effect's
            // cache-hit short-circuit already prevents this for the
            // bytes-identical case in production, but the guard is
            // defensive for a future `bg_for_fetch` divergence that
            // could dispatch under an identical-byte cache hit.
            const existing = state.svgCache.get(action.cacheKey);
            if (
                existing
                && existing.upid === action.entry.upid
                && existing.svgText === action.entry.svgText
            ) {
                return state;
            }
            const next = new SvelteMap(state.svgCache);
            // delete-before-set: Map.set on an existing key updates the
            // value but does NOT change insertion order. To refresh the
            // entry's FIFO position (so an in-place upid bump moves it
            // to most-recent), we must delete and re-insert.
            next.delete(action.cacheKey);
            next.set(action.cacheKey, action.entry);
            // Per-plot eviction: drop any prior entries for the same
            // (sessionId, plotId) prefix so a resize gesture doesn't
            // accumulate stale sizes.
            purge_other_sizes(next, action.cacheKey);
            return { ...state, svgCache: evict_oldest(next) };
        }
    }
}

/**
 * Resolve the SvgEntry to render for the current `(plotId, dimensions)`.
 *
 * Live session: requires the cached entry's upid to match
 * `state.activeSession.upid`. A mismatch means the entry is from an
 * earlier in-place plot update (or a different session entirely) and is
 * stale.
 *
 * Post-quit (`state.sessionEnded === true`): tolerates upid mismatch
 * since httpgd is dead and the cached bytes are the best we have.
 * Also tolerates dimension drift — the user may resize the panel after
 * R quits, and we can't refetch; pick the most-recently-inserted entry
 * matching the `(sessionId, plotId)` prefix as a fallback.
 *
 * Branching on `state.sessionEnded` (not `state.activeSession`) is
 * load-bearing: `SET_ACTIVE_SESSION { sessionEnded: true }` PRESERVES
 * `activeSession` (see the reducer), so a check like
 * `if (state.activeSession)` would still run the live branch post-quit
 * and reject every cached entry the moment a `points()` call bumped
 * upid just before R died.
 */
export function pick_current_svg(
    state: ViewerState,
    dimensions: { width: number; height: number },
): SvgEntry | null {
    if (state.plotIds.length === 0) return null;
    const id = state.plotIds[state.currentIndex];
    const sessionId = state.activeSession?.sessionId;
    if (!sessionId) return null;
    const cacheKey = svg_cache_key(sessionId, id, dimensions.width, dimensions.height);
    if (state.sessionEnded) {
        // Try the live-dimension cache key first; on miss, walk the cache
        // in REVERSE insertion order so the most-recently-inserted entry
        // for this plotId wins.
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
    // `sessionEnded = true` would otherwise crash here.
    if (entry.upid !== state.activeSession?.upid) return null;  // stale
    return entry;
}

/**
 * Background-color query parameter for the httpgd fetch URL.
 *
 * Today both branches return '#ffffff'. Why not omit `bg` and let httpgd
 * pick a default: that default is unspecified by Raven (it could be
 * `transparent`, `white`, or something else depending on httpgd
 * version). Passing an explicit white locks the behavior down across
 * httpgd versions.
 *
 * Toggle OFF: R's canvas <rect fill="white"> + httpgd's #ffffff bg =
 * white plot. Matches today.
 *
 * Toggle ON: CSS overlay hides the canvas rect; webview body's
 * `--vscode-editor-background` shows through. The fetched SVG bytes
 * are unchanged (so the cache key correctly excludes `themeApplied`).
 *
 * A future change wanting a different toggle-on bg would update this
 * single function AND extend the svgCache key to include themeApplied
 * (since the rendered SVG bytes would then diverge).
 */
export function bg_for_fetch(_themeApplied: boolean): string {
    return '#ffffff';
}
