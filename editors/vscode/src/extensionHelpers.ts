import * as path from 'path';
import * as vscode from 'vscode';

const R_DOCUMENT_LANGUAGE_IDS = new Set(['r', 'jags', 'stan']);
const R_DOCUMENT_EXTENSIONS = new Set([
    '.r',
    '.rmd',
    '.qmd',
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
