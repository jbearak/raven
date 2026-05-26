# Hybrid filtering for labelled numeric columns

**Date:** 2026-05-26
**Status:** Approved — ready for implementation plan
**Area:** Data viewer → filter editor (TypeScript / webview)

## Problem

Raven's data viewer recognizes value-labelled columns (`haven_labelled`,
`foreign` `value.labels`, `readstata13`) and substitutes labels for codes when
the **Labels** toggle is on. But the *filter* editor does not. In
`editors/vscode/src/data-viewer/webview/filter-popover.tsx`, `colKind()`
classifies a column by its Arrow type **before** it checks for value labels:

```ts
if (t.startsWith('Int') || t.startsWith('Uint') || t.startsWith('Float')) return 'numeric';
// ...
if (col.valueLabels) return 'factor';   // unreachable for haven_labelled
```

A `haven_labelled` column is stored as a **numeric** Arrow type carrying a
`valueLabels` map (e.g. `{"1":"Male","2":"Female"}`), so it always classifies as
`'numeric'`. The value-label branch never fires. The filter editor offers only
`=, ≠, <, ≤, >, ≥, between, not between` — the user must know the underlying code
to filter, and the labels are invisible. (`docs/data-viewer.md` claims
value-labelled columns get `is one of`; that is currently aspirational for
numeric-typed ones.)

Two real-world flavors of labelled numeric column want different things:

- **Fully categorical** (e.g. `gender`: 1=Male, 2=Female) — a label checklist is
  ideal; range filtering is meaningless.
- **Partially-labelled continuous** (e.g. `age`: 0–120 with sentinels
  998="Don't know", 999="Refused") — wants range filters *and* a way to
  select/exclude the labelled sentinel codes. A pure checklist cannot list
  thousands of distinct ages.

## Decisions (locked)

1. **Hybrid editor.** Keep every numeric predicate (compare / between / not
   between) **and** add `Is one of` / `Is not one of` whose checklist lists the
   labelled values as label + code. The user chooses via the Condition dropdown.
2. **Match by underlying code.** Selecting "Male" stores and matches the numeric
   code `1`, not the string "Male". Filtering on a labelled numeric column is
   **uniformly code-based and toggle-independent**: flipping Labels on/off never
   invalidates a filter. The chip displays the label.
3. **Default to `Is one of`.** For a labelled numeric column the Condition
   dropdown lists set-membership first and pre-selects it, so the label
   checklist is visible immediately. One click switches to range filtering.

## Guiding principle

> A labelled numeric column always filters on the underlying numeric value. The
> labels are a convenience for *picking* codes, never the matched key.

This is a deliberate, documented divergence from factor (Dictionary) columns,
which keep their WYSIWYG displayed-string matching.

## Design

### 1. Classification — `filter-popover.tsx::colKind`

Introduce a new `ColKind` value `'labelledNumeric'`, detected **before** plain
numeric:

```ts
const isNumeric = t.startsWith('Int') || t.startsWith('Uint') || t.startsWith('Float');
if (isNumeric && col.valueLabels) return 'labelledNumeric';
if (isNumeric) return 'numeric';
if (t.startsWith('Dictionary')) return 'factor';
if (col.valueLabels) return 'factor';   // rare value-labelled string column — unchanged
// ...
```

### 2. Option list — `kindOptions('labelledNumeric')`

Returns the hybrid menu, set-membership first:

```text
Is one of            (setIn)        ← pre-selected
Is not one of        (setNotIn)
Compare (=,≠,<,≤,>,≥) (numCompare)
Between              (numBetween)
Not between          (numNotBetween)
Is empty / NA        (isEmpty)
Is not empty         (isNotEmpty)
```

### 3. Checklist editor

When the selected kind is `setIn`/`setNotIn` on a labelled-numeric column, render
a **searchable checklist built from `col.valueLabels`** — a third branch
alongside the existing shipped-dictionary and free-text branches:

- One row per labelled code, showing the **label** (primary) and the **code**
  (dimmed secondary): `Male  (1)`.
- Rows sorted by **numeric code ascending**.
- Selection state keyed by the **numeric code** (`number`).
- The search box matches on label text **or** code string.

Between / Not between reuse the existing numeric inputs and histogram brush;
Compare reuses the existing op-select + number input. No change to those editors.

### 4. Predicate & engine — `messages.ts`, `filter.ts`

