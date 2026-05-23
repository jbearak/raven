import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, sleep } from './helper';
import { __runKnitCommandForTest, type KnitDeps } from '../knit/knit-commands';

/**
 * Verifies that `Raven: Knit Preview` ignores the YAML `output:` block:
 * documents that previously hit the non-HTML-format gate now proceed
 * straight to knit and render as HTML preview.
 *
 * This test was renamed from `knit-html-only.test.ts` when the gate was
 * dropped. The historical opposite assertion — that a `pdf_document`
 * Rmd was refused — is the previous behavior we're explicitly reversing.
 * See docs/superpowers/specs/2026-05-23-knit-preview-export-design.md.
 */

async function writeTempRmd(name: string, frontmatter: string): Promise<vscode.Uri> {
    const tmp = require('os').tmpdir() as string;
    const fs = require('fs') as typeof import('fs');
    const p = require('path') as typeof import('path');
    const dir = fs.mkdtempSync(p.join(tmp, 'raven-knit-yaml-ignored-'));
    const filePath = p.join(dir, name);
    fs.writeFileSync(filePath, `---\n${frontmatter}\n---\n\nbody.\n`, 'utf-8');
    return vscode.Uri.file(filePath);
}

function makeKnitDeps(): { deps: KnitDeps; calls: { runKnit: number } } {
    const calls = { runKnit: 0 };
    const deps: KnitDeps = {
        runKnit: (async () => {
            calls.runKnit += 1;
            return {
                spawnError: null,
                cancelled: false,
                timedOut: false,
                exitCode: 0,
                // Synthetic output path so the success branch has
                // something to feed into the panel-show stub.
                stdout: 'Output created: /tmp/fake.html\n',
                stderr: '',
            };
        }) as KnitDeps['runKnit'],
        showOrUpdatePanel: (async () => ({ ok: true })) as KnitDeps['showOrUpdatePanel'],
        getLanguageClient: () => undefined,
        runPostKnitRender: (async () => undefined) as KnitDeps['runPostKnitRender'],
    };
    return { deps, calls };
}

suite('Knit Preview ignores YAML output: format', () => {
    test('output: pdf_document still launches knit', async () => {
        await activate();
        const docUri = await writeTempRmd('pdf-doc.Rmd', 'output: pdf_document');
        const inFlight = new Set<string>();
        const output = vscode.window.createOutputChannel('Knit Test');
        const fakeContext = { subscriptions: [] } as unknown as vscode.ExtensionContext;
        const { deps, calls } = makeKnitDeps();
        try {
            await __runKnitCommandForTest({ uri: docUri, output, inFlight, context: fakeContext, deps });
            await sleep(50);
            assert.strictEqual(calls.runKnit, 1, 'knit subprocess should be launched for pdf_document');
        } finally {
            output.dispose();
            try {
                const fs = require('fs') as typeof import('fs');
                const p = require('path') as typeof import('path');
                fs.rmSync(p.dirname(docUri.fsPath), { recursive: true, force: true });
            } catch { /* ignore */ }
        }
    });

    test('output: word_document still launches knit', async () => {
        await activate();
        const docUri = await writeTempRmd('word-doc.Rmd', 'output: word_document');
        const inFlight = new Set<string>();
        const output = vscode.window.createOutputChannel('Knit Test');
        const fakeContext = { subscriptions: [] } as unknown as vscode.ExtensionContext;
        const { deps, calls } = makeKnitDeps();
        try {
            await __runKnitCommandForTest({ uri: docUri, output, inFlight, context: fakeContext, deps });
            await sleep(50);
            assert.strictEqual(calls.runKnit, 1, 'knit subprocess should be launched for word_document');
        } finally {
            output.dispose();
            try {
                const fs = require('fs') as typeof import('fs');
                const p = require('path') as typeof import('path');
                fs.rmSync(p.dirname(docUri.fsPath), { recursive: true, force: true });
            } catch { /* ignore */ }
        }
    });

    test('output: bookdown::pdf_document2 still launches knit', async () => {
        await activate();
        const docUri = await writeTempRmd('bookdown-pdf.Rmd', 'output: bookdown::pdf_document2');
        const inFlight = new Set<string>();
        const output = vscode.window.createOutputChannel('Knit Test');
        const fakeContext = { subscriptions: [] } as unknown as vscode.ExtensionContext;
        const { deps, calls } = makeKnitDeps();
        try {
            await __runKnitCommandForTest({ uri: docUri, output, inFlight, context: fakeContext, deps });
            await sleep(50);
            assert.strictEqual(calls.runKnit, 1, 'custom non-HTML formats should also launch knit');
        } finally {
            output.dispose();
            try {
                const fs = require('fs') as typeof import('fs');
                const p = require('path') as typeof import('path');
                fs.rmSync(p.dirname(docUri.fsPath), { recursive: true, force: true });
            } catch { /* ignore */ }
        }
    });

    test('default html_document (no YAML output:) still launches knit', async () => {
        await activate();
        const docUri = await writeTempRmd('plain.Rmd', 'title: "Plain"');
        const inFlight = new Set<string>();
        const output = vscode.window.createOutputChannel('Knit Test');
        const fakeContext = { subscriptions: [] } as unknown as vscode.ExtensionContext;
        const { deps, calls } = makeKnitDeps();
        try {
            await __runKnitCommandForTest({ uri: docUri, output, inFlight, context: fakeContext, deps });
            await sleep(50);
            assert.strictEqual(calls.runKnit, 1);
        } finally {
            output.dispose();
            try {
                const fs = require('fs') as typeof import('fs');
                const p = require('path') as typeof import('path');
                fs.rmSync(p.dirname(docUri.fsPath), { recursive: true, force: true });
            } catch { /* ignore */ }
        }
    });
});
