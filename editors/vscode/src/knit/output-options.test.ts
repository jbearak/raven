import { describe, it, expect } from 'bun:test';
import { parseOutputOptions } from './output-options';

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

    it('logs pandoc_args as ignored (v1)', () => {
        const r = parseOutputOptions(
            { output: { html_document: { pandoc_args: ['--lua-filter=evil.lua'] } } },
            'html',
        );
        expect(r.ignored).toContain('pandoc_args');
        expect((r.pandocFlags as { pandoc_args?: unknown }).pandoc_args).toBeUndefined();
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
