import * as vscode from 'vscode';

/**
 * Templates and commands that scaffold R-specific workspace files
 * (`.gitignore`) and Raven configuration (`.vscode/settings.json`).
 * Single-file writes prompt before overwriting; the linting-settings
 * scaffold merges into an existing settings file and only prompts when
 * it would overwrite existing `raven.linting.*` keys.
 */

export const GITIGNORE_TEMPLATE = `# History files
.Rhistory
.Rapp.history

# Session Data files
.RData
.RDataTmp

# User-specific files
.Ruserdata

# RStudio files
.Rproj.user/

# R Environment Variables
.Renviron

# pkgdown site
docs/

# translation temp files
po/*~

# OS files
.DS_Store
Thumbs.db

# R Markdown / knitr artifacts
*_cache/
*_files/

# R CMD check output
.Rcheck/

# Quarto cache
.quarto/

# Local scratch / output
output/
scratch/
scratch.R

# AI tool user-local files
.claude/settings.local.json
.claude/agent-memory-local/
.claude/scheduled_tasks.lock
.cursorignore.local
`;

/**
 * Ordered groups of `raven.linting.*` keys. Each group renders as a
 * `// lintr: ...` heading followed by one or more key/value lines.
 * The leading-group `comment` is shown above the very first group as
 * the overview header. Keep the ordering stable so the file is easy
 * to diff after running the scaffold a second time.
 */
interface LintingGroup {
    comment: string;
    entries: Array<{ key: string; value: unknown }>;
}

const LINTING_GROUPS: LintingGroup[] = [
    {
        comment: 'Master switch — enable Raven\'s native style/lint diagnostics.',
        entries: [{ key: 'raven.linting.enabled', value: true }],
    },
    {
        comment: 'lintr: line_length_linter(length = N)',
        entries: [
            { key: 'raven.linting.lineLength', value: 120 },
            { key: 'raven.linting.lineLengthSeverity', value: 'hint' },
        ],
    },
    {
        comment: 'lintr: trailing_whitespace_linter()',
        entries: [{ key: 'raven.linting.trailingWhitespaceSeverity', value: 'hint' }],
    },
    {
        comment: 'lintr: whitespace_linter() (no-tab portion)',
        entries: [{ key: 'raven.linting.noTabSeverity', value: 'hint' }],
    },
    {
        comment: 'lintr: trailing_blank_lines_linter()',
        entries: [{ key: 'raven.linting.trailingBlankLinesSeverity', value: 'hint' }],
    },
    {
        comment: 'lintr: assignment_linter()',
        entries: [
            { key: 'raven.linting.assignmentOperator', value: '<-' },
            { key: 'raven.linting.assignmentOperatorSeverity', value: 'hint' },
        ],
    },
    {
        comment: 'lintr: object_name_linter(styles = ...)',
        entries: [
            { key: 'raven.linting.objectNameStyleFunction', value: 'snake_case' },
            { key: 'raven.linting.objectNameStyleVariable', value: 'snake_case' },
            { key: 'raven.linting.objectNameStyleArgument', value: 'snake_case' },
            { key: 'raven.linting.objectNameSeverity', value: 'hint' },
        ],
    },
    {
        comment: 'lintr: infix_spaces_linter()',
        entries: [{ key: 'raven.linting.infixSpacesSeverity', value: 'hint' }],
    },
    {
        comment: 'lintr: commented_code_linter()',
        entries: [{ key: 'raven.linting.commentedCodeSeverity', value: 'hint' }],
    },
    {
        comment: 'lintr: quotes_linter() / single_quotes_linter()',
        entries: [
            { key: 'raven.linting.stringDelimiter', value: '"' },
            { key: 'raven.linting.quotesSeverity', value: 'hint' },
        ],
    },
    {
        comment: 'lintr: commas_linter()',
        entries: [{ key: 'raven.linting.commasSeverity', value: 'hint' }],
    },
    {
        comment: 'lintr: T_and_F_symbol_linter()',
        entries: [{ key: 'raven.linting.tAndFSymbolSeverity', value: 'hint' }],
    },
    {
        comment: 'lintr: semicolon_linter()',
        entries: [{ key: 'raven.linting.semicolonSeverity', value: 'hint' }],
    },
    {
        comment: 'lintr: equals_na_linter()',
        entries: [{ key: 'raven.linting.equalsNaSeverity', value: 'hint' }],
    },
    {
        comment: 'lintr: object_length_linter(length = N)',
        entries: [
            { key: 'raven.linting.objectLength', value: 30 },
            { key: 'raven.linting.objectLengthSeverity', value: 'hint' },
        ],
    },
    {
        comment: 'lintr: vector_logic_linter()',
        entries: [{ key: 'raven.linting.vectorLogicSeverity', value: 'hint' }],
    },
    {
        comment: 'lintr: function_left_parentheses_linter()',
        entries: [{ key: 'raven.linting.functionLeftParenthesesSeverity', value: 'hint' }],
    },
    {
        comment: 'lintr: spaces_inside_linter()',
        entries: [{ key: 'raven.linting.spacesInsideSeverity', value: 'hint' }],
    },
    {
        comment: 'lintr: indentation_linter(indent = N)',
        entries: [
            { key: 'raven.linting.indentationUnit', value: 2 },
            { key: 'raven.linting.indentationSeverity', value: 'hint' },
        ],
    },
];

