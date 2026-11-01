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
import { PendingProfile, take_pending_profile, TERMINAL_ID_ENV } from './pending-profiles';
import {
    console_socket_of,
    forget_console_terminal,
    make_console_socket_path,
    register_console_terminal,
} from './console-ipc';
import {
    ConsoleTarget,
    effective_target,
    is_terminal_program,
    keep_session_choice_after_setting_change,
    parse_program_setting,
    ProgramSetting,
    terminal_name_for,
    TerminalProgram,
} from './console-choice';
import {
    ConsolePick,
    PickerOptions,
    show_console_picker,
    target_label,
} from './console-picker';
import type { PerchApiV1, SessionInfo } from './perch-api';
import {
    _connect_perch_for_test,
    perch_for_new_console,
    perch_lookup_settled,
    usable_perch,
    perch_session_of,
    perch_sessions_open_here,
    PerchDeps,
    PerchHandlers,
    start_perch,
    track_perch_terminal,
    untrack_perch_terminal,
} from './perch';
import {
    escape_perch_env,
    escape_perch_text,
    is_ended,
    PERCH_CONSOLE_SOCKET,
    PERCH_R_KIND,
    perch_annotations,
    RAVEN_CALLER_ID,
    reattach_candidates,
    session_console_socket,
    session_program,
} from './perch-sessions';

/**
 * Raven-managed R terminals and which console sends go to.
 *
 * `raven.rTerminal.program` is `ask` (default) or a fixed target. The
 * effective target is the session choice (set by the console picker) if any,
 * else the setting; see `effective_target`. A choice is authoritative: sends
 * only reuse a managed terminal running the chosen program, never one that
 * merely was active more recently.
 *
 * In a remote window with Perch installed next to Raven, new R terminals run
 * in Perch sessions, which survive a closed window or dropped connection. In
 * any window with Perch, Perch's list of new terminals can start one too
 * (`new_console_in_perch`). See `perch.ts` for when and the invariants. A
 * Perch terminal is managed like any other while it is open in this window.
 */

const PROFILE_ID = 'raven.rTerminal';
const PENDING_TTL_MS = 30_000;

let plot_services: PlotServices | null = null;
let server_path_getter: (() => string) | null = null;
let extension_context: vscode.ExtensionContext | null = null;
// Cache the in-flight (or completed) write promise rather than a "done" flag,
// so concurrent first calls in one activation share a single write instead of
// racing on the same temp path inside write_profile_file.
let profile_write_promise: Promise<void> | null = null;
let profile_written_for_storage_dir: string | null = null;

// Every live Raven-managed terminal and the program it runs. Map order is
// recency: `touch` moves a terminal to the end when it becomes active.
const managed_terminals = new Map<vscode.Terminal, TerminalProgram>();
const creation_in_flight = new Map<TerminalProgram, Promise<vscode.Terminal>>();
// Profile launches VS Code hasn't opened yet, keyed by RAVEN_TERMINAL_ID.
const pending_profiles = new Map<string, PendingProfile>();
const terminal_to_session_id = new WeakMap<vscode.Terminal, string>();
/**
 * Perch sessions this activation started, by Perch session ID: what each
 * runs and its plot/data-viewer session. A session not in here was started
 * by an earlier activation, whose plot server is gone.
 */
const launched_here = new Map<string, { program: TerminalProgram; plot_session_id?: string }>();
let stale_plots_notice_shown = false;
// Perch terminals (from the profile or Perch's list) whose session hasn't
// been reported yet; a new console waits for them rather than start a second.
const perch_profiles_starting = new Set<Promise<void>>();

// What the user picked this session; beats the setting. In memory only.
let session_choice: ConsoleTarget | null = null;
// At most one picker is open; other callers wait for it, then re-resolve.
let open_picker: Promise<ConsolePick | undefined> | null = null;

/** `raven.rTerminal.program` value for Raven's built-in console. */
export const RAVEN_CONSOLE_PROGRAM: TerminalProgram = 'raven';

function read_program_setting(): ProgramSetting {
    return parse_program_setting(
        vscode.workspace.getConfiguration('raven.rTerminal').get<string>('program'),
    );
}

/** The target sends use right now, or `undefined` to ask. */
export function current_target(): ConsoleTarget | undefined {
    return effective_target(session_choice, read_program_setting());
}

