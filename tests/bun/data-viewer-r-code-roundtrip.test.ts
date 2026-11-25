// Copy as R code round trip: R writes a frame through the real `View()`
// writer, the viewer's filter and sort engines compute the rows on screen,
// and R evaluates the emitted dplyr, base R and data.table code against the
// same frame. The `id` column (1..n) identifies rows, so each case compares
// R's row order with the viewer's permutation. Skipped when R, arrow,
// dplyr, data.table, stringr or haven is missing.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'bun';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArrowSliceReader } from '../../editors/vscode/src/data-viewer/arrow-reader';
import { computeFilteredIndices } from '../../editors/vscode/src/data-viewer/filter';
import { computePermutation } from '../../editors/vscode/src/data-viewer/sort';
import { generateRCode, type CodeFlavor } from '../../editors/vscode/src/data-viewer/r-code';
import type {
    FilterEntry,
    FilterPredicate,
    SortKey,
    StringOrder,
} from '../../editors/vscode/src/data-viewer/messages';
import {
    generate_profile_source,
    write_profile_file,
} from '../../editors/vscode/src/plot/r-bootstrap-profile';

const R_BIN = process.env.RAVEN_TEST_R_BIN ?? 'R';
const PKGS = ['arrow', 'dplyr', 'data.table', 'stringr', 'stringi', 'haven', 'tibble'];

