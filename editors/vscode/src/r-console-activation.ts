import * as vscode from 'vscode';

/**
 * R-console activation gating.
 *
 * `raven.rConsole.activation` controls whether Raven activates its
 * R-session features (R console, plot viewer, data viewer). The help
 * viewer is unaffected. The default `"auto"` resolves to `"disabled"`
 * when the REditorSupport (R) extension is enabled or VS Code is
 * running as Positron, so Raven steps aside in environments where the
 * user already has R-session integration. See
 * docs/coexistence.md for the rationale.
 */

export type RConsoleActivation = 'enabled' | 'disabled' | 'auto';
export type RConsoleResolved = 'enabled' | 'disabled';

/** Why `auto` resolved to `disabled`, or `null` when it resolved to `enabled`. */
export type AutoDisableReason = 'reditorsupport' | 'positron' | null;

const REDITORSUPPORT_EXTENSION_ID = 'REditorSupport.r';
const AUTO_NOTICE_DISMISSED_KEY = 'raven.rConsoleAutoNoticeDismissed';

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

export function detectAutoDisableReason(): AutoDisableReason {
    if (isREditorSupportActive()) return 'reditorsupport';
    if (isPositron()) return 'positron';
    return null;
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

    const message = reason === 'reditorsupport'
        ? "Raven includes an R console, plot viewer, and data viewer. Because REditorSupport (R) is enabled, Raven leaves these turned off by default so it doesn't interfere with your existing setup. Raven's code intelligence (completions, diagnostics, navigation) activates either way. See Learn more to decide whether to turn them on."
        : "Raven includes an R console, plot viewer, and data viewer. Because you're running Positron, which has its own R-session integration, Raven leaves these turned off by default. Raven's code intelligence (completions, diagnostics, navigation) activates either way. See Learn more to decide whether to turn them on.";

    const LEARN_MORE = 'Learn more';
    const OPEN_SETTINGS = 'Open setting';
    const DONT_SHOW = "Don't show again";

    const choice = await vscode.window.showInformationMessage(
        message, LEARN_MORE, OPEN_SETTINGS, DONT_SHOW,
    );
    if (choice === LEARN_MORE) {
        await vscode.env.openExternal(
            vscode.Uri.parse('https://github.com/jbearak/raven/blob/main/docs/coexistence.md'),
        );
    } else if (choice === OPEN_SETTINGS) {
        await vscode.commands.executeCommand(
            'workbench.action.openSettings', 'raven.rConsole.activation',
        );
    } else if (choice === DONT_SHOW) {
        await context.globalState.update(AUTO_NOTICE_DISMISSED_KEY, true);
    }
}

/**
 * Watches for changes to `raven.rConsole.activation` and to
 * REditorSupport's installed/enabled state. When either flips the
 * resolved activation away from its current value, prompts the user to
 * reload the window so the new state takes effect — Raven does not
 * dynamically tear down or stand up R-session services mid-session.
 */
export function registerActivationReactivity(
    context: vscode.ExtensionContext,
    initialResolved: RConsoleResolved,
): void {
    let lastResolved = initialResolved;

    const promptIfChanged = async (
        message: string,
    ): Promise<void> => {
        const next = resolveRConsoleActivation();
        if (next === lastResolved) return;
        lastResolved = next;
        const RELOAD = 'Reload Window';
        const choice = await vscode.window.showInformationMessage(message, RELOAD);
        if (choice === RELOAD) {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    };

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async event => {
            if (!event.affectsConfiguration('raven.rConsole.activation')) return;
            const next = resolveRConsoleActivation();
            if (next === lastResolved) return;
            const message = next === 'enabled'
                ? "Raven's R console, plot viewer, and data viewer are now enabled. Reload the window to start them."
                : "Raven's R console, plot viewer, and data viewer are now disabled. Reload the window to fully unload them.";
            await promptIfChanged(message);
        }),
    );

    context.subscriptions.push(
        vscode.extensions.onDidChange(async () => {
            // We only react to changes that affect the auto-resolution
            // path; if the setting is explicit, REditorSupport coming or
            // going doesn't change Raven's resolved state.
            if (readRConsoleActivation() !== 'auto') return;
            const next = resolveRConsoleActivation();
            if (next === lastResolved) return;
            const reason = detectAutoDisableReason();
            const message = next === 'enabled'
                ? "REditorSupport (R) was disabled. Reload the window to start Raven's R console, plot viewer, and data viewer."
                : reason === 'reditorsupport'
                    ? "REditorSupport (R) was enabled. Reload the window so Raven's R console steps aside (or set `raven.rConsole.activation` to \"enabled\" to keep both running)."
                    : "Raven's R session features are now disabled. Reload the window to fully unload them.";
            await promptIfChanged(message);
        }),
    );
}
