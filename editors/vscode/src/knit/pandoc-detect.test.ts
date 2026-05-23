import { describe, it, expect } from 'bun:test';
import { PandocResolver, PandocNotFoundError, defaultFallbacks } from './pandoc-detect';

const okAccess = (_: string) => Promise.resolve();
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
const noAccess = (_: string) => Promise.reject(enoent());

describe('PandocResolver', () => {
    it('uses the configured path when accessible', async () => {
        const r = new PandocResolver({
            getConfigured: () => '/custom/pandoc',
            access: okAccess,
            spawn: async () => 'pandoc 3.0',
        });
        expect(await r.resolve()).toBe('/custom/pandoc');
    });

    it('throws PandocNotFoundError when configured path is missing', async () => {
        const r = new PandocResolver({
            getConfigured: () => '/missing/pandoc',
            access: noAccess,
            spawn: async () => 'pandoc 3.0',
        });
        await expect(r.resolve()).rejects.toThrow(PandocNotFoundError);
    });

    it('falls back to bare `pandoc` on PATH when no configured path', async () => {
        const r = new PandocResolver({
            getConfigured: () => '',
            access: okAccess,
            spawn: async (bin: string) => (bin === 'pandoc' ? 'pandoc 3.0' : ''),
            fallbacks: () => [],
        });
        expect(await r.resolve()).toBe('pandoc');
    });

    it('falls back to platform paths when PATH lookup fails', async () => {
        const r = new PandocResolver({
            getConfigured: () => '',
            access: async (p: string) => {
                if (p === '/opt/homebrew/bin/pandoc') return;
                throw enoent();
            },
            spawn: async (bin: string) => {
                if (bin === 'pandoc') throw new Error('not found');
                return 'pandoc 3.0';
            },
            fallbacks: () => ['/opt/homebrew/bin/pandoc', '/usr/local/bin/pandoc'],
        });
        expect(await r.resolve()).toBe('/opt/homebrew/bin/pandoc');
    });

    it('throws when nothing works', async () => {
        const r = new PandocResolver({
            getConfigured: () => '',
            access: noAccess,
            spawn: async () => { throw new Error('not found'); },
            fallbacks: () => ['/x', '/y'],
        });
        await expect(r.resolve()).rejects.toThrow(PandocNotFoundError);
    });

    it('caches successful resolution', async () => {
        let spawnCalls = 0;
        const r = new PandocResolver({
            getConfigured: () => '',
            access: okAccess,
            spawn: async () => { spawnCalls++; return 'pandoc 3.0'; },
            fallbacks: () => [],
        });
        await r.resolve();
        await r.resolve();
        expect(spawnCalls).toBe(1);
    });

    it('invalidate() clears the cache', async () => {
        let spawnCalls = 0;
        const r = new PandocResolver({
            getConfigured: () => '',
            access: okAccess,
            spawn: async () => { spawnCalls++; return 'pandoc 3.0'; },
            fallbacks: () => [],
        });
        await r.resolve();
        r.invalidate();
        await r.resolve();
        expect(spawnCalls).toBe(2);
    });
});

describe('defaultFallbacks', () => {
    it('returns macOS paths on darwin', () => {
        const fallbacks = defaultFallbacks('darwin');
        expect(fallbacks).toContain('/opt/homebrew/bin/pandoc');
        expect(fallbacks).toContain('/usr/local/bin/pandoc');
    });
    it('returns linux paths on linux', () => {
        const fallbacks = defaultFallbacks('linux');
        expect(fallbacks).toContain('/usr/bin/pandoc');
    });
});
