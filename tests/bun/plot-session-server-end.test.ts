import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PlotSessionServer } from '../../editors/vscode/src/plot/session-server';

describe('markSessionEnded', () => {
    let server: PlotSessionServer;

    beforeEach(async () => {
        server = new PlotSessionServer();
        await server.start();
        await fetch(`http://127.0.0.1:${server.port}/session-ready`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-raven-session-token': server.token,
            },
            body: JSON.stringify({
                sessionId: 's',
                httpgdHost: '127.0.0.1',
                httpgdPort: 1,
                httpgdToken: 't',
            }),
        });
    });
    afterEach(async () => { await server.stop(); });

    test('flips ended=true and emits session-ended', () => {
        const events: any[] = [];
        server.onEvent(e => events.push(e));
        server.markSessionEnded('s');
        expect(server.getSession('s')?.ended).toBe(true);
        expect(events).toContainEqual({ type: 'session-ended', sessionId: 's' });
    });

    test('is a no-op for unknown session', () => {
        const events: any[] = [];
        server.onEvent(e => events.push(e));
        server.markSessionEnded('unknown');
        expect(events).toEqual([]);
    });
});
