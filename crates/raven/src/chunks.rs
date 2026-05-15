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
        Regex::new(r"^#+[^']?.*[-#+=*]{4,}\s*$").expect("section divider regex")
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

/// Detect all chunks in the document, in source order. `kind` controls which
/// detection path runs.
pub fn detect_chunks(text: &str, kind: ChunkKind) -> Vec<Chunk> {
    let lines: Vec<&str> = text.lines().collect();
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
        for j in (i + 1)..lines.len() {
            if let Some(close_caps) = close_re.captures(lines[j]) {
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
        let next_marker = markers
            .get(m + 1)
            .copied()
            .unwrap_or(lines.len());
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
    fn detects_a_single_r_chunk() {
        let src = "Some prose.\n\n```{r}\nx <- 1\nprint(x)\n```\n\nMore prose.";
        let chunks = detect(src, ChunkKind::Rmd);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].header_line, 2);
        assert_eq!(chunks[0].closing_fence_line, Some(5));
        assert_eq!(chunks[0].end_line, 4);
        assert_eq!(chunks[0].language, "r");
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
}