function touch(terminal: vscode.Terminal): void {
    const program = managed_terminals.get(terminal);
    if (program === undefined) return;
    managed_terminals.delete(terminal);
    managed_terminals.set(terminal, program);
}

function most_recent(
    accept: (terminal: vscode.Terminal, program: TerminalProgram) => boolean = () => true,
): vscode.Terminal | undefined {
    const entries = Array.from(managed_terminals);
    for (let i = entries.length - 1; i >= 0; i--) {
        if (accept(entries[i][0], entries[i][1])) return entries[i][0];
    }
    return undefined;
}

/** The program a managed terminal runs, or undefined for other terminals. */
export function terminal_program_of(terminal: vscode.Terminal): TerminalProgram | undefined {
    return managed_terminals.get(terminal);
}

/**
 * The program a terminal opened without asking would run, without prompting:
 * the effective target if it's a terminal program, else Raven's console.
 */
export function terminal_program_now(): TerminalProgram {
    const target = current_target();
    return is_terminal_program(target) ? target : RAVEN_CONSOLE_PROGRAM;
}

/** The managed terminal whose R reports as plot/data-viewer `session_id`. */
export function terminal_for_session(session_id: string): vscode.Terminal | undefined {
    for (const terminal of managed_terminals.keys()) {
        if (terminal_to_session_id.get(terminal) === session_id) return terminal;
    }
    return undefined;
}

async function apply_pick(pick: ConsolePick): Promise<void> {
    session_choice = pick.target;
    if (pick.scope !== 'all') return;
    const config = vscode.workspace.getConfiguration('raven.rTerminal');
    try {
        await config.update('program', pick.target, vscode.ConfigurationTarget.Global);
    } catch (err) {
        // The session choice already holds, so the send goes ahead.
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showWarningMessage(
            `Raven: couldn't save raven.rTerminal.program to your user settings (${message}). Raven uses ${target_label(pick.target)} for this session.`,
        );
        return;
    }
    const inspected = config.inspect<string>('program');
    if (inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined) {
        void vscode.window.showWarningMessage(
            `Raven: this workspace sets raven.rTerminal.program, which overrides your user setting. Raven uses ${target_label(pick.target)} for the rest of this session.`,
        );
    }
}

function open_console_picker(options: PickerOptions): Promise<ConsolePick | undefined> {
    const picking: Promise<ConsolePick | undefined> = (async () => {
        const pick = await show_console_picker(options);
        if (pick) await apply_pick(pick);
        return pick;
    })().finally(() => {
        if (open_picker === picking) open_picker = null;
    });
    open_picker = picking;
    return picking;
}

/**
 * **Raven: Choose R Console**. Sets the session choice (and the setting, for
 * "All sessions"); existing terminals keep running, and the next send goes to
 * a terminal running the new choice. Joins a picker that is already open.
 */
export async function choose_r_console(): Promise<ConsolePick | undefined> {
    if (open_picker) return open_picker;
    return open_console_picker({ include_vscode_r: true });
}

/** Where a send goes. */
export type SendTarget =
    | { kind: 'terminal'; terminal: vscode.Terminal }
    | { kind: 'vscode-r' };

/**
 * Where code sent from the editor goes, asking if no console is chosen.
 * Returns null when the user cancels the picker.
 *
 * With no choice and no `ask`-overriding setting, a live managed terminal
 * (opened from the profile dropdown or by the debugger) is used without
 * asking: opening it was the choice.
 */
export async function resolve_send_target(): Promise<SendTarget | null> {
    for (;;) {
        if (open_picker) {
            if (!(await open_picker)) return null;
            continue;
        }
        const target = current_target();
        if (target === undefined) {
            const recent = most_recent();
            if (recent) return { kind: 'terminal', terminal: recent };
            if (!(await open_console_picker({ include_vscode_r: true }))) return null;
            continue;
        }
        if (target === 'vscode-R') return { kind: 'vscode-r' };
        try {
            return { kind: 'terminal', terminal: await get_or_create_terminal_for(target) };
        } catch (err) {
            if (err instanceof vscode.CancellationError) return null;
            throw err;
        }
    }
}

