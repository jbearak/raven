import { describe, test, expect } from 'bun:test';
import {
    classify_chunk_document,
    detect_chunks,
    find_chunk_at_line,
    chunks_above,
    extract_chunk_code,
    has_chunk_anchor,
    is_runnable_chunk,
    Chunk,
} from '../../editors/vscode/src/chunks/chunk-detector';

function lines(text: string): string[] {
    return text.split('\n');
}

describe('classify_chunk_document', () => {
    test('treats .Rmd as rmd', () => {
        expect(classify_chunk_document('/tmp/foo.Rmd')).toBe('rmd');
        expect(classify_chunk_document('/tmp/foo.rmd')).toBe('rmd');
    });

    test('treats .qmd as rmd', () => {
        expect(classify_chunk_document('/tmp/foo.qmd')).toBe('rmd');
        expect(classify_chunk_document('/tmp/foo.QMD')).toBe('rmd');
    });

    test('treats .R / .r as r', () => {
        expect(classify_chunk_document('/tmp/foo.R')).toBe('r');
        expect(classify_chunk_document('/tmp/foo.r')).toBe('r');
    });

    test('falls back to r for unknown extensions', () => {
        expect(classify_chunk_document('/tmp/foo.txt')).toBe('r');
    });
});

describe('detect_chunks — Rmd/Qmd fenced blocks', () => {
    test('detects a single ```{r} chunk', () => {
        const src = lines([
            'Some prose.',
            '',
            '```{r}',
            'x <- 1',
            'print(x)',
            '```',
            '',
            'More prose.',
        ].join('\n'));
        const chunks = detect_chunks(src, 'rmd');
        expect(chunks.length).toBe(1);
        expect(chunks[0].header_line).toBe(2);
        expect(chunks[0].closing_fence_line).toBe(5);
        expect(chunks[0].end_line).toBe(4);
        expect(chunks[0].language).toBe('r');
        expect(chunks[0].is_eval_false).toBe(false);
    });

    test('parses header options including label and eval=FALSE', () => {
        const src = lines([
            '```{r setup, eval=FALSE, fig.width=4}',
            'x <- 1',
            '```',
        ].join('\n'));
        const chunks = detect_chunks(src, 'rmd');
        expect(chunks.length).toBe(1);
        expect(chunks[0].language).toBe('r');
        expect(chunks[0].label).toBe('setup');
        expect(chunks[0].options.eval).toBe('FALSE');
        expect(chunks[0].options['fig.width']).toBe('4');
        expect(chunks[0].is_eval_false).toBe(true);
    });

    test('keeps parenthesised vector values intact when splitting options', () => {
        const src = lines([
            '```{r, fig.dim=c(5, 6), out.width="80%"}',
            '1',
            '```',
        ].join('\n'));
        const chunks = detect_chunks(src, 'rmd');
        expect(chunks[0].options['fig.dim']).toBe('c(5, 6)');
        expect(chunks[0].options['out.width']).toBe('80%');
    });

    test('respects escaped quotes inside option values', () => {
        const src = lines([
            '```{r, lab="say \\"hi\\""}',
            '1',
            '```',
        ].join('\n'));
        const chunks = detect_chunks(src, 'rmd');
        // The escape stays in the parsed value — Raven does not interpret R string escapes.
        expect(chunks[0].options.lab).toBe('say \\"hi\\"');
    });

    test('recognizes eval = F as eval false', () => {
        const src = lines([
            '```{r, eval = F}',
            '1',
            '```',
        ].join('\n'));
        const chunks = detect_chunks(src, 'rmd');
        expect(chunks[0].is_eval_false).toBe(true);
    });

    test('recognizes upper-case R language tag', () => {
        const src = lines([
            '```{R}',
            '1',
            '```',
        ].join('\n'));
        const chunks = detect_chunks(src, 'rmd');
        expect(chunks[0].language).toBe('r');
    });

    test('detects non-R chunks (python, julia)', () => {
        const src = lines([
            '```{python}',
            'pass',
            '```',
            '',
            '```{julia}',
            '1',
            '```',
        ].join('\n'));
        const chunks = detect_chunks(src, 'rmd');
        expect(chunks.length).toBe(2);
        expect(chunks[0].language).toBe('python');
        expect(chunks[1].language).toBe('julia');
    });

    test('detects multiple chunks separated by prose', () => {
        const src = lines([
            '```{r}',
            'a <- 1',
            '```',
            'Prose between.',
            '```{r second}',
            'b <- 2',
            '```',
        ].join('\n'));
        const chunks = detect_chunks(src, 'rmd');
        expect(chunks.length).toBe(2);
        expect(chunks[0].header_line).toBe(0);
        expect(chunks[1].header_line).toBe(4);
        expect(chunks[1].label).toBe('second');
    });

    test('handles unclosed fence by extending to EOF', () => {
        const src = lines([
            '```{r}',
            'x <- 1',
            'y <- 2',
        ].join('\n'));
        const chunks = detect_chunks(src, 'rmd');
        expect(chunks.length).toBe(1);
        expect(chunks[0].closing_fence_line).toBeNull();
        expect(chunks[0].end_line).toBe(2);
    });

    test('handles tilde fences', () => {
        const src = lines([
            '~~~{r}',
            'x <- 1',
            '~~~',
        ].join('\n'));
        const chunks = detect_chunks(src, 'rmd');
        expect(chunks.length).toBe(1);
        expect(chunks[0].language).toBe('r');
    });

    test('handles fences with more backticks (4+)', () => {
        const src = lines([
            '````{r}',
            '```',
            'inner backticks',
            '```',
            '````',
        ].join('\n'));
        const chunks = detect_chunks(src, 'rmd');
        expect(chunks.length).toBe(1);
        expect(chunks[0].closing_fence_line).toBe(4);
    });

    test('ignores indented fences (Pandoc-style is line-start)', () => {
        // Two leading spaces — code-block indent in Pandoc treats this as a literal, not a fence.
        const src = lines([
            '  ```{r}',
            '  x <- 1',
            '  ```',
        ].join('\n'));
        const chunks = detect_chunks(src, 'rmd');
        // We don't try to parse Pandoc semantics: just require the fence at column 0.
        expect(chunks.length).toBe(0);
    });

    test('returns empty for documents with no fences', () => {
        const src = lines(['# Title', 'Just prose.'].join('\n'));
        expect(detect_chunks(src, 'rmd').length).toBe(0);
    });

    test('treats a header inside an open chunk as content, not a new chunk', () => {
        // Outer ```` ```` fence wraps an inner ``` ``` ``` fence header
        // verbatim. We should see one outer chunk and no inner one — the
        // detector resumes scanning AFTER the outer closing fence.
        const src = lines([
            '````{r outer}',
            '```{r inner}',
            'x <- 1',
            '```',
            '````',
        ].join('\n'));
        const chunks = detect_chunks(src, 'rmd');
        expect(chunks.length).toBe(1);
        expect(chunks[0].label).toBe('outer');
        expect(chunks[0].closing_fence_line).toBe(4);
    });
});

