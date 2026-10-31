import * as vscode from 'vscode';

/**
 * R-console activation gating.
 *
 * `raven.rConsole.activation` controls whether Raven activates its
 * R-session features (R console, plot viewer, data viewer). The help
 * viewer is unaffected. The default `"auto"` resolves to `"disabled"`
 * when VS Code is running as Positron, which has its own R console.
 * vscode-R (REditorSupport) no longer turns them off: when the user sends
 * code, Raven asks which console to use and offers vscode-R's terminal as
 * one choice (see `send-to-r/console-picker.ts`). See docs/coexistence.md.
 */

export type RConsoleActivation = 'enabled' | 'disabled' | 'auto';
export type RConsoleResolved = 'enabled' | 'disabled';

/** Why `auto` resolved to `disabled`, or `null` when it resolved to `enabled`. */
export type AutoDisableReason = 'positron' | null;

const REDITORSUPPORT_EXTENSION_ID = 'REditorSupport.r';
const AUTO_NOTICE_DISMISSED_KEY = 'raven.rConsoleAutoNoticeDismissed';
const VSCODE_R_NOTICE_SHOWN_KEY = 'raven.rConsoleVscodeRNoticeShown';
const COEXISTENCE_URL = 'https://github.com/jbearak/raven/blob/main/docs/coexistence.md';

export function readRConsoleActivation(): RConsoleActivation {
    const raw = vscode.workspace.getConfiguration('raven.rConsole')
        .get<string>('activation', 'auto');
    if (raw === 'enabled' || raw === 'disabled' || raw === 'auto') return raw;
    return 'auto';
}

/** True when the host is Positron (a VS Code fork by Posit). */
export function isPositron(appName: string = vscode.env.appName): boolean {
    return appName.toLowerCase().includes('positron');
}

/** True when the REditorSupport (R) extension is installed and enabled. */
export function isREditorSupportActive(): boolean {
    const ext = vscode.extensions.getExtension(REDITORSUPPORT_EXTENSION_ID);
    return ext !== undefined;
}

export function detectAutoDisableReason(appName?: string): AutoDisableReason {
    return isPositron(appName) ? 'positron' : null;
}

export function resolveRConsoleActivation(
    setting: RConsoleActivation = readRConsoleActivation(),
): RConsoleResolved {
    if (setting === 'enabled') return 'enabled';
    if (setting === 'disabled') return 'disabled';
    return detectAutoDisableReason() === null ? 'enabled' : 'disabled';
}

/**
 * One-time popover explaining why `auto` left Raven's R-session features
 * off. Fires only when the setting is `auto`, the resolution chose
 * `disabled`, and the user has not previously dismissed the message.
 */
export async function notifyAutoDisable(
    context: vscode.ExtensionContext,
    reason: AutoDisableReason,
): Promise<void> {
    if (reason === null) return;
    if (context.globalState.get<boolean>(AUTO_NOTICE_DISMISSED_KEY)) return;

    const message = "Raven includes an R console, plot viewer, and data viewer. Because you're running Positron, which has its own R-session integration, Raven leaves these turned off by default. Raven's code intelligence (completions, diagnostics, navigation) activates either way. See Learn more to decide whether to turn them on.";

    const LEARN_MORE = 'Learn more';
    const OPEN_SETTINGS = 'Open setting';
    const DONT_SHOW = "Don't show again";

    const choice = await vscode.window.showInformationMessage(
        message, LEARN_MORE, OPEN_SETTINGS, DONT_SHOW,
    );
    if (choice === LEARN_MORE) {
        await vscode.env.openExternal(vscode.Uri.parse(COEXISTENCE_URL));
    } else if (choice === OPEN_SETTINGS) {
        await vscode.commands.executeCommand(
            'workbench.action.openSettings', 'raven.rConsole.activation',
        );
    } else if (choice === DONT_SHOW) {
        await context.globalState.update(AUTO_NOTICE_DISMISSED_KEY, true);
    }
}

/**
 * One-time notice for vscode-R users: Raven's R console used to stay off
 * next to vscode-R and now runs alongside it. Shown once, at activation,
 * when vscode-R is installed and the setting is `auto`.
 */
export async function notifyVscodeRCoexistence(
    context: vscode.ExtensionContext,
): Promise<void> {
    if (readRConsoleActivation() !== 'auto' || isPositron()) return;
    if (!isREditorSupportActive()) return;
    if (context.globalState.get<boolean>(VSCODE_R_NOTICE_SHOWN_KEY)) return;
    await context.globalState.update(VSCODE_R_NOTICE_SHOWN_KEY, true);

    const LEARN_MORE = 'Learn more';
    const choice = await vscode.window.showInformationMessage(
        "Raven's R console now runs alongside vscode-R. When you send code, Raven asks which console to use.",
        LEARN_MORE,
    );
    if (choice === LEARN_MORE) {
        await vscode.env.openExternal(vscode.Uri.parse(COEXISTENCE_URL));
    }
}

/**
 * Watches for changes to `raven.rConsole.activation`. When a change flips
 * the resolved activation, prompts the user to reload the window so the new
 * state takes effect — Raven does not dynamically tear down or stand up
 * R-session services mid-session.
 */
export function registerActivationReactivity(
    context: vscode.ExtensionContext,
    initialResolved: RConsoleResolved,
): void {
    let lastResolved = initialResolved;

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async event => {
            if (!event.affectsConfiguration('raven.rConsole.activation')) return;
            const next = resolveRConsoleActivation();
            if (next === lastResolved) return;
            lastResolved = next;
            const message = next === 'enabled'
                ? "Raven's R console, plot viewer, and data viewer are now enabled. Reload the window to start them."
                : "Raven's R console, plot viewer, and data viewer are now disabled. Reload the window to fully unload them.";
            const RELOAD = 'Reload Window';
            const choice = await vscode.window.showInformationMessage(message, RELOAD);
            if (choice === RELOAD) {
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        }),
    );
}
