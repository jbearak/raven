//! AST-first extraction of `R/sysdata.rda` symbol names and `.onLoad`/`.onAttach` bindings.
//!
//! Part 1: scans `data-raw/**/*.R` (and any other non-built R files under the
//! workspace root) for generating calls:
//! - `usethis::use_data(..., internal = TRUE)` / `use_data(..., internal = TRUE)` → positional args
//! - `save(..., file = "...sysdata.rda")` / `save(list = c("a","b"), file = "...sysdata.rda")`
//!
//! Part 2: `.onLoad`/`.onAttach` body scanning for namespace-level bindings:
//! - `assign("x", ..., envir = ...)` at top level inside the hook
//! - `ns$x <- ...` / `topenv()$x <- ...` inside the hook

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use tree_sitter::{Node, Parser};

/// Scan `data-raw/**/*.R` (recursively) for `use_data(..., internal=TRUE)` and
/// `save(..., file="...sysdata.rda")` calls. Returns the set of symbol names
/// that would be written to `R/sysdata.rda`.
pub fn scan_sysdata_generating_scripts(workspace_root: &Path) -> BTreeSet<String> {
    let mut symbols = BTreeSet::new();
    let data_raw = workspace_root.join("data-raw");
    if data_raw.is_dir() {
        scan_dir_recursive(&data_raw, &mut symbols);
    }
    symbols
}

fn scan_dir_recursive(dir: &Path, symbols: &mut BTreeSet<String>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_dir_recursive(&path, symbols);
        } else if matches!(path.extension().and_then(|e| e.to_str()), Some("R" | "r"))
            && let Ok(content) = fs::read_to_string(&path)
        {
            extract_sysdata_names_from_source(&content, symbols);
        }
    }
}

/// Extract sysdata symbol names from a single R source file's content.
pub fn extract_sysdata_names_from_source(content: &str, symbols: &mut BTreeSet<String>) {
    let mut parser = Parser::new();
    if parser
        .set_language(&tree_sitter_r::LANGUAGE.into())
        .is_err()
    {
        return;
    }
    let Some(tree) = parser.parse(content, None) else {
        return;
    };
    visit_for_sysdata(tree.root_node(), content, symbols);
}

fn visit_for_sysdata(node: Node, content: &str, symbols: &mut BTreeSet<String>) {
    if node.kind() == "call" {
        try_extract_use_data_internal(node, content, symbols);
        try_extract_save_sysdata(node, content, symbols);
    }
    for child in node.children(&mut node.walk()) {
        visit_for_sysdata(child, content, symbols);
    }
}

/// Match `usethis::use_data(a, b, internal = TRUE)` or `use_data(a, b, internal = TRUE)`.
fn try_extract_use_data_internal(node: Node, content: &str, symbols: &mut BTreeSet<String>) {
    let Some(func_node) = node.child_by_field_name("function") else {
        return;
    };
    let func_text = node_text(func_node, content);
    if func_text != "use_data" && func_text != "usethis::use_data" {
        return;
    }
    let Some(args_node) = node.child_by_field_name("arguments") else {
        return;
    };
    if !has_named_bool_arg(&args_node, content, "internal", true) {
        return;
    }
    // Collect positional (unnamed) arguments that are bare identifiers
    let mut cursor = args_node.walk();
    for child in args_node.children(&mut cursor) {
        if child.kind() == "argument"
            && child.child_by_field_name("name").is_none()
            && let Some(value_node) = child.child_by_field_name("value")
            && value_node.kind() == "identifier"
        {
            let name = node_text(value_node, content);
            if !name.is_empty() {
                symbols.insert(name.to_string());
            }
        }
    }
}

/// Match `save(a, b, file = "...sysdata.rda")` or `save(list = c("a","b"), file = "...sysdata.rda")`.
fn try_extract_save_sysdata(node: Node, content: &str, symbols: &mut BTreeSet<String>) {
    let Some(func_node) = node.child_by_field_name("function") else {
        return;
    };
    if node_text(func_node, content) != "save" {
        return;
    }
    let Some(args_node) = node.child_by_field_name("arguments") else {
        return;
    };
    if !file_arg_is_sysdata(&args_node, content) {
        return;
    }
    // Try `list = c("a", "b")` form
    if let Some(list_names) = extract_list_arg_strings(&args_node, content) {
        symbols.extend(list_names);
        return;
    }
    // Positional bare identifiers (excluding named args)
    let mut cursor = args_node.walk();
    for child in args_node.children(&mut cursor) {
        if child.kind() == "argument"
            && child.child_by_field_name("name").is_none()
            && let Some(value_node) = child.child_by_field_name("value")
            && value_node.kind() == "identifier"
        {
            let name = node_text(value_node, content);
            if !name.is_empty() {
                symbols.insert(name.to_string());
            }
        }
    }
}

