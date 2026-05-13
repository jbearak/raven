import * as path from 'path';
import * as vscode from 'vscode';
import {
    ExecuteCommandRequest,
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
} from 'vscode-languageclient/node';
import { activateHelpViewer, wrapHoverWithHelpTrust } from './help';
import { registerAutoCloseFix } from './autoCloseFix';
import { registerScaffoldCommands } from './scaffold';
import {
    getInitializationOptions as buildInitializationOptions,
    RavenInitializationOptions,
} from './initializationOptions';
import {
    getUpdatedGlobalLanguageConfig,
    isRDocument,
} from './extensionHelpers';
import {
    shouldTriggerDirectivePathSuggest,
    shouldTriggerNestedPathSuggest,
} from './pathCompletionTriggers';
import {
    register_r_terminal,
    register_send_to_r_commands,
    register_inspection_commands,
    get_or_create_r_terminal,
} from './send-to-r';
import { register_build_commands } from './build-commands';
import { register_r_package_detection } from './r-package-detection';
import { PlotServices } from './plot';
import { registerDataViewer, dataViewerDirOf } from './data-viewer';
import type { DataViewerManager } from './data-viewer/manager';
import {
    detectAutoDisableReason,
    notifyAutoDisable,
    readRConsoleActivation,
    registerActivationReactivity,
    resolveRConsoleActivation,
} from './r-console-activation';

/**
 * Read all raven.* settings from VS Code configuration and construct
 * the initializationOptions object for the LSP server.
 * Explicit settings are forwarded, and master defaults like diagnostics.enabled
 * are included when the server contract requires them.
 */
function getInitializationOptions(): RavenInitializationOptions {
    return buildInitializationOptions(vscode.workspace.getConfiguration('raven'));
}

let client: LanguageClient;
const R_CONSOLE_ENABLED_CONTEXT = 'raven.rConsoleEnabled';
const WORD_SEPARATORS = "`~!@#$%^&*()-=+[{]}\\|;:'\",<>/?";
const DOT_IN_WORD_LANGUAGE_IDS = ['r', 'jags'] as const;

function hasWordSeparatorsOverride(configValue: unknown): boolean {
    return typeof configValue === 'object'
        && configValue !== null
        && 'editor.wordSeparators' in configValue;
}

function getServerPath(context: vscode.ExtensionContext): string {
    const config = vscode.workspace.getConfiguration('raven');
    const configPath = config.get<string>('server.path');
    
    if (configPath) {
        return configPath;
    }

    // Use bundled binary
    const platform = process.platform;
    const binaryName = platform === 'win32' ? 'raven.exe' : 'raven';
    return path.join(context.extensionPath, 'bin', binaryName);
}

/**
 * Send activity notification to the server for cross-file revalidation prioritization.
 */
function sendActivityNotification() {
    if (!client) {
        return;
    }

    const activeEditor = vscode.window.activeTextEditor;
    const visibleEditors = vscode.window.visibleTextEditors;

    const activeDocument = activeEditor?.document;
    const activeUriStr = activeDocument && isRDocument(activeDocument)
        ? activeDocument.uri.toString()
        : null;

    const visibleUris = visibleEditors
        .map(editor => editor.document)
        .filter(isRDocument)
        .map(document => document.uri.toString());

    client.sendNotification('raven/activeDocumentsChanged', {
        activeUri: activeUriStr,
        visibleUris: visibleUris,
        timestampMs: Date.now(),
    });
}

/**
 * Public extension API surface, returned from `activate()` and reachable
 * from other extensions and the test harness via
 * `vscode.extensions.getExtension('jbearak.raven-r').exports`.
 *
 * The only consumer today is the Mocha test suite, which uses the live
 * LanguageClient to round-trip `workspace/executeCommand` calls (e.g.
 * `raven.getHelpHtml`) that are intentionally NOT registered as VS Code
 * commands per the executeCommandProvider rule in CLAUDE.md.
 */
export interface RavenExtensionApi {
    /** Returns the live LSP client once activation has installed it. */
    getLanguageClient(): LanguageClient | undefined;
    /**
     * Creates (or reuses) a Raven-managed R terminal with the bootstrap
     * profile injected, then sends `code` to it. Used by integration tests.
     */
    sendToRTerminal(code: string): Promise<void>;
    /** Names of currently-open data viewer panels. Used by integration tests. */
    getDataViewerPanelNames(): string[];
    /** Column names for a named data viewer panel. Used by integration tests. */
    getDataViewerPanelColumnNames(panelName: string): string[] | undefined;
}

