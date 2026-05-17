import * as path from 'path';
import * as vscode from 'vscode';

// Set of language IDs and file extensions that Raven's language server
// processes. `.Rmd` / `.qmd` are intentionally absent: those files use the
// dedicated `rmd` / `quarto` language IDs and the LSP's document selector
// is `r` only, so sending activity or watching their file events would be
// noise. The chunk feature (which spans `.Rmd` / `.qmd`) has its own
// language-aware wiring in `chunks/`.
const R_DOCUMENT_LANGUAGE_IDS = new Set(['r', 'jags', 'stan']);
const R_DOCUMENT_EXTENSIONS = new Set([
    '.r',
    '.jags',
    '.bugs',
    '.stan',
]);

type LanguageConfigurationInspection = {
    globalValue?: unknown;
    workspaceValue?: unknown;
    workspaceFolderValue?: unknown;
};

export function isRDocument(
    document: Pick<vscode.TextDocument, 'isUntitled' | 'languageId' | 'uri'>,
): boolean {
    if (document.isUntitled) {
        return R_DOCUMENT_LANGUAGE_IDS.has(document.languageId);
    }

    return R_DOCUMENT_EXTENSIONS.has(path.extname(document.uri.fsPath).toLowerCase());
}

/**
 * Resolve the effective `editor.tabSize` for a document. The scope MUST
 * include `languageId` so VS Code returns language-scoped overrides (e.g.
 * `[r] { "editor.tabSize": 2 }`) instead of only the resource-scoped value.
 *
 * The optional `getCfg` parameter exists for unit testing; callers should
 * omit it and let the default use `vscode.workspace.getConfiguration`.
 */
export function resolveTabSizeForDocument(
    document: Pick<vscode.TextDocument, 'uri' | 'languageId'>,
    getCfg: (scope: vscode.ConfigurationScope) => vscode.WorkspaceConfiguration = (scope) =>
        vscode.workspace.getConfiguration('editor', scope),
    visibleTextEditors: readonly vscode.TextEditor[] = vscode.window.visibleTextEditors,
): number {
    const editor = visibleTextEditors.find((candidate) =>
        candidate.document.uri.toString() === document.uri.toString()
    );
    if (typeof editor?.options.tabSize === 'number') {
        return editor.options.tabSize;
    }

    return getCfg({ uri: document.uri, languageId: document.languageId })
        .get<number>('tabSize', 2);
}

export function getUpdatedGlobalLanguageConfig(
    inspection: LanguageConfigurationInspection | undefined,
    wordSeparators: string,
): Record<string, unknown> | null {
    const globalValue: Record<string, unknown> =
        typeof inspection?.globalValue === 'object' && inspection.globalValue !== null
            ? inspection.globalValue as Record<string, unknown>
            : {};

    if (globalValue['editor.wordSeparators'] === wordSeparators) {
        return null;
    }

    return {
        ...globalValue,
        'editor.wordSeparators': wordSeparators,
    };
}
