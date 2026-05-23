import * as vscode from 'vscode';
import * as path from 'path';

export function getFixturePath(name: string): string {
    // __dirname is out/test, fixtures are in src/test/fixtures
    return path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', name);
}

export function getFixtureUri(name: string): vscode.Uri {
    return vscode.Uri.file(getFixturePath(name));
}

export async function activate(): Promise<void> {
    const ext = vscode.extensions.getExtension('jbearak.raven-r');
    if (ext && !ext.isActive) {
        await ext.activate();
    }
}

export async function openDocument(fixtureName: string): Promise<vscode.TextDocument> {
    const uri = getFixtureUri(fixtureName);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    // Give LSP time to process
    await sleep(2000);
    return doc;
}

export async function waitForDiagnostics(uri: vscode.Uri, timeout = 10000): Promise<vscode.Diagnostic[]> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const diagnostics = vscode.languages.getDiagnostics(uri);
        if (diagnostics.length > 0) {
            return diagnostics;
        }
        await sleep(200);
    }
    return vscode.languages.getDiagnostics(uri);
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Ensure `vscode.window.activeTextEditor` is an editor for `editor.document`.
 *
 * `vscode.window.showTextDocument(doc)`'s promise resolves before VS Code
 * has finished promoting the new editor to "active" — under suite-cumulative
 * load (other webviews focused, prior tests' panels lingering, output
 * channels stealing focus), the `activeTextEditor` pointer can still
 * reference a different editor (or `undefined`) when the next
 * `executeCommand` runs. Command handlers that read
 * `vscode.window.activeTextEditor` then operate on the wrong document and
 * produce confusing failures like "no R chunks found in this document".
 *
 * Strategy: poll up to ~250 ms (handles the common "just resolved a tick
 * ago" race cheaply), and on any longer delay actively re-focus by
 * re-calling `showTextDocument`. Output channels (`output:` scheme) and
 * other non-test editors do not yield to a polling-only wait — they have
 * to be displaced explicitly: when the active editor is an output channel
 * (commonly `output:tasks` from VS Code's npm-task auto-detection),
 * `showTextDocument` alone leaves focus on the panel even after the new
 * editor opens, so we close the panel and refocus the editor group first.
 *
 * Comparison is by document URI, not by `TextEditor` reference identity.
 * `showTextDocument` on an already-open document is documented to return
 * "an existing editor that is showing the document", but VS Code does not
 * guarantee the returned object is `===` to the caller's prior reference —
 * a strict-equality wait would spin to the timeout in those cases even
 * though the right document is focused.
 *
 * Call this right after `showTextDocument`, and before any `executeCommand`
 * that depends on the active editor.
 */
export async function awaitActive(
    editor: vscode.TextEditor,
    timeoutMs = 5000,
): Promise<void> {
    const targetUri = editor.document.uri.toString();
    const matches = (): boolean => {
        const active = vscode.window.activeTextEditor;
        return active !== undefined && active.document.uri.toString() === targetUri;
    };
    const started = Date.now();
    let lastForceFocusAt = 0;
    while (!matches()) {
        const elapsed = Date.now() - started;
        if (elapsed > timeoutMs) {
            const active = vscode.window.activeTextEditor?.document.uri.toString() ?? 'none';
            throw new Error(
                `Editor for ${targetUri} never became active (active: ${active})`,
            );
        }
        // Re-focus the test's document after a short initial poll budget,
        // then at most every 500 ms. The two-phase shape keeps the common
        // case (`showTextDocument` just resolved) cheap, while displacing
        // a focused output channel or webview when polling alone won't.
        if (elapsed >= 250 && Date.now() - lastForceFocusAt >= 500) {
            lastForceFocusAt = Date.now();
            // If the current active is an output channel (e.g.
            // `output:tasks` opened by VS Code's npm-task auto-detection
            // on startup), `showTextDocument` opens the editor but does
            // not steal focus back from the panel. Close the panel and
            // pin focus to the editor group before re-showing so the
            // newly opened editor actually wins activation.
            const activeScheme = vscode.window.activeTextEditor?.document.uri.scheme;
            if (activeScheme === 'output') {
                try {
                    await vscode.commands.executeCommand('workbench.action.closePanel');
                } catch { /* panel may already be closed */ }
                try {
                    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
                } catch { /* no editor group yet — showTextDocument below handles it */ }
            }
            try {
                await vscode.window.showTextDocument(editor.document, {
                    viewColumn: editor.viewColumn,
                    preserveFocus: false,
                    preview: false,
                });
            } catch {
                // Document may have been closed externally; the next poll
                // tick will detect the mismatch and time out with a
                // diagnostic error rather than swallowing this silently.
            }
        }
        await sleep(25);
    }
}

/**
 * True when the test runner is invoked under a local Claude Code sandbox.
 *
 * The sandbox env disables FSEvents callbacks on macOS and adds CPU
 * contention that pushes long-running smoke tests past their timeouts.
 * Suites that fail purely because of those constraints (e.g. the 700K-row
 * data-viewer scrolling tests, the knit iframe-load probe) self-skip when
 * this returns `true` so a local run reports "skipped (sandbox)" rather
 * than "failed (timeout)".
 *
 * `CLAUDECODE=1` alone is not enough — Claude-backed CI agents and review
 * lanes also set it (see the `LlmReporter` note in `problemMatchers.test.ts`).
 * Gating additionally on `!process.env.CI` keeps real CI lanes — including
 * Claude-backed ones — running the full suite, where they should.
 */
export function isClaudeCodeSandbox(): boolean {
    return process.env.CLAUDECODE === '1' && !process.env.CI;
}
