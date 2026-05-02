//
// state.rs
//
// Copyright (C) 2022-2026 Posit Software, PBC. All rights reserved.
// Modifications copyright (C) 2026 Jonathan Marc Bearak
//

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use crate::content_provider::ContentProvider;
use crate::indentation::IndentationStyle;
use ropey::Rope;
use tower_lsp::lsp_types::TextDocumentContentChangeEvent;

/// Symbol provider configuration
///
/// Controls behavior of document symbol and workspace symbol providers.
///
/// # Configuration Options
///
/// - `workspace_max_results`: Maximum number of symbols returned by workspace symbol queries.
///   Limits results to prevent overwhelming the client with large result sets.
///   Valid range: 100-10000 (values outside this range are clamped).
///
/// # Requirements
///
/// - **11.1**: Default value of 1000 for workspace_max_results
/// - **11.2**: Configurable via `symbols.workspaceMaxResults` initialization option
/// - **11.3**: Valid range 100-10000 with clamping
#[derive(Debug, Clone)]
pub struct SymbolConfig {
    /// Maximum workspace symbol results (default: 1000)
    ///
    /// When a workspace symbol query returns more results than this limit,
    /// the results are truncated. Valid range: 100-10000.
    pub workspace_max_results: usize,

    /// Whether the client supports hierarchical document symbols.
    ///
    /// When true, the document symbol provider returns `DocumentSymbol[]` (nested structure).
    /// When false, it returns `SymbolInformation[]` (flat structure) as fallback.
    ///
    /// This capability is detected from the client's `InitializeParams` at:
    /// `params.capabilities.text_document.document_symbol.hierarchical_document_symbol_support`
    ///
    /// Requirements 1.1, 1.2: Response type selection based on client capability.
    pub hierarchical_document_symbol_support: bool,
}

impl Default for SymbolConfig {
    fn default() -> Self {
        Self {
            workspace_max_results: 1000,
            // Default to false (flat response) until client capability is detected
            hierarchical_document_symbol_support: false,
        }
    }
}

impl SymbolConfig {
    /// Minimum allowed value for workspace_max_results
    pub const MIN_WORKSPACE_MAX_RESULTS: usize = 100;

    /// Maximum allowed value for workspace_max_results
    pub const MAX_WORKSPACE_MAX_RESULTS: usize = 10000;

    /// Default value for workspace_max_results (used in tests)
    #[cfg(test)]
    pub const DEFAULT_WORKSPACE_MAX_RESULTS: usize = 1000;

    /// Create a new SymbolConfig with the given workspace_max_results value.
    ///
    /// The value is clamped to the valid range [100, 10000].
    /// The hierarchical_document_symbol_support field defaults to false.
    ///
    /// # Examples
    ///
    /// ```text
    /// let config = SymbolConfig::with_max_results(500);
    /// assert_eq!(config.workspace_max_results, 500);
    ///
    /// // Values below minimum are clamped
    /// let config = SymbolConfig::with_max_results(50);
    /// assert_eq!(config.workspace_max_results, 100);
    ///
    /// // Values above maximum are clamped
    /// let config = SymbolConfig::with_max_results(20000);
    /// assert_eq!(config.workspace_max_results, 10000);
    /// ```
    pub fn with_max_results(value: usize) -> Self {
        Self {
            workspace_max_results: value.clamp(
                Self::MIN_WORKSPACE_MAX_RESULTS,
                Self::MAX_WORKSPACE_MAX_RESULTS,
            ),
            hierarchical_document_symbol_support: false,
        }
    }
}

/// Completion provider configuration
///
/// Controls behavior of the completion trigger characters and related UI settings.
#[derive(Debug, Clone)]
pub struct CompletionConfig {
    /// Whether typing `(` triggers parameter completions.
    /// When true, `(` is registered as a completion trigger character so that
    /// parameter suggestions appear immediately when opening a function call.
    pub trigger_on_open_paren: bool,
}

impl Default for CompletionConfig {
    fn default() -> Self {
        Self {
            trigger_on_open_paren: true,
        }
    }
}

/// Indentation configuration settings.
#[derive(Debug, Clone, Default)]
pub struct IndentationSettings {
    /// Indentation style for R code formatting.
    /// _Requirements: 7.1, 7.2, 7.3, 7.4_
    pub style: IndentationStyle,
}

use tower_lsp::lsp_types::Url;
use tree_sitter::Parser;
use tree_sitter::Tree;

use crate::content_provider::DefaultContentProvider;
use crate::cross_file::revalidation::CrossFileDiagnosticsGate;
use crate::cross_file::{
    CrossFileActivityState, CrossFileConfig, CrossFileFileCache, CrossFileRevalidationState,
    CrossFileWorkspaceIndex, DependencyGraph, MetadataCache,
};
use crate::document_store::DocumentStore;
use crate::file_type::{file_type_from_language_id_or_uri, file_type_from_uri, FileType};
use crate::package_library::PackageLibrary;
use crate::parameter_resolver::SignatureCache;
use crate::workspace_index::WorkspaceIndex;

/// A parsed document
pub struct Document {
    pub contents: Rope,
    pub tree: Option<Tree>,
    pub loaded_packages: Vec<String>,
    pub file_type: FileType,
    pub version: Option<i32>,
    pub revision: u64,
}

impl Document {
    #[cfg(test)]
    pub fn new(text: &str, version: Option<i32>) -> Self {
        Self::new_with_file_type(text, version, FileType::R)
    }

    pub fn new_with_uri(text: &str, version: Option<i32>, uri: &Url) -> Self {
        Self::new_with_file_type(text, version, file_type_from_uri(uri))
    }

    pub fn new_with_language_id(
        text: &str,
        version: Option<i32>,
        uri: &Url,
        language_id: Option<&str>,
    ) -> Self {
        Self::new_with_file_type(
            text,
            version,
            file_type_from_language_id_or_uri(language_id, uri),
        )
    }

    pub fn new_with_file_type(text: &str, version: Option<i32>, file_type: FileType) -> Self {
        let contents = Rope::from_str(text);
        let tree = parse_document(&contents, file_type);
        let loaded_packages = extract_loaded_packages(&tree, text);
        Self {
            contents,
            tree,
            loaded_packages,
            file_type,
            version,
            revision: 0,
        }
    }

    pub fn apply_change(&mut self, change: TextDocumentContentChangeEvent) {
        if let Some(range) = change.range {
            let start_line = range.start.line as usize;
            let start_utf16_char = range.start.character as usize;
            let end_line = range.end.line as usize;
            let end_utf16_char = range.end.character as usize;

            let start_line_text = self.contents.line(start_line).to_string();
            let end_line_text = self.contents.line(end_line).to_string();

            let start_char = utf16_offset_to_char_offset(&start_line_text, start_utf16_char);
            let end_char = utf16_offset_to_char_offset(&end_line_text, end_utf16_char);

            let start_idx = self.contents.line_to_char(start_line) + start_char;
            let end_idx = self.contents.line_to_char(end_line) + end_char;

            self.contents.remove(start_idx..end_idx);
            self.contents.insert(start_idx, &change.text);
        } else {
            // Full document sync
            self.contents = Rope::from_str(&change.text);
        }

        self.revision += 1;
        self.tree = parse_document(&self.contents, self.file_type);
        let text = self.contents.to_string();
        self.loaded_packages = extract_loaded_packages(&self.tree, &text);
    }

    #[allow(dead_code)]
    pub fn contents_hash(&self) -> u64 {
        self.revision
    }

    pub fn text(&self) -> String {
        self.contents.to_string()
    }
}

