//! Non-standard-evaluation (NSE) argument policies for undefined-variable
//! diagnostics.
//!
//! Issue #398 untangles undefined-variable diagnostics from the old blanket
//! "call-like arguments are NSE" suppression. Instead of suppressing every
//! identifier inside any `call`/`subset`/`subset2` argument list, the
//! diagnostics collector resolves the callee to its source and consults an
//! **argument-policy table** that says, per call, which argument subtrees are
//! captured / data-masked / tidy-selected (and therefore not free-variable
//! references) versus evaluated normally.
//!
//! This module is the **pure** half of that machinery: it has no dependency on
//! tree-sitter or scope resolution. It exposes
//!
//! - [`ArgPolicy`], the per-call decision (`Standard`, `WholeCall`, or
//!   `PerFormal`),
//! - [`base_policy`] / [`package_policy`], the built-in `(source, name)` →
//!   policy table, and
//! - [`suppressed_arguments`], which maps a policy plus the ordered argument
//!   labels of a concrete call onto a per-argument suppression mask using R's
//!   named-then-positional matching rules.
//!
//! The AST-facing half (extracting the callee, resolving it against scope and
//! the package library, inferring user-defined captured formals, and applying
//! the suppression mask while walking the tree) lives in `handlers.rs`.
//!
//! The table deliberately prefers **per-formal** policies over whole-call
//! suppression so that, for example, `with(df, col + 1)` still checks `df`
//! while suppressing `col`. Whole-call suppression is reserved for forms where
//! every meaningful argument is captured (`aes(...)`, the plural rlang capture
//! helpers). The table is a curated v1 of the common, slow-moving NSE surface
//! (base metaprogramming, dplyr/tidyr data-masking and tidy-select verbs,
//! ggplot2 mapping helpers, rlang capture helpers, and a few established DSLs);
//! it is intentionally extensible rather than exhaustive.

/// What to do with the arguments of a resolved call when collecting
/// undefined-variable candidates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ArgPolicy {
    /// Standard evaluation: every argument is a real expression, so descend
    /// into all of them and collect candidate references.
    Standard,
    /// Whole-call NSE: every argument subtree is captured / data-masked, so
    /// suppress them all. Reserved for forms where per-formal modeling is
    /// unnecessary (e.g. `aes(...)`, `exprs(...)`).
    WholeCall,
    /// Per-formal NSE: suppress only the arguments bound to the named formals
    /// (and, when `captured_dots` is set, the arguments absorbed by `...` /
    /// trailing positionals). Every other argument is checked.
    ///
    /// Owned `String`s (rather than `&'static str`) so the same variant can
    /// carry both the built-in table's literals and the formals inferred from a
    /// user-defined function's parameter list (Phase 2.5).
    PerFormal {
        /// Ordered formal names, used for positional argument matching. A
        /// literal `"..."` marks where `...` sits: positional arguments at or
        /// past that point are absorbed by `...` and governed by
        /// `captured_dots`; formals after `...` can only be matched by name.
        formals: Vec<String>,
        /// Names of formals whose bound argument is captured (suppressed).
        captured: Vec<String>,
        /// Whether arguments absorbed by `...` (or overflowing positionals) are
        /// captured (suppressed).
        captured_dots: bool,
    },
}

impl ArgPolicy {
    /// Construct a [`ArgPolicy::PerFormal`] from string slices (used by the
    /// built-in table; the Phase 2.5 inference constructs the variant directly
    /// from owned formal names).
    pub(crate) fn per_formal(formals: &[&str], captured: &[&str], captured_dots: bool) -> Self {
        ArgPolicy::PerFormal {
            formals: formals.iter().map(|s| s.to_string()).collect(),
            captured: captured.iter().map(|s| s.to_string()).collect(),
            captured_dots,
        }
    }
}

