import { describe, expect, test } from 'bun:test';
import { spawn } from 'bun';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    generate_profile_source,
    write_profile_file,
} from '../../editors/vscode/src/plot/r-bootstrap-profile';
import { RSessionServer, type RSessionEvent } from '../../editors/vscode/src/r-session-server';
import { rString } from '../../editors/vscode/src/data-viewer/r-code';

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

async function start_capture_server(status = 200): Promise<{
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
        socket.write(`HTTP/1.0 ${status} X\r\nContent-Length: 0\r\n\r\n`);
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
        'View(nested list) errors naming the offending element and posts nothing',
        async () => {
            const cap = await start_capture_server();
            try {
                const r = await spawnR(cap, viewExpectError('View(list(a = 1, b = list(1, 2)))'));
                expect(r.stderr).toContain("Can't `View()` this list:");
                expect(r.stderr).toContain('element `b` has class `list`');
                expect(r.stderr).toContain('Only flat lists (every element a vector) are supported.');
                expect(cap.requests.filter(req => req.headers.includes('POST /view-data')).length).toBe(0);
            } finally {
                await cap.close();
            }
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'View(empty list) errors with an empty-list message and posts nothing',
        async () => {
            const cap = await start_capture_server();
            try {
                const r = await spawnR(cap, viewExpectError('View(list())'));
                expect(r.stderr).toContain("Can't `View()` an empty list.");
                expect(cap.requests.filter(req => req.headers.includes('POST /view-data')).length).toBe(0);
            } finally {
                await cap.close();
            }
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'View(list offender: unnamed / blank / NA) reports the positional element',
        async () => {
            const cap = await start_capture_server();
            try {
                // Fully-unnamed list: names(x) is NULL — exercises the
                // !is.null(nm) short-circuit (nm[[i]] would error otherwise).
                const unnamed = await spawnR(cap, viewExpectError('View(list(1, list(2)))'));
                expect(unnamed.stderr).toContain('element 2 has class `list`');
                // Blank name and NA name must both fall through to "element <i>"
                // rather than "element ``" / "element `NA`".
                const blank = await spawnR(cap, viewExpectError(
                    'View(setNames(list(1, list(2)), c("a", "")))',
                ));
                expect(blank.stderr).toContain('element 2 has class `list`');
                expect(blank.stderr).not.toContain('element ``');
                const na = await spawnR(cap, viewExpectError(
                    'View(setNames(list(1, list(2)), c("a", NA)))',
                ));
                expect(na.stderr).toContain('element 2 has class `list`');
                expect(na.stderr).not.toContain('element `NA`');
                // A backtick in the name would break the backtick quoting,
                // so it also falls through to the positional form.
                const tick = await spawnR(cap, viewExpectError(
                    'View(setNames(list(list(2)), "a`b"))',
                ));
                expect(tick.stderr).toContain('element 1 has class `list`');
                expect(cap.requests.filter(req => req.headers.includes('POST /view-data')).length).toBe(0);
            } finally {
                await cap.close();
            }
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'View(1-D array) renders as a vector (single values column)',
        async () => {
            const cap = await start_capture_server();
            try {
                const r = await spawnR(cap, viewAndReadback('View(array(1:3))'));
                expect(r.stdout).toContain('RAVEN_COLS=values');
                expect(r.stdout).toContain('RAVEN_NROW=3');
            } finally {
                await cap.close();
            }
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'View(named 1-D array) carries dimnames into a leading name column',
        async () => {
            const cap = await start_capture_server();
            try {
                const r = await spawnR(cap, viewAndReadback(
                    'View(array(1:2, dimnames = list(c("a", "b"))))',
                ));
                expect(r.stdout).toContain('RAVEN_COLS=name,values');
                expect(r.stdout).toContain('RAVEN_NROW=2');
            } finally {
                await cap.close();
            }
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'View(3-D array) errors with the dimensionality message and posts nothing',
        async () => {
            const cap = await start_capture_server();
            try {
                const r = await spawnR(cap, viewExpectError('View(array(1:8, c(2, 2, 2)))'));
                expect(r.stderr).toContain("Can't `View()` an array with 3 dimensions");
                expect(r.stderr).toContain('the data viewer shows 2-dimensional tables only.');
                expect(cap.requests.filter(req => req.headers.includes('POST /view-data')).length).toBe(0);
            } finally {
                await cap.close();
            }
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'View(3-way table) hits the dimensionality message (is.array admits tables)',
        async () => {
            const cap = await start_capture_server();
            try {
                // A deterministic 3-way table: dim c(2,2,2), class "table".
                const r = await spawnR(cap, viewExpectError(
                    'View(table(c(1,1,2,2), c(1,2,1,2), c(1,1,2,2)))',
                ));
                expect(r.stderr).toContain("Can't `View()` an array with 3 dimensions");
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

    /** The single /view-data body R sent, parsed (fails the test when the
     *  body is not valid JSON, as the session server would reject it). */
    async function viewDataBody(
        rCode: string,
        status = 200,
    ): Promise<{ body: Record<string, unknown>; bytes: number; r: Awaited<ReturnType<typeof spawnR>> }> {
        const cap = await start_capture_server(status);
        try {
            const r = await spawnR(cap, rCode);
            const posts = cap.requests.filter(req => req.headers.includes('POST /view-data'));
            expect(posts.length).toBe(1);
            const raw = posts[0].body;
            return { body: JSON.parse(raw), bytes: Buffer.byteLength(raw, 'utf8'), r };
        } finally {
            await cap.close();
        }
    }

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'an expression near 64 KiB still opens the viewer: the whole body fits the server cap',
        async () => {
            const { body, bytes } = await viewDataBody(
                // The audit's repro, View(data.frame(x = "<65,400 a's>"), ...),
                // built with call() since R's console caps an input line at 4 KiB.
                'eval(call("View", call("data.frame", x = strrep("a", 65400L)), title = "Long literal")); Sys.sleep(0.2)',
            );
            // MAX_BODY_BYTES in r-session-server/index.ts.
            expect(bytes).toBeLessThanOrEqual(64 * 1024);
            expect(body.panelName).toBe('Long literal');
            expect(body.expression ?? '').toBe('');
            expect(body.nrow).toBe(1);
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'an expression whose escaped form passes 64 KiB is dropped, not sent',
        async () => {
            // 30,000 quotes deparse to 60,002 bytes (under 64 KiB) but
            // escape to 120,000+ in the JSON body.
            const { body, bytes } = await viewDataBody(
                'eval(call("View", call("c", strrep(\'"\', 30000L)))); Sys.sleep(0.2)',
            );
            expect(bytes).toBeLessThanOrEqual(64 * 1024);
            expect(body.expression ?? '').toBe('');
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'a quote in the expression yields valid JSON that round-trips',
        async () => {
            const { body } = await viewDataBody(
                `View(data.frame(s = 'a"b'), title = 'quoted'); Sys.sleep(0.2)`,
            );
            expect(body.panelName).toBe('quoted');
            expect(body.expression).toBe('data.frame(s = "a\\"b")');
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'every character JSON must escape round-trips through panelName and expression',
        async () => {
            // backslash, quote, newline, tab, CR, BS, FF, U+0001, U+001F,
            // DEL, é, U+2028, an astral emoji.
            const cps = [97, 92, 98, 34, 99, 10, 9, 13, 8, 12, 1, 31, 127, 233, 0x2028, 0x1f600, 122];
            const { body } = await viewDataBody(
                `t <- intToUtf8(c(${cps.join(', ')})); View(data.frame(s = t), title = t); Sys.sleep(0.2)`,
            );
            const t = String.fromCodePoint(...cps);
            expect(body.panelName).toBe(t);
            expect(body.expression).toBe('data.frame(s = t)');
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'non-syntactic names are captured with backticks, so Refresh re-evaluates them',
        async () => {
            const a = await viewDataBody('`my table` <- data.frame(a = 1); View(`my table`); Sys.sleep(0.2)');
            expect(a.body.expression).toBe('`my table`');
            const b = await viewDataBody('`a+b` <- data.frame(a = 1); View(`a+b`); Sys.sleep(0.2)');
            expect(b.body.expression).toBe('`a+b`');
            // The panel title stays the readable name.
            expect(b.body.panelName).toBe('a+b');
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'an untitled expression past 256 bytes: its cut name passed back as the title names the same panel',
        async () => {
            // A two-byte character straddles the 256-byte cut.
            const setup = 'df <- data.frame(a = 1)';
            const call = `View(subset(df, nchar("${'é'.repeat(150)}") > 0))`;
            const first = await viewDataBody(`${setup}; ${call}; Sys.sleep(0.2)`);
            const name = String(first.body.panelName);
            expect(name.endsWith('\u2026')).toBe(true);
            expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(256);
            // What Refresh sends (DataViewerPanel.refreshCall).
            const again = await viewDataBody(
                `${setup}; View(${String(first.body.expression)}, title = ${rString(name)}); Sys.sleep(0.2)`,
            );
            expect(again.body.panelName).toBe(name);
            expect(again.body.expression).toBe(first.body.expression);
        },
        30_000,
    );

    /** TRUE when `expr` (R source) evaluates, after `setup`, to the same
     *  object as `obj`. */
    async function evaluatesTo(setup: string, expr: string, obj: string): Promise<boolean> {
        const cap = await start_capture_server();
        try {
            const r = await spawnR(
                cap,
                `${setup}; cat("RAVEN_SAME=", identical(eval(parse(text = Sys.getenv("RAVEN_EXPR"))), ${obj}), "\\n", sep = "")`,
                { RAVEN_EXPR: expr },
            );
            return r.stdout.includes('RAVEN_SAME=TRUE');
        } finally {
            await cap.close();
        }
    }

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'the captured expression is R source that evaluates to the viewed object',
        async () => {
            const cases: Array<[setup: string, call: string, obj: string]> = [
                ['`my table` <- data.frame(a = 1)', 'View(`my table`)', '`my table`'],
                ['`a+b` <- data.frame(a = 1); a <- 1; b <- 2', 'View(`a+b`)', '`a+b`'],
                ['invisible(0)', 'View(local({ a <- 1; data.frame(a) }))', 'data.frame(a = 1)'],
                ['`if` <- NULL; l <- list(`x y` = data.frame(z = 1))', 'View(l$`x y`)', 'l$`x y`'],
            ];
            for (const [setup, call, obj] of cases) {
                const { body } = await viewDataBody(`${setup}; ${call}; Sys.sleep(0.2)`);
                const expr = String(body.expression);
                expect({ call, ok: await evaluatesTo(setup, expr, obj) }).toEqual({ call, ok: true });
            }
        },
        60_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'an empty title falls back to "View" (the server needs a panel name)',
        async () => {
            const { body } = await viewDataBody('View(mtcars, title = ""); Sys.sleep(0.2)');
            expect(body.panelName).toBe('View');
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'a title too long for the request is truncated, and the viewer still opens',
        async () => {
            const { body, bytes } = await viewDataBody(
                'View(mtcars, title = strrep("t", 70000L)); Sys.sleep(0.2)',
            );
            expect(bytes).toBeLessThanOrEqual(64 * 1024);
            expect(body.expression ?? '').toBe('');
            const title = String(body.panelName);
            expect(title.startsWith('ttt')).toBe(true);
            expect(title.endsWith('…')).toBe(true);
            expect(Buffer.byteLength(title, 'utf8')).toBeLessThanOrEqual(256);
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'a refused /view-data request leaves no Arrow file behind',
        async () => {
            const { r } = await viewDataBody(
                'View(mtcars); Sys.sleep(0.2); cat("RAVEN_LEFT=", length(list.files(Sys.getenv("RAVEN_DATA_VIEWER_DIR"), pattern = "[.]arrow$")), "\\n", sep = "")',
                400,
            );
            expect(r.stdout).toContain('RAVEN_LEFT=0');
        },
        30_000,
    );

    test.skipIf(!HAS_R || !HAS_ARROW)(
        'against the real session server, each audited View() opens the viewer',
        async () => {
            const tmp = mkdtempSync(join(tmpdir(), 'raven-dv-e2e-'));
            const dvDir = realpathSync(join(tmp, '.'));
            mkdirSync(join(dvDir, 'dv'));
            const server = new RSessionServer(join(dvDir, 'dv'));
            await server.start();
            const events: RSessionEvent[] = [];
            server.onEvent(e => events.push(e));
            try {
                const profile_path = await write_profile_file(tmp, generate_profile_source());
                const proc = spawn({
                    cmd: [R_BIN, '--quiet', '--no-save', '--no-restore', '-e', [
                        'eval(call("View", call("data.frame", x = strrep("a", 65400L)), title = "Long literal"))',
                        `View(data.frame(s = 'a"b'), title = 'quoted')`,
                        '`my table` <- data.frame(a = 1); View(`my table`)',
                        'Sys.sleep(0.3)',
                    ].join('\n')],
                    cwd: tmp,
                    env: {
                        ...process.env,
                        R_PROFILE_USER: profile_path,
                        RAVEN_ORIGINAL_R_PROFILE_USER: '',
                        RAVEN_SESSION_PORT: String(server.port),
                        RAVEN_SESSION_TOKEN: server.token,
                        RAVEN_R_SESSION_ID: 'e2e',
                        RAVEN_DATA_VIEWER_DIR: join(dvDir, 'dv'),
                    },
                    stdout: 'pipe', stderr: 'pipe',
                });
                await proc.exited;
                const opened = events.filter(e => e.type === 'view-data-requested') as
                    Extract<RSessionEvent, { type: 'view-data-requested' }>[];
                expect(opened.map(e => e.panelName)).toEqual(['Long literal', 'quoted', 'my table']);
                expect(opened.map(e => e.expression)).toEqual([
                    undefined, 'data.frame(s = "a\\"b")', '`my table`',
                ]);
            } finally {
                await server.stop();
            }
        },
        30_000,
    );
});
