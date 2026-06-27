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
const HAS_HAVEN = HAS_R && (await r_with('haven'));

/**
 * R code that runs `viewCall`, then reads back the single Arrow file the
 * View() override wrote into RAVEN_DATA_VIEWER_DIR and prints a structured
 * summary to stdout (RAVEN_COLS / RAVEN_TYPES / RAVEN_NROW / per-factor
 * RAVEN_LEVELS / RAVEN_FIELDS schema metadata), plus any `extra` asserts.
 * No file is written when View() errors, so the readback is skipped.
 */
function viewAndReadback(viewCall: string, extra = ''): string {
    return [
        viewCall,
        '.dir <- Sys.getenv("RAVEN_DATA_VIEWER_DIR")',
        '.f <- list.files(.dir, pattern = "[.]arrow$", full.names = TRUE)',
        'if (length(.f) >= 1L) {',
        '  .t <- arrow::read_feather(.f[[1L]], as_data_frame = FALSE)',
        '  .df <- as.data.frame(.t)',
        '  cat("RAVEN_COLS=", paste(names(.df), collapse = ","), "\\n", sep = "")',
        '  cat("RAVEN_TYPES=", paste(vapply(.df, function(c) class(c)[[1L]], character(1L)), collapse = ","), "\\n", sep = "")',
        '  cat("RAVEN_NROW=", nrow(.df), "\\n", sep = "")',
        '  for (.nm in names(.df)) if (is.factor(.df[[.nm]])) cat("RAVEN_LEVELS[", .nm, "]=", paste(levels(.df[[.nm]]), collapse = "|"), "\\n", sep = "")',
        '  .md <- .t$schema$metadata[["raven.fields"]]',
        '  if (!is.null(.md)) cat("RAVEN_FIELDS=", .md, "\\n", sep = "")',
        '}',
        extra,
        'Sys.sleep(0.2)',
    ].join('\n');
}

