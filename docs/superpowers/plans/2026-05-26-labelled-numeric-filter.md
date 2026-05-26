# Hybrid Labelled-Numeric Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give value-labelled numeric columns in the data viewer a hybrid filter editor — numeric range/compare predicates *plus* a label checklist that matches by underlying code, toggle-independently.

**Architecture:** Extract the popover's column-kind logic into a pure, tested module (`filter-column-kind.ts`); add a new `'labelledNumeric'` kind; teach the filter engine, chip summary, and popover to treat set-membership on these columns as **code-based** matching while *displaying* labels.

**Tech Stack:** TypeScript, React (webview), apache-arrow (JS), Bun test runner.

---

## Background (read before starting)

- The data viewer filter lives under `editors/vscode/src/data-viewer/`.
- A `haven_labelled` column is stored as a **numeric** Arrow type (`Int*`/`Uint*`/`Float*`) carrying a `valueLabels` map, e.g. `{"1":"low","2":"mid","3":"high"}`, on `ColumnSchema.valueLabels` (`arrow-reader.ts:43`).
- Today `colKind()` in `filter-popover.tsx` checks the numeric Arrow type *before* `valueLabels`, so these columns classify as `'numeric'` and the editor only offers `=,≠,<,≤,>,≥,between,not between`. The label branch is unreachable.
- **Decision (locked):** these columns get a hybrid menu; set-membership matches the **underlying numeric code** (never the label string), so flipping the Labels toggle never invalidates a filter. The chip still *shows* labels.
- Spec: `docs/superpowers/specs/2026-05-26-labelled-numeric-filter-design.md`.

### Test fixtures (already exist — do NOT regenerate)

Built by `editors/vscode/test-fixtures/generate-data-viewer.mjs`, read from `editors/vscode/test-fixtures/data-viewer/`:

- `tiny.arrow` col **6** `lbl`: `Float64 [1,2,3,1,2]`, labels `{1:low,2:mid,3:high}`.
- `labelled-non-float.arrow` col **0** `rating`: `Int32 [1,2,3,1,2]`, labels `{1:zebra,2:apple,3:mango}`.

Both have every value labelled. The engine matches numerically and is indifferent to label coverage, so these suffice; the "unlabelled code" path is exercised in the pure summary test (Task 4).

### Commands

- Run one bun test file (from repo root): `bun test tests/bun/<file>.test.ts`
- Type-check the webview: `cd editors/vscode && node_modules/.bin/tsc -p src/data-viewer/webview/tsconfig.json --noEmit` (run from repo root as a single command — see Task 7).

### Reuse, don't add a predicate kind

We **reuse** `setIn`/`setNotIn`. Their `values` already type as `(string | number)[]`. For a labelled-numeric column they hold **numeric codes**; for a factor they hold label strings; for a value-labelled string column they hold strings. The discriminator everywhere is the column schema (numeric Arrow type + `valueLabels`). Do **not** add `codeIn`/`codeNotIn` — it would churn `messages.ts`, the exhaustiveness switches, and persistence for no behavioral gain.

---

## Task 1: Extract column-kind logic into a pure module (no behavior change)

**Files:**
- Create: `editors/vscode/src/data-viewer/webview/filter-column-kind.ts`
- Create: `tests/bun/data-viewer-filter-column-kind.test.ts`
- Modify: `editors/vscode/src/data-viewer/webview/filter-popover.tsx` (remove inline `ColKind`/`colKind`/`KindOption`/`kindOptions`, import them instead)

- [ ] **Step 1: Write the failing test**

Create `tests/bun/data-viewer-filter-column-kind.test.ts`:

