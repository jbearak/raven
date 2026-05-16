import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Programmatic registration of R-language snippets (loaded from
 * `snippets/r.json`) for `rmd` and `quarto` language IDs.
 *
 * `package.json` can't conditionally register snippet contributions, so to
 * keep these snippets out of the way when R-console is disabled (i.e. when
 * REditorSupport or Positron is handling R), the caller invokes this only
 * inside the gated branch in `activate()`. See `docs/coexistence.md`.
 *
 * The `.R` language ID itself is registered statically in `package.json`;
 * R-only files always get these snippets regardless of activation, because
 * `r.json` doesn't overlap with REditorSupport's `.R` snippet contributions
 * the same way it does inside fenced R chunks.
 */
export function registerRSnippetCompletionsForRmdAndQuarto(
    context: vscode.ExtensionContext,
): void {
    const items = loadRSnippetCompletionItems(context.extensionPath);
    if (items.length === 0) return;

    const provider: vscode.CompletionItemProvider = {
        provideCompletionItems: () => items,
    };

    for (const language of ['rmd', 'quarto']) {
        context.subscriptions.push(
            vscode.languages.registerCompletionItemProvider(
                { language },
                provider,
            ),
        );
    }
}

interface RawSnippet {
    prefix: string | string[];
    body: string | string[];
    description?: string;
}

function loadRSnippetCompletionItems(extensionPath: string): vscode.CompletionItem[] {
    const file = path.join(extensionPath, 'snippets', 'r.json');
    let raw: string;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        console.error(`raven: failed to read ${file}:`, err);
        return [];
    }

    let parsed: Record<string, RawSnippet>;
    try {
        parsed = JSON.parse(raw) as Record<string, RawSnippet>;
    } catch (err) {
        console.error(`raven: failed to parse ${file}:`, err);
        return [];
    }

    const items: vscode.CompletionItem[] = [];
    for (const snippet of Object.values(parsed)) {
        const prefixes = Array.isArray(snippet.prefix)
            ? snippet.prefix
            : [snippet.prefix];
        const body = Array.isArray(snippet.body)
            ? snippet.body.join('\n')
            : snippet.body;
        const description = snippet.description ?? '';
        for (const prefix of prefixes) {
            items.push(buildCompletionItem(prefix, body, description));
        }
    }
    return items;
}

function buildCompletionItem(
    prefix: string,
    body: string,
    description: string,
): vscode.CompletionItem {
    const item = new vscode.CompletionItem(prefix, vscode.CompletionItemKind.Snippet);
    item.insertText = new vscode.SnippetString(body);
    item.detail = description;
    item.documentation = new vscode.MarkdownString().appendCodeblock(body, 'r');
    return item;
}