export function activate(context: vscode.ExtensionContext): RavenExtensionApi {
    const serverPath = getServerPath(context);

    function buildRustLogEnv(): Record<string, string> | undefined {
        const traceLevel = vscode.workspace.getConfiguration('raven').get<string>('trace.server', 'off');
        const rustLog = traceLevel === 'verbose' ? 'raven=trace' :
                        traceLevel === 'messages' ? 'raven=debug' : undefined;
        return rustLog ? { ...process.env as Record<string, string>, RUST_LOG: rustLog } : undefined;
    }

    const serverOptions: ServerOptions = {
        command: serverPath,
        args: ['--stdio'],
        options: { env: buildRustLogEnv() },
    };

    // Create output channel for server logs
    const outputChannel = vscode.window.createOutputChannel('Raven');

    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { scheme: 'file', language: 'r' },
            { scheme: 'untitled', language: 'r' },
            { scheme: 'file', language: 'jags' },
            { scheme: 'untitled', language: 'jags' },
            { scheme: 'file', language: 'stan' },
            { scheme: 'untitled', language: 'stan' },
        ],
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{r,R,rmd,Rmd,qmd,jags,Jags,JAGS,bugs,Bugs,BUGS,stan,Stan,STAN}'),
        },
        outputChannel: outputChannel,
        initializationOptions: getInitializationOptions,
        middleware: {
            provideHover: (document, position, token, next) =>
                wrapHoverWithHelpTrust(async (doc, pos, tok) => {
                    const result = await next(doc, pos, tok);
                    return result as vscode.Hover | null | undefined;
                })(document, position, token),
        },
    };

    client = new LanguageClient(
        'raven',
        'Raven - R Language Server',
        serverOptions,
        clientOptions
    );

    client.start();

    // Activate help viewer (registers raven.openHelpPanel, raven.help.back, raven.help.forward).
    activateHelpViewer(context, client);

    // R-console activation gating. The R console, plot viewer, and data viewer
    // share one umbrella — `raven.rConsole.activation`. Default `auto` steps
    // aside when REditorSupport (R) is enabled or VS Code is running as
    // Positron, so Raven supplements rather than fights existing R-session
    // setups. The help viewer activates regardless and is wired above.
    const r_console_resolved = resolveRConsoleActivation();
    void vscode.commands.executeCommand(
        'setContext',
        R_CONSOLE_ENABLED_CONTEXT,
        r_console_resolved === 'enabled',
    );
    let data_viewer_manager: DataViewerManager | undefined;
    if (r_console_resolved === 'enabled') {
        // Plot services (session server + viewer panel) for managed R terminals.
        // Constructed before raven.restart registration so the closure has a live
        // reference, not just a temporal-dead-zone forward binding.
        const plot_services = new PlotServices(context, dataViewerDirOf(context));
        active_plot_services = plot_services;
        data_viewer_manager = registerDataViewer(context, plot_services.server, dataViewerDirOf(context));

        // Register R terminal and send-to-R commands
        register_r_terminal(context, plot_services);
        register_send_to_r_commands(context);
        register_inspection_commands(context);
        register_build_commands(context);
    }

    // Package-mode context key. Wired regardless of R-console activation so
    // the palette gating works even when Send-to-R is disabled (e.g. when
    // coexisting with REditorSupport, which provides its own R session).
    // The Build commands themselves require an R terminal, so they're only
    // registered above when r-console is enabled; the context key still
    // hides their palette entries when the workspace isn't a package.
    register_r_package_detection(context);

    // Register restart command — re-reads trace config so changed settings take effect.
    //
    // Intentionally does NOT restart plot_services: existing Raven-managed R
    // terminals already hold the current RAVEN_SESSION_PORT/RAVEN_SESSION_TOKEN
    // in their environment, so tearing the session server down and bringing it
    // back up on a different port would leave those terminals POSTing to a
    // dead/unauthorized server until the user manually closes them.
    context.subscriptions.push(
        vscode.commands.registerCommand('raven.restart', async () => {
            (serverOptions as { options: { env: Record<string, string> | undefined } }).options.env = buildRustLogEnv();
            await client.restart();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('raven.refreshPackages', async () => {
            try {
                const response = await client.sendRequest(ExecuteCommandRequest.type, {
                    command: 'raven.refreshPackages',
                    arguments: []
                });
                // Server returns `{ cleared: N }` — surface it so users get
                // feedback that the command actually did something.
                const cleared =
                    response && typeof (response as { cleared?: unknown }).cleared === 'number'
                        ? (response as { cleared: number }).cleared
                        : undefined;
                if (cleared !== undefined) {
                    vscode.window.setStatusBarMessage(
                        `Raven: refreshed ${cleared} package cache ${cleared === 1 ? 'entry' : 'entries'}`,
                        3000,
                    );
                }
            } catch (err) {
                vscode.window.showErrorMessage(`Raven refreshPackages failed: ${err}`);
            }
        })
    );

    // Register auto-close pair overtype fix
    context.subscriptions.push(registerAutoCloseFix());

    // Register .gitignore / .lintr scaffold commands
    registerScaffoldCommands(context);

    // If `auto` chose to disable, surface a one-time popover so the user knows
    // why their R console / plot viewer / data viewer didn't activate.
    if (r_console_resolved === 'disabled' && readRConsoleActivation() === 'auto') {
        void notifyAutoDisable(context, detectAutoDisableReason());
    }

    // Listen for setting changes and REditorSupport extension toggles, and
    // prompt the user to reload when the resolved activation flips.
    registerActivationReactivity(context, r_console_resolved);

    // Register activity signal listeners for cross-file revalidation prioritization
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => {
            sendActivityNotification();
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors(() => {
            sendActivityNotification();
        })
    );

    // Register configuration change listener
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('raven')) {
                // Send updated configuration to LSP server
                const settings = getInitializationOptions();
                client.sendNotification('workspace/didChangeConfiguration', {
                    settings: settings
                });
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor || activeEditor.document.uri.toString() !== event.document.uri.toString()) {
                return;
            }
            if (!isRDocument(event.document) || event.contentChanges.length !== 1) {
                return;
            }

            const change = event.contentChanges[0];
            const lineText = event.document.lineAt(change.range.start.line).text;
            const linePrefix = lineText.slice(0, change.range.start.character + change.text.length);
            const shouldTriggerSuggest =
                (change.rangeLength === 0 &&
                    shouldTriggerDirectivePathSuggest(change.text, linePrefix)) ||
                shouldTriggerNestedPathSuggest(change.text, linePrefix);
            if (shouldTriggerSuggest) {
                void vscode.commands.executeCommand('editor.action.triggerSuggest');
            }
        }),
    );

    // Prompt for word separators configuration
    promptWordSeparators();

    return {
        getLanguageClient: () => client,
        sendToRTerminal: async (code: string) => {
            const terminal = await get_or_create_r_terminal();
            terminal.sendText(code, true);
        },
        getDataViewerPanelNames: () => data_viewer_manager?.getPanelNames() ?? [],
        getDataViewerPanelColumnNames: (panelName: string) =>
            data_viewer_manager?.getPanelColumnNames(panelName),
    };
}

