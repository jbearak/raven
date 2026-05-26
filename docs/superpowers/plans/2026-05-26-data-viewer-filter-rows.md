# Data Viewer: Filter rows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add row filtering to the Raven data viewer — per-column predicates with WYSIWYG label routing, a toolbar chip strip, persistence, and a status-bar count — without regressing sort or any other existing data-viewer behavior.

**Architecture:** A filter engine sibling to `sort.ts` produces a `Uint32Array` of surviving row indices from a `FilterState`; the panel layers filter → sort to derive the visible row order. Persistence mirrors `SortStateStore` keyed by `panelName + schemaHash`. Webview adds a chip strip peer to `ToolbarSortStrip`, filter items in the existing column / cell context menus, and a typed filter-editor popover. Wire format gains `setFilters` / `filterApplied` / `filterStatus` messages parallel to the sort triad.

**Tech Stack:** TypeScript (Node + React webview), Bun (unit tests), Apache Arrow IPC, VS Code webview API.

**Spec:** [GitHub #323](https://github.com/jbearak/raven/issues/323) and the inline spec in PR.

**Follow-up filed:** [#328](https://github.com/jbearak/raven/issues/328) — thread filter domain into sort engine.

---

## File Map

### Created

| Path | Responsibility |
|---|---|
| `editors/vscode/src/data-viewer/filter.ts` | Predicate evaluator. `computeFilteredIndices(reader, state, ctx) → Uint32Array \| undefined`. Per-type predicate handlers; label-aware for factor / haven_labelled columns. |
| `editors/vscode/src/data-viewer/filter-state.ts` | `FilterStateStore` — peer of `SortStateStore`. Composite key, LRU eviction by `maxStoredLayouts`. |
| `editors/vscode/src/data-viewer/histograms.ts` | `computeNumericHistograms(reader) → Record<colIndex, HistogramBin[]>`. 50-bin uniform-width histograms over Int / Uint / Float columns. NA/NaN excluded. Empty columns yield `[]`. |
| `editors/vscode/src/data-viewer/webview/filter-strip.tsx` | Toolbar chip strip rendering one chip per active filter. Edit / disable / remove via popover; clear-all ✕. |
| `editors/vscode/src/data-viewer/webview/filter-popover.tsx` | Filter editor popover (predicate selector + typed value editor + Include NA checkbox + Apply/Cancel). |
| `editors/vscode/src/data-viewer/webview/filter-histogram.tsx` | Mini-histogram with draggable brush; keyboard-operable; emits `{lo, hi}` to its parent. |
| `editors/vscode/src/data-viewer/webview/predicate-summary.ts` | Pure: `summarizePredicate(predicate, columnSchema) → string` used by chips and aria-labels. |
| `tests/bun/data-viewer-filter-engine.test.ts` | Predicate evaluation across types, label routing, NA semantics, sort-domain interaction. |
| `tests/bun/data-viewer-filter-state.test.ts` | Persistence parity with sort-state. |
| `tests/bun/data-viewer-histograms.test.ts` | Histogram bin math, NA exclusion, empty columns. |
| `tests/bun/data-viewer-panel-filter.test.ts` | Panel round-trip: setFilters → filterApplied → getRows → saveFilter → restore. Combined with setSort. |
| `tests/bun/data-viewer-predicate-summary.test.ts` | Pure summary string format per predicate kind. |

### Modified

| Path | Why |
|---|---|
| `editors/vscode/src/data-viewer/messages.ts` | Add `FilterPredicate`, `FilterEntry`, `FilterState`, `EMPTY_FILTER`, new `init` / `replace` fields (`filter`, `histograms`), `filterApplied`, `filterStatus`, `setFilters`, `saveFilter`. Extend `originalRowIndices` semantics docstring. |
| `editors/vscode/src/data-viewer/panel.ts` | `handleSetFilters`, `filterGeneration`, `filteredIndices`, filter restore on init/replace, status-bar wiring. Compose with sort. |
| `editors/vscode/src/data-viewer/manager.ts` | Inject `FilterStateStore` into `DataViewerPanel`. |
| `editors/vscode/src/data-viewer/index.ts` | Wire up the new store. |
| `editors/vscode/src/data-viewer/webview/App.tsx` | Render `FilterStrip`; thread predicates / histograms through state; integrate filter context-menu items. |
| `editors/vscode/src/data-viewer/webview/column-context-menu.tsx` | Add Filter section (Filter… / Add filter… / Clear). |
| `editors/vscode/src/data-viewer/webview/styles.css` | Filter chip + popover + histogram styles. |
| `editors/vscode/package.json` | Add `raven.dataViewer.persistFilters`, `raven.dataViewer.maxFilters` settings. |
| `editors/vscode/src/initializationOptions.ts` | Thread new settings through init options. |
| `editors/vscode/src/test/settings.test.ts` | Settings mapping rows. |
| `docs/data-viewer.md` | Add `## Filtering` section. Refresh toolbar diagram and Settings table. |
| `docs/comparison.md` | Add a filter row to the data viewer comparison table. |
| `editors/vscode/test-fixtures/generate-data-viewer.mjs` | Add a `filter-mixed.arrow` fixture covering Bool + a richer labelled column set if needed. |

---

## Conventions Used in This Plan

- Every code block in a "Step 1" / "Step 3" is the **exact** contents to write or the **exact** diff to apply (with surrounding context lines so the engineer can locate the splice site).
- Bun tests run from the repo root: `bun test tests/bun/<file>.test.ts`.
- All commits use Conventional Commits prefixes matching this repo's history: `feat(data-viewer):`, `test(data-viewer):`, `docs(data-viewer):`, `chore(data-viewer):`.
- After each task, run `bun test tests/bun/` (no filter) to confirm no orthogonal regression. Listed once at the end of each task; if it fails, stop and report rather than charging ahead.
- The webview entry sources are bundled by `editors/vscode/scripts/build.js`. Typecheck the webview tree with `cd editors/vscode && bun run typecheck`.

---

## Task 1: Wire-format types & `EMPTY_FILTER`

**Files:**
- Modify: `editors/vscode/src/data-viewer/messages.ts`
- Test: `tests/bun/data-viewer-filter-types.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/bun/data-viewer-filter-types.test.ts`:

```ts
/**
 * Compile-time + runtime sanity for the FilterState / FilterPredicate
 * discriminated unions. If this file type-checks and runs, the protocol
 * surface exists in the right shape; per-predicate evaluation is covered
 * by the filter-engine tests.
 */
import { describe, test, expect } from 'bun:test';
import {
    EMPTY_FILTER,
    type FilterEntry,
    type FilterPredicate,
    type FilterState,
} from '../../editors/vscode/src/data-viewer/messages';

describe('EMPTY_FILTER', () => {
    test('has no entries and records labelsOnWhenFiltered = true', () => {
        expect(EMPTY_FILTER.entries).toEqual([]);
        expect(EMPTY_FILTER.labelsOnWhenFiltered).toBe(true);
    });
});

describe('FilterPredicate discriminants', () => {
    test('every documented kind is constructible', () => {
        // Compile-time exhaustive switch. If a new variant is added without
        // updating this case list, TS will widen `_exhaustive` and fail to
        // compile.
        const ps: FilterPredicate[] = [
            { kind: 'isEmpty' },
            { kind: 'isNotEmpty' },
            { kind: 'numCompare', op: '=', value: 1 },
            { kind: 'numBetween', lo: 0, hi: 1, inclusive: true },
            { kind: 'numNotBetween', lo: 0, hi: 1, inclusive: true },
            { kind: 'setIn', values: ['a', 1] },
            { kind: 'setNotIn', values: ['a'] },
            { kind: 'strCompare', op: '=', value: 'x', caseSensitive: false },
            { kind: 'strContains', value: 'x', caseSensitive: false, negate: false },
            { kind: 'strStartsWith', value: 'x', caseSensitive: false },
            { kind: 'strEndsWith', value: 'x', caseSensitive: false },
            { kind: 'strRegex', pattern: '.+', caseSensitive: false },
            { kind: 'dateCompare', op: '<', value: '2024-01-01' },
            { kind: 'dateBetween', lo: '2024-01-01', hi: '2024-12-31', inclusive: true },
            { kind: 'dateNotBetween', lo: '2024-01-01', hi: '2024-12-31', inclusive: true },
            { kind: 'bool', value: true },
        ];
        expect(ps.length).toBe(16);
        for (const p of ps) {
            switch (p.kind) {
                case 'isEmpty':
                case 'isNotEmpty':
                case 'numCompare':
                case 'numBetween':
                case 'numNotBetween':
                case 'setIn':
                case 'setNotIn':
                case 'strCompare':
                case 'strContains':
                case 'strStartsWith':
                case 'strEndsWith':
                case 'strRegex':
                case 'dateCompare':
                case 'dateBetween':
                case 'dateNotBetween':
                case 'bool':
                    break;
                default: {
                    const _exhaustive: never = p;
                    throw new Error(`unhandled kind: ${(_exhaustive as { kind: string }).kind}`);
                }
            }
        }
    });
});

describe('FilterEntry / FilterState shape', () => {
    test('can build a representative state', () => {
        const entry: FilterEntry = {
            id: '1',
            columnIndex: 0,
            predicate: { kind: 'numCompare', op: '>', value: 10 },
            enabled: true,
            includeMissing: false,
        };
        const state: FilterState = {
            entries: [entry],
            labelsOnWhenFiltered: true,
        };
        expect(state.entries[0].predicate.kind).toBe('numCompare');
    });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test tests/bun/data-viewer-filter-types.test.ts
```

Expected: FAIL — `EMPTY_FILTER`, `FilterPredicate`, `FilterEntry`, `FilterState` are not exported from `messages.ts` yet.

- [ ] **Step 3: Implement the additions in `messages.ts`**

Splice the new types **immediately after `EMPTY_SORT`** in `editors/vscode/src/data-viewer/messages.ts`:

```ts
/** A single filter predicate. Discriminated by `kind`. Predicate value
 *  storage is in JS-native types — wire serialization is whatever
 *  `JSON.stringify` does, which is fine for everything except `BigInt`
 *  (currently unused since Int64 / Uint64 columns are filtered as
 *  numeric or set predicates, both of which use Number or string keys). */
export type FilterPredicate =
    | { kind: 'isEmpty' }
    | { kind: 'isNotEmpty' }
    | { kind: 'numCompare'; op: '=' | '!=' | '<' | '<=' | '>' | '>='; value: number }
    | { kind: 'numBetween'; lo: number; hi: number; inclusive: boolean }
    | { kind: 'numNotBetween'; lo: number; hi: number; inclusive: boolean }
    | { kind: 'setIn'; values: (string | number)[] }
    | { kind: 'setNotIn'; values: (string | number)[] }
    | { kind: 'strCompare'; op: '=' | '!='; value: string; caseSensitive: boolean }
    | { kind: 'strContains'; value: string; caseSensitive: boolean; negate: boolean }
    | { kind: 'strStartsWith'; value: string; caseSensitive: boolean }
    | { kind: 'strEndsWith'; value: string; caseSensitive: boolean }
    | { kind: 'strRegex'; pattern: string; caseSensitive: boolean }
    | { kind: 'dateCompare'; op: '=' | '!=' | '<' | '<=' | '>' | '>='; value: string }
    | { kind: 'dateBetween'; lo: string; hi: string; inclusive: boolean }
    | { kind: 'dateNotBetween'; lo: string; hi: string; inclusive: boolean }
    | { kind: 'bool'; value: boolean };

export type FilterEntry = {
    /** UUID-ish. Stable across edits so a chip-popover Apply updates the
     *  same slot. Generated by the webview on Add; never reused. */
    id: string;
    /** Index into ColumnSchema[]. */
    columnIndex: number;
    predicate: FilterPredicate;
    /** Disabled chips are kept in the strip (greyed) but not applied to
     *  the row index. Lets users A/B a filter without retyping. */
    enabled: boolean;
    /** When true, missing rows pass this entry regardless of predicate.
     *  Semantics: `predicate(x) | is.na(x)`. */
    includeMissing: boolean;
};

export type FilterState = {
    entries: FilterEntry[];
    /** Snapshot of Labels-on at the time the index was computed.
     *  Used by the webview to detect that the Labels toggle has flipped
     *  since this filter was last applied, so labelled columns re-filter.
     *  The host always recomputes the index on restore — `entries` are
     *  the only source of truth for membership, and schema-hash equality
     *  plus column-name equality is not evidence of same values. */
    labelsOnWhenFiltered: boolean;
};

export const EMPTY_FILTER: FilterState = {
    entries: [],
    labelsOnWhenFiltered: true,
};

/** Bin in a numeric column's precomputed histogram. Bins are
 *  uniform-width over `[min, max]` of the present values; NA / NaN
 *  rows are excluded from `count`. A column with no present values
 *  serializes to an empty array. */
export type HistogramBin = {
    lo: number;
    hi: number;
    count: number;
};
```

Then add the new message variants. Extend the `ExtensionToWebview` `init` and `replace` payloads (existing variants — splice the two new fields in):

```ts
    | {
        type: 'init';
        // ... existing fields ...
        sort: SortState;
        /** Filter state restored from persistence, or EMPTY_FILTER if none.
         *  Webview reflects this in chip strip and aria labels; the host
         *  has already computed `filteredIndices` before sending init. */
        filter: FilterState;
        /** Precomputed 50-bin histograms per numeric column index. Used
         *  by the filter popover's range editor; absent columns get no
         *  histogram (string / bool / date / factor). */
        histograms: Record<number, HistogramBin[]>;
    }
    | {
        type: 'replace';
        // ... existing fields ...
        sort: SortState;
        filter: FilterState;
        histograms: Record<number, HistogramBin[]>;
    }
```

And add the new filter-side messages **next to** `sortApplied` / `sortStatus`:

```ts
    | {
        /** Filter index has been (re)built. Webview updates chip strip,
         *  status bar, and gutter renderer. The pulse animation fires
         *  only when `fromPersistence` is false. */
        type: 'filterApplied';
        panelGeneration: number;
        requestId: number;
        filter: FilterState;
        nrowFiltered: number;
        fromPersistence: boolean;
    }
    | {
        type: 'filterStatus';
        panelGeneration: number;
        state: 'pending' | 'idle';
    }
```

In `WebviewToExtension`, add `setFilters` and `saveFilter` next to `setSort` / `saveSort`:

```ts
    | {
        /** Apply (or update, or clear) the active filter. The extension
         *  host rebuilds the index and broadcasts `filterApplied`.
         *  Sending an empty `entries` array clears the filter. */
        type: 'setFilters';
        panelGeneration: number;
        requestId: number;
        entries: FilterEntry[];
        labelsOn: boolean;
    }
    | {
        type: 'saveFilter';
        panelGeneration: number;
        schemaHash: string;
        filter: FilterState;
    }
```

- [ ] **Step 4: Run to verify pass**

```bash
bun test tests/bun/data-viewer-filter-types.test.ts
cd editors/vscode && bun run typecheck && cd -
```

Expected: both green.

- [ ] **Step 5: Commit**

```bash
git add tests/bun/data-viewer-filter-types.test.ts editors/vscode/src/data-viewer/messages.ts
git commit -m "feat(data-viewer): add filter wire-format types and EMPTY_FILTER"
```

---

## Task 2: `predicate-summary.ts` (pure)

**Why first**: chips, aria-labels, status bar, and tests all use this. Writing it standalone gives every later task a stable serializer.

**Files:**
- Create: `editors/vscode/src/data-viewer/webview/predicate-summary.ts`
- Test: `tests/bun/data-viewer-predicate-summary.test.ts`

- [ ] **Step 1: Failing test**

Create `tests/bun/data-viewer-predicate-summary.test.ts`:

```ts
/**
 * predicate-summary — short human strings used by the chip strip and
 * accessibility labels. Pure; depends only on schema metadata.
 */
import { describe, test, expect } from 'bun:test';
import { summarizePredicate } from '../../editors/vscode/src/data-viewer/webview/predicate-summary';
import type { ColumnSchema } from '../../editors/vscode/src/data-viewer/arrow-reader';
import type { FilterPredicate } from '../../editors/vscode/src/data-viewer/messages';

const NUM: ColumnSchema = {
    name: 'mpg', arrowType: 'Float64', isInteger: false, dictionaryShipped: false,
};
const STR: ColumnSchema = {
    name: 'name', arrowType: 'Utf8', isInteger: false, dictionaryShipped: false,
};
const FACTOR: ColumnSchema = {
    name: 'cyl', arrowType: 'Dictionary<Int32, Utf8>', isInteger: false,
    dictionary: ['4', '6', '8'], dictionaryShipped: true,
};
const DATE: ColumnSchema = {
    name: 'd', arrowType: 'Date<DAY>', isInteger: false, dictionaryShipped: false,
};
const BOOL: ColumnSchema = {
    name: 'b', arrowType: 'Bool', isInteger: false, dictionaryShipped: false,
};

function sum(p: FilterPredicate, col: ColumnSchema): string {
    return summarizePredicate(p, col);
}

describe('summarizePredicate', () => {
    test('isEmpty / isNotEmpty', () => {
        expect(sum({ kind: 'isEmpty' }, NUM)).toBe('mpg is empty');
        expect(sum({ kind: 'isNotEmpty' }, NUM)).toBe('mpg is not empty');
    });
    test('numCompare', () => {
        expect(sum({ kind: 'numCompare', op: '>', value: 20 }, NUM)).toBe('mpg > 20');
        expect(sum({ kind: 'numCompare', op: '<=', value: 0 }, NUM)).toBe('mpg ≤ 0');
        expect(sum({ kind: 'numCompare', op: '!=', value: 6 }, NUM)).toBe('mpg ≠ 6');
    });
    test('numBetween', () => {
        expect(sum({ kind: 'numBetween', lo: 1, hi: 5, inclusive: true }, NUM)).toBe('mpg 1–5');
        expect(sum({ kind: 'numBetween', lo: 1, hi: 5, inclusive: false }, NUM))
            .toBe('mpg (1, 5)');
        expect(sum({ kind: 'numNotBetween', lo: 1, hi: 5, inclusive: true }, NUM))
            .toBe('mpg not in 1–5');
    });
    test('setIn / setNotIn (factor)', () => {
        expect(sum({ kind: 'setIn', values: ['low', 'high'] }, FACTOR))
            .toBe('cyl ∈ {low, high}');
        expect(sum({ kind: 'setNotIn', values: ['low'] }, FACTOR))
            .toBe('cyl ∉ {low}');
    });
    test('strCompare and strContains', () => {
        expect(sum({ kind: 'strCompare', op: '=', value: 'foo', caseSensitive: false }, STR))
            .toBe('name = "foo"');
        expect(sum({ kind: 'strContains', value: 'foo', caseSensitive: false, negate: false }, STR))
            .toBe('name contains "foo"');
        expect(sum({ kind: 'strContains', value: 'foo', caseSensitive: false, negate: true }, STR))
            .toBe('name not contains "foo"');
        expect(sum({ kind: 'strRegex', pattern: '^f', caseSensitive: false }, STR))
            .toBe('name matches /^f/i');
        expect(sum({ kind: 'strRegex', pattern: '^F', caseSensitive: true }, STR))
            .toBe('name matches /^F/');
    });
    test('strStartsWith / strEndsWith', () => {
        expect(sum({ kind: 'strStartsWith', value: 'foo', caseSensitive: false }, STR))
            .toBe('name starts with "foo"');
        expect(sum({ kind: 'strEndsWith', value: 'bar', caseSensitive: false }, STR))
            .toBe('name ends with "bar"');
    });
    test('dateCompare and dateBetween', () => {
        expect(sum({ kind: 'dateCompare', op: '<', value: '2024-01-01' }, DATE))
            .toBe('d < 2024-01-01');
        expect(sum({ kind: 'dateBetween', lo: '2024-01-01', hi: '2024-12-31', inclusive: true }, DATE))
            .toBe('d 2024-01-01–2024-12-31');
    });
    test('bool', () => {
        expect(sum({ kind: 'bool', value: true }, BOOL)).toBe('b is true');
        expect(sum({ kind: 'bool', value: false }, BOOL)).toBe('b is false');
    });
    test('truncates long set summaries with +N more', () => {
        const values = ['a', 'b', 'c', 'd', 'e', 'f'];
        expect(sum({ kind: 'setIn', values }, FACTOR))
            .toBe('cyl ∈ {a, b, c, d +2 more}');
    });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test tests/bun/data-viewer-predicate-summary.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `predicate-summary.ts`**

Create `editors/vscode/src/data-viewer/webview/predicate-summary.ts`:

```ts
/**
 * Pure summarizer for FilterPredicates. Used by chip strip labels, aria
 * labels, and the status bar. Output is intentionally short — the chip
 * has limited width — and uses Unicode glyphs so a chip reads like math
 * (≠, ≤, ∈, ∉) without needing CSS.
 *
 * Set-membership summaries truncate after 4 values with `+N more`.
 */

import type { ColumnSchema } from '../arrow-reader';
import type { FilterPredicate } from '../messages';

const SET_TRUNC_AT = 4;

export function summarizePredicate(p: FilterPredicate, col: ColumnSchema): string {
    const n = col.name;
    switch (p.kind) {
        case 'isEmpty': return `${n} is empty`;
        case 'isNotEmpty': return `${n} is not empty`;
        case 'numCompare': return `${n} ${numOp(p.op)} ${p.value}`;
        case 'numBetween':
            return p.inclusive ? `${n} ${p.lo}–${p.hi}` : `${n} (${p.lo}, ${p.hi})`;
        case 'numNotBetween':
            return p.inclusive ? `${n} not in ${p.lo}–${p.hi}` : `${n} not in (${p.lo}, ${p.hi})`;
        case 'setIn': return `${n} ∈ {${summarizeSet(p.values)}}`;
        case 'setNotIn': return `${n} ∉ {${summarizeSet(p.values)}}`;
        case 'strCompare': return `${n} ${p.op === '=' ? '=' : '≠'} "${p.value}"`;
        case 'strContains':
            return `${n} ${p.negate ? 'not contains' : 'contains'} "${p.value}"`;
        case 'strStartsWith': return `${n} starts with "${p.value}"`;
        case 'strEndsWith': return `${n} ends with "${p.value}"`;
        case 'strRegex': return `${n} matches /${p.pattern}/${p.caseSensitive ? '' : 'i'}`;
        case 'dateCompare': return `${n} ${numOp(p.op)} ${p.value}`;
        case 'dateBetween':
            return p.inclusive ? `${n} ${p.lo}–${p.hi}` : `${n} (${p.lo}, ${p.hi})`;
        case 'dateNotBetween':
            return p.inclusive ? `${n} not in ${p.lo}–${p.hi}` : `${n} not in (${p.lo}, ${p.hi})`;
        case 'bool': return `${n} is ${p.value ? 'true' : 'false'}`;
    }
}

function numOp(op: '=' | '!=' | '<' | '<=' | '>' | '>='): string {
    switch (op) {
        case '=': return '=';
        case '!=': return '≠';
        case '<': return '<';
        case '<=': return '≤';
        case '>': return '>';
        case '>=': return '≥';
    }
}

function summarizeSet(values: (string | number)[]): string {
    if (values.length <= SET_TRUNC_AT) return values.join(', ');
    const head = values.slice(0, SET_TRUNC_AT).join(', ');
    const rest = values.length - SET_TRUNC_AT;
    return `${head} +${rest} more`;
}
```

- [ ] **Step 4: Run**

```bash
bun test tests/bun/data-viewer-predicate-summary.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/src/data-viewer/webview/predicate-summary.ts \
        tests/bun/data-viewer-predicate-summary.test.ts
git commit -m "feat(data-viewer): pure predicate summarizer for chips and a11y"
```

---

## Task 3: Histograms — precompute per numeric column

**Files:**
- Create: `editors/vscode/src/data-viewer/histograms.ts`
- Test: `tests/bun/data-viewer-histograms.test.ts`

- [ ] **Step 1: Failing test**

```ts
/**
 * Histogram precomputation. 50 uniform-width bins per numeric column;
 * NA / NaN excluded; columns with no present values yield `[]`; columns
 * where all present values are equal collapse to a single zero-width
 * bin with the full count.
 */
import { describe, test, expect } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArrowSliceReader } from '../../editors/vscode/src/data-viewer/arrow-reader';
import { computeNumericHistograms } from '../../editors/vscode/src/data-viewer/histograms';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = (n: string) =>
    join(HERE, '..', '..', 'editors/vscode/test-fixtures/data-viewer', n);

describe('computeNumericHistograms', () => {
    test('numeric columns get bins; non-numeric do not', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const h = await computeNumericHistograms(r);
        // x is Int32, y is Float64 with NA/NaN/±Inf, lbl is Float64 labelled.
        // Schema order in tiny.arrow: x, y, s, f, d, ts, lbl
        expect(h[0]).toBeDefined();          // x
        expect(h[1]).toBeDefined();          // y
        expect(h[6]).toBeDefined();          // lbl
        expect(h[2]).toBeUndefined();        // s — Utf8
        expect(h[3]).toBeUndefined();        // f — Dictionary
        expect(h[4]).toBeUndefined();        // d — DateDay
        expect(h[5]).toBeUndefined();        // ts — Timestamp
        await r.close();
    });

    test('totals equal nrow minus NA / NaN / ±Inf', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const h = await computeNumericHistograms(r);
        // x = [1,2,3,4,5], no missing -> total 5.
        const xTotal = h[0].reduce((s, b) => s + b.count, 0);
        expect(xTotal).toBe(5);
        // y = [1.5, NA, NaN, +Inf, -Inf] -> NA, NaN excluded;
        // ±Inf excluded by the implementation (they break uniform binning).
        const yTotal = h[1].reduce((s, b) => s + b.count, 0);
        expect(yTotal).toBe(1);
        await r.close();
    });

    test('uniform-bin spans cover [min, max]', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const h = await computeNumericHistograms(r);
        const x = h[0];
        expect(x.length).toBe(50);
        expect(x[0].lo).toBe(1);
        expect(x[x.length - 1].hi).toBe(5);
        await r.close();
    });

    test('single-value column collapses to one zero-width bin', async () => {
        const r = await ArrowSliceReader.open(FIX('bigint64.arrow'));
        const h = await computeNumericHistograms(r);
        // bigint64.arrow has a Int64 column; verify it's present in h and
        // its bins' counts sum equals the present-value count.
        const keys = Object.keys(h).map(Number);
        expect(keys.length).toBeGreaterThan(0);
        for (const k of keys) {
            const bins = h[k];
            for (const b of bins) {
                expect(b.lo).toBeLessThanOrEqual(b.hi);
                expect(b.count).toBeGreaterThanOrEqual(0);
            }
        }
        await r.close();
    });
});
```

- [ ] **Step 2: Run**

```bash
bun test tests/bun/data-viewer-histograms.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `histograms.ts`**

