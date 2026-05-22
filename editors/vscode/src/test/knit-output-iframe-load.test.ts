import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate, sleep } from './helper';
import { KnitOutputPanel } from '../knit/knit-output-panel';

/**
 * Runtime integration test for the Knit Output webview iframe.
 *
 * Original bug: the panel rendered the toolbar correctly but the
 * iframe area showed pure white instead of the rendered HTML. Root
 * cause: a nested `<iframe>` inside a VS Code webview cannot navigate
 * to a `webview.asWebviewUri(...)` URL — Electron's resource handler
 * does not intercept nested-frame navigations, so the network stack
 * tries a real DNS lookup on `file+.vscode-resource.vscode-cdn.net`
 * and fails with `ERR_NAME_NOT_RESOLVED`. The fix inlines the rendered
 * HTML via `srcdoc` and uses `sandbox="allow-same-origin"` so the
 * iframe inherits the parent webview origin (scripts/forms/popups
 * stay blocked).
 *
 * The assertions check:
 *  1. A recognizable marker from the rendered HTML appears in
 *     `panel.webview.html` — i.e. the content was inlined, not
 *     reached via URL navigation.
 *  2. The shell instruments the iframe with load/error listeners and
 *     a `probe` message; the probe round-trip reports `loadFired`
 *     without firing the `error` event or surfacing CSP violations.
 */