```ts
/**
 * filter-column-kind — pure classification of a ColumnSchema into the
 * editor's ColKind, and the per-kind predicate option lists. No React,
 * types-only imports, so it runs under bun directly.
 */
import { describe, test, expect } from 'bun:test';
import { colKind, kindOptions } from '../../editors/vscode/src/data-viewer/webview/filter-column-kind';
import type { ColumnSchema } from '../../editors/vscode/src/data-viewer/arrow-reader';

function col(partial: Partial<ColumnSchema> & Pick<ColumnSchema, 'name' | 'arrowType'>): ColumnSchema {
    return { isInteger: false, dictionaryShipped: false, ...partial };
}

const PLAIN_NUM = col({ name: 'x', arrowType: 'Int32', isInteger: true });
const FLOAT = col({ name: 'y', arrowType: 'Float64' });
const FACTOR = col({ name: 'f', arrowType: 'Dictionary<Int32, Utf8>', dictionary: ['a', 'b'], dictionaryShipped: true });
const STR = col({ name: 's', arrowType: 'Utf8' });
const STR_LBL = col({ name: 'answer', arrowType: 'Utf8', valueLabels: { Y: 'Apple' } });
const BOOL = col({ name: 'b', arrowType: 'Bool' });
const DATE = col({ name: 'd', arrowType: 'Date<DAY>' });
const TS = col({ name: 'ts', arrowType: 'Timestamp<MICROSECOND, UTC>' });

describe('colKind — stable classifications', () => {
    test('plain numeric', () => {
        expect(colKind(PLAIN_NUM)).toBe('numeric');
        expect(colKind(FLOAT)).toBe('numeric');
    });
    test('factor (dictionary)', () => expect(colKind(FACTOR)).toBe('factor'));
    test('value-labelled string stays factor', () => expect(colKind(STR_LBL)).toBe('factor'));
    test('plain string', () => expect(colKind(STR)).toBe('string'));
    test('bool', () => expect(colKind(BOOL)).toBe('bool'));
    test('date and timestamp', () => {
        expect(colKind(DATE)).toBe('date');
        expect(colKind(TS)).toBe('date');
    });
});

describe('kindOptions — shape per kind', () => {
    test('numeric offers compare/between + universal', () => {
        const vals = kindOptions('numeric').map(o => o.value);
        expect(vals).toEqual(['numCompare', 'numBetween', 'numNotBetween', 'isEmpty', 'isNotEmpty']);
    });
    test('factor offers set-membership + universal', () => {
        const vals = kindOptions('factor').map(o => o.value);
        expect(vals).toEqual(['setIn', 'setNotIn', 'isEmpty', 'isNotEmpty']);
    });
    test('string / bool / date each end with the universal pair', () => {
        for (const k of ['string', 'bool', 'date'] as const) {
            const vals = kindOptions(k).map(o => o.value);
            expect(vals.slice(-2)).toEqual(['isEmpty', 'isNotEmpty']);
        }
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bun/data-viewer-filter-column-kind.test.ts`
Expected: FAIL — `Cannot find module '.../filter-column-kind'`.

- [ ] **Step 3: Create the module by moving the existing logic verbatim**

Create `editors/vscode/src/data-viewer/webview/filter-column-kind.ts`:

```ts
/**
 * Pure column-type categorisation for the filter editor. Maps a
 * ColumnSchema to a ColKind and supplies the predicate-kind option list
 * per kind. Kept React-free so it is unit-testable under bun and so the
 * popover stays focused on rendering.
 */
import type { ColumnSchema } from '../arrow-reader';

export type ColKind = 'numeric' | 'factor' | 'string' | 'bool' | 'date';

export function colKind(col: ColumnSchema): ColKind {
    const t = col.arrowType;
    if (t.startsWith('Int') || t.startsWith('Uint') || t.startsWith('Float')) return 'numeric';
    if (t.startsWith('Dictionary')) return 'factor';
    if (col.valueLabels) return 'factor';
    if (t.startsWith('Utf8') || t.startsWith('LargeUtf8')) return 'string';
    if (t === 'Bool') return 'bool';
    if (t.startsWith('Date') || t.startsWith('Timestamp')) return 'date';
    return 'string'; // safe fallback
}

export type KindOption = { value: string; label: string };

export function kindOptions(kind: ColKind): KindOption[] {
    switch (kind) {
        case 'numeric':
            return [
                { value: 'numCompare', label: 'Compare (=, ≠, <, ≤, >, ≥)' },
                { value: 'numBetween', label: 'Between' },
                { value: 'numNotBetween', label: 'Not between' },
                { value: 'isEmpty', label: 'Is empty / NA' },
                { value: 'isNotEmpty', label: 'Is not empty' },
            ];
        case 'factor':
            return [
                { value: 'setIn', label: 'Is one of' },
                { value: 'setNotIn', label: 'Is not one of' },
                { value: 'isEmpty', label: 'Is empty / NA' },
                { value: 'isNotEmpty', label: 'Is not empty' },
            ];
        case 'string':
            return [
                { value: 'strContains', label: 'Contains' },
                { value: 'strNotContains', label: 'Does not contain' },
                { value: 'strStartsWith', label: 'Starts with' },
                { value: 'strEndsWith', label: 'Ends with' },
                { value: 'strCompareEq', label: 'Equals (=)' },
                { value: 'strCompareNe', label: 'Not equals (≠)' },
                { value: 'strRegex', label: 'Matches regex' },
                { value: 'isEmpty', label: 'Is empty / NA' },
                { value: 'isNotEmpty', label: 'Is not empty' },
            ];
        case 'bool':
            return [
                { value: 'bool', label: 'Is true / false' },
                { value: 'isEmpty', label: 'Is empty / NA' },
                { value: 'isNotEmpty', label: 'Is not empty' },
            ];
        case 'date':
            return [
                { value: 'dateCompare', label: 'Compare (=, ≠, <, ≤, >, ≥)' },
                { value: 'dateBetween', label: 'Between' },
                { value: 'dateNotBetween', label: 'Not between' },
                { value: 'isEmpty', label: 'Is empty / NA' },
                { value: 'isNotEmpty', label: 'Is not empty' },
            ];
    }
}
```

