import * as assert from 'assert';
import * as vscode from 'vscode';

const CHUNK_COMMANDS = [
    'raven.runCurrentChunk',
    'raven.runCurrentChunkAndMove',
    'raven.runAboveChunks',
    'raven.runAllChunks',
    'raven.goToNextChunk',
    'raven.goToPreviousChunk',
    'raven.selectCurrentChunk',
] as const;

const RMD_FIXTURE = [
    '---',
    'title: example',
    '---',
    '',
    'Some prose.',
    '',
    '```{r setup, include=FALSE}',
    'library(dplyr)',
    '```',
    '',
    'More prose.',
    '',
    '```{python}',
    'print("not r")',
    '```',
    '',
    '```{r second}',
    'x <- 1',
    'y <- 2',
    '```',
    '',
    '```{r noeval, eval=FALSE}',
    'never_run()',
    '```',
    '',
].join('\n');

const R_CELL_FIXTURE = [
    '# %% one',
    'a <- 1',
    'b <- 2',
    '# %% two',
    'c <- 3',
    '',
].join('\n');

async function open_rmd(content: string): Promise<vscode.TextEditor> {
    const doc = await vscode.workspace.openTextDocument({
        language: 'r',
        content,
    });
    return vscode.window.showTextDocument(doc);
}

function place_cursor(editor: vscode.TextEditor, line: number, char = 0): void {
    const pos = new vscode.Position(line, char);
    editor.selection = new vscode.Selection(pos, pos);
}

interface MessageStub {
    last: string | undefined;
    restore(): void;
}

function stub_information_message(): MessageStub {
    const original = vscode.window.showInformationMessage;
    const result: MessageStub = {
        last: undefined,
        restore: () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).showInformationMessage = original;
        },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.window as any).showInformationMessage = (msg: string) => {
        result.last = msg;
        return Promise.resolve(undefined);
    };
    return result;
}

interface TerminalStub {
    sent: string[];
    restore(): void;
}

/**
 * Replace `vscode.window.createTerminal` so the next call returns a
 * recording terminal. The bundled extension's `get_or_create_r_terminal`
 * caches the terminal in-process via module-level state, so the FIRST
 * call after stubbing is what we capture — subsequent tests in the same
 * suite will reuse that same recording terminal. The stub also records
 * `sendText` calls when the cached terminal is reused.
 */
function stub_create_terminal(): TerminalStub {
    const sent: string[] = [];
    const recorder = (text: string, _addNewLine?: boolean) => {
        sent.push(text);
    };
    // Cast through `unknown` because the VS Code TerminalState/shell-integration
    // interfaces churn across `@types/vscode` versions and the test only needs
    // `sendText` / `show` to be callable.
    const fake_terminal = {
        name: 'R (Raven test stub)',
        sendText: recorder,
        show: () => undefined,
        dispose: () => undefined,
        processId: Promise.resolve(undefined),
        creationOptions: { name: 'R (Raven test stub)' },
        exitStatus: undefined,
        state: { isInteractedWith: false },
    } as unknown as vscode.Terminal;
    const original = vscode.window.createTerminal;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.window as any).createTerminal = (..._args: unknown[]) => fake_terminal;
    return {
        sent,
        restore: () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).createTerminal = original;
        },
    };
}

