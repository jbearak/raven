/**
 * Copy as R code: the current view (filters, sort, hidden columns) as R
 * code against the expression passed to `View()`, in three flavors
 * (dplyr, base R, data.table). ark's `convert_to_code.rs` (MIT) was the
 * reference for the shape; the predicates here come from the typed
 * filter model, so they round-trip.
 *
 * Fidelity rules (each mirrors the engine it reproduces):
 *   - **Filters** (`filter.ts`): a missing value (NA, or NaN in a double
 *     column) fails an entry unless `includeMissing` is set, when it
 *     passes; `isEmpty` always keeps missing rows and `isNotEmpty` always
 *     drops them. Every flavor drops rows whose condition is NA (dplyr's
 *     `filter()`, `which()` in base R, data.table's `i`), so a predicate
 *     only needs an explicit `!is.na(x) &` when it can be TRUE for NA
 *     (negations). Set filters on factors and value-labelled character
 *     columns use labels when Labels was on at filter time and codes or
 *     values when it was off; labelled numeric columns always use codes.
 *     `numBetween` honors `upperInclusive`.
 *   - **Sorts** (`sort.ts`): stable, NA last in both directions, NaN just
 *     before NA. dplyr and base R put NaN and NA together in original
 *     order, so a double key gains an `is.na(x) & !is.nan(x)` tie-break
 *     unless the column is known to have no NaN; data.table already
 *     orders NaN first. Factors sort by level order with Labels off and
 *     by label text with it on; value-labelled columns by label text with
 *     Labels on. String keys follow the string order: C →
 *     `.locale = "C"` (code point order; base R's `method = "radix"`,
 *     data.table's own order), Locale → `.locale = "<ui language>"` (or
 *     `stringr::str_rank()` outside dplyr), Natural →
 *     `stringr::str_rank(x, locale = "<ui language>", numeric = TRUE)`.
 *     Descending keys use `desc()`, `decreasing =`, or unary minus.
 *
 * A filter or sort the generator can't express faithfully is left out
 * and named in a comment, never approximated silently.
 */
import type { ColumnSchema } from './arrow-reader';
import type { FilterEntry, FilterPredicate, FilterState, SortState, StringOrder } from './messages';
import { keyKind } from './sort';

export type CodeFlavor = 'dplyr' | 'base' | 'data.table';

export type CodeInput = {
    /** The deparsed expression passed to `View()`. */
    expression: string;
    /** What `View()` received: `data.frame`, `matrix`, `vector`, `list`.
     *  Absent ⇔ unknown (an older R session); treated as a data frame. */
    sourceKind?: string;
    columns: readonly ColumnSchema[];
    sort: SortState;
    filter: FilterState;
    hiddenColumns: readonly number[];
    /** VS Code's UI language, the locale of Natural and Locale orders. */
    locale: string;
    /** True when column `i` is known to hold no NaN (from its profile), so
     *  its sort key needs no NaN-before-NA tie-break. */
    noNaN?: (columnIndex: number) => boolean;
};

export type CodeResult = { code: string } | { error: string };

const SYNTACTIC = /^((([A-Za-z]|[.][A-Za-z._])[A-Za-z0-9._]*)|[.])$/;
const RESERVED = new Set([
    'if', 'else', 'repeat', 'while', 'function', 'for', 'next', 'break', 'TRUE', 'FALSE', 'NULL',
    'Inf', 'NaN', 'NA', 'NA_integer_', 'NA_real_', 'NA_character_', 'NA_complex_', 'in',
]);

/** `name` as an R symbol, backticked when it isn't syntactic. */
export function rName(name: string): string {
    if (SYNTACTIC.test(name) && !RESERVED.has(name)) return name;
    return '`' + name.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
}

/** A double-quoted R string literal. Non-ASCII text stays literal (R
 *  reads UTF-8 source); control characters are escaped. */
