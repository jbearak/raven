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

/// Normalizes a use-site callee/identifier spelling to the canonical bare-name
/// form: strip surrounding backticks iff the inner name is syntactic, so a
/// redundantly-quoted `` `my_func` `` matches the bare key that resolution
/// stores, while a genuinely non-syntactic name (`` `my fn` ``, `` `if` ``,
/// `` `.2way` ``) keeps its required backticks.
///
/// Applied wherever a use site is matched against a bare-keyed store: it is the
/// use-site counterpart to [`crate::cross_file::directive::callee_name_for_match`]
/// at the directive seam (Seam B), and is also used for NSE local-policy lookups
/// and storage (Seam C), `table_verb_policy`, go-to-definition, find-references,
/// and completion signature lookups. (Seam A — the position-aware scope symbol
/// table — instead uses an unconditional `unquote_backtick_name`, since it stores
/// every definition bare regardless of syntacticity.)
///
/// This is NOT a literal round-trip inverse of `callee_name_for_match`: it is
/// many-to-one (both `foo` and `` `foo` `` map to `foo`), so it cannot
/// reconstruct which spelling a caller used.
///
/// Contract: `raw` is a BARE callee/identifier only — never a `pkg::` qualifier
/// and never surrounding context. It uses the Unicode-aware
/// [`is_syntactic_r_name`] (NOT scope.rs's ASCII-only
/// `is_valid_unquoted_r_identifier`), so a non-ASCII syntactic name such as
/// `` `données` `` is correctly unwrapped. The return is borrowed from `raw`.
pub(crate) fn canonical_use_name(raw: &str) -> &str {
    // Leading-backtick fast path keeps the hot diagnostic/find-refs loops cheap.
    let Some(rest) = raw.strip_prefix('`') else {
        return raw;
    };
    match rest.strip_suffix('`') {
        Some(inner) if is_syntactic_r_name(inner) => inner,
        _ => raw,
    }
}

#[cfg(test)]
mod tests {
    use super::{canonical_use_name, is_syntactic_r_name};

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

    #[test]
    fn canonical_use_name_strips_redundant_backticks_on_syntactic_names() {
        assert_eq!(canonical_use_name("`f`"), "f");
        assert_eq!(canonical_use_name("`foo.bar`"), "foo.bar");
        // Unicode-aware: a non-ASCII syntactic name has its backticks stripped.
        assert_eq!(canonical_use_name("`données`"), "données");
    }

    #[test]
    fn canonical_use_name_keeps_backticks_on_non_syntactic_names() {
        assert_eq!(canonical_use_name("`my fn`"), "`my fn`");
        assert_eq!(canonical_use_name("`if`"), "`if`");
        assert_eq!(canonical_use_name("`TRUE`"), "`TRUE`");
        // Leading-dot-digit name is non-syntactic and must keep its backticks.
        assert_eq!(canonical_use_name("`.2way`"), "`.2way`");
    }

    #[test]
    fn canonical_use_name_leaves_bare_names_unchanged() {
        assert_eq!(canonical_use_name("f"), "f");
        assert_eq!(canonical_use_name("pkg"), "pkg");
    }

    #[test]
    fn canonical_use_name_leaves_degenerate_inputs_unchanged() {
        // Empty input has no backticks: returned as-is.
        assert_eq!(canonical_use_name(""), "");
        // Lone backtick: no closing backtick, so untouched.
        assert_eq!(canonical_use_name("`"), "`");
        // Empty pair of backticks wraps a non-syntactic (empty) inner name.
        assert_eq!(canonical_use_name("``"), "``");
        // A backslash inside backticks is non-syntactic and stays quoted.
        assert_eq!(canonical_use_name("`a\\b`"), "`a\\b`");
    }
}
