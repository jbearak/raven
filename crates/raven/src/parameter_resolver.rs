//
// parameter_resolver.rs
//
// Resolves function parameter information for completion suggestions.
// Supports user-defined functions (AST extraction), cross-file scope,
// and package functions (R subprocess formals() queries with caching).
//

use std::collections::HashSet;
use std::fmt;
use std::num::NonZeroUsize;
use std::sync::RwLock;

use lru::LruCache;
use tree_sitter::Node;
use url::Url;

use crate::cross_file::scope::ScopeAtPosition;
use crate::cross_file::SymbolKind;
use crate::state::WorldState;

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

/// Information about a single function parameter.
#[derive(Debug, Clone)]
pub struct ParameterInfo {
    /// Parameter name (e.g., "x", "na.rm", "...")
    pub name: String,
    /// Default value as a string, if any (e.g., "TRUE", "NULL")
    pub default_value: Option<String>,
    /// Whether this parameter is the `...` (dots) parameter
    pub is_dots: bool,
}

/// Where a function signature was obtained from.
#[derive(Debug, Clone)]
pub enum SignatureSource {
    /// From R subprocess `formals()` query
    RSubprocess { package: Option<String> },
    /// From the current file's AST
    CurrentFile { uri: Url, line: u32 },
    /// From a cross-file sourced definition
    CrossFile { uri: Url, line: u32 },
}

/// A resolved function signature with its parameters.
#[derive(Debug, Clone)]
pub struct FunctionSignature {
    /// Ordered list of parameters
    pub parameters: Vec<ParameterInfo>,
    /// Where this signature was obtained from
    pub source: SignatureSource,
}

// ---------------------------------------------------------------------------
// Signature cache
// ---------------------------------------------------------------------------

/// Thread-safe LRU signature cache with separate stores for package and user
/// function signatures.
///
/// Cache key formats:
/// - Package functions: `"package::function"` (e.g., `"dplyr::filter"`)
/// - User functions: `"file:///path/to/file.R#my_func"` (URI + function name)
///
/// Uses `RwLock` with `peek()` for reads (no LRU promotion under read lock)
/// and `push()` for writes under write lock, consistent with existing Raven
/// cache patterns.
pub struct SignatureCache {
    /// Package function signatures ("package::function" -> signature)
    package_signatures: RwLock<LruCache<String, FunctionSignature>>,
    /// User-defined function signatures ("file:///path#func" -> signature)
    user_signatures: RwLock<LruCache<String, FunctionSignature>>,
}

// LruCache doesn't derive Debug; implement manually using finish_non_exhaustive()
impl fmt::Debug for SignatureCache {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SignatureCache")
            .finish_non_exhaustive()
    }
}

impl SignatureCache {
    /// Create a new signature cache with the given capacities.
    pub fn new(max_package: usize, max_user: usize) -> Self {
        let pkg_cap = NonZeroUsize::new(max_package).unwrap_or(NonZeroUsize::new(500).unwrap());
        let user_cap = NonZeroUsize::new(max_user).unwrap_or(NonZeroUsize::new(200).unwrap());
        Self {
            package_signatures: RwLock::new(LruCache::new(pkg_cap)),
            user_signatures: RwLock::new(LruCache::new(user_cap)),
        }
    }

    /// Look up a package function signature (read-only, no LRU promotion).
    pub fn get_package(&self, key: &str) -> Option<FunctionSignature> {
        let cache = self.package_signatures.read().ok()?;
        cache.peek(key).cloned()
    }

    /// Look up a user-defined function signature (read-only, no LRU promotion).
    pub fn get_user(&self, key: &str) -> Option<FunctionSignature> {
        let cache = self.user_signatures.read().ok()?;
        cache.peek(key).cloned()
    }

    /// Insert a package function signature (promotes/evicts under write lock).
    pub fn insert_package(&self, key: String, sig: FunctionSignature) {
        if let Ok(mut cache) = self.package_signatures.write() {
            cache.push(key, sig);
        }
    }

    /// Insert a user-defined function signature (promotes/evicts under write lock).
    pub fn insert_user(&self, key: String, sig: FunctionSignature) {
        if let Ok(mut cache) = self.user_signatures.write() {
            cache.push(key, sig);
        }
    }