fn utf16_offset_to_char_offset(line_text: &str, utf16_offset: usize) -> usize {
    let mut utf16_count = 0;
    let mut char_count = 0;

    for ch in line_text.chars() {
        if utf16_count >= utf16_offset {
            return char_count;
        }
        utf16_count += ch.len_utf16();
        char_count += 1;
    }
    char_count
}

fn parse_r(contents: &Rope) -> Option<Tree> {
    let mut parser = Parser::new();
    parser.set_language(&tree_sitter_r::LANGUAGE.into()).ok()?;
    let text = contents.to_string();
    parser.parse(&text, None)
}

fn parse_document(contents: &Rope, file_type: FileType) -> Option<Tree> {
    match file_type {
        FileType::R | FileType::Jags | FileType::Stan => parse_r(contents),
    }
}

fn extract_loaded_packages(tree: &Option<Tree>, text: &str) -> Vec<String> {
    let Some(tree) = tree else {
        return Vec::new();
    };

    let mut packages = Vec::new();
    let mut stack = Vec::new();
    stack.push(tree.root_node());

    while let Some(node) = stack.pop() {
        if node.kind() == "call" {
            // Check if this is a library/require/loadNamespace call
            if let Some(func_node) = node.child_by_field_name("function") {
                let func_text = &text[func_node.byte_range()];

                if func_text == "library" || func_text == "require" || func_text == "loadNamespace"
                {
                    // Extract the first argument
                    if let Some(args_node) = node.child_by_field_name("arguments") {
                        for i in 0..args_node.child_count() {
                            if let Some(child) = args_node.child(i) {
                                if child.kind() == "argument" {
                                    if let Some(value_node) = child.child_by_field_name("value") {
                                        let value_text = &text[value_node.byte_range()];
                                        let pkg_name = value_text
                                            .trim_matches(|c: char| c == '"' || c == '\'');
                                        packages.push(pkg_name.to_string());
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        let child_count = node.child_count();
        for i in (0..child_count).rev() {
            if let Some(child) = node.child(i) {
                stack.push(child);
            }
        }
    }
    packages
}

/// Package metadata loaded from disk
#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct Package {
    pub name: String,
    pub path: PathBuf,
    pub exports: Vec<String>,
    pub description: Option<String>,
    pub version: Option<String>,
}

impl Package {
    #[allow(dead_code)]
    pub fn load(path: &Path) -> Option<Self> {
        let description_path = path.join("DESCRIPTION");
        if !description_path.exists() {
            return None;
        }

        let description_text = fs::read_to_string(&description_path).ok()?;
        let name = parse_dcf_field(&description_text, "Package")?;
        let version = parse_dcf_field(&description_text, "Version");
        let title = parse_dcf_field(&description_text, "Title");

        // Parse NAMESPACE for exports
        let exports = parse_namespace_exports(&path.join("NAMESPACE"));

        // Also include symbols from INDEX file (for datasets)
        let mut all_exports = exports;
        if let Some(index_exports) = parse_index(&path.join("INDEX")) {
            all_exports.extend(index_exports);
            all_exports.sort();
            all_exports.dedup();
        }

        Some(Self {
            name,
            path: path.to_path_buf(),
            exports: all_exports,
            description: title,
            version,
        })
    }
}

#[allow(dead_code)]
fn parse_dcf_field(text: &str, field: &str) -> Option<String> {
    for line in text.lines() {
        if line.starts_with(field) && line.contains(':') {
            let value = line.split_once(':')?.1.trim();
            return Some(value.to_string());
        }
    }
    None
}

#[allow(dead_code)]
fn parse_namespace_exports(path: &PathBuf) -> Vec<String> {
    let mut exports = Vec::new();

    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return exports,
    };

    // Simple regex-free parsing of NAMESPACE export directives
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("export(") {
            // export(foo, bar, baz)
            if let Some(args) = line
                .strip_prefix("export(")
                .and_then(|s| s.strip_suffix(')'))
            {
                for arg in args.split(',') {
                    let sym = arg.trim().trim_matches('"');
                    if !sym.is_empty() {
                        exports.push(sym.to_string());
                    }
                }
            }
        } else if line.starts_with("exportPattern(") {
            // We can't expand patterns without R, skip
        } else if line.starts_with("S3method(") {
            // S3method(print, foo) exports print.foo
            if let Some(args) = line
                .strip_prefix("S3method(")
                .and_then(|s| s.strip_suffix(')'))
            {
                let parts: Vec<&str> = args.split(',').map(|s| s.trim()).collect();
                if parts.len() >= 2 {
                    let method = format!("{}.{}", parts[0], parts[1]);
                    exports.push(method);
                }
            }
        }
    }

    exports
}

#[allow(dead_code)]
fn parse_index(path: &PathBuf) -> Option<Vec<String>> {
    let text = fs::read_to_string(path).ok()?;
    let mut symbols = Vec::new();

    for line in text.lines() {
        // INDEX format: symbol_name<whitespace>description
        if let Some(sym) = line.split_whitespace().next() {
            if !sym.is_empty()
                && sym
                    .chars()
                    .next()
                    .map(|c| c.is_alphabetic())
                    .unwrap_or(false)
            {
                symbols.push(sym.to_string());
            }
        }
    }

    Some(symbols)
}

#[allow(dead_code)]
fn parse_namespace_imports(path: &PathBuf, library: &Library) -> Vec<(String, String)> {
    let mut imports = Vec::new();

    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return imports,
    };

    for line in text.lines() {
        let line = line.trim();

        // import(pkg) - imports all exports from pkg
        if line.starts_with("import(") {
            if let Some(args) = line
                .strip_prefix("import(")
                .and_then(|s| s.strip_suffix(')'))
            {
                for pkg_name in args.split(',') {
                    let pkg_name = pkg_name.trim().trim_matches('"');
                    if let Some(pkg) = library.get(pkg_name) {
                        for sym in &pkg.exports {
                            imports.push((pkg_name.to_string(), sym.clone()));
                        }
                    }
                }
            }
        }
        // importFrom(pkg, sym1, sym2, ...)
        else if line.starts_with("importFrom(") {
            if let Some(args) = line
                .strip_prefix("importFrom(")
                .and_then(|s| s.strip_suffix(')'))
            {
                let parts: Vec<&str> = args.split(',').map(|s| s.trim()).collect();
                if parts.len() >= 2 {
                    // First arg is package name, rest are symbols
                    let pkg = parts[0].trim_matches('"').to_string();
                    for sym in &parts[1..] {
                        let sym = sym.trim_matches('"');
                        imports.push((pkg.clone(), sym.to_string()));
                    }
                }
            }
        }
    }

    imports
}

/// Library of installed packages
#[allow(dead_code)]
pub struct Library {
    paths: Vec<PathBuf>,
    packages: RwLock<HashMap<String, Arc<Package>>>,
}

impl Library {
    pub fn new(paths: Vec<PathBuf>) -> Self {
        Self {
            paths,
            packages: RwLock::new(HashMap::new()),
        }
    }

    #[allow(dead_code)]
    pub fn get(&self, name: &str) -> Option<Arc<Package>> {
        if let Ok(packages) = self.packages.read() {
            if let Some(pkg) = packages.get(name) {
                return Some(pkg.clone());
            }
        }

        // Try to load from library paths
        for lib_path in &self.paths {
            let pkg_path = lib_path.join(name);
            if let Some(pkg) = Package::load(&pkg_path) {
                let pkg = Arc::new(pkg);
                if let Ok(mut packages) = self.packages.write() {
                    packages.insert(name.to_string(), pkg.clone());
                }
                return Some(pkg);
            }
        }

        None
    }

    /// List all installed package names
    #[allow(dead_code)]
    pub fn list_packages(&self) -> Vec<String> {
        let mut names_set = HashSet::new();
        let mut names = Vec::new();
        for lib_path in &self.paths {
            if let Ok(entries) = fs::read_dir(lib_path) {
                for entry in entries.flatten() {
                    if entry.path().join("DESCRIPTION").exists() {
                        if let Some(name) = entry.file_name().to_str() {
                            let s = name.to_string();
                            if names_set.insert(s.clone()) {
                                names.push(s);
                            }
                        }
                    }
                }
            }
        }
        names.sort();
        names
    }
}

/// Global LSP state
pub struct WorldState {
    // Document management (new architecture)
    pub document_store: DocumentStore,
    pub workspace_index_new: WorkspaceIndex,

    // Legacy fields (kept for migration compatibility)
    pub documents: HashMap<Url, Document>,
    pub workspace_index: HashMap<Url, Document>,
    /// (package, symbol) pairs from workspace NAMESPACE importFrom() entries.
    ///
    /// Wrapped in `Arc` so `DiagnosticsSnapshot::build` does a refcount bump
    /// rather than deep-cloning the entire vector on every snapshot build.
    pub workspace_imports: Arc<Vec<(String, String)>>,

    // Workspace configuration
    pub workspace_folders: Vec<Url>,
    pub library: Library,

    // Package function awareness
    // Manages installed packages, their exports, and caching for package-aware scope resolution
    // Requirement 13.4: THE Package_Cache SHALL support concurrent read access from multiple LSP handlers
    // Arc allows sharing across async tasks without holding WorldState lock
    pub package_library: Arc<PackageLibrary>,

    // Caches
    pub help_cache: crate::help::HelpCache,
    pub signature_cache: Arc<SignatureCache>,
    pub cross_file_file_cache: CrossFileFileCache,
    pub diagnostics_gate: CrossFileDiagnosticsGate,

    // Cross-file state
    pub cross_file_config: CrossFileConfig,
    /// Symbol provider configuration
    /// Controls document symbol and workspace symbol behavior
    pub symbol_config: SymbolConfig,
    /// Completion provider configuration
    pub completion_config: CompletionConfig,
    /// Indentation configuration
    pub indentation_config: IndentationSettings,
    pub cross_file_meta: MetadataCache,
    pub cross_file_graph: DependencyGraph,
    pub cross_file_revalidation: CrossFileRevalidationState,
    pub cross_file_activity: CrossFileActivityState,
    pub cross_file_workspace_index: CrossFileWorkspaceIndex,
    /// Handle to the running libpath watcher, if any. Dropping it stops watching.
    pub libpath_watcher_handle:
        Option<std::sync::Arc<super::libpath_watcher::LibpathWatcherHandle>>,
    pub package_library_ready: bool,
    /// Whether the background workspace scan has completed and the dependency
    /// graph has been populated from workspace entries. In `Auto` backward
    /// dependency mode, undefined variable diagnostics are deferred for files
    /// without explicit backward directives until this flag is true.
    pub workspace_scan_complete: bool,
}

impl WorldState {
    /// Creates a new WorldState initialized with default cross-file configuration and empty caches.
    ///
    /// The returned state is populated with:
    /// - default CrossFileConfig (logged at initialization),
    /// - empty document and workspace indexes (legacy and new),
    /// - a Library constructed from `library_paths`,
    /// - an empty, concurrently accessible PackageLibrary,
    /// - all cross-file caches and auxiliary structures in their default state.
    ///
    /// # Examples
    ///
    /// ```
    /// use std::path::PathBuf;
    /// use raven::state::WorldState;
    ///
    /// let ws = WorldState::new(vec![PathBuf::from("/usr/lib/R/library")]);
    /// // newly created state has no opened documents or workspace folders by default
    /// assert!(ws.documents.is_empty());
    /// assert!(ws.workspace_folders.is_empty());
    /// ```
    pub fn new(library_paths: Vec<PathBuf>) -> Self {
        let config = CrossFileConfig::default();

        // Log default cross-file configuration at startup
        log::info!("Initializing cross-file configuration with defaults:");
        log::info!("  max_backward_depth: {}", config.max_backward_depth);
        log::info!("  max_forward_depth: {}", config.max_forward_depth);
        log::info!("  max_chain_depth: {}", config.max_chain_depth);
        log::info!("  assume_call_site: {:?}", config.assume_call_site);
        log::info!("  index_workspace: {}", config.index_workspace);
        log::info!(
            "  max_revalidations_per_trigger: {}",
            config.max_revalidations_per_trigger
        );
        log::info!(
            "  revalidation_debounce_ms: {}",
            config.revalidation_debounce_ms
        );
        log::info!(
            "  undefined_variables_enabled: {}",
            config.undefined_variables_enabled
        );
        log::info!("  Diagnostic severities:");
        log::info!("    missing_file: {:?}", config.missing_file_severity);
        log::info!(
            "    circular_dependency: {:?}",
            config.circular_dependency_severity
        );
        log::info!("    out_of_scope: {:?}", config.out_of_scope_severity);
        log::info!(
            "    ambiguous_parent: {:?}",
            config.ambiguous_parent_severity
        );
        log::info!("    max_chain_depth: {:?}", config.max_chain_depth_severity);

        Self {
            // New architecture components
            document_store: DocumentStore::new(Default::default()),
            workspace_index_new: WorkspaceIndex::new(Default::default()),

            // Legacy fields (kept for migration compatibility)
            documents: HashMap::new(),
            workspace_index: HashMap::new(),
            workspace_imports: Arc::new(Vec::new()),

            // Workspace configuration
            workspace_folders: Vec::new(),
            library: Library::new(library_paths),

            // Package function awareness
            // Initialize with empty state - will be populated via initialize() or async initialization
            // Requirement 13.4: THE Package_Cache SHALL support concurrent read access
            package_library: Arc::new(PackageLibrary::new_empty()),

            // Caches
            help_cache: crate::help::HelpCache::new(),
            signature_cache: Arc::new(SignatureCache::new(500, 200)),
            cross_file_file_cache: CrossFileFileCache::new(),
            diagnostics_gate: CrossFileDiagnosticsGate::new(),

            // Cross-file state
            cross_file_config: config,
            symbol_config: SymbolConfig::default(),
            completion_config: CompletionConfig::default(),
            indentation_config: IndentationSettings::default(),
            cross_file_meta: MetadataCache::new(),
            cross_file_graph: DependencyGraph::new(),
            cross_file_revalidation: CrossFileRevalidationState::new(),
            cross_file_activity: CrossFileActivityState::new(),
            cross_file_workspace_index: CrossFileWorkspaceIndex::new(),
            libpath_watcher_handle: None,
            package_library_ready: false,
            workspace_scan_complete: false,
        }
    }

    /// Create a content provider for this state
    ///
    /// The content provider provides a unified interface for accessing file content,
    /// metadata, and artifacts. It respects the open-docs-authoritative rule:
    /// open documents always take precedence over indexed data.
    ///
    /// This method creates a content provider with legacy field support for
    /// migration compatibility. During the migration period, both old and new
    /// fields are checked.
    ///
    /// **Validates: Requirements 4.1, 13.1, 13.2**
    pub fn content_provider(&self) -> DefaultContentProvider<'_> {
        DefaultContentProvider::with_legacy(
            &self.document_store,
            &self.workspace_index_new,
            &self.cross_file_file_cache,
            &self.documents,
            &self.workspace_index,
            &self.cross_file_workspace_index,
        )
    }

    /// Build a snapshot of the dependency neighborhood for package scope
    /// resolution. The snapshot includes artifacts/metadata for all files
    /// reachable from `docs` via the cross-file dependency graph (not just
    /// open documents), so inherited packages from closed parent files are
    /// discovered.
    ///
    /// Call this under the read lock, then drop the lock before running
    /// `scope_at_position_with_graph` against the returned snapshot.
    pub(crate) fn build_package_scope_snapshot(
        &self,
        docs: &[(Url, u32)],
    ) -> crate::backend::ScopeProbeSnapshot {
        let max_depth = self.cross_file_config.max_chain_depth;
        let max_visited = self.cross_file_config.max_transitive_dependents_visited;
        // Scale the shared visited budget with seed count so workspaces with many
        // open files retain coverage equivalent to the old per-seed loop, capped to
        // bound lock-hold time when the user has hundreds of files open.
        let effective_max_visited = max_visited
            .saturating_mul(docs.len().max(1))
            .min(max_visited.saturating_mul(50));

        let neighborhood = self.cross_file_graph.collect_neighborhood_multi(
            docs.iter().map(|(uri, _)| uri.clone()),
            max_depth,
            effective_max_visited,
        );

        let content_provider = self.content_provider();
        let mut artifacts_map = HashMap::with_capacity(neighborhood.len());
        let mut metadata_map = HashMap::with_capacity(neighborhood.len());
        for u in &neighborhood {
            if let Some(a) = content_provider.get_artifacts(u) {
                artifacts_map.insert(u.clone(), a);
            }
            if let Some(m) = content_provider.get_metadata(u) {
                metadata_map.insert(u.clone(), m);
            }
        }

        crate::backend::ScopeProbeSnapshot {
            docs: docs.to_vec(),
            artifacts_map,
            metadata_map,
            doc_loaded_packages: self
                .documents
                .iter()
                .map(|(uri, doc)| (uri.clone(), doc.loaded_packages.clone()))
                .collect(),
            graph: self.cross_file_graph.extract_subgraph(&neighborhood),
            workspace_folder: self.workspace_folders.first().cloned(),
            max_chain_depth: self.cross_file_config.max_chain_depth,
            backward_dependencies: self.cross_file_config.backward_dependencies,
        }
    }

    /// Recompute the pinned URI set across all caches that hold open-document
    /// neighborhood entries.
    ///
    /// The pinned set is the transitive dependency neighborhood of every open
    /// document — closed-but-reachable files included. Pinned entries are
    /// protected from LRU eviction in `DocumentStore`, `WorkspaceIndex`, and
    /// `CrossFileWorkspaceIndex`, so closed-but-reachable documents survive
    /// across edits to other files and avoid the `compute_artifacts_with_metadata`
    /// recomputation fallback. `DocumentStore` only physically holds open
    /// documents; closed neighbors live in the two workspace indexes, so all
    /// three caches must share the same pin set to fully cover the contract.
    ///
    /// Call after the open set changes (`did_open` / `did_close`) or after a
    /// dependency-graph edge change touches an open file.
    pub fn recompute_open_neighborhood_pins(&mut self) {
        let open_uris: Vec<Url> = self.document_store.uris();
        if open_uris.is_empty() {
            self.document_store.set_pinned_uris(HashSet::new());
            self.workspace_index_new.set_pinned_uris(HashSet::new());
            self.cross_file_workspace_index
                .set_pinned_uris(HashSet::new());
            return;
        }

        let max_depth = self.cross_file_config.max_chain_depth;
        let max_visited = self.cross_file_config.max_transitive_dependents_visited;
        // Same scaling as build_package_scope_snapshot: bound lock-hold time
        // while preserving coverage equivalent to the per-seed loop.
        let effective_max_visited = max_visited
            .saturating_mul(open_uris.len().max(1))
            .min(max_visited.saturating_mul(50));

        let neighborhood = self.cross_file_graph.collect_neighborhood_multi(
            open_uris.iter().cloned(),
            max_depth,
            effective_max_visited,
        );

        // Mirror the same neighborhood across all three caches. Cloning is
        // cheap relative to the neighborhood traversal and avoids needing
        // `Arc<HashSet<Url>>` plumbing through the existing setter signature.
        self.workspace_index_new
            .set_pinned_uris(neighborhood.clone());
        self.cross_file_workspace_index
            .set_pinned_uris(neighborhood.clone());
        self.document_store.set_pinned_uris(neighborhood);
    }

    /// Resize all LRU caches based on configuration.
    /// Called after parsing initialization options.
    pub fn resize_caches(&self, config: &crate::cross_file::config::CrossFileConfig) {
        self.cross_file_meta
            .resize(config.cache_metadata_max_entries);
        self.cross_file_file_cache.resize(
            config.cache_file_content_max_entries,
            config.cache_existence_max_entries,
        );
        self.cross_file_workspace_index
            .resize(config.cache_workspace_index_max_entries);
    }

    #[allow(dead_code)] // Retained for tests and compatibility with older call sites.
    pub fn open_document(&mut self, uri: Url, text: &str, version: Option<i32>) {
        self.documents
            .insert(uri.clone(), Document::new_with_uri(text, version, &uri));
    }

    pub fn open_document_with_language_id(
        &mut self,
        uri: Url,
        text: &str,
        version: Option<i32>,
        language_id: Option<&str>,
    ) {
        self.documents.insert(
            uri.clone(),
            Document::new_with_language_id(text, version, &uri, language_id),
        );
    }

    pub fn close_document(&mut self, uri: &Url) {
        self.documents.remove(uri);
    }

    pub fn apply_change(&mut self, uri: &Url, change: TextDocumentContentChangeEvent) {
        if let Some(doc) = self.documents.get_mut(uri) {
            doc.apply_change(change);
        }
    }

    pub fn get_document(&self, uri: &Url) -> Option<&Document> {
        self.documents.get(uri)
    }

    /// Get enriched metadata for a URI, preferring already-enriched sources.
    ///
    /// Priority order:
    /// 1. DocumentStore (open documents with enriched metadata)
    /// 2. WorkspaceIndex (new unified index)
    /// 3. Legacy cross_file_workspace_index
    /// 4. Legacy documents HashMap (re-extract metadata)
    /// 5. File cache (re-extract metadata)
    /// Find or parse `CrossFileMetadata` for `uri` for the working-directory
    /// inheritance closures used by snapshot builds and several diagnostic
    /// helpers. Walks the chain: open document → cross-file workspace index
    /// → file-cache contents. Returns an `Arc` so callers (closures bound to
    /// `compute_inherited_working_directory`) avoid deep clones.
    pub fn get_or_parse_metadata(
        &self,
        uri: &Url,
    ) -> Option<Arc<crate::cross_file::CrossFileMetadata>> {
        if let Some(doc) = self.documents.get(uri) {
            return Some(Arc::new(crate::cross_file::directive::parse_directives(
                &doc.text(),
            )));
        }
        if let Some(meta) = self.cross_file_workspace_index.get_metadata(uri) {
            return Some(meta);
        }
        let content_provider = self.content_provider();
        if let Some(content) = content_provider.get_content(uri) {
            return Some(Arc::new(crate::cross_file::extract_metadata(&content)));
        }
        None
    }

    pub fn get_enriched_metadata(
        &self,
        uri: &Url,
    ) -> Option<Arc<crate::cross_file::CrossFileMetadata>> {
        self.document_store
            .get_without_touch(uri)
            .map(|doc| doc.metadata.clone())
            .or_else(|| self.workspace_index_new.get_metadata(uri))
            .or_else(|| self.cross_file_workspace_index.get_metadata(uri))
            .or_else(|| {
                self.documents
                    .get(uri)
                    .map(|doc| Arc::new(crate::cross_file::extract_metadata(&doc.text())))
            })
            .or_else(|| {
                self.cross_file_file_cache
                    .get(uri)
                    .map(|content| Arc::new(crate::cross_file::extract_metadata(&content)))
            })
    }

    #[allow(dead_code)]
    pub fn index_workspace(&mut self) {
        let folders = self.workspace_folders.clone();
        log::info!("Indexing {} workspace folders", folders.len());
        for folder in &folders {
            log::info!("Indexing folder: {}", folder);
            if let Ok(path) = folder.to_file_path() {
                self.index_directory(&path);
            }
        }
        log::info!("Indexed {} workspace files", self.workspace_index.len());

        // Load workspace NAMESPACE imports
        self.load_workspace_namespace();
    }

    /// Apply pre-scanned workspace index results (for non-blocking initialization)
    ///
    /// **Validates: Requirements 11.1, 13.1**
    pub fn apply_workspace_index(
        &mut self,
        index: HashMap<Url, Document>,
        imports: Vec<(String, String)>,
        cross_file_entries: HashMap<Url, crate::cross_file::workspace_index::IndexEntry>,
        new_index_entries: HashMap<Url, crate::workspace_index::IndexEntry>,
    ) {
        self.workspace_index = index;
        self.workspace_imports = Arc::new(imports);

        // Populate cross-file workspace index (legacy)
        for (uri, entry) in cross_file_entries {
            log::info!(
                "Indexing cross-file entry: {} (exported symbols: {})",
                uri,
                entry.artifacts.exported_interface.len()
            );
            self.cross_file_workspace_index.insert(uri, entry);
        }

        // Populate new unified WorkspaceIndex
        for (uri, entry) in new_index_entries {
            log::trace!(
                "Indexing new workspace entry: {} (exported symbols: {})",
                uri,
                entry.artifacts.exported_interface.len()
            );
            self.workspace_index_new.insert(uri, entry);
        }

        log::info!(
            "Applied {} workspace files, {} imports, {} cross-file entries, {} new index entries",
            self.workspace_index.len(),
            self.workspace_imports.len(),
            self.cross_file_workspace_index.uris().len(),
            self.workspace_index_new.len()
        );

        // Build the dependency graph from all workspace entries so that
        // forward-created backward edges are available for auto-detect mode.
        self.build_dependency_graph_from_workspace();
        self.workspace_scan_complete = true;
        log::info!("[Background] Dependency graph built from workspace entries, workspace_scan_complete = true");

        // Now that the graph reflects the workspace, refresh the document_store
        // pin set so any file opened before the scan completes picks up its
        // neighborhood.
        self.recompute_open_neighborhood_pins();
    }

    /// Build the dependency graph from all entries in the workspace index.
    ///
    /// For each file, calls `update_file` on the dependency graph using its
    /// metadata. This creates forward edges (parent→child) and their
    /// corresponding backward entries (child→parent) for all workspace files,
    /// enabling auto-detection of backward dependencies.
    fn build_dependency_graph_from_workspace(&mut self) {
        let workspace_root = self.workspace_folders.first().cloned();

        // Collect URIs and metadata to avoid borrow conflicts with self.
        // `entry.metadata` is `Arc<CrossFileMetadata>`, so the clone is a
        // refcount bump rather than a deep clone of Vec/HashSet/String fields.
        let mut entries: Vec<(Url, Arc<crate::cross_file::CrossFileMetadata>)> = Vec::new();
        for (uri, entry) in self.workspace_index_new.iter() {
            entries.push((uri.clone(), entry.metadata.clone()));
        }

        // Destructure self to split borrows: cross_file_graph (mutable) and
        // workspace_index_new (shared) can coexist without pre-cloning all contents.
        let Self {
            cross_file_graph,
            workspace_index_new,
            ..
        } = self;

        for (uri, meta) in &entries {
            let get_content = |parent_uri: &Url| -> Option<String> {
                workspace_index_new
                    .get(parent_uri)
                    .map(|e| e.contents.to_string())
            };
            let _result = cross_file_graph.update_file(
                uri,
                meta.as_ref(),
                workspace_root.as_ref(),
                get_content,
            );
        }

        log::info!(
            "Built dependency graph from {} workspace files",
            entries.len()
        );
    }

    #[allow(dead_code)]
    fn load_workspace_namespace(&mut self) {
        for folder_url in &self.workspace_folders {
            if let Ok(folder_path) = folder_url.to_file_path() {
                let namespace_path = folder_path.join("NAMESPACE");
                if namespace_path.exists() {
                    self.workspace_imports =
                        Arc::new(parse_namespace_imports(&namespace_path, &self.library));
                    log::info!(
                        "Loaded {} workspace imports from NAMESPACE",
                        self.workspace_imports.len()
                    );
                    break; // Only process first workspace folder with NAMESPACE
                }
            }
        }
    }

    #[allow(dead_code)]
    fn index_directory(&mut self, dir: &std::path::Path) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };

        for entry in entries.flatten() {
            let path = entry.path();

            if path.is_dir() {
                if let Some(dir_name) = path.file_name().and_then(|n| n.to_str()) {
                    if should_skip_directory(dir_name) {
                        continue;
                    }
                }
                self.index_directory(&path);
            } else if is_stat_model_extension(&path) {
                if let Ok(text) = fs::read_to_string(&path) {
                    if let Ok(uri) = Url::from_file_path(&path) {
                        log::trace!("Indexing file: {}", uri);
                        self.workspace_index
                            .insert(uri.clone(), Document::new_with_uri(&text, None, &uri));
                    }
                }
            }
        }
    }
}

/// Scan workspace folders for R files without holding any locks (Requirement 13a)
///
/// Returns:
/// - `HashMap<Url, Document>` - Legacy index for backward compatibility
/// - `Vec<String>` - Workspace imports from NAMESPACE
/// - `HashMap<Url, crate::cross_file::workspace_index::IndexEntry>` - Cross-file entries (legacy)
/// - `HashMap<Url, crate::workspace_index::IndexEntry>` - New unified WorkspaceIndex entries
///
/// **Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5**
pub type WorkspaceScanResult = (
    HashMap<Url, Document>,
    Vec<(String, String)>,
    HashMap<Url, crate::cross_file::workspace_index::IndexEntry>,
    HashMap<Url, crate::workspace_index::IndexEntry>,
);

/// Result of processing a single workspace file (used by parallel scan).
struct ProcessedFile {
    uri: Url,
    document: Document,
    cross_file_entry: crate::cross_file::workspace_index::IndexEntry,
    new_index_entry: crate::workspace_index::IndexEntry,
}

/// Recursively collect file paths from a directory (serial walk, fast).
fn collect_file_paths(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut visited = HashSet::new();
    if let Ok(canonical) = fs::canonicalize(dir) {
        visited.insert(canonical);
    }
    collect_file_paths_inner(dir, out, &mut visited);
}

fn collect_file_paths_inner(dir: &Path, out: &mut Vec<PathBuf>, visited: &mut HashSet<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();

        if path.is_dir() {
            if let Some(dir_name) = path.file_name().and_then(|n| n.to_str()) {
                if should_skip_directory(dir_name) {
                    log::trace!("Skipping directory: {}", path.display());
                    continue;
                }
            }
            match fs::canonicalize(&path) {
                Ok(canonical) => {
                    if !visited.insert(canonical) {
                        log::trace!("Skipping symlink cycle: {}", path.display());
                        continue;
                    }
                }
                Err(e) => {
                    log::trace!("Skipping unresolvable dir {}: {}", path.display(), e);
                    continue;
                }
            }
            collect_file_paths_inner(&path, out, visited);
        } else if is_stat_model_extension(&path) {
            out.push(path);
        }
    }
}

