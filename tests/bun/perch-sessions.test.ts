import { describe, expect, test } from 'bun:test';
import type { SessionInfo } from '../../editors/vscode/src/send-to-r/perch-api';
import { perch_error_code } from '../../editors/vscode/src/send-to-r/perch-api';
import {
    as_typed,
    escape_perch_env,
    escape_perch_text,
    perch_annotations,
    RAVEN_CALLER_ID,
    reattach_candidates,
    session_console_socket,
    session_program,
} from '../../editors/vscode/src/send-to-r/perch-sessions';

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
    return {
        id: 'k3x9q2ab',
        name: 'R',
        kind: 'r',
        owner: RAVEN_CALLER_ID,
        annotations: { 'raven.program': 'raven', 'raven.console': 'ipc' },
        dir: '/tmp/perch-501/k3x9q2ab',
        degraded: [],
        cwd: '/work',
        host: 'h',
        createdAt: '2026-11-01T12:00:00Z',
        state: 'running',
        attached: false,
        attachedHere: false,
        ...overrides,
    };
}

/** `perch new`'s expansion: `{{`/`}}` literal, `{dir}`/`{id}` substituted, other braces an error. */
function perch_expand(text: string, dir: string, id: string): string {
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const rest = text.slice(i);
        if (rest.startsWith('{{')) { out += '{'; i++; continue; }
        if (rest.startsWith('}}')) { out += '}'; i++; continue; }
        if (rest.startsWith('{dir}')) { out += dir; i += 4; continue; }
        if (rest.startsWith('{id}')) { out += id; i += 3; continue; }
        if (text[i] === '{' || text[i] === '}') throw new Error(`lone brace at ${i}`);
        out += text[i];
    }
    return out;
}

describe('escape_perch_text', () => {
    test('braces and placeholders reach the program literally', () => {
        for (const text of ['/opt/R{4}/bin/R', 'a}b', '{dir}/x', '{id}', 'awk {print $1}', '{{', 'plain']) {
            expect(perch_expand(escape_perch_text(text), '/D', 'ID')).toBe(text);
        }
    });

    test('env values are escaped, names kept', () => {
        expect(escape_perch_env({ R_LIBS: '/lib{dir}', X: 'y' })).toEqual({ R_LIBS: '/lib{{dir}}', X: 'y' });
        expect(escape_perch_env(undefined)).toBeUndefined();
    });
});

describe('session annotations', () => {
    test('a console session is marked with its program and socket', () => {
        expect(perch_annotations('raven', true)).toEqual({ 'raven.program': 'raven', 'raven.console': 'ipc' });
        expect(perch_annotations('radian', false)).toEqual({ 'raven.program': 'radian' });
    });

    test('program from the annotation, else from the console mark', () => {
        expect(session_program(session())).toBe('raven');
        expect(session_program(session({ annotations: { 'raven.program': 'arf' } }))).toBe('arf');
        expect(session_program(session({ annotations: { 'raven.console': 'ipc' } }))).toBe('raven');
        expect(session_program(session({ annotations: { 'raven.program': 'bogus' } }))).toBe('R');
    });

    test('console socket in the session directory, gone once the directory was recreated', () => {
        expect(session_console_socket(session())).toBe('/tmp/perch-501/k3x9q2ab/ipc');
        expect(session_console_socket(session({ degraded: ['directory-recreated'] }))).toBeUndefined();
        expect(session_console_socket(session({ annotations: { 'raven.program': 'R' } }))).toBeUndefined();
    });
});

describe('reattach_candidates', () => {
    test("running Raven sessions of the program with no terminal here, from any workspace", () => {
        const here = session({ id: 'here0001', attached: true, attachedHere: true });
        const elsewhere = session({ id: 'else0001', attached: true, cwd: '/other-workspace' });
        const detached = session({ id: 'detached' });
        const exited = session({ id: 'exited01', state: 'exited' });
        const lost = session({ id: 'lost0001', state: 'lost' });
        const radian = session({ id: 'radian01', annotations: { 'raven.program': 'radian' } });
        const foreign = session({ id: 'foreign1', owner: 'jbearak.sight' });
        const unowned = session({ id: 'unowned1', owner: undefined });
        const listed = [here, elsewhere, detached, exited, lost, radian, foreign, unowned];
        expect(reattach_candidates(listed, 'raven', new Set(['here0001'])).map((s) => s.id))
            .toEqual(['else0001', 'detached']);
        expect(reattach_candidates(listed, 'radian', new Set()).map((s) => s.id)).toEqual(['radian01']);
    });
});

describe('as_typed', () => {
    test('line breaks become Enter; submit adds the last one', () => {
        expect(as_typed('x <- 1\nprint(x)')).toBe('x <- 1\rprint(x)');
        expect(as_typed('x\r\n')).toBe('x');
        expect(as_typed('x')).toBe('x');
    });
});

describe('perch_error_code', () => {
    test('reads the code of a PerchApiError, by name', () => {
        const err = Object.assign(new Error('x'), { name: 'PerchApiError', code: 'outcome_unknown' });
        expect(perch_error_code(err)).toBe('outcome_unknown');
        expect(perch_error_code(new Error('x'))).toBeUndefined();
        expect(perch_error_code(Object.assign(new Error('x'), { name: 'PerchApiError', code: 'other' }))).toBeUndefined();
        expect(perch_error_code(undefined)).toBeUndefined();
    });
});
