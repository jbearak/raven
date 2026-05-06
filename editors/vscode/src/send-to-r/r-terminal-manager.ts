import * as vscode from 'vscode';

const PROFILE_ID = 'raven.rTerminal';
const TERMINAL_NAME = 'R (Raven)';

const profile_terminals = new Set<vscode.Terminal>();
let last_active_terminal: vscode.Terminal | null = null;
let creation_in_flight: Promise<vscode.Terminal> | null = null;
let pending_profile_creation_count = 0;

function get_program(): string {
    const config = vscode.workspace.getConfiguration('raven.rTerminal');
    return config.get<string>('program', 'R');
}

function handle_terminal_opened(terminal: vscode.Terminal): void {
    if (
        pending_profile_creation_count > 0
        && terminal.name === TERMINAL_NAME
        && !profile_terminals.has(terminal)
    ) {
        pending_profile_creation_count--;
        profile_terminals.add(terminal);
        last_active_terminal = terminal;
    }
}

function handle_terminal_closed(terminal: vscode.Terminal): void {
    profile_terminals.delete(terminal);
    if (last_active_terminal === terminal) {
        last_active_terminal = null;
        for (const t of profile_terminals) {
            last_active_terminal = t;
        }
    }
}

function handle_active_terminal_changed(
    terminal: vscode.Terminal | undefined
): void {
    if (terminal && profile_terminals.has(terminal)) {
        last_active_terminal = terminal;
    }
}

export function register_r_terminal(
    context: vscode.ExtensionContext
): void {
    const provider: vscode.TerminalProfileProvider = {
        async provideTerminalProfile(
            token: vscode.CancellationToken
        ): Promise<vscode.TerminalProfile> {
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }
            const profile = new vscode.TerminalProfile({
                name: TERMINAL_NAME,
                shellPath: get_program(),
                shellArgs: ['--no-save', '--no-restore'],
            });
            pending_profile_creation_count++;
            return profile;
        }
    };

    context.subscriptions.push(
        vscode.window.registerTerminalProfileProvider(PROFILE_ID, provider),
        vscode.window.onDidOpenTerminal(handle_terminal_opened),
        vscode.window.onDidCloseTerminal(handle_terminal_closed),
        vscode.window.onDidChangeActiveTerminal(handle_active_terminal_changed),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('raven.rTerminal.program')) {
                // Untrack existing terminals so the next send spawns one with the
                // new program. Terminals are left alive so the user can finish
                // whatever they were doing in them.
                profile_terminals.clear();
                last_active_terminal = null;
            }
        }),
    );
}

export async function get_or_create_r_terminal(): Promise<vscode.Terminal> {
    if (last_active_terminal) {
        return last_active_terminal;
    }
    if (creation_in_flight) {
        return creation_in_flight;
    }
    creation_in_flight = create_r_terminal().finally(() => {
        creation_in_flight = null;
    });
    return creation_in_flight;
}

async function create_r_terminal(): Promise<vscode.Terminal> {
    const terminal = vscode.window.createTerminal({
        name: TERMINAL_NAME,
        shellPath: get_program(),
        shellArgs: ['--no-save', '--no-restore'],
    });
    profile_terminals.add(terminal);
    last_active_terminal = terminal;
    return terminal;
}
