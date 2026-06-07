//! Syntax-based recognition of `foreach(...) %do% expr` and
//! `foreach(...) %dopar% expr` execution expressions (issue #404) — and the
//! drop-in operators other packages register to drive `foreach(...)`: doRNG's
//! `%dorng%` and doFuture's `%dofuture%` (issue #410) — including nested
//! compositions joined by the `%:%` operator and `when(...)` filters (issue
//! #406).
//!
//! `foreach` is not a language construct: it parses as a `call` to `foreach`
//! whose result is fed to a special infix execution operator (`%do%`, `%dopar%`,
//! `%dorng%`, or `%dofuture%`). The iterator variables are the *named* arguments
//! of the `foreach(...)` call (`foreach(i = 1:10)`), and they must be visible
//! only inside the executed right-hand-side expression.
//!
//! The left side of the execution operator may also be a *composition*: a `%:%` chain
//! of `foreach(...)` calls and `when(...)` filters
//! (`foreach(i = 1:3) %:% when(i %% 2 == 0) %:% foreach(j = 1:3) %do% i + j`).
//! Every foreach call in the chain contributes iterators. Binding is
//! left-to-right, matching R: each iterator is visible from *its own*
//! `foreach(...)` call onward — inside later `when(...)` filters, later iterator
//! value expressions (the realistic `foreach(j = seq_len(i))` cross-reference),
//! and the executed body — but not in anything to its left, where R itself
//! raises "object not found". `when(...)` is a filter, not an iterator source,
//! so it contributes no iterators of its own.
//!
//! This recognizer is deliberately **syntax-only**: it never consults live
//! package metadata, so it works the same in the editor and the CLI. It is
//! shared by scope construction (`cross_file::scope`, which turns each
//! `foreach(...)` call into a synthetic iterator scope spanning from the end of
//! that call through the executed body; see [`ForeachExecution`]) and is
//! available to diagnostic collection if a collector-only gap ever appears. A
//! user-defined function also named `foreach` (or `when`) is treated as the
//! real one; that lookalike can be revisited if it causes real-world false
//! positives, but #404 is a regression in the standard idiom.

use tree_sitter::Node;

/// A recognized `foreach(...) %do%/%dopar%/%dorng%/%dofuture% rhs` execution
/// expression.
pub struct ForeachExecution<'tree> {
    /// One group per `foreach(...)` call in the composition, in left-to-right
    /// source order. A simple `foreach(...) %do% body` has exactly one group;
    /// a `%:%` chain (issue #406) has one per foreach call. `when(...)` filters
    /// are not iterator sources and produce no group.
    ///
    /// Each group's iterators are scoped from the end of *its own* `foreach(...)`
    /// call through the executed body. Modeling per-call (rather than one scope
    /// over the whole composition) reproduces foreach's left-to-right binding
    /// order: an iterator is visible in later `when(...)` filters, later iterator
    /// value expressions (the realistic `foreach(j = seq_len(i))` cross-reference
    /// idiom), and the body — but not in anything to its left, where R itself
    /// raises "object not found".
    pub iterator_groups: Vec<ForeachIteratorGroup<'tree>>,
}

/// The iterators contributed by a single `foreach(...)` call in a composition.
pub struct ForeachIteratorGroup<'tree> {
    /// The `foreach(...)` call node. Its *end* is where these iterators start
    /// being visible — so they do not leak into the call's own value expressions
    /// (`foreach(i = 1:i)` does not see `i`) nor anything to its left.
    pub call: Node<'tree>,
    /// The `name`-field identifier nodes of this call's iterator arguments — its
    /// named, non-dot arguments. Each node's position is the `i` in
    /// `foreach(i = ...)`, suitable as the iterator's definition site. Empty for
    /// a foreach call carrying only dot-control arguments.
    pub iterators: Vec<Node<'tree>>,
}

