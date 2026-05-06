import { describe, test, expect } from 'bun:test';
import {
    ExtensionToWebviewMessage,
    WebviewToExtensionMessage,
    isExtensionToWebviewMessage,
    isWebviewToExtensionMessage,
} from '../../editors/vscode/src/plot/messages';

describe('plot messages', () => {
    test('extension-to-webview includes state-update', () => {
        const msg: ExtensionToWebviewMessage = {
            type: 'state-update',
            payload: {
                activeSession: {
                    sessionId: 'abc',
                    httpgdBaseUrl: 'http://127.0.0.1:1234',
                    httpgdToken: 'tok',
                },
                sessionEnded: false,
            },
        };
        expect(isExtensionToWebviewMessage(msg)).toBe(true);
    });

    test('extension-to-webview includes theme-changed', () => {
        const msg: ExtensionToWebviewMessage = { type: 'theme-changed', payload: {} };
        expect(isExtensionToWebviewMessage(msg)).toBe(true);
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
