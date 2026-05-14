/**
 * Code-chunk detection for R Markdown / Quarto fenced blocks and `.R` cell markers.
 *
 * Pure functions (no VS Code dependency) — unit-testable from `tests/bun/`.
 *
 * Chunk forms supported:
 *   - Rmd/Qmd fenced block: ```` ```{r ...} ```` … ```` ``` ```` (backticks or tildes,
 *     fence must start at column 0; closing fence must use the same character and be
 *     at least as long as the opener).
 *   - `.R` cell marker: a line matching `/^#+\s*%%/` starts a new cell that extends
 *     until the next marker or end-of-file.
 *
 * The `language` field is normalized to lower case. For `.R` cells it is always `'r'`.
 */

export type ChunkKind = 'rmd' | 'r';
export type DocumentKind = ChunkKind;

export interface Chunk {
    /** 0-based line index of the chunk header (fence or `# %%` line). */
    header_line: number;
    /**
     * 0-based line index of the last content line (inclusive).
     * For an Rmd chunk, this is one line above `closing_fence_line` when the fence
     * is present, or the last line of the file when unclosed.
     * For a `.R` cell, this is the line above the next cell marker (or EOF).
     */
    end_line: number;
    /**
     * 0-based line index of the closing fence (Rmd only). `null` for `.R` cells and
     * for unclosed Rmd chunks that run off the end of the file.
     */
    closing_fence_line: number | null;
    /** Language tag from the chunk header, lower-cased. `.R` cells are always `'r'`. */
    language: string;
    /** Optional first identifier in the header (e.g. `setup` in `{r setup, eval=FALSE}`). */
    label: string | null;
    /** Parsed `key=value` options from the header (unquoted, trimmed). */
    options: Record<string, string>;
    /** True when `eval = FALSE` (or `F`) is present in the header options. */
    is_eval_false: boolean;
    /** Marker for which detection path produced this chunk. */
    kind: ChunkKind;
}

const FENCE_HEADER_RE = /^(`{3,}|~{3,})\s*\{([A-Za-z0-9_+.\-]+)([^}]*)\}\s*$/;
const FENCE_CLOSE_RE = /^(`{3,}|~{3,})\s*$/;
// Cell marker: a comment line that starts with `# %%` (any number of leading `#`),
// followed by end-of-line or whitespace. This avoids matching `# %%%` (three or
// more `%`) or `# %%inline-text` which are not cell delimiters in VS Code's
// interactive-cell convention.
const CELL_MARKER_RE = /^#+\s*%%(?!%)(?:\s.*)?$/;

/**
 * Classify a document path (or URI string) by file extension.
 * Falls back to `'r'` so behavior in unknown contexts is predictable.
 */
export function classify_chunk_document(file_name_or_uri: string): DocumentKind {
    const lower = file_name_or_uri.toLowerCase();
    if (lower.endsWith('.rmd') || lower.endsWith('.qmd')) return 'rmd';
    return 'r';
}

/**
 * Classify a document by inspecting both its languageId and its URI. Used at
 * the VS Code adapter layer (commands, CodeLens, decorations) where we have
 * a full `TextDocument`. Checks languageId first so untitled buffers — which
 * have no file extension to inspect — classify correctly under our `rmd` /
 * `quarto` language IDs, then falls back to the extension-based check as a
 * safety net for environments where another extension has claimed the
 * languageId for `.Rmd` / `.qmd` files.
 */
export function classify_chunk_document_for_document(
    document: { languageId: string; uri: { fsPath: string; path: string } },
): DocumentKind {
    const lang = document.languageId.toLowerCase();
    if (lang === 'rmd' || lang === 'quarto') return 'rmd';
    return classify_chunk_document(document.uri.fsPath || document.uri.path);
}

/**
 * Cheap substring screen for "does this document contain any chunk anchors?".
 * Lets callers skip the per-line detector loop on plain `.R` files that never
 * use cell markers and on prose-only `.Rmd` documents.
 *
 * The screen is intentionally coarse: returning `true` only guarantees that an
 * anchor character sequence is present somewhere in the text, not that any
 * valid chunk will actually be detected. Use the result as a fast-path gate,
 * not as authoritative chunk presence.
 */
export function has_chunk_anchor(text: string, kind: DocumentKind): boolean {
    if (kind === 'r') return text.includes('%%');
    return text.includes('```') || text.includes('~~~');
}

/**
 * Parse the body of a chunk header (everything between `{` and `}`, excluding the
 * leading language tag). Returns the optional label (first bare identifier) and a
 * map of `key=value` options. Values are returned unquoted and trimmed.
 */
