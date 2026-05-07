import * as vscode from 'vscode';
import { PlotSessionServer } from './session-server';
import { PlotViewerPanel } from './plot-viewer-panel';

/**
 * Per-window plot services. Lazily started on first managed terminal
 * creation when raven.plot.enabled is true; restarted by raven.restart;
 * disposed on extension deactivation.
 */
export class PlotServices {
    readonly server = new PlotSessionServer();
    readonly panel: PlotViewerPanel;
    private started = false;
    private start_failed = false;

    constructor(context: vscode.ExtensionContext) {
        this.panel = new PlotViewerPanel(context, this.server);
        this.panel.attach();
    }

    isEnabled(): boolean {
        return vscode.workspace.getConfiguration('raven.plot').get<boolean>('enabled', true);
    }

    async ensureStarted(): Promise<boolean> {
        if (this.started) return true;
        if (this.start_failed) return false;
        if (!this.isEnabled()) return false;
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
        this.started = false;
        this.start_failed = false;
    }

    async dispose(): Promise<void> {
        this.panel.dispose();
        await this.server.stop();
        this.started = false;
    }
}