describe('detect_chunks — .R cell markers', () => {
    test('detects # %% cells', () => {
        const src = lines([
            '# initial code',
            'x <- 1',
            '# %% First cell',
            'a <- 1',
            'b <- 2',
            '# %% Second cell',
            'c <- 3',
        ].join('\n'));
        const chunks = detect_chunks(src, 'r');
        expect(chunks.length).toBe(2);
        expect(chunks[0].header_line).toBe(2);
        expect(chunks[0].end_line).toBe(4);
        expect(chunks[0].language).toBe('r');
        expect(chunks[1].header_line).toBe(5);
        expect(chunks[1].end_line).toBe(6);
    });

    test('matches multiple-hash markers', () => {
        const src = lines([
            '### %% Heading-style',
            'x <- 1',
        ].join('\n'));
        const chunks = detect_chunks(src, 'r');
        expect(chunks.length).toBe(1);
        expect(chunks[0].header_line).toBe(0);
    });

    test('does not match `# %%%` or `# %%inline` non-markers', () => {
        const src = lines([
            '# %%%',
            'x <- 1',
            '# %%not-a-cell',
            'y <- 2',
            '# %% real cell',
            'z <- 3',
        ].join('\n'));
        const chunks = detect_chunks(src, 'r');
        expect(chunks.length).toBe(1);
        expect(chunks[0].header_line).toBe(4);
    });

    test('returns empty for .R with no markers', () => {
        const src = lines(['x <- 1', 'print(x)'].join('\n'));
        expect(detect_chunks(src, 'r').length).toBe(0);
    });

    test('empty cell (no following content) is still a chunk', () => {
        const src = lines(['# %%'].join('\n'));
        const chunks = detect_chunks(src, 'r');
        expect(chunks.length).toBe(1);
        expect(chunks[0].header_line).toBe(0);
        expect(chunks[0].end_line).toBe(0);
    });
});

describe('find_chunk_at_line', () => {
    const chunks: Chunk[] = [
        { header_line: 2, end_line: 4, closing_fence_line: 5, language: 'r', label: null, options: {}, is_eval_false: false, kind: 'rmd' },
        { header_line: 7, end_line: 9, closing_fence_line: 10, language: 'r', label: null, options: {}, is_eval_false: false, kind: 'rmd' },
    ];

    test('returns chunk when cursor is inside body', () => {
        expect(find_chunk_at_line(chunks, 3)?.header_line).toBe(2);
        expect(find_chunk_at_line(chunks, 8)?.header_line).toBe(7);
    });

    test('returns chunk when cursor is on header line', () => {
        expect(find_chunk_at_line(chunks, 2)?.header_line).toBe(2);
    });

    test('returns chunk when cursor is on closing fence', () => {
        expect(find_chunk_at_line(chunks, 5)?.header_line).toBe(2);
    });

    test('returns null when cursor is outside any chunk', () => {
        expect(find_chunk_at_line(chunks, 0)).toBeNull();
        expect(find_chunk_at_line(chunks, 6)).toBeNull();
    });
});

