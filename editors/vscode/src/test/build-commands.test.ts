/// <reference types="mocha" />

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    BUILD_COMMANDS,
    get_or_create_tasks_terminal,
    get_package_path_arg,
    _reset_tasks_terminal_for_test,
} from '../build-commands';
import { activate } from './helper';

declare const suite: Mocha.SuiteFunction;
declare const test: Mocha.TestFunction;
declare const suiteTeardown: Mocha.HookFunction;

const vscodeRoot = path.resolve(__dirname, '..', '..');
const packageJsonPath = path.join(vscodeRoot, 'package.json');

interface CommandContribution {
    command: string;
    title: string;
    category?: string;
}

interface MenuEntry {
    command?: string;
    submenu?: string;
    when?: string;
    group?: string;
}

interface SubmenuContribution {
    id: string;
    label: string;
    icon?: string;
}

interface PackageJson {
    contributes: {
        commands: CommandContribution[];
        submenus?: SubmenuContribution[];
        menus?: Record<string, MenuEntry[]>;
    };
}

function loadPackageJson(): PackageJson {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJson;
}

suite('build commands: definitions', () => {
    test('declares the six RStudio-Build-menu commands in order', () => {
        const ids = BUILD_COMMANDS.map((c) => c.id);
        assert.deepStrictEqual(ids, [
            'raven.build.loadAll',
            'raven.build.document',
            'raven.build.installAndRestart',
            'raven.build.testPackage',
            'raven.build.checkPackage',
            'raven.build.buildSource',
        ]);
    });

    test('r-console group invokes the live R session, tasks group is dedicated', () => {
        const target = Object.fromEntries(BUILD_COMMANDS.map((c) => [c.id, c.target]));
        assert.strictEqual(target['raven.build.loadAll'], 'r-console');
        assert.strictEqual(target['raven.build.document'], 'r-console');
        assert.strictEqual(target['raven.build.installAndRestart'], 'r-console');
        assert.strictEqual(target['raven.build.testPackage'], 'tasks');
        assert.strictEqual(target['raven.build.checkPackage'], 'tasks');
        assert.strictEqual(target['raven.build.buildSource'], 'tasks');
    });

    test('command code wraps the matching devtools call with the explicit pkg arg', () => {
        const make = Object.fromEntries(
            BUILD_COMMANDS.map((c) => [c.id, c.make_code]),
        );
        const pkg = '"/tmp/example"';
        assert.strictEqual(make['raven.build.loadAll']?.(pkg), 'devtools::load_all("/tmp/example")');
        assert.strictEqual(make['raven.build.document']?.(pkg), 'devtools::document("/tmp/example")');
        assert.strictEqual(make['raven.build.testPackage']?.(pkg), 'devtools::test("/tmp/example")');
        assert.strictEqual(make['raven.build.checkPackage']?.(pkg), 'devtools::check("/tmp/example")');
        assert.strictEqual(make['raven.build.buildSource']?.(pkg), 'devtools::build("/tmp/example")');
        // installAndRestart composes its R code dynamically because it must
        // chain devtools::install() with quit(save = "no") to force the
        // R-terminal restart that gives the command its name.
        assert.strictEqual(make['raven.build.installAndRestart'], undefined);
    });

    test('get_package_path_arg quotes the first workspace folder as a valid R string literal', () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'test harness must open a workspace folder');
        const arg = get_package_path_arg();
        // Result must round-trip through JSON.parse to the same fsPath:
        // JSON string literals are a superset of valid R double-quoted
        // string literals for the relevant escape rules (`\\`, `\"`).
        assert.strictEqual(JSON.parse(arg), folder.uri.fsPath);
    });
});

