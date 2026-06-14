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

/// Cross-seam invariant tests for the two backtick normalizers and the directive
/// re-quote inverse (issue #462).
///
/// Backtick normalization is split across three functions by deliberate design,
/// keyed to two storage conventions (the "Seams A/B/C" contract documented on
/// [`canonical_use_name`] above):
///
/// - Seam A — [`crate::handlers::unquote_backtick_name`]: an **unconditional**
///   strip, used for **bare-keyed** stores (the scope symbol table,
///   go-to-definition, find-references definitions). Every definition is stored
///   bare, so a backticked use recovers the bare key by stripping unconditionally.
/// - Seams B/C — [`canonical_use_name`]: a **conditional** strip (only when the
///   inner name is syntactic), used for **call-site-keyed** stores (directive
///   `DeclaredSymbol`/`NseDeclaration` names, completion insert text). A genuinely
///   non-syntactic name keeps its required backticks so it stays distinct.
/// - The directive-storage inverse —
///   [`crate::cross_file::directive::callee_name_for_match`]: the conditional
///   **re-quote** that puts a directive-declared bare name back into the spelling
///   a call site uses.
///
/// The hazard these tests guard against is "wrong normalizer at a new call site":
/// routing a name through the unconditional strip where the conditional one is
/// required (or vice-versa) silently breaks resolution **only** for genuinely
/// non-syntactic names — the esoteric case least likely to be exercised by hand.
/// The properties below pin the equivalences and, crucially, the one divergence
/// that makes the two normalizers non-interchangeable, so a future unification or
/// mis-routed call site fails a test instead of shipping a latent bug.
///
/// The imports of `unquote_backtick_name` (from `handlers`) and
/// `callee_name_for_match` (from `cross_file::directive`) are test-only: they do
/// not change the runtime module layering, under which `r_names` depends on
/// neither. This module is the single place that exercises all three seams
/// together, so it lives beside the contract they implement.
#[cfg(test)]
mod seam_invariants {
    use super::{canonical_use_name, is_syntactic_r_name};
    use crate::cross_file::directive::callee_name_for_match;
    use crate::handlers::unquote_backtick_name;
    use proptest::prelude::*;

    /// Wrap a bare name in backticks — the only legal source spelling of a
    /// non-syntactic name, and a redundant-but-legal spelling of a syntactic one.
    fn quoted(name: &str) -> String {
        format!("`{name}`")
    }

    // ── Example-based: the exact names the issue calls out ──────────────────

    /// Seam A: every backticked use recovers its bare key, syntactic or not —
    /// the mechanism by which a bare definition and a backticked use resolve to
    /// the same scope-table / goto / find-references symbol (issue bullet 1).
    #[test]
    fn unconditional_strip_recovers_bare_key_for_every_name() {
        for n in ["foo", "my_func", "données", "my fn", "if", ".2way", "TRUE"] {
            assert_eq!(
                unquote_backtick_name(&quoted(n)),
                Some(n),
                "Seam A must strip backticks unconditionally so `{n}` keys the bare store"
            );
        }
    }

    /// Seams B/C: a non-syntactic name is NEVER reduced to a bare key on the
    /// call-site path, so `` `my fn` `` and the bare `myfn` cannot collide
    /// (issue bullet 2).
    #[test]
    fn nonsyntactic_name_never_collapses_to_a_bare_key() {
        for n in ["my fn", "if", ".2way", "TRUE", "a:b"] {
            assert!(
                !is_syntactic_r_name(n),
                "test fixture `{n}` must be non-syntactic"
            );
            let q = quoted(n);
            let canon = canonical_use_name(&q);
            assert!(
                canon.starts_with('`') && canon.ends_with('`'),
                "non-syntactic `{n}` must keep its backticks on the call-site seam, got {canon:?}"
            );
        }
        // The concrete collision the design exists to prevent: the non-syntactic
        // `my fn` and the syntactic `myfn` must not share a key.
        assert_ne!(
            canonical_use_name(&quoted("my fn")),
            canonical_use_name(&quoted("myfn")),
            "`my fn` and `myfn` must never share a call-site key"
        );
    }

