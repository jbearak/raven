import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { PlotServices } from '../plot';
import {
    build_terminal_env,
    generate_profile_source,
    RAVEN_PROFILE_FILENAME,
    write_profile_file,
    RavenPlotEnv,
} from '../plot/r-bootstrap-profile';
import * as path from 'path';
import {
    PendingProfileSession,
    _sweep_and_dequeue_session,
} from './pending-fifo';

export type { PendingProfileSession };
export { _sweep_and_dequeue_session };

const PROFILE_ID = 'raven.rTerminal';
const TERMINAL_NAME = 'R (Raven)';
const PENDING_TTL_MS = 30_000;

let plot_services: PlotServices | null = null;
let extension_context: vscode.ExtensionContext | null = null;
// Cache the in-flight (or completed) write promise rather than a "done" flag,
// so concurrent first calls in one activation share a single write instead of
// racing on the same temp path inside write_profile_file.
let profile_write_promise: Promise<void> | null = null;
let profile_written_for_storage_dir: string | null = null;

const profile_terminals = new Set<vscode.Terminal>();
let last_active_terminal: vscode.Terminal | null = null;
let creation_in_flight: Promise<vscode.Terminal> | null = null;
let pending_profile_creation_count = 0;
const pending_profile_session_ids: PendingProfileSession[] = [];
const terminal_to_session_id = new WeakMap<vscode.Terminal, string>();

function get_program(): string {
    const config = vscode.workspace.getConfiguration('raven.rTerminal');
    return config.get<string>('program', 'R');
}

const exec_async = promisify(exec);
const SAFE_PROGRAM_NAME = /^[A-Za-z0-9._-]+$/;
const SHELL_VALIDATION_TIMEOUT_MS = 5000;

// Per-session cache of validation outcomes, keyed by program name. `validated-ok`
// means the user's shell found it on PATH; `user-kept` means it wasn't found but
// the user opted to keep the setting anyway. Either way we don't reprompt this
// session. Cleared when raven.rTerminal.program changes.
type ValidationOutcome = 'validated-ok' | 'user-kept';
const validation_cache = new Map<string, ValidationOutcome>();

export function _reset_validation_cache_for_test(): void {
    validation_cache.clear();
}

// Probes for the program in the user's interactive-login shell, where rc-file
// PATH additions (conda, pyenv, asdf, homebrew shellenv) are visible — unlike
// the extension host's process.env.PATH. Returns false on missing/timeout.
async function shell_can_find_program(program: string): Promise<boolean> {
    if (process.platform === 'win32') return true; // skip; cmd/pwsh/wsl shells vary too much
    if (!SAFE_PROGRAM_NAME.test(program)) return false;
    const shell = process.env.SHELL ?? '/bin/sh';
    try {
        await exec_async(
            `${JSON.stringify(shell)} -ilc 'command -v ${program} >/dev/null 2>&1'`,
            { timeout: SHELL_VALIDATION_TIMEOUT_MS },
        );
        return true;
    } catch {
        return false;
    }
}

// Indirection for tests; production code uses shell_can_find_program.
let _validator: (program: string) => Promise<boolean> = shell_can_find_program;

export function _set_validator_for_test(
    v: ((program: string) => Promise<boolean>) | null,
): void {
    _validator = v ?? shell_can_find_program;
}

// Resolves the program to launch for an R terminal. For non-`R` configurations
// it validates via the user's shell and, if the program isn't found, prompts
// the user to switch to `R` for this machine. Picking "Switch to R" updates
// the Global (== per-machine in Remote-SSH) setting so the synced User default
// stays intact. Picking "Keep" lets the configured value through and lets VS
// Code surface its own launch failure.
export async function resolve_program(): Promise<string> {
    const configured = get_program();
    if (configured === 'R') return 'R';
    if (validation_cache.has(configured)) return configured;

    if (await _validator(configured)) {
        validation_cache.set(configured, 'validated-ok');
        return configured;
    }

    const SWITCH = 'Switch to R';
    const KEEP = 'Keep';
    const choice = await vscode.window.showWarningMessage(
        `Raven: '${configured}' was not found in your shell PATH. The R terminal will likely fail to launch. Switch to R on this machine?`,
        SWITCH,
        KEEP,
    );
    if (choice === SWITCH) {
        await vscode.workspace
            .getConfiguration('raven.rTerminal')
            .update('program', 'R', vscode.ConfigurationTarget.Global);
        return 'R';
    }
    validation_cache.set(configured, 'user-kept');
    return configured;
}

async function get_plot_terminal_env(): Promise<{ env: RavenPlotEnv; sessionId: string } | null> {
    if (!plot_services || !extension_context) return null;
    const ok = await plot_services.ensureStarted();
    if (!ok) return null;

    const sessionId = crypto.randomUUID();
    const storage_uri = extension_context.globalStorageUri;
    const storage_dir = storage_uri.fsPath;
    const profile_path = path.join(storage_dir, RAVEN_PROFILE_FILENAME);
    // generate_profile_source() returns static content; write once per activation.
    if (profile_written_for_storage_dir !== storage_dir) {
        if (!profile_write_promise) {
            profile_write_promise = write_profile_file(storage_dir, generate_profile_source())
                .then(() => { profile_written_for_storage_dir = storage_dir; })
                .catch(err => { profile_write_promise = null; throw err; });
        }
        await profile_write_promise;
    }

    const previous = process.env.R_PROFILE_USER;
    const env = build_terminal_env({
        profile_path,
        session_port: plot_services.server.port,
        session_token: plot_services.server.token,
        r_session_id: sessionId,
        previous_r_profile_user: previous && previous.length > 0 ? previous : undefined,
    });
    return { env, sessionId };
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
        const next_id = _sweep_and_dequeue_session(pending_profile_session_ids, Date.now(), PENDING_TTL_MS);
        if (next_id) terminal_to_session_id.set(terminal, next_id);
    }
}

function handle_terminal_closed(terminal: vscode.Terminal): void {
    profile_terminals.delete(terminal);
    const sid = terminal_to_session_id.get(terminal);
    if (sid && plot_services) {
        plot_services.server.markSessionEnded(sid);
    }
    terminal_to_session_id.delete(terminal);
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
    context: vscode.ExtensionContext,
    services: PlotServices,
): void {
    extension_context = context;
    plot_services = services;
    const provider: vscode.TerminalProfileProvider = {
        async provideTerminalProfile(
            token: vscode.CancellationToken
        ): Promise<vscode.TerminalProfile> {
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }
            const program = await resolve_program();
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }
            const plot_env = await get_plot_terminal_env();
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }
            const profile = new vscode.TerminalProfile({
                name: TERMINAL_NAME,
                shellPath: program,
                shellArgs: ['--no-save', '--no-restore'],
                env: plot_env?.env,
            });
            if (plot_env) {
                pending_profile_session_ids.push({
                    sessionId: plot_env.sessionId,
                    programName: program,
                    generatedAtMs: Date.now(),
                });
            }
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
                profile_terminals.clear();
                last_active_terminal = null;
                validation_cache.clear();
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
    const program = await resolve_program();
    const plot_env = await get_plot_terminal_env();
    const terminal = vscode.window.createTerminal({
        name: TERMINAL_NAME,
        shellPath: program,
        shellArgs: ['--no-save', '--no-restore'],
        env: plot_env?.env,
    });
    profile_terminals.add(terminal);
    last_active_terminal = terminal;
    if (plot_env) terminal_to_session_id.set(terminal, plot_env.sessionId);
    return terminal;
}
