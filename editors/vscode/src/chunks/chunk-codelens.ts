import * as vscode from 'vscode';
import {
    classify_chunk_document,
    detect_chunks,
    is_runnable_chunk,
} from './chunk-detector';

/**
 * CodeLens provider that places "Run Chunk | Run Above" buttons on every R chunk
 * header in `.Rmd` / `.qmd` / `.R` documents.
 *
 * Non-R chunks (e.g. `{python}`, `{bash}`) are skipped — they aren't executable
 * via the R console.
 */
class ChunkCodeLensProvider implements vscode.CodeLensProvider {
    private readonly _on_did_change = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._on_did_change.event;

    refresh(): void {
        this._on_did_change.fire();
    }

    dispose(): void {
        this._on_did_change.dispose();
    }

    provideCodeLenses(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken,
    ): vscode.CodeLens[] {
        const kind = classify_chunk_document(document.uri.fsPath || document.uri.path);
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
        vscode.languages.registerCodeLensProvider(
            [
                { scheme: 'file', language: 'r' },
                { scheme: 'untitled', language: 'r' },
            ],
            provider,
        ),
        provider,
    );
    // Refresh lenses on document edits so they track newly added chunks.
    // VS Code already coalesces CodeLens recomputation; we just fire the event.
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(() => provider.refresh()),
    );
    return provider;
}
