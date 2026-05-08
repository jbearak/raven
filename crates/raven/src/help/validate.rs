//! Topic-name validation for R help lookup.
//!
//! Permits R operator topics (`[`, `+`, `%>%`, `<-`, etc.) but rejects
//! control characters, NUL bytes, backticks, and oversized inputs.

/// Returns true if `s` is a plausible R help topic.
///
/// See the help-viewer spec, "Validation" section, for the full rule set.
pub fn is_valid_help_topic(s: &str) -> bool {
    if s.is_empty() || s.len() > 256 {
        return false;
    }
    for byte in s.bytes() {
        // Reject control chars, DEL, NUL, backtick.
        if byte < 0x20 || byte == 0x7f || byte == b'`' {
            return false;
        }
        // Reject non-ASCII to keep the API surface predictable.
        if byte >= 0x80 {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_simple_identifiers() {
        assert!(is_valid_help_topic("mean"));
        assert!(is_valid_help_topic("print.default"));
        assert!(is_valid_help_topic("filter"));
    }

    #[test]
    fn accepts_operator_topics() {
        assert!(is_valid_help_topic("["));
        assert!(is_valid_help_topic("[["));
        assert!(is_valid_help_topic("+"));
        assert!(is_valid_help_topic("%>%"));
        assert!(is_valid_help_topic("<-"));
        assert!(is_valid_help_topic(":"));
        assert!(is_valid_help_topic(":::"));
        assert!(is_valid_help_topic("?"));
    }

    #[test]
    fn accepts_keywords() {
        assert!(is_valid_help_topic("if"));
        assert!(is_valid_help_topic("for"));
        assert!(is_valid_help_topic("while"));
        assert!(is_valid_help_topic("Control"));
    }

    #[test]
    fn rejects_empty() {
        assert!(!is_valid_help_topic(""));
    }

    #[test]
    fn rejects_too_long() {
        let s = "a".repeat(257);
        assert!(!is_valid_help_topic(&s));
    }

    #[test]
    fn rejects_control_chars() {
        assert!(!is_valid_help_topic("with\nnewline"));
        assert!(!is_valid_help_topic("with\ttab"));
        assert!(!is_valid_help_topic("with\rcr"));
        assert!(!is_valid_help_topic("with\x01ctrl"));
    }

    #[test]
    fn rejects_nul() {
        assert!(!is_valid_help_topic("with\0nul"));
    }

    #[test]
    fn rejects_backticks() {
        assert!(!is_valid_help_topic("`backtick`"));
    }

    #[test]
    fn rejects_non_ascii() {
        assert!(!is_valid_help_topic("café"));
        assert!(!is_valid_help_topic("emoji😀"));
    }
}
