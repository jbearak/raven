// Copy as R code with hostile column names, values, labels and View()
// expressions: text from the data must never become code. For every
// flavor, R parses the generated code from a file (where a bare CR also
// ends a line) and the test checks that
//   - it has as many top-level expressions as the same view over benign
//     names and values,
//   - every token that carries the injected `pwn` call is a comment, a
//     string literal or a backticked symbol, and
//   - evaluating it against a frame with those names never calls `pwn()`.
// Skipped when R, dplyr or data.table is missing.
import { beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'bun';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ColumnSchema } from '../../editors/vscode/src/data-viewer/arrow-reader';
import { generateRCode, rComment, type CodeFlavor } from '../../editors/vscode/src/data-viewer/r-code';
import type { FilterEntry, FilterPredicate, SortKey } from '../../editors/vscode/src/data-viewer/messages';

const R_BIN = process.env.RAVEN_TEST_R_BIN ?? 'R';

async function hasPackages(): Promise<boolean> {
    try {
        const p = spawn({
            cmd: [R_BIN, '--vanilla', '--quiet', '--no-echo', '-e',
                'cat(if (all(vapply(c("dplyr", "data.table"), requireNamespace, logical(1), quietly = TRUE))) "OK" else "NO")'],
            stdout: 'pipe', stderr: 'pipe',
        });
        const out = await new Response(p.stdout).text();
        await p.exited;
        return out.includes('OK');
    } catch {
        return false;
    }
}

const READY = await hasPackages();
const FLAVORS: CodeFlavor[] = ['dplyr', 'base', 'data.table'];

/** Every line terminator R or an editor might honor, quotes, escapes,
 *  backticks, bidi controls, non-BMP text, names that are syntactic but
 *  special (`...`, `..1`, `if`), a comment start, and a duplicate. */
const HOSTILE = [
    'a\nb', 'x\npwn()\n#', 'x\rpwn()', 'x\r\npwn()', 'x\u2028pwn()', 'x\u2029pwn()', 'x\u0085pwn()',
    'x\u000bpwn()', 'x\u000cpwn()', '`', '\\', '\\`pwn()`', '"', "'", 'a"b\\', 'é😀', '\u202epwn()',
    '...', '..1', 'if', '_x', '#pwn()', '"); pwn(); ("', '`); pwn(); (`', 'dup\npwn()', 'dup\npwn()',
];

function col(name: string, arrowType: string, extra: Partial<ColumnSchema> = {}): ColumnSchema {
    return { name, arrowType, dictionaryShipped: false, isInteger: false, ...extra };
}

/** The view under test, over the given names (one character column per
 *  name, after `id`) and values. */
function view(names: string[], values: string[], expression: string) {
    const columns: ColumnSchema[] = [
        col('id', 'Int32', { typeTag: '<int>' }),
        ...names.map(n => col(n, 'Utf8', { typeTag: '<chr>' })),
        col('lab', 'Utf8', {
            typeTag: '<chr+lbl>',
            valueLabels: Object.fromEntries(values.map((v, k) => [v, values[(k + 1) % values.length]])),
        }),
    ];
    const lab = columns.length - 1;
    const entries: FilterEntry[] = [];
    const add = (columnIndex: number, predicate: FilterPredicate, includeMissing = false) =>
        entries.push({ id: `e${entries.length}`, columnIndex, predicate, enabled: true, includeMissing });
    names.forEach((_, k) => {
        const ci = k + 1;
        const v = values[k % values.length];
        const preds: FilterPredicate[] = [
            { kind: 'strCompare', op: '!=', value: v, caseSensitive: k % 2 === 0 },
            { kind: 'setNotIn', values: [v, values[(k + 3) % values.length]] },
            { kind: 'strContains', value: v, caseSensitive: true, negate: true },
            { kind: 'strStartsWith', value: v, caseSensitive: false },
        ];
        add(ci, preds[k % preds.length], true);
        // Never translated (`\\p` differs between JS and PCRE), so the
        // column name lands in a "Not translated" comment.
        add(ci, { kind: 'strRegex', pattern: '\\p{L}', caseSensitive: true });
    });
    add(lab, { kind: 'setNotIn', values: [values[0], values[1]] }, true);
    const keys: SortKey[] = [{ columnIndex: 1, direction: 'desc' }, { columnIndex: lab, direction: 'asc' }];
    return {
        expression,
        sourceKind: 'data.frame',
        columns,
        sort: { keys, labelsOnWhenSorted: true, stringOrder: 'c' as const },
        filter: { entries, labelsOnWhenFiltered: true },
        hiddenColumns: [2, 4],
        locale: 'en',
    };
}