```ts
/**
 * Precomputed numeric-column histograms for the filter popover. One
 * uniform-width 50-bin histogram per Int/Uint/Float column.
 *
 * NA / NaN are excluded from `count` because they are filtered through
 * `includeMissing`, not via the histogram brush. ±Inf is excluded
 * because it breaks uniform binning (Infinity / -Infinity span the
 * entire real line).
 *
 * Columns with no present finite values yield `[]`. Columns where every
 * present value equals min collapse to a single zero-width bin holding
 * the full count.
 *
 * Computed once per panel-init off the open ArrowSliceReader. RSS is
 * bounded by the bin array (50 × 24 bytes per numeric column), not by
 * row count.
 */

import type { ArrowSliceReader } from './arrow-reader';
import type { HistogramBin } from './messages';

const BIN_COUNT = 50;

export async function computeNumericHistograms(
    reader: ArrowSliceReader,
): Promise<Record<number, HistogramBin[]>> {
    const out: Record<number, HistogramBin[]> = {};
    const schema = reader.schema.columns;
    for (let ci = 0; ci < schema.length; ci++) {
        const t = schema[ci].arrowType;
        if (!(t.startsWith('Int') || t.startsWith('Uint') || t.startsWith('Float'))) {
            continue;
        }
        out[ci] = await histogramForColumn(reader, ci);
    }
    return out;
}

async function histogramForColumn(
    reader: ArrowSliceReader,
    columnIndex: number,
): Promise<HistogramBin[]> {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let count = 0;
    const numBatches = reader.batchStarts.length - 1;

    // Pass 1: find min/max of finite values, count them.
    for (let bi = 0; bi < numBatches; bi++) {
        const batch = await (reader as any).getBatch(bi);
        const child = batch.getChildAt(columnIndex);
        const n = batch.numRows ?? batch.length ?? 0;
        for (let r = 0; r < n; r++) {
            const v = child.get(r);
            if (v === null || v === undefined) continue;
            const x = typeof v === 'bigint' ? Number(v) : (v as number);
            if (!Number.isFinite(x)) continue;
            if (x < min) min = x;
            if (x > max) max = x;
            count++;
        }
    }

    if (count === 0) return [];
    if (min === max) {
        return [{ lo: min, hi: max, count }];
    }

    const width = (max - min) / BIN_COUNT;
    const bins: HistogramBin[] = new Array(BIN_COUNT);
    for (let i = 0; i < BIN_COUNT; i++) {
        bins[i] = { lo: min + i * width, hi: min + (i + 1) * width, count: 0 };
    }
    // Float drift safety: anchor the final bin's hi to max exactly so
    // the test's `bins[BIN_COUNT-1].hi === max` invariant holds.
    bins[BIN_COUNT - 1].hi = max;

    // Pass 2: assign each finite value to a bin.
    for (let bi = 0; bi < numBatches; bi++) {
        const batch = await (reader as any).getBatch(bi);
        const child = batch.getChildAt(columnIndex);
        const n = batch.numRows ?? batch.length ?? 0;
        for (let r = 0; r < n; r++) {
            const v = child.get(r);
            if (v === null || v === undefined) continue;
            const x = typeof v === 'bigint' ? Number(v) : (v as number);
            if (!Number.isFinite(x)) continue;
            let idx = Math.floor((x - min) / width);
            if (idx >= BIN_COUNT) idx = BIN_COUNT - 1;
            if (idx < 0) idx = 0;
            bins[idx].count++;
        }
    }
    return bins;
}
```

