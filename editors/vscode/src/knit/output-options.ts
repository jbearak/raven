/**
 * Parse the YAML `output:` block of an R Markdown front matter into a
 * structured `OutputOptions` value. Four groups:
 *
 *   - `chunkOpts`: knitr chunk-level options applied via `opts_chunk$set`
 *     BEFORE knitting (`fig_width`, `fig_height`, `fig_retina`, `dpi`,
 *     `dev`). Apply for preview AND export.
 *   - `pandocFlags`: options that map to Pandoc command-line flags
 *     (`toc`, `toc_depth`, `number_sections`, `highlight`,
 *     `self_contained`, `css`, `mathjax`). Apply during export only.
 *   - `pandocArgs`: verbatim extra args from YAML's `pandoc_args:` list,
 *     appended after Raven's own flags. Destination flags (`-o`,
 *     `--output`) and format-selection flags (`-t`, `--to`, `-w`,
 *     `--write`) are stripped because the editor menu owns those — the
 *     export writes a sibling of the source `.Rmd` in the menu-chosen
 *     format, matching RStudio's Knit-button behavior.
 *   - `ignored`: keys the user wrote that we don't honor. Logged to the
 *     "Raven: Knit" output channel.
 *
 * Merge precedence (first match wins):
 *   1. The requested-format block (e.g., `pdf_document:` for PDF export).
 *   2. Top-level scalar keys under `output:` (e.g., `output: { toc: true, pdf_document: {} }`).
 *   3. Defaults (nothing).
 *
 * Format blocks for non-matching formats are completely ignored. This
 * avoids `html_document.toc_depth` accidentally driving the PDF TOC.
 */

import type { FrontmatterDoc } from './yaml-frontmatter';

export type TargetFormat = 'html' | 'pdf' | 'docx';

export interface ChunkOpts {
    fig_width?: number;
    fig_height?: number;
    fig_retina?: number;
    dpi?: number;
    dev?: string;
}

export interface PandocFlags {
    toc?: boolean;
    toc_depth?: number;
    number_sections?: boolean;
    highlight?: string;
    self_contained?: boolean;
    css?: string[];
    mathjax?: boolean;
}

export interface OutputOptions {
    chunkOpts: ChunkOpts;
    pandocFlags: PandocFlags;
    /**
     * Extra args from YAML's `pandoc_args:` that survived stripping, in
     * original order. Appended after Raven's own flags by
     * `buildPandocArgs`. Pandoc's last-arg-wins rule applies to any
     * duplicates (other than destination/format, which we already
     * stripped).
     */
    pandocArgs: string[];
    /**
     * Args from YAML's `pandoc_args:` that we stripped (destination /
     * format flags). Surfaced to the output channel so the user knows
     * the menu choice took precedence.
     */
    droppedPandocArgs: string[];
    /** Keys the user wrote but we don't honor; surfaced to the output channel. */
    ignored: string[];
}

const HTML_FORMATS: ReadonlySet<string> = new Set([
    'html_document',
    'html_notebook',
    'html_vignette',
    'html_fragment',
    'bookdown::html_document2',
    'distill::distill_article',
    'pkgdown::html_document',
    'rmdformats::readthedown',
    'rmdformats::material',
    'rmdformats::html_clean',
    'rmdformats::html_docco',
    'tufte::tufte_html',
    'prettydoc::html_pretty',
]);

const PDF_FORMATS: ReadonlySet<string> = new Set([
    'pdf_document',
    'bookdown::pdf_document2',
    'tufte::tufte_handout',
    'tufte::tufte_book',
]);

const DOCX_FORMATS: ReadonlySet<string> = new Set([
    'word_document',
    'bookdown::word_document2',
]);

const CHUNK_KEYS: (keyof ChunkOpts)[] = ['fig_width', 'fig_height', 'fig_retina', 'dpi', 'dev'];
const PANDOC_KEYS: (keyof PandocFlags)[] = [
    'toc',
    'toc_depth',
    'number_sections',
    'highlight',
    'self_contained',
    'css',
    'mathjax',
];

