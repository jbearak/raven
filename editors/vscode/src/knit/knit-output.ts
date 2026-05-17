import * as path from 'path';
import { parseRenderedOutputPath } from './output-path';

export type KnitOutputMessage =
    | { type: 'refresh' }
    | { type: 'openInBrowser' };

/**
 * Strict type-narrowing for messages posted from the Knit Output webview.
 * The webview is a trust boundary; reject anything we did not explicitly
 * shape. Additional unknown properties on a recognized type are allowed
 * (the handler ignores them).
 */
export function isKnitOutputMessage(msg: unknown): msg is KnitOutputMessage {
    if (msg === null || typeof msg !== 'object') return false;
    const t = (msg as { type?: unknown }).type;
    return t === 'refresh' || t === 'openInBrowser';
}

/**
 * Possible outcomes of a single `runKnit` invocation, after we have
 * classified the raw engine result. Discriminated by `kind`. No user-
 * facing toasts or webview operations have been performed yet — that
 * happens in `renderOutcome`, OUTSIDE the `withProgress` callback. This
 * is the core of the Piece A bug fix: keeping the `withProgress`
 * lifecycle short and predictable.
 */
export type KnitOutcome =
    | { kind: 'spawnError'; error: NodeJS.ErrnoException }
    | { kind: 'cancelled' }
    | { kind: 'timedOut'; timeoutMs?: number }
    | { kind: 'failed'; exitCode: number | null }
    | { kind: 'noOutput' }
    | { kind: 'ok'; parsedOutputs: string[]; cwd: string | undefined };

/** Minimal subset of `runKnit`'s return value classify needs. */
export interface ClassifyInput {
    spawnError: NodeJS.ErrnoException | null;
    cancelled: boolean;
    timedOut: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
}

/**
 * Pure classifier mapping the engine's raw result onto a KnitOutcome.
 * Branch priority mirrors the original runKnitCommand:
 *   spawnError > cancelled > timedOut > failed > noOutput / ok
 */
export function classify(
    result: ClassifyInput,
    ctx: { cwd: string | undefined },
): KnitOutcome {
    if (result.spawnError) return { kind: 'spawnError', error: result.spawnError };
    if (result.cancelled) return { kind: 'cancelled' };
    if (result.timedOut) return { kind: 'timedOut' };
    if (result.exitCode !== 0) return { kind: 'failed', exitCode: result.exitCode };
    const parsed = parseRenderedOutputPath(result.stdout + '\n' + result.stderr).paths;
    if (parsed.length === 0) return { kind: 'noOutput' };
    return { kind: 'ok', parsedOutputs: parsed, cwd: ctx.cwd };
}

/**
 * Minimal vscode.Webview shape buildShellHtml needs. Defined inline so
 * the pure helper has no dependency on the actual vscode module — tests
 * pass a fake.
 */
function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Build the outer-shell HTML for the Knit Output webview.
 *
 * The shell is Raven-controlled and owns the CSP in `<head>`; the
 * rendered HTML loads inside `<iframe sandbox="">`. Three independent
 * containment layers (sandbox attribute, outer-shell CSP,
 * `localResourceRoots`) make the security model robust to either layer
 * failing.
 *
 * Pure helper — no dependency on the vscode module. The caller
 * (`KnitOutputPanel`) is responsible for converting the output path via
 * `webview.asWebviewUri(vscode.Uri.file(...))` and passing the result
 * here as `iframeSrc`, and for forwarding `webview.cspSource`.
 *
 * See `docs/superpowers/specs/2026-05-17-knit-output-webview-design.md`
 * for the threat model.
 */
export function buildShellHtml(args: {
    iframeSrc: string;
    cspSource: string;
    outputPath: string;
    nonce: string;
}): string {
    const { iframeSrc, cspSource, outputPath, nonce } = args;
    // path.basename handles both POSIX and Windows separators.
    const lastSep = Math.max(outputPath.lastIndexOf('/'), outputPath.lastIndexOf('\\'));
    const basename = lastSep >= 0 ? outputPath.slice(lastSep + 1) : outputPath;
    const safeName = escapeHtml(basename);

    const csp = [
        `default-src 'none'`,
        `frame-src ${cspSource}`,
        `img-src ${cspSource} https: data:`,
        `style-src ${cspSource} 'unsafe-inline'`,
        `font-src ${cspSource} https: data:`,
        `script-src 'nonce-${nonce}'`,
        `connect-src 'none'`,
    ].join('; ');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Knit Output</title>
<style nonce="${nonce}">
  body { margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column;
         font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  #raven-knit-toolbar { display: flex; gap: 0.5rem; align-items: center;
                        padding: 0.4rem 0.75rem;
                        background: var(--vscode-editorWidget-background);
                        border-bottom: 1px solid var(--vscode-editorWidget-border);
                        flex: 0 0 auto; }
  #raven-knit-toolbar button { font: inherit; padding: 0.2rem 0.6rem;
                               background: var(--vscode-button-background);
                               color: var(--vscode-button-foreground);
                               border: 1px solid var(--vscode-button-border, transparent);
                               cursor: pointer; }
  #raven-knit-toolbar button:hover { background: var(--vscode-button-hoverBackground); }
  #raven-knit-filename { margin-left: 0.5rem; opacity: 0.8; font-size: 0.9em; }
  #raven-knit-frame { flex: 1 1 auto; width: 100%; border: 0; background: white; }
</style>
</head>
<body>
  <div id="raven-knit-toolbar" role="toolbar" aria-label="Knit output">
    <button id="raven-knit-refresh" type="button" title="Re-knit the source document">Refresh</button>
    <button id="raven-knit-open-browser" type="button" title="Open the rendered file in your default browser">Open in Browser</button>
    <span id="raven-knit-filename" aria-live="polite">${safeName}</span>
  </div>
  <iframe id="raven-knit-frame"
          src="${escapeHtml(iframeSrc)}"
          sandbox=""
          referrerpolicy="no-referrer"
          title="Rendered output: ${safeName}"></iframe>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      document.getElementById('raven-knit-refresh').addEventListener('click', function () {
        vscode.postMessage({ type: 'refresh' });
      });
      document.getElementById('raven-knit-open-browser').addEventListener('click', function () {
        vscode.postMessage({ type: 'openInBrowser' });
      });
    })();
  </script>
</body>
</html>`;
}

/**
 * Pick the output path to surface in the Knit Output panel.
 *
 * When `output_format = "all"` (or a custom multi-format render) produces
 * a mix of formats, the user almost always wants the HTML viewer rather
 * than e.g. revealing a PDF in the file browser. Prefer the first HTML
 * output; fall back to the first entry overall.
 *
 * Codex adversarial review #4 on the v1 spec called out that v1 always
 * used `parsed.paths[0]`, which would hide an HTML output behind a
 * PDF/DOCX-first reveal.
 */
export function pickPrimaryOutput(paths: readonly string[]): string | undefined {
    if (paths.length === 0) return undefined;
    const html = paths.find((p) => {
        const ext = path.extname(p).toLowerCase();
        return ext === '.html' || ext === '.htm';
    });
    return html ?? paths[0];
}
