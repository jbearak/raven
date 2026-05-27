/**
 * Pure semver-ish gate for VSCode runtime version checks.
 *
 * Kept free of any `vscode` import so it can be exercised by the bun test
 * suite (which cannot resolve the `vscode` module). The `vscode`-aware
 * callers live in modules like `viewer-tab-icon.ts`.
 */

/**
 * True when `version` is at least `major.minor`.
 *
 * Accepts VSCode version strings such as `"1.110.0"` or
 * `"1.111.2-insider"` — only the leading `major.minor` integers are
 * compared; any patch/pre-release suffix is ignored.
 */
export function meetsMinVersion(version: string, major: number, minor: number): boolean {
    const [maj, min] = version.split('.').map((p) => parseInt(p, 10));
    if (maj !== major) return maj > major;
    return min >= minor;
}
