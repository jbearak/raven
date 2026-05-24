import type { ActiveSessionInfo } from '../messages';
import { plot_url } from './httpgd-client';

export type Phase = 'loading' | 'empty' | 'viewing' | 'disconnected';

export type ViewerState = {
    phase: Phase;
    activeSession: ActiveSessionInfo | null;
    plotIds: string[];
    currentIndex: number;
    sessionEnded: boolean;
    themeBg: string | null;
};

export type ViewerAction =
    | { type: 'SET_ACTIVE_SESSION'; activeSession: ActiveSessionInfo | null; sessionEnded: boolean }
    | { type: 'SET_PLOT_IDS'; plotIds: string[] }
    | { type: 'GO_PREV' }
    | { type: 'GO_NEXT' }
    | { type: 'SESSION_ENDED' }
    | { type: 'SET_THEME_BG'; themeBg: string | null };

export function initial_state(): ViewerState {
    return {
        phase: 'loading',
        activeSession: null,
        plotIds: [],
        currentIndex: 0,
        sessionEnded: false,
        themeBg: null,
    };
}

export function reduce(state: ViewerState, action: ViewerAction): ViewerState {
    switch (action.type) {
        case 'SET_ACTIVE_SESSION': {
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
            return {
                ...state,
                activeSession: action.activeSession,
                sessionEnded: false,
                phase,
                plotIds: [],
                currentIndex: 0,
            };
        }
        case 'SET_PLOT_IDS': {
            if (action.plotIds.length === 0) {
                return {
                    ...state,
                    plotIds: [],
                    currentIndex: 0,
                    phase: state.activeSession ? 'empty' : state.phase,
                };
            }
            return {
                ...state,
                plotIds: action.plotIds,
                currentIndex: action.plotIds.length - 1,
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
        case 'SET_THEME_BG':
            return { ...state, themeBg: action.themeBg };
    }
}

/**
 * Identity of the plot the post-quit snapshot fetcher should target.
 *
 * Deliberately omits dimensions and themeBg: the snapshot is a fallback
 * for after R dies, and `<img>` CSS (`object-fit: contain`) scales it
 * post-quit, so it doesn't need to match the live viewport. Including
 * those would refire the snapshot fetch on every resize and theme switch
 * — pointless network traffic since the bytes only need to be re-captured
 * when the underlying plot changes (new plot id, or `points()` etc.
 * bumping `upid` on an existing id).
 *
 * The reuse contract for the same `plotId`: when `upid` changes, the
 * cached snapshot is stale and must be re-fetched (see the upid
 * cache-buster comment in `httpgd-client.ts`).
 */
export type SnapshotKey = {
    baseUrl: string;
    token: string;
    plotId: string;
    upid: number;
};

/**
 * A blob URL captured for a specific plot during an alive R session,
 * paired with the `SnapshotKey` it was fetched against. The pairing lets
 * `pick_image_src` reject a stale cache (failed mid-flight refetch after
 * navigating to a different plot, deleted-plot bytes still in memory)
 * instead of replaying earlier bytes under the wrong "Plot N/M" counter.
 */
export type CachedSnapshot = {
    url: string;
    key: SnapshotKey;
};

export function compute_snapshot_key(state: ViewerState): SnapshotKey | null {
    if (state.sessionEnded) return null;
    if (state.phase !== 'viewing') return null;
    if (!state.activeSession || state.plotIds.length === 0) return null;
    return {
        baseUrl: state.activeSession.httpgdBaseUrl,
        token: state.activeSession.httpgdToken,
        plotId: state.plotIds[state.currentIndex],
        upid: state.activeSession.upid,
    };
}

/**
 * Compute the URL/blob URL to use as the plot `<img>`'s src.
 *
 * While the R session is alive, returns the live httpgd URL. After the
 * session ends (httpgd runs inside R and dies with it), returns the
 * cached blob URL captured while the session was alive — but only when
 * the cache corresponds to the currently-displayed plot. A stale cache
 * (e.g. fetch for the current plot failed mid-flight, leaving a blob
 * from a previously-viewed plot) is NOT replayed; we'd rather return ''
 * than mislabel an earlier plot's pixels under the "Showing last plot"
 * banner.
 *
 * Only `plotId` is compared. A `upid` mismatch (pre-`points()` snapshot
 * of the same plot) is tolerated so the fallback stays useful in the
 * common in-place-update case.
 */
export function pick_image_src(
    state: ViewerState,
    dimensions: { width: number; height: number },
    cached: CachedSnapshot | null,
): string {
    if (state.phase !== 'viewing' && state.phase !== 'disconnected') return '';
    if (state.plotIds.length === 0) return '';
    const id = state.plotIds[state.currentIndex];
    if (state.sessionEnded) {
        if (!cached || cached.key.plotId !== id) return '';
        return cached.url;
    }
    if (!state.activeSession) return '';
    return plot_url(
        state.activeSession.httpgdBaseUrl,
        state.activeSession.httpgdToken,
        id,
        {
            format: 'svg',
            width: dimensions.width,
            height: dimensions.height,
            bg: state.themeBg,
            upid: state.activeSession.upid,
        },
    );
}
