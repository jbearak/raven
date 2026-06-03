//! Code-chunk detection for R Markdown / Quarto fenced blocks and `.R` cell markers.
//!
//! Rust port of `editors/vscode/src/chunks/chunk-detector.ts`. Detection is
//! text-based (no tree-sitter), so it works on documents whose body would
//! otherwise be opaque to the R parser (prose, YAML, fenced non-R code).
//!
//! Used by `SymbolExtractor::extract_chunks` to surface chunk entries in the
//! document outline. Kept aligned with the TypeScript detector so the two
//! continue to produce the same `header_line` / `end_line` for any document.

use regex::Regex;
use std::sync::OnceLock;

/// Which detection path to use when scanning a document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChunkKind {
    /// Rmd/Qmd fenced block (` ```{r ...} ` … ` ``` `).
    Rmd,
    /// `.R` cell marker (`# %%`).
    R,
}

/// A detected chunk.
#[derive(Debug, Clone)]
pub struct Chunk {
    /// 0-based line index of the chunk header (fence or `# %%` line).
    pub header_line: u32,
    /// 0-based line index of the last content line (inclusive). For an Rmd
    /// chunk this is one line above `closing_fence_line` when the fence is
    /// present, or the last line of the file when unclosed.
    pub end_line: u32,
    /// 0-based line index of the closing fence (Rmd only). `None` for `.R`
    /// cells and for unclosed Rmd chunks that run off the end of the file.
    pub closing_fence_line: Option<u32>,
    /// Language tag from the chunk header, lower-cased. `.R` cells are always
    /// `"r"`.
    pub language: String,
    /// First bare identifier in the header (e.g. `setup` in
    /// `{r setup, eval=FALSE}`), or — for `# %%` cells — the text after the
    /// marker. `None` when no label is present.
    pub label: Option<String>,
}

fn fence_header_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^(`{3,}|~{3,})\s*\{([A-Za-z0-9_+.\-]+)([^}]*)\}\s*$")
            .expect("fence header regex")
    })
}

fn fence_close_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(`{3,}|~{3,})\s*$").expect("fence close regex"))
}

fn cell_marker_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // `# %%` (any number of leading `#`), followed by EOL or whitespace.
    // Excludes `# %%%` (3+ `%`) and `# %%inline-text`.
    RE.get_or_init(|| Regex::new(r"^#+\s*%%(?:[^%\S\r\n].*|\s*)?$").expect("cell marker regex"))
}

fn section_divider_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // RStudio-style section divider: `# Title ====`, `# Setup ----`, etc.
    // Acts as a cell-END boundary when mixed with `# %%` cells.
    // Excludes roxygen `#'` lines.
    RE.get_or_init(|| {
        // `[^']` (mandatory, not `[^']?`) — without it, the character class
        // could match zero chars and a roxygen line like `#' Title ----`
        // would be misread as a divider.
        Regex::new(r"^#+[^'].*[-#+=*]{4,}\s*$").expect("section divider regex")
    })
}

/// Classify a document path (URI or file path) by extension. Falls back to
/// [`ChunkKind::R`] for unknown extensions so behavior is predictable.
pub fn classify_chunk_document(path_or_uri: &str) -> ChunkKind {
    let lower = path_or_uri.to_ascii_lowercase();
    if lower.ends_with(".rmd") || lower.ends_with(".qmd") {
        ChunkKind::Rmd
    } else {
        ChunkKind::R
    }
}

/// Classify a document using its `languageId` first, then its URI path.
///
/// Matches the client-side `classify_chunk_document_for_document` helper in
/// `editors/vscode/src/chunks/chunk-detector.ts` so untitled buffers — which
/// have no file extension — still classify correctly when the editor passes
/// `languageId: "rmd" | "quarto"`.
pub fn classify_chunk_document_for(language_id: Option<&str>, path_or_uri: &str) -> ChunkKind {
    if let Some(lang) = language_id {
        match lang.to_ascii_lowercase().as_str() {
            "rmd" | "quarto" => return ChunkKind::Rmd,
            "r" => return classify_chunk_document(path_or_uri),
            _ => {}
        }
    }
    classify_chunk_document(path_or_uri)
}

