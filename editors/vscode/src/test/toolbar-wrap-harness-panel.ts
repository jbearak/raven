/**
 * Extension-host helper for the data-viewer toolbar-wrap real-layout suite.
 *
 * Opens a webview panel that loads the test harness bundle from
 * `dist-test/toolbar-wrap-harness/` (built by `bun run bundle:webview-test`),
 * and exposes the `test:*` message protocol the harness implements:
 *
 *   host → webview: test:reset, test:setWidth, test:setState,
 *                   test:requestSnapshot
 *   webview → host: test:ready, test:layoutSnapshot
 *
 * The host cannot read the sandboxed webview's DOM, so the webview measures
 * its own layout and posts the numbers back; this helper collects them and
 * resolves the higher-level `apply()` / `waitForReady()` promises the test
 * cases consume.
 *
 * NOTE: filename intentionally lacks `.test.` so the `.vscode-test.mjs`
 * glob (`out/test/**\/*.test.js`) does not load it as a suite.
 */

import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    snapshotReflectsMessage,
    type LayoutSnapshot,
} from './toolbar-wrap-protocol';

export type { LayoutSnapshot } from './toolbar-wrap-protocol';

// From `editors/vscode/out/test/toolbar-wrap-harness-panel.js`, the
// harness bundle lives at `editors/vscode/dist-test/toolbar-wrap-harness/`.
const HARNESS_DIR = path.resolve(__dirname, '..', '..', 'dist-test', 'toolbar-wrap-harness');

export interface HarnessController {
    panel: vscode.WebviewPanel;
    send(message: unknown): Thenable<boolean>;
    waitForReady(timeoutMs?: number): Promise<void>;
    apply(
        message: unknown,
        predicate?: (snap: LayoutSnapshot) => boolean,
        timeoutMs?: number,
    ): Promise<LayoutSnapshot>;
    reset(): Promise<LayoutSnapshot>;
    readonly latestSnapshot: LayoutSnapshot | null;
    dispose(): Promise<void>;
}

function generateNonce(): string {
    return crypto.randomBytes(16).toString('hex');
}

function buildHarnessHtml(webview: vscode.Webview, nonce: string): string {
    const jsUri = webview.asWebviewUri(vscode.Uri.file(path.join(HARNESS_DIR, 'index.js')));
    const cssUri = webview.asWebviewUri(vscode.Uri.file(path.join(HARNESS_DIR, 'index.css')));

    // Per-panel nonce in script-src; the harness bundle emits a sibling
    // index.css (esbuild's css loader does not inline CSS into the IIFE),
    // so we link it just like production webviews do.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               style-src ${webview.cspSource} 'nonce-${nonce}';
               script-src 'nonce-${nonce}';
               img-src ${webview.cspSource} https: data:;
               font-src ${webview.cspSource};">
<title>Toolbar Wrap Harness</title>
<link nonce="${nonce}" rel="stylesheet" href="${cssUri}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

function withTimeout<T>(p: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([p, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

/** Open the harness panel and wire up the message protocol. */
export function openHarnessPanel(): HarnessController {
    const panel = vscode.window.createWebviewPanel(
        'raven.toolbarWrapHarness',
        'Toolbar Wrap Harness',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.file(HARNESS_DIR)],
        },
    );

    let isReady = false;
    const readyWaiters: Array<() => void> = [];
    const snapshotWaiters: Array<(snap: LayoutSnapshot) => void> = [];
    let latestSnapshot: LayoutSnapshot | null = null;

    // Register BEFORE setting html so the test:ready handshake and the
    // initial snapshot can never be missed.
    panel.webview.onDidReceiveMessage((message: unknown) => {
        if (!message || typeof message !== 'object') return;
        const m = message as { type?: unknown };
        if (typeof m.type !== 'string') return;
        if (m.type === 'test:ready') {
            isReady = true;
            while (readyWaiters.length > 0) readyWaiters.shift()!();
            return;
        }
        if (m.type === 'test:layoutSnapshot') {
            const snap = message as LayoutSnapshot;
            latestSnapshot = snap;
            while (snapshotWaiters.length > 0) snapshotWaiters.shift()!(snap);
        }
    });

    const nonce = generateNonce();
    panel.webview.html = buildHarnessHtml(panel.webview, nonce);

    function send(message: unknown): Thenable<boolean> {
        return panel.webview.postMessage(message);
    }

    function waitForReady(timeoutMs = 30000): Promise<void> {
        if (isReady) return Promise.resolve();
        return withTimeout(
            new Promise<void>(resolve => { readyWaiters.push(resolve); }),
            timeoutMs,
            'Timed out waiting for harness test:ready',
        );
    }

    // Resolves on the next layoutSnapshot received after this call. The
    // waiter is registered synchronously so callers can register it before
    // posting and never miss the reply.
    function nextSnapshot(timeoutMs: number): Promise<LayoutSnapshot> {
        return new Promise<LayoutSnapshot>((resolve, reject) => {
            const timer = setTimeout(() => {
                const i = snapshotWaiters.indexOf(entry);
                if (i >= 0) snapshotWaiters.splice(i, 1);
                reject(new Error('Timed out waiting for test:layoutSnapshot'));
            }, timeoutMs);
            const entry = (snap: LayoutSnapshot) => {
                clearTimeout(timer);
                resolve(snap);
            };
            snapshotWaiters.push(entry);
        });
    }

    /**
     * Send a control message, then poll snapshots (via test:requestSnapshot)
     * until the snapshot reflects that message and `predicate(snap)` holds,
     * or the deadline passes. React state updates in the webview are async:
     * a requested snapshot can report the previous render, and late rAF
     * snapshots can also arrive after a new control message. Those snapshots
     * are valid telemetry but not valid answers to the current `apply()`.
     * Returns the last snapshot seen if the predicate never matches (the
     * caller's assertion then reports the mismatch).
     */
    async function apply(
        message: unknown,
        predicate?: (snap: LayoutSnapshot) => boolean,
        timeoutMs = 5000,
    ): Promise<LayoutSnapshot> {
        const deadline = Date.now() + timeoutMs;
        await send(message);
        let snap: LayoutSnapshot | null = null;
        while (Date.now() < deadline) {
            const wait = nextSnapshot(1500);
            await send({ type: 'test:requestSnapshot' });
            try {
                snap = await wait;
            } catch {
                continue;
            }
            if (snapshotReflectsMessage(message, snap) && (!predicate || predicate(snap))) {
                return snap;
            }
        }
        if (snap) return snap;
        throw new Error('apply: no snapshot received within timeout');
    }

    function reset(): Promise<LayoutSnapshot> {
        // Wait for the cleared state to settle. With zero chips the toolbar
        // can never wrap, so each test starts from a known single-row
        // baseline and a stray late snapshot can't leak into the next case.
        return apply({ type: 'test:reset' }, snap => snap.isWrapped === false);
    }

    async function dispose(): Promise<void> {
        panel.dispose();
        // Let VS Code settle the panel teardown before the next suite.
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    return {
        panel,
        send,
        waitForReady,
        apply,
        reset,
        get latestSnapshot() { return latestSnapshot; },
        dispose,
    };
}
