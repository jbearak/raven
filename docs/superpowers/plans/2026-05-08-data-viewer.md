# Data Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Raven-owned R data viewer that overrides `View()`, supports gigabyte-scale frames via Apache Arrow IPC slicing, and renders a virtualized Svelte grid with Labels/Format toggles.

**Architecture:** R bootstrap profile installs a `View()` override that writes the frame to a Feather v2 (Arrow IPC) file in `<globalStorage>/data-viewer/` and POSTs a tiny event to the existing loopback session server (renamed `RSessionServer`). The extension Node process opens the Arrow file via `apache-arrow`, serves row slices to a Svelte webview over postMessage with generation-tagged messages, and materializes copy-as-TSV server-side.

**Tech Stack:** TypeScript (Node + Svelte), Bun (test runner), Rust (existing test harness), R (bootstrap profile + `arrow` package), Apache Arrow IPC.

**Spec:** `docs/superpowers/specs/2026-05-08-data-viewer-design.md`

---

## File Map

**Created**

| Path | Responsibility |
|---|---|
| `editors/vscode/src/r-session-server/index.ts` | Renamed from `plot/session-server.ts`. Owns the loopback HTTP server. Adds `/view-data` route + path-trust check + `view-data-requested` event. |
| `editors/vscode/src/r-session-server/types.ts` | Shared event types for plot + data viewer. |
| `editors/vscode/src/data-viewer/index.ts` | `registerDataViewer(context)` entry point. |
| `editors/vscode/src/data-viewer/manager.ts` | `DataViewerManager`: routes `view-data-requested` events to a panel keyed by `panelName`. Owns activation-time stale-file sweep. |
| `editors/vscode/src/data-viewer/panel.ts` | `DataViewerPanel`: webview lifecycle, `panelGeneration`, message routing, extension-side copy. Includes inline `build_html()`. |
| `editors/vscode/src/data-viewer/arrow-reader.ts` | `ArrowSliceReader`: opens Arrow file, indexes batches, serves `getRows`/`getLabels` with generation-aware cancellation, encodes wire format. |
| `editors/vscode/src/data-viewer/wire-format.ts` | Pure encoders/decoders for the JSON cell sentinels (NaN/Inf/Date/timestamp/trunc). |
| `editors/vscode/src/data-viewer/layout-state.ts` | Persisted column widths + hidden columns. Composite key `<panelName>::<schemaHash>`. LRU eviction by `raven.dataViewer.maxStoredLayouts`. |
| `editors/vscode/src/data-viewer/messages.ts` | Protocol type definitions (extension ↔ webview). |
| `editors/vscode/src/data-viewer/csp.ts` | Content-Security-Policy builder, mirroring `plot/csp.ts`. |
| `editors/vscode/src/data-viewer/webview/main.ts` | Svelte mount entry. |
| `editors/vscode/src/data-viewer/webview/App.svelte` | Top-level component (toolbar + grid). |
| `editors/vscode/src/data-viewer/webview/grid.svelte` | Virtualized cell grid (sticky header + first column). |
| `editors/vscode/src/data-viewer/webview/toolbar.svelte` | Labels/Format toggles, digits dropdown, Columns popover, row counter. |
| `editors/vscode/src/data-viewer/webview/grid-model.ts` | Pure: visible-row math, scroll coalescing, viewportGeneration. |
| `editors/vscode/src/data-viewer/webview/row-cache.ts` | LRU of decoded row windows. |
| `editors/vscode/src/data-viewer/webview/selection-model.ts` | Anchor + focus rectangle math. |
| `editors/vscode/src/data-viewer/webview/cell-render.ts` | Display-time formatting (Labels, Format, missing-value styling). |
| `editors/vscode/src/data-viewer/webview/styles.css` | Grid + toolbar styles. |
| `editors/vscode/src/data-viewer/webview/tsconfig.json` | Webview TS config (mirror plot). |
| `editors/vscode/test-fixtures/generate-data-viewer.R` | One-off R script to regenerate Arrow fixtures. |
| `editors/vscode/test-fixtures/data-viewer/*.arrow` | Committed Arrow fixtures for unit tests. |
| `tests/bun/data-viewer-arrow-reader.test.ts` | ArrowSliceReader behavior. |
| `tests/bun/data-viewer-wire-format.test.ts` | Wire-format encode/decode. |
| `tests/bun/data-viewer-session-server-route.test.ts` | `/view-data` route incl. path-trust. |
| `tests/bun/data-viewer-manager.test.ts` | DataViewerManager + Panel + extension-side copy. |
| `tests/bun/data-viewer-grid-model.test.ts` | grid-model + selection + cell-render. |
| `tests/bun/data-viewer-layout-state.test.ts` | Composite-key persistence + LRU. |
| `tests/bun/data-viewer-bootstrap-content.test.ts` | Pure-JS check that the bootstrap source contains the right View() override. |
| `crates/raven/tests/data_viewer_bootstrap.rs` | R-integration test (skipped without R on PATH). |
| `docs/data-viewer.md` | User-facing documentation. |

**Modified**

| Path | What changes |
|---|---|
| `editors/vscode/src/plot/r-bootstrap-profile.ts` | Adds the View() override block at the **top** of the profile source (before the plot `local({...})`), in its own `local({...})`. Keeps existing exports. |
| `editors/vscode/src/plot/index.ts` | Imports `RSessionServer` from new location; class continues to subscribe to plot-only events. |
| `editors/vscode/src/extension.ts` | Calls `registerDataViewer(context)` during activation. |
| `editors/vscode/package.json` | Adds 4 settings under `raven.dataViewer.*` and a runtime dep on `apache-arrow`. |
| `docs/send-to-r.md` | Adds a "Data Viewer" sibling section to "Plot Viewer". |
| `CLAUDE.md` | Adds `docs/data-viewer.md` to the "What to read" list. |

**Renamed (preserve history)**

| From | To |
|---|---|
| `editors/vscode/src/plot/session-server.ts` | `editors/vscode/src/r-session-server/index.ts` |
| `tests/bun/plot-session-server-auth.test.ts`, `*-ready.test.ts`, `*-available.test.ts`, `*-end.test.ts` | unchanged paths; imports updated to the new module location |

---

## Task 1: Arrow JS spike — pin the API surface

**Files:**
- Modify: `editors/vscode/package.json` (add `apache-arrow` dep)
- Create: `tests/bun/data-viewer-arrow-spike.test.ts`
- Create: `editors/vscode/test-fixtures/generate-data-viewer.R`
- Create: `editors/vscode/test-fixtures/data-viewer/tiny.arrow`

The goal is to lock in the exact `apache-arrow` API names and access patterns we'll use in `ArrowSliceReader`, before the rest of the plan commits to specific symbols. After this task we know the **exact** way to (a) open a file, (b) read its schema and column-level KV metadata, (c) read the i-th record batch by index, (d) read a dictionary column.

- [ ] **Step 1: Add the dependency**

In `editors/vscode/package.json` `dependencies`, add:

```json
"apache-arrow": "^17.0.0"
```

Run `cd editors/vscode && bun install`. Confirm `apache-arrow` resolves and `node_modules/apache-arrow/dist/index.d.ts` is present.

- [ ] **Step 2: Generate the fixture**

Create `editors/vscode/test-fixtures/generate-data-viewer.R`:

```r
#!/usr/bin/env Rscript
# Regenerates fixtures under editors/vscode/test-fixtures/data-viewer/
# Run by hand when the schema changes. Requires arrow.

if (!requireNamespace("arrow", quietly = TRUE)) {
    stop("install.packages('arrow') first")
}
library(arrow)

out_dir <- file.path(
    dirname(sys.frame(1)$ofile %||% commandArgs(trailingOnly = FALSE)[4]),
    "data-viewer"
)
dir.create(out_dir, showWarnings = FALSE, recursive = TRUE)

write_tiny <- function() {
    df <- data.frame(
        x = 1:5,
        y = c(1.5, NA_real_, NaN, Inf, -Inf),
        s = c("a", "b", NA, "d", "e"),
        f = factor(c("low", "med", "low", "high", "med"),
                   levels = c("low", "med", "high")),
        d = as.Date("2024-01-01") + 0:4,
        ts = as.POSIXct("2024-01-01 12:00:00", tz = "UTC") + 0:4
    )
    attr(df$y, "label") <- "A floaty column"
    write_feather(df, file.path(out_dir, "tiny.arrow"), chunk_size = 3)
}

write_tiny()
cat("Fixtures written to", out_dir, "\n")
```

Run by hand:

```bash
cd editors/vscode && Rscript test-fixtures/generate-data-viewer.R
```

Expected: `editors/vscode/test-fixtures/data-viewer/tiny.arrow` exists, ≈600 bytes. Commit the file.

- [ ] **Step 3: Write the spike test**

Create `tests/bun/data-viewer-arrow-spike.test.ts`. The test must **pass** end-to-end and document the API we'll use:

```ts
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tableFromIPC, RecordBatchFileReader } from 'apache-arrow';

const FIXTURE = join(
    __dirname, '..', '..',
    'editors/vscode/test-fixtures/data-viewer/tiny.arrow'
);

describe('apache-arrow spike: pin the API surface', () => {
    test('can open file, read schema, batch count, and a single batch', () => {
        const buf = readFileSync(FIXTURE);
        const reader = RecordBatchFileReader.from(buf);
        // schema and column KV metadata
        const schema = reader.schema;
        expect(schema.fields.map(f => f.name)).toEqual([
            'x', 'y', 's', 'f', 'd', 'ts',
        ]);
        const yField = schema.fields.find(f => f.name === 'y')!;
        expect(yField.metadata.get('label') ?? null).toBe('A floaty column');

        // batch count and per-batch row counts
        const batches: number[] = [];
        for (let i = 0; i < reader.numRecordBatches; i++) {
            const b = reader.readRecordBatch(i)!;
            batches.push(b.numRows);
        }
        // chunk_size = 3 across 5 rows → batches [3, 2]
        expect(batches).toEqual([3, 2]);
    });

    test('factor column is dictionary-encoded; can read indices and dict values', () => {
        const buf = readFileSync(FIXTURE);
        const reader = RecordBatchFileReader.from(buf);
        const table = tableFromIPC(buf);
        const col = table.getChild('f')!;
        // Underlying values are the dictionary indices (Int32) ...
        // and a getter exposes the dictionary values.
        // Pin whatever access pattern works:
        const first = col.get(0);
        // Implementation note: tableFromIPC decodes dictionaries by default,
        // returning the level string. We need to read RAW indices for the
        // wire format. The way to do this is by using the lower-level
        // RecordBatchFileReader and inspecting batch.data.children[0].values.
        const batch = reader.readRecordBatch(0)!;
        const fIndices = (batch.getChild('f') as any).data.values;
        expect(fIndices).toBeInstanceOf(Int32Array);
        expect(Array.from(fIndices.slice(0, 3))).toEqual([0, 1, 0]);
        // first via decoded path
        expect(first).toBe('low');
    });

    test('NaN, Inf, -Inf round-trip via read', () => {
        const buf = readFileSync(FIXTURE);
        const table = tableFromIPC(buf);
        const y = table.getChild('y')!;
        const vals = [y.get(0), y.get(1), y.get(2), y.get(3), y.get(4)];
        // index 1 is NA → null in arrow JS
        expect(vals[0]).toBe(1.5);
        expect(vals[1]).toBeNull();
        expect(Number.isNaN(vals[2])).toBe(true);
        expect(vals[3]).toBe(Infinity);
        expect(vals[4]).toBe(-Infinity);
    });
});
```