export function rString(s: string): string {
    let out = '"';
    for (const ch of s) {
        const c = ch.codePointAt(0)!;
        if (ch === '\\') out += '\\\\';
        else if (ch === '"') out += '\\"';
        else if (ch === '\n') out += '\\n';
        else if (ch === '\r') out += '\\r';
        else if (ch === '\t') out += '\\t';
        else if (c < 0x20 || c === 0x7f) out += '\\x' + c.toString(16).padStart(2, '0');
        else out += ch;
    }
    return out + '"';
}

/** A double as an R literal that reads back to the same value. */
export function rNumber(v: number): string {
    if (Number.isNaN(v)) return 'NaN';
    if (v === Infinity) return 'Inf';
    if (v === -Infinity) return '-Inf';
    return String(v);
}

function rVector(items: string[]): string {
    return items.length === 1 ? items[0] : `c(${items.join(', ')})`;
}

const LABEL_HELPER = [
    '# Each value\'s label where it has one, else the value, as the viewer shows with Labels on',
    'label_or_value <- function(x, labels) {',
    '  key <- as.character(unclass(x))',
    '  out <- unname(labels[key])',
    '  out[is.na(out)] <- key[is.na(out)]',
    '  out[is.na(x)] <- NA',
    '  out',
    '}',
];

/** Per-flavor naming of columns and the frame. */
type Ctx = {
    flavor: CodeFlavor;
    input: CodeInput;
    /** Name of the frame inside base R's `with()` (rownames lookup). */
    frame: string;
    /** True once a rowname column is materialized as a real column. */
    rownamesAsColumn: boolean;
    needs: Set<'stringr' | 'stringi' | 'labelHelper' | 'tibble'>;
    skipped: string[];
};

function colRef(ctx: Ctx, ci: number): string {
    const col = ctx.input.columns[ci];
    if (col.isRowname && !ctx.rownamesAsColumn) return `rownames(${ctx.frame})`;
    return rName(col.name);
}

/** A column's values for comparison: value-labelled vectors are
 *  unclassed, because `%in%` (via `mtfrm()`) and some comparisons refuse
 *  `haven_labelled`. */
function valueRef(ctx: Ctx, ci: number): string {
    const col = ctx.input.columns[ci];
    const x = colRef(ctx, ci);
    return col.valueLabels && !isFactor(col) ? `unclass(${x})` : x;
}

function isFactor(col: ColumnSchema): boolean {
    return col.arrowType.startsWith('Dictionary');
}

function isNumericType(t: string): boolean {
    return t.startsWith('Int') || t.startsWith('Uint') || t.startsWith('Float');
}

function labelsVector(col: ColumnSchema): string {
    const entries = Object.entries(col.valueLabels ?? {})
        .map(([k, v]) => `${rString(k)} = ${rString(v)}`);
    return `c(${entries.join(', ')})`;
}

function labelled(ctx: Ctx, ci: number): string {
    ctx.needs.add('labelHelper');
    return `label_or_value(${colRef(ctx, ci)}, ${labelsVector(ctx.input.columns[ci])})`;
}

/** The predicate of one entry over non-missing values, and whether it
 *  can be TRUE for a missing one. `null` ⇔ not expressible. */
