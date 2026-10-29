// The R `View()` writer's file contract (design F1), checked with a real R
// subprocess through the bootstrap profile. No session port is set, so
// View() writes its Arrow file and skips the POST (no local socket needed).
// Skipped when R or the arrow package is unavailable.
import { describe, expect, test } from 'bun:test';
import { spawn } from 'bun';
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArrowSliceReader } from '../../editors/vscode/src/data-viewer/arrow-reader';
import {
    generate_profile_source,
    write_profile_file,
} from '../../editors/vscode/src/plot/r-bootstrap-profile';

const R_BIN = process.env.RAVEN_TEST_R_BIN ?? 'R';

async function rWith(pkg: string): Promise<boolean> {
    try {
        const p = spawn({
            cmd: [R_BIN, '--vanilla', '--quiet', '--no-echo', '-e',
                `cat(if (requireNamespace("${pkg}", quietly = TRUE)) "OK" else "NO")`],
            stdout: 'pipe', stderr: 'pipe',
        });
        const out = await new Response(p.stdout).text();
        await p.exited;
        return out.includes('OK');
    } catch {
        return false;
    }
}

const HAS_ARROW = await rWith('arrow');
const HAS_HAVEN = HAS_ARROW && (await rWith('haven'));

async function runR(rCode: string): Promise<{ stdout: string; stderr: string; files: string[] }> {
    const tmp = mkdtempSync(join(tmpdir(), 'raven-dv-writer-'));
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
            RAVEN_R_SESSION_ID: 'writer',
            RAVEN_SESSION_PORT: '',
            RAVEN_SESSION_TOKEN: '',
        },
        stdout: 'pipe', stderr: 'pipe',
    });
    const stdout = await new Response(p.stdout).text();
    const stderr = await new Response(p.stderr).text();
    await p.exited;
    const files = readdirSync(dv).filter(f => f.endsWith('.arrow')).map(f => join(dv, f));
    return { stdout, stderr, files };
}

function schemaMd(r: ArrowSliceReader): Map<string, string> {
    return (r as any).reader.schema.metadata;
}

function fieldsMd(r: ArrowSliceReader): Record<string, Record<string, string>> {
    return JSON.parse(schemaMd(r).get('raven.fields') ?? '{}');
}