const LINTING_BLOCK_HEADER =
    'Raven native style/lint diagnostics. Severities accept: "error",\n' +
    '"warning", "information", "hint", or "off". Each group below names\n' +
    'the lintr linter it mirrors. See docs/linting.md for details.';

/**
 * Sentinel markers that delimit the block this scaffold manages. A
 * re-run of the scaffold strips the full sentinel range (including the
 * per-group `// lintr: ...` headers) before inserting a fresh block, so
 * a previously scaffolded file stays clean instead of accumulating
 * orphaned header comments. The markers are intentionally long and
 * stable so an accidental match against a user-authored comment is
 * unlikely.
 */
export const LINTING_SENTINEL_BEGIN =
    '// >>> raven.linting.* (managed by "Raven: Create linting settings")';
export const LINTING_SENTINEL_END = '// <<< raven.linting.*';

/**
 * Format the linting-settings block (sentinels + header + groups) at
 * the given indentation, without surrounding braces. Every entry — even
 * the last one — emits a trailing comma; the sentinel-end comment line
 * (and possibly more existing keys after our block in the merge case)
 * follows, so the comma is always correct in JSONC.
 */
function formatLintingBlock(indent: string): string {
    const lines: string[] = [];
    lines.push(`${indent}${LINTING_SENTINEL_BEGIN}`);
    for (const headerLine of LINTING_BLOCK_HEADER.split('\n')) {
        lines.push(`${indent}// ${headerLine}`);
    }

    for (const group of LINTING_GROUPS) {
        lines.push('');
        lines.push(`${indent}// ${group.comment}`);
        for (const entry of group.entries) {
            lines.push(
                `${indent}${JSON.stringify(entry.key)}: ${JSON.stringify(entry.value)},`,
            );
        }
    }

    lines.push(`${indent}${LINTING_SENTINEL_END}`);
    return lines.join('\n');
}

/**
 * The literal contents of a fresh `.vscode/settings.json` containing
 * just the linting block. Exported for unit tests; the production path
 * builds this via `buildLintingSettingsContent` so an existing file is
 * merged rather than clobbered.
 */
export const LINTING_SETTINGS_TEMPLATE = `{\n${formatLintingBlock('  ')}\n}\n`;

