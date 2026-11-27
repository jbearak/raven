import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate, awaitActive, live_suites_required, sleep } from './helper';

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
 * Uses a debug build (`cargo build -p raven`) when there is one, else the
 * binary bundled with the extension (CI). Needs R with a shared libR; skipped
 * without a binary or R, and on Windows. With
 * `RAVEN_TEST_REQUIRE_LIVE_SUITES=1` (CI), a missing binary or R fails
 * instead of skipping.
 *
 * Its first test must run before any debug session has, so `.vscode-test.mjs`
 * lists this file first.
 */
const DEBUG_BUILD = path.resolve(__dirname, '..', '..', '..', '..', 'target', 'debug', 'raven');
const BUNDLED = path.resolve(__dirname, '..', '..', 'bin', 'raven');

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

/** Poll an async check until it yields a value. */
async function until_async<T>(what: string, check: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
    const start = Date.now();
    for (;;) {
        const v = await check();
        if (v !== undefined) return v;
        if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
        await sleep(100);
    }
}

/** The "Debug this error" quick fix on `line` (0-based) of `file`, if offered. */
async function debug_action(file: string, line: number): Promise<vscode.Command | undefined> {
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        vscode.Uri.file(file),
        new vscode.Range(line, 0, line, 0),
    );
    return actions?.find((a) => a.title === 'Debug this error')?.command;
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
    if (process.platform === 'win32') {
        test('skipped: not supported on Windows', () => undefined);
        return;
    }
    const missing = [
        !fs.existsSync(DEBUG_BUILD) && !fs.existsSync(BUNDLED) && `a raven binary (${DEBUG_BUILD} or ${BUNDLED})`,
        !r_available() && 'R with a shared libR (`R RHOME`, then lib/libR.so or lib/libR.dylib)',
    ].filter((m): m is string => typeof m === 'string');
    if (missing.length > 0) {
        if (live_suites_required()) {
            test('prerequisites (required on this run)', () => {
                throw new Error(`RAVEN_TEST_REQUIRE_LIVE_SUITES=1, but this suite is missing: ${missing.join('; ')}`);
            });
        } else {
            test('skipped: needs a raven binary and R with a shared libR', () => undefined);
        }
        return;
    }
    this.timeout(120_000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvdbg-'));
    let tracker: vscode.Disposable | undefined;
    let set_server_path = false;

    suiteSetup(async () => {
        await activate();
        // A debug build, when there is one, runs instead of the bundled
        // binary (which the extension uses with the setting unset).
        const config = vscode.workspace.getConfiguration('raven');
        if (fs.existsSync(DEBUG_BUILD) && config.inspect('server.path')?.globalValue === undefined) {
            await config.update('server.path', DEBUG_BUILD, vscode.ConfigurationTarget.Global);
            set_server_path = true;
        }
        tracker = vscode.debug.registerDebugAdapterTrackerFactory('raven-r', {
            createDebugAdapterTracker: () => ({ onDidSendMessage: (m) => sent.push(m) }),
        });
    });

    suiteTeardown(async () => {
        tracker?.dispose();
        vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
        for (const t of vscode.window.terminals) t.dispose();
        if (set_server_path) {
            await vscode.workspace
                .getConfiguration('raven')
                .update('server.path', undefined, vscode.ConfigurationTarget.Global);
        }
    });

    // First, so no session has run yet: with the default filters (Uncaught
    // errors on) and `stopOnError: inSession`, nothing stops on its own.
    test('an uncaught error in code run from the editor prints, and its line offers the debugger', async () => {
        const file = path.join(dir, 'e.R');
        fs.writeFileSync(file, 'e <- function(x) {\n  y <- x * 2\n  stop("boom")\n}\ne(1)\n');
        const editor = await open_at(file, 0);
        editor.selection = new vscode.Selection(0, 0, 3, 1);
        await vscode.commands.executeCommand('raven.runLineOrSelection');
        await sleep(3000);
        const mark = sent.length;
        await open_at(file, 4);
        await vscode.commands.executeCommand('raven.runLineOrSelection');
        // The error's line (`stop("boom")`, inside e) offers the debugger.
        const action = await until_async('a Debug this error action', () => debug_action(file, 2));
        assert.strictEqual(
            sent.slice(mark).find((m) => m.type === 'event' && m.event === 'stopped'),
            undefined,
            'the error stopped with no session',
        );
        assert.strictEqual(vscode.debug.activeDebugSession, undefined);
        await vscode.commands.executeCommand(action.command, ...(action.arguments ?? []));
        const stop = await stopped_after(mark);
        assert.strictEqual(stop.body?.reason, 'exception');
        const session = await until('a session', () => vscode.debug.activeDebugSession);
        const frame = await top_frame(session);
        assert.strictEqual(frame.name, 'e');
        assert.strictEqual(frame.line, 3);
        const ended = session_ended();
        await vscode.commands.executeCommand('workbench.action.debug.continue');
        await ended;
        // The next send (the definition again) clears the marker.
        const again = await open_at(file, 0);
        again.selection = new vscode.Selection(0, 0, 3, 1);
        await vscode.commands.executeCommand('raven.runLineOrSelection');
        await until_async('the marker to clear', async () => ((await debug_action(file, 2)) ? undefined : true));
    });

    test('with stopOnError: always, running a fixed line while stopped on its error ends the stop and runs the fix', async () => {
        const config = vscode.workspace.getConfiguration('raven.debugger');
        await config.update('stopOnError', 'always', vscode.ConfigurationTarget.Global);
        try {
            // The setting reaches the console with the next mirror.
            await sleep(1000);
            const file = path.join(dir, 't.R');
            const out = path.join(dir, 't.out');
            // In a function, so a marker, if one were published, would offer the action.
            fs.writeFileSync(file, `tt <- function() prit(1); tt()\nwriteLines("ran", ${JSON.stringify(out)})\n`);
            const mark = sent.length;
            await open_at(file, 0);
            await vscode.commands.executeCommand('raven.runLineOrSelection');
            const stop = await stopped_after(mark);
            assert.strictEqual(stop.body?.reason, 'exception');
            await until('a session', () => vscode.debug.activeDebugSession);
            const ended = session_ended();
            await open_at(file, 1);
            await vscode.commands.executeCommand('raven.runLineOrSelection');
            await ended;
            await until('the fixed line ran', () => fs.existsSync(out) || undefined);
            // The error was seen in the debugger: no marker offers it again.
            await sleep(1000);
            assert.strictEqual(await debug_action(file, 0), undefined);
        } finally {
            await config.update('stopOnError', undefined, vscode.ConfigurationTarget.Global);
            await sleep(1000);
        }
    });

    test('Inspect Last Error reopens an error after it reached the prompt', async () => {
        const file = path.join(dir, 'p.R');
        fs.writeFileSync(file, 'p <- function(x) {\n  q <- x * 3\n  stop("late")\n}\np(2)\n');
        const editor = await open_at(file, 0);
        editor.selection = new vscode.Selection(0, 0, 3, 1);
        await vscode.commands.executeCommand('raven.runLineOrSelection');
        await sleep(3000);
        // With no session, the error prints and R returns to the prompt.
        await open_at(file, 4);
        await vscode.commands.executeCommand('raven.runLineOrSelection');
        await until_async('the error to reach the prompt', () => debug_action(file, 2));
        const mark = sent.length;
        await vscode.commands.executeCommand('raven.debugger.inspectLastError');
        const stop = await stopped_after(mark);
        assert.strictEqual(stop.body?.reason, 'exception');
        const session = await until('a session', () => vscode.debug.activeDebugSession);
        const frame = await top_frame(session);
        assert.strictEqual(frame.name, 'p');
        assert.strictEqual(frame.line, 3);
        const ev = await session.customRequest('evaluate', { expression: 'q', frameId: frame.id, context: 'repl' });
        assert.match(ev.result, /6/);
        const ended = session_ended();
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
