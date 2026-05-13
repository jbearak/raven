// IDE-only: forces @types/mocha into scope for TS language servers that
// check this file in isolation and don't see the project's tsconfig
// auto-loaded @types. The compile already works without this — see the
// identical `declare const suite` pattern in settings.test.ts.
/// <reference types="mocha" />

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Structural and placeholder-grammar tests for the snippet files
 * registered in package.json's `contributes.snippets`.
 *
 * Pure file/JSON assertions — no `vscode` API needed beyond the harness.
 * For each registered file we validate: JSON parses, every entry has
 * the right shape, placeholder syntax is well-formed. Across all files
 * registered for the same language we validate that prefixes are unique
 * (VS Code silently overwrites duplicates).
 *
 * We intentionally do NOT snapshot exact body strings or assert a hard
 * count — both make routine edits churn-y without catching real bugs.
 */

// Mocha globals available in the vscode-test harness.
declare const suite: Mocha.SuiteFunction;
declare const test: Mocha.TestFunction;

// __dirname at runtime is editors/vscode/out/test. Walk back to editors/vscode/.
const vscodeRoot = path.resolve(__dirname, '..', '..');
const packageJsonPath = path.join(vscodeRoot, 'package.json');

interface SnippetEntry {
    // VS Code allows a snippet to bind multiple trigger words by setting
    // prefix to a string[]; accept both forms.
    prefix: string | string[];
    body: string | string[];
    description: string;
}

interface SnippetContribution {
    language: string;
    path: string;
}

function loadPackageJson(): Record<string, unknown> {
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
}

function loadSnippetContributions(): SnippetContribution[] {
    const pkg = loadPackageJson();
    const contributes = pkg.contributes as Record<string, unknown> | undefined;
    assert.ok(contributes, 'package.json must have a contributes section');
    const snippetEntries = contributes.snippets as SnippetContribution[] | undefined;
    assert.ok(
        Array.isArray(snippetEntries) && snippetEntries.length > 0,
        'package.json contributes.snippets must be a non-empty array',
    );
    return snippetEntries;
}

function loadSnippets(relativePath: string): Record<string, SnippetEntry> {
    const absolutePath = path.resolve(vscodeRoot, relativePath);
    const raw = fs.readFileSync(absolutePath, 'utf8');
    return JSON.parse(raw) as Record<string, SnippetEntry>;
}

function bodyToString(body: string | string[]): string {
    return Array.isArray(body) ? body.join('\n') : body;
}

