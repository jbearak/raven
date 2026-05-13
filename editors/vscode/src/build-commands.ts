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
     * The R code sent to the selected terminal, parameterized by a
     * pre-quoted R-string-literal representing the package path
     * (e.g. `"\"/Users/foo/pkg\""` or `"\".\""`). `installAndRestart`
     * composes its code in `run_install_and_restart` instead.
     */
    make_code?: (pkg_arg: string) => string;
}

export const BUILD_COMMANDS: BuildCommand[] = [
    {
        id: 'raven.build.loadAll',
        title: 'Load All',
        target: 'r-console',
        make_code: (pkg) => `devtools::load_all(${pkg})`,
    },
    {
        id: 'raven.build.document',
        title: 'Document',
        target: 'r-console',
        make_code: (pkg) => `devtools::document(${pkg})`,
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
        make_code: (pkg) => `devtools::test(${pkg})`,
    },
    {
        id: 'raven.build.checkPackage',
        title: 'Check Package',
        target: 'tasks',
        make_code: (pkg) => `devtools::check(${pkg})`,
    },
    {
        id: 'raven.build.buildSource',
        title: 'Build Source Package',
        target: 'tasks',
        make_code: (pkg) => `devtools::build(${pkg})`,
    },
];

/**
 * Compute the R-string-literal argument passed to every devtools call.
 *
 * The terminal's working directory can drift away from the package root
 * (the user runs `setwd()`, or the terminal launches from a subdirectory),
 * which means a bare `devtools::load_all()` would silently target the
 * wrong project. Resolving the path against the first workspace folder
 * keeps the build commands anchored to the package Raven detected.
 *
 * Falls back to `"."` only when no workspace folder is open — that's the
 * `raven.packages.packageMode = "enabled"` escape hatch for users who
 * force package mode without a DESCRIPTION-bearing root, and matches
 * devtools' own default.
 *
 * `JSON.stringify` of an absolute path produces a valid R double-quoted
 * string literal: identical escape rules for `\` and `"`, so Windows
 * paths like `C:\foo\bar` round-trip safely.
 */
export function get_package_path_arg(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return '"."';
    return JSON.stringify(folder.uri.fsPath);
}

const TASKS_TERMINAL_NAME = 'R: Package Tasks';
let tasks_terminal: vscode.Terminal | null = null;
// Shared in-flight promise so two tasks-group commands fired in quick
// succession (e.g. Test Package immediately followed by Check Package)
// don't both pass the `tasks_terminal` null check around the
// `await resolve_program()` yield point and spawn two terminals. Mirrors
// the `creation_in_flight` guard in `r-terminal-manager.ts`.
let tasks_creation_in_flight: Promise<vscode.Terminal> | null = null;

function handle_tasks_terminal_closed(terminal: vscode.Terminal): void {
    if (terminal === tasks_terminal) {
        tasks_terminal = null;
    }
}

async function create_tasks_terminal(): Promise<vscode.Terminal> {
    const program = await resolve_program();
    const terminal = vscode.window.createTerminal({
        name: TASKS_TERMINAL_NAME,
        shellPath: program,
        shellArgs: ['--no-save', '--no-restore'],
        isTransient: true,
    });
    // `resolve_program()` can yield for seconds (shell `which` validation,
    // or a "Switch to R / Keep" dialog). If `raven.rTerminal.program`
    // changed during that window, the config handler cleared
    // `tasks_creation_in_flight`; don't cache this now-stale terminal —
    // the next call should launch a fresh one with the updated program.
    if (tasks_creation_in_flight !== null) {
        tasks_terminal = terminal;
    }
    return terminal;
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
    if (tasks_creation_in_flight) return tasks_creation_in_flight;
    tasks_creation_in_flight = create_tasks_terminal().finally(() => {
        tasks_creation_in_flight = null;
    });
    return tasks_creation_in_flight;
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
async function run_install_and_restart(
    context: vscode.ExtensionContext,
): Promise<void> {
    const terminal = await get_or_create_r_terminal();
    terminal.show(true);

    const pkg_arg = get_package_path_arg();
    const code = [
        'local({',
        `  status <- tryCatch({ devtools::install(${pkg_arg}); "ok" },`,
        '    error = function(e) conditionMessage(e))',
        '  if (!identical(status, "ok"))',
        '    message("Raven: install failed: ", status)',
        '  quit(save = "no")',
        '})',
    ].join('\n');

    // Self-disposing one-shot listener — but also tracked in
    // `context.subscriptions` so it's disposed if the extension deactivates
    // before the terminal closes (otherwise the callback would later fire
    // against a torn-down module and spawn an orphaned terminal).
    const restart_listener = vscode.window.onDidCloseTerminal((closed) => {
        if (closed !== terminal) return;
        restart_listener.dispose();
        // Recreate so the user's next Send-to-R / Build command lands in a
        // fresh R session loaded with the newly installed package.
        void get_or_create_r_terminal();
    });
    context.subscriptions.push(restart_listener);

    send_code(terminal, code, get_send_options());
}

async function run_build_command(
    cmd: BuildCommand,
    context: vscode.ExtensionContext,
): Promise<void> {
    if (cmd.id === 'raven.build.installAndRestart') {
        await run_install_and_restart(context);
        return;
    }
    if (!cmd.make_code) return;
    await run_simple(cmd.make_code(get_package_path_arg()), cmd.target);
}

export function register_build_commands(context: vscode.ExtensionContext): void {
    for (const cmd of BUILD_COMMANDS) {
        context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, () => run_build_command(cmd, context)),
        );
    }
    context.subscriptions.push(
        vscode.window.onDidCloseTerminal(handle_tasks_terminal_closed),
        // Mirror the `raven.rTerminal.program`-change behaviour in
        // `r-terminal-manager.ts`: clear the slot so the next build command
        // launches a fresh terminal with the newly-configured program. The
        // existing terminal keeps running so the user can read scrollback;
        // they close it themselves when they're done with it.
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('raven.rTerminal.program')) {
                tasks_terminal = null;
                tasks_creation_in_flight = null;
            }
        }),
    );
}

/** Reset the tasks-terminal slot. Tests only. */
export function _reset_tasks_terminal_for_test(): void {
    tasks_terminal = null;
    tasks_creation_in_flight = null;
}
