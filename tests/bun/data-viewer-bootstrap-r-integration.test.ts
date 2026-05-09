import { describe, expect, test } from 'bun:test';
import { spawn } from 'bun';
import { mkdtempSync, mkdirSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    generate_profile_source,
    write_profile_file,
} from '../../editors/vscode/src/plot/r-bootstrap-profile';

const R_BIN = process.env.RAVEN_TEST_R_BIN ?? 'R';

async function r_with(pkg: string): Promise<boolean> {
    try {
        const proc = spawn({
            cmd: [
                R_BIN,
                '--vanilla',
                '--quiet',
                '--no-echo',
                '-e',
                `cat(if (requireNamespace("${pkg}", quietly = TRUE)) "RAVEN_PKG_OK" else "RAVEN_PKG_MISSING")`,
            ],
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        return out.includes('RAVEN_PKG_OK');
    } catch {
        return false;
    }
}

async function has_R(): Promise<boolean> {
    try {
        const proc = spawn({
            cmd: [R_BIN, '--version'], stdout: 'pipe', stderr: 'pipe',
        });
        await proc.exited;
        return proc.exitCode === 0;
    } catch { return false; }
}

const HAS_R = await has_R();
const HAS_ARROW = HAS_R && (await r_with('arrow'));

type CapturedRequest = { headers: string; body: string };

async function start_capture_server(): Promise<{
    port: number;
    requests: CapturedRequest[];
    waitForRequest: (
        predicate: (r: CapturedRequest) => boolean,
        timeoutMs: number,
    ) => Promise<CapturedRequest>;
    close: () => Promise<void>;
}> {
    const requests: CapturedRequest[] = [];
    const sockets = new Set<net.Socket>();
    const waiters: {
        predicate: (r: CapturedRequest) => boolean;
        resolve: (r: CapturedRequest) => void;
    }[] = [];
    const server = net.createServer(socket => {
        sockets.add(socket);
        let buf = Buffer.alloc(0);
        socket.on('data', chunk => { buf = Buffer.concat([buf, chunk]); });
        socket.on('end', () => {
            const text = buf.toString('utf8');
            const sep = text.indexOf('\r\n\r\n');
            const req: CapturedRequest = {
                headers: sep >= 0 ? text.slice(0, sep) : text,
                body: sep >= 0 ? text.slice(sep + 4) : '',
            };
            requests.push(req);
            for (let i = waiters.length - 1; i >= 0; i--) {
                if (waiters[i].predicate(req)) {
                    waiters[i].resolve(req);
                    waiters.splice(i, 1);
                }
            }
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
        port, requests,
        waitForRequest(predicate, timeoutMs) {
            const existing = requests.find(predicate);
            if (existing) return Promise.resolve(existing);
            return new Promise<CapturedRequest>((resolve, reject) => {
                const entry = { predicate, resolve };
                waiters.push(entry);
                const timer = setTimeout(() => {
                    const idx = waiters.indexOf(entry);
                    if (idx >= 0) waiters.splice(idx, 1);
                    reject(new Error(`waitForRequest timed out after ${timeoutMs}ms`));
                }, timeoutMs);
                const wrapped = entry.resolve;
                entry.resolve = req => { clearTimeout(timer); wrapped(req); };
            });
        },
        close: () => new Promise<void>(resolve => {
            for (const s of sockets) s.destroy();
            server.close(() => resolve());
        }),
    };
}

async function spawnR(
    cap: { port: number },
    rCode: string,
    extraEnv: Record<string, string> = {},
): Promise<{ stderr: string; stdout: string; exitCode: number; tmp: string; dvDir: string }> {
    const tmp = mkdtempSync(join(tmpdir(), 'raven-dv-int-'));
    const dvDir = join(tmp, 'data-viewer');
    mkdirSync(dvDir, { recursive: true });
    const profile_path = await write_profile_file(tmp, generate_profile_source());
    const proc = spawn({
        cmd: [R_BIN, '--quiet', '--no-save', '--no-restore', '-e', rCode],
        cwd: tmp,
        env: {
            ...process.env,
            R_PROFILE_USER: profile_path,
            RAVEN_ORIGINAL_R_PROFILE_USER: '',
            RAVEN_SESSION_PORT: String(cap.port),
            RAVEN_SESSION_TOKEN: 'test-token-dv',
            RAVEN_R_SESSION_ID: 'test-rsid',
            RAVEN_DATA_VIEWER_DIR: dvDir,
            ...extraEnv,
        },
        stdout: 'pipe', stderr: 'pipe',
    });
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return { stderr, stdout, exitCode, tmp, dvDir };
}

describe('Data viewer bootstrap (real R subprocess)', () => {
    test.skipIf(!HAS_R || !HAS_ARROW)(
        'View(mtcars) POSTs /view-data with the expected body shape',
        async () => {
            const cap = await start_capture_server();
            try {
                const r = spawnR(cap, 'View(mtcars); Sys.sleep(0.2)');
                const got = await cap.waitForRequest(
                    req => req.headers.includes('POST /view-data'),
                    20_000,
                );
                await r;
                expect(got.headers).toContain('X-Raven-Session-Token: test-token-dv');
                expect(got.body).toContain('"sessionId":"test-rsid"');
                expect(got.body).toContain('"panelName":"mtcars"');
                expect(got.body).toContain('"nrow":32');
                expect(got.body).toContain('"filePath":"');
                expect(got.body).not.toContain('schemaJson');
            } finally {
                await cap.close();
            }
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'View(1) errors with the Positron-style message and posts nothing',
        async () => {
            const cap = await start_capture_server();
            try {
                const r = await spawnR(cap, 'tryCatch(View(1), error = function(e) cat(conditionMessage(e), file = stderr())); Sys.sleep(0.2)');
                expect(r.stderr).toContain("Can't `View()` an object of class");
                // No /view-data POST should have arrived.
                const dataPosts = cap.requests.filter(req => req.headers.includes('POST /view-data'));
                expect(dataPosts.length).toBe(0);
            } finally {
                await cap.close();
            }
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'View() works even when httpgd is missing (data viewer ordering regression)',
        async () => {
            const cap = await start_capture_server();
            try {
                // R_LIBS_USER pointing at an empty dir hides any installed httpgd.
                const fakeLib = mkdtempSync(join(tmpdir(), 'raven-empty-libs-'));
                const r = spawnR(cap, 'View(mtcars); Sys.sleep(0.2)', {
                    R_LIBS_USER: fakeLib,
                });
                const got = await cap.waitForRequest(
                    req => req.headers.includes('POST /view-data'),
                    20_000,
                );
                await r;
                expect(got.body).toContain('"panelName":"mtcars"');
            } finally {
                await cap.close();
            }
        },
        30_000,
    );
});