/// Process a single file: read, parse, compute metadata and artifacts.
/// Returns `None` if the file can't be read or converted to a URI.
fn process_workspace_file(path: &Path) -> Option<ProcessedFile> {
    let text = fs::read_to_string(path).ok()?;
    let uri = Url::from_file_path(path).ok()?;
    let metadata_result = fs::metadata(path).ok()?;

    log::trace!("Scanning file: {}", uri);
    let doc = Document::new_with_uri(&text, None, &uri);

    let cross_file_meta = crate::cross_file::extract_metadata(&text);

    let artifacts = std::sync::Arc::new(if let Some(tree) = doc.tree.as_ref() {
        crate::cross_file::scope::compute_artifacts_with_metadata(
            &uri,
            tree,
            &text,
            Some(&cross_file_meta),
        )
    } else {
        crate::cross_file::scope::ScopeArtifacts::default()
    });

    let snapshot =
        crate::cross_file::file_cache::FileSnapshot::with_content_hash(&metadata_result, &text);
    let cross_file_meta = Arc::new(cross_file_meta);

    let cross_file_entry = crate::cross_file::workspace_index::IndexEntry {
        snapshot: snapshot.clone(),
        metadata: cross_file_meta.clone(),
        artifacts: artifacts.clone(),
        indexed_at_version: 0,
    };

    let new_index_entry = crate::workspace_index::IndexEntry {
        contents: doc.contents.clone(),
        tree: doc.tree.clone(),
        loaded_packages: doc.loaded_packages.clone(),
        snapshot,
        metadata: cross_file_meta,
        artifacts,
        indexed_at_version: 0,
    };

    Some(ProcessedFile {
        uri,
        document: doc,
        cross_file_entry,
        new_index_entry,
    })
}

