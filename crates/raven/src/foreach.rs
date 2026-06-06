//! Syntax-based recognition of `foreach(...) %do% expr` and
//! `foreach(...) %dopar% expr` execution expressions (issue #404), including
//! nested compositions joined by the `%:%` operator and `when(...)` filters
//! (issue #406).
//!
//! `foreach` is not a language construct: it parses as a `call` to `foreach`
//! whose result is fed to the special infix operator `%do%`/`%dopar%`. The
//! iterator variables are the *named* arguments of the `foreach(...)` call
//! (`foreach(i = 1:10)`), and they must be visible only inside the executed
//! right-hand-side expression.
//!
//! The left side of `%do%`/`%dopar%` may also be a *composition*: a `%:%` chain
//! of `foreach(...)` calls and `when(...)` filters
//! (`foreach(i = 1:3) %:% when(i %% 2 == 0) %:% foreach(j = 1:3) %do% i + j`).
//! Every foreach call in the chain contributes iterators, and they are visible
//! across the whole composition — inside `when(...)` filters and later iterator
//! value expressions, as well as the executed body. `when(...)` is a filter, not
//! an iterator source, so it contributes no iterators of its own.
//!
//! This recognizer is deliberately **syntax-only**: it never consults live
//! package metadata, so it works the same in the editor and the CLI. It is
//! shared by scope construction (`cross_file::scope`, which turns a recognized
//! execution into a synthetic iterator scope spanning the executed body — and,
//! for compositions, the whole left-hand side; see [`ForeachExecution`]) and is
//! available to diagnostic collection if a collector-only gap ever appears. A
//! user-defined function also named `foreach` (or `when`) is treated as the
//! real one; that lookalike can be revisited if it causes real-world false
//! positives, but #404 is a regression in the standard idiom.

use tree_sitter::Node;

/// A recognized `foreach(...) %do%/%dopar% rhs` execution expression.
pub struct ForeachExecution<'tree> {
    /// The executed right-hand-side expression — the immediate `rhs` field of
    /// the `%do%`/`%dopar%` `binary_operator`. Often a `braced_expression`, but
    /// may be any expression (e.g. `sqrt(i)`).
    pub rhs: Node<'tree>,
    /// The node where the iterator scope begins.
    ///
    /// For a simple `foreach(...) %do% body` this is `rhs` (issue #404): the
    /// iterators are visible only inside the executed expression. For a composed
    /// `foreach(...) %:% when(...) %:% foreach(...) %do% body` (issue #406), this
    /// is the whole left-hand `%:%` composition, so the iterators are also
    /// visible inside `when(...)` filters and later iterator value expressions
    /// (e.g. an inner `foreach(j = seq_len(i))` that references an outer
    /// iterator) — the realistic cross-reference idiom we must not false-flag.
    ///
    /// The deliberate cost of spanning the whole composition: any symbol
    /// *assigned* inside a left iterator-value expression (the pathological
    /// `foreach(i = { x <- 1; 1:3 }) %:% ...`) is treated as scoped to the loop
    /// and so does not leak past it. We accept that over the alternative —
    /// scoping only the body and `when()` filters, which would reintroduce
    /// false "undefined variable" positives on the common cross-reference case.
    pub scope_start: Node<'tree>,
    /// The `name`-field identifier nodes of the iterator arguments — the named,
    /// non-dot arguments of every `foreach(...)` call in the composition. Each
    /// node's position is the `i` in `foreach(i = ...)`, suitable as the
    /// iterator's definition site.
    pub iterators: Vec<Node<'tree>>,
}