suite('build commands: package.json contributions', () => {
    test('every BUILD_COMMANDS entry is declared in package.json under the "Raven Build" category', () => {
        const pkg = loadPackageJson();
        const byId = new Map(pkg.contributes.commands.map((c) => [c.command, c]));
        for (const cmd of BUILD_COMMANDS) {
            const declared = byId.get(cmd.id);
            assert.ok(declared, `${cmd.id} must be declared in package.json`);
            assert.strictEqual(
                declared.title,
                cmd.title,
                `${cmd.id} title should match BUILD_COMMANDS`,
            );
            assert.strictEqual(
                declared.category,
                'Raven Build',
                `${cmd.id} should sit under the "Raven Build" category`,
            );
        }
    });

    test('declares the raven.build submenu with the package codicon', () => {
        const pkg = loadPackageJson();
        const submenu = pkg.contributes.submenus?.find((s) => s.id === 'raven.build');
        assert.ok(submenu, 'package.json must declare the raven.build submenu');
        assert.strictEqual(submenu.icon, '$(package)');
    });

    test('every build command appears in the raven.build submenu in the documented order', () => {
        const pkg = loadPackageJson();
        const entries = pkg.contributes.menus?.['raven.build'] ?? [];
        const commandIds = entries.map((e) => e.command).filter((id): id is string => !!id);
        assert.deepStrictEqual(
            commandIds,
            BUILD_COMMANDS.map((c) => c.id),
            'raven.build submenu must list all six commands in BUILD_COMMANDS order',
        );
    });

    test('raven.build editor/title entry is gated on package mode and the R console', () => {
        const pkg = loadPackageJson();
        const editorTitle = pkg.contributes.menus?.['editor/title'] ?? [];
        const buildEntry = editorTitle.find((e) => e.submenu === 'raven.build');
        assert.ok(buildEntry, 'editor/title must include the raven.build submenu');
        const when = buildEntry.when ?? '';
        assert.ok(when.includes('raven.isRPackage'), 'submenu must be gated on raven.isRPackage');
        assert.ok(when.includes('raven.rConsoleEnabled'), 'submenu must require r-console activation');
        assert.ok(when.includes("editorLangId == r"), 'submenu must require an R file');
        assert.strictEqual(buildEntry.group, 'navigation');
    });

    test('palette entries for build commands are gated on package mode and the R console', () => {
        const pkg = loadPackageJson();
        const palette = pkg.contributes.menus?.commandPalette ?? [];
        for (const cmd of BUILD_COMMANDS) {
            const entry = palette.find((e) => e.command === cmd.id);
            assert.ok(entry, `command palette must gate ${cmd.id}`);
            const when = entry.when ?? '';
            assert.ok(
                when.includes('raven.isRPackage'),
                `${cmd.id} palette entry must require raven.isRPackage`,
            );
            assert.ok(
                when.includes('raven.rConsoleEnabled'),
                `${cmd.id} palette entry must require raven.rConsoleEnabled`,
            );
        }
    });
});

suite('build commands: registration', () => {
    test('extension registers every build command after activation', async function () {
        this.timeout(15000);
        await activate();
        const all = new Set(await vscode.commands.getCommands(true));
        for (const cmd of BUILD_COMMANDS) {
            assert.ok(
                all.has(cmd.id),
                `expected build command "${cmd.id}" to be registered`,
            );
        }
    });
});

suite('build commands: tasks terminal', () => {
    // `config.update(key, undefined, Workspace)` writes `.vscode/settings.json`
    // with the remaining keys (possibly empty). Sweep on teardown so the
    // fixture workspace doesn't pollute git status between runs.
    suiteTeardown(async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) return;
        await new Promise((resolve) => setTimeout(resolve, 200));
        const dotVscode = vscode.Uri.joinPath(folder.uri, '.vscode');
        const settings = vscode.Uri.joinPath(dotVscode, 'settings.json');
        try {
            const bytes = await vscode.workspace.fs.readFile(settings);
            const text = Buffer.from(bytes).toString('utf8').trim();
            if (text === '' || text === '{}' || text === '{\n}') {
                try {
                    await vscode.workspace.fs.delete(settings);
                    const entries = await vscode.workspace.fs.readDirectory(dotVscode);
                    if (entries.length === 0) await vscode.workspace.fs.delete(dotVscode);
                } catch {
                    // best-effort
                }
            }
        } catch {
            // no settings.json — nothing to clean
        }
    });

    test('concurrent get_or_create calls return the same terminal instance', async function () {
        this.timeout(15000);
        await activate();
        _reset_tasks_terminal_for_test();
        try {
            // Fire both calls before awaiting either. With the
            // creation-in-flight guard, both promises must resolve to the
            // same vscode.Terminal — otherwise two terminals would be
            // spawned and the first would be orphaned.
            const [a, b] = await Promise.all([
                get_or_create_tasks_terminal(),
                get_or_create_tasks_terminal(),
            ]);
            assert.strictEqual(a, b, 'concurrent calls must share a single terminal');
            assert.strictEqual(a.name, 'R: Package Tasks');
        } finally {
            // Best-effort cleanup: dispose the terminal so it doesn't
            // linger between tests. The next test's reset will null out
            // our module-local slot.
            try {
                (await get_or_create_tasks_terminal()).dispose();
            } catch {
                // ignore
            }
            _reset_tasks_terminal_for_test();
        }
    });

    // No test for the `raven.rTerminal.program`-change invalidation:
    // vscode-test runs the suite against an out/ copy of this module while
    // the bundled extension uses a separate dist/ copy (see the note on
    // `_set_extension_context_for_test` in `r-terminal-manager.ts`). The
    // listener registered by `register_build_commands` clears the bundled
    // module's `tasks_terminal` slot, which the test module can't observe.
    // The companion `raven.rTerminal.program`-change listener in
    // `r-terminal-manager.ts` has the same gap.
});
