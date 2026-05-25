import { describe, test, expect } from 'bun:test';
import {
    SVG_CACHE_CAP,
    bg_for_fetch,
    initial_state,
    pick_current_svg,
    reduce,
    svg_cache_key,
} from '../../editors/vscode/src/plot/webview/state';
import type { SvgEntry, ViewerState } from '../../editors/vscode/src/plot/webview/state';

const SESSION = {
    sessionId: 's',
    httpgdBaseUrl: 'http://127.0.0.1:12345',
    httpgdToken: 't',
    upid: 1,
};

const DIM = { width: 800, height: 600 };

function viewing_state(session = SESSION, plotIds: string[] = ['p1']): ViewerState {
    let s = reduce(initial_state(), {
        type: 'SET_ACTIVE_SESSION',
        activeSession: session,
        sessionEnded: false,
    });
    s = reduce(s, { type: 'SET_PLOT_IDS', plotIds });
    return s;
}

function entry(svgText: string, upid: number): SvgEntry {
    return { svgText, upid };
}

describe('webview state reducer — base behavior', () => {
    test('initial state', () => {
        const s = initial_state();
        expect(s.phase).toBe('loading');
        expect(s.activeSession).toBeNull();
        expect(s.plotIds).toEqual([]);
        expect(s.currentIndex).toBe(0);
        expect(s.sessionEnded).toBe(false);
        expect(s.themeApplied).toBe(false);
        expect(s.svgCache.size).toBe(0);
    });

    test('SET_ACTIVE_SESSION transitions to empty', () => {
        const s = reduce(initial_state(), {
            type: 'SET_ACTIVE_SESSION',
            activeSession: SESSION,
            sessionEnded: false,
        });
        expect(s.phase).toBe('empty');
        expect(s.activeSession?.sessionId).toBe('s');
    });

    test('SET_PLOT_IDS with new plots transitions to viewing', () => {
        let s = viewing_state(SESSION, ['p1', 'p2']);
        expect(s.phase).toBe('viewing');
        expect(s.plotIds).toEqual(['p1', 'p2']);
        expect(s.currentIndex).toBe(1);
    });

    test('SET_PLOT_IDS empty returns to empty when active', () => {
        let s = viewing_state();
        s = reduce(s, { type: 'SET_PLOT_IDS', plotIds: [] });
        expect(s.phase).toBe('empty');
    });

    test('GO_PREV / GO_NEXT clamp', () => {
        let s = viewing_state(SESSION, ['p1', 'p2', 'p3']);
        expect(s.currentIndex).toBe(2);
        s = reduce(s, { type: 'GO_PREV' });
        expect(s.currentIndex).toBe(1);
        s = reduce(s, { type: 'GO_PREV' });
        s = reduce(s, { type: 'GO_PREV' });
        expect(s.currentIndex).toBe(0);
        s = reduce(s, { type: 'GO_NEXT' });
        expect(s.currentIndex).toBe(1);
    });

    test('SESSION_ENDED preserves plot history', () => {
        let s = viewing_state(SESSION, ['p1', 'p2']);
        s = reduce(s, { type: 'GO_PREV' });
        s = reduce(s, { type: 'SESSION_ENDED' });
        expect(s.phase).toBe('disconnected');
        expect(s.sessionEnded).toBe(true);
        expect(s.plotIds).toEqual(['p1', 'p2']);
        expect(s.currentIndex).toBe(0);
    });

    test('SET_ACTIVE_SESSION sessionEnded=true preserves plot history', () => {
        let s = viewing_state(SESSION, ['p1', 'p2', 'p3']);
        s = reduce(s, { type: 'GO_PREV' });
        s = reduce(s, {
            type: 'SET_ACTIVE_SESSION',
            activeSession: SESSION,
            sessionEnded: true,
        });
        expect(s.plotIds).toEqual(['p1', 'p2', 'p3']);
        expect(s.currentIndex).toBe(1);
        expect(s.sessionEnded).toBe(true);
    });

    test('SET_ACTIVE_SESSION sessionEnded=false to a different session clears plots', () => {
        let s = viewing_state(SESSION, ['p1']);
        s = reduce(s, {
            type: 'SET_ACTIVE_SESSION',
            activeSession: { ...SESSION, sessionId: 'b' },
            sessionEnded: false,
        });
        expect(s.plotIds).toEqual([]);
        expect(s.phase).toBe('empty');
    });

    test('SET_ACTIVE_SESSION is no-op when activeSession+sessionEnded are unchanged', () => {
        // Returns the SAME state reference so Svelte's $state skips the cascade.
        const s = viewing_state();
        const sameSessionPayload = {
            type: 'SET_ACTIVE_SESSION' as const,
            activeSession: { ...s.activeSession! },
            sessionEnded: false,
        };
        const next = reduce(s, sameSessionPayload);
        // The exact-reference check is the load-bearing one — Svelte's
        // $state proxy short-circuits on identity equality.
        expect(next).toBe(s);
    });

    test('SET_ACTIVE_SESSION with upid-only change PRESERVES plotIds and currentIndex', () => {
        // Regression guard: without this branch, every /plot-available
        // event broadcast would reset plotIds=[] and currentIndex=0,
        // flashing "empty" until the WebSocket refresh re-filled.
        let s = viewing_state(SESSION, ['p1', 'p2', 'p3']);
        s = reduce(s, { type: 'GO_PREV' });
        expect(s.currentIndex).toBe(1);
        // Insert a cache entry so we can verify it survives too.
        s = reduce(s, {
            type: 'SET_SVG_CACHE_ENTRY',
            cacheKey: svg_cache_key('s', 'p2', DIM.width, DIM.height),
            entry: entry('<svg>p2</svg>', SESSION.upid),
        });
        const before_cache_size = s.svgCache.size;
        // Simulate a plot-available state-update with bumped upid.
        const next = reduce(s, {
            type: 'SET_ACTIVE_SESSION',
            activeSession: { ...SESSION, upid: SESSION.upid + 1 },
            sessionEnded: false,
        });
        expect(next.plotIds).toEqual(['p1', 'p2', 'p3']);
        expect(next.currentIndex).toBe(1);
        expect(next.phase).toBe('viewing');
        expect(next.activeSession?.upid).toBe(SESSION.upid + 1);
        // svgCache survives because only-upid-changed paths don't touch it.
        expect(next.svgCache.size).toBe(before_cache_size);
    });

    test('SET_ACTIVE_SESSION different sessionId DROPS svgCache entries for the prior session', () => {
        // The session-swap cache eviction keeps the cache from
        // accumulating dead-session bytes across many session swaps.
        let s = viewing_state();
        s = reduce(s, {
            type: 'SET_SVG_CACHE_ENTRY',
            cacheKey: svg_cache_key('s', 'p1', DIM.width, DIM.height),
            entry: entry('<svg>p1</svg>', SESSION.upid),
        });
        expect(s.svgCache.size).toBe(1);
        const next = reduce(s, {
            type: 'SET_ACTIVE_SESSION',
            activeSession: { ...SESSION, sessionId: 'different' },
            sessionEnded: false,
        });
        expect(next.svgCache.size).toBe(0);
    });

    test('SET_ACTIVE_SESSION different sessionId KEEPS cache entries for the new session if any existed', () => {
        let s = viewing_state();
        // Seed an entry under the OTHER session id so we can verify it survives.
        s.svgCache.set(svg_cache_key('new-session', 'p1', DIM.width, DIM.height), entry('<svg>k</svg>', 0));
        s.svgCache.set(svg_cache_key('s', 'p1', DIM.width, DIM.height), entry('<svg>drop</svg>', SESSION.upid));
        const next = reduce(s, {
            type: 'SET_ACTIVE_SESSION',
            activeSession: { ...SESSION, sessionId: 'new-session' },
            sessionEnded: false,
        });
        expect(next.svgCache.size).toBe(1);
        expect(next.svgCache.has(svg_cache_key('new-session', 'p1', DIM.width, DIM.height))).toBe(true);
    });
});

