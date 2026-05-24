/**
 * Pure function: convert an `OutputOptions` + export target into a
 * Pandoc-arg-array suitable for `child_process.spawn`.
 *
 * Security boundary: relative CSS paths from YAML are resolved against
 * the source `.Rmd`'s directory, then validated against a containment
 * root (the workspace folder, or the .Rmd's parent if no workspace).
 * Paths that escape the containment root are dropped and surfaced via
 * `detailed().droppedCss`.
 *
 * `OutputOptions.pandocArgs` (verbatim YAML passthrough, already
 * stripped of destination/format flags by `parseOutputOptions`) is
 * appended after Raven's own flags. Pandoc's last-arg-wins rule means
 * users can override defaults like `--highlight-style` from YAML
 * without colliding with `-o`/`--to`/`--from`.
 *
 * HTML exports default to `--embed-resources` (matching rmarkdown's
 * `html_document` default of `self_contained: true`). Users opt out
 * with `self_contained: false` in YAML.
 */

import * as path from 'path';
import type { OutputOptions, TargetFormat } from './output-options';
import { isUnderContainmentRoot } from './raven-knit-paths';

export interface BuildPandocArgsCtx {
    mdPath: string;
    outPath: string;
    /** Directory of the source .Rmd. Used to resolve YAML-relative CSS paths. */
    sourceDir: string;
    /** Workspace folder containing the .Rmd, or sourceDir if no workspace. */
    containmentRoot: string;
    /** Required for `format === 'pdf'`. */
    pdfEngine?: string;
}

export interface DetailedPandocArgs {
    args: string[];
    droppedCss: string[];
}

function build(opts: OutputOptions, format: TargetFormat, ctx: BuildPandocArgsCtx): DetailedPandocArgs {
    const f = opts.pandocFlags;
    const args: string[] = [ctx.mdPath, '-o', ctx.outPath];
    if (format === 'html') {
        args.push('--to', 'html5', '--standalone');
        // Default HTML exports to self-contained. Without embedding,
        // Pandoc emits `<img src="figure/foo.png">` relative to the
        // destination — but the figures live in Raven's temp preview
        // dir, which is purged after the panel closes. The visible
        // export would silently lose its images. rmarkdown's
        // html_document defaults to self_contained: true for the same
        // reason; we match that contract here and respect an explicit
        // self_contained: false opt-out.
        if (f.self_contained !== false) args.push('--embed-resources');
    } else if (format === 'pdf') {
        args.push('--to', 'pdf');
        args.push(`--pdf-engine=${ctx.pdfEngine ?? 'xelatex'}`);
    } else if (format === 'docx') {
        args.push('--to', 'docx');
    }

    if (f.toc) args.push('--toc');
    if (f.toc_depth !== undefined) args.push(`--toc-depth=${f.toc_depth}`);
    if (f.number_sections) args.push('--number-sections');
    if (f.highlight) args.push(`--highlight-style=${f.highlight}`);
    if (f.mathjax) args.push('--mathjax');

    const droppedCss: string[] = [];
    if (f.css) {
        for (const entry of f.css) {
            const abs = path.isAbsolute(entry) ? entry : path.resolve(ctx.sourceDir, entry);
            const normalized = path.normalize(abs);
            if (isUnderContainmentRoot(normalized, ctx.containmentRoot)) {
                args.push(`--css=${normalized}`);
            } else {
                droppedCss.push(entry);
            }
        }
    }

    args.push(...opts.pandocArgs);

    return { args, droppedCss };
}

interface BuildPandocArgsFn {
    (opts: OutputOptions, format: TargetFormat, ctx: BuildPandocArgsCtx): string[];
    detailed(opts: OutputOptions, format: TargetFormat, ctx: BuildPandocArgsCtx): DetailedPandocArgs;
}

const buildPandocArgsImpl: BuildPandocArgsFn = ((
    opts: OutputOptions,
    format: TargetFormat,
    ctx: BuildPandocArgsCtx,
) => build(opts, format, ctx).args) as BuildPandocArgsFn;
buildPandocArgsImpl.detailed = build;

export const buildPandocArgs = buildPandocArgsImpl;