- [ ] **Step 4: Run the spike**

```bash
bun test tests/bun/data-viewer-arrow-spike.test.ts
```

Expected: PASS. If the API doesn't match, **adjust the test**, fix the spike, and commit. The exact symbols that pass here become the canonical ones used by `ArrowSliceReader` in Task 4.

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/package.json editors/vscode/bun.lock \
    editors/vscode/test-fixtures/generate-data-viewer.R \
    editors/vscode/test-fixtures/data-viewer/tiny.arrow \
    tests/bun/data-viewer-arrow-spike.test.ts
git commit -m "feat(data-viewer): pin apache-arrow JS API via spike test"
```

---

## Task 2: Rename PlotSessionServer → RSessionServer

A pure rename — no behavior changes. The class moves to `editors/vscode/src/r-session-server/`. Existing plot tests must continue to pass against the new path.

**Files:**
- Move: `editors/vscode/src/plot/session-server.ts` → `editors/vscode/src/r-session-server/index.ts`
- Create: `editors/vscode/src/r-session-server/types.ts` (event-type union home)
- Modify: `editors/vscode/src/plot/index.ts` (update import)
- Modify: `tests/bun/plot-session-server-{auth,ready,available,end}.test.ts` (update imports)

- [ ] **Step 1: Move the file via git**

```bash
mkdir -p editors/vscode/src/r-session-server
git mv editors/vscode/src/plot/session-server.ts \
       editors/vscode/src/r-session-server/index.ts
```

- [ ] **Step 2: Rename the class**

In `editors/vscode/src/r-session-server/index.ts`, rename `PlotSessionServer` → `RSessionServer`. Keep `PlotEvent`, `PlotEventListener`, and `SessionInfo` for now — they'll be split in Task 3.

```ts
export class RSessionServer {
    // (unchanged body)
}
```

- [ ] **Step 3: Add a re-export for the old name (temporarily)**

To minimize churn in this task, keep an alias at the bottom of the file:

```ts
/** @deprecated use RSessionServer */
export const PlotSessionServer = RSessionServer;
export type PlotSessionServer = RSessionServer;
```

- [ ] **Step 4: Fix imports in plot/index.ts**

Replace `from './session-server'` with `from '../r-session-server'`. Use the `RSessionServer` name.

- [ ] **Step 5: Fix imports in plot test files**

Update all `tests/bun/plot-session-server-*.test.ts` to import from `../../editors/vscode/src/r-session-server`. Replace `PlotSessionServer` with `RSessionServer`.

- [ ] **Step 6: Run and verify all tests pass**

```bash
bun test tests/bun/plot-session-server-auth.test.ts
bun test tests/bun/plot-session-server-ready.test.ts
bun test tests/bun/plot-session-server-available.test.ts
bun test tests/bun/plot-session-server-end.test.ts
```

Expected: all four PASS. Then full suite:

```bash
bun test
```

Expected: all PASS, no new failures.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(session-server): rename PlotSessionServer to RSessionServer

Move to editors/vscode/src/r-session-server/ in preparation for the
data viewer reusing the same loopback HTTP server. No behavior change."
```

---

## Task 3: Split event types and add `/view-data` route + path-trust check

Now the event union becomes shared between plot and data viewer, and the server gains `/view-data`. The route validates that `filePath` is under a configurable allowlist directory.

**Files:**
- Modify: `editors/vscode/src/r-session-server/index.ts`
- Create: `editors/vscode/src/r-session-server/types.ts`
- Create: `tests/bun/data-viewer-session-server-route.test.ts`

- [ ] **Step 1: Define the event union in types.ts**

Create `editors/vscode/src/r-session-server/types.ts`:

```ts
export type SessionInfo = {
    sessionId: string;
    httpgdBaseUrl: string;
    httpgdToken: string;
    ended: boolean;
    lastUpid: number;
};

export type PlotEvent =
    | { type: 'session-ready'; session: SessionInfo }
    | { type: 'plot-available'; sessionId: string; hsize: number; upid: number }
    | { type: 'session-ended'; sessionId: string };

export type ViewDataEvent = {
    type: 'view-data-requested';
    sessionId: string;
    panelName: string;
    filePath: string;
    nrow: number;
};

export type RSessionEvent = PlotEvent | ViewDataEvent;
export type RSessionEventListener = (event: RSessionEvent) => void;
```

- [ ] **Step 2: Wire the new event type into the server**

In `editors/vscode/src/r-session-server/index.ts`:
- Replace local `PlotEvent` / `PlotEventListener` definitions with re-exports from `./types`.
- Change the `listeners` set to use `RSessionEventListener`.
- Add a constructor parameter `allowedDataViewerDir: string` (absolute path) that the new route uses for the path-trust check. Existing call sites (plot) pass `''` for now.

```ts
import { PlotEvent, RSessionEvent, RSessionEventListener, SessionInfo, ViewDataEvent } from './types';

export class RSessionServer {
    constructor(private readonly allowed_data_viewer_dir: string = '') {}
    // ...
}
```

- [ ] **Step 3: Write the failing route tests**

Create `tests/bun/data-viewer-session-server-route.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, mkdir, rm, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RSessionServer } from '../../editors/vscode/src/r-session-server';

describe('POST /view-data', () => {
    let server: RSessionServer;
    let dvDir: string;

    beforeEach(async () => {
        const root = await mkdtemp(join(tmpdir(), 'raven-dv-'));
        dvDir = join(root, 'data-viewer');
        await mkdir(dvDir, { recursive: true });
        server = new RSessionServer(await realpath(dvDir));
        await server.start();
    });
    afterEach(async () => { await server.stop(); });

    const post = async (body: unknown, token = server.token) =>
        fetch(`http://127.0.0.1:${server.port}/view-data`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-raven-session-token': token,
            },
            body: JSON.stringify(body),
        });

    test('valid POST emits view-data-requested', async () => {
        const fp = join(dvDir, 'sess-abc.arrow');
        await writeFile(fp, 'pretend-arrow');
        const events: any[] = [];
        server.onEvent(e => events.push(e));
        const r = await post({
            sessionId: 'sess', panelName: 'mtcars', filePath: fp, nrow: 32,
        });
        expect(r.status).toBe(200);
        expect(events).toContainEqual({
            type: 'view-data-requested',
            sessionId: 'sess', panelName: 'mtcars', filePath: fp, nrow: 32,
        });
    });

    test('invalid token returns 401', async () => {
        const r = await post(
            { sessionId: 's', panelName: 'p', filePath: join(dvDir, 'x.arrow'), nrow: 1 },
            'wrong'
        );
        expect(r.status).toBe(401);
    });

    test('missing field returns 400', async () => {
        const r = await post({ sessionId: 's', panelName: 'p', nrow: 1 });
        expect(r.status).toBe(400);
    });

    test('filePath outside allowed dir returns 400', async () => {
        const r = await post({
            sessionId: 's', panelName: 'p', filePath: '/etc/passwd', nrow: 1,
        });
        expect(r.status).toBe(400);
    });

    test('filePath using .. traversal returns 400', async () => {
        const r = await post({
            sessionId: 's', panelName: 'p',
            filePath: join(dvDir, '..', '..', 'etc', 'passwd'), nrow: 1,
        });
        expect(r.status).toBe(400);
    });

    test('symlink redirecting outside allowed dir returns 400', async () => {
        const link = join(dvDir, 'evil.arrow');
        await symlink('/etc/passwd', link);
        const r = await post({
            sessionId: 's', panelName: 'p', filePath: link, nrow: 1,
        });
        expect(r.status).toBe(400);
    });
});
```

- [ ] **Step 4: Run tests to confirm they fail**

```bash
bun test tests/bun/data-viewer-session-server-route.test.ts
```

Expected: all 6 FAIL (route does not exist; constructor parameter unused).

- [ ] **Step 5: Implement the route**

In `editors/vscode/src/r-session-server/index.ts` add to `handle()`:

```ts
if (url === '/view-data') {
    this.read_json_body(req, res, body => this.handle_view_data(body, res));
    return;
}
```

And the handler:

```ts
private handle_view_data(body: unknown, res: http.ServerResponse): void {
    if (!body || typeof body !== 'object') { res.writeHead(400).end(); return; }
    const b = body as Record<string, unknown>;
    const sessionId = typeof b.sessionId === 'string' ? b.sessionId : '';
    const panelName = typeof b.panelName === 'string' ? b.panelName : '';
    const filePath = typeof b.filePath === 'string' ? b.filePath : '';
    const nrow = typeof b.nrow === 'number' ? b.nrow : NaN;
    if (!sessionId || !panelName || !filePath || !Number.isFinite(nrow) || nrow < 0) {
        res.writeHead(400).end(); return;
    }
    if (!this.allowed_data_viewer_dir) {
        // Server was constructed without a path-trust dir (plot-only context).
        res.writeHead(404).end(); return;
    }
    let canonical: string;
    try {
        canonical = require('node:fs').realpathSync(filePath);
    } catch {
        res.writeHead(400).end(); return;
    }
    const allowed = this.allowed_data_viewer_dir;
    const sep = require('node:path').sep;
    if (canonical !== allowed && !canonical.startsWith(allowed + sep)) {
        res.writeHead(400).end(); return;
    }
    this.emit({ type: 'view-data-requested', sessionId, panelName, filePath: canonical, nrow });
    res.writeHead(200).end();
}
```

(Use proper ES module imports at the top of the file rather than `require`; `require` shown inline above for brevity.)

- [ ] **Step 6: Run tests to verify they pass**

```bash
bun test tests/bun/data-viewer-session-server-route.test.ts
```

Expected: PASS for all 6.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(session-server): add /view-data route with path-trust check

The data viewer publishes view-data-requested events through the same
loopback server the plot bridge uses. The route requires the server to
be constructed with an allowed data-viewer directory and rejects any
filePath that does not canonicalize inside it (including .. traversal
and symlink redirection)."
```

---

## Task 4: ArrowSliceReader

Owns one Arrow file. Indexes batch starts, decodes only requested batches, encodes the wire format, supports `viewportGeneration` cancellation, and ships dictionaries up to a cardinality threshold.

**Files:**
- Create: `editors/vscode/src/data-viewer/wire-format.ts`
- Create: `editors/vscode/src/data-viewer/arrow-reader.ts`
- Create: `tests/bun/data-viewer-wire-format.test.ts`
- Create: `tests/bun/data-viewer-arrow-reader.test.ts`
- Modify: `editors/vscode/test-fixtures/generate-data-viewer.R` (add multi-batch + dictionary fixtures)
- Add: `editors/vscode/test-fixtures/data-viewer/{multibatch,bigdict,types}.arrow`

- [ ] **Step 1: Define the wire format**

Create `editors/vscode/src/data-viewer/wire-format.ts`:

