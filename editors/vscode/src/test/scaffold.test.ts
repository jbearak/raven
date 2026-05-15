/// <reference types="mocha" />

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    GITIGNORE_TEMPLATE,
    LINTING_SENTINEL_BEGIN,
    LINTING_SENTINEL_END,
    LINTING_SETTINGS_TEMPLATE,
    buildLintingSettingsContent,
    createScaffoldFile,
    detectExistingLintingKeys,
    detectUserManagedLintingKeys,
} from '../scaffold';
import { activate } from './helper';

declare const suite: Mocha.SuiteFunction;
declare const test: Mocha.TestFunction;

const vscodeRoot = path.resolve(__dirname, '..', '..');
const packageJsonPath = path.join(vscodeRoot, 'package.json');

interface CommandContribution {
    command: string;
    title: string;
    category?: string;
}

function loadCommandContributions(): CommandContribution[] {
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw) as {
        contributes?: { commands?: CommandContribution[] };
    };
    return pkg.contributes?.commands ?? [];
}

function escapeRegex(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadLintingSettingKeys(): string[] {
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw) as {
        contributes?: {
            configuration?: { properties?: Record<string, unknown> };
        };
    };
    const properties = pkg.contributes?.configuration?.properties ?? {};
    return Object.keys(properties)
        .filter((k) => k.startsWith('raven.linting.'))
        .sort();
}

suite('scaffold templates', () => {
    test('.gitignore template contains the canonical R ignores', () => {
        const expected = [
            '.Rhistory',
            '.RData',
            '.Ruserdata',
            '.Rproj.user/',
            '.Renviron',
            '.DS_Store',
            'Thumbs.db',
            '*_cache/',
            '*_files/',
            '.Rcheck/',
            '.quarto/',
            'output/',
            'scratch/',
            'scratch.R',
            '.claude/settings.local.json',
            '.claude/agent-memory-local/',
            '.claude/scheduled_tasks.lock',
            '.cursorignore.local',
        ];
        for (const line of expected) {
            assert.ok(
                GITIGNORE_TEMPLATE.includes(line),
                `.gitignore template must include "${line}"`,
            );
        }
    });

    test('.gitignore template ends with a newline', () => {
        assert.ok(
            GITIGNORE_TEMPLATE.endsWith('\n'),
            '.gitignore template should end with a trailing newline',
        );
    });

    test('linting-settings template ends with a newline', () => {
        assert.ok(
            LINTING_SETTINGS_TEMPLATE.endsWith('\n'),
            'linting-settings template should end with a trailing newline',
        );
    });

    test('linting-settings template parses as valid JSON (comments stripped)', () => {
        const stripped = LINTING_SETTINGS_TEMPLATE.replace(/\/\/[^\n]*/g, '').replace(
            /,(\s*[}\]])/g,
            '$1',
        );
        const parsed = JSON.parse(stripped) as Record<string, unknown>;
        assert.strictEqual(parsed['raven.linting.enabled'], true);
        assert.strictEqual(parsed['raven.linting.lineLength'], 120);
        assert.strictEqual(parsed['raven.linting.indentationUnit'], 2);
        assert.strictEqual(parsed['raven.linting.objectLength'], 30);
    });

    test('linting-settings template covers every raven.linting.* configuration key', () => {
        const declared = loadLintingSettingKeys();
        const present = (detectExistingLintingKeys(LINTING_SETTINGS_TEMPLATE) ?? []).sort();
        assert.deepStrictEqual(
            present,
            declared,
            'every raven.linting.* configuration key must appear in the scaffold template',
        );
    });

    test('linting-settings template wraps the block in sentinel comments', () => {
        assert.ok(
            LINTING_SETTINGS_TEMPLATE.includes(LINTING_SENTINEL_BEGIN),
            'template must include the begin sentinel for safe re-run stripping',
        );
        assert.ok(
            LINTING_SETTINGS_TEMPLATE.includes(LINTING_SENTINEL_END),
            'template must include the end sentinel for safe re-run stripping',
        );
        assert.ok(
            LINTING_SETTINGS_TEMPLATE.indexOf(LINTING_SENTINEL_BEGIN) <
                LINTING_SETTINGS_TEMPLATE.indexOf(LINTING_SENTINEL_END),
            'begin sentinel must come before the end sentinel',
        );
    });

    test('linting-settings template names lintr equivalents in comments', () => {
        for (const expected of [
            'line_length_linter',
            'trailing_whitespace_linter',
            'whitespace_linter',
            'trailing_blank_lines_linter',
            'assignment_linter',
            'object_name_linter',
            'infix_spaces_linter',
            'commented_code_linter',
            'quotes_linter',
            'commas_linter',
            'T_and_F_symbol_linter',
            'semicolon_linter',
            'equals_na_linter',
            'object_length_linter',
            'vector_logic_linter',
            'function_left_parentheses_linter',
            'spaces_inside_linter',
            'indentation_linter',
        ]) {
            assert.ok(
                LINTING_SETTINGS_TEMPLATE.includes(expected),
                `linting-settings template must mention lintr's ${expected} in a comment`,
            );
        }
    });
});