function predicateCode(
    ctx: Ctx, entry: FilterEntry, labelsOn: boolean,
): { code: string; trueOnNA: boolean } | null {
    const col = ctx.input.columns[entry.columnIndex];
    const x = valueRef(ctx, entry.columnIndex);
    const p: FilterPredicate = entry.predicate;
    const str = isFactor(col) ? `as.character(${x})` : x;
    switch (p.kind) {
        case 'isEmpty': return { code: `is.na(${x})`, trueOnNA: true };
        case 'isNotEmpty': return { code: `!is.na(${x})`, trueOnNA: false };
        case 'bool': return { code: p.value ? x : `!${x}`, trueOnNA: false };
        case 'numCompare': {
            const op = p.op === '=' ? '==' : p.op;
            return { code: `${x} ${op} ${rNumber(p.value)}`, trueOnNA: false };
        }
        case 'numBetween': {
            const hiIncl = p.upperInclusive ?? p.inclusive;
            const lo = `${x} ${p.inclusive ? '>=' : '>'} ${rNumber(p.lo)}`;
            const hi = `${x} ${hiIncl ? '<=' : '<'} ${rNumber(p.hi)}`;
            return { code: `${lo} & ${hi}`, trueOnNA: false };
        }
        case 'numNotBetween': {
            const lo = `${x} ${p.inclusive ? '<' : '<='} ${rNumber(p.lo)}`;
            const hi = `${x} ${p.inclusive ? '>' : '>='} ${rNumber(p.hi)}`;
            return { code: `(${lo} | ${hi})`, trueOnNA: false };
        }
        case 'strCompare': {
            const op = p.op === '=' ? '==' : '!=';
            return p.caseSensitive
                ? { code: `${str} ${op} ${rString(p.value)}`, trueOnNA: false }
                : { code: `tolower(${str}) ${op} ${rString(p.value.toLowerCase())}`, trueOnNA: false };
        }
        case 'strContains': {
            const hay = p.caseSensitive ? str : `tolower(${str})`;
            const needle = p.caseSensitive ? p.value : p.value.toLowerCase();
            const g = `grepl(${rString(needle)}, ${hay}, fixed = TRUE)`;
            return p.negate ? { code: `!${g}`, trueOnNA: true } : { code: g, trueOnNA: false };
        }
        case 'strStartsWith':
        case 'strEndsWith': {
            const fn = p.kind === 'strStartsWith' ? 'startsWith' : 'endsWith';
            const hay = p.caseSensitive ? `as.character(${x})` : `tolower(${str})`;
            const needle = p.caseSensitive ? p.value : p.value.toLowerCase();
            return { code: `${fn}(${hay}, ${rString(needle)})`, trueOnNA: false };
        }
        case 'strRegex':
            return {
                code: `grepl(${rString(p.pattern)}, ${str}, perl = TRUE${p.caseSensitive ? '' : ', ignore.case = TRUE'})`,
                trueOnNA: false,
            };
        case 'dateCompare':
        case 'dateBetween':
        case 'dateNotBetween':
            return dateCode(col, x, p);
        case 'setIn':
        case 'setNotIn': {
            const set = setCode(ctx, entry.columnIndex, p.values, labelsOn);
            if (!set) return null;
            return p.kind === 'setIn'
                ? { code: set, trueOnNA: false }
                : { code: `!${set}`, trueOnNA: true };
        }
    }
}

/** `<x> %in% c(...)` for a set filter, routed as `filter.ts` routes it. */
function setCode(ctx: Ctx, ci: number, values: readonly (string | number)[], labelsOn: boolean): string | null {
    const col = ctx.input.columns[ci];
    const x = valueRef(ctx, ci);
    const t = col.arrowType;
    if (isFactor(col)) {
        if (labelsOn) return `${x} %in% ${rVector(values.map(v => rString(String(v))))}`;
        // Labels off: the engine matches 0-based dictionary codes; R codes
        // are 1-based.
        const codes = values.map(v => Number(v)).filter(Number.isInteger).map(c => rNumber(c + 1));
        return `as.integer(${x}) %in% ${codes.length > 0 ? rVector(codes) : 'integer(0)'}`;
    }
    if (col.valueLabels && isNumericType(t)) {
        const nums = values.map(Number).filter(v => !Number.isNaN(v)).map(rNumber);
        return `${x} %in% ${nums.length > 0 ? rVector(nums) : 'numeric(0)'}`;
    }
    if (col.valueLabels && labelsOn) {
        return `${labelled(ctx, ci)} %in% ${rVector(values.map(v => rString(String(v))))}`;
    }
    if (t === 'Utf8' || t === 'LargeUtf8') {
        return `${x} %in% ${rVector(values.map(v => rString(String(v))))}`;
    }
    if (isNumericType(t)) {
        const nums = values.map(v => Number(v));
        if (nums.some(Number.isNaN)) return null;
        return `${x} %in% ${rVector(nums.map(rNumber))}`;
    }
    if (t === 'Bool') {
        const want = values.map(v => String(v).toLowerCase());
        if (want.some(v => v !== 'true' && v !== 'false')) return null;
        return `${x} %in% ${rVector(want.map(v => (v === 'true' ? 'TRUE' : 'FALSE')))}`;
    }
    return null;
}

