/**
 * Parse the YAML `output:` block of an R Markdown front matter into a
 * structured `OutputOptions` value. Three groups:
 *
 *   - `chunkOpts`: knitr chunk-level options applied via `opts_chunk$set`
 *     BEFORE knitting (`fig_width`, `fig_height`, `fig_retina`, `dpi`,
 *     `dev`). Apply for preview AND export.
 *   - `pandocFlags`: options that map to Pandoc command-line flags
 *     (`toc`, `toc_depth`, `number_sections`, `highlight`,
 *     `self_contained`, `css`, `mathjax`). Apply during export only.
 *   - `ignored`: keys the user wrote that we don't honor. Logged to the
 *     "Raven: Knit" output channel. Includes `pandoc_args` in v1 (see
 *     spec: passing it verbatim is unsafe — `--lua-filter`, `--output`,
 *     etc. can break our destination/security model).
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
 * for logging. `pandoc_args` is here for security: passing it verbatim
 * would let any document override `--output`, `--lua-filter`, etc.
 */
const IGNORED_KEYS = [
    'theme',
    'code_folding',
    'df_print',
    'code_download',
    'template',
    'includes',
    'pandoc_args',
];

const DEV_ALLOWLIST = new Set(['png', 'pdf', 'svg', 'jpeg', 'cairo_pdf']);
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
    const ignored: string[] = [];

    const output = fm.output;
    if (output === undefined || output === null) return { chunkOpts, pandocFlags, ignored };
    if (typeof output === 'string') return { chunkOpts, pandocFlags, ignored };
    if (typeof output !== 'object' || Array.isArray(output)) return { chunkOpts, pandocFlags, ignored };

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

    return { chunkOpts, pandocFlags, ignored };
}