/// Built-in NSE policy for a base-R / builtin callee `name`, or `None` when the
/// builtin evaluates its arguments normally (the common case, e.g. `paste`,
/// `c`, `eval`, `tryCatch`, `stopifnot`, `system.time`).
///
/// Notable entries:
/// - `library` / `require` capture the bare package name so `library(dplyr)`
///   does not flag `dplyr`.
/// - `substitute` / `quote` / `bquote` / `evalq` capture the quoted expression
///   but still check environment arguments.
/// - `with` / `within` / `subset` / `transform` check the data argument and
///   suppress the data-masked expression(s).
/// - object-name helpers (`data`, `rm`, `remove`, `save`) suppress their bare
///   object-name `...` while checking control arguments such as `file`/`list`.
pub(crate) fn base_policy(name: &str) -> Option<ArgPolicy> {
    let policy = match name {
        // Package attachment: the package argument is a bare name, not a value.
        "library" | "require" => {
            ArgPolicy::per_formal(&["package", "help"], &["package", "help"], false)
        }

        // Base metaprogramming: capture the quoted expression, check the rest.
        "substitute" => ArgPolicy::per_formal(&["expr", "env"], &["expr"], false),
        "quote" => ArgPolicy::per_formal(&["expr"], &["expr"], false),
        "bquote" => ArgPolicy::per_formal(&["expr", "where", "splice"], &["expr"], false),
        "expression" => ArgPolicy::WholeCall,
        "evalq" => ArgPolicy::per_formal(&["expr", "envir", "enclos"], &["expr"], false),
        "on.exit" => ArgPolicy::per_formal(&["expr", "add", "after"], &["expr"], false),
        // `curve(sin(x), 0, 1)`: the expression is evaluated against an implicit
        // `x`, so capture it but check the numeric range/control arguments.
        "curve" => ArgPolicy::per_formal(&["expr", "from", "to", "n"], &["expr"], false),

        // Data-mask helpers: check the data, suppress the masked expression(s).
        "with" | "within" => ArgPolicy::per_formal(&["data", "expr"], &["expr"], true),
        "subset" => ArgPolicy::per_formal(
            &["x", "subset", "select", "drop"],
            &["subset", "select"],
            false,
        ),
        "transform" => ArgPolicy::per_formal(&["_data"], &[], true),

        // Object-name helpers: suppress bare object names, check controls.
        "data" => ArgPolicy::per_formal(
            &[
                "...",
                "list",
                "package",
                "lib.loc",
                "verbose",
                "envir",
                "overwrite",
            ],
            &[],
            true,
        ),
        "rm" | "remove" => {
            ArgPolicy::per_formal(&["...", "list", "pos", "envir", "inherits"], &[], true)
        }
        "save" => ArgPolicy::per_formal(
            &[
                "...",
                "list",
                "file",
                "ascii",
                "version",
                "envir",
                "compress",
                "compression_level",
                "eval.promises",
                "precheck",
            ],
            &[],
            true,
        ),
        "help" => ArgPolicy::per_formal(
            &[
                "topic",
                "package",
                "lib.loc",
                "verbose",
                "try.all.packages",
                "help_type",
            ],
            &["topic", "package"],
            false,
        ),

        _ => return None,
    };
    Some(policy)
}

/// Built-in NSE policy for a `package::name` callee, or `None` when that
/// package's function (as far as the v1 table knows) evaluates its arguments
/// normally.
///
/// Keyed by source `(package, name)` rather than bare text so that a local
/// `filter <- function(...)` or `stats::filter` is classified differently from
/// `dplyr::filter` (see the resolver in `handlers.rs`). Coverage is a curated
/// subset of the common data-masking / tidy-select / capture surface.
pub(crate) fn package_policy(package: &str, name: &str) -> Option<ArgPolicy> {
    let policy = match package {
        "dplyr" => dplyr_policy(name)?,
        "tidyr" => tidyr_policy(name)?,
        "ggplot2" => match name {
            "aes" | "vars" => ArgPolicy::WholeCall,
            _ => return None,
        },
        "rlang" => match name {
            "enquo" | "enexpr" | "ensym" => ArgPolicy::per_formal(&["arg"], &["arg"], false),
            "quo" | "expr" => ArgPolicy::per_formal(&["expr"], &["expr"], false),
            "quos" | "exprs" | "enquos" | "enexprs" | "ensyms" => ArgPolicy::WholeCall,
            _ => return None,
        },
        "data.table" => match name {
            // Column-name NSE; the `v`-suffixed variants take character vectors.
            "setkey" | "setorder" | "setindex" => ArgPolicy::per_formal(&["x", "..."], &[], true),
            _ => return None,
        },
        "targets" => match name {
            "tar_target" => ArgPolicy::per_formal(
                &["name", "command", "pattern"],
                &["name", "command", "pattern"],
                false,
            ),
            _ => return None,
        },
        _ => return None,
    };
    Some(policy)
}

