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
import { ToolbarStateStore } from './toolbar-state';
import { SortStateStore } from './sort-state';
import { FilterStateStore } from './filter-state';
import { Settings } from './messages';
import { sweep_stale } from './sweep';
import type { ViewDataEvent } from '../r-session-server/types';

export class DataViewerManager {
    private readonly panels = new Map<string, DataViewerPanel>();
    private readonly serializer = new Serializer();

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly store: LayoutStore,
        private readonly toolbarStore: ToolbarStateStore,
        private readonly sortStore: SortStateStore,
        private readonly filterStore: FilterStateStore,
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
                    e.panelName, reader, e.filePath,
                    this.store, this.toolbarStore, this.sortStore, this.filterStore, this.settings(),
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

    /** Panel names currently open — used by the test harness. */
    getPanelNames(): string[] {
        return [...this.panels.keys()];
    }

    /** Column names for a named panel — used by the test harness. */
    getPanelColumnNames(panelName: string): string[] | undefined {
        return this.panels.get(panelName)?.getColumnNames();
    }

    /** Latest visible-row range for a named panel — used by the test
     *  harness to verify scroll position. */
    getPanelVisibleRange(panelName: string): { start: number; end: number } | undefined {
        return this.panels.get(panelName)?.getVisibleRange();
    }

    /** Latest on-screen row range for a named panel, excluding overscan. */
    getPanelViewportRange(panelName: string): { start: number; end: number } | undefined {
        return this.panels.get(panelName)?.getViewportRange();
    }

    /** Latest selected focus cell for a named panel. */
    getPanelFocusCell(panelName: string): { row: number; col: number } | undefined {
        return this.panels.get(panelName)?.getFocusCell();
    }

    /** Test-only: dispatch a synthetic key event in a named panel's
     *  webview. Awaiting waits for the message to be queued, not for any
     *  reply; tests should poll `getPanelVisibleRange()` to observe
     *  results. */
    async pressKeyOnPanel(panelName: string, key: string): Promise<void> {
        await this.panels.get(panelName)?.pressKey(key);
    }

    /** Test-only: scroll the named panel to a fractional vertical position.
     *  fraction=0 jumps to top, fraction=1 jumps to bottom. Awaiting
     *  waits for message queuing; tests should poll
     *  `getPanelVisibleRange()` to observe results. */
    async dragScrollbarOnPanel(panelName: string, fraction: number): Promise<void> {
        await this.panels.get(panelName)?.dragScrollbar(fraction);
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