describe('SET_THEME_APPLIED reducer', () => {
    test('toggles themeApplied true→false→true', () => {
        let s = initial_state();
        expect(s.themeApplied).toBe(false);
        s = reduce(s, { type: 'SET_THEME_APPLIED', themeApplied: true });
        expect(s.themeApplied).toBe(true);
        s = reduce(s, { type: 'SET_THEME_APPLIED', themeApplied: false });
        expect(s.themeApplied).toBe(false);
    });

    test('no-op short-circuit returns SAME state reference on identical value', () => {
        // Load-bearing for the broadcast feedback-loop suppression. If
        // this fails, every broadcast triggers a full reactive pass
        // for every open panel.
        const s = initial_state();
        const next = reduce(s, { type: 'SET_THEME_APPLIED', themeApplied: false });
        expect(next).toBe(s);  // Object.is identity, not just equality
    });

    test('no-op short-circuit holds after a real flip', () => {
        let s = reduce(initial_state(), { type: 'SET_THEME_APPLIED', themeApplied: true });
        const next = reduce(s, { type: 'SET_THEME_APPLIED', themeApplied: true });
        expect(next).toBe(s);
    });
});

describe('SET_SVG_CACHE_ENTRY reducer', () => {
    test('adds a new entry and returns a new state object', () => {
        const s = initial_state();
        const next = reduce(s, {
            type: 'SET_SVG_CACHE_ENTRY',
            cacheKey: 's:p1:800:600',
            entry: entry('<svg></svg>', 1),
        });
        expect(next).not.toBe(s);
        expect(next.svgCache.size).toBe(1);
        expect(next.svgCache.get('s:p1:800:600')?.svgText).toBe('<svg></svg>');
    });

    test('returns a NEW SvelteMap identity for Svelte reactivity', () => {
        const s = initial_state();
        const next = reduce(s, {
            type: 'SET_SVG_CACHE_ENTRY',
            cacheKey: 's:p1:800:600',
            entry: entry('<svg></svg>', 1),
        });
        // The Map reference MUST change so $state's deep proxy registers
        // an update (a same-reference mutated Map would not trigger
        // reactivity downstream).
        expect(next.svgCache).not.toBe(s.svgCache);
    });

    test('bytes-identical short-circuit returns SAME state reference', () => {
        const s = reduce(initial_state(), {
            type: 'SET_SVG_CACHE_ENTRY',
            cacheKey: 's:p1:800:600',
            entry: entry('<svg></svg>', 1),
        });
        const next = reduce(s, {
            type: 'SET_SVG_CACHE_ENTRY',
            cacheKey: 's:p1:800:600',
            entry: entry('<svg></svg>', 1),
        });
        expect(next).toBe(s);
    });

    test('FIFO eviction kicks in at SVG_CACHE_CAP', () => {
        let s = initial_state();
        // Insert SVG_CACHE_CAP + 5 distinct plots (different plotIds so
        // the per-plot purge doesn't drop them).
        for (let i = 0; i < SVG_CACHE_CAP + 5; i++) {
            s = reduce(s, {
                type: 'SET_SVG_CACHE_ENTRY',
                cacheKey: `s:p${i}:800:600`,
                entry: entry(`<svg>${i}</svg>`, 1),
            });
        }
        expect(s.svgCache.size).toBe(SVG_CACHE_CAP);
        // Oldest 5 should have been evicted.
        expect(s.svgCache.has('s:p0:800:600')).toBe(false);
        expect(s.svgCache.has('s:p4:800:600')).toBe(false);
        expect(s.svgCache.has('s:p5:800:600')).toBe(true);
        expect(s.svgCache.has(`s:p${SVG_CACHE_CAP + 4}:800:600`)).toBe(true);
    });

    test('re-inserting an existing cacheKey moves it to most-recent insertion slot', () => {
        let s = reduce(initial_state(), {
            type: 'SET_SVG_CACHE_ENTRY',
            cacheKey: 's:p1:800:600',
            entry: entry('<svg>v1</svg>', 1),
        });
        s = reduce(s, {
            type: 'SET_SVG_CACHE_ENTRY',
            cacheKey: 's:p2:800:600',
            entry: entry('<svg>v2</svg>', 1),
        });
        // Re-insert p1 with updated upid — should move to the END of the order.
        s = reduce(s, {
            type: 'SET_SVG_CACHE_ENTRY',
            cacheKey: 's:p1:800:600',
            entry: entry('<svg>v1.upd</svg>', 2),
        });
        const keys = Array.from(s.svgCache.keys());
        expect(keys[keys.length - 1]).toBe('s:p1:800:600');
        expect(s.svgCache.get('s:p1:800:600')?.upid).toBe(2);
    });

    test('per-plot eviction: same (sessionId, plotId) at different sizes leaves only one entry', () => {
        let s = initial_state();
        for (let w = 100; w <= 400; w += 100) {
            s = reduce(s, {
                type: 'SET_SVG_CACHE_ENTRY',
                cacheKey: `s:p1:${w}:600`,
                entry: entry(`<svg w=${w}/>`, 1),
            });
        }
        // Only the last-inserted size for p1 survives.
        expect(s.svgCache.size).toBe(1);
        expect(s.svgCache.has('s:p1:400:600')).toBe(true);
    });

    test('per-plot eviction does NOT cross plotId — other plots survive', () => {
        let s = initial_state();
        s = reduce(s, {
            type: 'SET_SVG_CACHE_ENTRY',
            cacheKey: 's:p1:100:100',
            entry: entry('<svg/>', 1),
        });
        s = reduce(s, {
            type: 'SET_SVG_CACHE_ENTRY',
            cacheKey: 's:p2:200:200',
            entry: entry('<svg/>', 1),
        });
        s = reduce(s, {
            type: 'SET_SVG_CACHE_ENTRY',
            cacheKey: 's:p1:300:300',
            entry: entry('<svg/>', 1),
        });
        expect(s.svgCache.size).toBe(2);
        expect(s.svgCache.has('s:p1:300:300')).toBe(true);
        expect(s.svgCache.has('s:p2:200:200')).toBe(true);
    });

    test('resize gesture: 200 different (w, h) at same (sessionId, plotId) leaves ONE entry', () => {
        // Regression guard against a resize gesture evicting other plots'
        // history. With per-plot eviction, the cache cap is effectively
        // "one entry per (sessionId, plotId)" not "50 (plot, size) pairs".
        let s = initial_state();
        // Pre-populate with 30 other plots that must survive.
        for (let i = 0; i < 30; i++) {
            s = reduce(s, {
                type: 'SET_SVG_CACHE_ENTRY',
                cacheKey: `s:plot${i}:800:600`,
                entry: entry(`<svg id=${i}/>`, 1),
            });
        }
        // Simulate a 200-frame resize gesture.
        for (let i = 0; i < 200; i++) {
            s = reduce(s, {
                type: 'SET_SVG_CACHE_ENTRY',
                cacheKey: `s:resize-plot:${100 + i}:${100 + i}`,
                entry: entry(`<svg r=${i}/>`, 1),
            });
        }
        // Resize gesture leaves exactly one entry for resize-plot.
        const resizeEntries = Array.from(s.svgCache.keys()).filter(k => k.startsWith('s:resize-plot:'));
        expect(resizeEntries.length).toBe(1);
        // None of the other 30 plots were evicted.
        for (let i = 0; i < 30; i++) {
            expect(s.svgCache.has(`s:plot${i}:800:600`)).toBe(true);
        }
    });
});