pub fn scan_workspace(folders: &[Url], max_chain_depth: usize) -> WorkspaceScanResult {
    use rayon::prelude::*;

    let mut imports = Vec::new();

    // Get workspace root for path resolution
    let workspace_root = folders.first().cloned();

    // Phase 1: Collect file paths (serial directory walk — fast, I/O-bound)
    let mut file_paths: Vec<PathBuf> = Vec::new();
    for folder in folders {
        log::info!("Scanning folder: {}", folder);
        if let Ok(path) = folder.to_file_path() {
            collect_file_paths(&path, &mut file_paths);

            // Check for NAMESPACE file
            let namespace_path = path.join("NAMESPACE");
            if namespace_path.exists() && imports.is_empty() {
                if let Ok(text) = fs::read_to_string(&namespace_path) {
                    imports = parse_namespace_imports_from_text(&text);
                    log::info!("Found {} imports from NAMESPACE", imports.len());
                }
            }
        }
    }

    log::info!(
        "Collected {} file paths for parallel processing",
        file_paths.len()
    );

    // Type aliases for the thread-local accumulators used in fold/reduce.
    type IndexMap = HashMap<Url, Document>;
    type CrossFileMap = HashMap<Url, crate::cross_file::workspace_index::IndexEntry>;
    type NewIndexMap = HashMap<Url, crate::workspace_index::IndexEntry>;

    // Phase 2+3: Process files in parallel and accumulate directly into
    // thread-local HashMaps via fold, then merge with reduce. This avoids
    // an intermediate Vec<ProcessedFile> that would transiently hold all
    // file contents + ASTs and require two extra Url clones per file for
    // the serial insert loop.
    let (index, mut cross_file_entries, mut new_index_entries): (
        IndexMap,
        CrossFileMap,
        NewIndexMap,
    ) = file_paths
        .par_iter()
        .fold(
            || (IndexMap::new(), CrossFileMap::new(), NewIndexMap::new()),
            |(mut idx, mut cfe, mut nie), path| {
                if let Some(item) = process_workspace_file(path) {
                    cfe.insert(item.uri.clone(), item.cross_file_entry);
                    nie.insert(item.uri.clone(), item.new_index_entry);
                    idx.insert(item.uri, item.document);
                }
                (idx, cfe, nie)
            },
        )
        .reduce(
            || (IndexMap::new(), CrossFileMap::new(), NewIndexMap::new()),
            |(mut idx_a, mut cfe_a, mut nie_a), (idx_b, cfe_b, nie_b)| {
                idx_a.extend(idx_b);
                cfe_a.extend(cfe_b);
                nie_a.extend(nie_b);
                (idx_a, cfe_a, nie_a)
            },
        );

    // Second pass: iteratively enrich metadata with inherited_working_directory
    // Track only files that need enrichment to avoid O(n²) behavior
    let mut files_needing_enrichment: HashSet<Url> = new_index_entries
        .iter()
        .filter(|(_, entry)| {
            !entry.metadata.sourced_by.is_empty()
                && entry.metadata.working_directory.is_none()
                && entry.metadata.inherited_working_directory.is_none()
        })
        .map(|(uri, _)| uri.clone())
        .collect();

    for iteration in 0..max_chain_depth {
        if files_needing_enrichment.is_empty() {
            log::trace!(
                "Workspace scan enrichment converged after {} iteration(s)",
                iteration + 1
            );
            break;
        }

        // Build metadata map from current state
        let metadata_map: HashMap<Url, Arc<crate::cross_file::CrossFileMetadata>> =
            new_index_entries
                .iter()
                .map(|(uri, entry)| (uri.clone(), entry.metadata.clone()))
                .collect();

        let mut newly_enriched = Vec::new();

        // Only process files that need enrichment
        for uri in &files_needing_enrichment {
            if let Some(entry) = new_index_entries.get_mut(uri) {
                let old_inherited = entry.metadata.inherited_working_directory.clone();
                let meta = Arc::make_mut(&mut entry.metadata);
                crate::cross_file::enrich_metadata_with_inherited_wd(
                    meta,
                    uri,
                    workspace_root.as_ref(),
                    |parent_uri| metadata_map.get(parent_uri).cloned(),
                    max_chain_depth,
                );
                if entry.metadata.inherited_working_directory != old_inherited {
                    newly_enriched.push(uri.clone());
                }
            }
            // Also update legacy cross_file_entries
            if let Some(entry) = cross_file_entries.get_mut(uri) {
                let meta = Arc::make_mut(&mut entry.metadata);
                crate::cross_file::enrich_metadata_with_inherited_wd(
                    meta,
                    uri,
                    workspace_root.as_ref(),
                    |parent_uri| metadata_map.get(parent_uri).cloned(),
                    max_chain_depth,
                );
            }
        }

        // Remove enriched files from the set
        for uri in &newly_enriched {
            files_needing_enrichment.remove(uri);
        }

        if newly_enriched.is_empty() {
            log::trace!(
                "Workspace scan enrichment converged after {} iteration(s)",
                iteration + 1
            );
            break;
        }
    }

    log::info!(
        "Scanned {} workspace files ({} with cross-file metadata, {} new index entries)",
        index.len(),
        cross_file_entries.len(),
        new_index_entries.len()
    );
    (index, imports, cross_file_entries, new_index_entries)
}

