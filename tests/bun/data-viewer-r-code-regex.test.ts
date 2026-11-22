// Regex filters in Copy as R code: every pattern `translateRegex` accepts
// must select, in R's `grepl(perl = TRUE)`, exactly the strings the
// viewer's JavaScript RegExp selects. The corpus crosses patterns with
// strings that separate the engines: CR, U+2028, a trailing LF, Unicode
// spaces, every character of the case-fold table, emoji, and ASCII.
// Skipped when R is missing.
import { beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'bun';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rString, translateRegex } from '../../editors/vscode/src/data-viewer/r-code';

const R_BIN = process.env.RAVEN_TEST_R_BIN ?? 'R';

async function hasR(): Promise<boolean> {
    try {
        const p = spawn({ cmd: [R_BIN, '--vanilla', '--quiet', '--no-echo', '-e', 'cat("OK")'], stdout: 'pipe', stderr: 'pipe' });
        const out = await new Response(p.stdout).text();
        await p.exited;
        return out.includes('OK');
    } catch {
        return false;
    }
}

const READY = await hasR();

const FOLD = 'Kk\u212aSs\u017fÅå\u212bß\u1e9eΘθ\u03d1\u03f4Ωω\u2126\u1f80\u1f88\u1f97\u1f9f\u1fa3\u1fab\u1fb3\u1fbc\u1fc3\u1fcc\u1ff3\u1ffc';
const STRINGS = [
    '', 'a', 'A', 'ab', 'AB', 'abc', 'xyz', 'file_10', 'File_2.csv', '9', '١', 'é', 'É', 'ﬀ', 'İ', 'ı', 'µ', 'μ', 'Μ',
    ...Array.from(FOLD), 'kelvin', 'KELVIN', '\u212aelvin', 'stress', 'STRESS', '\u017ftress', 'kiss', 'Straße', 'STRA\u1e9eE',
    '😀', 'a😀b', '😀😀', '😀a', 'x😀', '𐐀', '𐐨', 'foo😀bar', 'foo😀😀bar',
    'a\rb', 'a\nb', 'a\u2028b', 'a\u2029b', 'a\n', 'a\r\n', '\n', 'x y', 'x\u00a0y', 'x\u3000y', 'x\ufeffy', 'x\ty', 'x\u0085y', 'x\u000by',
    'a,b', ',', 'a-b', 'aa', 'a{ 2 }', 'a{,2}', 'a{2}', 'a]b', 'a^b', 'a$b', 'a\\b', 'foo bar', 'bar', 'FOO',
];
const PATTERNS = [
    'a', 'A', 'ab', '^a', 'a$', '^a$', 'b$', '^$', 'a.b', '^a.*b$', '.*', '^.*$', '^.+$', 'a.+', '.+b', '^a.*$', 'a.*?b',
    '\\s', '\\S+', 'x\\sy', '^\\s*$', '[\\s]', '[\\s,]', '\\w+', '^\\w+$', '\\W', '\\W*', '\\d', '^\\d+$', '\\D*', '\\bk', 'k\\b', '\\Bs',
    'k', 'K', 's', 'S', '^k$', '^s$', 'kelvin', 'stress', 'kiss', 'straße', 'STRASSE', '[a-z]+', '^[a-z]+$', '^[A-Z]$', '[k]', '[^k]*',
    '^[^k]*$', '^[^a-z]*$', '[k-m]', '[r-t]', '^[a-zA-Z]*$', '[\\w]', '^[\\w]+$', 'å', 'Å', 'θ', '\u03d1', 'Θ', 'ω', 'Ω', '[α-ω]', '^[θ-ω]$',
    'ß', '\u1e9e', '\u1f80', '\u1f88', 'é', 'É', 'µ', 'μ', 'ı', 'i', 'I',
    '^.$', '^..$', 'a.b', '[^a]', '^[^a]$', '\\S', '😀', '[😀]', '^.+.+$',
    // Class escapes inside brackets consume half an emoji in JS, as outside.
    'foo[\\W]{2}bar', '^[\\D]$', '^[\\Wa]$', '[\\D]*', 'foo[\\W]+bar',
    '(?:ab|k)s', 'sk*', '^(?<n>k)$', '(?<=k)s', '(?<!s)k', '(?=a)a', '(a|b)+', '(?:a.*)+', 'a{2}', 'a{1,}', 'x{', '}', ']', 'a]',
    '[\\]]', '[-a]', '[a-]', '\\.', '\\-', '\\/', 'file_\\d+', '^file_\\d+\\.csv$', 'a\\$b', '\\^', 'a\\\\b', '[$^]', '\\t', '\\n', '\\r',
    'foo|bar', '^(foo|bar)$', ',', '^[^,]*,.*$', '^a{ 2 }$', '^a{,2}$', '^a{2}$', 'a{2,}',
    // Repeats PCRE expands into copies (R refuses a compiled pattern past 64 KiB).
    '(?<a$b>x){0,10000}', '(?:x){0,1000}', '((x){0,200}){0,200}', 'k{0,5000}', 'x{0,60000}', '(?:ab){2,}',
    '(?:[\\d][\\w][\\d][\\w]){0,499}', '(?:[\\d][\\w]){0,600}((?:[\\d][\\w]){0,600})', '(?:[a-z]\\d){0,50}',
];

