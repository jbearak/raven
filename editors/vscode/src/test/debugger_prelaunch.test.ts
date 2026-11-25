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
 * End-to-end, in a real VS Code with a real `raven console --dap` and R: a
 * `raven-r` launch whose `preLaunchTask` outlasts the 10 s the launch keeps
 * its console for (`admit_launch` in src/debugger/index.ts).
 *
 * tests/bun/debugger-console-link.test.ts covers the extension's logic
 * against a stand-in for VS Code's launch sequence. This covers what only
 * the real host can show: that VS Code runs the task between the provider's
 * two hooks, hands the second the configuration the first returned (with
 * the extension's private mark), and ends the launch quietly when the hook
 * returns nothing.
 *
 * The task is `raven-test: slow preLaunchTask` in fixtures/.vscode/tasks.json;
 * it runs until the test releases it. Uses a debug build
 * (`target/debug/raven`) when there is one, else the binary bundled with
 * the extension (CI); skipped without either, without R with a shared libR,
 * and on Windows (the task is a `/bin/sh` loop).
 *
 * Named to sort after debugger.test.ts, whose first test must run before
 * any debug session has. Leaves behind only what was there before it ran.
 */
const DEBUG_BUILD = path.resolve(__dirname, '..', '..', '..', '..', 'target', 'debug', 'raven');
const BUNDLED = path.resolve(__dirname, '..', '..', 'bin', 'raven');
const TASK = 'raven-test: slow preLaunchTask';

function r_available(): boolean {
    const out = spawnSync('R', ['RHOME'], { encoding: 'utf8' });
    if (out.status !== 0) return false;
    const lib = path.join(out.stdout.trim(), 'lib');
    return fs.existsSync(path.join(lib, 'libR.dylib')) || fs.existsSync(path.join(lib, 'libR.so'));
}

async function until<T>(what: string, check: () => T | undefined, ms = 30_000): Promise<T> {
    const start = Date.now();
    for (;;) {
        const v = check();
        if (v !== undefined) return v;
        if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
        await sleep(100);
    }
}

/** Open `file` with the cursor on line `line` (0-based). */
async function open_at(file: string, line: number): Promise<vscode.TextEditor> {
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc);
    await awaitActive(editor);
    editor.selection = new vscode.Selection(line, 0, line, doc.lineAt(line).text.length);
    return editor;
}