/** An R expression that builds the string `s` from code points, so the
 *  test never relies on the escaping it checks. */
function rFromCodePoints(s: string): string {
    const cps = Array.from(s, ch => ch.codePointAt(0)!);
    return cps.length === 0 ? '""' : `intToUtf8(c(${cps.join(', ')}))`;
}

/** Benign stand-ins with the same equality pattern as the hostile ones. */
function benign(xs: string[], prefix: string): string[] {
    const map = new Map<string, string>();
    return xs.map(x => {
        if (!map.has(x)) map.set(x, `${prefix}${map.size}`);
        return map.get(x)!;
    });
}

describe('rComment', () => {
    test('keeps comment text on one line with nothing invisible', () => {
        for (const s of HOSTILE) {
            const c = rComment(s);
            expect(c).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
        }
        expect(rComment('a\nb\rc\u2028')).toBe('a\\nb\\rc\\u2028');
    });
});

describe('generateRCode never emits data as code', () => {
    test('a NUL in a filter value is not translated', () => {
        const v = {
            expression: 'd', sourceKind: 'data.frame', locale: 'en', hiddenColumns: [],
            columns: [col('id', 'Int32'), col('s', 'Utf8', { typeTag: '<chr>' })],
            sort: { keys: [], labelsOnWhenSorted: true },
            filter: {
                entries: [{ id: 'a', columnIndex: 1, predicate: { kind: 'strCompare' as const, op: '=' as const, value: 'a\u0000b', caseSensitive: true }, enabled: true, includeMissing: false }],
                labelsOnWhenFiltered: true,
            },
        };
        for (const flavor of FLAVORS) {
            const r = generateRCode(v, flavor);
            if (!('code' in r)) throw new Error(r.error);
            expect(r.code).toContain('# Not translated: filter on s (strCompare)');
            expect(r.code).not.toContain('\u0000');
        }
    });

    test('a hostile View() expression stays in the header comment', () => {
        for (const flavor of FLAVORS) {
            const r = generateRCode({ ...view(['s'], ['a'], 'd'), expression: 'd\u2028pwn()' }, flavor);
            if (!('code' in r)) throw new Error(r.error);
            expect(r.code.split('\n')[0]).toBe('# d\\u2028pwn() as shown in Raven\'s data viewer');
        }
    });
});

