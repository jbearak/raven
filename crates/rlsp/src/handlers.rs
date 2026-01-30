//
// handlers.rs
//
// Copyright (C) 2025 Posit Software, PBC. All rights reserved.
//
//

use tower_lsp::lsp_types::*;
use tree_sitter::Node;
use tree_sitter::Point;

use crate::state::WorldState;

use crate::builtins;

// ============================================================================
// Folding Range
// ============================================================================

pub fn folding_range(state: &WorldState, uri: &Url) -> Option<Vec<FoldingRange>> {
    let doc = state.get_document(uri)?;
    let tree = doc.tree.as_ref()?;
    let mut ranges = Vec::new();

    collect_folding_ranges(tree.root_node(), &mut ranges);

    Some(ranges)
}

fn collect_folding_ranges(node: Node, ranges: &mut Vec<FoldingRange>) {
    let kind = node.kind();

    // Fold braced expressions, function definitions, and control structures
    let should_fold = matches!(
        kind,
        "brace_list" | "function_definition" | "if_statement" | "for_statement" | "while_statement"
    );

    if should_fold && node.start_position().row != node.end_position().row {
        ranges.push(FoldingRange {
            start_line: node.start_position().row as u32,
            start_character: Some(node.start_position().column as u32),
            end_line: node.end_position().row as u32,
            end_character: Some(node.end_position().column as u32),
            kind: Some(FoldingRangeKind::Region),
            collapsed_text: None,
        });
    }

    // Recurse into children
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_folding_ranges(child, ranges);
    }
}

// ============================================================================
// Selection Range
// ============================================================================

pub fn selection_range(
    state: &WorldState,
    uri: &Url,
    positions: Vec<Position>,
) -> Option<Vec<SelectionRange>> {
    let doc = state.get_document(uri)?;
    let tree = doc.tree.as_ref()?;

    let mut results = Vec::new();
    for pos in positions {
        let point = Point::new(pos.line as usize, pos.character as usize);
        if let Some(range) = build_selection_range(tree.root_node(), point) {
            results.push(range);
        }
    }

    Some(results)
}

fn build_selection_range(root: Node, point: Point) -> Option<SelectionRange> {
    let mut node = root.descendant_for_point_range(point, point)?;
    let mut ranges: Vec<Range> = Vec::new();

    loop {
        let range = Range {
            start: Position::new(node.start_position().row as u32, node.start_position().column as u32),
            end: Position::new(node.end_position().row as u32, node.end_position().column as u32),
        };

        if ranges.last() != Some(&range) {
            ranges.push(range);
        }

        if let Some(parent) = node.parent() {
            node = parent;
        } else {
            break;
        }
    }

    // Build nested SelectionRange from innermost to outermost
    let mut result: Option<SelectionRange> = None;
    for range in ranges {
        result = Some(SelectionRange {
            range,
            parent: result.map(Box::new),
        });
    }

    result
}

// ============================================================================
// Document Symbols
// ============================================================================

pub fn document_symbol(state: &WorldState, uri: &Url) -> Option<DocumentSymbolResponse> {
    let doc = state.get_document(uri)?;
    let tree = doc.tree.as_ref()?;
    let text = doc.text();

    let mut symbols = Vec::new();
    collect_symbols(tree.root_node(), &text, &mut symbols);

    Some(DocumentSymbolResponse::Flat(symbols))
}

#[allow(deprecated)]
fn collect_symbols(node: Node, text: &str, symbols: &mut Vec<SymbolInformation>) {
    // Look for assignments: identifier <- value or identifier = value
    if node.kind() == "binary_operator" {
        let mut cursor = node.walk();
        let children: Vec<_> = node.children(&mut cursor).collect();

        if children.len() >= 3 {
            let lhs = children[0];
            let op = children[1];
            let rhs = children[2];

            let op_text = node_text(op, text);
            if matches!(op_text, "<-" | "=" | "<<-") && lhs.kind() == "identifier" {
                let name = node_text(lhs, text).to_string();
                let kind = if rhs.kind() == "function_definition" {
                    SymbolKind::FUNCTION
                } else {
                    SymbolKind::VARIABLE
                };

                symbols.push(SymbolInformation {
                    name,
                    kind,
                    tags: None,
                    deprecated: None,
                    location: Location {
                        uri: Url::parse("file:///").unwrap(), // Will be replaced
                        range: Range {
                            start: Position::new(
                                node.start_position().row as u32,
                                node.start_position().column as u32,
                            ),
                            end: Position::new(
                                node.end_position().row as u32,
                                node.end_position().column as u32,
                            ),
                        },
                    },
                    container_name: None,
                });
            }
        }
    }

    // Recurse
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_symbols(child, text, symbols);
    }
}