    /// The directive round-trip (issue bullet 3): a callee declared bare in a
    /// directive is stored via `callee_name_for_match`, and the canonicalized
    /// call-site spelling must recover that exact stored key — for syntactic and
    /// non-syntactic names alike.
    #[test]
    fn directive_callee_round_trips_through_canonical_use_name() {
        for n in ["my_func", "données", "my fn", "if", ".2way"] {
            let stored = callee_name_for_match(n);
            assert_eq!(
                canonical_use_name(&quoted(n)),
                stored,
                "backticked call site `{n}` must match the directive-stored key"
            );
            if is_syntactic_r_name(n) {
                // A syntactic name is also legal bare at the call site, and is
                // stored bare — both spellings must reach the same key.
                assert_eq!(canonical_use_name(n), stored);
                assert_eq!(stored, n);
            }
        }
    }

    /// The reason there are two normalizers: on a non-syntactic name the
    /// unconditional strip (bare) and the conditional strip (kept-quoted) MUST
    /// disagree. If a refactor ever made them interchangeable this fails,
    /// flagging that a call site could now be routed through either silently.
    #[test]
    fn the_two_normalizers_diverge_on_nonsyntactic_names() {
        for n in ["my fn", "if", ".2way", "TRUE"] {
            let q = quoted(n);
            assert_ne!(
                Some(canonical_use_name(&q)),
                unquote_backtick_name(&q),
                "Seam A (bare) and Seams B/C (quoted) must differ on non-syntactic `{n}`"
            );
        }
    }

    // ── Property-based: the same invariants over generated names ─────────────

    /// A syntactic R name: lowercase to dodge reserved words, filtered through
    /// the real predicate so the strategy and the code under test never drift.
    fn syntactic_name() -> impl Strategy<Value = String> {
        "[a-z][a-z0-9._]{0,6}".prop_filter("syntactic", |s| is_syntactic_r_name(s))
    }

    /// A non-syntactic but backtick-legal R name (no inner backtick, non-empty):
    /// names with spaces/operators, leading digits, leading-dot digits, and
    /// reserved words.
    fn nonsyntactic_name() -> impl Strategy<Value = String> {
        prop_oneof![
            "[a-z]+ [a-z]+",     // embedded space
            "[0-9][a-z0-9]*",    // leading digit
            r"\.[0-9][a-z0-9]*", // leading-dot digit, e.g. .2way
            "[a-z]+:[a-z]+",     // embedded operator char
            Just("if".to_string()),
            Just("function".to_string()),
            Just("TRUE".to_string()),
        ]
        .prop_filter("non-syntactic and backtick-free", |s| {
            !s.is_empty() && !s.contains('`') && !is_syntactic_r_name(s)
        })
    }

    proptest! {
        /// Seam A over all names: the unconditional strip recovers the bare key.
        #[test]
        fn prop_unconditional_strip_recovers_bare_key(
            n in prop_oneof![syntactic_name(), nonsyntactic_name()]
        ) {
            let q = quoted(&n);
            prop_assert_eq!(unquote_backtick_name(&q), Some(n.as_str()));
        }

        /// On a syntactic name the two normalizers AGREE: both strip the
        /// redundant backticks to the same bare spelling.
        #[test]
        fn prop_normalizers_agree_on_syntactic_names(n in syntactic_name()) {
            let q = quoted(&n);
            prop_assert_eq!(canonical_use_name(&q), n.as_str());
            prop_assert_eq!(unquote_backtick_name(&q), Some(n.as_str()));
        }

        /// On a non-syntactic name the two normalizers DIVERGE, and the
        /// conditional one never yields a bare key (no collision possible).
        #[test]
        fn prop_normalizers_diverge_on_nonsyntactic_names(n in nonsyntactic_name()) {
            let q = quoted(&n);
            let canon = canonical_use_name(&q);
            prop_assert_eq!(canon, q.as_str());
            prop_assert_ne!(Some(canon), unquote_backtick_name(&q));
        }

        /// Directive round-trip over all names: the backticked call-site spelling
        /// canonicalizes to exactly the directive-stored key.
        #[test]
        fn prop_directive_callee_round_trips(
            n in prop_oneof![syntactic_name(), nonsyntactic_name()]
        ) {
            let q = quoted(&n);
            prop_assert_eq!(canonical_use_name(&q), callee_name_for_match(&n));
        }
    }
}
