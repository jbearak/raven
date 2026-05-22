import * as path from 'path';

/**
 * Derive the intermediate `.md` path that `knitr::knit` will write
 * to, from the input `.Rmd` path. Strips a trailing
 * `.Rmd` / `.rmd` / `.RMD` extension and appends `.md`.
 *
 * Defensive: if the input has no recognized R-Markdown extension we
 * just append `.md`. The `runKnitCommand` gate already requires
 * `.Rmd`, but a future caller change shouldn't be able to silently
 * produce a strange-looking output path.
 *
 * Pure path string manipulation — no `vscode` dependency so this is
 * unit-testable from `bun test`.
 */
export function computeMdOutputPath(rmdFsPath: string): string {
    const dir = path.dirname(rmdFsPath);
    const base = path.basename(rmdFsPath);
    const stripped = base.replace(/\.[Rr][Mm][Dd]$/, '');
    return path.join(dir, `${stripped}.md`);
}

/**
 * Derive the final `.html` path that the post-knit render pipeline
 * writes to, from the input `.Rmd` path. Same stripping rule as the
 * `.md` helper.
 */
export function computeHtmlOutputPath(rmdFsPath: string): string {
    const dir = path.dirname(rmdFsPath);
    const base = path.basename(rmdFsPath);
    const stripped = base.replace(/\.[Rr][Mm][Dd]$/, '');
    return path.join(dir, `${stripped}.html`);
}
