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
 *   - **WYSIWYG label routing (factors & value-labelled strings)**: when
 *     `labelsOn` is true, factor and value-labelled *string* columns evaluate
 *     `setIn` / `setNotIn` against the displayed label string; when false,
 *     against the underlying code / string value.
 *   - **Labelled-numeric set membership is code-based**: a numeric column
 *     carrying `valueLabels` always matches `setIn` / `setNotIn` against the
 *     underlying numeric code, ignoring `labelsOn` (the popover stores codes;
 *     labels are display-only). This is intentionally NOT WYSIWYG so the
 *     filter survives a Labels toggle.
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
    // isEmpty targets missing values — they always pass regardless of includeMissing.
    // All other predicates use the entry's includeMissing flag.
    const include = p.kind === 'isEmpty' ? true : entry.includeMissing;
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
    if (predicate.kind === 'isEmpty') return () => false;
    if (predicate.kind === 'isNotEmpty') return () => true;

    if (predicate.kind === 'bool') {
        const values = await loadBool(reader, columnIndex);
        const want = predicate.value ? 1 : 0;
        return (i) => values[i] === want;
    }

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

    if (predicate.kind === 'strCompare'
        || predicate.kind === 'strContains'
        || predicate.kind === 'strStartsWith'
        || predicate.kind === 'strEndsWith'
        || predicate.kind === 'strRegex') {
        const values = await loadString(reader, columnIndex);
        const cs = predicate.caseSensitive;
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
                // NB: the compiled pattern is user-supplied and `r.test` runs
                // synchronously over every row on the extension-host event
                // loop. A catastrophic-backtracking pattern (e.g. `(a+)+$`)
                // on a large frame can stall the host. This is user-
                // self-inflicted and the webview validates syntax (not ReDoS)
                // before applying; a hard guard would require a worker. If we
                // ever see this in practice, move filter compute off-thread.
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

    if (predicate.kind === 'dateCompare'
        || predicate.kind === 'dateBetween'
        || predicate.kind === 'dateNotBetween') {
        // Convert ISO strings to the same numeric domain the underlying
        // arrow values live in.
        //
        // apache-arrow's child.get(r) for Date32<DAY> (DateDay) returns
        // ms-since-epoch — NOT day-count — even though the raw typed array
        // stores days. loadNumeric therefore stores ms for all Date columns.
        // Timestamp columns (bigint microseconds) coerce to Number ms * 1000
        // via loadNumeric's bigint path, which loses sub-ms precision but is
        // fine for user-typed ISO strings.
        const values = await loadNumeric(reader, columnIndex);
        const isTs = schema.arrowType.startsWith('Timestamp');
        const toUnit = (iso: string): number => {
            const ms = Date.parse(iso);
            if (!Number.isFinite(ms)) return NaN;
            if (isTs) return ms * 1000;
            // Date32<DAY> / Date64: loadNumeric stores ms-since-epoch.
            return ms;
        };
        switch (predicate.kind) {
            case 'dateCompare': {
                const v = toUnit(predicate.value);
                // Unparseable ISO -> no-match, mirroring the invalid-regex
                // fallback. Without this guard `!=` would keep every row,
                // since `x !== NaN` is always true.
                if (!Number.isFinite(v)) return () => false;
                switch (predicate.op) {
                    case '=': return (i) => values[i] === v;
                    case '!=': return (i) => values[i] !== v;
                    case '<': return (i) => values[i] < v;
                    case '<=': return (i) => values[i] <= v;
                    case '>': return (i) => values[i] > v;
                    case '>=': return (i) => values[i] >= v;
                }
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

    if (predicate.kind === 'setIn' || predicate.kind === 'setNotIn') {
        const wantStr = new Set(predicate.values.map(String));
        const isFactor = schema.arrowType.startsWith('Dictionary');
        const hasValueLabels = !!schema.valueLabels;

        if (isFactor) {
            const codes = await loadFactorCodes(reader, columnIndex);
            if (ctx.labelsOn) {
                const labels: string[] = Array.isArray(schema.dictionary)
                    ? schema.dictionary
                    : await dictFromGetLabels(reader, columnIndex, codes);
                return predicate.kind === 'setIn'
                    ? (i) => wantStr.has(labels[codes[i]])
                    : (i) => !wantStr.has(labels[codes[i]]);
            }
            return predicate.kind === 'setIn'
                ? (i) => wantStr.has(String(codes[i]))
                : (i) => !wantStr.has(String(codes[i]));
        }

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

        if (hasValueLabels && ctx.labelsOn) {
            const displayed = await loadValueLabelled(reader, columnIndex, schema);
            return predicate.kind === 'setIn'
                ? (i) => wantStr.has(displayed[i])
                : (i) => !wantStr.has(displayed[i]);
        }

        const values = await loadString(reader, columnIndex);
        return predicate.kind === 'setIn'
            ? (i) => wantStr.has(values[i])
            : (i) => !wantStr.has(values[i]);
    }

    const _exhaustive: never = predicate;
    throw new Error(`filter: unhandled predicate ${(_exhaustive as { kind: string }).kind}`);
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