```ts
/** Wire-format cell values shipped over postMessage as JSON. */
export type Cell =
    | null            // NA / null
    | number          // valid finite number
    | string          // utf8 (raw, not factor)
    | boolean
    | number          // 0-based dictionary index for factor / labelled columns
    | { _: 'nan' }
    | { _: 'inf' }
    | { _: '-inf' }
    | { _: 'date'; v: string }     // YYYY-MM-DD
    | { _: 'ts'; v: string }       // ISO-8601 with offset
    | { _: 'trunc'; v: string };   // 1 KiB-truncated format() cell

export const TRUNC_LIMIT_BYTES = 1024;

export function encodeNumber(x: number | null): Cell {
    if (x === null) return null;
    if (Number.isNaN(x)) return { _: 'nan' };
    if (x === Infinity) return { _: 'inf' };
    if (x === -Infinity) return { _: '-inf' };
    return x;
}

export function encodeString(x: string | null): Cell {
    if (x === null) return null;
    if (Buffer.byteLength(x, 'utf8') > TRUNC_LIMIT_BYTES) {
        // R side does the truncation; this is a defensive guard for
        // anything that slipped through.
        return { _: 'trunc', v: truncateUtf8(x, TRUNC_LIMIT_BYTES - 1) + '…' };
    }
    return x;
}

export function encodeDate(daysSinceEpoch: number | null): Cell {
    if (daysSinceEpoch === null) return null;
    const ms = daysSinceEpoch * 86_400_000;
    const d = new Date(ms);
    const s = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    return { _: 'date', v: s };
}

export function encodeTimestamp(microseconds: bigint | null, tz: string): Cell {
    if (microseconds === null) return null;
    const ms = Number(microseconds / 1000n);
    const us = Number(microseconds % 1000n);
    const d = new Date(ms);
    const iso = d.toISOString().replace('Z', '');
    const usPart = us > 0 ? `.${String(us).padStart(3, '0')}` : '';
    const offset = tz === 'UTC' ? 'Z' : tz;
    return { _: 'ts', v: `${iso}${usPart}${offset.startsWith('+') || offset.startsWith('-') || offset === 'Z' ? offset : ''}` };
}

function pad(n: number): string { return n < 10 ? `0${n}` : `${n}`; }

function truncateUtf8(s: string, maxBytes: number): string {
    const buf = Buffer.from(s, 'utf8').subarray(0, maxBytes);
    // Trim trailing partial code point.
    return buf.toString('utf8').replace(/[�]+$/, '');
}
```

- [ ] **Step 2: Tests for wire-format**

Create `tests/bun/data-viewer-wire-format.test.ts`:

```ts
import { describe, test, expect } from 'bun:test';
import {
    encodeNumber, encodeString, encodeDate, encodeTimestamp, TRUNC_LIMIT_BYTES,
} from '../../editors/vscode/src/data-viewer/wire-format';

describe('encodeNumber', () => {
    test.each([
        [1.5, 1.5],
        [0, 0],
        [null, null],
        [NaN, { _: 'nan' }],
        [Infinity, { _: 'inf' }],
        [-Infinity, { _: '-inf' }],
    ])('encodes %p as %p', (input, expected) => {
        expect(encodeNumber(input as any)).toEqual(expected as any);
    });
});

describe('encodeString', () => {
    test('passes short strings through', () => {
        expect(encodeString('hi')).toBe('hi');
    });
    test('null', () => { expect(encodeString(null)).toBeNull(); });
    test('truncates over 1 KiB', () => {
        const long = 'x'.repeat(2000);
        const r = encodeString(long) as any;
        expect(r._).toBe('trunc');
        expect((r.v as string).endsWith('…')).toBe(true);
    });
});

describe('encodeDate / encodeTimestamp', () => {
    test('date roundtrip', () => {
        // 2024-01-15
        const days = Math.floor(Date.UTC(2024, 0, 15) / 86_400_000);
        expect(encodeDate(days)).toEqual({ _: 'date', v: '2024-01-15' });
    });
    test('timestamp UTC', () => {
        const us = BigInt(Date.UTC(2024, 0, 15, 12, 0, 0)) * 1000n;
        const r = encodeTimestamp(us, 'UTC') as any;
        expect(r._).toBe('ts');
        expect(r.v).toContain('2024-01-15T12:00:00');
    });
});
```

- [ ] **Step 3: Run wire-format tests**

```bash
bun test tests/bun/data-viewer-wire-format.test.ts
```

Expected: PASS.

- [ ] **Step 4: Generate richer fixtures**

Append to `editors/vscode/test-fixtures/generate-data-viewer.R`:

```r
write_multibatch <- function() {
    n <- 200000
    df <- data.frame(
        i = 1:n,
        v = runif(n)
    )
    write_feather(df, file.path(out_dir, "multibatch.arrow"), chunk_size = 65536)
}

write_bigdict <- function() {
    # Force a dictionary above the 100k threshold
    n <- 250000
    df <- data.frame(
        zip = factor(sprintf("zip-%07d", sample.int(150000, n, replace = TRUE)))
    )
    write_feather(df, file.path(out_dir, "bigdict.arrow"), chunk_size = 65536)
}

write_types <- function() {
    df <- data.frame(
        small_factor = factor(c("a", "b", "a"), levels = c("a", "b", "c")),
        labelled_num = haven::labelled(c(1, 2, 3), labels = c(low = 1, mid = 2, high = 3))
            # If haven is unavailable, fall back: this branch is best-effort
    )
    write_feather(df, file.path(out_dir, "types.arrow"))
}

write_multibatch()
write_bigdict()
tryCatch(write_types(), error = function(e) message("skipping types fixture: ", conditionMessage(e)))
```

Run by hand:

```bash
cd editors/vscode && Rscript test-fixtures/generate-data-viewer.R
git add test-fixtures/data-viewer/*.arrow test-fixtures/generate-data-viewer.R
```

- [ ] **Step 5: Write failing ArrowSliceReader tests**

Create `tests/bun/data-viewer-arrow-reader.test.ts`. Cover:

```ts
import { describe, test, expect, beforeAll } from 'bun:test';
import { join } from 'node:path';
import { ArrowSliceReader } from '../../editors/vscode/src/data-viewer/arrow-reader';

const FIX = (name: string) => join(
    __dirname, '..', '..',
    'editors/vscode/test-fixtures/data-viewer', name
);

describe('ArrowSliceReader: tiny fixture', () => {
    let r: ArrowSliceReader;
    beforeAll(() => { r = new ArrowSliceReader(FIX('tiny.arrow')); });

    test('schema columns', () => {
        expect(r.schema.columns.map(c => c.name))
            .toEqual(['x', 'y', 's', 'f', 'd', 'ts']);
    });
    test('exposes nrow', () => { expect(r.nrow).toBe(5); });
    test('reads variable_label metadata', () => {
        const y = r.schema.columns.find(c => c.name === 'y')!;
        expect(y.variableLabel).toBe('A floaty column');
    });
    test('factor dictionary shipped (small)', () => {
        const f = r.schema.columns.find(c => c.name === 'f')!;
        expect(f.dictionary).toEqual(['low', 'med', 'high']);
        expect(f.dictionaryShipped).toBe(true);
    });
    test('getRows returns wire-format cells', async () => {
        const rows = await r.getRows({
            start: 0, end: 5, columns: [0, 1, 2, 3, 4, 5],
            viewportGeneration: 1,
        });
        expect(rows.stale).toBe(false);
        expect(rows.rows).toHaveLength(5);
        // y col index 1
        expect(rows.rows[1][1]).toBeNull();
        expect(rows.rows[2][1]).toEqual({ _: 'nan' });
        expect(rows.rows[3][1]).toEqual({ _: 'inf' });
        // factor index, 0-based
        expect(rows.rows[0][3]).toBe(0);
        expect(rows.rows[1][3]).toBe(1);
    });
});

describe('ArrowSliceReader: multibatch', () => {
    let r: ArrowSliceReader;
    let loadedBatches: number[];
    beforeAll(() => {
        r = new ArrowSliceReader(FIX('multibatch.arrow'));
        loadedBatches = [];
        r.onBatchLoad = (i) => loadedBatches.push(i);
    });

    test('getRows(0, 10) loads only batch 0', async () => {
        loadedBatches.length = 0;
        await r.getRows({ start: 0, end: 10, columns: [0, 1], viewportGeneration: 1 });
        expect(loadedBatches).toEqual([0]);
    });
    test('getRows across boundary loads exactly 2 batches', async () => {
        loadedBatches.length = 0;
        await r.getRows({ start: 65530, end: 65540, columns: [0, 1], viewportGeneration: 2 });
        expect(loadedBatches).toEqual([0, 1]);
    });
    test('column subset does not decode hidden columns', async () => {
        loadedBatches.length = 0;
        const rows = await r.getRows({ start: 0, end: 5, columns: [0], viewportGeneration: 3 });
        expect(rows.rows[0]).toHaveLength(1); // only column 0 returned
    });
    test('stale viewportGeneration causes early return', async () => {
        // bump generation, then issue an old request.
        await r.setLatestViewportGeneration(10);
        const out = await r.getRows({ start: 0, end: 5, columns: [0], viewportGeneration: 5 });
        expect(out.stale).toBe(true);
    });
});

describe('ArrowSliceReader: bigdict fallback', () => {
    let r: ArrowSliceReader;
    beforeAll(() => { r = new ArrowSliceReader(FIX('bigdict.arrow')); });

    test('high-cardinality dictionary not shipped in schema', () => {
        const z = r.schema.columns.find(c => c.name === 'zip')!;
        expect(z.dictionaryShipped).toBe(false);
        expect(z.dictionary).toBeUndefined();
    });
    test('getLabels returns labels for the requested indices', async () => {
        const out = await r.getLabels(0, [0, 1, 2]);
        // dictionary order is fixture-dependent; just assert shape.
        expect(Object.keys(out).map(Number).sort((a, b) => a - b)).toEqual([0, 1, 2]);
        Object.values(out).forEach(s => expect(typeof s).toBe('string'));
    });
});
```

- [ ] **Step 6: Run failing reader tests**

```bash
bun test tests/bun/data-viewer-arrow-reader.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 7: Implement ArrowSliceReader**

Create `editors/vscode/src/data-viewer/arrow-reader.ts`:

```ts
import { readFileSync } from 'node:fs';
import { RecordBatchFileReader, tableFromIPC } from 'apache-arrow';
import { Cell, encodeNumber, encodeString, encodeDate, encodeTimestamp, TRUNC_LIMIT_BYTES } from './wire-format';

export const DICTIONARY_THRESHOLD = 100_000;

export type ColumnSchema = {
    name: string;
    arrowType: string;             // e.g. 'Float64', 'Utf8', 'Dictionary<Int32, Utf8>'
    originalClass?: string;        // raven.original_class metadata
    variableLabel?: string;        // raven.variable_label
    valueLabels?: Record<string, string>; // raven.value_labels (parsed from JSON)
    formatStata?: string;          // raven.format
    dictionary?: string[];         // present iff dictionaryShipped
    dictionaryShipped: boolean;
    isInteger: boolean;            // for Format toggle: integer columns ignore digits
};

export type ReaderSchema = {
    columns: ColumnSchema[];
};

export type GetRowsRequest = {
    start: number;
    end: number;
    columns: number[];           // indices
    viewportGeneration: number;
};

export type GetRowsResponse = {
    rows: Cell[][];              // outer = row (ordered by `start..end-1`); inner = `columns` order
    stale: boolean;
};

export class ArrowSliceReader {
    readonly schema: ReaderSchema;
    readonly nrow: number;
    readonly batchStarts: Uint32Array;
    onBatchLoad?: (batchIndex: number) => void;

    private readonly file: Buffer;
    private readonly reader: RecordBatchFileReader;
    private latestViewportGen = 0;

    constructor(path: string) {
        this.file = readFileSync(path);
        this.reader = RecordBatchFileReader.from(this.file);
        const starts: number[] = [0];
        let acc = 0;
        for (let i = 0; i < this.reader.numRecordBatches; i++) {
            const b = this.reader.readRecordBatch(i)!;
            acc += b.numRows;
            starts.push(acc);
        }
        this.nrow = acc;
        this.batchStarts = new Uint32Array(starts);
        this.schema = this.buildSchema();
    }

