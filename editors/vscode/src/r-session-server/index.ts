import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import {
    PlotEvent,
    RSessionEvent,
    RSessionEventListener,
    SessionInfo,
    ViewDataEvent,
} from './types';

export type { PlotEvent, RSessionEvent, RSessionEventListener, SessionInfo, ViewDataEvent };
/** @deprecated Use {@link RSessionEventListener}. */
export type PlotEventListener = RSessionEventListener;

const MAX_BODY_BYTES = 64 * 1024;

export class RSessionServer {
    private server: http.Server | null = null;
    private _port = 0;
    private _token = '';
    private sessions = new Map<string, SessionInfo>();
    private listeners = new Set<RSessionEventListener>();
    private active_session_id: string | null = null;
    private readonly allowed_data_viewer_dir: string;

    /**
     * @param allowed_data_viewer_dir
     *   Absolute path of the directory under which `/view-data` filePaths must
     *   resolve. When empty, `/view-data` returns 404 — used in plot-only
     *   contexts where the data viewer is disabled or not yet initialized.
     */
    constructor(allowed_data_viewer_dir: string = '') {
        this.allowed_data_viewer_dir = allowed_data_viewer_dir
            ? path.resolve(allowed_data_viewer_dir)
            : '';
    }

    get port(): number { return this._port; }
    get token(): string { return this._token; }
    get activeSessionId(): string | null { return this.active_session_id; }
    getSession(id: string): SessionInfo | undefined { return this.sessions.get(id); }

    async start(): Promise<void> {
        if (this.server) return;
        this._token = crypto.randomBytes(32).toString('hex');
        const s = http.createServer((req, res) => this.handle(req, res));
        this.server = s;
        try {
            await new Promise<void>((resolve, reject) => {
                s.once('error', reject);
                s.listen({ host: '127.0.0.1', port: 0 }, () => {
                    const addr = s.address();
                    this._port = typeof addr === 'object' && addr ? addr.port : 0;
                    resolve();
                });
            });
        } catch (err) {
            this.server = null;
            this._token = '';
            throw err;
        }
    }

    async stop(): Promise<void> {
        const s = this.server;
        this.server = null;
        this._port = 0;
        this._token = '';
        this.sessions.clear();
        this.active_session_id = null;
        if (!s) return;
        await new Promise<void>(resolve => s.close(() => resolve()));
    }

    onEvent(listener: RSessionEventListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    markSessionEnded(sessionId: string): void {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        s.ended = true;
        this.emit({ type: 'session-ended', sessionId });
    }

    private emit(event: RSessionEvent): void {
        for (const l of this.listeners) {
            try { l(event); } catch { /* ignore listener errors */ }
        }
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        const auth = req.headers['x-raven-session-token'];
        if (typeof auth !== 'string' || auth !== this._token) {
            res.writeHead(401).end();
            return;
        }
        if (req.method !== 'POST') {
            res.writeHead(405).end();
            return;
        }
        const url = req.url ?? '';
        if (url === '/session-ready') {
            this.read_json_body(req, res, body => this.handle_session_ready(body, res));
            return;
        }
        if (url === '/plot-available') {
            this.read_json_body(req, res, body => this.handle_plot_available(body, res));
            return;
        }
        if (url === '/view-data') {
            this.read_json_body(req, res, body => this.handle_view_data(body, res));
            return;
        }
        res.writeHead(404).end();
    }

    private handle_view_data(body: unknown, res: http.ServerResponse): void {
        // /view-data is only enabled when the server was constructed with an
        // allowed data-viewer directory.
        if (!this.allowed_data_viewer_dir) {
            res.writeHead(404).end();
            return;
        }
        if (!body || typeof body !== 'object') {
            res.writeHead(400).end();
            return;
        }
        const b = body as Record<string, unknown>;
        const sessionId = typeof b.sessionId === 'string' ? b.sessionId : '';
        const panelName = typeof b.panelName === 'string' ? b.panelName : '';
        const filePath = typeof b.filePath === 'string' ? b.filePath : '';
        const nrow = typeof b.nrow === 'number' ? b.nrow : NaN;
        if (!sessionId || !panelName || !filePath
            || !Number.isInteger(nrow) || nrow < 0) {
            res.writeHead(400).end();
            return;
        }

        // Path-trust: canonicalize and require strict containment in the
        // allowed directory. realpathSync also rejects non-existent files.
        let canonical: string;
        try {
            canonical = fs.realpathSync(filePath);
        } catch {
            res.writeHead(400).end();
            return;
        }
        const allowed = this.allowed_data_viewer_dir;
        if (canonical !== allowed && !canonical.startsWith(allowed + path.sep)) {
            res.writeHead(400).end();
            return;
        }

        this.emit({
            type: 'view-data-requested',
            sessionId,
            panelName,
            filePath: canonical,
            nrow,
        });
        res.writeHead(200).end();
    }

    private read_json_body(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        cb: (body: unknown) => void,
    ): void {
        const chunks: Buffer[] = [];
        let total = 0;
        let aborted = false;
        req.on('data', c => {
            if (aborted) return;
            total += c.length;
            if (total > MAX_BODY_BYTES) {
                aborted = true;
                if (!res.headersSent) res.writeHead(413).end();
                req.destroy();
                return;
            }
            chunks.push(Buffer.from(c));
        });
        req.on('end', () => {
            if (aborted) return;
            try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                cb(parsed);
            } catch {
                if (!res.headersSent) res.writeHead(400).end();
            }
        });
        req.on('error', () => {
            if (!res.headersSent) res.writeHead(400).end();
        });
    }

