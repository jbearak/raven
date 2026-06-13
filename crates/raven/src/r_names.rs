//! R lexical rules for *syntactic* names — names that may appear unquoted in
//! source.
//!
//! Centralized here so every site that must decide "does this name need
//! backtick-quoting?" agrees on one rule, and so the rule lives below both
//! [`crate::handlers`] and [`crate::cross_file`] in the module graph: either may
//! depend on it; it depends on neither. Today the consumers are completion
//! insert text (`accessor_member_insert_text`) and NSE/`func` directive callee
//! storage (`callee_name_for_match`).

use crate::reserved_words::is_reserved_word;

/// Whether `name` is a *syntactic* R name: one R accepts without backtick
/// quoting.
///
/// R's rule (R Language Definition §10.3.2, `?make.names`): a name begins with a
/// letter or a `.`; a leading `.` may not be followed by a digit; the remaining
/// characters are letters, digits, `.`, or `_`; and the name is not a reserved
/// word. "Letter" is locale-dependent, so the Unicode alphabetic predicate is
/// used (not the ASCII-only variant) — a non-ASCII identifier such as `données`
/// is syntactic in a UTF-8 locale and must NOT be treated as needing quoting.
///
/// A name failing this test must be backtick-quoted in source, so its
/// tree-sitter `node_text` carries the backticks. Callers that store or insert a
/// name use this predicate to keep the quoted and unquoted spellings aligned:
/// `# raven: nse ".2way"(x)` must match a `` `.2way`(x) `` call (a leading-dot
/// digit name is non-syntactic), `# raven: nse "if"(x)` must match a `` `if`(x)
/// `` call (a reserved word is non-syntactic), and a `` foo$`alpha beta` ``
/// completion must be inserted with its backticks.
///
/// The input is the bare name only — never a `pkg::` qualifier and never the
/// surrounding backticks themselves (a `name` that already contains a backtick
/// is non-syntactic and returns `false`).
pub(crate) fn is_syntactic_r_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_alphabetic() && first != '.' {
        return false;
    }
    // A leading `.` followed by a digit (`.2way`) is NOT syntactic in R.
    if first == '.' && chars.clone().next().is_some_and(|c| c.is_ascii_digit()) {
        return false;
    }
    chars.all(|c| c.is_alphanumeric() || c == '.' || c == '_') && !is_reserved_word(name)
}

#[cfg(test)]
mod tests {
    use super::is_syntactic_r_name;

    #[test]
    fn plain_identifiers_are_syntactic() {
        assert!(is_syntactic_r_name("my_fn"));
        assert!(is_syntactic_r_name("foo.bar"));
        assert!(is_syntactic_r_name("x1"));
        assert!(is_syntactic_r_name(".hidden"));
        assert!(is_syntactic_r_name(".a2")); // leading dot then a letter is fine
    }

    #[test]
    fn non_ascii_letters_are_syntactic() {
        // Unicode-aware: a non-ASCII identifier is syntactic in a UTF-8 locale
        // and must not be flagged as needing backtick-quoting.
        assert!(is_syntactic_r_name("données"));
        assert!(is_syntactic_r_name("café"));
    }

    #[test]
    fn leading_digit_or_dot_digit_is_not_syntactic() {
        assert!(!is_syntactic_r_name("2way"));
        assert!(!is_syntactic_r_name(".2way"));
    }

    #[test]
    fn reserved_words_are_not_syntactic() {
        assert!(!is_syntactic_r_name("if"));
        assert!(!is_syntactic_r_name("function"));
        assert!(!is_syntactic_r_name("TRUE"));
    }

    #[test]
    fn spaces_operators_and_backticks_are_not_syntactic() {
        assert!(!is_syntactic_r_name("my fn"));
        assert!(!is_syntactic_r_name("a:b"));
        assert!(!is_syntactic_r_name("`quoted`"));
        assert!(!is_syntactic_r_name(""));
    }
}
