import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OperationRegistry, type OperationController } from '../../editors/vscode/src/knit/operation-controller';
import { previewArtifactPaths } from '../../editors/vscode/src/knit/raven-knit-paths';
import { __resetSessionStateForTests, cleanupCurrentSession, initSessionState } from '../../editors/vscode/src/knit/session-state';

type CommandCallback = (...args: unknown[]) => unknown;

const registeredCommands = new Map<string, CommandCallback>();
const warnings: string[] = [];

mock.module('vscode', () => ({
    ProgressLocation: { Notification: 15 },
    Uri: {
        file: (fsPath: string) => fileUri(fsPath),
        parse: (value: string) => ({ fsPath: value, path: value, scheme: value.split(':', 1)[0], toString: () => value }),
    },
    commands: {
        registerCommand: (id: string, callback: CommandCallback) => {
            registeredCommands.set(id, callback);
            return { dispose: () => registeredCommands.delete(id) };
        },
        executeCommand: async () => undefined,
    },
    env: {
        openExternal: async () => true,
    },
    window: {
        activeTextEditor: undefined,
        showWarningMessage: async (message: string) => {
            warnings.push(message);
            return undefined;
        },
        showInformationMessage: async () => undefined,
        showErrorMessage: async () => undefined,
        withProgress: async (_opts: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) => {
            return await task({}, { onCancellationRequested: () => ({ dispose() {} }) });
        },
    },
    workspace: {
        fs: {
            readFile: async (uri: { fsPath: string }) => await fs.promises.readFile(uri.fsPath),
        },
        getWorkspaceFolder: () => undefined,
        getConfiguration: () => ({
            get: (_key: string, fallback: unknown) => fallback,
        }),
    },
}));

function fileUri(fsPath: string) {
    return { fsPath, path: fsPath, scheme: 'file', toString: () => `file://${fsPath}` };
}

function outputChannel() {
    return {
        append() {},
        appendLine() {},
        show() {},
    };
}

function fakePandocExecutable(dir: string): string {
    const executable = path.join(dir, 'fake-pandoc');
    fs.writeFileSync(
        executable,
        `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const outIndex = args.lastIndexOf('-o');
if (outIndex < 0 || !args[outIndex + 1]) process.exit(2);
const out = args[outIndex + 1];
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, 'converted');
`,
    );
    fs.chmodSync(executable, 0o755);
    return executable;
}

function writeRmd(dir: string, name = 'report.Rmd'): string {
    const rmdPath = path.join(dir, name);
    fs.writeFileSync(rmdPath, '---\noutput: html_document\n---\n\nBody\n');
    return rmdPath;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-export-test-'));
    try {
        return await fn(dir);
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
}

async function loadExportCommands() {
    return await import('../../editors/vscode/src/knit/export-commands');
}

beforeEach(() => {
    registeredCommands.clear();
    warnings.length = 0;
    __resetSessionStateForTests();
    initSessionState({ sessionId: `test-${Date.now()}`, workspaceUri: null });
});

afterEach(async () => {
    await cleanupCurrentSession();
    __resetSessionStateForTests();
});

describe('export commands', () => {
    it('pins the preview dir while editor-toolbar export re-knits into it', async () => {
        await withTempDir(async (dir) => {
            const { runExport } = await loadExportCommands();
            const rmdPath = writeRmd(dir);
            const previewPaths = previewArtifactPaths(rmdPath);
            const registry = new OperationRegistry();
            let refsDuringKnit = -1;

            await runExport(fileUri(rmdPath), 'html', {
                resolver: { resolve: async () => fakePandocExecutable(dir) },
                registry,
                getOutput: () => outputChannel(),
                runKnit: async (_uri: unknown, _controller: OperationController) => {
                    refsDuringKnit = registry.previewRefs(previewPaths.previewKey);
                    await fs.promises.mkdir(previewPaths.previewDir, { recursive: true });
                    await fs.promises.writeFile(previewPaths.mdPath, '# knitted\n');
                    return { ok: true };
                },
            }, { entry: 'editor-toolbar' });

            expect(refsDuringKnit).toBe(1);
            expect(registry.previewRefs(previewPaths.previewKey)).toBe(0);
        });
    });

    it('drops stale panel-disposal deletion after editor-toolbar re-knit succeeds', async () => {
        await withTempDir(async (dir) => {
            const { runExport } = await loadExportCommands();
            const rmdPath = writeRmd(dir);
            const previewPaths = previewArtifactPaths(rmdPath);
            const registry = new OperationRegistry();
            const deleted: string[] = [];

            registry.setPreviewDirDeleter((previewDir) => {
                deleted.push(previewDir);
            });

            await runExport(fileUri(rmdPath), 'html', {
                resolver: { resolve: async () => fakePandocExecutable(dir) },
                registry,
                getOutput: () => outputChannel(),
                runKnit: async () => {
                    registry.requestPreviewDirDeletion(previewPaths.previewKey, previewPaths.previewDir);
                    await fs.promises.mkdir(previewPaths.previewDir, { recursive: true });
                    await fs.promises.writeFile(previewPaths.mdPath, '# knitted\n');
                    return { ok: true };
                },
            }, { entry: 'editor-toolbar' });

            expect(deleted).toEqual([]);
            expect(registry.previewRefs(previewPaths.previewKey)).toBe(0);
        });
    });

    it('accepts uppercase .RMD files from registered export commands', async () => {
        await withTempDir(async (dir) => {
            const { registerExportCommands } = await loadExportCommands();
            const rmdPath = writeRmd(dir, 'REPORT.RMD');
            const previewPaths = previewArtifactPaths(rmdPath);
            const registry = new OperationRegistry();
            let knitCount = 0;

            registerExportCommands({ subscriptions: [] } as any, {
                resolver: { resolve: async () => fakePandocExecutable(dir) },
                registry,
                getOutput: () => outputChannel(),
                runKnit: async () => {
                    knitCount++;
                    await fs.promises.mkdir(previewPaths.previewDir, { recursive: true });
                    await fs.promises.writeFile(previewPaths.mdPath, '# knitted\n');
                    return { ok: true };
                },
            });

            const command = registeredCommands.get('raven.knit.exportHtml');
            expect(command).toBeDefined();
            await command?.(fileUri(rmdPath));

            expect(knitCount).toBe(1);
            expect(warnings).toEqual([]);
        });
    });
});