- [ ] **Step 4: Update `filter-popover.tsx` to import from the new module**

In `editors/vscode/src/data-viewer/webview/filter-popover.tsx`:

1. Add to the import block (after the `FilterHistogram` import near line 27):

```ts
import { colKind, kindOptions, type ColKind, type KindOption } from './filter-column-kind';
```

2. Delete the inline `// ── Column-type categorisation ──` section (the `type ColKind`, `function colKind`) and the `// ── Predicate-kind option lists per column type ──` section (`type KindOption`, `function kindOptions`) — currently lines ~49–112. Leave the `predicateToKindValue` function and everything below intact.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/bun/data-viewer-filter-column-kind.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 6: Commit**

```bash
git add editors/vscode/src/data-viewer/webview/filter-column-kind.ts \
        tests/bun/data-viewer-filter-column-kind.test.ts \
        editors/vscode/src/data-viewer/webview/filter-popover.tsx
git commit -m "refactor(data-viewer): extract pure colKind/kindOptions into filter-column-kind"
```

---

## Task 2: Add the `labelledNumeric` kind, options, and checklist choices

**Files:**
- Modify: `editors/vscode/src/data-viewer/webview/filter-column-kind.ts`
- Modify: `tests/bun/data-viewer-filter-column-kind.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `data-viewer-filter-column-kind.test.ts`)

```ts
import { labelledNumericChoices } from '../../editors/vscode/src/data-viewer/webview/filter-column-kind';

const LBL_FLOAT = col({ name: 'lbl', arrowType: 'Float64', valueLabels: { '1': 'low', '2': 'mid', '3': 'high' } });
const LBL_INT = col({ name: 'rating', arrowType: 'Int32', isInteger: true, valueLabels: { '1': 'zebra', '2': 'apple', '3': 'mango' } });

describe('colKind — labelled numeric', () => {
    test('numeric Arrow type + valueLabels → labelledNumeric', () => {
        expect(colKind(LBL_FLOAT)).toBe('labelledNumeric');
        expect(colKind(LBL_INT)).toBe('labelledNumeric');
    });
    test('numeric WITHOUT valueLabels stays numeric', () => {
        expect(colKind(col({ name: 'x', arrowType: 'Int32', isInteger: true }))).toBe('numeric');
    });
});

describe('kindOptions — labelledNumeric is hybrid, set-membership first', () => {
    test('lists setIn first and includes numeric predicates', () => {
        const vals = kindOptions('labelledNumeric').map(o => o.value);
        expect(vals).toEqual([
            'setIn', 'setNotIn', 'numCompare', 'numBetween', 'numNotBetween', 'isEmpty', 'isNotEmpty',
        ]);
    });
});

