/// <reference types="mocha" />

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

declare const suite: Mocha.SuiteFunction;
declare const test: Mocha.TestFunction;

interface MenuEntry {
    command?: string;
    submenu?: string;
    when?: string;
    group?: string;
}

interface PackageJson {
    contributes: {
        menus: Record<string, MenuEntry[]>;
    };
}

const packageJsonPath = path.resolve(__dirname, '..', '..', '..', 'package.json');

function loadPackageJson(): PackageJson {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJson;
}

// Regex literal for the .Rmd / .qmd extension family — matches the value used
// in the package.json `when` expressions and lets the assertions stay locked
// to a single source of truth.
const RMD_QMD_EXT = /\\\.\(rmd\|Rmd\|RMD\|qmd\|Qmd\|QMD\)\$/;
const RMD_ONLY_EXT = /\\\.\(rmd\|Rmd\|RMD\)\$/;

function findCommand(entries: MenuEntry[], command: string): MenuEntry | undefined {
    return entries.find((entry) => entry.command === command);
}

function assertHidesForRmdQmd(entry: MenuEntry, command: string): void {
    const when = entry.when ?? '';
    // The line-oriented commands must hide on .Rmd / .qmd. We require both
    // the explicit `editorLangId == r` constraint and the negated extension
    // test — otherwise an .R file named `notes.Rmd` (matched only by
    // extension) would slip through with `editorLangId == r` alone.
    assert.ok(
        when.includes('editorLangId == r'),
        `${command} must restrict to editorLangId == r, got: ${when}`,
    );
    assert.ok(
        when.includes('!(resourceExtname'),
        `${command} must exclude resourceExtname matches, got: ${when}`,
    );
    assert.ok(
        RMD_QMD_EXT.test(when),
        `${command} must reference the .Rmd/.qmd extension family, got: ${when}`,
    );
}

function assertShowsOnlyForRmdQmd(entry: MenuEntry, command: string): void {
    const when = entry.when ?? '';
    assert.ok(
        when.includes('editorLangId == rmd'),
        `${command} must allow editorLangId == rmd, got: ${when}`,
    );
    assert.ok(
        when.includes('editorLangId == quarto'),
        `${command} must allow editorLangId == quarto, got: ${when}`,
    );
    // The third clause covers a plain `editorLangId == r` editor that happens
    // to be backing a .Rmd/.qmd file (e.g. when another extension claims the
    // .Rmd language). The extension reference must point at the .Rmd/.qmd
    // family — not the .Rmd-only family used by Knit.
    assert.ok(
        when.includes('editorLangId == r'),
        `${command} must allow editorLangId == r when paired with the extension test, got: ${when}`,
    );
    assert.ok(
        RMD_QMD_EXT.test(when),
        `${command} must reference the .Rmd/.qmd extension family, got: ${when}`,
    );
}

suite('Send to R submenu: editor-title gating', () => {
    test('line-oriented commands hide on .Rmd / .qmd', () => {
        const pkg = loadPackageJson();
        const entries = pkg.contributes.menus['raven.sendToR'] ?? [];
        for (const command of ['raven.runUpwardLines', 'raven.runDownwardLines', 'raven.sourceFile']) {
            const entry = findCommand(entries, command);
            assert.ok(entry, `raven.sendToR must contain ${command}`);
            assertHidesForRmdQmd(entry, command);
        }
    });

    test('Run Line or Selection stays visible for every supported language', () => {
        const pkg = loadPackageJson();
        const entries = pkg.contributes.menus['raven.sendToR'] ?? [];
        const entry = findCommand(entries, 'raven.runLineOrSelection');
        assert.ok(entry, 'raven.sendToR must contain raven.runLineOrSelection');
        assert.strictEqual(
            entry.when,
            undefined,
            'raven.runLineOrSelection must have no `when` clause so it surfaces on .R, .Rmd, and .qmd alike',
        );
    });

    test('chunk commands carried over from .R remain ungated', () => {
        const pkg = loadPackageJson();
        const entries = pkg.contributes.menus['raven.sendToR'] ?? [];
        for (const command of [
            'raven.runCurrentChunk',
            'raven.runCurrentChunkAndMove',
            'raven.runAboveChunks',
            'raven.runAllChunks',
        ]) {
            const entry = findCommand(entries, command);
            assert.ok(entry, `raven.sendToR must contain ${command}`);
            assert.strictEqual(
                entry.when,
                undefined,
                `${command} must not gain a \`when\` clause — it already worked for .R today`,
            );
        }
    });

    test('chunk commands added for chunk-based files are gated to .Rmd / .qmd', () => {
        const pkg = loadPackageJson();
        const entries = pkg.contributes.menus['raven.sendToR'] ?? [];
        for (const command of [
            'raven.runCurrentAndBelowChunks',
            'raven.runBelowChunks',
            'raven.runPreviousChunk',
            'raven.runNextChunk',
        ]) {
            const entry = findCommand(entries, command);
            assert.ok(entry, `raven.sendToR must contain ${command}`);
            assertShowsOnlyForRmdQmd(entry, command);
        }
    });

    test('Knit is gated to .Rmd files and the rmdKnit feature flag', () => {
        const pkg = loadPackageJson();
        const entries = pkg.contributes.menus['raven.sendToR'] ?? [];
        const entry = findCommand(entries, 'raven.knit');
        assert.ok(entry, 'raven.sendToR must contain raven.knit');
        const when = entry.when ?? '';
        assert.ok(
            when.includes('raven.rmdKnit.enabled'),
            `Knit must require raven.rmdKnit.enabled, got: ${when}`,
        );
        // The Knit affordance is only meaningful for .Rmd — Quarto files
        // belong to `quarto render` instead — so the extension test must
        // exclude .qmd. We assert the .Rmd-only family is present and the
        // broader .Rmd/.qmd family is not.
        assert.ok(
            RMD_ONLY_EXT.test(when),
            `Knit must reference the .Rmd-only extension family, got: ${when}`,
        );
        assert.ok(
            !when.includes('qmd'),
            `Knit must not reference .qmd extensions, got: ${when}`,
        );
    });
});

suite('Send to R → Terminal submenu: editor-title gating', () => {
    test('terminal line-oriented commands hide on .Rmd / .qmd', () => {
        const pkg = loadPackageJson();
        const entries = pkg.contributes.menus['raven.sendToR.terminal'] ?? [];
        for (const command of [
            'raven.terminal.runUpwardLines',
            'raven.terminal.runDownwardLines',
            'raven.terminal.sourceFile',
        ]) {
            const entry = findCommand(entries, command);
            assert.ok(entry, `raven.sendToR.terminal must contain ${command}`);
            assertHidesForRmdQmd(entry, command);
        }
    });

    test('Terminal: Run Line or Selection stays visible for every supported language', () => {
        const pkg = loadPackageJson();
        const entries = pkg.contributes.menus['raven.sendToR.terminal'] ?? [];
        const entry = findCommand(entries, 'raven.terminal.runLineOrSelection');
        assert.ok(entry, 'raven.sendToR.terminal must contain raven.terminal.runLineOrSelection');
        assert.strictEqual(
            entry.when,
            undefined,
            'Terminal: Run Line or Selection must have no `when` clause so it surfaces on .R, .Rmd, and .qmd alike',
        );
    });
});
