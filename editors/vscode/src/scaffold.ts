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
 * Format the linting-settings block (header + groups) at the given
 * indentation, without surrounding braces. The final entry uses the
 * supplied `trailingPunctuation` so the caller can distinguish the
 * fresh-file case (no trailing comma — last property in the object)
 * from the merge case (trailing comma — more properties may follow).
 */
function formatLintingBlock(indent: string, trailingPunctuation: '' | ','): string {
    const lines: string[] = [];
    for (const headerLine of LINTING_BLOCK_HEADER.split('\n')) {
        lines.push(`${indent}// ${headerLine}`);
    }

    LINTING_GROUPS.forEach((group, groupIdx) => {
        lines.push('');
        lines.push(`${indent}// ${group.comment}`);
        group.entries.forEach((entry, entryIdx) => {
            const isLastEntryOfBlock =
                groupIdx === LINTING_GROUPS.length - 1 &&
                entryIdx === group.entries.length - 1;
            const sep = isLastEntryOfBlock ? trailingPunctuation : ',';
            lines.push(
                `${indent}${JSON.stringify(entry.key)}: ${JSON.stringify(entry.value)}${sep}`,
            );
        });
    });

    return lines.join('\n');
}

/**
 * The literal contents of a fresh `.vscode/settings.json` containing
 * just the linting block. Exported for unit tests; the production path
 * builds this via `buildLintingSettingsContent` so an existing file is
 * merged rather than clobbered.
 */
export const LINTING_SETTINGS_TEMPLATE = `{\n${formatLintingBlock('  ', '')}\n}\n`;

/**
 * Strip `//` line comments and `/* ... *\/` block comments from JSONC
 * text, preserving string contents and newlines (so line numbers in
 * any downstream parse errors still line up). Trailing-comma stripping
 * is left to the caller; this function only removes comments.
 */
function stripJsoncComments(text: string): string {
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
            while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
                if (text[i] === '\n') out += '\n';
                i++;
            }
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
 * Parse-with-comments helper that returns the list of top-level
 * `raven.linting.*` keys present in a JSONC text, or `null` if the text
 * has parse errors. An empty file returns an empty array.
 */
export function detectExistingLintingKeys(text: string): string[] | null {
    if (text.trim().length === 0) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(stripTrailingCommas(stripJsoncComments(text)));
    } catch {
        return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return [];
    }
    return Object.keys(parsed as Record<string, unknown>).filter((k) =>
        k.startsWith('raven.linting.'),
    );
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
 * Remove lines whose sole content is a top-level `raven.linting.*` key
 * declaration. `raven.linting.*` values are all scalars (boolean, int,
 * string) so single-line removal is safe.
 */
function stripExistingLintingLines(text: string): string {
    return text.replace(/^[ \t]*"raven\.linting\.[^"]+"[ \t]*:[^\n]*\n?/gm, '');
}

/**
 * Build the JSONC content to write to `.vscode/settings.json`. If
 * `existing` is `undefined` or whitespace-only, returns the fresh
 * template. Otherwise removes any prior `raven.linting.*` keys and
 * inserts a freshly formatted block immediately before the outermost
 * closing brace, preserving all unrelated keys and comments.
 */
export function buildLintingSettingsContent(existing: string | undefined): string {
    if (existing === undefined || existing.trim().length === 0) {
        return LINTING_SETTINGS_TEMPLATE;
    }
    const withoutLinting = stripExistingLintingLines(existing);
    const closeIdx = findOutermostClosingBrace(withoutLinting);
    if (closeIdx === -1) {
        return LINTING_SETTINGS_TEMPLATE;
    }

    const before = withoutLinting.slice(0, closeIdx);
    const after = withoutLinting.slice(closeIdx);
    const trimmedBefore = before.replace(/[ \t\n\r]+$/, '');

    const openBraceIdx = trimmedBefore.lastIndexOf('{');
    const hasExistingProps =
        openBraceIdx !== -1 && trimmedBefore.slice(openBraceIdx + 1).trim().length > 0;
    const endsWithComma = trimmedBefore.endsWith(',');

    let prefix: string;
    if (!hasExistingProps) {
        prefix = trimmedBefore + '\n';
    } else if (endsWithComma) {
        prefix = trimmedBefore + '\n';
    } else {
        prefix = trimmedBefore + ',\n';
    }

    const block = formatLintingBlock('  ', '');
    return `${prefix}${block}\n${after}`;
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
        const existingKeys = detectExistingLintingKeys(existing);
        if (existingKeys === null) {
            void vscode.window.showErrorMessage(
                `Raven: ${displayName} has JSON parse errors; fix them and re-run this command.`,
            );
            return undefined;
        }
        if (existingKeys.length > 0) {
            const label =
                existingKeys.length === 1
                    ? '1 raven.linting.* setting'
                    : `${existingKeys.length} raven.linting.* settings`;
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
