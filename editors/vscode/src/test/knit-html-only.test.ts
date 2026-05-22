import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, getFixtureUri, sleep } from './helper';
import {
    __runKnitCommandForTest,
    buildNonHtmlFormatBlocker,
    type KnitDeps,
} from '../knit/knit-commands';

/**
 * Verifies that `Raven: Knit` is now HTML-only: a document whose YAML
 * declares a non-HTML output format (e.g. `pdf_document`) must be
 * refused before the R subprocess is ever launched. The user-visible
 * affordance is the existing "Copy command" Blocker UI — same path the
 * shiny / site / custom-knit-hook refusals use — and the message must
 * include a copy-pasteable `rmarkdown::render(...)` call so the user
 * can produce the requested format manually.
 */
/**
 * Write a temporary Rmd file with the given YAML body and return its
 * URI. The fixtures directory is read-only territory under test, so
 * exotic-YAML cases land in os.tmpdir() instead.
 */
async function writeTempRmd(name: string, frontmatter: string): Promise<vscode.Uri> {
    const tmp = require('os').tmpdir() as string;
    const fs = require('fs') as typeof import('fs');
    const p = require('path') as typeof import('path');
    const dir = fs.mkdtempSync(p.join(tmp, 'raven-knit-html-only-'));
    const filePath = p.join(dir, name);
    fs.writeFileSync(filePath, `---\n${frontmatter}\n---\n\nbody.\n`, 'utf-8');
    return vscode.Uri.file(filePath);
}

