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
