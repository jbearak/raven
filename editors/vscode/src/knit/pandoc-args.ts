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
 * No `pandoc_args` passthrough — that lives in `OutputOptions.ignored`.
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
    const args: string[] = [ctx.mdPath, '-o', ctx.outPath];
    if (format === 'html') {
        args.push('--to', 'html5', '--standalone');
    } else if (format === 'pdf') {
        args.push('--to', 'pdf');
        args.push(`--pdf-engine=${ctx.pdfEngine ?? 'xelatex'}`);
    } else if (format === 'docx') {
        args.push('--to', 'docx');
    }

    const f = opts.pandocFlags;
    if (f.toc) args.push('--toc');
    if (f.toc_depth !== undefined) args.push(`--toc-depth=${f.toc_depth}`);
    if (f.number_sections) args.push('--number-sections');
    if (f.highlight) args.push(`--highlight-style=${f.highlight}`);
    if (f.self_contained) args.push('--embed-resources', '--standalone');
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
