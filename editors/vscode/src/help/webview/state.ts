import type { LoadPayload, ErrorPayload } from '../messages';

export type Phase = 'idle' | 'loading' | 'viewing' | 'error';

export type ViewerState = {
    phase: Phase;
    current: LoadPayload | null;
    lastError: ErrorPayload | null;
    canBack: boolean;
    canForward: boolean;
};

export type ViewerAction =
    | { type: 'LOAD'; payload: LoadPayload }
    | { type: 'LOADING' }
    | { type: 'ERROR'; payload: ErrorPayload }
    | { type: 'HISTORY_STATE'; canBack: boolean; canForward: boolean };

export function initial_state(): ViewerState {
    return {
        phase: 'idle',
        current: null,
        lastError: null,
        canBack: false,
        canForward: false,
    };
}

export function reduce(state: ViewerState, action: ViewerAction): ViewerState {
    switch (action.type) {
        case 'LOAD':
            return {
                ...state,
                phase: 'viewing',
                current: action.payload,
                lastError: null,
            };
        case 'LOADING':
            return {
                ...state,
                phase: 'loading',
                lastError: null,
            };
        case 'ERROR':
            return {
                ...state,
                phase: 'error',
                lastError: action.payload,
            };
        case 'HISTORY_STATE':
            return {
                ...state,
                canBack: action.canBack,
                canForward: action.canForward,
            };
    }
}
