//! Syntax-based recognition of `foreach(...) %do% expr` and
//! `foreach(...) %dopar% expr` execution expressions (issue #404).
//!
//! `foreach` is not a language construct: it parses as a `call` to `foreach`
//! whose result is fed to the special infix operator `%do%`/`%dopar%`. The
//! iterator variables are the *named* arguments of the `foreach(...)` call
//! (`foreach(i = 1:10)`), and they must be visible only inside the executed
//! right-hand-side expression.
//!
//! This recognizer is deliberately **syntax-only**: it never consults live
//! package metadata, so it works the same in the editor and the CLI. It is
//! shared by scope construction (`cross_file::scope`, which turns a recognized
//! execution into a synthetic RHS-only scope) and is available to diagnostic
//! collection if a collector-only gap ever appears. A user-defined function
//! also named `foreach` is treated as the real one; that lookalike can be
//! revisited if it causes real-world false positives, but #404 is a regression
//! in the standard idiom.

use tree_sitter::Node;

/// A recognized `foreach(...) %do%/%dopar% rhs` execution expression.
pub struct ForeachExecution<'tree> {
    /// The executed right-hand-side expression — the immediate `rhs` field of
    /// the `%do%`/`%dopar%` `binary_operator`. Often a `braced_expression`, but
    /// may be any expression (e.g. `sqrt(i)`).
    pub rhs: Node<'tree>,
    /// The `name`-field identifier nodes of the iterator arguments — the named,
    /// non-dot arguments of the `foreach(...)` call. Each node's position is the
    /// `i` in `foreach(i = ...)`, suitable as the iterator's definition site.
    pub iterators: Vec<Node<'tree>>,
}

/// Recognize whether `node` is a foreach execution expression.
///
/// Returns the executed RHS node and the iterator name nodes when `node` is a
/// `binary_operator` with operator text `%do%` or `%dopar%` whose left side is a
/// call to bare `foreach(...)` or namespace-qualified
/// `foreach::foreach(...)` / `foreach:::foreach(...)`. Otherwise `None`.
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
    if !lhs_is_foreach_call(lhs, text) {
        return None;
    }

    Some(ForeachExecution {
        rhs,
        iterators: iterator_name_nodes(lhs, text),
    })
}

/// Whether `lhs` is a `call` to bare `foreach(...)` or namespace-qualified
/// `foreach::foreach(...)` / `foreach:::foreach(...)`.
fn lhs_is_foreach_call(lhs: Node, text: &str) -> bool {
    if lhs.kind() != "call" {
        return false;
    }
    let Some(func) = lhs.child_by_field_name("function") else {
        return false;
    };
    match func.kind() {
        "identifier" => &text[func.byte_range()] == "foreach",
        // `pkg::name` and `pkg:::name` share the `namespace_operator` shape; we
        // do not distinguish `::` from `:::` because both name the same export.
        "namespace_operator" => {
            func.child_by_field_name("lhs")
                .map(|n| &text[n.byte_range()])
                == Some("foreach")
                && func
                    .child_by_field_name("rhs")
                    .map(|n| &text[n.byte_range()])
                    == Some("foreach")
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

    /// Find the first `binary_operator` node in document order.
    fn first_binary_operator(node: Node) -> Option<Node> {
        if node.kind() == "binary_operator" {
            return Some(node);
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if let Some(found) = first_binary_operator(child) {
                return Some(found);
            }
        }
        None
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
        if recognize_foreach_execution(node, text).is_some() {
            return Some(node);
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if let Some(found) = find_foreach_execution(child, text) {
                return Some(found);
            }
        }
        None
    }
}
