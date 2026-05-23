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

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { createGrammarRegistry, type GrammarRegistry } from './grammar-registry';
import { renderKnitHtml } from './render-html';

/**
 * Process-wide grammar registry cache.
 *
 * `vscode-oniguruma`'s WASM regex engine is a heavy initialisation
 * cost (~5-10 ms by itself, plus per-grammar loads on top). The
 * registry is functionally pure — it depends only on the currently-
 * installed extensions' grammar contributions — so caching across
 * knits is safe.
 *
 * Invalidation: `vscode.extensions.onDidChange` fires when an
 * extension is installed, uninstalled, enabled, or disabled. We drop
 * the cached registry on that signal so a user who installs (say)
 * REditorSupport.r-syntax mid-session gets the new grammar on their
 * next knit without restarting VS Code.
 */
let cachedRegistry: GrammarRegistry | null = null;
let extensionsChangeListener: vscode.Disposable | null = null;

function getOrCreateRegistry(context: vscode.ExtensionContext): GrammarRegistry {
    if (extensionsChangeListener === null) {
        extensionsChangeListener = vscode.extensions.onDidChange(() => {
            cachedRegistry = null;
        });
        // The disposable's owner is the extension's lifetime — if
        // anyone calls `runPostKnitRender` they're inside the
        // extension activation, so subscribing the disposable here
        // is safe.
        context.subscriptions.push(extensionsChangeListener);
    }
    if (cachedRegistry !== null) return cachedRegistry;
    const onigWasmPath = resolveOnigWasmPath(context);
    cachedRegistry = createGrammarRegistry({
        extensions: vscode.extensions.all,
        getExtensionById: (id) => vscode.extensions.getExtension(id),
        onigWasmPath,
    });
    return cachedRegistry;
}

/** Visible only for tests — drop the cached registry on demand. */
export function __resetRegistryCacheForTesting(): void {
    cachedRegistry = null;
    extensionsChangeListener?.dispose();
    extensionsChangeListener = null;
}

/**
 * Public access to the cached `GrammarRegistry`. The Knit Output panel
 * uses this to probe the active VS Code theme via
 * `vscode-theme-palette.ts` — the same registry the post-knit
 * renderer uses, so we reuse its loaded grammars and the cost-amortized
 * onig WASM load.
 *
 * Safe to call concurrently with `runPostKnitRender`: the registry's
 * theme-aware path (`extractWithTheme`) is serialized internally, and
 * the highlighter path (`tokenizeLineForLanguage`) is not affected by
 * theme state.
 */
export function getKnitGrammarRegistry(context: vscode.ExtensionContext): GrammarRegistry {
    return getOrCreateRegistry(context);
}

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
    const registry = getOrCreateRegistry(context);

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

    await writeFileAtomic(htmlPath, finalHtml);
}

/**
 * Write `content` to `destPath` atomically.
 *
 * Two failure modes the naïve `writeFile` exposes:
 *   1. Partial write — if the process dies (or the disk fills) mid-
 *      write, the destination is truncated and the panel reads a
 *      half-baked file.
 *   2. Concurrent-write race — a second knit of the same source
 *      could overlap the first knit's panel read. The panel uses
 *      `fs.readFileSync`, so a write that happens to clobber the
 *      file at the same moment can yield a partial read.
 *
 * Standard fix: write to a sibling temp file in the destination's
 * directory, then `rename` over the destination. POSIX rename is
 * atomic, and Node's `fs.promises.rename` uses MoveFileExW with
 * `MOVEFILE_REPLACE_EXISTING` on Windows. The destination is either
 * the previous version or the new complete version — never a
 * truncation.
 *
 * Temp file lives next to the destination so the rename is on the
 * same filesystem (cross-device rename would fall back to copy +
 * unlink, losing the atomicity guarantee).
 */
async function writeFileAtomic(destPath: string, content: string): Promise<void> {
    const dir = path.dirname(destPath);
    const tmp = path.join(
        dir,
        `.${path.basename(destPath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    try {
        await fs.promises.writeFile(tmp, content, 'utf-8');
        await fs.promises.rename(tmp, destPath);
    } catch (err) {
        // Best-effort cleanup of the temp file on any failure. The
        // rename may have succeeded after a partial-write — in which
        // case unlinking the (now-orphaned) temp is the right move.
        try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
        throw err;
    }
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
