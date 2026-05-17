import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    getUpdatedGlobalLanguageConfig,
    isRDocument,
    resolveTabSizeForDocument,
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

    test('resolveTabSizeForDocument passes language-scoped configuration scope', () => {
        // The scope passed to getConfiguration must include `languageId` so
        // VS Code resolves [r]-scoped overrides like `[r] { "editor.tabSize": 2 }`.
        // A bare vscode.Uri scope only reads resource-scoped configuration and
        // misses language-specific overrides.
        const doc = {
            uri: vscode.Uri.file('/proj/foo.R'),
            languageId: 'r',
        };

        let capturedScope: vscode.ConfigurationScope | undefined;
        resolveTabSizeForDocument(doc, (scope) => {
            capturedScope = scope;
            return {
                get<T>(_key: string, defaultValue: T): T { return defaultValue; },
                has: () => false,
                inspect: () => undefined,
                update: () => Promise.resolve(),
            } as unknown as vscode.WorkspaceConfiguration;
        });

        assert.ok(
            capturedScope !== undefined &&
            typeof capturedScope === 'object' &&
            !(capturedScope instanceof vscode.Uri) &&
            'languageId' in capturedScope,
            `getConfiguration scope must include languageId for language-scoped settings; got: ${JSON.stringify(capturedScope)}`,
        );
        assert.strictEqual(
            (capturedScope as { languageId: string }).languageId,
            'r',
            'languageId in scope must match the document language',
        );
    });

    test('resolveTabSizeForDocument returns tab size from configuration', () => {
        const doc = { uri: vscode.Uri.file('/proj/foo.R'), languageId: 'r' };
        const tabSize = resolveTabSizeForDocument(doc, () => ({
            get<T>(key: string, defaultValue: T): T {
                if (key === 'tabSize') return 4 as unknown as T;
                return defaultValue;
            },
            has: () => true,
            inspect: () => undefined,
            update: () => Promise.resolve(),
        } as unknown as vscode.WorkspaceConfiguration));
        assert.strictEqual(tabSize, 4);
    });

    test('resolveTabSizeForDocument prefers resolved visible editor tab size', () => {
        const doc = { uri: vscode.Uri.file('/proj/foo.R'), languageId: 'r' };
        const tabSize = resolveTabSizeForDocument(
            doc,
            () => ({
                get<T>(_key: string, defaultValue: T): T { return defaultValue; },
                has: () => true,
                inspect: () => undefined,
                update: () => Promise.resolve(),
            } as unknown as vscode.WorkspaceConfiguration),
            [
                {
                    document: doc,
                    options: { tabSize: 4 },
                } as unknown as vscode.TextEditor,
            ],
        );
        assert.strictEqual(tabSize, 4);
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
