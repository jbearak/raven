/**
 * Returns true iff the first non-empty line of Pandoc's `--version`
 * stdout begins with `pandoc` (case-insensitive).
 *
 * `probePandocBinary` (in `index.ts`) uses this to reject non-Pandoc
 * executables that happen to return exit 0 for `--version`. Coreutils
 * `echo`, `cat`, and several others fall in that bucket; treating any
 * exit-0 binary as Pandoc would let a misconfigured `raven.pandoc.path`
 * silently route export through the wrong executable.
 *
 * Pandoc's first version line is `pandoc 3.x.y` (and historically
 * `pandoc 2.x.y`, `pandoc 1.x.y`), so a `^pandoc(\s|$)` prefix match is
 * both specific and stable across major versions.
 */
export function isPandocVersionOutput(stdout: string): boolean {
    for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        return /^pandoc(?:\s|$)/i.test(trimmed);
    }
    return false;
}