suite('scaffold linting-settings merge', () => {
    test('returns fresh template when existing content is undefined', () => {
        assert.strictEqual(buildLintingSettingsContent(undefined), LINTING_SETTINGS_TEMPLATE);
    });

    test('returns fresh template when existing content is whitespace-only', () => {
        assert.strictEqual(buildLintingSettingsContent('   \n\t\n'), LINTING_SETTINGS_TEMPLATE);
    });

    function mergeOrThrow(input: string | undefined): string {
        const merged = buildLintingSettingsContent(input);
        assert.ok(merged !== null, 'buildLintingSettingsContent should not return null for this input');
        return merged;
    }

    test('inserts block into an empty object preserving formatting', () => {
        const merged = mergeOrThrow('{\n}\n');
        assert.ok(merged.startsWith('{\n'), 'should retain the opening brace line');
        assert.ok(merged.trimEnd().endsWith('}'), 'should retain the closing brace');
        const keys = detectExistingLintingKeys(merged) ?? [];
        assert.ok(keys.includes('raven.linting.enabled'));
        assert.ok(keys.includes('raven.linting.indentationSeverity'));
    });

    test('preserves unrelated keys and comments when merging', () => {
        const existing = `{
  // editor settings I care about
  "editor.tabSize": 4,
  "files.autoSave": "onFocusChange"
}
`;
        const merged = mergeOrThrow(existing);
        assert.ok(
            merged.includes('"editor.tabSize": 4'),
            'unrelated key must be preserved',
        );
        assert.ok(
            merged.includes('"files.autoSave": "onFocusChange"'),
            'unrelated key must be preserved',
        );
        assert.ok(
            merged.includes('// editor settings I care about'),
            'unrelated comments must be preserved',
        );
        assert.ok(
            merged.includes('"raven.linting.enabled": true'),
            'the new block must be inserted',
        );
    });

    test('overwrites existing raven.linting.* keys without duplicating them', () => {
        const existing = `{
  "raven.linting.enabled": false,
  "raven.linting.lineLength": 200,
  "editor.tabSize": 2
}
`;
        const merged = mergeOrThrow(existing);
        const enabledOccurrences = merged.match(/"raven\.linting\.enabled"/g) ?? [];
        assert.strictEqual(
            enabledOccurrences.length,
            1,
            'raven.linting.enabled must appear exactly once after merge',
        );
        const lineLengthOccurrences = merged.match(/"raven\.linting\.lineLength"/g) ?? [];
        assert.strictEqual(
            lineLengthOccurrences.length,
            1,
            'raven.linting.lineLength must appear exactly once after merge',
        );
        assert.ok(
            merged.includes('"raven.linting.enabled": true'),
            'merged value must reflect the new scaffold default (true)',
        );
        assert.ok(
            merged.includes('"raven.linting.lineLength": 120'),
            'merged value must reflect the new scaffold default (120)',
        );
        assert.ok(
            merged.includes('"editor.tabSize": 2'),
            'unrelated keys must survive overwrite',
        );
    });

    test('inserts comma before a trailing line comment on the last property', () => {
        const existing = `{
  "editor.tabSize": 4 // explanatory comment
}
`;
        const merged = mergeOrThrow(existing);
        // The new comma must come BEFORE the user's trailing `//` comment so
        // the file is still valid JSONC (otherwise the comma sits inside
        // the comment text).
        assert.ok(
            /"editor\.tabSize":\s*4,\s*\/\/ explanatory comment/.test(merged),
            `expected the inserted comma to land before the trailing comment; got:\n${merged}`,
        );
        const stripped = merged
            .replace(/\/\/[^\n]*/g, '')
            .replace(/,(\s*[}\]])/g, '$1');
        const parsed = JSON.parse(stripped) as Record<string, unknown>;
        assert.strictEqual(parsed['editor.tabSize'], 4);
        assert.strictEqual(parsed['raven.linting.enabled'], true);
    });

    test('leaves a nested raven.linting.* key inside an [r] override untouched', () => {
        const existing = `{
  "editor.tabSize": 2,
  "[r]": {
    "raven.linting.lineLength": 100
  }
}
`;
        const merged = mergeOrThrow(existing);
        // The nested key under [r] is a language-scoped override; it must
        // survive the merge intact (top-level keys may be stripped).
        assert.ok(
            /"\[r\]"\s*:\s*\{\s*"raven\.linting\.lineLength":\s*100/.test(merged),
            `expected the nested [r] override to survive; got:\n${merged}`,
        );
        // And the top-level block was still inserted.
        assert.ok(
            merged.includes('"raven.linting.enabled": true'),
            'the top-level block must still be inserted',
        );
    });

    test('returns null for a non-object root (e.g. array)', () => {
        assert.strictEqual(buildLintingSettingsContent('[1, 2, 3]'), null);
    });

    test('returns null for a parse-error file', () => {
        assert.strictEqual(buildLintingSettingsContent('{ this is not json'), null);
    });

    test('returns null when a raven.linting.* key has a non-scalar (object) value', () => {
        // raven.linting.* values are scalars; an object value would span
        // multiple lines, and the line-based stripper can't safely delete
        // a multi-line value. We refuse to merge instead.
        const existing = `{
  "raven.linting.foo": {
    "nested": 1
  }
}
`;
        assert.strictEqual(buildLintingSettingsContent(existing), null);
    });

    test('returns null when a raven.linting.* key has a non-scalar (array) value', () => {
        const existing = `{
  "raven.linting.bar": [1, 2, 3]
}
`;
        assert.strictEqual(buildLintingSettingsContent(existing), null);
    });

    test('returns null for an unterminated block comment', () => {
        // An unterminated `/*` used to slip through the comment stripper
        // silently, producing apparently-valid JSON and an invalid output.
        assert.strictEqual(buildLintingSettingsContent('{} /*'), null);
        assert.strictEqual(buildLintingSettingsContent('{ "a": 1 } /* unfinished'), null);
    });

    test('re-running on a sentineled file does not duplicate the block or its lintr comments', () => {
        const merged = mergeOrThrow(LINTING_SETTINGS_TEMPLATE);

        const beginCount = (merged.match(new RegExp(escapeRegex(LINTING_SENTINEL_BEGIN), 'g')) ?? [])
            .length;
        const endCount = (merged.match(new RegExp(escapeRegex(LINTING_SENTINEL_END), 'g')) ?? [])
            .length;
        assert.strictEqual(beginCount, 1, 'begin sentinel must appear exactly once after re-run');
        assert.strictEqual(endCount, 1, 'end sentinel must appear exactly once after re-run');

        const lintrHeaderCount = (merged.match(/\/\/ lintr: line_length_linter/g) ?? []).length;
        assert.strictEqual(
            lintrHeaderCount,
            1,
            'lintr header comments must not accumulate across re-runs',
        );

        const enabledCount = (merged.match(/"raven\.linting\.enabled"/g) ?? []).length;
        assert.strictEqual(enabledCount, 1, 'each raven.linting.* key must appear exactly once');
    });

    test('re-run strips a previous sentinel block while keeping unrelated keys', () => {
        const previous = `{
  // a comment the user wrote
  "editor.tabSize": 4,
  ${LINTING_SENTINEL_BEGIN}
  // Raven native style/lint diagnostics.
  // lintr: line_length_linter(length = N)
  "raven.linting.enabled": false,
  "raven.linting.lineLength": 200,
  ${LINTING_SENTINEL_END}
  "files.autoSave": "onFocusChange"
}
`;
        const merged = mergeOrThrow(previous);
        assert.ok(merged.includes('"editor.tabSize": 4'), 'unrelated keys must survive');
        assert.ok(
            merged.includes('"files.autoSave": "onFocusChange"'),
            'unrelated keys after the old block must survive',
        );
        assert.ok(
            merged.includes('// a comment the user wrote'),
            'unrelated comments must survive',
        );
        const enabledCount = (merged.match(/"raven\.linting\.enabled"/g) ?? []).length;
        assert.strictEqual(enabledCount, 1, 'no duplicate raven.linting.enabled');
        assert.ok(
            merged.includes('"raven.linting.enabled": true'),
            'value must reflect the scaffold default (true), not the prior false',
        );
        assert.ok(
            merged.includes('"raven.linting.lineLength": 120'),
            'value must reflect the scaffold default (120), not the prior 200',
        );
    });

    test('ignores sentinel-shaped lines that sit inside a block comment', () => {
        // The sentinels here are inside a /* ... */ block comment, so they
        // should NOT trigger the sentinel-strip path. The file has no real
        // raven.linting.* keys, so the merge just appends a fresh block.
        const existing = `{
  /*
   ${LINTING_SENTINEL_BEGIN}
   ${LINTING_SENTINEL_END}
   notes about future config
  */
  "editor.tabSize": 4
}
`;
        const merged = mergeOrThrow(existing);
        assert.ok(
            merged.includes('notes about future config'),
            'the user-authored block comment must survive',
        );
        // The new block adds its own sentinels — exactly one begin/end pair.
        const beginCount = (merged.match(new RegExp(escapeRegex(LINTING_SENTINEL_BEGIN), 'g')) ?? [])
            .length;
        assert.strictEqual(beginCount, 2, 'one sentinel inside the block comment plus one from the new block');
    });

    test('output parses as valid JSON after comment + trailing-comma stripping', () => {
        const existing = `{
  "editor.tabSize": 4,
  // a stray comment
  "raven.linting.enabled": false
}
`;
        const merged = mergeOrThrow(existing);
        const stripped = merged
            .replace(/\/\/[^\n]*/g, '')
            .replace(/,(\s*[}\]])/g, '$1');
        const parsed = JSON.parse(stripped) as Record<string, unknown>;
        assert.strictEqual(parsed['editor.tabSize'], 4);
        assert.strictEqual(parsed['raven.linting.enabled'], true);
    });
});

