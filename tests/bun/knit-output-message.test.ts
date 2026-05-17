import { describe, test, expect } from 'bun:test';
import { isKnitOutputMessage } from '../../editors/vscode/src/knit/knit-output';

describe('isKnitOutputMessage', () => {
    test('accepts {type: "refresh"}', () => {
        expect(isKnitOutputMessage({ type: 'refresh' })).toBe(true);
    });

    test('accepts {type: "openInBrowser"}', () => {
        expect(isKnitOutputMessage({ type: 'openInBrowser' })).toBe(true);
    });

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