/** Date and date-time comparisons, in the instants the engine compares
 *  (`Date.parse` of the typed ISO string). */
function dateCode(
    col: ColumnSchema,
    x: string,
    p: Extract<FilterPredicate, { kind: 'dateCompare' | 'dateBetween' | 'dateNotBetween' }>,
): { code: string; trueOnNA: boolean } {
    const isTs = col.arrowType.startsWith('Timestamp');
    const isos = p.kind === 'dateCompare' ? [p.value] : [p.lo, p.hi];
    const ms = isos.map(s => Date.parse(s));
    // An unparseable bound matches nothing in the engine.
    if (ms.some(v => !Number.isFinite(v))) return { code: 'FALSE', trueOnNA: false };
    const wholeDays = !isTs && ms.every(v => v % 86_400_000 === 0);
    const lhs = isTs || wholeDays ? x : `as.POSIXct(${x})`;
    const lit = (v: number): string => {
        const iso = new Date(v).toISOString();
        if (wholeDays) return `as.Date(${rString(iso.slice(0, 10))})`;
        const frac = iso.slice(19, 23) === '.000' ? '' : iso.slice(19, 23);
        return `as.POSIXct(${rString(`${iso.slice(0, 10)} ${iso.slice(11, 19)}${frac}`)}, tz = "UTC")`;
    };
    if (p.kind === 'dateCompare') {
        const op = p.op === '=' ? '==' : p.op;
        return { code: `${lhs} ${op} ${lit(ms[0])}`, trueOnNA: false };
    }
    const [lo, hi] = [lit(ms[0]), lit(ms[1])];
    if (p.kind === 'dateBetween') {
        return {
            code: p.inclusive
                ? `${lhs} >= ${lo} & ${lhs} <= ${hi}`
                : `${lhs} > ${lo} & ${lhs} < ${hi}`,
            trueOnNA: false,
        };
    }
    return {
        code: p.inclusive
            ? `(${lhs} < ${lo} | ${lhs} > ${hi})`
            : `(${lhs} <= ${lo} | ${lhs} >= ${hi})`,
        trueOnNA: false,
    };
}

/** One entry's full condition, missing-value semantics included. */
function entryCode(ctx: Ctx, entry: FilterEntry, labelsOn: boolean): string | null {
    const pred = predicateCode(ctx, entry, labelsOn);
    if (!pred) return null;
    const kind = entry.predicate.kind;
    if (kind === 'isEmpty' || kind === 'isNotEmpty') return pred.code;
    const x = colRef(ctx, entry.columnIndex);
    if (entry.includeMissing) return `is.na(${x}) | ${pred.code}`;
    if (pred.trueOnNA) return `!is.na(${x}) & ${pred.code}`;
    return pred.code;
}

type SortTerm = {
    /** The key expression. */
    expr: string;
    desc: boolean;
    /** A character key whose order comes from the string order (dplyr's
     *  `.locale`, base R's radix C order). */
    character: boolean;
    /** A bare column name (data.table's unary minus needs one for
     *  character keys). */
    bare: boolean;
};

