import { describe, test, expect } from 'bun:test';
import { initial_state, reduce } from '../../editors/vscode/src/plot/webview/state';

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
            activeSession: { sessionId: 's', httpgdBaseUrl: 'http://x', httpgdToken: 't' },
            sessionEnded: false,
        });
        expect(s.phase).toBe('empty');
        expect(s.activeSession?.sessionId).toBe('s');
        expect(s.sessionEnded).toBe(false);
    });

    test('SET_PLOT_IDS with new plots transitions to viewing', () => {
        let s = reduce(initial_state(), {
            type: 'SET_ACTIVE_SESSION',
            activeSession: { sessionId: 's', httpgdBaseUrl: 'http://x', httpgdToken: 't' },
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
            activeSession: { sessionId: 's', httpgdBaseUrl: 'http://x', httpgdToken: 't' },
            sessionEnded: false,
        });
        s = reduce(s, { type: 'SET_PLOT_IDS', plotIds: [] });
        expect(s.phase).toBe('empty');
    });

    test('GO_PREV decrements currentIndex but not below 0', () => {
        let s = reduce(initial_state(), {
            type: 'SET_ACTIVE_SESSION',
            activeSession: { sessionId: 's', httpgdBaseUrl: 'http://x', httpgdToken: 't' },
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
            activeSession: { sessionId: 's', httpgdBaseUrl: 'http://x', httpgdToken: 't' },
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
            activeSession: { sessionId: 's', httpgdBaseUrl: 'http://x', httpgdToken: 't' },
            sessionEnded: false,
        });
        s = reduce(s, { type: 'SET_PLOT_IDS', plotIds: ['p1'] });
        s = reduce(s, { type: 'SESSION_ENDED' });
        expect(s.phase).toBe('disconnected');
        expect(s.sessionEnded).toBe(true);
        expect(s.plotIds).toEqual(['p1']);
    });

    test('SET_THEME_BG records the bg', () => {
        const s = reduce(initial_state(), {
            type: 'SET_THEME_BG',
            themeBg: '#1e1e1e',
        });
        expect(s.themeBg).toBe('#1e1e1e');
    });
});