/// Detect all chunks in the document, in source order. `kind` controls which
/// detection path runs.
pub fn detect_chunks(text: &str, kind: ChunkKind) -> Vec<Chunk> {
    // BOM-tolerant split: both paths anchor their fence/cell/divider regexes at
    // column 0 (see `lines_for_column0_scan`). Chunks report only line numbers. #346.
    let lines = crate::utf16::lines_for_column0_scan(text);
    match kind {
        ChunkKind::Rmd => detect_rmd_chunks(&lines),
        ChunkKind::R => detect_r_cells(&lines),
    }
}

fn detect_rmd_chunks(lines: &[&str]) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let header_re = fence_header_re();
    let close_re = fence_close_re();

    let mut i = 0usize;
    while i < lines.len() {
        let line = lines[i];
        let Some(caps) = header_re.captures(line) else {
            i += 1;
            continue;
        };

        let fence = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let lang = caps
            .get(2)
            .map(|m| m.as_str().to_ascii_lowercase())
            .unwrap_or_default();
        let header_rest = caps.get(3).map(|m| m.as_str()).unwrap_or("");
        let label = parse_header_label(header_rest);

        let fence_char = fence.chars().next().unwrap_or('`');
        let min_len = fence.len();
        let mut closing_line: Option<u32> = None;
        for (j, &line) in lines.iter().enumerate().skip(i + 1) {
            if let Some(close_caps) = close_re.captures(line) {
                let close = close_caps.get(1).map(|m| m.as_str()).unwrap_or("");
                if close.starts_with(fence_char) && close.len() >= min_len {
                    closing_line = Some(j as u32);
                    break;
                }
            }
        }

        let header_line = i as u32;
        let end_line = match closing_line {
            Some(close) if close > 0 => close - 1,
            Some(_) => header_line,
            None => (lines.len().saturating_sub(1)) as u32,
        };
        let end_line = end_line.max(header_line);

        chunks.push(Chunk {
            header_line,
            end_line,
            closing_fence_line: closing_line,
            language: lang,
            label,
        });

        i = match closing_line {
            Some(close) => (close as usize) + 1,
            None => lines.len(),
        };
    }
    chunks
}

fn detect_r_cells(lines: &[&str]) -> Vec<Chunk> {
    let marker_re = cell_marker_re();
    let divider_re = section_divider_re();

    // Pass 1: enumerate cell markers and section dividers.
    let mut markers: Vec<usize> = Vec::new();
    let mut dividers: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for (idx, line) in lines.iter().enumerate() {
        if marker_re.is_match(line) {
            markers.push(idx);
        } else if divider_re.is_match(line) {
            dividers.insert(idx);
        }
    }

    // Pass 2: each marker is a cell that runs until the next marker, the next
    // section divider, or EOF — whichever comes first.
    let mut chunks = Vec::with_capacity(markers.len());
    for (m, &header) in markers.iter().enumerate() {
        let next_marker = markers.get(m + 1).copied().unwrap_or(lines.len());
        let mut end_line = next_marker.saturating_sub(1);
        for i in (header + 1)..next_marker {
            if dividers.contains(&i) {
                end_line = i;
                break;
            }
        }
        let header_line = header as u32;
        let end_line = (end_line as u32).max(header_line);
        chunks.push(Chunk {
            header_line,
            end_line,
            closing_fence_line: None,
            language: "r".to_string(),
            label: cell_label(lines[header]),
        });
    }
    chunks
}

