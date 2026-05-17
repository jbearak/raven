import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateServerBinary } from '../../editors/vscode/src/server-binary-check';

describe('validateServerBinary', () => {
    let tmp: string;
    let executable: string;
    let nonExecutable: string;
    let dir: string;

    beforeAll(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-binarycheck-'));
        executable = path.join(tmp, 'good');
        nonExecutable = path.join(tmp, 'bad');
        dir = path.join(tmp, 'a-directory');
        fs.writeFileSync(executable, '#!/bin/sh\necho hi\n');
        fs.chmodSync(executable, 0o755);
        fs.writeFileSync(nonExecutable, 'not a script');
        fs.chmodSync(nonExecutable, 0o644);
        fs.mkdirSync(dir);
    });

    afterAll(() => {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
    });

    test('returns ok for an existing executable file', () => {
        expect(validateServerBinary(executable)).toEqual({ ok: true });
    });

    test('returns ok: false when the path does not exist', () => {
        const result = validateServerBinary(path.join(tmp, 'missing'));
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toMatch(/missing|ENOENT|no such/i);
        }
    });

    test('returns ok: false when the path is a directory', () => {
        const result = validateServerBinary(dir);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toMatch(/directory|not.*file/i);
        }
    });

    test('returns ok: false when the file is not executable (POSIX)', () => {
        if (process.platform === 'win32') return;
        const result = validateServerBinary(nonExecutable);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toMatch(/not executable|EACCES|permission/i);
        }
    });
});
