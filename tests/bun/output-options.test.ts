import { describe, it, expect } from 'bun:test';
import {
    parseOutputOptions,
    withSvgDevDefault,
} from '../../editors/vscode/src/knit/output-options';

describe('parseOutputOptions', () => {
    it('handles missing output: as empty', () => {
        const r = parseOutputOptions({}, 'html');
        expect(r.chunkOpts).toEqual({});
        expect(r.pandocFlags).toEqual({});
        expect(r.ignored).toEqual([]);
    });

    it('reads chunk opts from the requested format block', () => {
        const r = parseOutputOptions(
            { output: { pdf_document: { fig_width: 5, fig_height: 4 } } },
            'pdf',
        );
        expect(r.chunkOpts).toEqual({ fig_width: 5, fig_height: 4 });
    });

    it('reads pandoc flags from the requested format block', () => {
        const r = parseOutputOptions(
            { output: { pdf_document: { toc: true, toc_depth: 3, number_sections: true } } },
            'pdf',
        );
        expect(r.pandocFlags).toEqual({ toc: true, toc_depth: 3, number_sections: true });
    });

    it('ignores non-matching format blocks', () => {
        const r = parseOutputOptions(
            { output: { html_document: { toc_depth: 9 }, pdf_document: { toc_depth: 3 } } },
            'pdf',
        );
        expect(r.pandocFlags.toc_depth).toBe(3);
    });

    it('falls back to top-level keys when format block omits them', () => {
        const r = parseOutputOptions(
            { output: { toc: true, pdf_document: {} } },
            'pdf',
        );
        expect(r.pandocFlags.toc).toBe(true);
    });

    it('logs theme and code_folding as ignored', () => {
        const r = parseOutputOptions(
            { output: { html_document: { theme: 'cerulean', code_folding: 'hide' } } },
            'html',
        );
        expect(r.ignored).toContain('theme');
        expect(r.ignored).toContain('code_folding');
    });

    it('honors pandoc_args by appending kept entries to pandocArgs', () => {
        const r = parseOutputOptions(
            {
                output: {
                    html_document: {
                        pandoc_args: ['--shift-heading-level-by=1', '--wrap=auto'],
                    },
                },
            },
            'html',
        );
        expect(r.pandocArgs).toEqual(['--shift-heading-level-by=1', '--wrap=auto']);
        expect(r.droppedPandocArgs).toEqual([]);
        expect(r.ignored).not.toContain('pandoc_args');
    });

    it('strips destination flags (-o, --output) from pandoc_args, separate form', () => {
        const r = parseOutputOptions(
            {
                output: {
                    html_document: {
                        pandoc_args: ['-o', '/tmp/x.html', '--shift-heading-level-by=1'],
                    },
                },
            },
            'html',
        );
        expect(r.pandocArgs).toEqual(['--shift-heading-level-by=1']);
        expect(r.droppedPandocArgs).toEqual(['-o', '/tmp/x.html']);
    });

    it('strips --output=value (equals form)', () => {
        const r = parseOutputOptions(
            { output: { html_document: { pandoc_args: ['--output=/tmp/x.html', '--toc'] } } },
            'html',
        );
        expect(r.pandocArgs).toEqual(['--toc']);
        expect(r.droppedPandocArgs).toEqual(['--output=/tmp/x.html']);
    });

    it('strips -oFILE (attached short form)', () => {
        const r = parseOutputOptions(
            { output: { html_document: { pandoc_args: ['-o/tmp/x.html', '--wrap=auto'] } } },
            'html',
        );
        expect(r.pandocArgs).toEqual(['--wrap=auto']);
        expect(r.droppedPandocArgs).toEqual(['-o/tmp/x.html']);
    });

    it('strips format flags (-t, --to, -w, --write) in every variant', () => {
        const r = parseOutputOptions(
            {
                output: {
                    html_document: {
                        pandoc_args: [
                            '-t', 'docx',
                            '--to=pdf',
                            '-w', 'docx',
                            '--write=pdf',
                            '-tdocx',
                            '-wdocx',
                            '--wrap=auto',
                        ],
                    },
                },
            },
            'html',
        );
        expect(r.pandocArgs).toEqual(['--wrap=auto']);
        expect(r.droppedPandocArgs).toEqual([
            '-t', 'docx',
            '--to=pdf',
            '-w', 'docx',
            '--write=pdf',
            '-tdocx',
            '-wdocx',
        ]);
    });

    it('drops non-string entries silently', () => {
        const r = parseOutputOptions(
            { output: { html_document: { pandoc_args: ['--toc', 123, null, '--wrap=auto'] } } },
            'html',
        );
        expect(r.pandocArgs).toEqual(['--toc', '--wrap=auto']);
    });

    it('treats non-array pandoc_args as no-op', () => {
        const r = parseOutputOptions(
            { output: { html_document: { pandoc_args: 'oops' } } },
            'html',
        );
        expect(r.pandocArgs).toEqual([]);
        expect(r.droppedPandocArgs).toEqual([]);
    });

    it('does NOT strip flags whose names start with -o/-t/-w but are different long options', () => {
        // --output-format is hypothetical; the real concern is that --shift-heading-level-by=-1
        // (negative value) and similar must not be mistaken for short -o/-t/-w.
        const r = parseOutputOptions(
            {
                output: {
                    html_document: {
                        pandoc_args: ['--shift-heading-level-by=-1', '--top-level-division=part'],
                    },
                },
            },
            'html',
        );
        expect(r.pandocArgs).toEqual(['--shift-heading-level-by=-1', '--top-level-division=part']);
        expect(r.droppedPandocArgs).toEqual([]);
    });

    it('accepts string output: as format-name shorthand (no options)', () => {
        const r = parseOutputOptions({ output: 'pdf_document' }, 'pdf');
        expect(r.chunkOpts).toEqual({});
        expect(r.pandocFlags).toEqual({});
    });

    it('validates dev against allowlist; rejects unknown', () => {
        const ok = parseOutputOptions({ output: { html_document: { dev: 'png' } } }, 'html');
        expect(ok.chunkOpts.dev).toBe('png');
        const bad = parseOutputOptions({ output: { html_document: { dev: 'rm -rf' } } }, 'html');
        expect(bad.chunkOpts.dev).toBeUndefined();
        expect(bad.ignored).toContain('dev');
    });

    it('html alias formats (bookdown::html_document2) match the html target', () => {
        const r = parseOutputOptions(
            { output: { 'bookdown::html_document2': { toc: true } } },
            'html',
        );
        expect(r.pandocFlags.toc).toBe(true);
    });

    it('honors css string and css array', () => {
        const single = parseOutputOptions(
            { output: { html_document: { css: 'style.css' } } },
            'html',
        );
        expect(single.pandocFlags.css).toEqual(['style.css']);
        const arr = parseOutputOptions(
            { output: { html_document: { css: ['a.css', 'b.css'] } } },
            'html',
        );
        expect(arr.pandocFlags.css).toEqual(['a.css', 'b.css']);
    });

    it('validates highlight against allowlist', () => {
        const ok = parseOutputOptions(
            { output: { html_document: { highlight: 'tango' } } },
            'html',
        );
        expect(ok.pandocFlags.highlight).toBe('tango');
        const bad = parseOutputOptions(
            { output: { html_document: { highlight: 'rm -rf' } } },
            'html',
        );
        expect(bad.pandocFlags.highlight).toBeUndefined();
        expect(bad.ignored).toContain('highlight');
    });
});

describe('withSvgDevDefault', () => {
    it('injects dev=svg when not set', () => {
        expect(withSvgDevDefault({})).toEqual({ dev: 'svg' });
    });

    it('preserves an existing dev value', () => {
        expect(withSvgDevDefault({ dev: 'png' })).toEqual({ dev: 'png' });
        expect(withSvgDevDefault({ dev: 'pdf' })).toEqual({ dev: 'pdf' });
        expect(withSvgDevDefault({ dev: 'cairo_pdf' })).toEqual({ dev: 'cairo_pdf' });
    });

    it('preserves other chunk options', () => {
        const input = { fig_width: 8, fig_height: 5, dpi: 300 };
        expect(withSvgDevDefault(input)).toEqual({
            fig_width: 8,
            fig_height: 5,
            dpi: 300,
            dev: 'svg',
        });
    });

    it('does not mutate the input', () => {
        const input = { fig_width: 8 };
        const out = withSvgDevDefault(input);
        expect(input).toEqual({ fig_width: 8 });
        expect(out).not.toBe(input);
    });
});