/// Recognize whether `node` is a foreach execution expression.
///
/// Returns the per-call iterator groups when `node` is a `binary_operator` whose
/// operator is one of the foreach execution operators — `%do%`, `%dopar%`,
/// `%dorng%` (doRNG), or `%dofuture%` (doFuture) — and whose left side is a
/// foreach *composition*:
///
/// - a single call to bare `foreach(...)` or namespace-qualified
///   `foreach::foreach(...)` / `foreach:::foreach(...)` (issue #404);
/// - a `%:%` chain of `foreach(...)` calls and `when(...)` filters, with at
///   least one `foreach(...)` call (issue #406).
///
/// Otherwise `None`.
///
/// `text` is the full document text; tree-sitter byte ranges index into it.
pub fn recognize_foreach_execution<'tree>(
    node: Node<'tree>,
    text: &str,
) -> Option<ForeachExecution<'tree>> {
    if node.kind() != "binary_operator" {
        return None;
    }

    // The infix operator token has kind `special`; its *text* distinguishes the
    // foreach execution operators (enumerated in the `matches!` below) from every
    // other `%...%` operator, so match on the text.
    let operator = node.child_by_field_name("operator")?;
    let op_text = &text[operator.byte_range()];
    if !matches!(op_text, "%do%" | "%dopar%" | "%dorng%" | "%dofuture%") {
        return None;
    }

    let lhs = node.child_by_field_name("lhs")?;

    let mut iterator_groups = Vec::new();
    if !collect_composition_groups(lhs, text, &mut iterator_groups)? {
        // A valid composition that contains no `foreach(...)` call (e.g. a bare
        // `when(...) %do% body`) is not a foreach execution.
        return None;
    }

    Some(ForeachExecution { iterator_groups })
}

/// Walk a foreach *composition* on the left of `%do%`/`%dopar%`, appending a
/// [`ForeachIteratorGroup`] for every `foreach(...)` call to `groups` in
/// left-to-right source order.
///
/// A composition is a single `foreach(...)` call, a `when(...)` filter, or a
/// `%:%` chain of such. Returns `Some(saw_foreach)` — whether at least one
/// `foreach(...)` call was found — or `None` if `node` is not a valid
/// composition (an operand that is neither `foreach`, `when`, nor a `%:%` chain
/// rejects the whole left side). A `when(...)` filter is valid but yields no
/// group.
fn collect_composition_groups<'tree>(
    node: Node<'tree>,
    text: &str,
    groups: &mut Vec<ForeachIteratorGroup<'tree>>,
) -> Option<bool> {
    if is_foreach_package_call(node, text, "foreach") {
        groups.push(ForeachIteratorGroup {
            call: node,
            iterators: iterator_name_nodes(node, text),
        });
        return Some(true);
    }
    if is_foreach_package_call(node, text, "when") {
        return Some(false);
    }
    if is_colon_chain(node, text) {
        // `%:%` is left-associative, so recursing lhs before rhs appends groups
        // in source order.
        let lhs = node.child_by_field_name("lhs")?;
        let rhs = node.child_by_field_name("rhs")?;
        let left = collect_composition_groups(lhs, text, groups)?;
        let right = collect_composition_groups(rhs, text, groups)?;
        return Some(left || right);
    }
    None
}

/// Whether `node` is a `binary_operator` whose operator is the foreach nesting
/// operator `%:%` — the single source of truth for "this is a `%:%` composition
/// node".
fn is_colon_chain(node: Node, text: &str) -> bool {
    node.kind() == "binary_operator"
        && node
            .child_by_field_name("operator")
            .map(|op| &text[op.byte_range()])
            == Some("%:%")
}

/// Whether `node` is a `call` to the bare function `name` or its
/// namespace-qualified `foreach::name` / `foreach:::name` form — both
/// `foreach(...)` and `when(...)` are exports of the `foreach` package.
fn is_foreach_package_call(node: Node, text: &str, name: &str) -> bool {
    if node.kind() != "call" {
        return false;
    }
    let Some(func) = node.child_by_field_name("function") else {
        return false;
    };
    match func.kind() {
        "identifier" => &text[func.byte_range()] == name,
        // `pkg::name` and `pkg:::name` share the `namespace_operator` shape; we
        // do not distinguish `::` from `:::` because both name the same export.
        "namespace_operator" => {
            func.child_by_field_name("lhs")
                .map(|n| &text[n.byte_range()])
                == Some("foreach")
                && func
                    .child_by_field_name("rhs")
                    .map(|n| &text[n.byte_range()])
                    == Some(name)
        }
        _ => false,
    }
}

