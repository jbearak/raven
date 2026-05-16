import { describe, test, expect } from 'bun:test';
import {
    NagKey,
    shouldShowNag,
    markNagDismissed,
    nagStateForLanguageId,
} from '../../editors/vscode/src/recommendations/nag-state';

class FakeGlobalState {
    private readonly store = new Map<string, unknown>();
    get<T>(key: string): T | undefined { return this.store.get(key) as T | undefined; }
    async update(key: string, value: unknown): Promise<void> { this.store.set(key, value); }
}

interface FakeExtensions {
    has(id: string): boolean;
}

function fakeExtensions(installed: string[]): FakeExtensions {
    return { has: (id) => installed.includes(id) };
}

describe('shouldShowNag', () => {
    test('returns true when nothing dismissed and extension not installed', () => {
        const state = new FakeGlobalState();
        expect(shouldShowNag(state, NagKey.QuartoForQmd, fakeExtensions([]).has)).toBe(true);
    });

    test('returns false when the nag has been dismissed', async () => {
        const state = new FakeGlobalState();
        await markNagDismissed(state, NagKey.QuartoForQmd);
        expect(shouldShowNag(state, NagKey.QuartoForQmd, fakeExtensions([]).has)).toBe(false);
    });

    test('returns false when the recommended extension is already installed', () => {
        const state = new FakeGlobalState();
        expect(
            shouldShowNag(state, NagKey.QuartoForQmd, fakeExtensions(['quarto.quarto']).has),
        ).toBe(false);
    });

    test('rmd nag suppressed when either r-syntax or r is installed', () => {
        const state = new FakeGlobalState();
        expect(
            shouldShowNag(state, NagKey.RSyntaxForRmd, fakeExtensions(['REditorSupport.r-syntax']).has),
        ).toBe(false);
        expect(
            shouldShowNag(state, NagKey.RSyntaxForRmd, fakeExtensions(['REditorSupport.r']).has),
        ).toBe(false);
    });
});

describe('nagStateForLanguageId', () => {
    test('returns Quarto nag for .qmd', () => {
        expect(nagStateForLanguageId('quarto')).toBe(NagKey.QuartoForQmd);
    });

    test('returns r-syntax nag for .Rmd', () => {
        expect(nagStateForLanguageId('rmd')).toBe(NagKey.RSyntaxForRmd);
    });

    test('returns null for other languages', () => {
        expect(nagStateForLanguageId('r')).toBeNull();
        expect(nagStateForLanguageId('typescript')).toBeNull();
    });
});
