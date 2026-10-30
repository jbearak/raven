// Copy as R code: the generator's text (the R round trip lives in
// data-viewer-r-code-roundtrip.test.ts).
import { describe, expect, test } from 'bun:test';
import type { ColumnSchema } from '../../editors/vscode/src/data-viewer/arrow-reader';
import { generateRCode, pcreCompatible, rName, rNumber, rString } from '../../editors/vscode/src/data-viewer/r-code';
import { EMPTY_FILTER, EMPTY_SORT } from '../../editors/vscode/src/data-viewer/messages';

function col(name: string, arrowType: string, extra: Partial<ColumnSchema> = {}): ColumnSchema {
    return { name, arrowType, dictionaryShipped: false, isInteger: false, ...extra };
}

const COLS: ColumnSchema[] = [
    col('rowname', 'Utf8', { isRowname: true, typeTag: '<chr>' }),
    col('mpg', 'Float64', { typeTag: '<dbl>' }),
    col('cyl', 'Float64', { typeTag: '<dbl>' }),
    col('my name', 'Utf8', { typeTag: '<chr>' }),
];

function gen(over: Partial<Parameters<typeof generateRCode>[0]>, flavor: 'dplyr' | 'base' | 'data.table' = 'dplyr') {
    return generateRCode({
        expression: 'mtcars',
        sourceKind: 'data.frame',
        columns: COLS,
        sort: EMPTY_SORT,
        filter: EMPTY_FILTER,
        hiddenColumns: [],
        locale: 'en',
        ...over,
    }, flavor);
}

describe('R literals', () => {
    test('names are backticked only when needed', () => {
        expect(rName('mpg')).toBe('mpg');
        expect(rName('.x')).toBe('.x');
        expect(rName('my name')).toBe('`my name`');
        expect(rName('if')).toBe('`if`');
        expect(rName('2x')).toBe('`2x`');
        expect(rName('a`b')).toBe('`a\\`b`');
    });
    test('strings escape quotes, backslashes and control characters, keep non-ASCII', () => {
        expect(rString('a"b\\c\n\t')).toBe('"a\\"b\\\\c\\n\\t"');
        expect(rString('café')).toBe('"café"');
        expect(rString('\u0001')).toBe('"\\x01"');
    });
    test('numbers read back exactly', () => {
        expect(rNumber(0.1 + 0.2)).toBe('0.30000000000000004');
        expect(rNumber(1e-7)).toBe('1e-7');
        expect(rNumber(-Infinity)).toBe('-Inf');
    });
});