// ============================================================================
// Diagnostics
// ============================================================================

pub fn diagnostics(state: &WorldState, uri: &Url) -> Vec<Diagnostic> {
    let Some(doc) = state.get_document(uri) else {
        return Vec::new();
    };

    let Some(tree) = &doc.tree else {
        return Vec::new();
    };

    let text = doc.text();
    let mut diagnostics = Vec::new();

    // Collect syntax errors
    collect_syntax_errors(tree.root_node(), &mut diagnostics);

    // Collect undefined variable errors
    collect_undefined_variables(
        tree.root_node(),
        &text,
        &doc.loaded_packages,
        &state.workspace_imports,
        &state.library,
        &mut diagnostics,
    );

    diagnostics
}

fn collect_syntax_errors(node: Node, diagnostics: &mut Vec<Diagnostic>) {
    if node.is_error() || node.is_missing() {
        let message = if node.is_missing() {
            format!("Missing {}", node.kind())
        } else {
            "Syntax error".to_string()
        };

        diagnostics.push(Diagnostic {
            range: Range {
                start: Position::new(
                    node.start_position().row as u32,
                    node.start_position().column as u32,
                ),
                end: Position::new(
                    node.end_position().row as u32,
                    node.end_position().column as u32,
                ),
            },
            severity: Some(DiagnosticSeverity::ERROR),
            message,
            ..Default::default()
        });
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_syntax_errors(child, diagnostics);
    }
}

fn collect_undefined_variables(
    node: Node,
    text: &str,
    loaded_packages: &[String],
    workspace_imports: &[String],
    library: &crate::state::Library,
    diagnostics: &mut Vec<Diagnostic>,
) {
    use std::collections::HashSet;

    let mut defined: HashSet<String> = HashSet::new();
    let mut used: Vec<(String, Node)> = Vec::new();

    // First pass: collect all definitions
    collect_definitions(node, text, &mut defined);

    // Second pass: collect all usages
    collect_usages(node, text, &mut used);

    // Report undefined variables
    for (name, node) in used {
        if !defined.contains(&name)
            && !is_builtin(&name)
            && !is_package_export(&name, loaded_packages, library)
            && !workspace_imports.contains(&name)
        {
            diagnostics.push(Diagnostic {
                range: Range {
                    start: Position::new(
                        node.start_position().row as u32,
                        node.start_position().column as u32,
                    ),
                    end: Position::new(
                        node.end_position().row as u32,
                        node.end_position().column as u32,
                    ),
                },
                severity: Some(DiagnosticSeverity::WARNING),
                message: format!("Undefined variable: {}", name),
                ..Default::default()
            });
        }
    }
}

fn collect_definitions(node: Node, text: &str, defined: &mut std::collections::HashSet<String>) {
    if node.kind() == "binary_operator" {
        let mut cursor = node.walk();
        let children: Vec<_> = node.children(&mut cursor).collect();

        if children.len() >= 3 {
            let lhs = children[0];
            let op = children[1];

            let op_text = node_text(op, text);
            if matches!(op_text, "<-" | "=" | "<<-") && lhs.kind() == "identifier" {
                defined.insert(node_text(lhs, text).to_string());
            }
        }
    }

    // Collect function parameters
    if node.kind() == "function_definition" {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "parameters" {
                collect_parameters(child, text, defined);
            }
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_definitions(child, text, defined);
    }
}