/**
 * Keys we explicitly recognize but do not honor. Surfaced in `ignored`
 * for logging. `pandoc_args` is NOT in this list — see `parseOutputOptions`
 * for its handling (stripped of destination/format flags, then appended
 * to the Pandoc argv).
 */
const IGNORED_KEYS = [
    'theme',
    'code_folding',
    'df_print',
    'code_download',
    'template',
    'includes',
];

/**
 * Pandoc flags that we strip from YAML's `pandoc_args:` because Raven's
 * editor menu owns the export destination and format. Stripped values
 * appear in `OutputOptions.droppedPandocArgs` for logging.
 *
 * Coverage matrix:
 *   - separate form:  `['-o', FILE]`, `['--output', FILE]`
 *   - equals form:    `'--output=FILE'`
 *   - attached short: `'-oFILE'` (Pandoc accepts these)
 *
 * Same treatment for `-t`/`--to`/`-w`/`--write` (output format).
 *
 * Input-format flags (`-f`, `--from`, `-r`, `--read`) are NOT stripped —
 * Pandoc reads `.md` by default and overriding it is the user's choice.
 */
const STRIPPED_LONG_FLAGS: ReadonlySet<string> = new Set([
    '-o',
    '--output',
    '-t',
    '--to',
    '-w',
    '--write',
]);
const STRIPPED_EQUALS_PREFIXES = ['--output=', '--to=', '--write='];
const STRIPPED_SHORT_ATTACHED_RE = /^-[otw]./;

function stripPandocArgs(raw: unknown): { kept: string[]; dropped: string[] } {
    const kept: string[] = [];
    const dropped: string[] = [];
    if (!Array.isArray(raw)) return { kept, dropped };
    for (let i = 0; i < raw.length; i++) {
        const arg = raw[i];
        if (typeof arg !== 'string') continue;
        if (STRIPPED_LONG_FLAGS.has(arg)) {
            dropped.push(arg);
            const next = raw[i + 1];
            if (typeof next === 'string') {
                dropped.push(next);
                i++;
            }
            continue;
        }
        if (STRIPPED_EQUALS_PREFIXES.some((p) => arg.startsWith(p))) {
            dropped.push(arg);
            continue;
        }
        if (STRIPPED_SHORT_ATTACHED_RE.test(arg)) {
            dropped.push(arg);
            continue;
        }
        kept.push(arg);
    }
    return { kept, dropped };
}

const DEV_ALLOWLIST = new Set(['png', 'pdf', 'svg', 'svglite', 'jpeg', 'cairo_pdf']);
const HIGHLIGHT_ALLOWLIST = new Set([
    'pygments',
    'tango',
    'espresso',
    'zenburn',
    'kate',
    'monochrome',
    'breezedark',
    'haddock',
    'default',
]);

function matchesFormat(blockKey: string, target: TargetFormat): boolean {
    if (target === 'html') return HTML_FORMATS.has(blockKey);
    if (target === 'pdf') return PDF_FORMATS.has(blockKey);
    if (target === 'docx') return DOCX_FORMATS.has(blockKey);
    return false;
}