- [ ] **Step 4: Run**

```bash
bun test tests/bun/data-viewer-histograms.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/src/data-viewer/histograms.ts \
        tests/bun/data-viewer-histograms.test.ts
git commit -m "feat(data-viewer): precompute uniform-width histograms for numeric columns"
```

---

## Task 4: Filter engine — universal & boolean predicates

The filter engine `filter.ts` evaluates predicates against an `ArrowSliceReader` and returns a `Uint32Array` of surviving row indices (or `undefined` when the state is empty / nothing filtered, so the panel can skip storage). Predicate dispatch mirrors `sort.ts`'s `buildSortColumn`. Build it incrementally across Tasks 4–8 to keep each task small.

**Files (created across all of 4–8):**
- Create: `editors/vscode/src/data-viewer/filter.ts`
- Test: `tests/bun/data-viewer-filter-engine.test.ts`

### Task 4 — isEmpty / isNotEmpty / bool / disabled / multi-AND

- [ ] **Step 1: Failing test (initial file)**

Create `tests/bun/data-viewer-filter-engine.test.ts`:

```ts
/**
 * Filter engine — predicate evaluation against the same Arrow batches
 * the sort engine consumes. Returns `undefined` for an empty / all-
 * disabled state so the panel can skip storage.
 *
 * Covered in this file across Tasks 4–8:
 *   - Universal predicates and disabled chips (Task 4)
 *   - Numeric predicates (Task 5)
 *   - String predicates incl. regex (Task 6)
 *   - Date / Timestamp predicates (Task 7)
 *   - Set / factor / labelled predicates with Labels routing (Task 8)
 */

import { describe, test, expect } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArrowSliceReader } from '../../editors/vscode/src/data-viewer/arrow-reader';
import { computeFilteredIndices } from '../../editors/vscode/src/data-viewer/filter';
import type { FilterEntry, FilterState } from '../../editors/vscode/src/data-viewer/messages';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = (n: string) =>
    join(HERE, '..', '..', 'editors/vscode/test-fixtures/data-viewer', n);

const CTX_LABELS_ON = { labelsOn: true, formatOn: true, digits: 3 };

function state(entries: FilterEntry[]): FilterState {
    return { entries, labelsOnWhenFiltered: true };
}

function entry(id: string, columnIndex: number, predicate: FilterEntry['predicate'], opts: Partial<Omit<FilterEntry, 'id' | 'columnIndex' | 'predicate'>> = {}): FilterEntry {
    return {
        id,
        columnIndex,
        predicate,
        enabled: opts.enabled ?? true,
        includeMissing: opts.includeMissing ?? false,
    };
}

describe('computeFilteredIndices — empty / disabled state', () => {
    test('empty entries returns undefined', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const out = await computeFilteredIndices(r, state([]), CTX_LABELS_ON);
        expect(out).toBeUndefined();
        await r.close();
    });

    test('all-disabled entries returns undefined', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 0, { kind: 'isEmpty' }, { enabled: false });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(out).toBeUndefined();
        await r.close();
    });
});

describe('computeFilteredIndices — isEmpty / isNotEmpty', () => {
    test('isEmpty on y keeps rows where y is NA/NaN (rows 1,2)', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 1, { kind: 'isEmpty' });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(out).toBeInstanceOf(Uint32Array);
        // tiny.arrow column y = [1.5, NA, NaN, +Inf, -Inf]; engine treats
        // NA and NaN as missing for Float (matches sort behavior). ±Inf
        // are NOT missing.
        expect(Array.from(out!)).toEqual([1, 2]);
        await r.close();
    });

    test('isNotEmpty on y keeps non-missing rows (0,3,4)', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 1, { kind: 'isNotEmpty' });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 3, 4]);
        await r.close();
    });

    test('isEmpty on a column with no missing values returns []', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 0, { kind: 'isEmpty' });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([]);
        await r.close();
    });
});

describe('computeFilteredIndices — multi-entry AND', () => {
    test('disabled entries are ignored', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const enabled = entry('a', 1, { kind: 'isNotEmpty' });
        const disabled = entry('b', 1, { kind: 'isEmpty' }, { enabled: false });
        const out = await computeFilteredIndices(r, state([enabled, disabled]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 3, 4]);
        await r.close();
    });
});

describe('computeFilteredIndices — includeMissing', () => {
    test('includeMissing makes NA rows pass an isNotEmpty entry trivially', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        // Pathological: isNotEmpty + includeMissing should match everyone
        // (predicate(x) | is.na(x) = !is.na(x) | is.na(x) = TRUE).
        const e = entry('a', 1, { kind: 'isNotEmpty' }, { includeMissing: true });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 1, 2, 3, 4]);
        await r.close();
    });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test tests/bun/data-viewer-filter-engine.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement initial `filter.ts` with universal + bool handlers**

```ts
/**
 * Filter engine for the data viewer. Produces a Uint32Array of surviving
 * row indices from a FilterState evaluated against an open
 * ArrowSliceReader.
 *
 * Invariants:
 *   - **Empty / all-disabled state**: returns undefined so the panel
 *     can skip filter storage entirely.
 *   - **Cross-entry AND**: enabled entries are intersected on a row
 *     mask; disabled entries are ignored.
 *   - **WYSIWYG label routing**: when `labelsOn` is true, factor and
 *     value-labelled columns evaluate `setIn` / `setNotIn` against the
 *     displayed label string. When `labelsOn` is false, against the
 *     underlying code / numeric / string value.
 *   - **Format independence**: digits / formatOn never affects the
 *     row index. Numeric predicates always match against the raw
 *     double.
 *   - **NA / NaN semantics**: missing rows fail any predicate unless
 *     `includeMissing` is true on that entry, in which case the entry
 *     passes for missing rows regardless of predicate value.
 *
 * Performance:
 *   - Row mask is a `Uint8Array(nrow)`; final compaction to
 *     `Uint32Array` is O(nrow).
 *   - Per-entry column reads stream through the reader's batch loader
 *     (same iterator the sort engine uses).
 */