    private handle_plot_available(body: unknown, res: http.ServerResponse): void {
        if (!body || typeof body !== 'object') {
            res.writeHead(400).end();
            return;
        }
        const b = body as Record<string, unknown>;
        const sessionId = typeof b.sessionId === 'string' ? b.sessionId : '';
        const hsize = typeof b.hsize === 'number' ? b.hsize : NaN;
        const upid = typeof b.upid === 'number' ? b.upid : NaN;
        if (!sessionId || !this.sessions.has(sessionId) || Number.isNaN(hsize) || Number.isNaN(upid)) {
            res.writeHead(400).end();
            return;
        }
        this.active_session_id = sessionId;
        const session = this.sessions.get(sessionId);
        if (session) session.lastUpid = upid;
        this.emit({ type: 'plot-available', sessionId, hsize, upid });
        res.writeHead(200).end();
    }

    private handle_session_ready(body: unknown, res: http.ServerResponse): void {
        if (!body || typeof body !== 'object') {
            res.writeHead(400).end();
            return;
        }
        const b = body as Record<string, unknown>;
        const sessionId = typeof b.sessionId === 'string' ? b.sessionId : '';
        const httpgdHost = typeof b.httpgdHost === 'string' ? b.httpgdHost : '';
        const httpgdPort = typeof b.httpgdPort === 'number' ? b.httpgdPort : -1;
        const httpgdToken = typeof b.httpgdToken === 'string' ? b.httpgdToken : '';

        // Validate sessionId and httpgdToken are non-empty
        if (!sessionId || !httpgdToken) {
            res.writeHead(400).end();
            return;
        }

        // Validate httpgdHost is a loopback address
        const allowedHosts = ['127.0.0.1', 'localhost', '::1'];
        if (!allowedHosts.includes(httpgdHost)) {
            res.writeHead(400).end();
            return;
        }

        // Validate httpgdPort is in valid range
        if (!Number.isInteger(httpgdPort) || httpgdPort < 1 || httpgdPort > 65535) {
            res.writeHead(400).end();
            return;
        }

        // IPv6 literals must be wrapped in brackets to form a valid URL host.
        const hostForUrl = httpgdHost.includes(':') ? `[${httpgdHost}]` : httpgdHost;
        const session: SessionInfo = {
            sessionId,
            httpgdBaseUrl: `http://${hostForUrl}:${httpgdPort}`,
            httpgdToken,
            ended: false,
            lastUpid: 0,
        };
        this.sessions.set(sessionId, session);
        this.emit({ type: 'session-ready', session });
        res.writeHead(200).end();
    }
}

/** @deprecated Use {@link RSessionServer}. Retained for one release while
 *  callers migrate. */
export const PlotSessionServer = RSessionServer;
/** @deprecated Use {@link RSessionServer}. */
export type PlotSessionServer = RSessionServer;
