import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate, awaitActive, sleep } from './helper';

declare const suite: Mocha.SuiteFunction;
declare const test: Mocha.TestFunction;
declare const suiteSetup: Mocha.HookFunction;
declare const suiteTeardown: Mocha.HookFunction;

/**
 * End-to-end: the real extension in a real VS Code, driving a real
 * `raven console --dap` with R. Exercises what the console's own DAP tests
 * can't: auto-attach on a stop, the editor's commands sending tagged code,
 * launch with `program`, and the toolbar's Continue and Stop.
 *
 * Needs a debug build (`cargo build -p raven`) and R with a shared libR;
 * skipped otherwise.
 */
const RAVEN = path.resolve(__dirname, '..', '..', '..', '..', 'target', 'debug', 'raven');

function r_available(): boolean {
    const out = spawnSync('R', ['RHOME'], { encoding: 'utf8' });
    if (out.status !== 0) return false;
    const lib = path.join(out.stdout.trim(), 'lib');
    return fs.existsSync(path.join(lib, 'libR.dylib')) || fs.existsSync(path.join(lib, 'libR.so'));
}

/** Everything the R debug adapter sent, in order. */
const sent: Array<{ type?: string; event?: string; body?: Record<string, unknown> }> = [];

async function until<T>(what: string, check: () => T | undefined, ms = 30_000): Promise<T> {
    const start = Date.now();
    for (;;) {
        const v = check();
        if (v !== undefined) return v;
        if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
        await sleep(100);
    }
}

function stopped_after(mark: number) {
    return until('a stop', () => sent.slice(mark).find((m) => m.type === 'event' && m.event === 'stopped'));
}

function session_ended(): Promise<void> {
    return new Promise((resolve) => {
        const sub = vscode.debug.onDidTerminateDebugSession((s) => {
            if (s.type === 'raven-r') {
                sub.dispose();
                resolve();
            }
        });
    });
}

async function top_frame(session: vscode.DebugSession): Promise<{ id: number; name: string; line: number }> {
    const st = await session.customRequest('stackTrace', { threadId: 1 });
    return st.stackFrames[0];
}

/** Open `file` and select line `line` (0-based), or the whole file for -1. */
async function open_at(file: string, line: number): Promise<vscode.TextEditor> {
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc);
    await awaitActive(editor);
    const start = line < 0 ? 0 : line;
    const end = line < 0 ? doc.lineCount - 1 : line;
    editor.selection = new vscode.Selection(start, 0, end, doc.lineAt(end).text.length);
    return editor;
}