function sortTerms(ctx: Ctx): SortTerm[] {
    const { sort, columns } = ctx.input;
    const order: StringOrder = sort.stringOrder ?? 'natural';
    const labelsOn = sort.labelsOnWhenSorted;
    const terms: SortTerm[] = [];
    for (const key of sort.keys) {
        const col = columns[key.columnIndex];
        if (!col) continue;
        const x = valueRef(ctx, key.columnIndex);
        const desc = key.direction === 'desc';
        const kind = keyKind(col, { labelsOn });
        let text: string | undefined;
        switch (kind) {
            case 'number':
            case 'int64':
            case 'uint64':
            case 'timestamp':
            case 'dictCode':
                terms.push({ expr: x, desc, character: false, bare: true });
                // dplyr and base R tie NaN with NA; the viewer puts NaN
                // first. data.table already does.
                if (col.arrowType.startsWith('Float') && ctx.flavor !== 'data.table'
                    && !ctx.input.noNaN?.(key.columnIndex)) {
                    terms.push({ expr: `is.na(${x}) & !is.nan(${x})`, desc: false, character: false, bare: false });
                }
                continue;
            case 'dictLabel':
                text = `as.character(${x})`;
                break;
            case 'valueLabel':
                text = labelled(ctx, key.columnIndex);
                break;
            case 'string': {
                const tag = col.typeTag;
                if (!col.isRowname && tag !== undefined && tag !== '<chr>' && tag !== '<chr+lbl>') {
                    ctx.skipped.push(`sort by ${col.name} (${tag} values sort as text in the viewer)`);
                    continue;
                }
                text = x;
                break;
            }
        }
        const bare = text === colRef(ctx, key.columnIndex) && !(col.isRowname && !ctx.rownamesAsColumn);
        if (order === 'natural') {
            ctx.needs.add('stringr');
            terms.push({
                expr: `stringr::str_rank(${text}, locale = ${rString(ctx.input.locale)}, numeric = TRUE)`,
                desc, character: false, bare: false,
            });
        } else if (order === 'locale' && ctx.flavor !== 'dplyr') {
            ctx.needs.add('stringr');
            terms.push({
                expr: `stringr::str_rank(${text}, locale = ${rString(ctx.input.locale)})`,
                desc, character: false, bare: false,
            });
        } else if (order === 'c' && ctx.flavor === 'data.table' && !bare) {
            // data.table orders strings by code point, but unary minus
            // needs a bare column; rank the expression instead.
            terms.push({
                expr: `data.table::frank(${text}, ties.method = "min", na.last = "keep")`,
                desc, character: false, bare: false,
            });
        } else {
            if (order === 'locale') ctx.needs.add('stringi');
            terms.push({ expr: text, desc, character: true, bare });
        }
    }
    return terms;
}