fn dplyr_policy(name: &str) -> Option<ArgPolicy> {
    let policy = match name {
        "filter" | "slice" => {
            ArgPolicy::per_formal(&[".data", "...", ".by", ".preserve"], &[".by"], true)
        }
        "mutate" => ArgPolicy::per_formal(
            &[".data", "...", ".by", ".keep", ".before", ".after"],
            &[".by", ".before", ".after"],
            true,
        ),
        "transmute" | "select" | "rename" | "distinct" => {
            ArgPolicy::per_formal(&[".data", "..."], &[], true)
        }
        "summarise" | "summarize" | "reframe" => {
            ArgPolicy::per_formal(&[".data", "...", ".by", ".groups"], &[".by"], true)
        }
        "arrange" => ArgPolicy::per_formal(&[".data", "...", ".by_group"], &[], true),
        "group_by" | "rowwise" => {
            ArgPolicy::per_formal(&[".data", "...", ".add", ".drop"], &[], true)
        }
        // `slice_*` row selectors data-mask `order_by` / `by` and take literal
        // controls (`n`, `prop`, `with_ties`); suppress everything past `.data`.
        "slice_max" | "slice_min" | "slice_head" | "slice_tail" | "slice_sample" => {
            ArgPolicy::per_formal(&[".data", "..."], &[], true)
        }
        "relocate" => ArgPolicy::per_formal(
            &[".data", "...", ".before", ".after"],
            &[".before", ".after"],
            true,
        ),
        "count" | "add_count" => ArgPolicy::per_formal(
            &[".data", "...", ".wt", ".sort", ".name", ".drop"],
            &[".wt"],
            true,
        ),
        "pull" => ArgPolicy::per_formal(&[".data", "var", "name", "..."], &["var", "name"], false),
        // Whole-call data-masking helpers, normally nested inside the verbs above.
        "case_when" | "across" | "c_across" | "if_any" | "if_all" => ArgPolicy::WholeCall,
        _ => return None,
    };
    Some(policy)
}

fn tidyr_policy(name: &str) -> Option<ArgPolicy> {
    let policy = match name {
        "pivot_longer" => ArgPolicy::per_formal(
            &["data", "cols", "names_to", "values_to", "..."],
            &["cols"],
            false,
        ),
        "pivot_wider" => ArgPolicy::per_formal(
            &["data", "id_cols", "names_from", "values_from", "..."],
            &["id_cols", "names_from", "values_from"],
            false,
        ),
        "unite" => ArgPolicy::per_formal(&["data", "col", "..."], &["col"], true),
        "separate" | "extract" => {
            ArgPolicy::per_formal(&["data", "col", "into", "..."], &["col"], false)
        }
        "unnest" => ArgPolicy::per_formal(&["data", "cols", "..."], &["cols"], true),
        "unnest_wider" | "unnest_longer" => {
            ArgPolicy::per_formal(&["data", "col", "..."], &["col"], false)
        }
        "hoist" => ArgPolicy::per_formal(&[".data", ".col", "..."], &[".col"], true),
        "nest" | "fill" | "drop_na" | "complete" | "expand" => {
            ArgPolicy::per_formal(&["data", "..."], &[], true)
        }
        _ => return None,
    };
    Some(policy)
}

/// Core member packages of a known meta-package, or an empty slice. A file that
/// only does `library(tidyverse)` should still resolve `filter` / `mutate` to
/// the member package's NSE policy, so the resolver treats the meta-package as
/// if its members were in play. (Listing only the members whose exports carry
/// NSE policies in this module; other members are harmless to include.)
pub(crate) fn meta_package_members(name: &str) -> &'static [&'static str] {
    match name {
        "tidyverse" => &[
            "dplyr",
            "tidyr",
            "ggplot2",
            "purrr",
            "readr",
            "tibble",
            "stringr",
            "forcats",
            "lubridate",
        ],
        "tidymodels" => &["dplyr", "tidyr", "ggplot2", "purrr", "rlang"],
        _ => &[],
    }
}

/// The set of base/rlang capture helpers whose single expression argument, when
/// it is a direct reference to one of the enclosing function's formals, marks
/// that formal as captured. Used by the Phase 2.5 user-defined-NSE inference in
/// `handlers.rs`.
pub(crate) fn is_capture_helper(name: &str) -> bool {
    matches!(name, "substitute" | "enquo" | "enexpr" | "ensym")
}

