import * as crypto from 'crypto';
import * as http from 'http';

export type SessionInfo = {
    sessionId: string;
    httpgdBaseUrl: string;
    httpgdToken: string;
    ended: boolean;
};

export type PlotEvent =
    | { type: 'session-ready'; session: SessionInfo }
    | { type: 'plot-available'; sessionId: string; hsize: number; upid: number }
    | { type: 'session-ended'; sessionId: string };

export type PlotEventListener = (event: PlotEvent) => void;

export class PlotSessionServer {
    private server: http.Server | null = null;
    private _port = 0;
    private _token = '';
    private sessions = new Map<string, SessionInfo>();
    private listeners = new Set<PlotEventListener>();
    private active_session_id: string | null = null;

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

    onEvent(listener: PlotEventListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    markSessionEnded(sessionId: string): void {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        s.ended = true;
        this.emit({ type: 'session-ended', sessionId });
    }

    private emit(event: PlotEvent): void {
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
        res.writeHead(404).end();
    }

    private read_json_body(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        cb: (body: unknown) => void,
    ): void {
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(Buffer.from(c)));
        req.on('end', () => {
            try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                cb(parsed);
            } catch {
                res.writeHead(400).end();
            }
        });
        req.on('error', () => res.writeHead(400).end());
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
        if (!sessionId || !httpgdHost || httpgdPort <= 0 || !httpgdToken) {
            res.writeHead(400).end();
            return;
        }
        const session: SessionInfo = {
            sessionId,
            httpgdBaseUrl: `http://${httpgdHost}:${httpgdPort}`,
            httpgdToken,
            ended: false,
        };
        this.sessions.set(sessionId, session);
        this.emit({ type: 'session-ready', session });
        res.writeHead(200).end();
    }
}