describe.skipIf(!READY)('regex translation agrees with the viewer in real R', () => {
    const r = new Map<string, string>();
    const cases: { key: string; pattern: string; cs: boolean; js: string }[] = [];
    let translated = 0;
    beforeAll(async () => {
        const lines = [`x <- c(${STRINGS.map(s => rString(s)).join(', ')})`];
        for (const pattern of PATTERNS) {
            for (const cs of [true, false]) {
                const t = translateRegex(pattern, cs);
                if (!('pcre' in t)) continue;
                translated++;
                const rx = new RegExp(pattern, cs ? '' : 'i');
                const key = `${cs ? 'cs' : 'ci'} ${JSON.stringify(pattern)}`;
                cases.push({ key, pattern, cs, js: STRINGS.map(s => (rx.test(s) ? '1' : '0')).join('') });
                lines.push(`cat("@@", ${rString(key)}, "\\t", tryCatch(paste(as.integer(grepl(${rString(t.pcre)}, x, perl = TRUE${cs ? '' : ', ignore.case = TRUE'})), collapse = ""), error = function(e) paste("ERROR", conditionMessage(e)), warning = function(w) paste("WARNING", conditionMessage(w))), "\\n", sep = "")`);
            }
        }
        const dir = mkdtempSync(join(tmpdir(), 'raven-dv-regex-'));
        const script = join(dir, 'regex.R');
        writeFileSync(script, lines.join('\n'), 'utf8');
        const p = spawn({
            cmd: [R_BIN, '--vanilla', '--quiet', '--no-echo', '-e', `source(${JSON.stringify(script)}, encoding = "UTF-8")`],
            env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
            stdout: 'pipe', stderr: 'pipe',
        });
        const stdout = await new Response(p.stdout).text();
        const stderr = await new Response(p.stderr).text();
        await p.exited;
        for (const line of stdout.split('\n')) {
            const m = /^@@(.*?)\t(.*)$/.exec(line);
            if (m) r.set(m[1], m[2]);
        }
        if (r.size === 0) throw new Error(`R produced no results:\n${stderr}`);
    }, 60_000);

    test('most of the corpus is translated, so the comparison has teeth', () => {
        expect(translated).toBeGreaterThan(PATTERNS.length);
    });

    test('every translated pattern selects the same strings in R as in JS', () => {
        const mismatches: string[] = [];
        for (const c of cases) {
            const got = r.get(c.key);
            if (got === c.js) continue;
            const diff = got && /^[01]+$/.test(got)
                ? STRINGS.filter((_, k) => got[k] !== c.js[k]).map(s => JSON.stringify(s)).join(', ')
                : got;
            mismatches.push(`${c.key}: ${diff}`);
        }
        expect(mismatches).toEqual([]);
    });
});
