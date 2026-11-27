import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';

/**
 * User keybindings that make Raven's shortcuts win over vscode-R's.
 *
 * Raven and vscode-R bind the same keys in R and R Markdown files. When two
 * extensions bind one key, VS Code runs the one registered last, and it
 * registers installed extensions in order of their folder names
 * (`extensionCmp` in VS Code's `extensionDescriptionRegistry.ts`), so
 * `reditorsupport.r-*` beats `jbearak.raven-r-*` and Raven's command never
 * runs. Neither extension's manifest can change that; only user keybindings
 * rank above both.
 *
 * The entries copy Raven's own contributed bindings for the commands below
 * and narrow them to `r` and `rmd` documents, where vscode-R binds the same
 * keys. They never apply in Quarto documents, so the Quarto extension keeps
 * its own shortcuts there. The extension host can run on a remote machine
 * whose OS differs from the UI's, so each binding is written twice, guarded
 * by `isMac` and `!isMac`, rather than for the host's platform. Pure, so
 * it's tested without VS Code.
 */

/** Raven commands whose default keys vscode-R also binds in `r` / `rmd` files. */
export const COMMANDS_VSCODE_R_SHADOWS = [
    'raven.runLineOrSelection',
    'raven.sourceFile',
    'raven.knit',
    'raven.runPreviousChunk',
] as const;

/** A `contributes.keybindings` entry from a package.json. */
export type ContributedKeybinding = { command: string; key: string; mac?: string; when?: string };

/** An entry in the user's keybindings.json. */
export type UserKeybinding = { key: string; command: string; when: string };

const R_OR_RMD = '(editorLangId == r || editorLangId == rmd)';

/** The user keybindings for `COMMANDS_VSCODE_R_SHADOWS`, from Raven's contributed ones. */
export function raven_user_keybindings(contributed: readonly ContributedKeybinding[]): UserKeybinding[] {
    const entries: UserKeybinding[] = [];
    for (const binding of contributed) {
        if (!(COMMANDS_VSCODE_R_SHADOWS as readonly string[]).includes(binding.command)) continue;
        const when = binding.when ? `(${binding.when}) && ${R_OR_RMD}` : R_OR_RMD;
        entries.push({ key: binding.mac ?? binding.key, command: binding.command, when: `isMac && ${when}` });
        entries.push({ key: binding.key, command: binding.command, when: `!isMac && ${when}` });
    }
    return entries;
}

/**
 * `text` (a keybindings.json, comments allowed) with `entries` appended,
 * skipping entries it already has, and how many were added. `text` comes
 * back unchanged when nothing is missing; `null` means it isn't a JSON array.
 */
export function with_user_keybindings(
    text: string,
    entries: readonly UserKeybinding[],
): { text: string; added: number } | null {
    let result = text.trim() === '' ? '[]' : text;
    const errors: ParseError[] = [];
    const existing: unknown = parse(result, errors, { allowTrailingComma: true });
    if (errors.length > 0 || !Array.isArray(existing)) return null;
    const has = (entry: UserKeybinding) => existing.some((item) =>
        typeof item === 'object' && item !== null
        && (item as Partial<UserKeybinding>).key === entry.key
        && (item as Partial<UserKeybinding>).command === entry.command
        && (item as Partial<UserKeybinding>).when === entry.when);
    const missing = entries.filter((entry) => !has(entry));
    if (missing.length === 0) return { text, added: 0 };
    const eol = result.includes('\r\n') ? '\r\n' : '\n';
    for (const entry of missing) {
        result = applyEdits(result, modify(result, [-1], entry, {
            isArrayInsertion: true,
            formattingOptions: { insertSpaces: true, tabSize: 4, eol },
        }));
    }
    return { text: result, added: missing.length };
}
