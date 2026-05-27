import { describe, expect, it } from 'bun:test';
import { meetsMinVersion } from '../../editors/vscode/src/version-gate';

describe('meetsMinVersion', () => {
    // Gate used by viewer-tab-icon.ts: ThemeIcon webview tab icons require
    // VSCode >= 1.110, so the cutover point (1.109.x vs 1.110.0) matters.
    it('rejects versions below the cutoff', () => {
        expect(meetsMinVersion('1.82.0', 1, 110)).toBe(false);
        expect(meetsMinVersion('1.109.9', 1, 110)).toBe(false);
    });

    it('accepts the exact minimum and above', () => {
        expect(meetsMinVersion('1.110.0', 1, 110)).toBe(true);
        expect(meetsMinVersion('1.111.0', 1, 110)).toBe(true);
    });

    it('ignores patch and pre-release suffixes', () => {
        expect(meetsMinVersion('1.111.2-insider', 1, 110)).toBe(true);
        expect(meetsMinVersion('1.110.0-insider', 1, 110)).toBe(true);
    });

    it('compares the major version first', () => {
        expect(meetsMinVersion('2.0.0', 1, 110)).toBe(true);
        expect(meetsMinVersion('0.99.0', 1, 110)).toBe(false);
    });
});