suite('KnitOutputPanel iframe loads rendered HTML', () => {
    let tmp: string;

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-knit-iframe-'));
    });

    teardown(() => {
        KnitOutputPanel.disposeAllForTesting();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
    });

    test('rendered HTML content is inlined into the webview shell', async function () {
        this.timeout(30000);
        await activate();

        const marker = 'RAVEN-IFRAME-TEST-MARKER';
        // Include a fragment-only anchor + a target with that id so we
        // can assert that intra-document anchor navigation survives
        // the `<base href>` injection (Codex review #1).
        const body = '<!doctype html><html><head><title>t</title></head>'
            + '<body>'
            + '<a id="toc-link" href="#results">Jump to results</a>'
            + `<h1 id="results">${marker}</h1>`
            + '</body></html>';
        const outputPath = path.join(tmp, 'analysis.html');
        fs.writeFileSync(outputPath, body, 'utf-8');

        const src = vscode.Uri.file(path.join(tmp, 'src.Rmd'));
        const output = vscode.window.createOutputChannel('Knit Test');
        try {
            const r = await KnitOutputPanel.showOrUpdate(
                {} as vscode.ExtensionContext,
                { sourceUri: src, outputPath, output },
            );
            assert.deepStrictEqual(r, { ok: true });
            const inst = KnitOutputPanel.getInstancesForTesting().get(src.fsPath);
            assert.ok(inst, 'panel instance should exist');
            const panel = inst.getPanelForTesting();

            // The marker is the strongest signal that content actually
            // reaches the iframe — `srcdoc` embeds the rendered HTML
            // inline in `panel.webview.html`, so a missing marker
            // means the content was never wired through.
            assert.ok(
                panel.webview.html.includes(marker),
                'expected the rendered HTML marker to appear in panel.webview.html',
            );

            // The iframe element uses `srcdoc` (inline HTML) rather
            // than `src` (URL navigation). This is the fix — `src` on
            // a nested iframe inside a VS Code webview fails with
            // `ERR_NAME_NOT_RESOLVED`.
            assert.ok(
                /<iframe[^>]*srcdoc=/.test(panel.webview.html),
                'iframe should use srcdoc to inline the content',
            );
            assert.ok(
                !/<iframe[^>]*\ssrc=/.test(panel.webview.html),
                'iframe should not use src= (broken for nested iframes in webviews)',
            );

            // Fragment-only anchors must be rewritten to point at
            // `about:srcdoc#…`. Without this rewrite, the injected
            // `<base href>` would route a click on a TOC link into a
            // full cross-document navigation (Codex review).
            assert.ok(
                panel.webview.html.includes('href=&quot;about:srcdoc#results&quot;'),
                'fragment anchor should be rewritten to about:srcdoc#…',
            );
            assert.ok(
                !panel.webview.html.includes('href=&quot;#results&quot;'),
                'raw fragment-only href should not survive into the srcdoc',
            );

            // Force the panel to the front of its tab group before
            // probing — when this test runs after the per-source-
            // panel suites (knit-multi-panel, knit-rootdir-change,
            // etc.) have already churned several webviews, the new
            // panel can be created hidden, and VS Code throttles
            // message delivery to hidden webviews.
            panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Beside, false);
            // 25s probe budget within the 30s mocha timeout.
            const probeResult = await probeIframe(panel.webview, 25000);
            assert.ok(
                probeResult.loadFired,
                `iframe never fired a 'load' event. Diagnostics: ${JSON.stringify(probeResult)}`,
            );
            assert.ok(
                !probeResult.errorFired,
                `iframe fired an 'error' event. Diagnostics: ${JSON.stringify(probeResult)}`,
            );
            // Same-origin access to the iframe document is what
            // allows the theme overlay to inject CSS — locationHref
            // accessible AND equal to 'about:srcdoc' confirms the
            // sandbox=allow-same-origin + srcdoc setup is working.
            assert.strictEqual(
                probeResult.locationHref,
                'about:srcdoc',
                'iframe should be same-origin (about:srcdoc) so the theme overlay can inject CSS',
            );
            assert.strictEqual(
                probeResult.cspViolations.length,
                0,
                `CSP violations observed: ${JSON.stringify(probeResult.cspViolations)}`,
            );
        } finally {
            output.dispose();
        }
    });

    test('relative <img> in the rendered HTML loads inside the iframe', async function () {
        this.timeout(30000);
        await activate();

        // Drop a real PNG (smallest valid PNG: 1×1 transparent) next
        // to the rendered HTML. Knit output references it via a
        // relative path the same way the post-knit pipeline emits
        // `figure/plot-1.png` for actual knitr chunks.
        const figDir = path.join(tmp, 'figure');
        fs.mkdirSync(figDir, { recursive: true });
        const pngBytes = Buffer.from(
            '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
            '1f15c4890000000d49444154789c63000100000005000174ec61e30000' +
            '0000049454e44ae426082',
            'hex',
        );
        const pngPath = path.join(figDir, 'plot-1.png');
        fs.writeFileSync(pngPath, pngBytes);

        const body = '<!doctype html><html><body>'
            + '<img src="figure/plot-1.png" alt="diagnostic-marker">'
            + '</body></html>';
        const outputPath = path.join(tmp, 'analysis.html');
        fs.writeFileSync(outputPath, body, 'utf-8');

        const src = vscode.Uri.file(path.join(tmp, 'src.Rmd'));
        const output = vscode.window.createOutputChannel('Knit Test');
        try {
            const r = await KnitOutputPanel.showOrUpdate(
                {} as vscode.ExtensionContext,
                { sourceUri: src, outputPath, output },
            );
            assert.deepStrictEqual(r, { ok: true });
            const inst = KnitOutputPanel.getInstancesForTesting().get(src.fsPath);
            assert.ok(inst);
            const panel = inst.getPanelForTesting();

            panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Beside, false);
            const probeResult = await probeIframe(panel.webview, 25000);

            assert.ok(
                probeResult.loadFired,
                `iframe never fired load. ${JSON.stringify(probeResult)}`,
            );
            // The single <img> in the rendered HTML should be in the
            // probe's imageStates with non-zero natural dimensions —
            // meaning the browser actually fetched and decoded it.
            assert.strictEqual(
                probeResult.imageStates.length,
                1,
                `expected one <img> in the iframe, got ${JSON.stringify(probeResult.imageStates)}`,
            );
            const img = probeResult.imageStates[0];
            // The panel inlines relative <img> sources as data URLs
            // to work around the nested-iframe subresource issue: VS
            // Code's resource handler doesn't intercept subresource
            // fetches issued from a nested `<iframe srcdoc>`, so the
            // webview-resource URL the `<base>` resolves them to
            // escapes the handler and fails with a real DNS lookup.
            // Inlining the bytes as `data:image/png;base64,…` removes
            // the resource fetch entirely.
            assert.ok(
                img.src.startsWith('data:image/png;base64,'),
                `expected the panel to inline the image as a data URL, got src=${img.src}`,
            );
            assert.ok(
                img.naturalWidth > 0 && img.naturalHeight > 0,
                `image did NOT load — complete=${img.complete}, ` +
                    `naturalWidth=${img.naturalWidth}, ` +
                    `resolvedSrc=${img.resolvedSrc.slice(0, 80)}…, ` +
                    `cspViolations=${JSON.stringify(probeResult.cspViolations)}`,
            );
        } finally {
            output.dispose();
        }
    });
});