    private buildSchema(): ReaderSchema {
        const cols: ColumnSchema[] = this.reader.schema.fields.map(f => {
            const md = f.metadata;
            const labelStr = md.get('raven.value_labels');
            const valueLabels = labelStr ? JSON.parse(labelStr) : undefined;
            const isDict = String(f.type).startsWith('Dictionary');
            const dict = isDict ? this.readDictionary(f.name) : undefined;
            const ship = isDict && (dict?.length ?? 0) <= DICTIONARY_THRESHOLD;
            return {
                name: f.name,
                arrowType: String(f.type),
                originalClass: md.get('raven.original_class') ?? undefined,
                variableLabel: md.get('raven.variable_label') ?? md.get('label') ?? undefined,
                valueLabels,
                formatStata: md.get('raven.format') ?? undefined,
                dictionary: ship ? dict : undefined,
                dictionaryShipped: !!ship,
                isInteger: /^Int\d+$/.test(String(f.type)),
            };
        });
        return { columns: cols };
    }

    private readDictionary(colName: string): string[] {
        const t = tableFromIPC(this.file);
        const c = t.getChild(colName);
        // Read all distinct dictionary values.
        // apache-arrow keeps dict in column.data.dictionary
        const dataAny = (c as any).data;
        const dict = (dataAny.dictionary ?? dataAny[0]?.dictionary) as any;
        if (!dict) return [];
        const out: string[] = [];
        for (let i = 0; i < dict.length; i++) out.push(dict.get(i) as string);
        return out;
    }

    setLatestViewportGeneration(g: number): void {
        this.latestViewportGen = g;
    }

    async getRows(req: GetRowsRequest): Promise<GetRowsResponse> {
        if (req.viewportGeneration < this.latestViewportGen) {
            return { rows: [], stale: true };
        }
        const { start, end, columns } = req;
        const lo = Math.max(0, start);
        const hi = Math.min(this.nrow, end);
        if (hi <= lo) return { rows: [], stale: false };
        const fields = this.reader.schema.fields;
        const rows: Cell[][] = [];
        for (let row = lo; row < hi; row++) rows.push(new Array(columns.length));
        // For each batch overlapping [lo, hi), decode requested columns once.
        const startBatch = upperBoundLE(this.batchStarts, lo);
        const endBatch = upperBoundLE(this.batchStarts, hi - 1);
        for (let bi = startBatch; bi <= endBatch; bi++) {
            const batch = this.reader.readRecordBatch(bi)!;
            this.onBatchLoad?.(bi);
            const batchRowStart = this.batchStarts[bi];
            const localLo = Math.max(0, lo - batchRowStart);
            const localHi = Math.min(batch.numRows, hi - batchRowStart);
            for (let ci = 0; ci < columns.length; ci++) {
                const colIdx = columns[ci];
                const field = fields[colIdx];
                const child = batch.getChildAt(colIdx)!;
                for (let r = localLo; r < localHi; r++) {
                    const cell = encodeArrowCell(child, r, field);
                    rows[batchRowStart + r - lo][ci] = cell;
                }
            }
        }
        return { rows, stale: false };
    }

    async getLabels(columnIndex: number, indices: number[]): Promise<Record<number, string>> {
        const t = tableFromIPC(this.file);
        const colName = this.reader.schema.fields[columnIndex].name;
        const c = t.getChild(colName);
        const dict = (c as any).data.dictionary ?? (c as any).data[0]?.dictionary;
        const out: Record<number, string> = {};
        for (const i of indices) out[i] = dict.get(i) as string;
        return out;
    }
}

function upperBoundLE(starts: Uint32Array, v: number): number {
    // largest i such that starts[i] <= v
    let lo = 0, hi = starts.length - 1, ans = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= v) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
}

function encodeArrowCell(child: any, row: number, field: any): Cell {
    const t = String(field.type);
    if (t.startsWith('Dictionary')) {
        // Return raw 0-based index.
        const indices = child.data.values as Int32Array | Int16Array | Int8Array;
        const valid = child.data.nullBitmap;
        if (valid && !((valid[row >> 3] >> (row & 7)) & 1)) return null;
        return indices[row] as number;
    }
    if (t.startsWith('Int')) return child.get(row) ?? null;
    if (t.startsWith('Float')) return encodeNumber(child.get(row));
    if (t === 'Bool') return child.get(row);
    if (t === 'Utf8' || t === 'LargeUtf8') return encodeString(child.get(row));
    if (t.startsWith('Date32')) return encodeDate(child.get(row));
    if (t.startsWith('Timestamp')) {
        const tz = (field.type as any).timezone ?? 'UTC';
        return encodeTimestamp(child.data.values[row] ?? null, tz);
    }
    // Fallback: stringify.
    const v = child.get(row);
    return v === null ? null : encodeString(String(v));
}
```

- [ ] **Step 8: Run reader tests**

```bash
bun test tests/bun/data-viewer-arrow-reader.test.ts
```

Expected: PASS for all in tiny + multibatch suites. The bigdict case may hit dictionary-access quirks; iterate against the spike's pinned API until it works. If `data.dictionary` is not the right access path, fix and re-run.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(data-viewer): ArrowSliceReader + wire format

Indexes record-batch starts on open; serves row windows by decoding
only the requested batches and columns. Wire-format encoders ship
NaN/Inf/Date/timestamp via JSON sentinels so postMessage payloads stay
strict-JSON. High-cardinality dictionaries (>100k entries) are not
shipped in the schema; getLabels resolves them on demand."
```

---

## Task 5: Protocol message types + DataViewerPanel + DataViewerManager

The extension-side panel + manager. Includes `panelGeneration`, schema-hashed layout keys, and **extension-side copy** materialization.

**Files:**
- Create: `editors/vscode/src/data-viewer/messages.ts`
- Create: `editors/vscode/src/data-viewer/csp.ts`
- Create: `editors/vscode/src/data-viewer/layout-state.ts`
- Create: `editors/vscode/src/data-viewer/panel.ts`
- Create: `editors/vscode/src/data-viewer/manager.ts`
- Create: `editors/vscode/src/data-viewer/index.ts`
- Create: `tests/bun/data-viewer-layout-state.test.ts`
- Create: `tests/bun/data-viewer-manager.test.ts`

- [ ] **Step 1: Define the protocol**

Create `editors/vscode/src/data-viewer/messages.ts`:

```ts
import { Cell } from './wire-format';
import { ColumnSchema } from './arrow-reader';

export type Layout = {
    columnWidths: Record<string, number>;   // by column name
    hiddenColumns: string[];
};

export type Settings = {
    missingValueStyle: 'foreground' | 'background' | 'none';
    defaultDigits: number;
};

export type ExtensionToWebview =
    | { type: 'init'; panelGeneration: number; nrow: number; columns: ColumnSchema[];
        layout: Layout; settings: Settings;
        dictionaries: Record<number, string[]> }
    | { type: 'rows'; panelGeneration: number; requestId: number;
        viewportGeneration: number; start: number; end: number;
        rows: Cell[][]; stale: boolean }
    | { type: 'labels'; panelGeneration: number; requestId: number;
        columnIndex: number; labels: Record<number, string> }
    | { type: 'replace'; panelGeneration: number; nrow: number;
        columns: ColumnSchema[]; layout: Layout;
        dictionaries: Record<number, string[]> }
    | { type: 'copyDone'; panelGeneration: number; requestId: number;
        ok: boolean; error?: string }
    | { type: 'error'; panelGeneration: number; message: string };

export type WebviewToExtension =
    | { type: 'getRows'; panelGeneration: number; requestId: number;
        viewportGeneration: number; start: number; end: number;
        columns: number[] }
    | { type: 'getLabels'; panelGeneration: number; requestId: number;
        columnIndex: number; indices: number[] }
    | { type: 'saveLayout'; panelGeneration: number; layout: Layout }
    | { type: 'copy'; panelGeneration: number; requestId: number;
        range: { rowStart: number; rowEnd: number; colIndices: number[] };
        labelsOn: boolean; formatOn: boolean; digits: number };

export const COPY_CELL_LIMIT = 5_000_000;
```

- [ ] **Step 2: CSP helper**

Create `editors/vscode/src/data-viewer/csp.ts` mirroring `plot/csp.ts`:

```ts
import * as vscode from 'vscode';
import * as crypto from 'crypto';

export type CSPInputs = { webview: vscode.Webview; };

export function buildCSP(webview: vscode.Webview): { csp: string; nonce: string } {
    const nonce = crypto.randomBytes(16).toString('hex');
    const csp = [
        `default-src 'none'`,
        `img-src ${webview.cspSource} data:`,
        `script-src ${webview.cspSource} 'nonce-${nonce}'`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `font-src ${webview.cspSource}`,
    ].join('; ');
    return { csp, nonce };
}
```

- [ ] **Step 3: Layout state TDD**

Create `tests/bun/data-viewer-layout-state.test.ts`:

```ts
import { describe, test, expect, beforeEach } from 'bun:test';
import { LayoutStore, schemaHash } from '../../editors/vscode/src/data-viewer/layout-state';

class MemKV {
    private m = new Map<string, unknown>();
    get<T>(k: string, d?: T): T | undefined { return (this.m.get(k) as T) ?? d; }
    update(k: string, v: unknown) { this.m.set(k, v); return Promise.resolve(); }
    keys() { return Array.from(this.m.keys()); }
}

describe('schemaHash', () => {
    test('stable across calls', () => {
        const s = [{ name: 'a', arrowType: 'Int32' }, { name: 'b', arrowType: 'Utf8' }] as any;
        expect(schemaHash(s)).toBe(schemaHash(s));
    });
    test('differs when columns differ', () => {
        const a = [{ name: 'a', arrowType: 'Int32' }] as any;
        const b = [{ name: 'a', arrowType: 'Float64' }] as any;
        expect(schemaHash(a)).not.toBe(schemaHash(b));
    });
});

describe('LayoutStore', () => {
    let kv: MemKV; let store: LayoutStore;
    beforeEach(() => { kv = new MemKV(); store = new LayoutStore(kv as any, 3); });

    test('save then load by composite key', async () => {
        await store.save('mtcars', 'h1', { columnWidths: { x: 100 }, hiddenColumns: [] });
        const got = await store.load('mtcars', 'h1');
        expect(got).toEqual({ columnWidths: { x: 100 }, hiddenColumns: [] });
    });

    test('different schemaHash → different layout', async () => {
        await store.save('mtcars', 'h1', { columnWidths: { x: 100 }, hiddenColumns: [] });
        const got = await store.load('mtcars', 'h2');
        expect(got).toBeUndefined();
    });

    test('LRU eviction respects capacity', async () => {
        for (let i = 0; i < 5; i++) {
            await store.save(`p${i}`, 'h', { columnWidths: {}, hiddenColumns: [] });
        }
        // capacity 3 → only most recent 3 keys remain
        const remaining = kv.keys().filter(k => k.startsWith('raven.dataViewer.layout::'));
        expect(remaining.length).toBe(3);
    });
});
```

- [ ] **Step 4: Implement LayoutStore**

Create `editors/vscode/src/data-viewer/layout-state.ts`:

