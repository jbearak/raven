/**
 * One-time install nags for sibling extensions Raven defers to.
 *
 * Pure module — accepts the bits of VS Code state it needs as
 * parameters rather than importing `vscode`, so it's unit-testable
 * with a fake global state and a fake "is extension installed" check.
 * The `install-nag.ts` module wires the real `vscode` APIs.
 */

export enum NagKey {
    QuartoForQmd = 'raven.nag.quartoForQmd',
    RSyntaxForRmd = 'raven.nag.rSyntaxForRmd',
}

export const QUARTO_EXTENSION_ID = 'quarto.quarto';
export const R_SYNTAX_EXTENSION_ID = 'REditorSupport.r-syntax';
export const R_FULL_EXTENSION_ID = 'REditorSupport.r';

/**
 * Minimal subset of `vscode.Memento` that we depend on. `update`
 * returns a `PromiseLike` so this interface is satisfied by both
 * `Memento` (whose `update` is typed as `Thenable<void>`) and a plain
 * `Promise<void>` returned from our test fakes.
 */
export interface NagStore {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void>;
}

/**
 * Decide whether the nag for a recommended extension should appear:
 * the recommended extension must not already be installed, and the
 * user must not have previously dismissed the nag.
 */
export function shouldShowNag(
    state: NagStore,
    key: NagKey,
    isExtensionInstalled: (id: string) => boolean,
): boolean {
    if (state.get<boolean>(key) === true) return false;
    if (key === NagKey.QuartoForQmd) {
        return !isExtensionInstalled(QUARTO_EXTENSION_ID);
    }
    if (key === NagKey.RSyntaxForRmd) {
        return !(
            isExtensionInstalled(R_SYNTAX_EXTENSION_ID) ||
            isExtensionInstalled(R_FULL_EXTENSION_ID)
        );
    }
    return false;
}

export async function markNagDismissed(state: NagStore, key: NagKey): Promise<void> {
    await state.update(key, true);
}

/**
 * Map an editor's `languageId` to the nag that document should trigger,
 * or null if no nag applies. Callers fire the nag the first time a
 * matching document opens in a session.
 */
export function nagStateForLanguageId(languageId: string): NagKey | null {
    if (languageId === 'quarto') return NagKey.QuartoForQmd;
    if (languageId === 'rmd') return NagKey.RSyntaxForRmd;
    return null;
}
