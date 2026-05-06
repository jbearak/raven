/**
 * R multi-line statement detection.
 * Pure functions (no VS Code dependency) so they can be unit tested.
 *
 * An R expression is incomplete when:
 * - Brackets/parens/braces are unmatched
 * - Line ends with a binary operator (+, -, *, /, |>, %>%, %any%, ||, &&, |, &, ~, =, <-, ->, ,, ::, :::)
 * - Line ends with an opening bracket/paren/brace
 * - Next line starts with a pipe, closing bracket, or binary operator continuation
 */

export interface StatementBounds {
    start_line: number;  // 0-indexed, inclusive
    end_line: number;    // 0-indexed, inclusive
}

/**
 * Trailing operators that signal the expression continues on the next line.
 * Order matters: longer patterns must come before shorter ones that are prefixes.
 */
const TRAILING_OPERATORS = [
    '|>', '%>%', ':::', '::', '||', '&&', '<<-', '->>',
    '<-', '->',  '<=', '>=', '==', '!=',
    '+', '-', '*', '/', '^', '~', ',', '|', '&', '=',
    '<', '>',
];

/**
 * Leading tokens that signal this line continues a previous expression.
 */
const LEADING_CONTINUATION_RE = /^\s*(\|>|%>%|%[^%]+%|\)|\]|\}|\+|-|\*|\/|\^|~|\||&|,)/;

/**
 * Strip comments and strings from a line to avoid false positives.
 * Returns the "code-only" content for bracket/operator analysis.
 */
export function strip_strings_and_comments(line: string): string {
    let result = '';
    let i = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch === '#') {
            break; // rest is comment
        }
        if (ch === '"' || ch === "'") {
            // skip string
            const quote = ch;
            i++;
            while (i < line.length) {
                if (line[i] === '\\') {
                    i += 2;
                } else if (line[i] === quote) {
                    i++;
                    break;
                } else {
                    i++;
                }
            }
            result += '""'; // placeholder
        } else if (ch === '`') {
            // skip backtick-quoted name
            i++;
            while (i < line.length && line[i] !== '`') {
                i++;
            }
            i++; // skip closing backtick
            result += '``';
        } else {
            result += ch;
            i++;
        }
    }
    return result;
}

/**
 * Count net open brackets in a code line (after stripping strings/comments).
 */
function net_open_brackets(code: string): number {
    let count = 0;
    for (const ch of code) {
        if (ch === '(' || ch === '[' || ch === '{') count++;
        else if (ch === ')' || ch === ']' || ch === '}') count--;
    }
    return count;
}

/**
 * Check if a line's expression is incomplete (continues on the next line).
 */
export function is_r_line_incomplete(line: string): boolean {
    const code = strip_strings_and_comments(line);
    const trimmed = code.trimEnd();
    if (trimmed.length === 0) return false;

    // Unmatched open brackets
    if (net_open_brackets(code) > 0) return true;

    // Ends with a trailing operator
    for (const op of TRAILING_OPERATORS) {
        if (trimmed.endsWith(op)) return true;
    }

    // Ends with an opening bracket (block/call continues on next line)
    const last_char = trimmed[trimmed.length - 1];
    if (last_char === '(' || last_char === '[' || last_char === '{') return true;

    // Ends with %infix% operator
    if (/%.+%\s*$/.test(trimmed)) return true;

    return false;
}

/**
 * Check if a line is a continuation of a previous expression.
 */
export function is_r_line_continuation(line: string): boolean {
    return LEADING_CONTINUATION_RE.test(line);
}

/**
 * Detect the full statement bounds around the cursor line.
 * Walks upward while previous lines are incomplete or current line is a continuation,
 * then walks downward while current line is incomplete or next line is a continuation.
 */
export function detect_r_statement(
    lines: string[],
    cursor_line: number
): StatementBounds {
    let start_line = cursor_line;
    let end_line = cursor_line;

    // Walk upward
    while (start_line > 0) {
        const prev = lines[start_line - 1];
        const curr = lines[start_line];
        if (is_r_line_incomplete(prev) || is_r_line_continuation(curr)) {
            start_line--;
        } else {
            break;
        }
    }

    // Walk downward
    while (end_line < lines.length - 1) {
        const curr = lines[end_line];
        const next = lines[end_line + 1];
        if (is_r_line_incomplete(curr) || is_r_line_continuation(next)) {
            end_line++;
        } else {
            break;
        }
    }

    return { start_line, end_line };
}

/**
 * Get bounds from start of file to cursor (extending to complete the statement).
 */
export function get_upward_bounds(
    lines: string[],
    cursor_line: number
): StatementBounds {
    let end_line = cursor_line;

    // Extend downward to complete the statement at cursor
    while (end_line < lines.length - 1) {
        const curr = lines[end_line];
        const next = lines[end_line + 1];
        if (is_r_line_incomplete(curr) || is_r_line_continuation(next)) {
            end_line++;
        } else {
            break;
        }
    }

    return { start_line: 0, end_line };
}

/**
 * Get bounds from cursor to end of file (extending upward to include statement start).
 */
export function get_downward_bounds(
    lines: string[],
    cursor_line: number
): StatementBounds {
    let start_line = cursor_line;

    // Extend upward to find statement start
    while (start_line > 0) {
        const prev = lines[start_line - 1];
        const curr = lines[start_line];
        if (is_r_line_incomplete(prev) || is_r_line_continuation(curr)) {
            start_line--;
        } else {
            break;
        }
    }

    return { start_line, end_line: lines.length - 1 };
}
