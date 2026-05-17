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

interface Keybinding {
    command: string;
    key?: string;
    mac?: string;
    when?: string;
}

interface PackageJson {
    contributes: {
        menus: Record<string, MenuEntry[]>;
        keybindings: Keybinding[];
    };
}

const packageJsonPath = path.resolve(__dirname, '..', '..', '..', 'package.json');

function loadPackageJson(): PackageJson {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJson;
}

// Regex literals for the extension families — these mirror the regex
// fragments embedded in the package.json `when` expressions so the tests
// stay locked to a single source of truth.
const RMD_QMD_EXT = /\\\.\(rmd\|Rmd\|RMD\|qmd\|Qmd\|QMD\)\$/;
const RMD_ONLY_EXT = /\\\.\(rmd\|Rmd\|RMD\)\$/;
const QMD_ONLY_EXT = /\\\.\(qmd\|Qmd\|QMD\)\$/;

function findCommand(entries: MenuEntry[], command: string): MenuEntry | undefined {
    return entries.find((entry) => entry.command === command);
}

function findSubmenu(entries: MenuEntry[], submenu: string): MenuEntry | undefined {
    return entries.find((entry) => entry.submenu === submenu);
}

function assertHidesForRmdQmd(entry: MenuEntry, label: string): void {
    const when = entry.when ?? '';
    // The auto-include entries must hide on .Rmd / .qmd. We require both
    // the explicit `editorLangId == r` constraint and the negated extension
    // test — otherwise an .R file named `notes.Rmd` (matched only by
    // extension) would slip through with `editorLangId == r` alone.
    assert.ok(
        when.includes('editorLangId == r'),
        `${label} must restrict to editorLangId == r, got: ${when}`,
    );
    assert.ok(
        when.includes('!(resourceExtname'),
        `${label} must exclude resourceExtname matches, got: ${when}`,
    );
    assert.ok(
        RMD_QMD_EXT.test(when),
        `${label} must reference the .Rmd/.qmd extension family, got: ${when}`,
    );
}

function assertShowsOnlyForRmdQmd(entry: MenuEntry, label: string): void {
    const when = entry.when ?? '';
    assert.ok(
        when.includes('editorLangId == rmd'),
        `${label} must fire for editorLangId == rmd, got: ${when}`,
    );
    assert.ok(
        when.includes('editorLangId == quarto'),
        `${label} must fire for editorLangId == quarto, got: ${when}`,
    );
    // Also covers .R files saved with a .Rmd / .qmd extension (handy when
    // another extension claims the language).
    assert.ok(
        when.includes('editorLangId == r'),
        `${label} must also fire for editorLangId == r when paired with an extension test, got: ${when}`,
    );
    assert.ok(
        RMD_QMD_EXT.test(when),
        `${label} must reference the .Rmd/.qmd extension family, got: ${when}`,
    );
}

