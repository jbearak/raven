import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from 'jsonc-parser';
import {
    COMMANDS_VSCODE_R_SHADOWS,
    raven_user_keybindings,
    with_user_keybindings,
    type ContributedKeybinding,
} from '../../editors/vscode/src/send-to-r/raven-keybinding-entries';

const manifest = JSON.parse(
    fs.readFileSync(path.join(import.meta.dir, '../../editors/vscode/package.json'), 'utf8'),
) as { contributes: { keybindings: ContributedKeybinding[] } };
const entries = raven_user_keybindings(manifest.contributes.keybindings);

describe('raven_user_keybindings', () => {
    test("writes a Mac and a non-Mac entry for each shadowed command's binding", () => {
        const commands = new Set(entries.map((e) => e.command));
        expect([...commands].sort()).toEqual([...COMMANDS_VSCODE_R_SHADOWS].sort());
        expect(entries).toContainEqual({
            key: 'cmd+enter',
            command: 'raven.runLineOrSelection',
            when: 'isMac && (editorTextFocus && (editorLangId == r || editorLangId == rmd || editorLangId == quarto) && raven.rConsoleEnabled) && (editorLangId == r || editorLangId == rmd)',
        });
        expect(entries).toContainEqual(expect.objectContaining({
            key: 'ctrl+enter',
            command: 'raven.runLineOrSelection',
        }));
        for (const entry of entries) {
            expect(entry.when).toMatch(/^!?isMac && /);
            expect(entry.when.endsWith('&& (editorLangId == r || editorLangId == rmd)')).toBe(true);
            expect(entry.when).toContain('raven.rConsoleEnabled');
        }
    });
});

describe('with_user_keybindings', () => {
    test('fills an empty file', () => {
        const result = with_user_keybindings('', entries);
        expect(result?.added).toBe(entries.length);
        expect(parse(result!.text)).toEqual(entries);
    });

    test("keeps VS Code's comment header and the user's own entries", () => {
        const text = '// Place your key bindings in this file to override the defaults\n[\n    { "key": "cmd+r", "command": "workbench.action.reloadWindow" },\n]\n';
        const result = with_user_keybindings(text, entries)!;
        expect(result.text.startsWith('// Place your key bindings')).toBe(true);
        const parsed = parse(result.text) as unknown[];
        expect(parsed[0]).toEqual({ key: 'cmd+r', command: 'workbench.action.reloadWindow' });
        expect(parsed.slice(1)).toEqual(entries);
    });

    test('adds nothing the second time', () => {
        const once = with_user_keybindings('[]', entries)!.text;
        expect(with_user_keybindings(once, entries)).toEqual({ text: once, added: 0 });
    });

    test('adds only the entries that are missing', () => {
        const partial = with_user_keybindings('[]', entries.slice(0, 3))!.text;
        const result = with_user_keybindings(partial, entries)!;
        expect(result.added).toBe(entries.length - 3);
        expect(parse(result.text)).toEqual(entries);
    });

    test('refuses a file that is not a JSON array', () => {
        expect(with_user_keybindings('{}', entries)).toBeNull();
        expect(with_user_keybindings('[ { "key": ', entries)).toBeNull();
    });
});
