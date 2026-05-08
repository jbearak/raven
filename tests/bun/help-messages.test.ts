import { describe, test, expect } from 'bun:test';
import {
    ExtensionToWebviewMessage,
    WebviewToExtensionMessage,
    isExtensionToWebviewMessage,
    isWebviewToExtensionMessage,
} from '../../editors/vscode/src/help/messages';

describe('help messages', () => {
    test('ext->webview load message', () => {
        const msg: ExtensionToWebviewMessage = {
            type: 'load',
            payload: {
                topic: 'filter',
                package: 'dplyr',
                title: 'Subset rows',
                html: '<p>x</p>',
                anchor: null,
                scrollY: 0,
            },
        };
        expect(isExtensionToWebviewMessage(msg)).toBe(true);
    });

    test('ext->webview load message rejects missing scrollY', () => {
        // Validator should reject pre-scroll-restoration payloads to keep
        // the wire-protocol contract honest.
        expect(
            isExtensionToWebviewMessage({
                type: 'load',
                payload: {
                    topic: 'filter',
                    package: 'dplyr',
                    title: 'Subset rows',
                    html: '<p>x</p>',
                    anchor: null,
                    // scrollY missing
                },
            }),
        ).toBe(false);
    });

    test('ext->webview loading and error', () => {
        expect(
            isExtensionToWebviewMessage({ type: 'loading', payload: {} }),
        ).toBe(true);
        expect(
            isExtensionToWebviewMessage({
                type: 'error',
                payload: { reason: 'not-found', message: 'no help' },
            }),
        ).toBe(true);
    });

    test('webview->ext navigate', () => {
        const msg: WebviewToExtensionMessage = {
            type: 'navigate',
            payload: { topic: '[', package: 'base', anchor: null },
        };
        expect(isWebviewToExtensionMessage(msg)).toBe(true);
    });

    test('webview->ext open-external, report-error, scroll, ready', () => {
        expect(
            isWebviewToExtensionMessage({
                type: 'open-external',
                payload: { url: 'https://example.com' },
            }),
        ).toBe(true);
        expect(
            isWebviewToExtensionMessage({
                type: 'report-error',
                payload: { message: 'x' },
            }),
        ).toBe(true);
        expect(
            isWebviewToExtensionMessage({
                type: 'scroll',
                payload: { y: 42 },
            }),
        ).toBe(true);
        expect(
            isWebviewToExtensionMessage({
                type: 'webview-ready',
                payload: {},
            }),
        ).toBe(true);
    });

    test('rejects malformed', () => {
        expect(isExtensionToWebviewMessage({ type: 'unknown' })).toBe(false);
        expect(isWebviewToExtensionMessage({ type: 'navigate' })).toBe(false);
    });
});