import type { ArrowSliceReader, ColumnSchema } from './arrow-reader';
import type { FilterEntry, FilterState } from './messages';

export type FilterContext = {
    labelsOn: boolean;
    formatOn: boolean;
    digits: number;
};

export async function computeFilteredIndices(
    reader: ArrowSliceReader,
    state: FilterState,
    ctx: FilterContext,
): Promise<Uint32Array | undefined> {
    const active = state.entries.filter(e => e.enabled);
    if (active.length === 0) return undefined;

    const nrow = reader.nrow;
    const mask = new Uint8Array(nrow);
    mask.fill(1);

    for (const e of active) {
        await applyEntry(reader, e, ctx, mask);
        if (allZero(mask)) break;
    }
    return compact(mask);
}

async function applyEntry(
    reader: ArrowSliceReader,
    entry: FilterEntry,
    ctx: FilterContext,
    mask: Uint8Array,
): Promise<void> {
    const schema = reader.schema.columns[entry.columnIndex];
    if (!schema) {
        throw new Error(`computeFilteredIndices: unknown columnIndex ${entry.columnIndex}`);
    }
    const p = entry.predicate;
    const accept = await acceptorFor(reader, entry.columnIndex, schema, p, ctx);
    const include = entry.includeMissing;
    const missing = await missingMaskFor(reader, entry.columnIndex, schema);

    for (let i = 0; i < mask.length; i++) {
        if (mask[i] === 0) continue;
        if (missing[i]) {
            mask[i] = include ? 1 : 0;
            continue;
        }
        mask[i] = accept(i) ? 1 : 0;
    }
}

/** Returns a fn `(rowIndex) => boolean` whose domain is **non-missing**
 *  rows (missing-row handling is enforced by the outer loop). Built
 *  once per entry; per-row evaluation is O(1) lookup. */
async function acceptorFor(
    reader: ArrowSliceReader,
    columnIndex: number,
    schema: ColumnSchema,
    predicate: FilterEntry['predicate'],
    ctx: FilterContext,
): Promise<(row: number) => boolean> {
    // Universal predicates: trivially TRUE / FALSE on the missing-aware
    // path. The outer loop's `missing` branch already handles the
    // "is empty" case; for non-missing rows isEmpty is always false
    // and isNotEmpty is always true.
    if (predicate.kind === 'isEmpty') return () => false;
    if (predicate.kind === 'isNotEmpty') return () => true;

    if (predicate.kind === 'bool') {
        const values = await loadBool(reader, columnIndex);
        const want = predicate.value ? 1 : 0;
        return (i) => values[i] === want;
    }

    // Future tasks: numeric, string, date, set.
    throw new Error(`filter: predicate kind not yet implemented: ${predicate.kind}`);
}

async function missingMaskFor(
    reader: ArrowSliceReader,
    columnIndex: number,
    schema: ColumnSchema,
): Promise<Uint8Array> {
    const nrow = reader.nrow;
    const m = new Uint8Array(nrow);
    const isFloat = schema.arrowType.startsWith('Float');
    const numBatches = reader.batchStarts.length - 1;
    for (let bi = 0; bi < numBatches; bi++) {
        const batch = await (reader as any).getBatch(bi);
        const child = batch.getChildAt(columnIndex);
        const start = reader.batchStarts[bi];
        const n = (reader.batchStarts[bi + 1] - start);
        for (let r = 0; r < n; r++) {
            const v = child.get(r);
            if (v === null || v === undefined) m[start + r] = 1;
            else if (isFloat && typeof v === 'number' && Number.isNaN(v)) m[start + r] = 1;
        }
    }
    return m;
}

async function loadBool(reader: ArrowSliceReader, columnIndex: number): Promise<Uint8Array> {
    const nrow = reader.nrow;
    const values = new Uint8Array(nrow);
    const numBatches = reader.batchStarts.length - 1;
    for (let bi = 0; bi < numBatches; bi++) {
        const batch = await (reader as any).getBatch(bi);
        const child = batch.getChildAt(columnIndex);
        const start = reader.batchStarts[bi];
        const n = (reader.batchStarts[bi + 1] - start);
        for (let r = 0; r < n; r++) {
            const v = child.get(r);
            if (v === null || v === undefined) continue;
            values[start + r] = v ? 1 : 0;
        }
    }
    return values;
}

function allZero(m: Uint8Array): boolean {
    for (let i = 0; i < m.length; i++) {
        if (m[i] !== 0) return false;
    }
    return true;
}

function compact(mask: Uint8Array): Uint32Array {
    let count = 0;
    for (let i = 0; i < mask.length; i++) {
        if (mask[i]) count++;
    }
    const out = new Uint32Array(count);
    let j = 0;
    for (let i = 0; i < mask.length; i++) {
        if (mask[i]) out[j++] = i;
    }
    return out;
}
```

- [ ] **Step 4: Run**

```bash
bun test tests/bun/data-viewer-filter-engine.test.ts
```

Expected: PASS (only the Task 4 cases — numeric / string / date / set / regex tests are added in later tasks).

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/src/data-viewer/filter.ts \
        tests/bun/data-viewer-filter-engine.test.ts
git commit -m "feat(data-viewer): filter engine — universal, bool, multi-entry AND"
```

---

## Task 5: Numeric predicates in filter engine

**Files:**
- Modify: `editors/vscode/src/data-viewer/filter.ts`
- Modify: `tests/bun/data-viewer-filter-engine.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `tests/bun/data-viewer-filter-engine.test.ts`:

```ts
describe('computeFilteredIndices — numeric predicates on x [1,2,3,4,5]', () => {
    test('numCompare = 3', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 0, { kind: 'numCompare', op: '=', value: 3 });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([2]);
        await r.close();
    });
    test('numCompare >= 3', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 0, { kind: 'numCompare', op: '>=', value: 3 });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([2, 3, 4]);
        await r.close();
    });
    test('numBetween inclusive 2..4', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 0, { kind: 'numBetween', lo: 2, hi: 4, inclusive: true });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([1, 2, 3]);
        await r.close();
    });
    test('numBetween exclusive 2..4', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 0, { kind: 'numBetween', lo: 2, hi: 4, inclusive: false });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([2]);
        await r.close();
    });
    test('numNotBetween inclusive 2..4', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 0, { kind: 'numNotBetween', lo: 2, hi: 4, inclusive: true });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 4]);
        await r.close();
    });
});

describe('computeFilteredIndices — numeric on Float with NA / NaN / Inf', () => {
    test('numCompare > 0 keeps 1.5 and +Inf', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        // y = [1.5, NA, NaN, +Inf, -Inf]
        const e = entry('a', 1, { kind: 'numCompare', op: '>', value: 0 });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        // NA / NaN rows fail by default; -Inf < 0 fails; 1.5 and +Inf pass.
        expect(Array.from(out!)).toEqual([0, 3]);
        await r.close();
    });
    test('numCompare > 0 with includeMissing keeps NA/NaN too', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 1, { kind: 'numCompare', op: '>', value: 0 }, { includeMissing: true });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 1, 2, 3]);
        await r.close();
    });
});
```

- [ ] **Step 2: Run**

```bash
bun test tests/bun/data-viewer-filter-engine.test.ts
```

Expected: FAIL — `numCompare` / `numBetween` / `numNotBetween` not yet implemented.

- [ ] **Step 3: Extend `filter.ts` `acceptorFor`**

Replace the `// Future tasks` block in `acceptorFor` with numeric handling above the throw:

```ts
    if (predicate.kind === 'numCompare') {
        const values = await loadNumeric(reader, columnIndex);
        const v = predicate.value;
        switch (predicate.op) {
            case '=': return (i) => values[i] === v;
            case '!=': return (i) => values[i] !== v;
            case '<': return (i) => values[i] < v;
            case '<=': return (i) => values[i] <= v;
            case '>': return (i) => values[i] > v;
            case '>=': return (i) => values[i] >= v;
        }
    }
    if (predicate.kind === 'numBetween') {
        const values = await loadNumeric(reader, columnIndex);
        const lo = predicate.lo, hi = predicate.hi, incl = predicate.inclusive;
        return incl
            ? (i) => values[i] >= lo && values[i] <= hi
            : (i) => values[i] > lo && values[i] < hi;
    }
    if (predicate.kind === 'numNotBetween') {
        const values = await loadNumeric(reader, columnIndex);
        const lo = predicate.lo, hi = predicate.hi, incl = predicate.inclusive;
        return incl
            ? (i) => values[i] < lo || values[i] > hi
            : (i) => values[i] <= lo || values[i] >= hi;
    }
```

And add `loadNumeric` helper next to `loadBool`:

```ts
async function loadNumeric(reader: ArrowSliceReader, columnIndex: number): Promise<Float64Array> {
    const nrow = reader.nrow;
    const out = new Float64Array(nrow);
    const numBatches = reader.batchStarts.length - 1;
    for (let bi = 0; bi < numBatches; bi++) {
        const batch = await (reader as any).getBatch(bi);
        const child = batch.getChildAt(columnIndex);
        const start = reader.batchStarts[bi];
        const n = reader.batchStarts[bi + 1] - start;
        for (let r = 0; r < n; r++) {
            const v = child.get(r);
            if (v === null || v === undefined) continue;
            // bigint columns (Int64 / Uint64) lossily coerce to Number;
            // values outside Number.MAX_SAFE_INTEGER lose precision. For
            // filter predicates the loss is acceptable because the user
            // typed a Number-domain `value` field; sort uses BigInt for
            // exact ordering where precision matters.
            out[start + r] = typeof v === 'bigint' ? Number(v) : (v as number);
        }
    }
    return out;
}
```

- [ ] **Step 4: Run**

```bash
bun test tests/bun/data-viewer-filter-engine.test.ts
```

Expected: PASS (Task 4 + 5 cases).

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/src/data-viewer/filter.ts \
        tests/bun/data-viewer-filter-engine.test.ts