describe('chunks_above', () => {
    const chunks: Chunk[] = [
        { header_line: 0, end_line: 2, closing_fence_line: 3, language: 'r', label: null, options: {}, is_eval_false: false, kind: 'rmd' },
        { header_line: 5, end_line: 6, closing_fence_line: 7, language: 'r', label: null, options: {}, is_eval_false: false, kind: 'rmd' },
        { header_line: 10, end_line: 12, closing_fence_line: 13, language: 'r', label: null, options: {}, is_eval_false: false, kind: 'rmd' },
    ];

    test('returns chunks whose closing position is strictly above cursor', () => {
        // Cursor on line 8 (between chunk 2's close at 7 and chunk 3's header at 10)
        // → chunks 1 and 2 are above.
        const result = chunks_above(chunks, 8);
        expect(result.length).toBe(2);
    });

    test('when cursor is inside a chunk, chunks above does not include the current chunk', () => {
        // Cursor in chunk 2 (line 6) → only chunk 1 is above.
        const result = chunks_above(chunks, 6);
        expect(result.length).toBe(1);
        expect(result[0].header_line).toBe(0);
    });

    test('returns empty list when cursor is above all chunks', () => {
        const result = chunks_above(chunks, 0);
        expect(result.length).toBe(0);
    });
});

describe('extract_chunk_code', () => {
    test('extracts content between fence lines, excluding fences', () => {
        const src = lines([
            'prose',
            '```{r}',
            'x <- 1',
            'y <- 2',
            '```',
        ].join('\n'));
        const chunks = detect_chunks(src, 'rmd');
        expect(extract_chunk_code(src, chunks[0])).toBe('x <- 1\ny <- 2');
    });

    test('extracts content after cell marker', () => {
        const src = lines([
            '# %% one',
            'x <- 1',
            'y <- 2',
        ].join('\n'));
        const chunks = detect_chunks(src, 'r');
        expect(extract_chunk_code(src, chunks[0])).toBe('x <- 1\ny <- 2');
    });

    test('returns empty for an empty chunk body', () => {
        const src = lines([
            '```{r}',
            '```',
        ].join('\n'));
        const chunks = detect_chunks(src, 'rmd');
        expect(extract_chunk_code(src, chunks[0])).toBe('');
    });
});

describe('has_chunk_anchor', () => {
    test('returns false for plain R code with no markers', () => {
        const text = 'x <- 1\nprint(x)\n# comment\nfn <- function(a, b) a + b\n';
        expect(has_chunk_anchor(text, 'r')).toBe(false);
    });

    test('returns true when an .R file contains `%%`', () => {
        // Coarse: any `%%` in the text triggers the slow path. False positives
        // are acceptable; the real regex confirms whether the line is a marker.
        expect(has_chunk_anchor('# %% one\nx <- 1', 'r')).toBe(true);
        expect(has_chunk_anchor('x <- "50%%"\n', 'r')).toBe(true);
    });

    test('returns false for prose-only Rmd / Qmd', () => {
        const text = '# Title\n\nSome prose.\nNo fences here.\n';
        expect(has_chunk_anchor(text, 'rmd')).toBe(false);
    });

    test('returns true when an Rmd document contains backtick or tilde fences', () => {
        expect(has_chunk_anchor('```{r}\n1\n```\n', 'rmd')).toBe(true);
        expect(has_chunk_anchor('~~~{r}\n1\n~~~\n', 'rmd')).toBe(true);
    });

    test('does not false-trigger on single backticks (inline code)', () => {
        const text = 'Inline `r 1 + 1` math here.\n';
        expect(has_chunk_anchor(text, 'rmd')).toBe(false);
    });
});

describe('is_runnable_chunk', () => {
    test('r chunks are runnable', () => {
        const c: Chunk = { header_line: 0, end_line: 1, closing_fence_line: 2, language: 'r', label: null, options: {}, is_eval_false: false, kind: 'rmd' };
        expect(is_runnable_chunk(c)).toBe(true);
    });

    test('non-r chunks are not runnable', () => {
        const c: Chunk = { header_line: 0, end_line: 1, closing_fence_line: 2, language: 'python', label: null, options: {}, is_eval_false: false, kind: 'rmd' };
        expect(is_runnable_chunk(c)).toBe(false);
    });
});
