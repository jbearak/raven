import * as vscode from 'vscode';
import {
    get_or_create_r_terminal,
    resolve_program,
    send_code,
    get_send_options,
} from './send-to-r';

/**
 * "Raven Build:" commands — wrappers around the standard devtools workflows
 * (load_all, document, install, test, check, build). Names and behaviour
 * mirror RStudio's Build menu so users with existing muscle memory find what
 * they expect.
 *
 * Terminal routing:
 *   - `Load All`, `Document`, `Install and Restart` run in the active R
 *     terminal (the same one used by Send-to-R). Side effects on the
 *     interactive session are the point of these commands.
 *   - `Test Package`, `Check Package`, `Build Source Package` run in a
 *     dedicated "R: Package Tasks" terminal so they don't tie up the
 *     interactive prompt for the 20-60s+ they take.
 */

export interface BuildCommand {
    id: string;
    /** Palette title (without the "Raven Build:" prefix). */
    title: string;
    /** Where the command runs. */
    target: 'r-console' | 'tasks';
    /**
     * The R code sent to the selected terminal. For `installAndRestart` this
     * is composed dynamically (see `run_install_and_restart`).
     */
    code?: string;
}

export const BUILD_COMMANDS: BuildCommand[] = [
    {
        id: 'raven.build.loadAll',
        title: 'Load All',
        target: 'r-console',
        code: 'devtools::load_all()',
    },
    {
        id: 'raven.build.document',
        title: 'Document',
        target: 'r-console',
        code: 'devtools::document()',
    },
    {
        id: 'raven.build.installAndRestart',
        title: 'Install and Restart',
        target: 'r-console',
    },
    {
        id: 'raven.build.testPackage',
        title: 'Test Package',
        target: 'tasks',
        code: 'devtools::test()',
    },
    {
        id: 'raven.build.checkPackage',
        title: 'Check Package',
        target: 'tasks',
        code: 'devtools::check()',
    },
    {
        id: 'raven.build.buildSource',
        title: 'Build Source Package',
        target: 'tasks',
        code: 'devtools::build()',
    },
];

const TASKS_TERMINAL_NAME = 'R: Package Tasks';
let tasks_terminal: vscode.Terminal | null = null;

function handle_tasks_terminal_closed(terminal: vscode.Terminal): void {
    if (terminal === tasks_terminal) {
        tasks_terminal = null;
    }
}

/**
 * Get-or-create the dedicated package-tasks terminal. Parallel to the
 * Send-to-R terminal slot: reuses `resolve_program()` so the user's
 * `raven.rTerminal.program` carries over, and uses `isTransient: true` to
 * opt out of VS Code's terminal restoration (a window restore would replay
 * scrollback into a fresh R process with no shared state).
 */
export async function get_or_create_tasks_terminal(): Promise<vscode.Terminal> {
    if (tasks_terminal) return tasks_terminal;
    const program = await resolve_program();
    tasks_terminal = vscode.window.createTerminal({
        name: TASKS_TERMINAL_NAME,
        shellPath: program,
        shellArgs: ['--no-save', '--no-restore'],
        isTransient: true,
    });
    return tasks_terminal;
}

async function run_simple(code: string, target: 'r-console' | 'tasks'): Promise<void> {
    const terminal = target === 'r-console'
        ? await get_or_create_r_terminal()
        : await get_or_create_tasks_terminal();
    terminal.show(true);
    send_code(terminal, code, get_send_options());
}

/**
 * `Install and Restart`: install the package, then end the R session so a
 * fresh R is launched on next use. VS Code's stable terminal API doesn't
 * expose terminal output, so we can't watch for a sentinel — instead we
 * append `quit(save = "no")` to the install call. R exits when install
 * completes (or errors), and a one-shot close listener spawns a new R
 * terminal in the same pane.
 *
 * `tryCatch` keeps `quit()` running even if install fails, so the user
 * never ends up stuck in a broken half-restarted state. Failure output
 * remains visible in the closed-terminal scrollback.
 */
async function run_install_and_restart(): Promise<void> {
    const terminal = await get_or_create_r_terminal();
    terminal.show(true);

    const code = [
        'local({',
        '  status <- tryCatch({ devtools::install(); "ok" },',
        '    error = function(e) conditionMessage(e))',
        '  if (!identical(status, "ok"))',
        '    message("Raven: install failed: ", status)',
        '  quit(save = "no")',
        '})',
    ].join('\n');

    const restart_listener = vscode.window.onDidCloseTerminal((closed) => {
        if (closed !== terminal) return;
        restart_listener.dispose();
        // Recreate so the user's next Send-to-R / Build command lands in a
        // fresh R session loaded with the newly installed package.
        void get_or_create_r_terminal();
    });

    send_code(terminal, code, get_send_options());
}

async function run_build_command(cmd: BuildCommand): Promise<void> {
    if (cmd.id === 'raven.build.installAndRestart') {
        await run_install_and_restart();
        return;
    }
    if (!cmd.code) return;
    await run_simple(cmd.code, cmd.target);
}

export function register_build_commands(context: vscode.ExtensionContext): void {
    for (const cmd of BUILD_COMMANDS) {
        context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, () => run_build_command(cmd)),
        );
    }
    context.subscriptions.push(
        vscode.window.onDidCloseTerminal(handle_tasks_terminal_closed),
    );
}

/** Reset the tasks-terminal slot. Tests only. */
export function _reset_tasks_terminal_for_test(): void {
    tasks_terminal = null;
}