    /// Invalidate all user-defined signatures from a specific file.
    ///
    /// Iterates the user LRU cache and removes keys whose URI prefix matches
    /// the given URI. This is O(n) in cache size but acceptable given the
    /// small capacity (200 entries).
    pub fn invalidate_file(&self, uri: &Url) {
        let prefix = format!("{}#", uri.as_str());
        if let Ok(mut cache) = self.user_signatures.write() {
            // Collect keys to remove: entries keyed by this file's URI prefix,
            // OR entries whose source URI matches this file (cross-file signatures
            // cached under the caller's URI).
            let keys_to_remove: Vec<String> = cache
                .iter()
                .filter_map(|(k, v)| {
                    let key_match = k.starts_with(&prefix);
                    let source_match = match &v.source {
                        SignatureSource::CurrentFile { uri: src, .. }
                        | SignatureSource::CrossFile { uri: src, .. } => src == uri,
                        SignatureSource::RSubprocess { .. } => false,
                    };
                    if key_match || source_match {
                        Some(k.clone())
                    } else {
                        None
                    }
                })
                .collect();
            for key in keys_to_remove {
                cache.pop(&key);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// AST extraction
// ---------------------------------------------------------------------------

/// Extract parameter information from a `parameters` tree-sitter node.
///
/// Walks the node's children to find:
/// - `parameter` nodes containing `identifier`: regular parameters
/// - `parameter` nodes containing `dots`: the `...` parameter
/// - `parameter` nodes with `=` and a value: parameters with default values
/// - Direct `dots` children: the `...` parameter
///
/// Returns parameters in declaration order, including `...` (R-LS parity).
pub fn extract_from_ast(params_node: Node, text: &str) -> Vec<ParameterInfo> {
    let mut params = Vec::new();
    let mut cursor = params_node.walk();

    for child in params_node.children(&mut cursor) {
        if child.kind() == "parameter" {
            let mut param_cursor = child.walk();
            let param_children: Vec<_> = child.children(&mut param_cursor).collect();

            // Check if this parameter contains dots
            if param_children.iter().any(|n| n.kind() == "dots") {
                params.push(ParameterInfo {
                    name: "...".to_string(),
                    default_value: None,
                    is_dots: true,
                });
            } else if let Some(identifier) =
                param_children.iter().find(|n| n.kind() == "identifier")
            {
                let param_name = node_text(*identifier, text).to_string();

                // Check for default value: identifier = value
                let default_value =
                    if param_children.len() >= 3 && param_children[1].kind() == "=" {
                        Some(node_text(param_children[2], text).to_string())
                    } else {
                        None
                    };

                params.push(ParameterInfo {
                    name: param_name,
                    default_value,
                    is_dots: false,
                });
            }
        } else if child.kind() == "dots" {
            // dots can also appear directly as a child of parameters
            params.push(ParameterInfo {
                name: "...".to_string(),
                default_value: None,
                is_dots: true,
            });
        }
    }

    params
}

/// Get the text content of a tree-sitter node.
fn node_text<'a>(node: Node<'a>, text: &'a str) -> &'a str {
    let start = node.start_byte();
    let end = node.end_byte();
    if start <= end && end <= text.len() {
        &text[start..end]
    } else {
        ""
    }
}

// ---------------------------------------------------------------------------
// Parameter resolution
// ---------------------------------------------------------------------------

/// Resolve function parameters with multi-phase resolution.
///
/// Resolution priority:
/// 1. **Cache**: Check signature cache first (both package and user caches)
/// 2. **Local AST**: Search the current file for the nearest in-scope function
///    definition before the cursor position (works for untitled/unsaved docs)
/// 3. **Cross-file scope**: Search sourced files for function definitions
/// 4. **Package**: Determine which package exports the function using the scope
///    resolver's position-aware `loaded_packages` + `inherited_packages`, then
///    query R subprocess (stub for now — Task 4.1 adds `get_function_formals`)
///
/// This function is synchronous and may block on R subprocess for package
/// functions. The backend wraps it in `spawn_blocking`.
pub fn resolve(
    state: &WorldState,
    cache: &SignatureCache,
    function_name: &str,
    namespace: Option<&str>,
    _is_internal: bool,
    current_uri: &Url,
    position: tower_lsp::lsp_types::Position,
) -> Option<FunctionSignature> {
    // --- Phase 0: Cache lookup ---

    // For namespace-qualified calls (e.g., dplyr::filter), check package cache
    if let Some(ns) = namespace {
        let cache_key = format!("{}::{}", ns, function_name);
        if let Some(sig) = cache.get_package(&cache_key) {
            return Some(sig);
        }
    }

    // --- Phases 1 & 2: Local / cross-file (only for unqualified calls) ---
    // Namespace-qualified calls (e.g., dplyr::filter) skip user-defined lookup
    // and go straight to package resolution.
    if namespace.is_none() {
        // Check user cache (current file + cross-file)
        let user_cache_key = format!("{}#{}", current_uri.as_str(), function_name);
        if let Some(sig) = cache.get_user(&user_cache_key) {
            return Some(sig);
        }

        // Phase 1: Local AST search (current file)
        if let Some(sig) =
            resolve_from_current_file(state, cache, function_name, current_uri, position)
        {
            return Some(sig);
        }

        // Phase 2: Cross-file scope
        if let Some(sig) =
            resolve_from_cross_file(state, cache, function_name, current_uri, position)
        {
            return Some(sig);
        }
    }

    // --- Phase 3: Package resolution ---
    // For unqualified names, check package cache with all possible package keys
    // before attempting R subprocess
    let scope = get_scope(state, current_uri, position);
    let all_packages = collect_packages_at_position(state, &scope);

    // If namespace is specified, we already checked the cache above.
    // For unqualified names, try to find which package exports this function.
    let resolved_package = if let Some(ns) = namespace {
        Some(ns.to_string())
    } else {
        // Use find_package_for_symbol to determine which package exports this function
        let pkg_list: Vec<String> = all_packages.iter().cloned().collect();
        state
            .package_library
            .find_package_for_symbol(function_name, &pkg_list)
    };

    if let Some(ref pkg_name) = resolved_package {
        let cache_key = format!("{}::{}", pkg_name, function_name);
        if let Some(sig) = cache.get_package(&cache_key) {
            return Some(sig);
        }

        // R subprocess integration with graceful degradation (Requirement 11.1, 11.2, 11.3)
        // Query R for function formals using get_function_formals
        if let Some(ref r_subprocess) = state.package_library.r_subprocess() {
            // Get tokio runtime handle for async call from sync context
            let handle = match tokio::runtime::Handle::try_current() {
                Ok(h) => h,
                Err(_) => {
                    log::trace!(
                        "No tokio runtime available for R subprocess query; skipping package function {}::{}",
                        pkg_name,
                        function_name
                    );
                    return None;
                }
            };

            // Call async get_function_formals from sync context
            let formals_result = handle.block_on(r_subprocess.get_function_formals(
                function_name,
                Some(pkg_name),
                !_is_internal,
            ));

            match formals_result {
                Ok(params) => {
                    // Success: build signature, cache it, and return
                    let signature = FunctionSignature {
                        parameters: params,
                        source: SignatureSource::RSubprocess {
                            package: Some(pkg_name.clone()),
                        },
                    };
                    cache.insert_package(cache_key, signature.clone());
                    log::trace!(
                        "Resolved package function {}::{} via R subprocess ({} params)",
                        pkg_name,
                        function_name,
                        signature.parameters.len()
                    );
                    return Some(signature);
                }
                Err(e) => {
                    // Graceful degradation: log error and return None
                    // Timeouts are logged at warn level (Requirement 11.3)
                    // Other errors (parse failures, missing functions) at trace level
                    if e.to_string().contains("timeout") || e.to_string().contains("timed out") {
                        log::warn!(
                            "R subprocess timeout querying formals for {}::{}: {}",
                            pkg_name,
                            function_name,
                            e
                        );
                    } else {
                        log::trace!(
                            "Failed to get formals for {}::{} from R subprocess: {}",
                            pkg_name,
                            function_name,
                            e
                        );
                    }
                    // Fall through to return None (standard completions will still appear)
                }
            }
        } else {
            log::trace!(
                "No R subprocess available; cannot query formals for {}::{}",
                pkg_name,
                function_name
            );
        }
    }

    None
}

/// Search the current file's AST for a user-defined function with the given name.
///
/// Finds the nearest function definition that appears before the cursor position,
/// preferring the innermost enclosing scope. Works for untitled/unsaved documents
/// since it uses in-memory content.
fn resolve_from_current_file(
    state: &WorldState,
    cache: &SignatureCache,
    function_name: &str,
    uri: &Url,
    position: tower_lsp::lsp_types::Position,
) -> Option<FunctionSignature> {
    let doc = state.get_document(uri)?;
    let tree = doc.tree.as_ref()?;
    let text = doc.text();

    // Search for the nearest function definition before cursor position
    let func_node = find_function_definition_before_position(
        tree.root_node(),
        function_name,
        &text,
        position,
    )?;

    // Find the formal_parameters child of the function_definition node
    let params_node = func_node
        .children(&mut func_node.walk())
        .find(|c| c.kind() == "parameters")?;

    let parameters = extract_from_ast(params_node, &text);
    let def_line = func_node.start_position().row as u32;

    let sig = FunctionSignature {
        parameters,
        source: SignatureSource::CurrentFile {
            uri: uri.clone(),
            line: def_line,
        },
    };

    // Cache the result
    let cache_key = format!("{}#{}", uri.as_str(), function_name);
    cache.insert_user(cache_key, sig.clone());

    Some(sig)
}

/// Search cross-file scope for a function definition.
///
/// Uses the cross-file scope resolver to find function definitions in sourced files.
fn resolve_from_cross_file(
    state: &WorldState,
    cache: &SignatureCache,
    function_name: &str,
    uri: &Url,
    position: tower_lsp::lsp_types::Position,
) -> Option<FunctionSignature> {
    let scope = get_scope(state, uri, position);

    // Look for the function in cross-file symbols
    let symbol = scope.symbols.get(function_name)?;

    // Only consider function symbols from other files (not the current file,
    // which was already checked in Phase 1)
    if symbol.source_uri == *uri {
        return None;
    }

    // Only consider actual function definitions, not variables or package exports
    if symbol.kind != SymbolKind::Function {
        return None;
    }

    // Skip package-sourced symbols (those have "package:" URIs)
    if symbol.source_uri.as_str().starts_with("package:") {
        return None;
    }

    // Try to get the source file's AST and extract parameters
    let source_doc = state.get_document(&symbol.source_uri)?;
    let source_tree = source_doc.tree.as_ref()?;
    let source_text = source_doc.text();

    // Find the function definition at the known line
    let func_node = find_function_definition_at_line(
        source_tree.root_node(),
        function_name,
        &source_text,
        symbol.defined_line,
    )?;

    let params_node = func_node
        .children(&mut func_node.walk())
        .find(|c| c.kind() == "parameters")?;

    let parameters = extract_from_ast(params_node, &source_text);

    let sig = FunctionSignature {
        parameters,
        source: SignatureSource::CrossFile {
            uri: symbol.source_uri.clone(),
            line: symbol.defined_line,
        },
    };

    // Cache under the caller's URI so the lookup in resolve() (which uses
    // current_uri) gets a cache hit. Invalidation by source file is handled
    // by invalidate_file() which checks SignatureSource for source URI matches.
    let cache_key = format!("{}#{}", uri.as_str(), function_name);
    cache.insert_user(cache_key, sig.clone());

    Some(sig)
}

// ---------------------------------------------------------------------------
// AST search helpers
// ---------------------------------------------------------------------------

/// Find the nearest function definition with the given name that appears
/// before the cursor position in the AST.
///
/// Searches the entire tree for assignment nodes where the LHS matches
/// `function_name` and the RHS is a `function_definition`. Returns the
/// `function_definition` node of the last (nearest) match before the cursor.
fn find_function_definition_before_position<'a>(
    root: Node<'a>,
    function_name: &str,
    text: &str,
    position: tower_lsp::lsp_types::Position,
) -> Option<Node<'a>> {
    let mut best: Option<Node<'a>> = None;
    find_func_def_recursive(root, function_name, text, position, &mut best);
    best
}

fn find_func_def_recursive<'a>(
    node: Node<'a>,
    function_name: &str,
    text: &str,
    position: tower_lsp::lsp_types::Position,
    best: &mut Option<Node<'a>>,
) {
    if node.kind() == "binary_operator" {
        let mut cursor = node.walk();
        let children: Vec<_> = node.children(&mut cursor).collect();

        if children.len() >= 3 {
            let lhs = children[0];
            let op = children[1];
            let rhs = children[2];

            let op_text = node_text(op, text);
            if matches!(op_text, "<-" | "=" | "<<-")
                && lhs.kind() == "identifier"
                && node_text(lhs, text) == function_name
                && rhs.kind() == "function_definition"
            {
                // Only consider definitions before the cursor position
                let def_line = lhs.start_position().row as u32;
                if def_line <= position.line {
                    // Take the last (nearest) definition before cursor
                    match best {
                        Some(prev) => {
                            if def_line >= prev.start_position().row as u32 {
                                *best = Some(rhs);
                            }
                        }
                        None => {
                            *best = Some(rhs);
                        }
                    }
                }
            }
        }
    }

    // Also check right-assignment: function_definition -> name
    if node.kind() == "right_assignment" {
        let mut cursor = node.walk();
        let children: Vec<_> = node.children(&mut cursor).collect();

        if children.len() >= 3 {
            let lhs = children[0]; // value (function_definition)
            let rhs = children[2]; // name (identifier)

            if rhs.kind() == "identifier"
                && node_text(rhs, text) == function_name
                && lhs.kind() == "function_definition"
            {
                let def_line = rhs.start_position().row as u32;
                if def_line <= position.line {
                    match best {
                        Some(prev) => {
                            if def_line >= prev.start_position().row as u32 {
                                *best = Some(lhs);
                            }
                        }
                        None => {
                            *best = Some(lhs);
                        }
                    }
                }
            }
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        find_func_def_recursive(child, function_name, text, position, best);
    }
}

/// Find a function definition at a specific line in the AST.
///
/// Used for cross-file resolution where we know the exact line of the definition.
fn find_function_definition_at_line<'a>(
    root: Node<'a>,
    function_name: &str,
    text: &str,
    target_line: u32,
) -> Option<Node<'a>> {
    let mut result: Option<Node<'a>> = None;
    find_func_def_at_line_recursive(root, function_name, text, target_line, &mut result);
    result
}