/**
 * Strip `//` line comments and `/* ... *\/` block comments from JSONC
 * text, preserving string contents and newlines (so line numbers in
 * any downstream parse errors still line up). Trailing-comma stripping
 * is left to the caller; this function only removes comments.
 *
 * Returns `null` if the input contains an unterminated block comment.
 * Without this guard, the comment-stripper would silently drop the
 * rest of the file and any subsequent `JSON.parse` would succeed on
 * the truncated prefix — leading the scaffold to write back invalid
 * JSONC (a `/*` with nothing closing it).
 */
function stripJsoncComments(text: string): string | null {
    let out = '';
    let i = 0;
    let inString = false;
    while (i < text.length) {
        const c = text[i];
        if (inString) {
            out += c;
            if (c === '\\' && i + 1 < text.length) {
                out += text[i + 1];
                i += 2;
                continue;
            }
            if (c === '"') inString = false;
            i++;
            continue;
        }
        if (c === '"') {
            inString = true;
            out += c;
            i++;
            continue;
        }
        if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            i += 2;
            let closed = false;
            while (i + 1 < text.length) {
                if (text[i] === '*' && text[i + 1] === '/') {
                    closed = true;
                    break;
                }
                if (text[i] === '\n') out += '\n';
                i++;
            }
            if (!closed) return null;
            i += 2;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

function stripTrailingCommas(text: string): string {
    return text.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Result of parsing JSONC settings text for our purposes:
 *   - `parseError`: text was not valid JSONC at all (caller should bail).
 *   - `nonObjectRoot`: parsed fine but the root isn't a JSON object
 *     (e.g. an array, scalar, or `null`). Can't safely merge into it.
 *   - `object`: parsed as a JSON object — `keys` lists the top-level
 *     `raven.linting.*` keys present (may be empty).
 */
type LintingParseResult =
    | { kind: 'parseError' }
    | { kind: 'nonObjectRoot' }
    | { kind: 'object'; keys: string[] };

function parseLintingKeys(text: string): LintingParseResult {
    if (text.trim().length === 0) return { kind: 'object', keys: [] };
    const stripped = stripJsoncComments(text);
    if (stripped === null) return { kind: 'parseError' };
    let parsed: unknown;
    try {
        parsed = JSON.parse(stripTrailingCommas(stripped));
    } catch {
        return { kind: 'parseError' };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { kind: 'nonObjectRoot' };
    }
    return {
        kind: 'object',
        keys: Object.keys(parsed as Record<string, unknown>).filter((k) =>
            k.startsWith('raven.linting.'),
        ),
    };
}

/**
 * Parse-with-comments helper that returns the list of top-level
 * `raven.linting.*` keys present in a JSONC text, or `null` if the text
 * has parse errors **or** is valid JSON whose root isn't an object.
 * An empty file returns an empty array.
 *
 * Kept in this collapsed shape (string[] | null) because the test suite
 * uses it as a parse-success signal; the scaffold command path uses
 * the richer `parseLintingKeys` discriminator to distinguish parse
 * errors from a non-object root.
 */
export function detectExistingLintingKeys(text: string): string[] | null {
    const result = parseLintingKeys(text);
    return result.kind === 'object' ? result.keys : null;
}

/**
 * Walk JSONC text and return the index of the `}` that closes the
 * outermost object, or `-1` if none was found. Skips braces inside
 * strings and comments.
 */
function findOutermostClosingBrace(text: string): number {
    let depth = 0;
    let inString = false;
    let close = -1;
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (inString) {
            if (c === '\\' && i + 1 < text.length) {
                i += 2;
                continue;
            }
            if (c === '"') inString = false;
            i++;
            continue;
        }
        if (c === '"') {
            inString = true;
            i++;
            continue;
        }
        if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            i += 2;
            while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        if (c === '{') {
            depth++;
            i++;
            continue;
        }
        if (c === '}') {
            depth--;
            if (depth === 0) close = i;
            i++;
            continue;
        }
        i++;
    }
    return close;
}

/**
 * Compute the offsets, line by line, at which a given character index
 * falls. Used by the sentinel walker to map char-positions back to line
 * indices without re-scanning the whole text per lookup.
 */
function computeLineStarts(text: string): number[] {
    const starts: number[] = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') starts.push(i + 1);
    }
    return starts;
}

function lineIndexOfPos(lineStarts: number[], pos: number): number {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (lineStarts[mid] <= pos) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

/**
 * Find the line indices of our sentinel-begin / sentinel-end markers,
 * skipping any matches that fall inside a JSONC `/* ... *\/` block
 * comment (line-comment matches are kept — those are exactly what we
 * emit). Returns `null` if either marker is missing or appears on the
 * wrong side of the other.
 */
function findSentinelLineRange(text: string): { begin: number; end: number } | null {
    const lineStarts = computeLineStarts(text);
    const sentinelLines: { begin: number | null; end: number | null } = {
        begin: null,
        end: null,
    };

    let i = 0;
    let inString = false;
    let inBlockComment = false;
    let lineConsumed = -1; // last line we've already classified

    function maybeRecord(pos: number) {
        const lineIdx = lineIndexOfPos(lineStarts, pos);
        if (lineIdx <= lineConsumed) return;
        const lineStart = lineStarts[lineIdx];
        const lineEnd =
            lineIdx + 1 < lineStarts.length ? lineStarts[lineIdx + 1] - 1 : text.length;
        const lineText = text.slice(lineStart, lineEnd).trim();
        if (lineText === LINTING_SENTINEL_BEGIN && sentinelLines.begin === null) {
            sentinelLines.begin = lineIdx;
        } else if (
            lineText === LINTING_SENTINEL_END &&
            sentinelLines.begin !== null &&
            sentinelLines.end === null &&
            lineIdx > sentinelLines.begin
        ) {
            sentinelLines.end = lineIdx;
        }
        lineConsumed = lineIdx;
    }

    while (i < text.length) {
        const c = text[i];
        if (inBlockComment) {
            if (c === '*' && text[i + 1] === '/') {
                inBlockComment = false;
                i += 2;
                continue;
            }
            i++;
            continue;
        }
        if (inString) {
            if (c === '\\' && i + 1 < text.length) {
                i += 2;
                continue;
            }
            if (c === '"') inString = false;
            i++;
            continue;
        }
        if (c === '"') {
            inString = true;
            i++;
            continue;
        }
        if (c === '/' && text[i + 1] === '/') {
            // A line comment outside of a block comment — this is where
            // our sentinels live. Classify the line.
            maybeRecord(i);
            while (i < text.length && text[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            inBlockComment = true;
            i += 2;
            continue;
        }
        i++;
    }

    if (sentinelLines.begin === null || sentinelLines.end === null) return null;
    return { begin: sentinelLines.begin, end: sentinelLines.end };
}

/**
 * Strip the entire sentinel-delimited block we manage, including the
 * inner `// lintr: ...` headers and key lines. If either sentinel is
 * missing — or appears only inside a block comment — returns the input
 * unchanged.
 */
function stripSentineledLintingBlock(text: string): string {
    const range = findSentinelLineRange(text);
    if (!range) return text;
    const lines = text.split('\n');
    lines.splice(range.begin, range.end - range.begin + 1);
    return lines.join('\n');
}

/**
 * Remove lines whose sole content is a **top-level** `raven.linting.*`
 * key declaration. `raven.linting.*` values are all scalars (boolean,
 * int, string) so single-line removal is safe.
 *
 * Walks the text tracking string/comment state and brace/bracket depth
 * so a nested key (e.g. inside a `[r]` language override block where
 * the user might write `"[r]": { "raven.linting.lineLength": 120 }`)
 * is left untouched.
 *
 * Assumes the VS Code convention of one key per line. A user who puts
 * `"editor.tabSize": 4, "raven.linting.foo": true` on a single line
 * would lose the unrelated key here, but VS Code's own formatters and
 * the Settings UI never produce that shape, so we don't try to handle
 * it.
 */
function stripTopLevelLintingLines(text: string): string {
    const lineStarts = computeLineStarts(text);
    const linesToStrip = new Set<number>();

    let depth = 0;
    let inString = false;
    let inBlockComment = false;
    let i = 0;

    while (i < text.length) {
        const c = text[i];
        if (inBlockComment) {
            if (c === '*' && text[i + 1] === '/') {
                inBlockComment = false;
                i += 2;
                continue;
            }
            i++;
            continue;
        }
        if (inString) {
            if (c === '\\' && i + 1 < text.length) {
                i += 2;
                continue;
            }
            if (c === '"') inString = false;
            i++;
            continue;
        }
        if (c === '"') {
            // String-literal start. If we're at depth 1, this could be a
            // top-level property key; check whether it matches our pattern
            // and is followed by `:` (ignoring whitespace/comments).
            if (depth === 1) {
                const match = /^"raven\.linting\.[^"\\]+"/.exec(text.slice(i));
                if (match) {
                    const afterKey = i + match[0].length;
                    let j = afterKey;
                    // Skip whitespace and same-line comments looking for `:`.
                    while (j < text.length) {
                        const ch = text[j];
                        if (ch === ' ' || ch === '\t') {
                            j++;
                            continue;
                        }
                        if (ch === '/' && text[j + 1] === '/') {
                            while (j < text.length && text[j] !== '\n') j++;
                            break;
                        }
                        if (ch === '/' && text[j + 1] === '*') {
                            j += 2;
                            while (
                                j + 1 < text.length &&
                                !(text[j] === '*' && text[j + 1] === '/')
                            )
                                j++;
                            j += 2;
                            continue;
                        }
                        break;
                    }
                    if (j < text.length && text[j] === ':') {
                        linesToStrip.add(lineIndexOfPos(lineStarts, i));
                    }
                }
            }
            inString = true;
            i++;
            continue;
        }
        if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            inBlockComment = true;
            i += 2;
            continue;
        }
        if (c === '{' || c === '[') {
            depth++;
            i++;
            continue;
        }
        if (c === '}' || c === ']') {
            depth--;
            i++;
            continue;
        }
        i++;
    }

    if (linesToStrip.size === 0) return text;

    const lines = text.split('\n');
    const kept: string[] = [];
    for (let li = 0; li < lines.length; li++) {
        if (!linesToStrip.has(li)) kept.push(lines[li]);
    }
    return kept.join('\n');
}

/**
 * Append a `,` after the last non-comment, non-whitespace character of
 * `text`. If the trailing content is a `//` line comment or a `/* *\/`
 * block comment, the comma is inserted *before* the comment so the
 * file remains valid JSONC. No-op if the last significant character is
 * already `,`, `{`, or `[` (i.e. no separator needed).
 */
function appendCommaIfNeeded(text: string): string {
    let lastSig = -1;
    let i = 0;
    let inString = false;

    while (i < text.length) {
        const c = text[i];
        if (inString) {
            if (c === '\\' && i + 1 < text.length) {
                lastSig = i + 1;
                i += 2;
                continue;
            }
            lastSig = i;
            if (c === '"') inString = false;
            i++;
            continue;
        }
        if (c === '"') {
            inString = true;
            lastSig = i;
            i++;
            continue;
        }
        if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            i += 2;
            while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
            i++;
            continue;
        }
        lastSig = i;
        i++;
    }

    if (lastSig === -1) return text;
    const lastChar = text[lastSig];
    if (lastChar === ',' || lastChar === '{' || lastChar === '[') return text;
    return text.slice(0, lastSig + 1) + ',' + text.slice(lastSig + 1);
}

/**
 * Like `detectExistingLintingKeys`, but ignores keys inside the sentinel-
 * managed block this scaffold owns. Used by the scaffold command to
 * decide whether to prompt: keys inside our block are safe to overwrite
 * silently on a re-run, but keys *outside* it are user-managed and need
 * confirmation. Returns `null` for parse errors or a non-object root.
 */
export function detectUserManagedLintingKeys(text: string): string[] | null {
    return detectExistingLintingKeys(stripSentineledLintingBlock(text));
}

/**
 * Same as `detectUserManagedLintingKeys`, but returns the richer result
 * shape so callers can distinguish a JSON parse error from a non-object
 * root (e.g. the file contains `[1, 2, 3]`). The scaffold command path
 * uses this; tests use the simpler `string[] | null` flavour above.
 */
export function classifyUserManagedLintingKeys(text: string): LintingParseResult {
    return parseLintingKeys(stripSentineledLintingBlock(text));
}

/**
 * Build the JSONC content to write to `.vscode/settings.json`. If
 * `existing` is `undefined` or whitespace-only, returns the fresh
 * template. Otherwise strips any prior sentinel-managed block and any
 * top-level `raven.linting.*` keys, then inserts a freshly formatted
 * block immediately before the outermost closing brace — preserving
 * all unrelated keys and comments.
 *
 * Returns `null` if the existing content can't safely be merged into
 * (parse error, or root isn't a JSON object). Callers must surface
 * that to the user rather than overwriting their file.
 */
export function buildLintingSettingsContent(existing: string | undefined): string | null {
    if (existing === undefined || existing.trim().length === 0) {
        return LINTING_SETTINGS_TEMPLATE;
    }

    const afterSentinelStrip = stripSentineledLintingBlock(existing);
    const classification = parseLintingKeys(afterSentinelStrip);
    if (classification.kind !== 'object') return null;

    const fullyStripped = stripTopLevelLintingLines(afterSentinelStrip);
    const closeIdx = findOutermostClosingBrace(fullyStripped);
    if (closeIdx === -1) return null;

    const before = fullyStripped.slice(0, closeIdx);
    const after = fullyStripped.slice(closeIdx);
    const trimmedBefore = before.replace(/[ \t\n\r]+$/, '');
    const prefix = appendCommaIfNeeded(trimmedBefore) + '\n';

    return `${prefix}${formatLintingBlock('  ')}\n${after}`;
}

/**
 * Return the first workspace folder, or surface a message and return
 * `undefined` if none is open. Without a workspace folder there is no
 * unambiguous place to write the scaffold file.
 */
function getTargetWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        void vscode.window.showErrorMessage(
            'Raven: open a folder before creating an R scaffold file.',
        );
        return undefined;
    }
    return folders[0];
}