/// Compute the per-argument suppression mask for a call.
///
/// `arg_labels[i]` is `Some(name)` for a named argument (`name = value`) and
/// `None` for a positional argument, in source order. The returned vector has
/// the same length: `true` means "suppress this argument's value subtree from
/// undefined-variable collection".
///
/// `PerFormal` matching follows R's rules in two passes: named arguments match
/// formals by (exact) name first; remaining positional arguments then fill the
/// still-unmatched formals in order, stopping at `...`. Positional arguments at
/// or past `...`, and named arguments that match no formal, are absorbed by
/// `...` and suppressed only when `captured_dots` is set. (Partial name
/// matching, which real R supports, is intentionally not modeled.)
///
/// `pipe_fed` is true when the call is the right-hand side of a pipe
/// (`df %>% filter(col > 1)` / `df |> filter(col > 1)`): the pipe supplies the
/// first formal (the data/object argument) implicitly, so it is pre-consumed
/// and the syntactic positional arguments bind starting at the *second* formal.
/// Without this, the data-masked `col > 1` would bind the non-captured `.data`
/// formal and be checked — a false positive on the most common dplyr idiom.
pub(crate) fn suppressed_arguments(
    policy: &ArgPolicy,
    arg_labels: &[Option<&str>],
    pipe_fed: bool,
) -> Vec<bool> {
    match policy {
        ArgPolicy::Standard => vec![false; arg_labels.len()],
        ArgPolicy::WholeCall => vec![true; arg_labels.len()],
        ArgPolicy::PerFormal {
            formals,
            captured,
            captured_dots,
        } => per_formal_mask(formals, captured, *captured_dots, arg_labels, pipe_fed),
    }
}

