/// Convert a UTF-16 column offset (from LSP Position.character) to a byte
/// offset within the given line. Tree-sitter Points expect byte offsets, not
/// UTF-16 code units.
pub fn utf16_column_to_byte_offset(line: &str, utf16_col: u32) -> usize {
    let mut utf16_count = 0;
    for (byte_idx, ch) in line.char_indices() {
        if utf16_count == utf16_col as usize {
            return byte_idx;
        }
        utf16_count += ch.len_utf16();
    }
    line.len()
}
