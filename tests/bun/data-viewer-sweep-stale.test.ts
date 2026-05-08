import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, utimes, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sweep_stale } from '../../editors/vscode/src/data-viewer/sweep';

describe('sweep_stale', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'raven-sweep-'));
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    test('returns 0 for an empty directory', async () => {
        expect(await sweep_stale(dir, 1000)).toBe(0);
    });

    test('returns 0 when the directory does not exist', async () => {
        await rm(dir, { recursive: true, force: true });
        expect(await sweep_stale(dir, 1000)).toBe(0);
    });

    test('removes files older than maxAge, leaves newer ones', async () => {
        const oldFp = join(dir, 'old.arrow');
        const newFp = join(dir, 'new.arrow');
        await writeFile(oldFp, 'old');
        await writeFile(newFp, 'new');
        const now = Date.now();
        // Backdate old.arrow by 48 hours.
        const old = new Date(now - 48 * 3600 * 1000);
        await utimes(oldFp, old, old);
        const removed = await sweep_stale(dir, 24 * 3600 * 1000, now);
        expect(removed).toBe(1);
        const remaining = await readdir(dir);
        expect(remaining).toEqual(['new.arrow']);
    });

    test('survives a subdirectory inside the data-viewer dir', async () => {
        await mkdir(join(dir, 'subdir'));
        const fp = join(dir, 'a.arrow');
        await writeFile(fp, 'a');
        const past = new Date(Date.now() - 48 * 3600 * 1000);
        await utimes(fp, past, past);
        const removed = await sweep_stale(dir, 24 * 3600 * 1000);
        expect(removed).toBe(1);
        // subdir untouched
        const remaining = await readdir(dir);
        expect(remaining).toContain('subdir');
        expect(remaining).not.toContain('a.arrow');
    });
});