/// Directories to skip during workspace scanning.
///
/// This is a conservative list of directories that are extremely unlikely to
/// contain user R source files. The workspace scan runs in the background,
/// so the primary goal is to avoid wasting time on directories that would
/// never contain R files.
///
/// Comparison is case-insensitive. This list is also used by the
/// `analysis-stats` CLI (via [`should_skip_directory`]).
const SKIP_DIRECTORIES: &[&str] = &[
    ".git",         // Git internal files
    ".svn",         // Subversion internal files
    ".hg",          // Mercurial internal files
    "node_modules", // JavaScript dependencies (can have 100k+ files)
    ".Rproj.user",  // RStudio user-local project state
    "renv",         // renv package library cache
    "packrat",      // packrat package library cache
    ".vscode",      // VS Code settings
    ".idea",        // JetBrains IDE settings
    "target",       // Rust build artifacts
];

/// Check if a directory should be skipped during scanning.
pub(crate) fn should_skip_directory(dir_name: &str) -> bool {
    SKIP_DIRECTORIES
        .iter()
        .any(|skip| dir_name.eq_ignore_ascii_case(skip))
}

fn is_stat_model_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|ext| {
            ext.eq_ignore_ascii_case("r")
                || ext.eq_ignore_ascii_case("jags")
                || ext.eq_ignore_ascii_case("bugs")
                || ext.eq_ignore_ascii_case("stan")
        })
}

