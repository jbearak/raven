import type { ActiveSessionInfo } from '../messages';

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
            const phase: Phase = action.activeSession ? 'empty' : 'loading';
            return {
                ...state,
                activeSession: action.activeSession,
                sessionEnded: action.sessionEnded,
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
        case 'GO_NEXT':
            return {
                ...state,
                currentIndex: Math.min(state.plotIds.length - 1, state.currentIndex + 1),
            };
        case 'SESSION_ENDED':
            return { ...state, phase: 'disconnected', sessionEnded: true };
        case 'SET_THEME_BG':
            return { ...state, themeBg: action.themeBg };
    }
}
