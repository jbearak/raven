const DIRECTIVE_SPACE_TRIGGER_RE =
    /^\s*#\s*@lsp-(?:source|run|include|sourced-by|run-by|included-by)\s+$/;
const DIRECTIVE_PATH_TRIGGER_RE =
    /^\s*#\s*@lsp-(?:source|run|include|sourced-by|run-by|included-by)(?::)?\s*(?:["'])?[^"'#]*\/$/;
const SOURCE_PATH_TRIGGER_RE =
    /\b(?:source|sys\.source)\s*\(\s*(?:file\s*=\s*)?["'][^"'\\]*(?:\\.[^"'\\]*)*\/$/;

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
        SOURCE_PATH_TRIGGER_RE.test(linePrefix)
    );
}