// `scan_directory` was replaced by `collect_file_paths` + `process_workspace_file`
// for parallel scanning via rayon. See `scan_workspace`.

/// Parse NAMESPACE imports without needing a `Library` reference.
///
/// Only handles `importFrom(pkg, sym, ...)`: it returns concrete `(package, symbol)`
/// pairs that downstream diagnostic suppression can match by name. `import(pkg)`
/// (whole-namespace import) is intentionally skipped here because expanding it
/// requires reading `pkg`'s exports, which this parser has no access to during the
/// initial workspace scan (the `PackageLibrary` may not be initialized yet, and
/// even when it is, this function is called during the parallel workspace scan
/// implemented by `collect_file_paths` + `process_workspace_file` / `scan_workspace`).
///
/// The Library-aware variant `parse_namespace_imports` (above) does expand
/// `import(pkg)`. If a workspace package uses `import(pkg)` to re-export an
/// entire namespace, symbols imported that way will not appear in
/// `state.workspace_imports` and therefore will not silence undefined-variable
/// diagnostics — users will see them flagged. This is a known limitation;
/// `importFrom()` is the dominant pattern in practice (≥99% of CRAN packages).
fn parse_namespace_imports_from_text(text: &str) -> Vec<(String, String)> {
    let mut imports = Vec::new();

    for line in text.lines() {
        let line = line.trim();

        // importFrom(pkg, sym1, sym2, ...)
        // import(pkg) is not handled here — see function docs.
        if line.starts_with("importFrom(") {
            if let Some(args) = line
                .strip_prefix("importFrom(")
                .and_then(|s| s.strip_suffix(')'))
            {
                let parts: Vec<&str> = args.split(',').map(|s| s.trim()).collect();
                if parts.len() >= 2 {
                    let pkg = parts[0].trim_matches('"').to_string();
                    for sym in &parts[1..] {
                        let sym = sym.trim_matches('"');
                        imports.push((pkg.clone(), sym.to_string()));
                    }
                }
            }
        }
    }

    imports
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower_lsp::lsp_types::{Position, Range, TextDocumentContentChangeEvent};

    // Include workspace scanning tests
    include!("state_tests.rs");

    #[test]
    fn test_workspace_imports_is_arc_wrapped() {
        // Locks in S5: WorldState.workspace_imports must be Arc<Vec<...>>
        // so DiagnosticsSnapshot::build does a refcount bump rather than
        // deep-cloning the (package, symbol) Vec on every snapshot build.
        let state = WorldState::new(vec![]);
        let arc1: Arc<Vec<(String, String)>> = state.workspace_imports.clone();
        let arc2 = arc1.clone();
        assert!(Arc::ptr_eq(&arc1, &arc2), "Arc clones must share storage");
    }

    #[test]
    fn test_document_apply_change_ascii() {
        let mut doc = Document::new("hello world", None);

        // Replace "world" with "rust"
        doc.apply_change(TextDocumentContentChangeEvent {
            range: Some(Range {
                start: Position {
                    line: 0,
                    character: 6,
                },
                end: Position {
                    line: 0,
                    character: 11,
                },
            }),
            range_length: None,
            text: "rust".to_string(),
        });

        assert_eq!(doc.text(), "hello rust");
    }

    #[test]
    fn test_document_apply_change_utf16_emoji() {
        // 🎉 is 4 bytes in UTF-8, 2 UTF-16 code units
        let mut doc = Document::new("a🎉b", None);

        // Insert "x" after the emoji (UTF-16 position 3 = after 'a' + 2 for emoji)
        doc.apply_change(TextDocumentContentChangeEvent {
            range: Some(Range {
                start: Position {
                    line: 0,
                    character: 3,
                },
                end: Position {
                    line: 0,
                    character: 3,
                },
            }),
            range_length: None,
            text: "x".to_string(),
        });

        assert_eq!(doc.text(), "a🎉xb");
    }

    #[test]
    fn test_document_apply_change_utf16_cjk() {
        // CJK characters are 3 bytes in UTF-8, 1 UTF-16 code unit each
        let mut doc = Document::new("a中b", None);

        // Insert "x" after '中' (UTF-16 position 2)
        doc.apply_change(TextDocumentContentChangeEvent {
            range: Some(Range {
                start: Position {
                    line: 0,
                    character: 2,
                },
                end: Position {
                    line: 0,
                    character: 2,
                },
            }),
            range_length: None,
            text: "x".to_string(),
        });

        assert_eq!(doc.text(), "a中xb");
    }

    #[test]
    fn test_document_apply_change_utf16_delete_emoji() {
        let mut doc = Document::new("a🎉b", None);

        // Delete the emoji (UTF-16 positions 1-3)
        doc.apply_change(TextDocumentContentChangeEvent {
            range: Some(Range {
                start: Position {
                    line: 0,
                    character: 1,
                },
                end: Position {
                    line: 0,
                    character: 3,
                },
            }),
            range_length: None,
            text: "".to_string(),
        });

        assert_eq!(doc.text(), "ab");
    }

    #[test]
    fn test_document_apply_change_multiline_utf16() {
        let mut doc = Document::new("line1\n🎉line2", None);

        // Replace "line2" on second line (after emoji)
        doc.apply_change(TextDocumentContentChangeEvent {
            range: Some(Range {
                start: Position {
                    line: 1,
                    character: 2,
                }, // After emoji (2 UTF-16 units)
                end: Position {
                    line: 1,
                    character: 7,
                }, // End of "line2"
            }),
            range_length: None,
            text: "test".to_string(),
        });

        assert_eq!(doc.text(), "line1\n🎉test");
    }

    #[test]
    fn test_utf16_offset_to_char_offset_ascii() {
        let line = "hello";
        assert_eq!(utf16_offset_to_char_offset(line, 0), 0);
        assert_eq!(utf16_offset_to_char_offset(line, 3), 3);
        assert_eq!(utf16_offset_to_char_offset(line, 5), 5);
    }

    #[test]
    fn test_utf16_offset_to_char_offset_emoji() {
        // 🎉 is 2 UTF-16 code units, 1 char
        let line = "a🎉b";
        assert_eq!(utf16_offset_to_char_offset(line, 0), 0); // before 'a'
        assert_eq!(utf16_offset_to_char_offset(line, 1), 1); // after 'a', before emoji
        assert_eq!(utf16_offset_to_char_offset(line, 3), 2); // after emoji (1 + 2 UTF-16 units)
        assert_eq!(utf16_offset_to_char_offset(line, 4), 3); // after 'b'
    }

    #[test]
    fn test_utf16_offset_to_char_offset_cjk() {
        // CJK characters are 1 UTF-16 code unit each
        let line = "a中b";
        assert_eq!(utf16_offset_to_char_offset(line, 0), 0); // before 'a'
        assert_eq!(utf16_offset_to_char_offset(line, 1), 1); // after 'a'
        assert_eq!(utf16_offset_to_char_offset(line, 2), 2); // after '中'
        assert_eq!(utf16_offset_to_char_offset(line, 3), 3); // after 'b'
    }

    // ============================================================================
    // SymbolConfig Tests
    // **Validates: Requirements 11.1, 11.2, 11.3**
    // ============================================================================

    #[test]
    fn test_symbol_config_default() {
        // **Validates: Requirement 11.1**
        // The default value for workspace_max_results SHALL be 1000
        let config = SymbolConfig::default();
        assert_eq!(config.workspace_max_results, 1000);
        assert_eq!(
            config.workspace_max_results,
            SymbolConfig::DEFAULT_WORKSPACE_MAX_RESULTS
        );
    }

    #[test]
    fn test_symbol_config_constants() {
        // **Validates: Requirement 11.3**
        // Valid range is 100-10000
        assert_eq!(SymbolConfig::MIN_WORKSPACE_MAX_RESULTS, 100);
        assert_eq!(SymbolConfig::MAX_WORKSPACE_MAX_RESULTS, 10000);
        assert_eq!(SymbolConfig::DEFAULT_WORKSPACE_MAX_RESULTS, 1000);
    }

    #[test]
    fn test_symbol_config_with_max_results_valid() {
        // **Validates: Requirement 11.3**
        // Values within range should be accepted as-is
        let config = SymbolConfig::with_max_results(500);
        assert_eq!(config.workspace_max_results, 500);

        let config = SymbolConfig::with_max_results(100);
        assert_eq!(config.workspace_max_results, 100);

        let config = SymbolConfig::with_max_results(10000);
        assert_eq!(config.workspace_max_results, 10000);

        let config = SymbolConfig::with_max_results(5000);
        assert_eq!(config.workspace_max_results, 5000);
    }

    #[test]
    fn test_symbol_config_with_max_results_clamp_low() {
        // **Validates: Requirement 11.3**
        // Values below minimum should be clamped to 100
        let config = SymbolConfig::with_max_results(50);
        assert_eq!(config.workspace_max_results, 100);

        let config = SymbolConfig::with_max_results(0);
        assert_eq!(config.workspace_max_results, 100);

        let config = SymbolConfig::with_max_results(99);
        assert_eq!(config.workspace_max_results, 100);
    }

    #[test]
    fn test_symbol_config_with_max_results_clamp_high() {
        // **Validates: Requirement 11.3**
        // Values above maximum should be clamped to 10000
        let config = SymbolConfig::with_max_results(20000);
        assert_eq!(config.workspace_max_results, 10000);

        let config = SymbolConfig::with_max_results(10001);
        assert_eq!(config.workspace_max_results, 10000);

        let config = SymbolConfig::with_max_results(usize::MAX);
        assert_eq!(config.workspace_max_results, 10000);
    }

    #[test]
    fn test_symbol_config_clone() {
        let config = SymbolConfig::with_max_results(750);
        let cloned = config.clone();
        assert_eq!(cloned.workspace_max_results, 750);
        assert_eq!(
            cloned.hierarchical_document_symbol_support,
            config.hierarchical_document_symbol_support
        );
    }

    #[test]
    fn test_symbol_config_debug() {
        let config = SymbolConfig::default();
        let debug_str = format!("{:?}", config);
        assert!(debug_str.contains("SymbolConfig"));
        assert!(debug_str.contains("workspace_max_results"));
        assert!(debug_str.contains("1000"));
        assert!(debug_str.contains("hierarchical_document_symbol_support"));
    }

    // ============================================================================
    // SymbolConfig hierarchical_document_symbol_support Tests
    // **Validates: Requirements 1.1, 1.2**
    // ============================================================================

    #[test]
    fn test_symbol_config_hierarchical_support_default_false() {
        // **Validates: Requirements 1.1, 1.2**
        // Default should be false (flat response) until client capability is detected
        let config = SymbolConfig::default();
        assert!(!config.hierarchical_document_symbol_support);
    }

    #[test]
    fn test_symbol_config_with_max_results_hierarchical_default_false() {
        // **Validates: Requirements 1.1, 1.2**
        // with_max_results should also default hierarchical support to false
        let config = SymbolConfig::with_max_results(500);
        assert!(!config.hierarchical_document_symbol_support);
    }

    #[test]
    fn test_symbol_config_hierarchical_support_can_be_set() {
        // **Validates: Requirements 1.1, 1.2**
        // The field should be settable after initialization
        let mut config = SymbolConfig::default();
        assert!(!config.hierarchical_document_symbol_support);

        config.hierarchical_document_symbol_support = true;
        assert!(config.hierarchical_document_symbol_support);

        config.hierarchical_document_symbol_support = false;
        assert!(!config.hierarchical_document_symbol_support);
    }

    #[test]
    fn test_build_package_scope_snapshot_scales_budget_with_seed_count() {
        // Regression test for the multi-seed BFS budget scaling in
        // build_package_scope_snapshot. Without scaling, the shared
        // max_transitive_dependents_visited budget would truncate the BFS
        // before reaching every chain's deepest ancestor in workspaces with
        // many open files — defeating the PR's goal of finding inherited
        // packages from closed parents.
        use crate::cross_file::types::{CrossFileMetadata, ForwardSource};
        use std::path::PathBuf;

        const NUM_CHAINS: usize = 30;
        const CHAIN_LEN: usize = 10;

        let mut state = WorldState::new(vec![PathBuf::from("/tmp/raven-test-libpath")]);
        assert_eq!(
            state.cross_file_config.max_transitive_dependents_visited, 200,
            "test assumes default per-seed budget of 200"
        );
        // 30 × 10 = 300 nodes total; with an unscaled shared budget of 200
        // the BFS would truncate.
        assert!(NUM_CHAINS * CHAIN_LEN > state.cross_file_config.max_transitive_dependents_visited);

        let workspace_root = Url::parse("file:///project").unwrap();
        let chain_url = |chain: usize, level: usize| -> Url {
            Url::parse(&format!("file:///project/c{}_l{}.R", chain, level)).unwrap()
        };

        let mut seeds: Vec<(Url, u32)> = Vec::with_capacity(NUM_CHAINS);
        for chain in 0..NUM_CHAINS {
            for level in 0..CHAIN_LEN - 1 {
                let parent = chain_url(chain, level);
                let child_path = format!("c{}_l{}.R", chain, level + 1);
                let meta = CrossFileMetadata {
                    sources: vec![ForwardSource {
                        path: child_path,
                        line: 1,
                        column: 0,
                        is_directive: false,
                        local: false,
                        chdir: false,
                        is_sys_source: false,
                        sys_source_global_env: true,
                        ..Default::default()
                    }],
                    ..Default::default()
                };
                state
                    .cross_file_graph
                    .update_file(&parent, &meta, Some(&workspace_root), |_| None);
            }
            seeds.push((chain_url(chain, 0), 0));
        }

        let snapshot = state.build_package_scope_snapshot(&seeds);

        // Walk each chain root → leaf via the snapshot's subgraph.
        // If the budget truncated, get_dependencies returns empty mid-walk.
        for chain in 0..NUM_CHAINS {
            let mut current = chain_url(chain, 0);
            for level in 0..CHAIN_LEN - 1 {
                let deps = snapshot.graph.get_dependencies(&current);
                assert!(
                    !deps.is_empty(),
                    "chain {} truncated at level {}: node {} missing from snapshot subgraph",
                    chain,
                    level,
                    current
                );
                current = deps[0].to.clone();
            }
            assert_eq!(current, chain_url(chain, CHAIN_LEN - 1));
        }
    }
}
