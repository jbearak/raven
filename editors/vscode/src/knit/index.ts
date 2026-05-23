import * as child_process from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { registerKnitCommands, runKnitWithExistingController } from './knit-commands';
import { disposeKnitGrammarRegistryForDeactivation, runPostKnitRender as postKnitRender } from './post-knit-renderer';
import { runKnit as knitEngineRun } from './knit-engine';
import {
    cleanupCurrentSession,
    initSessionState,
    maybeCurrentSession,
    sweepStaleSessions,
} from './session-state';
import { PandocResolver } from './pandoc-detect';
import { OperationRegistry } from './operation-controller';
import { registerExportCommands } from './export-commands';
import { KnitOutputPanel } from './knit-output-panel';
import { previewArtifactPaths } from './raven-knit-paths';

export { disposeKnitGrammarRegistryForDeactivation };
export { runExport } from './export-commands';
export type { ExportDeps } from './export-commands';

/**
 * Register `Raven: Knit` and its output-channel command. The commands
 * are registered unconditionally so walkthrough deep-links work even
 * when the resolved gate is closed; the handler re-checks
 * `resolveRConsoleActivation()` at invocation and surfaces an info
 * message if the gate has since closed (e.g. REditorSupport was enabled
 * after activation).
 *
 * The `raven.rmdKnit.enabled` context key controls whether the
 * command-palette entry is visible — set from the *resolved* gate, not
 * the raw setting.
 *
 * `getLanguageClient` is a thunk over the (singleton) LSP client so
 * the post-knit renderer can fetch Raven's `function` semantic tokens
 * for R code blocks at render time, after the LSP has finished
 * activating. The thunk pattern handles the activation race: knit can
 * be invoked from a walkthrough button before the LSP fully starts,
 * and the renderer tolerates `undefined` by falling back to
 * grammar-only highlighting.
 *
 * Also initializes the per-session knit state (workspaceHash +
 * sessionId) so the temp-dir layout under `<tmpdir>/raven-knit/...`
 * isolates this VS Code window from concurrent ones, and kicks off a
 * background sweep of stale (>7 day) sibling sessions.
 */
export function registerKnit(
    context: vscode.ExtensionContext,
    enabledFromGate: boolean,
    getLanguageClient?: () => LanguageClient | undefined,
): void {
    void vscode.commands.executeCommand(
        'setContext',
        'raven.rmdKnit.enabled',
        enabledFromGate,
    );

    // Idempotency guard — if the extension is re-activated within the
    // same process (rare, but happens in dev with reload-extension)
    // we don't want to clobber the existing session id.
    if (maybeCurrentSession() === null) {
        // First workspace folder URI wins; falls back to the workspace
        // file URI (for `.code-workspace` setups); falls back to `null`
        // which `initSessionState` then interprets as "single-file mode"
        // and asks the caller to provide a fallback per source.
        const workspaceUri =
            vscode.workspace.workspaceFolders?.[0]?.uri.toString()
            ?? vscode.workspace.workspaceFile?.toString()
            ?? null;
        initSessionState({ sessionId: crypto.randomUUID(), workspaceUri });
        context.subscriptions.push({
            dispose: () => { void cleanupCurrentSession(); },
        });
        // Non-blocking sweep of orphaned sibling sessions. Best effort —
        // errors are swallowed inside `sweepStaleSessions`.
        void sweepStaleSessions(path.join(os.tmpdir(), 'raven-knit'));
    }

    // One shared output channel for both knit and export. Two
    // independently-named "Raven: Knit" channels would confuse the
    // "Show Knit Output" command, so we create it here and inject it
    // into both registration paths.
    const knitOutput = vscode.window.createOutputChannel('Raven: Knit');
    context.subscriptions.push(knitOutput);
    // Shared OperationRegistry across knit + export so an in-flight
    // knit blocks a same-source export (and vice versa). Webview cancel
    // commands look up controllers via canonicalOpKey.
    const registry = new OperationRegistry();
    // Wire the preview-dir deleter so KnitOutputPanel.onDidDispose ->
    // registry.requestPreviewDirDeletion -> async rm. When an export
    // is mid-flight the rm is deferred until the last unpin.
    registry.setPreviewDirDeleter(async (previewDir, previewKey) => {
        try {
            await fs.promises.rm(previewDir, { recursive: true, force: true });
        } catch (err) {
            knitOutput.appendLine(
                `[knit] failed to remove preview dir ${previewDir} (key=${previewKey}): ${(err as Error).message}`,
            );
        }
    });
    KnitOutputPanel.setOnDidDisposeHandler((rmdAbsPath: string) => {
        try {
            const paths = previewArtifactPaths(rmdAbsPath);
            registry.requestPreviewDirDeletion(paths.previewKey, paths.previewDir);
        } catch {
            // session uninitialized — nothing to clean up
        }
    });
    // Pin/unpin handlers let the panel hold the preview dir alive
    // across the Export ▾ QuickPick. Closes the race where the user
    // dismisses the panel while picking a format — the disposal
    // handler would otherwise request deletion before the export
    // pipeline has taken its own pin.
    KnitOutputPanel.setPreviewPinHandlers(
        (rmdAbsPath: string) => {
            try { registry.pinPreviewDir(previewArtifactPaths(rmdAbsPath).previewKey); }
            catch { /* session uninitialized */ }
        },
        (rmdAbsPath: string) => {
            try { registry.unpinPreviewDir(previewArtifactPaths(rmdAbsPath).previewKey); }
            catch { /* session uninitialized */ }
        },
    );
    registerKnitCommands(
        context,
        {
            getLanguageClient,
            sharedOutput: knitOutput,
            sharedRegistry: registry,
        },
    );

    // Export commands (Pandoc-driven HTML/PDF/Word). The resolver is
    // shared across export invocations so the once-per-session probe is
    // amortized; settings changes invalidate the cache.
    const resolver = new PandocResolver({
        getConfigured: () =>
            vscode.workspace.getConfiguration('raven').get<string>('pandoc.path', ''),
        access: (p) => fs.promises.access(p, fs.constants.X_OK),
        spawn: (bin) => probePandocBinary(bin),
    });
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('raven.pandoc.path')) resolver.invalidate();
        }),
    );
    // The same registry from above feeds the export pipeline so
    // beginOp on either side respects the other's in-flight slot.
    // For editor-toolbar export, runKnit runs UNDER the export-*
    // controller already taken out by runExport. We must NOT re-enter
    // the registry's beginOp here — that would falsely report busy on
    // the same source key. `runKnitWithExistingController` is the
    // explicit re-entry point that skips the busy gate, leaving the
    // outer export controller as the single registry slot.
    registerExportCommands(context, {
        resolver,
        registry,
        getOutput: () => knitOutput,
        runKnit: async (uri) => {
            await runKnitWithExistingController(
                uri,
                knitOutput,
                context,
                {
                    runKnit: knitEngineRun,
                    showOrUpdatePanel: KnitOutputPanel.showOrUpdate,
                    getLanguageClient: getLanguageClient ?? (() => undefined),
                    runPostKnitRender: postKnitRender,
                },
            );
        },
    });
}

function probePandocBinary(bin: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const child = child_process.spawn(bin, ['--version']);
        let out = '';
        child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`pandoc exit ${code}`))));
    });
}
