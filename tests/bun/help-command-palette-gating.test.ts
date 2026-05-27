import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Guard that the three help-viewer commands stay hidden from the command
 * palette.
 *
 * `raven.openHelpPanel` needs a resolved `(topic, package)` pair, which only
 * the hover command-link supplies; invoked bare from the palette it would show
 * "cannot open help — no package known for topic 'undefined'". The
 * `raven.help.back` / `raven.help.forward` navigation commands likewise no-op
 * without an open panel. All three are therefore gated out of the palette with
 * a `menus.commandPalette` entry whose `when` is the literal string `"false"`.
 *
 * They remain declared in `contributes.commands` (so they're registered and
 * still invokable via `executeCommand` and the hover command-link) — palette
 * `when` gating does not affect command-link execution. This test fails fast if
 * a future edit drops the gating and re-leaks them into the palette.
 */
const VSCODE_ROOT = path.resolve(__dirname, '..', '..', 'editors', 'vscode');
const PACKAGE_JSON = path.join(VSCODE_ROOT, 'package.json');

const GATED_COMMANDS = [
    'raven.openHelpPanel',
    'raven.help.back',
    'raven.help.forward',
];

interface CommandContribution {
    command: string;
    title?: string;
    category?: string;
}

interface MenuEntry {
    command: string;
    when?: string;
}

function readManifest(): {
    commands: CommandContribution[];
    commandPalette: MenuEntry[];
} {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')) as {
        contributes?: {
            commands?: CommandContribution[];
            menus?: { commandPalette?: MenuEntry[] };
        };
    };
    return {
        commands: pkg.contributes?.commands ?? [],
        commandPalette: pkg.contributes?.menus?.commandPalette ?? [],
    };
}

describe('help commands are hidden from the command palette', () => {
    const { commands, commandPalette } = readManifest();

    for (const command of GATED_COMMANDS) {
        test(`${command} is declared in contributes.commands`, () => {
            expect(commands.some((c) => c.command === command)).toBe(true);
        });

        test(`${command} is gated out of the palette with when: "false"`, () => {
            const entries = commandPalette.filter((m) => m.command === command);
            expect(entries.length).toBe(1);
            expect(entries[0].when).toBe('false');
        });
    }
});