fn find_func_def_at_line_recursive<'a>(
    node: Node<'a>,
    function_name: &str,
    text: &str,
    target_line: u32,
    result: &mut Option<Node<'a>>,
) {
    if result.is_some() {
        return; // Already found
    }

    if node.kind() == "binary_operator" {
        let mut cursor = node.walk();
        let children: Vec<_> = node.children(&mut cursor).collect();

        if children.len() >= 3 {
            let lhs = children[0];
            let op = children[1];
            let rhs = children[2];

            let op_text = node_text(op, text);
            if matches!(op_text, "<-" | "=" | "<<-")
                && lhs.kind() == "identifier"
                && node_text(lhs, text) == function_name
                && rhs.kind() == "function_definition"
                && lhs.start_position().row as u32 == target_line
            {
                *result = Some(rhs);
                return;
            }
        }
    }

    // Also check right-assignment
    if node.kind() == "right_assignment" {
        let mut cursor = node.walk();
        let children: Vec<_> = node.children(&mut cursor).collect();

        if children.len() >= 3 {
            let lhs = children[0];
            let rhs = children[2];

            if rhs.kind() == "identifier"
                && node_text(rhs, text) == function_name
                && lhs.kind() == "function_definition"
                && rhs.start_position().row as u32 == target_line
            {
                *result = Some(lhs);
                return;
            }
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        find_func_def_at_line_recursive(child, function_name, text, target_line, result);
    }
}

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

/// Get the cross-file scope at the given position.
fn get_scope(
    state: &WorldState,
    uri: &Url,
    position: tower_lsp::lsp_types::Position,
) -> ScopeAtPosition {
    use crate::content_provider::ContentProvider;
    use crate::cross_file::scope;

    let content_provider = state.content_provider();

    let get_artifacts = |target_uri: &Url| -> Option<scope::ScopeArtifacts> {
        content_provider.get_artifacts(target_uri)
    };

    let get_metadata = |target_uri: &Url| -> Option<crate::cross_file::CrossFileMetadata> {
        content_provider.get_metadata(target_uri)
    };

    let max_depth = state.cross_file_config.max_chain_depth;

    let base_exports = if state.package_library_ready {
        state.package_library.base_exports().clone()
    } else {
        HashSet::new()
    };

    scope::scope_at_position_with_graph(
        uri,
        position.line,
        position.character,
        &get_artifacts,
        &get_metadata,
        &state.cross_file_graph,
        state.workspace_folders.first(),
        max_depth,
        &base_exports,
    )
}

/// Collect all packages available at the cursor position.
///
/// Combines base packages, inherited packages, and loaded packages from the
/// scope resolver's position-aware package list.
fn collect_packages_at_position(state: &WorldState, scope: &ScopeAtPosition) -> Vec<String> {
    let mut pkg_set: HashSet<String> = HashSet::new();
    let mut all_packages: Vec<String> = Vec::new();

    // Base packages first (always available without library() calls)
    if state.package_library_ready {
        for pkg in state.package_library.base_packages() {
            if pkg_set.insert(pkg.clone()) {
                all_packages.push(pkg.clone());
            }
        }
    }

    // Then inherited and explicitly loaded packages
    for pkg in scope
        .inherited_packages
        .iter()
        .chain(scope.loaded_packages.iter())
    {
        if pkg_set.insert(pkg.clone()) {
            all_packages.push(pkg.clone());
        }
    }

    all_packages
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_r_code(code: &str) -> tree_sitter::Tree {
        let mut parser = tree_sitter::Parser::new();
        let language = tree_sitter_r::LANGUAGE;
        parser
            .set_language(&language.into())
            .expect("Error loading R grammar");
        parser.parse(code, None).expect("Error parsing R code")
    }

    // -- SignatureCache tests --

    #[test]
    fn test_cache_new_default_capacities() {
        let cache = SignatureCache::new(500, 200);
        assert!(cache.get_package("nonexistent").is_none());
        assert!(cache.get_user("nonexistent").is_none());
    }

    #[test]
    fn test_cache_insert_and_get_package() {
        let cache = SignatureCache::new(10, 10);
        let sig = FunctionSignature {
            parameters: vec![ParameterInfo {
                name: ".data".to_string(),
                default_value: None,
                is_dots: false,
            }],
            source: SignatureSource::RSubprocess {
                package: Some("dplyr".to_string()),
            },
        };
        cache.insert_package("dplyr::filter".to_string(), sig.clone());
        let cached = cache.get_package("dplyr::filter");
        assert!(cached.is_some());
        assert_eq!(cached.unwrap().parameters.len(), 1);
    }

    #[test]
    fn test_cache_insert_and_get_user() {
        let cache = SignatureCache::new(10, 10);
        let sig = FunctionSignature {
            parameters: vec![],
            source: SignatureSource::CurrentFile {
                uri: Url::parse("file:///test.R").unwrap(),
                line: 0,
            },
        };
        cache.insert_user(
            "file:///test.R#my_func".to_string(),
            sig.clone(),
        );
        let cached = cache.get_user("file:///test.R#my_func");
        assert!(cached.is_some());
        assert!(cached.unwrap().parameters.is_empty());
    }

    #[test]
    fn test_cache_invalidate_file() {
        let cache = SignatureCache::new(10, 10);
        let uri = Url::parse("file:///project/utils.R").unwrap();

        // Insert two signatures from the same file
        let sig1 = FunctionSignature {
            parameters: vec![],
            source: SignatureSource::CurrentFile {
                uri: uri.clone(),
                line: 0,
            },
        };
        let sig2 = FunctionSignature {
            parameters: vec![],
            source: SignatureSource::CurrentFile {
                uri: uri.clone(),
                line: 5,
            },
        };
        cache.insert_user(format!("{}#func_a", uri.as_str()), sig1);
        cache.insert_user(format!("{}#func_b", uri.as_str()), sig2);

        // Insert a signature from a different file
        let other_uri = Url::parse("file:///project/other.R").unwrap();
        let sig3 = FunctionSignature {
            parameters: vec![],
            source: SignatureSource::CurrentFile {
                uri: other_uri.clone(),
                line: 0,
            },
        };
        cache.insert_user(format!("{}#func_c", other_uri.as_str()), sig3);

        // Verify all are present
        assert!(cache
            .get_user(&format!("{}#func_a", uri.as_str()))
            .is_some());
        assert!(cache
            .get_user(&format!("{}#func_b", uri.as_str()))
            .is_some());
        assert!(cache
            .get_user(&format!("{}#func_c", other_uri.as_str()))
            .is_some());

        // Invalidate the first file
        cache.invalidate_file(&uri);

        // Signatures from the invalidated file should be gone
        assert!(cache
            .get_user(&format!("{}#func_a", uri.as_str()))
            .is_none());
        assert!(cache
            .get_user(&format!("{}#func_b", uri.as_str()))
            .is_none());

        // Signature from the other file should still be present
        assert!(cache
            .get_user(&format!("{}#func_c", other_uri.as_str()))
            .is_some());
    }

    #[test]
    fn test_cache_lru_eviction() {
        // Create a cache with capacity 2
        let cache = SignatureCache::new(2, 2);

        for i in 0..3 {
            let sig = FunctionSignature {
                parameters: vec![],
                source: SignatureSource::RSubprocess { package: None },
            };
            cache.insert_package(format!("pkg::func_{}", i), sig);
        }

        // The first entry should have been evicted
        assert!(cache.get_package("pkg::func_0").is_none());
        // The last two should still be present
        assert!(cache.get_package("pkg::func_1").is_some());
        assert!(cache.get_package("pkg::func_2").is_some());
    }

    // -- extract_from_ast tests --

    #[test]
    fn test_extract_simple_params() {
        let code = "f <- function(x, y) { x + y }";
        let tree = parse_r_code(code);
        let func_node = find_function_def_in_tree(tree.root_node(), "f", code).unwrap();
        let params_node = func_node
            .children(&mut func_node.walk())
            .find(|c| c.kind() == "parameters")
            .unwrap();

        let params = extract_from_ast(params_node, code);
        assert_eq!(params.len(), 2);
        assert_eq!(params[0].name, "x");
        assert!(params[0].default_value.is_none());
        assert!(!params[0].is_dots);
        assert_eq!(params[1].name, "y");
        assert!(params[1].default_value.is_none());
        assert!(!params[1].is_dots);
    }

    #[test]
    fn test_extract_params_with_defaults() {
        let code = "f <- function(x = 1, y = \"hello\") { x }";
        let tree = parse_r_code(code);
        let func_node = find_function_def_in_tree(tree.root_node(), "f", code).unwrap();
        let params_node = func_node
            .children(&mut func_node.walk())
            .find(|c| c.kind() == "parameters")
            .unwrap();

        let params = extract_from_ast(params_node, code);
        assert_eq!(params.len(), 2);
        assert_eq!(params[0].name, "x");
        assert_eq!(params[0].default_value.as_deref(), Some("1"));
        assert_eq!(params[1].name, "y");
        assert_eq!(params[1].default_value.as_deref(), Some("\"hello\""));
    }

    #[test]
    fn test_extract_params_with_dots() {
        let code = "f <- function(...) { list(...) }";
        let tree = parse_r_code(code);
        let func_node = find_function_def_in_tree(tree.root_node(), "f", code).unwrap();
        let params_node = func_node
            .children(&mut func_node.walk())
            .find(|c| c.kind() == "parameters")
            .unwrap();

        let params = extract_from_ast(params_node, code);
        assert_eq!(params.len(), 1);
        assert_eq!(params[0].name, "...");
        assert!(params[0].is_dots);
        assert!(params[0].default_value.is_none());
    }

    #[test]
    fn test_extract_mixed_params() {
        let code = "f <- function(x, y = 1, ...) { x }";
        let tree = parse_r_code(code);
        let func_node = find_function_def_in_tree(tree.root_node(), "f", code).unwrap();
        let params_node = func_node
            .children(&mut func_node.walk())
            .find(|c| c.kind() == "parameters")
            .unwrap();

        let params = extract_from_ast(params_node, code);
        assert_eq!(params.len(), 3);
        assert_eq!(params[0].name, "x");
        assert!(params[0].default_value.is_none());
        assert!(!params[0].is_dots);
        assert_eq!(params[1].name, "y");
        assert_eq!(params[1].default_value.as_deref(), Some("1"));
        assert!(!params[1].is_dots);
        assert_eq!(params[2].name, "...");
        assert!(params[2].is_dots);
    }

    #[test]
    fn test_extract_no_params() {
        let code = "f <- function() { 42 }";
        let tree = parse_r_code(code);
        let func_node = find_function_def_in_tree(tree.root_node(), "f", code).unwrap();
        let params_node = func_node
            .children(&mut func_node.walk())
            .find(|c| c.kind() == "parameters")
            .unwrap();

        let params = extract_from_ast(params_node, code);
        assert!(params.is_empty());
    }

    #[test]
    fn test_extract_complex_default_values() {
        let code = "f <- function(x = c(1, 2, 3), y = NULL) { x }";
        let tree = parse_r_code(code);
        let func_node = find_function_def_in_tree(tree.root_node(), "f", code).unwrap();
        let params_node = func_node
            .children(&mut func_node.walk())
            .find(|c| c.kind() == "parameters")
            .unwrap();

        let params = extract_from_ast(params_node, code);
        assert_eq!(params.len(), 2);
        assert_eq!(params[0].name, "x");
        assert_eq!(params[0].default_value.as_deref(), Some("c(1, 2, 3)"));
        assert_eq!(params[1].name, "y");
        assert_eq!(params[1].default_value.as_deref(), Some("NULL"));
    }

    // -- find_function_definition_before_position tests --

    #[test]
    fn test_find_func_def_before_position() {
        let code = "f <- function(x) { x }\ng <- function(y) { y }\nf(1)";
        let tree = parse_r_code(code);

        // At line 2 (the call site), both f and g should be findable
        let pos = tower_lsp::lsp_types::Position::new(2, 0);
        let f_node = find_function_definition_before_position(
            tree.root_node(),
            "f",
            code,
            pos,
        );
        assert!(f_node.is_some());

        let g_node = find_function_definition_before_position(
            tree.root_node(),
            "g",
            code,
            pos,
        );
        assert!(g_node.is_some());
    }

    #[test]
    fn test_find_func_def_not_before_position() {
        let code = "f(1)\nf <- function(x) { x }";
        let tree = parse_r_code(code);

        // At line 0 (before the definition), f should not be found
        let pos = tower_lsp::lsp_types::Position::new(0, 0);
        let result = find_function_definition_before_position(
            tree.root_node(),
            "f",
            code,
            pos,
        );
        // The definition is on line 1, cursor is on line 0
        assert!(result.is_none());
    }

    #[test]
    fn test_find_func_def_nearest_wins() {
        let code = "f <- function(x) { x }\nf <- function(x, y) { x + y }\nf(1)";
        let tree = parse_r_code(code);

        // At line 2, the second definition (line 1) should win
        let pos = tower_lsp::lsp_types::Position::new(2, 0);
        let func_node = find_function_definition_before_position(
            tree.root_node(),
            "f",
            code,
            pos,
        )
        .unwrap();

        let params_node = func_node
            .children(&mut func_node.walk())
            .find(|c| c.kind() == "parameters")
            .unwrap();
        let params = extract_from_ast(params_node, code);
        assert_eq!(params.len(), 2); // Second definition has 2 params
    }

    // -- SignatureCache Debug --

    #[test]
    fn test_cache_debug_format() {
        let cache = SignatureCache::new(10, 10);
        let debug_str = format!("{:?}", cache);
        assert!(debug_str.contains("SignatureCache"));
    }

    // -- Helper for tests --

    /// Find a function_definition node by name in the tree (for test use).
    fn find_function_def_in_tree<'a>(
        node: Node<'a>,
        name: &str,
        text: &str,
    ) -> Option<Node<'a>> {
        if node.kind() == "binary_operator" {
            let mut cursor = node.walk();
            let children: Vec<_> = node.children(&mut cursor).collect();

            if children.len() >= 3 {
                let lhs = children[0];
                let op = children[1];
                let rhs = children[2];

                let op_text = node_text(op, text);
                if matches!(op_text, "<-" | "=" | "<<-")
                    && lhs.kind() == "identifier"
                    && node_text(lhs, text) == name
                    && rhs.kind() == "function_definition"
                {
                    return Some(rhs);
                }
            }
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if let Some(func_node) = find_function_def_in_tree(child, name, text) {
                return Some(func_node);
            }
        }

        None
    }
}