suite('knit refuses non-HTML output formats', () => {
    test('runKnit is never called for a pdf_document Rmd', async () => {
        await activate();

        const docUri = getFixtureUri('sample-pdf.Rmd');
        const doc = await vscode.workspace.openTextDocument(docUri);
        await vscode.window.showTextDocument(doc);

        const inFlight = new Set<string>();
        const output = vscode.window.createOutputChannel('Knit Test');

        // Stub the info-message dialog so the suspended Blocker prompt
        // does not stall the test. Capture the surfaced message so we
        // can assert the user sees the right copy-command UX.
        const origShow = vscode.window.showInformationMessage;
        const capturedMessages: string[] = [];
        (vscode.window as { showInformationMessage: unknown }).showInformationMessage = ((
            message: string,
            ..._rest: unknown[]
        ): Thenable<string | undefined> => {
            capturedMessages.push(message);
            // Resolve with undefined (no button clicked) so showBlocker
            // does not try to write to the clipboard.
            return Promise.resolve(undefined);
        }) as typeof vscode.window.showInformationMessage;

        const fakeContext = { subscriptions: [] } as unknown as vscode.ExtensionContext;
        let runKnitCalled = false;
        const deps: KnitDeps = {
            runKnit: (async () => {
                runKnitCalled = true;
                return {
                    spawnError: null,
                    cancelled: false,
                    timedOut: false,
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }) as KnitDeps['runKnit'],
            showOrUpdatePanel: (async () => ({ ok: true })) as KnitDeps['showOrUpdatePanel'],
            getLanguageClient: () => undefined,
            runPostKnitRender: (async () => undefined) as KnitDeps['runPostKnitRender'],
        };

        try {
            await __runKnitCommandForTest({
                uri: docUri,
                output,
                inFlight,
                context: fakeContext,
                deps,
            });

            await sleep(50);

            assert.strictEqual(
                runKnitCalled,
                false,
                'runKnit should NOT be called when the YAML output format is not HTML',
            );

            const matched = capturedMessages.find((m) =>
                m.includes('pdf_document') && /only renders to HTML/.test(m),
            );
            assert.ok(
                matched,
                `expected a Blocker info-message naming the format and the HTML restriction. ` +
                    `Got: ${JSON.stringify(capturedMessages)}`,
            );
        } finally {
            (vscode.window as { showInformationMessage: unknown }).showInformationMessage = origShow;
            output.dispose();
        }
    });

    /**
     * Adversarial coverage of the synthesized Blocker. YAML map keys
     * can hold arbitrary printable characters, so the `copyCommand`
     * must escape them through `escapeRString` — otherwise a value
     * like `x'); system('rm -rf ~'); #` would close the outer R
     * single-quoted literal and inject a follow-up call into whatever
     * the user pastes into their R console.
     *
     * Tested as a pure helper rather than through `__runKnitCommand-
     * ForTest` so the assertion is direct: the synthesized copy
     * command must be a single, well-formed `rmarkdown::render(...)`
     * call regardless of what the YAML says.
     */
    test('buildNonHtmlFormatBlocker escapes the format string so it cannot inject R code', () => {
        const malicious = "evil'); system('rm -rf ~'); #\\";
        const blocker = buildNonHtmlFormatBlocker(malicious);

        // The user-visible message echoes the malicious format
        // verbatim — that's fine, it's just informational text.
        assert.ok(
            blocker.message.includes(malicious),
            `info-message should mention the YAML format verbatim. Got: ${blocker.message}`,
        );

        // The copyCommand is what gets shipped to the clipboard. The
        // exact escaping comes from `escapeRString` in r-expression.ts:
        // every `\` doubles, every `'` becomes `\'`. The literal `'); system(`
        // does appear as the substring `\'); system(\'` — properly escaped
        // inside the R single-quoted literal — so the injection-safety
        // property to assert is the FULL escaped form, not the absence of
        // the dangerous substring.
        const cp = blocker.copyCommand;
        const expectedFull =
            "rmarkdown::render('FILENAME', output_format = " +
            "'evil\\'); system(\\'rm -rf ~\\'); #\\\\'" +
            ")";
        assert.strictEqual(
            cp,
            expectedFull,
            `copyCommand should escape every \` and ' in the format value`,
        );
    });

    test('buildNonHtmlFormatBlocker round-trips ordinary formats unchanged', () => {
        const blocker = buildNonHtmlFormatBlocker('pdf_document');
        assert.strictEqual(
            blocker.copyCommand,
            "rmarkdown::render('FILENAME', output_format = 'pdf_document')",
        );
    });

    test('default html_document (no YAML output:) is not gated', async () => {
        await activate();

        const docUri = await writeTempRmd('plain.Rmd', 'title: "Plain"');

        const inFlight = new Set<string>();
        const output = vscode.window.createOutputChannel('Knit Test');

        // Stub the info-message channel so an unexpected refusal
        // doesn't stall the test. If the gate misfires we'll see
        // surfacedMessage set instead of runKnitCalled.
        const origShow = vscode.window.showInformationMessage;
        let surfacedMessage: string | undefined;
        (vscode.window as { showInformationMessage: unknown }).showInformationMessage = ((
            message: string,
            ..._rest: unknown[]
        ): Thenable<string | undefined> => {
            surfacedMessage = message;
            return Promise.resolve(undefined);
        }) as typeof vscode.window.showInformationMessage;

        const fakeContext = { subscriptions: [] } as unknown as vscode.ExtensionContext;
        let runKnitCalled = false;
        const deps: KnitDeps = {
            runKnit: (async () => {
                runKnitCalled = true;
                return {
                    spawnError: null,
                    cancelled: false,
                    timedOut: false,
                    exitCode: 0,
                    // A bogus HTML path so the success path tries to open
                    // the panel; we stub showOrUpdatePanel below so it
                    // doesn't actually touch the file system.
                    stdout: `Output created: ${docUri.fsPath.replace(/\.Rmd$/, '.html')}\n`,
                    stderr: '',
                };
            }) as KnitDeps['runKnit'],
            showOrUpdatePanel: (async () => ({ ok: true })) as KnitDeps['showOrUpdatePanel'],
            getLanguageClient: () => undefined,
            runPostKnitRender: (async () => undefined) as KnitDeps['runPostKnitRender'],
        };

        try {
            await __runKnitCommandForTest({
                uri: docUri,
                output,
                inFlight,
                context: fakeContext,
                deps,
            });

            await sleep(50);

            assert.ok(
                runKnitCalled,
                `runKnit should be called for a plain Rmd with no output: field. ` +
                    `Surfaced info-message: ${JSON.stringify(surfacedMessage)}`,
            );
        } finally {
            (vscode.window as { showInformationMessage: unknown }).showInformationMessage = origShow;
            output.dispose();
            try {
                const fs = require('fs') as typeof import('fs');
                const p = require('path') as typeof import('path');
                fs.rmSync(p.dirname(docUri.fsPath), { recursive: true, force: true });
            } catch { /* ignore */ }
        }
    });
});
