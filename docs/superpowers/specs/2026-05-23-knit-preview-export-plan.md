# Knit Preview + Pandoc Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename `Knit` → `Knit Preview` (title only), move all intermediate artifacts to per-session temp dirs, drop the YAML output-format gate, and add three Pandoc-driven Export commands (HTML/PDF/Word) exposed from both the webview toolbar and the editor-title Raven menu.

**Architecture:** TDD throughout. New pure-function modules (`pandoc-args.ts`, `pandoc-detect.ts`, `pandoc-engine.ts`, `operation-controller.ts`, `raven-knit-paths.ts`) are unit-tested with bun. VS Code integration is tested via the existing Mocha+`vscode-test` suite. Pandoc is launched via `child_process.spawn` with the same SIGINT→SIGTERM→SIGKILL ladder as `knit-engine.ts`. Webview→host messages stay validated by an extended `isKnitOutputMessage` with per-type exact-schema matching.

**Tech Stack:** TypeScript (Node, esbuild-bundled VS Code extension), bun for unit tests, mocha + `vscode-test` for integration tests, R via subprocess (knitr), Pandoc via subprocess.

**Spec:** [`docs/superpowers/specs/2026-05-23-knit-preview-export-design.md`](./2026-05-23-knit-preview-export-design.md). Approved by Codex on pass 5.

---

## File Structure

**New files:**
- `editors/vscode/src/knit/raven-knit-paths.ts` — temp-dir layout (`raven-knit/<workspaceHash>/<sessionId>/preview|export/...`); `canonicalOpKey(uri)`; workspace/session helpers.
- `editors/vscode/src/knit/output-options.ts` — pure parser turning a `FrontmatterDoc` into `OutputOptions` (chunkOpts + pandocFlags + ignored).
- `editors/vscode/src/knit/pandoc-args.ts` — pure `buildPandocArgs(opts, format, csParam) → string[]` with CSS-path containment.
- `editors/vscode/src/knit/pandoc-detect.ts` — lazy `resolvePandoc()` with platform fallback paths + in-memory cache.
- `editors/vscode/src/knit/pandoc-engine.ts` — `pandocConvert()` with temp-then-rename, signal escalation, timeout.
- `editors/vscode/src/knit/operation-controller.ts` — per-source `OperationController` registry replacing the bare `Set<string>` plus preview-dir refcount.
- `editors/vscode/src/knit/export-commands.ts` — `raven.knit.exportHtml/Pdf/Docx` command registration + shared export pipeline.
- `editors/vscode/src/knit/open-exported-file.ts` — shared `openExportedFile(uri, format, output)` helper with the remote-workspace fallback.

**Modified files:**
- `editors/vscode/src/knit/knit-paths.ts` — kept as a thin shim (compatibility), delegates to `raven-knit-paths.ts`.
- `editors/vscode/src/knit/yaml-frontmatter.ts` — add `parseOutputOptions()`; remove the `non-html-format` blocker logic from `detectBlockers()`.
- `editors/vscode/src/knit/r-expression.ts` — extend `buildKnitExpression()` to set `base.dir`, `fig.path`, and `opts_chunk$set()` from `OutputOptions.chunkOpts`.
- `editors/vscode/src/knit/knit-commands.ts` — drop the non-HTML blocker flow; use new temp paths; replace `Set<string>` with `OperationController` registry; expose helpers for export.
- `editors/vscode/src/knit/knit-output.ts` — add `requestExport`/`cancelExport` to `KnitOutputMessage`; new `Export ▾` button HTML; per-type exact-schema `isKnitOutputMessage`.
- `editors/vscode/src/knit/knit-output-panel.ts` — handle `requestExport` (open quickpick), `cancelExport`; integrate stale-preview detection; refcount-aware disposal; refactor `openInBrowser` callers to use the shared `open-exported-file.ts` helper.
- `editors/vscode/src/knit/post-knit-renderer.ts` — write `.html` to the new temp path.
- `editors/vscode/src/extension.ts` — register session id; register export commands; activation orphan sweep.
- `editors/vscode/src/initializationOptions.ts` — new settings forwarding.
- `editors/vscode/package.json` — new commands, menu entries, settings schema.

**New test files (bun unit tests):**
- `editors/vscode/src/knit/raven-knit-paths.test.ts`
- `editors/vscode/src/knit/output-options.test.ts`
- `editors/vscode/src/knit/pandoc-args.test.ts`
- `editors/vscode/src/knit/pandoc-detect.test.ts`
- `editors/vscode/src/knit/operation-controller.test.ts`
- `editors/vscode/src/knit/yaml-frontmatter.test.ts` — extended

**New test files (vscode-test integration):**
- `editors/vscode/src/test/knit-yaml-output-ignored.test.ts` — renamed from `knit-html-only.test.ts`
- `editors/vscode/src/test/knit-export-html.test.ts`
- `editors/vscode/src/test/knit-export-pdf.test.ts`
- `editors/vscode/src/test/knit-export-docx.test.ts`
- `editors/vscode/src/test/knit-export-cancel.test.ts`
- `editors/vscode/src/test/knit-export-pandoc-missing.test.ts`
- `editors/vscode/src/test/knit-export-yaml-args.test.ts`
- `editors/vscode/src/test/knit-export-busy.test.ts`
- `editors/vscode/src/test/knit-temp-dir-cleanup.test.ts`
- `editors/vscode/src/test/knit-export-atomic.test.ts`
- `editors/vscode/src/test/knit-export-pinning.test.ts`
- `editors/vscode/src/test/knit-export-stale-figures.test.ts`
- `editors/vscode/src/test/knit-export-pandoc-args-rejected.test.ts`
- `editors/vscode/src/test/knit-export-yaml-merge.test.ts`
- `editors/vscode/src/test/knit-export-remote-fallback.test.ts`
- `editors/vscode/src/test/knit-multi-root-isolation.test.ts`
- `editors/vscode/src/test/knit-multi-window-isolation.test.ts`
- `editors/vscode/src/test/knit-op-registry-race.test.ts`
- `editors/vscode/src/test/knit-export-css-resolution.test.ts`
- `editors/vscode/src/test/knit-figpath-modes.test.ts`
- `editors/vscode/src/test/knit-trust-boundary.test.ts`

---

## Test Commands (used throughout the plan)

- **Unit tests** (single file): `bun test editors/vscode/src/knit/<file>.test.ts`
- **All bun tests**: `bun test`
- **VS Code integration tests** (one suite): `cd editors/vscode && bun run test -- --grep "<test name>"`
- **Whole vscode test suite**: `cd editors/vscode && bun run test`
- **Build extension**: `cd editors/vscode && bun run build`
- **Settings reference regen**: `bun editors/vscode/scripts/generate-settings-reference.mjs`

---

## Phase 1 — Foundation: temp-dir helpers + canonical key

### Task 1.1: Pure functions for temp-dir layout and canonical key

**Files:**
- Create: `editors/vscode/src/knit/raven-knit-paths.ts`
- Test: `editors/vscode/src/knit/raven-knit-paths.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// editors/vscode/src/knit/raven-knit-paths.test.ts
import { describe, it, expect } from 'bun:test';
import { canonicalOpKey, computeWorkspaceHash, computeSourceHash, isUnderContainmentRoot } from './raven-knit-paths';

describe('canonicalOpKey', () => {
  it('normalizes posix paths', () => {
    expect(canonicalOpKey({ fsPath: '/Users/x/foo.Rmd' } as any, 'darwin')).toBe('/Users/x/foo.Rmd');
  });
  it('lowercases on Windows', () => {
    expect(canonicalOpKey({ fsPath: 'C:\\Users\\X\\Foo.Rmd' } as any, 'win32')).toBe('c:\\users\\x\\foo.rmd');
  });
});

describe('computeWorkspaceHash', () => {
  it('is stable for the same URI', () => {
    expect(computeWorkspaceHash('file:///Users/x/proj')).toBe(computeWorkspaceHash('file:///Users/x/proj'));
  });
  it('differs across URIs', () => {
    expect(computeWorkspaceHash('file:///a')).not.toBe(computeWorkspaceHash('file:///b'));
  });
});

describe('computeSourceHash', () => {
  it('hashes the absolute path', () => {
    const a = computeSourceHash('/p/foo.Rmd');
    const b = computeSourceHash('/p/foo.Rmd');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('isUnderContainmentRoot', () => {
  it('accepts a path inside the root', () => {
    expect(isUnderContainmentRoot('/p/style.css', '/p')).toBe(true);
  });
  it('rejects parent escapes', () => {
    expect(isUnderContainmentRoot('/q/x.css', '/p')).toBe(false);
  });
  it('handles nested paths', () => {
    expect(isUnderContainmentRoot('/p/css/style.css', '/p')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify fail**

```bash
bun test editors/vscode/src/knit/raven-knit-paths.test.ts
```

Expected: FAIL — `Cannot find module './raven-knit-paths'`.

- [ ] **Step 3: Implement the module**

```typescript
// editors/vscode/src/knit/raven-knit-paths.ts
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import type { Uri } from 'vscode';

/**
 * Stable per-document key used by the OperationController registry.
 * Normalizes path separators and lowercases on Windows so the same .Rmd
 * opened under different URI shapes collapses to one controller.
 */