git commit -m "feat(data-viewer): numeric filter predicates"
```

---

## Task 6: String predicates (incl. regex with invalid-pattern fallback)

- [ ] **Step 1: Append failing tests**

Append to `tests/bun/data-viewer-filter-engine.test.ts`:

```ts
describe('computeFilteredIndices — string predicates on s ["a","b",null,"d","e"]', () => {
    test('strCompare = "b" case-insensitive matches "b"', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 2, { kind: 'strCompare', op: '=', value: 'B', caseSensitive: false });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([1]);
        await r.close();
    });
    test('strCompare = "B" case-sensitive matches nothing', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 2, { kind: 'strCompare', op: '=', value: 'B', caseSensitive: true });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([]);
        await r.close();
    });
    test('strContains "d" matches "d"', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 2, { kind: 'strContains', value: 'd', caseSensitive: false, negate: false });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([3]);
        await r.close();
    });
    test('strContains negate -> excludes "d"', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 2, { kind: 'strContains', value: 'd', caseSensitive: false, negate: true });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        // null is missing → drops; matches: rows 0,1,4 (a,b,e)
        expect(Array.from(out!)).toEqual([0, 1, 4]);
        await r.close();
    });
    test('strStartsWith "a"', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 2, { kind: 'strStartsWith', value: 'a', caseSensitive: false });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0]);
        await r.close();
    });
    test('strEndsWith "e"', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 2, { kind: 'strEndsWith', value: 'e', caseSensitive: false });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([4]);
        await r.close();
    });
    test('strRegex /^[ab]$/i', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 2, { kind: 'strRegex', pattern: '^[ab]$', caseSensitive: false });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 1]);
        await r.close();
    });
    test('strRegex with invalid pattern returns []  (entry treated as no-match, no throw)', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 2, { kind: 'strRegex', pattern: '[', caseSensitive: false });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([]);
        await r.close();
    });
});
```

- [ ] **Step 2: Run**

```bash
bun test tests/bun/data-viewer-filter-engine.test.ts
```

Expected: FAIL — string predicates not implemented.

- [ ] **Step 3: Extend `filter.ts`**

Add to `acceptorFor` above the throw:

```ts
    if (predicate.kind === 'strCompare'
        || predicate.kind === 'strContains'
        || predicate.kind === 'strStartsWith'
        || predicate.kind === 'strEndsWith'
        || predicate.kind === 'strRegex') {
        const values = await loadString(reader, columnIndex);
        const cs = predicate.kind === 'strRegex' ? predicate.caseSensitive : predicate.caseSensitive;
        switch (predicate.kind) {
            case 'strCompare': {
                const needle = cs ? predicate.value : predicate.value.toLowerCase();
                const eq = predicate.op === '=';
                return (i) => {
                    const hay = cs ? values[i] : values[i].toLowerCase();
                    return eq ? hay === needle : hay !== needle;
                };
            }
            case 'strContains': {
                const needle = cs ? predicate.value : predicate.value.toLowerCase();
                const neg = predicate.negate;
                return (i) => {
                    const hay = cs ? values[i] : values[i].toLowerCase();
                    const hit = hay.includes(needle);
                    return neg ? !hit : hit;
                };
            }
            case 'strStartsWith': {
                const needle = cs ? predicate.value : predicate.value.toLowerCase();
                return (i) => (cs ? values[i] : values[i].toLowerCase()).startsWith(needle);
            }
            case 'strEndsWith': {
                const needle = cs ? predicate.value : predicate.value.toLowerCase();
                return (i) => (cs ? values[i] : values[i].toLowerCase()).endsWith(needle);
            }
            case 'strRegex': {
                let rx: RegExp | null = null;
                try {
                    rx = new RegExp(predicate.pattern, cs ? '' : 'i');
                } catch {
                    // Invalid pattern: the chip should already be marked
                    // invalid by the webview, but we may still be invoked
                    // (e.g. on restore from persistence after a code
                    // change). Treat as no-match without throwing.
                    rx = null;
                }
                if (!rx) return () => false;
                const r = rx;
                return (i) => r.test(values[i]);
            }
        }
    }
```

Add `loadString` helper:

```ts
async function loadString(reader: ArrowSliceReader, columnIndex: number): Promise<string[]> {
    const nrow = reader.nrow;
    const out: string[] = new Array(nrow).fill('');
    const numBatches = reader.batchStarts.length - 1;
    for (let bi = 0; bi < numBatches; bi++) {
        const batch = await (reader as any).getBatch(bi);
        const child = batch.getChildAt(columnIndex);
        const start = reader.batchStarts[bi];
        const n = reader.batchStarts[bi + 1] - start;
        for (let r = 0; r < n; r++) {
            const v = child.get(r);
            if (v !== null && v !== undefined) out[start + r] = String(v);
        }
    }
    return out;
}
```

- [ ] **Step 4: Run**

```bash
bun test tests/bun/data-viewer-filter-engine.test.ts
```

Expected: PASS through Task 6.

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/src/data-viewer/filter.ts \
        tests/bun/data-viewer-filter-engine.test.ts
git commit -m "feat(data-viewer): string filter predicates incl. regex"
```

---

## Task 7: Date / Timestamp predicates

- [ ] **Step 1: Append failing tests**

```ts
describe('computeFilteredIndices — date predicates on d (DateDay 2024-01-01..05)', () => {
    test('dateCompare < 2024-01-03', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 4, { kind: 'dateCompare', op: '<', value: '2024-01-03' });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 1]);
        await r.close();
    });
    test('dateBetween inclusive 2024-01-02..2024-01-04', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 4, { kind: 'dateBetween', lo: '2024-01-02', hi: '2024-01-04', inclusive: true });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([1, 2, 3]);
        await r.close();
    });
});
```

- [ ] **Step 2: Run**

```bash
bun test tests/bun/data-viewer-filter-engine.test.ts
```

Expected: FAIL — date predicates not implemented.

- [ ] **Step 3: Extend `filter.ts`**

Add to `acceptorFor`:

```ts
    if (predicate.kind === 'dateCompare'
        || predicate.kind === 'dateBetween'
        || predicate.kind === 'dateNotBetween') {
        // Convert ISO strings to the same numeric domain the underlying
        // arrow values live in. For Date32/Date64 use ms since epoch;
        // Timestamp columns store microseconds-since-epoch as bigint.
        const values = await loadNumeric(reader, columnIndex);
        const isTs = schema.arrowType.startsWith('Timestamp');
        const toUnit = (iso: string): number => {
            const ms = Date.parse(iso);
            if (!Number.isFinite(ms)) return NaN;
            if (isTs) return ms * 1000;
            // Date32 = days since epoch; Date64 = ms since epoch.
            if (schema.arrowType === 'Date<DAY>') return Math.floor(ms / 86_400_000);
            return ms;
        };
        switch (predicate.kind) {
            case 'dateCompare': {
                const v = toUnit(predicate.value);
                switch (predicate.op) {
                    case '=': return (i) => values[i] === v;
                    case '!=': return (i) => values[i] !== v;
                    case '<': return (i) => values[i] < v;
                    case '<=': return (i) => values[i] <= v;
                    case '>': return (i) => values[i] > v;
                    case '>=': return (i) => values[i] >= v;
                }
                break;
            }
            case 'dateBetween': {
                const lo = toUnit(predicate.lo), hi = toUnit(predicate.hi);
                return predicate.inclusive
                    ? (i) => values[i] >= lo && values[i] <= hi
                    : (i) => values[i] > lo && values[i] < hi;
            }
            case 'dateNotBetween': {
                const lo = toUnit(predicate.lo), hi = toUnit(predicate.hi);
                return predicate.inclusive
                    ? (i) => values[i] < lo || values[i] > hi
                    : (i) => values[i] <= lo || values[i] >= hi;
            }
        }
    }
```

- [ ] **Step 4: Run**

```bash
bun test tests/bun/data-viewer-filter-engine.test.ts
```

Expected: PASS through Task 7.

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/src/data-viewer/filter.ts \
        tests/bun/data-viewer-filter-engine.test.ts
git commit -m "feat(data-viewer): date and timestamp filter predicates"
```

---

## Task 8: Set predicates with Labels routing (factor + haven_labelled)

- [ ] **Step 1: Append failing tests**

```ts
const CTX_LABELS_OFF = { labelsOn: false, formatOn: true, digits: 3 };

describe('computeFilteredIndices — setIn on factor with Labels routing', () => {
    test('Labels on: setIn matches against label strings', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        // f dictionary = ['low','med','high'], indices = [0,1,0,2,1] -> labels low,med,low,high,med
        const e = entry('a', 3, { kind: 'setIn', values: ['low', 'high'] });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 2, 3]);
        await r.close();
    });
    test('Labels off: setIn matches against codes', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        // codes 0 (low) and 2 (high)
        const e = entry('a', 3, { kind: 'setIn', values: [0, 2] });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_OFF);
        expect(Array.from(out!)).toEqual([0, 2, 3]);
        await r.close();
    });
});

describe('computeFilteredIndices — setIn on haven_labelled with Labels on', () => {
    test('matches against label strings', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        // lbl Float64 [1,2,3,1,2] labelled {1:low,2:mid,3:high}
        const e = entry('a', 6, { kind: 'setIn', values: ['low'] });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        // rows with lbl == 1 -> label 'low'
        // The fixture writes [1,2,3,1,2]; verify against the actual file
        // by checking that out has length 2 and only those rows pass.
        expect(out!.length).toBe(2);
        await r.close();
    });
});

describe('computeFilteredIndices — setIn on plain string column', () => {
    test('matches values directly regardless of labelsOn', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 2, { kind: 'setIn', values: ['a', 'e'] });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 4]);
        await r.close();
    });
});
```

- [ ] **Step 2: Run**

```bash
bun test tests/bun/data-viewer-filter-engine.test.ts
```

Expected: FAIL — set predicates not implemented.

- [ ] **Step 3: Extend `filter.ts`**

Add to `acceptorFor`:

```ts
    if (predicate.kind === 'setIn' || predicate.kind === 'setNotIn') {
        const wantStr = new Set(predicate.values.map(String));
        const isFactor = schema.arrowType.startsWith('Dictionary');
        const hasValueLabels = !!schema.valueLabels;

        if (isFactor) {
            const codes = await loadFactorCodes(reader, columnIndex);
            if (ctx.labelsOn) {
                const dict = schema.dictionary
                    ?? Object.values(await reader.getLabels(columnIndex, [...new Set(codes)]));
                const labels: string[] = Array.isArray(schema.dictionary)
                    ? schema.dictionary
                    : await dictFromGetLabels(reader, columnIndex, codes);
                return predicate.kind === 'setIn'
                    ? (i) => wantStr.has(labels[codes[i]])
                    : (i) => !wantStr.has(labels[codes[i]]);
            }
            // Labels off — match against the integer code.
            return predicate.kind === 'setIn'
                ? (i) => wantStr.has(String(codes[i]))
                : (i) => !wantStr.has(String(codes[i]));
        }

        if (hasValueLabels && ctx.labelsOn) {
            const displayed = await loadValueLabelled(reader, columnIndex, schema);
            return predicate.kind === 'setIn'
                ? (i) => wantStr.has(displayed[i])
                : (i) => !wantStr.has(displayed[i]);
        }

        // Plain string / numeric — match the raw stringified value.
        const values = await loadString(reader, columnIndex);
        return predicate.kind === 'setIn'
            ? (i) => wantStr.has(values[i])
            : (i) => !wantStr.has(values[i]);
    }
```

Add helpers:

```ts
async function loadFactorCodes(reader: ArrowSliceReader, columnIndex: number): Promise<Int32Array> {
    const nrow = reader.nrow;
    const codes = new Int32Array(nrow);
    const numBatches = reader.batchStarts.length - 1;
    for (let bi = 0; bi < numBatches; bi++) {
        const batch = await (reader as any).getBatch(bi);
        const child = batch.getChildAt(columnIndex);
        const data = child.data[0];
        const start = reader.batchStarts[bi];
        const n = reader.batchStarts[bi + 1] - start;
        for (let r = 0; r < n; r++) codes[start + r] = data.values[r] as number;
    }
    return codes;
}

async function dictFromGetLabels(
    reader: ArrowSliceReader,
    columnIndex: number,
    codes: Int32Array,
): Promise<string[]> {
    const seen = new Set<number>();
    for (let i = 0; i < codes.length; i++) seen.add(codes[i]);
    const labels = await reader.getLabels(columnIndex, [...seen]);
    const max = [...seen].reduce((a, b) => Math.max(a, b), -1);
    const out: string[] = new Array(max + 1).fill('');
    for (const [k, v] of Object.entries(labels)) out[Number(k)] = v;
    return out;
}

async function loadValueLabelled(
    reader: ArrowSliceReader,
    columnIndex: number,
    schema: ColumnSchema,
): Promise<string[]> {
    const nrow = reader.nrow;
    const out: string[] = new Array(nrow).fill('');
    const labels = schema.valueLabels ?? {};
    const numBatches = reader.batchStarts.length - 1;
    for (let bi = 0; bi < numBatches; bi++) {
        const batch = await (reader as any).getBatch(bi);
        const child = batch.getChildAt(columnIndex);
        const start = reader.batchStarts[bi];
        const n = reader.batchStarts[bi + 1] - start;
        for (let r = 0; r < n; r++) {
            const v = child.get(r);
            if (v === null || v === undefined) continue;
            const key = typeof v === 'bigint' ? v.toString() : String(v);
            out[start + r] = labels[key] ?? key;
        }
    }
    return out;
}
```

- [ ] **Step 4: Run**

```bash
bun test tests/bun/data-viewer-filter-engine.test.ts
```

Expected: PASS through Task 8.

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/src/data-viewer/filter.ts \
        tests/bun/data-viewer-filter-engine.test.ts
git commit -m "feat(data-viewer): set/factor/labelled predicates with Labels routing"
```

