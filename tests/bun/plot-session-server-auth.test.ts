import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { RSessionServer } from '../../editors/vscode/src/r-session-server';

describe('RSessionServer auth + lifecycle', () => {
    let server: RSessionServer;

    beforeEach(async () => {
        server = new RSessionServer();
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    test('exposes a port and token after start()', () => {
        expect(server.port).toBeGreaterThan(0);
        expect(server.token).toMatch(/^[0-9a-f]{64}$/);
    });

    test('rejects request without token', async () => {
        const r = await fetch(`http://127.0.0.1:${server.port}/session-ready`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(r.status).toBe(401);
    });

    test('rejects request with wrong token', async () => {
        const r = await fetch(`http://127.0.0.1:${server.port}/session-ready`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-raven-session-token': 'nope',
            },
            body: JSON.stringify({}),
        });
        expect(r.status).toBe(401);
    });

    test('rejects unknown path', async () => {
        const r = await fetch(`http://127.0.0.1:${server.port}/whatever`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-raven-session-token': server.token,
            },
            body: JSON.stringify({}),
        });
        expect(r.status).toBe(404);
    });

    test('stop() closes the port', async () => {
        const port = server.port;
        await server.stop();
        await expect(
            fetch(`http://127.0.0.1:${port}/session-ready`, { method: 'POST' })
        ).rejects.toThrow();
        // Restart for the afterEach
        await server.start();
    });

    test('stop() resets state so a retry can succeed', async () => {
        // Test the recovery path by stopping and restarting.
        // After stop(), the server should reset to initial state,
        // then start() should succeed with fresh credentials.
        const token = server.token;
        await server.stop();
        expect(server.port).toBe(0);
        expect(server.token).toBe('');
        await server.start();
        expect(server.port).toBeGreaterThan(0);
        expect(server.token).not.toBe(token); // fresh token
    });
});
