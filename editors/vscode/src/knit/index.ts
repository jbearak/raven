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
import { isPandocVersionOutput } from './pandoc-probe';

export { disposeKnitGrammarRegistryForDeactivation };
export { runExport } from './export-commands';
export type { ExportDeps } from './export-commands';

/**
 * Register `Raven: Knit Preview` and its output-channel command. The commands
 * are registered unconditionally so user keybindings and `tasks.json`
 * entries keep working even when the resolved gate is closed; the
 * handler re-checks `resolveRConsoleActivation()` at invocation and
 * surfaces an info message if the gate has since closed (e.g.
 * REditorSupport was enabled after activation).
 *
 * The `raven.rmdKnit.enabled` context key controls whether the
 * command-palette entry is visible — set from the *resolved* gate, not
 * the raw setting.
 *
 * `getLanguageClient` is a thunk over the (singleton) LSP client so
 * the post-knit renderer can fetch Raven's `function` semantic tokens
 * for R code blocks at render time, after the LSP has finished
 * activating. The thunk pattern handles the activation race: knit can
 * be invoked before the LSP fully starts (e.g. immediately after
 * extension activation), and the renderer tolerates `undefined` by
 * falling back to grammar-only highlighting.
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
        runKnit: async (uri, exportController) => {
            return await runKnitWithExistingController(
                uri,
                knitOutput,
                context,
                {
                    runKnit: knitEngineRun,
                    showOrUpdatePanel: KnitOutputPanel.showOrUpdate,
                    getLanguageClient: getLanguageClient ?? (() => undefined),
                    runPostKnitRender: postKnitRender,
                },
                exportController,
            );
        },
        notifyExportBusy: (rmdAbsPath, busy) => {
            KnitOutputPanel.notifyExportBusy(rmdAbsPath, busy);
        },
    });
}

/**
 * Probe `<bin> --version` and verify it's actually Pandoc. Resolves to
 * trimmed stdout on a clean exit AND the first non-empty stdout line
 * begins with `pandoc` (case-insensitive). Rejects otherwise.
 *
 * Why the version-string check: a bare `code === 0` gate accepts any
 * executable that handles `--version` cleanly. On macOS `/bin/echo
 * --version` exits 0 and prints `--version`; on Linux many GNU coreutils
 * accept `--version` and exit 0. Without parsing the output, a user who
 * mistypes `raven.pandoc.path` (or a malicious workspace-committed
 * setting on a trusted workspace) could route export through the wrong
 * binary. Pandoc itself always emits a line starting with `pandoc 3.x`
 * — see <https://pandoc.org/MANUAL.html#options>.
 *
 * `--version` should respond within milliseconds; a much higher cap is
 * a backstop against a wedged binary (broken shared libraries, hanging
 * AV scanners on Windows, etc.) blocking the first export forever. A
 * hung probe would otherwise leave the export's progress notification
 * spinning with no way to recover except restarting VS Code, since
 * `PandocResolver` is the gate before the cancellable Pandoc subprocess.
 */
const PANDOC_PROBE_TIMEOUT_MS = 10_000;

function probePandocBinary(bin: string, timeoutMs: number = PANDOC_PROBE_TIMEOUT_MS): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        // Close stdin and pipe both stdout/stderr — if a Pandoc build
        // writes startup warnings to stderr (locale, missing optional
        // libs) and the buffer fills, the child blocks on write(2). The
        // probe's hard timeout would then misreport Pandoc as not
        // installed. Drain both streams to keep the pipes flowing.
        const child = child_process.spawn(bin, ['--version'], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
            reject(new Error(`pandoc probe timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
        // Drain stderr so the OS pipe buffer cannot fill.
        child.stderr?.on('data', () => { /* swallow */ });
        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`pandoc exit ${code}`));
                return;
            }
            const trimmed = out.trim();
            if (!isPandocVersionOutput(trimmed)) {
                reject(new Error(`not pandoc: --version output did not start with 'pandoc'`));
                return;
            }
            resolve(trimmed);
        });
    });
}
