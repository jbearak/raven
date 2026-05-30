/// Convert a UTF-16 column offset (from LSP Position.character) to a byte
/// offset within the given line. Tree-sitter Points expect byte offsets, not
/// UTF-16 code units.
///
/// Fast path: for ASCII-only lines, UTF-16 column equals byte offset directly.
pub fn utf16_column_to_byte_offset(line: &str, utf16_col: u32) -> usize {
    let col = utf16_col as usize;
    if col <= line.len() && line.as_bytes()[..col].is_ascii() {
        return col;
    }
    let mut utf16_count = 0;
    for (byte_idx, ch) in line.char_indices() {
        if utf16_count == utf16_col as usize {
            return byte_idx;
        }
        utf16_count += ch.len_utf16();
    }
    line.len()
}

/// Strip a single leading U+FEFF (byte-order mark) from `s` for the purpose of
/// a raw-text *scan anchor*, returning the remainder borrowed from `s`.
///
/// Why this exists: tree-sitter-r treats U+FEFF as whitespace (`extras`), so a
/// BOM-prefixed first line parses cleanly. But Rust's `\s` / `str::trim` follow
/// Unicode `White_Space`, which **excludes** U+FEFF (removed in Unicode 6.3), so
/// our column-0 raw-text scanners (directive headers, line-length measurement)
/// would otherwise fail to recognise or mis-measure a first-line construct
/// preceded by a raw BOM. Open documents deliberately keep the BOM verbatim to
/// stay position-aligned with the client (see `decode_source` in `state.rs`), so
/// these scanners skip it only at the scan anchor — reported positions are
/// unaffected. Stripping is idempotent-safe: only one leading BOM is removed.
///
/// Apply this to the **first line** of a document only; a U+FEFF anywhere else
/// is a deprecated zero-width no-break space, not a BOM, and is left untouched.
pub fn strip_leading_bom_for_scan(s: &str) -> &str {
    s.strip_prefix('\u{FEFF}').unwrap_or(s)
}

/// Convert a byte offset (e.g. tree-sitter `Point.column`) to a UTF-16 column
/// offset within the given line, suitable for an LSP `Position.character`.
///
/// Fast path: for ASCII-only prefixes (the common case in R code), byte offset
/// equals UTF-16 column directly, avoiding the per-character iteration.
pub fn byte_offset_to_utf16_column(line: &str, byte_offset: usize) -> u32 {
    let prefix_len = byte_offset.min(line.len());
    if line.as_bytes()[..prefix_len].is_ascii() {
        return prefix_len as u32;
    }
    let mut utf16_count: u32 = 0;
    for (byte_idx, ch) in line.char_indices() {
        if byte_idx >= byte_offset {
            return utf16_count;
        }
        utf16_count += ch.len_utf16() as u32;
    }
    utf16_count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_leading_bom_removes_one_leading_feff() {
        assert_eq!(strip_leading_bom_for_scan("\u{FEFF}# x"), "# x");
    }

    #[test]
    fn strip_leading_bom_leaves_bomless_input_untouched() {
        assert_eq!(strip_leading_bom_for_scan("# x"), "# x");
    }

    #[test]
    fn strip_leading_bom_removes_only_the_first_bom() {
        // A second U+FEFF is a zero-width no-break space, not a BOM; keep it.
        assert_eq!(
            strip_leading_bom_for_scan("\u{FEFF}\u{FEFF}x"),
            "\u{FEFF}x"
        );
    }

    #[test]
    fn strip_leading_bom_ignores_a_non_leading_feff() {
        assert_eq!(strip_leading_bom_for_scan("x\u{FEFF}"), "x\u{FEFF}");
    }
}
