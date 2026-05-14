import * as vscode from 'vscode';
import {
    classify_chunk_document_for_document,
    detect_chunks,
    has_chunk_anchor,
    is_runnable_chunk,
} from './chunk-detector';

/**
 * CodeLens provider that places "Run Chunk | Run Above" buttons on every R chunk
 * header in `.Rmd` / `.qmd` / `.R` documents.
 *
 * Non-R chunks (e.g. `{python}`, `{bash}`) are skipped — they aren't executable
 * via the R console.
 *
 * Lens invalidation is left to VS Code: the editor automatically re-calls
 * `provideCodeLenses` (with internal debouncing) after document edits, visible-
 * range changes, and selector-matching scope shifts. Because our lenses depend
 * only on the document text, we don't fire `onDidChangeCodeLenses` ourselves —
 * doing so on every keystroke would bypass VS Code's coalescing and trigger an
 * immediate recompute per edit. The optional event is declared (and disposed)
 * to keep the provider future-proof for cases that need external invalidation.
 */
class ChunkCodeLensProvider implements vscode.CodeLensProvider {
    private readonly _on_did_change = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._on_did_change.event;

    dispose(): void {
        this._on_did_change.dispose();
    }

    provideCodeLenses(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken,
    ): vscode.CodeLens[] {
        const kind = classify_chunk_document_for_document(document);
        // Fast path: plain `.R` files without `# %%` markers (and prose-only
        // `.Rmd` documents) skip the per-line scan entirely.
        if (!has_chunk_anchor(document.getText(), kind)) return [];
        const lines: string[] = [];
        for (let i = 0; i < document.lineCount; i++) lines.push(document.lineAt(i).text);
        const chunks = detect_chunks(lines, kind);
        const lenses: vscode.CodeLens[] = [];
        let chunk_index = 0;
        for (const c of chunks) {
            chunk_index++;
            if (!is_runnable_chunk(c)) continue;
            const range = new vscode.Range(c.header_line, 0, c.header_line, 0);
            const eval_suffix = c.is_eval_false ? ' (eval = FALSE)' : '';
            lenses.push(new vscode.CodeLens(range, {
                title: `▷ Run Chunk${eval_suffix}`,
                command: 'raven.runCurrentChunkAt',
                arguments: [document.uri, c.header_line],
                tooltip: c.label
                    ? `Run chunk "${c.label}" in the R console`
                    : `Run chunk #${chunk_index} in the R console`,
            }));
            lenses.push(new vscode.CodeLens(range, {
                title: '↥ Run Above',
                command: 'raven.runAboveChunksAt',
                arguments: [document.uri, c.header_line],
                tooltip: 'Run every R chunk above this one',
            }));
        }
        return lenses;
    }
}

export function register_chunk_codelens(context: vscode.ExtensionContext): ChunkCodeLensProvider {
    const provider = new ChunkCodeLensProvider();
    context.subscriptions.push(
        // Chunks live in `.R` files (via `# %%` cells) and in `.Rmd` / `.qmd`
        // files (via fenced code blocks). After the language-ID split each
        // file type uses its own `languageId`, so the selector lists all three.
        vscode.languages.registerCodeLensProvider(
            [
                { scheme: 'file', language: 'r' },
                { scheme: 'untitled', language: 'r' },
                { scheme: 'file', language: 'rmd' },
                { scheme: 'untitled', language: 'rmd' },
                { scheme: 'file', language: 'quarto' },
                { scheme: 'untitled', language: 'quarto' },
            ],
            provider,
        ),
        provider,
    );
    return provider;
}
