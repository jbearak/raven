//
// namespace_completion.rs
//
// Completion of a package's exported symbols after a `pkg::` namespace
// qualifier. Typing `dplyr::` offers `mutate`, `filter`, `starwars`, ... each
// attributed `{dplyr}` and resolving to its help topic.
//
// Shape mirrors `file_path_intellisense`: a context type, one `detect_*` entry
// point, and an item builder. The completion handler calls
// `detect_namespace_completion_context` and, on `Some`, returns the items from
// `namespace_completion_items` and short-circuits.
//
// Suppression contract: inside a `::` expression the only valid completions are
// the package's exported names (on the member/RHS side) or package names (on
// the LHS, which is not yet offered). Keywords, local symbols, and call
// parameters are all syntactically invalid around `::`, so a detected context
// ALWAYS short-circuits the handler — even when it yields no items (unknown
// package, or the package/LHS side). Falling through to general completion
// there would offer suggestions that cannot parse (`dplyr::if`, `if::filter`).
//
// Scope: exported symbols only (`::`). Internal access (`:::`) is detected (the
// `internal` flag on `Member`) but intentionally yields no items — internal
// symbols are not stored in the package library and would need an R subprocess.
// The flag is the seam to add them later without touching the handler wiring.

use tower_lsp::lsp_types::{
    CompletionItem, CompletionItemKind, CompletionTextEdit, Position, Range, TextEdit,
};
use tree_sitter::{Node, Point, Tree};

use crate::handlers::SORT_PREFIX_PACKAGE;
use crate::package_library::PackageLibrary;

/// What the cursor's `::` position calls for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NamespaceCompletionContext {
    /// Cursor on the member (RHS) side — offer `package`'s exported symbols.
    /// `internal` is true for `:::` (deferred, so it yields no items).
    /// `replace_range` is the already-typed member token the accepted completion
    /// must overwrite (see [`member_replace_range`]).
    Member {
        package: String,
        internal: bool,
        replace_range: Range,
    },
    /// Cursor on the package (LHS) side of a `::`, including the operator
    /// boundary (`dplyr|::x`). Members are wrong here and keywords/locals are
    /// invalid around `::`, so the handler short-circuits with no completions —
    /// matching the pre-existing behavior and preventing parameter/keyword
    /// leakage inside a qualified call argument (`foo(pkg::bar)`).
    PackageSide,
}

/// Detect whether `point` sits inside a `pkg::` / `pkg:::` expression.
///
/// `node` is the deepest AST node at the cursor and `point` its tree-sitter
/// position (both computed once by the caller). Detection is purely AST-based:
/// it finds the `namespace_operator` enclosing the cursor, or — for an
/// incomplete `pkg::` where the cursor sits just *past* the operator (including
/// past trailing whitespace, as in `pkg:: `) — the one enclosing the nearest
/// token before the cursor. Trailing-whitespace step-back applies only to a
/// member-less operator, so a cursor past a complete `pkg::name ` is correctly
/// treated as outside the expression.
///
/// tree-sitter forms a `namespace_operator` even for an incomplete `pkg::` (and
/// for a quoted/backtick qualifier, whose `lhs` is a `string`/identifier node we
/// unquote), but NOT for a non-name LHS (`a$b::`, `1::` → `extract_operator` /
/// `float` + `ERROR`) nor inside a comment/string (those are `comment`/`string`
/// nodes). So this naturally accepts exactly the valid qualifier shapes and
/// rejects the rest — no text scanning or string/comment guard needed.
///
/// Returns `None` when the cursor is not inside a `::` expression at all.
pub fn detect_namespace_completion_context(
    tree: &Tree,
    node: Node,
    point: Point,
    text: &str,
) -> Option<NamespaceCompletionContext> {
    let ns = enclosing_namespace_operator(node).or_else(|| {
        // Incomplete `pkg::`: the cursor resolves past the operator, so look at
        // the token immediately before it. The cursor may also sit on trailing
        // horizontal whitespace (`pkg:: `, still valid R), so step back over
        // same-line spaces/tabs to reach that token.
        //
        // Crucially, only step over whitespace when the operator has no member
        // yet: a cursor immediately after a partial member (`pkg:: x|`, no
        // space) is editing that member and must resolve, but a cursor past a
        // *complete* member and a space (`pkg::name |`) is past the whole
        // expression — stepping back there would wrongly re-enter it.
        let line = text.lines().nth(point.row)?;
        let bytes = line.as_bytes();
        let c0 = point.column.checked_sub(1)?;
        let stepped_over_whitespace = matches!(bytes.get(c0), Some(b' ' | b'\t'));
        let mut probe_col = c0;
        while matches!(bytes.get(probe_col), Some(b' ' | b'\t')) {
            probe_col = probe_col.checked_sub(1)?;
        }
        let before = Point::new(point.row, probe_col);
        let ns = enclosing_namespace_operator(
            tree.root_node()
                .descendant_for_point_range(before, before)?,
        )?;
        if stepped_over_whitespace && ns.child_by_field_name("rhs").is_some() {
            return None;
        }
        Some(ns)
    })?;
    classify_namespace_cursor(ns, point, text)
}

