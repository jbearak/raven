const DIRECTIVE_SPACE_TRIGGER_RE =
    /^\s*#\s*@lsp-(?:source|run|include|sourced-by|run-by|included-by)\s+$/;

export function shouldTriggerDirectivePathSuggest(
    insertedText: string,
    linePrefix: string,
): boolean {
    if (insertedText !== ' ') {
        return false;
    }

    return DIRECTIVE_SPACE_TRIGGER_RE.test(linePrefix);
}