/**
 * Program for the terminal profile dropdown: the effective target if it's a
 * terminal program, else the picker without vscode-R (which isn't a program
 * Raven can launch). Throws `CancellationError` when the user cancels.
 */
async function resolve_profile_program(): Promise<TerminalProgram> {
    for (;;) {
        if (open_picker) {
            if (!(await open_picker)) throw new vscode.CancellationError();
            continue;
        }
        const target = current_target();
        if (is_terminal_program(target)) return launch_program_for(target);
        if (!(await open_console_picker({ include_vscode_r: false }))) {
            throw new vscode.CancellationError();
        }
    }
}

/** Test-only: reset the session choice and any open picker. */
export function _reset_console_choice_for_test(): void {
    session_choice = null;
    open_picker = null;
}

/** Test-only: the session choice. */
export function _session_choice_for_test(): ConsoleTarget | null {
    return session_choice;
}

/**
 * Applies a `raven.rTerminal.program` change: drops the session choice unless
 * it matches the new value (see `keep_session_choice_after_setting_change`).
 * Managed terminals stay tracked; sends pick among them by program.
 */
export function _on_program_setting_changed(): void {
    const config = vscode.workspace.getConfiguration('raven.rTerminal');
    if (!keep_session_choice_after_setting_change(
        session_choice,
        config.inspect<string>('program')?.globalValue,
        config.get<string>('program'),
    )) {
        session_choice = null;
    }
    session_user_kept.clear();
}

/** How to launch an R terminal for a resolved program. */
export type RTerminalLaunch = {
    shellPath: string;
    shellArgs: string[];
    /** Set when the terminal runs Raven's console: where it listens for code. */
    consoleSocket?: string;
};

/**
 * Launch spec for `program` (a `resolve_program()` result). Raven's console is
 * the bundled server binary's `console` subcommand; it finds R itself and
 * falls back to plain R if it can't embed it, so it needs no PATH check.
 */
export function build_r_terminal_launch(program: string): RTerminalLaunch {
    if (program !== RAVEN_CONSOLE_PROGRAM || !server_path_getter) {
        return { shellPath: program, shellArgs: R_ARGS };
    }
    const socket = make_console_socket_path();
    return {
        shellPath: server_path_getter(),
        shellArgs: console_args(socket, (s) => s),
        consoleSocket: socket,
    };
}

const R_ARGS = ['--no-save', '--no-restore'];

/**
 * Arguments of Raven's console listening on `socket`. `literal` wraps each
 * argument that comes from settings rather than from Raven.
 */
function console_args(socket: string, literal: (s: string) => string): string[] {
    const config = vscode.workspace.getConfiguration('raven.console');
    // The debugger's DAP socket sits next to the IPC socket (see
    // debugger/index.ts `dap_socket_for`).
    const dap = vscode.workspace.getConfiguration('raven.debugger').get<boolean>('enabled', true)
        ? ['--dap', path.join(path.dirname(socket), 'd')]
        : [];
    return [
        'console',
        '--ipc', socket,
        ...dap,
        '--edit-mode', literal(config.get<string>('editMode', 'emacs')),
        '--color-output', literal(config.get<string>('colorOutput', 'streams')),
        ...R_ARGS,
    ];
}

/**
 * The `command` of a Perch session running `program`. Raven's console
 * listens in the session directory (`{dir}/ipc`, DAP at `{dir}/d`); every
 * other argument is escaped so Perch passes it literally.
 */
export function build_perch_r_command(program: TerminalProgram): { command: string[]; console_socket: boolean } {
    if (program !== RAVEN_CONSOLE_PROGRAM || !server_path_getter) {
        return { command: [escape_perch_text(program), ...R_ARGS], console_socket: false };
    }
    return {
        command: [escape_perch_text(server_path_getter()), ...console_args(PERCH_CONSOLE_SOCKET, escape_perch_text)],
        console_socket: true,
    };
}

/** Describes a Perch session for `program`, remembering it as started here. */
function prepare_perch_launch(
    api: PerchApiV1,
    program: TerminalProgram,
    plot_env: { env: RavenPlotEnv; sessionId: string } | null,
): { id: string; options: vscode.TerminalOptions } {
    const { command, console_socket } = build_perch_r_command(program);
    const launch = api.prepareLaunch({
        name: terminal_name_for(program),
        kind: PERCH_R_KIND,
        command,
        env: escape_perch_env(plot_env?.env),
        annotations: perch_annotations(program, console_socket),
    });
    launched_here.set(launch.id, { program, plot_session_id: plot_env?.sessionId });
    return launch;
}