async function hasPackages(): Promise<boolean> {
    try {
        const p = spawn({
            cmd: [R_BIN, '--vanilla', '--quiet', '--no-echo', '-e',
                `cat(if (all(vapply(c(${PKGS.map(p => `"${p}"`).join(',')}), requireNamespace, logical(1), quietly = TRUE))) "OK" else "NO")`],
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
const LOCALE = 'en';

/** The frame: every column kind the generator routes differently, with
 *  NA in each, NaN in the double, a mixed-case digit-run string column,
 *  and non-ASCII strings. */
const FRAME_R = `
n <- 24L
s <- c("a", "A", "file_2", "file_10", "b", "B", "file_1", NA, "Z", "z", "10", "9",
       "a", "file_02", "_x", "x_", "File_3", "file_3", "b", "", "A", "aa", "Ab", "aB")
u <- c("café", "cafe", "Ålborg", "zebra", "émile", "Émile", "Zürich", "zurich", "ångström",
       "Angstrom", NA, "naïve", "naive", "Œuvre", "oeuvre", "ß", "ss", "ü", "u", "é",
       "e", "É", "E", "über")
x <- c(3.5, NA, 1, NaN, 2, 1, 7, -1, NA, 2.5, 3.5, 0, NaN, 10, 1, -3, 4, 4, NA, 2, 8, 9, 0.5, 6)
f <- factor(c("lo", "hi", "mid", NA, "hi", "lo", "mid", "mid", "lo", "hi", NA, "lo",
              "hi", "mid", "lo", "lo", "hi", "mid", "lo", NA, "hi", "mid", "lo", "hi"),
            levels = c("mid", "lo", "hi"))
o <- factor(c("b", "c", "a", "a", "c", "b", "b", "a", "c", "c", "a", "b",
              "b", "a", NA, "c", "a", "b", "c", "a", "b", "c", "a", "b"),
            levels = c("c", "a", "b"), ordered = TRUE)
lab <- haven::labelled(c(1, 2, 3, 1, NA, 2, 9, 3, 1, 2, 3, 1, 2, 2, 3, 9, 1, NA, 2, 3, 1, 1, 2, 3),
                       labels = c(Male = 1, Female = 2, Other = 3))
labc <- haven::labelled(c("y", "n", "y", NA, "m", "n", "y", "y", "n", "m", "n", "y",
                          "y", "n", "y", "m", "n", "y", NA, "n", "y", "y", "m", "n"),
                        labels = c(Yes = "y", No = "n"))
d <- as.Date("2024-01-01") + c(0:22, NA)
b <- c(TRUE, FALSE, NA, TRUE, TRUE, FALSE, FALSE, NA, TRUE, FALSE, TRUE, TRUE,
       FALSE, TRUE, NA, FALSE, TRUE, FALSE, TRUE, TRUE, FALSE, NA, TRUE, FALSE)
i <- c(5L, 3L, NA, 1L, 5L, 2L, 2L, 9L, 0L, -4L, 3L, 3L, 1L, NA, 8L, 7L, 6L, 2L, 1L, 0L, 4L, 4L, 5L, 9L)
df <- data.frame(id = seq_len(n), s = s, u = u, x = x, f = f, o = o, d = d, b = b, i = i,
                 stringsAsFactors = FALSE)
df$lab <- lab
df$labc <- labc
`;

type Case = {
    name: string;
    filters?: { col: string; p: FilterPredicate; includeMissing?: boolean }[];
    sort?: { col: string; dir: 'asc' | 'desc' }[];
    order?: StringOrder;
    labelsOn?: boolean;
    hide?: string[];
};

const CASES: Case[] = [];
for (const order of ['c', 'locale', 'natural'] as StringOrder[]) {
    for (const dir of ['asc', 'desc'] as const) {
        CASES.push({ name: `mixed-case digit runs, ${order} ${dir}`, sort: [{ col: 's', dir }], order });
        CASES.push({ name: `non-ASCII, ${order} ${dir}`, sort: [{ col: 'u', dir }], order });
        CASES.push({ name: `factor labels, ${order} ${dir}`, sort: [{ col: 'f', dir }, { col: 'id', dir: 'desc' }], order });
        CASES.push({ name: `value labels on, ${order} ${dir}`, sort: [{ col: 'lab', dir }, { col: 'labc', dir }], order });
    }
}
CASES.push(
    { name: 'double with NaN and NA, asc', sort: [{ col: 'x', dir: 'asc' }] },
    { name: 'double with NaN and NA, desc', sort: [{ col: 'x', dir: 'desc' }] },
    { name: 'multi-key: factor codes desc, double asc', sort: [{ col: 'f', dir: 'desc' }, { col: 'x', dir: 'asc' }], labelsOn: false },
    { name: 'ordered factor by levels', sort: [{ col: 'o', dir: 'asc' }, { col: 'b', dir: 'desc' }], labelsOn: false },
    { name: 'ordered factor by label text', sort: [{ col: 'o', dir: 'desc' }], labelsOn: true },
    { name: 'labelled values with Labels off', sort: [{ col: 'lab', dir: 'desc' }, { col: 'labc', dir: 'asc' }], labelsOn: false, order: 'c' },
    { name: 'date and logical', sort: [{ col: 'b', dir: 'asc' }, { col: 'd', dir: 'desc' }] },
    { name: 'numCompare', filters: [{ col: 'x', p: { kind: 'numCompare', op: '>', value: 1 } }] },
    { name: 'numCompare != keeps no missing', filters: [{ col: 'x', p: { kind: 'numCompare', op: '!=', value: 1 } }] },
    { name: 'numBetween half-open with includeMissing', filters: [{ col: 'x', p: { kind: 'numBetween', lo: 1, hi: 4, inclusive: true, upperInclusive: false }, includeMissing: true }] },
    { name: 'numNotBetween exclusive', filters: [{ col: 'i', p: { kind: 'numNotBetween', lo: 2, hi: 5, inclusive: false } }] },
    { name: 'isEmpty / isNotEmpty ignore includeMissing', filters: [
        { col: 'x', p: { kind: 'isNotEmpty' }, includeMissing: true },
        { col: 's', p: { kind: 'isEmpty' } },
    ] },
    { name: 'isNotEmpty on double drops NaN', filters: [{ col: 'x', p: { kind: 'isNotEmpty' } }], sort: [{ col: 'x', dir: 'desc' }] },
    { name: 'factor set, Labels on', filters: [{ col: 'f', p: { kind: 'setIn', values: ['hi', 'mid'] } }], labelsOn: true },
    { name: 'factor not-in set, Labels on', filters: [{ col: 'f', p: { kind: 'setNotIn', values: ['hi'] } }], labelsOn: true },
    { name: 'factor not-in set with missing', filters: [{ col: 'f', p: { kind: 'setNotIn', values: ['hi'] }, includeMissing: true }], labelsOn: true },
    { name: 'factor set, Labels off (codes)', filters: [{ col: 'f', p: { kind: 'setIn', values: ['0', '2'] } }], labelsOn: false },
    { name: 'labelled numeric set (codes)', filters: [{ col: 'lab', p: { kind: 'setIn', values: [1, 9] } }] },
    { name: 'labelled character set, Labels on', filters: [{ col: 'labc', p: { kind: 'setIn', values: ['Yes', 'm'] } }], labelsOn: true },
    { name: 'labelled character set, Labels off', filters: [{ col: 'labc', p: { kind: 'setNotIn', values: ['y'] } }], labelsOn: false },
    { name: 'character set with non-ASCII', filters: [{ col: 'u', p: { kind: 'setIn', values: ['café', 'Ålborg', 'ß'] } }] },
    { name: 'contains, case-insensitive', filters: [{ col: 's', p: { kind: 'strContains', value: 'FILE', caseSensitive: false, negate: false } }] },
    { name: 'not contains keeps no NA', filters: [{ col: 's', p: { kind: 'strContains', value: 'a', caseSensitive: true, negate: true } }] },
    { name: 'starts / ends with', filters: [
        { col: 'u', p: { kind: 'strStartsWith', value: 'É', caseSensitive: true } },
    ] },
    { name: 'ends with, case-insensitive, on factor', filters: [{ col: 'f', p: { kind: 'strEndsWith', value: 'I', caseSensitive: false } }] },
    { name: 'regex', filters: [{ col: 's', p: { kind: 'strRegex', pattern: '^file_\\d$', caseSensitive: false } }] },
    { name: 'string equals', filters: [{ col: 'u', p: { kind: 'strCompare', op: '=', value: 'CAFÉ', caseSensitive: false } }] },
    { name: 'date between', filters: [{ col: 'd', p: { kind: 'dateBetween', lo: '2024-01-05', hi: '2024-01-12', inclusive: true } }] },
    { name: 'date compare', filters: [{ col: 'd', p: { kind: 'dateCompare', op: '>=', value: '2024-01-20' } }] },
    { name: 'bool with includeMissing', filters: [{ col: 'b', p: { kind: 'bool', value: false }, includeMissing: true }] },
    { name: 'filter + sort + hidden', filters: [
        { col: 'x', p: { kind: 'numCompare', op: '>=', value: 0 } },
        { col: 's', p: { kind: 'isNotEmpty' } },
    ], sort: [{ col: 's', dir: 'desc' }, { col: 'x', dir: 'asc' }], order: 'natural', hide: ['u', 'lab'] },
);

const FLAVORS: CodeFlavor[] = ['dplyr', 'base', 'data.table'];

let reader: ArrowSliceReader;
let rdsPath: string;
let rOut: Map<string, string> = new Map();
const expected = new Map<string, number[]>();
const hiddenExpect = new Map<string, string[]>();

async function runR(rCode: string, extraEnv: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; dir: string }> {
    const tmp = mkdtempSync(join(tmpdir(), 'raven-dv-rcode-'));
    const dv = join(tmp, 'dv');
    mkdirSync(dv);
    const profile = await write_profile_file(tmp, generate_profile_source());
    const p = spawn({
        cmd: [R_BIN, '--quiet', '--no-save', '--no-restore', '-e', rCode],
        cwd: tmp,
        env: {
            ...process.env,
            R_PROFILE_USER: profile,
            RAVEN_ORIGINAL_R_PROFILE_USER: '',
            RAVEN_DATA_VIEWER_DIR: dv,
            RAVEN_R_SESSION_ID: 'rcode',
            RAVEN_SESSION_PORT: '',
            RAVEN_SESSION_TOKEN: '',
            LANG: 'en_US.UTF-8',
            LC_ALL: 'en_US.UTF-8',
            ...extraEnv,
        },
        stdout: 'pipe', stderr: 'pipe',
    });
    const stdout = await new Response(p.stdout).text();
    const stderr = await new Response(p.stderr).text();
    await p.exited;
    return { stdout, stderr, dir: dv };
}

describe.skipIf(!READY)('Copy as R code round trip (real R)', () => {
    // A reader left open is closed by the garbage collector later, and bun
    // reports that as an error in whichever test is running then.
    afterAll(async () => { await reader?.close(); });

    beforeAll(async () => {
        const tmp = mkdtempSync(join(tmpdir(), 'raven-dv-rcode-rds-'));
        rdsPath = join(tmp, 'df.rds');
        const w = await runR(`${FRAME_R}\nsaveRDS(df, ${JSON.stringify(rdsPath)})\nView(df)\n`);
        const files = readdirSync(w.dir).filter(f => f.endsWith('.arrow'));
        if (files.length !== 1) throw new Error(`View() wrote ${files.length} files\n${w.stderr}`);
        reader = await ArrowSliceReader.open(join(w.dir, files[0]));
        const cols = reader.schema.columns;
        const ci = (name: string) => {
            const i = cols.findIndex(c => c.name === name);
            if (i < 0) throw new Error(`no column ${name}`);
            return i;
        };

        const script: string[] = [
            'suppressPackageStartupMessages({ library(dplyr); library(data.table) })',
            `df <- readRDS(${JSON.stringify(rdsPath)})`,
            'emit <- function(key, out) cat("@@", key, "\\t", paste(out[["id"]], collapse = ","), "\\t", paste(names(out), collapse = ","), "\\n", sep = "")',
        ];
        for (const c of CASES) {
            const labelsOn = c.labelsOn ?? true;
            const entries: FilterEntry[] = (c.filters ?? []).map((f, k) => ({
                id: `f${k}`, columnIndex: ci(f.col), predicate: f.p, enabled: true, includeMissing: f.includeMissing ?? false,
            }));
            const keys: SortKey[] = (c.sort ?? []).map(s => ({ columnIndex: ci(s.col), direction: s.dir }));
            const ctx = { labelsOn, formatOn: true, digits: 3 };
            const rows = await computeFilteredIndices(reader, { entries, labelsOnWhenFiltered: labelsOn }, ctx);
            const perm = await computePermutation(reader, keys, {
                ...ctx, stringOrder: c.order, locale: LOCALE,
            }, { rows });
            expected.set(c.name, Array.from(perm, r => r + 1));
            hiddenExpect.set(c.name, cols.map(col => col.name).filter(n => !(c.hide ?? []).includes(n)));
            for (const flavor of FLAVORS) {
                const res = generateRCode({
                    expression: 'df',
                    sourceKind: 'data.frame',
                    columns: cols,
                    sort: { keys, labelsOnWhenSorted: labelsOn, ...(c.order ? { stringOrder: c.order } : {}) },
                    filter: { entries, labelsOnWhenFiltered: labelsOn },
                    hiddenColumns: (c.hide ?? []).map(ci),
                    locale: LOCALE,
                }, flavor);
                if ('error' in res) throw new Error(res.error);
                const key = `${flavor}|${c.name}`;
                script.push(
                    `local({ out <- tryCatch({ out <- {${'\n'}${res.code}${'\n'}}; out }, error = function(e) { cat("@@", ${JSON.stringify(key)}, "\\tERROR: ", conditionMessage(e), "\\n", sep = ""); NULL }); if (!is.null(out)) emit(${JSON.stringify(key)}, out) })`,
                );
            }
        }
        const scriptPath = join(mkdtempSync(join(tmpdir(), 'raven-dv-rcode-script-')), 'cases.R');
        writeFileSync(scriptPath, script.join('\n'), 'utf8');
        const r = await runR(`source(${JSON.stringify(scriptPath)}, encoding = "UTF-8")`);
        for (const line of r.stdout.split('\n')) {
            const m = /^@@(.*?)\t(.*)$/.exec(line);
            if (m) rOut.set(m[1], m[2]);
        }
        if (rOut.size === 0) throw new Error(`R produced no results:\n${r.stderr}`);
    }, 120_000);

    for (const c of CASES) {
        for (const flavor of FLAVORS) {
            test(`${flavor}: ${c.name}`, () => {
                const got = rOut.get(`${flavor}|${c.name}`);
                expect(got).toBeDefined();
                expect(got!).not.toMatch(/^ERROR/);
                const [ids, names] = got!.split('\t');
                const rows = ids === '' ? [] : ids.split(',').map(Number);
                expect(rows).toEqual(expected.get(c.name)!);
                if (c.hide) expect(names.split(',')).toEqual(hiddenExpect.get(c.name)!);
            });
        }
    }
});

// Row names: the viewer shows them as a `rowname` column; dplyr and
// data.table materialize it, base R reads rownames().
describe.skipIf(!READY)('Copy as R code round trip: row names (real R)', () => {
    const results = new Map<string, string>();
    let wantDesc: number[] = [];
    let wantFiltered: number[] = [];
    beforeAll(async () => {
        const tmp = mkdtempSync(join(tmpdir(), 'raven-dv-rcode-rn-'));
        const rds = join(tmp, 'm.rds');
        const w = await runR(`m <- mtcars[1:16, 1:3]\nm$id <- seq_len(nrow(m))\nsaveRDS(m, ${JSON.stringify(rds)})\nView(m)\n`);
        const files = readdirSync(w.dir).filter(f => f.endsWith('.arrow'));
        const rd = await ArrowSliceReader.open(join(w.dir, files[0]));
        const cols = rd.schema.columns;
        const rn = cols.findIndex(c => c.isRowname);
        const cyl = cols.findIndex(c => c.name === 'cyl');
        expect(rn).toBe(0);
        const entries: FilterEntry[] = [{ id: 'a', columnIndex: rn, predicate: { kind: 'strStartsWith', value: 'Merc', caseSensitive: true }, enabled: true, includeMissing: false }];
        const keys: SortKey[] = [{ columnIndex: cyl, direction: 'desc' }, { columnIndex: rn, direction: 'desc' }];
        const ctx = { labelsOn: true, formatOn: true, digits: 3 };
        const rows = await computeFilteredIndices(rd, { entries, labelsOnWhenFiltered: true }, ctx);
        wantFiltered = Array.from(await computePermutation(rd, keys, { ...ctx, stringOrder: 'c', locale: LOCALE }, { rows }), r => r + 1);
        wantDesc = Array.from(await computePermutation(rd, [keys[1]], { ...ctx, stringOrder: 'c', locale: LOCALE }), r => r + 1);
        const script = [
            'suppressPackageStartupMessages({ library(dplyr); library(data.table) })',
            `m <- readRDS(${JSON.stringify(rds)})`,
        ];
        for (const flavor of FLAVORS) {
            for (const [name, f, k] of [['filtered', entries, keys], ['desc', [], [keys[1]]]] as const) {
                const res = generateRCode({
                    expression: 'm', sourceKind: 'data.frame', columns: cols,
                    sort: { keys: [...k], labelsOnWhenSorted: true, stringOrder: 'c' },
                    filter: { entries: [...f], labelsOnWhenFiltered: true },
                    hiddenColumns: [], locale: LOCALE,
                }, flavor);
                if ('error' in res) throw new Error(res.error);
                script.push(`local({ out <- tryCatch({ out <- {\n${res.code}\n}; out }, error = function(e) { cat("@@${flavor}|${name}\tERROR: ", conditionMessage(e), "\n", sep = ""); NULL }); if (!is.null(out)) cat("@@${flavor}|${name}\t", paste(out[["id"]], collapse = ","), "\n", sep = "") })`);
            }
        }
        const scriptPath = join(tmp, 'rn.R');
        writeFileSync(scriptPath, script.join('\n'), 'utf8');
        const r = await runR(`source(${JSON.stringify(scriptPath)}, encoding = "UTF-8")`);
        for (const line of r.stdout.split('\n')) {
            const m = /^@@(.*?)\t(.*)$/.exec(line);
            if (m) results.set(m[1], m[2]);
        }
        await rd.close();
    }, 120_000);

    for (const flavor of FLAVORS) {
        test(`${flavor}: filter and sort on row names`, () => {
            expect(results.get(`${flavor}|filtered`)).toBe(wantFiltered.join(','));
            expect(results.get(`${flavor}|desc`)).toBe(wantDesc.join(','));
        });
    }
});

/** A small frame through the real writer and engines: each case names
 *  columns by index (duplicate names allowed), and R evaluates the code
 *  against `objects` (e.g. the frame and the same data as a data.table). */
type EdgeCase = {
    name: string;
    filters?: { ci: number; p: FilterPredicate; includeMissing?: boolean }[];
    sort?: { ci: number; dir: 'asc' | 'desc' }[];
    hide?: number[];
    /** Flavors that must refuse the view (generator error), not emit code. */
    refuse?: CodeFlavor[];
    /** The `id`s the view must show, stated independently of the viewer's
     *  engine (which otherwise supplies the expectation). */
    rows?: number[];
};

/** `preamble` is R run before the cases, after dplyr and data.table load
 *  (e.g. attaching bit64). */
function edgeSuite(title: string, frameR: string, objects: string[], cases: EdgeCase[], preamble = ''): void {
    describe.skipIf(!READY)(title, () => {
        const results = new Map<string, string>();
        const want = new Map<string, string>();
        const errors = new Map<string, string>();
        const viewerRows = new Map<string, number[]>();
        beforeAll(async () => {
            const tmp = mkdtempSync(join(tmpdir(), 'raven-dv-rcode-edge-'));
            const rds = join(tmp, 'df.rds');
            const w = await runR(`${frameR}\nsaveRDS(df, ${JSON.stringify(rds)})\nView(df)\n`);
            const files = readdirSync(w.dir).filter(f => f.endsWith('.arrow'));
            if (files.length !== 1) throw new Error(`View() wrote ${files.length} files\n${w.stderr}`);
            const rd = await ArrowSliceReader.open(join(w.dir, files[0]));
            const cols = rd.schema.columns;
            const script = [
                'suppressPackageStartupMessages({ library(dplyr); library(data.table) })',
                `df <- readRDS(${JSON.stringify(rds)})`,
                'dtobj <- data.table::as.data.table(df)',
                preamble,
            ];
            for (const c of cases) {
                const entries: FilterEntry[] = (c.filters ?? []).map((f, k) => ({
                    id: `f${k}`, columnIndex: f.ci, predicate: f.p, enabled: true, includeMissing: f.includeMissing ?? false,
                }));
                const keys: SortKey[] = (c.sort ?? []).map(s => ({ columnIndex: s.ci, direction: s.dir }));
                const ctx = { labelsOn: true, formatOn: true, digits: 3 };
                const rows = await computeFilteredIndices(rd, { entries, labelsOnWhenFiltered: true }, ctx);
                const perm = await computePermutation(rd, keys, { ...ctx, stringOrder: 'c', locale: LOCALE }, { rows });
                const keep = cols.map((col, i) => (c.hide ?? []).includes(i) ? null : col.name).filter(n => n !== null);
                want.set(c.name, `${Array.from(perm, r => r + 1).join(',')}\t${keep.join(',')}`);
                if (c.rows) viewerRows.set(c.name, Array.from(perm, r => r + 1));
                for (const obj of objects) {
                    for (const flavor of FLAVORS) {
                        const res = generateRCode({
                            expression: obj, sourceKind: 'data.frame', columns: cols,
                            sort: { keys, labelsOnWhenSorted: true, stringOrder: 'c' },
                            filter: { entries, labelsOnWhenFiltered: true },
                            hiddenColumns: c.hide ?? [], locale: LOCALE,
                        }, flavor);
                        const key = `${obj}|${flavor}|${c.name}`;
                        if ('error' in res) { errors.set(key, res.error); continue; }
                        script.push(`local({ out <- tryCatch({ out <- {\n${res.code}\n}; out }, error = function(e) { cat("@@", ${JSON.stringify(key)}, "\\tERROR: ", conditionMessage(e), "\\n", sep = ""); NULL }); if (!is.null(out)) cat("@@", ${JSON.stringify(key)}, "\\t", if (is.data.frame(out)) paste(out[["id"]], collapse = ",") else paste("NOT A FRAME:", deparse(out)), "\\t", paste(names(out), collapse = ","), "\\n", sep = "") })`);
                    }
                }
            }
            const scriptPath = join(tmp, 'edge.R');
            writeFileSync(scriptPath, script.join('\n'), 'utf8');
            const r = await runR(`source(${JSON.stringify(scriptPath)}, encoding = "UTF-8")`);
            for (const line of r.stdout.split('\n')) {
                const m = /^@@(.*?)\t(.*)$/.exec(line);
                if (m) results.set(m[1], m[2]);
            }
            await rd.close();
            if (results.size === 0 && errors.size === 0) throw new Error(`R produced no results:\n${r.stderr}`);
        }, 120_000);

        for (const c of cases) {
            if (c.rows) {
                test(`viewer: ${c.name}`, () => { expect(viewerRows.get(c.name)).toEqual(c.rows!); });
            }
            for (const obj of objects) {
                for (const flavor of FLAVORS) {
                    test(`${obj} ${flavor}: ${c.name}`, () => {
                        const key = `${obj}|${flavor}|${c.name}`;
                        if (c.refuse?.includes(flavor)) {
                            expect(errors.get(key)).toMatch(/copy the base R or data\.table code instead/);
                            return;
                        }
                        expect(errors.get(key)).toBeUndefined();
                        expect(results.get(key)).toBe(want.get(c.name)!);
                    });
                }
            }
        }
    });
}

// Duplicate names: the second `val` is a different column from the first;
// a reference by name would read the first one.
edgeSuite('Copy as R code round trip: duplicate column names (real R)',
    'df <- data.frame(id = 1:4, val = c(4L, 3L, 2L, 1L), val = c(0L, 100L, NA, 70L), check.names = FALSE)',
    ['df', 'dtobj'],
    [
        { name: 'filter the second val', filters: [{ ci: 2, p: { kind: 'numCompare', op: '>', value: 50 } }], refuse: ['dplyr'] },
        { name: 'sort by the second val', sort: [{ ci: 2, dir: 'desc' }], refuse: ['dplyr'] },
        { name: 'filter the first val, sort by the second', filters: [{ ci: 1, p: { kind: 'numCompare', op: '>=', value: 2 } }], sort: [{ ci: 2, dir: 'asc' }], refuse: ['dplyr'] },
        { name: 'hide the second val', hide: [2] },
    ]);

// Columns named like the code's own bindings (`dat`, `out`, `dt`) and
// like the object itself: inside `with()` or data.table's `[` such a
// column would shadow the binding a positional reference reads.
edgeSuite('Copy as R code round trip: columns named like the bindings (real R)',
    'df <- data.frame(id = 1:4, out = 4:1, dt = 4:1, dat = 4:1, df = 4:1, dtobj = 4:1, k = 1:4, k = c(9L, 0L, 7L, 5L), check.names = FALSE)',
    ['df', 'dtobj'],
    [
        { name: 'filter and sort the second k', filters: [{ ci: 7, p: { kind: 'numCompare', op: '>', value: 1 } }], sort: [{ ci: 7, dir: 'asc' }], refuse: ['dplyr'] },
        { name: 'filter by out, hide dt', filters: [{ ci: 1, p: { kind: 'numCompare', op: '<', value: 4 } }], sort: [{ ci: 7, dir: 'desc' }], hide: [2], refuse: ['dplyr'] },
    ]);

// Logical filters (data.table reads a lone symbol or a leading `!` in `i`
// specially) and hidden columns, against a data.frame and a data.table
// (base R's `[` dispatches to `[.data.table`).
edgeSuite('Copy as R code round trip: logical columns and data.table objects (real R)',
    'df <- data.frame(id = 1:5, b = c(TRUE, FALSE, NA, TRUE, NA), s = c("e", "d", "c", "b", "a"))',
    ['df', 'dtobj'],
    [
        { name: 'b is TRUE', filters: [{ ci: 1, p: { kind: 'bool', value: true } }] },
        { name: 'b is FALSE', filters: [{ ci: 1, p: { kind: 'bool', value: false } }] },
        { name: 'b is FALSE or missing', filters: [{ ci: 1, p: { kind: 'bool', value: false }, includeMissing: true }] },
        { name: 'b is TRUE, sorted by s', filters: [{ ci: 1, p: { kind: 'bool', value: true } }], sort: [{ ci: 2, dir: 'asc' }] },
        { name: 'hide b', hide: [1] },
        { name: 'hide all but id', hide: [1, 2] },
        { name: 'b is TRUE, hide b and s', filters: [{ ci: 1, p: { kind: 'bool', value: true } }], hide: [1, 2] },
    ]);

// Grouped and rowwise tibbles: the view is the flat table, so hiding a
// grouping column must drop it (dplyr's select() keeps grouping columns
// and moves them to the front). `plain` is the same data ungrouped.
edgeSuite('Copy as R code round trip: grouped and rowwise tibbles (real R)',
    `df <- dplyr::group_by(data.frame(id = 1:6, g = c("a", "b", "a", "b", "a", "b"),
    h = c(1L, 1L, 2L, 2L, 1L, 1L), x = c(3, 1, 2, 6, 5, 4)), g, h)`,
    ['df', 'rw', 'plain'],
    [
        { name: 'nothing hidden', rows: [1, 2, 3, 4, 5, 6] },
        { name: 'hide one grouping column', hide: [1], rows: [1, 2, 3, 4, 5, 6] },
        { name: 'hide both grouping columns', hide: [1, 2], rows: [1, 2, 3, 4, 5, 6] },
        { name: 'hide a column that is not grouped by', hide: [3], rows: [1, 2, 3, 4, 5, 6] },
        {
            name: 'filter, sort and hide a grouping column',
            filters: [{ ci: 3, p: { kind: 'numCompare', op: '>', value: 1 } }],
            sort: [{ ci: 3, dir: 'desc' }], hide: [1], rows: [4, 5, 6, 1, 3],
        },
    ],
    'rw <- dplyr::rowwise(dplyr::ungroup(df), g)\nplain <- as.data.frame(dplyr::ungroup(df))');

// Date-times: the engine and the code compare the same instants. `t`
// holds 2023-12-31, 2024-01-01, half a second later, NA and 2024-01-02
// (UTC); a half second is exact in a double and in microseconds.
edgeSuite('Copy as R code round trip: date-times (real R)',
    `df <- data.frame(id = 1:5)
df$t <- as.POSIXct(c(1703980800, 1704067200, 1704067200.5, NA, 1704153600), origin = "1970-01-01", tz = "UTC")`,
    ['df', 'dtobj'],
    [
        { name: 't = midnight', filters: [{ ci: 1, p: { kind: 'dateCompare', op: '=', value: '2024-01-01T00:00:00Z' } }], rows: [2] },
        { name: 't != midnight', filters: [{ ci: 1, p: { kind: 'dateCompare', op: '!=', value: '2024-01-01T00:00:00Z' } }], rows: [1, 3, 5] },
        { name: 't > midnight', filters: [{ ci: 1, p: { kind: 'dateCompare', op: '>', value: '2024-01-01T00:00:00Z' } }], rows: [3, 5] },
        { name: 't < midnight', filters: [{ ci: 1, p: { kind: 'dateCompare', op: '<', value: '2024-01-01T00:00:00Z' } }], rows: [1] },
        { name: 't <= half past', filters: [{ ci: 1, p: { kind: 'dateCompare', op: '<=', value: '2024-01-01T00:00:00.500Z' } }], rows: [1, 2, 3] },
        { name: 't between, with an offset', filters: [{ ci: 1, p: { kind: 'dateBetween', lo: '2024-01-01T01:00:00+01:00', hi: '2024-01-02T00:00:00Z', inclusive: true } }], rows: [2, 3, 5] },
        { name: 't not between, or missing', filters: [{ ci: 1, p: { kind: 'dateNotBetween', lo: '2024-01-01T00:00:00Z', hi: '2024-01-01T00:00:01Z', inclusive: true }, includeMissing: true }], rows: [1, 4, 5] },
    ]);

// Years past 9999 and before 0000: R reads neither `+010000-01-01` nor
// `-000001-01-01`, so the code counts from the epoch instead. `d` holds
// 9999-12-31, 10000-01-01, 10000-01-02 and NA; `t` the same instants at
// midnight UTC; `bc` the first days of the years -1, 0 and 1.
edgeSuite('Copy as R code round trip: years outside 0000 to 9999 (real R)',
    `df <- data.frame(id = 1:4)
df$d <- as.Date(c(2932896, 2932897, 2932898, NA), origin = "1970-01-01")
df$t <- as.POSIXct(c(2932896, 2932897, 2932898, NA) * 86400, origin = "1970-01-01", tz = "UTC")
df$bc <- as.Date(c(-719893, -719528, -719162, NA), origin = "1970-01-01")`,
    ['df', 'dtobj'],
    [
        { name: 'd = 10000-01-01', filters: [{ ci: 1, p: { kind: 'dateCompare', op: '=', value: '+010000-01-01' } }], rows: [2] },
        { name: 'd >= 10000-01-01', filters: [{ ci: 1, p: { kind: 'dateCompare', op: '>=', value: '+010000-01-01' } }], rows: [2, 3] },
        { name: 'd between 9999 and 10000', filters: [{ ci: 1, p: { kind: 'dateBetween', lo: '9999-12-31', hi: '+010000-01-01', inclusive: true } }], rows: [1, 2] },
        { name: 'd not between, or missing', filters: [{ ci: 1, p: { kind: 'dateNotBetween', lo: '+010000-01-01', hi: '+010000-01-01', inclusive: true }, includeMissing: true }], rows: [1, 3, 4] },
        { name: 'd after noon on 10000-01-01', filters: [{ ci: 1, p: { kind: 'dateCompare', op: '>', value: '+010000-01-01T12:00:00Z' } }], rows: [3] },
        { name: 't = 10000-01-01', filters: [{ ci: 2, p: { kind: 'dateCompare', op: '=', value: '+010000-01-01T00:00:00Z' } }], rows: [2] },
        { name: 't < 10000-01-01', filters: [{ ci: 2, p: { kind: 'dateCompare', op: '<', value: '+010000-01-01T00:00:00Z' } }], rows: [1] },
        { name: 't between 9999 and 10000', filters: [{ ci: 2, p: { kind: 'dateBetween', lo: '9999-12-31T00:00:00Z', hi: '+010000-01-01T00:00:00Z', inclusive: true } }], rows: [1, 2] },
        { name: 'bc = year -1', filters: [{ ci: 3, p: { kind: 'dateCompare', op: '=', value: '-000001-01-01' } }], rows: [1] },
        { name: 'bc > year -1', filters: [{ ci: 3, p: { kind: 'dateCompare', op: '>', value: '-000001-01-01' } }], rows: [2, 3] },
    ]);

// integer64: set values are decimal strings the double can't hold
// (Value Counts counts on the bigint), so the code compares them as
// integer64; comparisons and ranges compare the exact integers too, in
// the viewer and in the code (a bound past 2^53 is decimal text).
// `lab` carries integer64 value labels.
edgeSuite('Copy as R code round trip: integer64 (real R)',
    `df <- data.frame(id = 1:3)
df$big <- bit64::as.integer64(c("9007199254740992", "9007199254740993", "9007199254740993"))
df$small <- bit64::as.integer64(c("2", "3", NA))
lab <- df$big
labs <- bit64::as.integer64(c("9007199254740992", "9007199254740993"))
names(labs) <- c("even", "odd")
attr(lab, "labels") <- labs
df$lab <- lab
df$neg <- bit64::as.integer64(c("-1", "-2", NA))`,
    ['df', 'dtobj'],
    [
        { name: 'big in one exact value', filters: [{ ci: 1, p: { kind: 'setIn', values: ['9007199254740993'] } }] },
        { name: 'big not in one exact value', filters: [{ ci: 1, p: { kind: 'setNotIn', values: ['9007199254740993'] } }] },
        { name: 'big > 2^53', filters: [{ ci: 1, p: { kind: 'numCompare', op: '>', value: 9007199254740992 } }] },
        { name: 'big = 2^53', filters: [{ ci: 1, p: { kind: 'numCompare', op: '=', value: 9007199254740992 } }] },
        { name: 'big between 2^53 and 2^53', filters: [{ ci: 1, p: { kind: 'numBetween', lo: 9007199254740992, hi: 9007199254740992, inclusive: true } }] },
        { name: 'big = 2^53 + 1', filters: [{ ci: 1, p: { kind: 'numCompare', op: '=', value: '9007199254740993' } }] },
        { name: 'big != 2^53 + 1', filters: [{ ci: 1, p: { kind: 'numCompare', op: '!=', value: '9007199254740993' } }] },
        { name: 'big < 2^53 + 1', filters: [{ ci: 1, p: { kind: 'numCompare', op: '<', value: '9007199254740993' } }] },
        { name: 'big between 2^53 + 1 and int64 max', filters: [{ ci: 1, p: { kind: 'numBetween', lo: '9007199254740993', hi: '9223372036854775807', inclusive: true } }] },
        { name: 'big not between 2^53 + 1 and 2^53 + 1', filters: [{ ci: 1, p: { kind: 'numNotBetween', lo: '9007199254740993', hi: '9007199254740993', inclusive: true } }] },
        { name: 'big in a bin [2^53, 2^53 + 2)', filters: [{ ci: 1, p: { kind: 'numBetween', lo: 9007199254740992, hi: 9007199254740994, inclusive: true, upperInclusive: false } }] },
        { name: 'big >= -2^63 (below every integer64)', filters: [{ ci: 1, p: { kind: 'numCompare', op: '>=', value: '-9223372036854775808' } }] },
        { name: 'big > 1e30', filters: [{ ci: 1, p: { kind: 'numCompare', op: '>', value: 1e30 } }] },
        { name: 'labelled = odd code', filters: [{ ci: 3, p: { kind: 'numCompare', op: '=', value: '9007199254740993' } }] },
        { name: 'labelled = even code', filters: [{ ci: 3, p: { kind: 'numCompare', op: '=', value: 9007199254740992 } }] },
        { name: 'small >= 2.5', filters: [{ ci: 2, p: { kind: 'numCompare', op: '>=', value: 2.5 } }] },
        { name: 'small != 2.5', filters: [{ ci: 2, p: { kind: 'numCompare', op: '!=', value: 2.5 } }] },
        { name: 'small != 2.5 or missing', filters: [{ ci: 2, p: { kind: 'numCompare', op: '!=', value: 2.5 }, includeMissing: true }] },
        { name: 'small > Inf or missing', filters: [{ ci: 2, p: { kind: 'numCompare', op: '>', value: Infinity }, includeMissing: true }] },
        { name: 'small = 2.5', filters: [{ ci: 2, p: { kind: 'numCompare', op: '=', value: 2.5 } }] },
        { name: 'small < Inf', filters: [{ ci: 2, p: { kind: 'numCompare', op: '<', value: Infinity } }] },
        { name: 'small not between 2.5 and 9', filters: [{ ci: 2, p: { kind: 'numNotBetween', lo: 2.5, hi: 9, inclusive: true } }] },
        { name: 'small in 3 (a number)', filters: [{ ci: 2, p: { kind: 'setIn', values: ['3'] } }] },
        { name: 'labelled: odd', filters: [{ ci: 3, p: { kind: 'setIn', values: ['9007199254740993'] } }] },
        { name: 'labelled: even (a safe number)', filters: [{ ci: 3, p: { kind: 'setIn', values: [9007199254740992] } }] },
        { name: 'labelled: not odd', filters: [{ ci: 3, p: { kind: 'setNotIn', values: ['9007199254740993'] } }] },
        { name: 'sort by big desc', sort: [{ ci: 1, dir: 'desc' }, { ci: 0, dir: 'asc' }] },
        { name: 'sort by label', sort: [{ ci: 3, dir: 'desc' }, { ci: 0, dir: 'asc' }] },
        { name: 'neg in -1', filters: [{ ci: 4, p: { kind: 'setIn', values: [-1] } }] },
        { name: 'neg not in -2', filters: [{ ci: 4, p: { kind: 'setNotIn', values: ['-2'] } }] },
        // -2^63 is bit64's NA: it must not select the missing row.
        { name: 'neg in -2^63', filters: [{ ci: 4, p: { kind: 'setIn', values: ['-9223372036854775808'] } }] },
    ]);

// Sorting integer64: negatives, NA and values past 2^53, as the first key
// and as a second key with the other direction. Base R's order() reads an
// integer64 as its raw bits until bit64 is attached, and once it is
// attached refuses more than one key; the base R code sorts by
// bit64::keypos() instead.
const I64_SORT_FRAME = `df <- data.frame(id = 1:7, g = c(1L, 2L, 1L, 2L, 1L, 2L, 1L))
df$big <- bit64::as.integer64(c("-1", "5", "-3", "9007199254740993", "9007199254740992", NA, NA))`;
const I64_SORT: EdgeCase[] = [
    { name: 'big asc', sort: [{ ci: 2, dir: 'asc' }] },
    { name: 'big desc', sort: [{ ci: 2, dir: 'desc' }] },
    { name: 'g asc, big desc', sort: [{ ci: 1, dir: 'asc' }, { ci: 2, dir: 'desc' }] },
    { name: 'big asc, g desc', sort: [{ ci: 2, dir: 'asc' }, { ci: 1, dir: 'desc' }] },
    // rank.integer64() aborts R on a key that is all NA.
    { name: 'big missing only, sorted by big', filters: [{ ci: 2, p: { kind: 'isEmpty' } }], sort: [{ ci: 2, dir: 'asc' }] },
];
edgeSuite('Copy as R code round trip: integer64 sort keys, bit64 not attached (real R)',
    I64_SORT_FRAME, ['df', 'dtobj'], I64_SORT);
edgeSuite('Copy as R code round trip: integer64 sort keys, bit64 attached (real R)',
    I64_SORT_FRAME, ['df', 'dtobj'], I64_SORT, 'suppressPackageStartupMessages(library(bit64))');

// Comparisons alone, in a session where nothing has loaded bit64 yet:
// the operators dispatch to bit64 only once it is loaded, which
// evaluating the `bit64::as.integer64()` operand does.
// One R session per case: the first bit64 call loads it for the rest.
const I64_FRAME = `df <- data.frame(id = 1:3)
df$small <- bit64::as.integer64(c("2", "3", NA))`;
const I64_FRESH: EdgeCase[] = [
    { name: 'small >= 2.5', filters: [{ ci: 1, p: { kind: 'numCompare', op: '>=', value: 2.5 } }] },
    { name: 'small not in 3', filters: [{ ci: 1, p: { kind: 'setNotIn', values: ['3'] } }] },
    { name: 'small > 2 or missing', filters: [{ ci: 1, p: { kind: 'numCompare', op: '>', value: 2 }, includeMissing: true }] },
    { name: 'small is empty', filters: [{ ci: 1, p: { kind: 'isEmpty' } }] },
    { name: 'small = 3', filters: [{ ci: 1, p: { kind: 'numCompare', op: '=', value: 3 } }] },
    { name: 'small != 3', filters: [{ ci: 1, p: { kind: 'numCompare', op: '!=', value: 3 } }] },
    { name: 'small between 3 and 9', filters: [{ ci: 1, p: { kind: 'numBetween', lo: 3, hi: 9, inclusive: true } }] },
    { name: 'small not between 3 and 9', filters: [{ ci: 1, p: { kind: 'numNotBetween', lo: 3, hi: 9, inclusive: true } }] },
    { name: 'small < Inf', filters: [{ ci: 1, p: { kind: 'numCompare', op: '<', value: Infinity } }] },
];
for (const c of I64_FRESH) {
    edgeSuite(`Copy as R code round trip: integer64 with bit64 not loaded, ${c.name} (real R)`, I64_FRAME, ['df'], [c]);
}

// Infinite values picked in Value Counts: a labelled double (labels on 5)
// and a plain one.
edgeSuite('Copy as R code round trip: infinite set values (real R)',
    `df <- data.frame(id = 1:5)
x <- c(Inf, 0, 5, -Inf, NaN)
attr(x, "labels") <- c(five = 5)
df$x <- x
df$y <- c(Inf, 0, 5, -Inf, NaN)`,
    ['df', 'dtobj'],
    [
        { name: 'labelled: Inf', filters: [{ ci: 1, p: { kind: 'setIn', values: [Infinity] } }] },
        { name: 'labelled: not -Inf', filters: [{ ci: 1, p: { kind: 'setNotIn', values: [-Infinity] } }] },
        { name: 'labelled: NaN or missing', filters: [{ ci: 1, p: { kind: 'setIn', values: [NaN] }, includeMissing: true }] },
        { name: 'plain: Inf, -Inf (text from Value Counts)', filters: [{ ci: 2, p: { kind: 'setIn', values: ['Infinity', '-Infinity'] } }] },
        { name: 'plain: < Inf', filters: [{ ci: 2, p: { kind: 'numCompare', op: '<', value: Infinity } }] },
        { name: 'plain: between -Inf and 0', filters: [{ ci: 2, p: { kind: 'numBetween', lo: -Infinity, hi: 0, inclusive: true } }] },
    ]);

// Empty and duplicate names through the real writer (which addresses
// columns by position): the code reaches each column by position.
edgeSuite('Copy as R code round trip: empty and duplicate names from the writer (real R)',
    `df <- data.frame(id = 1:3, x = c(30, 10, 20), y = c(1, 2, 3))
names(df)[2] <- ""
df$d <- as.difftime(c(2, 1, 3), units = "hours")
df$e <- as.difftime(c(60, 180, 120), units = "mins")
names(df)[4:5] <- c("d", "d")`,
    ['df', 'dtobj'],
    [
        { name: 'filter the empty-named column', filters: [{ ci: 1, p: { kind: 'numCompare', op: '>', value: 15 } }], refuse: ['dplyr'] },
        { name: 'sort by the second d (minutes)', sort: [{ ci: 4, dir: 'asc' }], refuse: ['dplyr'] },
        { name: 'filter the first d (hours)', filters: [{ ci: 3, p: { kind: 'numCompare', op: '>=', value: 2 } }], refuse: ['dplyr'] },
        { name: 'hide the empty-named column', hide: [1], refuse: ['dplyr'] },
    ]);

// Dots names (`..1`, `...`): dplyr can't read one or select() around one it
// keeps, but an unreferenced one doesn't stop filter() or arrange().
edgeSuite('Copy as R code round trip: dots column names (real R)',
    'df <- setNames(data.frame(1:3, c(3L, 1L, 2L), 4:6, 7:9), c("id", "a", "..1", "..."))',
    ['df', 'dtobj'],
    [
        { name: 'filter a, ..1 unreferenced', filters: [{ ci: 1, p: { kind: 'numCompare', op: '>', value: 1 } }] },
        { name: 'sort by a, ..1 unreferenced', sort: [{ ci: 1, dir: 'asc' }] },
        { name: 'hide both dots columns', hide: [2, 3] },
        { name: 'filter ..1', filters: [{ ci: 2, p: { kind: 'numCompare', op: '>', value: 4 } }], refuse: ['dplyr'] },
        { name: 'sort by ...', sort: [{ ci: 3, dir: 'desc' }], refuse: ['dplyr'] },
        { name: 'hide a, keep ..1', hide: [1], refuse: ['dplyr'] },
    ]);