fn per_formal_mask(
    formals: &[String],
    captured: &[String],
    captured_dots: bool,
    arg_labels: &[Option<&str>],
    pipe_fed: bool,
) -> Vec<bool> {
    let is_captured = |formal: &str| captured.iter().any(|c| c == formal);
    let mut mask = vec![false; arg_labels.len()];
    // Which formal indices have already been bound by a named argument; a
    // positional argument cannot reuse them.
    let mut consumed = vec![false; formals.len()];
    // A pipe supplies the leading data/object formal, so treat it as bound
    // before matching the syntactic arguments (unless that formal is `...`).
    if pipe_fed && formals.first().is_some_and(|f| f != "...") {
        consumed[0] = true;
    }

    // Pass 1: named arguments match formals by exact name.
    for (i, label) in arg_labels.iter().enumerate() {
        let Some(name) = label else { continue };
        match formals.iter().position(|f| f != "..." && f == name) {
            Some(fi) => {
                consumed[fi] = true;
                mask[i] = is_captured(name);
            }
            // Named argument that matches no formal is absorbed by `...`.
            None => mask[i] = captured_dots,
        }
    }

    // Pass 2: positional arguments fill remaining formals in order, stopping at
    // `...`. A cursor that has reached `...` (or run off the end) routes every
    // further positional argument through the dots policy.
    let mut cursor = 0usize;
    for (i, label) in arg_labels.iter().enumerate() {
        if label.is_some() {
            continue;
        }
        loop {
            match formals.get(cursor).map(String::as_str) {
                Some("...") => {
                    mask[i] = captured_dots;
                    break;
                }
                Some(formal) => {
                    let fi = cursor;
                    cursor += 1;
                    if consumed[fi] {
                        continue;
                    }
                    mask[i] = is_captured(formal);
                    break;
                }
                None => {
                    mask[i] = captured_dots;
                    break;
                }
            }
        }
    }

    mask
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Convenience: build the `arg_labels` slice from a list of optional names.
    fn labels(names: &[Option<&'static str>]) -> Vec<Option<&'static str>> {
        names.to_vec()
    }

    #[test]
    fn standard_suppresses_nothing() {
        let mask = suppressed_arguments(
            &ArgPolicy::Standard,
            &labels(&[None, Some("x"), None]),
            false,
        );
        assert_eq!(mask, vec![false, false, false]);
    }

    #[test]
    fn whole_call_suppresses_everything() {
        let mask = suppressed_arguments(&ArgPolicy::WholeCall, &labels(&[None, Some("x")]), false);
        assert_eq!(mask, vec![true, true]);
    }

    #[test]
    fn substitute_suppresses_expr_checks_env_positionally() {
        // substitute(expr, env): first positional -> expr (suppressed),
        // second positional -> env (checked).
        let p = base_policy("substitute").unwrap();
        let mask = suppressed_arguments(&p, &labels(&[None, None]), false);
        assert_eq!(mask, vec![true, false]);
    }

    #[test]
    fn substitute_named_env_is_checked() {
        // substitute(expr, env = typo_env): expr positional suppressed,
        // env named is checked.
        let p = base_policy("substitute").unwrap();
        let mask = suppressed_arguments(&p, &labels(&[None, Some("env")]), false);
        assert_eq!(mask, vec![true, false]);
    }

    #[test]
    fn with_checks_data_suppresses_expr() {
        // with(df, col + 1): data checked, expr suppressed.
        let p = base_policy("with").unwrap();
        let mask = suppressed_arguments(&p, &labels(&[None, None]), false);
        assert_eq!(mask, vec![false, true]);
    }

    #[test]
    fn subset_checks_x_and_drop_suppresses_subset_and_select() {
        // subset(x, subset, select, drop)
        let p = base_policy("subset").unwrap();
        let mask = suppressed_arguments(&p, &labels(&[None, None, None, None]), false);
        assert_eq!(mask, vec![false, true, true, false]);
    }

    #[test]
    fn library_suppresses_bare_package_name() {
        let p = base_policy("library").unwrap();
        let mask = suppressed_arguments(&p, &labels(&[None]), false);
        assert_eq!(mask, vec![true]);
    }

    #[test]
    fn rm_suppresses_dots_checks_named_list() {
        // rm(x, y, list = z): x, y -> dots (suppressed); list -> checked.
        let p = base_policy("rm").unwrap();
        let mask = suppressed_arguments(&p, &labels(&[None, None, Some("list")]), false);
        assert_eq!(mask, vec![true, true, false]);
    }

    #[test]
    fn save_suppresses_objects_checks_file() {
        // save(x, y, file = "out.rda")
        let p = base_policy("save").unwrap();
        let mask = suppressed_arguments(&p, &labels(&[None, None, Some("file")]), false);
        assert_eq!(mask, vec![true, true, false]);
    }

    #[test]
    fn dplyr_filter_checks_data_suppresses_dots_and_by() {
        // filter(.data, cond, .by = grp): .data checked, cond -> dots
        // (suppressed), .by suppressed, .preserve would be checked.
        let p = package_policy("dplyr", "filter").unwrap();
        let mask = suppressed_arguments(&p, &labels(&[None, None, Some(".by")]), false);
        assert_eq!(mask, vec![false, true, true]);
    }

    #[test]
    fn dplyr_filter_preserve_is_checked() {
        let p = package_policy("dplyr", "filter").unwrap();
        let mask = suppressed_arguments(&p, &labels(&[None, None, Some(".preserve")]), false);
        assert_eq!(mask, vec![false, true, false]);
    }

    #[test]
    fn dplyr_mutate_checks_keep_suppresses_before_after() {
        // mutate(.data, new = expr, .keep = "all", .before = col)
        let p = package_policy("dplyr", "mutate").unwrap();
        let mask = suppressed_arguments(
            &p,
            &labels(&[None, Some("new"), Some(".keep"), Some(".before")]),
            false,
        );
        // .data positional checked; `new` is a label whose VALUE is data-masked
        // (named arg matching no formal -> dots -> suppressed); .keep checked;
        // .before suppressed.
        assert_eq!(mask, vec![false, true, false, true]);
    }

    #[test]
    fn pipe_fed_filter_suppresses_first_masked_column() {
        // `df %>% filter(col > 1)`: the pipe supplies `.data`, so the single
        // syntactic positional binds `...` and is suppressed (not `.data`).
        let p = package_policy("dplyr", "filter").unwrap();
        let mask = suppressed_arguments(&p, &labels(&[None]), true);
        assert_eq!(mask, vec![true]);
    }

    #[test]
    fn dplyr_slice_max_suppresses_order_by_and_controls() {
        // df %>% slice_max(x, n = 5): pipe supplies .data; x and n bind `...`.
        let p = package_policy("dplyr", "slice_max").unwrap();
        let mask = suppressed_arguments(&p, &labels(&[None, Some("n")]), true);
        assert_eq!(mask, vec![true, true]);
    }

    #[test]
    fn dplyr_if_any_is_whole_call() {
        assert_eq!(
            package_policy("dplyr", "if_any"),
            Some(ArgPolicy::WholeCall)
        );
        assert_eq!(
            package_policy("dplyr", "c_across"),
            Some(ArgPolicy::WholeCall)
        );
    }

    #[test]
    fn pipe_fed_select_suppresses_all_columns() {
        // `df %>% select(colA, colB)`: both positionals bind `...`.
        let p = package_policy("dplyr", "select").unwrap();
        let mask = suppressed_arguments(&p, &labels(&[None, None]), true);
        assert_eq!(mask, vec![true, true]);
    }

    #[test]
    fn pivot_longer_suppresses_cols_checks_names_to() {
        // pivot_longer(data, cols, names_to = "k")
        let p = package_policy("tidyr", "pivot_longer").unwrap();
        let mask = suppressed_arguments(&p, &labels(&[None, None, Some("names_to")]), false);
        assert_eq!(mask, vec![false, true, false]);
    }

    #[test]
    fn aes_is_whole_call() {
        let p = package_policy("ggplot2", "aes").unwrap();
        let mask = suppressed_arguments(&p, &labels(&[None, None]), false);
        assert_eq!(mask, vec![true, true]);
    }

    #[test]
    fn rlang_enquo_captures_single_arg() {
        let p = package_policy("rlang", "enquo").unwrap();
        let mask = suppressed_arguments(&p, &labels(&[None]), false);
        assert_eq!(mask, vec![true]);
    }

    #[test]
    fn tar_target_captures_name_and_command() {
        let p = package_policy("targets", "tar_target").unwrap();
        let mask = suppressed_arguments(&p, &labels(&[None, None]), false);
        assert_eq!(mask, vec![true, true]);
    }

    #[test]
    fn meta_packages_expand_to_members() {
        assert!(meta_package_members("tidyverse").contains(&"dplyr"));
        assert!(meta_package_members("tidyverse").contains(&"ggplot2"));
        assert!(meta_package_members("tidymodels").contains(&"dplyr"));
        assert!(meta_package_members("dplyr").is_empty());
    }

    #[test]
    fn curve_captures_expr_checks_range() {
        // curve(sin(t), 0, 1): expr captured, from/to checked.
        let p = base_policy("curve").unwrap();
        let mask = suppressed_arguments(&p, &labels(&[None, None, None]), false);
        assert_eq!(mask, vec![true, false, false]);
    }

    #[test]
    fn standard_eval_builtins_have_no_policy() {
        for name in ["paste", "c", "eval", "tryCatch", "stopifnot", "system.time"] {
            assert!(
                base_policy(name).is_none(),
                "{name} should be standard-eval"
            );
        }
    }

    #[test]
    fn unknown_package_function_has_no_policy() {
        assert!(package_policy("dplyr", "coalesce").is_none());
        assert!(package_policy("stats", "filter").is_none());
        assert!(package_policy("nonexistent", "filter").is_none());
    }

    #[test]
    fn capture_helpers_recognized() {
        for name in ["substitute", "enquo", "enexpr", "ensym"] {
            assert!(is_capture_helper(name));
        }
        for name in ["quote", "expr", "paste", "with"] {
            assert!(!is_capture_helper(name));
        }
    }

    #[test]
    fn per_formal_named_arg_for_captured_formal_is_suppressed() {
        // f(env = typo_env, expr = col) for substitute-like (expr captured):
        // expr named -> suppressed; env named -> checked.
        let p = ArgPolicy::per_formal(&["expr", "env"], &["expr"], false);
        let mask = suppressed_arguments(&p, &labels(&[Some("env"), Some("expr")]), false);
        assert_eq!(mask, vec![false, true]);
    }

    #[test]
    fn positional_overflow_without_dots_routes_through_dots_policy() {
        // Only one formal, no `...`, captured_dots = false: extra positionals
        // are not suppressed.
        let p = ArgPolicy::per_formal(&["x"], &[], false);
        let mask = suppressed_arguments(&p, &labels(&[None, None, None]), false);
        assert_eq!(mask, vec![false, false, false]);
    }

    #[test]
    fn named_then_positional_skips_consumed_formal() {
        // g(b = 1, 2) with formals [a, b], a captured: `b` named -> checked;
        // positional `2` fills `a` (skipping consumed `b`) -> suppressed.
        let p = ArgPolicy::per_formal(&["a", "b"], &["a"], false);
        let mask = suppressed_arguments(&p, &labels(&[Some("b"), None]), false);
        assert_eq!(mask, vec![false, true]);
    }
}
