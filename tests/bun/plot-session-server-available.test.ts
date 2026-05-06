import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PlotSessionServer } from '../../editors/vscode/src/plot/session-server';

describe('POST /plot-available', () => {
    let server: PlotSessionServer;

    async function register(sid: string) {
        await fetch(`http://127.0.0.1:${server.port}/session-ready`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-raven-session-token': server.token,
            },
            body: JSON.stringify({
                sessionId: sid,
                httpgdHost: '127.0.0.1',
                httpgdPort: 1234,
                httpgdToken: 'pt',
            }),
        });
    }

    async function plotAvailable(sid: string, hsize = 1, upid = 1) {
        return fetch(`http://127.0.0.1:${server.port}/plot-available`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-raven-session-token': server.token,
            },
            body: JSON.stringify({ sessionId: sid, hsize, upid }),
        });
    }

    beforeEach(async () => {
        server = new PlotSessionServer();
        await server.start();
    });
    afterEach(async () => { await server.stop(); });

    test('marks session as active and emits plot-available', async () => {
        const events: any[] = [];
        server.onEvent(e => events.push(e));
        await register('s1');
        const r = await plotAvailable('s1', 2, 5);
        expect(r.status).toBe(200);
        expect(server.activeSessionId).toBe('s1');
        expect(events).toContainEqual(
            expect.objectContaining({ type: 'plot-available', sessionId: 's1', hsize: 2, upid: 5 })
        );
    });

    test('switches active session to the most recent caller', async () => {
        await register('s1');
        await register('s2');
        await plotAvailable('s1');
        await plotAvailable('s2');
        expect(server.activeSessionId).toBe('s2');
    });

    test('rejects unknown session with 400', async () => {
        const r = await plotAvailable('does-not-exist');
        expect(r.status).toBe(400);
    });
});