function parse_header_options(rest: string): { label: string | null; options: Record<string, string> } {
    const options: Record<string, string> = {};
    let label: string | null = null;
    const trimmed = rest.trim();
    if (trimmed.length === 0) return { label, options };

    // Split on commas while keeping nested parens/brackets/braces and quoted
    // strings intact, so values like `fig.dim=c(5, 6)` or `lab="a,b"` survive.
    // Backslash-escaped quotes inside a quoted span are respected.
    const parts: string[] = [];
    let current = '';
    let in_quote: '"' | "'" | null = null;
    let depth = 0;
    for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (in_quote) {
            current += ch;
            if (ch === '\\' && i + 1 < trimmed.length) {
                current += trimmed[i + 1];
                i++;
                continue;
            }
            if (ch === in_quote) in_quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            in_quote = ch;
            current += ch;
            continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') {
            depth++;
            current += ch;
            continue;
        }
        if (ch === ')' || ch === ']' || ch === '}') {
            if (depth > 0) depth--;
            current += ch;
            continue;
        }
        if (ch === ',' && depth === 0) {
            parts.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.length > 0) parts.push(current);

    for (const raw of parts) {
        const part = raw.trim();
        if (part.length === 0) continue;
        const eq = part.indexOf('=');
        if (eq === -1) {
            // Bare token: the first one is the label.
            if (label === null) {
                label = part;
            }
            continue;
        }
        const key = part.slice(0, eq).trim();
        let value = part.slice(eq + 1).trim();
        // Strip surrounding quotes for convenience.
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key.length > 0) options[key] = value;
    }

    return { label, options };
}

function eval_false_from_options(options: Record<string, string>): boolean {
    const raw = options.eval;
    if (raw === undefined) return false;
    const v = raw.trim().toUpperCase();
    return v === 'F' || v === 'FALSE';
}

/**
 * Detect all chunks in the document, in source order.
 * `kind` controls which form to look for (caller decides via `classify_chunk_document`).
 */
export function detect_chunks(lines: string[], kind: DocumentKind): Chunk[] {
    return kind === 'rmd' ? detect_rmd_chunks(lines) : detect_r_cells(lines);
}

function detect_rmd_chunks(lines: string[]): Chunk[] {
    const chunks: Chunk[] = [];
    let i = 0;
    while (i < lines.length) {
        const header_match = FENCE_HEADER_RE.exec(lines[i]);
        if (!header_match) {
            i++;
            continue;
        }
        const fence = header_match[1];
        const lang = header_match[2].toLowerCase();
        const { label, options } = parse_header_options(header_match[3] ?? '');

        // Find a matching closing fence (same char, at least as long).
        const fence_char = fence[0];
        const min_len = fence.length;
        let closing_line: number | null = null;
        for (let j = i + 1; j < lines.length; j++) {
            const close_match = FENCE_CLOSE_RE.exec(lines[j]);
            if (close_match && close_match[1][0] === fence_char && close_match[1].length >= min_len) {
                closing_line = j;
                break;
            }
        }
        const end_line = closing_line !== null ? closing_line - 1 : lines.length - 1;
        chunks.push({
            header_line: i,
            end_line: Math.max(end_line, i),
            closing_fence_line: closing_line,
            language: lang,
            label,
            options,
            is_eval_false: eval_false_from_options(options),
            kind: 'rmd',
        });
        i = closing_line !== null ? closing_line + 1 : lines.length;
    }
    return chunks;
}

function detect_r_cells(lines: string[]): Chunk[] {
    const chunks: Chunk[] = [];
    const marker_lines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (CELL_MARKER_RE.test(lines[i])) marker_lines.push(i);
    }
    for (let m = 0; m < marker_lines.length; m++) {
        const header_line = marker_lines[m];
        const next_marker = m + 1 < marker_lines.length ? marker_lines[m + 1] : lines.length;
        const end_line = Math.max(next_marker - 1, header_line);
        chunks.push({
            header_line,
            end_line,
            closing_fence_line: null,
            language: 'r',
            label: null,
            options: {},
            is_eval_false: false,
            kind: 'r',
        });
    }
    return chunks;
}

/**
 * Find the chunk that contains a given 0-based line index, or `null` if the line
 * is outside any chunk. The header line and (for Rmd) the closing fence line are
 * considered "inside" the chunk.
 */
export function find_chunk_at_line(chunks: Chunk[], line: number): Chunk | null {
    for (const c of chunks) {
        const last = c.closing_fence_line ?? c.end_line;
        if (line >= c.header_line && line <= last) return c;
    }
    return null;
}

/**
 * Return chunks whose last line is strictly above the cursor line. When the cursor
 * sits inside a chunk, that chunk is NOT included in the result.
 */
export function chunks_above(chunks: Chunk[], line: number): Chunk[] {
    const out: Chunk[] = [];
    for (const c of chunks) {
        const last = c.closing_fence_line ?? c.end_line;
        if (last < line) out.push(c);
    }
    return out;
}

/**
 * Return the executable code inside the chunk, joined with `\n`.
 * Excludes the header/fence lines.
 */
export function extract_chunk_code(lines: string[], chunk: Chunk): string {
    const start = chunk.header_line + 1;
    const end = chunk.end_line;
    if (start > end) return '';
    return lines.slice(start, end + 1).join('\n');
}

/**
 * Whether the chunk's language is something Raven can run in R (i.e. R itself).
 * Non-R language tags (python, julia, bash, …) are recognized for navigation/outline
 * purposes but not sent to the R terminal.
 */
export function is_runnable_chunk(chunk: Chunk): boolean {
    return chunk.language === 'r';
}