#[cfg(test)]
mod property_tests {
    use super::*;
    use proptest::prelude::*;

    /// Parse R code using a fresh parser (test-only).
    fn parse_r_code(code: &str) -> tree_sitter::Tree {
        let mut parser = tree_sitter::Parser::new();
        let language = tree_sitter_r::LANGUAGE;
        parser
            .set_language(&language.into())
            .expect("Error loading R grammar");
        parser.parse(code, None).expect("Error parsing R code")
    }

    /// Strategy to generate valid R parameter names.
    /// R identifiers start with a letter or `.` (if followed by non-digit),
    /// and can contain letters, digits, `.`, and `_`.
    /// We keep it simple: start with a lowercase letter, then alphanumeric/dot/underscore.
    fn r_param_name() -> impl Strategy<Value = String> {
        "[a-z][a-z0-9._]{0,7}"
            .prop_filter("must not be empty", |s| !s.is_empty())
            .prop_filter("must not be a reserved word", |s| {
                !matches!(
                    s.as_str(),
                    "if" | "else"
                        | "for"
                        | "in"
                        | "while"
                        | "repeat"
                        | "function"
                        | "return"
                        | "next"
                        | "break"
                        | "TRUE"
                        | "FALSE"
                        | "NULL"
                        | "Inf"
                        | "NaN"
                        | "NA"
                )
            })
    }

