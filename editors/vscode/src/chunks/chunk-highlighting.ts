import * as vscode from 'vscode';
import {
    Chunk,
    classify_chunk_document_for_document,
    detect_chunks,
    find_chunk_at_line,
    has_chunk_anchor,
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
        const kind = classify_chunk_document_for_document(editor.document);
        // Fast path: avoid the per-line scan on `.R` files without `# %%`
        // markers and prose-only `.Rmd` documents. Still clears any stale
        // decorations from a prior state in case markers were just removed.
        if (!has_chunk_anchor(editor.document.getText(), kind)) {
            editor.setDecorations(this.active_type, []);
            editor.setDecorations(this.inactive_type, []);
            return;
        }
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

function active_cell_indicator_enabled(): boolean {
    const config = vscode.workspace.getConfiguration('raven.chunks');
    return config.get<boolean>('activeCellIndicator', true);
}

/**
 * Cursor-tracking top/bottom border around the active `.R` cell.
 *
 * Mirrors VS Code's "selected cell" indicator from the Interactive Window /
 * Jupyter Notebooks. Without it, `.R` cell mode has no visible boundary
 * between adjacent cells — only the flat background tint — so users can't
 * tell which cell `Run Current Chunk` will run.
 *
 * Scope: `.R` files only (cell mode). `.Rmd` / `.qmd` fences already give
 * a clear visual boundary, so the indicator is skipped there.
 */
class ChunkActiveCellIndicator {
    private top_border: vscode.TextEditorDecorationType;
    private bottom_border: vscode.TextEditorDecorationType;
    private debounce_handle: NodeJS.Timeout | undefined;
    // Per-document chunk cache keyed by URI string. Avoids re-scanning the
    // entire file on every cursor move — onDidChangeTextEditorSelection
    // fires on every keystroke and arrow press, so the unmodified-file path
    // must be O(1) rather than O(n).
    private chunks_cache: Map<string, { version: number; chunks: Chunk[] }> = new Map();

    constructor() {
        this.top_border = this.create_border('top');
        this.bottom_border = this.create_border('bottom');
    }

    private create_border(side: 'top' | 'bottom'): vscode.TextEditorDecorationType {
        const color = new vscode.ThemeColor(
            side === 'top' ? 'raven.chunk.activeCellBorderTop' : 'raven.chunk.activeCellBorderBottom',
        );
        return vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            borderColor: color,
            borderWidth: side === 'top' ? '1px 0 0 0' : '0 0 1px 0',
            borderStyle: 'solid',
        });
    }

    private clear(editor: vscode.TextEditor): void {
        editor.setDecorations(this.top_border, []);
        editor.setDecorations(this.bottom_border, []);
    }

    private get_chunks(editor: vscode.TextEditor): Chunk[] {
        const uri = editor.document.uri.toString();
        const version = editor.document.version;
        const cached = this.chunks_cache.get(uri);
        if (cached && cached.version === version) return cached.chunks;
        // Fast path: skip the line scan if there are no `%%` anchors at all.
        const text = editor.document.getText();
        if (!has_chunk_anchor(text, 'r')) {
            this.chunks_cache.set(uri, { version, chunks: [] });
            return [];
        }
        const lines: string[] = [];
        for (let i = 0; i < editor.document.lineCount; i++) lines.push(editor.document.lineAt(i).text);
        const chunks = detect_chunks(lines, 'r');
        this.chunks_cache.set(uri, { version, chunks });
        return chunks;
    }

    update(editor: vscode.TextEditor | undefined): void {
        if (!editor) return;
        if (!this.should_decorate(editor)) {
            this.clear(editor);
            return;
        }
        const chunks = this.get_chunks(editor);
        if (chunks.length === 0) {
            this.clear(editor);
            return;
        }
        const cursor_line = editor.selection.active.line;
        const active_chunk = find_chunk_at_line(chunks, cursor_line);
        if (active_chunk === null) {
            this.clear(editor);
            return;
        }
        const top = new vscode.Range(active_chunk.header_line, 0, active_chunk.header_line, 0);
        const bottom = new vscode.Range(active_chunk.end_line, 0, active_chunk.end_line, 0);
        editor.setDecorations(this.top_border, [top]);
        editor.setDecorations(this.bottom_border, [bottom]);
    }

    update_visible(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            this.update(editor);
        }
    }

    schedule_refresh(): void {
        if (this.debounce_handle !== undefined) {
            clearTimeout(this.debounce_handle);
        }
        this.debounce_handle = setTimeout(() => {
            this.debounce_handle = undefined;
            this.update_visible();
        }, 75);
    }

    /**
     * Drop the cached chunks for a closed document so the map doesn't grow
     * unbounded over a long editing session.
     */
    forget(uri: vscode.Uri): void {
        this.chunks_cache.delete(uri.toString());
    }

    private should_decorate(editor: vscode.TextEditor): boolean {
        if (!active_cell_indicator_enabled()) return false;
        // Only `.R` cell mode — Rmd/Qmd fences already provide clear boundaries.
        if (classify_chunk_document_for_document(editor.document) !== 'r') return false;
        // Belt-and-suspenders: bail if another extension overrode the languageId.
        if (editor.document.languageId.toLowerCase() !== 'r') return false;
        return true;
    }

    rebuild_decorations(): void {
        this.top_border.dispose();
        this.bottom_border.dispose();
        this.top_border = this.create_border('top');
        this.bottom_border = this.create_border('bottom');
        this.update_visible();
    }

    dispose(): void {
        if (this.debounce_handle !== undefined) clearTimeout(this.debounce_handle);
        this.top_border.dispose();
        this.bottom_border.dispose();
        this.chunks_cache.clear();
    }
}