describe.skipIf(!READY)('hostile names and values in real R', () => {
    const results = new Map<string, string>();
    beforeAll(async () => {
        const tmp = mkdtempSync(join(tmpdir(), 'raven-dv-hostile-'));
        // `\x` and `\u` escapes can't share an R string literal.
        const values = [...HOSTILE, 'x', 'é😀', 'x\u000b\u2028y'];
        const goodValues = benign(values, 'v');
        const script: string[] = [
            'suppressPackageStartupMessages({ library(dplyr); library(data.table) })',
            'pwn <- function(...) stop("INJECTED")',
            `vals <- c(${values.map(rFromCodePoints).join(', ')})`,
            'mk <- function(nm) {',
            '  d <- data.frame(id = 1:4)',
            '  for (k in seq_along(nm)) d[[k + 1L]] <- c(vals[k], "x", NA, vals[(k %% length(vals)) + 1L])',
            '  d$lab <- c(vals[1], vals[2], NA, "x")',
            '  names(d) <- c("id", nm, "lab")',
            '  d',
            '}',
            'check <- function(key, file, good, nm) {',
            '  d <- mk(nm)',
            '  ex <- tryCatch(parse(file = file, encoding = "UTF-8"), error = function(e) e)',
            '  if (inherits(ex, "error")) { cat("@@", key, "\\tPARSE: ", conditionMessage(ex), "\\n", sep = ""); return() }',
            '  n_good <- length(parse(file = good, encoding = "UTF-8"))',
            '  pd <- getParseData(parse(file = file, encoding = "UTF-8", keep.source = TRUE))',
            '  bad <- pd[pd$terminal & grepl("pwn", pd$text, fixed = TRUE) &',
            '           !(pd$token %in% c("COMMENT", "STR_CONST") | (pd$token == "SYMBOL" & startsWith(pd$text, "`"))), ]',
            '  run <- tryCatch({ local({ eval(parse(file = file, encoding = "UTF-8")) }); "ok" },',
            '                  error = function(e) conditionMessage(e))',
            '  cat("@@", key, "\\t", length(ex), "/", n_good, "\\t", nrow(bad), "\\t", gsub("\\n", " ", run), "\\n", sep = "")',
            '}',
        ];
        // With the duplicate name, and with every name unique (dplyr
        // refuses duplicates, so only this variant reaches its code).
        const variants = {
            dup: HOSTILE,
            uniq: [...new Set(HOSTILE)],
            plain: [...new Set(HOSTILE)].filter(n => n !== '...' && n !== '..1'),
        };
        for (const [variant, names] of Object.entries(variants)) {
            const goodNames = benign(names, 'n');
            const nm = `c(${names.map(rFromCodePoints).join(', ')})`;
            for (const flavor of FLAVORS) {
                const key = `${variant}|${flavor}`;
                const hostile = generateRCode(view(names, values, 'd'), flavor);
                const good = generateRCode(view(goodNames, goodValues, 'd'), flavor);
                if ('error' in hostile || 'error' in good) {
                    results.set(key, `GENERATOR: ${'error' in hostile ? hostile.error : ''} ${'error' in good ? good.error : ''}`);
                    continue;
                }
                const f = join(tmp, `${variant}-${flavor}.R`);
                const g = join(tmp, `${variant}-${flavor}-good.R`);
                writeFileSync(f, hostile.code, 'utf8');
                writeFileSync(g, good.code, 'utf8');
                script.push(`check(${JSON.stringify(key)}, ${JSON.stringify(f)}, ${JSON.stringify(g)}, ${nm})`);
            }
        }
        const scriptPath = join(tmp, 'check.R');
        writeFileSync(scriptPath, script.join('\n'), 'utf8');
        const p = spawn({
            cmd: [R_BIN, '--vanilla', '--quiet', '--no-echo', '-e', `source(${JSON.stringify(scriptPath)}, encoding = "UTF-8")`],
            env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
            stdout: 'pipe', stderr: 'pipe',
        });
        const stdout = await new Response(p.stdout).text();
        const stderr = await new Response(p.stderr).text();
        await p.exited;
        for (const line of stdout.split('\n')) {
            const m = /^@@(.*?)\t(.*)$/.exec(line);
            if (m) results.set(m[1], m[2]);
        }
        if (results.size === 0) throw new Error(`R produced no results:\n${stderr}`);
    }, 120_000);

    test('dplyr refuses duplicate and dots names rather than reading the wrong column', () => {
        expect(results.get('dup|dplyr')).toMatch(/^GENERATOR: dplyr can't work with this data frame's column names \("dup\\npwn\(\)", "\.\.\.", "\.\.1"/);
        expect(results.get('uniq|dplyr')).toMatch(/^GENERATOR: dplyr can't work with this data frame's column names \("\.\.\.", "\.\.1"/);
    });

    for (const key of ['dup|base', 'dup|data.table', 'uniq|base', 'uniq|data.table', 'plain|dplyr', 'plain|base', 'plain|data.table']) {
        test(`${key}: parses to the benign shape, keeps data inert, and runs`, () => {
            const got = results.get(key);
            expect(got).toBeDefined();
            const [counts, bad, run] = got!.split('\t');
            const [n, nGood] = counts.split('/').map(Number);
            expect(n).toBe(nGood);
            expect(Number(bad)).toBe(0);
            expect(run).toBe('ok');
        });
    }
});
