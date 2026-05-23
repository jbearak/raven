/**
 * Thin shim over `raven-knit-paths.previewArtifactPaths` for the
 * existing `computeMdOutputPath` / `computeHtmlOutputPath` callers.
 *
 * The old behavior wrote `<basename>.md` and `<basename>.html` next to
 * the source `.Rmd`. The new behavior writes them into a per-session
 * temp dir at `<tmpdir>/raven-knit/<workspaceHash>/<sessionId>/preview/
 * <sourceHash>/`. See `docs/superpowers/specs/2026-05-23-knit-preview-
 * export-design.md` for the rationale.
 *
 * No `vscode` dependency — purely a path-derivation module.
 */

import { previewArtifactPaths } from './raven-knit-paths';

export function computeMdOutputPath(rmdFsPath: string): string {
    return previewArtifactPaths(rmdFsPath).mdPath;
}

export function computeHtmlOutputPath(rmdFsPath: string): string {
    return previewArtifactPaths(rmdFsPath).htmlPath;
}