/**
 * Write `content` to `fileName` in the given workspace folder, prompting
 * before overwriting an existing file. Returns the target URI on success.
 */
export async function createScaffoldFile(
    folder: vscode.WorkspaceFolder,
    fileName: string,
    content: string,
): Promise<vscode.Uri | undefined> {
    const target = vscode.Uri.joinPath(folder.uri, fileName);

    let exists = false;
    try {
        await vscode.workspace.fs.stat(target);
        exists = true;
    } catch {
        exists = false;
    }

    if (exists) {
        const choice = await vscode.window.showWarningMessage(
            `${fileName} already exists in ${folder.name}. Overwrite?`,
            { modal: true },
            'Overwrite',
        );
        if (choice !== 'Overwrite') {
            return undefined;
        }
    }

    const bytes = Buffer.from(content, 'utf8');
    await vscode.workspace.fs.writeFile(target, bytes);

    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc, { preview: false });

    void vscode.window.setStatusBarMessage(
        `Raven: ${exists ? 'overwrote' : 'created'} ${fileName}`,
        3000,
    );

    return target;
}

/**
 * Run `createScaffoldFile` and surface a Raven-branded error notification on
 * failure. Mirrors the try/catch pattern used by `raven.refreshPackages` so
 * filesystem errors (permission denied, read-only workspace) get a clearer
 * message than VS Code's default rejection toast.
 */
