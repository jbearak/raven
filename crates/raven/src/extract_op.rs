//! Shared AST-shape predicate for the RHS of R's `extract_operator`
//! (`obj$field`, `obj@slot`).
//!
//! Centralized here so both `is_structural_non_reference` (in `handlers.rs`)
//! and `qualified_resolve::resolve_qualified_member` cannot drift in their
//! understanding of "this identifier is the structural member-name half of
//! `$`/`@`, not a free-variable reference".

use tree_sitter::Node;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtractOp {
    Dollar,
    At,
}

/// If `node` is the RHS identifier of an `extract_operator` (`foo$bar` or
/// `foo@bar`), return the LHS node and the operator kind. Otherwise `None`.
///
/// Tree-sitter-r exposes the operator's children via `child_by_field_name`
/// (`lhs`, `rhs`, `operator`); we use those rather than positional indexing.
pub fn extract_operator_rhs(node: Node) -> Option<(Node, ExtractOp)> {
    if node.kind() != "identifier" {
        return None;
    }
    let parent = node.parent()?;
    if parent.kind() != "extract_operator" {
        return None;
    }
    let rhs = parent.child_by_field_name("rhs")?;
    if rhs.id() != node.id() {
        return None;
    }
    let lhs = parent.child_by_field_name("lhs")?;
    let op_node = parent.child_by_field_name("operator")?;
    let op = match op_node.kind() {
        "$" => ExtractOp::Dollar,
        "@" => ExtractOp::At,
        _ => return None,
    };
    Some((lhs, op))
}