Reuse the existing `setIn` / `setNotIn` predicates — **no new predicate kind**.
The selected codes are stored as **numbers** in `predicate.values`.

In `filter.ts`'s set-membership block, add a branch **ahead of** the existing
`hasValueLabels && ctx.labelsOn` branch:

> If the column's Arrow type is numeric **and** it has `valueLabels`, build
> `const want = new Set(predicate.values.map(Number))` and match `loadNumeric`
> codes: `setIn` → `(i) => want.has(values[i])`, `setNotIn` → negation.
> `ctx.labelsOn` is **ignored**.

`numCompare` / `numBetween` / `numNotBetween` already match the raw double, so
they need no change. The result: every predicate on a labelled-numeric column is
code-based.

The pre-existing `hasValueLabels && ctx.labelsOn` (displayed-label) branch
remains for the rare **value-labelled string** column, whose behavior is
unchanged.

### 5. Chip summary — `predicate-summary.ts`

`summarizePredicate(p, col)` already receives the `ColumnSchema`. For
`setIn`/`setNotIn` on a labelled-numeric column (numeric Arrow type +
`valueLabels`), map each stored code → its label (fall back to the bare code when
a code is unmapped) before building the `∈ {…}` summary, so the chip reads
`gender ∈ {Male, Female}` though the stored values are `[1, 2]`. The 4-value
truncation rule is unchanged and applies to the mapped labels.

### 6. Persistence

No schema change — `setIn.values` already serializes as `(string | number)[]`.
Restored filters re-evaluate against current data (existing behavior). Codes are
small integers and round-trip losslessly through JSON.

### 7. Docs

- `docs/data-viewer.md`:
  - Per-type predicate table: the labelled-numeric row gets the full hybrid set,
    not the factor-only set.
  - "Labels and Format" filtering subsection: state that labelled-numeric columns
    filter on the underlying numeric value, set-membership included, and are
    therefore unaffected by the Labels toggle (label is a picking convenience).
- Module-doc updates: `filter.ts` header invariants (WYSIWYG-label-routing note
  must carve out labelled-numeric code matching) and `filter-popover.tsx` header
  "behaviour by column kind" table (add the labelledNumeric row).

## Testing

Bun tests (under `tests/bun/`, matching existing data-viewer filter coverage):

1. **Classification:** a numeric-typed column with `valueLabels` →
   `labelledNumeric`; without → `numeric`; a Dictionary column → `factor`;
   a value-labelled string column → `factor` (unchanged).
2. **Option list:** `kindOptions('labelledNumeric')` lists `setIn` first and
   includes the numeric predicates.
3. **Engine — code matching:** `setIn`/`setNotIn` with code values match the
   right rows **with `labelsOn: true` and `labelsOn: false`** (identical
   result), proving toggle-independence. Include an unlabelled-code row to
   confirm `setNotIn` keeps it.
4. **Numeric predicates still work** on a labelled-numeric column (compare /
   between unaffected).
5. **Seed / persistence round-trip:** an entry with `values: [1, 2]` re-opens
   with codes 1 and 2 checked; persists and restores unchanged.
6. **Summary mapping:** `setIn` `values: [1, 2]` on a gender column →
   `gender ∈ {Male, Female}`; an unmapped code falls back to the bare number;
   truncation past 4 values still applies.
7. **includeMissing / isEmpty** behavior on a labelled-numeric column is
   unchanged.

## Scope / non-goals

- Factor (Dictionary) columns and value-labelled **string** columns are
  unchanged.
- No size cap on `valueLabels` for the checklist (these maps are small in
  practice; the checklist is searchable). No new shipping threshold.
- The between-histogram still spans raw values including sentinel codes —
  pre-existing, out of scope.
- No change to sorting, the Labels/Format toggles, copy, or persistence schema.

## Files touched

- `editors/vscode/src/data-viewer/webview/filter-popover.tsx` — `colKind`,
  `kindOptions`, checklist branch, `buildPredicate`/`seedFromEntry` for codes.
- `editors/vscode/src/data-viewer/filter.ts` — code-matching branch in
  set-membership; header invariant doc.
- `editors/vscode/src/data-viewer/webview/predicate-summary.ts` — code→label
  mapping for labelled-numeric set summaries.
- `editors/vscode/src/data-viewer/webview/styles.css` — checklist code-secondary
  styling (if needed).
- `docs/data-viewer.md` — predicate table + Labels/Format filtering note.
- Bun tests under `tests/bun/`.
</content>
</invoke>
