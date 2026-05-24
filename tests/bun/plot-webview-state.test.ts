import { describe, test, expect } from 'bun:test';
import {
    compute_snapshot_key,
    initial_state,
    pick_image_src,
    reduce,
} from '../../editors/vscode/src/plot/webview/state';

describe('webview state reducer', () => {
    test('initial state is loading with no active session', () => {
        expect(initial_state()).toEqual({
            phase: 'loading',
            activeSession: null,
            plotIds: [],
            currentIndex: 0,
            sessionEnded: false,
            themeBg: null,
        });
    });

    test('SET_ACTIVE_SESSION transitions to empty', () => {
        const s = reduce(initial_state(), {
            type: 'SET_ACTIVE_SESSION',
            activeSession: { sessionId: 's', httpgdBaseUrl: 'http://x', httpgdToken: 't', upid: 0 },
            sessionEnded: false,
        });
        expect(s.phase).toBe('empty');
        expect(s.activeSession?.sessionId).toBe('s');
        expect(s.sessionEnded).toBe(false);
    });

    test('SET_PLOT_IDS with new plots transitions to viewing', () => {
        let s = reduce(initial_state(), {
            type: 'SET_ACTIVE_SESSION',
            activeSession: { sessionId: 's', httpgdBaseUrl: 'http://x', httpgdToken: 't', upid: 0 },
            sessionEnded: false,
        });
        s = reduce(s, { type: 'SET_PLOT_IDS', plotIds: ['p1', 'p2'] });
        expect(s.phase).toBe('viewing');
        expect(s.plotIds).toEqual(['p1', 'p2']);
        expect(s.currentIndex).toBe(1); // most recent
    });

    test('SET_PLOT_IDS empty list returns to empty when active', () => {
        let s = reduce(initial_state(), {
            type: 'SET_ACTIVE_SESSION',
            activeSession: { sessionId: 's', httpgdBaseUrl: 'http://x', httpgdToken: 't', upid: 0 },
            sessionEnded: false,
        });
        s = reduce(s, { type: 'SET_PLOT_IDS', plotIds: [] });
        expect(s.phase).toBe('empty');
    });

    test('GO_PREV decrements currentIndex but not below 0', () => {
        let s = reduce(initial_state(), {
            type: 'SET_ACTIVE_SESSION',
            activeSession: { sessionId: 's', httpgdBaseUrl: 'http://x', httpgdToken: 't', upid: 0 },
            sessionEnded: false,
        });
        s = reduce(s, { type: 'SET_PLOT_IDS', plotIds: ['p1', 'p2', 'p3'] });
        expect(s.currentIndex).toBe(2);
        s = reduce(s, { type: 'GO_PREV' });
        expect(s.currentIndex).toBe(1);
        s = reduce(s, { type: 'GO_PREV' });
        s = reduce(s, { type: 'GO_PREV' });
        expect(s.currentIndex).toBe(0);
    });

    test('GO_NEXT increments but not past the last plot', () => {
        let s = reduce(initial_state(), {
            type: 'SET_ACTIVE_SESSION',
            activeSession: { sessionId: 's', httpgdBaseUrl: 'http://x', httpgdToken: 't', upid: 0 },
            sessionEnded: false,
        });
        s = reduce(s, { type: 'SET_PLOT_IDS', plotIds: ['p1', 'p2', 'p3'] });
        s = reduce(s, { type: 'GO_PREV' });
        s = reduce(s, { type: 'GO_NEXT' });
        expect(s.currentIndex).toBe(2);
        s = reduce(s, { type: 'GO_NEXT' });
        expect(s.currentIndex).toBe(2);
    });

    test('SESSION_ENDED transitions to disconnected and keeps last plot', () => {
        let s = reduce(initial_state(), {
            type: 'SET_ACTIVE_SESSION',
            activeSession: { sessionId: 's', httpgdBaseUrl: 'http://x', httpgdToken: 't', upid: 0 },
            sessionEnded: false,
        });
        s = reduce(s, { type: 'SET_PLOT_IDS', plotIds: ['p1'] });
        s = reduce(s, { type: 'SESSION_ENDED' });
        expect(s.phase).toBe('disconnected');
        expect(s.sessionEnded).toBe(true);
        expect(s.plotIds).toEqual(['p1']);
    });

    test('SET_ACTIVE_SESSION with sessionEnded=true preserves plot history', () => {
        // Reproduces the panel's session-ended state-update message:
        //   activeSession=<session>, sessionEnded=true.
        // App.svelte dispatches SET_ACTIVE_SESSION before SESSION_ENDED,
        // so the SET_ACTIVE_SESSION step must not clear plotIds/currentIndex.
        let s = reduce(initial_state(), {
            type: 'SET_ACTIVE_SESSION',
            activeSession: { sessionId: 's', httpgdBaseUrl: 'http://x', httpgdToken: 't', upid: 0 },
            sessionEnded: false,
        });
        s = reduce(s, { type: 'SET_PLOT_IDS', plotIds: ['p1', 'p2', 'p3'] });
        // Step the user back from the most recent plot to ensure the index is
        // preserved across the session-ended transition.
        s = reduce(s, { type: 'GO_PREV' });
        expect(s.currentIndex).toBe(1);
        s = reduce(s, {
            type: 'SET_ACTIVE_SESSION',
            activeSession: { sessionId: 's', httpgdBaseUrl: 'http://x', httpgdToken: 't', upid: 0 },
            sessionEnded: true,
        });
        expect(s.plotIds).toEqual(['p1', 'p2', 'p3']);
        expect(s.currentIndex).toBe(1);
        expect(s.sessionEnded).toBe(true);
        s = reduce(s, { type: 'SESSION_ENDED' });
        expect(s.phase).toBe('disconnected');
        expect(s.plotIds).toEqual(['p1', 'p2', 'p3']);
        expect(s.currentIndex).toBe(1);
    });

    test('SET_ACTIVE_SESSION with sessionEnded=false still resets plots', () => {
        let s = reduce(initial_state(), {
            type: 'SET_ACTIVE_SESSION',
            activeSession: { sessionId: 'a', httpgdBaseUrl: 'http://x', httpgdToken: 't', upid: 0 },
            sessionEnded: false,
        });
        s = reduce(s, { type: 'SET_PLOT_IDS', plotIds: ['p1', 'p2'] });
        s = reduce(s, {
            type: 'SET_ACTIVE_SESSION',
            activeSession: { sessionId: 'b', httpgdBaseUrl: 'http://y', httpgdToken: 'u', upid: 0 },
            sessionEnded: false,
        });
        expect(s.plotIds).toEqual([]);
        expect(s.currentIndex).toBe(0);
        expect(s.phase).toBe('empty');
        expect(s.sessionEnded).toBe(false);
    });

    test('SET_THEME_BG records the bg', () => {
        const s = reduce(initial_state(), {
            type: 'SET_THEME_BG',
            themeBg: '#1e1e1e',
        });
        expect(s.themeBg).toBe('#1e1e1e');
    });
});

