import * as vscode from 'vscode';
import {
    classify_chunk_document,
    detect_chunks,
    is_runnable_chunk,
} from './chunk-detector';

/**
 * Manages per-editor background decoration for R chunk regions.
 *
 * Two decoration types are used:
 *   - "active": chunks with `eval = TRUE` (the default).
 *   - "inactive": chunks with `eval = FALSE`, rendered with reduced opacity so users
 *     can see at a glance that these will not be evaluated by `knitr` / `quarto render`.
 *
 * The colors are themable via the `colorCustomizations` mechanism (see
 * `register_chunk_decorations`).
 */
class ChunkDecorationManager {
    private active_type: vscode.TextEditorDecorationType;
    private inactive_type: vscode.TextEditorDecorationType;
    private debounce_handle: NodeJS.Timeout | undefined;

    constructor() {
        this.active_type = this.create_decoration(false);
        this.inactive_type = this.create_decoration(true);
    }

    private create_decoration(inactive: boolean): vscode.TextEditorDecorationType {
        return vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: new vscode.ThemeColor(
                inactive ? 'raven.chunk.inactiveBackground' : 'raven.chunk.activeBackground',
            ),
            overviewRulerLane: vscode.OverviewRulerLane.Left,
            overviewRulerColor: new vscode.ThemeColor(
                inactive ? 'raven.chunk.inactiveBackground' : 'raven.chunk.activeBackground',
            ),
        });
    }

    update(editor: vscode.TextEditor | undefined): void {
        if (!editor) return;
        if (!is_chunk_capable_document(editor.document)) {
            editor.setDecorations(this.active_type, []);
            editor.setDecorations(this.inactive_type, []);
            return;
        }
        if (!chunks_enabled()) {
            editor.setDecorations(this.active_type, []);
            editor.setDecorations(this.inactive_type, []);
            return;
        }
        const kind = classify_chunk_document(editor.document.uri.fsPath || editor.document.uri.path);
        const lines: string[] = [];
        for (let i = 0; i < editor.document.lineCount; i++) lines.push(editor.document.lineAt(i).text);
        const chunks = detect_chunks(lines, kind);
        const active_ranges: vscode.Range[] = [];
        const inactive_ranges: vscode.Range[] = [];
        for (const c of chunks) {
            if (!is_runnable_chunk(c)) continue;
            const last = c.closing_fence_line ?? c.end_line;
            const range = new vscode.Range(c.header_line, 0, last, 0);
            (c.is_eval_false ? inactive_ranges : active_ranges).push(range);
        }
        editor.setDecorations(this.active_type, active_ranges);
        editor.setDecorations(this.inactive_type, inactive_ranges);
    }

    update_visible(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            this.update(editor);
        }
    }

    /**
     * Debounced refresh for rapid edits — VS Code coalesces editor-change events well,
     * but Rmd documents in particular can be large, so we throttle to 75ms.
     */
    schedule_refresh(): void {
        if (this.debounce_handle !== undefined) {
            clearTimeout(this.debounce_handle);
        }
        this.debounce_handle = setTimeout(() => {
            this.debounce_handle = undefined;
            this.update_visible();
        }, 75);
    }

    rebuild_decorations(): void {
        this.active_type.dispose();
        this.inactive_type.dispose();
        this.active_type = this.create_decoration(false);
        this.inactive_type = this.create_decoration(true);
        this.update_visible();
    }

    dispose(): void {
        if (this.debounce_handle !== undefined) clearTimeout(this.debounce_handle);
        this.active_type.dispose();
        this.inactive_type.dispose();
    }
}

function chunks_enabled(): boolean {
    const config = vscode.workspace.getConfiguration('raven.chunks');
    return config.get<boolean>('highlight.enabled', true);
}

function is_chunk_capable_document(document: vscode.TextDocument): boolean {
    if (document.languageId !== 'r') return false;
    // For .R files we still draw highlight for `# %%` cells.
    return true;
}

export function register_chunk_decorations(context: vscode.ExtensionContext): ChunkDecorationManager {
    const manager = new ChunkDecorationManager();
    context.subscriptions.push({ dispose: () => manager.dispose() });

    manager.update_visible();

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => manager.update(editor)),
        vscode.window.onDidChangeVisibleTextEditors(() => manager.update_visible()),
        vscode.workspace.onDidChangeTextDocument((event) => {
            const active = vscode.window.activeTextEditor;
            if (active && event.document.uri.toString() === active.document.uri.toString()) {
                manager.schedule_refresh();
            }
        }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('raven.chunks.highlight')) {
                manager.rebuild_decorations();
            }
        }),
    );

    return manager;
}