    /// Strategy to generate a simple R default value expression.
    fn r_default_value() -> impl Strategy<Value = String> {
        prop_oneof![
            // Numeric literals
            (1..1000i32).prop_map(|n| n.to_string()),
            // String literals
            "[a-z]{1,5}".prop_map(|s| format!("\"{}\"", s)),
            // Boolean/NULL
            Just("TRUE".to_string()),
            Just("FALSE".to_string()),
            Just("NULL".to_string()),
        ]
    }

    /// Strategy to generate a single parameter definition (name with optional default).
    fn r_param_def() -> impl Strategy<Value = (String, Option<String>)> {
        r_param_name().prop_flat_map(|name| {
            let name_clone = name.clone();
            prop_oneof![
                // No default value
                Just((name.clone(), None)),
                // With a default value
                r_default_value().prop_map(move |val| (name_clone.clone(), Some(val))),
            ]
        })
    }

    /// Strategy to generate a list of unique parameter definitions (0-6 params).
    fn r_param_list(min: usize, max: usize) -> impl Strategy<Value = Vec<(String, Option<String>)>> {
        prop::collection::vec(r_param_def(), min..=max).prop_filter(
            "parameter names must be unique",
            |params| {
                let mut seen = std::collections::HashSet::new();
                params.iter().all(|(name, _)| seen.insert(name.clone()))
            },
        )
    }