/// Check if the `file` argument contains "sysdata.rda" or "sysdata.RData".
fn file_arg_is_sysdata(args_node: &Node, content: &str) -> bool {
    let mut cursor = args_node.walk();
    for child in args_node.children(&mut cursor) {
        if child.kind() == "argument"
            && let Some(name_node) = child.child_by_field_name("name")
            && node_text(name_node, content) == "file"
            && let Some(value_node) = child.child_by_field_name("value")
            && let Some(s) = extract_string_literal(value_node, content)
        {
            return s.contains("sysdata.rda") || s.contains("sysdata.RData");
        }
    }
    false
}

/// Extract string literals from `list = c("a", "b", ...)`.
fn extract_list_arg_strings(args_node: &Node, content: &str) -> Option<Vec<String>> {
    let mut cursor = args_node.walk();
    for child in args_node.children(&mut cursor) {
        if child.kind() == "argument"
            && let Some(name_node) = child.child_by_field_name("name")
            && node_text(name_node, content) == "list"
            && let Some(value_node) = child.child_by_field_name("value")
        {
            return extract_c_string_literals(value_node, content);
        }
    }
    None
}

/// Given a node that should be `c("a", "b", ...)`, extract the string literals.
fn extract_c_string_literals(node: Node, content: &str) -> Option<Vec<String>> {
    if node.kind() != "call" {
        return None;
    }
    let func_node = node.child_by_field_name("function")?;
    if node_text(func_node, content) != "c" {
        return None;
    }
    let args_node = node.child_by_field_name("arguments")?;
    let mut result = Vec::new();
    let mut cursor = args_node.walk();
    for child in args_node.children(&mut cursor) {
        if child.kind() == "argument"
            && let Some(value_node) = child.child_by_field_name("value")
            && let Some(s) = extract_string_literal(value_node, content)
        {
            result.push(s);
        }
    }
    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}

// === .onLoad / .onAttach binding extraction ===

/// Extract symbols bound in `.onLoad` and `.onAttach` function bodies from
/// `R/*.R` source text. Detects:
/// - `assign("x", ..., envir = ...)` at top level of the hook body
/// - `ns$x <- ...` / `topenv()$x <- ...`
pub fn extract_onload_bindings(content: &str) -> BTreeSet<String> {
    let mut parser = Parser::new();
    if parser
        .set_language(&tree_sitter_r::LANGUAGE.into())
        .is_err()
    {
        return BTreeSet::new();
    }
    let Some(tree) = parser.parse(content, None) else {
        return BTreeSet::new();
    };
    let mut symbols = BTreeSet::new();
    visit_for_onload(tree.root_node(), content, &mut symbols);
    symbols
}

fn visit_for_onload(node: Node, content: &str, symbols: &mut BTreeSet<String>) {
    if is_onload_definition(node, content) {
        if let Some(rhs) = node.child_by_field_name("rhs")
            && rhs.kind() == "function_definition"
            && let Some(body) = rhs.child_by_field_name("body")
        {
            extract_bindings_from_body(body, content, symbols);
        }
        return;
    }
    for child in node.children(&mut node.walk()) {
        visit_for_onload(child, content, symbols);
    }
}

/// Check if this node is a top-level `<-` assignment where the LHS is
/// `.onLoad` or `.onAttach`.
fn is_onload_definition(node: Node, content: &str) -> bool {
    if node.kind() != "binary_operator" {
        return false;
    }
    let Some(op) = node.child_by_field_name("operator") else {
        return false;
    };
    if !matches!(node_text(op, content), "<-" | "=") {
        return false;
    }
    let Some(lhs) = node.child_by_field_name("lhs") else {
        return false;
    };
    if lhs.kind() != "identifier" {
        return false;
    }
    let name = node_text(lhs, content);
    name == ".onLoad" || name == ".onAttach"
}

fn extract_bindings_from_body(body: Node, content: &str, symbols: &mut BTreeSet<String>) {
    visit_body_for_bindings(body, content, symbols, false);
}