/// Extract the human-readable label from a `# %%` cell marker line.
/// Returns `None` when the marker has no trailing text.
fn cell_label(line: &str) -> Option<String> {
    // Trim leading `#`s and whitespace, drop the `%%` token, then return the
    // remainder (trimmed) as the label. Returns None when nothing remains.
    let mut rest = line.trim_start();
    while rest.starts_with('#') {
        rest = &rest[1..];
    }
    let rest = rest.trim_start();
    let rest = rest.strip_prefix("%%").unwrap_or(rest);
    let label = rest.trim().trim_end_matches(|c: char| {
        // Strip trailing decorative `-#+=*` runs (e.g. `# %% Setup ----`).
        matches!(c, '-' | '#' | '+' | '=' | '*' | ' ' | '\t')
    });
    let label = label.trim();
    if label.is_empty() {
        None
    } else {
        Some(label.to_string())
    }
}

/// Parse the body of a chunk header (everything between `{lang` and `}`) and
/// return the optional label (first bare identifier).
///
/// Comma splitting respects nested brackets and quoted strings so that values
/// like `fig.dim=c(5, 6)` or `lab="a,b"` don't trip the parser.
fn parse_header_label(rest: &str) -> Option<String> {
    let trimmed = rest.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Split on commas while keeping nested brackets and quoted strings intact.
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_quote: Option<char> = None;
    let mut depth = 0i32;

    let chars: Vec<char> = trimmed.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if let Some(q) = in_quote {
            current.push(ch);
            if ch == '\\' && i + 1 < chars.len() {
                current.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if ch == q {
                in_quote = None;
            }
            i += 1;
            continue;
        }
        match ch {
            '"' | '\'' => {
                in_quote = Some(ch);
                current.push(ch);
            }
            '(' | '[' | '{' => {
                depth += 1;
                current.push(ch);
            }
            ')' | ']' | '}' => {
                if depth > 0 {
                    depth -= 1;
                }
                current.push(ch);
            }
            ',' if depth == 0 => {
                parts.push(std::mem::take(&mut current));
            }
            _ => current.push(ch),
        }
        i += 1;
    }
    if !current.is_empty() {
        parts.push(current);
    }

    for raw in parts {
        let part = raw.trim();
        if part.is_empty() {
            continue;
        }
        if part.contains('=') {
            // key=value option, not the label.
            continue;
        }
        return Some(part.to_string());
    }
    None
}

/// True for chunk language tags that should be parsed as R. Pandoc/knitr
/// permit a few aliases (`r`, `R`, plus the rare `Rscript`). The chunk
/// detector lower-cases the tag before storing it, so a simple ASCII compare
/// is sufficient here.
pub(crate) fn is_r_chunk_language(language: &str) -> bool {
    matches!(language, "r" | "rscript")
}

/// A compiled regex for the knitr chunk-reuse reference pattern `<<label>>`.
///
/// Lines matching `^\s*<<[^>]+>>\s*$` (optionally with a trailing `\r`) are
/// knitr meta-syntax, not R code, and must be blanked by [`mask_to_r`].
fn chunk_reuse_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s*<<[^>]+>>\s*\r?$").expect("chunk reuse reference regex"))
}

