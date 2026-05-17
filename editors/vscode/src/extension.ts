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
    _dispose_cached_r_terminal_for_test,
} from './send-to-r';
import { register_build_commands } from './build-commands';
import {
    register_chunks_navigation_and_highlight,
    register_chunks_with_terminal,
} from './chunks';
import { registerRSnippetCompletionsForRmdAndQuarto } from './r-snippet-provider';
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
import { registerKnit } from './knit';
import { registerInstallNags } from './recommendations/install-nag';
import { registerWalkthroughCommands } from './recommendations/walkthrough';

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
 * Resolve the effective `editor.tabSize` for an R document, resource-scoped
 * so per-file and per-language overrides are honoured.
 */
function resolveTabSizeForDocument(document: vscode.TextDocument): number {
    const cfg = vscode.workspace.getConfiguration('editor', document.uri);
    const tabSize = cfg.get<number>('tabSize', 2);
    return tabSize;
}

/**
 * Send raven/documentIndentUnitsChanged when `raven.linting.indentationUnit`
 * is `"auto"`. Sends an empty list (clearing all overrides) when the setting
 * is a fixed integer, so the server falls back to `lint_config.indentation_unit`.
 */
function sendDocumentIndentUnitsNotification() {
    if (!client) {
        return;
    }

    const ravenCfg = vscode.workspace.getConfiguration('raven');
    const setting = ravenCfg.get<number | 'auto'>('linting.indentationUnit', 'auto');

    if (setting !== 'auto') {
        // Fixed integer: clear per-document overrides so the server uses the
        // workspace-wide value it already received via initializationOptions.
        client.sendNotification('raven/documentIndentUnitsChanged', { units: [] });
        return;
    }

    const units = vscode.workspace.textDocuments
        .filter(isRDocument)
        .map(doc => ({
            uri: doc.uri.toString(),
            indentUnit: resolveTabSizeForDocument(doc),
        }));

    client.sendNotification('raven/documentIndentUnitsChanged', { units });
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
    /** Latest visible-row range for a data viewer panel, or undefined if
     *  none has arrived yet. Used by integration tests to verify scroll
     *  position. */
    getDataViewerPanelVisibleRange(panelName: string):
        { start: number; end: number } | undefined;
    /** Test-only: dispatch a synthetic key event in a data viewer panel.
     *  Used by integration tests to drive End / Home / PageDown / PageUp.
     *  Awaiting waits for the message to be queued; poll
     *  getDataViewerPanelVisibleRange to observe the result. */
    pressDataViewerKey(panelName: string, key: string): Promise<void>;
    /** Test-only: drive a custom-scrollbar drag in a data viewer panel.
     *  fraction=0 jumps to top, fraction=1 jumps to bottom. Used by
     *  integration tests to exercise the drag math + scroll pipeline.
     *  Awaiting waits for the message to be queued; poll
     *  getDataViewerPanelVisibleRange to observe the result. */
    dragDataViewerScrollbar(panelName: string, fraction: number): Promise<void>;
    /**
     * Test-only: forget the bundled extension's cached R terminal so the next
     * `sendToRTerminal` recreates it through the real `createTerminal` path.
     * Needed by integration suites that follow another suite which stubbed
     * `vscode.window.createTerminal` — that stub's fake terminal is invisible
     * to `onDidCloseTerminal` and would otherwise be reused indefinitely.
     */
    _disposeCachedRTerminalForTest(): void;
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
        // `rmd` and `quarto` are included so the document outline can surface
        // chunk entries (issue #227). The server side gates diagnostics for
        // these documents because the R tree-sitter parser would otherwise
        // emit syntax errors on prose. Chunk-level LSP features inside R
        // chunks (hover/completion/go-to-def) are tracked as a follow-up to
        // #230 and will need a more targeted flow (e.g. virtual-document
        // injection per fenced R block).
        documentSelector: [
            { scheme: 'file', language: 'r' },
            { scheme: 'untitled', language: 'r' },
            { scheme: 'file', language: 'rmd' },
            { scheme: 'untitled', language: 'rmd' },
            { scheme: 'file', language: 'quarto' },
            { scheme: 'untitled', language: 'quarto' },
            { scheme: 'file', language: 'jags' },
            { scheme: 'untitled', language: 'jags' },
            { scheme: 'file', language: 'stan' },
            { scheme: 'untitled', language: 'stan' },
        ],
        synchronize: {
            // Matches the LSP `documentSelector` above. `.Rmd` / `.qmd` are
            // included so workspace file events for those documents reach the
            // server too. `raven.toml` and `.lintr` are watched so portable
            // project-config edits reach the server for live reconfiguration.
            fileEvents: [
                vscode.workspace.createFileSystemWatcher(
                    '**/*.{r,R,rmd,Rmd,RMD,qmd,Qmd,QMD,jags,Jags,JAGS,bugs,Bugs,BUGS,stan,Stan,STAN}',
                ),
                vscode.workspace.createFileSystemWatcher('**/raven.toml'),
                vscode.workspace.createFileSystemWatcher('**/.lintr'),
            ],
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

    // The server emits `raven/projectConfigLoaded` whenever it picks up (or
    // re-picks up) a portable `raven.toml` / `.lintr` — and now also when
    // the file is removed. `path: null` + `source: null` is the cleared
    // form; both fields must be present and consistent for a "config in
    // effect" notification. Surface the source so users can confirm
    // what's authoritative at a glance.
    client.onNotification(
        'raven/projectConfigLoaded',
        (params: unknown) => {
            // Runtime type guard so a future server-side schema change fails
            // loudly rather than silently rendering "undefined" in the UI.
            // Enforce pair-shape consistency: both fields are null (cleared)
            // OR both fields are non-empty strings with `source` matching
            // the known discriminator set. Half-null / empty-string / unknown
            // source values are treated as malformed and logged.
            const isValidSource = (v: unknown): v is 'raven.toml' | '.lintr' =>
                v === 'raven.toml' || v === '.lintr';
            if (typeof params !== 'object' || params === null) {
                outputChannel.appendLine(
                    `Raven: ignoring malformed projectConfigLoaded payload: ${JSON.stringify(params)}`,
                );
                return;
            }
            const rawPath = (params as { path?: unknown }).path;
            const rawSource = (params as { source?: unknown }).source;
            const cleared = rawPath === null && rawSource === null;
            const inEffect =
                typeof rawPath === 'string' && rawPath.length > 0 && isValidSource(rawSource);
            if (!cleared && !inEffect) {
                outputChannel.appendLine(
                    `Raven: ignoring malformed projectConfigLoaded payload: ${JSON.stringify(params)}`,
                );
                return;
            }
            if (cleared) {
                outputChannel.appendLine('Raven: project config cleared (no raven.toml / .lintr in effect)');
                vscode.window.setStatusBarMessage('$(circle-slash) Raven: no project config', 5000);
                return;
            }
            const path = rawPath as string;
            const source = rawSource as 'raven.toml' | '.lintr';
            outputChannel.appendLine(`Raven: using config at ${path} (${source})`);
            vscode.window.setStatusBarMessage(`$(check) Raven: using ${source}`, 5000);
        },
    );

    void client.start().then(() => {
        // Send initial per-document indent units after the LSP handshake completes
        // so the server has correct values for already-open R files when
        // raven.linting.indentationUnit is "auto".
        sendDocumentIndentUnitsNotification();
    });

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
        register_chunks_with_terminal(context);

        // Chunk navigation and highlighting overlap with REditorSupport's
        // chunk surfaces, so they're gated behind R-console activation. With
        // REditorSupport / Positron handling chunks, Raven steps aside.
        register_chunks_navigation_and_highlight(context);

        // R snippets for `rmd` / `quarto` are registered programmatically here
        // (rather than statically in package.json) so they only appear when
        // Raven's R-console is active. The static `language: "r"` registration
        // in package.json continues to provide them in `.R` files. See
        // docs/coexistence.md.
        registerRSnippetCompletionsForRmdAndQuarto(context);
    }

    // Package-mode context key. The `raven.isRPackage` key gates the
    // Build commands' palette entries and editor-title submenu — every
    // `when` clause that uses it is also gated on `raven.rConsoleEnabled`,
    // so the key has no visible effect when R-console is disabled. We
    // still register the detection unconditionally so the key is
    // populated for whichever surfaces (current or future) consult it.
    register_r_package_detection(context);

    // `Raven: Knit` registers unconditionally so the walkthrough's
    // command-link works even when the resolved gate is closed. The
    // handler itself re-checks `resolveRConsoleActivation()` at
    // invocation and surfaces a clear info message if the gate is
    // closed. Setting `raven.rmdKnit.enabled` to match the resolved gate
    // gates the command-palette entry.
    registerKnit(context, r_console_resolved === 'enabled');

    // Install nags (one-time recommendations to install quarto.quarto for .qmd
    // and REditorSupport.r-syntax for .Rmd grammar) and the Get-Started
    // walkthrough's `raven.walkthrough.createSampleRmd` command. Both
    // activate regardless of the R-console gate — they're about grammar and
    // discoverability, not subprocess features.
    registerInstallNags(context);
    registerWalkthroughCommands(context);

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
            sendDocumentIndentUnitsNotification();
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

    // Scaffold a portable `raven.toml` from current VS Code linting settings.
    // Lives here (not in `scaffold.ts`) because it pulls the nested LSP-shape
    // linting payload via `buildInitializationOptions`, which the rest of
    // extension.ts already imports.
    context.subscriptions.push(
        vscode.commands.registerCommand('raven.createProjectConfig', async () => {
            await scaffoldProjectConfig();
        }),
    );

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
            // editor.tabSize changes affect per-document indent units when
            // raven.linting.indentationUnit is "auto".
            if (
                event.affectsConfiguration('raven.linting.indentationUnit') ||
                event.affectsConfiguration('editor.tabSize')
            ) {
                sendDocumentIndentUnitsNotification();
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((doc) => {
            if (isRDocument(doc)) {
                sendDocumentIndentUnitsNotification();
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((doc) => {
            if (isRDocument(doc)) {
                sendDocumentIndentUnitsNotification();
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
        getDataViewerPanelVisibleRange: (panelName: string) =>
            data_viewer_manager?.getPanelVisibleRange(panelName),
        pressDataViewerKey: async (panelName: string, key: string) => {
            await data_viewer_manager?.pressKeyOnPanel(panelName, key);
        },
        dragDataViewerScrollbar: async (panelName: string, fraction: number) => {
            await data_viewer_manager?.dragScrollbarOnPanel(panelName, fraction);
        },
        _disposeCachedRTerminalForTest: () => _dispose_cached_r_terminal_for_test(),
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

async function scaffoldProjectConfig(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage('Raven: open a workspace folder first.');
        return;
    }
    const target = vscode.Uri.joinPath(folders[0].uri, 'raven.toml');
    try {
        await vscode.workspace.fs.stat(target);
        const choice = await vscode.window.showWarningMessage(
            'raven.toml already exists. Overwrite?',
            { modal: true },
            'Overwrite',
            'Cancel',
        );
        if (choice !== 'Overwrite') return;
    } catch {
        // not present — fall through
    }

    // Reuse the existing factory that converts VS Code's flat
    // `raven.linting.*` settings into the nested LSP init-options shape.
    // The TOML we render is the same shape Raven's server consumes.
    const config = vscode.workspace.getConfiguration('raven');
    const initOptions = buildInitializationOptions(config);
    const body = renderRavenToml(initOptions.linting as Record<string, unknown> | undefined);
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(target, encoder.encode(body));
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc);
}

function renderRavenToml(linting: Record<string, unknown> | undefined): string {
    const lines: string[] = ['# Generated by Raven: Create raven.toml', ''];
    lines.push('[linting]');
    // Keep this list exhaustive across every `raven.linting.*` key the
    // server understands so the scaffold faithfully mirrors explicit VS
    // Code settings in portable config. Missing a severity here would
    // create behavior drift for CLI / non-VS-Code consumers, where
    // `raven.toml` is the shared source of truth. Any new lint rule
    // should add both its value key (if it has one) and its severity
    // key here at the time the rule is added.
    const severities: [string, string][] = [
        ['lineLengthSeverity', 'hint'],
        ['trailingWhitespaceSeverity', 'hint'],
        ['noTabSeverity', 'hint'],
        ['trailingBlankLinesSeverity', 'hint'],
        ['assignmentOperatorSeverity', 'hint'],
        ['objectNameSeverity', 'hint'],
        ['infixSpacesSeverity', 'hint'],
        ['commentedCodeSeverity', 'hint'],
        ['quotesSeverity', 'hint'],
        ['commasSeverity', 'hint'],
        ['tAndFSymbolSeverity', 'hint'],
        ['semicolonSeverity', 'hint'],
        ['equalsNaSeverity', 'hint'],
        ['objectLengthSeverity', 'hint'],
        ['vectorLogicSeverity', 'hint'],
        ['functionLeftParenthesesSeverity', 'hint'],
        ['spacesInsideSeverity', 'hint'],
        ['indentationSeverity', 'hint'],
    ];
    const entries: [string, unknown, string][] = [
        ['enabled', false, 'master switch'],
        ['lineLength', 80, 'maximum line length (UTF-16 code units)'],
        ['objectLength', 30, 'maximum identifier length'],
        ['indentationUnit', 2, 'expected indent unit'],
        ['assignmentOperator', '<-', '"<-" or "="'],
        ['stringDelimiter', '"', '"\\"" or "\'"'],
        ['objectNameStyleFunction', 'snake_case', 'or camelCase, dotted.case, UPPER_CASE, lowercase, any'],
        ['objectNameStyleVariable', 'snake_case', 'as above'],
        ['objectNameStyleArgument', 'snake_case', 'as above'],
        ...severities.map<[string, unknown, string]>(([k, d]) => [
            k,
            d,
            'error | warning | information | hint | off',
        ]),
    ];
    const ravenDefaultEnabled = false; // mirror VS Code package.json default
    for (const [key, dflt, comment] of entries) {
        const fromUser = linting?.[key];
        // `enabled` is special: the init-options factory always emits it
        // (see initializationOptions.ts:367), so the "is this explicit?"
        // heuristic above doesn't apply. Treat enabled as explicit only when
        // it differs from the package.json default.
        const isExplicit = key === 'enabled'
            ? fromUser !== undefined && fromUser !== ravenDefaultEnabled
            : fromUser !== undefined;
        const value = isExplicit ? fromUser : dflt;
        const prefix = isExplicit ? '' : '# ';
        lines.push(`${prefix}${key} = ${toTomlScalar(value)}    # ${comment}`);
    }
    lines.push('');
    return lines.join('\n');
}

function toTomlScalar(v: unknown): string {
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'boolean' || typeof v === 'number') return String(v);
    return JSON.stringify(v);
}

let active_plot_services: PlotServices | null = null;

export function deactivate(): Thenable<void> | undefined {
    const stops: Thenable<void>[] = [];
    if (active_plot_services) stops.push(active_plot_services.dispose());
    if (client) stops.push(client.stop());
    if (stops.length === 0) return undefined;
    return Promise.all(stops).then(() => undefined);
}
