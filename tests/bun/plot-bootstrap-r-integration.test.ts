import { describe, expect, test } from 'bun:test';
import { spawn } from 'bun';
import { mkdtempSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    generate_profile_source,
    write_profile_file,
} from '../../editors/vscode/src/plot/r-bootstrap-profile';

const R_BIN = process.env.RAVEN_TEST_R_BIN ?? 'R';

async function r_with_httpgd_available(): Promise<boolean> {
    try {
        const proc = spawn({
            cmd: [
                R_BIN,
                '--vanilla',
                '--quiet',
                '-e',
                'cat(requireNamespace("httpgd", quietly = TRUE) && utils::packageVersion("httpgd") >= "2.0.2")',
            ],
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        return out.trim().includes('TRUE');
    } catch {
        return false;
    }
}

const HAS_R_HTTPGD = await r_with_httpgd_available();

type CapturedRequest = { headers: string; body: string };

async function start_capture_server(): Promise<{
    port: number;
    requests: CapturedRequest[];
    close: () => Promise<void>;
}> {
    const requests: CapturedRequest[] = [];
    const sockets = new Set<net.Socket>();
    const server = net.createServer(socket => {
        sockets.add(socket);
        let buf = Buffer.alloc(0);
        socket.on('data', chunk => {
            buf = Buffer.concat([buf, chunk]);
        });
        socket.on('end', () => {
            const text = buf.toString('utf8');
            const sep = text.indexOf('\r\n\r\n');
            requests.push({
                headers: sep >= 0 ? text.slice(0, sep) : text,
                body: sep >= 0 ? text.slice(sep + 4) : '',
            });
        });
        socket.on('close', () => sockets.delete(socket));
        socket.write('HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n');
    });
    const port = await new Promise<number>(resolve => {
        server.listen(0, '127.0.0.1', () => {
            resolve((server.address() as net.AddressInfo).port);
        });
    });
    return {
        port,
        requests,
        close: () =>
            new Promise<void>(resolve => {
                for (const s of sockets) s.destroy();
                server.close(() => resolve());
            }),
    };
}

describe('R bootstrap end-to-end (real R subprocess)', () => {
    test.skipIf(!HAS_R_HTTPGD)(
        'sources profile cleanly and POSTs /session-ready without binary-connection error',
        async () => {
            const cap = await start_capture_server();
            const tmp = mkdtempSync(join(tmpdir(), 'raven-bootstrap-int-'));
            const profile_path = await write_profile_file(tmp, generate_profile_source());

            const proc = spawn({
                cmd: [
                    R_BIN,
                    '--quiet',
                    '--no-save',
                    '--no-restore',
                    '-e',
                    'invisible(NULL)',
                ],
                cwd: tmp,
                env: {
                    ...process.env,
                    R_PROFILE_USER: profile_path,
                    RAVEN_ORIGINAL_R_PROFILE_USER: '',
                    RAVEN_SESSION_PORT: String(cap.port),
                    RAVEN_SESSION_TOKEN: 'test-token-deadbeef',
                    RAVEN_R_SESSION_ID: 'test-session-id-1',
                },
                stdout: 'pipe',
                stderr: 'pipe',
            });
            const stderr = await new Response(proc.stderr).text();
            await new Response(proc.stdout).text();
            await proc.exited;

            // Allow capture sockets to flush after R closes them.
            await new Promise(r => setTimeout(r, 250));
            await cap.close();

            // Bug guards: the previous text-mode socketConnection produced
            // these messages on every R startup and every plot.
            expect(stderr).not.toContain('session POST failed');
            expect(stderr).not.toContain('can only write to a binary connection');

            // Functional guard: the POST actually arrived with the right
            // token, session id, and httpgd endpoint fields.
            const ready = cap.requests.find(r =>
                r.headers.includes('POST /session-ready'),
            );
            expect(ready).toBeDefined();
            expect(ready!.headers).toContain(
                'X-Raven-Session-Token: test-token-deadbeef',
            );
            expect(ready!.body).toContain('test-session-id-1');
            expect(ready!.body).toContain('"httpgdHost"');
            expect(ready!.body).toContain('"httpgdPort"');
            expect(ready!.body).toContain('"httpgdToken"');
        },
        20_000,
    );
});
