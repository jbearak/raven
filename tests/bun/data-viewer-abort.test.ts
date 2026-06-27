/**
 * Abort helpers shared by the cancellable saved-sort/filter restore
 * (#519): throwIfAborted / yieldToEventLoop / isAbortError.
 */
import { describe, test, expect } from 'bun:test';
import {
    isAbortError,
    throwIfAborted,
    yieldToEventLoop,
} from '../../editors/vscode/src/data-viewer/abort';

describe('throwIfAborted', () => {
    test('no signal is a no-op', () => {
        expect(() => throwIfAborted(undefined)).not.toThrow();
    });

    test('un-aborted signal is a no-op', () => {
        const c = new AbortController();
        expect(() => throwIfAborted(c.signal)).not.toThrow();
    });

    test('aborted signal throws an AbortError DOMException', () => {
        const c = new AbortController();
        c.abort();
        let err: unknown;
        try {
            throwIfAborted(c.signal);
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(DOMException);
        expect((err as DOMException).name).toBe('AbortError');
    });
});

describe('isAbortError', () => {
    test('true for an AbortError DOMException', () => {
        expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
    });

    test('false for a plain Error', () => {
        expect(isAbortError(new Error('decode failed'))).toBe(false);
    });

    test('false for non-objects', () => {
        expect(isAbortError(undefined)).toBe(false);
        expect(isAbortError('AbortError')).toBe(false);
        expect(isAbortError(null)).toBe(false);
    });
});

describe('yieldToEventLoop', () => {
    test('defers to a later macrotask (does not resolve synchronously)', async () => {
        let resolved = false;
        const p = yieldToEventLoop().then(() => { resolved = true; });
        // The yield must not have completed during synchronous execution;
        // that macrotask boundary is what lets a queued IPC message land.
        expect(resolved).toBe(false);
        await p;
        expect(resolved).toBe(true);
    });
});