describe('svg_cache_key', () => {
    test('produces distinct keys per (sessionId, plotId, width, height)', () => {
        expect(svg_cache_key('s1', 'p1', 800, 600)).toBe('s1:p1:800:600');
        expect(svg_cache_key('s2', 'p1', 800, 600)).not.toBe(svg_cache_key('s1', 'p1', 800, 600));
        expect(svg_cache_key('s1', 'p2', 800, 600)).not.toBe(svg_cache_key('s1', 'p1', 800, 600));
        expect(svg_cache_key('s1', 'p1', 1000, 600)).not.toBe(svg_cache_key('s1', 'p1', 800, 600));
        expect(svg_cache_key('s1', 'p1', 800, 700)).not.toBe(svg_cache_key('s1', 'p1', 800, 600));
    });
});

describe('pick_current_svg — live session', () => {
    test('returns null when no plots', () => {
        const s = reduce(initial_state(), {
            type: 'SET_ACTIVE_SESSION',
            activeSession: SESSION,
            sessionEnded: false,
        });
        expect(pick_current_svg(s, DIM)).toBeNull();
    });

    test('returns null when cache is cold', () => {
        const s = viewing_state();
        expect(pick_current_svg(s, DIM)).toBeNull();
    });

    test('returns the cached entry when (upid, dimensions) match', () => {
        let s = viewing_state();
        const key = svg_cache_key('s', 'p1', DIM.width, DIM.height);
        s = reduce(s, {
            type: 'SET_SVG_CACHE_ENTRY',
            cacheKey: key,
            entry: entry('<svg>hi</svg>', SESSION.upid),
        });
        expect(pick_current_svg(s, DIM)?.svgText).toBe('<svg>hi</svg>');
    });

    test('returns null on upid mismatch (live)', () => {
        let s = viewing_state();
        const key = svg_cache_key('s', 'p1', DIM.width, DIM.height);
        s = reduce(s, {
            type: 'SET_SVG_CACHE_ENTRY',
            cacheKey: key,
            entry: entry('<svg>stale</svg>', SESSION.upid + 1),
        });
        expect(pick_current_svg(s, DIM)).toBeNull();
    });

    test('returns null on dimension mismatch (live)', () => {
        let s = viewing_state();
        // Insert under one size, look up at another.
        const key = svg_cache_key('s', 'p1', 100, 100);
        s = reduce(s, {
            type: 'SET_SVG_CACHE_ENTRY',
            cacheKey: key,
            entry: entry('<svg/>', SESSION.upid),
        });
        expect(pick_current_svg(s, { width: 200, height: 200 })).toBeNull();
    });
});