fn collect_parameters(node: Node, text: &str, defined: &mut std::collections::HashSet<String>) {
    if node.kind() == "parameter" || node.kind() == "identifier" {
        let name = node_text(node, text);
        if !name.is_empty() && name != "..." {
            defined.insert(name.to_string());
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_parameters(child, text, defined);
    }
}

fn collect_usages<'a>(node: Node<'a>, text: &str, used: &mut Vec<(String, Node<'a>)>) {
    if node.kind() == "identifier" {
        // Skip if this is the LHS of an assignment
        if let Some(parent) = node.parent() {
            if parent.kind() == "binary_operator" {
                let mut cursor = parent.walk();
                let children: Vec<_> = parent.children(&mut cursor).collect();
                if children.len() >= 2 && children[0].id() == node.id() {
                    let op = children[1];
                    let op_text = node_text(op, text);
                    if matches!(op_text, "<-" | "=" | "<<-") {
                        return; // Skip LHS of assignment
                    }
                }
            }
            
            // Skip if this is a named argument (e.g., n = 1 in readLines(..., n = 1))
            if parent.kind() == "argument" {
                if let Some(name_node) = parent.child_by_field_name("name") {
                    if name_node.id() == node.id() {
                        return; // Skip argument names
                    }
                }
            }
        }

        used.push((node_text(node, text).to_string(), node));
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_usages(child, text, used);
    }
}

fn is_builtin(name: &str) -> bool {
    // Check constants first
    if matches!(name, "TRUE" | "FALSE" | "NULL" | "NA" | "Inf" | "NaN" | "T" | "F") {
        return true;
    }
    // Check comprehensive builtin list
    builtins::is_builtin(name)
}

fn is_package_export(name: &str, loaded_packages: &[String], library: &crate::state::Library) -> bool {
    for pkg_name in loaded_packages {
        if let Some(package) = library.get(pkg_name) {
            if package.exports.contains(&name.to_string()) {
                return true;
            }
        }
    }
    false
}

// ============================================================================
// Completions
// ============================================================================

pub fn completion(state: &WorldState, uri: &Url, position: Position) -> Option<CompletionResponse> {
    let doc = state.get_document(uri)?;
    let tree = doc.tree.as_ref()?;
    let text = doc.text();

    let point = Point::new(position.line as usize, position.character as usize);
    let node = tree.root_node().descendant_for_point_range(point, point)?;

    let mut items = Vec::new();

    // Check if we're in a namespace context (pkg::)
    if find_namespace_context(&node, &text).is_some() {
        // TODO: Get package exports from library
        return Some(CompletionResponse::Array(items));
    }

    // Add R keywords
    let keywords = [
        "if", "else", "repeat", "while", "function", "for", "in", "next", "break",
        "TRUE", "FALSE", "NULL", "Inf", "NaN", "NA", "NA_integer_", "NA_real_",
        "NA_complex_", "NA_character_", "library", "require", "return", "print",
    ];

    for kw in keywords {
        items.push(CompletionItem {
            label: kw.to_string(),
            kind: Some(CompletionItemKind::KEYWORD),
            ..Default::default()
        });
    }

    // Add symbols from current document
    collect_document_completions(tree.root_node(), &text, &mut items);

    Some(CompletionResponse::Array(items))
}

fn find_namespace_context<'a>(node: &Node<'a>, text: &'a str) -> Option<&'a str> {
    // Walk up to find namespace_operator
    let mut current = *node;
    loop {
        if current.kind() == "namespace_operator" {
            let mut cursor = current.walk();
            let children: Vec<_> = current.children(&mut cursor).collect();
            if !children.is_empty() {
                return Some(node_text(children[0], text));
            }
        }
        current = current.parent()?;
    }
}

fn collect_document_completions(node: Node, text: &str, items: &mut Vec<CompletionItem>) {
    if node.kind() == "binary_operator" {
        let mut cursor = node.walk();
        let children: Vec<_> = node.children(&mut cursor).collect();

        if children.len() >= 3 {
            let lhs = children[0];
            let op = children[1];
            let rhs = children[2];

            let op_text = node_text(op, text);
            if matches!(op_text, "<-" | "=" | "<<-") && lhs.kind() == "identifier" {
                let name = node_text(lhs, text).to_string();
                let kind = if rhs.kind() == "function_definition" {
                    CompletionItemKind::FUNCTION
                } else {
                    CompletionItemKind::VARIABLE
                };

                items.push(CompletionItem {
                    label: name,
                    kind: Some(kind),
                    ..Default::default()
                });
            }
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_document_completions(child, text, items);
    }
}

// ============================================================================
// Hover
// ============================================================================

pub fn hover(state: &WorldState, uri: &Url, position: Position) -> Option<Hover> {
    let doc = state.get_document(uri)?;
    let tree = doc.tree.as_ref()?;
    let text = doc.text();

    let point = Point::new(position.line as usize, position.character as usize);
    let node = tree.root_node().descendant_for_point_range(point, point)?;

    // Get the identifier
    let name = if node.kind() == "identifier" || node.kind() == "string" {
        node_text(node, &text)
    } else {
        return None;
    };

    // Check cache first
    if let Some(cached) = state.help_cache.get(&name) {
        if let Some(help_text) = cached {
            return Some(Hover {
                contents: HoverContents::Markup(MarkupContent {
                    kind: MarkupKind::Markdown,
                    value: format!("```\n{}\n```", help_text),
                }),
                range: Some(Range {
                    start: Position::new(node.start_position().row as u32, node.start_position().column as u32),
                    end: Position::new(node.end_position().row as u32, node.end_position().column as u32),
                }),
            });
        }
        return None;
    }

    // Try to get help from R
    let help_text = crate::help::get_help(&name, None)?;
    
    // Cache the result
    state.help_cache.insert(name.to_string(), Some(help_text.clone()));

    Some(Hover {
        contents: HoverContents::Markup(MarkupContent {
            kind: MarkupKind::Markdown,
            value: format!("```\n{}\n```", help_text),
        }),
        range: Some(Range {
            start: Position::new(node.start_position().row as u32, node.start_position().column as u32),
            end: Position::new(node.end_position().row as u32, node.end_position().column as u32),
        }),
    })
}
// Signature Help
// ============================================================================

pub fn signature_help(
    state: &WorldState,
    uri: &Url,
    position: Position,
) -> Option<SignatureHelp> {
    let doc = state.get_document(uri)?;
    let tree = doc.tree.as_ref()?;
    let text = doc.text();

    let point = Point::new(position.line as usize, position.character as usize);

    // Find enclosing call
    let mut node = tree.root_node().descendant_for_point_range(point, point)?;

    loop {
        if node.kind() == "call" {
            let mut cursor = node.walk();
            let children: Vec<_> = node.children(&mut cursor).collect();

            if !children.is_empty() {
                let func_node = children[0];
                let func_name = node_text(func_node, &text);

                return Some(SignatureHelp {
                    signatures: vec![SignatureInformation {
                        label: format!("{}(...)", func_name),
                        documentation: None,
                        parameters: None,
                        active_parameter: None,
                    }],
                    active_signature: Some(0),
                    active_parameter: None,
                });
            }
        }

        node = node.parent()?;
    }
}

// ============================================================================
// Goto Definition
// ============================================================================

pub fn goto_definition(
    state: &WorldState,
    uri: &Url,
    position: Position,
) -> Option<GotoDefinitionResponse> {
    // Try open document first, then workspace index
    let doc = state.get_document(uri).or_else(|| state.workspace_index.get(uri))?;
    let tree = doc.tree.as_ref()?;
    let text = doc.text();

    let point = Point::new(position.line as usize, position.character as usize);
    let node = tree.root_node().descendant_for_point_range(point, point)?;

    if node.kind() != "identifier" {
        return None;
    }

    let name = node_text(node, &text);

    // Search current document first
    if let Some(def_range) = find_definition_in_tree(tree.root_node(), name, &text) {
        return Some(GotoDefinitionResponse::Scalar(Location {
            uri: uri.clone(),
            range: def_range,
        }));
    }

    // Search all open documents
    for (file_uri, doc) in &state.documents {
        if file_uri == uri {
            continue;
        }
        if let Some(tree) = &doc.tree {
            let file_text = doc.text();
            if let Some(def_range) = find_definition_in_tree(tree.root_node(), name, &file_text) {
                return Some(GotoDefinitionResponse::Scalar(Location {
                    uri: file_uri.clone(),
                    range: def_range,
                }));
            }
        }
    }

    // Search workspace index
    for (file_uri, doc) in &state.workspace_index {
        if file_uri == uri {
            continue;
        }
        if let Some(tree) = &doc.tree {
            let file_text = doc.text();
            if let Some(def_range) = find_definition_in_tree(tree.root_node(), name, &file_text) {
                return Some(GotoDefinitionResponse::Scalar(Location {
                    uri: file_uri.clone(),
                    range: def_range,
                }));
            }
        }
    }

    None
}

fn find_definition_in_tree(node: Node, name: &str, text: &str) -> Option<Range> {
    if node.kind() == "binary_operator" {
        let mut cursor = node.walk();
        let children: Vec<_> = node.children(&mut cursor).collect();

        if children.len() >= 3 {
            let lhs = children[0];
            let op = children[1];

            let op_text = node_text(op, text);
            if matches!(op_text, "<-" | "=" | "<<-") && lhs.kind() == "identifier" {
                if node_text(lhs, text) == name {
                    return Some(Range {
                        start: Position::new(
                            lhs.start_position().row as u32,
                            lhs.start_position().column as u32,
                        ),
                        end: Position::new(
                            lhs.end_position().row as u32,
                            lhs.end_position().column as u32,
                        ),
                    });
                }
            }
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if let Some(range) = find_definition_in_tree(child, name, text) {
            return Some(range);
        }
    }

    None
}

// ============================================================================
// References
// ============================================================================

pub fn references(state: &WorldState, uri: &Url, position: Position) -> Option<Vec<Location>> {
    // Try open document first, then workspace index
    let doc = state.get_document(uri).or_else(|| state.workspace_index.get(uri))?;
    let tree = doc.tree.as_ref()?;
    let text = doc.text();

    let point = Point::new(position.line as usize, position.character as usize);
    let node = tree.root_node().descendant_for_point_range(point, point)?;

    if node.kind() != "identifier" {
        return None;
    }

    let name = node_text(node, &text);
    let mut locations = Vec::new();

    // Search current document
    find_references_in_tree(tree.root_node(), name, &text, uri, &mut locations);

    // Search all open documents
    for (file_uri, doc) in &state.documents {
        if file_uri == uri {
            continue; // Already searched
        }
        if let Some(tree) = &doc.tree {
            let file_text = doc.text();
            find_references_in_tree(tree.root_node(), name, &file_text, file_uri, &mut locations);
        }
    }

    // Search workspace index
    for (file_uri, doc) in &state.workspace_index {
        if file_uri == uri {
            continue; // Already searched
        }
        if let Some(tree) = &doc.tree {
            let file_text = doc.text();
            find_references_in_tree(tree.root_node(), name, &file_text, file_uri, &mut locations);
        }
    }

    Some(locations)
}

fn find_references_in_tree(
    node: Node,
    name: &str,
    text: &str,
    uri: &Url,
    locations: &mut Vec<Location>,
) {
    if node.kind() == "identifier" && node_text(node, text) == name {
        locations.push(Location {
            uri: uri.clone(),
            range: Range {
                start: Position::new(
                    node.start_position().row as u32,
                    node.start_position().column as u32,
                ),
                end: Position::new(
                    node.end_position().row as u32,
                    node.end_position().column as u32,
                ),
            },
        });
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        find_references_in_tree(child, name, text, uri, locations);
    }
}

// ============================================================================
// On Type Formatting (Indentation)
// ============================================================================

pub fn on_type_formatting(
    state: &WorldState,
    uri: &Url,
    position: Position,
) -> Option<Vec<TextEdit>> {
    let doc = state.get_document(uri)?;
    let text = doc.text();

    // Simple indentation: match previous line's indentation
    if position.line == 0 {
        return None;
    }

    let prev_line_idx = position.line as usize - 1;
    let lines: Vec<&str> = text.lines().collect();

    if prev_line_idx >= lines.len() {
        return None;
    }

    let prev_line = lines[prev_line_idx];
    let indent: String = prev_line.chars().take_while(|c| c.is_whitespace()).collect();

    // Check if previous line ends with { or ( - add extra indent
    let trimmed = prev_line.trim_end();
    let extra_indent = if trimmed.ends_with('{') || trimmed.ends_with('(') {
        "  "
    } else {
        ""
    };

    let new_indent = format!("{}{}", indent, extra_indent);

    Some(vec![TextEdit {
        range: Range {
            start: Position::new(position.line, 0),
            end: Position::new(position.line, 0),
        },
        new_text: new_indent,
    }])
}

// ============================================================================
// Utilities
// ============================================================================

fn node_text<'a>(node: Node<'a>, text: &'a str) -> &'a str {
    &text[node.byte_range()]
}


// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn parse_r_code(code: &str) -> tree_sitter::Tree {
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&tree_sitter_r::LANGUAGE.into()).unwrap();
        parser.parse(code, None).unwrap()
    }

    #[test]
    fn test_function_parameters_recognized() {
        let code = "f <- function(a, b) { a + b }";
        let tree = parse_r_code(code);
        let mut defined = HashSet::new();
        collect_definitions(tree.root_node(), code, &mut defined);
        
        assert!(defined.contains("f"), "Function name should be defined");
        assert!(defined.contains("a"), "Parameter 'a' should be defined");
        assert!(defined.contains("b"), "Parameter 'b' should be defined");
    }

    #[test]
    fn test_single_parameter() {
        let code = "square <- function(x) { x * x }";
        let tree = parse_r_code(code);
        let mut defined = HashSet::new();
        collect_definitions(tree.root_node(), code, &mut defined);
        
        assert!(defined.contains("square"));
        assert!(defined.contains("x"));
    }

    #[test]
    fn test_no_parameters() {
        let code = "get_pi <- function() { 3.14 }";
        let tree = parse_r_code(code);
        let mut defined = HashSet::new();
        collect_definitions(tree.root_node(), code, &mut defined);
        
        assert!(defined.contains("get_pi"));
    }

    #[test]
    fn test_builtin_functions() {
        assert!(is_builtin("warning"));
        assert!(is_builtin("any"));
        assert!(is_builtin("is.na"));
        assert!(is_builtin("sprintf"));
        assert!(is_builtin("print"));
        assert!(is_builtin("sum"));
        assert!(is_builtin("mean"));
    }

    #[test]
    fn test_builtin_constants() {
        assert!(is_builtin("TRUE"));
        assert!(is_builtin("FALSE"));
        assert!(is_builtin("NULL"));
        assert!(is_builtin("NA"));
        assert!(is_builtin("Inf"));
        assert!(is_builtin("NaN"));
    }

    #[test]
    fn test_not_builtin() {
        assert!(!is_builtin("my_custom_function"));
        assert!(!is_builtin("undefined_var"));
    }

    #[test]
    fn test_nested_function_parameters() {
        let code = "outer <- function(x) { inner <- function(y) { x + y }; inner }";
        let tree = parse_r_code(code);
        let mut defined = HashSet::new();
        collect_definitions(tree.root_node(), code, &mut defined);
        
        assert!(defined.contains("outer"));
        assert!(defined.contains("x"));
        assert!(defined.contains("inner"));
        assert!(defined.contains("y"));
    }
}