async function promptWordSeparators() {
    const config = vscode.workspace.getConfiguration('raven');
    const setting = config.get<string>('editor.dotInWordSeparators', 'ask');

    // If set to 'yes', ensure the setting is applied
    if (setting === 'yes') {
        await ensureWordSeparators(WORD_SEPARATORS);
        return;
    }

    // If set to 'no', do nothing
    if (setting === 'no') {
        return;
    }

    // If set to 'ask', check if we should prompt
    const wsConfig = vscode.workspace.getConfiguration();
    const missingWordSeparatorsLanguage = DOT_IN_WORD_LANGUAGE_IDS.find((languageId) => {
        const languageConfig = wsConfig.inspect(`[${languageId}]`);
        return !hasWordSeparatorsOverride(languageConfig?.globalValue)
            && !hasWordSeparatorsOverride(languageConfig?.workspaceValue)
            && !hasWordSeparatorsOverride(languageConfig?.workspaceFolderValue);
    });

    if (missingWordSeparatorsLanguage === undefined) {
        return;
    }

    // Show prompt
    const choice = await vscode.window.showInformationMessage(
        'This extension can treat dots as part of words in R and JAGS files by updating editor.wordSeparators for [r] and [jags]. Enable this behavior?',
        'Enable',
        'No thanks'
    );

    if (choice === 'Enable') {
        await config.update('editor.dotInWordSeparators', 'yes', vscode.ConfigurationTarget.Global);
        await ensureWordSeparators(WORD_SEPARATORS);
        
        const reload = await vscode.window.showInformationMessage(
            'R and JAGS word separators updated: dots will now be part of words in R and JAGS files. Reload window to apply?',
            'Reload',
            'Later'
        );
        if (reload === 'Reload') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    } else if (choice === 'No thanks') {
        await config.update('editor.dotInWordSeparators', 'no', vscode.ConfigurationTarget.Global);
    }
}

async function ensureWordSeparators(wordSeparators: string) {
    const config = vscode.workspace.getConfiguration();
    
    for (const languageId of DOT_IN_WORD_LANGUAGE_IDS) {
        const updatedLanguageConfig = getUpdatedGlobalLanguageConfig(
            config.inspect<Record<string, unknown>>(`[${languageId}]`),
            wordSeparators,
        );

        // Only update if not already set correctly
        if (updatedLanguageConfig !== null) {
            await config.update(`[${languageId}]`, updatedLanguageConfig, vscode.ConfigurationTarget.Global);
        }
    }
}

let active_plot_services: PlotServices | null = null;

export function deactivate(): Thenable<void> | undefined {
    const stops: Thenable<void>[] = [];
    if (active_plot_services) stops.push(active_plot_services.dispose());
    if (client) stops.push(client.stop());
    if (stops.length === 0) return undefined;
    return Promise.all(stops).then(() => undefined);
}
