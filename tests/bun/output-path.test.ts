import { describe, test, expect } from 'bun:test';
import { parseRenderedOutputPath } from '../../editors/vscode/src/knit/output-path';

describe('parseRenderedOutputPath', () => {
    test('extracts a single output path', () => {
        const stdout = [
            "processing file: foo.Rmd",
            "  |......                                          |  10%  ordinary text without R code",
            "",
            "Output created: foo.html",
            "",
        ].join('\n');
        const result = parseRenderedOutputPath(stdout);
        expect(result.paths).toEqual(['foo.html']);
    });

    test('extracts an absolute path', () => {
        const stdout = "Output created: /Users/me/proj/foo.html\n";
        expect(parseRenderedOutputPath(stdout).paths).toEqual(['/Users/me/proj/foo.html']);
    });

    test('returns empty when message is absent (quiet mode)', () => {
        const stdout = "rendering...\n";
        expect(parseRenderedOutputPath(stdout).paths).toEqual([]);
    });

    test('returns multiple paths for "all" output', () => {
        const stdout = [
            "Output created: foo.html",
            "more progress",
            "Output created: foo.pdf",
            "Output created: foo.docx",
        ].join('\n');
        expect(parseRenderedOutputPath(stdout).paths).toEqual([
            'foo.html', 'foo.pdf', 'foo.docx',
        ]);
    });

    test('trims trailing whitespace from the path', () => {
        const stdout = "Output created: foo.html   \n";
        expect(parseRenderedOutputPath(stdout).paths).toEqual(['foo.html']);
    });

    test('handles CRLF line endings', () => {
        const stdout = "Output created: foo.html\r\n";
        expect(parseRenderedOutputPath(stdout).paths).toEqual(['foo.html']);
    });

    test('matches paths with spaces (rmarkdown does not quote them)', () => {
        const stdout = "Output created: /Users/me/My Project/foo.html\n";
        expect(parseRenderedOutputPath(stdout).paths).toEqual([
            '/Users/me/My Project/foo.html',
        ]);
    });

    test('ignores leading whitespace on the message line', () => {
        const stdout = "    Output created: foo.html\n";
        expect(parseRenderedOutputPath(stdout).paths).toEqual(['foo.html']);
    });
});