suite('Raven R debugger (end to end)', function () {
    if (process.platform === 'win32' || !fs.existsSync(RAVEN) || !r_available()) {
        test('skipped: needs target/debug/raven and R with a shared libR', () => undefined);
        return;
    }
    this.timeout(120_000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvdbg-'));
    let tracker: vscode.Disposable | undefined;

    suiteSetup(async () => {
        await activate();
        await vscode.workspace
            .getConfiguration('raven')
            .update('server.path', RAVEN, vscode.ConfigurationTarget.Global);
        tracker = vscode.debug.registerDebugAdapterTrackerFactory('raven-r', {
            createDebugAdapterTracker: () => ({ onDidSendMessage: (m) => sent.push(m) }),
        });
    });

    suiteTeardown(async () => {
        tracker?.dispose();
        vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
        for (const t of vscode.window.terminals) t.dispose();
        await vscode.workspace
            .getConfiguration('raven')
            .update('server.path', undefined, vscode.ConfigurationTarget.Global);
    });

    // First, so no session has run yet: the default filters must already
    // reach the console.
    test('an uncaught error in code run from the editor attaches with no setup', async () => {
        const file = path.join(dir, 'e.R');
        fs.writeFileSync(file, 'e <- function(x) {\n  y <- x * 2\n  stop("boom")\n}\ne(1)\n');
        const editor = await open_at(file, 0);
        editor.selection = new vscode.Selection(0, 0, 3, 1);
        await vscode.commands.executeCommand('raven.runLineOrSelection');
        await sleep(3000);
        const mark = sent.length;
        await open_at(file, 4);
        await vscode.commands.executeCommand('raven.runLineOrSelection');
        const stop = await stopped_after(mark);
        assert.strictEqual(stop.body?.reason, 'exception');
        const session = await until('a session', () => vscode.debug.activeDebugSession);
        const frame = await top_frame(session);
        assert.strictEqual(frame.name, 'e');
        assert.strictEqual(frame.line, 3);
        const ended = session_ended();
        await vscode.commands.executeCommand('workbench.action.debug.continue');
        await ended;
    });

    test('Inspect Last Error reopens an error after it reached the prompt', async () => {
        const file = path.join(dir, 'p.R');
        fs.writeFileSync(file, 'p <- function(x) {\n  q <- x * 3\n  stop("late")\n}\np(2)\n');
        const editor = await open_at(file, 0);
        editor.selection = new vscode.Selection(0, 0, 3, 1);
        await vscode.commands.executeCommand('raven.runLineOrSelection');
        await sleep(3000);
        // It stops on the error; Continue lets it reach the prompt.
        let mark = sent.length;
        await open_at(file, 4);
        await vscode.commands.executeCommand('raven.runLineOrSelection');
        await stopped_after(mark);
        let ended = session_ended();
        await vscode.commands.executeCommand('workbench.action.debug.continue');
        await ended;
        await sleep(1000);
        mark = sent.length;
        await vscode.commands.executeCommand('raven.debugger.inspectLastError');
        const stop = await stopped_after(mark);
        assert.strictEqual(stop.body?.reason, 'exception');
        const session = await until('a session', () => vscode.debug.activeDebugSession);
        const frame = await top_frame(session);
        assert.strictEqual(frame.name, 'p');
        assert.strictEqual(frame.line, 3);
        const ev = await session.customRequest('evaluate', { expression: 'q', frameId: frame.id, context: 'repl' });
        assert.match(ev.result, /6/);
        ended = session_ended();
        await vscode.commands.executeCommand('workbench.action.debug.continue');
        await ended;
    });

    test('a breakpoint in code run from the editor attaches, inspects, and continues', async () => {
        const file = path.join(dir, 'f.R');
        fs.writeFileSync(file, 'f <- function(x) {\n  y <- x + 1\n  y * 2\n}\nf(1)\n');
        vscode.debug.addBreakpoints([
            new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file), new vscode.Position(2, 0))),
        ]);
        // Run the definition (Run Line or Selection), then the call.
        const editor = await open_at(file, 0);
        editor.selection = new vscode.Selection(0, 0, 3, 1);
        await vscode.commands.executeCommand('raven.runLineOrSelection');
        await sleep(3000);
        const mark = sent.length;
        await open_at(file, 4);
        await vscode.commands.executeCommand('raven.runLineOrSelection');
        const stop = await stopped_after(mark);
        assert.strictEqual(stop.body?.reason, 'breakpoint');
        const session = await until('a session', () => vscode.debug.activeDebugSession);
        assert.strictEqual(session.type, 'raven-r');
        const frame = await top_frame(session);
        assert.strictEqual(frame.name, 'f');
        assert.strictEqual(frame.line, 3);
        const ev = await session.customRequest('evaluate', {
            expression: 'y * 10',
            frameId: frame.id,
            context: 'repl',
        });
        assert.match(ev.result, /20/);
        const ended = session_ended();
        await vscode.commands.executeCommand('workbench.action.debug.continue');
        await ended;
    });

    test('a breakpoint removed right after it was added never stops', async () => {
        const file = path.join(dir, 'k.R');
        fs.writeFileSync(file, 'kk <- function() {\n  1\n}\nkk()\n');
        const bp = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file), new vscode.Position(1, 0)));
        vscode.debug.addBreakpoints([bp]);
        vscode.debug.removeBreakpoints([bp]);
        await sleep(1000);
        const mark = sent.length;
        await open_at(file, -1);
        await vscode.commands.executeCommand('raven.runLineOrSelection');
        await sleep(3000);
        assert.strictEqual(
            sent.slice(mark).filter((m) => m.event === 'stopped').length,
            0,
            'stopped at a deleted breakpoint',
        );
        assert.strictEqual(vscode.debug.activeDebugSession, undefined);
    });

    test('launch with program sources the file under the debugger; Stop quits the browser', async () => {
        const file = path.join(dir, 'g.R');
        fs.writeFileSync(file, 'g <- function() {\n  z <- 5\n  z\n}\nres <- g()\n');
        vscode.debug.addBreakpoints([
            new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file), new vscode.Position(2, 0))),
        ]);
        await open_at(file, 0);
        const mark = sent.length;
        await vscode.debug.startDebugging(undefined, {
            type: 'raven-r',
            request: 'launch',
            name: 'Source R file',
            program: file,
        });
        await stopped_after(mark);
        const session = await until('a session', () => vscode.debug.activeDebugSession);
        assert.strictEqual((await top_frame(session)).line, 3);
        const ended = session_ended();
        await vscode.commands.executeCommand('workbench.action.debug.stop');
        await ended;

        // Stop quit the browser, so `g()` never returned and `res` doesn't
        // exist. Ask from the next stop.
        const probe = path.join(dir, 'h.R');
        fs.writeFileSync(probe, 'h <- function() {\n  exists("res")\n}\nh()\n');
        vscode.debug.addBreakpoints([
            new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(probe), new vscode.Position(1, 0))),
        ]);
        await open_at(probe, -1);
        const mark2 = sent.length;
        await vscode.commands.executeCommand('raven.runLineOrSelection');
        await stopped_after(mark2);
        const s2 = await until('a session', () => vscode.debug.activeDebugSession);
        const ev = await s2.customRequest('evaluate', {
            expression: 'exists("res")',
            frameId: (await top_frame(s2)).id,
            context: 'repl',
        });
        assert.match(ev.result, /FALSE/);
        const ended2 = session_ended();
        await vscode.commands.executeCommand('workbench.action.debug.continue');
        await ended2;
    });
});