interface ImageState {
    src: string;
    resolvedSrc: string;
    complete: boolean;
    naturalWidth: number;
    naturalHeight: number;
}

interface ProbeResult {
    locationHref: string;
    loadFired: boolean;
    errorFired: boolean;
    src: string | null;
    cspViolations: Array<{ violatedDirective: string; blockedURI: string }>;
    imageStates: ImageState[];
}

/**
 * Round-trip a `probe` message into the webview shell and wait for the
 * shell's diagnostic reply.
 */
async function probeIframe(
    webview: vscode.Webview,
    timeoutMs: number,
): Promise<ProbeResult> {
    await sleep(750);

    const violations: Array<{ violatedDirective: string; blockedURI: string }> = [];

    return await new Promise<ProbeResult>((resolve, reject) => {
        let settled = false;
        let pokeTimer: NodeJS.Timeout | undefined;
        let timeoutTimer: NodeJS.Timeout | undefined;
        let sub: vscode.Disposable | undefined;

        const cleanup = () => {
            settled = true;
            if (pokeTimer) clearInterval(pokeTimer);
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (sub) sub.dispose();
        };

        timeoutTimer = setTimeout(() => {
            if (settled) return;
            cleanup();
            reject(new Error(
                `Timed out waiting for iframeProbe. ` +
                `Violations: ${JSON.stringify(violations)}.`,
            ));
        }, timeoutMs);

        sub = webview.onDidReceiveMessage((raw: unknown) => {
            if (!raw || typeof raw !== 'object') return;
            const msg = raw as Record<string, unknown>;
            if (msg.type === 'cspViolation') {
                violations.push({
                    violatedDirective: String(msg.violatedDirective ?? ''),
                    blockedURI: String(msg.blockedURI ?? ''),
                });
                return;
            }
            if (msg.type === 'iframeProbe') {
                if (settled) return;
                cleanup();
                const rawStates = Array.isArray(msg.imageStates) ? msg.imageStates : [];
                resolve({
                    locationHref: String(msg.locationHref ?? ''),
                    loadFired: Boolean(msg.loadFired),
                    errorFired: Boolean(msg.errorFired),
                    src: msg.src == null ? null : String(msg.src),
                    cspViolations: violations,
                    imageStates: rawStates.map((s: Record<string, unknown>): ImageState => ({
                        src: String(s.src ?? ''),
                        resolvedSrc: String(s.resolvedSrc ?? ''),
                        complete: Boolean(s.complete),
                        naturalWidth: Number(s.naturalWidth ?? 0),
                        naturalHeight: Number(s.naturalHeight ?? 0),
                    })),
                });
            }
        });

        const poke = () => { void webview.postMessage({ __ravenKnitProbe: true }); };
        poke();
        pokeTimer = setInterval(poke, 250);
    });
}