/// Recognize whether `node` is a foreach execution expression.
///
/// Returns the executed RHS node, the scope-start node, and the iterator name
/// nodes when `node` is a `binary_operator` with operator text `%do%` or
/// `%dopar%` whose left side is a foreach *composition*:
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

    // The infix operator token has kind `special`; its *text* distinguishes
    // `%do%`/`%dopar%` from every other `%...%` operator, so match on the text.
    let operator = node.child_by_field_name("operator")?;
    let op_text = &text[operator.byte_range()];
    if op_text != "%do%" && op_text != "%dopar%" {
        return None;
    }

    let lhs = node.child_by_field_name("lhs")?;
    let rhs = node.child_by_field_name("rhs")?;

    let mut iterators = Vec::new();
    if !collect_composition_iterators(lhs, text, &mut iterators)? {
        // A valid composition that contains no `foreach(...)` call (e.g. a bare
        // `when(...) %do% body`) is not a foreach execution.
        return None;
    }

    // A simple `foreach(...) %do% body` scopes the iterators to the body only
    // (#404). A composed `foreach(...) %:% ...` left side may carry `when(...)`
    // filters and cross-references that must also see the iterators, so the
    // scope spans the whole composition (#406).
    let scope_start = if is_colon_chain(lhs, text) { lhs } else { rhs };

    Some(ForeachExecution {
        rhs,
        scope_start,
        iterators,
    })
}

/// Walk a foreach *composition* on the left of `%do%`/`%dopar%`, appending the
/// iterator name nodes of every `foreach(...)` call to `iterators`.
///
/// A composition is a single `foreach(...)` call, a `when(...)` filter, or a
/// `%:%` chain of such. Returns `Some(saw_foreach)` — whether at least one
/// `foreach(...)` call was found — or `None` if `node` is not a valid
/// composition (an operand that is neither `foreach`, `when`, nor a `%:%` chain
/// rejects the whole left side). A `when(...)` filter is valid but yields no
/// iterators.
fn collect_composition_iterators<'tree>(
    node: Node<'tree>,
    text: &str,
    iterators: &mut Vec<Node<'tree>>,
) -> Option<bool> {
    if is_foreach_package_call(node, text, "foreach") {
        iterators.extend(iterator_name_nodes(node, text));
        return Some(true);
    }
    if is_foreach_package_call(node, text, "when") {
        return Some(false);
    }
    if is_colon_chain(node, text) {
        let lhs = node.child_by_field_name("lhs")?;
        let rhs = node.child_by_field_name("rhs")?;
        let left = collect_composition_iterators(lhs, text, iterators)?;
        let right = collect_composition_iterators(rhs, text, iterators)?;
        return Some(left || right);
    }
    None
}

/// Whether `node` is a `binary_operator` whose operator is the foreach nesting
/// operator `%:%` — the single source of truth for "this is a `%:%` composition
/// node", shared by composition collection and the scope-start decision.
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

    fn iterator_names(exec: &ForeachExecution, text: &str) -> Vec<String> {
        exec.iterators
            .iter()
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
        assert_eq!(exec.rhs.kind(), "braced_expression");
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
        assert!(exec.iterators.is_empty());
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
    fn composition_scope_start_covers_when_filter() {
        // For a composed execution, the scope must begin at the start of the
        // whole left composition (so `when(...)` filters see the iterators),
        // not at the `%do%` rhs.
        let code = "foreach(i = 1:3) %:% when(i %% 2 == 0) %do% i";
        let tree = parse(code);
        let exec_node = find_foreach_execution(tree.root_node(), code).unwrap();
        let exec = recognize_foreach_execution(exec_node, code).unwrap();
        // scope_start is the `%:%` lhs composition, which begins at byte 0.
        assert_eq!(exec.scope_start.start_byte(), 0);
    }

    #[test]
    fn simple_execution_scope_start_is_rhs() {
        // A plain `foreach(...) %do% body` keeps #404 behavior: the scope starts
        // at the rhs, not the foreach call.
        let code = "foreach(i = 1:10) %do% { print(i) }";
        let tree = parse(code);
        let binop = first_binary_operator(tree.root_node()).unwrap();
        let exec = recognize_foreach_execution(binop, code).unwrap();
        assert_eq!(exec.scope_start.id(), exec.rhs.id());
    }
}
