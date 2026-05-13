/// <reference types="mocha" />

/**
 * Structural tests for problem-matcher contributions in package.json.
 *
 * The $testthat matcher parses test-failure headers emitted by testthat 3.x.
 * Three distinct reporters are in active use and the matcher must handle all
 * three. Samples below were captured from `testthat 3.3.2` + `devtools 2.5.2`
 * running against a temporary package with three failing tests.
 *
 *   ProgressReporter (default for `devtools::test()` / `testthat::test_dir()`):
 *     Failure ('test-sample.R:2:3'): expect_equal mismatch
 *     Error   ('test-sample.R:6:3'): error inside test
 *
 *   CompactProgressReporter:
 *     ── Failure ('test-sample.R:2:3'): expect_equal mismatch ───────────────
 *     ── Error   ('test-sample.R:6:3'): error inside test ───────────────────
 *
 *   LlmReporter — auto-selected when CLAUDECODE / AGENT / GEMINI_CLI /
 *   CURSOR_AGENT env vars are set, so CI agents and reviewers running under
 *   Claude / Gemini / Cursor see this form (not what end users get in
 *   VS Code's terminal, but the matcher handles it for completeness):
 *     FAILURE: 'test-sample.R:2:3' ----------------------
 *     ERROR:   'test-sample.R:6:3' ------------------------
 *
 * Common shape: a single-quoted location `'file:line:col'`. Test name is
 * absent in the LlmReporter form.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

declare const suite: Mocha.SuiteFunction;
declare const test: Mocha.TestFunction;

const vscodeRoot = path.resolve(__dirname, '..', '..');
const packageJsonPath = path.join(vscodeRoot, 'package.json');

interface ProblemPattern {
    regexp: string;
    file?: number;
    line?: number;
    column?: number;
    severity?: number;
    message?: number;
    code?: number;
    location?: number;
    endLine?: number;
    endColumn?: number;
    loop?: boolean;
}

interface ProblemMatcherContribution {
    name?: string;
    label?: string;
    owner?: string;
    source?: string;
    applyTo?: string;
    fileLocation?: string | [string, string];
    severity?: string;
    pattern: ProblemPattern | ProblemPattern[];
}

function loadProblemMatchers(): ProblemMatcherContribution[] {
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw) as {
        contributes?: { problemMatchers?: ProblemMatcherContribution[] };
    };
    return pkg.contributes?.problemMatchers ?? [];
}

function getTestthatMatcher(): ProblemMatcherContribution {
    const matchers = loadProblemMatchers();
    const matcher = matchers.find((m) => m.name === 'testthat');
    assert.ok(matcher, 'package.json must declare a problemMatcher named "testthat"');
    return matcher;
}

function singlePattern(matcher: ProblemMatcherContribution): ProblemPattern {
    assert.ok(
        !Array.isArray(matcher.pattern),
        'testthat matcher should declare a single-line pattern',
    );
    return matcher.pattern as ProblemPattern;
}

suite('problem matcher contributions', () => {
    test('declares a testthat matcher with the expected top-level shape', () => {
        const matcher = getTestthatMatcher();

        assert.strictEqual(
            matcher.owner,
            'raven-testthat',
            'owner must be a stable identifier so diagnostics are scoped to this matcher',
        );
        assert.strictEqual(
            matcher.source,
            'testthat',
            'source should label diagnostics with their tool of origin',
        );
        assert.strictEqual(matcher.severity, 'error');
        assert.ok(
            Array.isArray(matcher.fileLocation),
            'fileLocation must be a tuple [mode, baseDir]',
        );
        const [mode, base] = matcher.fileLocation as [string, string];
        assert.strictEqual(
            mode,
            'relative',
            'testthat reports paths relative to tests/testthat',
        );
        assert.strictEqual(
            base,
            '${workspaceFolder}/tests/testthat',
            'base directory must point at tests/testthat under the workspace folder',
        );
    });

    test('pattern uses the documented capture-group indices', () => {
        const pattern = singlePattern(getTestthatMatcher());
        assert.strictEqual(pattern.file, 3);
        assert.strictEqual(pattern.line, 4);
        assert.strictEqual(pattern.column, 5);
        assert.strictEqual(pattern.message, 6);
    });

    test('regex compiles as a JavaScript RegExp', () => {
        const pattern = singlePattern(getTestthatMatcher());
        assert.doesNotThrow(
            () => new RegExp(pattern.regexp),
            `pattern.regexp must be a valid JS RegExp: ${pattern.regexp}`,
        );
    });
});

interface ExpectedCapture {
    file: string;
    line: string;
    column?: string;
    message?: string;
}

suite('testthat regex captures (real reporter output)', () => {
    function regex(): RegExp {
        return new RegExp(singlePattern(getTestthatMatcher()).regexp);
    }

    function expectMatch(sample: string, expected: ExpectedCapture): void {
        const m = sample.match(regex());
        assert.ok(m, `expected match for: ${JSON.stringify(sample)}`);
        const pattern = singlePattern(getTestthatMatcher());
        assert.strictEqual(m[pattern.file!], expected.file, 'file capture');
        assert.strictEqual(m[pattern.line!], expected.line, 'line capture');
        assert.strictEqual(m[pattern.column!], expected.column, 'column capture');
        assert.strictEqual(m[pattern.message!], expected.message, 'message capture');
    }

    suite('ProgressReporter (default for devtools::test / testthat::test_dir)', () => {
        test('failure header captures file, line, column, test name', () => {
            expectMatch(
                "Failure ('test-sample.R:2:3'): expect_equal mismatch",
                {
                    file: 'test-sample.R',
                    line: '2',
                    column: '3',
                    message: 'expect_equal mismatch',
                },
            );
        });

        test('error header captures file, line, column, test name', () => {
            expectMatch(
                "Error ('test-sample.R:6:3'): error inside test",
                {
                    file: 'test-sample.R',
                    line: '6',
                    column: '3',
                    message: 'error inside test',
                },
            );
        });

        test('captures a verbose test name', () => {
            expectMatch(
                "Failure ('test-sample.R:10:3'): multi-line description that should be captured",
                {
                    file: 'test-sample.R',
                    line: '10',
                    column: '3',
                    message: 'multi-line description that should be captured',
                },
            );
        });
    });

    suite('CompactProgressReporter', () => {
        test('failure header with surrounding box rule', () => {
            expectMatch(
                "── Failure ('test-sample.R:2:3'): expect_equal mismatch ────────────────────────",
                {
                    file: 'test-sample.R',
                    line: '2',
                    column: '3',
                    message: 'expect_equal mismatch',
                },
            );
        });

        test('error header with surrounding box rule', () => {
            expectMatch(
                "── Error ('test-sample.R:6:3'): error inside test ──────────────────────────────",
                {
                    file: 'test-sample.R',
                    line: '6',
                    column: '3',
                    message: 'error inside test',
                },
            );
        });

        test('ASCII fallback rule (cli.unicode=FALSE)', () => {
            expectMatch(
                "-- Failure ('test-sample.R:2:3'): expect_equal mismatch ----",
                {
                    file: 'test-sample.R',
                    line: '2',
                    column: '3',
                    message: 'expect_equal mismatch',
                },
            );
        });
    });

    suite('LlmReporter (CLAUDECODE/AGENT env active)', () => {
        test('FAILURE: header captures file, line, column (no test name)', () => {
            expectMatch(
                "FAILURE: 'test-sample.R:2:3' ----------------------",
                {
                    file: 'test-sample.R',
                    line: '2',
                    column: '3',
                    message: undefined,
                },
            );
        });

        test('ERROR: header captures file, line, column (no test name)', () => {
            expectMatch(
                "ERROR: 'test-sample.R:6:3' ------------------------",
                {
                    file: 'test-sample.R',
                    line: '6',
                    column: '3',
                    message: undefined,
                },
            );
        });
    });

    suite('Edge cases', () => {
        test('header without column (srcref missing column info)', () => {
            expectMatch(
                "Failure ('test-sample.R:2'): no column captured",
                {
                    file: 'test-sample.R',
                    line: '2',
                    column: undefined,
                    message: 'no column captured',
                },
            );
        });

        test('file path with hyphens and dots', () => {
            expectMatch(
                "Failure ('test-foo.bar.baz-2.R:1:1'): odd-name",
                {
                    file: 'test-foo.bar.baz-2.R',
                    line: '1',
                    column: '1',
                    message: 'odd-name',
                },
            );
        });

        test('test name containing ASCII dashes', () => {
            expectMatch(
                "── Failure ('test-foo.R:9:1'): name with -- inside ──",
                {
                    file: 'test-foo.R',
                    line: '9',
                    column: '1',
                    message: 'name with -- inside',
                },
            );
        });
    });

    suite('Negative cases', () => {
        const negatives = [
            '',
            'Expected 1 to equal 2.',
            'Differences:',
            '[ FAIL 3 | WARN 0 | SKIP 0 | PASS 0 ]',
            '────────────────────────────────────────────────────────────────────────────────',
            '✖ | 3        0 | sample',
            '> devtools::test()',
            'Some random text',
            "── Skip ('test-foo.R:7:3'): not on CI ──",
            "── Skipped ('test-foo.R:7:3'): not on CI ──",
            "WARNING: 'test-foo.R:1:1' ----",
            // Old (pre-3.0) testthat shape — not supported; verifies we don't
            // accidentally fall back to the prior over-broad matcher.
            '── Failure (test-foo.R:12:3): unquoted location ──',
        ];

        for (const sample of negatives) {
            test(`rejects: ${JSON.stringify(sample)}`, () => {
                const m = sample.match(regex());
                assert.strictEqual(m, null);
            });
        }
    });
});
