import { describe, test, expect } from 'bun:test';
import {
    RSessionServer,
    RSessionEvent,
} from '../../editors/vscode/src/r-session-server';

async function withServer<T>(fn: (server: RSessionServer) => Promise<T>): Promise<T> {
    const server = new RSessionServer();
    await server.start();
    try {
        return await fn(server);
    } finally {
        await server.stop();
    }
}

const postWarning = (server: RSessionServer, body: unknown, token = server.token) =>
    fetch(`http://127.0.0.1:${server.port}/data-viewer-warning`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-raven-session-token': token,
        },
        body: JSON.stringify(body),
    });

describe('POST /data-viewer-warning', () => {
    test('valid missing-arrow POST emits data-viewer-warning', async () => {
        await withServer(async server => {
            const events: RSessionEvent[] = [];
            server.onEvent(e => events.push(e));
            const r = await postWarning(server, {
                sessionId: 'sess',
                reason: 'missing-arrow',
                message: 'Raven data viewer requires arrow',
            });
            expect(r.status).toBe(200);
            expect(events).toContainEqual({
                type: 'data-viewer-warning',
                sessionId: 'sess',
                reason: 'missing-arrow',
                message: 'Raven data viewer requires arrow',
            });
        });
    });

    test('invalid token returns 401', async () => {
        await withServer(async server => {
            const r = await postWarning(server, {
                sessionId: 'sess',
                reason: 'missing-arrow',
                message: 'Raven data viewer requires arrow',
            }, 'wrong');
            expect(r.status).toBe(401);
        });
    });

    test('unknown reason returns 400', async () => {
        await withServer(async server => {
            const r = await postWarning(server, {
                sessionId: 'sess',
                reason: 'other',
                message: 'Raven data viewer requires arrow',
            });
            expect(r.status).toBe(400);
        });
    });
});