const exec_async = promisify(exec);
const SAFE_PROGRAM_NAME = /^[A-Za-z0-9._-]+$/;
const SHELL_VALIDATION_TIMEOUT_MS = 5000;

// Per-machine "shell found this program" record (ExtensionContext.globalState,
// which doesn't sync). Only successes are persisted: once the shell has
// validated a program on this machine, we never re-spawn the shell to check
// again. Failures are not persisted — next session we re-validate, in case
// the user has since installed the program.
const VALIDATED_KEY_PREFIX = 'rTerminal.programValidated.';

function is_program_validated_on_this_machine(program: string): boolean {
    return extension_context?.globalState.get<boolean>(VALIDATED_KEY_PREFIX + program) === true;
}

/**
 * Test-only setter. The bundled extension sets `extension_context` from its
 * own copy of this module (esbuild inlines the source). The test runner
 * imports a SEPARATE compiled copy from `out/`, whose `extension_context`
 * is never written by the bundle. Tests that exercise the persistence path
 * must wire `extension_context` themselves via this setter.
 */
export function _set_extension_context_for_test(
    ctx: vscode.ExtensionContext | null,
): void {
    extension_context = ctx;
}

async function persist_program_validated(program: string): Promise<void> {
    await extension_context?.globalState.update(VALIDATED_KEY_PREFIX + program, true);
}

// Per-session: the user opted to keep a program we couldn't find. Don't
// re-prompt for the rest of this session; next session we'll re-check.
const session_user_kept = new Set<string>();

export async function _clear_validation_state_for_test(): Promise<void> {
    session_user_kept.clear();
    const ctx = extension_context;
    if (!ctx) return;
    for (const key of ctx.globalState.keys()) {
        if (key.startsWith(VALIDATED_KEY_PREFIX)) {
            await ctx.globalState.update(key, undefined);
        }
    }
}

/**
 * Test-only: forget any cached terminal so the next `get_or_create_r_terminal()`
 * goes through the full creation path. Used by integration suites that follow
 * a suite which stubbed `vscode.window.createTerminal` and left the bundled
 * extension caching a fake terminal whose `dispose()` is a no-op and which is
 * invisible to `vscode.window.onDidCloseTerminal`. Without this hook the cache
 * survives forever and downstream tests that need a real R session fail with
 * a 60-second timeout because their `sendText` lands in the dead stub.
 */