export function canonicalOpKey(uri: Pick<Uri, 'fsPath'>, platform: NodeJS.Platform = process.platform): string {
  const normalized = path.normalize(uri.fsPath);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function computeWorkspaceHash(workspaceUri: string): string {
  return crypto.createHash('sha256').update(workspaceUri).digest('hex');
}

export function computeSourceHash(absPath: string): string {
  return crypto.createHash('sha256').update(absPath).digest('hex');
}

/**
 * True when `absPath` resolves to a path inside `root` (or equal to it).
 * Uses `path.relative` rather than string prefix checks to handle
 * trailing separators and parent-dir traversal correctly.
 */
export function isUnderContainmentRoot(absPath: string, root: string): boolean {
  const rel = path.relative(root, absPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Returns the root for all Raven temp artifacts in this session:
 *   <os.tmpdir()>/raven-knit/<workspaceHash>/<sessionId>/
 */
export function sessionRoot(workspaceHash: string, sessionId: string): string {
  return path.join(os.tmpdir(), 'raven-knit', workspaceHash, sessionId);
}

export function previewDirFor(workspaceHash: string, sessionId: string, sourceHash: string): string {
  return path.join(sessionRoot(workspaceHash, sessionId), 'preview', sourceHash);
}

export function exportDirFor(workspaceHash: string, sessionId: string, uuid: string): string {
  return path.join(sessionRoot(workspaceHash, sessionId), 'export', uuid);
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
bun test editors/vscode/src/knit/raven-knit-paths.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/src/knit/raven-knit-paths.ts editors/vscode/src/knit/raven-knit-paths.test.ts
git commit -m "feat(knit): add raven-knit-paths module with canonical op key + temp-dir helpers"
```

---

## Phase 2 — YAML output options parser

### Task 2.1: Parse YAML output: block into OutputOptions

**Files:**
- Create: `editors/vscode/src/knit/output-options.ts`
- Test: `editors/vscode/src/knit/output-options.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// editors/vscode/src/knit/output-options.test.ts
import { describe, it, expect } from 'bun:test';
import { parseOutputOptions } from './output-options';

describe('parseOutputOptions', () => {
  it('handles missing output: as empty', () => {
    const r = parseOutputOptions({}, 'html');
    expect(r.chunkOpts).toEqual({});
    expect(r.pandocFlags).toEqual({});
    expect(r.ignored).toEqual([]);
  });

  it('reads chunk opts from the requested format block', () => {
    const r = parseOutputOptions({ output: { pdf_document: { fig_width: 5, fig_height: 4 } } }, 'pdf');
    expect(r.chunkOpts).toEqual({ fig_width: 5, fig_height: 4 });
  });

  it('reads pandoc flags from the requested format block', () => {
    const r = parseOutputOptions({ output: { pdf_document: { toc: true, toc_depth: 3, number_sections: true } } }, 'pdf');
    expect(r.pandocFlags).toEqual({ toc: true, toc_depth: 3, number_sections: true });
  });

  it('ignores non-matching format blocks', () => {
    const r = parseOutputOptions({ output: { html_document: { toc_depth: 9 }, pdf_document: { toc_depth: 3 } } }, 'pdf');
    expect(r.pandocFlags.toc_depth).toBe(3);
  });

  it('falls back to top-level keys when format block omits them', () => {
    const r = parseOutputOptions({ output: { toc: true, pdf_document: {} } }, 'pdf');
    expect(r.pandocFlags.toc).toBe(true);
  });

  it('logs theme and code_folding as ignored', () => {
    const r = parseOutputOptions({ output: { html_document: { theme: 'cerulean', code_folding: 'hide' } } }, 'html');
    expect(r.ignored).toContain('theme');
    expect(r.ignored).toContain('code_folding');
  });

  it('logs pandoc_args as ignored (v1)', () => {
    const r = parseOutputOptions({ output: { html_document: { pandoc_args: ['--lua-filter=evil.lua'] } } }, 'html');
    expect(r.ignored).toContain('pandoc_args');
    expect((r.pandocFlags as any).pandoc_args).toBeUndefined();
  });

  it('accepts string output: as format-name shorthand', () => {
    const r = parseOutputOptions({ output: 'pdf_document' }, 'pdf');
    expect(r.chunkOpts).toEqual({});
  });

  it('validates dev against allowlist; rejects unknown', () => {
    const r = parseOutputOptions({ output: { html_document: { dev: 'png' } } }, 'html');
    expect(r.chunkOpts.dev).toBe('png');
    const r2 = parseOutputOptions({ output: { html_document: { dev: 'rm -rf' } } }, 'html');
    expect(r2.chunkOpts.dev).toBeUndefined();
    expect(r2.ignored).toContain('dev');
  });

  it('html alias formats (bookdown::html_document2) match the html target', () => {
    const r = parseOutputOptions({ output: { 'bookdown::html_document2': { toc: true } } }, 'html');
    expect(r.pandocFlags.toc).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify fail**

```bash
bun test editors/vscode/src/knit/output-options.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement the parser**

```typescript
// editors/vscode/src/knit/output-options.ts
import type { FrontmatterDoc } from './yaml-frontmatter';

export type TargetFormat = 'html' | 'pdf' | 'docx';

export interface ChunkOpts {
  fig_width?: number;
  fig_height?: number;
  fig_retina?: number;
  dpi?: number;
  dev?: string;
}

export interface PandocFlags {
  toc?: boolean;
  toc_depth?: number;
  number_sections?: boolean;
  highlight?: string;
  self_contained?: boolean;
  css?: string[];
  mathjax?: boolean;
}

export interface OutputOptions {
  chunkOpts: ChunkOpts;
  pandocFlags: PandocFlags;
  ignored: string[];
}

const HTML_FORMATS: ReadonlySet<string> = new Set([
  'html_document', 'html_notebook', 'html_vignette', 'html_fragment',
  'bookdown::html_document2', 'distill::distill_article', 'pkgdown::html_document',
  'rmdformats::readthedown', 'rmdformats::material', 'rmdformats::html_clean',
  'rmdformats::html_docco', 'tufte::tufte_html', 'prettydoc::html_pretty',
]);
const PDF_FORMATS: ReadonlySet<string> = new Set([
  'pdf_document', 'bookdown::pdf_document2', 'tufte::tufte_handout', 'tufte::tufte_book',
]);
const DOCX_FORMATS: ReadonlySet<string> = new Set([
  'word_document', 'bookdown::word_document2',
]);

const CHUNK_KEYS: (keyof ChunkOpts)[] = ['fig_width', 'fig_height', 'fig_retina', 'dpi', 'dev'];
const PANDOC_KEYS: (keyof PandocFlags)[] = ['toc', 'toc_depth', 'number_sections', 'highlight', 'self_contained', 'css', 'mathjax'];
const IGNORED_KEYS = ['theme', 'code_folding', 'df_print', 'code_download', 'template', 'includes', 'pandoc_args'];
const DEV_ALLOWLIST = new Set(['png', 'pdf', 'svg', 'jpeg', 'cairo_pdf']);
const HIGHLIGHT_ALLOWLIST = new Set([
  'pygments', 'tango', 'espresso', 'zenburn', 'kate', 'monochrome', 'breezedark', 'haddock',
  'default', 'pygments-default',
]);

function matchesFormat(blockKey: string, target: TargetFormat): boolean {
  if (target === 'html') return HTML_FORMATS.has(blockKey);
  if (target === 'pdf') return PDF_FORMATS.has(blockKey);
  if (target === 'docx') return DOCX_FORMATS.has(blockKey);
  return false;
}

export function parseOutputOptions(fm: FrontmatterDoc, target: TargetFormat): OutputOptions {
  const chunkOpts: ChunkOpts = {};
  const pandocFlags: PandocFlags = {};
  const ignored: string[] = [];

  const output = fm.output;
  if (output === undefined || output === null) return { chunkOpts, pandocFlags, ignored };
  if (typeof output === 'string') return { chunkOpts, pandocFlags, ignored };
  if (typeof output !== 'object' || Array.isArray(output)) return { chunkOpts, pandocFlags, ignored };

  const outputMap = output as Record<string, unknown>;
  let formatBlock: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(outputMap)) {
    if (matchesFormat(key, target) && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      formatBlock = value as Record<string, unknown>;
      break;
    }
  }

  const topLevel: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(outputMap)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      topLevel[key] = value;
    }
  }

  const resolve = (key: string): unknown =>
    (formatBlock && key in formatBlock) ? formatBlock[key]
    : (key in topLevel) ? topLevel[key]
    : undefined;

  for (const key of CHUNK_KEYS) {
    const v = resolve(key);
    if (v === undefined) continue;
    if (key === 'dev') {
      if (typeof v === 'string' && DEV_ALLOWLIST.has(v)) chunkOpts.dev = v;
      else { ignored.push('dev'); }
      continue;
    }
    if (typeof v === 'number' && Number.isFinite(v)) chunkOpts[key] = v;
    else if (typeof v === 'boolean') chunkOpts[key] = v ? 1 : 0;
  }

  for (const key of PANDOC_KEYS) {
    const v = resolve(key);
    if (v === undefined) continue;
    if (key === 'toc' || key === 'number_sections' || key === 'self_contained' || key === 'mathjax') {
      if (typeof v === 'boolean') pandocFlags[key] = v;
    } else if (key === 'toc_depth') {
      if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 6) pandocFlags.toc_depth = v;
    } else if (key === 'highlight') {
      if (typeof v === 'string' && HIGHLIGHT_ALLOWLIST.has(v)) pandocFlags.highlight = v;
      else ignored.push('highlight');
    } else if (key === 'css') {
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) pandocFlags.css = v.slice();
      else if (typeof v === 'string') pandocFlags.css = [v];
    }
  }

  const seenIgnored = new Set(ignored);
  const surfaces = formatBlock ? [formatBlock, topLevel] : [topLevel];
  for (const surface of surfaces) {
    for (const k of IGNORED_KEYS) {
      if (k in surface && !seenIgnored.has(k)) {
        ignored.push(k);
        seenIgnored.add(k);
      }
    }
  }

  return { chunkOpts, pandocFlags, ignored };
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
bun test editors/vscode/src/knit/output-options.test.ts
```

Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/src/knit/output-options.ts editors/vscode/src/knit/output-options.test.ts
git commit -m "feat(knit): parse YAML output: block into structured OutputOptions"
```

---

## Phase 3 — Pandoc args builder (pure function)

### Task 3.1: buildPandocArgs with CSS containment

**Files:**
- Create: `editors/vscode/src/knit/pandoc-args.ts`
- Test: `editors/vscode/src/knit/pandoc-args.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// editors/vscode/src/knit/pandoc-args.test.ts
import { describe, it, expect } from 'bun:test';
import { buildPandocArgs } from './pandoc-args';

const opts = { chunkOpts: {}, pandocFlags: {}, ignored: [] };

describe('buildPandocArgs', () => {
  it('produces minimal args for HTML', () => {
    expect(buildPandocArgs(opts, 'html', { mdPath: 'in.md', outPath: 'out.html', sourceDir: '/p', containmentRoot: '/p' }))
      .toEqual(['in.md', '-o', 'out.html', '--to', 'html5', '--standalone']);
  });

  it('produces minimal args for PDF', () => {
    expect(buildPandocArgs(opts, 'pdf', { mdPath: 'in.md', outPath: 'out.pdf', sourceDir: '/p', containmentRoot: '/p', pdfEngine: 'xelatex' }))
      .toEqual(['in.md', '-o', 'out.pdf', '--to', 'pdf', '--pdf-engine=xelatex']);
  });

  it('produces minimal args for DOCX', () => {
    expect(buildPandocArgs(opts, 'docx', { mdPath: 'in.md', outPath: 'out.docx', sourceDir: '/p', containmentRoot: '/p' }))
      .toEqual(['in.md', '-o', 'out.docx', '--to', 'docx']);
  });

  it('appends --toc / --toc-depth / --number-sections', () => {
    const o = { ...opts, pandocFlags: { toc: true, toc_depth: 4, number_sections: true } };
    const args = buildPandocArgs(o, 'html', { mdPath: 'in.md', outPath: 'out.html', sourceDir: '/p', containmentRoot: '/p' });
    expect(args).toContain('--toc');
    expect(args).toContain('--toc-depth=4');
    expect(args).toContain('--number-sections');
  });

  it('resolves css against sourceDir and inserts --css=<abs>', () => {
    const o = { ...opts, pandocFlags: { css: ['style.css'] } };
    const args = buildPandocArgs(o, 'html', { mdPath: 'in.md', outPath: 'out.html', sourceDir: '/p', containmentRoot: '/p' });
    expect(args).toContain('--css=/p/style.css');
  });

  it('drops css entries that escape containmentRoot and reports them', () => {
    const o = { ...opts, pandocFlags: { css: ['../etc/passwd', 'style.css'] } };
    const { args, droppedCss } = buildPandocArgs.detailed(o, 'html', { mdPath: 'in.md', outPath: 'out.html', sourceDir: '/p/sub', containmentRoot: '/p' });
    expect(args).toContain('--css=/p/sub/style.css');
    expect(args.some((a) => a.includes('passwd'))).toBe(false);
    expect(droppedCss).toContain('../etc/passwd');
  });

  it('appends --embed-resources --standalone for self_contained', () => {
    const o = { ...opts, pandocFlags: { self_contained: true } };
    const args = buildPandocArgs(o, 'html', { mdPath: 'in.md', outPath: 'out.html', sourceDir: '/p', containmentRoot: '/p' });
    expect(args).toContain('--embed-resources');
    expect(args).toContain('--standalone');
  });

  it('appends --highlight-style when present', () => {
    const o = { ...opts, pandocFlags: { highlight: 'tango' } };
    const args = buildPandocArgs(o, 'pdf', { mdPath: 'in.md', outPath: 'o.pdf', sourceDir: '/p', containmentRoot: '/p', pdfEngine: 'xelatex' });
    expect(args).toContain('--highlight-style=tango');
  });

  it('appends --mathjax when mathjax: true', () => {
    const o = { ...opts, pandocFlags: { mathjax: true } };
    const args = buildPandocArgs(o, 'html', { mdPath: 'in.md', outPath: 'o.html', sourceDir: '/p', containmentRoot: '/p' });
    expect(args).toContain('--mathjax');
  });
});
```

- [ ] **Step 2: Run, fail.**

```bash
bun test editors/vscode/src/knit/pandoc-args.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement.**

```typescript
// editors/vscode/src/knit/pandoc-args.ts
import * as path from 'path';
import type { OutputOptions, TargetFormat } from './output-options';
import { isUnderContainmentRoot } from './raven-knit-paths';

export interface BuildPandocArgsCtx {
  mdPath: string;
  outPath: string;
  /** Directory of the source .Rmd. Used to resolve relative paths from YAML. */
  sourceDir: string;
  /** Workspace folder containing the .Rmd, or sourceDir if no workspace. */
  containmentRoot: string;
  /** Only required for pdf. */
  pdfEngine?: string;
}

export interface DetailedPandocArgs {
  args: string[];
  droppedCss: string[];
}

function build(opts: OutputOptions, format: TargetFormat, ctx: BuildPandocArgsCtx): DetailedPandocArgs {
  const args: string[] = [ctx.mdPath, '-o', ctx.outPath];
  if (format === 'html') {
    args.push('--to', 'html5', '--standalone');
  } else if (format === 'pdf') {
    args.push('--to', 'pdf');
    args.push(`--pdf-engine=${ctx.pdfEngine ?? 'xelatex'}`);
  } else if (format === 'docx') {
    args.push('--to', 'docx');
  }

  const f = opts.pandocFlags;
  if (f.toc) args.push('--toc');
  if (f.toc_depth) args.push(`--toc-depth=${f.toc_depth}`);
  if (f.number_sections) args.push('--number-sections');
  if (f.highlight) args.push(`--highlight-style=${f.highlight}`);
  if (f.self_contained) args.push('--embed-resources', '--standalone');
  if (f.mathjax) args.push('--mathjax');

  const droppedCss: string[] = [];
  if (f.css) {
    for (const entry of f.css) {
      const abs = path.isAbsolute(entry) ? entry : path.resolve(ctx.sourceDir, entry);
      const normalized = path.normalize(abs);
      if (isUnderContainmentRoot(normalized, ctx.containmentRoot)) {
        args.push(`--css=${normalized}`);
      } else {
        droppedCss.push(entry);
      }
    }
  }

  return { args, droppedCss };
}

export function buildPandocArgs(opts: OutputOptions, format: TargetFormat, ctx: BuildPandocArgsCtx): string[] {
  return build(opts, format, ctx).args;
}
buildPandocArgs.detailed = build;
```

- [ ] **Step 4: Run, pass.**

```bash
bun test editors/vscode/src/knit/pandoc-args.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add editors/vscode/src/knit/pandoc-args.ts editors/vscode/src/knit/pandoc-args.test.ts
git commit -m "feat(knit): buildPandocArgs with CSS containment-root validation"
```

---

## Phase 4 — Operation controller registry

### Task 4.1: OperationController + registry with refcount

**Files:**
- Create: `editors/vscode/src/knit/operation-controller.ts`
- Test: `editors/vscode/src/knit/operation-controller.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// editors/vscode/src/knit/operation-controller.test.ts
import { describe, it, expect } from 'bun:test';
import { OperationRegistry } from './operation-controller';

describe('OperationRegistry', () => {
  it('beginOp registers and returns controller', () => {
    const reg = new OperationRegistry();
    const r = reg.beginOp('k1', 'knit-preview');
    expect(r.kind === 'started').toBe(true);
    if (r.kind === 'started') {
      expect(r.controller.kind).toBe('knit-preview');
      expect(r.controller.phase).toBe('starting');
    }
  });

  it('second beginOp on same key returns busy', () => {
    const reg = new OperationRegistry();
    reg.beginOp('k1', 'knit-preview');
    const r2 = reg.beginOp('k1', 'export-pdf');
    expect(r2.kind === 'busy').toBe(true);
  });

  it('endOp clears the slot', () => {
    const reg = new OperationRegistry();
    const r1 = reg.beginOp('k1', 'knit-preview');
    if (r1.kind === 'started') reg.endOp(r1.controller, 'done');
    const r2 = reg.beginOp('k1', 'export-pdf');
    expect(r2.kind === 'started').toBe(true);
  });

  it('pin and unpin track preview-dir refcount', () => {
    const reg = new OperationRegistry();
    reg.pinPreviewDir('preview-key');
    expect(reg.previewRefs('preview-key')).toBe(1);
    reg.pinPreviewDir('preview-key');
    expect(reg.previewRefs('preview-key')).toBe(2);
    reg.unpinPreviewDir('preview-key');
    expect(reg.previewRefs('preview-key')).toBe(1);
    reg.unpinPreviewDir('preview-key');
    expect(reg.previewRefs('preview-key')).toBe(0);
  });

  it('updatePhase broadcasts to panel listener', () => {
    const reg = new OperationRegistry();
    const events: string[] = [];
    const r = reg.beginOp('k1', 'knit-preview', { broadcast: (p) => events.push(p) });
    if (r.kind === 'started') {
      r.controller.updatePhase('knitting');
      r.controller.updatePhase('finalizing');
      reg.endOp(r.controller, 'done');
    }
    expect(events).toEqual(['starting', 'knitting', 'finalizing', 'done']);
  });
});
```

- [ ] **Step 2: Run, fail.**

```bash
bun test editors/vscode/src/knit/operation-controller.test.ts
```

- [ ] **Step 3: Implement.**

```typescript
// editors/vscode/src/knit/operation-controller.ts
export type OpKind = 'knit-preview' | 'export-html' | 'export-pdf' | 'export-docx' | 'knit-then-export';
export type OpPhase = 'starting' | 'knitting' | 'converting' | 'finalizing' | 'done' | 'cancelled';

export interface OperationController {
  key: string;
  kind: OpKind;
  phase: OpPhase;
  /** Mutate phase and broadcast. */
  updatePhase(p: OpPhase): void;
  /** Listener registered by the panel, if any. */
  broadcast: (p: OpPhase) => void;
  /** Set true on cancel(); workers check inside their tight loops. */
  cancelled: boolean;
  cancel(): void;
}

export type BeginOpResult =
  | { kind: 'started'; controller: OperationController }
  | { kind: 'busy'; existing: OperationController };

export interface BeginOpOptions {
  broadcast?: (p: OpPhase) => void;
}

/**
 * Single-instance per process. The registry replaces `Set<string>` in
 * `knit-commands.ts`. Caller MUST call `beginOp` synchronously (before
 * the first `await`) so two concurrent command invocations cannot both
 * pass the empty-registry check.
 */
export class OperationRegistry {
  private readonly ops = new Map<string, OperationController>();
  private readonly previewPins = new Map<string, number>();

  beginOp(key: string, kind: OpKind, opts: BeginOpOptions = {}): BeginOpResult {
    const existing = this.ops.get(key);
    if (existing) return { kind: 'busy', existing };

    const controller: OperationController = {
      key,
      kind,
      phase: 'starting',
      cancelled: false,
      broadcast: opts.broadcast ?? (() => {}),
      updatePhase: function (p: OpPhase) {
        this.phase = p;
        this.broadcast(p);
      },
      cancel: function () {
        this.cancelled = true;
      },
    };
    controller.broadcast('starting');
    this.ops.set(key, controller);
    return { kind: 'started', controller };
  }

  endOp(controller: OperationController, finalPhase: 'done' | 'cancelled'): void {
    if (this.ops.get(controller.key) !== controller) return;
    controller.phase = finalPhase;
    controller.broadcast(finalPhase);
    this.ops.delete(controller.key);
  }

  current(key: string): OperationController | undefined {
    return this.ops.get(key);
  }

  pinPreviewDir(previewKey: string): void {
    this.previewPins.set(previewKey, (this.previewPins.get(previewKey) ?? 0) + 1);
  }

  unpinPreviewDir(previewKey: string): void {
    const next = (this.previewPins.get(previewKey) ?? 0) - 1;
    if (next <= 0) this.previewPins.delete(previewKey);
    else this.previewPins.set(previewKey, next);
  }

  previewRefs(previewKey: string): number {
    return this.previewPins.get(previewKey) ?? 0;
  }
}
```

- [ ] **Step 4: Run, pass.**

```bash
bun test editors/vscode/src/knit/operation-controller.test.ts
```

- [ ] **Step 5: Commit.**

```bash
git add editors/vscode/src/knit/operation-controller.ts editors/vscode/src/knit/operation-controller.test.ts
git commit -m "feat(knit): add OperationRegistry with phase broadcast + preview-dir refcount"
```

---

## Phase 5 — Pandoc detection

### Task 5.1: resolvePandoc with platform fallback paths

**Files:**
- Create: `editors/vscode/src/knit/pandoc-detect.ts`
- Test: `editors/vscode/src/knit/pandoc-detect.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// editors/vscode/src/knit/pandoc-detect.test.ts
import { describe, it, expect } from 'bun:test';
import { PandocResolver, PandocNotFoundError } from './pandoc-detect';

const okPath = (path: string) => Promise.resolve();
const noPath = (_: string) => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

describe('PandocResolver', () => {
  it('uses configured path when accessible', async () => {
    const r = new PandocResolver({ getConfigured: () => '/custom/pandoc', access: okPath, spawn: async () => 'pandoc 3.0' });
    expect(await r.resolve()).toBe('/custom/pandoc');
  });

  it('throws when configured path is missing', async () => {
    const r = new PandocResolver({ getConfigured: () => '/missing', access: noPath, spawn: async () => 'pandoc 3.0' });
    await expect(r.resolve()).rejects.toThrow(PandocNotFoundError);
  });

  it('falls back to PATH when no configured path', async () => {
    const r = new PandocResolver({ getConfigured: () => '', access: okPath, spawn: async (bin) => bin === 'pandoc' ? 'pandoc 3.0' : '', fallbacks: () => [] });
    expect(await r.resolve()).toBe('pandoc');
  });

  it('falls back to platform paths when PATH lookup fails', async () => {
    const r = new PandocResolver({
      getConfigured: () => '',
      access: async (p: string) => { if (p === '/opt/homebrew/bin/pandoc') return; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      spawn: async (bin) => { if (bin === 'pandoc') throw new Error('not found'); return 'pandoc 3.0'; },
      fallbacks: () => ['/opt/homebrew/bin/pandoc', '/usr/local/bin/pandoc'],
    });
    expect(await r.resolve()).toBe('/opt/homebrew/bin/pandoc');
  });

  it('caches successful resolution', async () => {
    let calls = 0;
    const r = new PandocResolver({ getConfigured: () => '', access: okPath, spawn: async (bin) => { calls++; return 'pandoc 3.0'; }, fallbacks: () => [] });
    await r.resolve();
    await r.resolve();
    expect(calls).toBe(1);
  });

  it('invalidate() clears the cache', async () => {
    let calls = 0;
    const r = new PandocResolver({ getConfigured: () => '', access: okPath, spawn: async (bin) => { calls++; return 'pandoc 3.0'; }, fallbacks: () => [] });
    await r.resolve();
    r.invalidate();
    await r.resolve();
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: Run, fail.**

```bash
bun test editors/vscode/src/knit/pandoc-detect.test.ts
```

- [ ] **Step 3: Implement.**

```typescript
// editors/vscode/src/knit/pandoc-detect.ts
export class PandocNotFoundError extends Error {
  constructor(message = 'Pandoc not found') { super(message); this.name = 'PandocNotFoundError'; }
}

export interface PandocResolverDeps {
  getConfigured: () => string;
  access: (path: string) => Promise<void>;
  /** Probe a binary by running `<bin> --version`; resolves to the trimmed output. */
  spawn: (bin: string) => Promise<string>;
  fallbacks?: () => string[];
}

export function defaultFallbacks(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin') return [
    '/opt/homebrew/bin/pandoc',
    '/usr/local/bin/pandoc',
    '/Applications/RStudio.app/Contents/Resources/app/quarto/bin/tools/pandoc',
  ];
  if (platform === 'win32') return [
    `${process.env.LOCALAPPDATA ?? ''}\\Pandoc\\pandoc.exe`,
    `${process.env.PROGRAMFILES ?? ''}\\Pandoc\\pandoc.exe`,
  ].filter((p) => p && !p.startsWith('\\'));
  return ['/usr/bin/pandoc', '/usr/local/bin/pandoc'];
}

export class PandocResolver {
  private cached: string | null = null;
  constructor(private readonly deps: PandocResolverDeps) {}

  async resolve(): Promise<string> {
    if (this.cached) return this.cached;

    const configured = this.deps.getConfigured();
    if (configured) {
      try {
        await this.deps.access(configured);
        this.cached = configured;
        return configured;
      } catch (err) {
        throw new PandocNotFoundError(`Configured pandoc path is unusable: ${configured}`);
      }
    }

    try {
      await this.deps.spawn('pandoc');
      this.cached = 'pandoc';
      return 'pandoc';
    } catch { /* fall through */ }

    const fallbacks = (this.deps.fallbacks ?? defaultFallbacks)();
    for (const candidate of fallbacks) {
      try {
        await this.deps.access(candidate);
        this.cached = candidate;
        return candidate;
      } catch { /* continue */ }
    }
    throw new PandocNotFoundError();
  }

  invalidate(): void { this.cached = null; }
}
```

- [ ] **Step 4: Run, pass.**

```bash
bun test editors/vscode/src/knit/pandoc-detect.test.ts
```

- [ ] **Step 5: Commit.**

```bash
git add editors/vscode/src/knit/pandoc-detect.ts editors/vscode/src/knit/pandoc-detect.test.ts
git commit -m "feat(knit): lazy Pandoc resolver with platform fallback paths"
```

---

## Phase 6 — Pandoc subprocess engine

### Task 6.1: pandocConvert with temp-then-rename + signal escalation

**Files:**
- Create: `editors/vscode/src/knit/pandoc-engine.ts`

This module wraps `child_process.spawn`. It cannot be meaningfully tested at the unit level without spawning a real subprocess; we rely on the integration tests in later phases (`knit-export-atomic.test.ts`, `knit-export-cancel.test.ts`). For the unit-test footprint, we extract two pure helpers: `chooseTempPath()` and `interpretExitResult()`.

- [ ] **Step 1: Write unit tests for the pure helpers**

```typescript
// editors/vscode/src/knit/pandoc-engine-helpers.test.ts
import { describe, it, expect } from 'bun:test';
import { chooseTempPath, interpretExitResult } from './pandoc-engine-helpers';

describe('chooseTempPath', () => {
  it('places temp next to destination', () => {
    const t = chooseTempPath('/p/out.docx', { pid: 42, rand: 'abc' });
    expect(t.startsWith('/p/')).toBe(true);
    expect(t).toMatch(/\.out\.docx\.42\.[a-f0-9]+\.tmp$/);
  });

  it('uses the supplied rand suffix verbatim', () => {
    const t = chooseTempPath('/p/o.pdf', { pid: 7, rand: 'deadbeef' });
    expect(t).toBe('/p/.o.pdf.7.deadbeef.tmp');
  });
});

describe('interpretExitResult', () => {
  it('success on exit 0', () => {
    expect(interpretExitResult({ code: 0, signal: null, cancelled: false }).status).toBe('success');
  });
  it('cancelled when cancelled flag set', () => {
    expect(interpretExitResult({ code: null, signal: 'SIGINT', cancelled: true }).status).toBe('cancelled');
  });
  it('failure on non-zero exit', () => {
    expect(interpretExitResult({ code: 1, signal: null, cancelled: false }).status).toBe('failure');
  });
  it('failure on signal termination not from cancel', () => {
    expect(interpretExitResult({ code: null, signal: 'SIGTERM', cancelled: false }).status).toBe('failure');
  });
});
```

- [ ] **Step 2: Implement helpers**

```typescript
// editors/vscode/src/knit/pandoc-engine-helpers.ts
import * as path from 'path';

export interface TempPathOpts { pid: number; rand: string; }

export function chooseTempPath(destPath: string, opts: TempPathOpts): string {
  const dir = path.dirname(destPath);
  const base = path.basename(destPath);
  return path.join(dir, `.${base}.${opts.pid}.${opts.rand}.tmp`);
}

export interface ExitInput {
  code: number | null;
  signal: NodeJS.Signals | null;
  cancelled: boolean;
}
export type ExitResult =
  | { status: 'success' }
  | { status: 'cancelled' }
  | { status: 'failure' };

export function interpretExitResult(input: ExitInput): ExitResult {
  if (input.cancelled) return { status: 'cancelled' };
  if (input.code === 0) return { status: 'success' };
  return { status: 'failure' };
}
```

- [ ] **Step 3: Run unit tests**

```bash
bun test editors/vscode/src/knit/pandoc-engine-helpers.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 4: Implement the engine** (no unit tests at this layer; covered by integration tests)

```typescript
// editors/vscode/src/knit/pandoc-engine.ts
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { OutputChannel } from 'vscode';
import type { OperationController } from './operation-controller';
import { chooseTempPath, interpretExitResult } from './pandoc-engine-helpers';

export interface PandocConvertOpts {
  pandocPath: string;
  /** Args from buildPandocArgs, except mdPath and -o args, which we add here so we can substitute the tmp output path. */
  args: string[];
  mdPath: string;
  destPath: string;
  /** Pandoc cwd — MUST be the directory containing mdPath. */
  cwd: string;
  /** SIGINT → SIGTERM → SIGKILL hard deadline. */
  timeoutMs: number;
  controller: OperationController;
  output: OutputChannel;
}

export interface PandocConvertResult {
  status: 'success' | 'cancelled' | 'failure';
  stderr: string;
}

export async function pandocConvert(opts: PandocConvertOpts): Promise<PandocConvertResult> {
  const rand = crypto.randomBytes(6).toString('hex');
  const tmpOut = chooseTempPath(opts.destPath, { pid: process.pid, rand });

  // Replace any existing '-o <path>' in opts.args (we already strip it client-side, but guard).
  const args: string[] = [];
  for (let i = 0; i < opts.args.length; i++) {
    if (opts.args[i] === '-o') { i++; continue; }
    args.push(opts.args[i]);
  }
  args.push('-o', tmpOut);

  return new Promise<PandocConvertResult>((resolve) => {
    const child = child_process.spawn(opts.pandocPath, args, { cwd: opts.cwd });
    let stderr = '';
    let killTimer: NodeJS.Timeout | null = null;
    let termTimer: NodeJS.Timeout | null = null;
    let cancelled = false;

    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      if (termTimer) clearTimeout(termTimer);
    };

    const escalate = () => {
      try { child.kill('SIGINT'); } catch { /* ignore */ }
      termTimer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, 1500);
      }, 1500);
    };

    const cancelTimer = setInterval(() => {
      if (opts.controller.cancelled && !cancelled) {
        cancelled = true;
        escalate();
        clearInterval(cancelTimer);
      }
    }, 100);

    const hardDeadline = setTimeout(() => {
      cancelled = true;
      escalate();
    }, opts.timeoutMs);

    child.stderr?.on('data', (buf: Buffer) => {
      const text = buf.toString();
      stderr += text;
      opts.output.append(`[pandoc] ${text}`);
    });

    child.on('close', async (code, signal) => {
      clearInterval(cancelTimer);
      clearTimeout(hardDeadline);
      cleanup();

      const exit = interpretExitResult({ code, signal, cancelled });
      if (exit.status === 'success') {
        try {
          await fs.promises.rename(tmpOut, opts.destPath);
        } catch (err) {
          // Cross-device rename fallback: copy then unlink.
          try {
            await fs.promises.copyFile(tmpOut, opts.destPath);
            await fs.promises.unlink(tmpOut);
          } catch (err2) {
            opts.output.appendLine(`[pandoc] Failed to finalize ${opts.destPath}: ${(err2 as Error).message}`);
            resolve({ status: 'failure', stderr });
            return;
          }
        }
        resolve({ status: 'success', stderr });
      } else {
        // Clean up the temp file; leave the prior destination intact.
        try { await fs.promises.unlink(tmpOut); } catch { /* ignore */ }
        resolve({ status: exit.status, stderr });
      }
    });
  });
}
```

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/src/knit/pandoc-engine.ts editors/vscode/src/knit/pandoc-engine-helpers.ts editors/vscode/src/knit/pandoc-engine-helpers.test.ts
git commit -m "feat(knit): pandoc-engine with temp-then-rename + signal escalation"
```

---

## Phase 7 — Webview trust boundary

### Task 7.1: Per-type exact-schema validation, add requestExport/cancelExport

**Files:**
- Modify: `editors/vscode/src/knit/knit-output.ts` (KnitOutputMessage union + isKnitOutputMessage)
- Test: `editors/vscode/src/test/knit-trust-boundary.test.ts`

- [ ] **Step 1: Inspect existing `KnitOutputMessage` and `isKnitOutputMessage`**

```bash
grep -n "KnitOutputMessage\|isKnitOutputMessage" editors/vscode/src/knit/knit-output.ts | head -20
```

- [ ] **Step 2: Write integration test for the trust boundary**

```typescript
// editors/vscode/src/test/knit-trust-boundary.test.ts
import * as assert from 'assert';
import { isKnitOutputMessage } from '../knit/knit-output';

suite('Knit webview trust boundary', () => {
  test('accepts {type: refresh}', () => {
    assert.strictEqual(isKnitOutputMessage({ type: 'refresh' }), true);
  });
  test('rejects {type: refresh, x: 1}', () => {
    assert.strictEqual(isKnitOutputMessage({ type: 'refresh', x: 1 }), false);
  });
  test('accepts {type: requestExport}', () => {
    assert.strictEqual(isKnitOutputMessage({ type: 'requestExport' }), true);
  });
  test('rejects {type: requestExport, format: "../etc/passwd"}', () => {
    assert.strictEqual(isKnitOutputMessage({ type: 'requestExport', format: '../etc/passwd' }), false);
  });
  test('accepts {type: cancelExport}', () => {
    assert.strictEqual(isKnitOutputMessage({ type: 'cancelExport' }), true);
  });
  test('accepts {type: themeChanged, applied: true}', () => {
    assert.strictEqual(isKnitOutputMessage({ type: 'themeChanged', applied: true }), true);
  });
  test('rejects {type: themeChanged} with missing applied', () => {
    assert.strictEqual(isKnitOutputMessage({ type: 'themeChanged' }), false);
  });
  test('accepts {type: themeContext, editorBackground: "#fff"}', () => {
    assert.strictEqual(isKnitOutputMessage({ type: 'themeContext', editorBackground: '#fff' }), true);
  });
  test('rejects unknown type', () => {
    assert.strictEqual(isKnitOutputMessage({ type: 'nope' }), false);
  });
});
```

- [ ] **Step 3: Update the KnitOutputMessage union and validator**

In `editors/vscode/src/knit/knit-output.ts`, find the `KnitOutputMessage` union at the top of the file. Replace it with:

```typescript
export type KnitOutputMessage =
  | { type: 'refresh' }
  | { type: 'openInBrowser' }
  | { type: 'themeChanged'; applied: boolean }
  | { type: 'themeContext'; editorBackground: string }
  | { type: 'requestPalette' }
  | { type: 'requestFonts' }
  | { type: 'requestExport' }
  | { type: 'cancelExport' };

const MESSAGE_SCHEMAS: Record<KnitOutputMessage['type'], readonly string[]> = {
  refresh: ['type'],
  openInBrowser: ['type'],
  themeChanged: ['applied', 'type'],
  themeContext: ['editorBackground', 'type'],
  requestPalette: ['type'],
  requestFonts: ['type'],
  requestExport: ['type'],
  cancelExport: ['type'],
};

export function isKnitOutputMessage(value: unknown): value is KnitOutputMessage {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== 'string') return false;
  const expected = MESSAGE_SCHEMAS[obj.type as KnitOutputMessage['type']];
  if (!expected) return false;
  const actual = Object.keys(obj).sort();
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) return false;
  }
  // Per-type value checks for non-`type` fields:
  if (obj.type === 'themeChanged' && typeof obj.applied !== 'boolean') return false;
  if (obj.type === 'themeContext' && typeof obj.editorBackground !== 'string') return false;
  return true;
}
```

- [ ] **Step 4: Run the integration test**

```bash
cd editors/vscode && bun run test -- --grep "Knit webview trust boundary"
```

Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/src/knit/knit-output.ts editors/vscode/src/test/knit-trust-boundary.test.ts
git commit -m "feat(knit): per-type exact-schema validation; add requestExport/cancelExport"
```

---

## Phase 8 — Drop the YAML gate, keep other blockers

### Task 8.1: Remove the `non-html-format` blocker code path

**Files:**
- Modify: `editors/vscode/src/knit/yaml-frontmatter.ts`
- Modify: `editors/vscode/src/knit/knit-commands.ts`
- Rename: `editors/vscode/src/test/knit-html-only.test.ts` → `knit-yaml-output-ignored.test.ts` (update assertions)

- [ ] **Step 1: Remove `'non-html-format'` from `BlockerKind`**

In `yaml-frontmatter.ts:23`, change:

```typescript
export type BlockerKind = 'knit-hook' | 'shiny' | 'site' | 'non-html-format';
```

to:

```typescript
export type BlockerKind = 'knit-hook' | 'shiny' | 'site';
```

- [ ] **Step 2: Find and remove `buildNonHtmlFormatBlocker` from `knit-commands.ts`**

```bash
grep -n "buildNonHtmlFormatBlocker\|non-html-format\|isSupportedHtmlFormat" editors/vscode/src/knit/knit-commands.ts
```

Delete the entire `buildNonHtmlFormatBlocker` function and any branch that calls it. The replacement: every `.Rmd` proceeds to knit regardless of the YAML `output:` format. Also remove the `isSupportedHtmlFormat` import (the function itself stays in `yaml-frontmatter.ts` for now — it's used by `parseOutputOptions` via `HTML_FORMATS`).

- [ ] **Step 3: Rename the test file**

```bash
git mv editors/vscode/src/test/knit-html-only.test.ts editors/vscode/src/test/knit-yaml-output-ignored.test.ts
```

- [ ] **Step 4: Rewrite the test assertions**

Replace the file with assertions that exercise the new behavior: a `.Rmd` with `output: pdf_document` (or `word_document`, or `bookdown::pdf_document2`) starts the R subprocess (the gate is gone). The Pandoc step doesn't run during preview. Concretely:

```typescript
// editors/vscode/src/test/knit-yaml-output-ignored.test.ts
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerKnitCommands } from '../knit/knit-commands';
import { fixturePath, openFixtureRmd, makeStubDeps } from './helpers/knit-test-utils';

suite('YAML output field is ignored for preview', () => {
  test('output: pdf_document still launches knit', async () => {
    const { context, deps, runKnitCalls } = makeStubDeps();
    registerKnitCommands(context, deps);
    const uri = await openFixtureRmd('output-pdf-document.Rmd');
    await vscode.commands.executeCommand('raven.knit', uri);
    assert.strictEqual(runKnitCalls.length, 1, 'knit subprocess should be launched');
  });
  test('output: word_document still launches knit', async () => {
    const { context, deps, runKnitCalls } = makeStubDeps();
    registerKnitCommands(context, deps);
    const uri = await openFixtureRmd('output-word-document.Rmd');
    await vscode.commands.executeCommand('raven.knit', uri);
    assert.strictEqual(runKnitCalls.length, 1);
  });
});
```

(`makeStubDeps()` and `openFixtureRmd` patterns already exist in the repo — see existing test helpers for the exact import paths.)

Add the two fixtures under `editors/vscode/src/test/fixtures/`:
- `output-pdf-document.Rmd`: minimal `---\noutput: pdf_document\n---\n\n# Hello`
- `output-word-document.Rmd`: same with `word_document`.

- [ ] **Step 5: Run, ensure pass**

```bash
cd editors/vscode && bun run test -- --grep "YAML output field is ignored"
```

- [ ] **Step 6: Commit**

```bash
git add editors/vscode/src/knit/yaml-frontmatter.ts editors/vscode/src/knit/knit-commands.ts editors/vscode/src/test/knit-yaml-output-ignored.test.ts editors/vscode/src/test/fixtures/output-pdf-document.Rmd editors/vscode/src/test/fixtures/output-word-document.Rmd
git commit -m "feat(knit): drop YAML output gate; all formats preview as HTML"
```

---

## Phase 9 — Update buildKnitExpression to set fig.path + chunk opts

### Task 9.1: Extend `buildKnitExpression` to inject base.dir, fig.path, chunk opts

**Files:**
- Modify: `editors/vscode/src/knit/r-expression.ts`
- Modify or new: `editors/vscode/src/knit/r-expression.test.ts` (existing tests may need updates; add new ones)

- [ ] **Step 1: Add tests for the extended buildKnitExpression**

Find existing test file:

```bash
ls editors/vscode/src/knit/r-expression.test.ts 2>/dev/null && echo EXISTS || echo MISSING
```

If missing, create. Append tests:

```typescript
import { describe, it, expect } from 'bun:test';
import { buildKnitExpression } from './r-expression';

describe('buildKnitExpression with chunk opts', () => {
  it('emits opts_chunk$set for known chunk keys', () => {
    const expr = buildKnitExpression({
      filePath: '/p/foo.Rmd',
      outputPath: '/tmp/foo.md',
      format: 'html_document',
      knitRootDir: null,
      baseDir: '/tmp',
      figPath: 'figure/',
      chunkOpts: { fig_width: 5, fig_height: 4, dpi: 150, dev: 'png' },
    });
    expect(expr).toContain('opts_chunk$set');
    expect(expr).toContain('fig.width = 5');
    expect(expr).toContain('fig.height = 4');
    expect(expr).toContain('dpi = 150L');
    expect(expr).toContain("dev = 'png'");
  });

  it('emits opts_knit$set with base.dir and fig.path', () => {
    const expr = buildKnitExpression({
      filePath: '/p/foo.Rmd',
      outputPath: '/tmp/foo.md',
      format: 'html_document',
      knitRootDir: '/p',
      baseDir: '/tmp/preview',
      figPath: 'figure/',
      chunkOpts: {},
    });
    expect(expr).toContain("base.dir = '/tmp/preview'");
    expect(expr).toContain("fig.path = 'figure/'");
    expect(expr).toContain("root.dir = '/p'");
  });

  it('omits opts_chunk$set when chunkOpts is empty', () => {
    const expr = buildKnitExpression({
      filePath: '/p/foo.Rmd',
      outputPath: '/tmp/foo.md',
      format: 'html_document',
      knitRootDir: null,
      baseDir: '/tmp',
      figPath: 'figure/',
      chunkOpts: {},
    });
    expect(expr).not.toContain('opts_chunk$set');
  });

  it('escapes dev value', () => {
    expect(() =>
      buildKnitExpression({
        filePath: '/p/foo.Rmd',
        outputPath: '/tmp/foo.md',
        format: 'html_document',
        knitRootDir: null,
        baseDir: '/tmp',
        figPath: 'figure/',
        chunkOpts: { dev: "png'; system('rm -rf /')" } as any,
      })
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run, fail.**

```bash
bun test editors/vscode/src/knit/r-expression.test.ts
```

- [ ] **Step 3: Update `buildKnitExpression`**

In `editors/vscode/src/knit/r-expression.ts`, locate `buildKnitExpression` (around line 165). Replace the input interface and function with:

```typescript
import type { ChunkOpts } from './output-options';

export interface KnitExpressionInput {
  filePath: string;
  outputPath: string;
  format: string;
  knitRootDir: string | null;
  /** Base directory for knitr output (figures land relative to this dir). */
  baseDir: string;
  /** Relative path within baseDir where figures go, e.g. 'figure/'. */
  figPath: string;
  /** Chunk options to inject via opts_chunk$set. */
  chunkOpts: ChunkOpts;
}

const DEV_ALLOWLIST = new Set(['png', 'pdf', 'svg', 'jpeg', 'cairo_pdf']);

export function buildKnitExpression(input: KnitExpressionInput): string {
  validatePathForRExpression(input.filePath);
  validatePathForRExpression(input.outputPath);
  validatePathForRExpression(input.baseDir);
  validatePathForRExpression(input.figPath);
  validateFormatIdentifier(input.format);
  if (input.knitRootDir !== null) validatePathForRExpression(input.knitRootDir);
  if (input.chunkOpts.dev !== undefined && !DEV_ALLOWLIST.has(input.chunkOpts.dev)) {
    throw new ValidatePathError(`Chunk dev value not in allowlist: ${input.chunkOpts.dev}`);
  }

  const rootDirLiteral = input.knitRootDir !== null ? escapeRString(input.knitRootDir) : 'getwd()';
  const inputLit = escapeRString(input.filePath);
  const outputLit = escapeRString(input.outputPath);
  const baseDirLit = escapeRString(input.baseDir);
  const figPathLit = escapeRString(input.figPath);

  const chunkParts: string[] = [];
  const co = input.chunkOpts;
  if (co.fig_width !== undefined) chunkParts.push(`fig.width = ${co.fig_width}`);
  if (co.fig_height !== undefined) chunkParts.push(`fig.height = ${co.fig_height}`);
  if (co.fig_retina !== undefined) chunkParts.push(`fig.retina = ${co.fig_retina}`);
  if (co.dpi !== undefined) chunkParts.push(`dpi = ${Math.trunc(co.dpi)}L`);
  if (co.dev !== undefined) chunkParts.push(`dev = ${escapeRString(co.dev)}`);

  const optsChunk = chunkParts.length > 0
    ? ` knitr::opts_chunk$set(${chunkParts.join(', ')});`
    : '';

  return [
    'local({',
    ` knitr::opts_knit$set(root.dir = ${rootDirLiteral}, base.dir = ${baseDirLit});`,
    ` knitr::opts_chunk$set(fig.path = ${figPathLit});`,
    optsChunk,
    ` out <- knitr::knit(`,
    `input = ${inputLit},`,
    ` output = ${outputLit},`,
    ` envir = new.env(),`,
    ` quiet = TRUE);`,
    ` cat('Output created: ', out, '\\n', sep = '')`,
    ' })',
  ].join('');
}
```

- [ ] **Step 4: Run all r-expression tests**

```bash
bun test editors/vscode/src/knit/r-expression.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/src/knit/r-expression.ts editors/vscode/src/knit/r-expression.test.ts
git commit -m "feat(knit): extend buildKnitExpression with base.dir, fig.path, opts_chunk\$set"
```

---

## Phase 10 — Shared open-exported-file helper

### Task 10.1: Extract openExportedFile with remote fallback

**Files:**
- Create: `editors/vscode/src/knit/open-exported-file.ts`
- Modify: `editors/vscode/src/knit/knit-output-panel.ts` (have `openInBrowser` delegate to it)

- [ ] **Step 1: Create the module**

```typescript
// editors/vscode/src/knit/open-exported-file.ts
import * as path from 'path';
import * as vscode from 'vscode';

export type ExportFormat = 'html' | 'pdf' | 'docx';

const LABELS: Record<ExportFormat, string> = {
  html: 'Open in Browser',
  pdf: 'View PDF',
  docx: 'Open in Word',
};

export async function openExportedFile(
  savedUri: vscode.Uri,
  format: ExportFormat,
  output: vscode.OutputChannel,
  options: { showSavedToast?: boolean } = { showSavedToast: true },
): Promise<void> {
  const label = LABELS[format];
  let action: string | undefined;
  if (options.showSavedToast !== false) {
    action = await vscode.window.showInformationMessage(`Saved ${path.basename(savedUri.fsPath)}`, label);
    if (action !== label) return;
  }

  let opened = false;
  try {
    opened = await vscode.env.openExternal(savedUri);
  } catch (err) {
    output.appendLine(`[Export] openExternal threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (opened) return;
  output.appendLine(`[Export] file:// did not open. Output is at: ${savedUri.fsPath}`);
  void vscode.window.showWarningMessage(
    `${label} is not available for this workspace. The file path has been written to the Raven: Knit output channel.`,
  );
}
```

- [ ] **Step 2: Update `openInBrowser` in `knit-output-panel.ts` to delegate**

```bash
grep -n "export async function openInBrowser" editors/vscode/src/knit/knit-output-panel.ts
```

Replace the body with:

```typescript
export async function openInBrowser(outputPath: string, output: vscode.OutputChannel): Promise<void> {
  const { openExportedFile } = await import('./open-exported-file');
  await openExportedFile(vscode.Uri.file(outputPath), 'html', output, { showSavedToast: false });
}
```

(Dynamic import keeps the existing module-load order. If the static import resolves cleanly, prefer that — verify by running the existing knit panel test suite afterward.)

- [ ] **Step 3: Run the existing knit-output-panel tests to make sure nothing regresses**

```bash
cd editors/vscode && bun run test -- --grep "Knit output panel"
```

- [ ] **Step 4: Commit**

```bash
git add editors/vscode/src/knit/open-exported-file.ts editors/vscode/src/knit/knit-output-panel.ts
git commit -m "feat(knit): shared openExportedFile helper with remote-workspace fallback"
```

---

## Phase 11 — Migrate knit pipeline to temp dirs + session id

### Task 11.1: Session id + activation orphan sweep in extension.ts

**Files:**
- Modify: `editors/vscode/src/extension.ts`

- [ ] **Step 1: Find the activate function**

```bash
grep -n "export function activate\|export async function activate\|export function deactivate" editors/vscode/src/extension.ts | head -10
```

- [ ] **Step 2: Add session-id init and orphan sweep**

In `extension.ts`, near the top of `activate(context)`:

```typescript
import * as crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';
import { sweepStaleSessions, initSessionState } from './knit/session-state';
```

After existing init code, before knit command registration:

```typescript
const sessionId = crypto.randomUUID();
initSessionState({
  sessionId,
  workspaceUri:
    vscode.workspace.workspaceFolders?.[0]?.uri.toString()
    ?? vscode.workspace.workspaceFile?.toString()
    ?? null,
});
// Sweep stale (>7d) sessions on activation; non-blocking.
void sweepStaleSessions(path.join(os.tmpdir(), 'raven-knit')).catch(() => {});
```

In `deactivate`, add:

```typescript
import { cleanupCurrentSession } from './knit/session-state';
// ... existing code ...
await cleanupCurrentSession();
```

- [ ] **Step 3: Create `session-state.ts`**

```typescript
// editors/vscode/src/knit/session-state.ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { computeWorkspaceHash, sessionRoot } from './raven-knit-paths';

interface SessionState {
  sessionId: string;
  workspaceHash: string;
}

let state: SessionState | null = null;

export function initSessionState(opts: { sessionId: string; workspaceUri: string | null }): void {
  const workspaceHash = computeWorkspaceHash(opts.workspaceUri ?? 'no-workspace');
  state = { sessionId: opts.sessionId, workspaceHash };
}

export function currentSession(): SessionState {
  if (!state) throw new Error('Session state not initialized');
  return state;
}

export async function cleanupCurrentSession(): Promise<void> {
  if (!state) return;
  const root = sessionRoot(state.workspaceHash, state.sessionId);
  try { await fs.promises.rm(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

export async function sweepStaleSessions(ravenKnitRoot: string, maxAgeMs = 7 * 24 * 3600 * 1000): Promise<void> {
  let workspaceDirs: string[];
  try { workspaceDirs = await fs.promises.readdir(ravenKnitRoot); } catch { return; }
  const now = Date.now();
  for (const wd of workspaceDirs) {
    const wdPath = path.join(ravenKnitRoot, wd);
    let sessions: string[];
    try { sessions = await fs.promises.readdir(wdPath); } catch { continue; }
    for (const session of sessions) {
      const sPath = path.join(wdPath, session);
      try {
        const stat = await fs.promises.stat(sPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          await fs.promises.rm(sPath, { recursive: true, force: true });
        }
      } catch { /* ignore */ }
    }
  }
}
```

- [ ] **Step 4: Build the extension to verify compile**

```bash
cd editors/vscode && bun run build
```

Expected: success.

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/src/extension.ts editors/vscode/src/knit/session-state.ts
git commit -m "feat(knit): session-id init + stale-session sweep at activation"
```

### Task 11.2: Route knit output paths to per-session temp dir

**Files:**
- Modify: `editors/vscode/src/knit/knit-paths.ts` (delegate to raven-knit-paths)
- Modify: `editors/vscode/src/knit/knit-commands.ts` (use new temp paths)
- Modify: `editors/vscode/src/knit/post-knit-renderer.ts` (consume new html path)

- [ ] **Step 1: Add new path-derivation helpers**

In `editors/vscode/src/knit/raven-knit-paths.ts`, append:

```typescript
import { currentSession } from './session-state';

export function previewArtifactPaths(rmdAbsPath: string): { previewDir: string; mdPath: string; htmlPath: string; figDir: string; previewKey: string } {
  const { workspaceHash, sessionId } = currentSession();
  const sourceHash = computeSourceHash(rmdAbsPath);
  const previewDir = previewDirFor(workspaceHash, sessionId, sourceHash);
  const baseName = require('path').basename(rmdAbsPath).replace(/\.[Rr][Mm][Dd]$/, '');
  return {
    previewDir,
    mdPath: require('path').join(previewDir, `${baseName}.md`),
    htmlPath: require('path').join(previewDir, `${baseName}.html`),
    figDir: require('path').join(previewDir, 'figure'),
    previewKey: sourceHash,
  };
}
```

(Resolve the `require` to a real `import` if linting forbids it.)

- [ ] **Step 2: Have `knit-paths.ts` delegate**

Replace the contents of `editors/vscode/src/knit/knit-paths.ts`:

```typescript
import { previewArtifactPaths } from './raven-knit-paths';

/** Deprecated — use raven-knit-paths.previewArtifactPaths. Kept for one release. */
export function computeMdOutputPath(rmdFsPath: string): string {
  return previewArtifactPaths(rmdFsPath).mdPath;
}

export function computeHtmlOutputPath(rmdFsPath: string): string {
  return previewArtifactPaths(rmdFsPath).htmlPath;
}
```

- [ ] **Step 3: Run knit-paths consumers' existing tests, fix what breaks**

```bash
cd editors/vscode && bun run test -- --grep "Knit"
```

Many tests will fail because they expect source-dir outputs. Update them: import `previewArtifactPaths` and assert against the temp paths instead. See `knit-output-panel.test.ts` lines that pattern-match output paths.

For each existing test that fails due to path expectations, update the assertion to use `previewArtifactPaths(rmdPath).{mdPath,htmlPath}` or to assert the path starts with the per-session temp root.

- [ ] **Step 4: Ensure the preview dir is created before the knit subprocess starts**

In `editors/vscode/src/knit/knit-commands.ts`, where the knit invocation is prepared, add `await fs.promises.mkdir(previewDir, { recursive: true });` before computing the R expression.

- [ ] **Step 5: Run, ensure pass**

```bash
cd editors/vscode && bun run test
```

- [ ] **Step 6: Commit**

```bash
git add editors/vscode/src/knit/raven-knit-paths.ts editors/vscode/src/knit/knit-paths.ts editors/vscode/src/knit/knit-commands.ts editors/vscode/src/test/
git commit -m "feat(knit): preview artifacts written to per-session temp dir"
```

---

## Phase 12 — Replace inFlight Set with OperationRegistry

### Task 12.1: Wire OperationRegistry into knit-commands

**Files:**
- Modify: `editors/vscode/src/knit/knit-commands.ts`

- [ ] **Step 1: Replace `const inFlight = new Set<string>()` near line 85**

```typescript
import { OperationRegistry } from './operation-controller';
import { canonicalOpKey } from './raven-knit-paths';
// ...
const registry = new OperationRegistry();
```

- [ ] **Step 2: Convert `runKnitCommand` to use registry**

Find every occurrence of `inFlight.add(...)`, `inFlight.delete(...)`, `inFlight.has(...)` and replace:

- `inFlight.has(fsPath)` → `registry.current(canonicalOpKey({ fsPath })) !== undefined`
- `inFlight.add(fsPath)` → handled by `registry.beginOp(...)` BEFORE any `await`
- `inFlight.delete(fsPath)` → handled by `registry.endOp(controller, 'done' | 'cancelled')` in `finally`

The pattern at the top of `runKnitCommand`:

```typescript
const key = canonicalOpKey(uri);
const begin = registry.beginOp(key, 'knit-preview');
if (begin.kind === 'busy') {
  await offerCancelAndRetryToast(begin.existing, uri, ...);
  return;
}
const controller = begin.controller;
try {
  controller.updatePhase('knitting');
  // ... existing knit code ...
  controller.updatePhase('finalizing');
  await runPostKnitRender(...);
  registry.endOp(controller, 'done');
} catch (err) {
  registry.endOp(controller, controller.cancelled ? 'cancelled' : 'done');
  throw err;
}
```

Add `offerCancelAndRetryToast` as a private helper in the same file:

```typescript
async function offerCancelAndRetryToast(
  existing: OperationController,
  uri: vscode.Uri,
  retry: () => Promise<void>,
): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    `A ${humanizeOpKind(existing.kind)} is in progress for ${path.basename(uri.fsPath)}.`,
    'Cancel and retry',
    'Wait',
  );
  if (choice === 'Cancel and retry') {
    existing.cancel();
    // Wait briefly for the in-flight op to settle; bail if it doesn't.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!existing.cancelled || existing.phase === 'cancelled' || existing.phase === 'done') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await retry();
  }
}

function humanizeOpKind(kind: OpKind): string {
  switch (kind) {
    case 'knit-preview': return 'knit';
    case 'export-html': return 'HTML export';
    case 'export-pdf': return 'PDF export';
    case 'export-docx': return 'Word export';
    case 'knit-then-export': return 'knit-then-export';
  }
}
```

- [ ] **Step 3: Wire the registry to the panel's progress-callback so the webview button state can react**

After creating the controller, register a broadcast listener that posts a panel message:

```typescript
controller.broadcast = (phase) => {
  KnitOutputPanel.broadcastOpPhase(uri, kind, phase);
};
```

Add `broadcastOpPhase(uri, kind, phase)` as a static method on `KnitOutputPanel` that looks up the per-source panel from the registry and `postMessage({ type: 'opPhase', kind, phase })` (this requires extending `KnitOutputMessage` from the host→webview side, which is the separate posted-message channel — not the same as `isKnitOutputMessage`'s webview→host validation). See `knit-output-panel.ts` for the existing post pattern.

- [ ] **Step 4: Build, run tests**

```bash
cd editors/vscode && bun run build && bun run test
```

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/src/knit/knit-commands.ts editors/vscode/src/knit/knit-output-panel.ts
git commit -m "feat(knit): replace inFlight Set with OperationRegistry; cancel-and-retry toast"
```

---

## Phase 13 — Webview Export button + cancellation

### Task 13.1: Add Export ▾ button to the toolbar

**Files:**
- Modify: `editors/vscode/src/knit/knit-output.ts` (buildShellHtml or equivalent)

- [ ] **Step 1: Find the toolbar markup**

```bash
grep -n "raven-knit-refresh\|raven-knit-open-browser\|raven-knit-theme" editors/vscode/src/knit/knit-output.ts | head -10
```

- [ ] **Step 2: Add the Export button + spinner state**

In the toolbar HTML, after the Open in Browser button and before the theme toggle, insert:

```html
<button id="raven-knit-export" type="button" class="raven-toolbar-btn">Export ▾</button>
```

Add a CSS class `.raven-toolbar-btn[data-busy="true"]` that shows a spinner glyph (CSS only, no JS framework).

- [ ] **Step 3: Wire the click**

In the webview script section:

```javascript
const exportBtn = document.getElementById('raven-knit-export');
exportBtn.addEventListener('click', () => {
  if (exportBtn.dataset.busy === 'true') {
    vscode.postMessage({ type: 'cancelExport' });
  } else {
    vscode.postMessage({ type: 'requestExport' });
  }
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg && msg.type === 'opPhase') {
    const isExportPhase = msg.kind && msg.kind.startsWith('export-');
    if (isExportPhase && (msg.phase === 'starting' || msg.phase === 'converting' || msg.phase === 'knitting' || msg.phase === 'finalizing')) {
      exportBtn.dataset.busy = 'true';
      exportBtn.title = 'Cancel current export';
    } else if (msg.phase === 'done' || msg.phase === 'cancelled') {
      delete exportBtn.dataset.busy;
      exportBtn.title = '';
    }
  }
});
```

- [ ] **Step 4: Compile**

```bash
cd editors/vscode && bun run build
```

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/src/knit/knit-output.ts
git commit -m "feat(knit): add Export ▾ button to webview toolbar with cancel state"
```

### Task 13.2: Handle requestExport in the panel (open native quickpick)

**Files:**
- Modify: `editors/vscode/src/knit/knit-output-panel.ts`

- [ ] **Step 1: Find the existing message handler**

```bash
grep -n "handleMessage\|onDidReceiveMessage\|isKnitOutputMessage" editors/vscode/src/knit/knit-output-panel.ts
```

- [ ] **Step 2: Add cases for requestExport and cancelExport**

In the message-dispatch switch:

```typescript
case 'requestExport': {
  await this.openExportQuickPick();
  break;
}
case 'cancelExport': {
  const op = registry.current(canonicalOpKey({ fsPath: this.sourcePath }));
  if (op && op.kind.startsWith('export-')) op.cancel();
  break;
}
```

Add `openExportQuickPick` as a method on the panel:

```typescript
private async openExportQuickPick(): Promise<void> {
  const items: vscode.QuickPickItem[] = [];
  if (this.previewIsStale()) {
    items.push({ label: '$(warning) Preview may be out of date — Knit again first?', detail: 'Runs knit then exports.' });
  }
  items.push(
    { label: '$(file-code) Export to HTML…', detail: 'Pandoc HTML' },
    { label: '$(file-pdf) Export to PDF…', detail: 'Pandoc PDF' },
    { label: '$(file) Export to Word…', detail: 'Pandoc DOCX' },
  );
  const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Export this preview' });
  if (!choice) return;
  if (choice.label.includes('out of date')) {
    await vscode.commands.executeCommand('raven.knit', vscode.Uri.file(this.sourcePath));
    // Then export to HTML by default; can refine.
    await vscode.commands.executeCommand('raven.knit.exportHtml', vscode.Uri.file(this.sourcePath));
    return;
  }
  if (choice.label.includes('HTML')) {
    await vscode.commands.executeCommand('raven.knit.exportHtml', vscode.Uri.file(this.sourcePath));
  } else if (choice.label.includes('PDF')) {
    await vscode.commands.executeCommand('raven.knit.exportPdf', vscode.Uri.file(this.sourcePath));
  } else if (choice.label.includes('Word')) {
    await vscode.commands.executeCommand('raven.knit.exportDocx', vscode.Uri.file(this.sourcePath));
  }
}

private previewIsStale(): boolean {
  // Best effort: check the in-memory TextDocument's isDirty, plus the on-disk mtime
  // against the cached .md's mtime. If we can't determine, return false.
  try {
    const docs = vscode.workspace.textDocuments;
    const doc = docs.find((d) => d.uri.fsPath === this.sourcePath);
    if (doc?.isDirty) return true;
    const { mdPath } = previewArtifactPaths(this.sourcePath);
    const srcStat = require('fs').statSync(this.sourcePath);
    const mdStat = require('fs').statSync(mdPath);
    return srcStat.mtimeMs > mdStat.mtimeMs;
  } catch {
    return false;
  }
}
```

- [ ] **Step 3: Build, run existing tests**

```bash
cd editors/vscode && bun run build && bun run test -- --grep "Knit output panel"
```

- [ ] **Step 4: Commit**

```bash
git add editors/vscode/src/knit/knit-output-panel.ts
git commit -m "feat(knit): wire requestExport/cancelExport in panel; open native quickpick"
```

---

## Phase 14 — Export command pipeline

### Task 14.1: registerExportCommands + shared runExport()

**Files:**
- Create: `editors/vscode/src/knit/export-commands.ts`
- Modify: `editors/vscode/src/extension.ts` to call registerExportCommands

- [ ] **Step 1: Create the export command module**

```typescript
// editors/vscode/src/knit/export-commands.ts
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { extractFrontmatter, parseFrontmatter } from './yaml-frontmatter';
import { parseOutputOptions, type TargetFormat } from './output-options';
import { buildPandocArgs } from './pandoc-args';
import { pandocConvert } from './pandoc-engine';
import { PandocResolver, PandocNotFoundError } from './pandoc-detect';
import { OperationRegistry } from './operation-controller';
import { canonicalOpKey, isUnderContainmentRoot, exportDirFor, previewArtifactPaths } from './raven-knit-paths';
import { currentSession } from './session-state';
import { openExportedFile } from './open-exported-file';

export interface ExportDeps {
  resolver: PandocResolver;
  registry: OperationRegistry;
  getOutput: () => vscode.OutputChannel;
  runKnit: (uri: vscode.Uri) => Promise<void>; // for editor-toolbar entries that re-knit
}

export function registerExportCommands(context: vscode.ExtensionContext, deps: ExportDeps): void {
  const register = (id: string, format: TargetFormat) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (uri?: vscode.Uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target) return;
        await runExport(target, format, deps, { entry: 'editor-toolbar' });
      }),
    );
  };
  register('raven.knit.exportHtml', 'html');
  register('raven.knit.exportPdf', 'pdf');
  register('raven.knit.exportDocx', 'docx');
}

export interface RunExportOpts {
  /** webview = reuse cached .md (Approach C); editor-toolbar = re-knit fresh. */
  entry: 'webview' | 'editor-toolbar';
}

export async function runExport(
  rmd: vscode.Uri,
  format: TargetFormat,
  deps: ExportDeps,
  opts: RunExportOpts,
): Promise<void> {
  const key = canonicalOpKey(rmd);
  const opKind = format === 'html' ? 'export-html' : format === 'pdf' ? 'export-pdf' : 'export-docx';
  const begin = deps.registry.beginOp(key, opKind);
  if (begin.kind === 'busy') {
    void vscode.window.showInformationMessage(
      `A ${begin.existing.kind} is in progress for ${path.basename(rmd.fsPath)}.`,
      'Wait',
    );
    return;
  }
  const controller = begin.controller;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, cancellable: true, title: `Exporting to ${format.toUpperCase()}…` },
    async (_progress, token) => {
      token.onCancellationRequested(() => controller.cancel());
      try {
        // Step 1: ensure we have a .md to feed Pandoc.
        const previewKey = path.basename(rmd.fsPath);
        let mdPath: string;
        let mdDir: string;
        const previewPaths = previewArtifactPaths(rmd.fsPath);
        if (opts.entry === 'webview') {
          if (!fs.existsSync(previewPaths.mdPath)) {
            void vscode.window.showWarningMessage('No cached preview. Knit first, then export.');
            return;
          }
          mdPath = previewPaths.mdPath;
          mdDir = previewPaths.previewDir;
          deps.registry.pinPreviewDir(previewPaths.previewKey);
        } else {
          controller.updatePhase('knitting');
          await deps.runKnit(rmd);
          mdPath = previewPaths.mdPath;
          mdDir = previewPaths.previewDir;
        }

        // Step 2: resolve Pandoc.
        controller.updatePhase('converting');
        let pandocBin: string;
        try {
          pandocBin = await deps.resolver.resolve();
        } catch (err) {
          if (err instanceof PandocNotFoundError) {
            await offerPandocInstall(deps.getOutput());
            return;
          }
          throw err;
        }

        // Step 3: build args + run Pandoc.
        const text = (await vscode.workspace.fs.readFile(rmd)).toString();
        const fmInner = extractFrontmatter(text) ?? '';
        const fmParse = parseFrontmatter(fmInner);
        const fm = fmParse.ok ? fmParse.value : {};
        const outOpts = parseOutputOptions(fm, format);

        // Surface ignored keys to the output channel.
        if (outOpts.ignored.length > 0) {
          for (const key of outOpts.ignored) {
            deps.getOutput().appendLine(`[knit] Ignored output: option '${key}'`);
          }
        }

        const sourceDir = path.dirname(rmd.fsPath);
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(rmd)?.uri.fsPath;
        const containmentRoot = workspaceFolder ?? sourceDir;
        const ext = format === 'docx' ? 'docx' : format;
        const destPath = path.join(sourceDir, path.basename(rmd.fsPath).replace(/\.[Rr][Mm][Dd]$/, '') + '.' + ext);

        const pdfEngine = vscode.workspace.getConfiguration('raven').get<string>('pandoc.pdfEngine', 'xelatex');
        const detailed = buildPandocArgs.detailed(outOpts, format, {
          mdPath, outPath: destPath, sourceDir, containmentRoot, pdfEngine,
        });
        if (detailed.droppedCss.length > 0) {
          for (const dropped of detailed.droppedCss) {
            deps.getOutput().appendLine(`[knit] CSS path outside containment root, dropped: '${dropped}'`);
          }
        }

        const timeoutMs = vscode.workspace.getConfiguration('raven').get<number>('knit.export.timeoutMs', 120_000);
        const result = await pandocConvert({
          pandocPath: pandocBin,
          args: detailed.args,
          mdPath, destPath, cwd: mdDir, timeoutMs,
          controller, output: deps.getOutput(),
        });

        controller.updatePhase('finalizing');
        if (result.status === 'success') {
          await openExportedFile(vscode.Uri.file(destPath), format, deps.getOutput());
        } else if (result.status === 'cancelled') {
          deps.getOutput().appendLine(`[Export] Cancelled.`);
        } else {
          await offerPandocFailure(format, result.stderr, deps.getOutput(), rmd);
        }
      } finally {
        if (opts.entry === 'webview') deps.registry.unpinPreviewDir(previewArtifactPaths(rmd.fsPath).previewKey);
        deps.registry.endOp(controller, controller.cancelled ? 'cancelled' : 'done');
      }
    },
  );
}

async function offerPandocInstall(output: vscode.OutputChannel): Promise<void> {
  const choice = await vscode.window.showErrorMessage(
    'Pandoc not found. Install it to export to PDF or Word.',
    'Install Pandoc…',
    'Set path…',
  );
  if (choice === 'Install Pandoc…') {
    void vscode.env.openExternal(vscode.Uri.parse('https://pandoc.org/installing.html'));
  } else if (choice === 'Set path…') {
    void vscode.commands.executeCommand('workbench.action.openSettings', '@id:raven.pandoc.path');
  }
}

async function offerPandocFailure(format: TargetFormat, stderr: string, output: vscode.OutputChannel, rmd: vscode.Uri): Promise<void> {
  output.appendLine(`[Export] Pandoc stderr:\n${stderr}`);
  if (format === 'pdf' && /(xelatex|pdflatex|lualatex|tectonic) not found/i.test(stderr)) {
    const choice = await vscode.window.showErrorMessage(
      'PDF export needs a LaTeX engine.',
      'Install TinyTeX…',
      'Show details',
    );
    if (choice === 'Install TinyTeX…') void vscode.env.openExternal(vscode.Uri.parse('https://yihui.org/tinytex/'));
    else if (choice === 'Show details') output.show(true);
    return;
  }
  const buttons = format === 'pdf' ? ['Show details', 'Try Word instead'] : ['Show details'];
  const choice = await vscode.window.showErrorMessage(`Export to ${format.toUpperCase()} failed.`, ...buttons);
  if (choice === 'Show details') output.show(true);
  else if (choice === 'Try Word instead') void vscode.commands.executeCommand('raven.knit.exportDocx', rmd);
}
```

- [ ] **Step 2: Register the commands in extension.ts**

```typescript
import { registerExportCommands } from './knit/export-commands';
import { PandocResolver } from './knit/pandoc-detect';
// ...inside activate():
const resolver = new PandocResolver({
  getConfigured: () => vscode.workspace.getConfiguration('raven').get('pandoc.path', ''),
  access: (p) => fs.promises.access(p, fs.constants.X_OK),
  spawn: (bin) => new Promise<string>((resolve, reject) => {
    const c = child_process.spawn(bin, ['--version']);
    let out = '';
    c.stdout.on('data', (d) => out += d.toString());
    c.on('close', (code) => code === 0 ? resolve(out.trim()) : reject(new Error('non-zero exit')));
    c.on('error', reject);
  }),
});
const output = vscode.window.createOutputChannel('Raven: Knit');
registerExportCommands(context, {
  resolver,
  registry: knitRegistry, // exported from knit-commands
  getOutput: () => output,
  runKnit: (uri) => vscode.commands.executeCommand('raven.knit', uri),
});

// Invalidate Pandoc cache on settings change:
context.subscriptions.push(
  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('raven.pandoc.path')) resolver.invalidate();
  }),
);
```

`knitRegistry` must be exported from `knit-commands.ts` (a module-level singleton).

- [ ] **Step 3: Build**

```bash
cd editors/vscode && bun run build
```

- [ ] **Step 4: Commit**

```bash
git add editors/vscode/src/knit/export-commands.ts editors/vscode/src/knit/knit-commands.ts editors/vscode/src/extension.ts
git commit -m "feat(knit): registerExportCommands with shared runExport pipeline"
```

---

## Phase 15 — package.json: commands, menus, settings

### Task 15.1: Add commands, menus, settings to package.json

**Files:**
- Modify: `editors/vscode/package.json`

- [ ] **Step 1: Find existing knit entries**

```bash
grep -n '"command": "raven.knit' editors/vscode/package.json
```

- [ ] **Step 2: Add the three new command entries**

In the `contributes.commands` array, after the existing `raven.knit.openOutputChannel` entry, add:

```json
{ "command": "raven.knit.exportHtml", "title": "Knit: Export to HTML…", "category": "Raven" },
{ "command": "raven.knit.exportPdf",  "title": "Knit: Export to PDF…",  "category": "Raven" },
{ "command": "raven.knit.exportDocx", "title": "Knit: Export to Word…", "category": "Raven" }
```

Rename the title of `raven.knit` from `"Knit"` to `"Knit Preview"`.

- [ ] **Step 3: Add menu entries**

In the `editor/title/run` section (around line 467), after the existing `raven.knit` entry, add:

```json
{ "command": "raven.knit.exportHtml", "group": "raven_knit@2", "when": "raven.rmdKnit.enabled && editorLangId == rmd && resourceExtname =~ /^\\.[Rr]md$/" },
{ "command": "raven.knit.exportPdf",  "group": "raven_knit@3", "when": "raven.rmdKnit.enabled && editorLangId == rmd && resourceExtname =~ /^\\.[Rr]md$/" },
{ "command": "raven.knit.exportDocx", "group": "raven_knit@4", "when": "raven.rmdKnit.enabled && editorLangId == rmd && resourceExtname =~ /^\\.[Rr]md$/" }
```

Update the existing `raven.knit` entry's group to `"raven_knit@1"`.

Similarly add Command Palette entries under `commandPalette`.

- [ ] **Step 4: Add settings**

In `contributes.configuration.properties`, add:

```json
"raven.pandoc.path": {
  "type": "string",
  "default": "",
  "scope": "machine-overridable",
  "description": "Absolute path to a Pandoc binary. Leave empty to use PATH plus standard install locations."
},
"raven.pandoc.pdfEngine": {
  "type": "string",
  "enum": ["xelatex", "pdflatex", "lualatex", "tectonic", "wkhtmltopdf"],
  "default": "xelatex",
  "description": "LaTeX engine used by Pandoc when exporting to PDF."
},
"raven.knit.export.timeoutMs": {
  "type": "integer",
  "default": 120000,
  "minimum": 5000,
  "description": "Timeout (in milliseconds) for the Pandoc subprocess during export."
}
```

- [ ] **Step 5: Update `editors/vscode/src/initializationOptions.ts`**

Add the three new settings to whatever forwarding helper lives there. Ensure the LSP doesn't actually consume them (they're TS-side); they may not need forwarding at all — read the existing pattern first.

```bash
grep -n "pandoc\|export" editors/vscode/src/initializationOptions.ts || echo "no existing pandoc keys"
```

If forwarding isn't needed, add a comment noting that these are TS-side settings only.

- [ ] **Step 6: Update SETTINGS_MAPPING in the settings test**

```bash
grep -n "SETTINGS_MAPPING" editors/vscode/src/test/settings.test.ts
```

If the test compares all `raven.*` keys against a mapping, add the new keys.

- [ ] **Step 7: Regenerate settings reference**

```bash
bun editors/vscode/scripts/generate-settings-reference.mjs
```

- [ ] **Step 8: Run, ensure pass**

```bash
cd editors/vscode && bun run build && bun run test -- --grep "settings"
bun test tests/bun/settings-reference.test.ts
```

- [ ] **Step 9: Commit**

```bash
git add editors/vscode/package.json editors/vscode/src/initializationOptions.ts editors/vscode/src/test/settings.test.ts docs/settings-reference.md 2>/dev/null
git commit -m "feat(knit): package.json commands, menus, settings for Knit Preview + Export"
```

---

## Phase 16 — Integration tests

For each new test file listed in the File Structure section, follow the same pattern:

1. Write the test file (skeleton + assertions).
2. Run, observe what's missing.
3. Fix the failing seam (most should pass given Phases 1-15 already implemented the surface).
4. Commit one test file per commit.

### Task 16.1: knit-export-html.test.ts

**Files:**
- Create: `editors/vscode/src/test/knit-export-html.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// editors/vscode/src/test/knit-export-html.test.ts
import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { isClaudeCodeSandbox } from './helper';

suite('knit export to HTML', function () {
  this.timeout(60_000);
  test('exports HTML next to the .Rmd', async function () {
    if (isClaudeCodeSandbox()) this.skip();
    // Open a fixture, run raven.knit, then raven.knit.exportHtml.
    const uri = vscode.Uri.file(path.join(__dirname, 'fixtures', 'export-html-fixture.Rmd'));
    await vscode.workspace.openTextDocument(uri);
    await vscode.commands.executeCommand('raven.knit', uri);
    await vscode.commands.executeCommand('raven.knit.exportHtml', uri);
    const expected = uri.fsPath.replace(/\.Rmd$/, '.html');
    assert.ok(fs.existsSync(expected), 'HTML export should land next to the .Rmd');
    fs.unlinkSync(expected);
  });
});
```

- [ ] **Step 2: Add the fixture**

```bash
cat > editors/vscode/src/test/fixtures/export-html-fixture.Rmd <<'EOF'
---
output: html_document
---

# Hello world
EOF
```

- [ ] **Step 3: Run** (sandbox-skipped — verify the test file at least compiles and reports skip)

```bash
cd editors/vscode && bun run test -- --grep "knit export to HTML"
```

- [ ] **Step 4: Commit**

```bash
git add editors/vscode/src/test/knit-export-html.test.ts editors/vscode/src/test/fixtures/export-html-fixture.Rmd
git commit -m "test(knit): export-to-HTML integration test"
```

### Task 16.2 through 16.18: remaining integration tests

For brevity, the remaining tests follow the same TDD pattern as 16.1. Implement each in sequence, committing one per file:

- `knit-export-pdf.test.ts` — same shape; mocks Pandoc subprocess to avoid LaTeX dep.
- `knit-export-docx.test.ts` — same shape.
- `knit-export-cancel.test.ts` — start an export, send cancellation, verify SIGINT delivered and destination untouched. Sandbox-skipped (requires signals).
- `knit-export-pandoc-missing.test.ts` — inject a `PandocResolver` whose `spawn` rejects ENOENT and `fallbacks` returns `[]`; assert the offer-install error message is shown (use `vscode.window.showErrorMessage` interception via test harness).
- `knit-export-yaml-args.test.ts` — fixture with `output.pdf_document.toc: true`; assert Pandoc args contain `--toc`. Use a fake `pandocConvert` that captures args.
- `knit-export-busy.test.ts` — start a fake long-running knit, fire export, assert the toast.
- `knit-temp-dir-cleanup.test.ts` — dispose the panel; assert the preview subdir is removed; assert the session dir survives.
- `knit-export-atomic.test.ts` — pre-place `<base>.docx`; cancel mid-Pandoc; assert original file intact, no `.tmp` orphans.
- `knit-export-pinning.test.ts` — close panel mid-export; assert temp dir survives until export ends, then cleaned.
- `knit-export-stale-figures.test.ts` — pre-place `figure/stale.png` next to .Rmd; assert export references temp `figure/`, not stale.
- `knit-export-pandoc-args-rejected.test.ts` — YAML with `pandoc_args: ['--output=/tmp/pwned']`; assert Pandoc args do NOT include those entries; assert ignored channel logs the key.
- `knit-export-yaml-merge.test.ts` — YAML with both `html_document:` and `pdf_document:` blocks; assert PDF export uses pdf_document's keys, not html_document's.
- `knit-export-remote-fallback.test.ts` — stub `vscode.env.openExternal` to return false; assert warning + output channel message.
- `knit-multi-root-isolation.test.ts` — two workspace folders, same-named .Rmd; assert their preview hashes differ.
- `knit-multi-window-isolation.test.ts` — simulate two sessions; assert `<sessionId>` subdirs isolate cleanup.
- `knit-op-registry-race.test.ts` — invoke `raven.knit.exportPdf` twice synchronously; assert one Pandoc call + busy toast.
- `knit-export-css-resolution.test.ts` — `style.css` next to .Rmd both with and without workspace; assert `../style.css` rejected.
- `knit-figpath-modes.test.ts` — knit under each `raven.knit.workingDirectory` mode; assert figures land in temp.

Each test file: write, run, commit.

---

## Phase 17 — Documentation

### Task 17.1: Update docs/knit.md, README.md, docs/coexistence.md, CLAUDE.md

**Files:**
- Modify: `docs/knit.md`
- Modify: `README.md`
- Modify: `docs/coexistence.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Rewrite docs/knit.md sections**

Replace the current "Output destinations" / "Refusal" sections with:

```markdown
## What Knit Preview does

`Raven: Knit Preview` renders the current `.Rmd` to HTML and shows it in
a side-by-side webview. Knitting runs in an R subprocess via
`knitr::knit`; no Pandoc is required for the preview.

## Where files go

Preview artifacts live in a per-VS-Code-session temp directory:

    <os.tmpdir()>/raven-knit/<workspaceHash>/<sessionId>/preview/<sourceHash>/
        <basename>.md
        <basename>.html
        figure/                  # knitr-generated plots

They are cleaned up when the panel is closed or when VS Code exits.

## Exporting

The webview's `Export ▾` button and the editor-title Raven menu both
expose `Export to HTML…`, `Export to PDF…`, and `Export to Word…`.
These shell out to Pandoc (resolved from PATH or `raven.pandoc.path`)
and save the result next to the `.Rmd` with the matching extension. PDF
export uses the engine configured at `raven.pandoc.pdfEngine` (default
`xelatex`).

## YAML output options

Raven honors a subset of the `output:` block's keys:

| Key | Where it's applied |
|---|---|
| `fig_width`, `fig_height`, `fig_retina`, `dpi`, `dev` | `knitr::opts_chunk$set` before knitting |
| `toc`, `toc_depth` | Pandoc `--toc` / `--toc-depth` |
| `number_sections` | Pandoc `--number-sections` |
| `highlight` | Pandoc `--highlight-style` (validated against Pandoc's known list) |
| `self_contained` | Pandoc `--embed-resources --standalone` |
| `css` | Pandoc `--css=<absolute path>` (containment-checked) |
| `mathjax` | Pandoc `--mathjax` |

Keys NOT honored: `theme`, `code_folding`, `df_print`, `code_download`,
`template`, `includes`, `pandoc_args`. They are logged to the
`Raven: Knit` output channel when present.
```

- [ ] **Step 2: README.md**

Update the Knit paragraph to mention export. ~3 sentences.

- [ ] **Step 3: docs/coexistence.md**

Add a paragraph noting that REditorSupport.R's `r.knitRmdToPdf` / `r.knitRmdToHtml` / `r.knitRmdToAll` work in parallel; the user picks.

- [ ] **Step 4: CLAUDE.md**

Add five invariants to the Knit pipeline section:

```markdown
- **Knit Preview temp layout** is `<os.tmpdir()>/raven-knit/<workspaceHash>/<sessionId>/preview|export/...`. Tests pin it; don't relocate without updating cleanup paths.
- **Webview Export reuses the cached `.md` unconditionally** (Approach C). Editor-toolbar Export always re-knits. Don't add hidden mtime checks; R chunks read external state the .Rmd mtime doesn't capture.
- **Preview temp dirs are refcounted** during in-flight exports. Panel disposal marks for deletion; actual removal waits for refcount → 0. Don't add a code path that removes the dir while an export references it.
- **`pandoc_args` from YAML is not honored.** A document could otherwise inject `--output`, `--lua-filter`, `--metadata-file`. Adding it later requires an explicit allowlist/blocklist.
- **Webview→host messages stay in the trust boundary.** Any new message type must be added to `KnitOutputMessage`, the `MESSAGE_SCHEMAS` map, and a regression test in the same commit.
```

- [ ] **Step 5: Commit**

```bash
git add docs/knit.md README.md docs/coexistence.md CLAUDE.md
git commit -m "docs(knit): rewrite knit.md for Knit Preview + export; add invariants to CLAUDE.md"
```

---

## Phase 18 — Final verification

### Task 18.1: Run the full test suite + build

- [ ] **Step 1: Bun unit tests**

```bash
bun test
```

Expected: PASS (all knit-module unit tests pass).

- [ ] **Step 2: VS Code build**

```bash
cd editors/vscode && bun run build
```

Expected: PASS.

- [ ] **Step 3: VS Code integration tests (full)**

```bash
cd editors/vscode && bun run test
```

Expected: PASS or skipped (sandbox-skipped tests report "skipped").

- [ ] **Step 4: Cargo tests for the Rust LSP** (just to confirm no incidental break)

```bash
cargo test -p raven --quiet
```

Expected: PASS.

- [ ] **Step 5: Final commit if any test-fixing edits needed**

If any test surfaced an issue, fix and commit.

```bash
git status
```

---

## Phase 19 — Codex review pass

### Task 19.1: Run Codex pass on the implementation diff

- [ ] **Step 1: Diff from main**

```bash
git diff main...HEAD --stat
```

- [ ] **Step 2: Invoke Codex via the codex:codex-rescue agent**

Use the codex:codex-rescue subagent and ask: "Review the implementation against the spec at docs/superpowers/specs/2026-05-23-knit-preview-export-design.md. Focus on: (1) all 5 CLAUDE.md invariants observed; (2) error paths; (3) any drift between spec wording and code."

- [ ] **Step 3: Address findings**

Implement fixes for any findings; commit each fix with a descriptive message.

- [ ] **Step 4: Re-run the full test suite after fixes**

```bash
bun test && cd editors/vscode && bun run build && bun run test
```

---

## Phase 20 — Open the PR

### Task 20.1: Push branch and create PR

- [ ] **Step 1: Push**

```bash
git push -u origin improve-knit-ux
```

- [ ] **Step 2: Create PR with `gh`**

```bash
gh pr create --title "feat(knit): Knit Preview + Pandoc export" --body "$(cat <<'EOF'
## Summary
- Renames `Knit` → `Knit Preview` (title only; command ID `raven.knit` stable)
- Moves intermediate artifacts (`.md`, `figure/`, `.html`) to per-session temp dirs
- Drops the YAML output-format gate (all `output:` formats preview as HTML)
- Adds three Pandoc-driven export commands (`Export to HTML/PDF/Word`) exposed both from the webview's new `Export ▾` button and from the editor-title Raven menu

Design: [docs/superpowers/specs/2026-05-23-knit-preview-export-design.md](./docs/superpowers/specs/2026-05-23-knit-preview-export-design.md) (approved by Codex on pass 5).
Plan: [docs/superpowers/specs/2026-05-23-knit-preview-export-plan.md](./docs/superpowers/specs/2026-05-23-knit-preview-export-plan.md).

## Test plan
- [ ] `bun test` (unit tests for `output-options`, `pandoc-args`, `pandoc-detect`, `operation-controller`, `raven-knit-paths`, `r-expression`, `pandoc-engine-helpers`)
- [ ] `cd editors/vscode && bun run test` (VS Code integration suite; sandbox-skipped tests report "skipped")
- [ ] `cargo test -p raven`
- [ ] Manual: knit a `.Rmd` with `output: pdf_document`; preview renders. Click `Export ▾` → PDF; verify `<basename>.pdf` lands next to .Rmd.
- [ ] Manual: with Pandoc not on PATH, click `Export to PDF`; verify the "Install Pandoc…" toast appears.
EOF
)"
```

- [ ] **Step 3: Wait for CI**

Monitor PR status; address feedback when received.

---

## Self-Review Notes

**Spec coverage:** Every section of the spec has corresponding tasks:

- §Architecture (preview/export pipelines, temp dirs, cleanup, refcount, cancel, conflicts) → Phases 1, 4, 9, 11, 12, 13, 14.
- §YAML handling (parsing, honored keys, ignored, merge precedence, CSS containment) → Phases 2, 3, 8.
- §Pandoc detection + invocation → Phases 5, 6.
- §Webview trust boundary + UI → Phases 7, 13.
- §Editor menu + commands + settings → Phase 15.
- §Tests (existing updates + 18 new files) → Phase 16.
- §Docs + invariants → Phase 17.

**Placeholder scan:** No "TBD", "TODO", or vague "implement later" steps. Each code-producing step shows the code; each test step shows the test.

**Type consistency:** `OutputOptions`, `OperationController`, `KnitOutputMessage`, `BeginOpResult`, `ExportFormat`, `TargetFormat`, `OpKind`, `OpPhase` are defined once each and referenced consistently across phases.

**Known abbreviations:** Phase 16 tasks 16.2–16.18 are summarized rather than spelled out in full because they follow the identical TDD pattern as 16.1. Each test file follows the shape "write, run, fix-seam-if-needed, commit"; the spec lists exactly what each test asserts.