describe('generateRCode', () => {
    test('no transforms: the expression itself, with the header', () => {
        const r = gen({});
        expect('code' in r && r.code).toBe('# mtcars as shown in Raven\'s data viewer\n# Requires R >= 4.1 (|>), dplyr >= 1.1.0\n\nlibrary(dplyr)\n\nmtcars\n');
    });

    test('dplyr: filter, arrange with desc and the NaN tie-break, select', () => {
        const r = gen({
            filter: { entries: [{ id: 'a', columnIndex: 2, predicate: { kind: 'setIn', values: [6, 8] }, enabled: true, includeMissing: false }], labelsOnWhenFiltered: true },
            sort: { keys: [{ columnIndex: 1, direction: 'desc' }], labelsOnWhenSorted: true },
            hiddenColumns: [3],
        });
        if (!('code' in r)) throw new Error(r.error);
        expect(r.code).toContain('mtcars |>\n  filter(cyl %in% c(6, 8)) |>\n  arrange(desc(mpg), is.na(mpg) & !is.nan(mpg)) |>\n  select(-`my name`)');
    });

    test('known NaN-free double sorts need no tie-break', () => {
        const r = gen({
            sort: { keys: [{ columnIndex: 1, direction: 'asc' }], labelsOnWhenSorted: true },
            noNaN: () => true,
        });
        expect('code' in r && r.code).toContain('arrange(mpg)');
    });

    test('string orders: C uses .locale, Natural uses str_rank and names stringr', () => {
        const c = gen({ sort: { keys: [{ columnIndex: 3, direction: 'asc' }], labelsOnWhenSorted: true, stringOrder: 'c' } });
        expect('code' in c && c.code).toContain('arrange(`my name`, .locale = "C")');
        const l = gen({ sort: { keys: [{ columnIndex: 3, direction: 'desc' }], labelsOnWhenSorted: true, stringOrder: 'locale' } });
        expect('code' in l && l.code).toContain('arrange(desc(`my name`), .locale = "en")');
        expect('code' in l && l.code).toContain('stringi');
        const n = gen({ sort: { keys: [{ columnIndex: 3, direction: 'asc' }], labelsOnWhenSorted: true } });
        expect('code' in n && n.code).toContain('arrange(stringr::str_rank(`my name`, locale = "en", numeric = TRUE))');
        expect('code' in n && n.code).toContain('stringr >= 1.5.0');
        expect('code' in n && n.code).toContain('ICU');
    });

    test('row names: dplyr and data.table materialize them, base R uses rownames()', () => {
        const filter = { entries: [{ id: 'a', columnIndex: 0, predicate: { kind: 'strStartsWith' as const, value: 'Merc', caseSensitive: true }, enabled: true, includeMissing: false }], labelsOnWhenFiltered: true };
        const d = gen({ filter });
        expect('code' in d && d.code).toContain('tibble::rownames_to_column("rowname") |>\n  filter(startsWith(as.character(rowname), "Merc"))');
        const dt = gen({ filter }, 'data.table');
        expect('code' in dt && dt.code).toContain('as.data.table(mtcars, keep.rownames = "rowname")');
        const b = gen({ filter }, 'base');
        expect('code' in b && b.code).toContain('out <- mtcars[which(with(mtcars, startsWith(as.character(rownames(mtcars)), "Merc"))), , drop = FALSE]');
    });

    test('complex expressions are parenthesized at the head of a pipe', () => {
        const filter = { entries: [{ id: 'a', columnIndex: 1, predicate: { kind: 'isNotEmpty' as const }, enabled: true, includeMissing: false }], labelsOnWhenFiltered: true };
        expect(('code' in gen({ expression: 'subset(mtcars, cyl > 4)', filter })) && (gen({ expression: 'subset(mtcars, cyl > 4)', filter }) as { code: string }).code)
            .toContain('subset(mtcars, cyl > 4) |>');
        expect((gen({ expression: 'a + b', filter }) as { code: string }).code).toContain('(a + b) |>');
        expect((gen({ expression: 'f(x)[1:3, ]', filter }) as { code: string }).code).toContain('(f(x)[1:3, ]) |>');
    });

    test('matrices become data frames; vectors and lists are refused', () => {
        const m = gen({ sourceKind: 'matrix', hiddenColumns: [1] }, 'base');
        expect('code' in m && m.code).toContain('dat <- as.data.frame(mtcars)');
        expect(gen({ sourceKind: 'vector' })).toEqual({ error: expect.stringContaining('data frames and matrices') });
        expect(gen({ expression: '  ' })).toEqual({ error: expect.stringContaining('unknown') });
    });

    test('duplicate names hide by position, skipping row names R does not have', () => {
        const cols = [...COLS, col('mpg', 'Float64')];
        const r = gen({ columns: cols, hiddenColumns: [4] });
        expect('code' in r && r.code).toContain('select(-4)');
    });

    test('regex filters are written only when JS and PCRE read the pattern alike', () => {
        const regex = (pattern: string) => gen({
            filter: { entries: [{ id: 'r', columnIndex: 3, predicate: { kind: 'strRegex', pattern, caseSensitive: true }, enabled: true, includeMissing: false }], labelsOnWhenFiltered: true },
        });
        const ok = regex('^file_\\d+\\.csv$');
        expect('code' in ok && ok.code).toContain('grepl("^file_\\\\d+\\\\.csv$"');
        for (const pattern of ['\\u0061', '\\x{61}a\\cJ', '[^]', '\\p{L}', '\\k', '\\0', '\\v']) {
            const r = regex(pattern);
            expect([pattern, 'code' in r && r.code.includes('grepl(')]).toEqual([pattern, false]);
            expect('code' in r && r.code).toContain('# Not translated: filter on my name (strRegex)');
        }
    });

    test('pcreCompatible allows the shared subset only', () => {
        for (const p of ['abc', '^a.*b$', '[a-z]+\\d{2,3}', '(foo|bar)\\b', 'a\\.b\\/c\\-d', '\\s\\S\\w\\W'])
            expect([p, pcreCompatible(p)]).toEqual([p, true]);
        for (const p of ['\\u0061', '\\cA', '[^]', '\\p{L}', '\\1\\0', '\\v', 'trailing\\'])
            expect([p, pcreCompatible(p)]).toEqual([p, false]);
    });

    test('untranslatable filters are named in a comment, not approximated', () => {
        const cols = [...COLS, col('when', 'Timestamp<MICROSECOND>', { typeTag: '<dttm>' })];
        const r = gen({
            columns: cols,
            filter: { entries: [{ id: 'a', columnIndex: 4, predicate: { kind: 'setIn', values: ['x'] }, enabled: true, includeMissing: false }], labelsOnWhenFiltered: true },
        });
        expect('code' in r && r.code).toContain('# Not translated: filter on when (setIn)');
        expect('code' in r && r.code).not.toContain('filter(');
    });
});