suite('Raven R debugger: a launch with a slow preLaunchTask (end to end)', function () {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const have_binary = fs.existsSync(DEBUG_BUILD) || fs.existsSync(BUNDLED);
    if (process.platform === 'win32' || !folder || !have_binary || !r_available()) {
        test('skipped: needs a raven binary, a workspace folder and R with a shared libR', () => undefined);
        return;
    }
    this.timeout(180_000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvdbg-task-'));
    const task_release = path.join(folder.uri.fsPath, '.raven-test-slow-task-release');
    const task_done = path.join(folder.uri.fsPath, '.raven-test-slow-task-done');
    /** Everything the R debug adapter sent, in order. */
    const sent: Array<{ type?: string; event?: string; body?: Record<string, unknown> }> = [];
    const disposables: vscode.Disposable[] = [];
    let sessions_started = 0;
    /** What this suite added or changed, for `suiteTeardown` to undo. */
    const breakpoints: vscode.Breakpoint[] = [];
    let terminals_before: readonly vscode.Terminal[] = [];
    let set_server_path = false;

    suiteSetup(async () => {
        await activate();
        fs.rmSync(task_release, { force: true });
        fs.rmSync(task_done, { force: true });
        terminals_before = [...vscode.window.terminals];
        const config = vscode.workspace.getConfiguration('raven');
        if (fs.existsSync(DEBUG_BUILD) && config.inspect('server.path')?.globalValue === undefined) {
            await config.update('server.path', DEBUG_BUILD, vscode.ConfigurationTarget.Global);
            set_server_path = true;
        }
        disposables.push(
            vscode.debug.registerDebugAdapterTrackerFactory('raven-r', {
                createDebugAdapterTracker: () => ({ onDidSendMessage: (m) => sent.push(m) }),
            }),
            vscode.debug.onDidStartDebugSession((s) => {
                if (s.type === 'raven-r') sessions_started++;
            }),
        );
    });

    suiteTeardown(async () => {
        for (const d of disposables) d.dispose();
        // Also ends a task a failed test left waiting.
        fs.writeFileSync(task_release, '');
        await sleep(500);
        fs.rmSync(task_release, { force: true });
        fs.rmSync(task_done, { force: true });
        vscode.debug.removeBreakpoints(breakpoints);
        // The console this suite opened may be stopped in the debugger if
        // the test failed; one that was already open is left alone.
        for (const t of vscode.window.terminals) if (!terminals_before.includes(t)) t.dispose();
        if (set_server_path) {
            await vscode.workspace
                .getConfiguration('raven')
                .update('server.path', undefined, vscode.ConfigurationTarget.Global);
        }
    });

    test('the stop that attached while the task ran keeps the console; the launch does not start', async () => {
        const file = path.join(dir, 's.R');
        fs.writeFileSync(file, 'slow_fn <- function() {\n  w <- 1\n  w\n}\nslow_fn()\n');
        const program = path.join(dir, 'prog.R');
        const program_ran = path.join(dir, 'program-ran');
        fs.writeFileSync(program, `file.create(${JSON.stringify(program_ran)})\n`);
        breakpoints.push(
            new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file), new vscode.Position(2, 0))),
        );
        vscode.debug.addBreakpoints(breakpoints);
        // Define the function, which opens the console the launch will use.
        const editor = await open_at(file, 0);
        editor.selection = new vscode.Selection(0, 0, 3, 1);
        await vscode.commands.executeCommand('raven.runLineOrSelection');
        await sleep(5000);

        let task_started = false;
        disposables.push(vscode.tasks.onDidStartTask((e) => {
            if (e.execution.task.name === TASK) task_started = true;
        }));
        const launch = vscode.debug.startDebugging(folder, {
            type: 'raven-r',
            request: 'launch',
            name: 'Slow preLaunchTask',
            program,
            preLaunchTask: TASK,
        });
        // The launch has resolved and claimed the console; its task runs.
        await until('the preLaunchTask to start', () => task_started || undefined);
        assert.strictEqual(sessions_started, 0);
        const mark = sent.length;
        await open_at(file, 4);
        await vscode.commands.executeCommand('raven.runLineOrSelection');
        // The stop waits for the launch while its claim lasts (10 s), then
        // gets a session of its own.
        const stop = await until(
            'a stop',
            () => sent.slice(mark).find((m) => m.type === 'event' && m.event === 'stopped'),
            60_000,
        );
        assert.strictEqual(stop.body?.reason, 'breakpoint');
        const session = await until('a session', () => vscode.debug.activeDebugSession);

        // Only now does the task finish.
        fs.writeFileSync(task_release, '');
        const started = await launch;
        assert.ok(fs.existsSync(task_done), 'the preLaunchTask did not run to its end');
        assert.strictEqual(started, false, 'the launch started over the session showing the stop');
        assert.strictEqual(sessions_started, 1);
        // The session showing the stop was not cut off.
        const st = await session.customRequest('stackTrace', { threadId: 1 });
        assert.strictEqual(st.stackFrames[0].name, 'slow_fn');
        assert.strictEqual(st.stackFrames[0].line, 3);

        const ended = new Promise<void>((resolve) => {
            const sub = vscode.debug.onDidTerminateDebugSession((s) => {
                if (s.type === 'raven-r') {
                    sub.dispose();
                    resolve();
                }
            });
        });
        await vscode.commands.executeCommand('workbench.action.debug.continue');
        await ended;
        await sleep(2000);
        assert.ok(!fs.existsSync(program_ran), "the launch's program ran");
    });
});