```ts
import { ColumnSchema } from './arrow-reader';
import { Layout } from './messages';

const PREFIX = 'raven.dataViewer.layout::';
const ORDER_KEY = 'raven.dataViewer.layoutOrder';

export type Memento = {
    get<T>(k: string, d?: T): T | undefined;
    update(k: string, v: unknown): Thenable<void> | Promise<void>;
};

export function schemaHash(cols: Pick<ColumnSchema, 'name' | 'arrowType'>[]): string {
    const s = cols.map(c => `${c.name}\0${c.arrowType}`).join('');
    // FNV-1a 32-bit, stable enough for keying.
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

export class LayoutStore {
    constructor(private readonly kv: Memento, private readonly cap: number) {}

    private key(panelName: string, h: string): string { return `${PREFIX}${panelName}::${h}`; }

    async load(panelName: string, h: string): Promise<Layout | undefined> {
        return this.kv.get<Layout>(this.key(panelName, h));
    }

    async save(panelName: string, h: string, layout: Layout): Promise<void> {
        const k = this.key(panelName, h);
        await this.kv.update(k, layout);
        const order = (this.kv.get<string[]>(ORDER_KEY) ?? []).filter(x => x !== k);
        order.push(k);
        while (order.length > this.cap) {
            const evict = order.shift()!;
            await this.kv.update(evict, undefined);
        }
        await this.kv.update(ORDER_KEY, order);
    }
}
```

- [ ] **Step 5: Run layout tests**

```bash
bun test tests/bun/data-viewer-layout-state.test.ts
```

Expected: PASS.

- [ ] **Step 6: DataViewerPanel + Manager skeleton**

Create `editors/vscode/src/data-viewer/panel.ts`:

```ts
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { ArrowSliceReader, ColumnSchema } from './arrow-reader';
import { Cell } from './wire-format';
import {
    COPY_CELL_LIMIT, ExtensionToWebview, Layout, Settings, WebviewToExtension,
} from './messages';
import { LayoutStore, schemaHash } from './layout-state';
import { buildCSP } from './csp';

export class DataViewerPanel {
    readonly panelName: string;
    private readonly webview: vscode.WebviewPanel;
    private reader: ArrowSliceReader;
    private filePath: string;
    private generation = 0;
    private dictionaries: Record<number, string[]> = {};
    private columns: ColumnSchema[] = [];
    private layoutHash = '';
    private layout: Layout = { columnWidths: {}, hiddenColumns: [] };

    constructor(
        panelName: string,
        webview: vscode.WebviewPanel,
        reader: ArrowSliceReader,
        filePath: string,
        private readonly store: LayoutStore,
        private readonly settings: Settings,
        private readonly disposeOnClose: () => void,
    ) {
        this.panelName = panelName;
        this.webview = webview;
        this.reader = reader;
        this.filePath = filePath;
        this.webview.onDidDispose(() => this.dispose());
        this.webview.webview.onDidReceiveMessage((m: WebviewToExtension) => this.handle(m));
    }

    static async create(
        panelName: string,
        reader: ArrowSliceReader,
        filePath: string,
        store: LayoutStore,
        settings: Settings,
        extensionUri: vscode.Uri,
        dispose: () => void,
    ): Promise<DataViewerPanel> {
        const webview = vscode.window.createWebviewPanel(
            'raven.dataViewer',
            panelName,
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        webview.webview.html = build_html(webview.webview, extensionUri);
        const p = new DataViewerPanel(panelName, webview, reader, filePath, store, settings, dispose);
        await p.sendInit();
        return p;
    }

    async replace(reader: ArrowSliceReader, filePath: string): Promise<void> {
        this.generation += 1;
        try { await fs.unlink(this.filePath); } catch { /* ignore */ }
        this.reader = reader;
        this.filePath = filePath;
        await this.sendReplace();
    }

    reveal(): void { this.webview.reveal(); }

    private async sendInit(): Promise<void> {
        this.columns = this.reader.schema.columns;
        this.layoutHash = schemaHash(this.columns);
        this.layout = (await this.store.load(this.panelName, this.layoutHash))
            ?? { columnWidths: {}, hiddenColumns: [] };
        this.dictionaries = this.collectDictionaries();
        const msg: ExtensionToWebview = {
            type: 'init',
            panelGeneration: this.generation,
            nrow: this.reader.nrow,
            columns: this.columns,
            layout: this.layout,
            settings: this.settings,
            dictionaries: this.dictionaries,
        };
        this.webview.webview.postMessage(msg);
    }

    private async sendReplace(): Promise<void> {
        this.columns = this.reader.schema.columns;
        this.layoutHash = schemaHash(this.columns);
        this.layout = (await this.store.load(this.panelName, this.layoutHash))
            ?? { columnWidths: {}, hiddenColumns: [] };
        this.dictionaries = this.collectDictionaries();
        const msg: ExtensionToWebview = {
            type: 'replace',
            panelGeneration: this.generation,
            nrow: this.reader.nrow,
            columns: this.columns,
            layout: this.layout,
            dictionaries: this.dictionaries,
        };
        this.webview.webview.postMessage(msg);
    }

    private collectDictionaries(): Record<number, string[]> {
        const out: Record<number, string[]> = {};
        this.columns.forEach((c, i) => { if (c.dictionaryShipped && c.dictionary) out[i] = c.dictionary; });
        return out;
    }

    private async handle(m: WebviewToExtension): Promise<void> {
        if (m.panelGeneration !== this.generation) return;
        switch (m.type) {
            case 'getRows': {
                this.reader.setLatestViewportGeneration(m.viewportGeneration);
                const out = await this.reader.getRows({
                    start: m.start, end: m.end, columns: m.columns,
                    viewportGeneration: m.viewportGeneration,
                });
                const reply: ExtensionToWebview = {
                    type: 'rows',
                    panelGeneration: this.generation,
                    requestId: m.requestId,
                    viewportGeneration: m.viewportGeneration,
                    start: m.start, end: m.end,
                    rows: out.rows, stale: out.stale,
                };
                this.webview.webview.postMessage(reply);
                return;
            }
            case 'getLabels': {
                const labels = await this.reader.getLabels(m.columnIndex, m.indices);
                const reply: ExtensionToWebview = {
                    type: 'labels',
                    panelGeneration: this.generation,
                    requestId: m.requestId,
                    columnIndex: m.columnIndex,
                    labels,
                };
                this.webview.webview.postMessage(reply);
                return;
            }
            case 'saveLayout': {
                this.layout = m.layout;
                await this.store.save(this.panelName, this.layoutHash, m.layout);
                return;
            }
            case 'copy': {
                await this.handleCopy(m);
                return;
            }
        }
    }

    private async handleCopy(m: Extract<WebviewToExtension, { type: 'copy' }>): Promise<void> {
        const cells = (m.range.rowEnd - m.range.rowStart) * m.range.colIndices.length;
        const reply = (ok: boolean, error?: string): ExtensionToWebview => ({
            type: 'copyDone', panelGeneration: this.generation,
            requestId: m.requestId, ok, error,
        });
        if (cells > COPY_CELL_LIMIT) {
            this.webview.webview.postMessage(reply(false, 'Selection exceeds copy limit'));
            return;
        }
        const got = await this.reader.getRows({
            start: m.range.rowStart, end: m.range.rowEnd,
            columns: m.range.colIndices,
            viewportGeneration: Number.MAX_SAFE_INTEGER,
        });
        const tsv = renderTsv(got.rows, m.range.colIndices, this.columns,
                              this.dictionaries, m.labelsOn, m.formatOn, m.digits);
        await vscode.env.clipboard.writeText(tsv);
        this.webview.webview.postMessage(reply(true));
    }

    private async dispose(): Promise<void> {
        try { await fs.unlink(this.filePath); } catch { /* ignore */ }
        this.disposeOnClose();
    }
}

export function renderTsv(
    rows: Cell[][],
    colIndices: number[],
    columns: ColumnSchema[],
    dictionaries: Record<number, string[]>,
    labelsOn: boolean,
    formatOn: boolean,
    digits: number,
): string {
    const lines: string[] = [];
    for (const row of rows) {
        const parts: string[] = [];
        row.forEach((cell, j) => {
            parts.push(formatCellForTsv(cell, columns[colIndices[j]], dictionaries[colIndices[j]], labelsOn, formatOn, digits));
        });
        lines.push(parts.join('\t'));
    }
    return lines.join('\n');
}

function formatCellForTsv(
    cell: Cell,
    col: ColumnSchema | undefined,
    dict: string[] | undefined,
    labelsOn: boolean,
    formatOn: boolean,
    digits: number,
): string {
    if (cell === null) return '';
    if (typeof cell === 'object' && cell && '_' in cell) {
        switch (cell._) {
            case 'nan': return 'NaN';
            case 'inf': return 'Inf';
            case '-inf': return '-Inf';
            case 'date': return cell.v;
            case 'ts': return cell.v;
            case 'trunc': return cell.v;
        }
    }
    if (typeof cell === 'number' && col?.dictionaryShipped && dict) {
        return labelsOn && dict[cell] !== undefined ? dict[cell] : String(cell + 1);
    }
    if (typeof cell === 'number' && col && !col.isInteger && formatOn) {
        return cell.toFixed(digits);
    }
    return String(cell).replace(/[\t\n\r]/g, ' ');
}

function build_html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const { csp, nonce } = buildCSP(webview);
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(
        extensionUri, 'dist', 'data-viewer-webview', 'main.js'));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(
        extensionUri, 'dist', 'data-viewer-webview', 'styles.css'));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" type="module" src="${jsUri}"></script>
</body>
</html>`;
}
```

Create `editors/vscode/src/data-viewer/manager.ts`:

```ts
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { ArrowSliceReader } from './arrow-reader';
import { DataViewerPanel } from './panel';
import { LayoutStore } from './layout-state';
import { Settings } from './messages';
import { ViewDataEvent } from '../r-session-server/types';

export class DataViewerManager {
    private readonly panels = new Map<string, DataViewerPanel>();

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly store: LayoutStore,
        private readonly settings: () => Settings,
    ) {}

    async onViewDataRequested(e: ViewDataEvent): Promise<void> {
        const reader = new ArrowSliceReader(e.filePath);
        const existing = this.panels.get(e.panelName);
        if (existing) {
            await existing.replace(reader, e.filePath);
            existing.reveal();
            return;
        }
        const panel = await DataViewerPanel.create(
            e.panelName, reader, e.filePath, this.store, this.settings(),
            this.extensionUri,
            () => this.panels.delete(e.panelName),
        );
        this.panels.set(e.panelName, panel);
    }

    static async sweepStale(dir: string, maxAgeMs: number, now = Date.now()): Promise<number> {
        let count = 0;
        try {
            const entries = await fs.readdir(dir);
            for (const name of entries) {
                const fp = join(dir, name);
                try {
                    const st = await fs.stat(fp);
                    if (now - st.mtimeMs > maxAgeMs) {
                        await fs.unlink(fp);
                        count++;
                    }
                } catch { /* ignore */ }
            }
        } catch { /* dir missing is fine */ }
        return count;
    }
}
```

Create `editors/vscode/src/data-viewer/index.ts`:

```ts
import * as vscode from 'vscode';
import { join } from 'node:path';
import { DataViewerManager } from './manager';
import { LayoutStore } from './layout-state';
import { Settings } from './messages';
import { RSessionServer } from '../r-session-server';

