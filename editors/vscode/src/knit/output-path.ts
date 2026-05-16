/**
 * Best-effort parser for the rendered-output paths that
 * `rmarkdown::render` prints to the R console.
 *
 * Source-of-truth message: `rmarkdown:::render_print` in the rmarkdown
 * R package emits `Output created: <path>` via `message()`. The literal
 * is not currently localized, but rmarkdown could localize it in a
 * future release. If parsing fails we surface "Knit succeeded (output
 * path unknown)" rather than fabricating a path — the subprocess exit
 * code is the ground truth for success/failure; output parsing is a
 * UX nicety.
 *
 * `output_format = "all"` (or a multi-output knit hook) emits one
 * "Output created" line per format. We return every match so the
 * caller can offer "Show All" alongside opening the first.
 */

const OUTPUT_LINE = /^[\t ]*Output created:[\t ]+(.+?)[\t ]*$/;

export interface ParsedOutput {
    paths: string[];
}

export function parseRenderedOutputPath(stdout: string): ParsedOutput {
    const paths: string[] = [];
    for (const rawLine of stdout.split('\n')) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        const match = line.match(OUTPUT_LINE);
        if (match) paths.push(match[1]);
    }
    return { paths };
}