export function _dispose_cached_r_terminal_for_test(): void {
    managed_terminals.clear();
    creation_in_flight.clear();
    pending_profiles.clear();
    launched_here.clear();
    perch_profiles_starting.clear();
    stale_plots_notice_shown = false;
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

// Checks that an explicitly configured program can launch. Once a program has been
// shell-validated on this machine, persisted state short-circuits everything
// and we never re-spawn the shell. Otherwise we re-validate on every launch:
// the user may have installed the program mid-session, and the next launch
// should pick that up and persist. If validation still fails, we prompt at
// most once per session — Switch-to-R updates the Global (== per-machine in
// Remote-SSH) setting so the synced User default stays intact; Keep / dismiss
// proceeds with the configured value and VS Code surfaces any real launch
// failure (e.g. for setups where terminal.integrated.env.* extends PATH only
// inside the terminal).
async function validate_program(configured: TerminalProgram): Promise<TerminalProgram> {
    if (configured === 'R') return 'R';
    // Raven's console is bundled (no PATH check).
    if (configured === RAVEN_CONSOLE_PROGRAM) return RAVEN_CONSOLE_PROGRAM;
    if (is_program_validated_on_this_machine(configured)) return configured;

    if (await _validator(configured)) {
        await persist_program_validated(configured);
        return configured;
    }

    // Validator failed. If the user already answered this session, proceed
    // silently — but we still re-ran the validator above, so a mid-session
    // install gets picked up and persisted.
    if (session_user_kept.has(configured)) return configured;

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
    session_user_kept.add(configured);
    return configured;
}

/**
 * Program to launch for a target. A picked target was already found on PATH
 * (or is Raven's console / plain R), so only a program that comes from the
 * setting goes through the not-found prompt.
 */
async function launch_program_for(target: TerminalProgram): Promise<TerminalProgram> {
    if (session_choice === target) return target;
    return validate_program(target);
}

/**
 * Program for a new terminal opened without asking (the package-tasks
 * terminal, test hooks): the effective target if it's a terminal program,
 * else Raven's console.
 */
export async function resolve_program(): Promise<TerminalProgram> {
    return launch_program_for(terminal_program_now());
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
    const data_viewer_dir = path.join(storage_dir, 'data-viewer');
    const env = build_terminal_env({
        profile_path,
        session_port: plot_services.server.port,
        session_token: plot_services.server.token,
        r_session_id: sessionId,
        previous_r_profile_user: previous && previous.length > 0 ? previous : undefined,
        data_viewer_dir,
    });
    return { env, sessionId };
}

function handle_terminal_opened(terminal: vscode.Terminal): void {
    const options = terminal.creationOptions as vscode.TerminalOptions;
    const id = options.env?.[TERMINAL_ID_ENV];
    const entry = take_pending_profile(
        pending_profiles,
        typeof id === 'string' ? id : undefined,
        Date.now(),
        PENDING_TTL_MS,
    );
    if (!entry) return;
    if (entry.perch) {
        // Its console socket is in the session directory, known once Perch
        // reports the session.
        const api = entry.perch;
        const starting = api.waitForSession(id as string, terminal).then(
            (session) => adopt_perch_terminal(session, terminal, api),
            (err) => report_perch_start_failure(err),
        );
        perch_profiles_starting.add(starting);
        void starting.finally(() => perch_profiles_starting.delete(starting));
        return;
    }
    managed_terminals.set(terminal, entry.program);
    if (entry.sessionId) terminal_to_session_id.set(terminal, entry.sessionId);
    if (entry.consoleSocket) register_console_terminal(terminal, entry.consoleSocket);
}

/** Test-only: record a pending profile launch, as `provideTerminalProfile` does. */
export function _add_pending_profile_for_test(id: string, entry: PendingProfile): void {
    pending_profiles.set(id, entry);
}

/** Test-only: run the `onDidOpenTerminal` handler. */
export function _handle_terminal_opened_for_test(terminal: vscode.Terminal): void {
    handle_terminal_opened(terminal);
}

/** Test-only: run the `onDidCloseTerminal` handler. */
export function _handle_terminal_closed_for_test(terminal: vscode.Terminal): void {
    handle_terminal_closed(terminal);
}

/** Test-only: where Raven's server binary is (activation sets it). */
export function _set_server_path_for_test(get: (() => string) | null): void {
    server_path_getter = get;
}

function handle_terminal_closed(terminal: vscode.Terminal): void {
    // Closing a Perch terminal only detaches it: R keeps running, so its plot
    // session stays open until `perch_session_ended`.
    const detached = perch_session_of(terminal) !== undefined;
    untrack_perch_terminal(terminal);
    managed_terminals.delete(terminal);
    forget_console_terminal(terminal);
    const sid = terminal_to_session_id.get(terminal);
    if (sid && plot_services && !detached) {
        plot_services.server.markSessionEnded(sid);
    }
    terminal_to_session_id.delete(terminal);
}

/**
 * Manages a Perch terminal of this window attached to one of Raven's
 * sessions: one Raven started, one Perch reopened after a reload, or one
 * the user reattached. Runs again for the same terminal harmlessly.
 */
function adopt_perch_terminal(session: SessionInfo, terminal: vscode.Terminal, api: PerchApiV1): void {
    if (managed_terminals.has(terminal) || is_ended(session) || session.owner !== RAVEN_CALLER_ID) return;
    const launched = launched_here.get(session.id);
    track_perch_terminal(terminal, session.id, api);
    managed_terminals.set(terminal, launched?.program ?? session_program(session));
    const socket = session_console_socket(session);
    if (socket) register_console_terminal(terminal, socket, { owns_dir: false });
    if (launched?.plot_session_id) terminal_to_session_id.set(terminal, launched.plot_session_id);
    if (!launched) show_stale_plots_notice();
}

/**
 * A console started by an earlier activation posts plots and `View()` data
 * to that activation's server, which is gone. Say so once rather than let
 * them vanish.
 */
function show_stale_plots_notice(): void {
    if (stale_plots_notice_shown) return;
    stale_plots_notice_shown = true;
    void vscode.window.showInformationMessage(
        'Raven: reconnected to an R console that kept running in Perch. Its plots and data viewer ' +
        "won't show in this window until you restart that console (quit R, then send code again).",
    );
}

function perch_session_ended(session: SessionInfo): void {
    for (const terminal of [...managed_terminals.keys()]) {
        if (perch_session_of(terminal) === session.id) {
            untrack_perch_terminal(terminal);
            managed_terminals.delete(terminal);
            forget_console_terminal(terminal);
            terminal_to_session_id.delete(terminal);
        }
    }
    const launched = launched_here.get(session.id);
    launched_here.delete(session.id);
    if (launched?.plot_session_id && plot_services) {
        plot_services.server.markSessionEnded(launched.plot_session_id);
    }
}

const perch_handlers: PerchHandlers = { attached: adopt_perch_terminal, ended: perch_session_ended };

/** Test-only: look Perch up with fake dependencies, as activation does. */
export function _connect_perch_for_r_terminals_for_test(deps: PerchDeps): Promise<void> {
    return _connect_perch_for_test(deps, perch_handlers);
}

function report_perch_start_failure(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Raven: the R console didn't start in a Perch session (${message}).`);
}

/** The **R** terminal profile: Raven's console, or the chosen program. */
async function provide_r_terminal_profile(token: vscode.CancellationToken): Promise<vscode.TerminalProfile> {
    if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
    }
    const program = await resolve_profile_program();
    if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
    }
    const plot_env = await get_plot_terminal_env();
    if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
    }
    const perch_profile = await profile_in_perch(program, plot_env);
    if (perch_profile) return perch_profile;
    const launch = build_r_terminal_launch(program);
    // VS Code opens this terminal itself; the id in its environment is
    // how `handle_terminal_opened` recognizes it.
    const id = crypto.randomUUID();
    const profile = new vscode.TerminalProfile({
        name: terminal_name_for(program),
        shellPath: launch.shellPath,
        shellArgs: launch.shellArgs,
        env: { ...plot_env?.env, [TERMINAL_ID_ENV]: id },
        isTransient: true,
    });
    pending_profiles.set(id, {
        program,
        consoleSocket: launch.consoleSocket,
        sessionId: plot_env?.sessionId,
        generatedAtMs: Date.now(),
    });
    return profile;
}