export function registerDataViewer(
    context: vscode.ExtensionContext,
    server: RSessionServer,
): void {
    const cap = vscode.workspace.getConfiguration('raven.dataViewer')
        .get<number>('maxStoredLayouts', 10000);
    const store = new LayoutStore(context.globalState as any, cap);
    const settings = (): Settings => ({
        missingValueStyle: vscode.workspace.getConfiguration('raven.dataViewer')
            .get<'foreground' | 'background' | 'none'>('missingValueStyle', 'foreground'),
        defaultDigits: vscode.workspace.getConfiguration('raven.dataViewer')
            .get<number>('defaultDigits', 3),
    });
    const manager = new DataViewerManager(context.extensionUri, store, settings);
    const dataViewerDir = join(context.globalStorageUri.fsPath, 'data-viewer');
    void DataViewerManager.sweepStale(dataViewerDir, 24 * 3600 * 1000);
    server.onEvent(e => {
        if (e.type === 'view-data-requested') void manager.onViewDataRequested(e);
    });
}
```

- [ ] **Step 7: Manager + Panel tests**

Create `tests/bun/data-viewer-manager.test.ts`. Build a `vscode` shim object (mirror what `tests/bun/plot-viewer-csp.test.ts` already does) sufficient to instantiate the panel — just `createWebviewPanel` returning a stub that records `postMessage` calls and exposes a `triggerMessage` helper, plus a `clipboard` mock and a `Uri.joinPath` polyfill. Cover:

```ts
// Pseudocode outline; full implementation lives in the test file.
// Use Bun.mock or a manual ./vscode-shim.ts.

describe('DataViewerManager', () => {
    test('first event creates a panel and posts init', async () => { /* ... */ });
    test('second event with same panelName replaces and increments generation', async () => {
        // Assert panelGeneration on the second post is greater than the first.
    });
    test('layouts hashed by schema: differing schemas get different layouts', async () => { /* ... */ });
    test('late getRows reply with old panelGeneration is dropped', async () => { /* ... */ });
    test('extension-side copy materializes TSV honoring labels/format', async () => { /* ... */ });
    test('copy refused when range exceeds COPY_CELL_LIMIT', async () => { /* ... */ });
    test('panel disposal deletes the file', async () => { /* ... */ });
});

describe('DataViewerManager.sweepStale', () => {
    test('deletes files older than max age, leaves newer', async () => { /* ... */ });
});
```

Implement each described scenario with concrete code, asserting against the recorded postMessage queue.

- [ ] **Step 8: Run all data-viewer tests so far**

```bash
bun test tests/bun/data-viewer-*.test.ts
```

Expected: PASS for wire-format, arrow-reader, layout-state, manager.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(data-viewer): panel + manager with extension-side copy

DataViewerPanel owns one Arrow file, increments panelGeneration on
replace, and materializes copy-as-TSV in the extension so whole-frame
selections work regardless of what the webview has loaded.
DataViewerManager routes view-data-requested events by panelName and
sweeps stale files on activation."
```

---

## Task 6: Bootstrap profile — install the View() override

The R bootstrap profile gains a new `local({...})` block at the **top** that installs `View()` independent of the plot bridge. Existing plot tests must still pass.

**Files:**
- Modify: `editors/vscode/src/plot/r-bootstrap-profile.ts`
- Create: `tests/bun/data-viewer-bootstrap-content.test.ts`
- Modify: `crates/raven/tests/` (add R-integration test in next sub-step)

- [ ] **Step 1: Failing content test**

Create `tests/bun/data-viewer-bootstrap-content.test.ts`:

```ts
import { describe, test, expect } from 'bun:test';
import { generate_profile_source } from '../../editors/vscode/src/plot/r-bootstrap-profile';

const src = generate_profile_source();

describe('bootstrap profile: data-viewer block', () => {
    test('installs View() override before the plot bridge', () => {
        const viewIdx = src.indexOf('# Raven data viewer block');
        const plotIdx = src.indexOf('httpgd::hgd');
        expect(viewIdx).toBeGreaterThan(-1);
        expect(plotIdx).toBeGreaterThan(-1);
        expect(viewIdx).toBeLessThan(plotIdx);
    });
    test('uses its own local({}) block', () => {
        const viewIdx = src.indexOf('# Raven data viewer block');
        const localAfter = src.indexOf('local({', viewIdx);
        const closeAfter = src.indexOf('})', localAfter);
        const plotLocal = src.indexOf('local({', closeAfter);
        expect(localAfter).toBeGreaterThan(viewIdx);
        expect(closeAfter).toBeGreaterThan(localAfter);
        expect(plotLocal).toBeGreaterThan(closeAfter);
    });
    test('checks for arrow package and skips if missing', () => {
        expect(src).toContain('requireNamespace("arrow"');
    });
    test('overrides View in globalenv', () => {
        expect(src).toContain('assign("View"');
        expect(src).toContain('globalenv()');
    });
    test('errors with the Positron-style message for unsupported types', () => {
        expect(src).toContain("Can't `View()` an object of class");
    });
    test('truncates panelName to 256 chars with ellipsis', () => {
        expect(src).toMatch(/256/);
    });
    test('POSTs /view-data with body shape sessionId/panelName/filePath/nrow', () => {
        expect(src).toContain('/view-data');
        expect(src).toMatch(/"sessionId"/);
        expect(src).toMatch(/"panelName"/);
        expect(src).toMatch(/"filePath"/);
        expect(src).toMatch(/"nrow"/);
        expect(src).not.toMatch(/"schemaJson"/);
    });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
bun test tests/bun/data-viewer-bootstrap-content.test.ts
```

Expected: FAIL on the comment-marker checks.

- [ ] **Step 3: Implement the new block**

In `editors/vscode/src/plot/r-bootstrap-profile.ts`, insert a new `local({...})` block at the top of the returned source (right after the leading comment). The block must:

1. Source the user's profile (the existing plot code does this; **lift it into a small shared helper** at the top of the file so both blocks call it once). Keep the resulting behavior unchanged: the user's `.Rprofile` runs at most once, before either bridge.
2. Check `requireNamespace("arrow", quietly = TRUE)`; if missing, `message()` once and `return(invisible(NULL))`.
3. Define a function that:
   - Reads `RAVEN_SESSION_PORT` / `RAVEN_SESSION_TOKEN`.
   - Reads `RAVEN_DATA_VIEWER_DIR` (a new env var the extension sets — to be added in Task 11).
   - Names the panel: `if (missing(title)) deparse1(substitute(x), collapse = " ")` truncated to 256 chars with trailing `…`.
   - Dispatches: `is.data.frame(x) || is.matrix(x)` → write Arrow + POST. Otherwise `stop("Can't `View()` an object of class `", paste(class(x), collapse = "/"), "`")`.
   - Pre-encodes `haven_labelled` / matrix / list / format-fallback per spec's table. **Truncate** any cell longer than 1024 bytes to `paste0(substr(s, 1, 1023), "…")`.
   - Emits column KV metadata (`raven.variable_label`, `raven.value_labels`, `raven.original_class`, `raven.format`).
   - Writes `arrow::write_feather(df_out, file = path, chunk_size = 65536)`.
   - POSTs `/view-data` with the body `{sessionId, panelName, filePath, nrow}`.
4. Calls `assign("View", view_fn, envir = globalenv())`.

Mark the block with the comment `# Raven data viewer block` exactly so the content test can find it.

- [ ] **Step 4: Re-run content tests**

```bash
bun test tests/bun/data-viewer-bootstrap-content.test.ts
```

Expected: PASS for all.

- [ ] **Step 5: Verify existing plot tests still pass**

```bash
bun test tests/bun/plot-bootstrap-content.test.ts \
    tests/bun/plot-bootstrap-env.test.ts \
    tests/bun/plot-bootstrap-r-integration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(data-viewer): install View() override in bootstrap profile

Adds a self-contained local({...}) block before the plot bridge that
installs View() in globalenv(). The override writes data.frame/matrix
arguments to a Feather v2 file under RAVEN_DATA_VIEWER_DIR and POSTs
the path to the extension's loopback server. Unsupported classes raise
a Positron-style error. Plot-bridge failure does not affect the
override."
```

---

## Task 7: R-integration test for the bootstrap

A Rust integration test that spawns R with the generated profile and asserts the bootstrap behaves correctly end-to-end.

**Files:**
- Create: `crates/raven/tests/data_viewer_bootstrap.rs`

- [ ] **Step 1: Write the test**

Create `crates/raven/tests/data_viewer_bootstrap.rs`. Skip when `R` is not on PATH (mirror existing pattern). Build a tiny stub HTTP server in Rust (use `tiny_http` if already a dep, else `std::net::TcpListener`). The test:

```rust
// Skeleton; fill in completely. Mirror the existing plot-bridge integration test.

#[test]
fn data_viewer_view_writes_arrow_and_posts() {
    let Some(r) = which::which("R").ok() else { eprintln!("skip: no R"); return; };
    // 1. Generate the bootstrap source via a Node helper or by inlining the
    //    same JS-emitted source into a fixture file (preferred: read from
    //    editors/vscode/src/plot/r-bootstrap-profile.ts via a small node
    //    invocation, so the test always exercises the real source).
    // 2. Start a stub HTTP listener on 127.0.0.1:0; record requests.
    // 3. Set env: R_PROFILE_USER, RAVEN_SESSION_PORT, RAVEN_SESSION_TOKEN,
    //    RAVEN_DATA_VIEWER_DIR=temp dir, RAVEN_R_SESSION_ID="rsid".
    // 4. Spawn R --no-save and pipe in: View(mtcars).
    // 5. Read the recorded POST body. Assert keys = {sessionId, panelName,
    //    filePath, nrow}; nrow == 32; panelName == "mtcars"; filePath under
    //    RAVEN_DATA_VIEWER_DIR.
    // 6. Open the Arrow file via `arrow-rs` (or just verify magic bytes) and
    //    assert it parses.
}

#[test]
fn data_viewer_view_unsupported_type_errors() { /* spawn R, View(1), expect stderr to contain "Can't \`View()\` an object" */ }

#[test]
fn data_viewer_install_independent_of_httpgd() {
    // Force httpgd missing (set R_LIBS_USER to an empty dir);
    // assert View(mtcars) still POSTs /view-data.
}
```

- [ ] **Step 2: Run the integration test**

```bash
cargo test -p raven --test data_viewer_bootstrap
```

Expected: PASS when R is available, otherwise SKIP with a clear message.

- [ ] **Step 3: Commit**

```bash
git add crates/raven/tests/data_viewer_bootstrap.rs
git commit -m "test(data-viewer): R-integration test for bootstrap View() override"
```

---

## Task 8: Webview — virtualized grid skeleton

A minimal Svelte webview that renders rows for fixed-width columns, plus the model code (grid-model, row-cache, viewport-generation glue). No toolbar yet, no Labels/Format toggles, no selection.

**Files:**
- Create: `editors/vscode/src/data-viewer/webview/main.ts`
- Create: `editors/vscode/src/data-viewer/webview/App.svelte`
- Create: `editors/vscode/src/data-viewer/webview/grid.svelte`
- Create: `editors/vscode/src/data-viewer/webview/grid-model.ts`
- Create: `editors/vscode/src/data-viewer/webview/row-cache.ts`
- Create: `editors/vscode/src/data-viewer/webview/cell-render.ts`
- Create: `editors/vscode/src/data-viewer/webview/styles.css`
- Create: `editors/vscode/src/data-viewer/webview/tsconfig.json`
- Create: `tests/bun/data-viewer-grid-model.test.ts`
- Modify: `editors/vscode/esbuild.config.mjs` (or whatever the current bundler config is — mirror plot)

- [ ] **Step 1: Snapshot how the plot webview is built**

Inspect the bundler config used for the plot webview (`editors/vscode/esbuild.config.mjs` or similar) to see the entry/output pattern. Copy that pattern verbatim for `data-viewer-webview`, with the entry at `editors/vscode/src/data-viewer/webview/main.ts` and output at `editors/vscode/dist/data-viewer-webview/main.js`.

- [ ] **Step 2: grid-model TDD**

Create `tests/bun/data-viewer-grid-model.test.ts` covering:

```ts
import { describe, test, expect } from 'bun:test';
import {
    visibleRange, RowCache, coalesceScroll,
} from '../../editors/vscode/src/data-viewer/webview/grid-model';

describe('visibleRange', () => {
    test('basic computation with overscan', () => {
        const r = visibleRange({ scrollTop: 0, viewportHeight: 100, rowHeight: 24, nrow: 1000, overscan: 2 });
        expect(r).toEqual({ start: 0, end: Math.min(1000, Math.ceil(100/24) + 2) });
    });
    test('clamps end to nrow', () => {
        const r = visibleRange({ scrollTop: 24 * 990, viewportHeight: 100, rowHeight: 24, nrow: 1000, overscan: 2 });
        expect(r.end).toBe(1000);
    });
});

describe('coalesceScroll', () => {
    test('10 events in 16 ms produce 1 fetch', async () => {
        let calls = 0;
        const fn = coalesceScroll(() => calls++, 16);
        for (let i = 0; i < 10; i++) fn();
        await new Promise(r => setTimeout(r, 25));
        expect(calls).toBe(1);
    });
});

describe('RowCache', () => {
    test('LRU eviction by aggregate cell count', () => {
        const c = new RowCache(10);
        c.put(0, 5, [[1,2,3,4,5]]);  // 5 cells
        c.put(5, 10, [[1,2,3,4,5]]); // 5 cells
        c.put(10, 15, [[1,2,3,4,5]]); // would push over 10 → eldest evicted
        expect(c.get(0, 5)).toBeUndefined();
        expect(c.get(5, 10)).toBeDefined();
    });
});
```

- [ ] **Step 3: Implement grid-model + row-cache**

Create `editors/vscode/src/data-viewer/webview/grid-model.ts`:

```ts
export type VisibleArgs = {
    scrollTop: number; viewportHeight: number; rowHeight: number;
    nrow: number; overscan: number;
};

export function visibleRange(a: VisibleArgs): { start: number; end: number } {
    const start = Math.max(0, Math.floor(a.scrollTop / a.rowHeight) - a.overscan);
    const end = Math.min(a.nrow,
        Math.ceil((a.scrollTop + a.viewportHeight) / a.rowHeight) + a.overscan);
    return { start, end };
}

export function coalesceScroll<T extends (...args: any[]) => void>(fn: T, intervalMs: number): T {
    let timer: any = null;
    let pendingArgs: any[] | null = null;
    const runner = (...args: any[]) => {
        pendingArgs = args;
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            const a = pendingArgs!;
            pendingArgs = null;
            fn(...a);
        }, intervalMs);
    };
    return runner as T;
}
```

Create `editors/vscode/src/data-viewer/webview/row-cache.ts`:

```ts
import { Cell } from '../wire-format';

type Entry = { start: number; end: number; rows: Cell[][]; cells: number; };

export class RowCache {
    private entries = new Map<string, Entry>();
    private cells = 0;
    constructor(private readonly capacity: number) {}

    private k(start: number, end: number): string { return `${start}:${end}`; }

    get(start: number, end: number): Cell[][] | undefined {
        const e = this.entries.get(this.k(start, end));
        if (!e) return;
        // Move to end (LRU touch).
        this.entries.delete(this.k(start, end));
        this.entries.set(this.k(start, end), e);
        return e.rows;
    }

    put(start: number, end: number, rows: Cell[][]): void {
        const cells = rows.length * (rows[0]?.length ?? 0);
        const key = this.k(start, end);
        if (this.entries.has(key)) {
            this.cells -= this.entries.get(key)!.cells;
            this.entries.delete(key);
        }
        this.entries.set(key, { start, end, rows, cells });
        this.cells += cells;
        while (this.cells > this.capacity && this.entries.size > 0) {
            const first = this.entries.keys().next().value!;
            const e = this.entries.get(first)!;
            this.cells -= e.cells;
            this.entries.delete(first);
        }
    }

    clear(): void { this.entries.clear(); this.cells = 0; }
}
```

- [ ] **Step 4: Run grid-model tests**

```bash
bun test tests/bun/data-viewer-grid-model.test.ts
```

Expected: PASS.

- [ ] **Step 5: Implement Svelte components**

Create the four Svelte / TS files described above. Keep behaviors minimal:

- `App.svelte`: subscribes to `window.acquireVsCodeApi()`, posts `getRows` for the visible window, renders `<Grid>`.
- `Grid.svelte`: virtualized vertical scrolling using a CSS spacer of `nrow * rowHeight`. Hidden columns are filtered before render. Sticky header + sticky first column (row numbers).
- `cell-render.ts`: pure function `formatCell(cell, columnSchema, dictionary, labelsOn, formatOn, digits)` mirroring `formatCellForTsv` but returning a `{ text, missing: boolean }` so the grid can apply missing-value styling.
- `styles.css`: `position: sticky` for header and first column; `font-variant-numeric: tabular-nums` for numerics.

- [ ] **Step 6: Smoke build**

```bash
cd editors/vscode && bun run build
```

Expected: a `dist/data-viewer-webview/main.js` file is produced. If the existing build script bundles only one webview, extend it to also bundle the data-viewer webview, mirroring the plot pattern.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(data-viewer): minimal virtualized webview

Skeleton Svelte webview with grid-model (visible-range math, scroll
coalescing, LRU row cache) and a sticky header + row-number column.
No toolbar yet."
```

---

## Task 9: Toolbar — Labels, Format, digits, Columns popover, row counter

**Files:**
- Create: `editors/vscode/src/data-viewer/webview/toolbar.svelte`
- Modify: `editors/vscode/src/data-viewer/webview/App.svelte`
- Modify: `editors/vscode/src/data-viewer/webview/cell-render.ts` (Labels/Format paths)
- Add tests in: `tests/bun/data-viewer-grid-model.test.ts`

- [ ] **Step 1: cell-render tests for Labels/Format**

Append to `tests/bun/data-viewer-grid-model.test.ts`:

```ts
import { formatCell } from '../../editors/vscode/src/data-viewer/webview/cell-render';

describe('formatCell — Labels toggle', () => {
    test('factor with Labels off shows 1-based code', () => {
        const r = formatCell(0, { name: 'f', arrowType: 'Dictionary<Int32, Utf8>',
            isInteger: false, dictionaryShipped: true } as any,
            ['low', 'med', 'high'], false, false, 3);
        expect(r.text).toBe('1');
    });
    test('factor with Labels on shows level', () => {
        const r = formatCell(2, { name: 'f', arrowType: 'Dictionary<Int32, Utf8>',
            isInteger: false, dictionaryShipped: true } as any,
            ['low', 'med', 'high'], true, false, 3);
        expect(r.text).toBe('high');
    });
    test('integer column ignores Format', () => {
        const r = formatCell(7, { name: 'i', arrowType: 'Int32', isInteger: true,
            dictionaryShipped: false } as any, undefined, false, true, 4);
        expect(r.text).toBe('7');
    });
    test('float column rounds when Format on', () => {
        const r = formatCell(1.23456, { name: 'v', arrowType: 'Float64', isInteger: false,
            dictionaryShipped: false } as any, undefined, false, true, 2);
        expect(r.text).toBe('1.23');
    });
    test('NaN passthrough', () => {
        const r = formatCell({ _: 'nan' }, undefined, undefined, false, true, 3);
        expect(r.text).toBe('NaN');
    });
});
```

- [ ] **Step 2: Implement formatCell**

Create `editors/vscode/src/data-viewer/webview/cell-render.ts`:

```ts
import { Cell } from '../wire-format';
import { ColumnSchema } from '../arrow-reader';

export type FormattedCell = { text: string; missing: boolean };

export function formatCell(
    cell: Cell,
    col: ColumnSchema | undefined,
    dictionary: string[] | undefined,
    labelsOn: boolean,
    formatOn: boolean,
    digits: number,
): FormattedCell {
    if (cell === null) return { text: '', missing: true };
    if (typeof cell === 'object' && cell && '_' in cell) {
        switch (cell._) {
            case 'nan': return { text: 'NaN', missing: true };
            case 'inf': return { text: 'Inf', missing: false };
            case '-inf': return { text: '-Inf', missing: false };
            case 'date': return { text: cell.v, missing: false };
            case 'ts': return { text: cell.v, missing: false };
            case 'trunc': return { text: cell.v, missing: false };
        }
    }
    if (typeof cell === 'number' && col?.dictionaryShipped) {
        if (labelsOn && dictionary && dictionary[cell] !== undefined) {
            return { text: dictionary[cell], missing: false };
        }
        return { text: String(cell + 1), missing: false }; // 1-based code
    }
    if (typeof cell === 'number' && col && !col.isInteger && formatOn) {
        return { text: cell.toFixed(digits), missing: false };
    }
    return { text: String(cell), missing: false };
}
```

- [ ] **Step 3: Run cell-render tests**

```bash
bun test tests/bun/data-viewer-grid-model.test.ts
```

Expected: PASS for the new cases.

- [ ] **Step 4: Build the Svelte toolbar**

Create `editors/vscode/src/data-viewer/webview/toolbar.svelte` with:

- Two button toggles for Labels and Format.
- A `<select>` digits dropdown bound to `digits`, disabled when `formatOn` is false.
- A "Columns" button opening a popover with one checkbox per column. Use the prior plot popover pattern if it exists; otherwise a minimal `position: absolute` panel with a click-outside handler.
- Right-side row/column counts: `rows: ${nrow}  cols: ${visibleCount}/${total}`.

Wire `App.svelte` so:

- `labelsOn`, `formatOn`, `digits`, and `hiddenColumns` are reactive Svelte stores (or `let` bindings).
- A change to `hiddenColumns` posts `saveLayout` (debounced 250 ms).
- A change to a column width also posts `saveLayout`.

- [ ] **Step 5: Smoke build**

```bash
cd editors/vscode && bun run build
```

Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(data-viewer): toolbar with Labels/Format/digits/Columns"
```

---

## Task 10: Selection model + copy glue

The webview side of selection + copy. Server-side copy already exists (Task 5).

**Files:**
- Create: `editors/vscode/src/data-viewer/webview/selection-model.ts`
- Modify: `editors/vscode/src/data-viewer/webview/grid.svelte`
- Modify: `editors/vscode/src/data-viewer/webview/App.svelte`
- Add tests to `tests/bun/data-viewer-grid-model.test.ts`

- [ ] **Step 1: selection-model tests**

```ts
import { Selection } from '../../editors/vscode/src/data-viewer/webview/selection-model';

describe('Selection', () => {
    test('rectangle from anchor + focus', () => {
        const s = new Selection();
        s.anchor(2, 3); s.focus(5, 1);
        expect(s.rect()).toEqual({ rowStart: 2, rowEnd: 6, colStart: 1, colEnd: 4 });
    });
    test('selectAll spans nrow × visibleCols', () => {
        const s = new Selection();
        s.selectAll(1000, [0, 2, 4]);
        expect(s.rect()).toEqual({ rowStart: 0, rowEnd: 1000, colStart: 0, colEnd: 5 });
        expect(s.colIndices()).toEqual([0, 2, 4]);
    });
});
```

- [ ] **Step 2: Implement Selection**

Create `editors/vscode/src/data-viewer/webview/selection-model.ts`:

```ts
export type Rect = { rowStart: number; rowEnd: number; colStart: number; colEnd: number; };

export class Selection {
    private a: { row: number; col: number } | null = null;
    private f: { row: number; col: number } | null = null;
    private explicitCols: number[] | null = null;

    anchor(row: number, col: number): void { this.a = { row, col }; this.f = { row, col }; this.explicitCols = null; }
    focus(row: number, col: number): void { this.f = { row, col }; this.explicitCols = null; }
    selectAll(nrow: number, visibleCols: number[]): void {
        this.a = { row: 0, col: visibleCols[0] ?? 0 };
        this.f = { row: nrow - 1, col: visibleCols[visibleCols.length - 1] ?? 0 };
        this.explicitCols = visibleCols;
    }
    clear(): void { this.a = this.f = null; this.explicitCols = null; }

    rect(): Rect | null {
        if (!this.a || !this.f) return null;
        return {
            rowStart: Math.min(this.a.row, this.f.row),
            rowEnd: Math.max(this.a.row, this.f.row) + 1,
            colStart: Math.min(this.a.col, this.f.col),
            colEnd: Math.max(this.a.col, this.f.col) + 1,
        };
    }

    colIndices(): number[] | null { return this.explicitCols; }
}
```

- [ ] **Step 3: Wire selection into Grid + App**

`Grid.svelte` handles `pointerdown` (anchor), `pointermove with buttons & 1` (focus), `pointerup` (commit). Highlights cells inside `rect()`.

`App.svelte` listens for `keydown`:
- `Cmd/Ctrl+A` → `selection.selectAll(nrow, visibleCols)` then re-render.
- `Cmd/Ctrl+C` → posts:

```ts
post({
    type: 'copy',
    panelGeneration: lastPanelGen,
    requestId: nextId(),
    range: {
        rowStart: rect.rowStart, rowEnd: rect.rowEnd,
        colIndices: selection.colIndices() ??
            range(rect.colStart, rect.colEnd).filter(i => !hiddenSet.has(i)),
    },
    labelsOn, formatOn, digits,
});
```

`copyDone` failures show a toast (a small `position: fixed` div that times out).

- [ ] **Step 4: Run selection tests**

```bash
bun test tests/bun/data-viewer-grid-model.test.ts
```

Expected: PASS.

- [ ] **Step 5: Smoke build**

```bash
cd editors/vscode && bun run build
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(data-viewer): selection + copy glue (extension-side TSV)"
```

---

## Task 11: Wire activation, R env vars, and settings

Pull the manager into extension activation, set the `RAVEN_DATA_VIEWER_DIR` env var on Raven-managed terminals, and expose the four settings.

**Files:**
- Modify: `editors/vscode/src/extension.ts`
- Modify: `editors/vscode/src/plot/r-bootstrap-profile.ts` (add `RAVEN_DATA_VIEWER_DIR` to `BuildEnvInputs` / `RavenPlotEnv`; rename type to `RavenRSessionEnv` if appropriate)
- Modify: any place that constructs the `R_PROFILE_USER` env (search for `RAVEN_SESSION_PORT`)
- Modify: `editors/vscode/package.json` (add 4 settings + ensure `apache-arrow` in deps)
- Modify: `editors/vscode/src/test/settings.test.ts` if there is a generic "no LSP setting forgotten" check

- [ ] **Step 1: Settings in package.json**

Add to `contributes.configuration.properties`:

```json
"raven.dataViewer.enabled": {
    "type": "boolean", "default": true,
    "description": "Override View() in the Raven-managed R terminal."
},
"raven.dataViewer.missingValueStyle": {
    "type": "string", "enum": ["foreground", "background", "none"],
    "default": "foreground",
    "description": "How to highlight missing values (NA, NaN) in the data viewer."
},
"raven.dataViewer.maxStoredLayouts": {
    "type": "integer", "default": 10000, "minimum": 0,
    "description": "Maximum persisted column-layout entries before LRU eviction."
},
"raven.dataViewer.defaultDigits": {
    "type": "integer", "default": 3, "minimum": 0, "maximum": 15,
    "description": "Initial digits used when the Format toggle is on."
}
```

- [ ] **Step 2: Env-var wiring**

Where the plot bootstrap env is built (`build_terminal_env`), add `RAVEN_DATA_VIEWER_DIR` set to the absolute path of `<globalStorageUri>/data-viewer/`. Ensure that directory is created on first use (`fs.mkdir(... { recursive: true })`).

- [ ] **Step 3: Activate the data viewer**

In `editors/vscode/src/extension.ts` activation:

```ts
import { registerDataViewer } from './data-viewer';

if (vscode.workspace.getConfiguration('raven.dataViewer').get('enabled', true)) {
    registerDataViewer(context, plotServices.server);
}
```

Construct `RSessionServer` with `allowedDataViewerDir` set to the same directory; if data viewer is disabled, pass `''` and the route will reject all `/view-data` calls.

- [ ] **Step 4: Smoke build**

```bash
cd editors/vscode && bun run build
```

- [ ] **Step 5: Run the full Bun suite**

```bash
bun test
```

Expected: PASS for all data viewer tests + all existing plot/help/etc. tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(data-viewer): activation, env wiring, settings

Adds raven.dataViewer.* settings and registers the data viewer in
extension activation. The Raven terminal env now carries
RAVEN_DATA_VIEWER_DIR pointing at <globalStorage>/data-viewer/."
```

---

## Task 12: VS Code end-to-end Mocha test

A real-extension test that runs only when R is installed. Mirrors `editors/vscode/src/test/plot/restart.test.ts`.

**Files:**
- Create: `editors/vscode/src/test/data-viewer/end-to-end.test.ts`

- [ ] **Step 1: Write the test**

```ts
// Skeleton; expand to runnable Mocha + vscode-test code.

suite('Data viewer end-to-end', function () {
    this.timeout(60_000);
    test('View(mtcars) opens a panel titled mtcars', async () => {
        // ensure R on PATH; otherwise this.skip()
        // open Raven R terminal via the existing helper
        // send "View(mtcars)\n"
        // poll vscode.window for a webview panel with title 'mtcars'
        // assert it exists within 30s
    });
    test('second View(mtcars) reuses the tab', async () => { /* same panel ID */ });
    test('View(head(mtcars, 5)) opens a separate tab', async () => { /* different name */ });
});
```

- [ ] **Step 2: Run from the wrapper subprocess test at root**

```bash
bun test tests/bun/workspace-suite.test.ts
```

Per CLAUDE.md, the root Bun runner does not recurse into `editors/vscode/src/test`; the wrapper invokes `vscode-test` separately.

Expected: PASS when R is present, SKIP otherwise.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(data-viewer): end-to-end VS Code suite

Verifies View(mtcars) opens a panel, repeated View() reuses the tab,
and a different deparse opens a new tab."
```

---

## Task 13: Documentation

**Files:**
- Create: `docs/data-viewer.md`
- Modify: `docs/send-to-r.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Write `docs/data-viewer.md`**

Cover: how to trigger (View() in a Raven R terminal), supported types, the Labels and Format toggles, missing-value styles, settings, and troubleshooting (`arrow` missing, viewer doesn't open, copying fails on huge selections).

- [ ] **Step 2: Add a "Data Viewer" section to `docs/send-to-r.md`**

Mirror the existing "Plot Viewer" section; link to `docs/data-viewer.md`.

- [ ] **Step 3: Add `docs/data-viewer.md` pointer to CLAUDE.md "What to read"**

- [ ] **Step 4: Commit**

```bash
git add docs/data-viewer.md docs/send-to-r.md CLAUDE.md
git commit -m "docs(data-viewer): user guide and pointers"
```

---

## Final verification

- [ ] **Build the extension once more**

```bash
cd editors/vscode && bun run build
```

- [ ] **Run the full Bun suite**

```bash
bun test
```

Expected: all PASS.

- [ ] **Run cargo tests**

```bash
cargo test -p raven
```

Expected: all PASS (R-integration test SKIPs cleanly without R).

- [ ] **Manual verification with R installed**

1. Open VS Code in this repo.
2. Open a Raven R terminal.
3. Run `install.packages("arrow")` if needed.
4. Run `View(mtcars)`. Confirm a tab named `mtcars` opens with the expected columns.
5. Toggle Labels: factor columns from `mtcars` aren't applicable; use `View(iris)` instead and confirm `Species` switches between integer codes and level strings.
6. Toggle Format with `View(mtcars)`; confirm `mpg` rounds to 3 digits by default and updates with the dropdown.
7. Hide a column via the Columns popover; close and reopen with `View(mtcars)`; confirm the layout persists.
8. Select 100 rows × 3 cols; `Cmd/Ctrl+C`; paste into a spreadsheet — confirm TSV is correct and respects the active toggles.
9. Run `View(1)`; confirm the Positron-style error appears in R.
10. Generate a 10 M-row × 10-col synthetic frame and `View()` it; confirm scrolling stays smooth and RSS is bounded.

- [ ] **Open the PR**

```bash
git push -u origin data-viewer
gh pr create --title "Data viewer: View() override with virtualized Arrow grid" --body "$(cat <<'EOF'
## Summary
- Adds a Raven-owned data viewer that overrides R's `View()` in the bootstrap profile and renders frames in a virtualized Svelte grid.
- Frames are written by R via `arrow::write_feather` and sliced on demand by the extension via `apache-arrow`, so gigabyte-scale data stays bounded in RAM.
- Toolbar exposes Labels (factor codes ↔ levels, haven value labels) and a Format toggle with a digits dropdown.
- Layout persistence keyed by `<panelName>::<schemaHash>`; whole-frame copy materialized in the extension to avoid webview memory pressure.

Spec: `docs/superpowers/specs/2026-05-08-data-viewer-design.md`
Plan: `docs/superpowers/plans/2026-05-08-data-viewer.md`

## Test plan
- [ ] `bun test`
- [ ] `cargo test -p raven`
- [ ] Manual: View(mtcars), View(iris) Labels toggle, Format digits, Columns popover persistence, copy → spreadsheet, View(1) error, 10 M-row stress.
EOF
)"
```

---

## Spec coverage cross-check

| Spec section | Covered by task |
|---|---|
| Trigger and panel lifecycle (View override, deparse 256 char cap, dispatch by class, replace algorithm) | T6 (override), T5 (replace), T7 (integration) |
| Storage format (Arrow IPC, encoding rules incl. 1 KiB list-col cap, matrix rownames rule, integer64/complex/raw) | T6 (R side), T1+T4 (fixtures + reader) |
| Schema metadata (variable_label, value_labels, original_class, format) | T4 (reader), T6 (R side), T7 (assertion) |
| Wire format for cells (NaN/Inf/Date/timestamp/trunc, factor 0-based) | T4 (encoder + reader), T9 (decoder via formatCell), T8 (cell-render) |
| File lifecycle and path-trust check | T3 (route check), T5 (deletion on replace + dispose), T11 (sweep + env) |
| Session server reuse (rename, /view-data route) | T2, T3 |
| ArrowSliceReader (batch index, generation cancel, dictionary threshold, getLabels) | T4 |
| DataViewerPanel (panelGeneration, schema-hashed layouts, extension-side copy) | T5 |
| DataViewerManager (singleton, sweep) | T5, T11 |
| postMessage protocol with generation tags | T5 (typing), T8/T9/T10 (use) |
| File layout — `panel.ts` builds HTML inline | T5 |
| Toolbar (Labels, Format + digits, Columns popover, row counter) | T9 |
| Selection & copy (rectangle + Cmd-A + extension-side TSV + 5M cap) | T5 (server cap), T10 (client) |
| Error handling table | T3, T5, T6, T9 (toast) |
| Settings (no init-options wiring) | T11 |
| Testing (R integration, reader, route, manager, grid model, layout, e2e) | T1, T3, T4, T5, T6, T7, T8, T9, T10, T12 |
| Documentation | T13 |
| Implementation order matches spec | T1..T13 numbered to spec's order |
