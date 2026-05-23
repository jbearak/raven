import { describe, it, expect } from 'bun:test';
import { buildPandocArgs } from '../../editors/vscode/src/knit/pandoc-args';
import type { OutputOptions } from '../../editors/vscode/src/knit/output-options';

const emptyOpts: OutputOptions = { chunkOpts: {}, pandocFlags: {}, ignored: [] };

describe('buildPandocArgs', () => {
    it('produces minimal args for HTML', () => {
        const args = buildPandocArgs(emptyOpts, 'html', {
            mdPath: 'in.md',
            outPath: 'out.html',
            sourceDir: '/p',
            containmentRoot: '/p',
        });
        expect(args).toEqual(['in.md', '-o', 'out.html', '--to', 'html5', '--standalone']);
    });

    it('produces minimal args for PDF with xelatex default', () => {
        const args = buildPandocArgs(emptyOpts, 'pdf', {
            mdPath: 'in.md',
            outPath: 'out.pdf',
            sourceDir: '/p',
            containmentRoot: '/p',
            pdfEngine: 'xelatex',
        });
        expect(args).toEqual(['in.md', '-o', 'out.pdf', '--to', 'pdf', '--pdf-engine=xelatex']);
    });

    it('produces minimal args for DOCX', () => {
        const args = buildPandocArgs(emptyOpts, 'docx', {
            mdPath: 'in.md',
            outPath: 'out.docx',
            sourceDir: '/p',
            containmentRoot: '/p',
        });
        expect(args).toEqual(['in.md', '-o', 'out.docx', '--to', 'docx']);
    });

    it('appends --toc / --toc-depth / --number-sections', () => {
        const o: OutputOptions = { ...emptyOpts, pandocFlags: { toc: true, toc_depth: 4, number_sections: true } };
        const args = buildPandocArgs(o, 'html', {
            mdPath: 'in.md',
            outPath: 'out.html',
            sourceDir: '/p',
            containmentRoot: '/p',
        });
        expect(args).toContain('--toc');
        expect(args).toContain('--toc-depth=4');
        expect(args).toContain('--number-sections');
    });

    it('resolves css against sourceDir and inserts --css=<abs>', () => {
        const o: OutputOptions = { ...emptyOpts, pandocFlags: { css: ['style.css'] } };
        const args = buildPandocArgs(o, 'html', {
            mdPath: 'in.md',
            outPath: 'out.html',
            sourceDir: '/p',
            containmentRoot: '/p',
        });
        expect(args).toContain('--css=/p/style.css');
    });

    it('drops css entries that escape containmentRoot and reports them via detailed()', () => {
        const o: OutputOptions = { ...emptyOpts, pandocFlags: { css: ['../../../../etc/passwd', 'style.css'] } };
        const result = buildPandocArgs.detailed(o, 'html', {
            mdPath: 'in.md',
            outPath: 'out.html',
            sourceDir: '/p/sub',
            containmentRoot: '/p',
        });
        expect(result.args).toContain('--css=/p/sub/style.css');
        expect(result.args.some((a: string) => a.includes('passwd'))).toBe(false);
        expect(result.droppedCss).toContain('../../../../etc/passwd');
    });

    it('appends --embed-resources --standalone for self_contained', () => {
        const o: OutputOptions = { ...emptyOpts, pandocFlags: { self_contained: true } };
        const args = buildPandocArgs(o, 'html', {
            mdPath: 'in.md',
            outPath: 'out.html',
            sourceDir: '/p',
            containmentRoot: '/p',
        });
        expect(args).toContain('--embed-resources');
        expect(args).toContain('--standalone');
    });

    it('appends --highlight-style when present', () => {
        const o: OutputOptions = { ...emptyOpts, pandocFlags: { highlight: 'tango' } };
        const args = buildPandocArgs(o, 'pdf', {
            mdPath: 'in.md',
            outPath: 'o.pdf',
            sourceDir: '/p',
            containmentRoot: '/p',
            pdfEngine: 'xelatex',
        });
        expect(args).toContain('--highlight-style=tango');
    });

    it('appends --mathjax when mathjax: true', () => {
        const o: OutputOptions = { ...emptyOpts, pandocFlags: { mathjax: true } };
        const args = buildPandocArgs(o, 'html', {
            mdPath: 'in.md',
            outPath: 'o.html',
            sourceDir: '/p',
            containmentRoot: '/p',
        });
        expect(args).toContain('--mathjax');
    });

    it('accepts absolute css paths inside containment root', () => {
        const o: OutputOptions = { ...emptyOpts, pandocFlags: { css: ['/p/abs.css'] } };
        const args = buildPandocArgs(o, 'html', {
            mdPath: 'in.md',
            outPath: 'o.html',
            sourceDir: '/p/sub',
            containmentRoot: '/p',
        });
        expect(args).toContain('--css=/p/abs.css');
    });
});
