import { describe, it, expect } from 'bun:test';
import {
    canonicalOpKey,
    computeWorkspaceHash,
    computeSourceHash,
    isUnderContainmentRoot,
    sessionRoot,
    previewDirFor,
    exportDirFor,
} from '../../editors/vscode/src/knit/raven-knit-paths';

describe('canonicalOpKey', () => {
    it('normalizes posix paths unchanged on darwin/linux', () => {
        expect(canonicalOpKey({ fsPath: '/Users/x/foo.Rmd' } as never, 'darwin')).toBe('/Users/x/foo.Rmd');
        expect(canonicalOpKey({ fsPath: '/home/x/foo.Rmd' } as never, 'linux')).toBe('/home/x/foo.Rmd');
    });
    it('lowercases on Windows', () => {
        expect(canonicalOpKey({ fsPath: 'C:\\Users\\X\\Foo.Rmd' } as never, 'win32')).toBe('c:\\users\\x\\foo.rmd');
    });
});

describe('computeWorkspaceHash', () => {
    it('is stable for the same URI', () => {
        expect(computeWorkspaceHash('file:///Users/x/proj')).toBe(computeWorkspaceHash('file:///Users/x/proj'));
    });
    it('differs across URIs', () => {
        expect(computeWorkspaceHash('file:///a')).not.toBe(computeWorkspaceHash('file:///b'));
    });
    it('returns a 64-char hex digest', () => {
        expect(computeWorkspaceHash('file:///x')).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe('computeSourceHash', () => {
    it('hashes the absolute path deterministically', () => {
        const a = computeSourceHash('/p/foo.Rmd');
        const b = computeSourceHash('/p/foo.Rmd');
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
    });
    it('differs for different paths', () => {
        expect(computeSourceHash('/p/a.Rmd')).not.toBe(computeSourceHash('/p/b.Rmd'));
    });
});

describe('isUnderContainmentRoot', () => {
    it('accepts a path inside the root', () => {
        expect(isUnderContainmentRoot('/p/style.css', '/p')).toBe(true);
    });
    it('accepts the root itself', () => {
        expect(isUnderContainmentRoot('/p', '/p')).toBe(true);
    });
    it('rejects parent escapes', () => {
        expect(isUnderContainmentRoot('/q/x.css', '/p')).toBe(false);
    });
    it('handles nested paths', () => {
        expect(isUnderContainmentRoot('/p/css/style.css', '/p')).toBe(true);
    });
    it('rejects ../ traversal escapes after normalization', () => {
        expect(isUnderContainmentRoot('/p/../q/x.css', '/p')).toBe(false);
    });
});

describe('sessionRoot / previewDirFor / exportDirFor', () => {
    it('composes the expected paths', () => {
        const root = sessionRoot('abc', 'sess1');
        expect(root.endsWith('raven-knit/abc/sess1') || root.endsWith('raven-knit\\abc\\sess1')).toBe(true);
        const preview = previewDirFor('abc', 'sess1', 'srchash');
        expect(preview.endsWith('raven-knit/abc/sess1/preview/srchash') || preview.endsWith('raven-knit\\abc\\sess1\\preview\\srchash')).toBe(true);
        const exp = exportDirFor('abc', 'sess1', 'uuid');
        expect(exp.endsWith('raven-knit/abc/sess1/export/uuid') || exp.endsWith('raven-knit\\abc\\sess1\\export\\uuid')).toBe(true);
    });
});