/** R code that swallows an expected View() error, printing it to stderr. */
function viewExpectError(viewCall: string): string {
    return `tryCatch(${viewCall}, error = function(e) cat(conditionMessage(e), file = stderr())); Sys.sleep(0.2)`;
}

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
        'View(environment) errors with the Positron-style message and posts nothing',
        async () => {
            const cap = await start_capture_server();
            try {
                const r = await spawnR(cap, viewExpectError('View(new.env())'));
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
        'View(named vector) → name + values columns',
        async () => {
            const cap = await start_capture_server();
            try {
                const r = await spawnR(cap, viewAndReadback(
                    'x <- c(a = 1, b = 2, c = 3); View(x)',
                ));
                expect(r.stdout).toContain('RAVEN_COLS=name,values');
                expect(r.stdout).toContain('RAVEN_NROW=3');
                const got = cap.requests.find(req => req.headers.includes('POST /view-data'));
                expect(got?.body).toContain('"nrow":3');
                expect(got?.body).toContain('"panelName":"x"');
            } finally {
                await cap.close();
            }
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'View(unnamed vector) → single values column',
        async () => {
            const cap = await start_capture_server();
            try {
                const r = await spawnR(cap, viewAndReadback('View(c(10, 20, 30))'));
                expect(r.stdout).toContain('RAVEN_COLS=values');
                expect(r.stdout).toContain('RAVEN_NROW=3');
            } finally {
                await cap.close();
            }
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'View(scalar) → single value column, one row',
        async () => {
            const cap = await start_capture_server();
            try {
                const r = await spawnR(cap, viewAndReadback('View(42L)'));
                expect(r.stdout).toContain('RAVEN_COLS=value');
                expect(r.stdout).toContain('RAVEN_NROW=1');
            } finally {
                await cap.close();
            }
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'View(factor) → single value column, factor round-trips with levels',
        async () => {
            const cap = await start_capture_server();
            try {
                const r = await spawnR(cap, viewAndReadback('View(factor(c("b", "a", "b")))'));
                expect(r.stdout).toContain('RAVEN_COLS=values');
                expect(r.stdout).toContain('RAVEN_TYPES=factor');
                expect(r.stdout).toContain('RAVEN_LEVELS[values]=a|b');
                expect(r.stdout).toContain('RAVEN_NROW=3');
            } finally {
                await cap.close();
            }
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'View(ragged flat list) → element-as-column, NA-padded, types preserved',
        async () => {
            const cap = await start_capture_server();
            try {
                const r = await spawnR(cap, viewAndReadback(
                    'View(list(a = 1:3, b = c("x", "y"), c = TRUE))',
                    'cat("RAVEN_B3_NA=", is.na(.df$b[[3L]]), "\\n", sep = "")',
                ));
                expect(r.stdout).toContain('RAVEN_COLS=a,b,c');
                expect(r.stdout).toContain('RAVEN_TYPES=integer,character,logical');
                expect(r.stdout).toContain('RAVEN_NROW=3');
                expect(r.stdout).toContain('RAVEN_B3_NA=TRUE');
            } finally {
                await cap.close();
            }
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'View(list with length-0 typed element) keeps the factor column (finding #2)',
        async () => {
            const cap = await start_capture_server();
            try {
                const r = await spawnR(cap, viewAndReadback(
                    'View(list(a = 1:3, f = factor(character(), levels = c("a", "b"))))',
                ));
                expect(r.stdout).toContain('RAVEN_COLS=a,f');
                // f must remain a factor with its levels, NOT degrade to logical.
                expect(r.stdout).toContain('RAVEN_TYPES=integer,factor');
                expect(r.stdout).toContain('RAVEN_LEVELS[f]=a|b');
                expect(r.stdout).toContain('RAVEN_NROW=3');
            } finally {
                await cap.close();
            }
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'View(unnamed list) → synthesized V1.. column names',
        async () => {
            const cap = await start_capture_server();
            try {
                const r = await spawnR(cap, viewAndReadback('View(list(1:2, 3:4))'));
                expect(r.stdout).toContain('RAVEN_COLS=V1,V2');
                expect(r.stdout).toContain('RAVEN_NROW=2');
            } finally {
                await cap.close();
            }
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'View(list) — a synthesized V<i> name never steals a real column name',
        async () => {
            const cap = await start_capture_server();
            try {
                // Element 1 is unnamed → would be filled "V1"; element 2 is
                // the user's explicit "V1". The user's V1 (value 20) must
                // survive; the placeholder yields.
                const r = await spawnR(cap, viewAndReadback(
                    'View(list(10, V1 = 20))',
                    'cat("RAVEN_V1=", .df[["V1"]][[1L]], "\\n", sep = "")',
                ));
                expect(r.stdout).toContain('RAVEN_V1=20');
            } finally {
                await cap.close();
            }
        },
        30_000,
    );

    test.skipIf(!HAS_HAVEN || !HAS_ARROW)(
        'View(haven_labelled) → single value column, labels in schema metadata',
        async () => {
            const cap = await start_capture_server();
            try {
                const r = await spawnR(cap, viewAndReadback(
                    'x <- haven::labelled(c(1, 2, 1), c(Male = 1, Female = 2)); View(x)',
                ));
                expect(r.stdout).toContain('RAVEN_COLS=values');
                expect(r.stdout).toContain('RAVEN_FIELDS=');
                expect(r.stdout).toMatch(/Male/);
                expect(r.stdout).toMatch(/Female/);
                expect(r.stdout).toContain('RAVEN_NROW=3');
            } finally {
                await cap.close();
            }
        },
        30_000,
    );

    test.skipIf(!HAS_HAVEN || !HAS_ARROW)(
        'View(ragged list with a short haven_labelled element) NA-pads without crashing',
        async () => {
            const cap = await start_capture_server();
            try {
                // vctrs [ rejects out-of-bounds indices, so over-indexing a
                // short labelled element to pad it would crash. The values
                // column must NA-pad to nrow = 4 and keep the labels.
                const r = await spawnR(cap, viewAndReadback(
                    'View(list(g = haven::labelled(c(1, 2), c(Male = 1, Female = 2)), n = 1:4))',
                    'cat("RAVEN_G3_NA=", is.na(.df$g[[3L]]), "\\n", sep = "")',
                ));
                expect(r.stdout).toContain('RAVEN_COLS=g,n');
                expect(r.stdout).toContain('RAVEN_NROW=4');
                expect(r.stdout).toContain('RAVEN_G3_NA=TRUE');
                expect(r.stdout).toMatch(/Male/);
                expect(r.stderr).not.toContain('past the end');
            } finally {
                await cap.close();
            }
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'View(df with a non-scalar "label" attr) does not crash on the && length check',
        async () => {
            const cap = await start_capture_server();
            try {
                // A malformed length-2 "label" attribute must not blow up the
                // `&&` in the metadata writer (length>1 → error on R >= 4.4).
                const r = spawnR(cap,
                    'df <- data.frame(a = 1:2); attr(df$a, "label") <- c("x", "y"); View(df); Sys.sleep(0.2)');
                const got = await cap.waitForRequest(
                    req => req.headers.includes('POST /view-data'), 20_000);
                const done = await r;
                expect(got.body).toContain('"nrow":2');
                expect(done.stderr).not.toContain('length = 2');
            } finally {
                await cap.close();
            }
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'View(nested list) errors and posts nothing',
        async () => {
            const cap = await start_capture_server();
            try {
                const r = await spawnR(cap, viewExpectError('View(list(a = 1, b = list(1, 2)))'));
                expect(r.stderr).toContain("Can't `View()` an object of class");
                expect(cap.requests.filter(req => req.headers.includes('POST /view-data')).length).toBe(0);
            } finally {
                await cap.close();
            }
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'View(raw vector) errors and posts nothing (raw excluded)',
        async () => {
            const cap = await start_capture_server();
            try {
                const r = await spawnR(cap, viewExpectError('View(as.raw(1:3))'));
                expect(r.stderr).toContain("Can't `View()` an object of class");
                expect(cap.requests.filter(req => req.headers.includes('POST /view-data')).length).toBe(0);
            } finally {
                await cap.close();
            }
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'View(NULL) errors and posts nothing (is.atomic(NULL) guard)',
        async () => {
            const cap = await start_capture_server();
            try {
                const r = await spawnR(cap, viewExpectError('View(NULL)'));
                expect(r.stderr).toContain("Can't `View()` an object of class");
                expect(cap.requests.filter(req => req.headers.includes('POST /view-data')).length).toBe(0);
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