async function runScaffoldCommand(fileName: string, content: string): Promise<void> {
    const folder = getTargetWorkspaceFolder();
    if (!folder) return;
    try {
        await createScaffoldFile(folder, fileName, content);
    } catch (err) {
        void vscode.window.showErrorMessage(
            `Raven: failed to create ${fileName}: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

/**
 * Merge a Raven linting-settings block into `.vscode/settings.json`,
 * creating the file (and the `.vscode/` directory) if absent. If the
 * file already contains any `raven.linting.*` keys, prompt before
 * overwriting them; unrelated keys and comments are preserved.
 */
async function runLintingSettingsScaffold(
    folder: vscode.WorkspaceFolder,
): Promise<vscode.Uri | undefined> {
    const vscodeDir = vscode.Uri.joinPath(folder.uri, '.vscode');
    const settingsUri = vscode.Uri.joinPath(vscodeDir, 'settings.json');
    const displayName = '.vscode/settings.json';

    let existing: string | undefined;
    try {
        const bytes = await vscode.workspace.fs.readFile(settingsUri);
        existing = Buffer.from(bytes).toString('utf8');
    } catch {
        existing = undefined;
    }

    if (existing !== undefined) {
        // Keys inside our sentinel-managed block were produced by an
        // earlier run of this same scaffold, so it's safe to regenerate
        // them silently. Only user-authored `raven.linting.*` keys
        // (anything outside the sentinel range) trigger the prompt.
        const classification = classifyUserManagedLintingKeys(existing);
        if (classification.kind === 'parseError') {
            void vscode.window.showErrorMessage(
                `Raven: ${displayName} has JSON parse errors; fix them and re-run this command.`,
            );
            return undefined;
        }
        if (classification.kind === 'nonObjectRoot') {
            void vscode.window.showErrorMessage(
                `Raven: ${displayName} is valid JSON but its root isn't a JSON object — refusing to overwrite. Move the file aside (or wrap its contents in \`{}\`) and re-run this command.`,
            );
            return undefined;
        }
        const userManagedKeys = classification.keys;
        if (userManagedKeys.length > 0) {
            const label =
                userManagedKeys.length === 1
                    ? '1 raven.linting.* setting'
                    : `${userManagedKeys.length} raven.linting.* settings`;
            const choice = await vscode.window.showWarningMessage(
                `${label} already in ${displayName}. Overwrite the raven.linting.* block? Other keys and comments will be preserved.`,
                { modal: true },
                'Overwrite',
            );
            if (choice !== 'Overwrite') {
                return undefined;
            }
        }
    }

    const newContent = buildLintingSettingsContent(existing);
    if (newContent === null) {
        // Classification above should have caught this — defensive only.
        void vscode.window.showErrorMessage(
            `Raven: could not safely merge into ${displayName}.`,
        );
        return undefined;
    }

    try {
        await vscode.workspace.fs.createDirectory(vscodeDir);
    } catch {
        // directory may already exist; createDirectory is best-effort
    }

    await vscode.workspace.fs.writeFile(settingsUri, Buffer.from(newContent, 'utf8'));

    const doc = await vscode.workspace.openTextDocument(settingsUri);
    await vscode.window.showTextDocument(doc, { preview: false });

    void vscode.window.setStatusBarMessage(
        `Raven: ${existing === undefined ? 'created' : 'updated'} ${displayName}`,
        3000,
    );

    return settingsUri;
}

export function registerScaffoldCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('raven.scaffold.gitignore', () =>
            runScaffoldCommand('.gitignore', GITIGNORE_TEMPLATE),
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('raven.scaffold.lintingSettings', async () => {
            const folder = getTargetWorkspaceFolder();
            if (!folder) return;
            try {
                await runLintingSettingsScaffold(folder);
            } catch (err) {
                void vscode.window.showErrorMessage(
                    `Raven: failed to update .vscode/settings.json: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }),
    );
}
