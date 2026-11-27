import * as fs from 'fs';
import * as vscode from 'vscode';

/**
 * The marker on the line where the last error from code in a file happened.
 * With `raven.debugger.stopOnError: inSession` (the default), an error in code
 * run with no debug session prints its traceback and returns R to the
 * prompt; the console then pushes `{"event":"error"}` (message, innermost
 * file line, whether Inspect Last Error can open it), and this module marks
 * that line, so the user can choose to debug it afterwards.
 *
 * Invariants:
 * - One marker at a time, across consoles: it names the console it came
 *   from, and its action inspects that console's last error. A newer error
 *   from any console replaces it, so it never offers an error the console
 *   has since replaced (the console keeps only its last error's frames).
 * - "Debug this error" (hover link and code action) is offered only when the
 *   console kept the error's frames (`inspect`); an error at the top level
 *   of a file is marked without it.
 * - Cleared by the next send to any console, by an edit that touches the
 *   marked line, and when its console closes. It is a decoration, not a
 *   diagnostic: a runtime error is not a problem in the file's text and
 *   stays out of the Problems view.
 */

export interface ErrorEvent {
    message?: string;
    path?: string;
    line?: number;
    inspect?: boolean;
}

interface Marker {
    ipc: string;
    uri: vscode.Uri;
    /** 0-based. */
    line: number;
    message: string;
    inspect: boolean;
}

export const DEBUG_ERROR_COMMAND = 'raven.debugger.debugError';
const MAX_INLINE = 120;

let marker: Marker | null = null;
let decoration: vscode.TextEditorDecorationType | null = null;

function same_file(a: vscode.Uri, b: vscode.Uri): boolean {
    if (a.toString() === b.toString()) return true;
    if (a.scheme !== 'file' || b.scheme !== 'file') return false;
    // The console reports real paths (macOS's /tmp and /var are symlinks).
    try {
        return fs.realpathSync.native(a.fsPath) === fs.realpathSync.native(b.fsPath);
    } catch {
        return false;
    }
}

function one_line(s: string): string {
    const first = s.split('\n')[0].trim();
    return first.length > MAX_INLINE ? first.slice(0, MAX_INLINE - 1) + '…' : first;
}

function render(): void {
    if (!decoration) return;
    for (const editor of vscode.window.visibleTextEditors) {
        if (!marker || !same_file(editor.document.uri, marker.uri) || marker.line >= editor.document.lineCount) {
            editor.setDecorations(decoration, []);
            continue;
        }
        const text = editor.document.lineAt(marker.line);
        const start = text.firstNonWhitespaceCharacterIndex;
        const range = new vscode.Range(marker.line, start, marker.line, Math.max(start, text.range.end.character));
        const hover = new vscode.MarkdownString();
        hover.appendText(`Error: ${marker.message}`);
        if (marker.inspect) {
            const args = encodeURIComponent(JSON.stringify([marker.ipc]));
            hover.appendMarkdown(`\n\n[Debug this error](command:${DEBUG_ERROR_COMMAND}?${args})`);
            hover.isTrusted = { enabledCommands: [DEBUG_ERROR_COMMAND] };
        }
        editor.setDecorations(decoration, [{
            range,
            hoverMessage: hover,
            renderOptions: { after: { contentText: `  Error: ${one_line(marker.message)}` } },
        }]);
    }
}

function set(next: Marker | null): void {
    if (marker === null && next === null) return;
    marker = next;
    render();
}

/** An `error` event from console `ipc`. */
export function show_error(ipc: string, ev: ErrorEvent): void {
    if (typeof ev.path !== 'string' || !ev.path || typeof ev.line !== 'number' || ev.line < 1) return;
    set({
        ipc,
        uri: vscode.Uri.file(ev.path),
        line: ev.line - 1,
        message: ev.message || 'an error',
        inspect: ev.inspect === true,
    });
}

/** Code was sent to a console: the error it would offer is no longer the last word. */
export function clear_error(): void {
    set(null);
}

/** Console `ipc` closed: its errors can no longer be inspected. */
export function clear_error_for(ipc: string): void {
    if (marker?.ipc === ipc) set(null);
}

const code_actions: vscode.CodeActionProvider = {
    provideCodeActions(document, range) {
        if (!marker?.inspect || !same_file(document.uri, marker.uri)) return [];
        if (range.start.line > marker.line || range.end.line < marker.line) return [];
        const action = new vscode.CodeAction('Debug this error', vscode.CodeActionKind.QuickFix);
        action.command = { command: DEBUG_ERROR_COMMAND, title: 'Debug this error', arguments: [marker.ipc] };
        action.isPreferred = true;
        return [action];
    },
};

/** `debug` opens console `ipc`'s last error in the debugger. */
export function register_error_marker(
    context: vscode.ExtensionContext,
    debug: (ipc: string) => Promise<void>,
): void {
    decoration = vscode.window.createTextEditorDecorationType({
        textDecoration: 'underline wavy var(--vscode-editorError-foreground)',
        overviewRulerColor: new vscode.ThemeColor('editorError.foreground'),
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        after: {
            color: new vscode.ThemeColor('editorError.foreground'),
            fontStyle: 'italic',
            margin: '0 0 0 1em',
        },
    });
    context.subscriptions.push(
        decoration,
        vscode.window.onDidChangeVisibleTextEditors(render),
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (!marker || !same_file(e.document.uri, marker.uri)) return;
            const line = marker.line;
            if (e.contentChanges.some((c) => c.range.start.line <= line && line <= c.range.end.line)) {
                set(null);
                return;
            }
            // Lines inserted or removed above move the marked line with them.
            let shift = 0;
            for (const c of e.contentChanges) {
                if (c.range.end.line >= line) continue;
                const added = c.text.split('\n').length - 1;
                const removed = c.range.end.line - c.range.start.line;
                shift += added - removed;
            }
            if (shift !== 0) {
                marker = { ...marker, line: line + shift };
                render();
            }
        }),
        vscode.languages.registerCodeActionsProvider(
            // Every file: the marker may be in any file R ran code from.
            { scheme: 'file' },
            code_actions,
            { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
        ),
        vscode.commands.registerCommand(DEBUG_ERROR_COMMAND, async (ipc?: string) => {
            const target = typeof ipc === 'string' ? ipc : marker?.ipc;
            if (target) await debug(target);
        }),
        new vscode.Disposable(() => {
            marker = null;
            decoration = null;
        }),
    );
}
