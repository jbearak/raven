import { describe, test, expect } from 'bun:test';
import {
    extractFrontmatter,
    parseFrontmatter,
    detectFormat,
    detectBlockers,
    isSupportedHtmlFormat,
    stripFrontmatter,
} from '../../editors/vscode/src/knit/yaml-frontmatter';

describe('extractFrontmatter', () => {
    test('extracts a fenced front-matter block', () => {
        const text = '---\ntitle: example\noutput: html_document\n---\n\nbody\n';
        expect(extractFrontmatter(text)).toBe('title: example\noutput: html_document\n');
    });

    test('strips a leading UTF-8 BOM', () => {
        const text = '﻿---\ntitle: ok\n---\n';
        expect(extractFrontmatter(text)).toBe('title: ok\n');
    });

    test('returns null when document has no front matter', () => {
        expect(extractFrontmatter('# heading\n\nbody\n')).toBeNull();
    });

    test('returns null when fence is unterminated', () => {
        expect(extractFrontmatter('---\ntitle: x\nno close\n')).toBeNull();
    });

    test('accepts CRLF line endings', () => {
        const text = '---\r\ntitle: x\r\n---\r\nbody\r\n';
        expect(extractFrontmatter(text)).toBe('title: x\n');
    });
});

describe('parseFrontmatter', () => {
    test('parses standard YAML into a plain object', () => {
        const fm = parseFrontmatter('title: example\noutput: html_document\n');
        expect(fm.ok).toBe(true);
        if (fm.ok) {
            expect(fm.value).toEqual({ title: 'example', output: 'html_document' });
        }
    });

    test('returns an error result on malformed YAML', () => {
        const fm = parseFrontmatter('title: : :\n');
        expect(fm.ok).toBe(false);
        if (!fm.ok) {
            expect(fm.error).toMatch(/./);
        }
    });

    test('parses an absent body as empty object', () => {
        const fm = parseFrontmatter('');
        expect(fm.ok).toBe(true);
        if (fm.ok) expect(fm.value).toEqual({});
    });
});

describe('detectFormat', () => {
    test('returns "html_document" when output is absent', () => {
        expect(detectFormat({})).toBe('html_document');
    });

    test('returns the string when output: is a single string value', () => {
        expect(detectFormat({ output: 'pdf_document' })).toBe('pdf_document');
    });

    test('returns first key when output is a map', () => {
        expect(detectFormat({ output: { html_document: { toc: true }, pdf_document: {} } }))
            .toBe('html_document');
    });

    test('accepts namespaced identifiers like bookdown::pdf_document2', () => {
        expect(detectFormat({ output: { 'bookdown::pdf_document2': {} } }))
            .toBe('bookdown::pdf_document2');
    });

    test('falls back to "html_document" when output: is empty map', () => {
        expect(detectFormat({ output: {} })).toBe('html_document');
    });

    test('falls back when output: value is unrecognized shape', () => {
        expect(detectFormat({ output: null })).toBe('html_document');
        expect(detectFormat({ output: ['html_document', 'pdf_document'] }))
            .toBe('html_document');
    });
});

describe('isSupportedHtmlFormat', () => {
    test('accepts the rmarkdown default html_document', () => {
        expect(isSupportedHtmlFormat('html_document')).toBe(true);
    });

    test('accepts common HTML variants', () => {
        expect(isSupportedHtmlFormat('html_notebook')).toBe(true);
        expect(isSupportedHtmlFormat('html_vignette')).toBe(true);
        expect(isSupportedHtmlFormat('html_fragment')).toBe(true);
    });

    test('accepts namespaced HTML formats from common packages', () => {
        expect(isSupportedHtmlFormat('bookdown::html_document2')).toBe(true);
        expect(isSupportedHtmlFormat('distill::distill_article')).toBe(true);
        expect(isSupportedHtmlFormat('tufte::tufte_html')).toBe(true);
    });

    test('rejects non-HTML formats', () => {
        expect(isSupportedHtmlFormat('pdf_document')).toBe(false);
        expect(isSupportedHtmlFormat('word_document')).toBe(false);
        expect(isSupportedHtmlFormat('ioslides_presentation')).toBe(false);
        expect(isSupportedHtmlFormat('revealjs::revealjs_presentation')).toBe(false);
        expect(isSupportedHtmlFormat('bookdown::pdf_document2')).toBe(false);
    });

    test('rejects empty and unknown formats', () => {
        // Empty format defaults to html_document elsewhere; here we are
        // asserting the predicate's own behavior is "default to false on
        // unknown". An empty / whitespace-only input is definitely
        // unrecognized.
        expect(isSupportedHtmlFormat('')).toBe(false);
        expect(isSupportedHtmlFormat('   ')).toBe(false);
        expect(isSupportedHtmlFormat('something_made_up')).toBe(false);
    });

    test('tolerates surrounding whitespace', () => {
        expect(isSupportedHtmlFormat('  html_document  ')).toBe(true);
    });
});

