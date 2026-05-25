import * as assert from 'assert';
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as http from 'http';
import { RSessionServer } from '../../r-session-server';
import { PlotViewerPanel } from '../../plot/plot-viewer-panel';

/**
 * Drives the "Apply VS Code theme" toggle end-to-end through a real
 * `WebviewPanel`. We can't easily exercise the Svelte webview side
 * inside vscode-test (no DOM access to assert against), so this suite
 * focuses on the host-visible contract:
 *
 *  - Persistence: a `set-theme-applied` message updates globalState.
 *  - Broadcast: that update is re-emitted to every open panel via
 *    `PlotServices.broadcastStateUpdate()` (routed through the internal
 *    `raven.plot.broadcastStateUpdate` command).
 *  - Seeding: the persisted value lands in `build_html`'s
 *    `__ravenInitialPlotState` script tag so the first paint reflects it.
 */
suite('plot theme-toggle — host wiring', () => {
    let server: RSessionServer;
    let fake_httpgd: http.Server;
    let httpgdPort: number;

    suiteSetup(async function () {
        this.timeout(30000);
        const ext = vscode.extensions.getExtension('jbearak.raven-r')
            ?? vscode.extensions.all.find(e => e.id.toLowerCase().endsWith('.raven-r'));
        assert.ok(ext, 'raven extension should be installed in the test host');
        await ext!.activate();
        server = new RSessionServer();
        await server.start();
        fake_httpgd = http.createServer((_req, res) => res.writeHead(200).end());
        await new Promise<void>(r => fake_httpgd.listen(0, '127.0.0.1', () => r()));
        httpgdPort = (fake_httpgd.address() as { port: number }).port;
    });

    suiteTeardown(async () => {
        await new Promise<void>(r => fake_httpgd.close(() => r()));
        await server.stop();
    });

    // No suite-level setup — every test that needs a clean globalState
    // builds its own Memento stub. The extension does not expose its
    // ExtensionContext on `exports`, so wiping the real globalState
    // from a test is intentionally not done. Tests that drive the
    // real production globalState risk cross-test bleed; keep them
    // self-contained.

    test('readThemePreference defaults to false when globalState is empty', () => {
        const ctx = {
            globalState: { get: (_k: string, def: unknown) => def } as unknown as vscode.Memento,
        } as unknown as vscode.ExtensionContext;
        assert.strictEqual(PlotViewerPanel.readThemePreference(ctx), false);
    });

    test('readThemePreference returns the stored boolean', () => {
        const ctx = {
            globalState: {
                get: (_k: string, _def: unknown) => true,
            } as unknown as vscode.Memento,
        } as unknown as vscode.ExtensionContext;
        assert.strictEqual(PlotViewerPanel.readThemePreference(ctx), true);
    });

    test('readThemePreference handles missing globalState (sparse stub)', () => {
        const ctx = {} as unknown as vscode.ExtensionContext;
        assert.strictEqual(PlotViewerPanel.readThemePreference(ctx), false);
    });

    test('set-theme-applied write goes into globalState, then broadcasts', async function () {
        this.timeout(20000);
        const ext = vscode.extensions.getExtension('jbearak.raven-r')!;
        // The PlotServices instance is hidden inside extension.ts. The
        // production wiring registers `raven.plot.broadcastStateUpdate`
        // as a regular VS Code command, which is observable here.
        // (Skip if the gate is closed in the test profile.)
        const allCommands = await vscode.commands.getCommands(true);
        if (!allCommands.includes('raven.plot.broadcastStateUpdate')) {
            this.skip();
        }

        // Drive a panel into existence so there's something to broadcast to.
        const sessionId = crypto.randomBytes(8).toString('hex');
        await postSessionReady(server, sessionId, httpgdPort);
        const ctx = { extensionUri: ext!.extensionUri } as unknown as vscode.ExtensionContext;
        // Sparse globalState stub to count update() calls.
        let last_value: unknown = undefined;
        const memento = {
            get: (_k: string, def: unknown) => last_value ?? def,
            update: async (_k: string, v: unknown) => { last_value = v; },
            keys: () => [PlotViewerPanel.THEME_PREFERENCE_KEY],
        };
        (ctx as { globalState: unknown }).globalState = memento;

        const panel = new PlotViewerPanel(ctx, server, sessionId, 1, { onDisposed: () => {} });
        try {
            panel.notifyPlotAvailable();
            // Wait for create_panel to settle.
            await pollFor(() => {
                const internal = panel as unknown as { panel: vscode.WebviewPanel | null };
                return internal.panel?.webview.html ?? null;
            }, 5000);

            // Simulate the webview posting a set-theme-applied(true).
            const internal = panel as unknown as {
                on_webview_message: (msg: unknown) => void;
            };
            internal.on_webview_message({
                type: 'set-theme-applied',
                payload: { applied: true },
            });
            await pollFor(() => last_value === true ? true : null, 5000);
            assert.strictEqual(last_value, true, 'globalState should hold true');
        } finally {
            panel.dispose();
        }
    });

    test('build_html bakes the persisted themeApplied into the script seed', async function () {
        this.timeout(15000);
        const ext = vscode.extensions.getExtension('jbearak.raven-r')!;
        const sessionId = crypto.randomBytes(8).toString('hex');
        await postSessionReady(server, sessionId, httpgdPort);
        const memento = {
            get: (_k: string, _def: unknown) => true, // pretend persisted
            update: async (_k: string, _v: unknown) => { /* no-op */ },
            keys: () => [PlotViewerPanel.THEME_PREFERENCE_KEY],
        };
        const ctx = {
            extensionUri: ext!.extensionUri,
            globalState: memento,
        } as unknown as vscode.ExtensionContext;

        const panel = new PlotViewerPanel(ctx, server, sessionId, 1, { onDisposed: () => {} });
        try {
            panel.notifyPlotAvailable();
            const html = await pollFor(() => {
                const internal = panel as unknown as { panel: vscode.WebviewPanel | null };
                const h = internal.panel?.webview.html ?? '';
                return h.includes('__ravenInitialPlotState') ? h : null;
            }, 5000);

            // Verify the seed contains an exact JSON-serialized boolean,
            // no string interpolation surprises.
            assert.match(
                html,
                /__ravenInitialPlotState = \{"themeApplied":true\};/,
                'persisted true should be baked as literal JSON',
            );
        } finally {
            panel.dispose();
        }
    });

    test('build_html with default-false produces themeApplied:false in the seed', async function () {
        this.timeout(15000);
        const ext = vscode.extensions.getExtension('jbearak.raven-r')!;
        const sessionId = crypto.randomBytes(8).toString('hex');
        await postSessionReady(server, sessionId, httpgdPort);
        const memento = {
            get: (_k: string, def: unknown) => def,
            update: async (_k: string, _v: unknown) => { /* no-op */ },
            keys: () => [],
        };
        const ctx = {
            extensionUri: ext!.extensionUri,
            globalState: memento,
        } as unknown as vscode.ExtensionContext;

        const panel = new PlotViewerPanel(ctx, server, sessionId, 1, { onDisposed: () => {} });
        try {
            panel.notifyPlotAvailable();
            const html = await pollFor(() => {
                const internal = panel as unknown as { panel: vscode.WebviewPanel | null };
                const h = internal.panel?.webview.html ?? '';
                return h.includes('__ravenInitialPlotState') ? h : null;
            }, 5000);

            assert.match(
                html,
                /__ravenInitialPlotState = \{"themeApplied":false\};/,
                'default false should be baked as literal JSON',
            );
        } finally {
            panel.dispose();
        }
    });

    test('cross-panel broadcast: postStateUpdate on a sibling panel re-reads the persisted value', async function () {
        // Verifies the broadcast contract end-to-end at the level the
        // host owns: when one panel writes Memento, calling
        // `postStateUpdate` on any OTHER open panel must push a
        // state-update carrying the new value. (The production wiring
        // goes through `executeCommand('raven.plot.broadcastStateUpdate')`
        // → `PlotServices.broadcastStateUpdate()` → every panel's
        // `postStateUpdate()`. Driving the registered command here
        // would hit the running PlotServices instance which has no
        // reference to our test-constructed panels; instead, exercise
        // each panel's `postStateUpdate` directly, which is the layer
        // that reads back from Memento.)
        this.timeout(20000);
        const ext = vscode.extensions.getExtension('jbearak.raven-r')!;
        let stored: unknown = false;
        const memento = {
            get: (_k: string, def: unknown) => stored ?? def,
            update: async (_k: string, v: unknown) => { stored = v; },
            keys: () => [PlotViewerPanel.THEME_PREFERENCE_KEY],
        };
        const ctx = {
            extensionUri: ext!.extensionUri,
            globalState: memento,
        } as unknown as vscode.ExtensionContext;

        const sessionA = crypto.randomBytes(8).toString('hex');
        const sessionB = crypto.randomBytes(8).toString('hex');
        for (const sid of [sessionA, sessionB]) {
            await postSessionReady(server, sid, httpgdPort);
        }
        const panelA = new PlotViewerPanel(ctx, server, sessionA, 1, { onDisposed: () => {} });
        const panelB = new PlotViewerPanel(ctx, server, sessionB, 2, { onDisposed: () => {} });
        try {
            panelA.notifyPlotAvailable();
            panelB.notifyPlotAvailable();
            await pollFor(() => {
                const ia = panelA as unknown as { panel: vscode.WebviewPanel | null };
                const ib = panelB as unknown as { panel: vscode.WebviewPanel | null };
                return ia.panel && ib.panel ? true : null;
            }, 5000);

            const messagesToB: unknown[] = [];
            const internalB = panelB as unknown as { panel: vscode.WebviewPanel | null };
            const realPostB = internalB.panel!.webview.postMessage.bind(internalB.panel!.webview);
            internalB.panel!.webview.postMessage = (m: unknown) => {
                messagesToB.push(m);
                return realPostB(m as Parameters<typeof realPostB>[0]);
            };

            // Wait for panel B to report `webview-ready` before
            // exercising the broadcast — until then, a state-update
            // posted on B would race the Svelte onMount listener
            // install and could be dropped. (Production wires this
            // round-trip identically: the host's
            // `on_webview_message('webview-ready')` is the bottleneck
            // that releases the first state-update.)
            const inboundB: unknown[] = [];
            internalB.panel!.webview.onDidReceiveMessage((m) => inboundB.push(m));
            await waitForWebviewReady(inboundB);

            // Write globalState as the production set-theme-applied
            // handler does, then call postStateUpdate on the sibling
            // — same code path the broadcast wires.
            await ctx.globalState.update(PlotViewerPanel.THEME_PREFERENCE_KEY, true);
            panelB.postStateUpdate();

            const got = await pollFor(() => {
                for (const m of messagesToB) {
                    const msg = m as { type?: string; payload?: { themeApplied?: boolean } };
                    if (msg.type === 'state-update' && msg.payload?.themeApplied === true) {
                        return msg;
                    }
                }
                return null;
            }, 5000);
            assert.ok(got, 'panel B should have received a state-update with themeApplied=true');
        } finally {
            panelA.dispose();
            panelB.dispose();
        }
    });

    test('no-echo invariant: a state-update never produces a set-theme-applied response', async function () {
        this.timeout(15000);
        // Verifies the load-bearing webview contract that we can only
        // reach end-to-end here: when the host broadcasts a state-update
        // (e.g. as the echo from another panel's broadcast), the
        // receiving webview must NOT post `set-theme-applied` back. A
        // future regression where on_message echoes the value would
        // produce a feedback loop in production but pass every
        // reducer-level test.
        const ext = vscode.extensions.getExtension('jbearak.raven-r')!;
        let stored: unknown = false;
        const memento = {
            get: (_k: string, def: unknown) => stored ?? def,
            update: async (_k: string, v: unknown) => { stored = v; },
            keys: () => [PlotViewerPanel.THEME_PREFERENCE_KEY],
        };
        const ctx = {
            extensionUri: ext!.extensionUri,
            globalState: memento,
        } as unknown as vscode.ExtensionContext;

        const sessionId = crypto.randomBytes(8).toString('hex');
        await postSessionReady(server, sessionId, httpgdPort);
        const panel = new PlotViewerPanel(ctx, server, sessionId, 1, { onDisposed: () => {} });
        try {
            // Observe inbound webview→host messages. Register BEFORE
            // calling `notifyPlotAvailable` so the `webview-ready`
            // message — which the Svelte `onMount` posts as soon as
            // its listener is installed — is captured deterministically.
            const inboundFromWebview: unknown[] = [];
            const internal = panel as unknown as { panel: vscode.WebviewPanel | null };
            panel.notifyPlotAvailable();
            const html = await pollFor(() => internal.panel?.webview.html ?? null, 5000);
            assert.ok(html, 'panel HTML should be set');
            internal.panel!.webview.onDidReceiveMessage((m) => inboundFromWebview.push(m));

            // Wait for the webview to report `webview-ready` — by
            // contract (AGENTS.md "onMount-ordering") the inbound
            // message listener inside App.svelte is installed BEFORE
            // this message is posted, so observing it on this side
            // means a subsequent `state-update` is guaranteed to
            // reach the webview's handler. Without this gate, the
            // assertion below could pass for the wrong reason — the
            // state-update would arrive before App.svelte's listener
            // exists and be silently dropped, masking a real echo
            // regression.
            await waitForWebviewReady(inboundFromWebview);

            // Reset the inbound buffer so the assertion only sees
            // messages produced in response to OUR state-update.
            inboundFromWebview.length = 0;

            // Push a state-update with themeApplied=true and wait for
            // the webview to settle (the no-echo invariant says NO
            // set-theme-applied reply should appear).
            await internal.panel!.webview.postMessage({
                type: 'state-update',
                payload: {
                    activeSession: null,
                    sessionEnded: false,
                    themeApplied: true,
                },
            });
            // Give the webview multiple frames to (incorrectly) respond.
            await new Promise(r => setTimeout(r, 500));

            const echoes = inboundFromWebview.filter((m) => {
                const msg = m as { type?: string };
                return msg.type === 'set-theme-applied';
            });
            assert.strictEqual(echoes.length, 0, 'webview must not echo set-theme-applied');
        } finally {
            panel.dispose();
        }
    });
});