suite('Send to R submenu: editor-title gating', () => {
    test('auto-include line entries and Source File hide on .Rmd / .qmd', () => {
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
        // Run Line or Selection sends what the user explicitly picked (the
        // selection, or statement detection on the cursor line). That stays
        // useful inside a chunk too, so the entry has no `when` clause.
        assert.strictEqual(
            entry.when,
            undefined,
            'raven.runLineOrSelection must have no `when` clause so it surfaces on .R, .Rmd, and .qmd alike',
        );
    });

    test('chunk commands are gated to .Rmd / .qmd', () => {
        // Plain `.R` cell mode (`# %%`) is real, but the toolbar menu is
        // meant for chunk-based authoring; users with cell-mode `.R` reach
        // chunk operations through the CodeLens or command palette. Gating
        // here keeps the .R toolbar lean.
        const pkg = loadPackageJson();
        const entries = pkg.contributes.menus['raven.sendToR'] ?? [];
        for (const command of [
            'raven.runCurrentChunk',
            'raven.runCurrentChunkAndMove',
            'raven.runAboveChunks',
            'raven.runBelowChunks',
            'raven.runAllChunks',
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
        // Knit only applies to .Rmd — Quarto preview is a separate concern —
        // so the extension test must reference the .Rmd-only family and must
        // not pull in .qmd extensions.
        assert.ok(
            RMD_ONLY_EXT.test(when),
            `Knit must reference the .Rmd-only extension family, got: ${when}`,
        );
        assert.ok(
            !when.includes('qmd'),
            `Knit must not reference .qmd extensions, got: ${when}`,
        );
    });

    test('Terminal submenu surfaces for every supported language', () => {
        // The Terminal submenu sends to whatever terminal is currently
        // active (tmux, Docker, …); it must stay reachable on .R, .Rmd,
        // and .qmd. The auto-include and Source-File entries inside the
        // submenu have their own gating — see the dedicated suite below.
        const pkg = loadPackageJson();
        const entries = pkg.contributes.menus['raven.sendToR'] ?? [];
        const submenu = findSubmenu(entries, 'raven.sendToR.terminal');
        assert.ok(submenu, 'raven.sendToR must reference the Terminal submenu');
        assert.strictEqual(
            submenu.when,
            undefined,
            'raven.sendToR.terminal submenu reference must have no `when` clause',
        );
    });
});

suite('Send to R → Terminal submenu: editor-title gating', () => {
    test('terminal auto-include and sourceFile entries hide on .Rmd / .qmd', () => {
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
            'raven.terminal.runLineOrSelection must have no `when` clause so it surfaces on .R, .Rmd, and .qmd alike',
        );
    });
});

suite('Send to R: shift+enter chord on chunk-based documents', () => {
    test('Knit takes Shift+Enter on .Rmd when the rmdKnit feature flag is on', () => {
        // The .R Shift+Enter shortcut runs `source()`. Knit is the closest
        // equivalent for an .Rmd document, so the chord is repurposed there
        // whenever the feature flag is on.
        const pkg = loadPackageJson();
        const bindings = pkg.contributes.keybindings ?? [];
        const entry = bindings.find(
            (b) =>
                b.command === 'raven.knit'
                && b.key === 'ctrl+shift+enter'
                && b.mac === 'cmd+shift+enter',
        );
        assert.ok(
            entry,
            'expected a raven.knit keybinding bound to ctrl+shift+enter / cmd+shift+enter',
        );
        const when = entry.when ?? '';
        assert.ok(
            when.includes('raven.rmdKnit.enabled'),
            `raven.knit keybinding must require raven.rmdKnit.enabled, got: ${when}`,
        );
        assert.ok(
            when.includes('editorLangId == rmd'),
            `raven.knit keybinding must fire for editorLangId == rmd, got: ${when}`,
        );
        assert.ok(
            RMD_ONLY_EXT.test(when),
            `raven.knit keybinding must reference the .Rmd-only extension family, got: ${when}`,
        );
        // Knit must not steal the chord on .qmd — Quarto preview belongs to
        // a separate command path.
        assert.ok(
            !when.includes('quarto'),
            `raven.knit keybinding must not fire for editorLangId == quarto, got: ${when}`,
        );
        assert.ok(
            !when.includes('qmd'),
            `raven.knit keybinding must not reference .qmd extensions, got: ${when}`,
        );
    });

    test('Run All Chunks takes Shift+Enter when Knit does not apply', () => {
        // The chord still has to do *something* useful on .qmd documents and
        // on .Rmd documents where the user disabled Knit, so Run All Chunks
        // is the fallback. The two keybindings must be mutually exclusive so
        // they cannot both fire on the same buffer.
        const pkg = loadPackageJson();
        const bindings = pkg.contributes.keybindings ?? [];
        const entry = bindings.find(
            (b) =>
                b.command === 'raven.runAllChunks'
                && b.key === 'ctrl+shift+enter'
                && b.mac === 'cmd+shift+enter',
        );
        assert.ok(
            entry,
            'expected a raven.runAllChunks keybinding bound to ctrl+shift+enter / cmd+shift+enter',
        );
        const when = entry.when ?? '';
        assert.ok(
            when.includes('editorLangId == quarto'),
            `raven.runAllChunks keybinding must fire for editorLangId == quarto, got: ${when}`,
        );
        assert.ok(
            QMD_ONLY_EXT.test(when),
            `raven.runAllChunks keybinding must reference the .qmd-only extension family, got: ${when}`,
        );
        // The .Rmd branch is gated on `!raven.rmdKnit.enabled` so it cannot
        // double-fire with Knit. We assert the negation is present alongside
        // the rmd language id and Rmd-only extension family.
        assert.ok(
            when.includes('!raven.rmdKnit.enabled'),
            `raven.runAllChunks keybinding must require !raven.rmdKnit.enabled on the .Rmd branch, got: ${when}`,
        );
        assert.ok(
            when.includes('editorLangId == rmd'),
            `raven.runAllChunks keybinding must include the .Rmd-knit-disabled fallback, got: ${when}`,
        );
        assert.ok(
            RMD_ONLY_EXT.test(when),
            `raven.runAllChunks keybinding must reference the .Rmd-only extension family for the knit-disabled branch, got: ${when}`,
        );
    });

    test('Source File keybinding stays restricted to plain .R', () => {
        // Pin the existing Source File gating so the new Knit / Run All Chunks
        // bindings can coexist on .Rmd / .qmd without double-firing.
        const pkg = loadPackageJson();
        const bindings = pkg.contributes.keybindings ?? [];
        const entry = bindings.find((b) => b.command === 'raven.sourceFile');
        assert.ok(entry, 'expected a raven.sourceFile keybinding');
        const when = entry.when ?? '';
        assert.ok(
            when.includes('editorLangId == r'),
            `raven.sourceFile must restrict to editorLangId == r, got: ${when}`,
        );
        assert.ok(
            when.includes('!(resourceExtname'),
            `raven.sourceFile must exclude .Rmd/.qmd extensions, got: ${when}`,
        );
        assert.ok(
            RMD_QMD_EXT.test(when),
            `raven.sourceFile must reference the .Rmd/.qmd extension family, got: ${when}`,
        );
    });

    test('runCurrentChunk no longer holds the Shift+Enter chord', () => {
        // Previously raven.runCurrentChunk was bound to cmd+shift+enter for
        // .Rmd / .qmd. With Knit and Run All Chunks taking that chord, the
        // previous binding must be removed (not duplicated) to avoid both
        // firing.
        const pkg = loadPackageJson();
        const bindings = pkg.contributes.keybindings ?? [];
        const conflict = bindings.find(
            (b) =>
                b.command === 'raven.runCurrentChunk'
                && (b.key === 'ctrl+shift+enter' || b.mac === 'cmd+shift+enter'),
        );
        assert.strictEqual(
            conflict,
            undefined,
            'raven.runCurrentChunk must not hold the Shift+Enter chord — that chord now belongs to Knit or Run All Chunks for .Rmd / .qmd',
        );
    });
});
