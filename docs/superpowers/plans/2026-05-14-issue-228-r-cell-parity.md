# Issue #228: `.R` cell-mode parity — active-cell indicator + RStudio section boundaries

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close two `.R` cell-mode UX gaps tracked in #228: (1) a cursor-tracking top/bottom border on the active cell (Jupyter-style), and (2) recognizing RStudio section headers (`# Title ====`, `# Setup ----`, `# Section #####`) as cell-end markers in `.R` files.

**Architecture:** Both items are frontend-only (VS Code extension TypeScript). Item 2 is a pure-function detector change in `editors/vscode/src/chunks/chunk-detector.ts` plus tests in `tests/bun/chunk-detector.test.ts`. Item 1 adds a new `ChunkActiveCellIndicator` collaborator in `editors/vscode/src/chunks/chunk-highlighting.ts`, wired to `vscode.window.onDidChangeTextEditorSelection`, with two new themable border colors and an opt-out setting.

**Tech Stack:** TypeScript, VS Code Extension API, `bun:test`.

---

## File Structure

- **Create:** none — both items extend existing files.
- **Modify:**
  - `editors/vscode/src/chunks/chunk-detector.ts` — extend `detect_r_cells` with section-divider boundary detection; export `SECTION_DIVIDER_RE` for tests.
  - `editors/vscode/src/chunks/chunk-highlighting.ts` — add `ChunkActiveCellIndicator` class, hook `onDidChangeTextEditorSelection`, expose `raven.chunks.activeCellIndicator` setting flow.
  - `editors/vscode/package.json` — declare two new theme colors (`raven.chunk.activeCellBorderTop`, `raven.chunk.activeCellBorderBottom`) and the `raven.chunks.activeCellIndicator` setting.
  - `tests/bun/chunk-detector.test.ts` — add section-divider tests.
  - `docs/chunks.md` — document the active-cell indicator and section-header boundary behavior.

## Reference (vscode-R)

- `vscode-R/src/rmarkdown/index.ts`, `highlightCurrentChunk` — top/bottom border decoration types and the `onDidChangeTextEditorSelection` handler.
- Section divider regex (from issue): `/^#+\s*.*[-#+=*]{4,}/g` — `# Title ====`, `# Setup ----`, `# Section #####`.

---

### Task 1: Add section-divider tests (RED) for `detect_r_cells`

**Files:**
- Test: `tests/bun/chunk-detector.test.ts` (append to `describe('detect_chunks — .R cell markers')`)

- [ ] **Step 1: Add failing tests for section dividers as cell-end markers**

Add these tests inside the existing `describe('detect_chunks — .R cell markers', …)` block (after the existing `empty cell` test):

```typescript
test('section divider line ends the current cell (cell-end only, not cell-start)', () => {
    const src = lines([
        '# %% one',
        'x <- 1',
        '# Section ====',
        'y <- 2',
        '# %% two',
        'z <- 3',
    ].join('\n'));
    const chunks = detect_chunks(src, 'r');
    expect(chunks.length).toBe(2);
    // Cell 1 ends at the section divider line itself (line 2).
    expect(chunks[0].header_line).toBe(0);
    expect(chunks[0].end_line).toBe(2);
    // Cell 2 starts at its own # %% header. The orphan `y <- 2` line between
    // the section divider and `# %% two` is NOT part of any cell.
    expect(chunks[1].header_line).toBe(4);
    expect(chunks[1].end_line).toBe(5);
});

test('section divider with dashes ends the cell', () => {
    const src = lines([
        '# %% Load',
        'library(dplyr)',
        '# Setup ----',
        '# %% Transform',
        'x <- 1',
    ].join('\n'));
    const chunks = detect_chunks(src, 'r');
    expect(chunks.length).toBe(2);
    expect(chunks[0].header_line).toBe(0);
    expect(chunks[0].end_line).toBe(2);
    expect(chunks[1].header_line).toBe(3);
});

test('section divider with hashes ends the cell', () => {
    const src = lines([
        '# %% First',
        'a <- 1',
        '## Section #####',
        '# %% Second',
        'b <- 2',
    ].join('\n'));
    const chunks = detect_chunks(src, 'r');
    expect(chunks.length).toBe(2);
    expect(chunks[0].end_line).toBe(2);
    expect(chunks[1].header_line).toBe(3);
});

test('section divider before any # %% is not a chunk by itself', () => {
    const src = lines([
        '# Setup ----',
        'x <- 1',
        '# %% main',
        'y <- 2',
    ].join('\n'));
    const chunks = detect_chunks(src, 'r');
    // Section divider doesn't start a cell; the only cell is `# %% main`.
    expect(chunks.length).toBe(1);
    expect(chunks[0].header_line).toBe(2);
    expect(chunks[0].end_line).toBe(3);
});

