/// <reference types="mocha" />

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Structural and placeholder-grammar tests for the R snippets file.
 *
 * Pure file/JSON assertions — no `vscode` API needed beyond the harness.
 * Validates: JSON parses, every entry has the right shape, prefixes are
 * unique, placeholder syntax is well-formed, and package.json's
 * `contributes.snippets` points at the on-disk file.
 *
 * We intentionally do NOT snapshot exact body strings or assert a hard
 * count — both make routine edits churn-y without catching real bugs.
 */

// Mocha globals available in the vscode-test harness.
declare const suite: Mocha.SuiteFunction;
declare const test: Mocha.TestFunction;

// __dirname at runtime is editors/vscode/out/test. Walk back to editors/vscode/.
const vscodeRoot = path.resolve(__dirname, '..', '..');
const snippetsRelativePath = './snippets/r.json';
const snippetsAbsolutePath = path.join(vscodeRoot, 'snippets', 'r.json');
const packageJsonPath = path.join(vscodeRoot, 'package.json');

interface SnippetEntry {
    prefix: string;
    body: string | string[];
    description: string;
}

function loadSnippets(): Record<string, SnippetEntry> {
    const raw = fs.readFileSync(snippetsAbsolutePath, 'utf8');
    return JSON.parse(raw) as Record<string, SnippetEntry>;
}

function loadPackageJson(): Record<string, unknown> {
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
}

function bodyToString(body: string | string[]): string {
    return Array.isArray(body) ? body.join('\n') : body;
}

suite('R snippets', () => {
    test('snippets file parses as JSON', () => {
        assert.doesNotThrow(() => loadSnippets(), 'r.json must be valid JSON');
    });

    test('contains at least one snippet', () => {
        const snippets = loadSnippets();
        assert.ok(
            Object.keys(snippets).length > 0,
            'r.json must define at least one snippet',
        );
    });

    test('every snippet has required fields with correct types', () => {
        const snippets = loadSnippets();
        for (const [name, entry] of Object.entries(snippets)) {
            assert.ok(
                typeof entry.prefix === 'string' && entry.prefix.length > 0,
                `Snippet "${name}" must have a non-empty string prefix`,
            );
            const bodyIsString = typeof entry.body === 'string';
            const bodyIsStringArray = Array.isArray(entry.body)
                && entry.body.every((line) => typeof line === 'string');
            assert.ok(
                bodyIsString || bodyIsStringArray,
                `Snippet "${name}" body must be a string or array of strings`,
            );
            assert.ok(
                typeof entry.description === 'string' && entry.description.length > 0,
                `Snippet "${name}" must have a non-empty string description`,
            );
        }
    });

    test('prefixes are unique across all snippets', () => {
        const snippets = loadSnippets();
        const seen = new Map<string, string>(); // prefix -> first snippet name
        for (const [name, entry] of Object.entries(snippets)) {
            const prior = seen.get(entry.prefix);
            assert.ok(
                prior === undefined,
                `Prefix "${entry.prefix}" is used by both "${prior}" and "${name}" — `
                + 'duplicates silently overwrite each other in VS Code',
            );
            seen.set(entry.prefix, name);
        }
    });

    test('placeholder grammar is well-formed in every snippet body', () => {
        const snippets = loadSnippets();
        // Matches:
        //   ${N}          (placeholder, no default)
        //   ${N:default}  (placeholder with default — default may contain
        //                   nested ${...} for recursive snippets)
        //   $N            (bare tab stop)
        // We use a permissive matcher then validate balance separately.
        const tabStopPattern = /\$\{(\d+)(?::([^}]*))?\}|\$(\d+)/g;

        for (const [name, entry] of Object.entries(snippets)) {
            const body = bodyToString(entry.body);

            // 1. No unterminated `${` — count must balance.
            const openCount = (body.match(/\$\{/g) || []).length;
            const closeAfterOpen = countBalancedClosers(body);
            assert.strictEqual(
                openCount,
                closeAfterOpen,
                `Snippet "${name}" has unbalanced \${...} placeholders`,
            );

            // 2. Collect tab-stop numbers found in the body.
            const tabStopNumbers: number[] = [];
            let match: RegExpExecArray | null;
            tabStopPattern.lastIndex = 0;
            while ((match = tabStopPattern.exec(body)) !== null) {
                const numStr = match[1] ?? match[3];
                if (numStr !== undefined) {
                    tabStopNumbers.push(parseInt(numStr, 10));
                }
            }

            // 3. At most one ${0} (or $0). Zero is allowed (cursor lands at body end).
            const zeroCount = tabStopNumbers.filter((n) => n === 0).length;
            assert.ok(
                zeroCount <= 1,
                `Snippet "${name}" has ${zeroCount} \${0} placeholders — at most one is allowed`,
            );

            // 4. No duplicate non-zero tab-stop numbers within one snippet.
            const nonZero = tabStopNumbers.filter((n) => n !== 0);
            const duplicates = nonZero.filter((n, i) => nonZero.indexOf(n) !== i);
            assert.deepStrictEqual(
                duplicates,
                [],
                `Snippet "${name}" has duplicate tab-stop numbers: ${[...new Set(duplicates)].join(', ')}`,
            );
        }
    });

    test('package.json registers the snippets file under the r language', () => {
        const pkg = loadPackageJson();
        const contributes = pkg.contributes as Record<string, unknown> | undefined;
        assert.ok(contributes, 'package.json must have a contributes section');
        const snippetEntries = contributes.snippets as Array<{ language?: string; path?: string }> | undefined;
        assert.ok(
            Array.isArray(snippetEntries),
            'package.json contributes.snippets must be an array',
        );
        const rEntries = snippetEntries.filter((e) => e.language === 'r');
        assert.strictEqual(
            rEntries.length,
            1,
            'Exactly one snippet entry must be registered for language "r"',
        );
        assert.strictEqual(
            rEntries[0].path,
            snippetsRelativePath,
            `R snippet entry must point at ${snippetsRelativePath}`,
        );
    });

    test('registered snippets path resolves to an existing file', () => {
        const pkg = loadPackageJson();
        const contributes = pkg.contributes as Record<string, unknown>;
        const snippetEntries = contributes.snippets as Array<{ language: string; path: string }>;
        const rEntry = snippetEntries.find((e) => e.language === 'r');
        assert.ok(rEntry, 'No snippet entry found for r language');
        // Path in package.json is relative to the extension root, which is vscodeRoot.
        const resolvedPath = path.resolve(vscodeRoot, rEntry.path);
        assert.ok(
            fs.existsSync(resolvedPath),
            `Registered snippets file does not exist on disk: ${resolvedPath}`,
        );
    });
});

/**
 * Count how many `${` openers in the body are matched by a `}` that
 * also closes the placeholder (skipping `{` and `}` that appear inside
 * a default value as part of nested `${...}`). This is a simple state
 * machine — VS Code's snippet engine itself is recursive, but for our
 * "are placeholders balanced?" check we only need to know the opener
 * count matches the corresponding closer count at the same depth.
 */
function countBalancedClosers(body: string): number {
    let depth = 0;
    let matched = 0;
    for (let i = 0; i < body.length; i++) {
        if (body[i] === '$' && body[i + 1] === '{') {
            depth++;
            i++; // skip the '{'
        } else if (body[i] === '}' && depth > 0) {
            depth--;
            matched++;
        }
    }
    return matched;
}
