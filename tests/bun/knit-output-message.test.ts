import { describe, test, expect } from 'bun:test';
import { isKnitOutputMessage } from '../../editors/vscode/src/knit/knit-output';

describe('isKnitOutputMessage', () => {
    test('accepts {type: "refresh"}', () => {
        expect(isKnitOutputMessage({ type: 'refresh' })).toBe(true);
    });

    test('accepts {type: "openInBrowser"}', () => {
        expect(isKnitOutputMessage({ type: 'openInBrowser' })).toBe(true);
    });

    // Keyboard shortcuts that the iframe captures (Cmd+J to toggle
    // the panel, Cmd+= / Cmd+- to zoom, etc.) are re-dispatched on
    // the outer shell document as synthetic KeyboardEvents — VS
    // Code's keybinding handler matches them the same way as native
    // editor keystrokes. No extension-side message is needed; the
    // round-trip is entirely inside the webview. See
    // knit-output-shell.test.ts for the structural assertions.

    // Image copy is handled in-iframe via the async Clipboard API
    // (ClipboardItem with image/* MIME) — no extension-side message
    // round-trip is needed. The Copy image button lives in the
    // existing context menu (asserted in knit-output-shell.test.ts).

    test('rejects unknown type', () => {
        expect(isKnitOutputMessage({ type: 'evil' })).toBe(false);
    });

    test('rejects null', () => {
        expect(isKnitOutputMessage(null)).toBe(false);
    });

    test('rejects undefined', () => {
        expect(isKnitOutputMessage(undefined)).toBe(false);
    });

    test('rejects primitives', () => {
        expect(isKnitOutputMessage('refresh')).toBe(false);
        expect(isKnitOutputMessage(42)).toBe(false);
    });

    test('rejects empty object', () => {
        expect(isKnitOutputMessage({})).toBe(false);
    });

    test('rejects object missing the type key', () => {
        expect(isKnitOutputMessage({ kind: 'refresh' })).toBe(false);
    });
});
