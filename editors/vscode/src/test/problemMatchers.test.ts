/// <reference types="mocha" />

/**
 * Structural tests for problem-matcher contributions in package.json.
 *
 * The $testthat matcher parses failure headers emitted by testthat's default
 * progress reporter so VS Code can surface failing tests in the Problems panel
 * with clickable file:line links.
 *
 * Tests are pure file/JSON assertions — they parse the regex out of
 * package.json and exercise it against captured testthat output samples,
 * which keeps the matcher honest without needing to spawn R or VS Code's
 * task runner.
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
        assert.strictEqual(pattern.file, 2);
        assert.strictEqual(pattern.line, 3);
        assert.strictEqual(pattern.column, 4);
        assert.strictEqual(pattern.message, 5);
    });

    test('regex compiles as a JavaScript RegExp', () => {
        const pattern = singlePattern(getTestthatMatcher());
        assert.doesNotThrow(
            () => new RegExp(pattern.regexp),
            `pattern.regexp must be a valid JS RegExp: ${pattern.regexp}`,
        );
    });
});

suite('testthat regex captures', () => {
    function regex(): RegExp {
        return new RegExp(singlePattern(getTestthatMatcher()).regexp);
    }

    test('matches a standard testthat 3.x failure header', () => {
        const sample = '── Failure (test-helpers.R:12:3): process_data handles NAs ──';
        const m = sample.match(regex());
        assert.ok(m, 'standard failure header must match');
        assert.strictEqual(m[1], 'Failure');
        assert.strictEqual(m[2], 'test-helpers.R');
        assert.strictEqual(m[3], '12');
        assert.strictEqual(m[4], '3');
        assert.strictEqual(m[5], 'process_data handles NAs');
    });

    test('matches an error header', () => {
        const sample = '── Error (test-foo.R:50:1): boots when fed an empty frame ──';
        const m = sample.match(regex());
        assert.ok(m, 'error header must match');
        assert.strictEqual(m[1], 'Error');
        assert.strictEqual(m[2], 'test-foo.R');
        assert.strictEqual(m[3], '50');
        assert.strictEqual(m[4], '1');
        assert.strictEqual(m[5], 'boots when fed an empty frame');
    });

    test('matches a header without an explicit column', () => {
        const sample = '── Failure (test-foo.R:12): something ──';
        const m = sample.match(regex());
        assert.ok(m, 'header without column must still match');
        assert.strictEqual(m[2], 'test-foo.R');
        assert.strictEqual(m[3], '12');
        assert.strictEqual(m[4], undefined, 'column should be unset when omitted');
        assert.strictEqual(m[5], 'something');
    });

    test('matches an ASCII fallback header', () => {
        const sample = '-- Failure (test-foo.R:1:1): plain ASCII fallback --';
        const m = sample.match(regex());
        assert.ok(m, 'ASCII fallback (-- ... --) must match');
        assert.strictEqual(m[2], 'test-foo.R');
        assert.strictEqual(m[5], 'plain ASCII fallback');
    });

    test('matches a header with extra leading dashes/spaces', () => {
        const sample = '────── Failure (test-foo.R:9:1): wide rule ──────';
        const m = sample.match(regex());
        assert.ok(m, 'longer dash rules must still match');
        assert.strictEqual(m[2], 'test-foo.R');
        assert.strictEqual(m[5], 'wide rule');
    });

    test('matches a path containing dots and dashes', () => {
        const sample = '── Failure (test-foo.bar.baz-2.R:3:7): odd-name ──';
        const m = sample.match(regex());
        assert.ok(m, 'paths with dots and dashes must match');
        assert.strictEqual(m[2], 'test-foo.bar.baz-2.R');
    });

    test('rejects a header missing the leading rule', () => {
        const sample = 'Failure (test-foo.R:12:3): without dashes';
        assert.strictEqual(
            sample.match(regex()),
            null,
            'header without leading dashes should not match the matcher',
        );
    });

    test('rejects unrelated output', () => {
        const samples = [
            '',
            '> devtools::test()',
            '[ FAIL 0 | WARN 0 | SKIP 0 | PASS 17 ]',
            'Expected: 1',
            'Backtrace:',
        ];
        for (const sample of samples) {
            assert.strictEqual(
                sample.match(regex()),
                null,
                `non-failure line should not match: ${JSON.stringify(sample)}`,
            );
        }
    });

    test('does not match testthat skip headers (skips are not problems)', () => {
        const sample = '── Skipped (test-foo.R:7:3): not on CI ──';
        assert.strictEqual(
            sample.match(regex()),
            null,
            'Skip headers should not produce diagnostics',
        );
    });
});
