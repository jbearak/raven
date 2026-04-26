import * as path from 'path';
import * as vscode from 'vscode';
import {
    ExecuteCommandRequest,
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
} from 'vscode-languageclient/node';
import { registerAutoCloseFix } from './autoCloseFix';
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

export function activate(context: vscode.ExtensionContext) {
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
    };

    client = new LanguageClient(
        'raven',
        'Raven - R Language Server',
        serverOptions,
        clientOptions
    );

    client.start();

    // Register restart command — re-reads trace config so changed settings take effect
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

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
