import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate } from './helper';
import { KnitOutputPanel } from '../knit/knit-output-panel';

function writeFixture(dir: string, name: string, body = '<html><body>hi</body></html>'): string {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, body, 'utf-8');
    return p;
}

suite('KnitOutputPanel integration', () => {
    let tmp: string;

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-knit-panel-'));
    });

    teardown(() => {
        KnitOutputPanel.disposeForTesting();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
    });

    test('showOrUpdate reuses the singleton when rootDir is unchanged', async () => {
        await activate();
        const output = vscode.window.createOutputChannel('Knit Test');
        try {
            const a = writeFixture(tmp, 'a.html');
            const b = writeFixture(tmp, 'b.html');
            const src = vscode.Uri.file(path.join(tmp, 'src.Rmd'));

            const r1 = await KnitOutputPanel.showOrUpdate(
                {} as vscode.ExtensionContext,
                { sourceUri: src, outputPath: a, output },
            );
            assert.deepStrictEqual(r1, { ok: true });
            const inst1 = KnitOutputPanel.getInstanceForTesting();
            assert.ok(inst1);

            const r2 = await KnitOutputPanel.showOrUpdate(
                {} as vscode.ExtensionContext,
                { sourceUri: src, outputPath: b, output },
            );
            assert.deepStrictEqual(r2, { ok: true });
            const inst2 = KnitOutputPanel.getInstanceForTesting();
            assert.strictEqual(inst1, inst2, 'singleton instance should be reused');
        } finally {
            output.dispose();
        }
    });

    test('showOrUpdate creates a fresh panel when rootDir changes', async () => {
        await activate();
        const output = vscode.window.createOutputChannel('Knit Test');
        try {
            const sub = path.join(tmp, 'sub');
            const a = writeFixture(tmp, 'a.html');
            const b = writeFixture(sub, 'b.html');
            const src = vscode.Uri.file(path.join(tmp, 'src.Rmd'));

            await KnitOutputPanel.showOrUpdate(
                {} as vscode.ExtensionContext,
                { sourceUri: src, outputPath: a, output },
            );
            const inst1 = KnitOutputPanel.getInstanceForTesting();
            assert.ok(inst1);

            await KnitOutputPanel.showOrUpdate(
                {} as vscode.ExtensionContext,
                { sourceUri: src, outputPath: b, output },
            );
            const inst2 = KnitOutputPanel.getInstanceForTesting();
            assert.ok(inst2);
            assert.notStrictEqual(inst1, inst2, 'a new singleton should be created when rootDir changes');
        } finally {
            output.dispose();
        }
    });

    test('panel is created with the security-relevant webview options', async () => {
        await activate();
        const output = vscode.window.createOutputChannel('Knit Test');
        try {
            const a = writeFixture(tmp, 'a.html');
            const src = vscode.Uri.file(path.join(tmp, 'src.Rmd'));

            const r = await KnitOutputPanel.showOrUpdate(
                {} as vscode.ExtensionContext,
                { sourceUri: src, outputPath: a, output },
            );
            assert.deepStrictEqual(r, { ok: true });
            const inst = KnitOutputPanel.getInstanceForTesting();
            assert.ok(inst);

            // Access the panel via the singleton — the panel field is
            // private but the only public surface, `panel.webview`, is
            // reachable via `WebviewPanel.webview`. We assert the
            // *options* set at creation time.
            const opts = (inst as unknown as { panel: vscode.WebviewPanel }).panel.webview.options;
            assert.strictEqual(opts.enableScripts, true);
            assert.ok(opts.localResourceRoots, 'localResourceRoots is set');
            assert.strictEqual(opts.localResourceRoots!.length, 1);
            assert.strictEqual(opts.localResourceRoots![0].fsPath, tmp);
        } finally {
            output.dispose();
        }
    });

    test('showOrUpdate returns {ok: false} when the output file does not exist', async () => {
        await activate();
        const output = vscode.window.createOutputChannel('Knit Test');
        try {
            const src = vscode.Uri.file(path.join(tmp, 'src.Rmd'));
            const result = await KnitOutputPanel.showOrUpdate(
                {} as vscode.ExtensionContext,
                { sourceUri: src, outputPath: path.join(tmp, 'does-not-exist.html'), output },
            );
            assert.strictEqual(result.ok, false);
            if (!result.ok) assert.ok(result.error.length > 0);
        } finally {
            output.dispose();
        }
    });

    test('theme preference from globalState renders the button pressed', async () => {
        // The toggle must persist across panel disposal/recreation:
        // KnitOutputPanel.updateContent reads
        // raven.knit.applyVSCodeTheme from globalState and threads
        // it into buildShellHtml. With the preference set to true,
        // the rendered shell HTML must reflect that initial state
        // so users don't see a flicker on each knit.
        await activate();
        const output = vscode.window.createOutputChannel('Knit Test');
        const stored: Record<string, unknown> = {
            'raven.knit.applyVSCodeTheme': true,
        };
        const fakeGlobalState = {
            get: <T>(key: string, defaultValue?: T) =>
                (stored[key] as T) ?? defaultValue,
            update: (key: string, value: unknown) => {
                stored[key] = value;
                return Promise.resolve();
            },
            keys: () => Object.keys(stored),
            setKeysForSync: () => undefined,
        } as unknown as vscode.Memento & { setKeysForSync(keys: readonly string[]): void };
        const fakeContext = {
            globalState: fakeGlobalState,
            subscriptions: [],
        } as unknown as vscode.ExtensionContext;
        try {
            const html = writeFixture(tmp, 'a.html');
            const src = vscode.Uri.file(path.join(tmp, 'src.Rmd'));
            const r = await KnitOutputPanel.showOrUpdate(
                fakeContext,
                { sourceUri: src, outputPath: html, output },
            );
            assert.deepStrictEqual(r, { ok: true });
            const inst = KnitOutputPanel.getInstanceForTesting();
            assert.ok(inst);
            const panel = (inst as unknown as { panel: vscode.WebviewPanel }).panel;
            assert.ok(
                /<button[^>]*id="raven-knit-theme"[^>]*aria-pressed="true"/
                    .test(panel.webview.html),
                'theme button should render in pressed state when globalState has the toggle on',
            );
            // The button label stays constant; only aria-pressed
            // flips, which is what CSS keys off for the visual
            // active state.
            assert.ok(
                !panel.webview.html.includes('Use document theme'),
                'button label should not switch (no document theme to switch back to)',
            );
        } finally {
            output.dispose();
        }
    });
});
