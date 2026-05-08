import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    RSessionServer,
    RSessionEvent,
} from '../../editors/vscode/src/r-session-server';

describe('POST /view-data', () => {
    let server: RSessionServer;
    let dvDir: string;
    let root: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'raven-dv-'));
        dvDir = join(root, 'data-viewer');
        await mkdir(dvDir, { recursive: true });
        server = new RSessionServer(await realpath(dvDir));
        await server.start();
    });
    afterEach(async () => {
        await server.stop();
        await rm(root, { recursive: true, force: true });
    });

    const post = (body: unknown, token = server.token) =>
        fetch(`http://127.0.0.1:${server.port}/view-data`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-raven-session-token': token,
            },
            body: JSON.stringify(body),
        });

    test('valid POST emits view-data-requested', async () => {
        const fp = join(dvDir, 'sess-abc.arrow');
        await writeFile(fp, 'pretend-arrow-bytes');
        const events: RSessionEvent[] = [];
        server.onEvent(e => events.push(e));
        const r = await post({
            sessionId: 'sess', panelName: 'mtcars', filePath: fp, nrow: 32,
        });
        expect(r.status).toBe(200);
        const realFp = await realpath(fp);
        expect(events).toContainEqual({
            type: 'view-data-requested',
            sessionId: 'sess', panelName: 'mtcars', filePath: realFp, nrow: 32,
        });
    });

    test('invalid token returns 401', async () => {
        const fp = join(dvDir, 'x.arrow');
        await writeFile(fp, '');
        const r = await post({
            sessionId: 's', panelName: 'p', filePath: fp, nrow: 1,
        }, 'wrong');
        expect(r.status).toBe(401);
    });

    test('missing required field returns 400', async () => {
        const r = await post({ sessionId: 's', panelName: 'p', nrow: 1 });
        expect(r.status).toBe(400);
    });

    test('non-numeric nrow returns 400', async () => {
        const fp = join(dvDir, 'x.arrow');
        await writeFile(fp, '');
        const r = await post({
            sessionId: 's', panelName: 'p', filePath: fp, nrow: 'lots' as any,
        });
        expect(r.status).toBe(400);
    });

    test('filePath outside allowed dir returns 400', async () => {
        const r = await post({
            sessionId: 's', panelName: 'p', filePath: '/etc/passwd', nrow: 1,
        });
        expect(r.status).toBe(400);
    });

    test('filePath using .. traversal returns 400', async () => {
        const traversed = join(dvDir, '..', '..', 'tmp', 'evil.arrow');
        await writeFile(join(root, 'evil.arrow'), '');
        const r = await post({
            sessionId: 's', panelName: 'p', filePath: traversed, nrow: 1,
        });
        expect(r.status).toBe(400);
    });

    test('symlink redirecting outside allowed dir returns 400', async () => {
        const link = join(dvDir, 'evil.arrow');
        await symlink('/etc/hosts', link); // safer than passwd; just any file outside dvDir
        const r = await post({
            sessionId: 's', panelName: 'p', filePath: link, nrow: 1,
        });
        expect(r.status).toBe(400);
    });

    test('non-existent filePath returns 400', async () => {
        const r = await post({
            sessionId: 's', panelName: 'p',
            filePath: join(dvDir, 'does-not-exist.arrow'), nrow: 1,
        });
        expect(r.status).toBe(400);
    });

    test('plot-only server (constructed with empty allowed dir) returns 404', async () => {
        const plotOnly = new RSessionServer();
        await plotOnly.start();
        try {
            const fp = join(dvDir, 'x.arrow');
            await writeFile(fp, '');
            const r = await fetch(`http://127.0.0.1:${plotOnly.port}/view-data`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-raven-session-token': plotOnly.token,
                },
                body: JSON.stringify({
                    sessionId: 's', panelName: 'p', filePath: fp, nrow: 1,
                }),
            });
            expect(r.status).toBe(404);
        } finally {
            await plotOnly.stop();
        }
    });
});