describe('pick_current_svg — post-quit', () => {
    test('returns the entry for the live cache key when present', () => {
        let s = viewing_state();
        const key = svg_cache_key('s', 'p1', DIM.width, DIM.height);
        s = reduce(s, {
            type: 'SET_SVG_CACHE_ENTRY',
            cacheKey: key,
            entry: entry('<svg>post</svg>', SESSION.upid),
        });
        s = reduce(s, { type: 'SESSION_ENDED' });
        expect(pick_current_svg(s, DIM)?.svgText).toBe('<svg>post</svg>');
    });

    test('tolerates upid mismatch (httpgd is dead — bytes are best-we-have)', () => {
        let s = viewing_state();
        const key = svg_cache_key('s', 'p1', DIM.width, DIM.height);
        s = reduce(s, {
            type: 'SET_SVG_CACHE_ENTRY',
            cacheKey: key,
            entry: entry('<svg>old-upid</svg>', SESSION.upid + 99),
        });
        s = reduce(s, { type: 'SESSION_ENDED' });
        expect(pick_current_svg(s, DIM)?.svgText).toBe('<svg>old-upid</svg>');
    });

    test('REVERSE-walks the cache and returns the most-recently inserted matching entry', () => {
        // Regression guard for the v7→v8 fix: a forward walk would
        // return the OLDEST cached size, which gives the wrong UX
        // after a resize (the user sees a tiny early plot rather than
        // their latest size).
        let s = viewing_state();
        s = reduce(s, {
            type: 'SET_SVG_CACHE_ENTRY',
            cacheKey: svg_cache_key('s', 'p1', 100, 100),
            entry: entry('<svg>oldest</svg>', SESSION.upid),
        });
        // Per-plot eviction would drop the 100x100 entry on the next
        // p1 insert. To reach the "no live-dim match, walk the prefix"
        // branch, we insert at a different plotId, then look up p1 at
        // an unmatched dim.
        s = reduce(s, {
            type: 'SET_SVG_CACHE_ENTRY',
            cacheKey: svg_cache_key('s', 'other', 800, 600),
            entry: entry('<svg>other</svg>', SESSION.upid),
        });
        s = reduce(s, { type: 'SESSION_ENDED' });
        // Look up p1 at a different size — live-dim miss; the reverse
        // walk should return the 100x100 p1 entry (the only one).
        const result = pick_current_svg(s, { width: 999, height: 999 });
        expect(result?.svgText).toBe('<svg>oldest</svg>');
    });

    test('post-quit reverse walk: when two different sizes for the same plot survive (forced via direct cache build), the most-recent wins', () => {
        // Build the cache directly so we can test the reverse walk in
        // isolation from the per-plot eviction (per-plot eviction in
        // the reducer would normally drop earlier sizes; here we set
        // up the state object by hand to exercise the selector).
        const s = viewing_state();
        s.svgCache.set(svg_cache_key('s', 'p1', 100, 100), entry('<svg>first</svg>', SESSION.upid));
        s.svgCache.set(svg_cache_key('s', 'p1', 200, 200), entry('<svg>second</svg>', SESSION.upid));
        const s2 = reduce(s, { type: 'SESSION_ENDED' });
        const result = pick_current_svg(s2, { width: 999, height: 999 });
        expect(result?.svgText).toBe('<svg>second</svg>');
    });

    test('returns null when nothing matches', () => {
        let s = viewing_state();
        s = reduce(s, { type: 'SESSION_ENDED' });
        expect(pick_current_svg(s, DIM)).toBeNull();
    });

    test('does NOT bleed across sessions even at the same plotId', () => {
        let s = viewing_state();
        s.svgCache.set(svg_cache_key('other-session', 'p1', DIM.width, DIM.height), entry('<svg>nope</svg>', SESSION.upid));
        s = reduce(s, { type: 'SESSION_ENDED' });
        // The live-key lookup misses (different session); the prefix
        // walk looks for `s:p1:` not `other-session:p1:`.
        expect(pick_current_svg(s, DIM)).toBeNull();
    });

    test('history navigation post-quit: GO_PREV/GO_NEXT walk every cached plot (spec smoke #10 regression)', () => {
        // Mirrors smoke test #10: plot three things, navigate back to
        // the first, then quit R. After quit, GO_PREV/GO_NEXT must
        // walk all three cached entries.
        let s = viewing_state(SESSION, ['p1', 'p2', 'p3']);
        // Populate the cache for all three plotIds at the current dim.
        for (const id of ['p1', 'p2', 'p3']) {
            s = reduce(s, {
                type: 'SET_SVG_CACHE_ENTRY',
                cacheKey: svg_cache_key('s', id, DIM.width, DIM.height),
                entry: entry(`<svg>${id}</svg>`, SESSION.upid),
            });
        }
        // R quits. activeSession is preserved (sessionEnded path keeps
        // it); plotIds and currentIndex are preserved by SESSION_ENDED.
        s = reduce(s, { type: 'SESSION_ENDED' });
        // currentIndex starts at the most-recently-inserted plot id (p3).
        expect(s.currentIndex).toBe(2);
        expect(pick_current_svg(s, DIM)?.svgText).toBe('<svg>p3</svg>');
        s = reduce(s, { type: 'GO_PREV' });
        expect(pick_current_svg(s, DIM)?.svgText).toBe('<svg>p2</svg>');
        s = reduce(s, { type: 'GO_PREV' });
        expect(pick_current_svg(s, DIM)?.svgText).toBe('<svg>p1</svg>');
        s = reduce(s, { type: 'GO_NEXT' });
        expect(pick_current_svg(s, DIM)?.svgText).toBe('<svg>p2</svg>');
        s = reduce(s, { type: 'GO_NEXT' });
        expect(pick_current_svg(s, DIM)?.svgText).toBe('<svg>p3</svg>');
    });

    test('regression guard: post-quit branch is reached via SET_ACTIVE_SESSION { sessionEnded: true } (v5 fix)', () => {
        // The v5 fix gated `pick_current_svg`'s tolerant lookup on
        // `state.sessionEnded`, not `state.activeSession`. Reaching
        // that state via `SET_ACTIVE_SESSION { sessionEnded: true }`
        // preserves activeSession, so a check `if (state.activeSession)`
        // would still take the live branch and reject the cache entry
        // on upid mismatch (the bug that v5 fixed).
        let s = viewing_state();
        // Populate at the current upid.
        s = reduce(s, {
            type: 'SET_SVG_CACHE_ENTRY',
            cacheKey: svg_cache_key('s', 'p1', DIM.width, DIM.height),
            entry: entry('<svg>pre-quit</svg>', SESSION.upid + 5),  // newer upid (e.g. after points())
        });
        // Drive the session-end state-update — preserves activeSession,
        // sets sessionEnded=true.
        s = reduce(s, {
            type: 'SET_ACTIVE_SESSION',
            activeSession: SESSION,
            sessionEnded: true,
        });
        // Sanity: activeSession should still be set.
        expect(s.activeSession).not.toBeNull();
        expect(s.sessionEnded).toBe(true);
        // The selector MUST take the post-quit branch and tolerate the
        // upid mismatch.
        expect(pick_current_svg(s, DIM)?.svgText).toBe('<svg>pre-quit</svg>');
    });
});

describe('bg_for_fetch', () => {
    test('returns the same value regardless of themeApplied (today)', () => {
        expect(bg_for_fetch(true)).toBe('#ffffff');
        expect(bg_for_fetch(false)).toBe('#ffffff');
    });
});