/// Collect the `name`-field identifier nodes of the iterator arguments of a
/// `foreach(...)` call: named arguments whose name is a valid `identifier` and
/// does not start with `.`. Dot-prefixed names (`.combine`, `.packages`,
/// `.export`, `.noexport`, `.verbose`, …) are control arguments, not iterators.
fn iterator_name_nodes<'tree>(call: Node<'tree>, text: &str) -> Vec<Node<'tree>> {
    let mut out = Vec::new();
    let Some(args) = call.child_by_field_name("arguments") else {
        return out;
    };
    let mut cursor = args.walk();
    for arg in args
        .children(&mut cursor)
        .filter(|c| c.kind() == "argument")
    {
        if let Some(name) = arg.child_by_field_name("name")
            && name.kind() == "identifier"
            && !text[name.byte_range()].starts_with('.')
        {
            out.push(name);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse(code: &str) -> tree_sitter::Tree {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_r::LANGUAGE.into())
            .unwrap();
        parser.parse(code, None).unwrap()
    }

    /// Find the first node (preorder) satisfying `pred`.
    fn find_node<'tree>(node: Node<'tree>, pred: &impl Fn(Node) -> bool) -> Option<Node<'tree>> {
        if pred(node) {
            return Some(node);
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if let Some(found) = find_node(child, pred) {
                return Some(found);
            }
        }
        None
    }

    /// Find the first `binary_operator` node in document order.
    fn first_binary_operator(node: Node) -> Option<Node> {
        find_node(node, &|n| n.kind() == "binary_operator")
    }

    /// All iterator names across every group, in source order.
    fn iterator_names(exec: &ForeachExecution, text: &str) -> Vec<String> {
        exec.iterator_groups
            .iter()
            .flat_map(|g| g.iterators.iter())
            .map(|n| text[n.byte_range()].to_string())
            .collect()
    }

    #[test]
    fn recognizes_do_with_single_iterator() {
        let code = "foreach(i = 1:10) %do% { print(i) }";
        let tree = parse(code);
        let binop = first_binary_operator(tree.root_node()).unwrap();
        let exec = recognize_foreach_execution(binop, code).expect("should recognize %do%");
        assert_eq!(iterator_names(&exec, code), vec!["i"]);
    }

    #[test]
    fn recognizes_dopar() {
        let code = "foreach(i = 1:10) %dopar% sqrt(i)";
        let tree = parse(code);
        let binop = first_binary_operator(tree.root_node()).unwrap();
        let exec = recognize_foreach_execution(binop, code).expect("should recognize %dopar%");
        assert_eq!(iterator_names(&exec, code), vec!["i"]);
    }

    #[test]
    fn recognizes_dorng() {
        // doRNG's `%dorng%` drives foreach the same way `%dopar%` does
        // (reproducible parallel RNG); issue #410.
        let code = "foreach(i = 1:10) %dorng% sqrt(i)";
        let tree = parse(code);
        let binop = first_binary_operator(tree.root_node()).unwrap();
        let exec = recognize_foreach_execution(binop, code).expect("should recognize %dorng%");
        assert_eq!(iterator_names(&exec, code), vec!["i"]);
    }

    #[test]
    fn recognizes_dofuture() {
        // doFuture's `%dofuture%` drives foreach via a future plan; issue #410.
        let code = "foreach(i = 1:10) %dofuture% sqrt(i)";
        let tree = parse(code);
        let binop = first_binary_operator(tree.root_node()).unwrap();
        let exec = recognize_foreach_execution(binop, code).expect("should recognize %dofuture%");
        assert_eq!(iterator_names(&exec, code), vec!["i"]);
    }

    #[test]
    fn collects_multiple_iterators_and_skips_dot_controls() {
        let code = "foreach(i = 1:3, j = 4:6, .combine = c) %do% i + j";
        let tree = parse(code);
        // The whole expression parses as `(foreach(...) %do% i) + j`, so the
        // foreach execution is the *inner* binary_operator.
        let inner = find_foreach_execution(tree.root_node(), code).unwrap();
        let exec = recognize_foreach_execution(inner, code).unwrap();
        assert_eq!(iterator_names(&exec, code), vec!["i", "j"]);
    }

    #[test]
    fn recognizes_namespace_qualified_foreach() {
        for code in [
            "foreach::foreach(i = 1:3) %do% i",
            "foreach:::foreach(i = 1:3) %do% i",
        ] {
            let tree = parse(code);
            let binop = first_binary_operator(tree.root_node()).unwrap();
            let exec =
                recognize_foreach_execution(binop, code).expect("namespace foreach recognized");
            assert_eq!(iterator_names(&exec, code), vec!["i"]);
        }
    }

    #[test]
    fn rejects_other_special_operators() {
        let code = "foreach(i = 1:3) %xyz% i";
        let tree = parse(code);
        let binop = first_binary_operator(tree.root_node()).unwrap();
        assert!(recognize_foreach_execution(binop, code).is_none());
    }

    #[test]
    fn rejects_non_foreach_lhs() {
        let code = "other_foreach(i = 1:3) %do% i";
        let tree = parse(code);
        let binop = first_binary_operator(tree.root_node()).unwrap();
        assert!(recognize_foreach_execution(binop, code).is_none());
    }

    #[test]
    fn ignores_positional_arguments() {
        let code = "foreach(1:3) %do% i";
        let tree = parse(code);
        let binop = first_binary_operator(tree.root_node()).unwrap();
        let exec = recognize_foreach_execution(binop, code).unwrap();
        // One group (the foreach call) carrying no iterators.
        assert_eq!(exec.iterator_groups.len(), 1);
        assert!(exec.iterator_groups[0].iterators.is_empty());
    }

    /// Walk the tree to find the first node recognized as a foreach execution.
    fn find_foreach_execution<'tree>(node: Node<'tree>, text: &str) -> Option<Node<'tree>> {
        find_node(node, &|n| recognize_foreach_execution(n, text).is_some())
    }

    // Issue #406: nested foreach composition with `%:%` and `when()` filters.

    #[test]
    fn recognizes_nested_foreach_composition() {
        // `foreach(i) %:% foreach(j) %do% i + j` parses as
        // `((foreach %:% foreach) %do% i) + j`, so the execution is the inner
        // `%do%` binary_operator.
        let code = "foreach(i = 1:3) %:% foreach(j = 1:3) %do% i + j";
        let tree = parse(code);
        let exec_node = find_foreach_execution(tree.root_node(), code).unwrap();
        let exec = recognize_foreach_execution(exec_node, code).unwrap();
        assert_eq!(iterator_names(&exec, code), vec!["i", "j"]);
    }

    #[test]
    fn recognizes_when_filter_composition() {
        let code = "foreach(i = 1:3) %:% when(i %% 2 == 0) %do% i";
        let tree = parse(code);
        let exec_node = find_foreach_execution(tree.root_node(), code).unwrap();
        let exec = recognize_foreach_execution(exec_node, code).unwrap();
        // `when(...)` contributes no iterators; only the foreach call does.
        assert_eq!(iterator_names(&exec, code), vec!["i"]);
    }

    #[test]
    fn collects_iterators_across_when_and_multiple_foreach() {
        let code = "foreach(i = 1:3) %:% when(i %% 2 == 0) %:% foreach(j = 1:3) %do% i + j";
        let tree = parse(code);
        let exec_node = find_foreach_execution(tree.root_node(), code).unwrap();
        let exec = recognize_foreach_execution(exec_node, code).unwrap();
        assert_eq!(iterator_names(&exec, code), vec!["i", "j"]);
    }

    #[test]
    fn rejects_when_only_composition_without_foreach() {
        // `when(...)` alone on the left of `%do%` is not a foreach execution.
        let code = "when(i %% 2 == 0) %do% i";
        let tree = parse(code);
        let binop = first_binary_operator(tree.root_node()).unwrap();
        assert!(recognize_foreach_execution(binop, code).is_none());
    }

    #[test]
    fn rejects_non_foreach_operand_in_colon_chain() {
        // A `%:%` chain whose left side is neither foreach, when, nor another
        // `%:%` chain is not a recognized composition.
        let code = "other(i = 1:3) %:% foreach(j = 1:3) %do% i + j";
        let tree = parse(code);
        let exec_node = find_node(tree.root_node(), &|n| {
            n.kind() == "binary_operator"
                && n.child_by_field_name("operator")
                    .map(|o| &code[o.byte_range()])
                    == Some("%do%")
        })
        .unwrap();
        assert!(recognize_foreach_execution(exec_node, code).is_none());
    }

    #[test]
    fn groups_are_per_foreach_call_in_source_order() {
        // Each `foreach(...)` call is its own group, in left-to-right order;
        // `when(...)` produces no group.
        let code = "foreach(i = 1:3) %:% when(i %% 2 == 0) %:% foreach(j = 1:3) %do% i + j";
        let tree = parse(code);
        let exec_node = find_foreach_execution(tree.root_node(), code).unwrap();
        let exec = recognize_foreach_execution(exec_node, code).unwrap();

        assert_eq!(exec.iterator_groups.len(), 2);
        // First group is the left foreach (its call starts at byte 0).
        assert_eq!(exec.iterator_groups[0].call.start_byte(), 0);
        let g0: Vec<_> = exec.iterator_groups[0]
            .iterators
            .iter()
            .map(|n| &code[n.byte_range()])
            .collect();
        let g1: Vec<_> = exec.iterator_groups[1]
            .iterators
            .iter()
            .map(|n| &code[n.byte_range()])
            .collect();
        assert_eq!(g0, vec!["i"]);
        assert_eq!(g1, vec!["j"]);
        // The second group's call begins after the first (source order).
        assert!(
            exec.iterator_groups[1].call.start_byte() > exec.iterator_groups[0].call.start_byte()
        );
    }

    #[test]
    fn simple_execution_has_single_group() {
        let code = "foreach(i = 1:10) %do% { print(i) }";
        let tree = parse(code);
        let binop = first_binary_operator(tree.root_node()).unwrap();
        let exec = recognize_foreach_execution(binop, code).unwrap();
        assert_eq!(exec.iterator_groups.len(), 1);
        assert_eq!(iterator_names(&exec, code), vec!["i"]);
    }
}