/// Produce R-parseable text from an R Markdown / Quarto document with
/// **identical line/column geometry** to the source.
///
/// ## Contract
///
/// * The input is split on `\n` (NOT `.lines()`, which strips `\r` and loses
///   information about trailing newlines). Any `\r` that precedes `\n` stays
///   attached to its segment.
/// * [`detect_chunks`] with [`ChunkKind::Rmd`] locates R chunk bodies. A
///   chunk is R when [`is_r_chunk_language`] returns `true` for its language
///   tag. Body lines are `(chunk.header_line + 1)..=chunk.end_line`, clamped
///   the same way as `semantic_tokens_for_rmd_document`:
///   - skip when `body_start > end_line` (empty chunk) or
///     `body_start >= total_lines` (header at EOF);
///   - clamp `end_line` to `total_lines - 1`.
/// * Each line is emitted **verbatim** (byte-identical, including any trailing
///   `\r`) when it falls inside an R chunk body; otherwise it is replaced by
///   an **empty string `""`**.
/// * Exception inside R bodies: a line matching the knitr chunk-reuse pattern
///   `^\s*<<[^>]+>>\s*$` (optionally with `\r`) is also blanked — it is
///   knitr meta-syntax, not R.
/// * Header fence lines, closing fence lines, prose, YAML front matter, and
///   non-R chunk bodies (Python, Bash, etc.) all become `""`.
/// * Segments are rejoined with `\n`. The result has exactly the same number
///   of `\n`-separated segments as the input (trailing-newline presence is
///   preserved automatically).
/// * A leading BOM (U+FEFF) lives on line 0, which is never an R body line,
///   so it is blanked — that is intentional and harmless for downstream R
///   parsing.
///
/// Net effect: identical line count; within kept R-body lines, identical
/// byte/column geometry. Downstream tools that parse the masked text obtain
/// positions they can use directly as document coordinates.
pub fn mask_to_r(text: &str) -> String {
    let segments: Vec<&str> = text.split('\n').collect();
    let total_lines = segments.len();

    // Build a boolean mask: true = keep this line verbatim.
    let mut keep = vec![false; total_lines];

    let reuse_re = chunk_reuse_re();
    let chunks = detect_chunks(text, ChunkKind::Rmd);

    for chunk in &chunks {
        if !is_r_chunk_language(&chunk.language) {
            continue;
        }
        let body_start = chunk.header_line.saturating_add(1);
        // Mirror bounds logic from `semantic_tokens_for_rmd_document`.
        if body_start > chunk.end_line {
            continue;
        }
        if body_start >= total_lines as u32 {
            continue;
        }
        let end_line = chunk.end_line.min((total_lines as u32).saturating_sub(1));

        for idx in body_start as usize..=end_line as usize {
            // Blank knitr chunk-reuse references; keep everything else.
            if !reuse_re.is_match(segments[idx]) {
                keep[idx] = true;
            }
        }
    }

    let masked: Vec<&str> = segments
        .iter()
        .enumerate()
        .map(|(i, &seg)| if keep[i] { seg } else { "" })
        .collect();

    masked.join("\n")
}

