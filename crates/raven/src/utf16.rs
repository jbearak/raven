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