suite('detectUserManagedLintingKeys', () => {
    test('returns an empty array when all keys are inside the sentinel block', () => {
        const text = `{
  ${LINTING_SENTINEL_BEGIN}
  "raven.linting.enabled": true,
  "raven.linting.lineLength": 120,
  ${LINTING_SENTINEL_END}
}`;
        assert.deepStrictEqual(detectUserManagedLintingKeys(text), []);
    });

    test('returns only user-managed keys (outside the sentinel block)', () => {
        const text = `{
  "raven.linting.objectLength": 50,
  ${LINTING_SENTINEL_BEGIN}
  "raven.linting.enabled": true,
  ${LINTING_SENTINEL_END}
}`;
        assert.deepStrictEqual(detectUserManagedLintingKeys(text), [
            'raven.linting.objectLength',
        ]);
    });

    test('falls back to the full key list when no sentinels are present', () => {
        const text = `{
  "raven.linting.enabled": true,
  "raven.linting.lineLength": 120
}`;
        assert.deepStrictEqual((detectUserManagedLintingKeys(text) ?? []).sort(), [
            'raven.linting.enabled',
            'raven.linting.lineLength',
        ]);
    });
});

suite('detectExistingLintingKeys', () => {
    test('returns an empty array for empty input', () => {
        assert.deepStrictEqual(detectExistingLintingKeys(''), []);
    });

    test('finds raven.linting.* keys and skips others', () => {
        const text = `{
  "editor.tabSize": 2,
  "raven.linting.enabled": true,
  "raven.linting.lineLength": 120,
  "raven.crossFile.indexWorkspace": true
}`;
        const keys = (detectExistingLintingKeys(text) ?? []).sort();
        assert.deepStrictEqual(keys, [
            'raven.linting.enabled',
            'raven.linting.lineLength',
        ]);
    });

    test('returns null on JSON parse errors', () => {
        assert.strictEqual(detectExistingLintingKeys('{ this is not json'), null);
    });

    test('ignores raven.linting.* keys inside string values and comments', () => {
        const text = `{
  // "raven.linting.enabled": true (just a comment, not a real key)
  "editor.label": "say \\"raven.linting.foo\\""
}`;
        assert.deepStrictEqual(detectExistingLintingKeys(text), []);
    });
});

