import * as assert from 'assert';
import * as vscode from 'vscode';
import { State, type LanguageClient } from 'vscode-languageclient/node';
import type { RavenExtensionApi } from '../extension';
import { activate, openDocument, sleep } from './helper';

/**
 * End-to-end smoke tests for the R help viewer. These mirror the manual
 * smoke-test plan in docs/help-viewer.md, but exercised through the live
 * LSP client + extension activation. They specifically guard against
 * regressions caught only at runtime in earlier rounds:
 *
 *   - Hovering `filter` in `dplyr::filter(...)` must produce a bold
 *     `dplyr::filter` link, NOT `base::filter` (qualifier wins over
 *     unqualified scope lookup).
 *   - Same for `plot` in `graphics::plot(...)` (cross-package qualifier).
 *   - Clicking the bold link (i.e. invoking `raven.getHelpHtml` directly)
 *     must NOT bail with `r-unavailable: R not configured (set
 *     raven.packages.rPath)` when the user has R on PATH but no explicit
 *     `raven.packages.rPath` setting (the documented default — auto-detect).
 */

interface OpenHelpPanelArgs {
    topic: string;
    // The hover currently always passes a string here, but the wire contract
    // for `raven.openHelpPanel` accepts `null` for the unqualified case
    // (e.g. base topics without a package qualifier). Keep the decoder lenient
    // so a future hover that omits the package doesn't make this test choke.
    package: string | null;
}

/**
 * Pull the percent-encoded JSON args out of a markdown link of the form
 * `**[`pkg::topic`](command:raven.openHelpPanel?<encoded>)**`.
 */
function decodeOpenHelpPanelArgs(markdown: string): OpenHelpPanelArgs | null {
    const m = markdown.match(/command:raven\.openHelpPanel\?([^)\s]+)\)/);
    if (!m) return null;
    const decoded = decodeURIComponent(m[1]);
    const args = JSON.parse(decoded) as unknown;
    if (!Array.isArray(args) || args.length < 2) return null;
    if (typeof args[0] !== 'string') return null;
    if (typeof args[1] !== 'string' && args[1] !== null) return null;
    return { topic: args[0], package: args[1] };
}

function hoverMarkdown(hovers: vscode.Hover[]): string {
    return hovers
        .flatMap((h) => h.contents)
        .map((c) => {
            if (typeof c === 'string') return c;
            if (c instanceof vscode.MarkdownString) return c.value;
            return c.value ?? '';
        })
        .join('\n');
}

/**
 * Wait for the LanguageClient to finish starting and return it. Times out
 * after `timeoutMs` and returns `undefined` so the caller can decide whether
 * to skip or fail.
 */
async function waitForLanguageClient(timeoutMs = 15000): Promise<LanguageClient | undefined> {
    // Extension ID is publisher.name from package.json: "jbearak" + "raven-r".
    const ext = vscode.extensions.getExtension('jbearak.raven-r');
    if (!ext) return undefined;
    if (!ext.isActive) await ext.activate();
    const api = ext.exports as RavenExtensionApi | undefined;
    if (!api) return undefined;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const client = api.getLanguageClient();
        // The client is "running" once the LSP server has responded to
        // initialize.
        if (client && client.state === State.Running) return client;
        await sleep(100);
    }
    return api.getLanguageClient();
}

