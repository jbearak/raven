import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
    detection_script,
    effective_target,
    keep_session_choice_after_setting_change,
    parse_detection_output,
    parse_program_setting,
    terminal_name_for,
} from '../../editors/vscode/src/send-to-r/console-choice';
import { take_pending_profile, type PendingProfile } from '../../editors/vscode/src/send-to-r/pending-profiles';

describe('effective_target', () => {
    test('asks when the setting is ask and nothing is chosen', () => {
        expect(effective_target(null, 'ask')).toBeUndefined();
    });

    test('uses an explicit setting', () => {
        expect(effective_target(null, 'arf')).toBe('arf');
    });

    test('the session choice beats an explicit setting', () => {
        expect(effective_target('raven', 'R')).toBe('raven');
        expect(effective_target('vscode-R', 'ask')).toBe('vscode-R');
    });
});

describe('parse_program_setting', () => {
    test('known values pass through; anything else means ask', () => {
        expect(parse_program_setting('vscode-R')).toBe('vscode-R');
        expect(parse_program_setting('raven')).toBe('raven');
        expect(parse_program_setting('ask')).toBe('ask');
        expect(parse_program_setting(undefined)).toBe('ask');
        expect(parse_program_setting('emacs')).toBe('ask');
    });
});

describe('keep_session_choice_after_setting_change', () => {
    test('the picker writing "All sessions" keeps the choice', () => {
        expect(keep_session_choice_after_setting_change('arf', 'arf', 'arf')).toBe(true);
    });

    test('keeps it when a workspace value overrides the Global one the picker wrote', () => {
        // Workspace says R; the user picked arf for all sessions.
        expect(keep_session_choice_after_setting_change('arf', 'arf', 'R')).toBe(true);
    });

    test('an outside edit to a different value clears the choice', () => {
        expect(keep_session_choice_after_setting_change('arf', 'radian', 'radian')).toBe(false);
        expect(keep_session_choice_after_setting_change('raven', undefined, 'ask')).toBe(false);
    });

    test('no choice stays no choice', () => {
        expect(keep_session_choice_after_setting_change(null, 'R', 'R')).toBe(false);
    });
});

describe('terminal_name_for', () => {
    test("Raven's console is just R", () => {
        expect(terminal_name_for('raven')).toBe('R');
        expect(terminal_name_for('R')).toBe('R (plain)');
        expect(terminal_name_for('arf')).toBe('arf');
        expect(terminal_name_for('radian')).toBe('radian');
    });
});

describe('console detection', () => {
    test('arf alone', () => {
        expect([...parse_detection_output('/opt/homebrew/bin/arf\n')]).toEqual(['arf']);
    });

    test('radian alone', () => {
        expect([...parse_detection_output('/usr/local/bin/radian\n')]).toEqual(['radian']);
    });

    test('both, among rc-file noise', () => {
        const stdout = [
            'Welcome to zsh',
            '/opt/homebrew/bin/arf',
            'conda activated',
            '/Users/me/Library/Python/3.12/bin/radian',
        ].join('\n');
        expect([...parse_detection_output(stdout)].sort()).toEqual(['arf', 'radian']);
    });

    test('neither', () => {
        expect(parse_detection_output('').size).toBe(0);
        expect(parse_detection_output('motd only\n').size).toBe(0);
    });

    test('an alias or shell function is not a launchable program', () => {
        expect(parse_detection_output("alias arf='cargo run'\n").size).toBe(0);
        expect(parse_detection_output('radian\n').size).toBe(0);
        // A path that merely contains the name doesn't count.
        expect(parse_detection_output('/opt/arf/bin/arf-helper\n').size).toBe(0);
    });

    test('paths with spaces are accepted', () => {
        expect([...parse_detection_output('/Users/me/My Tools/arf\n')]).toEqual(['arf']);
    });

    test('the script works in sh, zsh and bash (those installed), with a missing last program', async () => {
        const dir = `${process.env.TMPDIR ?? '/tmp'}/raven-detect-${process.pid}`;
        await Bun.$`mkdir -p ${dir} && printf '#!/bin/sh\n' > ${dir}/arf && chmod +x ${dir}/arf`;
        const shells = ['/bin/sh', '/bin/zsh', '/bin/bash'].filter((shell) => existsSync(shell));
        for (const shell of shells) {
            const result = await Bun.$`${shell} -c ${detection_script()}`
                .env({ PATH: `${dir}:/usr/bin:/bin` })
                .nothrow()
                .quiet();
            expect(result.exitCode).toBe(0);
            expect([...parse_detection_output(result.stdout.toString())]).toEqual(['arf']);
        }
        await Bun.$`rm -rf ${dir}`;
    });
});

describe('take_pending_profile', () => {
    const entry = (program: PendingProfile['program'], at: number): PendingProfile => ({
        program,
        generatedAtMs: at,
    });

    test('claims only the entry with the matching id', () => {
        const pending = new Map([['a', entry('raven', 1000)], ['b', entry('R', 1000)]]);
        // Out of order: b opens first.
        expect(take_pending_profile(pending, 'b', 1500)?.program).toBe('R');
        expect(take_pending_profile(pending, 'a', 1500)?.program).toBe('raven');
        expect(pending.size).toBe(0);
    });

    test('an unrelated terminal (no id) claims nothing', () => {
        const pending = new Map([['a', entry('raven', 1000)]]);
        expect(take_pending_profile(pending, undefined, 1500)).toBeNull();
        expect(take_pending_profile(pending, 'other', 1500)).toBeNull();
        expect(pending.size).toBe(1);
    });

    test('expired entries are swept', () => {
        const pending = new Map([['a', entry('raven', 0)], ['b', entry('R', 50_000)]]);
        expect(take_pending_profile(pending, 'a', 60_000, 30_000)).toBeNull();
        expect([...pending.keys()]).toEqual(['b']);
    });
});