/// Walk up from `node` to its enclosing `namespace_operator`, if any.
fn enclosing_namespace_operator(node: Node) -> Option<Node> {
    let mut current = node;
    while current.kind() != "namespace_operator" {
        current = current.parent()?;
    }
    Some(current)
}

/// Classify a cursor inside `ns` as member- vs package-side and read the
/// qualifier package (unquoting a `"pkg"` / `` `pkg` `` lhs) and `::` vs `:::`.
fn classify_namespace_cursor(
    ns: Node,
    point: Point,
    text: &str,
) -> Option<NamespaceCompletionContext> {
    let lhs = ns.child_by_field_name("lhs")?;
    // The grammar permits a quoted lhs (`"pkg"::name`, `` `pkg`::name `` — both
    // valid R), whose node text keeps the delimiters; strip them so the package
    // name resolves.
    let package = unquote_package(node_text(lhs, text));
    if package.is_empty() {
        return None;
    }

    // The operator (`::` / `:::`) is the unnamed child between lhs and rhs; only
    // it can read as a double/triple colon (identifiers cannot contain colons).
    let mut walk = ns.walk();
    let op = ns
        .children(&mut walk)
        .find(|c| matches!(node_text(*c, text), "::" | ":::"))?;

    // A cursor at or before the operator end — `dp|lyr::x`, the boundary
    // `dplyr|::x` (node ranges are end-exclusive, so that cursor resolves to the
    // `::` token), or on the operator — is editing the package name.
    let op_end = op.end_position();
    if (point.row, point.column) < (op_end.row, op_end.column) {
        return Some(NamespaceCompletionContext::PackageSide);
    }

    Some(NamespaceCompletionContext::Member {
        package: package.to_string(),
        internal: node_text(op, text) == ":::",
        replace_range: member_replace_range(op_end, point, text),
    })
}

/// The text range an accepted member completion must replace: the member token
/// already typed after the `::`/`:::` operator.
///
/// Emitting an explicit range (consumed as a `text_edit`) rather than relying on
/// the client's word-range default makes the overwrite independent of the
/// client's `wordPattern`, and mirrors the `$`/`@` member path so both
/// member-completion seams behave identically. For a non-syntactic operator
/// member (`%>%`) the range is the empty insert at the operator boundary —
/// detection never forms a context for a half-typed `pkg::%`, so the only way to
/// reach such a member is incremental typing after `pkg::`, and the client
/// extends the overwrite back over the typed `%` on accept (`overwriteBefore =
/// cursor − range.start`), exactly as it would have under the word-range default.
///
/// `op_end` is the end of the `::`/`:::` operator and `point` the cursor (both
/// tree-sitter points with byte columns). The range starts just past the
/// operator — skipping any horizontal whitespace, but never advancing past the
/// cursor — and ends at the cursor, extended rightward over a partially typed
/// *syntactic* identifier (`pkg::fil|ter` replaces all of `filter`). Operator
/// members are only ever typed up to the cursor, so they need no right
/// extension. For the exotic `pkg::`-then-newline split the range is anchored at
/// the cursor instead.
fn member_replace_range(op_end: Point, point: Point, text: &str) -> Range {
    let line = text.lines().nth(point.row).unwrap_or("");
    let bytes = line.as_bytes();
    let cursor = point.column.min(line.len());

    let mut start = if op_end.row == point.row {
        op_end.column.min(cursor)
    } else {
        cursor
    };
    while start < cursor && matches!(bytes.get(start), Some(b' ' | b'\t')) {
        start += 1;
    }

    let mut end = cursor;
    while end < bytes.len() && crate::handlers::is_r_identifier_continue_byte(bytes[end]) {
        end += 1;
    }

    let start_char = crate::utf16::byte_offset_to_utf16_column(line, start);
    let end_char = crate::utf16::byte_offset_to_utf16_column(line, end);
    Range {
        start: Position::new(point.row as u32, start_char),
        end: Position::new(point.row as u32, end_char),
    }
}