suite('scaffold package.json contributions', () => {
    test('declares raven.scaffold.gitignore and raven.scaffold.lintingSettings commands', () => {
        const commands = loadCommandContributions();
        const byId = new Map(commands.map((c) => [c.command, c]));

        const gitignore = byId.get('raven.scaffold.gitignore');
        assert.ok(gitignore, 'raven.scaffold.gitignore must be declared');
        assert.strictEqual(
            gitignore.title,
            'Create .gitignore',
            'raven.scaffold.gitignore must use the short title',
        );
        assert.strictEqual(
            gitignore.category,
            'Raven',
            'raven.scaffold.gitignore must be under the Raven category',
        );

        const linting = byId.get('raven.scaffold.lintingSettings');
        assert.ok(linting, 'raven.scaffold.lintingSettings must be declared');
        assert.strictEqual(
            linting.title,
            'Create linting settings',
            'raven.scaffold.lintingSettings must use the short title',
        );
        assert.strictEqual(
            linting.category,
            'Raven',
            'raven.scaffold.lintingSettings must be under the Raven category',
        );

        assert.ok(
            !byId.has('raven.scaffold.lintr'),
            'the legacy raven.scaffold.lintr command must no longer be declared',
        );
    });
});

suite('scaffold integration', () => {
    test('createScaffoldFile writes the requested content to the workspace folder', async function () {
        this.timeout(15000);
        await activate();
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'a workspace folder must be open in the test harness');
        const fileName = `.raven-scaffold-test-${Date.now()}.tmp`;
        const target = vscode.Uri.joinPath(folder.uri, fileName);
        try {
            const result = await createScaffoldFile(folder, fileName, 'hello\n');
            assert.ok(result, 'createScaffoldFile should return a URI on success');
            const bytes = await vscode.workspace.fs.readFile(target);
            assert.strictEqual(Buffer.from(bytes).toString('utf8'), 'hello\n');
        } finally {
            try {
                await vscode.workspace.fs.delete(target);
            } catch {
                // best-effort cleanup
            }
        }
    });

    test('extension registers both scaffold commands', async function () {
        this.timeout(15000);
        await activate();
        const all = await vscode.commands.getCommands(true);
        assert.ok(
            all.includes('raven.scaffold.gitignore'),
            'raven.scaffold.gitignore must be registered after activation',
        );
        assert.ok(
            all.includes('raven.scaffold.lintingSettings'),
            'raven.scaffold.lintingSettings must be registered after activation',
        );
        assert.ok(
            !all.includes('raven.scaffold.lintr'),
            'the legacy raven.scaffold.lintr command must no longer be registered',
        );
    });

    // We intentionally don't drive `runLintingSettingsScaffold` end-to-end in
    // an integration test: the production path calls `showTextDocument` on
    // `.vscode/settings.json`, which leaves the file open in an editor and
    // confuses the workspace-configuration writes that the `r-package
    // detection` suite performs later in the same VS Code session. The merge
    // logic itself is fully exercised by the `scaffold linting-settings
    // merge` and `detectExistingLintingKeys` suites above, and command
    // registration is covered by the test directly above this comment.
});