fn visit_body_for_bindings(
    node: Node,
    content: &str,
    symbols: &mut BTreeSet<String>,
    inside_nested_function: bool,
) {
    match node.kind() {
        "call" if !inside_nested_function => {
            try_extract_assign_call(node, content, symbols);
            for child in node.children(&mut node.walk()) {
                visit_body_for_bindings(child, content, symbols, inside_nested_function);
            }
        }
        "binary_operator" if !inside_nested_function => {
            try_extract_dollar_assignment(node, content, symbols);
            for child in node.children(&mut node.walk()) {
                visit_body_for_bindings(child, content, symbols, inside_nested_function);
            }
        }
        "function_definition" => {
            for child in node.children(&mut node.walk()) {
                visit_body_for_bindings(child, content, symbols, true);
            }
        }
        _ => {
            for child in node.children(&mut node.walk()) {
                visit_body_for_bindings(child, content, symbols, inside_nested_function);
            }
        }
    }
}

/// Match `assign("x", value, envir = ns)` — extract "x".
fn try_extract_assign_call(node: Node, content: &str, symbols: &mut BTreeSet<String>) {
    let Some(func_node) = node.child_by_field_name("function") else {
        return;
    };
    if node_text(func_node, content) != "assign" {
        return;
    }
    let Some(args_node) = node.child_by_field_name("arguments") else {
        return;
    };
    if !has_named_arg(&args_node, content, "envir") {
        return;
    }
    // First positional arg should be a string literal with the name
    let mut cursor = args_node.walk();
    for child in args_node.children(&mut cursor) {
        if child.kind() == "argument"
            && child.child_by_field_name("name").is_none()
            && let Some(value_node) = child.child_by_field_name("value")
            && let Some(name) = extract_string_literal(value_node, content)
        {
            if !name.is_empty() {
                symbols.insert(name);
            }
            return;
        }
    }
}

/// Match `ns$x <- ...` or `topenv()$x <- ...` patterns.
fn try_extract_dollar_assignment(node: Node, content: &str, symbols: &mut BTreeSet<String>) {
    // Must be an assignment operator
    let Some(op) = node.child_by_field_name("operator") else {
        return;
    };
    if !matches!(node_text(op, content), "<-" | "<<-" | "=") {
        return;
    }
    let Some(lhs) = node.child_by_field_name("lhs") else {
        return;
    };
    if lhs.kind() != "extract_operator" {
        return;
    }
    let mut cursor = lhs.walk();
    let children: Vec<_> = lhs.children(&mut cursor).collect();
    if children.len() < 3 {
        return;
    }
    if node_text(children[1], content) != "$" {
        return;
    }
    let field = &children[2];
    let name = if field.kind() == "string" {
        extract_string_literal(*field, content)
    } else if field.kind() == "identifier" {
        Some(node_text(*field, content).to_string())
    } else {
        None
    };
    if let Some(n) = name
        && !n.is_empty()
    {
        symbols.insert(n);
    }
}

// === Helpers ===

fn has_named_bool_arg(args_node: &Node, content: &str, param: &str, expected: bool) -> bool {
    let mut cursor = args_node.walk();
    for child in args_node.children(&mut cursor) {
        if child.kind() == "argument"
            && let Some(name_node) = child.child_by_field_name("name")
            && node_text(name_node, content) == param
            && let Some(value_node) = child.child_by_field_name("value")
        {
            let val = node_text(value_node, content);
            return if expected {
                val == "TRUE" || val == "T"
            } else {
                val == "FALSE" || val == "F"
            };
        }
    }
    false
}

fn has_named_arg(args_node: &Node, content: &str, param: &str) -> bool {
    let mut cursor = args_node.walk();
    for child in args_node.children(&mut cursor) {
        if child.kind() == "argument"
            && let Some(name_node) = child.child_by_field_name("name")
            && node_text(name_node, content) == param
        {
            return true;
        }
    }
    false
}

fn extract_string_literal(node: Node, content: &str) -> Option<String> {
    if node.kind() != "string" {
        return None;
    }
    let text = node_text(node, content);
    if (text.starts_with('"') && text.ends_with('"'))
        || (text.starts_with('\'') && text.ends_with('\''))
    {
        Some(text[1..text.len() - 1].to_string())
    } else {
        None
    }
}

fn node_text<'a>(node: Node<'a>, content: &'a str) -> &'a str {
    &content[node.byte_range()]
}

// === R subprocess fallback ===

use std::sync::Mutex;

type SysdataCache = Mutex<Option<(super::ContentDigest, BTreeSet<String>)>>;

/// Cached result of R-subprocess sysdata loading, keyed by file content digest.
static SYSDATA_R_CACHE: std::sync::LazyLock<SysdataCache> =
    std::sync::LazyLock::new(|| Mutex::new(None));

