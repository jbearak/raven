import * as vscode from 'vscode';
import { RSessionEvent, RSessionServer } from '../r-session-server';
import { PlotViewerPanel } from './plot-viewer-panel';

/**
 * Per-window plot services. Constructed only when Raven's R console is
 * active (see `raven.rConsole.activation`); started lazily on the first
 * managed-terminal creation; disposed on extension deactivation.
 * Intentionally NOT torn down by raven.restart — existing Raven-managed R
 * terminals already hold the current session port/token in their
 * environment, so cycling the server would leave them POSTing to a dead
 * port until the user closes them.
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
    private started = false;
    private start_failed = false;

    /**
     * @param dataViewerDir
     *   The absolute path the loopback session server's /view-data route
     *   accepts files under. The data viewer is gated by the same
     *   `raven.rConsole.activation` setting as the rest of the R console,
     *   so when this constructor runs the data viewer is always active.
     */
    constructor(context: vscode.ExtensionContext, dataViewerDir: string) {
        this.server = new RSessionServer(dataViewerDir);
        this.context = context;
        this.detach_session_listener = this.server.onEvent(e => this.on_server_event(e));
    }

    async ensureStarted(): Promise<boolean> {
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
        this.dispose_all_panels();
        await this.server.stop();
        this.started = false;
    }

    /**
     * Re-push state-update to every open plot panel. Called after a
     * `set-theme-applied` write so all panels (not just the one that
     * was clicked) reflect the new value. The state-update payload
     * reads the persisted theme value via
     * `PlotViewerPanel.readThemePreference`, so this orchestrator
     * doesn't need to know the storage key string — single source of
     * truth lives on the panel class.
     */
    broadcastStateUpdate(): void {
        for (const panel of this.panels.values()) {
            panel.postStateUpdate();
        }
    }

    private dispose_all_panels(): void {
        // Snapshot first: panel.dispose() triggers onDisposed which mutates the
        // map, so iterating the live map would skip entries.
        const panels = Array.from(this.panels.values());
        this.panels.clear();
        for (const p of panels) p.dispose();
    }

    private on_server_event(event: RSessionEvent): void {
        if (event.type === 'plot-available') {
            const panel = this.get_or_create_panel(event.sessionId);
            panel.notifyPlotAvailable();
        } else if (event.type === 'session-ended') {
            this.panels.get(event.sessionId)?.notifySessionEnded();
        } else if (event.type === 'plot-warning') {
            vscode.window.showWarningMessage(event.message);
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