describe('labelledNumericChoices', () => {
    test('maps valueLabels to {code,label}, sorted by numeric code ascending', () => {
        expect(labelledNumericChoices(LBL_INT)).toEqual([
            { code: 1, label: 'zebra' },
            { code: 2, label: 'apple' },
            { code: 3, label: 'mango' },
        ]);
    });
    test('sorts out-of-order and string-keyed codes numerically (not lexically)', () => {
        const c = col({ name: 'q', arrowType: 'Float64', valueLabels: { '10': 'ten', '2': 'two', '1': 'one' } });
        expect(labelledNumericChoices(c).map(x => x.code)).toEqual([1, 2, 10]);
    });
    test('returns [] when there are no value labels', () => {
        expect(labelledNumericChoices(col({ name: 'x', arrowType: 'Int32' }))).toEqual([]);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/bun/data-viewer-filter-column-kind.test.ts`
Expected: FAIL — `colKind` returns `'numeric'` for `LBL_FLOAT`; `labelledNumericChoices` is not exported.

- [ ] **Step 3: Implement in `filter-column-kind.ts`**

Replace the `ColKind` type and the head of `colKind`:

```ts
export type ColKind = 'numeric' | 'labelledNumeric' | 'factor' | 'string' | 'bool' | 'date';

export function colKind(col: ColumnSchema): ColKind {
    const t = col.arrowType;
    const isNumeric = t.startsWith('Int') || t.startsWith('Uint') || t.startsWith('Float');
    if (isNumeric && col.valueLabels) return 'labelledNumeric';
    if (isNumeric) return 'numeric';
    if (t.startsWith('Dictionary')) return 'factor';
    if (col.valueLabels) return 'factor';
    if (t.startsWith('Utf8') || t.startsWith('LargeUtf8')) return 'string';
    if (t === 'Bool') return 'bool';
    if (t.startsWith('Date') || t.startsWith('Timestamp')) return 'date';
    return 'string'; // safe fallback
}
```

Add a `case 'labelledNumeric'` to `kindOptions`, immediately before `case 'numeric'`:

```ts
        case 'labelledNumeric':
            return [
                { value: 'setIn', label: 'Is one of' },
                { value: 'setNotIn', label: 'Is not one of' },
                { value: 'numCompare', label: 'Compare (=, ≠, <, ≤, >, ≥)' },
                { value: 'numBetween', label: 'Between' },
                { value: 'numNotBetween', label: 'Not between' },
                { value: 'isEmpty', label: 'Is empty / NA' },
                { value: 'isNotEmpty', label: 'Is not empty' },
            ];
```

Append the new export at the end of the file:

```ts
/** Checklist rows for a labelled-numeric column: one per labelled code,
 *  sorted by numeric code ascending. The code is the value the filter
 *  matches on; the label is for display only. */
export function labelledNumericChoices(col: ColumnSchema): { code: number; label: string }[] {
    const vl = col.valueLabels;
    if (!vl) return [];
    return Object.entries(vl)
        .map(([k, label]) => ({ code: Number(k), label }))
        .filter(c => Number.isFinite(c.code))
        .sort((a, b) => a.code - b.code);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/bun/data-viewer-filter-column-kind.test.ts`
Expected: PASS (all blocks, including the new labelled-numeric ones).

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/src/data-viewer/webview/filter-column-kind.ts \
        tests/bun/data-viewer-filter-column-kind.test.ts
git commit -m "feat(data-viewer): classify labelled-numeric columns + hybrid option list"
```

---

## Task 3: Engine — match set-membership by code on labelled-numeric columns

**Files:**
- Modify: `editors/vscode/src/data-viewer/filter.ts` (set-membership block ~lines 240–271; header doc ~lines 11–14)
- Modify: `tests/bun/data-viewer-filter-engine.test.ts` (replace the `haven_labelled` block ~lines 239–247; add a labelled-Int block)

- [ ] **Step 1: Replace the stale `haven_labelled` engine test and add coverage**

In `tests/bun/data-viewer-filter-engine.test.ts`, **replace** the existing block:

```ts
describe('computeFilteredIndices — setIn on haven_labelled with Labels on', () => {
    test('matches against label strings', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 6, { kind: 'setIn', values: ['low'] });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(out!.length).toBe(2);
        await r.close();
    });
});
```

with this (code-based, toggle-independent):

```ts
describe('computeFilteredIndices — setIn/setNotIn on labelled FLOAT (tiny col 6 lbl=[1,2,3,1,2])', () => {
    // valueLabels {1:low,2:mid,3:high}. Matching is by underlying code and
    // MUST be identical with Labels on and off (toggle-independent).
    test('setIn [1] matches rows 0,3 with Labels ON', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 6, { kind: 'setIn', values: [1] });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 3]);
        await r.close();
    });
    test('setIn [1] matches rows 0,3 with Labels OFF (identical)', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 6, { kind: 'setIn', values: [1] });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_OFF);
        expect(Array.from(out!)).toEqual([0, 3]);
        await r.close();
    });
    test('setIn [1,3] matches rows 0,2,3', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 6, { kind: 'setIn', values: [1, 3] });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 2, 3]);
        await r.close();
    });
    test('setNotIn [1] keeps rows 1,2,4', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 6, { kind: 'setNotIn', values: [1] });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([1, 2, 4]);
        await r.close();
    });
    test('label strings (legacy) no longer match — codes only', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 6, { kind: 'setIn', values: ['low'] });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([]);
        await r.close();
    });
});

describe('computeFilteredIndices — setIn on labelled INT (labelled-non-float col 0 rating=[1,2,3,1,2])', () => {
    test('setIn [2] matches rows 1,4 regardless of toggle', async () => {
        const r = await ArrowSliceReader.open(FIX('labelled-non-float.arrow'));
        const e = entry('a', 0, { kind: 'setIn', values: [2] });
        const on = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        const off = await computeFilteredIndices(r, state([e]), CTX_LABELS_OFF);
        expect(Array.from(on!)).toEqual([1, 4]);
        expect(Array.from(off!)).toEqual([1, 4]);
        await r.close();
    });
});
```

(`CTX_LABELS_OFF` is already defined at line 220 of this file. The labelled-string column at col 1 of `labelled-non-float.arrow` is intentionally left to the existing factor/value-labelled-string tests; its behavior is unchanged.)

- [ ] **Step 2: Run to verify the new tests fail**

Run: `bun test tests/bun/data-viewer-filter-engine.test.ts`
Expected: FAIL — `setIn [1]` currently routes through the displayed-label path (Labels ON) / `loadString` (Labels OFF). The "label strings no longer match" test fails because today `['low']` matches when Labels ON.

- [ ] **Step 3: Implement the code-matching branch in `filter.ts`**

In `acceptorFor`, inside `if (predicate.kind === 'setIn' || predicate.kind === 'setNotIn') {`, after the `if (isFactor) { … }` block and **before** `if (hasValueLabels && ctx.labelsOn) {`, insert:

```ts
        // Labelled NUMERIC column: always match the underlying numeric code,
        // regardless of the Labels toggle. The popover stores codes (numbers)
        // for these columns; labels are display-only. This makes the filter
        // toggle-independent (flipping Labels never invalidates it).
        const t = schema.arrowType;
        const isNumericLabelled = !isFactor && hasValueLabels
            && (t.startsWith('Int') || t.startsWith('Uint') || t.startsWith('Float'));
        if (isNumericLabelled) {
            const want = new Set(predicate.values.map(Number));
            const values = await loadNumeric(reader, columnIndex);
            return predicate.kind === 'setIn'
                ? (i) => want.has(values[i])
                : (i) => !want.has(values[i]);
        }
```

- [ ] **Step 4: Update the `filter.ts` module-doc invariant**

In the header block, change the `WYSIWYG label routing` bullet (~lines 11–14) to:

```ts
 *   - **WYSIWYG label routing (factors & value-labelled strings)**: when
 *     `labelsOn` is true, factor and value-labelled *string* columns evaluate
 *     `setIn` / `setNotIn` against the displayed label string; when false,
 *     against the underlying code / string value.
 *   - **Labelled-numeric set membership is code-based**: a numeric column
 *     carrying `valueLabels` always matches `setIn` / `setNotIn` against the
 *     underlying numeric code, ignoring `labelsOn` (the popover stores codes;
 *     labels are display-only). This is intentionally NOT WYSIWYG so the
 *     filter survives a Labels toggle.
```

- [ ] **Step 5: Run to verify it passes**

Run: `bun test tests/bun/data-viewer-filter-engine.test.ts`
Expected: PASS (new labelled blocks green; all pre-existing factor/string/date/numeric tests still green).

- [ ] **Step 6: Commit**

```bash
git add editors/vscode/src/data-viewer/filter.ts tests/bun/data-viewer-filter-engine.test.ts
git commit -m "feat(data-viewer): match labelled-numeric set filters by code, toggle-independent"
```

---

## Task 4: Chip summary — display labels for code-valued set predicates

**Files:**
- Modify: `editors/vscode/src/data-viewer/webview/predicate-summary.ts`
- Modify: `tests/bun/data-viewer-predicate-summary.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `data-viewer-predicate-summary.test.ts`)

```ts
const LBL_NUM: ColumnSchema = {
    name: 'gender', arrowType: 'Float64', isInteger: false, dictionaryShipped: false,
    valueLabels: { '1': 'Male', '2': 'Female', '998': "Don't know" },
};

describe('summarizePredicate — labelled-numeric set membership shows labels', () => {
    test('setIn maps codes to labels', () => {
        expect(sum({ kind: 'setIn', values: [1, 2] }, LBL_NUM))
            .toBe('gender ∈ {Male, Female}');
    });
    test('setNotIn maps codes to labels', () => {
        expect(sum({ kind: 'setNotIn', values: [998] }, LBL_NUM))
            .toBe("gender ∉ {Don't know}");
    });
    test('an unmapped code falls back to the bare number', () => {
        expect(sum({ kind: 'setIn', values: [1, 7] }, LBL_NUM))
            .toBe('gender ∈ {Male, 7}');
    });
    test('truncation past 4 applies to mapped labels', () => {
        const c: ColumnSchema = {
            name: 'k', arrowType: 'Int32', isInteger: true, dictionaryShipped: false,
            valueLabels: { '1': 'a', '2': 'b', '3': 'c', '4': 'd', '5': 'e', '6': 'f' },
        };
        expect(sum({ kind: 'setIn', values: [1, 2, 3, 4, 5, 6] }, c))
            .toBe('k ∈ {a, b, c, d +2 more}');
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/bun/data-viewer-predicate-summary.test.ts`
Expected: FAIL — summary prints raw codes (`gender ∈ {1, 2}`), not labels.

- [ ] **Step 3: Implement in `predicate-summary.ts`**

Change the two set cases (currently lines 25–26):

```ts
        case 'setIn': return `${n} ∈ {${summarizeSet(mapSetValues(p.values, col))}}`;
        case 'setNotIn': return `${n} ∉ {${summarizeSet(mapSetValues(p.values, col))}}`;
```

Add this helper near `summarizeSet`:

```ts
/** For a labelled-numeric column (numeric Arrow type + valueLabels), map
 *  each stored code to its label for display, falling back to the bare
 *  code when unmapped. All other columns (factors store labels already,
 *  strings store strings) pass through unchanged. */
function mapSetValues(values: (string | number)[], col: ColumnSchema): (string | number)[] {
    const t = col.arrowType;
    const isNumericLabelled = !!col.valueLabels
        && (t.startsWith('Int') || t.startsWith('Uint') || t.startsWith('Float'));
    if (!isNumericLabelled) return values;
    const vl = col.valueLabels!;
    return values.map(v => vl[String(v)] ?? v);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/bun/data-viewer-predicate-summary.test.ts`
Expected: PASS (new block green; the existing factor `setIn`/`setNotIn` and truncation tests still green, since `FACTOR` has no `valueLabels`).

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/src/data-viewer/webview/predicate-summary.ts \
        tests/bun/data-viewer-predicate-summary.test.ts
git commit -m "feat(data-viewer): chip summary shows labels for labelled-numeric set filters"
```

---

## Task 5: Popover — render the label checklist and store codes

**Files:**
- Modify: `editors/vscode/src/data-viewer/webview/filter-popover.tsx`
- Modify: `editors/vscode/src/data-viewer/webview/styles.css`

No bun unit test renders the popover (consistent with the existing code: there is no `FilterPopover` render test). This task wires the tested helpers from Tasks 1–2 into JSX; correctness is enforced by the type-checker (Task 7) and the engine/summary tests already covering the data path. Implement carefully and exactly as below.

- [ ] **Step 1: Import the choices helper**

In `filter-popover.tsx`, extend the Task-1 import:

```ts
import { colKind, kindOptions, labelledNumericChoices, type ColKind, type KindOption } from './filter-column-kind';
```

- [ ] **Step 2: Derive labelled-numeric flags next to `hasShippedDictionary`**

Find (≈ line 302):

```ts
    const hasShippedDictionary = kind === 'factor' && column.dictionaryShipped && Array.isArray(column.dictionary);
    const dictValues: string[] = hasShippedDictionary ? (column.dictionary ?? []) : [];
```

Add immediately after:

```ts
    const isLabelledNumeric = kind === 'labelledNumeric';
    const labelledChoices = isLabelledNumeric ? labelledNumericChoices(column) : [];
```

- [ ] **Step 3: Make `effectiveSetValues` return codes for labelled-numeric**

Replace `effectiveSetValues` (≈ lines 390–399):

```ts
    function effectiveSetValues(): (string | number)[] {
        if (isLabelledNumeric || hasShippedDictionary) {
            // labelled-numeric → numeric codes; shipped dictionary → label strings.
            return setSelected.selected;
        }
        // Free-text: split on comma or newline
        return freeText.text
            .split(/[\n,]+/)
            .map(s => s.trim())
            .filter(Boolean);
    }
```

- [ ] **Step 4: Add the labelled-numeric checklist branch**

Replace the set-membership editor block (≈ lines 522–573), which currently is `hasShippedDictionary ? (checklist) : (freetext)`, with a three-way:

```tsx
                {(selectedKind === 'setIn' || selectedKind === 'setNotIn') && (
                    isLabelledNumeric ? (
                        <>
                            <input
                                type="text"
                                className="filter-popover-input filter-popover-search"
                                placeholder="Search labels…"
                                value={factorSearch}
                                onChange={e => setFactorSearch(e.target.value)}
                            />
                            <div className="filter-popover-checklist">
                                {labelledChoices
                                    .filter(c => !factorSearch
                                        || c.label.toLowerCase().includes(factorSearch.toLowerCase())
                                        || String(c.code).includes(factorSearch))
                                    .map(c => {
                                        const checked = setSelected.selected.includes(c.code);
                                        return (
                                            <label key={c.code} className="filter-popover-check-row">
                                                <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    onChange={e => {
                                                        setSetSelected(s => ({
                                                            selected: e.target.checked
                                                                ? [...s.selected, c.code]
                                                                : s.selected.filter(x => x !== c.code),
                                                        }));
                                                    }}
                                                />
                                                <span className="filter-popover-label-text">{c.label}</span>
                                                <span className="filter-popover-code-dim">{c.code}</span>
                                            </label>
                                        );
                                    })}
                                {labelledChoices.length === 0 && (
                                    <div className="filter-popover-hint">No labels available</div>
                                )}
                            </div>
                        </>
                    ) : hasShippedDictionary ? (
                        <>
                            <input
                                type="text"
                                className="filter-popover-input filter-popover-search"
                                placeholder="Search values…"
                                value={factorSearch}
                                onChange={e => setFactorSearch(e.target.value)}
                            />
                            <div className="filter-popover-checklist">
                                {dictValues
                                    .filter(v => !factorSearch || v.toLowerCase().includes(factorSearch.toLowerCase()))
                                    .map((v, i) => {
                                        const checked = setSelected.selected.includes(v);
                                        return (
                                            <label key={i} className="filter-popover-check-row">
                                                <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    onChange={e => {
                                                        setSetSelected(s => ({
                                                            selected: e.target.checked
                                                                ? [...s.selected, v]
                                                                : s.selected.filter(x => x !== v),
                                                        }));
                                                    }}
                                                />
                                                {v}
                                            </label>
                                        );
                                    })}
                                {dictValues.length === 0 && (
                                    <div className="filter-popover-hint">No values available</div>
                                )}
                            </div>
                        </>
                    ) : (
                        <>
                            <textarea
                                className="filter-popover-textarea"
                                placeholder="One value per line or comma-separated"
                                value={freeText.text}
                                rows={4}
                                onChange={e => setFreeText({ text: e.target.value })}
                            />
                            <div className="filter-popover-hint">
                                Dictionary not available — enter values manually
                            </div>
                        </>
                    )
                )}
```

(Only the new `isLabelledNumeric ? (...) :` arm is added; the dictionary and free-text arms are unchanged from the original.)

- [ ] **Step 5: Add checklist label/code styling**

Append to `editors/vscode/src/data-viewer/webview/styles.css`:

```css
/* Labelled-numeric filter checklist: label fills the row, code is dimmed. */
.filter-popover-check-row .filter-popover-label-text {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.filter-popover-check-row .filter-popover-code-dim {
    flex: 0 0 auto;
    margin-left: auto;
    padding-left: 8px;
    opacity: 0.6;
    font-variant-numeric: tabular-nums;
}
```

(If `.filter-popover-check-row` is not already a flex row, also add `display: flex; align-items: center;` to its existing rule — check the file first and only add the properties it lacks.)

- [ ] **Step 6: Type-check the webview**

Run: `cd editors/vscode && node_modules/.bin/tsc -p src/data-viewer/webview/tsconfig.json --noEmit; cd "$OLDPWD"`
Expected: no errors. (If `tsc` reports an unused `KindOption` import, drop `KindOption` from the import — it was only used by the old inline code; keep `ColKind` only if still referenced, otherwise remove it too.)

- [ ] **Step 7: Commit**

```bash
git add editors/vscode/src/data-viewer/webview/filter-popover.tsx \
        editors/vscode/src/data-viewer/webview/styles.css
git commit -m "feat(data-viewer): labelled-numeric filter checklist (label + code) in popover"
```

---

## Task 6: Docs and module-doc updates

**Files:**
- Modify: `docs/data-viewer.md`
- Modify: `editors/vscode/src/data-viewer/webview/filter-popover.tsx` (header comment only)

- [ ] **Step 1: Update the per-type predicate table in `docs/data-viewer.md`**

Find the table row (≈ line 242–243):

```text
| Numeric (Int, Float) | `=`, `≠`, `<`, `≤`, `>`, `≥`, `between`, `not between` |
| Factor / value-labelled (`haven_labelled`, `foreign`, `readstata13`) | `is one of`, `is not one of` |
```

Replace those two rows with:

```text
| Numeric (Int, Float) | `=`, `≠`, `<`, `≤`, `>`, `≥`, `between`, `not between` |
| Labelled numeric (`haven_labelled`, `foreign`, `readstata13`) | `is one of`, `is not one of` (label checklist, matched by code) **plus** the full numeric set above |
| Factor | `is one of`, `is not one of` |
```

- [ ] **Step 2: Update the checklist note (≈ lines 253–255)**

Find:

```text
For factor and value-labelled columns, the editor shows a searchable
checklist of levels when the column's value dictionary has been shipped.
Large or unshipped dictionaries fall back to a free-text value list.
```

Replace with:

```text
For factor columns, the editor shows a searchable checklist of levels when
the column's value dictionary has been shipped; large or unshipped
dictionaries fall back to a free-text value list. For labelled numeric
columns the editor defaults to a searchable checklist of the labelled
values, each shown as label + underlying code, and also offers the full
set of numeric predicates via the condition dropdown.
```

- [ ] **Step 3: Update the "Labels and Format" filtering subsection (≈ lines 271–280)**

After the existing paragraph that begins "Filters on labelled columns match the displayed string", append:

```text
Labelled **numeric** columns are the exception: their `is one of` /
`is not one of` checklist matches the **underlying numeric code**, not the
displayed label, so toggling Labels never changes which rows a labelled-numeric
filter keeps. The chip still shows the labels (for example `gender ∈ {Male,
Female}`). The numeric `compare` / `between` predicates likewise match the
underlying value, as for any numeric column.
```

- [ ] **Step 4: Update the `filter-popover.tsx` header "behaviour by column kind" comment**

In the header block (≈ lines 4–12), add a line under the Numeric line:

```ts
 *  Labelled numeric (numeric type + valueLabels) → setIn / setNotIn (label
 *      checklist, stored & matched as codes) | numCompare | numBetween |
 *      numNotBetween. setIn/setNotIn pre-selected.
```

- [ ] **Step 5: Verify docs lint clean** (markdownlint runs in CI; keep table pipes aligned and fenced blocks language-tagged)

Run: `bun test tests/bun/data-viewer-filter-column-kind.test.ts tests/bun/data-viewer-filter-engine.test.ts tests/bun/data-viewer-predicate-summary.test.ts`
Expected: PASS (sanity that nothing regressed while editing).

- [ ] **Step 6: Commit**

```bash
git add docs/data-viewer.md editors/vscode/src/data-viewer/webview/filter-popover.tsx
git commit -m "docs(data-viewer): document hybrid labelled-numeric filtering"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full bun suite**

Run: `bun test tests/bun/`
Expected: all pass, no regressions. (If the wrapper that runs VS Code/Mocha suites is slow or environment-gated, scope to the data-viewer files: `bun test tests/bun/data-viewer-*.test.ts`.)

- [ ] **Step 2: Type-check the webview**

Run: `cd editors/vscode && node_modules/.bin/tsc -p src/data-viewer/webview/tsconfig.json --noEmit; cd "$OLDPWD"`
Expected: no errors.

- [ ] **Step 3: Confirm no stray references to the removed inline functions**

Run: `grep -n "function colKind\|function kindOptions" editors/vscode/src/data-viewer/webview/filter-popover.tsx`
Expected: no matches (both now live in `filter-column-kind.ts`).

- [ ] **Step 4: Final commit if anything was adjusted**

```bash
git add -A && git commit -m "test(data-viewer): verify labelled-numeric filter end-to-end" || echo "nothing to commit"
```

---

## Self-review notes (for the implementer)

- **Spec coverage:** Task 1–2 = classification + options (spec §1–2); Task 3 = engine code-matching (spec §4 + principle); Task 4 = chip summary labels (spec §5); Task 5 = popover checklist/default (spec §3); Task 6 = docs (spec §7). Persistence (spec §6) needs no code change — covered by the unchanged `setIn.values` serialization and verified implicitly by the engine tests.
- **Type consistency:** `colKind`/`kindOptions`/`labelledNumericChoices` signatures are identical across all tasks. `setSelected.selected` holds `number[]` for labelled-numeric and `string[]` for factors — never mixed within one column.
- **No new predicate kind** — `setIn`/`setNotIn` reused; `messages.ts`, `data-viewer-filter-types.test.ts`, and persistence are untouched.
- **Behavior change is safe:** no UI path could previously emit `setIn` on a numeric-typed labelled column (old `colKind` returned `'numeric'`), so no persisted label-string set filters exist to migrate.
```