    /// Build an R function definition string from parameter definitions.
    fn build_function_code(
        func_name: &str,
        params: &[(String, Option<String>)],
        include_dots: bool,
    ) -> String {
        let mut param_strs: Vec<String> = params
            .iter()
            .map(|(name, default)| match default {
                Some(val) => format!("{} = {}", name, val),
                None => name.clone(),
            })
            .collect();

        if include_dots {
            param_strs.push("...".to_string());
        }

        format!("{} <- function({}) {{ NULL }}", func_name, param_strs.join(", "))
    }

    /// Find the function_definition node in the tree (test helper).
    fn find_function_def_in_tree<'a>(
        node: Node<'a>,
        name: &str,
        text: &str,
    ) -> Option<Node<'a>> {
        if node.kind() == "binary_operator" {
            let mut cursor = node.walk();
            let children: Vec<_> = node.children(&mut cursor).collect();

            if children.len() >= 3 {
                let lhs = children[0];
                let op = children[1];
                let rhs = children[2];

                let op_text = node_text(op, text);
                if matches!(op_text, "<-" | "=" | "<<-")
                    && lhs.kind() == "identifier"
                    && node_text(lhs, text) == name
                    && rhs.kind() == "function_definition"
                {
                    return Some(rhs);
                }
            }
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if let Some(func_node) = find_function_def_in_tree(child, name, text) {
                return Some(func_node);
            }
        }

        None
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]

        // ============================================================================
        // Feature: function-parameter-completions, Property 3: Parameter Extraction Round-Trip
        //
        // For any user-defined R function with parameters, extracting parameters
        // from the AST SHALL produce parameter names that match the original
        // formal parameter names in declaration order.
        //
        // **Validates: Requirements 4.1**
        // ============================================================================

        /// Generate R function definitions with varying parameter counts and defaults;
        /// verify extracted parameter names match original formal parameter names in
        /// declaration order, and default values are correctly extracted when present.
        #[test]
        fn prop_parameter_extraction_round_trip(
            params in r_param_list(0, 6),
            include_dots in proptest::bool::ANY,
        ) {
            let code = build_function_code("test_fn", &params, include_dots);

            let tree = parse_r_code(&code);
            let func_node = find_function_def_in_tree(tree.root_node(), "test_fn", &code);
            prop_assert!(
                func_node.is_some(),
                "Failed to find function definition in code: {}",
                code
            );
            let func_node = func_node.unwrap();

            let params_node = func_node
                .children(&mut func_node.walk())
                .find(|c| c.kind() == "parameters");
            prop_assert!(
                params_node.is_some(),
                "Failed to find parameters node in code: {}",
                code
            );
            let params_node = params_node.unwrap();

            let extracted = extract_from_ast(params_node, &code);

            // Expected count: original params + dots (if included)
            let expected_count = params.len() + if include_dots { 1 } else { 0 };
            prop_assert_eq!(
                extracted.len(),
                expected_count,
                "Parameter count mismatch for code: {} (expected {}, got {})",
                code,
                expected_count,
                extracted.len()
            );

            // Verify each original parameter name and default in declaration order
            for (i, (expected_name, expected_default)) in params.iter().enumerate() {
                prop_assert_eq!(
                    &extracted[i].name,
                    expected_name,
                    "Parameter name mismatch at index {} in code: {}",
                    i,
                    code
                );
                prop_assert!(
                    !extracted[i].is_dots,
                    "Parameter at index {} should not be dots in code: {}",
                    i,
                    code
                );

                // Verify default value round-trip
                match expected_default {
                    Some(val) => {
                        prop_assert_eq!(
                            extracted[i].default_value.as_deref(),
                            Some(val.as_str()),
                            "Default value mismatch at index {} in code: {}",
                            i,
                            code
                        );
                    }
                    None => {
                        prop_assert!(
                            extracted[i].default_value.is_none(),
                            "Expected no default at index {} but got {:?} in code: {}",
                            i,
                            extracted[i].default_value,
                            code
                        );
                    }
                }
            }

            // Verify dots parameter if included
            if include_dots {
                let dots_idx = params.len();
                prop_assert_eq!(
                    &extracted[dots_idx].name,
                    "...",
                    "Dots parameter name mismatch in code: {}",
                    code
                );
                prop_assert!(
                    extracted[dots_idx].is_dots,
                    "Dots parameter should have is_dots=true in code: {}",
                    code
                );
                prop_assert!(
                    extracted[dots_idx].default_value.is_none(),
                    "Dots parameter should have no default value in code: {}",
                    code
                );
            }
        }

        // ============================================================================
        // Feature: function-parameter-completions, Property 5: Dots Parameter Inclusion
        //
        // For any function with a `...` (dots) parameter, the parameter completions
        // SHALL include `...` as a completion item.
        //
        // **Validates: Requirements 5.5**
        // ============================================================================

        /// Generate R functions with `...` parameter at various positions (beginning,
        /// middle, end of parameter list); verify dots is included in parameter
        /// completions with `is_dots = true`, name `"..."`, and no default value.
        #[test]
        fn prop_dots_parameter_inclusion(
            params in r_param_list(0, 5),
            // Position where dots is inserted: 0 = beginning, params.len() = end
            dots_position_ratio in 0.0..=1.0f64,
        ) {
            // Always include dots — compute insertion position from ratio
            let dots_pos = if params.is_empty() {
                0
            } else {
                let pos = (dots_position_ratio * (params.len() as f64)).floor() as usize;
                pos.min(params.len())
            };

            // Build parameter strings with dots inserted at the computed position
            let mut param_strs: Vec<String> = params
                .iter()
                .map(|(name, default)| match default {
                    Some(val) => format!("{} = {}", name, val),
                    None => name.clone(),
                })
                .collect();
            param_strs.insert(dots_pos, "...".to_string());

            let code = format!(
                "test_fn <- function({}) {{ NULL }}",
                param_strs.join(", ")
            );

            let tree = parse_r_code(&code);
            let func_node = find_function_def_in_tree(tree.root_node(), "test_fn", &code);
            prop_assert!(
                func_node.is_some(),
                "Failed to find function definition in code: {}",
                code
            );
            let func_node = func_node.unwrap();

            let params_node = func_node
                .children(&mut func_node.walk())
                .find(|c| c.kind() == "parameters");
            prop_assert!(
                params_node.is_some(),
                "Failed to find parameters node in code: {}",
                code
            );
            let params_node = params_node.unwrap();

            let extracted = extract_from_ast(params_node, &code);

            // Total count: original params + 1 for dots
            let expected_count = params.len() + 1;
            prop_assert_eq!(
                extracted.len(),
                expected_count,
                "Parameter count mismatch for code: {} (expected {}, got {})",
                code,
                expected_count,
                extracted.len()
            );

            // Verify dots is present at the correct position
            let dots_param = &extracted[dots_pos];
            prop_assert_eq!(
                &dots_param.name,
                "...",
                "Dots parameter at position {} should have name '...' in code: {}",
                dots_pos,
                code
            );
            prop_assert!(
                dots_param.is_dots,
                "Dots parameter at position {} should have is_dots=true in code: {}",
                dots_pos,
                code
            );
            prop_assert!(
                dots_param.default_value.is_none(),
                "Dots parameter at position {} should have no default value in code: {}",
                dots_pos,
                code
            );

            // Verify non-dots parameters are correct and in order
            let mut param_idx = 0;
            for (i, extracted_param) in extracted.iter().enumerate() {
                if i == dots_pos {
                    // Already verified dots above
                    continue;
                }
                prop_assert!(
                    param_idx < params.len(),
                    "More non-dots params than expected at index {} in code: {}",
                    i,
                    code
                );
                let (expected_name, _) = &params[param_idx];
                prop_assert_eq!(
                    &extracted_param.name,
                    expected_name,
                    "Non-dots parameter name mismatch at extracted index {}, param index {} in code: {}",
                    i,
                    param_idx,
                    code
                );
                prop_assert!(
                    !extracted_param.is_dots,
                    "Non-dots parameter at index {} should not have is_dots=true in code: {}",
                    i,
                    code
                );
                param_idx += 1;
            }

            // Also verify dots is findable via iteration (simulating completion list search)
            let dots_found = extracted.iter().any(|p| p.is_dots && p.name == "...");
            prop_assert!(
                dots_found,
                "Dots parameter should be findable in extracted params for code: {}",
                code
            );
        }

        // ============================================================================
        // Feature: function-parameter-completions, Property 10: Cache Consistency
        //
        // For any function signature inserted into the cache, subsequent lookups
        // with the same key SHALL return the cached signature without invoking
        // R subprocess.
        //
        // **Validates: Requirements 2.5, 3.5**
        // ============================================================================

        /// Insert a signature into cache, then look it up; verify the cached
        /// signature is returned with all fields preserved (parameter names,
        /// default values, is_dots flags). Tests both package and user caches.
        #[test]
        fn prop_cache_consistency(
            func_name in "[a-z][a-z0-9._]{0,7}",
            params in r_param_list(0, 6),
            include_dots in proptest::bool::ANY,
            // Whether to test package cache (true) or user cache (false)
            use_package_cache in proptest::bool::ANY,
        ) {
            // Build parameter list from generated params
            let mut parameters: Vec<ParameterInfo> = params
                .iter()
                .map(|(name, default)| ParameterInfo {
                    name: name.clone(),
                    default_value: default.clone(),
                    is_dots: false,
                })
                .collect();

            if include_dots {
                parameters.push(ParameterInfo {
                    name: "...".to_string(),
                    default_value: None,
                    is_dots: true,
                });
            }

            // Build the signature to insert
            let signature = if use_package_cache {
                FunctionSignature {
                    parameters: parameters.clone(),
                    source: SignatureSource::RSubprocess {
                        package: Some("testpkg".to_string()),
                    },
                }
            } else {
                FunctionSignature {
                    parameters: parameters.clone(),
                    source: SignatureSource::CurrentFile {
                        uri: Url::parse("file:///test/file.R").unwrap(),
                        line: 1,
                    },
                }
            };

            // Create a fresh cache for each test case
            let cache = SignatureCache::new(500, 200);

            // Build the cache key
            let key = if use_package_cache {
                format!("testpkg::{}", func_name)
            } else {
                format!("file:///test/file.R#{}", func_name)
            };

            // Verify the key is not in cache before insertion
            let before = if use_package_cache {
                cache.get_package(&key)
            } else {
                cache.get_user(&key)
            };
            prop_assert!(
                before.is_none(),
                "Cache should be empty before insertion for key: {}",
                key
            );

            // Insert the signature into the appropriate cache
            if use_package_cache {
                cache.insert_package(key.clone(), signature.clone());
            } else {
                cache.insert_user(key.clone(), signature.clone());
            }

            // Look up the signature from cache
            let cached = if use_package_cache {
                cache.get_package(&key)
            } else {
                cache.get_user(&key)
            };

            // Verify the cached signature is returned (not None)
            prop_assert!(
                cached.is_some(),
                "Cache lookup should return Some after insertion for key: {}",
                key
            );
            let cached = cached.unwrap();

            // Verify parameter count is preserved
            prop_assert_eq!(
                cached.parameters.len(),
                parameters.len(),
                "Cached parameter count mismatch for key: {} (expected {}, got {})",
                key,
                parameters.len(),
                cached.parameters.len()
            );

            // Verify each parameter's fields are preserved
            for (i, (expected, actual)) in parameters.iter().zip(cached.parameters.iter()).enumerate() {
                prop_assert_eq!(
                    &actual.name,
                    &expected.name,
                    "Parameter name mismatch at index {} for key: {}",
                    i,
                    key
                );
                prop_assert_eq!(
                    &actual.default_value,
                    &expected.default_value,
                    "Default value mismatch at index {} for key: {}",
                    i,
                    key
                );
                prop_assert_eq!(
                    actual.is_dots,
                    expected.is_dots,
                    "is_dots mismatch at index {} for key: {}",
                    i,
                    key
                );
            }

            // Verify the wrong cache type does NOT return the signature
            let wrong_cache = if use_package_cache {
                cache.get_user(&key)
            } else {
                cache.get_package(&key)
            };
            prop_assert!(
                wrong_cache.is_none(),
                "Signature should not be found in the wrong cache type for key: {}",
                key
            );

            // Verify a second lookup also returns the same signature (cache is stable)
            let second_lookup = if use_package_cache {
                cache.get_package(&key)
            } else {
                cache.get_user(&key)
            };
            prop_assert!(
                second_lookup.is_some(),
                "Second cache lookup should also return Some for key: {}",
                key
            );
            let second = second_lookup.unwrap();
            prop_assert_eq!(
                second.parameters.len(),
                parameters.len(),
                "Second lookup parameter count mismatch for key: {}",
                key
            );
        }

        // ============================================================================
        // Feature: function-parameter-completions, Property 13: Cache Invalidation on File Change
        //
        // For any user-defined function signature in the cache, invalidating the
        // file that defines it SHALL remove the signature from the cache so
        // subsequent lookups return None.
        //
        // **Validates: Requirements 9.2**
        // ============================================================================

        /// Insert user-defined signatures for a file, invalidate that file, verify
        /// subsequent lookups return None. Tests that invalidation only affects
        /// signatures from the specified file, not other files.
        #[test]
        fn prop_cache_invalidation_on_file_change(
            func_names in prop::collection::vec("[a-z][a-z0-9._]{0,7}", 1..=5),
            params in r_param_list(0, 4),
        ) {
            // Create a fresh cache for each test case
            let cache = SignatureCache::new(500, 200);

            // Build parameter list from generated params
            let parameters: Vec<ParameterInfo> = params
                .iter()
                .map(|(name, default)| ParameterInfo {
                    name: name.clone(),
                    default_value: default.clone(),
                    is_dots: false,
                })
                .collect();

            // Test file URIs
            let test_uri = Url::parse("file:///test/file.R").unwrap();
            let other_uri = Url::parse("file:///test/other.R").unwrap();

            // Insert signatures for the test file
            let mut test_keys = Vec::new();
            for func_name in &func_names {
                let key = format!("{}#{}", test_uri, func_name);
                let signature = FunctionSignature {
                    parameters: parameters.clone(),
                    source: SignatureSource::CurrentFile {
                        uri: test_uri.clone(),
                        line: 1,
                    },
                };
                cache.insert_user(key.clone(), signature);
                test_keys.push(key);
            }

            // Insert a signature for a different file (should not be affected)
            let other_key = format!("{}#other_func", other_uri);
            let other_signature = FunctionSignature {
                parameters: parameters.clone(),
                source: SignatureSource::CurrentFile {
                    uri: other_uri.clone(),
                    line: 1,
                },
            };
            cache.insert_user(other_key.clone(), other_signature);

            // Verify all signatures are in cache before invalidation
            for key in &test_keys {
                let before = cache.get_user(key);
                prop_assert!(
                    before.is_some(),
                    "Signature should be in cache before invalidation for key: {}",
                    key
                );
            }
            let other_before = cache.get_user(&other_key);
            prop_assert!(
                other_before.is_some(),
                "Other file signature should be in cache before invalidation"
            );

            // Invalidate the test file
            cache.invalidate_file(&test_uri);

            // Verify all test file signatures are removed
            for key in &test_keys {
                let after = cache.get_user(key);
                prop_assert!(
                    after.is_none(),
                    "Signature should be removed from cache after invalidation for key: {}",
                    key
                );
            }

            // Verify the other file's signature is NOT affected
            let other_after = cache.get_user(&other_key);
            prop_assert!(
                other_after.is_some(),
                "Other file signature should remain in cache after invalidating different file"
            );

            // Verify re-insertion works after invalidation
            let first_key = &test_keys[0];
            let re_signature = FunctionSignature {
                parameters: parameters.clone(),
                source: SignatureSource::CurrentFile {
                    uri: test_uri.clone(),
                    line: 1,
                },
            };
            cache.insert_user(first_key.clone(), re_signature);

            let re_lookup = cache.get_user(first_key);
            prop_assert!(
                re_lookup.is_some(),
                "Re-inserted signature should be retrievable after invalidation for key: {}",
                first_key
            );
        }
    }
}