function is_chunk_capable_document(document: vscode.TextDocument): boolean {
    // Accept the three language IDs Raven contributes: `r` (covering `.r` /
    // `.R`, where chunks take the `# %%` cell form), `rmd` (covering `.Rmd`),
    // and `quarto` (covering `.qmd`). A sibling extension that wins the
    // `rmd` / `quarto` languageId race falls into the same branch by design.
    const lang = document.languageId.toLowerCase();
    return lang === 'r' || lang === 'rmd' || lang === 'quarto';
}

export function register_chunk_decorations(context: vscode.ExtensionContext): ChunkDecorationManager {
    const manager = new ChunkDecorationManager();
    const indicator = new ChunkActiveCellIndicator();
    context.subscriptions.push({ dispose: () => manager.dispose() });
    context.subscriptions.push({ dispose: () => indicator.dispose() });

    manager.update_visible();
    indicator.update_visible();

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            manager.update(editor);
            indicator.update(editor);
        }),
        vscode.window.onDidChangeVisibleTextEditors(() => {
            manager.update_visible();
            indicator.update_visible();
        }),
        vscode.window.onDidChangeTextEditorSelection((event) => {
            // Selection changes only matter for the active-cell indicator —
            // background highlighting doesn't depend on cursor position.
            indicator.update(event.textEditor);
        }),
        vscode.workspace.onDidChangeTextDocument((event) => {
            // Refresh whenever the changed document is currently visible — that
            // covers both the active editor and any split-view panes showing
            // the same document, so decorations don't go stale when the user
            // edits via a workspace edit or in another pane.
            const document_uri = event.document.uri.toString();
            const is_visible = vscode.window.visibleTextEditors.some(
                (editor) => editor.document.uri.toString() === document_uri,
            );
            if (is_visible) {
                manager.schedule_refresh();
                indicator.schedule_refresh();
            }
        }),
        vscode.workspace.onDidCloseTextDocument((document) => {
            indicator.forget(document.uri);
        }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('raven.chunks.highlight')) {
                manager.rebuild_decorations();
            }
            if (event.affectsConfiguration('raven.chunks.activeCellIndicator')) {
                indicator.rebuild_decorations();
            }
        }),
    );

    return manager;
}
