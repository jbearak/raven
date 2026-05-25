import { describe, test, expect } from 'bun:test';
import {
    ExtensionToWebviewMessage,
    WebviewToExtensionMessage,
    isExtensionToWebviewMessage,
    isWebviewToExtensionMessage,
} from '../../editors/vscode/src/plot/messages';

describe('plot messages', () => {
    test('extension-to-webview includes state-update with themeApplied', () => {
        const msg: ExtensionToWebviewMessage = {
            type: 'state-update',
            payload: {
                activeSession: {
                    sessionId: 'abc',
                    httpgdBaseUrl: 'http://127.0.0.1:1234',
                    httpgdToken: 'tok',
                    upid: 0,
                },
                sessionEnded: false,
                themeApplied: false,
            },
        };
        expect(isExtensionToWebviewMessage(msg)).toBe(true);
    });

    test('extension-to-webview state-update accepts null activeSession', () => {
        const msg: ExtensionToWebviewMessage = {
            type: 'state-update',
            payload: { activeSession: null, sessionEnded: true, themeApplied: true },
        };
        expect(isExtensionToWebviewMessage(msg)).toBe(true);
    });

    test('extension-to-webview state-update rejects missing themeApplied', () => {
        // Drop themeApplied — must be rejected by the guard.
        const msg = {
            type: 'state-update',
            payload: { activeSession: null, sessionEnded: true },
        };
        expect(isExtensionToWebviewMessage(msg)).toBe(false);
    });

    test('extension-to-webview state-update rejects non-boolean themeApplied', () => {
        const msg = {
            type: 'state-update',
            payload: { activeSession: null, sessionEnded: true, themeApplied: 'true' },
        };
        expect(isExtensionToWebviewMessage(msg)).toBe(false);
    });

    test('extension-to-webview REJECTS theme-changed (removed in v6/v7)', () => {
        // Locks the deletion in place — a future PR reintroducing
        // `theme-changed` would have to update this test in the same
        // commit, making the wire-protocol change visible in review.
        expect(isExtensionToWebviewMessage({ type: 'theme-changed', payload: {} })).toBe(false);
    });

    test('webview-to-extension includes webview-ready', () => {
        const msg: WebviewToExtensionMessage = { type: 'webview-ready', payload: {} };
        expect(isWebviewToExtensionMessage(msg)).toBe(true);
    });

    test('webview-to-extension includes request-save-plot with format', () => {
        const msg: WebviewToExtensionMessage = {
            type: 'request-save-plot',
            payload: { plotId: 'p1', format: 'png' },
        };
        expect(isWebviewToExtensionMessage(msg)).toBe(true);
    });

    test('webview-to-extension accepts request-save-plot with svg and pdf too', () => {
        expect(isWebviewToExtensionMessage({
            type: 'request-save-plot',
            payload: { plotId: 'p1', format: 'svg' },
        })).toBe(true);
        expect(isWebviewToExtensionMessage({
            type: 'request-save-plot',
            payload: { plotId: 'p1', format: 'pdf' },
        })).toBe(true);
    });

    test('webview-to-extension rejects request-save-plot with invalid format', () => {
        // Widening the format allowlist must update this regression
        // test in the same commit.
        expect(isWebviewToExtensionMessage({
            type: 'request-save-plot',
            payload: { plotId: 'p1', format: 'jpg' },
        })).toBe(false);
        expect(isWebviewToExtensionMessage({
            type: 'request-save-plot',
            payload: { plotId: 'p1' },
        })).toBe(false);
        expect(isWebviewToExtensionMessage({
            type: 'request-save-plot',
            payload: { plotId: 'p1', format: 42 },
        })).toBe(false);
    });

    test('webview-to-extension state-update upid rejects NaN and Infinity', () => {
        // The guard uses Number.isInteger to catch values that pass
        // `typeof === 'number'` but break downstream arithmetic.
        const base = {
            type: 'state-update' as const,
            payload: {
                activeSession: {
                    sessionId: 'a',
                    httpgdBaseUrl: 'http://x',
                    httpgdToken: 't',
                    upid: NaN,
                },
                sessionEnded: false,
                themeApplied: false,
            },
        };
        expect(isExtensionToWebviewMessage(base)).toBe(false);
        base.payload.activeSession.upid = Infinity;
        expect(isExtensionToWebviewMessage(base)).toBe(false);
        base.payload.activeSession.upid = -Infinity;
        expect(isExtensionToWebviewMessage(base)).toBe(false);
    });

    test('extension-to-webview state-update upid rejects fractional and negative integers', () => {
        const base = {
            type: 'state-update' as const,
            payload: {
                activeSession: {
                    sessionId: 'a',
                    httpgdBaseUrl: 'http://x',
                    httpgdToken: 't',
                    upid: 1.5,
                },
                sessionEnded: false,
                themeApplied: false,
            },
        };
        expect(isExtensionToWebviewMessage(base)).toBe(false);
        base.payload.activeSession.upid = -1;
        expect(isExtensionToWebviewMessage(base)).toBe(false);
    });

    test('extension-to-webview state-update rejects sessionId containing a colon', () => {
        // The svgCache uses `${sessionId}:${plotId}:...` as its key
        // shape; a sessionId with a colon would collide with cross-
        // session boundaries. The guard enforces this at the wire.
        const base = {
            type: 'state-update' as const,
            payload: {
                activeSession: {
                    sessionId: 'has:colon',
                    httpgdBaseUrl: 'http://x',
                    httpgdToken: 't',
                    upid: 0,
                },
                sessionEnded: false,
                themeApplied: false,
            },
        };
        expect(isExtensionToWebviewMessage(base)).toBe(false);
    });

    test('extension-to-webview state-update rejects empty sessionId', () => {
        const base = {
            type: 'state-update' as const,
            payload: {
                activeSession: {
                    sessionId: '',
                    httpgdBaseUrl: 'http://x',
                    httpgdToken: 't',
                    upid: 0,
                },
                sessionEnded: false,
                themeApplied: false,
            },
        };
        expect(isExtensionToWebviewMessage(base)).toBe(false);
    });

    test('webview-to-extension includes request-open-externally', () => {
        const msg: WebviewToExtensionMessage = {
            type: 'request-open-externally',
            payload: { plotId: 'p1' },
        };
        expect(isWebviewToExtensionMessage(msg)).toBe(true);
    });

    test('webview-to-extension includes report-error', () => {
        const msg: WebviewToExtensionMessage = {
            type: 'report-error',
            payload: { message: 'oops' },
        };
        expect(isWebviewToExtensionMessage(msg)).toBe(true);
    });

    test('webview-to-extension includes set-theme-applied (true)', () => {
        const msg: WebviewToExtensionMessage = {
            type: 'set-theme-applied',
            payload: { applied: true },
        };
        expect(isWebviewToExtensionMessage(msg)).toBe(true);
    });

    test('webview-to-extension includes set-theme-applied (false)', () => {
        const msg: WebviewToExtensionMessage = {
            type: 'set-theme-applied',
            payload: { applied: false },
        };
        expect(isWebviewToExtensionMessage(msg)).toBe(true);
    });

    test('webview-to-extension rejects set-theme-applied with missing applied', () => {
        expect(isWebviewToExtensionMessage({
            type: 'set-theme-applied',
            payload: {},
        })).toBe(false);
    });

    test('webview-to-extension rejects set-theme-applied with non-boolean applied', () => {
        expect(isWebviewToExtensionMessage({
            type: 'set-theme-applied',
            payload: { applied: 'yes' },
        })).toBe(false);
        expect(isWebviewToExtensionMessage({
            type: 'set-theme-applied',
            payload: { applied: 1 },
        })).toBe(false);
    });

    test('rejects unknown extension-to-webview type', () => {
        expect(isExtensionToWebviewMessage({ type: 'bogus', payload: {} })).toBe(false);
    });

    test('rejects unknown webview-to-extension type', () => {
        expect(isWebviewToExtensionMessage({ type: 'bogus', payload: {} })).toBe(false);
    });

    test('rejects null', () => {
        expect(isExtensionToWebviewMessage(null)).toBe(false);
        expect(isWebviewToExtensionMessage(null)).toBe(false);
    });

    test('rejects non-object primitives', () => {
        expect(isExtensionToWebviewMessage(42)).toBe(false);
        expect(isExtensionToWebviewMessage('webview-ready')).toBe(false);
        expect(isWebviewToExtensionMessage(undefined)).toBe(false);
    });

    test('rejects objects with non-string type', () => {
        expect(isExtensionToWebviewMessage({ type: 42, payload: {} })).toBe(false);
        expect(isWebviewToExtensionMessage({ type: null, payload: {} })).toBe(false);
    });
});