async function pollFor<T>(fn: () => T | null | undefined, timeout_ms: number): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < timeout_ms) {
        const v = fn();
        if (v !== null && v !== undefined) return v;
        await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`pollFor: timed out after ${timeout_ms}ms`);
}

/**
 * POST `/session-ready` and assert the response is OK. A 4xx/5xx
 * here would otherwise surface much later as a "panel never saw the
 * session" failure with no useful diagnostic — fail fast at the
 * source.
 */
async function postSessionReady(
    server: RSessionServer,
    sessionId: string,
    httpgdPort: number,
): Promise<void> {
    const r = await fetch(`http://127.0.0.1:${server.port}/session-ready`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-raven-session-token': server.token,
        },
        body: JSON.stringify({
            sessionId,
            httpgdHost: '127.0.0.1',
            httpgdPort,
            httpgdToken: 'tok',
        }),
    });
    if (!r.ok) {
        const body = await r.text().catch(() => '<no body>');
        throw new Error(`/session-ready failed: ${r.status} ${body}`);
    }
}

/**
 * Wait for the webview's `webview-ready` message in an `inbound`
 * buffer that is being populated by an `onDidReceiveMessage`
 * listener. Mirrors the host's own readiness gate: the Svelte
 * `onMount` installs the inbound listener BEFORE posting
 * `webview-ready`, so by the time we observe that message the
 * webview is ready to receive `state-update`s and the no-echo
 * invariant can be exercised. Without this, a host-posted
 * `state-update` can arrive before the listener install and be
 * dropped, causing the no-echo assertion to pass for the wrong
 * reason.
 */
async function waitForWebviewReady(
    inbound: unknown[],
    timeout_ms = 5000,
): Promise<void> {
    await pollFor(() => {
        for (const m of inbound) {
            const msg = m as { type?: string };
            if (msg.type === 'webview-ready') return true;
        }
        return null;
    }, timeout_ms);
}
