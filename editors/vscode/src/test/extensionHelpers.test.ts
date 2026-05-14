import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    getUpdatedGlobalLanguageConfig,
    isRDocument,
} from '../extensionHelpers';

suite('Extension Helpers', () => {
    test('isRDocument accepts untitled R-like documents by language id', () => {
        const makeUntitledDocument = (
            languageId: string,
        ): Pick<vscode.TextDocument, 'isUntitled' | 'languageId' | 'uri'> => ({
            isUntitled: true,
            languageId,
            uri: vscode.Uri.parse(`untitled:${languageId}`),
        });

        assert.strictEqual(isRDocument(makeUntitledDocument('r')), true);
        assert.strictEqual(isRDocument(makeUntitledDocument('jags')), true);
        assert.strictEqual(isRDocument(makeUntitledDocument('stan')), true);
        // R Markdown and Quarto are tracked under their own language IDs but
        // the LSP server does not parse them, so they intentionally do NOT
        // count as "R documents" for activity-tracking / path-completion-
        // trigger purposes.
        assert.strictEqual(isRDocument(makeUntitledDocument('rmd')), false);
        assert.strictEqual(isRDocument(makeUntitledDocument('quarto')), false);
        assert.strictEqual(isRDocument(makeUntitledDocument('plaintext')), false);
    });

    test('isRDocument accepts supported file-backed extensions', () => {
        const makeFileDocument = (
            filePath: string,
        ): Pick<vscode.TextDocument, 'isUntitled' | 'languageId' | 'uri'> => ({
            isUntitled: false,
            languageId: 'plaintext',
            uri: vscode.Uri.file(filePath),
        });

        assert.strictEqual(isRDocument(makeFileDocument('/tmp/script.R')), true);
        assert.strictEqual(isRDocument(makeFileDocument('/tmp/model.BUGS')), true);
        assert.strictEqual(isRDocument(makeFileDocument('/tmp/model.StAn')), true);
        // `.Rmd` and `.qmd` register under the dedicated `rmd` / `quarto`
        // languages and are not LSP-tracked.
        assert.strictEqual(isRDocument(makeFileDocument('/tmp/report.Rmd')), false);
        assert.strictEqual(isRDocument(makeFileDocument('/tmp/report.qmd')), false);
        assert.strictEqual(isRDocument(makeFileDocument('/tmp/notes.txt')), false);
    });

    test('getUpdatedGlobalLanguageConfig creates a global override when missing', () => {
        assert.deepStrictEqual(
            getUpdatedGlobalLanguageConfig(undefined, 'abc'),
            { 'editor.wordSeparators': 'abc' },
        );
    });

    test('getUpdatedGlobalLanguageConfig preserves unrelated global keys', () => {
        assert.deepStrictEqual(
            getUpdatedGlobalLanguageConfig(
                {
                    globalValue: {
                        'editor.tabSize': 2,
                    },
                },
                'abc',
            ),
            {
                'editor.tabSize': 2,
                'editor.wordSeparators': 'abc',
            },
        );
    });

    test('getUpdatedGlobalLanguageConfig returns null when already correct globally', () => {
        assert.strictEqual(
            getUpdatedGlobalLanguageConfig(
                {
                    globalValue: {
                        'editor.wordSeparators': 'abc',
                    },
                },
                'abc',
            ),
            null,
        );
    });

    test('getUpdatedGlobalLanguageConfig ignores workspace-only overrides', () => {
        assert.deepStrictEqual(
            getUpdatedGlobalLanguageConfig(
                {
                    globalValue: undefined,
                    workspaceValue: {
                        'editor.tabSize': 8,
                        'editor.wordSeparators': 'workspace-only',
                    },
                    workspaceFolderValue: {
                        'editor.insertSpaces': false,
                    },
                },
                'abc',
            ),
            { 'editor.wordSeparators': 'abc' },
        );
    });
});
