/**
 * DataViewerManager — routes view-data-requested events from the
 * RSessionServer to one DataViewerPanel per panelName.
 *
 * Events are processed strictly in event-loop order: a name collision
 * causes the manager to await the existing panel's replace step before
 * accepting the next one. There is no timeout / forced-replace fallback.
 *
 * Also owns the activation-time stale-file sweep of the per-extension
 * data-viewer directory.
 */

import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';

import { ArrowSliceReader } from './arrow-reader';
import { DataViewerPanel } from './panel';
import { LayoutStore } from './layout-state';
import { Settings } from './messages';
import { sweep_stale } from './sweep';
import type { ViewDataEvent } from '../r-session-server/types';

export class DataViewerManager {
    private readonly panels = new Map<string, DataViewerPanel>();
    private readonly serializer = new Serializer();

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly store: LayoutStore,
        private readonly settings: () => Settings,
    ) {}

    async onViewDataRequested(e: ViewDataEvent): Promise<void> {
        await this.serializer.run(async () => {
            try {
                const reader = await ArrowSliceReader.open(e.filePath);
                const existing = this.panels.get(e.panelName);
                if (existing) {
                    await existing.replace(reader, e.filePath);
                    existing.reveal();
                    return;
                }
                const panel = await DataViewerPanel.create(
                    e.panelName, reader, e.filePath, this.store, this.settings(),
                    this.extensionUri,
                    () => { this.panels.delete(e.panelName); },
                );
                this.panels.set(e.panelName, panel);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                void vscode.window.showErrorMessage(
                    `Raven data viewer: failed to open ${e.panelName}: ${msg}`,
                );
                // Best-effort: delete the file we couldn't read.
                try { await fs.unlink(e.filePath); } catch { /* ignore */ }
            }
        });
    }

    /** For tests + activation; delegates to {@link sweep_stale}. */
    static sweepStale = sweep_stale;
}

/** Serialize async work submitted via run(). Each submitted callback only
 *  starts after the previous one settled — used to make replace events for
 *  the same panel name strictly ordered. */
class Serializer {
    private tail: Promise<unknown> = Promise.resolve();
    run<T>(fn: () => Promise<T>): Promise<T> {
        const next = this.tail.then(() => fn(), () => fn());
        this.tail = next.catch(() => undefined);
        return next;
    }
}
