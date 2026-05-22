import { describe, test, expect } from 'bun:test';
import { computeMdOutputPath, computeHtmlOutputPath } from '../../editors/vscode/src/knit/knit-paths';

describe('computeMdOutputPath', () => {
    test('strips lowercase .rmd and appends .md', () => {
        expect(computeMdOutputPath('/tmp/foo.rmd')).toBe('/tmp/foo.md');
    });

    test('strips title-cased .Rmd and appends .md', () => {
        expect(computeMdOutputPath('/tmp/foo.Rmd')).toBe('/tmp/foo.md');
    });

    test('strips uppercase .RMD and appends .md', () => {
        expect(computeMdOutputPath('/tmp/foo.RMD')).toBe('/tmp/foo.md');
    });

    test('handles paths with multiple dots in the basename', () => {
        expect(computeMdOutputPath('/tmp/foo.bar.Rmd')).toBe('/tmp/foo.bar.md');
    });

    test('preserves directory traversal correctly', () => {
        expect(computeMdOutputPath('/a/b/c/doc.Rmd')).toBe('/a/b/c/doc.md');
    });

    test('falls back to appending .md when extension is missing', () => {
        // Defensive — the gate in runKnitCommand already requires .Rmd,
        // but if a bug ever lets a non-Rmd through we still produce a
        // sensible-looking output path rather than something weird.
        expect(computeMdOutputPath('/tmp/foo')).toBe('/tmp/foo.md');
    });
});

describe('computeHtmlOutputPath', () => {
    test('strips .Rmd and appends .html', () => {
        expect(computeHtmlOutputPath('/tmp/foo.Rmd')).toBe('/tmp/foo.html');
    });

    test('strips .rmd / .RMD case variants', () => {
        expect(computeHtmlOutputPath('/tmp/foo.rmd')).toBe('/tmp/foo.html');
        expect(computeHtmlOutputPath('/tmp/foo.RMD')).toBe('/tmp/foo.html');
    });

    test('matches computeMdOutputPath structurally', () => {
        // Both helpers share the same stripping logic; assert they
        // produce sibling files with parallel basenames so the
        // post-knit pipeline never has to second-guess.
        expect(computeMdOutputPath('/tmp/foo.Rmd').replace(/\.md$/, '.html'))
            .toBe(computeHtmlOutputPath('/tmp/foo.Rmd'));
    });
});
