import { describe, it, expect } from 'bun:test';
import { isPandocVersionOutput } from '../../editors/vscode/src/knit/pandoc-probe';

describe('isPandocVersionOutput', () => {
    it('accepts real pandoc version output', () => {
        expect(isPandocVersionOutput('pandoc 3.9.0.2')).toBe(true);
        expect(isPandocVersionOutput('pandoc 2.19.2\nCompiled with…')).toBe(true);
        expect(isPandocVersionOutput('pandoc 1.16')).toBe(true);
    });

    it('accepts pandoc with leading blank lines', () => {
        expect(isPandocVersionOutput('\n\npandoc 3.0\n')).toBe(true);
    });

    it('matches case-insensitively', () => {
        expect(isPandocVersionOutput('Pandoc 3.0')).toBe(true);
        expect(isPandocVersionOutput('PANDOC 3.0')).toBe(true);
    });

    it('handles CRLF line endings', () => {
        expect(isPandocVersionOutput('\r\npandoc 3.0\r\n')).toBe(true);
    });

    it('rejects /bin/echo --version stdout', () => {
        // macOS `/bin/echo --version` exits 0 and prints "--version".
        expect(isPandocVersionOutput('--version')).toBe(false);
    });

    it('rejects empty stdout', () => {
        expect(isPandocVersionOutput('')).toBe(false);
        expect(isPandocVersionOutput('\n\n  \n')).toBe(false);
    });

    it('rejects other coreutils version banners', () => {
        expect(isPandocVersionOutput('echo (GNU coreutils) 9.4')).toBe(false);
        expect(isPandocVersionOutput('cat (GNU coreutils) 9.4')).toBe(false);
        expect(isPandocVersionOutput('R version 4.4.0 (2024-04-24)')).toBe(false);
    });

    it('rejects substrings — must be a word-boundary prefix', () => {
        expect(isPandocVersionOutput('mypandoc 1.0')).toBe(false);
        expect(isPandocVersionOutput('not-pandoc 1.0')).toBe(false);
    });

    it('rejects pandoc-citeproc (separate binary)', () => {
        // Looks like pandoc but is a different tool; we only want the
        // real pandoc binary.
        expect(isPandocVersionOutput('pandoc-citeproc 0.17.0')).toBe(false);
    });

    it('accepts "pandoc" alone (no version trailing)', () => {
        // Defensive — if a future pandoc trimmed the version, the prefix
        // match still works.
        expect(isPandocVersionOutput('pandoc')).toBe(true);
    });
});