#[cfg(test)]
mod proptests {
    use super::*;
    use proptest::prelude::*;
    use crate::state::Document;
    use std::collections::HashSet;

    proptest! {
        #[test]
        fn test_library_require_extraction(pkg_name in "[a-z]{3,10}") {
            let code_library = format!("library({})", pkg_name);
            let code_require = format!("require({})", pkg_name);
            let code_loadns = format!("loadNamespace(\"{}\")", pkg_name);
            
            let doc1 = Document::new(&code_library);
            let doc2 = Document::new(&code_require);
            let doc3 = Document::new(&code_loadns);
            
            prop_assert!(doc1.loaded_packages.contains(&pkg_name));
            prop_assert!(doc2.loaded_packages.contains(&pkg_name));
            prop_assert!(doc3.loaded_packages.contains(&pkg_name));
        }

        #[test]
        fn test_multiple_library_calls(pkg_count in 1usize..5) {
            let packages: Vec<String> = (0..pkg_count)
                .map(|i| format!("pkg{}", i))
                .collect();
            
            let code = packages.iter()
                .map(|p| format!("library({})", p))
                .collect::<Vec<_>>()
                .join("\n");
            
            let doc = Document::new(&code);
            
            for pkg in &packages {
                prop_assert!(doc.loaded_packages.contains(pkg));
            }
            prop_assert_eq!(doc.loaded_packages.len(), pkg_count);
        }

        #[test]
        fn test_mixed_symbol_types(
            var_name in "[a-z]{3,8}",
            func_name in "[a-z]{3,8}",
            builtin in prop::sample::select(vec!["print", "sum", "mean", "length"])
        ) {
            let code = format!(
                "{} <- 42\n{} <- function() {{}}\n{}({})",
                var_name, func_name, builtin, var_name
            );
            
            let tree = parse_r_code(&code);
            let mut defined = HashSet::new();
            collect_definitions(tree.root_node(), &code, &mut defined);
            
            prop_assert!(defined.contains(&var_name));
            prop_assert!(defined.contains(&func_name));
            prop_assert!(is_builtin(&builtin));
        }

        #[test]
        fn test_named_arguments_not_flagged(
            func_name in "[a-z]{3,8}",
            arg_name in "[a-z]{2,6}",
            value in 1i32..100
        ) {
            let code = format!("{}({} = {})", func_name, arg_name, value);
            
            let tree = parse_r_code(&code);
            let mut used = Vec::new();
            collect_usages(tree.root_node(), &code, &mut used);
            
            // func_name should be in used, but arg_name should NOT be
            let func_used = used.iter().any(|(name, _)| name == &func_name);
            let arg_used = used.iter().any(|(name, _)| name == &arg_name);
            
            prop_assert!(func_used, "Function name should be collected as usage");
            prop_assert!(!arg_used, "Named argument should NOT be collected as usage");
        }

        #[test]
        fn test_multiple_named_arguments(
            arg_count in 1usize..4
        ) {
            let args: Vec<String> = (0..arg_count)
                .map(|i| format!("arg{} = {}", i, i + 1))
                .collect();
            
            let code = format!("func({})", args.join(", "));
            
            let tree = parse_r_code(&code);
            let mut used = Vec::new();
            collect_usages(tree.root_node(), &code, &mut used);
            
            // None of the argument names should be flagged as usages
            for i in 0..arg_count {
                let arg_name = format!("arg{}", i);
                let arg_used = used.iter().any(|(name, _)| name == &arg_name);
                prop_assert!(!arg_used, "Named argument {} should not be flagged", arg_name);
            }
        }
    }

