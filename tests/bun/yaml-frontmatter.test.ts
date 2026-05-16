import { describe, test, expect } from 'bun:test';
import {
    extractFrontmatter,
    parseFrontmatter,
    detectFormat,
    detectBlockers,
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

describe('detectBlockers', () => {
    test('returns empty when no blockers', () => {
        expect(detectBlockers({ output: 'html_document' })).toEqual([]);
    });

    test('detects custom knit: hook', () => {
        const blockers = detectBlockers({ knit: '(function(input, ...) bookdown::render_book(input, ...))' });
        expect(blockers).toHaveLength(1);
        expect(blockers[0].kind).toBe('knit-hook');
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