describe('pick_image_src', () => {
    const dim = { width: 800, height: 600 };
    const session = {
        sessionId: 's',
        httpgdBaseUrl: 'http://127.0.0.1:12345',
        httpgdToken: 't',
        upid: 1,
    };

    function viewing_state() {
        let s = reduce(initial_state(), {
            type: 'SET_ACTIVE_SESSION',
            activeSession: session,
            sessionEnded: false,
        });
        s = reduce(s, { type: 'SET_PLOT_IDS', plotIds: ['p1'] });
        return s;
    }

    test('returns the live httpgd URL while session is viewing', () => {
        const src = pick_image_src(viewing_state(), dim, null);
        expect(src).toContain('127.0.0.1:12345');
        expect(src).toContain('id=p1');
    });

    test('returns "" when no plots yet (phase=empty)', () => {
        const s = reduce(initial_state(), {
            type: 'SET_ACTIVE_SESSION',
            activeSession: session,
            sessionEnded: false,
        });
        expect(pick_image_src(s, dim, null)).toBe('');
    });

    test('after SESSION_ENDED, returns the cached blob URL instead of the dead httpgd URL', () => {
        // This is the regression test for the "Showing last plot" bug:
        // httpgd dies with R, so the live URL would 404. The webview captures
        // a blob URL while the session is alive and must use it post-quit.
        let s = viewing_state();
        s = reduce(s, { type: 'SESSION_ENDED' });
        const src = pick_image_src(s, dim, 'blob:cached-svg');
        expect(src).toBe('blob:cached-svg');
        expect(src).not.toContain('127.0.0.1:12345');
    });

    test('after SESSION_ENDED with no cached blob URL, returns "" (graceful)', () => {
        // Worst case: session ended before any plot was cached (very fast quit,
        // or panel restored after R died). Don't return the dead URL — better
        // to show the placeholder than a broken image.
        let s = viewing_state();
        s = reduce(s, { type: 'SESSION_ENDED' });
        expect(pick_image_src(s, dim, null)).toBe('');
    });
});