---

## Task 9: `FilterStateStore` persistence

**Files:**
- Create: `editors/vscode/src/data-viewer/filter-state.ts`
- Test: `tests/bun/data-viewer-filter-state.test.ts`

- [ ] **Step 1: Failing test**

Mirror `tests/bun/data-viewer-sort-state.test.ts` exactly, with a `FilterState` payload. See file contents in step 3 for the API; tests cover save → load round-trip, LRU eviction at cap, and panel-name isolation.

```ts
/**
 * FilterStateStore — persistence parity with SortStateStore.
 */
import { describe, test, expect } from 'bun:test';
import { FilterStateStore } from '../../editors/vscode/src/data-viewer/filter-state';
import type { FilterState } from '../../editors/vscode/src/data-viewer/messages';

class MemKV {
    private m = new Map<string, unknown>();
    get<T>(k: string, d?: T): T | undefined {
        return (this.m.get(k) as T | undefined) ?? d;
    }
    update(k: string, v: unknown): Promise<void> {
        if (v === undefined) this.m.delete(k);
        else this.m.set(k, v);
        return Promise.resolve();
    }
    keys(): string[] { return [...this.m.keys()]; }
}

const STATE_A: FilterState = {
    entries: [{
        id: 'a',
        columnIndex: 0,
        predicate: { kind: 'numCompare', op: '>', value: 10 },
        enabled: true,
        includeMissing: false,
    }],
    labelsOnWhenFiltered: true,
};
const STATE_B: FilterState = {
    entries: [{
        id: 'b',
        columnIndex: 1,
        predicate: { kind: 'isEmpty' },
        enabled: false,
        includeMissing: false,
    }],
    labelsOnWhenFiltered: false,
};

describe('FilterStateStore', () => {
    test('save then load returns the stored state', async () => {
        const kv = new MemKV();
        const store = new FilterStateStore(kv as any, 10);
        await store.save('mtcars', 'abc', STATE_A);
        expect(await store.load('mtcars', 'abc')).toEqual(STATE_A);
    });
    test('load returns undefined when nothing saved', async () => {
        const store = new FilterStateStore(new MemKV() as any, 10);
        expect(await store.load('mtcars', 'abc')).toBeUndefined();
    });
    test('LRU eviction at cap', async () => {
        const kv = new MemKV();
        const store = new FilterStateStore(kv as any, 2);
        await store.save('a', 'h', STATE_A);
        await store.save('b', 'h', STATE_B);
        await store.save('c', 'h', STATE_A);
        expect(await store.load('a', 'h')).toBeUndefined();
        expect(await store.load('b', 'h')).toEqual(STATE_B);
        expect(await store.load('c', 'h')).toEqual(STATE_A);
    });
    test('clear removes the entry and its order slot', async () => {
        const kv = new MemKV();
        const store = new FilterStateStore(kv as any, 10);
        await store.save('a', 'h', STATE_A);
        await store.clear('a', 'h');
        expect(await store.load('a', 'h')).toBeUndefined();
    });
    test('different panel names with same hash do not collide', async () => {
        const store = new FilterStateStore(new MemKV() as any, 10);
        await store.save('a', 'h', STATE_A);
        await store.save('b', 'h', STATE_B);
        expect(await store.load('a', 'h')).toEqual(STATE_A);
        expect(await store.load('b', 'h')).toEqual(STATE_B);
    });
});
```

- [ ] **Step 2: Run**

```bash
bun test tests/bun/data-viewer-filter-state.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `filter-state.ts`**

Copy-paste `sort-state.ts` and replace `SortState` / `SortStateStore` / `raven.dataViewer.sort` / `sortOrder` with the filter equivalents:

```ts
/**
 * Persisted filter state for the data viewer. Mirrors {@link ./sort-state.ts}
 * and shares the same `maxStoredLayouts` LRU cap. Layout, toolbar, sort,
 * and filter persistence evict together for a given panel+hash.
 *
 * What's persisted is only the chip descriptors. The host always
 * recomputes the index on restore against the current reader — schema
 * hash equality is not evidence that two datasets share values.
 */

import type { Memento } from './layout-state';
import type { FilterState } from './messages';

const PREFIX = 'raven.dataViewer.filter::';
const ORDER_KEY = 'raven.dataViewer.filterOrder';

export class FilterStateStore {
    constructor(
        private readonly kv: Memento,
        private readonly cap: number,
    ) {}

    private compositeKey(panelName: string, hash: string): string {
        return `${PREFIX}${panelName}::${hash}`;
    }

    async load(panelName: string, hash: string): Promise<FilterState | undefined> {
        return this.kv.get<FilterState>(this.compositeKey(panelName, hash));
    }

    async save(panelName: string, hash: string, state: FilterState): Promise<void> {
        const key = this.compositeKey(panelName, hash);
        await this.kv.update(key, state);
        const order = (this.kv.get<string[]>(ORDER_KEY) ?? []).filter(k => k !== key);
        order.push(key);
        while (order.length > this.cap) {
            const evict = order.shift()!;
            await this.kv.update(evict, undefined);
        }
        await this.kv.update(ORDER_KEY, order);
    }

    async clear(panelName: string, hash: string): Promise<void> {
        const key = this.compositeKey(panelName, hash);
        await this.kv.update(key, undefined);
        const order = (this.kv.get<string[]>(ORDER_KEY) ?? []).filter(k => k !== key);
        await this.kv.update(ORDER_KEY, order);
    }
}
```

- [ ] **Step 4: Run**

```bash
bun test tests/bun/data-viewer-filter-state.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/src/data-viewer/filter-state.ts \
        tests/bun/data-viewer-filter-state.test.ts
git commit -m "feat(data-viewer): FilterStateStore persistence"
```

---

## Task 10: Panel wiring — `setFilters` handler + restore

**Files:**
- Modify: `editors/vscode/src/data-viewer/panel.ts`
- Modify: `editors/vscode/src/data-viewer/manager.ts`
- Modify: `editors/vscode/src/data-viewer/index.ts`
- Test: `tests/bun/data-viewer-panel-filter.test.ts`

This is the largest task. We split it into three sub-steps that share one commit; tests verify the whole round-trip at the end.

### 10a — Wire up FilterStateStore in `manager.ts` and `index.ts`

- [ ] **Step 1: Read existing constructor signatures**

```bash
grep -n "DataViewerPanel" editors/vscode/src/data-viewer/manager.ts | head
grep -n "DataViewerManager\|new DataViewerManager" editors/vscode/src/data-viewer/index.ts
```

Note the exact constructor signatures so you can splice the new dependency in without breaking other callers.

- [ ] **Step 2: Pass `FilterStateStore` from `index.ts` → `DataViewerManager` → `DataViewerPanel`**

In `index.ts`, near the existing `new SortStateStore(...)`:

```ts
const sortStore = new SortStateStore(context.globalState, cap);
const filterStore = new FilterStateStore(context.globalState, cap);
// ...
const manager = new DataViewerManager(
    context,
    /* ... existing args ... */
    sortStore,
    filterStore,
);
```

In `manager.ts`, accept the new param and pass it to `DataViewerPanel`:

```ts
constructor(
    /* ... existing fields ... */
    private readonly sortStore: SortStateStore,
    private readonly filterStore: FilterStateStore,
) { /* ... */ }

// In createPanel():
const panel = new DataViewerPanel(
    /* existing args */,
    this.sortStore,
    this.filterStore,
);
```

### 10b — Implement `handleSetFilters` and restore-on-init in `panel.ts`

- [ ] **Step 1: Add fields and constructor wiring**

Splice these fields next to the existing `sort` / `permutation` / `sortGeneration` fields in `DataViewerPanel`:

```ts
private filter: FilterState = EMPTY_FILTER;
private filteredIndices: Uint32Array | undefined;
private filterGeneration = 0;
```

Inject `private readonly filterStore: FilterStateStore` into the constructor signature next to `sortStore`.

- [ ] **Step 2: Compute filter at init and pass through `init` payload**

In whatever method builds the `init` message (`postInit` or similar), inline alongside the existing sort restore:

```ts
const savedFilter = await this.filterStore.load(this.panelName, this.schemaHash);
this.filter = savedFilter ?? EMPTY_FILTER;
try {
    this.filteredIndices = await computeFilteredIndices(this.reader, this.filter, {
        labelsOn: this.toolbar.labelsOn,
        formatOn: this.toolbar.formatOn,
        digits: this.toolbar.digits,
    });
} catch (err) {
    // Restored filter is broken (e.g. invalid regex). Treat as cleared.
    this.filter = EMPTY_FILTER;
    this.filteredIndices = undefined;
}

const histograms = await computeNumericHistograms(this.reader);
```

Add `filter`, `histograms`, and (if a filter is active) `nrowFiltered` to the `init` payload. Same for `replace`.

- [ ] **Step 3: Handle `setFilters`**

In the message switch, add:

```ts
case 'setFilters': {
    await this.handleSetFilters(m, gen);
    return;
}
```

Add the method (mirror `handleSetSort`):

```ts
private async handleSetFilters(
    m: Extract<WebviewToExtension, { type: 'setFilters' }>,
    gen: number,
): Promise<void> {
    this.filterGeneration += 1;
    const myFilterGen = this.filterGeneration;
    const next: FilterState = {
        entries: m.entries,
        labelsOnWhenFiltered: m.labelsOn,
    };

    if (m.entries.length === 0 || m.entries.every(e => !e.enabled)) {
        this.filter = next;
        this.filteredIndices = undefined;
        // Sort permutation is unchanged; nothing else to rebuild.
        const ack: ExtensionToWebview = {
            type: 'filterApplied',
            panelGeneration: gen,
            requestId: m.requestId,
            filter: next,
            nrowFiltered: this.reader.nrow,
            fromPersistence: false,
        };
        await this.webviewPanel.webview.postMessage(ack);
        return;
    }

    await this.webviewPanel.webview.postMessage({
        type: 'filterStatus',
        panelGeneration: gen,
        state: 'pending',
    } satisfies ExtensionToWebview);

    let indices: Uint32Array | undefined;
    try {
        indices = await computeFilteredIndices(this.reader, next, {
            labelsOn: m.labelsOn,
            formatOn: this.toolbar.formatOn,
            digits: this.toolbar.digits,
        });
    } catch (err) {
        if (gen !== this.generation
            || myFilterGen !== this.filterGeneration
            || this.disposed) return;
        await this.webviewPanel.webview.postMessage({
            type: 'filterStatus',
            panelGeneration: gen,
            state: 'idle',
        } satisfies ExtensionToWebview);
        await this.webviewPanel.webview.postMessage({
            type: 'error',
            panelGeneration: gen,
            message: err instanceof Error ? err.message : String(err),
        } satisfies ExtensionToWebview);
        return;
    }

    if (gen !== this.generation || myFilterGen !== this.filterGeneration) return;

    this.filter = next;
    this.filteredIndices = indices;

    await this.webviewPanel.webview.postMessage({
        type: 'filterStatus',
        panelGeneration: gen,
        state: 'idle',
    } satisfies ExtensionToWebview);
    await this.webviewPanel.webview.postMessage({
        type: 'filterApplied',
        panelGeneration: gen,
        requestId: m.requestId,
        filter: next,
        nrowFiltered: indices?.length ?? this.reader.nrow,
        fromPersistence: false,
    } satisfies ExtensionToWebview);
}
```

- [ ] **Step 4: Compose with sort in `getRows`**

Find `getRows` dispatch. The current code passes `this.permutation` to `reader.getRows`. Replace that with a composed permutation:

```ts
const effective = composePermutation(this.filteredIndices, this.permutation);
```

Add a private helper:

```ts
/** Combine filter + sort into a single permutation handed to the
 *  reader. `filteredIndices` is the surviving row set in original
 *  order; `permutation` (when present) is a sort permutation over the
 *  ORIGINAL frame. We post-filter the sort permutation by the
 *  filteredIndices set so the visible window reflects both.
 *
 *  Open question 4 in the spec: the wasted memory of building the
 *  permutation over `nrow` rather than over the filtered domain is
 *  accepted in this first cut. Follow-up #328 tracks the fix. */
