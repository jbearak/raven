import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PlotSessionServer } from '../../editors/vscode/src/plot/session-server';

describe('POST /session-ready', () => {
    let server: PlotSessionServer;

    beforeEach(async () => {
        server = new PlotSessionServer();
        await server.start();
    });
    afterEach(async () => { await server.stop(); });

    test('registers a session and emits session-ready event', async () => {
        const events: any[] = [];
        server.onEvent(e => events.push(e));
        const r = await fetch(`http://127.0.0.1:${server.port}/session-ready`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-raven-session-token': server.token,
            },
            body: JSON.stringify({
                sessionId: 'sid-1',
                httpgdHost: '127.0.0.1',
                httpgdPort: 7777,
                httpgdToken: 'plot-tok',
            }),
        });
        expect(r.status).toBe(200);
        expect(server.getSession('sid-1')).toEqual({
            sessionId: 'sid-1',
            httpgdBaseUrl: 'http://127.0.0.1:7777',
            httpgdToken: 'plot-tok',
            ended: false,
        });
        expect(events).toContainEqual(
            expect.objectContaining({ type: 'session-ready' })
        );
    });

    test('rejects malformed body with 400', async () => {
        const r = await fetch(`http://127.0.0.1:${server.port}/session-ready`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-raven-session-token': server.token,
            },
            body: '{not-json',
        });
        expect(r.status).toBe(400);
    });

    test('rejects body missing sessionId with 400', async () => {
        const r = await fetch(`http://127.0.0.1:${server.port}/session-ready`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-raven-session-token': server.token,
            },
            body: JSON.stringify({ httpgdHost: '127.0.0.1', httpgdPort: 1, httpgdToken: 't' }),
        });
        expect(r.status).toBe(400);
    });
});