suite('chunk commands: registration and behavior', () => {
    test('every chunk command is registered in VS Code', async () => {
        // Skip when R-console activation is disabled (REditorSupport / Positron):
        // the run / CodeLens-positional commands aren't registered then. The
        // three navigation commands always are.
        const all = new Set(await vscode.commands.getCommands(true));
        const r_console_disabled = !all.has('raven.runLineOrSelection');
        const expected = r_console_disabled
            ? ['raven.goToNextChunk', 'raven.goToPreviousChunk', 'raven.selectCurrentChunk']
            : CHUNK_COMMANDS;
        for (const cmd of expected) {
            assert.ok(
                all.has(cmd),
                `expected chunk command "${cmd}" to be registered`,
            );
        }
    });

    test('package.json declares every chunk command under the Raven category', () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pkg = require('../../package.json') as {
            contributes: {
                commands: Array<{ command: string; title: string; category?: string }>;
            };
        };
        const declared = new Map(
            pkg.contributes.commands.map((c) => [c.command, c]),
        );
        for (const cmd of CHUNK_COMMANDS) {
            const entry = declared.get(cmd);
            assert.ok(entry, `package.json must declare ${cmd}`);
            assert.strictEqual(
                entry.category,
                'Raven',
                `${cmd} must be under the Raven category`,
            );
        }
    });

    test('goToNextChunk places cursor inside the next R chunk body', async () => {
        const editor = await open_rmd(RMD_FIXTURE);
        place_cursor(editor, 0); // before any chunk
        await vscode.commands.executeCommand('raven.goToNextChunk');
        // First chunk header is line 6 ("```{r setup, ...}"), body starts at line 7.
        assert.strictEqual(editor.selection.active.line, 7);

        await vscode.commands.executeCommand('raven.goToNextChunk');
        // Second runnable chunk header is the python one at 12, but navigation walks
        // every chunk regardless of language — the next chunk is python at 12, so
        // cursor lands on line 13 (body of the python chunk). That's intentional:
        // navigation is language-agnostic.
        assert.strictEqual(editor.selection.active.line, 13);
    });

    test('goToPreviousChunk walks chunks in reverse', async () => {
        const editor = await open_rmd(RMD_FIXTURE);
        place_cursor(editor, 17); // inside the second R chunk body
        await vscode.commands.executeCommand('raven.goToPreviousChunk');
        // Previous chunk is python at line 12 → body line 13.
        assert.strictEqual(editor.selection.active.line, 13);
    });

    test('selectCurrentChunk selects only the body of the chunk under the cursor', async () => {
        const editor = await open_rmd(RMD_FIXTURE);
        place_cursor(editor, 17); // inside the "second" R chunk
        await vscode.commands.executeCommand('raven.selectCurrentChunk');
        const text = editor.document.getText(editor.selection);
        assert.strictEqual(text, 'x <- 1\ny <- 2');
    });

    test('runCurrentChunk warns when cursor is not inside a chunk', async () => {
        const r_console_disabled = !(await vscode.commands.getCommands(true))
            .includes('raven.runCurrentChunk');
        if (r_console_disabled) return; // command not registered in this env
        const editor = await open_rmd(RMD_FIXTURE);
        place_cursor(editor, 4); // prose line, not in a chunk
        const stub = stub_information_message();
        try {
            await vscode.commands.executeCommand('raven.runCurrentChunk');
        } finally {
            stub.restore();
        }
        assert.ok(
            stub.last && stub.last.includes('not inside an R chunk'),
            `expected "not inside an R chunk" info message, got: ${String(stub.last)}`,
        );
    });

    test('runCurrentChunk refuses non-R chunks', async () => {
        const r_console_disabled = !(await vscode.commands.getCommands(true))
            .includes('raven.runCurrentChunk');
        if (r_console_disabled) return;
        const editor = await open_rmd(RMD_FIXTURE);
        place_cursor(editor, 13); // inside the python chunk
        const stub = stub_information_message();
        try {
            await vscode.commands.executeCommand('raven.runCurrentChunk');
        } finally {
            stub.restore();
        }
        assert.ok(
            stub.last && stub.last.includes('python'),
            `expected python-language info message, got: ${String(stub.last)}`,
        );
    });

    test('runCurrentChunk on an empty (no chunks) document warns', async () => {
        const r_console_disabled = !(await vscode.commands.getCommands(true))
            .includes('raven.runCurrentChunk');
        if (r_console_disabled) return;
        const editor = await open_rmd('x <- 1\nprint(x)\n');
        place_cursor(editor, 0);
        const stub = stub_information_message();
        try {
            await vscode.commands.executeCommand('raven.runCurrentChunk');
        } finally {
            stub.restore();
        }
        assert.ok(
            stub.last && stub.last.includes('no R chunks'),
            `expected "no R chunks" info message, got: ${String(stub.last)}`,
        );
    });

    test('runCurrentChunk sends the chunk body to the R terminal', async () => {
        const r_console_disabled = !(await vscode.commands.getCommands(true))
            .includes('raven.runCurrentChunk');
        if (r_console_disabled) return;
        const editor = await open_rmd(RMD_FIXTURE);
        place_cursor(editor, 17); // inside the "second" R chunk
        const term = stub_create_terminal();
        try {
            await vscode.commands.executeCommand('raven.runCurrentChunk');
        } finally {
            term.restore();
        }
        const combined = term.sent.join('\n');
        // The send path may wrap multi-line payloads in bracketed paste markers or
        // a tempfile source() wrapper. Either way, the original chunk body should
        // appear somewhere in the captured text (with chunk-body lines preserved
        // or referenced via a temp-file source path). To keep the assertion
        // robust across send transports, just check that AT LEAST one of the
        // chunk's distinctive identifiers made it to the terminal.
        const observed_chunk_content =
            combined.includes('x <- 1') ||
            combined.includes('y <- 2') ||
            /source\((.+)\.R/.test(combined);
        assert.ok(
            observed_chunk_content,
            `expected chunk body to reach terminal, got: ${combined.slice(0, 200)}`,
        );
    });

    test('# %% cell mode in .R: selectCurrentChunk grabs the cell body', async () => {
        const editor = await open_rmd(R_CELL_FIXTURE);
        place_cursor(editor, 1); // inside cell "one"
        await vscode.commands.executeCommand('raven.selectCurrentChunk');
        const text = editor.document.getText(editor.selection);
        assert.strictEqual(text, 'a <- 1\nb <- 2');
    });
});