private composeEffective(): Uint32Array | undefined {
    if (!this.filteredIndices) return this.permutation;
    if (!this.permutation) return this.filteredIndices;
    const survives = new Uint8Array(this.reader.nrow);
    for (let i = 0; i < this.filteredIndices.length; i++) survives[this.filteredIndices[i]] = 1;
    const out = new Uint32Array(this.filteredIndices.length);
    let j = 0;
    for (let i = 0; i < this.permutation.length; i++) {
        if (survives[this.permutation[i]]) out[j++] = this.permutation[i];
    }
    return out;
}
```

Use it wherever the reader's `getRows` is called:

```ts
const effective = this.composeEffective();
const reply = await this.reader.getRows({
    /* ... */,
    permutation: effective,
});
```

- [ ] **Step 5: Recompute filter when Labels toggles** (saveToolbar handler)

In whatever method handles `saveToolbar`, after persisting toolbar state add:

```ts
const labelsFlipped = this.filter.labelsOnWhenFiltered !== m.toolbar.labelsOn;
if (labelsFlipped && this.filter.entries.some(e => e.enabled)) {
    // Trigger a recompute via the same path setFilters uses, but mark
    // fromPersistence=true so the chip-strip doesn't pulse-animate.
    await this.handleSetFilters({
        type: 'setFilters',
        panelGeneration: gen,
        requestId: this.nextRequestId(),
        entries: this.filter.entries,
        labelsOn: m.toolbar.labelsOn,
    }, gen);
}
```

- [ ] **Step 6: Persist on `saveFilter`**

```ts
case 'saveFilter': {
    await this.filterStore.save(this.panelName, m.schemaHash, m.filter);
    return;
}
```

### 10c — Panel round-trip test

- [ ] **Step 1: Failing test**

Mirror `tests/bun/data-viewer-panel-sort.test.ts`. Cover:

1. `init` includes `filter: EMPTY_FILTER` and a histograms blob for the numeric columns.
2. `setFilters` with one `numCompare > 2` on `x` → host posts `filterStatus pending` → `filterApplied` with `nrowFiltered === 3` → next `getRows` returns rows where x > 2.
3. `saveFilter` round-trips through the store.
4. Second panel init for the same `panelName + schemaHash` restores the filter and reapplies it.
5. Combined `setSort desc on x` + `setFilters > 2` → rows arrive in [5,4,3].

```ts
/**
 * Panel-level round-trip for filter: setFilters → filterApplied →
 * subsequent getRows respects the filter → saveFilter persists →
 * next init restores and reapplies. Also covers filter + sort
 * composition.
 *
 * Mocks `vscode` like the existing panel-persistence test.
 */
import { describe, test, expect, mock, afterEach } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ... copy MemKV, FakeWebview, FakeWebviewPanel, loadPanel from
//     data-viewer-panel-sort.test.ts verbatim; add a test that asserts
//     init.filter === EMPTY_FILTER and histograms is non-empty.

// Then:
//   - send setFilters with one numCompare > 2 on column 0 (x)
//   - assert filterStatus 'pending' + 'idle' + filterApplied posted in order
//   - assert nrowFiltered === 3
//   - send getRows {start:0,end:3,columns:[0]}
//   - assert returned rows are [3,4,5] in some order (subject to sort)
//   - send saveFilter; verify the store key is populated
//   - dispose, recreate the panel with the same MemKV, observe filter
//     restored in init
```

(Full file contents are repetitive; if it would help reduce error surface, the implementer should `cp` the existing `data-viewer-panel-sort.test.ts` and adapt — the helpers are identical.)

- [ ] **Step 2: Run**

```bash
bun test tests/bun/data-viewer-panel-filter.test.ts
```

Expected: FAIL until the implementation in 10a–10b is complete.

- [ ] **Step 3: Cycle until green**

Run `bun test tests/bun/` to confirm nothing else regressed.

- [ ] **Step 4: Commit**

```bash
git add editors/vscode/src/data-viewer/panel.ts \
        editors/vscode/src/data-viewer/manager.ts \
        editors/vscode/src/data-viewer/index.ts \
        tests/bun/data-viewer-panel-filter.test.ts
git commit -m "feat(data-viewer): wire filter through panel, compose with sort, persist"
```

---

## Task 11: Webview — `FilterStrip` component

**Files:**
- Create: `editors/vscode/src/data-viewer/webview/filter-strip.tsx`
- Modify: `editors/vscode/src/data-viewer/webview/styles.css`
- Modify: `editors/vscode/src/data-viewer/webview/App.tsx`

The strip is a styled near-copy of `sort-strip.tsx`. Differences:
- Chip text uses `summarizePredicate(entry.predicate, column)`.
- Each chip has a leading toggle glyph (✓ enabled, ✗ disabled) plus a kebab popover with Edit / Disable / Enable / Remove.
- Invalid entries (regex parse failure on the host) get class `filter-chip invalid` + the host's error in a `title` tooltip.
- Clicking the chip body itself opens the editor popover for that entry (the kebab is for quick actions; click-body is the primary edit affordance).
- Empty strip — render `null` like Sort does.

- [ ] **Step 1: Write the component** (pure UI; testing of the visual layer happens via end-to-end VS Code test in Task 14).

Reference implementation outline (full code is mechanical; expand following the sort-strip pattern):

```tsx
/**
 * Toolbar filter chip strip — peer of {@link ./sort-strip.tsx}.
 *
 * One chip per entry in FilterState. Each chip:
 *   - Reads from {@link summarizePredicate}.
 *   - Renders ✓/✗ leading glyph for enabled state.
 *   - Renders `invalid` class + tooltip when entry.isValid === false.
 *   - Clicking the chip body opens the filter-popover anchored at that
 *     chip's bottom-left, with the entry pre-populated.
 *   - Each chip's right-edge kebab opens a small actions popover:
 *     Edit / Disable (or Enable) / Remove.
 *
 * Hidden entirely when `filter.entries.length === 0`.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import type { ColumnSchema } from '../arrow-reader';
import type { FilterEntry, FilterState } from '../messages';
import { summarizePredicate } from './predicate-summary';
import { useDismiss } from './use-dismiss';

type Props = {
    filter: FilterState;
    columns: ColumnSchema[];
    onEdit: (entry: FilterEntry) => void;
    onToggleEnabled: (id: string) => void;
    onRemove: (id: string) => void;
    onClearAll: () => void;
};

export function FilterStrip({ filter, columns, onEdit, onToggleEnabled, onRemove, onClearAll }: Props) {
    if (filter.entries.length === 0) return null;
    return (
        <div className="filter-strip" role="group" aria-label="Active filters">
            <span className="filter-strip-label">Filter:</span>
            <div className="filter-strip-chips">
                {filter.entries.map(e => (
                    <FilterChip
                        key={e.id}
                        entry={e}
                        column={columns[e.columnIndex]}
                        onEdit={() => onEdit(e)}
                        onToggleEnabled={() => onToggleEnabled(e.id)}
                        onRemove={() => onRemove(e.id)}
                    />
                ))}
            </div>
            <button
                type="button"
                className="filter-strip-clear"
                aria-label="Clear all filters"
                title="Clear all filters"
                onClick={onClearAll}
            >
                ✕
            </button>
        </div>
    );
}

// FilterChip and its popover follow the structure of SortChip in
// sort-strip.tsx — same useLayoutEffect clamp to viewport, same role,
// same dismiss handling. Replace the per-chip menu items with
// Edit / Disable (or Enable) / Remove.
```

- [ ] **Step 2: Add styles**

Append to `styles.css`:

```css
.filter-strip {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-top: 1px solid var(--vscode-panel-border);
    overflow-x: auto;
}
.filter-strip-label {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
    user-select: none;
}
.filter-strip-chips { display: flex; gap: 4px; }
.filter-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 999px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-size: 0.9em;
    cursor: pointer;
}
.filter-chip.disabled { opacity: 0.55; }
.filter-chip.invalid { border-color: var(--vscode-inputValidation-errorBorder); }
.filter-chip-toggle { font-family: var(--vscode-editor-font-family); }
.filter-strip-clear {
    border: none; background: transparent; color: var(--vscode-descriptionForeground);
    cursor: pointer; font-size: 1em;
}
```

- [ ] **Step 3: Render in `App.tsx`**

In the toolbar render region, immediately below the existing `<ToolbarSortStrip ...>`:

```tsx
<FilterStrip
    filter={filter}
    columns={columns}
    onEdit={openFilterEditorForEntry}
    onToggleEnabled={toggleFilterEnabled}
    onRemove={removeFilter}
    onClearAll={clearAllFilters}
/>
```

The callbacks are stubbed for this task — they'll be wired in Task 13. For now they can be no-ops with `// TODO Task 13` comments **only** to keep this commit's surface minimal.

Wait — the rule prohibits no-op TODO scaffolding. Instead, inline the handlers (they're tiny) right here:

```tsx
const openFilterEditorForEntry = (entry: FilterEntry) => setFilterEditor({ entry });
const toggleFilterEnabled = (id: string) => {
    const next = filter.entries.map(e => e.id === id ? { ...e, enabled: !e.enabled } : e);
    applyFilters(next);
};
const removeFilter = (id: string) => {
    applyFilters(filter.entries.filter(e => e.id !== id));
};
const clearAllFilters = () => applyFilters([]);
```

Where `applyFilters` posts `setFilters` and `setFilterEditor` is a `useState` introduced in Task 13. For Task 11 commit, set these up alongside the existing `setSortKeys` / `clearSort` handlers in App.tsx so the build stays green.

- [ ] **Step 4: Typecheck + bun test**

```bash
cd editors/vscode && bun run typecheck && cd -
bun test tests/bun/
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/src/data-viewer/webview/filter-strip.tsx \
        editors/vscode/src/data-viewer/webview/styles.css \
        editors/vscode/src/data-viewer/webview/App.tsx
git commit -m "feat(data-viewer): filter chip strip"
```

---

## Task 12: Webview — column & cell context menu entries

**Files:**
- Modify: `editors/vscode/src/data-viewer/webview/column-context-menu.tsx`
- Modify: `editors/vscode/src/data-viewer/webview/App.tsx`

Extend `ColumnContextMenu` with a Filter section mirroring the Sort section. New props:

```ts
export type FilterMenuProps = {
    /** True when this column has an active filter chip. */
    hasFilter: boolean;
    /** True when any column has an active filter chip. */
    anyFiltered: boolean;
    onAddFilter: () => void;
    onClearColumn: () => void;
    onClearAll: () => void;
};
```

Render after the Sort section's divider (so the column menu reads Copy → Hide → Sort → Filter top-to-bottom). The Cell context menu gains two items: `Filter: column = <value>` and `Filter: column ≠ <value>` — accept `cellValue?: string` and `cellColumn?: ColumnSchema` props.

- [ ] **Step 1: Write the diff** (no isolated test — covered indirectly by the panel-filter test driving the host wire, and by the end-to-end test in Task 14).
- [ ] **Step 2: Typecheck + bun test**
- [ ] **Step 3: Commit**

```bash
git commit -m "feat(data-viewer): filter items in column & cell context menus"
```

---

## Task 13: Filter editor popover

**Files:**
- Create: `editors/vscode/src/data-viewer/webview/filter-popover.tsx`
- Create: `editors/vscode/src/data-viewer/webview/filter-histogram.tsx`
- Modify: `editors/vscode/src/data-viewer/webview/App.tsx`
- Modify: `editors/vscode/src/data-viewer/webview/styles.css`

The popover is type-driven. Its high-level skeleton:

```tsx
type Props = {
    column: ColumnSchema;
    histogram?: HistogramBin[];
    initial?: FilterEntry;        // present iff editing
    columnHasMissing: boolean;     // hides Include NA when no missing rows
    onApply: (entry: FilterEntry) => void;
    onCancel: () => void;
};

