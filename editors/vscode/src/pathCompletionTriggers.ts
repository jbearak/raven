// `# raven:` is the canonical directive prefix; `@lsp-` is a permanent alias
// (#421). Kept as one fragment so both trigger regexes accept either prefix —
// this mirrors `DIRECTIVE_PREFIX` in the server's `cross_file::directive`. The
// keyword group is the forward + backward families (path-bearing directives).
const DIRECTIVE_PREFIX = String.raw`#\s*(?:@lsp-|raven:\s*)`;
const DIRECTIVE_KEYWORDS = 'source|run|include|sourced-by|run-by|included-by';
const DIRECTIVE_SPACE_TRIGGER_RE = new RegExp(
    String.raw`^\s*${DIRECTIVE_PREFIX}(?:${DIRECTIVE_KEYWORDS}):?\s+$`,
);
const DIRECTIVE_PATH_TRIGGER_RE = new RegExp(
    String.raw`^\s*${DIRECTIVE_PREFIX}(?:${DIRECTIVE_KEYWORDS})(?::)?\s*(?:["'])?[^"'#]*\/$`,
);
const SOURCE_POSITIONAL_PATH_TRIGGER_RE =
    /\b(?:source|sys\.source)\s*\(\s*(?:file\s*=\s*)?["'][^"'\\]*(?:\\.[^"'\\]*)*\/$/;
const SOURCE_NAMED_FILE_PATH_TRIGGER_RE =
    /\b(?:source|sys\.source)\s*\([^)]*?\bfile\s*=\s*["'][^"'\\]*(?:\\.[^"'\\]*)*\/$/;

export function shouldTriggerDirectivePathSuggest(
    insertedText: string,
    linePrefix: string,
): boolean {
    if (insertedText !== ' ') {
        return false;
    }

    return DIRECTIVE_SPACE_TRIGGER_RE.test(linePrefix);
}

export function shouldTriggerNestedPathSuggest(
    insertedText: string,
    linePrefix: string,
): boolean {
    if (!insertedText.endsWith('/') || insertedText.length <= 1) {
        return false;
    }

    return (
        DIRECTIVE_PATH_TRIGGER_RE.test(linePrefix) ||
        SOURCE_POSITIONAL_PATH_TRIGGER_RE.test(linePrefix) ||
        SOURCE_NAMED_FILE_PATH_TRIGGER_RE.test(linePrefix)
    );
}