export function parseOutputOptions(fm: FrontmatterDoc, target: TargetFormat): OutputOptions {
    const chunkOpts: ChunkOpts = {};
    const pandocFlags: PandocFlags = {};
    const pandocArgs: string[] = [];
    const droppedPandocArgs: string[] = [];
    const ignored: string[] = [];
    const empty = (): OutputOptions => ({
        chunkOpts, pandocFlags, pandocArgs, droppedPandocArgs, ignored,
    });

    const output = fm.output;
    if (output === undefined || output === null) return empty();
    if (typeof output === 'string') return empty();
    if (typeof output !== 'object' || Array.isArray(output)) return empty();

    const outputMap = output as Record<string, unknown>;

    let formatBlock: Record<string, unknown> | null = null;
    for (const [key, value] of Object.entries(outputMap)) {
        if (
            matchesFormat(key, target) &&
            value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value)
        ) {
            formatBlock = value as Record<string, unknown>;
            break;
        }
    }

    // Top-level scalar keys (anything not a nested map) under `output:`.
    const topLevel: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(outputMap)) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            topLevel[key] = value;
        }
    }

    const resolve = (key: string): unknown => {
        if (formatBlock && key in formatBlock) return formatBlock[key];
        if (key in topLevel) return topLevel[key];
        return undefined;
    };

    // Chunk options.
    for (const key of CHUNK_KEYS) {
        const v = resolve(key);
        if (v === undefined) continue;
        if (key === 'dev') {
            if (typeof v === 'string' && DEV_ALLOWLIST.has(v)) chunkOpts.dev = v;
            else ignored.push('dev');
            continue;
        }
        if (typeof v === 'number' && Number.isFinite(v)) {
            chunkOpts[key] = v;
        } else if (typeof v === 'boolean') {
            chunkOpts[key] = v ? 1 : 0;
        }
    }

    // Pandoc flags.
    for (const key of PANDOC_KEYS) {
        const v = resolve(key);
        if (v === undefined) continue;
        if (key === 'toc' || key === 'number_sections' || key === 'self_contained' || key === 'mathjax') {
            if (typeof v === 'boolean') pandocFlags[key] = v;
        } else if (key === 'toc_depth') {
            if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 6) {
                pandocFlags.toc_depth = v;
            }
        } else if (key === 'highlight') {
            if (typeof v === 'string' && HIGHLIGHT_ALLOWLIST.has(v)) {
                pandocFlags.highlight = v;
            } else {
                ignored.push('highlight');
            }
        } else if (key === 'css') {
            if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
                pandocFlags.css = v.slice();
            } else if (typeof v === 'string') {
                pandocFlags.css = [v];
            }
        }
    }

    // Ignored keys (present in either the matching format block or top-level).
    const seenIgnored = new Set(ignored);
    const surfaces: Record<string, unknown>[] = formatBlock ? [formatBlock, topLevel] : [topLevel];
    for (const surface of surfaces) {
        for (const k of IGNORED_KEYS) {
            if (k in surface && !seenIgnored.has(k)) {
                ignored.push(k);
                seenIgnored.add(k);
            }
        }
    }

    // pandoc_args: resolved via the same format-block-then-top-level precedence.
    const rawPandocArgs = resolve('pandoc_args');
    if (rawPandocArgs !== undefined) {
        const stripped = stripPandocArgs(rawPandocArgs);
        pandocArgs.push(...stripped.kept);
        droppedPandocArgs.push(...stripped.dropped);
    }

    return empty();
}

/**
 * Return `chunkOpts` with `dev` defaulted to `'svglite'` if the YAML
 * didn't set one. Used by the HTML knit paths (preview and HTML export)
 * so plots are rendered as inline SVG with a structure the Knit Output
 * panel's "Apply VS Code theme" overlay can actually recolor.
 *
 * Why svglite, not the built-in 'svg' (Cairo) device:
 *   - svglite emits the outer canvas rect as the first <rect> child of
 *     <svg> and the panel background as a direct child of <g> with no
 *     stroke-linejoin/linecap — the exact structure the plot viewer's
 *     `tag_background_rects` heuristic was tuned for. Cairo wraps both
 *     deeper inside clip-path groups, defeating the structural tag.
 *   - svglite (with web_fonts = TRUE, which buildKnitExpression
 *     auto-enables when the installed svglite supports it) renders
 *     text as real <text> elements that the CSS font-family override
 *     can actually re-flow. Cairo renders text as <symbol>+<use> glyph
 *     paths, which look like the original font regardless of CSS.
 *   - If svglite isn't installed, the R-side fallback in
 *     buildKnitExpression downgrades to 'svg' so the knit still
 *     succeeds — the user just sees the same partially-themed plot
 *     that pre-svglite users get.
 *
 * Non-HTML targets (PDF, Word) intentionally do NOT use this default;
 * their R-side defaults (knitr's PNG) and YAML overrides win unchanged.
 * Per-chunk `{r dev='png'}` overrides still win at knit time —
 * `opts_chunk$set` is a document-wide default and chunk headers
 * override it.
 */
export function withSvgDevDefault(opts: ChunkOpts): ChunkOpts {
    if (opts.dev !== undefined) return opts;
    return { ...opts, dev: 'svglite' };
}
