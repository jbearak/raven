import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { download_to_buffer } from '../../editors/vscode/src/plot/http-download';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let server: http.Server | null = null;
let port = 0;

function start(handler: Handler): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const s = http.createServer(handler);
        s.once('error', reject);
        s.listen({ host: '127.0.0.1', port: 0 }, () => {
            const addr = s.address() as AddressInfo;
            port = addr.port;
            server = s;
            resolve();
        });
    });
}

beforeEach(() => {
    server = null;
    port = 0;
});

afterEach(async () => {
    if (server) {
        await new Promise<void>(resolve => server!.close(() => resolve()));
        server = null;
    }
});

describe('download_to_buffer', () => {
    test('returns body bytes on 200', async () => {
        await start((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            res.end(Buffer.from([1, 2, 3, 4, 5]));
        });
        const buf = await download_to_buffer(`http://127.0.0.1:${port}/x`);
        expect(buf.equals(Buffer.from([1, 2, 3, 4, 5]))).toBe(true);
    });

    test('rejects on non-2xx status', async () => {
        await start((_req, res) => {
            res.writeHead(404).end();
        });
        await expect(download_to_buffer(`http://127.0.0.1:${port}/missing`)).rejects.toThrow(
            /HTTP 404/,
        );
    });

    test('follows redirects within max_redirects', async () => {
        await start((req, res) => {
            if (req.url === '/start') {
                res.writeHead(302, { location: '/end' }).end();
                return;
            }
            if (req.url === '/end') {
                res.writeHead(200).end(Buffer.from('ok'));
                return;
            }
            res.writeHead(404).end();
        });
        const buf = await download_to_buffer(`http://127.0.0.1:${port}/start`);
        expect(buf.toString()).toBe('ok');
    });

    test('rejects when redirect chain exceeds max_redirects', async () => {
        await start((req, res) => {
            // Always redirect to itself; chain grows without bound.
            res.writeHead(302, { location: req.url ?? '/loop' }).end();
        });
        await expect(
            download_to_buffer(`http://127.0.0.1:${port}/loop`, { max_redirects: 2 }),
        ).rejects.toThrow(/Too many redirects/);
    });

    test('rejects when body exceeds max_bytes', async () => {
        await start((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            res.end(Buffer.alloc(2048));
        });
        await expect(
            download_to_buffer(`http://127.0.0.1:${port}/big`, { max_bytes: 1024 }),
        ).rejects.toThrow(/exceeded max_bytes/);
    });

    test('forwards custom headers', async () => {
        let seen_token = '';
        await start((req, res) => {
            seen_token = String(req.headers['x-raven-test-token'] ?? '');
            res.writeHead(200).end(Buffer.from('ok'));
        });
        await download_to_buffer(`http://127.0.0.1:${port}/h`, {
            headers: { 'X-Raven-Test-Token': 'abc123' },
        });
        expect(seen_token).toBe('abc123');
    });

    test('rejects unsupported protocols', async () => {
        await expect(download_to_buffer('ftp://example.invalid/x')).rejects.toThrow(
            /Unsupported protocol/,
        );
    });
});
