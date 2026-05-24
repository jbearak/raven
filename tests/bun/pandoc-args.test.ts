import { describe, it, expect } from 'bun:test';
import { buildPandocArgs } from '../../editors/vscode/src/knit/pandoc-args';
import type { OutputOptions } from '../../editors/vscode/src/knit/output-options';

const emptyOpts: OutputOptions = {
    chunkOpts: {},
    pandocFlags: {},
    pandocArgs: [],
    droppedPandocArgs: [],
    ignored: [],
};

describe('buildPandocArgs', () => {
    it('produces minimal args for HTML (default embeds resources)', () => {
        // HTML exports must default to --embed-resources because the
        // figure/ directory lives in Raven's temp preview dir, which
        // disappears when the panel closes. A non-embedded HTML would
        // be left with broken image links pointing at a missing path.
        const args = buildPandocArgs(emptyOpts, 'html', {
            mdPath: 'in.md',
            outPath: 'out.html',
            sourceDir: '/p',
            containmentRoot: '/p',
        });
        expect(args).toEqual([
            'in.md', '-o', 'out.html', '--to', 'html5', '--standalone', '--embed-resources',
        ]);
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

    it('keeps --embed-resources when self_contained: true is explicit', () => {
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

    it('always embeds HTML resources even when self_contained is explicitly false', () => {
        // Honoring `self_contained: false` would require copying the
        // temp `figure/` dir next to the .html (and Pandoc's data-dir
        // assets) for the linked-assets workflow to render. Raven's
        // temp dir is purged after the panel closes, so the linked
        // form would produce broken images. We always embed and
        // surface the override via `ignoredFlags`.
        const o: OutputOptions = { ...emptyOpts, pandocFlags: { self_contained: false } };
        const result = buildPandocArgs.detailed(o, 'html', {
            mdPath: 'in.md',
            outPath: 'out.html',
            sourceDir: '/p',
            containmentRoot: '/p',
        });
        expect(result.args).toContain('--embed-resources');
        expect(result.ignoredFlags).toEqual([
            'self_contained: false (HTML export always embeds resources)',
        ]);
    });

    it('does not add --embed-resources for PDF / DOCX exports', () => {
        // self_contained is HTML-specific; PDF and DOCX naturally
        // package their assets and Pandoc doesn't take --embed-resources
        // for those targets.
        const o: OutputOptions = { ...emptyOpts, pandocFlags: { self_contained: true } };
        const pdfArgs = buildPandocArgs(o, 'pdf', {
            mdPath: 'in.md',
            outPath: 'out.pdf',
            sourceDir: '/p',
            containmentRoot: '/p',
            pdfEngine: 'xelatex',
        });
        expect(pdfArgs).not.toContain('--embed-resources');
        const docxArgs = buildPandocArgs(o, 'docx', {
            mdPath: 'in.md',
            outPath: 'out.docx',
            sourceDir: '/p',
            containmentRoot: '/p',
        });
        expect(docxArgs).not.toContain('--embed-resources');
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

    it('appends pandocArgs after Raven\'s own flags', () => {
        const o: OutputOptions = {
            ...emptyOpts,
            pandocArgs: ['--shift-heading-level-by=1', '--wrap=auto'],
        };
        const args = buildPandocArgs(o, 'html', {
            mdPath: 'in.md',
            outPath: 'out.html',
            sourceDir: '/p',
            containmentRoot: '/p',
        });
        expect(args).toEqual([
            'in.md', '-o', 'out.html', '--to', 'html5', '--standalone', '--embed-resources',
            '--shift-heading-level-by=1', '--wrap=auto',
        ]);
    });

    it('pandocArgs appear after --css and other YAML-derived flags', () => {
        const o: OutputOptions = {
            ...emptyOpts,
            pandocFlags: { toc: true, css: ['style.css'] },
            pandocArgs: ['--shift-heading-level-by=1'],
        };
        const args = buildPandocArgs(o, 'html', {
            mdPath: 'in.md',
            outPath: 'out.html',
            sourceDir: '/p',
            containmentRoot: '/p',
        });
        // Our --toc and --css come before the passthrough block.
        expect(args.indexOf('--shift-heading-level-by=1')).toBeGreaterThan(args.indexOf('--toc'));
        expect(args.indexOf('--shift-heading-level-by=1')).toBeGreaterThan(args.indexOf('--css=/p/style.css'));
    });
});