suite('Snippet contributions', () => {
    test('package.json registers at least one snippet file for the r language', () => {
        const contributions = loadSnippetContributions();
        const rEntries = contributions.filter((e) => e.language === 'r');
        assert.ok(
            rEntries.length >= 1,
            'At least one snippet file must be registered for language "r"',
        );
    });

    test('every registered snippets path resolves to an existing file', () => {
        for (const entry of loadSnippetContributions()) {
            const resolvedPath = path.resolve(vscodeRoot, entry.path);
            assert.ok(
                fs.existsSync(resolvedPath),
                `Registered snippets file does not exist on disk: ${resolvedPath}`,
            );
        }
    });

    test('every registered snippets file parses as JSON', () => {
        for (const entry of loadSnippetContributions()) {
            assert.doesNotThrow(
                () => loadSnippets(entry.path),
                `${entry.path} must be valid JSON`,
            );
        }
    });

    test('every registered snippets file contains at least one snippet', () => {
        for (const entry of loadSnippetContributions()) {
            const snippets = loadSnippets(entry.path);
            assert.ok(
                Object.keys(snippets).length > 0,
                `${entry.path} must define at least one snippet`,
            );
        }
    });

    test('every snippet has required fields with correct types', () => {
        for (const entry of loadSnippetContributions()) {
            const snippets = loadSnippets(entry.path);
            for (const [name, snippet] of Object.entries(snippets)) {
                const prefixIsString = typeof snippet.prefix === 'string' && snippet.prefix.length > 0;
                const prefixIsStringArray = Array.isArray(snippet.prefix)
                    && snippet.prefix.length > 0
                    && snippet.prefix.every((p) => typeof p === 'string' && p.length > 0);
                assert.ok(
                    prefixIsString || prefixIsStringArray,
                    `${entry.path}: Snippet "${name}" must have a non-empty string or non-empty string-array prefix`,
                );
                const bodyIsString = typeof snippet.body === 'string';
                const bodyIsStringArray = Array.isArray(snippet.body)
                    && snippet.body.every((line) => typeof line === 'string');
                assert.ok(
                    bodyIsString || bodyIsStringArray,
                    `${entry.path}: Snippet "${name}" body must be a string or array of strings`,
                );
                assert.ok(
                    typeof snippet.description === 'string' && snippet.description.length > 0,
                    `${entry.path}: Snippet "${name}" must have a non-empty string description`,
                );
            }
        }
    });

    test('prefixes are unique within each language across all registered files', () => {
        // Group registered files by language and check the union of prefixes
        // — when multiple files are registered for the same language they
        // share a single trigger namespace at runtime, so any duplicate
        // would silently shadow the other.
        const contributions = loadSnippetContributions();
        const byLanguage = new Map<string, SnippetContribution[]>();
        for (const entry of contributions) {
            const list = byLanguage.get(entry.language) ?? [];
            list.push(entry);
            byLanguage.set(entry.language, list);
        }

        for (const [language, entries] of byLanguage) {
            const seen = new Map<string, { file: string; name: string }>();
            for (const entry of entries) {
                const snippets = loadSnippets(entry.path);
                for (const [name, snippet] of Object.entries(snippets)) {
                    const prefixes = Array.isArray(snippet.prefix) ? snippet.prefix : [snippet.prefix];
                    for (const prefix of prefixes) {
                        const prior = seen.get(prefix);
                        assert.ok(
                            prior === undefined,
                            `Language "${language}": prefix "${prefix}" is used by both `
                            + `"${prior?.name}" in ${prior?.file} and "${name}" in ${entry.path} — `
                            + 'duplicates silently overwrite each other in VS Code',
                        );
                        seen.set(prefix, { file: entry.path, name });
                    }
                }
            }
        }
    });

    test('placeholder grammar is well-formed in every snippet body', () => {
        // Matches:
        //   ${N}            (placeholder, no default)
        //   ${N:default}    (placeholder with default, non-nested)
        //   ${N|opt1,opt2|} (choice placeholder)
        //   $N              (bare tab stop)
        // Known limitation: the [^}]* default-group is non-recursive, so
        // tab-stop numbers that appear *inside* a nested ${...} default
        // are not collected. The "for" snippet does this intentionally —
        // body `for (${1:i} in ${2:seq_along(${3:x})})` — and stop 3 is
        // invisible to this regex. The balance check below still catches
        // malformed nesting. If a future snippet adds duplicate stops
        // inside nested defaults, this regex won't flag them.
        const tabStopPattern = /\$\{(\d+)(?::[^}]*)?\}|\$\{(\d+)\|[^}]*\|\}|\$(\d+)/g;

        for (const entry of loadSnippetContributions()) {
            const snippets = loadSnippets(entry.path);
            for (const [name, snippet] of Object.entries(snippets)) {
                const body = bodyToString(snippet.body);
                const label = `${entry.path}: Snippet "${name}"`;

                // 1. No unterminated `${` — count must balance.
                const openCount = (body.match(/\$\{/g) || []).length;
                const closeAfterOpen = countBalancedClosers(body);
                assert.strictEqual(
                    openCount,
                    closeAfterOpen,
                    `${label} has unbalanced \${...} placeholders`,
                );

                // 2. Collect tab-stop numbers found in the body.
                const tabStopNumbers: number[] = [];
                let match: RegExpExecArray | null;
                tabStopPattern.lastIndex = 0;
                while ((match = tabStopPattern.exec(body)) !== null) {
                    const numStr = match[1] ?? match[2] ?? match[3];
                    if (numStr !== undefined) {
                        tabStopNumbers.push(parseInt(numStr, 10));
                    }
                }

                // 3. At most one ${0} (or $0). Zero is allowed (cursor lands at body end).
                const zeroCount = tabStopNumbers.filter((n) => n === 0).length;
                assert.ok(
                    zeroCount <= 1,
                    `${label} has ${zeroCount} \${0} placeholders — at most one is allowed`,
                );

                // 4. No duplicate non-zero tab-stop numbers within one snippet.
                const nonZero = tabStopNumbers.filter((n) => n !== 0);
                const duplicates = nonZero.filter((n, i) => nonZero.indexOf(n) !== i);
                assert.deepStrictEqual(
                    duplicates,
                    [],
                    `${label} has duplicate tab-stop numbers: ${[...new Set(duplicates)].join(', ')}`,
                );
            }
        }
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
