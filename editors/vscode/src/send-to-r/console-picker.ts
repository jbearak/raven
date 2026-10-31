import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import {
    ConsoleTarget,
    DETECTABLE_PROGRAMS,
    DetectableProgram,
    detection_script,
    parse_detection_output,
} from './console-choice';

/**
 * The "Send R code to" quick pick: which console sends go to, for this
 * session or for all sessions. Resolution and session state live in
 * `r-terminal-manager.ts`; this module only asks.
 */

export const REDITORSUPPORT_EXTENSION_ID = 'REditorSupport.r';

export type PickScope = 'session' | 'all';
export type ConsolePick = { target: ConsoleTarget; scope: PickScope };
export type PickerOptions = {
    /** False for the terminal profile dropdown, which needs a terminal program. */
    include_vscode_r: boolean;
};

const exec_async = promisify(exec);
const exec_file_async = promisify(execFile);
const DETECTION_TIMEOUT_MS = 5000;

async function detect_unix(): Promise<Set<DetectableProgram>> {
    // An interactive login shell sees rc-file PATH additions (conda, pyenv,
    // homebrew shellenv) that the extension host's own PATH may lack.
    const shell = process.env.SHELL ?? '/bin/sh';
    try {
        const { stdout } = await exec_async(
            `${JSON.stringify(shell)} -ilc ${JSON.stringify(detection_script())}`,
            { timeout: DETECTION_TIMEOUT_MS },
        );
        return parse_detection_output(stdout);
    } catch {
        return new Set();
    }
}

async function detect_windows(): Promise<Set<DetectableProgram>> {
    const found = new Set<DetectableProgram>();
    await Promise.all(DETECTABLE_PROGRAMS.map(async (program) => {
        try {
            await exec_file_async('where.exe', [program], { timeout: DETECTION_TIMEOUT_MS });
            found.add(program);
        } catch {
            // Not found (or `where` timed out): leave it out of the picker.
        }
    }));
    return found;
}

function default_detector(): Promise<Set<DetectableProgram>> {
    return process.platform === 'win32' ? detect_windows() : detect_unix();
}

let detector: () => Promise<Set<DetectableProgram>> = default_detector;
// Detection runs once per session, on the first picker. It isn't persisted, so
// a program uninstalled since is noticed next session.
let detection: Promise<Set<DetectableProgram>> | null = null;

function detect_consoles(): Promise<Set<DetectableProgram>> {
    detection ??= detector();
    return detection;
}

export function _set_detector_for_test(
    fn: (() => Promise<Set<DetectableProgram>>) | null,
): void {
    detector = fn ?? default_detector;
    detection = null;
}

export function is_vscode_r_installed(): boolean {
    return vscode.extensions.getExtension(REDITORSUPPORT_EXTENSION_ID) !== undefined;
}

type TargetItem = vscode.QuickPickItem & { target: ConsoleTarget };

const TARGET_ITEMS: Record<ConsoleTarget, TargetItem> = {
    raven: {
        target: 'raven',
        label: "Raven's R console",
        detail: 'Completions, debugger, and syntax coloring',
    },
    R: { target: 'R', label: 'R command line', detail: 'The standard R console' },
    arf: { target: 'arf', label: 'arf', detail: 'Rust-based R console' },
    radian: { target: 'radian', label: 'radian', detail: 'Python-based R console' },
    'vscode-R': {
        target: 'vscode-R',
        label: 'vscode-R',
        detail: "vscode-R's R terminal",
    },
};

/** Display label for a target, as the picker shows it. */
export function target_label(target: ConsoleTarget): string {
    return TARGET_ITEMS[target].label;
}

function target_items(
    options: PickerOptions,
    detected: Set<DetectableProgram>,
): TargetItem[] {
    const items = [TARGET_ITEMS.raven, TARGET_ITEMS.R];
    for (const program of DETECTABLE_PROGRAMS) {
        if (detected.has(program)) items.push(TARGET_ITEMS[program]);
    }
    if (options.include_vscode_r && is_vscode_r_installed()) {
        items.push(TARGET_ITEMS['vscode-R']);
    }
    return items;
}

/**
 * Step 1: which console. Opens at once with the always-available items and
 * appends arf / radian when detection finishes, so a slow login shell never
 * delays the menu.
 */
function pick_target(options: PickerOptions): Promise<ConsoleTarget | undefined> {
    return new Promise((resolve) => {
        const quick_pick = vscode.window.createQuickPick<TargetItem>();
        quick_pick.title = 'Send R code to';
        quick_pick.placeholder = 'Choose an R console';
        quick_pick.items = target_items(options, new Set());
        quick_pick.busy = true;
        let settled = false;
        const finish = (target: ConsoleTarget | undefined) => {
            if (settled) return;
            settled = true;
            resolve(target);
            quick_pick.dispose();
        };
        void detect_consoles().then((detected) => {
            if (settled) return;
            const active = quick_pick.activeItems[0]?.target;
            quick_pick.items = target_items(options, detected);
            const keep = quick_pick.items.find((item) => item.target === active);
            if (keep) quick_pick.activeItems = [keep];
            quick_pick.busy = false;
        });
        quick_pick.onDidAccept(() => finish(quick_pick.selectedItems[0]?.target));
        quick_pick.onDidHide(() => finish(undefined));
        quick_pick.show();
    });
}

type ScopeItem = vscode.QuickPickItem & { scope: PickScope };

/** Step 2: for how long. */
async function pick_scope(target: ConsoleTarget): Promise<PickScope | undefined> {
    const items: ScopeItem[] = [
        { scope: 'session', label: 'This session', detail: 'Until you close or reload this window' },
        {
            scope: 'all',
            label: 'All sessions',
            detail: 'Saves raven.rTerminal.program in your user settings',
        },
    ];
    const picked = await vscode.window.showQuickPick(items, {
        title: `Use ${target_label(target)} for`,
    });
    return picked?.scope;
}

async function default_picker(options: PickerOptions): Promise<ConsolePick | undefined> {
    const target = await pick_target(options);
    if (!target) return undefined;
    const scope = await pick_scope(target);
    if (!scope) return undefined;
    return { target, scope };
}

let picker: (options: PickerOptions) => Promise<ConsolePick | undefined> = default_picker;

/** Shows the picker. `undefined` means the user cancelled at either step. */
export function show_console_picker(options: PickerOptions): Promise<ConsolePick | undefined> {
    return picker(options);
}

export function _set_picker_for_test(
    fn: ((options: PickerOptions) => Promise<ConsolePick | undefined>) | null,
): void {
    picker = fn ?? default_picker;
}