    fn parse_r_code(code: &str) -> tree_sitter::Tree {
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&tree_sitter_r::LANGUAGE.into()).unwrap();
        parser.parse(code, None).unwrap()
    }
    #[test]
    fn test_readlines_named_arg() {
        // This is the exact code from collate.r line 13
        let code = r#"run_hash <- trimws(readLines("output/oos/latest_hash.txt", n = 1))"#;
        let tree = parse_r_code(code);
        
        let mut used = Vec::new();
        collect_usages(tree.root_node(), code, &mut used);
        
        eprintln!("\n=== Collected usages ===");
        for (name, node) in &used {
            eprintln!("  '{}' (kind: {})", name, node.kind());
        }
        
        // trimws and readLines should be collected, but n should NOT be
        let trimws_used = used.iter().any(|(name, _)| name == "trimws");
        let readlines_used = used.iter().any(|(name, _)| name == "readLines");
        let n_used = used.iter().any(|(name, _)| name == "n");
        
        assert!(trimws_used, "trimws should be collected");
        assert!(readlines_used, "readLines should be collected");
        assert!(!n_used, "n should NOT be collected as it's a named argument");
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use crate::state::{WorldState, Document};
    use crate::r_env;
    
    #[test]
    fn test_base_package_functions() {
        // Test that base R functions are recognized
        let library_paths = r_env::find_library_paths();
        let _state = WorldState::new(library_paths);
        
        let code = "library(stats)\nx <- rnorm(100)\ny <- mean(x)";
        let doc = Document::new(code);
        
        // rnorm and mean should be recognized (rnorm from stats, mean from base)
        assert!(doc.loaded_packages.contains(&"stats".to_string()));
    }
    
    #[test]
    fn test_no_spurious_errors_with_common_packages() {
        let library_paths = r_env::find_library_paths();
        let mut state = WorldState::new(library_paths);
        
        // Test code that uses common package functions
        let test_cases = vec![
            ("library(stats)\nx <- rnorm(100)", vec!["rnorm"]),
            ("library(utils)\ndata <- read.csv('file.csv')", vec!["read.csv"]),
            ("require(graphics)\nplot(1:10)", vec!["plot"]),
        ];
        
        for (code, expected_funcs) in test_cases {
            let doc = Document::new(code);
            let uri = tower_lsp::lsp_types::Url::parse("file:///test.R").unwrap();
            state.documents.insert(uri.clone(), doc);
            
            let diagnostics = diagnostics(&state, &uri);
            
            // Check that expected functions don't generate undefined variable errors
            for func in expected_funcs {
                let has_error = diagnostics.iter().any(|d| d.message.contains(func));
                assert!(!has_error, "Function {} should not generate undefined variable error", func);
            }
        }
    }
    
    #[test]
    fn test_package_exports_loaded() {
        let library_paths = r_env::find_library_paths();
        let state = WorldState::new(library_paths);
        
        // Try to load stats package metadata
        if let Some(stats_pkg) = state.library.get("stats") {
            // stats should export common functions
            assert!(!stats_pkg.exports.is_empty(), "stats package should have exports");
            
            // Check for some known stats exports
            let has_common_funcs = stats_pkg.exports.iter().any(|e| 
                e == "rnorm" || e == "lm" || e == "t.test"
            );
            assert!(has_common_funcs, "stats should export common statistical functions");
        }
    }
}