test('line that matches both # %% and section divider is treated as cell marker', () => {
    // `# %% ====` matches both regexes; cell marker takes priority so it
    // becomes a new cell header, not a cell-end of the prior cell.
    const src = lines([
        '# %% one',
        'x <- 1',
        '# %% ====',
        'y <- 2',
    ].join('\n'));
    const chunks = detect_chunks(src, 'r');
    expect(chunks.length).toBe(2);
    expect(chunks[0].header_line).toBe(0);
    expect(chunks[0].end_line).toBe(1);
    expect(chunks[1].header_line).toBe(2);
    expect(chunks[1].end_line).toBe(3);
});

test('section divider requires at least 4 boundary characters', () => {
    // `# Title ===` has only 3 `=` — not a section divider.
    const src = lines([
        '# %% one',
        '# Title ===',
        'x <- 1',
    ].join('\n'));
    const chunks = detect_chunks(src, 'r');
    expect(chunks.length).toBe(1);
    // The `# Title ===` line is part of cell 1, not a boundary.
    expect(chunks[0].end_line).toBe(2);
});

test('section divider on the last line ends the cell at EOF', () => {
    const src = lines([
        '# %% one',
        'x <- 1',
        '# End ====',
    ].join('\n'));
    const chunks = detect_chunks(src, 'r');
    expect(chunks.length).toBe(1);
    expect(chunks[0].header_line).toBe(0);
    expect(chunks[0].end_line).toBe(2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/bun/chunk-detector.test.ts -t "section divider"`
Expected: 7 failing tests (current `detect_r_cells` doesn't know about section dividers).

- [ ] **Step 3: Commit failing tests**

```bash
git add tests/bun/chunk-detector.test.ts
git commit -m "test(chunks): add failing tests for RStudio section-divider cell boundaries

Part of #228."
```

---

### Task 2: Implement section-divider boundary detection (GREEN)

**Files:**
- Modify: `editors/vscode/src/chunks/chunk-detector.ts:32-43` (regex block) and `detect_r_cells`

- [ ] **Step 1: Add the section-divider regex**

After the `CELL_MARKER_RE` constant (around line 39 of `chunk-detector.ts`), add:

```typescript
// RStudio-style section divider: a comment line ending in 4+ consecutive
// boundary characters from the set { - # + = * }, with optional title text
// in between. Examples: "# Title ====", "# Setup ----", "## Section #####".
// Recognized as a cell-END marker only when mixing with `# %%` cells in `.R`
// files (parity with vscode-R). A line that matches both `CELL_MARKER_RE` and
// this regex is treated as a cell marker — `CELL_MARKER_RE` is tested first.
const SECTION_DIVIDER_RE = /^#+\s*.*[-#+=*]{4,}\s*$/;
```

- [ ] **Step 2: Update `detect_r_cells` to honor section dividers**

Replace the existing `detect_r_cells` (lines ~210–230) with:

```typescript
function detect_r_cells(lines: string[]): Chunk[] {
    const chunks: Chunk[] = [];

    // Pass 1: enumerate cell markers (cell-START lines) and section dividers
    // (cell-END-only lines). A line that matches CELL_MARKER_RE is always a
    // marker even if it would also match SECTION_DIVIDER_RE.
    const marker_lines: number[] = [];
    const divider_lines = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
        if (CELL_MARKER_RE.test(lines[i])) {
            marker_lines.push(i);
        } else if (SECTION_DIVIDER_RE.test(lines[i])) {
            divider_lines.add(i);
        }
    }

    // Pass 2: for each cell marker, find the cell end — whichever comes
    // first: the next cell marker, a section divider, or EOF. When a section
    // divider closes the cell, the divider line itself is the last line of
    // the cell (end_line === divider_line). Content between a divider and
    // the next # %% is not part of any cell.
    for (let m = 0; m < marker_lines.length; m++) {
        const header_line = marker_lines[m];
        const next_marker = m + 1 < marker_lines.length ? marker_lines[m + 1] : lines.length;
        // Walk from one line below the header to find the first divider before next_marker.
        let end_line = next_marker - 1;
        for (let i = header_line + 1; i < next_marker; i++) {
            if (divider_lines.has(i)) {
                end_line = i;
                break;
            }
        }
        chunks.push({
            header_line,
            end_line: Math.max(end_line, header_line),
            closing_fence_line: null,
            language: 'r',
            label: null,
            options: {},
            is_eval_false: false,
            kind: 'r',
        });
    }
    return chunks;
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `bun test tests/bun/chunk-detector.test.ts`
Expected: All tests pass, including the 7 new section-divider tests, AND all existing R-cell tests still pass.

- [ ] **Step 4: Commit**

```bash
git add editors/vscode/src/chunks/chunk-detector.ts
git commit -m "feat(chunks): recognize RStudio section dividers as .R cell-end markers

In .R cell mode, lines like \`# Title ====\`, \`# Setup ----\`, or
\`# Section #####\` now terminate the current \`# %%\` cell. The divider
line itself stays in the prior cell; content between a divider and the
next \`# %%\` is orphan (not part of any cell), matching vscode-R.

A line that matches both \`# %%\` and the divider pattern is treated as
a cell marker so users can write \`# %% ====\` headers.

Refs #228."
```

---

### Task 3: Add active-cell indicator setting + theme colors to package.json (RED for VS Code suite)

**Files:**
- Modify: `editors/vscode/package.json` — `contributes.colors` and `contributes.configuration.properties`

- [ ] **Step 1: Add two new themable border colors**

In `editors/vscode/package.json`, inside `contributes.colors` (after the existing two chunk-color entries, around line 639), add:

```jsonc
{
  "id": "raven.chunk.activeCellBorderTop",
  "description": "Top border color drawn above the active `# %%` cell in .R cell mode. Mirrors VS Code's interactive-cell selected-cell indicator.",
  "defaults": {
    "dark": "#3794ff",
    "light": "#0066bf",
    "highContrast": "#3794ff",
    "highContrastLight": "#0066bf"
  }
},
{
  "id": "raven.chunk.activeCellBorderBottom",
  "description": "Bottom border color drawn below the active `# %%` cell in .R cell mode.",
  "defaults": {
    "dark": "#3794ff",
    "light": "#0066bf",
    "highContrast": "#3794ff",
    "highContrastLight": "#0066bf"
  }
}
```

- [ ] **Step 2: Add the `raven.chunks.activeCellIndicator` setting**

In `contributes.configuration.properties`, immediately after `raven.chunks.highlight.enabled` (around line 1296), add:

```jsonc
"raven.chunks.activeCellIndicator": {
  "type": "boolean",
  "default": true,
  "description": "In `.R` files using `# %%` cell mode, draw a top and bottom border around the cell containing the cursor (Jupyter-style). Disable to hide the border."
},
```

- [ ] **Step 3: Verify package.json still parses**

Run: `cd editors/vscode && npx -y jsonc-parser-cli package.json >/dev/null 2>&1 || node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" && echo OK`

Expected: prints `OK` and no JSON parse error.

- [ ] **Step 4: Commit**

```bash
git add editors/vscode/package.json
git commit -m "feat(chunks): contribute active-cell indicator setting + border colors

New setting raven.chunks.activeCellIndicator (default true) controls
the Jupyter-style top/bottom border drawn around the active # %% cell
in .R cell mode. Themable via raven.chunk.activeCellBorderTop and
raven.chunk.activeCellBorderBottom.

Refs #228."
```

---

### Task 4: Implement `ChunkActiveCellIndicator` (GREEN — runtime)

**Files:**
- Modify: `editors/vscode/src/chunks/chunk-highlighting.ts`

- [ ] **Step 1: Add the active-cell indicator class**

Inside `editors/vscode/src/chunks/chunk-highlighting.ts`, after `class ChunkDecorationManager { … }`, add a new class:

```typescript
/**
 * Cursor-tracking top/bottom border around the active `.R` cell.
 *
 * Mirrors VS Code's "selected cell" indicator from the Interactive Window /
 * Jupyter Notebooks. Without it, `.R` cell mode has no visible boundary
 * between adjacent cells — only the flat background tint — so users can't
 * tell which cell `Run Current Chunk` will run.
 *
 * Scope: `.R` files only (cell mode). `.Rmd` / `.qmd` fences already give
 * a clear visual boundary.
 */
class ChunkActiveCellIndicator {
    private top_border: vscode.TextEditorDecorationType;
    private bottom_border: vscode.TextEditorDecorationType;

    constructor() {
        this.top_border = this.create_border('top');
        this.bottom_border = this.create_border('bottom');
    }

    private create_border(side: 'top' | 'bottom'): vscode.TextEditorDecorationType {
        const color = new vscode.ThemeColor(
            side === 'top' ? 'raven.chunk.activeCellBorderTop' : 'raven.chunk.activeCellBorderBottom',
        );
        return vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            borderColor: color,
            borderWidth: side === 'top' ? '1px 0 0 0' : '0 0 1px 0',
            borderStyle: 'solid',
        });
    }

    update(editor: vscode.TextEditor | undefined): void {
        if (!editor) return;
        if (!this.should_decorate(editor)) {
            editor.setDecorations(this.top_border, []);
            editor.setDecorations(this.bottom_border, []);
            return;
        }
        const text = editor.document.getText();
        // Fast path: skip the line scan if there are no `%%` anchors at all.
        if (!has_chunk_anchor(text, 'r')) {
            editor.setDecorations(this.top_border, []);
            editor.setDecorations(this.bottom_border, []);
            return;
        }
        const lines: string[] = [];
        for (let i = 0; i < editor.document.lineCount; i++) lines.push(editor.document.lineAt(i).text);
        const chunks = detect_chunks(lines, 'r');
        const cursor_line = editor.selection.active.line;
        let active_chunk = null as ReturnType<typeof detect_chunks>[number] | null;
        for (const c of chunks) {
            if (cursor_line >= c.header_line && cursor_line <= c.end_line) {
                active_chunk = c;
                break;
            }
        }
        if (active_chunk === null) {
            editor.setDecorations(this.top_border, []);
            editor.setDecorations(this.bottom_border, []);
            return;
        }
        const top = new vscode.Range(active_chunk.header_line, 0, active_chunk.header_line, 0);
        const bottom = new vscode.Range(active_chunk.end_line, 0, active_chunk.end_line, 0);
        editor.setDecorations(this.top_border, [top]);
        editor.setDecorations(this.bottom_border, [bottom]);
    }

    update_visible(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            this.update(editor);
        }
    }

    private should_decorate(editor: vscode.TextEditor): boolean {
        if (!active_cell_indicator_enabled()) return false;
        // Only `.R` cell mode — Rmd/Qmd fences already provide clear boundaries.
        if (classify_chunk_document_for_document(editor.document) !== 'r') return false;
        if (editor.document.languageId.toLowerCase() !== 'r') return false;
        return true;
    }

    rebuild_decorations(): void {
        this.top_border.dispose();
        this.bottom_border.dispose();
        this.top_border = this.create_border('top');
        this.bottom_border = this.create_border('bottom');
        this.update_visible();
    }

    dispose(): void {
        this.top_border.dispose();
        this.bottom_border.dispose();
    }
}

function active_cell_indicator_enabled(): boolean {
    const config = vscode.workspace.getConfiguration('raven.chunks');
    return config.get<boolean>('activeCellIndicator', true);
}
```

- [ ] **Step 2: Wire the indicator into `register_chunk_decorations`**

Modify `register_chunk_decorations` so it also constructs and subscribes the indicator. Replace the existing body with:

```typescript
export function register_chunk_decorations(context: vscode.ExtensionContext): ChunkDecorationManager {
    const manager = new ChunkDecorationManager();
    const indicator = new ChunkActiveCellIndicator();
    context.subscriptions.push({ dispose: () => manager.dispose() });
    context.subscriptions.push({ dispose: () => indicator.dispose() });

    manager.update_visible();
    indicator.update_visible();

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            manager.update(editor);
            indicator.update(editor);
        }),
        vscode.window.onDidChangeVisibleTextEditors(() => {
            manager.update_visible();
            indicator.update_visible();
        }),
        vscode.window.onDidChangeTextEditorSelection((event) => {
            // Selection changes only matter for the active-cell indicator —
            // background highlighting doesn't depend on cursor position.
            indicator.update(event.textEditor);
        }),
        vscode.workspace.onDidChangeTextDocument((event) => {
            const document_uri = event.document.uri.toString();
            const is_visible = vscode.window.visibleTextEditors.some(
                (editor) => editor.document.uri.toString() === document_uri,
            );
            if (is_visible) {
                manager.schedule_refresh();
                // The active-cell border may shift if the edit changed chunk
                // boundaries. Recompute right away — there's no per-line scan
                // when `has_chunk_anchor` is false.
                indicator.update_visible();
            }
        }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('raven.chunks.highlight')) {
                manager.rebuild_decorations();
            }
            if (
                event.affectsConfiguration('raven.chunks.activeCellIndicator')
                || event.affectsConfiguration('raven.chunk.activeCellBorderTop')
                || event.affectsConfiguration('raven.chunk.activeCellBorderBottom')
            ) {
                indicator.rebuild_decorations();
            }
        }),
    );

    return manager;
}
```

- [ ] **Step 3: TypeScript compile check**

Run: `cd editors/vscode && npm run compile`
Expected: no TypeScript errors.

- [ ] **Step 4: Bun unit tests still pass (no regression)**

Run: `bun test tests/bun/chunk-detector.test.ts`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/src/chunks/chunk-highlighting.ts
git commit -m "feat(chunks): draw active-cell top/bottom border in .R cell mode

Adds a Jupyter-style indicator that tracks the cursor and frames the
active \`# %%\` cell with top and bottom borders. .R files only --
.Rmd/.qmd fences already give a clear boundary.

Gated on raven.chunks.activeCellIndicator (default true) and skipped on
files with no \`%%\` anchors so the cursor-move handler stays free on
plain .R scripts.

Refs #228."
```

---

### Task 5: Documentation

**Files:**
- Modify: `docs/chunks.md` — add a `Plain .R cell mode` subsection covering the new behaviors.

- [ ] **Step 1: Update `docs/chunks.md`**

Find the `## Plain \`.R\` cell mode` section (around line 125) and update it to:

````markdown
## Plain `.R` cell mode

A line matching `# %%`, `## %%`, `### %%`, … starts a new cell. The cell extends until **whichever comes first**:

1. The next `# %%` marker.
2. An RStudio-style section divider (a comment line ending in 4+ `-`, `#`, `+`, `=`, or `*` characters — e.g. `# Title ====`, `# Setup ----`, `# Section #####`).
3. End of file.

This matches VS Code's native interactive-cell convention used by the Jupyter extension and parity with vscode-R's section dividers.

```r
# %% Load
library(dplyr)

# %% Transform
mtcars |>
    group_by(cyl) |>
    summarise(mean(mpg))
```

Run Current Chunk on any line inside a cell sends that cell to the R console.

### Section dividers as cell boundaries

If you mix `# %%` cells with RStudio section dividers, the divider terminates the surrounding cell. The divider line itself stays in the prior cell; any code between the divider and the next `# %%` is **not** part of a cell and won't be sent by `Run Current Chunk`.

```r
# %% load
library(dplyr)

# Setup ----
helper <- function() 1
# %% transform
mtcars |> mutate(x = helper())
```

In the example above the `load` cell ends at `# Setup ----`. The `helper <- function() 1` line is orphan — it belongs to neither cell.

### Active-cell border

The cell containing the cursor gets a top and bottom border so you can see at a glance which cell `Run Current Chunk` will run. Turn it off with `raven.chunks.activeCellIndicator: false`. The colors are themable via `raven.chunk.activeCellBorderTop` and `raven.chunk.activeCellBorderBottom`.
````

- [ ] **Step 2: Commit**

```bash
git add docs/chunks.md
git commit -m "docs(chunks): document section-divider boundaries and active-cell border

Refs #228."
```

---

### Task 6: End-to-end verification

- [ ] **Step 1: Run the full bun test suite**

Run: `bun test`
Expected: all green.

- [ ] **Step 2: Compile the VS Code extension and run its test suite**

Run: `cd editors/vscode && npm run compile && npm test`
Expected: compile passes, chunks test suite passes.

- [ ] **Step 3: Cargo workspace sanity check (no Rust code changed, but verify nothing broke)**

Run: `cargo build -p raven`
Expected: clean build.

- [ ] **Step 4: Open the PR**

Push the branch and open a PR referencing #228.

```bash
git push -u origin <branch>
gh pr create --title "feat(chunks): .R cell-mode parity — active-cell border + RStudio section dividers" --body "$(cat <<'EOF'
## Summary

Closes #228. Two small `.R` cell-mode UX polish items for parity with vscode-R:

- **Active-cell border** — Jupyter-style top/bottom border around the cell at the cursor, gated on `raven.chunks.activeCellIndicator` (default `true`) and `.R` only.
- **RStudio section dividers** as `.R` cell-end markers — `# Title ====`, `# Setup ----`, `# Section #####` now terminate the surrounding `# %%` cell.

## Test plan

- [x] `bun test tests/bun/chunk-detector.test.ts` — covers section-divider boundaries
- [x] `bun test` — full bun suite
- [x] `npm run compile && npm test` in `editors/vscode` — extension test suite
- [x] `cargo build -p raven` — workspace still compiles
EOF
)"
```

---

## Self-Review

**Spec coverage:** Item 1 (active-cell border) — Tasks 3, 4. Item 2 (section dividers) — Tasks 1, 2. Docs — Task 5. Out-of-scope items (.Rmd/.qmd, knit/preview, outline) are honored — none touched.

**Placeholders:** None — every code block is complete.

**Type consistency:** `ChunkActiveCellIndicator`, `update`, `update_visible`, `rebuild_decorations`, `dispose` mirror the `ChunkDecorationManager` interface.
