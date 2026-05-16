/**
 * Construction and pre-validation of the R expression we hand to
 * `R --no-save --no-restore -e <expr>` when knitting an .Rmd file.
 *
 * Two guards protect this surface:
 *
 *   1. `validatePathForRExpression` rejects bytes that can't safely round-
 *      trip through an R single-quoted string literal: NUL (terminates R
 *      strings silently), most C0 controls (mangle the R expression's
 *      diagnostic output and have no legitimate place in a path), and
 *      DEL. Tab is allowed because some filesystems permit it.
 *   2. `validateFormatIdentifier` enforces a strict allow-pattern for the
 *      `output_format` argument: identifier chars plus `::`, `.`, and
 *      `-`. The pattern is defense in depth — the YAML parser already
 *      hands us a string from a controlled grammar.
 *
 * `escapeRString` itself is straightforward (backslash and apostrophe
 * escapes inside single quotes); the bulk of the security work is the
 * validation step that runs first. We never construct shell strings —
 * the caller spawns R with an argv array — so this is R-literal
 * injection prevention, not shell-injection prevention.
 */

export class ValidatePathError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ValidatePathError';
    }
}

export class ValidateFormatError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ValidateFormatError';
    }
}

/**
 * Refuse strings that can't safely become an R single-quoted literal:
 * NUL, DEL, and C0 controls other than tab. Tab is the one C0 we keep
 * because filesystems permit it and it's harmless inside an R string.
 * Bidi-override and other exotic printable Unicode characters are NOT
 * rejected — they round-trip cleanly through `escapeRString`.
 */
export function validatePathForRExpression(value: string): void {
    if (typeof value !== 'string') {
        throw new ValidatePathError('Path must be a string.');
    }
    if (value.length === 0) {
        throw new ValidatePathError('Path must not be empty.');
    }
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code === 0x09) continue; // tab: allowed
        if (code === 0x00) {
            throw new ValidatePathError('Path contains a NUL byte.');
        }
        if (code < 0x20) {
            throw new ValidatePathError(
                `Path contains control character U+${code.toString(16).padStart(4, '0').toUpperCase()}.`,
            );
        }
        if (code === 0x7F) {
            throw new ValidatePathError('Path contains the DEL character.');
        }
    }
}

const FORMAT_IDENTIFIER_PATTERN = /^[A-Za-z0-9_:.-]+$/;

/**
 * Enforce the strict allow-pattern for the `output_format` argument we
 * pass to `rmarkdown::render`. The pattern covers what YAML front matter
 * legitimately produces (`html_document`, `bookdown::pdf_document2`,
 * `default`, `all`, ...) and rejects anything that could break out of an
 * R identifier or call into a different function.
 */
export function validateFormatIdentifier(value: string): void {
    if (typeof value !== 'string' || value.length === 0) {
        throw new ValidateFormatError('Format identifier must be a non-empty string.');
    }
    if (!FORMAT_IDENTIFIER_PATTERN.test(value)) {
        throw new ValidateFormatError(
            `Format identifier "${value}" contains characters outside [A-Za-z0-9_:.-].`,
        );
    }
}

/**
 * Escape a string for inclusion inside an R single-quoted literal.
 * Single quotes and backslashes become `\'` and `\\`; the result is
 * wrapped in single quotes. Callers MUST validate inputs (NUL/control
 * characters) before calling — escaping alone cannot rescue those.
 */
export function escapeRString(value: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new ValidatePathError('Cannot escape an empty or non-string value.');
    }
    let out = "'";
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (ch === '\\') out += '\\\\';
        else if (ch === "'") out += "\\'";
        else out += ch;
    }
    out += "'";
    return out;
}

export interface KnitExpressionInput {
    filePath: string;
    format: string;
    knitRootDir: string | null;
}

/**
 * Build the single-line R expression passed to `R -e`. Each interpolated
 * value is validated before escaping (see module docstring), so the
 * caller can rely on a clean throw rather than a half-escaped string if
 * the inputs are wrong.
 */
export function buildKnitExpression(input: KnitExpressionInput): string {
    validatePathForRExpression(input.filePath);
    validateFormatIdentifier(input.format);
    if (input.knitRootDir !== null) {
        validatePathForRExpression(input.knitRootDir);
    }

    const parts = [
        `input = ${escapeRString(input.filePath)}`,
        `output_format = ${escapeRString(input.format)}`,
    ];
    if (input.knitRootDir !== null) {
        parts.push(`knit_root_dir = ${escapeRString(input.knitRootDir)}`);
    }
    return `rmarkdown::render(${parts.join(', ')})`;
}