describe('View() writer (real R)', () => {
    test.skipIf(!HAS_ARROW)('viewing never touches .Random.seed', async () => {
        const r = await runR([
            'set.seed(42); s0 <- .Random.seed',
            'View(data.frame(x = 1:3, y = c("a", "b", "c")))',
            'View(mtcars)',
            'cat("SEED_SAME=", identical(s0, .Random.seed), "\\n", sep = "")',
            // A session that never used the RNG must not gain a seed.
            'rm(.Random.seed, envir = globalenv()); View(1:5)',
            'cat("SEED_ABSENT=", !exists(".Random.seed", envir = globalenv()), "\\n", sep = "")',
        ].join('\n'));
        expect(r.stdout).toContain('SEED_SAME=TRUE');
        expect(r.stdout).toContain('SEED_ABSENT=TRUE');
        expect(r.files.length).toBe(3);
    }, 60_000);

    test.skipIf(!HAS_ARROW)('schema metadata: nrow, chunk_rows, session zone; type tags; subsecond digits', async () => {
        const r = await runR([
            'n <- 3L',
            'df <- data.frame(i = 1:3, d = c(1.5, NA, 3), s = c("a", NA, "c"), l = c(TRUE, NA, FALSE),',
            '  f = factor(c("x", "y", NA)), o = factor(c("x", "y", "x"), ordered = TRUE),',
            '  dt = as.Date("2024-01-01") + 0:2,',
            '  t0 = as.POSIXct("2024-01-01 12:00:00", tz = "UTC") + 0:2,',
            '  t3 = as.POSIXct("2024-01-01 12:00:00", tz = "UTC") + c(0, 0.5, 0.123),',
            '  t6 = as.POSIXct("2024-01-01 12:00:00", tz = "UTC") + c(0, 0.000001, NA),',
            '  dur = as.difftime(c(1, 2.25, 3), units = "mins"),',
            '  stringsAsFactors = FALSE)',
            'df$cp <- complex(real = 1:3, imaginary = 1)',
            'df$lst <- I(list(1, "a", TRUE))',
            'View(df)',
            'tz <- tryCatch(Sys.timezone(), error = function(e) NA_character_)',
            'if (is.null(tz) || length(tz) != 1L || is.na(tz) || !nzchar(tz)) tz <- Sys.getenv("TZ")',
            'if (!nzchar(tz)) tz <- "UTC"',
            'cat("SESSION_TZ=", tz, "\\n", sep = "")',
        ].join('\n'));
        expect(r.files.length).toBe(1);
        const reader = await ArrowSliceReader.open(r.files[0]);
        const md = schemaMd(reader);
        expect(md.get('raven.nrow')).toBe('3');
        expect(md.get('raven.chunk_rows')).toBe('65536');
        const tz = /^SESSION_TZ=(.*)$/m.exec(r.stdout)?.[1]?.trim();
        expect(md.get('raven.session_tz')).toBe(tz);
        const f = fieldsMd(reader);
        const tags = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v['raven.type_tag']]));
        expect(tags).toEqual({
            i: '<int>', d: '<dbl>', s: '<chr>', l: '<lgl>', f: '<fct>', o: '<ord>', dt: '<date>',
            t0: '<dttm>', t3: '<dttm>', t6: '<dttm>', dur: '<drtn mins>', cp: '<cpl>', lst: '<list>',
        });
        expect(f.t0['raven.subsecond_digits']).toBe('0');
        expect(f.t3['raven.subsecond_digits']).toBe('3');
        expect(f.t6['raven.subsecond_digits']).toBe('6');
        expect(f.dur['raven.subsecond_digits']).toBe('0');   // 2.25 min = 135 s
        expect(f.d['raven.subsecond_digits']).toBeUndefined();
        // Existing conventions survive alongside the new keys.
        expect(f.o['raven.original_class']).toBe('ordered/factor');
        expect(reader.geometrySource).toBe('metadata');
        await reader.close();
    }, 60_000);

    test.skipIf(!HAS_HAVEN)('value-labelled columns get +lbl tags', async () => {
        const r = await runR([
            'df <- data.frame(id = 1:2)',
            'df$a <- haven::labelled(c(1, 2), c(lo = 1, hi = 2))',
            'df$b <- haven::labelled(c(1L, 2L), c(lo = 1L, hi = 2L))',
            'df$c <- haven::labelled(c("x", "y"), c(Ex = "x"))',
            'View(df)',
        ].join('\n'));
        const reader = await ArrowSliceReader.open(r.files[0]);
        const f = fieldsMd(reader);
        expect(f.a['raven.type_tag']).toBe('<dbl+lbl>');
        expect(f.b['raven.type_tag']).toBe('<int+lbl>');
        expect(f.c['raven.type_tag']).toBe('<chr+lbl>');
        await reader.close();
    }, 60_000);

    test.skipIf(!HAS_ARROW)('chunk_rows scales with width: 1,024-row batches at 2,100 doubles', async () => {
        const r = await runR([
            'm <- matrix(as.double(seq_len(2100L * 2500L)), nrow = 2500L)',
            'df <- as.data.frame(m)',
            'View(df)',
        ].join('\n'));
        const reader = await ArrowSliceReader.open(r.files[0]);
        // max(1024, min(65536, 2^21 %/% 2100)) = 1024.
        expect(schemaMd(reader).get('raven.chunk_rows')).toBe('1024');
        expect(reader.geometrySource).toBe('metadata');
        expect(Array.from(reader.batchStarts)).toEqual([0, 1024, 2048, 2500]);
        await reader.close();
    }, 60_000);

    test.skipIf(!HAS_ARROW)('arrow never writes a batch longer than chunk_size, even for a chunked column', async () => {
        // The premise behind arithmetic batch starts. A character column over
        // 2 GB arrives as a multi-chunk array; arrow then splits batches at
        // chunk boundaries too, so batches can be shorter (irregular) but
        // never longer. The reader's checks must reject the metadata then.
        const r = await runR([
            'tbl <- arrow::Table$create(',
            '  s = arrow::chunked_array(as.character(1:3), as.character(4:7), as.character(8:10)),',
            '  x = arrow::chunked_array(1:10))',
            'tbl <- tbl$ReplaceSchemaMetadata(list("raven.nrow" = "10", "raven.chunk_rows" = "4"))',
            'arrow::write_feather(tbl, file.path(Sys.getenv("RAVEN_DATA_VIEWER_DIR"), "chunked.arrow"),',
            '  chunk_size = 4L, compression = "uncompressed")',
        ].join('\n'));
        const reader = await ArrowSliceReader.open(r.files[0]);
        const starts = Array.from(reader.batchStarts);
        const lengths = starts.slice(1).map((s, i) => s - starts[i]);
        expect(Math.max(...lengths)).toBeLessThanOrEqual(4);
        expect(lengths.reduce((a, b) => a + b, 0)).toBe(10);
        // Irregular (3/4/3 or finer), so the metadata check fails and the
        // reader parsed headers instead of trusting chunk_rows.
        expect(reader.geometrySource).toBe('headers');
        const out = await reader.getRows({ start: 0, end: 10, columns: [0, 1], viewportGeneration: 1 });
        expect(out.rows.map(row => row[0])).toEqual(Array.from({ length: 10 }, (_, i) => String(i + 1)));
        await reader.close();
    }, 60_000);

    test.skipIf(!HAS_ARROW)('rownames: explicit kept, compact and zero-row never materialized', async () => {
        const r = await runR([
            'View(mtcars)',                                     // explicit character rownames
            'View(data.frame(x = 1:3))',                        // compact automatic
            'View(data.frame(x = integer()))',                  // zero rows
            'View(data.frame(x = 1:3, row.names = c(5L, 7L, 9L)))', // explicit integer rownames
        ].join('\n'));
        expect(r.files.length).toBe(4);
        const readers = await Promise.all(r.files.sort().map(f => ArrowSliceReader.open(f)));
        const [mt, compact, empty, intRn] = readers;
        const mtCols = mt.schema.columns;
        expect(mtCols[0].name).toBe('rowname');
        expect(mtCols[0].isRowname).toBe(true);
        expect(mtCols[0].typeTag).toBe('<chr>');
        expect(mtCols.slice(1).map(c => c.name)).toEqual(
            ['mpg', 'cyl', 'disp', 'hp', 'drat', 'wt', 'qsec', 'vs', 'am', 'gear', 'carb']);
        const first = await mt.getRows({ start: 0, end: 2, columns: [0, 1], viewportGeneration: 1 });
        expect(first.rows).toEqual([['Mazda RX4', 21], ['Mazda RX4 Wag', 21]]);
        expect(compact.schema.columns.map(c => c.name)).toEqual(['x']);
        expect(empty.schema.columns.map(c => c.name)).toEqual(['x']);
        expect(intRn.schema.columns.map(c => c.name)).toEqual(['rowname', 'x']);
        const ir = await intRn.getRows({ start: 0, end: 3, columns: [0], viewportGeneration: 1 });
        expect(ir.rows.map(row => row[0])).toEqual(['5', '7', '9']);
        await Promise.all(readers.map(x => x.close()));
    }, 60_000);

    test.skipIf(!HAS_ARROW)('rownames: an existing rowname column becomes .rowname, then ..rowname', async () => {
        const r = await runR([
            'df <- data.frame(rowname = c("p", "q"), v = 1:2, row.names = c("a", "b"))',
            'View(df)',
            'df2 <- data.frame(rowname = 1:2, .rowname = 3:4, row.names = c("a", "b"))',
            'View(df2)',
            'm <- matrix(1:4, 2, dimnames = list(c("r1", "r2"), c("rowname", "z")))',
            'View(m)',
        ].join('\n'));
        const readers = await Promise.all(r.files.sort().map(f => ArrowSliceReader.open(f)));
        const [a, b, m] = readers;
        expect(a.schema.columns.map(c => c.name)).toEqual(['.rowname', 'rowname', 'v']);
        expect(a.schema.columns.map(c => !!c.isRowname)).toEqual([true, false, false]);
        expect(b.schema.columns.map(c => c.name)).toEqual(['..rowname', 'rowname', '.rowname']);
        expect(m.schema.columns.map(c => c.name)).toEqual(['.rowname', 'rowname', 'z']);
        expect(m.schema.columns[0].isRowname).toBe(true);
        const rows = await a.getRows({ start: 0, end: 2, columns: [0, 1], viewportGeneration: 1 });
        expect(rows.rows).toEqual([['a', 'p'], ['b', 'q']]);
        await Promise.all(readers.map(x => x.close()));
    }, 60_000);

    test.skipIf(!HAS_ARROW)('rownames keep column attributes (labels, factor levels) intact', async () => {
        const r = await runR([
            'df <- data.frame(f = factor(c("lo", "hi")), n = c(1.5, 2), row.names = c("a", "b"))',
            'attr(df$n, "label") <- "A number"',
            'View(df)',
        ].join('\n'));
        const reader = await ArrowSliceReader.open(r.files[0]);
        const cols = reader.schema.columns;
        expect(cols.map(c => c.name)).toEqual(['rowname', 'f', 'n']);
        expect(cols[1].typeTag).toBe('<fct>');
        expect(cols[1].dictionary).toEqual(['hi', 'lo']);
        expect(cols[2].variableLabel).toBe('A number');
        await reader.close();
    }, 60_000);

    test.skipIf(!HAS_ARROW)('compact rownames at 1e7 rows are never materialized', async () => {
        // A materialized character rowname column would add ~80 MB and
        // seconds; the frame must come through with just its own column.
        const r = await runR([
            'df <- data.frame(x = seq_len(1e7))',
            't0 <- proc.time()[["elapsed"]]',
            'stopifnot(.row_names_info(df, 1L) < 0L)',
            'View(df)',
            'cat("ELAPSED=", proc.time()[["elapsed"]] - t0, "\\n", sep = "")',
        ].join('\n'));
        const reader = await ArrowSliceReader.open(r.files[0]);
        expect(reader.schema.columns.map(c => c.name)).toEqual(['x']);
        expect(reader.nrow).toBe(10_000_000);
        const elapsed = Number(/ELAPSED=([\d.]+)/.exec(r.stdout)?.[1]);
        expect(elapsed).toBeLessThan(20);
        await reader.close();
    }, 120_000);

    test.skipIf(!HAS_ARROW)('POSIXct without a tzone takes the session zone; NA and NaN round-trip distinctly', async () => {
        const r = await runR([
            'Sys.setenv(TZ = "America/Chicago")',
            // as.POSIXct() without tz gives tzone "", which arrow writes
            // with no zone: R shows it in the session zone.
            't <- as.POSIXct(c("2024-07-01 09:00:00", "2024-07-02 09:00:00"))',
            'stopifnot(identical(attr(t, "tzone"), ""))',
            'df <- data.frame(t = t, u = as.POSIXct(c("2024-07-01", "2024-07-02"), tz = "Asia/Tokyo"),',
            '  d = c(NA_real_, NaN))',
            'View(df)',
        ].join('\n'));
        const reader = await ArrowSliceReader.open(r.files[0]);
        const [t, u] = reader.schema.columns;
        expect(u.timeZone).toBe('Asia/Tokyo');
        expect(u.timeZoneSource).toBe('column');
        expect(t.timeZoneSource).toBe('session');
        expect(t.timeZone).toBe(schemaMd(reader).get('raven.session_tz'));
        const rows = await reader.getRows({ start: 0, end: 2, columns: [2], viewportGeneration: 1 });
        expect(rows.rows.map(x => x[0])).toEqual([null, { _: 'nan' }]);
        await reader.close();
    }, 60_000);
});