/// Build completion items for a detected `pkg::` context.
///
/// Only a member-side `::` context with a resolvable package yields items;
/// `PackageSide`, internal (`:::`), and unknown packages yield an empty `Vec`
/// (the handler still short-circuits — see the module suppression contract).
/// Exports are fetched synchronously via [`PackageLibrary::get_exports_sync`].
/// Each symbol becomes a `FUNCTION` item detailed `{pkg}` and carrying the
/// `{topic, package}` resolve data the existing `completionItem/resolve`
/// handler turns into help docs. Symbols arrive already sorted.
pub fn namespace_completion_items(
    ctx: &NamespaceCompletionContext,
    library: &PackageLibrary,
) -> Vec<CompletionItem> {
    let NamespaceCompletionContext::Member {
        package,
        internal,
        replace_range,
    } = ctx
    else {
        return Vec::new();
    };
    if *internal {
        return Vec::new();
    }
    let Some(exports) = library.get_exports_sync(package) else {
        return Vec::new();
    };
    let package = package.clone();
    let replace_range = *replace_range;
    exports
        .into_iter()
        .map(move |symbol| {
            // A package can export non-syntactic names (operators like `%>%`,
            // exported S3 methods). Accepting `pkg::%>%` would be invalid R, so
            // the inserted text is backtick-quoted (`pkg::`%>%``) via the shared
            // completion rule; a syntactic name inserts verbatim.
            let new_text = crate::handlers::accessor_member_insert_text(&symbol);
            CompletionItem {
                label: symbol.clone(),
                // FUNCTION for every export — the same kind the bare-identifier
                // package-export path uses. The export set mixes functions,
                // datasets, and S4 classes; distinguishing them needs per-symbol
                // type info we don't have synchronously, so we don't try.
                kind: Some(CompletionItemKind::FUNCTION),
                detail: Some(format!("{{{package}}}")),
                sort_text: Some(format!("{SORT_PREFIX_PACKAGE}{symbol}")),
                // An explicit edit (not `insert_text`) so the typed member prefix
                // is always overwritten — even a non-syntactic `%` the client's
                // wordPattern doesn't treat as a word. `filter_text` stays the
                // bare name so a typed prefix (including a leading `%`) matches
                // even when `new_text` is backtick-quoted.
                filter_text: Some(symbol.clone()),
                text_edit: Some(CompletionTextEdit::Edit(TextEdit {
                    range: replace_range,
                    new_text,
                })),
                data: Some(serde_json::json!({
                    "topic": symbol,
                    "package": package.clone(),
                })),
                ..Default::default()
            }
        })
        .collect()
}

/// Strip a single matching pair of surrounding string/backtick delimiters, so a
/// quoted package qualifier (`"dplyr"`, `'dplyr'`, `` `dplyr` ``) resolves to
/// the bare package name. Leaves a plain identifier untouched.
fn unquote_package(raw: &str) -> &str {
    let bytes = raw.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        if matches!(first, b'"' | b'\'' | b'`') && *bytes.last().unwrap() == first {
            return &raw[1..raw.len() - 1];
        }
    }
    raw
}

