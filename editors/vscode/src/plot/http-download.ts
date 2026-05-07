import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

/**
 * Download a URL to a Buffer using Node's built-in http/https modules.
 *
 * Used instead of the global `fetch` because the extension declares
 * `engines.vscode = ^1.75.0` and that VS Code release line ships a
 * Node 16 runtime where global `fetch` is not available. Node 18+
 * ships fetch but we cannot rely on the runtime being 18+.
 *
 * Follows up to `max_redirects` 3xx responses (default 3). Rejects on
 * non-2xx (after redirect resolution) and on bodies larger than
 * `max_bytes` (default 64 MiB).
 */
export interface DownloadOptions {
    headers?: Record<string, string>;
    max_redirects?: number;
    max_bytes?: number;
    timeout_ms?: number;
}

export async function download_to_buffer(
    url_string: string,
    options: DownloadOptions = {},
): Promise<Buffer> {
    const max_redirects = options.max_redirects ?? 3;
    const max_bytes = options.max_bytes ?? 64 * 1024 * 1024;
    const timeout_ms = options.timeout_ms ?? 30_000;

    let current = url_string;
    for (let i = 0; i <= max_redirects; i++) {
        const result = await request_once(current, options.headers ?? {}, max_bytes, timeout_ms);
        if (result.kind === 'body') return result.body;
        if (i === max_redirects) {
            throw new Error(`Too many redirects fetching ${url_string}`);
        }
        // Resolve redirect target relative to the current URL so relative
        // Location headers work.
        current = new URL(result.location, current).toString();
    }
    // unreachable, the loop either returns or throws.
    throw new Error('download_to_buffer: redirect loop exited unexpectedly');
}

type RequestResult =
    | { kind: 'body'; body: Buffer }
    | { kind: 'redirect'; location: string };

function request_once(
    url_string: string,
    headers: Record<string, string>,
    max_bytes: number,
    timeout_ms: number,
): Promise<RequestResult> {
    return new Promise<RequestResult>((resolve, reject) => {
        let parsed: URL;
        try {
            parsed = new URL(url_string);
        } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
        }
        const lib = parsed.protocol === 'https:' ? https : http;
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            reject(new Error(`Unsupported protocol: ${parsed.protocol}`));
            return;
        }
        const req = lib.request(
            parsed,
            { method: 'GET', headers },
            res => {
                const status = res.statusCode ?? 0;
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    resolve({ kind: 'redirect', location: res.headers.location });
                    return;
                }
                if (status < 200 || status >= 300) {
                    res.resume();
                    reject(new Error(`HTTP ${status} fetching ${url_string}`));
                    return;
                }
                const chunks: Buffer[] = [];
                let total = 0;
                res.on('data', (chunk: Buffer) => {
                    total += chunk.length;
                    if (total > max_bytes) {
                        res.destroy();
                        reject(new Error(`Response exceeded max_bytes=${max_bytes}`));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => resolve({ kind: 'body', body: Buffer.concat(chunks) }));
                res.on('error', err => reject(err));
            },
        );
        req.setTimeout(timeout_ms, () => {
            req.destroy(new Error(`Request timed out after ${timeout_ms}ms`));
        });
        req.on('error', err => reject(err));
        req.end();
    });
}
