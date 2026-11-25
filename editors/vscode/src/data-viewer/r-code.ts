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
 *     `numBetween` honors `upperInclusive`. On an integer64 column the
 *     numeric predicates compare integer64 with integer64 (`int64Code`),
 *     as the engine compares the exact integers.
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
 *   - **Columns** are referenced by name only when the name is unique
 *     and nonempty in the R object; otherwise by position (`dat[[3]]`),
 *     since a name would read the first column with it. dplyr can't
 *     filter or sort such a frame, nor read a `...`/`..1` column or
 *     select() around one it keeps, so that flavor refuses those views. Every `[` in the base R flavor is one
 *     `[.data.table` also reads as base R does (row indices, literal
 *     column positions), so it reproduces the view on a data.table too;
 *     the data.table flavor parenthesizes an `i` that is a lone symbol or
 *     starts with `!` (calling-scope lookup, not-join).
 *
 * Text from the data (column names, values, labels) is never code: in
 * comments it goes through `rComment()`,
 * in code through `rString()` or `rName()`, which escape every line
 * terminator, control and invisible format character. A name with no
 * safe symbol spelling is read as `x[["name"]]` (or `.data[["name"]]`).
 * The `View()` expression is the user's own R code: it is run again as
 * the code's source (so `View(f(d))` calls `f()` again), and only its
 * copy in the header comment goes through `rComment()`.
 *
 * A filter or sort the generator can't express faithfully is left out
 * and named in a comment, never approximated silently.
 */
import type { ColumnSchema } from './arrow-reader';
import type { FilterEntry, FilterPredicate, FilterState, SortState, StringOrder } from './messages';
import { keyKind } from './sort';
import {
    dateBoundMs, int64Intervals, int64SetKey, isInt64Type, isNumberLike, numBoundValue, type IntInterval,
} from './filter';

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

/**
 * Characters that must never appear raw in the copied code: C0/C1
 * controls and DEL; the line and paragraph separators (U+2028/9, which
 * editors may turn into line breaks) and NEL (U+0085); and invisible
 * format characters, bidi controls included, that can make text read
 * differently from how it parses ("Trojan Source"). The tag characters
 * (U+E0000-U+E007F, an invisible copy of ASCII) lie outside the BMP, so
 * the class matches code points (`u`) and callers test whole characters.
 */
const UNSAFE_CHAR = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\u{e0000}-\u{e007f}]/u;
const UNSAFE_CHARS = new RegExp(UNSAFE_CHAR.source, 'gu');

/** Thrown when data-derived text has no R spelling (NUL, which R strings
 *  can't hold); the caller leaves the piece out with a "Not translated"
 *  comment, or refuses the whole export. */
class Unrepresentable extends Error {}

/** A code point as an R escape: `\uNNNN`, or `\UNNNNNNNN` past the BMP. */
function uEscape(c: number): string {
    return c > 0xffff ? '\\U' + c.toString(16).padStart(8, '0') : '\\u' + c.toString(16).padStart(4, '0');
}

/**
 * Data-derived text (a column name, a value, the `View()` expression) as
 * the body of a `#` comment: one line, nothing invisible. Every unsafe
 * character, line terminators included, is written as a visible escape,
 * so no part of it can end the comment and run as code.
 */
export function rComment(s: string): string {
    return s.replace(UNSAFE_CHARS, ch => {
        if (ch === '\n') return '\\n';
        if (ch === '\r') return '\\r';
        if (ch === '\t') return '\\t';
        return uEscape(ch.codePointAt(0)!);
    });
}

/** `name` is spelled as a bare or backticked R symbol. Backticks process
 *  `\\`, `` \` `` and `\xNN` escapes but not `\u`, so a name holding an
 *  unsafe non-ASCII character (or NUL) has no safe symbol spelling; nor
 *  do `...` and `..1`, which stay the dots symbols even backticked. */
export function rNameRepresentable(name: string): boolean {
    if (name === '...' || /^\.\.[0-9]+$/.test(name)) return false;
    for (const ch of name) {
        const c = ch.codePointAt(0)!;
        if (c === 0) return false;
        if (c >= 0x80 && UNSAFE_CHAR.test(ch)) return false;
    }
    return name !== '';
}

/** `name` as an R symbol, backticked when it isn't syntactic. Throws
 *  `Unrepresentable` unless `rNameRepresentable(name)`; callers that may
 *  see such names reach the column as `x[["name"]]` instead. */
export function rName(name: string): string {
    if (!rNameRepresentable(name)) throw new Unrepresentable(`column name ${rComment(name)}`);
    if (SYNTACTIC.test(name) && !RESERVED.has(name)) return name;
    let out = '`';
    for (const ch of name) {
        const c = ch.charCodeAt(0);
        if (ch === '\\') out += '\\\\';
        else if (ch === '`') out += '\\`';
        else if (c < 0x20 || c === 0x7f) out += '\\x' + c.toString(16).padStart(2, '0');
        else out += ch;
    }
    return out + '`';
}

/** A double-quoted R string literal. Non-ASCII text stays literal (R
 *  reads UTF-8 source); control, separator and invisible format
 *  characters are escaped (as `\uNNNN` or `\UNNNNNNNN`). Throws `Unrepresentable` on NUL. */
