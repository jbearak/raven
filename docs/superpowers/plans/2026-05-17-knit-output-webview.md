# Knit Output Webview + Progress-Lifecycle Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the stuck "Knitting …" progress notification (which also causes the spurious "already being knitted" gate), and add an iframe-sandbox webview that renders HTML knit output with **Refresh** and **Open in Browser** toolbar buttons.

**Architecture:** Two pieces. (A) Refactor `runKnitCommand` so `withProgress` returns a discriminated `KnitOutcome` and all user-facing toasts run *after* the progress callback resolves; add a `deps` injection seam for tests. (B) New `KnitOutputPanel` module: a singleton webview whose outer document is a Raven-controlled shell (CSP in `<head>`, toolbar, nonce'd script) hosting an `<iframe sandbox="">` whose `src` is `webview.asWebviewUri(outputPath)`. No HTML parsing or rewriting; security enforced by three independent layers (sandbox attribute, outer-shell CSP, `localResourceRoots`).

**Tech Stack:** TypeScript, VS Code Extension API (`vscode.window.createWebviewPanel`, `webview.asWebviewUri`, `vscode.env.openExternal`), Bun for unit tests, Mocha + `@vscode/test-electron` for integration tests.

**Spec:** `docs/superpowers/specs/2026-05-17-knit-output-webview-design.md` (v2, commit `34e8a47`).

---

## File map

| Path | Action | Responsibility |
| -- | -- | -- |
| `editors/vscode/src/knit/knit-commands.ts` | Modify | Refactor `runKnitCommand`: classify → withProgress → renderOutcome. Add `deps` seam. Wire HTML success to `KnitOutputPanel.showOrUpdate`. |
| `editors/vscode/src/knit/knit-output.ts` | Create | Pure helpers: `KnitOutcome`, `classify`, `pickPrimaryOutput`, `isKnitOutputMessage`, `buildShellHtml`. |
| `editors/vscode/src/knit/knit-output-panel.ts` | Create | `KnitOutputPanel` singleton class; `openInBrowser` helper. |
| `tests/bun/knit-output-pick-primary.test.ts` | Create | Bun unit tests for `pickPrimaryOutput`. |
| `tests/bun/knit-output-message.test.ts` | Create | Bun unit tests for `isKnitOutputMessage`. |
| `tests/bun/knit-output-classify.test.ts` | Create | Bun unit tests for `classify`. |
| `tests/bun/knit-output-shell.test.ts` | Create | Bun unit tests for `buildShellHtml` (CSP-in-head, sandbox, escaping, asWebviewUri). |
| `editors/vscode/src/test/knit-progress-lifecycle.test.ts` | Create | Mocha integration test for Piece A (inFlight cleared before toast). |
| `editors/vscode/src/test/knit-output-panel.test.ts` | Create | Mocha integration test: refresh roundtrip, openInBrowser roundtrip, singleton reuse, rootDir-change recreation. |
| `editors/vscode/src/test/fixtures/sample.Rmd` | Create | Minimal `.Rmd` fixture used by integration tests (no R subprocess actually invoked). |
| `docs/knit.md` | Modify | Update step 10 (Reveal); document iframe-sandbox limitations (external links). |

`editors/vscode/src/knit/index.ts` stays unchanged.

`editors/vscode/src/knit/knit-engine.ts` stays unchanged.

`editors/vscode/package.json` stays unchanged (no new commands or settings).

---

## Phase 1 — Pure helpers (TDD via Bun)

Each task: write the failing test, run it to confirm failure, write the minimal implementation, run to confirm pass, commit.

### Task 1.1: `pickPrimaryOutput`

**Files:**
- Create: `editors/vscode/src/knit/knit-output.ts`
- Create: `tests/bun/knit-output-pick-primary.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/bun/knit-output-pick-primary.test.ts`:

```ts
import { describe, test, expect } from 'bun:test';
import { pickPrimaryOutput } from '../../editors/vscode/src/knit/knit-output';

describe('pickPrimaryOutput', () => {
    test('returns the only entry when there is one', () => {
        expect(pickPrimaryOutput(['/a/foo.html'])).toBe('/a/foo.html');
    });

    test('prefers .html when present mid-list', () => {
        expect(pickPrimaryOutput(['/a/foo.pdf', '/a/foo.html', '/a/foo.docx']))
            .toBe('/a/foo.html');
    });

    test('prefers .htm when no .html', () => {
        expect(pickPrimaryOutput(['/a/foo.pdf', '/a/foo.htm'])).toBe('/a/foo.htm');
    });

    test('returns the first when no HTML is present', () => {
        expect(pickPrimaryOutput(['/a/foo.pdf', '/a/foo.docx'])).toBe('/a/foo.pdf');
    });

    test('case-insensitive extension match', () => {
        expect(pickPrimaryOutput(['/a/foo.PDF', '/a/foo.HTML'])).toBe('/a/foo.HTML');
    });

    test('returns undefined for an empty list', () => {
        expect(pickPrimaryOutput([])).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
bun test tests/bun/knit-output-pick-primary.test.ts
```

Expected: FAIL with `Cannot find module '../../editors/vscode/src/knit/knit-output'` (the module doesn't exist yet).

- [ ] **Step 3: Create the module with the minimal implementation**

Create `editors/vscode/src/knit/knit-output.ts`:

```ts
import * as path from 'path';

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
```

- [ ] **Step 4: Run the test to confirm pass**

```bash
bun test tests/bun/knit-output-pick-primary.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/src/knit/knit-output.ts tests/bun/knit-output-pick-primary.test.ts
git commit -m "feat(knit): pickPrimaryOutput prefers HTML in multi-output renders"
```

---

### Task 1.2: `isKnitOutputMessage`

**Files:**
- Modify: `editors/vscode/src/knit/knit-output.ts` (append)
- Create: `tests/bun/knit-output-message.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/bun/knit-output-message.test.ts`:

```ts
import { describe, test, expect } from 'bun:test';
import { isKnitOutputMessage } from '../../editors/vscode/src/knit/knit-output';

describe('isKnitOutputMessage', () => {
    test('accepts {type: "refresh"}', () => {
        expect(isKnitOutputMessage({ type: 'refresh' })).toBe(true);
    });

    test('accepts {type: "openInBrowser"}', () => {
        expect(isKnitOutputMessage({ type: 'openInBrowser' })).toBe(true);
    });

    test('rejects unknown type', () => {
        expect(isKnitOutputMessage({ type: 'evil' })).toBe(false);
    });

    test('rejects null', () => {
        expect(isKnitOutputMessage(null)).toBe(false);
    });

    test('rejects undefined', () => {
        expect(isKnitOutputMessage(undefined)).toBe(false);
    });

    test('rejects primitives', () => {
        expect(isKnitOutputMessage('refresh')).toBe(false);
        expect(isKnitOutputMessage(42)).toBe(false);
    });

    test('rejects empty object', () => {
        expect(isKnitOutputMessage({})).toBe(false);
    });

    test('rejects object missing the type key', () => {
        expect(isKnitOutputMessage({ kind: 'refresh' })).toBe(false);
    });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
bun test tests/bun/knit-output-message.test.ts
```

Expected: FAIL — `isKnitOutputMessage` is not exported.

- [ ] **Step 3: Append the implementation to `knit-output.ts`**

Add to `editors/vscode/src/knit/knit-output.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to confirm pass**

```bash
bun test tests/bun/knit-output-message.test.ts
```

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/src/knit/knit-output.ts tests/bun/knit-output-message.test.ts
git commit -m "feat(knit): isKnitOutputMessage type guard for webview→extension messages"
```

---

### Task 1.3: `KnitOutcome` + `classify`

**Files:**
- Modify: `editors/vscode/src/knit/knit-output.ts` (append)
- Create: `tests/bun/knit-output-classify.test.ts`

- [ ] **Step 1: Inspect the current `runKnit` return shape**

Run:

```bash
grep -nE "interface|^export|spawnError|cancelled|timedOut|exitCode" editors/vscode/src/knit/knit-engine.ts
```

Confirm the `runKnit` result type has fields `{ spawnError, cancelled, timedOut, exitCode, stdout, stderr }`. (The plan below assumes these; if the field names differ, mirror the actual names.)

- [ ] **Step 2: Write the failing test**

Create `tests/bun/knit-output-classify.test.ts`:

```ts
import { describe, test, expect } from 'bun:test';
import { classify } from '../../editors/vscode/src/knit/knit-output';

describe('classify', () => {
    test('spawn error wins over everything', () => {
        const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        const outcome = classify({
            spawnError: err,
            cancelled: false,
            timedOut: false,
            exitCode: null,
            stdout: '',
            stderr: '',
        }, { cwd: '/wd' });
        expect(outcome.kind).toBe('spawnError');
    });

    test('cancelled beats timedOut and failure', () => {
        const outcome = classify({
            spawnError: undefined,
            cancelled: true,
            timedOut: false,
            exitCode: 130,
            stdout: '',
            stderr: '',
        }, { cwd: '/wd' });
        expect(outcome.kind).toBe('cancelled');
    });

    test('timedOut beats failure', () => {
        const outcome = classify({
            spawnError: undefined,
            cancelled: false,
            timedOut: true,
            exitCode: null,
            stdout: '',
            stderr: '',
        }, { cwd: '/wd' });
        expect(outcome.kind).toBe('timedOut');
    });

    test('non-zero exit is "failed"', () => {
        const outcome = classify({
            spawnError: undefined,
            cancelled: false,
            timedOut: false,
            exitCode: 1,
            stdout: '',
            stderr: '',
        }, { cwd: '/wd' });
        expect(outcome.kind).toBe('failed');
        if (outcome.kind === 'failed') expect(outcome.exitCode).toBe(1);
    });

    test('clean exit with no output path is "noOutput"', () => {
        const outcome = classify({
            spawnError: undefined,
            cancelled: false,
            timedOut: false,
            exitCode: 0,
            stdout: '\n',
            stderr: '',
        }, { cwd: '/wd' });
        expect(outcome.kind).toBe('noOutput');
    });

    test('clean exit with output path is "ok"', () => {
        const outcome = classify({
            spawnError: undefined,
            cancelled: false,
            timedOut: false,
            exitCode: 0,
            stdout: 'Output created: out.html\n',
            stderr: '',
        }, { cwd: '/wd' });
        expect(outcome.kind).toBe('ok');
        if (outcome.kind === 'ok') {
            expect(outcome.parsedOutputs).toEqual(['out.html']);
            expect(outcome.cwd).toBe('/wd');
        }
    });

    test('cwd undefined propagates through ok outcome', () => {
        const outcome = classify({
            spawnError: undefined,
            cancelled: false,
            timedOut: false,
            exitCode: 0,
            stdout: 'Output created: out.html\n',
            stderr: '',
        }, { cwd: undefined });
        expect(outcome.kind).toBe('ok');
        if (outcome.kind === 'ok') expect(outcome.cwd).toBeUndefined();
    });
});
```

- [ ] **Step 3: Run the test to confirm it fails**

```bash
bun test tests/bun/knit-output-classify.test.ts
```

Expected: FAIL — `classify` not exported.

- [ ] **Step 4: Append the implementation to `knit-output.ts`**

Add to `editors/vscode/src/knit/knit-output.ts`:

```ts
import { parseRenderedOutputPath } from './output-path';

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
    spawnError?: NodeJS.ErrnoException;
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
```

- [ ] **Step 5: Run the test to confirm pass**

```bash
bun test tests/bun/knit-output-classify.test.ts
```

Expected: all 7 tests pass.

- [ ] **Step 6: Commit**

```bash
git add editors/vscode/src/knit/knit-output.ts tests/bun/knit-output-classify.test.ts
git commit -m "feat(knit): classify pure helper produces KnitOutcome discriminated union"
```

---

## Phase 2 — Outer-shell HTML builder

### Task 2.1: `buildShellHtml`

**Files:**
- Modify: `editors/vscode/src/knit/knit-output.ts` (append)
- Create: `tests/bun/knit-output-shell.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/bun/knit-output-shell.test.ts`:

```ts
import { describe, test, expect } from 'bun:test';
import { buildShellHtml } from '../../editors/vscode/src/knit/knit-output';

const fakeWebview = {
    asWebviewUri: (uri: { fsPath: string }) =>
        `https://webview.test${uri.fsPath}`,
    cspSource: 'https://webview.test',
};

describe('buildShellHtml', () => {
    test('CSP <meta> appears in <head>, before <body>', () => {
        const html = buildShellHtml({
            webview: fakeWebview as any,
            outputPath: '/work/report.html',
            nonce: 'NONCE123',
        });
        const cspIdx = html.indexOf('Content-Security-Policy');
        const bodyIdx = html.indexOf('<body');
        expect(cspIdx).toBeGreaterThan(0);
        expect(bodyIdx).toBeGreaterThan(0);
        expect(cspIdx).toBeLessThan(bodyIdx);
    });

    test('CSP contains nonce, frame-src, no default-src loophole', () => {
        const html = buildShellHtml({
            webview: fakeWebview as any,
            outputPath: '/work/report.html',
            nonce: 'NONCE123',
        });
        expect(html).toContain("default-src 'none'");
        expect(html).toContain('frame-src https://webview.test');
        expect(html).toContain("script-src 'nonce-NONCE123'");
        expect(html).toContain("connect-src 'none'");
    });

    test('iframe src is asWebviewUri of the output path', () => {
        const html = buildShellHtml({
            webview: fakeWebview as any,
            outputPath: '/work/report.html',
            nonce: 'NONCE123',
        });
        expect(html).toContain('src="https://webview.test/work/report.html"');
    });

    test('iframe sandbox attribute is empty (most restrictive)', () => {
        const html = buildShellHtml({
            webview: fakeWebview as any,
            outputPath: '/work/report.html',
            nonce: 'NONCE123',
        });
        // Note: sandbox="" (empty string) is the strictest mode. Be exact.
        expect(html).toMatch(/<iframe\b[^>]*\bsandbox=""/);
    });

    test('toolbar contains refresh and open-in-browser buttons', () => {
        const html = buildShellHtml({
            webview: fakeWebview as any,
            outputPath: '/work/report.html',
            nonce: 'NONCE123',
        });
        expect(html).toContain('id="raven-knit-refresh"');
        expect(html).toContain('id="raven-knit-open-browser"');
    });

    test('filename is HTML-escaped', () => {
        const html = buildShellHtml({
            webview: fakeWebview as any,
            outputPath: '/work/<script>alert(1)</script>.html',
            nonce: 'NONCE123',
        });
        // The basename appears in the title attribute and the toolbar span.
        // Verify the raw "<script>" substring does NOT appear in the HTML.
        expect(html).not.toContain('<script>alert(1)</script>.html');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;.html');
    });

    test('toolbar script is nonce-tagged', () => {
        const html = buildShellHtml({
            webview: fakeWebview as any,
            outputPath: '/work/report.html',
            nonce: 'NONCE123',
        });
        expect(html).toMatch(/<script\s+nonce="NONCE123">/);
    });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
bun test tests/bun/knit-output-shell.test.ts
```

Expected: FAIL — `buildShellHtml` not exported.

- [ ] **Step 3: Append the implementation to `knit-output.ts`**

Add to `editors/vscode/src/knit/knit-output.ts`:

```ts
/**
 * Minimal vscode.Webview shape buildShellHtml needs. Defined inline so
 * the pure helper has no dependency on the actual vscode module — tests
 * pass a fake.
 */
export interface MinimalWebview {
    asWebviewUri(uri: { fsPath: string }): { toString(): string };
    cspSource: string;
}

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
 * rendered HTML loads inside `<iframe sandbox="">` from
 * `webview.asWebviewUri(outputPath)`. Three independent containment
 * layers (sandbox attribute, outer-shell CSP, localResourceRoots) make
 * the security model robust to either layer failing.
 *
 * See `docs/superpowers/specs/2026-05-17-knit-output-webview-design.md`
 * for the threat model.
 */
export function buildShellHtml(args: {
    webview: MinimalWebview;
    outputPath: string;
    nonce: string;
}): string {
    const { webview, outputPath, nonce } = args;
    const iframeSrc = webview.asWebviewUri({ fsPath: outputPath }).toString();
    // path.basename handles both POSIX and Windows separators.
    const lastSep = Math.max(outputPath.lastIndexOf('/'), outputPath.lastIndexOf('\\'));
    const basename = lastSep >= 0 ? outputPath.slice(lastSep + 1) : outputPath;
    const safeName = escapeHtml(basename);

    const csp = [
        `default-src 'none'`,
        `frame-src ${webview.cspSource}`,
        `img-src ${webview.cspSource} https: data:`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `font-src ${webview.cspSource} https: data:`,
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
```

- [ ] **Step 4: Run the test to confirm pass**

```bash
bun test tests/bun/knit-output-shell.test.ts
```

Expected: all 7 tests pass.

- [ ] **Step 5: Run all knit Bun tests to verify nothing else broke**

```bash
bun test tests/bun/knit-output-*.test.ts
```

Expected: all tests pass across the four files added so far.

- [ ] **Step 6: Commit**

```bash
git add editors/vscode/src/knit/knit-output.ts tests/bun/knit-output-shell.test.ts
git commit -m "feat(knit): buildShellHtml outer-shell with CSP in head and sandboxed iframe"
```

---

## Phase 3 — `KnitOutputPanel` singleton

### Task 3.1: Create the panel module

This module has direct vscode dependencies and is integration-tested in Mocha, not Bun. We write it after the pure helpers so the surface is small.

**Files:**
- Create: `editors/vscode/src/knit/knit-output-panel.ts`

- [ ] **Step 1: Create the file**

Create `editors/vscode/src/knit/knit-output-panel.ts`:

```ts
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildShellHtml, isKnitOutputMessage } from './knit-output';

/**
 * Singleton webview panel that renders the most recent HTML knit output
 * inside an `<iframe sandbox="">` with Refresh and Open-in-Browser
 * toolbar buttons.
 *
 * See `docs/superpowers/specs/2026-05-17-knit-output-webview-design.md`.
 *
 * Architecture:
 *  - Outer Raven-controlled shell document owns the CSP (in `<head>`),
 *    the toolbar, and a nonce'd `<script>` that posts messages.
 *  - Inner `<iframe>` loads the rendered HTML via
 *    `webview.asWebviewUri(outputPath)`. `sandbox=""` (empty, most
 *    restrictive) blocks scripts, forms, popups, and top-navigation.
 *    `frame-src ${cspSource}` on the outer CSP prevents iframe
 *    navigation to external hosts.
 *  - `localResourceRoots` is confined to `path.dirname(outputPath)`,
 *    which is also where rmarkdown's `_files/` figure directories sit.
 *
 * Singleton: one panel per VS Code window. Subsequent knits replace the
 * iframe `src`. If the new output's `rootDir` differs, the panel is
 * disposed and recreated (VS Code does not allow updating
 * `localResourceRoots` post-creation — see `help-panel.ts:284`).
 */
export class KnitOutputPanel {
    private static instance: KnitOutputPanel | undefined;

    private panel: vscode.WebviewPanel;
    private rootDir: string;
    private sourceUri: vscode.Uri;
    private outputPath: string;
    private readonly output: vscode.OutputChannel;

    /**
     * Open or update the singleton panel. Returns `{ ok: true }` on
     * success, `{ ok: false, error }` if the rendered file cannot be
     * accessed (caller should fall back to `revealFileInOS`).
     */
    static async showOrUpdate(
        context: vscode.ExtensionContext,
        args: {
            sourceUri: vscode.Uri;
            outputPath: string;
            output: vscode.OutputChannel;
        },
    ): Promise<{ ok: true } | { ok: false; error: string }> {
        try {
            await fs.promises.access(args.outputPath, fs.constants.R_OK);
        } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }

        const rootDir = path.dirname(args.outputPath);
        const existing = KnitOutputPanel.instance;

        if (existing && existing.rootDir === rootDir) {
            existing.updateContent({ sourceUri: args.sourceUri, outputPath: args.outputPath });
            existing.panel.reveal(existing.panel.viewColumn ?? vscode.ViewColumn.Beside, true);
            return { ok: true };
        }

        if (existing) {
            // localResourceRoots is immutable after panel creation — dispose
            // and recreate in the same column. Same workaround as help-panel.
            const column = existing.panel.viewColumn ?? vscode.ViewColumn.Beside;
            existing.panel.dispose();
            // panel.dispose() fires onDidDispose, which clears `instance`.
            const created = KnitOutputPanel.create(context, args, rootDir, column);
            return { ok: true };
        }

        KnitOutputPanel.create(context, args, rootDir, vscode.ViewColumn.Beside);
        return { ok: true };
    }

    /** Visible only for tests. */
    static getInstanceForTesting(): KnitOutputPanel | undefined {
        return KnitOutputPanel.instance;
    }

    /** Visible only for tests — destroys the singleton. */
    static disposeForTesting(): void {
        KnitOutputPanel.instance?.panel.dispose();
    }

    private static create(
        context: vscode.ExtensionContext,
        args: {
            sourceUri: vscode.Uri;
            outputPath: string;
            output: vscode.OutputChannel;
        },
        rootDir: string,
        column: vscode.ViewColumn,
    ): KnitOutputPanel {
        const panel = vscode.window.createWebviewPanel(
            'raven.knitOutput',
            'Knit Output',
            { viewColumn: column, preserveFocus: true },
            {
                enableScripts: true,
                enableFindWidget: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.file(rootDir)],
            },
        );
        const instance = new KnitOutputPanel(context, panel, rootDir, args);
        KnitOutputPanel.instance = instance;
        instance.updateContent({ sourceUri: args.sourceUri, outputPath: args.outputPath });
        return instance;
    }

    private constructor(
        private readonly context: vscode.ExtensionContext,
        panel: vscode.WebviewPanel,
        rootDir: string,
        args: {
            sourceUri: vscode.Uri;
            outputPath: string;
            output: vscode.OutputChannel;
        },
    ) {
        this.panel = panel;
        this.rootDir = rootDir;
        this.sourceUri = args.sourceUri;
        this.outputPath = args.outputPath;
        this.output = args.output;

        this.panel.webview.onDidReceiveMessage((msg: unknown) => this.handleMessage(msg));
        this.panel.onDidDispose(() => {
            if (KnitOutputPanel.instance === this) {
                KnitOutputPanel.instance = undefined;
            }
        });
    }

    private updateContent(args: { sourceUri: vscode.Uri; outputPath: string }): void {
        this.sourceUri = args.sourceUri;
        this.outputPath = args.outputPath;
        const nonce = crypto.randomBytes(16).toString('base64');
        this.panel.webview.html = buildShellHtml({
            webview: this.panel.webview,
            outputPath: args.outputPath,
            nonce,
        });
        this.panel.title = `Knit Output: ${path.basename(args.outputPath)}`;
    }

    private handleMessage(msg: unknown): void {
        if (!isKnitOutputMessage(msg)) return;
        if (msg.type === 'refresh') {
            void vscode.commands.executeCommand('raven.knit', this.sourceUri);
            return;
        }
        if (msg.type === 'openInBrowser') {
            void openInBrowser(this.outputPath, this.output);
        }
    }
}

/**
 * Open the rendered file via the user's OS default browser.
 *
 * In local workspaces this opens the configured handler for `file:` (a
 * browser, typically). In remote workspaces, `openExternal(file:)` may
 * route the request to the extension-host machine — i.e. the remote
 * server, not where the user is sitting. When `openExternal` returns
 * false we write the path to the Knit output channel and warn the user.
 */
export async function openInBrowser(
    outputPath: string,
    output: vscode.OutputChannel,
): Promise<void> {
    const uri = vscode.Uri.file(outputPath);
    let opened = false;
    try {
        opened = await vscode.env.openExternal(uri);
    } catch (err) {
        output.appendLine(`[Open in Browser] openExternal threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (opened) return;
    output.appendLine(`[Open in Browser] file:// did not open. Rendered output is at: ${outputPath}`);
    void vscode.window.showWarningMessage(
        'Open in Browser is not available for this workspace. The rendered file path has been written to the Raven: Knit output channel.',
    );
}
```

- [ ] **Step 2: Compile-check**

```bash
cd editors/vscode && bun run compile:test
```

Expected: clean TypeScript compile with no errors.

- [ ] **Step 3: Run the existing Bun suite to confirm no regressions**

```bash
bun test tests/bun/knit-output-*.test.ts
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add editors/vscode/src/knit/knit-output-panel.ts
git commit -m "feat(knit): KnitOutputPanel singleton with iframe-sandbox shell"
```

---

## Phase 4 — Progress-lifecycle fix in `knit-commands.ts`

This is Piece A. The refactor splits the monolithic `runKnitCommand` into three phases: `withProgress` callback returns a `KnitOutcome`; then `inFlight.delete(fsPath)` runs in the `finally`; then `renderOutcome` does all UI work.

### Task 4.1: Add the `deps` injection seam and `renderOutcome` helper

**Files:**
- Modify: `editors/vscode/src/knit/knit-commands.ts`

- [ ] **Step 1: Read the current file**

```bash
wc -l editors/vscode/src/knit/knit-commands.ts
```

Expected: ~429 lines.

- [ ] **Step 2: Refactor**

Apply these targeted edits to `editors/vscode/src/knit/knit-commands.ts`:

1. **Imports** — add at the top, after the existing `runKnit` import:

```ts
import { KnitOutputPanel } from './knit-output-panel';
import {
    classify,
    pickPrimaryOutput,
    type KnitOutcome,
} from './knit-output';
```

2. **DI seam type and signature** — replace the top of `registerKnitCommands`:

Find:

```ts
export function registerKnitCommands(context: vscode.ExtensionContext): void {
```

Replace with:

```ts
/**
 * Resolved dependency surface used throughout the knit command. The
 * fields are required at the point of use; the public optional shape
 * (`Partial<KnitDeps>` parameter on `registerKnitCommands`) lets tests
 * override individual functions while production omits the parameter
 * entirely.
 */
export interface KnitDeps {
    runKnit: typeof runKnit;
    showOrUpdatePanel: typeof KnitOutputPanel.showOrUpdate;
}

export function registerKnitCommands(
    context: vscode.ExtensionContext,
    deps?: Partial<KnitDeps>,
): void {
    const resolved: KnitDeps = {
        runKnit: deps?.runKnit ?? runKnit,
        showOrUpdatePanel: deps?.showOrUpdatePanel ?? KnitOutputPanel.showOrUpdate,
    };
```

3. **Pass deps through** — find:

```ts
        vscode.commands.registerCommand(
            'raven.knit',
            async (uri?: vscode.Uri) => {
                await runKnitCommand(uri, getOutput(), inFlight);
            },
        ),
```

Replace with:

```ts
        vscode.commands.registerCommand(
            'raven.knit',
            async (uri?: vscode.Uri) => {
                await runKnitCommand(uri, getOutput(), inFlight, context, resolved);
            },
        ),
```

4. **Update `runKnitCommand` signature**:

Find:

```ts
async function runKnitCommand(
    explicitUri: vscode.Uri | undefined,
    output: vscode.OutputChannel,
    inFlight: Set<string>,
): Promise<void> {
```

Replace with:

```ts
async function runKnitCommand(
    explicitUri: vscode.Uri | undefined,
    output: vscode.OutputChannel,
    inFlight: Set<string>,
    context: vscode.ExtensionContext,
    deps: KnitDeps,
): Promise<void> {
```

5. **Replace the `withProgress` block** — this is the critical lifecycle fix.

Find the existing block starting at `output.appendLine(`---`);` through the end of the `try` ... `finally` ... `inFlight.delete(fsPath);` (currently approximately lines 210–311). Replace with:

```ts
    output.appendLine(`---`);
    output.appendLine(`Knitting ${fsPath}`);
    output.appendLine(`R: ${rBinary}`);
    output.appendLine(`Expression: ${expression}`);
    output.appendLine(`cwd: ${cwd}`);
    output.appendLine(``);

    let outcome: KnitOutcome;
    try {
        outcome = await vscode.window.withProgress<KnitOutcome>(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Knitting ${baseName}…`,
                cancellable: true,
            },
            async (_progress, token) => {
                const result = await deps.runKnit({
                    rBinary,
                    expression,
                    cwd,
                    timeoutMs,
                    output,
                    cancellation: token,
                });
                return classify(result, { cwd });
            },
        );
    } finally {
        // Critical: inFlight.delete runs the moment withProgress resolves,
        // BEFORE any user-facing toast is awaited. This is the Piece A
        // fix — under the previous code, awaiting showInformationMessage
        // inside the withProgress callback held both the progress
        // notification AND the inFlight gate open until the user
        // dismissed the toast, causing a spurious "already being knitted"
        // on rapid re-invocation.
        inFlight.delete(fsPath);
    }

    await renderOutcome(outcome, {
        fsPath,
        baseName,
        sourceUri: docUri,
        cwd,
        output,
        rBinary,
        timeoutMs,
        context,
        showOrUpdatePanel: deps.showOrUpdatePanel,
    });
}

interface RenderOutcomeCtx {
    fsPath: string;
    baseName: string;
    sourceUri: vscode.Uri;
    cwd: string | undefined;
    output: vscode.OutputChannel;
    rBinary: string;
    timeoutMs: number;
    context: vscode.ExtensionContext;
    showOrUpdatePanel: KnitDeps['showOrUpdatePanel'];
}

/**
 * Surface the result of a knit to the user. Runs OUTSIDE the
 * `vscode.window.withProgress` callback so that the progress
 * notification closes the moment the R subprocess exits, regardless of
 * how long the user takes to dismiss the success/failure toast.
 */
async function renderOutcome(outcome: KnitOutcome, ctx: RenderOutcomeCtx): Promise<void> {
    if (outcome.kind === 'spawnError') {
        const code = outcome.error.code;
        if (code === 'ENOENT') {
            ctx.output.appendLine(`[error] R not found at "${ctx.rBinary}".`);
            void vscode.window.showErrorMessage(
                'Raven: Knit — R not found on PATH. Set `raven.packages.rPath`.',
            );
        } else {
            ctx.output.appendLine(`[error] ${outcome.error.message}`);
            void vscode.window.showErrorMessage(
                `Raven: Knit — failed to launch R: ${outcome.error.message}`,
            );
        }
        return;
    }

    if (outcome.kind === 'cancelled') {
        ctx.output.appendLine('Knit cancelled.');
        void vscode.window.showInformationMessage('Raven: Knit cancelled.');
        return;
    }

    if (outcome.kind === 'timedOut') {
        ctx.output.appendLine(`Knit timed out after ${ctx.timeoutMs} ms.`);
        ctx.output.show(true);
        void vscode.window.showErrorMessage('Raven: Knit timed out.');
        return;
    }

    if (outcome.kind === 'failed') {
        ctx.output.show(true);
        void vscode.window.showErrorMessage(
            `Raven: Knit failed (exit ${outcome.exitCode}). See Raven: Knit output.`,
        );
        return;
    }

    if (outcome.kind === 'noOutput') {
        const SHOW = 'Show Output';
        const choice = await vscode.window.showInformationMessage(
            'Raven: Knit succeeded (output path unknown).',
            SHOW,
        );
        if (choice === SHOW) ctx.output.show(true);
        return;
    }

    // ok branch
    const base = outcome.cwd ?? path.dirname(ctx.fsPath);
    const absolutized = outcome.parsedOutputs.map((p) => absolutizeFromCwd(p, base));
    const primary = pickPrimaryOutput(absolutized);
    if (!primary) {
        // Defensive — classify guarantees parsedOutputs.length >= 1 for 'ok'.
        void vscode.window.showInformationMessage('Raven: Knit succeeded.');
        return;
    }

    const ext = path.extname(primary).toLowerCase();
    const baseLabel = path.basename(primary);
    const isHtml = ext === '.html' || ext === '.htm';
    const SHOW_ALL = 'Show All';
    const SHOW_PANEL = 'Show Output Panel';
    const OPEN = 'Open';

    if (isHtml) {
        const panelResult = await ctx.showOrUpdatePanel(ctx.context, {
            sourceUri: ctx.sourceUri,
            outputPath: primary,
            output: ctx.output,
        });
        if (!panelResult.ok) {
            ctx.output.appendLine(`[panel] ${panelResult.error}`);
            // Fall through to the non-HTML reveal path.
            void revealKnitOutput(primary);
            return;
        }
        const buttons = absolutized.length > 1 ? [SHOW_PANEL, SHOW_ALL] : [SHOW_PANEL];
        const label = absolutized.length > 1
            ? `Raven: Knit succeeded: ${baseLabel} (and ${absolutized.length - 1} more).`
            : `Raven: Knit succeeded: ${baseLabel}.`;
        const choice = await vscode.window.showInformationMessage(label, ...buttons);
        if (choice === SHOW_PANEL) {
            const instance = KnitOutputPanel.getInstanceForTesting();
            // No public reveal method on the panel; calling showOrUpdate
            // again with the same args reveals it. (Idempotent — no
            // recompile of the iframe since the rootDir is unchanged.)
            if (instance) {
                await ctx.showOrUpdatePanel(ctx.context, {
                    sourceUri: ctx.sourceUri,
                    outputPath: primary,
                    output: ctx.output,
                });
            }
        } else if (choice === SHOW_ALL) {
            ctx.output.show(true);
        }
        return;
    }

    // Non-HTML: PDF, Word, plain text, etc.
    const buttons = absolutized.length > 1 ? [OPEN, SHOW_ALL] : [OPEN];
    const label = absolutized.length > 1
        ? `Raven: Knit succeeded: ${baseLabel} (and ${absolutized.length - 1} more).`
        : `Raven: Knit succeeded: ${baseLabel}.`;
    const choice = await vscode.window.showInformationMessage(label, ...buttons);
    if (choice === OPEN) await revealKnitOutput(primary);
    else if (choice === SHOW_ALL) ctx.output.show(true);
}
```

6. **Remove the obsolete inline `revealKnitOutput` for HTML** — find:

```ts
async function revealKnitOutput(outputPath: string): Promise<void> {
    const uri = vscode.Uri.file(outputPath);
    const ext = path.extname(outputPath).toLowerCase();
    if (ext === '.html' || ext === '.htm') {
        await vscode.commands.executeCommand('vscode.open', uri);
        return;
    }
    await vscode.commands.executeCommand('revealFileInOS', uri);
}
```

Replace with:

```ts
/**
 * Reveal non-HTML knit output. HTML outputs route through the Knit
 * Output webview panel instead (see renderOutcome). PDFs / Word docs /
 * etc. open via the OS file browser — the user double-clicks to launch
 * their preferred reader.
 */
async function revealKnitOutput(outputPath: string): Promise<void> {
    const uri = vscode.Uri.file(outputPath);
    await vscode.commands.executeCommand('revealFileInOS', uri);
}
```

- [ ] **Step 3: Compile-check**

```bash
cd editors/vscode && bun run compile:test
```

Expected: clean.

- [ ] **Step 4: Re-run Bun tests to confirm no Bun-level regression**

```bash
bun test tests/bun/knit-output-*.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/src/knit/knit-commands.ts
git commit -m "refactor(knit): renderOutcome runs outside withProgress; fix stuck progress + inFlight gate"
```

---

## Phase 5 — Mocha integration tests

### Task 5.1: Progress-lifecycle integration test

**Files:**
- Create: `editors/vscode/src/test/knit-progress-lifecycle.test.ts`

- [ ] **Step 1: Verify the existing helpers we'll reuse**

```bash
grep -nE "export (function|const) (activate|openDocument|sleep)" editors/vscode/src/test/helper.ts
```

Expected: `activate`, `openDocument`, `sleep` exported. (If not, adjust the imports in the test below to match the actual helper exports.)

- [ ] **Step 2: Expose a test-only entry point**

The production `raven.knit` is registered at activation time against the real `runKnit`; we cannot override the registered command from a test. Expose the internal `runKnitCommand` via a thin wrapper.

Append to `editors/vscode/src/knit/knit-commands.ts`:

```ts
/**
 * Test-only entry point that bypasses the registered `raven.knit`
 * command. Exposes the same code path with caller-controlled deps.
 * Used by `knit-progress-lifecycle.test.ts` to verify the Piece A
 * invariant: `inFlight.delete` runs the moment `withProgress` resolves,
 * NOT when the user dismisses the success toast.
 *
 * The `__` prefix signals "test-only"; do not call from production
 * code.
 */
export async function __runKnitCommandForTest(args: {
    uri: vscode.Uri | undefined;
    output: vscode.OutputChannel;
    inFlight: Set<string>;
    context: vscode.ExtensionContext;
    deps: KnitDeps;
}): Promise<void> {
    await runKnitCommand(args.uri, args.output, args.inFlight, args.context, args.deps);
}
```

- [ ] **Step 3: Create the test**

Create `editors/vscode/src/test/knit-progress-lifecycle.test.ts`:

```ts
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate, openDocument } from './helper';
import { __runKnitCommandForTest } from '../knit/knit-commands';

suite('knit progress lifecycle', () => {
    test('inFlight clears the moment runKnit resolves, not when toast is dismissed', async () => {
        const api = await activate();
        assert.ok(api, 'extension activated');

        const fixture = path.join(__dirname, 'fixtures', 'sample.Rmd');
        const doc = await openDocument(vscode.Uri.file(fixture));
        await vscode.window.showTextDocument(doc);

        const inFlight = new Set<string>();
        const output = vscode.window.createOutputChannel('Knit Test');

        // Stub showInformationMessage so the test does not hang on the
        // success toast. The bug under test was that inFlight stayed
        // populated until this resolved.
        const origShow = vscode.window.showInformationMessage;
        let showResolve: ((v: string | undefined) => void) | null = null;
        (vscode.window as any).showInformationMessage = (
            ...args: unknown[]
        ): Thenable<string | undefined> => {
            return new Promise<string | undefined>((res) => {
                showResolve = res;
            });
        };

        try {
            const runPromise = __runKnitCommandForTest({
                uri: doc.uri,
                output,
                inFlight,
                context: { subscriptions: [], extensionUri: api.extensionUri } as unknown as vscode.ExtensionContext,
                deps: {
                    runKnit: (async () => ({
                        spawnError: undefined,
                        cancelled: false,
                        timedOut: false,
                        exitCode: 0,
                        stdout: `Output created: ${path.join(path.dirname(fixture), 'sample.html')}\n`,
                        stderr: '',
                    })) as any,
                    showOrUpdatePanel: async () => ({ ok: true }),
                },
            });

            // Yield to let withProgress + runKnit resolve. After this
            // microtask drain, withProgress should be done AND
            // inFlight.delete should have happened — even though the
            // info-message stub is still suspended.
            await new Promise((res) => setTimeout(res, 50));

            assert.strictEqual(
                inFlight.has(doc.uri.fsPath),
                false,
                'inFlight should be cleared before the success toast is dismissed',
            );

            // Now dismiss the info-message so runPromise can resolve.
            showResolve?.(undefined);
            await runPromise;
        } finally {
            (vscode.window as any).showInformationMessage = origShow;
            output.dispose();
        }
    });
});
```

- [ ] **Step 4: Create the fixture**

Create `editors/vscode/src/test/fixtures/sample.Rmd`:

```markdown
---
title: "Knit test sample"
output: html_document
---

Hello.
```

- [ ] **Step 5: Compile-check**

```bash
cd editors/vscode && bun run compile:test
```

Expected: clean.

- [ ] **Step 6: Run the Mocha suite**

```bash
cd editors/vscode && bun run test 2>&1 | tail -40
```

Expected: the new `knit progress lifecycle` test passes alongside the existing suite.

- [ ] **Step 7: Commit**

```bash
git add editors/vscode/src/knit/knit-commands.ts editors/vscode/src/test/knit-progress-lifecycle.test.ts editors/vscode/src/test/fixtures/sample.Rmd
git commit -m "test(knit): inFlight clears before success toast (Piece A)"
```

---

### Task 5.2: Panel integration test — refresh + open-in-browser + singleton

**Files:**
- Create: `editors/vscode/src/test/knit-output-panel.test.ts`

- [ ] **Step 1: Create the test**

Create `editors/vscode/src/test/knit-output-panel.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Compile and run**

```bash
cd editors/vscode && bun run compile:test && bun run test
```

Expected: all knit tests pass; the rest of the suite is unchanged.

- [ ] **Step 3: Commit**

```bash
git add editors/vscode/src/test/knit-output-panel.test.ts
git commit -m "test(knit): KnitOutputPanel singleton lifecycle integration tests"
```

---

## Phase 6 — Docs

### Task 6.1: Update `docs/knit.md`

**Files:**
- Modify: `docs/knit.md`

- [ ] **Step 1: Update step 10 (Reveal) and the "what raven does not do" table**

Find:

```markdown
10. **Reveal.** On a clean exit Raven parses `Output created: <path>`
    out of stdout and offers an `Open` button. `.html` / `.htm` open
    via `vscode.open` (which routes through Simple Browser in remote
    workspaces); everything else opens via `revealFileInOS`. When the
    parse fails Raven still surfaces "Knit succeeded (output path
    unknown)" — the subprocess exit code is the ground truth.
```

Replace with:

```markdown
10. **Reveal.** On a clean exit Raven parses `Output created: <path>`
    out of stdout. When the primary output is HTML (or there's any HTML
    in a multi-output knit), Raven opens it in the **Knit Output**
    webview panel beside the editor. The panel toolbar has two buttons:
    - **Refresh** — re-knits the source `.Rmd` (the same code path as
      invoking `Raven: Knit` from the palette).
    - **Open in Browser** — opens the rendered file in your OS default
      browser. In remote workspaces (SSH, Codespaces, dev containers)
      this may not work because `file://` URIs target the remote
      machine; Raven warns and writes the path to the `Raven: Knit`
      output channel as a fallback.

    The rendered HTML loads inside an `<iframe sandbox="">` — scripts,
    forms, and external navigation are blocked. Intra-document anchor
    links (`#section`) work; clicking an external `<a>` does nothing
    (use **Open in Browser** for full interactivity, including
    htmlwidgets). For PDF / Word / etc., Raven still reveals the file
    in your OS file browser. When the output-path parse fails Raven
    surfaces "Knit succeeded (output path unknown)" — the subprocess
    exit code is the ground truth.
```

- [ ] **Step 2: Add a clarifying row to the "What Raven does **not** do" table**

Find:

```markdown
| Live preview of `.Rmd` or `.qmd` | `quarto.quarto`'s `Quarto: Preview` |
```

Add a row below it (no change to the existing one):

```markdown
| Auto-refresh / live preview on save | `quarto.quarto`'s `Quarto: Preview`. The Knit Output panel is a static viewer with a manual Refresh button — not a live recompile. |
```

- [ ] **Step 3: Compile-check that markdown still lints**

(The project uses `markdownlint`; the only constraint relevant here is MD040 — fenced code blocks need a language. The new content does not add fences.)

Skip — no command needed.

- [ ] **Step 4: Commit**

```bash
git add docs/knit.md
git commit -m "docs(knit): document Knit Output webview panel, refresh, open in browser, iframe limitations"
```

---

## Phase 7 — Local verification

### Task 7.1: Run the full local suite

- [ ] **Step 1: Bun tests**

```bash
bun test tests/bun/
```

Expected: all green.

- [ ] **Step 2: Cargo tests (sanity — no Rust code changed, but the workspace test suite catches accidental cross-cutting breakage)**

```bash
cargo test -p raven 2>&1 | tail -20
```

Expected: no new failures introduced. (Existing pass/fail unchanged.)

- [ ] **Step 3: VS Code Mocha**

```bash
cd editors/vscode && bun run compile:test && bun run test 2>&1 | tail -60
```

Expected: all knit tests pass; rest unchanged.

If anything fails, fix it and re-commit with a `fix:` message before proceeding.

- [ ] **Step 4: Settings reference regen (precautionary — if any package.json change crept in)**

```bash
bun editors/vscode/scripts/generate-settings-reference.mjs
git diff --stat
```

Expected: no diff. If there is one, commit it with `chore(vscode): regenerate settings reference`.

---

### Task 7.2: Manual smoke

Manual steps the implementer runs locally. Each must pass before opening the PR.

- [ ] Open a `.Rmd` fixture (the `editors/vscode/src/test/fixtures/sample.Rmd` works, or any local one). Run **Raven: Knit**.
  - "Knitting …" notification closes the moment R exits.
  - Knit Output panel opens beside the editor.
  - **Refresh** and **Open in Browser** are visible.
- [ ] Click **Refresh**. New "Knitting …" notification appears; panel content updates on success; no "already being knitted" toast.
- [ ] Click **Refresh** quickly twice while a knit is running. Second click produces "is already being knitted" (existing inFlight gate).
- [ ] Knit a `.Rmd` with `output: pdf_document`. Verify the success toast has **Open** and **Open** triggers `revealFileInOS` (file browser). No panel opens.
- [ ] (Optional, if remote workspace available) Knit in Codespaces / SSH. **Open in Browser** either opens locally OR shows the "not available for this workspace" warning + path in output channel.

---

## Phase 8 — Codex review, PR, merge

### Task 8.1: Codex adversarial review of the implementation

- [ ] **Step 1: Run Codex review on the diff**

Invoke the codex rescue subagent with a focused prompt:

```text
Adversarial review of branch fix-knit-bug vs main. Focus on:
- correctness of the Piece A lifecycle fix
- security of the iframe-sandbox shell (CSP, sandbox attribute, localResourceRoots)
- multi-output handling
- test coverage gaps
Find problems, not validate.
```

Use the `/codex:rescue` slash command (or `Agent` with `subagent_type: "codex:codex-rescue"`).

- [ ] **Step 2: Triage findings**

For each finding, decide:
- **Fix now** — incorrect or insecure code. Make the change, add a regression test, commit.
- **Document** — intentional trade-off. Note in the spec's "v2 → v3 changes" table if non-trivial.
- **Reject** — disagree, with reasoning. Surface to the user before dismissing.

Commit any fixes with `fix(knit): <Codex finding>` messages.

- [ ] **Step 3: Re-run the full local suite after fixes**

```bash
bun test tests/bun/ && cargo test -p raven 2>&1 | tail -10 && cd editors/vscode && bun run test 2>&1 | tail -30
```

Expected: all green.

---

### Task 8.2: Open the PR

- [ ] **Step 1: Push and open PR**

```bash
git push -u origin fix-knit-bug
gh pr create --title "fix(knit): output webview + progress lifecycle" --body "$(cat <<'EOF'
## Summary

- Fixes the stuck "Knitting …" progress notification (and the spurious "already being knitted" gate on re-invocation) by moving all user-facing toasts out of the `withProgress` callback. `inFlight.delete(fsPath)` now runs the moment the R subprocess exits.
- Adds a Knit Output webview panel: an iframe-sandbox shell that renders HTML output with **Refresh** and **Open in Browser** toolbar buttons. Three-layer security model (sandbox attribute, outer-shell CSP in `<head>`, `localResourceRoots`) — no HTML parsing or rewriting on Raven's side.
- Multi-output knits (`output_format = "all"`) prefer the HTML output for the viewer; PDF / DOCX / etc. remain on the existing `revealFileInOS` path.

## Spec
- `docs/superpowers/specs/2026-05-17-knit-output-webview-design.md` (v2, addresses Codex adversarial review of v1)
- Plan: `docs/superpowers/plans/2026-05-17-knit-output-webview.md`

## Test plan
- [ ] Bun unit tests for `pickPrimaryOutput`, `isKnitOutputMessage`, `classify`, `buildShellHtml`
- [ ] Mocha integration test asserting `inFlight` clears before the success toast (Piece A)
- [ ] Mocha integration tests for `KnitOutputPanel` singleton reuse and rootDir-change recreation
- [ ] Manual smoke: knit `.Rmd` locally, verify panel opens, Refresh re-knits, Open in Browser launches default browser
- [ ] Manual smoke: knit `output: pdf_document`, verify existing `revealFileInOS` path unchanged
EOF
)"
```

- [ ] **Step 2: Capture the PR URL**

The PR URL is printed by `gh pr create`. Use it for the merge step.

---

### Task 8.3: Monitor CI

- [ ] **Step 1: Check CI status**

```bash
gh pr checks --watch
```

Expected: all checks green.

- [ ] **Step 2: Address any CI failures**

For each failure: read the log (`gh pr view <number> --log`), reproduce locally, fix, push.

---

### Task 8.4: Final Codex sign-off and merge

- [ ] **Step 1: Codex final review**

Run Codex on the final diff:

```text
Final review of branch fix-knit-bug. Is this safe to merge?
Address only blocking issues (security, correctness, test gaps).
```

- [ ] **Step 2: Address any blocking findings**

Same triage as Task 8.2. Push fixes; CI runs again.

- [ ] **Step 3: Merge once Codex agrees and CI is green**

```bash
gh pr merge --squash --auto
```

(The `--auto` flag merges as soon as CI passes if it isn't already green.)

- [ ] **Step 4: Confirm merge**

```bash
gh pr view <number> --json state,mergedAt
```

Expected: `state: MERGED`.

---

## Self-review checklist (run before handing off)

- [ ] Spec coverage: every section in `docs/superpowers/specs/2026-05-17-knit-output-webview-design.md` has at least one task implementing it (Goals 1–5 ✓ Piece A, Piece B, multi-output, docs, tests).
- [ ] No placeholders: every code block in this plan contains executable text; every command has expected output stated.
- [ ] Type consistency: `KnitOutcome`, `KnitOutputMessage`, `KnitDeps`, `RenderOutcomeCtx` are all defined in exactly one task and referenced consistently.
- [ ] Commit cadence: 7 implementation commits + Codex-fix commits + docs commit = ~10 commits total. Each is independently revertible.