/// R fallback: load `R/sysdata.rda` via an R subprocess and return `ls()` of
/// the loaded environment. Called only when AST scanning found nothing AND
/// `R/sysdata.rda` exists. Caches by file digest; fail-soft (returns empty on
/// any failure).
///
/// # Safety invariants (per `r_subprocess` module doc)
/// - No user-controlled input is interpolated into the R code.
/// - The call is wrapped in `tokio::time::timeout()` by the caller.
pub async fn load_sysdata_via_r(
    r_subprocess: &crate::r_subprocess::RSubprocess,
    workspace_root: &Path,
) -> BTreeSet<String> {
    let sysdata_path = workspace_root.join("R").join("sysdata.rda");
    if !sysdata_path.is_file() {
        return BTreeSet::new();
    }

    // Compute digest for caching
    let digest = match fs::read(&sysdata_path) {
        Ok(bytes) => super::ContentDigest::of_bytes(&bytes),
        Err(_) => return BTreeSet::new(),
    };

    // Check cache
    if let Ok(guard) = SYSDATA_R_CACHE.lock()
        && let Some((cached_digest, cached_symbols)) = guard.as_ref()
        && *cached_digest == digest
    {
        return cached_symbols.clone();
    }

    // Build R code. The path is workspace-derived, but filesystem paths can
    // legally contain `"`, `\`, and control characters, so escape it into a
    // safe R string literal rather than interpolating verbatim.
    let sysdata_path_str = sysdata_path.to_string_lossy().replace('\\', "/");
    let escaped_path: String = sysdata_path_str
        .chars()
        .flat_map(|c| match c {
            '"' => vec!['\\', '"'],
            '\\' => vec!['\\', '\\'],
            '\n' => vec!['\\', 'n'],
            '\r' => vec!['\\', 'r'],
            '\t' => vec!['\\', 't'],
            other => vec![other],
        })
        .collect();
    let r_code = format!(
        r#"e <- new.env(parent = emptyenv()); load("{}", e); cat(ls(e), sep = "\n")"#,
        escaped_path
    );

    let result = match tokio::time::timeout(
        std::time::Duration::from_secs(10),
        r_subprocess.execute_r_code(&r_code),
    )
    .await
    {
        Ok(Ok(stdout)) => stdout,
        _ => return BTreeSet::new(),
    };

    let symbols: BTreeSet<String> = result
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    // Update cache
    if let Ok(mut guard) = SYSDATA_R_CACHE.lock() {
        *guard = Some((digest, symbols.clone()));
    }

    symbols
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- use_data with internal = TRUE ---

    #[test]
    fn use_data_internal_true_extracts_symbols() {
        let code = r#"usethis::use_data(x, y, internal = TRUE)"#;
        let mut syms = BTreeSet::new();
        extract_sysdata_names_from_source(code, &mut syms);
        assert!(syms.contains("x"), "got: {:?}", syms);
        assert!(syms.contains("y"), "got: {:?}", syms);
    }

    #[test]
    fn use_data_without_internal_does_not_feed_sysdata() {
        let code = r#"usethis::use_data(d)"#;
        let mut syms = BTreeSet::new();
        extract_sysdata_names_from_source(code, &mut syms);
        assert!(syms.is_empty(), "got: {:?}", syms);
    }

    #[test]
    fn use_data_internal_false_does_not_feed_sysdata() {
        let code = r#"use_data(d, internal = FALSE)"#;
        let mut syms = BTreeSet::new();
        extract_sysdata_names_from_source(code, &mut syms);
        assert!(syms.is_empty(), "got: {:?}", syms);
    }

    #[test]
    fn use_data_bare_name_extracts() {
        let code = r#"use_data(alpha, beta, internal = TRUE)"#;
        let mut syms = BTreeSet::new();
        extract_sysdata_names_from_source(code, &mut syms);
        assert!(syms.contains("alpha"), "got: {:?}", syms);
        assert!(syms.contains("beta"), "got: {:?}", syms);
    }

    // --- save() with sysdata.rda ---

    #[test]
    fn save_with_sysdata_file_extracts_positional_symbols() {
        let code = r#"save(z, file = "R/sysdata.rda")"#;
        let mut syms = BTreeSet::new();
        extract_sysdata_names_from_source(code, &mut syms);
        assert!(syms.contains("z"), "got: {:?}", syms);
    }

    #[test]
    fn save_with_list_arg_extracts_strings() {
        let code = r#"save(list = c("a", "b"), file = "R/sysdata.rda")"#;
        let mut syms = BTreeSet::new();
        extract_sysdata_names_from_source(code, &mut syms);
        assert!(syms.contains("a"), "got: {:?}", syms);
        assert!(syms.contains("b"), "got: {:?}", syms);
    }

    #[test]
    fn save_without_sysdata_does_not_extract() {
        let code = r#"save(z, file = "data/z.rda")"#;
        let mut syms = BTreeSet::new();
        extract_sysdata_names_from_source(code, &mut syms);
        assert!(syms.is_empty(), "got: {:?}", syms);
    }

    // --- .onLoad / .onAttach bindings ---

    #[test]
    fn onload_assign_with_envir_extracts() {
        let code = r#"
.onLoad <- function(libname, pkgname) {
  assign("x", 42, envir = ns)
}
"#;
        let syms = extract_onload_bindings(code);
        assert!(syms.contains("x"), "got: {:?}", syms);
    }

    #[test]
    fn onload_ns_dollar_assignment_extracts() {
        let code = r#"
.onLoad <- function(libname, pkgname) {
  ns <- topenv(environment())
  ns$my_var <- compute_something()
}
"#;
        let syms = extract_onload_bindings(code);
        assert!(syms.contains("my_var"), "got: {:?}", syms);
    }

    #[test]
    fn onattach_dollar_assignment_extracts() {
        let code = r#"
.onAttach <- function(libname, pkgname) {
  topenv()$greeting <- "hello"
}
"#;
        let syms = extract_onload_bindings(code);
        assert!(syms.contains("greeting"), "got: {:?}", syms);
    }

    #[test]
    fn local_assign_in_ordinary_function_stays_local() {
        let code = r#"
my_func <- function() {
  assign("x", 42, envir = ns)
}
"#;
        let syms = extract_onload_bindings(code);
        assert!(syms.is_empty(), "got: {:?}", syms);
    }

    #[test]
    fn nested_function_inside_onload_stays_local() {
        let code = r#"
.onLoad <- function(libname, pkgname) {
  helper <- function() {
    assign("local_only", 1, envir = e)
  }
  assign("visible", 2, envir = ns)
}
"#;
        let syms = extract_onload_bindings(code);
        assert!(syms.contains("visible"), "got: {:?}", syms);
        assert!(!syms.contains("local_only"), "got: {:?}", syms);
    }

    #[test]
    fn absent_everything_is_noop() {
        let code = r#"
foo <- function(x) x + 1
bar <- 42
"#;
        let mut sysdata_syms = BTreeSet::new();
        extract_sysdata_names_from_source(code, &mut sysdata_syms);
        assert!(sysdata_syms.is_empty());
        let onload_syms = extract_onload_bindings(code);
        assert!(onload_syms.is_empty());
    }

    // --- Filesystem scan ---

    #[test]
    fn scan_sysdata_generating_scripts_from_data_raw() {
        let tmp = tempfile::TempDir::new().unwrap();
        let data_raw = tmp.path().join("data-raw");
        std::fs::create_dir(&data_raw).unwrap();
        std::fs::write(
            data_raw.join("prepare.R"),
            "usethis::use_data(x, y, internal = TRUE)\n",
        )
        .unwrap();
        let syms = scan_sysdata_generating_scripts(tmp.path());
        assert!(syms.contains("x"), "got: {:?}", syms);
        assert!(syms.contains("y"), "got: {:?}", syms);
    }

    #[test]
    fn scan_sysdata_no_data_raw_is_empty() {
        let tmp = tempfile::TempDir::new().unwrap();
        let syms = scan_sysdata_generating_scripts(tmp.path());
        assert!(syms.is_empty());
    }

    /// R fallback test: loads a committed sysdata.rda fixture via R subprocess.
    /// Skip-gated: only runs when R is available.
    #[tokio::test]
    async fn r_fallback_loads_sysdata_rda_fixture() {
        let Some(r) = crate::r_subprocess::RSubprocess::new(None) else {
            eprintln!("skipping r_fallback_loads_sysdata_rda_fixture: R not available");
            return;
        };
        let fixture_root =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sysdata_pkg");
        let names = super::load_sysdata_via_r(&r, &fixture_root).await;
        assert!(
            names.contains("sysdata_var1"),
            "expected sysdata_var1, got: {:?}",
            names
        );
        assert!(
            names.contains("sysdata_var2"),
            "expected sysdata_var2, got: {:?}",
            names
        );
    }
}