/// Borrow a node's source text.
fn node_text<'a>(node: Node, text: &'a str) -> &'a str {
    &text[node.byte_range()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower_lsp::lsp_types::Position;

    fn parse_r(code: &str) -> Tree {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&tree_sitter_r::LANGUAGE.into())
            .unwrap();
        parser.parse(code, None).unwrap()
    }

    /// Split a `|`-marked snippet into (code, cursor position).
    fn at(marked: &str) -> (String, Position) {
        let marker = marked.find('|').expect("cursor marker `|`");
        let prefix = &marked[..marker];
        let line = prefix.chars().filter(|&c| c == '\n').count() as u32;
        let line_start = prefix.rfind('\n').map(|i| i + 1).unwrap_or(0);
        let character = prefix[line_start..].encode_utf16().count() as u32;
        let mut code = marked.to_string();
        code.remove(marker);
        (code, Position::new(line, character))
    }

    fn detect(marked: &str) -> Option<NamespaceCompletionContext> {
        let (code, position) = at(marked);
        let tree = parse_r(&code);
        let point = crate::handlers::lsp_position_to_ts_point(&code, position);
        let node = tree
            .root_node()
            .descendant_for_point_range(point, point)
            .unwrap();
        detect_namespace_completion_context(&tree, node, point, &code)
    }

    /// Assert a detected context is a member side for `package` with the given
    /// `internal` flag, ignoring the replace range (covered by its own tests).
    fn assert_member(ctx: Option<NamespaceCompletionContext>, package: &str, internal: bool) {
        match ctx {
            Some(NamespaceCompletionContext::Member {
                package: p,
                internal: i,
                ..
            }) => {
                assert_eq!(p, package, "package");
                assert_eq!(i, internal, "internal");
            }
            other => panic!("expected Member({package}, {internal}), got {other:?}"),
        }
    }

    /// The member replace range a marked snippet detects, as the `[start, end)`
    /// substring of its line — i.e. the text an accepted completion overwrites.
    fn member_replaced_text(marked: &str) -> String {
        let (code, _) = at(marked);
        let line = code.lines().next().unwrap_or("");
        match detect(marked) {
            Some(NamespaceCompletionContext::Member { replace_range, .. }) => {
                let start =
                    crate::utf16::utf16_column_to_byte_offset(line, replace_range.start.character);
                let end =
                    crate::utf16::utf16_column_to_byte_offset(line, replace_range.end.character);
                line[start..end].to_string()
            }
            other => panic!("expected Member, got {other:?}"),
        }
    }

    // ----- detection ------------------------------------------------------

    #[test]
    fn package_side_at_operator_boundary() {
        // Cursor exactly between the package name and `::` (`dplyr|::filter`):
        // node ranges are end-exclusive, so the cursor resolves to the `::`
        // token, but it is still the package side.
        assert_eq!(
            detect("dplyr|::filter"),
            Some(NamespaceCompletionContext::PackageSide)
        );
    }

    #[test]
    fn package_side_inside_package_name() {
        assert_eq!(
            detect("dp|lyr::filter"),
            Some(NamespaceCompletionContext::PackageSide)
        );
    }

    #[test]
    fn detects_complete_ast_member_side() {
        assert_member(detect("dplyr::fil|ter"), "dplyr", false);
    }

    #[test]
    fn unquotes_string_package_qualifier() {
        // `"pkg"::name` is valid R; the package name must drop its quotes.
        assert_member(detect("\"dplyr\"::fil|ter"), "dplyr", false);
    }

    #[test]
    fn unquotes_backtick_package_qualifier() {
        assert_member(detect("`dplyr`::fil|ter"), "dplyr", false);
    }

    #[test]
    fn unquotes_incomplete_string_package_qualifier() {
        // Incomplete quoted qualifier (no member yet) still resolves — the
        // `namespace_operator` forms with a `string` lhs.
        assert_member(detect("\"dplyr\"::|"), "dplyr", false);
    }

    #[test]
    fn no_context_for_member_access_before_colons() {
        // `a$b::` is not a package qualifier (the lhs is an extract expression,
        // which never forms a namespace_operator) — must not attribute `{b}`.
        assert_eq!(detect("a$b::|"), None);
    }

    #[test]
    fn no_context_for_numeric_before_colons() {
        // `1::` is not valid R; the numeric lhs never forms a namespace_operator.
        assert_eq!(detect("1::|"), None);
    }

    #[test]
    fn detects_incomplete_double_colon() {
        assert_member(detect("dplyr::|"), "dplyr", false);
    }

    #[test]
    fn detects_incomplete_triple_colon_as_internal() {
        assert_member(detect("dplyr:::|"), "dplyr", true);
    }

    #[test]
    fn detects_complete_triple_colon_as_internal() {
        assert_member(detect("dplyr:::int|ernal"), "dplyr", true);
    }

    #[test]
    fn no_context_for_plain_identifier() {
        assert_eq!(detect("x <- foo|"), None);
    }

    #[test]
    fn no_context_for_empty_package() {
        assert_eq!(detect("::|"), None);
    }

    #[test]
    fn detects_incomplete_double_colon_with_trailing_whitespace() {
        // `stats:: ` (a space after the operator, no member yet) is valid R and
        // a real qualifier context. The cursor sits past the operator on
        // whitespace, so the fallback must step back over the space to reach the
        // `::` token. (`stats::x` already works because the rhs node spans the
        // cursor; the no-member-yet form is the gap.)
        assert_member(detect("stats:: |"), "stats", false);
        assert_member(detect("stats::  |"), "stats", false);
        assert_member(detect("stats:::  |"), "stats", true);
    }

    // ----- member replace range -------------------------------------------

    #[test]
    fn no_context_for_partial_operator_member() {
        // tree-sitter does not form a `namespace_operator` for a half-typed
        // non-syntactic member (`pkg::%`, `pkg::%>`), so a *fresh* request there
        // yields no context (and no completions) — never a wrong insert. The
        // operator member is reachable only by incremental typing after `pkg::`,
        // where the request fired at the operator boundary with an empty range
        // and the client extends the overwrite back over the typed `%` on accept.
        assert_eq!(detect("magrittr::%|"), None);
        assert_eq!(detect("magrittr::%>|"), None);
        assert_eq!(detect("magrittr::%>%|"), None);
    }

    #[test]
    fn replace_range_covers_partial_syntactic_name_both_sides() {
        // A cursor mid-identifier replaces the whole token, not just the prefix.
        assert_eq!(member_replaced_text("dplyr::fil|ter"), "filter");
        assert_eq!(member_replaced_text("dplyr::fil|"), "fil");
    }

    #[test]
    fn replace_range_empty_when_no_member_typed() {
        // Nothing typed after `::` → an empty range at the cursor (pure insert).
        assert_eq!(member_replaced_text("dplyr::|"), "");
    }

    #[test]
    fn replace_range_skips_leading_whitespace() {
        // `stats:: ` — the range must not swallow the space before the cursor;
        // it stays an empty insert at the cursor.
        assert_eq!(member_replaced_text("stats:: |"), "");
        assert_eq!(member_replaced_text("stats:: med|ian"), "median");
    }

    #[test]
    fn trailing_whitespace_walk_does_not_overreach() {
        // The whitespace step-back must not turn an unrelated trailing space into
        // a namespace context: a plain identifier or expression followed by a
        // space is still not a `::` context.
        assert_eq!(detect("foo |"), None);
        assert_eq!(detect("x <- 1 |"), None);
        assert_eq!(detect("stats::median |"), None);
    }

    #[test]
    fn no_context_inside_namespaced_call_args() {
        // Inside `dplyr::filter(<args>)` we are completing arguments, not a
        // member of the package — parameter completion owns this.
        assert_eq!(detect("dplyr::filter(x|)"), None);
    }

    #[test]
    fn no_context_inside_comment() {
        // `:` is a completion trigger, so `pkg::` in a comment fires a request;
        // the raw-text fallback must not treat prose as a namespace operator.
        assert_eq!(detect("# see dplyr::|"), None);
    }

    #[test]
    fn no_context_inside_string() {
        assert_eq!(detect("x <- \"dplyr::|\""), None);
    }

    #[test]
    fn no_context_inside_unterminated_string() {
        // No closing quote: tree-sitter error-recovers. The cursor is still
        // inside string content, so `::` must not be treated as an operator.
        assert_eq!(detect("x <- \"dplyr::|"), None);
    }

    #[test]
    fn no_context_inside_raw_string() {
        // R raw string `r"(...)"` — a distinct node kind the canonical
        // string/comment predicate still matches via `.contains("string")`.
        assert_eq!(detect("x <- r\"(dplyr::|)\""), None);
    }

    // ----- item building --------------------------------------------------

    #[tokio::test]
    async fn items_for_cached_package() {
        use crate::package_library::PackageInfo;
        let library = PackageLibrary::new_empty();
        library
            .insert_package(PackageInfo::new(
                "dplyr".to_string(),
                std::collections::HashSet::from(["mutate".to_string(), "filter".to_string()]),
            ))
            .await;

        let range = Range::new(Position::new(0, 7), Position::new(0, 10));
        let ctx = NamespaceCompletionContext::Member {
            package: "dplyr".to_string(),
            internal: false,
            replace_range: range,
        };
        let items = namespace_completion_items(&ctx, &library);
        let labels: Vec<&str> = items.iter().map(|i| i.label.as_str()).collect();
        assert_eq!(labels, vec!["filter", "mutate"]); // sorted

        let filter = items.iter().find(|i| i.label == "filter").unwrap();
        assert_eq!(filter.kind, Some(CompletionItemKind::FUNCTION));
        assert_eq!(filter.detail.as_deref(), Some("{dplyr}"));
        assert_eq!(filter.sort_text.as_deref(), Some("4-filter"));
        // A syntactic export inserts its bare name through an edit over the
        // detected member range; `insert_text` is unused.
        assert_eq!(filter.insert_text, None);
        assert_eq!(
            filter.text_edit,
            Some(CompletionTextEdit::Edit(TextEdit {
                range,
                new_text: "filter".to_string(),
            }))
        );
        assert_eq!(
            filter.data,
            Some(serde_json::json!({ "topic": "filter", "package": "dplyr" }))
        );
    }

    #[tokio::test]
    async fn non_syntactic_export_is_backtick_quoted_on_insert() {
        // A package can export operators (`%>%`) and other non-syntactic names.
        // Accepting `magrittr::%>%` would produce invalid R; the inserted text
        // must be backtick-quoted (`magrittr::`%>%``) while the label stays bare
        // for display/filtering. A syntactic export is inserted verbatim.
        use crate::package_library::PackageInfo;
        let library = PackageLibrary::new_empty();
        library
            .insert_package(PackageInfo::new(
                "magrittr".to_string(),
                std::collections::HashSet::from(["%>%".to_string(), "set_names".to_string()]),
            ))
            .await;

        let range = Range::new(Position::new(0, 10), Position::new(0, 11));
        let ctx = NamespaceCompletionContext::Member {
            package: "magrittr".to_string(),
            internal: false,
            replace_range: range,
        };
        let items = namespace_completion_items(&ctx, &library);

        let op = items.iter().find(|i| i.label == "%>%").unwrap();
        assert_eq!(
            op.text_edit,
            Some(CompletionTextEdit::Edit(TextEdit {
                range,
                new_text: "`%>%`".to_string(),
            })),
            "non-syntactic export edits in backtick-quoted text over the member range"
        );
        assert_eq!(op.insert_text, None, "edit supersedes insert_text");
        assert_eq!(
            op.filter_text.as_deref(),
            Some("%>%"),
            "filter text stays the bare name so typing `%` still matches"
        );

        // A syntactic export inserts its bare name verbatim through the edit.
        let plain = items.iter().find(|i| i.label == "set_names").unwrap();
        assert_eq!(
            plain.text_edit,
            Some(CompletionTextEdit::Edit(TextEdit {
                range,
                new_text: "set_names".to_string(),
            }))
        );
        assert_eq!(plain.insert_text, None);
    }

    #[test]
    fn no_items_for_internal_context() {
        let library = PackageLibrary::new_empty();
        let ctx = NamespaceCompletionContext::Member {
            package: "dplyr".to_string(),
            internal: true,
            replace_range: Range::default(),
        };
        assert!(namespace_completion_items(&ctx, &library).is_empty());
    }

    #[test]
    fn no_items_for_package_side() {
        let library = PackageLibrary::new_empty();
        assert!(
            namespace_completion_items(&NamespaceCompletionContext::PackageSide, &library)
                .is_empty()
        );
    }

    #[test]
    fn no_items_for_unknown_package() {
        let library = PackageLibrary::new_empty();
        let ctx = NamespaceCompletionContext::Member {
            package: "nopkg".to_string(),
            internal: false,
            replace_range: Range::default(),
        };
        assert!(namespace_completion_items(&ctx, &library).is_empty());
    }
}