function pipeSource(expr: string): string {
    const e = expr.trim();
    // A name, a namespaced name, an `$`/`@` access, or a call can head a
    // pipe; anything else (operators) needs parentheses.
    if (/^[A-Za-z.][\w.]*(::[A-Za-z.][\w.]*)?((\$|@)[A-Za-z.][\w.]*)*$/.test(e)) return e;
    if (/^[A-Za-z.][\w.:]*\(/.test(e) && balancedCall(e)) return e;
    return `(${e})`;
}

/** True when `e` is a single call: the parenthesis opened by the call
 *  closes at the last character. */
function balancedCall(e: string): boolean {
    let depth = 0;
    let quote: string | null = null;
    const open = e.indexOf('(');
    for (let i = open; i < e.length; i++) {
        const ch = e[i];
        if (quote) {
            if (ch === '\\') { i++; continue; }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') {
            depth--;
            if (depth === 0) return i === e.length - 1;
        }
    }
    return false;
}

/** Hidden columns that exist in the R object, as names or (with
 *  duplicates or empty names) 1-based positions. */
function hiddenSelection(ctx: Ctx): { names?: string[]; positions?: number[] } {
    const { columns, hiddenColumns } = ctx.input;
    const hidden = [...new Set(hiddenColumns)]
        .filter(ci => columns[ci] && (!columns[ci].isRowname || ctx.rownamesAsColumn))
        .sort((a, b) => a - b);
    if (hidden.length === 0) return {};
    const counts = new Map<string, number>();
    for (const c of columns) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
    if (hidden.every(ci => columns[ci].name !== '' && counts.get(columns[ci].name) === 1)) {
        return { names: hidden.map(ci => columns[ci].name) };
    }
    const position = (ci: number): number => {
        let p = ci + 1;
        if (!ctx.rownamesAsColumn) {
            for (let j = 0; j < ci; j++) if (columns[j].isRowname) p--;
        }
        return p;
    };
    return { positions: hidden.map(position) };
}

function header(ctx: Ctx, extra: string[]): string[] {
    const req: string[] = [];
    if (ctx.flavor === 'dplyr') req.push('R >= 4.1 (|>)', 'dplyr >= 1.1.0');
    if (ctx.flavor === 'data.table') req.push('data.table');
    if (ctx.needs.has('tibble')) req.push('tibble');
    if (ctx.needs.has('stringr')) req.push('stringr >= 1.5.0 (str_rank)');
    if (ctx.needs.has('stringi')) req.push('stringi (a .locale other than "C")');
    const lines = [`# ${ctx.input.expression.split('\n')[0]} as shown in Raven's data viewer`];
    if (req.length > 0) lines.push(`# Requires ${req.join(', ')}`);
    const order = ctx.input.sort.stringOrder ?? 'natural';
    if (ctx.input.sort.keys.length > 0 && order !== 'c' && (ctx.needs.has('stringr') || ctx.needs.has('stringi'))) {
        lines.push('# String order uses ICU collation, as the viewer does; R and VS Code can ship',
            '# different ICU versions, which may order rare characters differently.');
    }
    for (const s of ctx.skipped) lines.push(`# Not translated: ${s}`);
    lines.push(...extra);
    if (ctx.needs.has('labelHelper')) lines.push('', ...LABEL_HELPER);
    return lines;
}

/** The R code for the current view, or why there is none. */
export function generateRCode(input: CodeInput, flavor: CodeFlavor): CodeResult {
    const kind = input.sourceKind ?? 'data.frame';
    if (kind !== 'data.frame' && kind !== 'matrix') {
        return { error: `Copy as R code works for data frames and matrices; this view shows a ${kind}.` };
    }
    if (!input.expression.trim()) {
        return { error: 'The expression passed to View() is unknown; run View() again.' };
    }
    const entries = input.filter.entries.filter(e => e.enabled && input.columns[e.columnIndex]);
    const usesRownames = [
        ...entries.map(e => e.columnIndex),
        ...input.sort.keys.map(k => k.columnIndex),
    ].some(ci => input.columns[ci]?.isRowname);
    const ctx: Ctx = {
        flavor,
        input,
        frame: 'dat',
        rownamesAsColumn: usesRownames && flavor !== 'base',
        needs: new Set(),
        skipped: [],
    };
    const src0 = kind === 'matrix' ? `as.data.frame(${input.expression.trim()})` : input.expression.trim();
    // Base R names the frame for rownames(): the expression itself when
    // it is a plain name, else `dat`.
    const simple = /^[A-Za-z.][\w.]*$/.test(src0);
    if (flavor === 'base' && simple) ctx.frame = src0;
    const rownameName = input.columns.find(c => c.isRowname)?.name ?? 'rowname';

    const labelsOn = input.filter.labelsOnWhenFiltered;
    const conditions: string[] = [];
    for (const e of entries) {
        const code = entryCode(ctx, e, labelsOn);
        if (code === null) {
            ctx.skipped.push(`filter on ${input.columns[e.columnIndex].name} (${e.predicate.kind})`);
        } else {
            conditions.push(code);
        }
    }
    const terms = sortTerms(ctx);
    const hidden = hiddenSelection(ctx);
    const hiddenNames = hidden.names?.map(n => rName(n));
    const order = input.sort.stringOrder ?? 'natural';

    if (flavor === 'dplyr') {
        const body: string[] = [];
        let head = pipeSource(src0);
        if (ctx.rownamesAsColumn) {
            ctx.needs.add('tibble');
            body.push(`tibble::rownames_to_column(${rString(rownameName)})`);
        }
        if (conditions.length > 0) {
            body.push(conditions.length === 1
                ? `filter(${conditions[0]})`
                : `filter(\n    ${conditions.join(',\n    ')}\n  )`);
        }
        if (terms.length > 0) {
            const args = terms.map(t => (t.desc ? `desc(${t.expr})` : t.expr));
            if (terms.some(t => t.character)) args.push(`.locale = ${rString(order === 'c' ? 'C' : input.locale)}`);
            body.push(`arrange(${args.join(', ')})`);
        }
        if (hiddenNames) body.push(`select(-${rVector(hiddenNames)})`);
        else if (hidden.positions) body.push(`select(-${rVector(hidden.positions.map(String))})`);
        if (body.length === 0) head = src0;
        const lines = header(ctx, ['', 'library(dplyr)', '']);
        lines.push(body.length === 0 ? head : `${head} |>\n  ${body.join(' |>\n  ')}`);
        return { code: lines.join('\n') + '\n' };
    }

    if (flavor === 'data.table') {
        const setup = ctx.rownamesAsColumn
            ? `dt <- as.data.table(${src0}, keep.rownames = ${rString(rownameName)})`
            : `dt <- as.data.table(${src0})`;
        const steps: string[] = [setup];
        let out = 'dt';
        if (conditions.length > 0) {
            steps.push(`out <- dt[${conditions.map(c => (/ \| /.test(c) && !c.startsWith('(') ? `(${c})` : c)).join(' & ')}]`);
            out = 'out';
        }
        if (terms.length > 0) {
            const args = terms.map(t => (t.desc ? `-${t.expr}` : t.expr));
            steps.push(`out <- ${out}[order(${args.join(', ')})]`);
            out = 'out';
        }
        if (hiddenNames) {
            steps.push(`out <- ${out}[, !${rVector(hidden.names!.map(rString))}]`);
            out = 'out';
        } else if (hidden.positions) {
            steps.push(`out <- ${out}[, -${rVector(hidden.positions.map(String))}]`);
            out = 'out';
        }
        if (out === 'dt') steps.push('out <- dt');
        const lines = header(ctx, ['', 'library(data.table)', '']);
        lines.push(...steps);
        return { code: lines.join('\n') + '\n' };
    }

    // Base R.
    const dat = ctx.frame;
    const conds = conditions;
    const steps: string[] = [];
    if (!simple) steps.push(`dat <- ${src0}`);
    let out = dat;
    if (conds.length > 0) {
        const joined = conds.map(c => (/ \| /.test(c) && !c.startsWith('(') ? `(${c})` : c)).join(' & ');
        steps.push(`out <- ${dat}[which(with(${dat}, ${joined})), , drop = FALSE]`);
        out = 'out';
    }
    if (terms.length > 0) {
        // Sort keys are evaluated in the filtered frame.
        const sortTermsOut = sortTerms({ ...ctx, frame: out, skipped: [] });
        const args = sortTermsOut.map(t => t.expr);
        const decreasing = sortTermsOut.map(t => (t.desc ? 'TRUE' : 'FALSE'));
        const dec = decreasing.every(d => d === 'FALSE') ? ''
            : decreasing.every(d => d === 'TRUE') ? ', decreasing = TRUE'
                : `, decreasing = c(${decreasing.join(', ')})`;
        steps.push(`out <- ${out}[with(${out}, order(${args.join(', ')}${dec}, method = "radix")), , drop = FALSE]`);
        out = 'out';
    }
    if (hidden.names) {
        steps.push(`out <- ${out}[, setdiff(names(${out}), ${rVector(hidden.names.map(rString))}), drop = FALSE]`);
        out = 'out';
    } else if (hidden.positions) {
        steps.push(`out <- ${out}[, -${rVector(hidden.positions.map(String))}, drop = FALSE]`);
        out = 'out';
    }
    if (out !== 'out') steps.push(`out <- ${out}`);
    const lines = header(ctx, ['']);
    lines.push(...steps);
    return { code: lines.join('\n') + '\n' };
}