/** Test-only: what the **R** terminal profile would open now. */
export function _provide_r_terminal_profile_for_test(): Promise<vscode.TerminalProfile> {
    return provide_r_terminal_profile(new vscode.CancellationTokenSource().token);
}

export function register_r_terminal(
    context: vscode.ExtensionContext,
    services: PlotServices,
    get_server_path: () => string,
): void {
    extension_context = context;
    plot_services = services;
    server_path_getter = get_server_path;
    const provider: vscode.TerminalProfileProvider = { provideTerminalProfile: provide_r_terminal_profile };

    start_perch(context, perch_handlers);
    context.subscriptions.push(
        vscode.window.registerTerminalProfileProvider(PROFILE_ID, provider),
        vscode.window.onDidOpenTerminal(handle_terminal_opened),
        vscode.window.onDidCloseTerminal(handle_terminal_closed),
        vscode.window.onDidChangeActiveTerminal(terminal => {
            if (terminal) touch(terminal);
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('raven.rTerminal.program')) {
                _on_program_setting_changed();
            }
        }),
    );
}

/**
 * A terminal profile running `program` in a Perch session, or null for an
 * ordinary terminal (no Perch, or Perch can't prepare one).
 */
async function profile_in_perch(
    program: TerminalProgram,
    plot_env: { env: RavenPlotEnv; sessionId: string } | null,
): Promise<vscode.TerminalProfile | null> {
    const api = await perch_for_new_console();
    if (!api) return null;
    let launch: { id: string; options: vscode.TerminalOptions };
    try {
        launch = prepare_perch_launch(api, program, plot_env);
    } catch (err) {
        console.warn('raven: Perch could not prepare a session; using an ordinary terminal:', err);
        return null;
    }
    // The Perch session ID doubles as the pending-profile ID.
    pending_profiles.set(launch.id, {
        program,
        sessionId: plot_env?.sessionId,
        generatedAtMs: Date.now(),
        perch: api,
    });
    return new vscode.TerminalProfile({
        ...launch.options,
        env: { ...launch.options.env, [TERMINAL_ID_ENV]: launch.id },
    });
}