/// Returns `true` iff `line` (0-based) falls within the body of an R chunk
/// in the given (raw) R Markdown / Quarto text.
///
/// "Body" means the lines strictly after the header fence and before (or at)
/// `end_line` — same bounds as [`mask_to_r`]. Header lines, closing fence
/// lines, prose, YAML front matter, and non-R chunk bodies all return `false`.
/// A `line` beyond the end of the document returns `false`.
pub fn position_in_r_chunk_body(text: &str, line: u32) -> bool {
    let total_lines = text.split('\n').count();
    let chunks = detect_chunks(text, ChunkKind::Rmd);

    for chunk in &chunks {
        if !is_r_chunk_language(&chunk.language) {
            continue;
        }
        let body_start = chunk.header_line.saturating_add(1);
        if body_start > chunk.end_line {
            continue;
        }
        if body_start >= total_lines as u32 {
            continue;
        }
        let end_line = chunk.end_line.min((total_lines as u32).saturating_sub(1));
        if line >= body_start && line <= end_line {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detect(text: &str, kind: ChunkKind) -> Vec<Chunk> {
        detect_chunks(text, kind)
    }

    #[test]
    fn classifies_rmd_qmd_extensions() {
        assert_eq!(classify_chunk_document("/tmp/foo.Rmd"), ChunkKind::Rmd);
        assert_eq!(classify_chunk_document("/tmp/foo.qmd"), ChunkKind::Rmd);
        assert_eq!(classify_chunk_document("/tmp/foo.QMD"), ChunkKind::Rmd);
        assert_eq!(classify_chunk_document("/tmp/foo.R"), ChunkKind::R);
        assert_eq!(classify_chunk_document("/tmp/foo.r"), ChunkKind::R);
        assert_eq!(classify_chunk_document("/tmp/foo.txt"), ChunkKind::R);
    }

    #[test]
    fn classifies_untitled_buffers_by_language_id() {
        // Untitled buffers have no extension, so `languageId` is the only
        // signal we have for distinguishing Rmd/Quarto from plain R.
        assert_eq!(
            classify_chunk_document_for(Some("rmd"), "untitled:Untitled-1"),
            ChunkKind::Rmd
        );
        assert_eq!(
            classify_chunk_document_for(Some("quarto"), "untitled:Untitled-1"),
            ChunkKind::Rmd
        );
        assert_eq!(
            classify_chunk_document_for(Some("RMD"), "untitled:Untitled-1"),
            ChunkKind::Rmd
        );
        assert_eq!(
            classify_chunk_document_for(Some("r"), "untitled:Untitled-1"),
            ChunkKind::R
        );
        assert_eq!(
            classify_chunk_document_for(None, "/tmp/foo.Rmd"),
            ChunkKind::Rmd
        );
        // languageId='r' on a .Rmd URI: trust the URI (matches the TS detector).
        assert_eq!(
            classify_chunk_document_for(Some("r"), "/tmp/foo.Rmd"),
            ChunkKind::Rmd
        );
    }

    #[test]
    fn detects_a_single_r_chunk() {
        let src = "Some prose.\n\n```{r}\nx <- 1\nprint(x)\n```\n\nMore prose.";
        let chunks = detect(src, ChunkKind::Rmd);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].header_line, 2);
        assert_eq!(chunks[0].closing_fence_line, Some(5));
        assert_eq!(chunks[0].end_line, 4);
        assert_eq!(chunks[0].language, "r");
    }

    // Issue #346: the fence-header and cell-marker regexes anchor at column 0
    // (`^`). A raw leading U+FEFF on the first line of in-memory text (open
    // documents keep the BOM verbatim) would otherwise defeat the `^` anchor and
    // hide a first-line chunk/cell.
    #[test]
    fn detects_first_line_fence_header_after_bom() {
        let src = "\u{FEFF}```{r}\nx <- 1\n```\n";
        let chunks = detect(src, ChunkKind::Rmd);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].header_line, 0);
        assert_eq!(chunks[0].language, "r");
    }

    #[test]
    fn detects_first_line_cell_marker_after_bom() {
        let src = "\u{FEFF}# %% setup\nx <- 1\n";
        let chunks = detect(src, ChunkKind::R);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].header_line, 0);
        assert_eq!(chunks[0].label.as_deref(), Some("setup"));
    }

    #[test]
    fn parses_label_from_header() {
        let src = "```{r setup, eval=FALSE, fig.width=4}\nx <- 1\n```";
        let chunks = detect(src, ChunkKind::Rmd);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].label.as_deref(), Some("setup"));
    }

    #[test]
    fn skips_options_when_picking_label() {
        // First option is key=value, so the label is None (no bare token).
        let src = "```{r, eval=FALSE}\n1\n```";
        let chunks = detect(src, ChunkKind::Rmd);
        assert_eq!(chunks[0].label, None);
    }

    #[test]
    fn handles_unclosed_chunk_at_eof() {
        let src = "```{r}\nx <- 1\nprint(x)";
        let chunks = detect(src, ChunkKind::Rmd);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].header_line, 0);
        assert_eq!(chunks[0].closing_fence_line, None);
        assert_eq!(chunks[0].end_line, 2);
    }

    #[test]
    fn tracks_non_r_language_tag() {
        let src = "```{python}\nprint('hi')\n```\n\n```{julia}\n1+1\n```";
        let chunks = detect(src, ChunkKind::Rmd);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].language, "python");
        assert_eq!(chunks[1].language, "julia");
    }

    #[test]
    fn tilde_fences_work() {
        let src = "~~~{r}\nx <- 1\n~~~";
        let chunks = detect(src, ChunkKind::Rmd);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].closing_fence_line, Some(2));
    }

    #[test]
    fn fence_close_requires_same_char_and_min_length() {
        // 4-backtick opener; 3-backtick close should not match.
        let src = "````{r}\nx <- 1\n```\n````";
        let chunks = detect(src, ChunkKind::Rmd);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].closing_fence_line, Some(3));
    }

    #[test]
    fn detects_r_cells_basic() {
        let src = "# %% Setup\nlibrary(dplyr)\n\n# %% Analysis\nx <- 1";
        let chunks = detect(src, ChunkKind::R);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].header_line, 0);
        assert_eq!(chunks[0].end_line, 2);
        assert_eq!(chunks[0].label.as_deref(), Some("Setup"));
        assert_eq!(chunks[1].header_line, 3);
        assert_eq!(chunks[1].end_line, 4);
        assert_eq!(chunks[1].label.as_deref(), Some("Analysis"));
    }

    #[test]
    fn empty_cell_marker_has_no_label() {
        let src = "# %%\nx <- 1";
        let chunks = detect(src, ChunkKind::R);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].label, None);
    }

    #[test]
    fn roxygen_line_does_not_end_cell() {
        // A `#' @param x A value -----` line inside a cell must NOT be
        // mistaken for a section divider — the divider regex must require a
        // non-quote character right after the leading hashes.
        let src = "# %% Setup\n#' @param x A value -----\nlibrary(x)\n# %% Next\ny <- 2";
        let chunks = detect(src, ChunkKind::R);
        assert_eq!(chunks.len(), 2);
        // First cell should extend through line 2 (`library(x)`), not be
        // truncated at the roxygen line.
        assert_eq!(chunks[0].end_line, 2);
    }

    #[test]
    fn section_divider_ends_cell() {
        let src = "# %% Setup\nlibrary(x)\n# Header ----\nx <- 1\n# %% Next\ny <- 2";
        let chunks = detect(src, ChunkKind::R);
        assert_eq!(chunks.len(), 2);
        // The divider line itself is the last line of the first cell.
        assert_eq!(chunks[0].end_line, 2);
    }

    #[test]
    fn cell_marker_with_trailing_decoration_keeps_label() {
        let src = "# %% Setup ----\nx <- 1";
        let chunks = detect(src, ChunkKind::R);
        assert_eq!(chunks[0].label.as_deref(), Some("Setup"));
    }

    #[test]
    fn parenthesised_option_values_survive() {
        let src = "```{r, fig.dim=c(5, 6), out.width=\"80%\"}\n1\n```";
        let chunks = detect(src, ChunkKind::Rmd);
        // We don't store options, but the header must still parse cleanly
        // and produce one chunk without confusing the comma split.
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].language, "r");
    }

    // =========================================================================
    // mask_to_r tests
    // =========================================================================

    /// Helper: count of '\n'-separated segments (mirrors split('\n').count()).
    fn seg_count(s: &str) -> usize {
        s.split('\n').count()
    }

    #[test]
    fn mask_preserves_line_count() {
        let cases: &[&str] = &[
            // no trailing newline
            "---\ntitle: T\n---\n\n```{r}\nx <- 1\n```\n\nMore prose.",
            // trailing newline
            "---\ntitle: T\n---\n\n```{r}\nx <- 1\n```\n\nMore prose.\n",
            // empty string
            "",
            // single line, no newline
            "just prose",
            // single newline
            "\n",
            // empty chunk
            "```{r}\n```\n",
            // unclosed chunk at EOF
            "```{r}\nx <- 1",
        ];
        for &t in cases {
            let masked = mask_to_r(t);
            assert_eq!(
                seg_count(&masked),
                seg_count(t),
                "line count mismatch for input {t:?}"
            );
        }
    }

    #[test]
    fn mask_keeps_r_body_byte_identical() {
        // Body line has leading and trailing spaces — must survive verbatim.
        let src = "```{r}\n  x <- f(1)  \n```\n";
        let masked = mask_to_r(src);
        let lines: Vec<&str> = masked.split('\n').collect();
        // Line 0 = header  → ""
        // Line 1 = body    → "  x <- f(1)  " (verbatim)
        // Line 2 = close   → ""
        // Line 3 = trailing → ""
        assert_eq!(lines[1], "  x <- f(1)  ");
    }

    #[test]
    fn mask_blanks_prose_yaml_and_fences() {
        let src = "---\ntitle: Test\n---\n\n```{r}\nx <- 1\n```\n\nProse.";
        let masked = mask_to_r(src);
        let lines: Vec<&str> = masked.split('\n').collect();
        // Line 0 = "---"          → ""
        // Line 1 = "title: Test"  → ""
        // Line 2 = "---"          → ""
        // Line 3 = ""  (blank prose line) → ""
        // Line 4 = "```{r}"       → "" (header fence)
        // Line 5 = "x <- 1"       → "x <- 1" (R body)
        // Line 6 = "```"          → "" (closing fence)
        // Line 7 = ""  (blank)    → ""
        // Line 8 = "Prose."       → ""
        assert_eq!(lines[0], "");
        assert_eq!(lines[1], "");
        assert_eq!(lines[2], "");
        assert_eq!(lines[3], "");
        assert_eq!(lines[4], "");
        assert_eq!(lines[5], "x <- 1");
        assert_eq!(lines[6], "");
        assert_eq!(lines[7], "");
        assert_eq!(lines[8], "");
    }

    #[test]
    fn mask_blanks_non_r_chunks() {
        let src = "```{python}\nprint('hi')\n```\n\n```{r}\ny <- 2\n```\n";
        let masked = mask_to_r(src);
        let lines: Vec<&str> = masked.split('\n').collect();
        // python body (line 1) → ""
        assert_eq!(lines[1], "");
        // R body (line 5) → "y <- 2"
        assert_eq!(lines[5], "y <- 2");
    }

    #[test]
    fn mask_crlf_preserves_cr_in_body() {
        // CRLF document: each raw line ends with '\r'.
        let src = "prose\r\n```{r}\r\nx <- 1\r\n```\r\n";
        let masked = mask_to_r(src);
        let lines: Vec<&str> = masked.split('\n').collect();
        // Line count unchanged.
        assert_eq!(seg_count(&masked), seg_count(src));
        // Line 0 = "prose\r"   → "" (prose)
        assert_eq!(lines[0], "");
        // Line 1 = "```{r}\r"  → "" (header)
        assert_eq!(lines[1], "");
        // Line 2 = "x <- 1\r"  → "x <- 1\r" (body, \r preserved)
        assert_eq!(lines[2], "x <- 1\r");
        // Line 3 = "```\r"     → "" (closing fence)
        assert_eq!(lines[3], "");
        // Line 4 = "" (trailing after final \n)
        assert_eq!(lines[4], "");
        // Blanked lines are "" not "\r".
        for (i, &l) in lines.iter().enumerate() {
            if i != 2 {
                assert!(!l.contains('\r'), "blanked line {i} must not contain \\r");
            }
        }
    }

    #[test]
    fn mask_bom_first_line() {
        // BOM on line 0; chunk starts on line 1.
        let src = "\u{FEFF}\n```{r}\nx <- 1\n```\n";
        let masked = mask_to_r(src);
        let lines: Vec<&str> = masked.split('\n').collect();
        // No panic; geometry intact.
        assert_eq!(seg_count(&masked), seg_count(src));
        // Line 0 contains BOM → blanked.
        assert_eq!(lines[0], "");
        // Line 2 = R body → "x <- 1"
        assert_eq!(lines[2], "x <- 1");
    }

    #[test]
    fn mask_tilde_fences() {
        let src = "~~~{r}\nx <- 1\n~~~\n";
        let masked = mask_to_r(src);
        let lines: Vec<&str> = masked.split('\n').collect();
        assert_eq!(lines[0], ""); // header
        assert_eq!(lines[1], "x <- 1"); // body
        assert_eq!(lines[2], ""); // closing
    }

    #[test]
    fn mask_nested_fences() {
        // 4-backtick opener; inner ``` is body content, not a closer.
        let src = "````{r}\nx <- 1\n```\ny <- 2\n````\n";
        let masked = mask_to_r(src);
        let lines: Vec<&str> = masked.split('\n').collect();
        // detect_chunks handles the nesting: closer is at line 4.
        assert_eq!(lines[0], ""); // header (````{r})
        assert_eq!(lines[1], "x <- 1"); // body
        assert_eq!(lines[2], "```"); // inner ``` preserved as body
        assert_eq!(lines[3], "y <- 2"); // body
        assert_eq!(lines[4], ""); // closing (````)
    }

    #[test]
    fn mask_unclosed_chunk_at_eof() {
        // No closing fence: body runs to EOF.
        let src = "```{r}\nx <- 1\nprint(x)";
        let masked = mask_to_r(src);
        let lines: Vec<&str> = masked.split('\n').collect();
        assert_eq!(seg_count(&masked), seg_count(src));
        assert_eq!(lines[0], ""); // header
        assert_eq!(lines[1], "x <- 1"); // body
        assert_eq!(lines[2], "print(x)"); // body at EOF
    }

    #[test]
    fn mask_empty_chunk() {
        // Header immediately followed by closing fence — no body lines.
        let src = "```{r}\n```\n";
        let masked = mask_to_r(src);
        let lines: Vec<&str> = masked.split('\n').collect();
        assert_eq!(seg_count(&masked), seg_count(src));
        assert_eq!(lines[0], ""); // header
        assert_eq!(lines[1], ""); // closing fence
    }

    #[test]
    fn mask_multiple_chunks() {
        // Two R chunks separated by prose; both bodies at original indices.
        let src = "```{r}\na <- 1\n```\n\nprose\n\n```{r}\nb <- 2\n```\n";
        let masked = mask_to_r(src);
        let lines: Vec<&str> = masked.split('\n').collect();
        assert_eq!(seg_count(&masked), seg_count(src));
        assert_eq!(lines[0], ""); // first header
        assert_eq!(lines[1], "a <- 1"); // first body
        assert_eq!(lines[2], ""); // first close
        assert_eq!(lines[3], ""); // blank prose
        assert_eq!(lines[4], ""); // prose
        assert_eq!(lines[5], ""); // blank prose
        assert_eq!(lines[6], ""); // second header
        assert_eq!(lines[7], "b <- 2"); // second body
        assert_eq!(lines[8], ""); // second close
    }

    #[test]
    fn mask_blanks_chunk_reuse_reference() {
        // <<setup>> inside an R body must be blanked.
        let src = "```{r}\nx <- 1\n<<setup>>\ny <- 2\n```\n";
        let masked = mask_to_r(src);
        let lines: Vec<&str> = masked.split('\n').collect();
        assert_eq!(lines[1], "x <- 1"); // kept
        assert_eq!(lines[2], ""); // <<setup>> → blanked
        assert_eq!(lines[3], "y <- 2"); // kept
    }

    // =========================================================================
    // position_in_r_chunk_body tests
    // =========================================================================

    #[test]
    fn position_in_r_chunk_body_true_for_body_line() {
        let src = "prose\n```{r}\nx <- 1\n```\n";
        // Line 2 is the R body.
        assert!(position_in_r_chunk_body(src, 2));
    }

    #[test]
    fn position_in_r_chunk_body_false_for_header_line() {
        let src = "prose\n```{r}\nx <- 1\n```\n";
        // Line 1 is the header fence.
        assert!(!position_in_r_chunk_body(src, 1));
    }

    #[test]
    fn position_in_r_chunk_body_false_for_closing_fence_line() {
        let src = "prose\n```{r}\nx <- 1\n```\n";
        // Line 3 is the closing fence.
        assert!(!position_in_r_chunk_body(src, 3));
    }

    #[test]
    fn position_in_r_chunk_body_false_for_prose_line() {
        let src = "prose\n```{r}\nx <- 1\n```\n";
        // Line 0 is prose.
        assert!(!position_in_r_chunk_body(src, 0));
    }

    #[test]
    fn position_in_r_chunk_body_false_for_python_body_line() {
        let src = "```{python}\nprint('hi')\n```\n";
        // Line 1 is a Python body — not R.
        assert!(!position_in_r_chunk_body(src, 1));
    }

    #[test]
    fn position_in_r_chunk_body_false_beyond_eof() {
        let src = "```{r}\nx <- 1\n```\n";
        // Line 99 is way past the end.
        assert!(!position_in_r_chunk_body(src, 99));
    }
}