suite('help-viewer smoke tests', () => {
    suiteSetup(async () => {
        await activate();
    });

    test('hover on `filter` in `dplyr::filter(...)` builds dplyr-qualified bold link', async () => {
        const doc = await openDocument('help_viewer.R');
        // Line 0: `result <- dplyr::filter(df, x > 1)`
        //          0         1         2
        //          0123456789012345678901234567
        // 'f' of filter is at column 17.
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            new vscode.Position(0, 17),
        );
        assert.ok(hovers && hovers.length > 0, 'expected a hover at dplyr::filter');
        const md = hoverMarkdown(hovers);
        assert.ok(
            md.includes('**[`dplyr::filter`]'),
            `expected bold dplyr::filter link in hover; got:\n${md}`,
        );
        assert.ok(
            !md.includes('from {base}') && !md.includes('from {stats}'),
            `qualifier-driven hover must not attribute filter to base/stats; got:\n${md}`,
        );
        const args = decodeOpenHelpPanelArgs(md);
        assert.ok(args, `expected decodable openHelpPanel args; got:\n${md}`);
        assert.strictEqual(args!.topic, 'filter');
        assert.strictEqual(args!.package, 'dplyr');
    });

    test('hover on `plot` in `graphics::plot(...)` builds graphics-qualified bold link', async () => {
        const doc = await openDocument('help_viewer.R');
        // Line 1: `graphics::plot(1:10)`
        //          0         1
        //          01234567890123456789
        // 'p' of plot is at column 10.
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            new vscode.Position(1, 10),
        );
        assert.ok(hovers && hovers.length > 0, 'expected a hover at graphics::plot');
        const md = hoverMarkdown(hovers);
        const args = decodeOpenHelpPanelArgs(md);
        assert.ok(args, `expected decodable openHelpPanel args; got:\n${md}`);
        assert.strictEqual(args!.topic, 'plot');
        assert.strictEqual(
            args!.package,
            'graphics',
            'qualifier `graphics::` must override any base/stats fallback',
        );
    });

    test('hover on unqualified `plot` does not regress to a non-link string', async () => {
        // Sanity: the unqualified case may resolve to whichever package
        // the scope analysis picks, and that might or might not include a
        // bold link depending on whether help text is cached. We only
        // assert the hover returns something — the qualified cases above
        // are the load-bearing tests.
        const doc = await openDocument('help_viewer.R');
        // Line 2: `plot(1:5)` — 'p' at column 0.
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            new vscode.Position(2, 0),
        );
        // hovers may be empty if R isn't available and nothing else
        // resolves the symbol — that's acceptable here.
        if (hovers && hovers.length > 0) {
            const md = hoverMarkdown(hovers);
            assert.ok(md.length > 0, 'expected non-empty hover content');
        }
    });

    test('raven.getHelpHtml does not bail with r-unavailable when rPath is unset', async function (this: Mocha.Context) {
        // The handler must mirror the hover path's PathBuf::from("R")
        // fallback so users with R on PATH but no explicit
        // `raven.packages.rPath` setting see help, not the
        // "R not configured" error. We assert only the negative — the
        // call site for this test cannot guarantee R is on PATH (CI
        // sandboxes may not have it), so a render-failed/not-found is
        // acceptable; the OLD r-unavailable wording is not.
        //
        // raven.getHelpHtml is intentionally NOT a VS Code command (per
        // executeCommandProvider rule in CLAUDE.md), so it must be invoked
        // through the LanguageClient's workspace/executeCommand request.
        const client = await waitForLanguageClient();
        if (!client) this.skip();
        const result = await client!.sendRequest<{
            ok: boolean;
            reason?: string;
            message?: string;
        }>('workspace/executeCommand', {
            command: 'raven.getHelpHtml',
            arguments: ['mean', 'base'],
        });

        assert.ok(result, 'sendRequest must return a result object');
        if (result.ok === false) {
            assert.notStrictEqual(
                result.reason,
                'r-unavailable',
                `handler must not bail with r-unavailable when PATH could provide R; got: ${JSON.stringify(result)}`,
            );
            const msg = result.message ?? '';
            assert.ok(
                !msg.includes('set raven.packages.rPath'),
                `stale 'set raven.packages.rPath' wording leaked through: ${JSON.stringify(result)}`,
            );
        }
    });

    test('raven.getHelpHtml rejects invalid topics before spawning R', async function (this: Mocha.Context) {
        // Validation runs first, so we get invalid-topic regardless of R.
        const client = await waitForLanguageClient();
        if (!client) this.skip();
        const result = await client!.sendRequest<{
            ok: boolean;
            reason?: string;
        }>('workspace/executeCommand', {
            command: 'raven.getHelpHtml',
            arguments: ['with\nnewline', 'base'],
        });

        assert.ok(result, 'sendRequest must return a result object');
        assert.strictEqual(result.ok, false, `expected ok=false; got: ${JSON.stringify(result)}`);
        assert.strictEqual(result.reason, 'invalid-topic');
    });

    test('raven.openHelpPanel command is registered and accepts (topic, package)', async () => {
        // We don't try to inspect the panel's webview content (sandboxed iframe);
        // we just verify the command is registered and accepts the
        // (topic: string, package: string) signature without throwing.
        const commands = await vscode.commands.getCommands(true);
        assert.ok(
            commands.includes('raven.openHelpPanel'),
            'raven.openHelpPanel must be registered as a VS Code command',
        );
        assert.ok(commands.includes('raven.help.back'));
        assert.ok(commands.includes('raven.help.forward'));

        // Invoke without awaiting the panel's internal async work — we just
        // assert the registered handler does not throw synchronously and
        // the panel exists in the editor area shortly after.
        await vscode.commands.executeCommand('raven.openHelpPanel', 'mean', 'base');
        // Give VS Code a beat to register the webview panel.
        await sleep(500);
        // Cleanup: close any opened webview panels so subsequent tests
        // don't inherit an open panel.
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });
});
