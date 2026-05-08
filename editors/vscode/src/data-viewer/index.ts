/** Entry point for the data viewer. Wires the manager into the existing
 *  RSessionServer event stream and runs the activation-time stale-file sweep. */

import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';

import { DataViewerManager } from './manager';
import { LayoutStore } from './layout-state';
import type { Settings } from './messages';
import { sweep_stale } from './sweep';
import type { RSessionServer } from '../r-session-server';

const STALE_MAX_AGE_MS = 24 * 3600 * 1000;

export async function registerDataViewer(
    context: vscode.ExtensionContext,
    server: RSessionServer,
    dataViewerDir: string,
): Promise<DataViewerManager> {
    const cap = vscode.workspace.getConfiguration('raven.dataViewer')
        .get<number>('maxStoredLayouts', 10000);
    const store = new LayoutStore(context.globalState as any, cap);

    const settings = (): Settings => {
        const cfg = vscode.workspace.getConfiguration('raven.dataViewer');
        return {
            missingValueStyle: cfg.get<'foreground' | 'background' | 'none'>(
                'missingValueStyle', 'foreground'),
            defaultDigits: cfg.get<number>('defaultDigits', 3),
        };
    };

    const manager = new DataViewerManager(context.extensionUri, store, settings);

    // Best-effort: ensure the directory exists, then sweep stale files.
    try { await fs.mkdir(dataViewerDir, { recursive: true }); } catch { /* ignore */ }
    void sweep_stale(dataViewerDir, STALE_MAX_AGE_MS);

    context.subscriptions.push({
        dispose: server.onEvent(e => {
            if (e.type === 'view-data-requested') {
                void manager.onViewDataRequested(e);
            }
        }),
    });

    return manager;
}

export function dataViewerDirOf(context: vscode.ExtensionContext): string {
    return join(context.globalStorageUri.fsPath, 'data-viewer');
}