describe('detectBlockers', () => {
    test('returns empty when no blockers', () => {
        expect(detectBlockers({ output: 'html_document' })).toEqual([]);
    });

    test('detects custom knit: hook', () => {
        const blockers = detectBlockers({ knit: '(function(input, ...) bookdown::render_book(input, ...))' });
        expect(blockers).toHaveLength(1);
        expect(blockers[0].kind).toBe('knit-hook');
        // Inferred copy command should pick the inner pkg::fn, not the
        // anonymous-function wrapper.
        expect(blockers[0].copyCommand).toBe("bookdown::render_book('FILENAME')");
    });

    test('falls back to rmarkdown::render when knit: hook is opaque', () => {
        const blockers = detectBlockers({ knit: 'opaque_string_no_call' });
        expect(blockers).toHaveLength(1);
        expect(blockers[0].copyCommand).toBe("rmarkdown::render('FILENAME')");
    });

    test('picks first pkg::fn for nested anonymous wrappers', () => {
        const blockers = detectBlockers({
            knit: '(function(input, encoding) { pkgdown::build_site() })',
        });
        expect(blockers[0].copyCommand).toBe("pkgdown::build_site('FILENAME')");
    });

    test('null knit: value is not a blocker', () => {
        expect(detectBlockers({ knit: null })).toEqual([]);
    });

    test('detects runtime: shiny', () => {
        const blockers = detectBlockers({ runtime: 'shiny' });
        expect(blockers).toHaveLength(1);
        expect(blockers[0].kind).toBe('shiny');
    });

    test('detects runtime: shiny_prerendered', () => {
        const blockers = detectBlockers({ runtime: 'shiny_prerendered' });
        expect(blockers).toHaveLength(1);
        expect(blockers[0].kind).toBe('shiny');
    });

    test('detects server: shiny', () => {
        const blockers = detectBlockers({ server: 'shiny' });
        expect(blockers).toHaveLength(1);
        expect(blockers[0].kind).toBe('shiny');
    });

    test('detects server: { type: shiny }', () => {
        const blockers = detectBlockers({ server: { type: 'shiny' } });
        expect(blockers).toHaveLength(1);
        expect(blockers[0].kind).toBe('shiny');
    });

    test('detects site: field', () => {
        const blockers = detectBlockers({ site: 'bookdown::bookdown_site' });
        expect(blockers).toHaveLength(1);
        expect(blockers[0].kind).toBe('site');
        expect(blockers[0].copyCommand).toContain('bookdown::serve_book');
    });

    test('site: with rmarkdown::render_site value', () => {
        const blockers = detectBlockers({ site: 'rmarkdown::render_site' });
        expect(blockers).toHaveLength(1);
        expect(blockers[0].copyCommand).toContain('rmarkdown::render_site');
    });

    test('params: is NOT a blocker', () => {
        expect(detectBlockers({ params: { x: 1 } })).toEqual([]);
    });

    test('multiple top-level output entries are NOT a blocker', () => {
        expect(detectBlockers({ output: { html_document: {}, pdf_document: {} } })).toEqual([]);
    });
});

