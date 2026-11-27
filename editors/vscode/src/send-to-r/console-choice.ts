/**
 * Pure rules for choosing which R console Raven sends code to. No `vscode`
 * import, so the bun suite can test them directly.
 *
 * `raven.rTerminal.program` is `ask` (default) or a fixed target. A *target*
 * is a console Raven can send to; a *terminal program* is a target Raven
 * launches in its own terminal (every target except `vscode-R`, whose
 * terminal vscode-R owns).
 */

export type TerminalProgram = 'raven' | 'R' | 'arf' | 'radian';
export type ConsoleTarget = TerminalProgram | 'vscode-R';
export type ProgramSetting = ConsoleTarget | 'ask';

/** Programs the picker lists only when they are found on PATH. */
export type DetectableProgram = 'arf' | 'radian';
export const DETECTABLE_PROGRAMS: readonly DetectableProgram[] = ['arf', 'radian'];

const TERMINAL_PROGRAMS: readonly string[] = ['raven', 'R', 'arf', 'radian'];

export function is_terminal_program(value: unknown): value is TerminalProgram {
    return typeof value === 'string' && TERMINAL_PROGRAMS.includes(value);
}

export function is_console_target(value: unknown): value is ConsoleTarget {
    return is_terminal_program(value) || value === 'vscode-R';
}

/** Reads a raw setting value; anything unknown means `ask`. */
export function parse_program_setting(raw: unknown): ProgramSetting {
    return is_console_target(raw) ? raw : 'ask';
}

/**
 * The target sends use right now, or `undefined` to ask. The session choice
 * beats the setting so **Raven: Choose R Console** can override an explicit
 * setting for one session.
 */
export function effective_target(
    session_choice: ConsoleTarget | null,
    setting: ProgramSetting,
): ConsoleTarget | undefined {
    if (session_choice) return session_choice;
    return setting === 'ask' ? undefined : setting;
}

/**
 * Whether the session choice survives a change to `raven.rTerminal.program`.
 *
 * The picker's "All sessions" writes the user-level (Global) value, so the
 * choice equals the new Global value whenever that change event arrives, even
 * when a workspace value overrides it. An own-write flag would race the event
 * instead. A choice that matches neither the Global nor the effective value
 * came from before an outside edit, which now takes effect.
 */
export function keep_session_choice_after_setting_change(
    session_choice: ConsoleTarget | null,
    global_value: unknown,
    effective_value: unknown,
): boolean {
    if (!session_choice) return false;
    return session_choice === global_value || session_choice === effective_value;
}

/**
 * Terminal tab name for a program. Raven's console is `R (Raven)`, not `R`:
 * vscode-R sends to terminals named `R` (`VSCODE_R_TERMINAL_NAMES`), and a
 * tab named `R` can't be told apart from vscode-R's own.
 */
export function terminal_name_for(program: TerminalProgram): string {
    switch (program) {
        case 'raven': return 'R (Raven)';
        case 'R': return 'R (plain)';
        case 'arf': return 'arf';
        case 'radian': return 'radian';
    }
}

/** Terminal names vscode-R treats as its own R terminals. */
export const VSCODE_R_TERMINAL_NAMES: readonly string[] = ['R', 'R Interactive'];

/**
 * The terminal vscode-R's `r.runCommand` sends to, mirroring its selector
 * (the same in vscode-R 2.8, 3.2 and 3.4): among live terminals whose name
 * doesn't contain "deactivate", the active terminal if
 * `r.alwaysUseActiveTerminal` is on; otherwise those named `R` or
 * `R Interactive`, preferring the active one, else the newest. Undefined
 * means vscode-R would open its own. Raven's terminals have other names, but
 * with `r.alwaysUseActiveTerminal` on this can still be a Raven terminal.
 */
export function vscode_r_terminal_pick<T extends { name: string; exitStatus?: unknown }>(
    terminals: readonly T[],
    active: T | undefined,
    always_use_active: boolean,
): T | undefined {
    const live = terminals.filter((t) => t.exitStatus === undefined && !t.name.toLowerCase().includes('deactivate'));
    if (always_use_active) return live.find((t) => t === active);
    const named = live.filter((t) => VSCODE_R_TERMINAL_NAMES.includes(t.name));
    if (named.length === 0) return undefined;
    return active !== undefined && named.includes(active) ? active : named[named.length - 1];
}

/**
 * Shell command that prints the path `command -v` resolves for each
 * detectable program. Only `command -v`, `;` and `true`, so it runs the same
 * in sh, bash, zsh and fish login shells. Ends in `true` so a missing last
 * program doesn't fail the call.
 */
export function detection_script(): string {
    return [...DETECTABLE_PROGRAMS.map((p) => `command -v ${p}`), 'true'].join('; ');
}

/**
 * Programs `detection_script` found. A line counts only if it is an absolute
 * path whose last component is the program's name, which labels each result
 * and ignores rc-file noise from the interactive login shell. An alias or
 * shell function makes `command -v` print its definition or bare name instead,
 * and is rejected: the terminal launches the program directly, not through
 * the shell.
 */
export function parse_detection_output(stdout: string): Set<DetectableProgram> {
    const found = new Set<DetectableProgram>();
    for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line.startsWith('/')) continue;
        const name = line.slice(line.lastIndexOf('/') + 1);
        if ((DETECTABLE_PROGRAMS as readonly string[]).includes(name)) {
            found.add(name as DetectableProgram);
        }
    }
    return found;
}