/**
 * The most recent managed terminal running `program`, else a new one. With
 * Perch, a running session of `program` with no terminal in this window
 * (closed, or left by an earlier window) is offered first.
 * Throws `CancellationError` when the user dismisses that offer.
 */
export async function get_or_create_terminal_for(
    program: TerminalProgram,
): Promise<vscode.Terminal> {
    let existing = most_recent((_, p) => p === program);
    if (existing) return existing;
    // Terminals Perch reopened or a profile launch started may still be
    // joining; without Perch both settle at once.
    await Promise.all([perch_lookup_settled(), ...perch_profiles_starting]);
    existing = most_recent((_, p) => p === program);
    if (existing) return existing;
    const in_flight = creation_in_flight.get(program);
    if (in_flight) return in_flight;
    const creating = (async () => (await reattach_perch_session(program)) ?? create_r_terminal(program))().finally(() => {
        creation_in_flight.delete(program);
    });
    creation_in_flight.set(program, creating);
    return creating;
}

/**
 * A managed terminal for callers that can't ask (test hooks, recreating a
 * terminal after Install and Restart): the effective target's terminal if it's
 * a terminal program, else the most recent managed terminal, else Raven's
 * console.
 */
export async function get_or_create_r_terminal(): Promise<vscode.Terminal> {
    const target = current_target();
    if (is_terminal_program(target)) return get_or_create_terminal_for(target);
    return most_recent() ?? get_or_create_terminal_for(RAVEN_CONSOLE_PROGRAM);
}

/**
 * Raven's console, for the debugger: the most recent managed terminal with a
 * console socket, else a new Raven console. Doesn't change the session
 * choice, so sends still follow the user's pick.
 */
export async function get_or_create_raven_console(): Promise<vscode.Terminal> {
    const existing = most_recent((terminal) => console_socket_of(terminal) !== undefined);
    if (existing) return existing;
    return get_or_create_terminal_for(RAVEN_CONSOLE_PROGRAM);
}

type ReattachItem = vscode.QuickPickItem & { session?: SessionInfo };

async function default_reattach_picker(
    candidates: SessionInfo[],
    program: TerminalProgram,
): Promise<SessionInfo | 'new' | undefined> {
    const items: ReattachItem[] = candidates.map((session) => ({
        label: session.name || terminal_name_for(program),
        description: session.cwd,
        detail: `Started ${new Date(session.createdAt).toLocaleString()} · ${
            session.attached ? 'open in another window' : 'not open in any window'}`,
        session,
    }));
    items.push({ label: `Start a new ${target_label(program)}` });
    const picked = await vscode.window.showQuickPick(items, {
        title: 'Reattach an R console?',
        placeHolder: 'These R consoles are still running on this host',
    });
    if (!picked) return undefined;
    return picked.session ?? 'new';
}

let reattach_picker = default_reattach_picker;

export function _set_reattach_picker_for_test(fn: typeof default_reattach_picker | null): void {
    reattach_picker = fn ?? default_reattach_picker;
}

/**
 * With Perch, offers the running sessions of `program` that have no terminal
 * in this window and reattaches the one picked. Returns undefined to start
 * a new console. Never targets a session without asking: it may belong to
 * another workspace.
 */
async function reattach_perch_session(program: TerminalProgram): Promise<vscode.Terminal | undefined> {
    const api = await perch_for_new_console();
    if (!api) return undefined;
    let listed: SessionInfo[];
    try {
        listed = await api.listSessions({ owner: RAVEN_CALLER_ID });
    } catch (err) {
        console.warn('raven: could not list Perch sessions:', err);
        return undefined;
    }
    const candidates = reattach_candidates(listed, program, perch_sessions_open_here());
    if (candidates.length === 0) return undefined;
    const picked = await reattach_picker(candidates, program);
    if (picked === undefined) throw new vscode.CancellationError();
    if (picked === 'new') return undefined;
    let terminal: vscode.Terminal;
    try {
        terminal = await api.attach(picked.id, { show: false });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showWarningMessage(`Raven: didn't reattach the R console (${message}).`);
        throw new vscode.CancellationError();
    }
    adopt_perch_terminal(picked, terminal, api);
    return terminal;
}