describe('compute_snapshot_key', () => {
    const session = {
        sessionId: 's',
        httpgdBaseUrl: 'http://127.0.0.1:12345',
        httpgdToken: 't',
        upid: 7,
    };

    function viewing_state_with(plotIds: string[], currentIndex: number) {
        let s = reduce(initial_state(), {
            type: 'SET_ACTIVE_SESSION',
            activeSession: session,
            sessionEnded: false,
        });
        s = reduce(s, { type: 'SET_PLOT_IDS', plotIds });
        // SET_PLOT_IDS sets currentIndex to last. Step back if asked.
        while (s.currentIndex > currentIndex) {
            s = reduce(s, { type: 'GO_PREV' });
        }
        return s;
    }

    test('returns the current plot id + upid + session info while viewing', () => {
        const s = viewing_state_with(['p1', 'p2'], 1);
        expect(compute_snapshot_key(s)).toEqual({
            baseUrl: 'http://127.0.0.1:12345',
            token: 't',
            plotId: 'p2',
            upid: 7,
        });
    });

    test('returns null after SESSION_ENDED (no fetch should fire post-quit)', () => {
        let s = viewing_state_with(['p1'], 0);
        s = reduce(s, { type: 'SESSION_ENDED' });
        expect(compute_snapshot_key(s)).toBeNull();
    });

    test('returns null when there are no plots yet', () => {
        const s = reduce(initial_state(), {
            type: 'SET_ACTIVE_SESSION',
            activeSession: session,
            sessionEnded: false,
        });
        expect(compute_snapshot_key(s)).toBeNull();
    });

    test('does not change when themeBg changes (no refetch on theme switch)', () => {
        // Regression guard for the original double-fetch bug: the snapshot
        // fetch must not redundantly re-fire when the user switches VS Code
        // theme. httpgd dies with R, so the cached blob is just a fallback;
        // CSS scales it post-quit and there's no win from re-downloading
        // with a different bg.
        let s = viewing_state_with(['p1'], 0);
        const before = compute_snapshot_key(s);
        s = reduce(s, { type: 'SET_THEME_BG', themeBg: '#1e1e1e' });
        const after = compute_snapshot_key(s);
        expect(after).toEqual(before!);
    });

    test('changes when plotId changes (new plot must refetch)', () => {
        let s = viewing_state_with(['p1', 'p2'], 1);
        const at_p2 = compute_snapshot_key(s);
        s = reduce(s, { type: 'GO_PREV' });
        const at_p1 = compute_snapshot_key(s);
        expect(at_p1!.plotId).toBe('p1');
        expect(at_p2!.plotId).toBe('p2');
    });

    test('changes when upid changes (in-place plot update must refetch)', () => {
        // Same plotId but a different upid means `points()` or similar
        // updated the live plot. The cached snapshot is stale and must be
        // re-downloaded.
        const s1 = viewing_state_with(['p1'], 0);
        const before = compute_snapshot_key(s1);
        // Simulate a state-update arriving with an incremented upid.
        const s2 = reduce(s1, {
            type: 'SET_ACTIVE_SESSION',
            activeSession: { ...session, upid: 8 },
            sessionEnded: false,
        });
        // SET_ACTIVE_SESSION clears plotIds (per the reducer); reapply.
        const s3 = reduce(s2, { type: 'SET_PLOT_IDS', plotIds: ['p1'] });
        const after = compute_snapshot_key(s3);
        expect(before!.upid).toBe(7);
        expect(after!.upid).toBe(8);
    });
});