describe('stripFrontmatter', () => {
    test('strips a well-formed frontmatter block with trailing newline', () => {
        const text = '---\ntitle: example\noutput: html_document\n---\n\nbody\n';
        // The opening `---\n`, the body, the closing `---`, and the
        // one newline immediately after the closing fence are removed.
        // The blank line that originally separated the closing fence
        // from `body` becomes the leading `\n` of the remainder.
        expect(stripFrontmatter(text)).toBe('\nbody\n');
    });

    test('strips frontmatter that ends at EOF without a trailing newline', () => {
        const text = '---\ntitle: x\n---';
        expect(stripFrontmatter(text)).toBe('');
    });

    test('strips a minimal-body frontmatter (one blank line between fences)', () => {
        // The closing-fence regex requires `\n---` (a newline BEFORE
        // the closing `---`), so a minimal frontmatter must have at
        // least one line — even an empty one — between the fences.
        const text = '---\n\n---\nbody\n';
        expect(stripFrontmatter(text)).toBe('body\n');
    });

    test('returns input unchanged when there is no opening fence', () => {
        const text = '# heading\n\nbody\n';
        expect(stripFrontmatter(text)).toBe(text);
    });

    test('returns input unchanged when the opening fence is not at byte 0', () => {
        const text = '\n---\ntitle: x\n---\nbody\n';
        expect(stripFrontmatter(text)).toBe(text);
    });

    test('returns input unchanged when the frontmatter is unterminated', () => {
        // No closing `---` after the opener — must NOT mistake a
        // later `---` mid-body for a closer either (there is none here).
        const text = '---\ntitle: x\nno close\n';
        expect(stripFrontmatter(text)).toBe(text);
    });

    test('does not mistake a body-side `---` for a frontmatter close', () => {
        // No frontmatter at all; the `---` appears as a horizontal
        // rule between paragraphs. Must come back unchanged.
        const text = 'intro\n\n---\n\nrest\n';
        expect(stripFrontmatter(text)).toBe(text);
    });

    test('strips a leading UTF-8 BOM before matching', () => {
        const text = '﻿---\ntitle: ok\n---\nbody\n';
        // BOM-stripped, frontmatter-stripped. Result is just the body
        // with no separating blank line, since the original had none.
        expect(stripFrontmatter(text)).toBe('body\n');
    });

    test('accepts CRLF line endings, returning LF in the remainder', () => {
        const text = '---\r\ntitle: x\r\n---\r\nbody\r\n';
        // CRLF→LF normalized before matching; remainder carries LF.
        expect(stripFrontmatter(text)).toBe('body\n');
    });

    test('lockstep with extractFrontmatter: same decision predicate', () => {
        // For every fixture, `stripFrontmatter` must change the input
        // iff `extractFrontmatter` returns a non-null body. This is
        // the contract that guards the shared `findFrontmatterEnd`
        // predicate.
        const fixtures: string[] = [
            '---\ntitle: x\n---\nbody\n',
            '---\ntitle: x\n---',
            '---\n\n---\nbody\n',
            '# heading\nbody\n',
            '---\nunterminated\n',
            '\n---\ntitle: x\n---\nbody\n',
            'intro\n\n---\n\nrest\n',
            '﻿---\ntitle: ok\n---\nbody\n',
            '---\r\ntitle: x\r\n---\r\nbody\r\n',
            '',
        ];
        for (const f of fixtures) {
            const stripped = stripFrontmatter(f);
            const extracted = extractFrontmatter(f);
            if (extracted === null) {
                expect(stripped).toBe(f);
            } else {
                expect(stripped).not.toBe(f);
            }
        }
    });
});

describe('parseFrontmatter -> detectBlockers integration', () => {
    test('knit: null in YAML parses as JS null and does not blocker', () => {
        const parsed = parseFrontmatter('knit: null\n');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.value).toEqual({ knit: null });
        expect(detectBlockers(parsed.value)).toEqual([]);
    });

    test('knit: ~ (YAML null shorthand) does not blocker', () => {
        const parsed = parseFrontmatter('knit: ~\n');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(detectBlockers(parsed.value)).toEqual([]);
    });

    test('custom knit: hook still blockers when present', () => {
        const parsed = parseFrontmatter(
            "knit: (function(input, ...) bookdown::render_book(input, ...))\n",
        );
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        const blockers = detectBlockers(parsed.value);
        expect(blockers).toHaveLength(1);
        expect(blockers[0].kind).toBe('knit-hook');
    });

    test('runtime: shiny via YAML triggers shiny blocker', () => {
        const parsed = parseFrontmatter('runtime: shiny\n');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        const blockers = detectBlockers(parsed.value);
        expect(blockers).toHaveLength(1);
        expect(blockers[0].kind).toBe('shiny');
    });

    test('numbers and booleans are preserved (JSON schema, not failsafe)', () => {
        const parsed = parseFrontmatter('params:\n  n: 3\n  flag: true\n');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.value).toEqual({ params: { n: 3, flag: true } });
    });
});
