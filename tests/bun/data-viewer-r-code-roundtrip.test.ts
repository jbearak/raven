// Copy as R code round trip: R writes a frame through the real `View()`
// writer, the viewer's filter and sort engines compute the rows on screen,
// and R evaluates the emitted dplyr, base R and data.table code against the
// same frame. The `id` column (1..n) identifies rows, so each case compares
// R's row order with the viewer's permutation. Skipped when R, arrow,
// dplyr, data.table, stringr or haven is missing.
import { beforeAll, describe, expect, test } from 'bun:test';
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