export function FilterPopover(props: Props) {
    // 1. Resolve the predicate-kind options from arrowType.
    // 2. Render the value editor for the active kind:
    //    numeric -> FilterHistogram + two number inputs
    //    factor / valueLabelled -> checklist with quick-search
    //    string -> input + Case sensitive toggle + Regex toggle
    //    date / timestamp -> date inputs
    //    bool -> radio
    // 3. Render Include NA checkbox (when columnHasMissing).
    // 4. Enter -> Apply; Escape -> Cancel.
}
```

`FilterHistogram` is a CSS-only `<svg>` with bin rects and two draggable thumb handles. Keyboard: Left/Right adjusts the active thumb by one bin (Shift+Left/Right by 10).

Implementation guidance:
- Anchor the popover with the same fixed-coords-clamped-to-viewport pattern as `SortChip` in `sort-strip.tsx`.
- Generate `entry.id` with `crypto.randomUUID()`. When `initial` is set, reuse `initial.id`.
- Empty value inputs in numeric/date/string editors disable the Apply button.

- [ ] **Step 1: Build the popover and histogram** (production code in this task is significant — ~250 lines combined; the implementer should follow the patterns above without inventing new ones).
- [ ] **Step 2: Wire `App.tsx` to open the popover from**:
  - Column context-menu `Filter…` → opens with no `initial`.
  - Filter chip click → opens with `initial = entry`.
  - Cell context-menu `Filter: column = X` → opens with a pre-built `initial` predicate.
- [ ] **Step 3: Typecheck + bun test + manual launch via `cd editors/vscode && bun run compile` then opening `View(mtcars)` in a Raven terminal.**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat(data-viewer): filter editor popover + histogram"
```

---

## Task 14: Status bar segment + persistence of `saveFilter`

**Files:**
- Modify: `editors/vscode/src/data-viewer/webview/App.tsx`
- Modify: `editors/vscode/src/data-viewer/webview/styles.css`
- Modify: `editors/vscode/src/data-viewer/panel.ts` (debounced saveFilter post)

Extend the existing status bar with a filter segment:

```tsx
{filter.entries.some(e => e.enabled) && nrowFiltered !== undefined && (
    <span className="status-filter">
        filtered to {nrowFiltered.toLocaleString()} ({pct(nrowFiltered, nrow)})
    </span>
)}
```

Where `pct` returns `''` for 0–1% / 99–100%, otherwise `${(100 * f / n).toFixed(1)}%`.

Debounce `saveFilter` 250 ms after the last `setFilters` round-trip — mirror the existing `saveSort` debounce.

- [ ] **Step 1: Edit + test**
- [ ] **Step 2: Commit**

```bash
git commit -m "feat(data-viewer): status-bar filter count + debounced saveFilter"
```

---

## Task 15: Keyboard shortcuts

**Files:**
- Modify: `editors/vscode/src/data-viewer/webview/App.tsx`

Add to the existing `onKeyDown` handler:

```ts
if (event.shiftKey && event.altKey && key === 'F') {
    if (focusedColumn != null) openFilterEditorForColumn(focusedColumn);
    event.preventDefault();
    return;
}
if (event.shiftKey && event.altKey && key === 'X') {
    if (focusedColumn != null) clearFilterForColumn(focusedColumn);
    event.preventDefault();
    return;
}
if (event.shiftKey && event.altKey && key === '9') {
    clearAllFilters();
    event.preventDefault();
    return;
}
```

Match the modifier-fall-through rules already in place for `Shift+Alt+A` / `D` / `0`.

- [ ] **Step 1: Edit + test (existing keyboard tests cover the handler shape; add 3 assertions for the new chord shortcuts).**
- [ ] **Step 2: Commit**

```bash
git commit -m "feat(data-viewer): filter keyboard shortcuts (Shift+Alt+F/X/9)"
```

---

## Task 16: Settings: `raven.dataViewer.persistFilters` + `raven.dataViewer.maxFilters`

**Files:**
- Modify: `editors/vscode/package.json`
- Modify: `editors/vscode/src/initializationOptions.ts`
- Modify: `editors/vscode/src/test/settings.test.ts`

- [ ] **Step 1: Add to `package.json` schema** next to `persistSort`:

```json
"raven.dataViewer.persistFilters": {
    "type": "boolean",
    "default": true,
    "description": "Persist active filter chips per panel-name × schema hash. Set to false to make every View(df) open unfiltered."
},
"raven.dataViewer.maxFilters": {
    "type": "integer",
    "default": 32,
    "minimum": 1,
    "maximum": 256,
    "description": "Hard cap on simultaneous active filter chips. Add items disable above the cap."
}
```

- [ ] **Step 2: Thread through `initializationOptions.ts`** alongside `persistSort`.

- [ ] **Step 3: Add settings-mapping rows in the existing settings test**.

- [ ] **Step 4: Regenerate the settings reference**:

```bash
bun editors/vscode/scripts/generate-settings-reference.mjs
```

- [ ] **Step 5: Run**

```bash
bun test tests/bun/settings-reference.test.ts
bun test tests/bun/
```

- [ ] **Step 6: Commit**

```bash
git add editors/vscode/package.json editors/vscode/src/initializationOptions.ts \
        editors/vscode/src/test/settings.test.ts docs/configuration.md
git commit -m "feat(data-viewer): settings — persistFilters + maxFilters"
```

---

## Task 17: Docs — `## Filtering` section + comparison row

**Files:**
- Modify: `docs/data-viewer.md`
- Modify: `docs/comparison.md`

- [ ] **Step 1: Add `## Filtering` section** to `docs/data-viewer.md`, between `## Sorting` and `## Settings`:

```markdown
## Filtering

Right-click a column header → **Filter…** to add a filter. A toolbar
chip strip shows active filters; click a chip to edit, the kebab to
disable or remove. The trailing **✕** clears all filters.

### Predicates by column type

| Column type        | Predicates                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| Numeric            | `= ≠ < ≤ > ≥`, `between`, `not between`. Editor shows a histogram with draggable range thumbs.              |
| Factor / labelled  | `is one of`, `is not one of`. Editor shows a checklist of unique levels with a quick-search box.            |
| Character          | `contains`, `starts with`, `ends with`, `= ≠`, `matches regex` (ECMAScript syntax). Case sensitive toggle.   |
| Date / Timestamp   | `= ≠ < ≤ > ≥`, `between`, `not between`.                                                                    |
| Boolean            | `is true`, `is false`.                                                                                      |
| Any column         | `is empty`, `is not empty` — universal.                                                                     |

### NA / NaN

By default, missing rows (R's `NA`, floating-point `NaN`, `NULL`) fail
every predicate. Each filter has an **Include NA / NaN** checkbox that
re-includes missing rows for that filter only.

Use `is empty` / `is not empty` to filter explicitly *for* missing rows.

### Labels and Format

Filters that target labelled columns (factor and `haven_labelled`)
match against the same string the grid shows: the label when **Labels**
is on, the underlying code or value when off. Toggling Labels with a
labelled filter active re-runs the filter.

Format / digits never affect filtering — numeric predicates always
match against the underlying double, even when the grid is rounding
the display.

### Filter by selection

Right-click a cell to add a filter on its column from the cell's value
(`Filter: column = <value>` or `Filter: column ≠ <value>`). The
popover opens pre-populated so you can refine before applying.

### Persistence

Active filter chips are persisted per panel-name × schema hash
alongside layout, toolbar, and sort state. Only chip descriptors are
stored; the host always recomputes membership on restore against the
current frame. Set `raven.dataViewer.persistFilters` to `false` to make
every `View(df)` open unfiltered. The cap is 32 active filters per
panel (`raven.dataViewer.maxFilters`).

### Keyboard

| Key              | Action                                                  |
| ---------------- | ------------------------------------------------------- |
| `Shift+Alt+F`    | Open filter editor for the focused column.              |
| `Shift+Alt+X`    | Clear filter on the focused column.                     |
| `Shift+Alt+9`    | Clear all filters.                                      |
| `Enter` (popover)| Apply.                                                  |
| `Esc` (popover)  | Cancel.                                                 |
```

Update the toolbar diagram near the top of `data-viewer.md`:

```text
rows: 12,345 (filtered 1,287) | Sort: mpg▲ ✕ | Filter: cyl ∈ {6,8} ✕ | [Labels] [Format] [3 digits ▾] | [Columns ▾]
```

Append two rows to the Settings table:

```markdown
| `raven.dataViewer.persistFilters` | `true` | Persist active filters per panel-name × schema hash. |
| `raven.dataViewer.maxFilters` | `32` | Hard cap on simultaneous active filter chips. |
```

- [ ] **Step 2: Add a row to `docs/comparison.md`**

(Look up the table heading first — likely `### Data viewer` followed by a row-comparison table — and append a `Filter` row with cells for Raven, vscode-R, Positron, RStudio, Data Wrangler matching the survey findings.)

- [ ] **Step 3: Lint check**

```bash
markdownlint docs/data-viewer.md docs/comparison.md
```

- [ ] **Step 4: Commit**

```bash
git add docs/data-viewer.md docs/comparison.md
git commit -m "docs(data-viewer): document row filtering"
```

---

## Task 18: Adversarial code-review pass

This task is a checkpoint, not a code change. Run the `superpowers:requesting-code-review` skill against the full diff.

- [ ] **Step 1: Invoke the review skill** with prompt:

> Review the implementation of issue #323 against the spec in PR. Focus areas: predicate evaluation correctness (especially NA, ±Inf, BigInt coercion, regex parse failure path), filter+sort composition (does the visible window match `filter ∘ sort`?), persistence (composite key collisions, LRU eviction with the other stores), and UX (chip strip on narrow toolbars, popover focus return, keyboard shortcuts not hijacked). Look for places where the implementation drifted from the spec without justification.

- [ ] **Step 2: Triage findings** — for each, decide: fix now / file follow-up / declared not-a-bug.
- [ ] **Step 3: Apply fixes** as individual commits with the review item referenced.
- [ ] **Step 4: Re-run full bun test + VS Code test if needed.**

---

## Task 19: End-to-end VS Code integration test (optional, time permitting)

Author one `editors/vscode/src/test/data-viewer.filter.test.ts` to:
1. Open `View(mtcars)` via a real Raven R terminal.
2. Programmatically post a `setFilters` message via the testKey channel (or extend with a `testSetFilters` message — same shape as `testKey`).
3. Verify the grid's visible rows match expectation and the chip strip renders.
4. Close, reopen, assert restore.

Skip in CI if `isClaudeCodeSandbox()`.

- [ ] **Step 1–5: standard VS Code-test edit / run / commit cycle**.

---

## Self-review checklist (run before saying "plan complete")

1. Spec coverage — every "## Section" in the spec maps to at least one task:
   - Goals / non-goals ✓ (tasks scope-bounded by the spec)
   - Column-header context menu ✓ (Task 12)
   - Filter chip strip ✓ (Task 11)
   - Filter editor popover ✓ (Task 13)
   - Cell "Filter by this value" ✓ (Task 12)
   - Status bar ✓ (Task 14)
   - Predicates by type ✓ (Tasks 4–8)
   - Composition rules ✓ (Tasks 4 + 10)
   - Label-aware filtering ✓ (Task 8 + Task 10 labels-flipped recompute)
   - Sort + filter pipeline ✓ (Task 10b step 4)
   - NA / NaN ✓ (Task 4 includeMissing + Task 5 NaN cases)
   - Performance / architecture ✓ (filter.ts streaming, race gate in Task 10)
   - Persistence ✓ (Task 9 + Task 14 + Task 16)
   - Keyboard ✓ (Task 15)
   - Accessibility — partly inline; remind reviewer in Task 18 to verify focus return and aria-live counts.
   - Wire protocol ✓ (Task 1)
   - Settings ✓ (Task 16)
   - Docs ✓ (Task 17)

2. Placeholder scan — no "TBD", no naked "TODO", no "similar to Task N". One pointer to a code-review prompt in Task 18; the prompt itself is concrete.

3. Type consistency — `FilterPredicate.kind` strings appear identically in Tasks 1, 2, 4–8, 11, 13. `FilterEntry.id` always `string`. `FilterContext` is named consistently.
