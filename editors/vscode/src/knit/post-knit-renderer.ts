/**
 * Live VS Code wiring for the post-knit HTML render step.
 *
 * `renderKnitHtml` in `render-html.ts` is pure-ish: it accepts callable
 * dependencies (`renderMarkdown`, `fetchRSemanticTokens`,
 * `registry`). This module wires those callables to the real VS Code
 * + LSP surfaces so the production knit flow can produce a final
 * `<basename>.html` from the intermediate `<basename>.md` knitr just
 * wrote.
 *
 * Flow:
 *
 *   1. Read the `.md` from disk.
 *   2. Force-activate `vscode.markdown-language-features` and
 *      `vscode.markdown-math` (their activation events are markdown-
 *      file-opening, which doesn't fire from a programmatic render).
 *   3. Build a `GrammarRegistry` from `vscode.extensions.all`.
 *   4. Read the KaTeX CSS from `vscode.markdown-math`'s contributed
 *      `markdown.previewStyles` paths and concatenate.
 *   5. Wire `renderMarkdown` to `vscode.commands.executeCommand(
 *      'markdown.api.render', source)`.
 *   6. Wire `fetchRSemanticTokens` to the LSP custom request
 *      `raven/semanticTokensForRString`.
 *   7. Call `renderKnitHtml` and write the result to `htmlPath`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { createGrammarRegistry } from './grammar-registry';
import { renderKnitHtml } from './render-html';

/**
 * Public entry point for stage 4c — call this from `renderOutcome`
 * after a successful knit. Throws on read / write / render errors so
 * the caller can surface a single error toast and fall back to
 * revealing the `.md` directly.
 */
export async function runPostKnitRender(args: {
    mdPath: string;
    htmlPath: string;
    context: vscode.ExtensionContext;
    /**
     * The live language client. When absent (extension still
     * activating, LSP not yet ready) we fall back to grammar-only
     * highlighting — the R function-name overlay is a nice-to-have,
     * not a hard requirement for a readable output.
     */
    client: LanguageClient | undefined;
    /**
     * Optional body-class string from the in-VS-Code panel. The
     * standalone `.html` written for "Open in Browser" passes null so
     * both palettes ship via `prefers-color-scheme` media queries.
     */
    themeClasses?: string | null;
}): Promise<void> {
    const { mdPath, htmlPath, context, client, themeClasses } = args;

    const markdownSource = await fs.promises.readFile(mdPath, 'utf-8');

    await activateMarkdownPipelineExtensions();
    const onigWasmPath = resolveOnigWasmPath(context);
    const registry = createGrammarRegistry({
        extensions: vscode.extensions.all,
        getExtensionById: (id) => vscode.extensions.getExtension(id),
        onigWasmPath,
    });

    const katexCss = await readKatexCss();
    const renderMarkdown = async (src: string): Promise<string> => {
        // markdown.api.render accepts either a TextDocument or a
        // string. We pass the string form which is the stable path
        // (see microsoft/vscode#80338 for the TextDocument-first-call
        // quirk).
        const html = await vscode.commands.executeCommand<string>(
            'markdown.api.render',
            src,
        );
        if (typeof html !== 'string') {
            throw new Error('markdown.api.render returned a non-string value');
        }
        return html;
    };

    const fetchRSemanticTokens = client
        ? async (text: string): Promise<ArrayLike<number>> => {
            // `raven/semanticTokensForRString` returns
            // `tower_lsp::lsp_types::SemanticTokens` which serializes
            // to `{ data: number[], resultId?: string }`. We only
            // care about `data`.
            const response = await client.sendRequest<{ data: number[] }>(
                'raven/semanticTokensForRString',
                { text },
            );
            return response?.data ?? [];
        }
        : undefined;

    const finalHtml = await renderKnitHtml({
        markdownSource,
        renderMarkdown,
        registry,
        fetchRSemanticTokens,
        katexCss,
        themeClasses: themeClasses ?? null,
    });

    await fs.promises.writeFile(htmlPath, finalHtml, 'utf-8');
}

/**
 * The built-in `markdown.api.render` command lives in
 * `vscode.markdown-language-features` and only gets registered when
 * the extension activates. Activation events for it include opening a
 * markdown file, which doesn't necessarily fire when our render path
 * runs programmatically. The `vscode.markdown-math` extension is the
 * KaTeX provider; its activation contributes the math plugin to the
 * pipeline.
 *
 * Both are built-ins, so `getExtension` should always return a
 * value. We tolerate missing extensions defensively in case a future
 * VS Code build renames or splits them.
 */
async function activateMarkdownPipelineExtensions(): Promise<void> {
    const ids = ['vscode.markdown-language-features', 'vscode.markdown-math'];
    await Promise.all(ids.map(async (id) => {
        const ext = vscode.extensions.getExtension(id);
        if (!ext) return;
        if (!ext.isActive) {
            try {
                await ext.activate();
            } catch (err) {
                console.error(
                    `[raven-knit] failed to activate ${id}: ` +
                        (err instanceof Error ? err.message : String(err)),
                );
            }
        }
    }));
}

/**
 * Read the KaTeX CSS shipped by `vscode.markdown-math`. The extension
 * contributes the CSS via `contributes.markdown.previewStyles` —
 * relative paths inside the extension. We concatenate every entry so
 * the final HTML carries everything the preview surface ordinarily
 * loads.
 *
 * Returns an empty string when the extension is missing or has no
 * styles. In that case math renders unstyled (KaTeX's HTML is still
 * present, just without the spacing / font rules).
 */
export async function readKatexCss(): Promise<string> {
    const mathExt = vscode.extensions.getExtension('vscode.markdown-math');
    if (!mathExt) return '';
    const pkg = mathExt.packageJSON as unknown;
    if (!pkg || typeof pkg !== 'object') return '';
    const contributes = (pkg as { contributes?: unknown }).contributes;
    if (!contributes || typeof contributes !== 'object') return '';
    // VS Code's markdown contribution point uses flat keys with
    // literal dots — `"markdown.previewStyles"`, not nested
    // `markdown: { previewStyles }`. We accept either shape to be
    // forward-compatible with a future restructure.
    const contribObj = contributes as Record<string, unknown>;
    let styles: unknown =
        contribObj['markdown.previewStyles']
        ?? (
            (contribObj['markdown'] as { previewStyles?: unknown } | undefined)
            ?.previewStyles
        );
    if (!Array.isArray(styles)) return '';

    const parts: string[] = [];
    for (const entry of styles) {
        if (typeof entry !== 'string') continue;
        const absolute = path.isAbsolute(entry)
            ? entry
            : path.join(mathExt.extensionPath, entry);
        try {
            const css = await fs.promises.readFile(absolute, 'utf-8');
            parts.push(`/* ${path.basename(absolute)} */\n${css}`);
        } catch (err) {
            console.error(
                `[raven-knit] failed to read KaTeX CSS at ${absolute}: ` +
                    (err instanceof Error ? err.message : String(err)),
            );
        }
    }
    return parts.join('\n');
}

/**
 * Resolve the bundled `onig.wasm` path. The build script copies it to
 * `dist/onig.wasm` next to the extension bundle; we resolve relative
 * to `context.extensionUri.fsPath` so the path is correct in both
 * local dev and packaged VSIX installs.
 */
function resolveOnigWasmPath(context: vscode.ExtensionContext): string {
    return vscode.Uri.joinPath(context.extensionUri, 'dist', 'onig.wasm').fsPath;
}
