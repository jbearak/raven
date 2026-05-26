/** Entry point for the data viewer. Wires the manager into the existing
 *  RSessionServer event stream and runs the activation-time stale-file sweep. */

import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';

import { DataViewerManager } from './manager';
import { LayoutStore } from './layout-state';
import { ToolbarStateStore } from './toolbar-state';
import { SortStateStore } from './sort-state';
import { FilterStateStore } from './filter-state';
import type { Settings } from './messages';
import { sweep_stale } from './sweep';
import type { RSessionServer } from '../r-session-server';

const STALE_MAX_AGE_MS = 24 * 3600 * 1000;

export function registerDataViewer(
    context: vscode.ExtensionContext,
    server: RSessionServer,
    dataViewerDir: string,
): DataViewerManager {
    const cap = vscode.workspace.getConfiguration('raven.dataViewer')
        .get<number>('maxStoredLayouts', 10000);
    const store = new LayoutStore(context.globalState as any, cap);
    const toolbarStore = new ToolbarStateStore(context.globalState as any, cap);
    const sortStore = new SortStateStore(context.globalState as any, cap);
    const filterStore = new FilterStateStore(context.globalState as any, cap);

    const settings = (): Settings => {
        const cfg = vscode.workspace.getConfiguration('raven.dataViewer');
        return {
            missingValueStyle: cfg.get<'foreground' | 'background' | 'none'>(
                'missingValueStyle', 'foreground'),
            defaultDigits: cfg.get<number>('defaultDigits', 3),
            persistSort: cfg.get<boolean>('persistSort', true),
            persistFilters: cfg.get<boolean>('persistFilters', true),
        };
    };

    const manager = new DataViewerManager(
        context.extensionUri,
        store,
        toolbarStore,
        sortStore,
        filterStore,
        settings,
    );

    context.subscriptions.push({
        dispose: server.onEvent(e => {
            if (e.type === 'view-data-requested') {
                void manager.onViewDataRequested(e);
            } else if (e.type === 'data-viewer-warning' && e.reason === 'missing-arrow') {
                vscode.window.showWarningMessage(e.message);
            }
        }),
    });

    // Best-effort background setup: ensure the directory exists, then sweep
    // stale files. Returning the manager synchronously means tests / consumers
    // never observe a window where the manager is undefined; the directory is
    // (re)created lazily by callers that actually write into it.
    void fs.mkdir(dataViewerDir, { recursive: true })
        .then(() => sweep_stale(dataViewerDir, STALE_MAX_AGE_MS))
        .catch(() => undefined);

    return manager;
}

export function dataViewerDirOf(context: vscode.ExtensionContext): string {
    return join(context.globalStorageUri.fsPath, 'data-viewer');
}
