import * as vscode from 'vscode';
import { PlotEvent, RSessionEvent, RSessionServer } from '../r-session-server';
import { PlotViewerPanel } from './plot-viewer-panel';

/**
 * Per-window plot services. Lazily started on first managed terminal
 * creation when raven.plot.enabled is true; disposed on extension
 * deactivation. Intentionally NOT torn down by raven.restart — existing
 * Raven-managed R terminals already hold the current session port/token
 * in their environment, so cycling the server would leave them POSTing
 * to a dead port until the user closes them.
 *
 * Owns one `PlotViewerPanel` per R session. The first /plot-available
 * event for a session creates that session's panel; closing the panel
 * causes the next plot from the same session to recreate it. Panel
 * indices are stable per session for the lifetime of the window so a
 * recreated panel keeps its "R Plots N" label.
 */
export class PlotServices {
    readonly server: RSessionServer;
    private readonly context: vscode.ExtensionContext;
    private readonly panels = new Map<string, PlotViewerPanel>();
    private readonly session_indices = new Map<string, number>();
    private next_panel_index = 1;
    private detach_session_listener: (() => void) | null = null;
    private config_subscription: vscode.Disposable | null = null;
    private started = false;
    private start_failed = false;

    /**
     * @param dataViewerDir
     *   When non-empty, the loopback session server's /view-data route
     *   accepts files under this absolute path. Pass '' (default) to
     *   disable the data viewer entirely (route returns 404).
     */
    constructor(context: vscode.ExtensionContext, dataViewerDir: string = '') {
        this.server = new RSessionServer(dataViewerDir);
        this.context = context;
        this.detach_session_listener = this.server.onEvent(e => this.on_server_event(e));
        this.config_subscription = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('raven.plot.enabled') && !this.isEnabled()) {
                // User disabled the plot viewer: tear down the running server
                // and any open panels so future terminals don't pick up plot
                // bootstrap env, and existing webviews close. Re-enabling later
                // re-starts on the next ensureStarted() call.
                void this.shutdown_for_disable();
            }
        });
    }

    isEnabled(): boolean {
        return vscode.workspace.getConfiguration('raven.plot').get<boolean>('enabled', true);
    }

    async ensureStarted(): Promise<boolean> {
        // Re-check enablement on every call: a previously-started server must
        // not keep handing out plot env after the user disables the setting.
        if (!this.isEnabled()) {
            if (this.started) await this.shutdown_for_disable();
            return false;
        }
        if (this.started) return true;
        if (this.start_failed) return false;
        try {
            await this.server.start();
            this.started = true;
            return true;
        } catch (err) {
            this.start_failed = true;
            const ch = vscode.window.createOutputChannel('Raven');
            ch.appendLine(`Raven plot session server failed to start: ${err}`);
            return false;
        }
    }

    async restart(): Promise<void> {
        await this.server.stop();
        this.dispose_all_panels();
        this.session_indices.clear();
        this.next_panel_index = 1;
        this.started = false;
        this.start_failed = false;
    }

    async dispose(): Promise<void> {
        this.detach_session_listener?.();
        this.detach_session_listener = null;
        this.config_subscription?.dispose();
        this.config_subscription = null;
        this.dispose_all_panels();
        await this.server.stop();
        this.started = false;
    }

    private async shutdown_for_disable(): Promise<void> {
        this.dispose_all_panels();
        this.session_indices.clear();
        this.next_panel_index = 1;
        await this.server.stop();
        this.started = false;
        this.start_failed = false;
    }

    private dispose_all_panels(): void {
        // Snapshot first: panel.dispose() triggers onDisposed which mutates the
        // map, so iterating the live map would skip entries.
        const panels = Array.from(this.panels.values());
        this.panels.clear();
        for (const p of panels) p.dispose();
    }

    private on_server_event(event: RSessionEvent): void {
        // PlotServices only handles plot-related events; the data viewer
        // manager subscribes separately for view-data-requested.
        if (event.type === 'view-data-requested') return;
        const e = event as PlotEvent;
        if (e.type === 'plot-available') {
            const panel = this.get_or_create_panel(e.sessionId);
            panel.notifyPlotAvailable();
        } else if (e.type === 'session-ended') {
            this.panels.get(e.sessionId)?.notifySessionEnded();
        }
    }

    private get_or_create_panel(sessionId: string): PlotViewerPanel {
        const existing = this.panels.get(sessionId);
        if (existing) return existing;
        const panelIndex = this.assign_or_recall_index(sessionId);
        const panel: PlotViewerPanel = new PlotViewerPanel(
            this.context,
            this.server,
            sessionId,
            panelIndex,
            {
                onDisposed: () => {
                    if (this.panels.get(sessionId) === panel) {
                        this.panels.delete(sessionId);
                    }
                },
            },
        );
        this.panels.set(sessionId, panel);
        return panel;
    }

    private assign_or_recall_index(sessionId: string): number {
        let idx = this.session_indices.get(sessionId);
        if (idx === undefined) {
            idx = this.next_panel_index++;
            this.session_indices.set(sessionId, idx);
        }
        return idx;
    }
}