export function rString(s: string): string {
    let out = '"';
    for (const ch of s) {
        const c = ch.codePointAt(0)!;
        if (c === 0) throw new Unrepresentable('a NUL character');
        if (ch === '\\') out += '\\\\';
        else if (ch === '"') out += '\\"';
        else if (ch === '\n') out += '\\n';
        else if (ch === '\r') out += '\\r';
        else if (ch === '\t') out += '\\t';
        // `\u` for every other escape: R refuses a literal mixing `\x`
        // and `\u` escapes.
        else if (UNSAFE_CHAR.test(ch)) out += uEscape(c);
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
    '  key <- if (inherits(x, "integer64")) bit64::as.character.integer64(x) else as.character(unclass(x))',
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
    /** The frame a column reference reads from: base R's frame inside
     *  `with()` (row names, positional references), data.table's `dt` or
     *  `out`. */
    frame: string;
    /** True once a rowname column is materialized as a real column. */
    rownamesAsColumn: boolean;
    needs: Set<'stringr' | 'stringi' | 'labelHelper' | 'tibble' | 'bit64'>;
    skipped: string[];
    /** Why the last untranslatable filter is left out, when known. */
    skipReason?: string;
    /** Names the R object (with a materialized row name column) has more
     *  than once, or the empty name: a reference by name would read
     *  another column, so these are reached by position. */
    ambiguous: Set<string>;
};

/** Column `ci`'s 1-based position in the R object the code indexes:
 *  row names count only once materialized as a column. */
function columnPosition(ctx: Ctx, ci: number): number {
    const { columns } = ctx.input;
    let p = ci + 1;
    if (!ctx.rownamesAsColumn) {
        for (let j = 0; j < ci; j++) if (columns[j].isRowname) p--;
    }
    return p;
}

/** The names of the R object's columns, in order. */
function objectNames(input: CodeInput, rownamesAsColumn: boolean, rownameName: string): string[] {
    return input.columns
        .filter(c => !c.isRowname || rownamesAsColumn)
        .map(c => (c.isRowname ? rownameName : c.name));
}

function ambiguousNames(names: readonly string[]): Set<string> {
    const counts = new Map<string, number>();
    for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
    return new Set(names.filter(n => n === '' || counts.get(n)! > 1));
}

function colRef(ctx: Ctx, ci: number): string {
    const col = ctx.input.columns[ci];
    if (col.isRowname && !ctx.rownamesAsColumn) return `rownames(${ctx.frame})`;
    const name = col.isRowname ? rownameNameOf(ctx.input) : col.name;
    if (ctx.ambiguous.has(name)) {
        // dplyr refuses such frames up front (generateRCode).
        return `${ctx.frame}[[${columnPosition(ctx, ci)}]]`;
    }
    if (!rNameRepresentable(name)) {
        return ctx.flavor === 'dplyr' ? `.data[[${rString(name)}]]` : `${ctx.frame}[[${rString(name)}]]`;
    }
    return rName(name);
}

/** True when column `ci` is referenced by a bare (possibly backticked)
 *  name, which data.table's unary minus needs for character keys. */
function isBareRef(ctx: Ctx, ci: number): boolean {
    const col = ctx.input.columns[ci];
    if (col.isRowname && !ctx.rownamesAsColumn) return false;
    const name = col.isRowname ? rownameNameOf(ctx.input) : col.name;
    return !ctx.ambiguous.has(name) && rNameRepresentable(name);
}

function rownameNameOf(input: CodeInput): string {
    return input.columns.find(c => c.isRowname)?.name ?? 'rowname';
}

/** A column's values for comparison: value-labelled vectors are
 *  unclassed, because `%in%` (via `mtfrm()`) and some comparisons refuse
 *  `haven_labelled`. */
function valueRef(ctx: Ctx, ci: number): string {
    const col = ctx.input.columns[ci];
    const x = colRef(ctx, ci);
    // An integer64 with a "labels" attribute is no haven_labelled (haven
    // refuses integer64); unclass() would turn it into raw doubles.
    return col.valueLabels && !isFactor(col) && !isInt64(col) ? `unclass(${x})` : x;
}

/** An Int64/UInt64 column: a `bit64::integer64` in R. */
function isInt64(col: ColumnSchema): boolean {
    return isInt64Type(col.arrowType);
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
    if (p.kind === 'numCompare' || p.kind === 'numBetween' || p.kind === 'numNotBetween') {
        if (isInt64(col)) return { code: int64Code(ctx, entry.columnIndex, x, p), trueOnNA: false };
        // A bound that isn't a number (an Inf saved as null) matches
        // nothing in the viewer.
        const bounds = p.kind === 'numCompare'
            ? [numBoundValue(p.value)]
            : [numBoundValue(p.lo), numBoundValue(p.hi)];
        if (bounds.some(v => v === undefined)) return { code: 'FALSE', trueOnNA: false };
        const [b0, b1] = bounds.map(v => rNumber(v!));
        if (p.kind === 'numCompare') {
            return { code: `${x} ${p.op === '=' ? '==' : p.op} ${b0}`, trueOnNA: false };
        }
        if (p.kind === 'numBetween') {
            const hiIncl = p.upperInclusive ?? p.inclusive;
            return { code: `${x} ${p.inclusive ? '>=' : '>'} ${b0} & ${x} ${hiIncl ? '<=' : '<'} ${b1}`, trueOnNA: false };
        }
        return { code: `(${x} ${p.inclusive ? '<' : '<='} ${b0} | ${x} ${p.inclusive ? '>' : '>='} ${b1})`, trueOnNA: false };
    }
    switch (p.kind) {
        case 'isEmpty': return { code: naCode(ctx, entry.columnIndex, x), trueOnNA: true };
        case 'isNotEmpty': return { code: `!${naCode(ctx, entry.columnIndex, x)}`, trueOnNA: false };
        case 'bool': return { code: p.value ? x : `!${x}`, trueOnNA: false };
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
        case 'strRegex': {
            // Translated only where R selects the same strings as the
            // viewer's JavaScript RegExp; otherwise "Not translated".
            const t = translateRegex(p.pattern, p.caseSensitive);
            if ('reason' in t) {
                ctx.skipReason = t.reason;
                return null;
            }
            return {
                code: `grepl(${rString(t.pcre)}, ${str}, perl = TRUE${p.caseSensitive ? '' : ', ignore.case = TRUE'})`,
                trueOnNA: false,
            };
        }
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

/** bit64's largest magnitude: -2^63 is its NA, and `as.integer64()` turns
 *  anything further out into NA. */
const R_INT64_MAX = (1n << 63n) - 1n;

/**
 * A numeric predicate on an integer64 column, exact as the viewer
 * evaluates it (`int64Intervals`): each bound becomes an integer64
 * literal, so no side is rounded to double. A plain `x >= 2.5` would not
 * do: bit64 truncates a fractional bound and turns an infinite one into
 * NA, and a double literal can't hold every 64-bit integer. So the bound
 * is moved to the integer that keeps the comparison's meaning
 * (`x >= 2.5` ⇔ `x >= 3`), and a bound no integer64 can reach folds to
 * "every non-missing row" or `FALSE`.
 *
 * The comparison operators dispatch to bit64 because evaluating the
 * `bit64::as.integer64()` operand loads it first; bit64 doesn't export
 * the methods to call by name.
 */
function int64Code(
    ctx: Ctx, ci: number, x: string,
    p: Extract<FilterPredicate, { kind: 'numCompare' | 'numBetween' | 'numNotBetween' }>,
): string {
    ctx.needs.add('bit64');
    const lit = (v: bigint): string => `bit64::as.integer64(${rString(v.toString())})`;
    const all = `!${naCode(ctx, ci, x)}`;
    // Clamp to the values an integer64 can hold.
    const parts: IntInterval[] = [];
    for (const iv of int64Intervals(p)) {
        if ((iv.lo !== undefined && iv.lo > R_INT64_MAX) || (iv.hi !== undefined && iv.hi < -R_INT64_MAX)) continue;
        const lo = iv.lo !== undefined && iv.lo > -R_INT64_MAX ? iv.lo : undefined;
        const hi = iv.hi !== undefined && iv.hi < R_INT64_MAX ? iv.hi : undefined;
        if (lo === undefined && hi === undefined) return all;
        parts.push({ lo, hi });
    }
    if (parts.length === 0) return 'FALSE';
    // `x != v` reads better than the two rays around `v`.
    if (parts.length === 2 && parts[0].lo === undefined && parts[1].hi === undefined
        && parts[0].hi !== undefined && parts[1].lo !== undefined && parts[1].lo - parts[0].hi === 2n) {
        return `${x} != ${lit(parts[0].hi + 1n)}`;
    }
    const one = ({ lo, hi }: IntInterval): string => {
        if (lo !== undefined && hi !== undefined) {
            return lo === hi ? `${x} == ${lit(lo)}` : `${x} >= ${lit(lo)} & ${x} <= ${lit(hi)}`;
        }
        return lo !== undefined ? `${x} >= ${lit(lo)}` : `${x} <= ${lit(hi!)}`;
    };
    return parts.length === 1 ? one(parts[0]) : `(${parts.map(one).join(' | ')})`;
}

/**
 * The viewer's regex filter (a JavaScript `RegExp` without the `u` flag,
 * `i` when case-insensitive) as a PCRE pattern for `grepl(perl = TRUE)`
 * that selects the same strings, or why there is none. The two engines
 * read the shared syntax alike but differ in what some of it matches, so
 * the pattern is rewritten where that is exact and refused where not:
 *   - `.` excludes CR, LF, U+2028 and U+2029 in JS (PCRE: only LF), so it
 *     becomes that class; `$` is the end of input in JS (PCRE: also
 *     before a final LF), so it becomes `\z`; `\s`/`\S` cover Unicode
 *     spaces in JS (PCRE: ASCII), so they become JS's set.
 *   - JS matches UTF-16 code units, PCRE (in R's UTF-8 mode) code points,
 *     so on a character outside the BMP (an emoji) the number of
 *     characters an atom consumes differs. Atoms that can match a lone
 *     surrogate (`.`, negated classes, `\S`, `\W`, `\D`) are allowed only
 *     under `*`, or under one `+` outside any quantified group, where the
 *     count can't change the outcome; a non-BMP character in the pattern,
 *     or a class range across the surrogates, is refused.
 *   - Case-insensitive matching folds a few characters in PCRE (Unicode
 *     simple case folding) that JS's `toUpperCase` canonicalization keeps
 *     apart, such as the Kelvin sign and `k` (`FOLD_GROUPS`). An atom
 *     whose fold group is one of these is guarded so that, on those
 *     characters only, it matches exactly what JS matches.
 * Everything outside the shared subset (escapes the engines read
 * differently, POSIX classes, inline flags, back-references, an invalid
 * pattern) is refused.
 */
export function translateRegex(pattern: string, caseSensitive: boolean): { pcre: string } | { reason: string } {
    const flags = caseSensitive ? '' : 'i';
    try {
        new RegExp(pattern, flags);
    } catch {
        return { reason: 'invalid pattern' };
    }
    const refuse = (reason: string) => ({ reason });
    const nonBmp = 'matches characters outside the Basic Multilingual Plane (such as emoji) differently in R';
    let out = '';
    let plusCount = 0;
    /** Per open group: does it hold a `+`-quantified any-unit atom? */
    const groups: boolean[] = [];
    let i = 0;
    const n = pattern.length;
    // PCRE compiles a bounded repeat of a group as that many copies, and
    // R's build refuses a compiled pattern past 64 KiB. `sizes` estimates
    // the expanded size per open group (translated text length, groups
    // multiplied by their bound); past `MAX_EXPANDED` the pattern is
    // refused.
    const sizes: number[] = [0];
    let last = { size: 0, group: false };
    const grow = (k: number) => { sizes[sizes.length - 1] += k; };
    /** Emit an atom, check the quantifier after it, and copy that. */
    const atom = (pcre: string, anyUnit: boolean): string | null => {
        const q = pattern[i];
        if (anyUnit) {
            if (q === '*') { /* zero minimum: safe */ }
            else if (q === '+' && plusCount === 0) {
                plusCount++;
                if (groups.length > 0) groups[groups.length - 1] = true;
            } else return nonBmp;
        }
        out += pcre;
        // A class compiles to a 32-byte bitmap and more; count it high.
        const size = pcre.length + CLASS_COST * (pcre.split('[').length - 1);
        grow(size);
        last = { size, group: pcre.startsWith('(') };
        return null;
    };
    while (i < n) {
        const c = pattern[i];
        const code = c.charCodeAt(0);
        if (code >= 0xd800 && code <= 0xdfff) return refuse(nonBmp);
        if (c === '\\') {
            const e = pattern[i + 1];
            if (e === undefined || !/[dDwWsSbBntrf.*+?()[\]{}|^$\\/\-]/.test(e)) {
                return refuse(`the escape \\${e ?? ''} means something else in R`);
            }
            i += 2;
            let err: string | null;
            if (e === 's') err = atom(`[${JS_SPACE}]`, false);
            else if (e === 'S') err = atom(`[^${JS_SPACE}]`, true);
            else err = atom(`\\${e}`, e === 'W' || e === 'D');
            if (err) return refuse(err);
            continue;
        }
        if (c === '[') {
            const cls = readClass(pattern, i);
            if ('reason' in cls) return refuse(cls.reason);
            i = cls.end;
            const err = atom(caseSensitive ? cls.pcre : foldGuard(cls.js, cls.inner, cls.pcre, false), cls.anyUnit);
            if (err) return refuse(err);
            continue;
        }
        if (c === '.') {
            i++;
            const err = atom(JS_DOT, true);
            if (err) return refuse(err);
            continue;
        }
        if (c === '$') { out += '\\z'; grow(2); last = { size: 0, group: false }; i++; continue; }
        if (c === '(') {
            const named = /^\(\?<([A-Za-z_$][\w$]*)>/.exec(pattern.slice(i));
            const head = named ? named[0] : /^\((\?(:|=|!))?/.exec(pattern.slice(i))![0];
            // Lookbehind: JS allows any width, R's PCRE only bounded ones.
            if (head === '(' && pattern[i + 1] === '?') return refuse('this group syntax means something else in R');
            // A named group's name may use `$` in JS only; back-references
            // are refused, so it can be a plain group.
            out += named ? '(?:' : head;
            i += head.length;
            groups.push(false);
            sizes.push(0);
            // PCRE2's default nesting limit is 250; translation adds up
            // to two levels around an atom.
            if (groups.length > MAX_DEPTH) return refuse('the pattern nests groups too deeply for R');
            continue;
        }
        if (c === ')') {
            out += c;
            i++;
            const inner = (sizes.length > 1 ? sizes.pop()! : 0) + 4;
            grow(inner);
            last = { size: inner, group: true };
            const plusInside = groups.pop() ?? false;
            if (plusInside && /[*+?{]/.test(pattern[i] ?? '')) return refuse(nonBmp);
            if (plusInside && groups.length > 0) groups[groups.length - 1] = true;
            continue;
        }
        if (c === '{') {
            // PCRE caps repeat counts at 65535; JS has no cap.
            const bound = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(i));
            if (!bound) {
                // A literal `{` in JS; PCRE2 10.43+ reads `{,2}` and
                // `{ 2 }` as repeats, so it is escaped.
                out += '\\{';
                grow(2);
                last = { size: 2, group: false };
                i++;
                continue;
            }
            if ([bound[1], bound[2]].some(b => b !== undefined && b !== '' && Number(b) > 65535)) {
                return refuse('the repeat count is too large for R');
            }
            if (last.group) {
                const copies = bound[2] === undefined ? Number(bound[1])
                    : bound[2] === '' ? Number(bound[1]) + 1 : Math.max(Number(bound[1]), Number(bound[2]));
                grow(last.size * Math.max(copies - 1, 0));
                if (sizes.some(z => z > MAX_EXPANDED)) return refuse('the pattern is too large for R once its repeats are expanded');
            }
            out += c;
            grow(1);
            last = { size: 0, group: false };
            i++;
            continue;
        }
        if ('*+?|^}'.includes(c)) {
            out += c;
            grow(1);
            last = { size: 0, group: false };
            i++;
            continue;
        }
        // A literal character.
        i++;
        const lit = c === ']' ? '\\]' : c;
        const err = atom(caseSensitive ? lit : foldGuard(`[${classBody(c)}]`, classBody(c), lit, true), false);
        if (err) return refuse(err);
    }
    if (sizes.some(z => z > MAX_EXPANDED)) return refuse('the pattern is too large for R once its repeats are expanded');
    return { pcre: out };
}

/** Budget for `translateRegex`'s expanded-size estimate, well under the
 *  64 KiB compiled-pattern limit (estimates count source characters). */
const MAX_EXPANDED = 10_000;
/** Deepest group nesting `translateRegex` accepts (PCRE2's limit is 250). */
const MAX_DEPTH = 200;
const NON_BMP = 'matches characters outside the Basic Multilingual Plane (such as emoji) differently in R';
/** Extra estimated size per character class (see `MAX_EXPANDED`). */
const CLASS_COST = 40;

/** JS's `\s`, as the body of a PCRE class (non-ASCII spaces as literal
 *  characters, so R compiles the pattern in UTF-8 mode). */
const JS_SPACE = '\\t\\n\\x0b\\f\\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
/** JS's `.` (without the `s` flag). */
const JS_DOT = '[^\\n\\r\u2028\u2029]';

/** Case-fold groups (BMP) where PCRE's caseless matching (Unicode simple
 *  case folding) joins characters that JS's non-Unicode `i` (each
 *  character's `toUpperCase()`, unless that is several characters or
 *  turns non-ASCII into ASCII) keeps apart. Generated by comparing
 *  `/x/iu` with `/x/i` over the BMP; the round trip tests check it
 *  against R. */
const FOLD_GROUPS: readonly string[] = [
    'Kk\u212a', 'Ss\u017f', '\u00c5\u00e5\u212b', '\u00df\u1e9e', '\u0398\u03b8\u03d1\u03f4',
    '\u03a9\u03c9\u2126',
    ...Array.from({ length: 8 }, (_, k) => String.fromCharCode(0x1f80 + k, 0x1f88 + k)),
    ...Array.from({ length: 8 }, (_, k) => String.fromCharCode(0x1f90 + k, 0x1f98 + k)),
    ...Array.from({ length: 8 }, (_, k) => String.fromCharCode(0x1fa0 + k, 0x1fa8 + k)),
    '\u1fb3\u1fbc', '\u1fc3\u1fcc', '\u1ff3\u1ffc',
];

function classBody(chars: string): string {
    return Array.from(chars, ch => (/[\\\]^-]/.test(ch) ? '\\' + ch : ch)).join('');
}

/**
 * A caseless atom that matches, on the characters of `FOLD_GROUPS`,
 * exactly what JS matches. `js` is the atom as a JS class (a literal `x`
 * as `[x]`), `inner` the JS class body of its positive members.
 * When no member is in a fold group the atom is unchanged: PCRE and JS
 * then agree on every input. Otherwise inputs in the touched groups are
 * matched case-sensitively against the set JS would accept, and other
 * inputs go to the atom as before.
 */
function foldGuard(js: string, inner: string, pcre: string, literal: boolean): string {
    const innerRx = new RegExp(`^[${inner}]$`);
    const touched = FOLD_GROUPS.filter(g => Array.from(g).some(ch => innerRx.test(ch))).join('');
    if (touched === '') return pcre;
    const jsRx = new RegExp(`^${js}$`, 'i');
    const accepted = Array.from(touched).filter(ch => jsRx.test(ch)).join('');
    const rejected = Array.from(touched).filter(ch => !accepted.includes(ch)).join('');
    if (literal) {
        // A literal: PCRE accepts its whole group, JS a subset.
        return rejected === '' ? pcre : `(?:(?!(?-i:[${classBody(rejected)}]))${pcre})`;
    }
    const guard = `(?-i:[${classBody(touched)}])`;
    return accepted === ''
        ? `(?:(?!${guard})${pcre})`
        : `(?:(?=${guard})(?-i:[${classBody(accepted)}])|(?!${guard})${pcre})`;
}

/** A bracket class at `start`: its PCRE spelling, its JS spelling, its
 *  positive members (class body), the index after it, and whether it can
 *  match a lone surrogate. */
function readClass(p: string, start: number):
    { pcre: string; js: string; inner: string; end: number; anyUnit: boolean } | { reason: string } {
    let i = start + 1;
    const negated = p[i] === '^';
    if (negated) i++;
    // `[]` / `[^]`: an empty (or "any") class in JS, but in PCRE a leading
    // `]` is a literal and the class runs on.
    if (p[i] === ']') return { reason: '`[]` means something else in R' };
    let body = '';
    let lastChar: number | null = null;
    /** `\W` or `\D` in the class: in JS each matches a lone surrogate. */
    let surrogateEscape = false;
    while (i < p.length && p[i] !== ']') {
        const c = p[i];
        const code = c.charCodeAt(0);
        if (code >= 0xd800 && code <= 0xdfff) {
            return { reason: 'matches characters outside the Basic Multilingual Plane (such as emoji) differently in R' };
        }
        // POSIX classes and collating elements exist in PCRE only.
        if (c === '[' && /[:.=]/.test(p[i + 1] ?? '')) return { reason: 'POSIX bracket expressions exist only in R' };
        if (c === '\\') {
            const e = p[i + 1];
            if (e === undefined || !/[dDwWsbntrf.*+?()[\]{}|^$\\/\-]/.test(e)) {
                return { reason: `the escape \\${e ?? ''} in a class means something else in R` };
            }
            const isSet = /[dDwWs]/.test(e);
            if (e === 'W' || e === 'D') surrogateEscape = true;
            // `[\d-z]`: a union with `-` in JS, an error in PCRE.
            if (isSet && p[i + 2] === '-' && p[i + 3] !== ']') {
                return { reason: 'a range next to a class escape means something else in R' };
            }
            body += e === 's' ? JS_SPACE : '\\' + e;
            lastChar = isSet ? null : (({ n: 10, t: 9, r: 13, f: 12, b: 8 } as Record<string, number>)[e] ?? e.charCodeAt(0));
            i += 2;
            continue;
        }
        if (c === '-' && lastChar !== null && p[i + 1] !== undefined && p[i + 1] !== ']') {
            const hiRaw = p[i + 1];
            if (hiRaw === '\\') {
                const e = p[i + 2];
                if (e === undefined || /[dDwWsS]/.test(e)) return { reason: 'a range next to a class escape means something else in R' };
                if (!/[bntrf.*+?()[\]{}|^$\\/\-]/.test(e)) return { reason: `the escape \\${e} in a class means something else in R` };
                const hi = (({ n: 10, t: 9, r: 13, f: 12, b: 8 } as Record<string, number>)[e] ?? e.charCodeAt(0));
                if (lastChar <= 0xdfff && hi >= 0xd800) return { reason: NON_BMP };
                body += '-\\' + e;
                i += 3;
            } else {
                const hi = hiRaw.charCodeAt(0);
                if (hi >= 0xd800 && hi <= 0xdfff) {
                    return { reason: 'matches characters outside the Basic Multilingual Plane (such as emoji) differently in R' };
                }
                if (lastChar <= 0xdfff && hi >= 0xd800) return { reason: NON_BMP };
                body += '-' + (hiRaw === ']' ? '\\]' : hiRaw);
                i += 2;
            }
            lastChar = null;
            continue;
        }
        body += c;
        lastChar = code;
        i++;
    }
    if (p[i] !== ']') return { reason: 'invalid pattern' };
    const js = p.slice(start, i + 1);
    const jsInner = p.slice(start + 1 + (negated ? 1 : 0), i);
    return {
        pcre: `[${negated ? '^' : ''}${body}]`,
        js,
        inner: jsInner,
        end: i + 1,
        // A negated class, or one holding `\W` or `\D`, matches a lone
        // surrogate in JS, as `\W` and `\D` outside a class do. A range
        // across the surrogates holds both halves of every emoji in JS but
        // no emoji in R; it is refused above.
        anyUnit: negated || surrogateEscape,
    };
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
    if (isInt64(col)) {
        // Exact, as the viewer matches: a double literal can't hold every
        // integer64 (`9007199254740993` would read as ...992).
        ctx.needs.add('bit64');
        const keys = values.map(int64SetKey).filter((k): k is string => k !== undefined);
        // bit64's own %in%: before R 4.3, base match() compares the raw
        // doubles, where every negative integer64 is a NaN and they all match.
        return `bit64::\`%in%\`(${x}, bit64::as.integer64(${keys.length > 0 ? rVector(keys.map(rString)) : 'character(0)'}))`;
    }
    if (col.valueLabels && isNumericType(t)) return numericSet(x, values);
    if (col.valueLabels && labelsOn) {
        return `${labelled(ctx, ci)} %in% ${rVector(values.map(v => rString(String(v))))}`;
    }
    if (t === 'Utf8' || t === 'LargeUtf8') {
        return `${x} %in% ${rVector(values.map(v => rString(String(v))))}`;
    }
    if (isNumericType(t)) return numericSet(x, values);
    if (t === 'Bool') {
        const want = values.map(v => String(v).toLowerCase());
        if (want.some(v => v !== 'true' && v !== 'false')) return null;
        return `${x} %in% ${rVector(want.map(v => (v === 'true' ? 'TRUE' : 'FALSE')))}`;
    }
    return null;
}

/** `x %in% c(...)` over a numeric column's set values. NaN is left out:
 *  the viewer treats NaN as missing, which no value matches (R's `%in%`
 *  would match it). So is anything that isn't a number, such as a `null`
 *  (an `Inf` a lossy transport turned into one, which `Number()` would
 *  make 0). `Inf` and `-Inf` are written as such. */
function numericSet(x: string, values: readonly (string | number)[]): string {
    const nums = values.filter(isNumberLike).map(Number).filter(v => !Number.isNaN(v)).map(rNumber);
    return `${x} %in% ${nums.length > 0 ? rVector(nums) : 'numeric(0)'}`;
}

/** Date and date-time comparisons, in the instants the engine compares
 *  (`dateBoundMs` of the typed ISO string). */
function dateCode(
    col: ColumnSchema,
    x: string,
    p: Extract<FilterPredicate, { kind: 'dateCompare' | 'dateBetween' | 'dateNotBetween' }>,
): { code: string; trueOnNA: boolean } {
    const isTs = col.arrowType.startsWith('Timestamp');
    const isos = p.kind === 'dateCompare' ? [p.value] : [p.lo, p.hi];
    const ms = isos.map(s => dateBoundMs(s, col));
    // An unparseable bound matches nothing in the engine.
    if (ms.some(v => !Number.isFinite(v))) return { code: 'FALSE', trueOnNA: false };
    const wholeDays = !isTs && ms.every(v => v % 86_400_000 === 0);
    const lhs = isTs || wholeDays ? x : `as.POSIXct(${x})`;
    const lit = (v: number): string => {
        const iso = new Date(v).toISOString();
        // A year outside 0000 to 9999 is `+010000-…` or `-000001-…` in
        // ISO 8601, which R reads as neither a date nor a date-time, so
        // the value is counted from the epoch instead.
        if (/^[+-]/.test(iso)) {
            return wholeDays
                ? `as.Date(${rNumber(v / 86_400_000)}, origin = "1970-01-01")`
                : `as.POSIXct(${rNumber(v / 1000)}, origin = "1970-01-01", tz = "UTC")`;
        }
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
    let pred: ReturnType<typeof predicateCode>;
    try {
        pred = predicateCode(ctx, entry, labelsOn);
    } catch (e) {
        if (e instanceof Unrepresentable) return null;
        throw e;
    }
    if (!pred) return null;
    const kind = entry.predicate.kind;
    if (kind === 'isEmpty' || kind === 'isNotEmpty') return pred.code;
    const na = naCode(ctx, entry.columnIndex, colRef(ctx, entry.columnIndex));
    if (entry.includeMissing) return `${na} | ${pred.code}`;
    if (pred.trueOnNA) return `!${na} & ${pred.code}`;
    return pred.code;
}

/** `is.na(x)` for `x`, a reference to column `ci`. For an integer64 the
 *  method is called by name: until bit64 is loaded, plain is.na() reads
 *  the raw bits. */
function naCode(ctx: Ctx, ci: number, x: string): string {
    if (!isInt64(ctx.input.columns[ci])) return `is.na(${x})`;
    ctx.needs.add('bit64');
    return `bit64::is.na.integer64(${x})`;
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
            case 'int64':
            case 'uint64':
                if (ctx.flavor === 'base') {
                    // Base R's order() reads an integer64 as its raw bits
                    // until bit64 is attached, and then refuses a second
                    // key. Sort by its dense rank instead, NA put back as
                    // NA (so last). Not rank.integer64(): it aborts R on
                    // a key that is all NA (bit64 4.8.6).
                    ctx.needs.add('bit64');
                    terms.push({
                        expr: `replace(bit64::keypos(${x}), bit64::is.na.integer64(${x}), NA)`,
                        desc, character: false, bare: false,
                    });
                    continue;
                }
                terms.push({ expr: x, desc, character: false, bare: true });
                continue;
            case 'number':
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
                if (isInt64(col)) ctx.needs.add('bit64');
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
        const bare = text === colRef(ctx, key.columnIndex) && isBareRef(ctx, key.columnIndex);
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

/** Hidden columns that exist in the R object, as names (when every one
 *  is unique and nonempty) or 1-based positions. */
function hiddenSelection(ctx: Ctx): { names?: string[]; positions?: number[] } {
    const { columns, hiddenColumns } = ctx.input;
    const hidden = [...new Set(hiddenColumns)]
        .filter(ci => columns[ci] && (!columns[ci].isRowname || ctx.rownamesAsColumn))
        .sort((a, b) => a - b);
    if (hidden.length === 0) return {};
    const positions = hidden.map(ci => columnPosition(ctx, ci));
    const names = hidden.map(ci => (columns[ci].isRowname ? rownameNameOf(ctx.input) : columns[ci].name));
    if (names.every(n => !ctx.ambiguous.has(n) && rNameRepresentable(n))) return { names, positions };
    return { positions };
}

/** data.table's `i`: a lone symbol is looked up in the calling scope and
 *  a leading `!` means a not-join, so either is parenthesized to make it
 *  a plain logical index. */
function dataTableI(conditions: readonly string[]): string {
    const i = conditions.map(c => (/ \| /.test(c) && !c.startsWith('(') ? `(${c})` : c)).join(' & ');
    const symbol = /^(?:[A-Za-z.][A-Za-z0-9._]*|`(?:[^`\\]|\\.)*`)$/.test(i);
    return symbol || i.startsWith('!') ? `(${i})` : i;
}

function header(ctx: Ctx, extra: string[]): string[] {
    const req: string[] = [];
    if (ctx.flavor === 'dplyr') req.push('R >= 4.1 (|>)', 'dplyr >= 1.1.0');
    if (ctx.flavor === 'data.table') req.push('data.table');
    if (ctx.needs.has('tibble')) req.push('tibble');
    if (ctx.needs.has('bit64')) req.push('bit64');
    if (ctx.needs.has('stringr')) req.push('stringr >= 1.5.0 (str_rank)');
    if (ctx.needs.has('stringi')) req.push('stringi (a .locale other than "C")');
    const firstLine = ctx.input.expression.trim().split(/\r\n|\r|\n/)[0];
    const lines = [`# ${rComment(firstLine)} as shown in Raven's data viewer`];
    if (req.length > 0) lines.push(`# Requires ${req.join(', ')}`);
    const order = ctx.input.sort.stringOrder ?? 'natural';
    if (ctx.input.sort.keys.length > 0 && order !== 'c' && (ctx.needs.has('stringr') || ctx.needs.has('stringi'))) {
        lines.push('# String order uses ICU collation, as the viewer does; R and VS Code can ship',
            '# different ICU versions, which may order rare characters differently.');
    }
    for (const s of ctx.skipped) lines.push(`# Not translated: ${rComment(s)}`);
    lines.push(...extra);
    if (ctx.needs.has('labelHelper')) lines.push('', ...LABEL_HELPER);
    return lines;
}

/** The R code for the current view, or why there is none. */
export function generateRCode(input: CodeInput, flavor: CodeFlavor): CodeResult {
    try {
        return generate(input, flavor);
    } catch (e) {
        if (e instanceof Unrepresentable) {
            return { error: `Copy as R code can't write ${e.message} as R code.` };
        }
        throw e;
    }
}

function generate(input: CodeInput, flavor: CodeFlavor): CodeResult {
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
    const rownamesAsColumn = usesRownames && flavor !== 'base';
    const rownameName = rownameNameOf(input);
    const ambiguous = ambiguousNames(objectNames(input, rownamesAsColumn, rownameName));
    if (flavor === 'dplyr') {
        // dplyr's data mask refuses duplicate and empty names in filter()
        // and arrange(). A dots name (`...`, `..1`) can't be read there
        // (`.data[["..1"]]` errors too), and select() refuses one it
        // leaves behind; an unreferenced dots column is otherwise fine.
        const isDots = (n: string) => n === '...' || /^\.\.[0-9]+$/.test(n);
        const nameOf = (ci: number) => (input.columns[ci].isRowname ? rownameName : input.columns[ci].name);
        const referenced = [...entries.map(e => e.columnIndex), ...input.sort.keys.map(k => k.columnIndex)]
            .filter(ci => input.columns[ci] && (!input.columns[ci].isRowname || rownamesAsColumn))
            .map(nameOf);
        const hiddenSet = new Set(input.hiddenColumns);
        const keptNames = objectNames(
            { ...input, columns: input.columns.filter((_, ci) => !hiddenSet.has(ci)) }, rownamesAsColumn, rownameName);
        const kept = ambiguousNames(keptNames);
        const names = objectNames(input, rownamesAsColumn, rownameName);
        // A hidden row-name column that isn't materialized emits no select().
        const selects = input.hiddenColumns.some(ci => input.columns[ci]
            && (!input.columns[ci].isRowname || rownamesAsColumn));
        const refused = [...new Set([
            ...(entries.length > 0 || input.sort.keys.length > 0 ? ambiguous : []),
            // tibble::rownames_to_column() refuses any dots name.
            ...(rownamesAsColumn ? names.filter(isDots) : []),
            // select() itself refuses duplicates it leaves behind.
            ...(selects ? kept : []),
            ...referenced.filter(isDots),
            ...(selects ? keptNames.filter(isDots) : []),
        ])];
        if (refused.length > 0) {
            const list = refused.map(n => (n === '' ? 'an empty name' : `"${rComment(n)}"`)).join(', ');
            return {
                error: `dplyr can't work with this data frame's column names (${list}: duplicate, empty, `
                    + 'or `...`/`..1`); copy the base R or data.table code instead.',
            };
        }
    }
    const src0 = kind === 'matrix' ? `as.data.frame(${input.expression.trim()})` : input.expression.trim();
    // The code's own bindings (`dat`, `out`, `dt`) are read inside
    // `with()` and data.table's `[`, where a column of the same name would
    // shadow them, so each avoids the object's column names.
    const taken = new Set(objectNames(input, rownamesAsColumn, rownameName));
    const fresh = (base: string): string => {
        let name = base;
        for (let k = 1; taken.has(name); k++) name = `${base}_${k}`;
        return name;
    };
    const DAT = fresh('dat');
    const OUT = fresh('out');
    const DT = fresh('dt');
    // Base R names the frame for rownames() and positional references: the
    // expression itself when it is a plain name no column shadows, else
    // `dat`.
    const simple = /^[A-Za-z.][\w.]*$/.test(src0) && !taken.has(src0);
    const ctx: Ctx = {
        flavor,
        input,
        frame: flavor === 'data.table' ? DT : flavor === 'base' && simple ? src0 : DAT,
        rownamesAsColumn,
        needs: new Set(),
        skipped: [],
        ambiguous,
    };

    const labelsOn = input.filter.labelsOnWhenFiltered;
    const conditions: string[] = [];
    for (const e of entries) {
        ctx.skipReason = undefined;
        const code = entryCode(ctx, e, labelsOn);
        if (code === null) {
            const why = ctx.skipReason ? `: ${ctx.skipReason}` : '';
            ctx.skipped.push(`filter on ${input.columns[e.columnIndex].name} (${e.predicate.kind}${why})`);
        } else {
            conditions.push(code);
        }
    }
    // Sort keys read the filtered frame (base R and data.table).
    if (conditions.length > 0 && flavor !== 'dplyr') ctx.frame = OUT;
    const terms = sortTerms(ctx);
    const hidden = hiddenSelection(ctx);
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
        if (hidden.names) body.push(`select(-${rVector(hidden.names.map(rName))})`);
        else if (hidden.positions) body.push(`select(-${rVector(hidden.positions.map(String))})`);
        // The view is the flat table. On a grouped or rowwise tibble
        // select() keeps the grouping columns, hidden or not, so the
        // grouping goes first (a no-op on any other data frame).
        if (hidden.positions) body.unshift('ungroup()');
        if (body.length === 0) head = src0;
        const lines = header(ctx, ['', 'library(dplyr)', '']);
        lines.push(body.length === 0 ? head : `${head} |>\n  ${body.join(' |>\n  ')}`);
        return { code: lines.join('\n') + '\n' };
    }

    if (flavor === 'data.table') {
        const setup = ctx.rownamesAsColumn
            ? `${DT} <- as.data.table(${src0}, keep.rownames = ${rString(rownameName)})`
            : `${DT} <- as.data.table(${src0})`;
        const steps: string[] = [setup];
        let out = DT;
        if (conditions.length > 0) {
            steps.push(`${OUT} <- ${DT}[${dataTableI(conditions)}]`);
            out = OUT;
        }
        if (terms.length > 0) {
            const args = terms.map(t => (t.desc ? `-${t.expr}` : t.expr));
            steps.push(`${OUT} <- ${out}[order(${args.join(', ')})]`);
            out = OUT;
        }
        if (hidden.names) {
            steps.push(`${OUT} <- ${out}[, !${rVector(hidden.names.map(rString))}]`);
            out = OUT;
        } else if (hidden.positions) {
            steps.push(`${OUT} <- ${out}[, -${rVector(hidden.positions.map(String))}]`);
            out = OUT;
        }
        if (out === DT) steps.push(`${OUT} <- ${DT}`);
        const lines = header(ctx, ['', 'library(data.table)', '']);
        lines.push(...steps);
        return { code: lines.join('\n') + '\n' };
    }

    // Base R. Every `[` here is one a data.table also reads as base R
    // does (row indices with an empty `j`, literal column positions), so
    // the code reproduces the view whatever the object's class.
    const dat = simple ? src0 : DAT;
    const steps: string[] = [];
    if (!simple) steps.push(`${DAT} <- ${src0}`);
    let out = dat;
    if (conditions.length > 0) {
        const joined = conditions.map(c => (/ \| /.test(c) && !c.startsWith('(') ? `(${c})` : c)).join(' & ');
        steps.push(`${OUT} <- ${dat}[which(with(${dat}, ${joined})), , drop = FALSE]`);
        out = OUT;
    }
    if (terms.length > 0) {
        const args = terms.map(t => t.expr);
        const decreasing = terms.map(t => (t.desc ? 'TRUE' : 'FALSE'));
        const dec = decreasing.every(d => d === 'FALSE') ? ''
            : decreasing.every(d => d === 'TRUE') ? ', decreasing = TRUE'
                : `, decreasing = c(${decreasing.join(', ')})`;
        steps.push(`${OUT} <- ${out}[with(${out}, order(${args.join(', ')}${dec}, method = "radix")), , drop = FALSE]`);
        out = OUT;
    }
    if (hidden.positions) {
        // Literal positions: a computed `j` (`setdiff(names(out), ...)`)
        // would be evaluated as an expression by `[.data.table`.
        steps.push(`${OUT} <- ${out}[, -${rVector(hidden.positions.map(String))}, drop = FALSE]`);
        out = OUT;
        // `[.data.frame` makes kept duplicate (or empty) names unique;
        // restore them as the view shows them.
        const keptNames = objectNames(input, false, rownameName)
            .filter((_, k) => !hidden.positions!.includes(k + 1));
        if (ambiguousNames(keptNames).size > 0) {
            steps.push(`${OUT} <- setNames(${OUT}, ${rVector(keptNames.map(rString))})`);
        }
    }
    if (out !== OUT) steps.push(`${OUT} <- ${out}`);
    const lines = header(ctx, ['']);
    lines.push(...steps);
    return { code: lines.join('\n') + '\n' };
}