/**
 * Starts `program` in a Perch session; resolves once Perch reports it
 * running. Undefined when Perch can't describe the launch (nothing was
 * started, so an ordinary terminal is safe).
 */
async function create_perch_terminal(
    api: PerchApiV1,
    program: TerminalProgram,
    plot_env: { env: RavenPlotEnv; sessionId: string } | null,
): Promise<vscode.Terminal | undefined> {
    let launch: { id: string; options: vscode.TerminalOptions };
    try {
        launch = prepare_perch_launch(api, program, plot_env);
    } catch (err) {
        console.warn('raven: Perch could not prepare a session; using an ordinary terminal:', err);
        return undefined;
    }
    try {
        return await open_perch_terminal(api, launch);
    } catch (err) {
        report_perch_start_failure(err);
        throw err;
    }
}

/** Opens a prepared Perch launch; resolves once Perch reports it running. */
async function open_perch_terminal(
    api: PerchApiV1,
    launch: { id: string; options: vscode.TerminalOptions },
): Promise<vscode.Terminal> {
    const terminal = vscode.window.createTerminal(launch.options);
    const session = await api.waitForSession(launch.id, terminal);
    adopt_perch_terminal(session, terminal, api);
    return terminal;
}

/** How long a console asked for from Perch's list waits for the Perch lookup. */
const PERCH_LAUNCHER_LOOKUP_MS = 5000;

/**
 * **New R console** in Perch's list of new terminals (Raven's
 * `perch.launchers` entry), in any window: starts the program the terminal
 * profile would (asking if no console is chosen) in a new Perch session, with
 * no reattach offer, then shows it. Being the newest console of its program,
 * it is where sends go. Resolves once the session runs; rejects with a
 * message for the user, or `CancellationError` when the user cancels.
 */
export async function new_console_in_perch(lookup_ms = PERCH_LAUNCHER_LOOKUP_MS): Promise<void> {
    const api = await usable_perch(lookup_ms);
    if (!api) throw new Error('Perch is not available here.');
    const program = await resolve_profile_program();
    const plot_env = await get_plot_terminal_env();
    let launch: { id: string; options: vscode.TerminalOptions };
    try {
        launch = prepare_perch_launch(api, program, plot_env);
    } catch (err) {
        throw new Error(`Perch couldn't start the R console (${err instanceof Error ? err.message : String(err)}).`);
    }
    const opening = open_perch_terminal(api, launch);
    const starting = opening.then(() => undefined, () => undefined);
    perch_profiles_starting.add(starting);
    void starting.finally(() => perch_profiles_starting.delete(starting));
    let terminal: vscode.Terminal;
    try {
        terminal = await opening;
    } catch (err) {
        throw new Error(`The R console didn't start in a Perch session (${err instanceof Error ? err.message : String(err)}).`);
    }
    terminal.show();
}

async function create_r_terminal(target: TerminalProgram): Promise<vscode.Terminal> {
    const program = await launch_program_for(target);
    const plot_env = await get_plot_terminal_env();
    const api = await perch_for_new_console();
    if (api) {
        const terminal = await create_perch_terminal(api, program, plot_env);
        if (terminal) return terminal;
    }
    // Opt out of VS Code's terminal restoration. Without isTransient, a restart
    // replays scrollback and relaunches R in the same pane, but the R process
    // is fresh (no objects/history) and the baked-in port/token env vars point
    // at a session server from the previous activation that no longer exists,
    // so plot/data-viewer integration silently posts to a dead server.
    const launch = build_r_terminal_launch(program);
    const terminal = vscode.window.createTerminal({
        name: terminal_name_for(program),
        shellPath: launch.shellPath,
        shellArgs: launch.shellArgs,
        env: plot_env?.env,
        isTransient: true,
    });
    if (launch.consoleSocket) register_console_terminal(terminal, launch.consoleSocket);
    managed_terminals.set(terminal, program);
    if (plot_env) terminal_to_session_id.set(terminal, plot_env.sessionId);
    return terminal;
}
