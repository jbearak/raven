use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};

use ropey::Rope;
use tower_lsp::lsp_types::Url;

use crate::content_provider::ContentProvider;
use crate::cross_file::scope;
use crate::state::WorldState;

/// Lightweight cooperative cancellation handle for diagnostic computation.
///
/// Wraps an optional `CancellationToken` so that diagnostic functions can
/// periodically check whether the computation should be aborted (e.g., because
/// a newer edit arrived). `DiagCancelToken::never()` returns a no-op token
/// that is always uncancelled — used by tests and non-debounced call sites.
#[derive(Clone, Default)]
pub struct DiagCancelToken(Option<tokio_util::sync::CancellationToken>);

impl DiagCancelToken {
    /// A token that is never cancelled. Use for tests and non-debounced paths.
    pub fn never() -> Self {
        Self(None)
    }

    /// Wrap a live cancellation token.
    pub fn from_token(token: tokio_util::sync::CancellationToken) -> Self {
        Self(Some(token))
    }

    /// Returns `true` if the computation should stop.
    #[inline]
    pub fn is_cancelled(&self) -> bool {
        self.0.as_ref().is_some_and(|t| t.is_cancelled())
    }

    /// Returns `true` for the no-op token created by [`DiagCancelToken::never`].
    #[inline]
    pub(crate) fn is_never(&self) -> bool {
        self.0.is_none()
    }

    /// Resolves when the computation should stop.
    pub async fn cancelled(&self) {
        match &self.0 {
            Some(token) => token.cancelled().await,
            None => std::future::pending::<()>().await,
        }
    }
}

/// Process-wide cached empty `Arc<HashSet<String>>`. Reused whenever a
/// snapshot or fallback path needs an "empty base_exports" stand-in so we
/// don't allocate a fresh Arc per snapshot when the package library isn't
/// ready (e.g. cold start or `WorldState::new` without an R subprocess).
pub(crate) fn empty_base_exports() -> &'static Arc<HashSet<String>> {
    static EMPTY: OnceLock<Arc<HashSet<String>>> = OnceLock::new();
    EMPTY.get_or_init(|| Arc::new(HashSet::new()))
}

/// Pick the right `base_exports` for cross-file scope resolution. Returns the
/// cached empty set during cold start so we don't allocate a fresh Arc per call
/// when the package library hasn't reported library paths yet.
pub(crate) fn cross_file_base_exports(state: &WorldState) -> Arc<HashSet<String>> {
    if state.package_library_ready {
        state.package_library.base_exports().clone()
    } else {
        empty_base_exports().clone()
    }
}

pub(crate) fn precollect_scope_snapshot_uri(
    content_provider: &impl ContentProvider,
    uri: &Url,
    artifacts_map: &mut HashMap<Url, Arc<scope::ScopeArtifacts>>,
    metadata_map: &mut HashMap<Url, Arc<crate::cross_file::CrossFileMetadata>>,
) -> Option<Arc<crate::cross_file::CrossFileMetadata>> {
    if let Some(artifacts) = content_provider.get_cached_artifacts(uri) {
        artifacts_map.insert(uri.clone(), artifacts);
    }
    let metadata = content_provider.get_metadata(uri);
    if let Some(metadata) = metadata.as_ref() {
        metadata_map.insert(uri.clone(), metadata.clone());
    }
    metadata
}

#[derive(Clone)]
enum SnapshotText {
    Rope {
        raw: Rope,
        chunk_kind: crate::chunks::ChunkKind,
        tree: Option<tree_sitter::Tree>,
    },
}

impl SnapshotText {
    fn raw_string(&self) -> String {
        match self {
            Self::Rope { raw, .. } => raw.to_string(),
        }
    }

    fn analysis_string(&self) -> String {
        let raw = self.raw_string();
        crate::cross_file::analysis_text_for_kind(self.chunk_kind(), &raw).into_owned()
    }

    fn chunk_kind(&self) -> crate::chunks::ChunkKind {
        match self {
            Self::Rope { chunk_kind, .. } => *chunk_kind,
        }
    }

    fn tree(&self) -> Option<tree_sitter::Tree> {
        match self {
            Self::Rope { tree, .. } => tree.clone(),
        }
    }
}

fn precollect_text_for_scope_snapshot(
    state: &WorldState,
    uri: &Url,
    raw_text_map: &mut HashMap<Url, SnapshotText>,
) {
    if let Some(doc) = state.document_store.get_without_touch(uri) {
        raw_text_map.insert(
            uri.clone(),
            SnapshotText::Rope {
                raw: doc.contents.clone(),
                chunk_kind: doc.chunk_kind,
                tree: doc.tree.clone(),
            },
        );
    } else if let Some(doc) = state.documents.get(uri) {
        raw_text_map.insert(
            uri.clone(),
            SnapshotText::Rope {
                raw: doc.contents.clone(),
                chunk_kind: doc.chunk_kind,
                tree: doc.tree.clone(),
            },
        );
    } else if let Some((contents, tree)) = state.workspace_index_new.get_contents_and_tree(uri) {
        raw_text_map.insert(
            uri.clone(),
            SnapshotText::Rope {
                raw: contents,
                chunk_kind: crate::chunks::classify_chunk_document(uri.path()),
                tree,
            },
        );
    } else if let Some(doc) = state.workspace_index.get(uri) {
        raw_text_map.insert(
            uri.clone(),
            SnapshotText::Rope {
                raw: doc.contents.clone(),
                chunk_kind: doc.chunk_kind,
                tree: doc.tree.clone(),
            },
        );
    }
}

#[derive(Default)]
struct SnapshotCorpus {
    artifacts_map: HashMap<Url, Arc<scope::ScopeArtifacts>>,
    metadata_map: HashMap<Url, Arc<crate::cross_file::CrossFileMetadata>>,
    raw_text_map: HashMap<Url, SnapshotText>,
    disk_attempted: HashSet<Url>,
    dynamic_disk_materialized: bool,
}

impl SnapshotCorpus {
    fn from_snapshot_maps(
        artifacts_map: &HashMap<Url, Arc<scope::ScopeArtifacts>>,
        metadata_map: &HashMap<Url, Arc<crate::cross_file::CrossFileMetadata>>,
        raw_text_map: &HashMap<Url, SnapshotText>,
    ) -> Self {
        Self {
            artifacts_map: artifacts_map.clone(),
            metadata_map: metadata_map.clone(),
            raw_text_map: raw_text_map.clone(),
            disk_attempted: HashSet::new(),
            dynamic_disk_materialized: false,
        }
    }

    fn get_artifacts(&self, uri: &Url) -> Option<Arc<scope::ScopeArtifacts>> {
        self.artifacts_map.get(uri).cloned()
    }

    fn get_metadata(&self, uri: &Url) -> Option<Arc<crate::cross_file::CrossFileMetadata>> {
        self.metadata_map.get(uri).cloned()
    }

    fn get_text(&self, uri: &Url) -> Option<SnapshotText> {
        self.raw_text_map.get(uri).cloned()
    }

    fn get_or_materialize_artifacts(&mut self, uri: &Url) -> Option<Arc<scope::ScopeArtifacts>> {
        if !self.artifacts_map.contains_key(uri) {
            let _ = self.compute_artifacts_from_snapshot_text(uri);
        }
        if !self.artifacts_map.contains_key(uri) {
            self.materialize_disk_uri(uri);
        }
        self.get_artifacts(uri)
    }

    fn get_or_materialize_metadata(
        &mut self,
        uri: &Url,
    ) -> Option<Arc<crate::cross_file::CrossFileMetadata>> {
        if !self.metadata_map.contains_key(uri) {
            self.compute_metadata_from_snapshot_text(uri);
        }
        if !self.metadata_map.contains_key(uri) {
            self.materialize_disk_uri(uri);
        }
        self.get_metadata(uri)
    }

    fn compute_metadata_from_snapshot_text(
        &mut self,
        uri: &Url,
    ) -> Option<Arc<crate::cross_file::CrossFileMetadata>> {
        if let Some(metadata) = self.get_metadata(uri) {
            return Some(metadata);
        }
        let text = self.get_text(uri)?;
        let analysis = text.analysis_string();
        let tree = text
            .tree()
            .or_else(|| crate::parser_pool::with_parser(|parser| parser.parse(&analysis, None)))?;
        let metadata = Arc::new(crate::cross_file::extract_metadata_with_tree(
            &analysis,
            Some(&tree),
        ));
        self.metadata_map.insert(uri.clone(), metadata.clone());
        Some(metadata)
    }

    fn compute_artifacts_from_snapshot_text(
        &mut self,
        uri: &Url,
    ) -> Option<Arc<scope::ScopeArtifacts>> {
        if let Some(artifacts) = self.get_artifacts(uri) {
            return Some(artifacts);
        }
        let text = self.get_text(uri)?;
        let analysis = text.analysis_string();
        let tree = text
            .tree()
            .or_else(|| crate::parser_pool::with_parser(|parser| parser.parse(&analysis, None)))?;
        let metadata = self.compute_metadata_from_snapshot_text(uri)?;
        let artifacts = Arc::new(scope::compute_artifacts_with_metadata(
            uri,
            &tree,
            &analysis,
            Some(&metadata),
        ));
        self.artifacts_map
            .entry(uri.clone())
            .or_insert_with(|| artifacts.clone());
        Some(artifacts)
    }

    fn materialize_disk_uri(&mut self, uri: &Url) {
        if !self.disk_attempted.insert(uri.clone()) {
            return;
        }
        let Ok(path) = uri.to_file_path() else {
            return;
        };
        let Ok(raw) = crate::state::read_source(&path) else {
            return;
        };
        let chunk_kind = crate::chunks::classify_chunk_document(uri.path());
        let analysis = crate::cross_file::analysis_text_for_kind(chunk_kind, &raw);
        let Some(tree) =
            crate::parser_pool::with_parser(|parser| parser.parse(analysis.as_ref(), None))
        else {
            return;
        };
        let metadata = Arc::new(crate::cross_file::extract_metadata_with_tree(
            analysis.as_ref(),
            Some(&tree),
        ));
        let artifacts = Arc::new(scope::compute_artifacts_with_metadata(
            uri,
            &tree,
            analysis.as_ref(),
            Some(&metadata),
        ));
        self.artifacts_map
            .entry(uri.clone())
            .or_insert_with(|| artifacts.clone());
        self.metadata_map
            .entry(uri.clone())
            .or_insert_with(|| metadata.clone());
        self.raw_text_map
            .entry(uri.clone())
            .or_insert(SnapshotText::Rope {
                raw: Rope::from_str(&raw),
                chunk_kind,
                tree: Some(tree),
            });
        self.dynamic_disk_materialized = true;
    }

    fn insert_open_doc(
        &mut self,
        uri: &Url,
        raw: Rope,
        chunk_kind: crate::chunks::ChunkKind,
        tree: Option<tree_sitter::Tree>,
        artifacts: Arc<scope::ScopeArtifacts>,
        metadata: Arc<crate::cross_file::CrossFileMetadata>,
    ) {
        self.artifacts_map.entry(uri.clone()).or_insert(artifacts);
        self.metadata_map.entry(uri.clone()).or_insert(metadata);
        self.raw_text_map
            .entry(uri.clone())
            .or_insert(SnapshotText::Rope {
                raw,
                chunk_kind,
                tree,
            });
    }

    fn insert_legacy_document(&mut self, uri: &Url, doc: &crate::state::Document) {
        if let Some(artifacts) = doc.cached_artifacts_for_uri(uri) {
            self.artifacts_map.entry(uri.clone()).or_insert(artifacts);
        }
        self.metadata_map
            .entry(uri.clone())
            .or_insert_with(|| doc.metadata_handle());
        self.raw_text_map
            .entry(uri.clone())
            .or_insert(SnapshotText::Rope {
                raw: doc.contents.clone(),
                chunk_kind: doc.chunk_kind,
                tree: doc.tree.clone(),
            });
    }

    fn insert_state_document_if_open(&mut self, state: &WorldState, uri: &Url) -> bool {
        if let Some(doc) = state.document_store.get_without_touch(uri) {
            self.insert_open_doc(
                uri,
                doc.contents.clone(),
                doc.chunk_kind,
                doc.tree.clone(),
                doc.artifacts.clone(),
                doc.metadata.clone(),
            );
            return true;
        }

        if let Some(doc) = state.documents.get(uri) {
            self.insert_legacy_document(uri, doc);
            return true;
        }

        false
    }

    fn has_deferred_artifacts(&self, uris: &[Url]) -> bool {
        uris.iter()
            .any(|uri| !self.artifacts_map.contains_key(uri) && self.raw_text_map.contains_key(uri))
    }

    fn precollect_uri(
        &self,
        uri: &Url,
        artifacts_map: &mut HashMap<Url, Arc<scope::ScopeArtifacts>>,
        metadata_map: &mut HashMap<Url, Arc<crate::cross_file::CrossFileMetadata>>,
        raw_text_map: &mut HashMap<Url, SnapshotText>,
    ) {
        if let Some(artifacts) = self.get_artifacts(uri) {
            artifacts_map.insert(uri.clone(), artifacts);
        }
        if let Some(metadata) = self.get_metadata(uri) {
            metadata_map.insert(uri.clone(), metadata);
        }
        if let Some(text) = self.get_text(uri) {
            raw_text_map.insert(uri.clone(), text);
        }
    }
}

fn capture_active_open_documents(state: &WorldState, corpus: &mut SnapshotCorpus) {
    for uri in state.document_store.uris() {
        if let Some(doc) = state.document_store.get_without_touch(&uri) {
            corpus.insert_open_doc(
                &uri,
                doc.contents.clone(),
                doc.chunk_kind,
                doc.tree.clone(),
                doc.artifacts.clone(),
                doc.metadata.clone(),
            );
        }
    }
    for (uri, doc) in &state.documents {
        corpus.insert_legacy_document(uri, doc);
    }
}

pub(crate) struct CrossFileScopeSnapshotCapture {
    subgraph: Arc<crate::cross_file::dependency::DependencyGraph>,
    cross_file_edge_revision: u64,
    standalone_scope_invalidation_generation: u64,
    standalone_scope_cache: Arc<scope::StandaloneScopeCache>,
    workspace_folders: Vec<Url>,
    cross_file_config: crate::cross_file::config::CrossFileConfig,
    base_exports: Arc<HashSet<String>>,
    package_library: Arc<crate::package_library::PackageLibrary>,
    package_library_ready: bool,
    package_facts: Option<crate::package_library::PackageFactSnapshot>,
    help_cache: crate::help::HelpCache,
    signature_cache: Arc<crate::parameter_resolver::SignatureCache>,
    scope_contribution: crate::package_state::PackageScopeContribution,
    seed_uris: Vec<Url>,
    snapshot_uris: HashSet<Url>,
    artifacts_map: HashMap<Url, Arc<scope::ScopeArtifacts>>,
    metadata_map: HashMap<Url, Arc<crate::cross_file::CrossFileMetadata>>,
    raw_text_map: HashMap<Url, SnapshotText>,
    active_corpus: Option<SnapshotCorpus>,
    expand_active_standalone_members: bool,
    persistent_cache_enabled: bool,
    max_depth: usize,
    max_visited: usize,
}

impl CrossFileScopeSnapshotCapture {
    pub(crate) fn finish(mut self, is_cancelled: &impl Fn() -> bool) -> CrossFileScopeSnapshot {
        if let Some(mut corpus) = self.active_corpus.take() {
            for seed_uri in &self.seed_uris {
                corpus.compute_metadata_from_snapshot_text(seed_uri);
                let _ = corpus.compute_artifacts_from_snapshot_text(seed_uri);
                corpus.precollect_uri(
                    seed_uri,
                    &mut self.artifacts_map,
                    &mut self.metadata_map,
                    &mut self.raw_text_map,
                );
            }

            if self.expand_active_standalone_members {
                let corpus = RefCell::new(corpus);
                let active_extra_uris = {
                    let get_active_artifacts = |target_uri: &Url| {
                        corpus.borrow_mut().get_or_materialize_artifacts(target_uri)
                    };
                    let get_active_metadata = |target_uri: &Url| {
                        corpus.borrow_mut().get_or_materialize_metadata(target_uri)
                    };
                    scope::standalone_active_snapshot_members(
                        scope::StandaloneActiveSnapshotMembersInputs {
                            graph: self.subgraph.as_ref(),
                            max_depth: self.max_depth,
                            max_visited: self.max_visited,
                            workspace_root: self.workspace_folders.first(),
                            seed_uris: &self.seed_uris,
                            is_cancelled,
                        },
                        &mut self.snapshot_uris,
                        &get_active_artifacts,
                        &get_active_metadata,
                    )
                };
                let corpus = corpus.into_inner();
                for extra_uri in &active_extra_uris {
                    corpus.precollect_uri(
                        extra_uri,
                        &mut self.artifacts_map,
                        &mut self.metadata_map,
                        &mut self.raw_text_map,
                    );
                }
                if corpus.dynamic_disk_materialized {
                    self.persistent_cache_enabled = false;
                }
            } else if corpus.dynamic_disk_materialized {
                self.persistent_cache_enabled = false;
            }
        }

        CrossFileScopeSnapshot {
            cross_file_graph: self.subgraph,
            cross_file_edge_revision: self.cross_file_edge_revision,
            standalone_scope_invalidation_generation: self.standalone_scope_invalidation_generation,
            standalone_scope_cache: self.standalone_scope_cache,
            workspace_folders: self.workspace_folders,
            cross_file_config: self.cross_file_config,
            base_exports: self.base_exports,
            package_library: self.package_library,
            package_library_ready: self.package_library_ready,
            package_facts: self.package_facts,
            help_cache: self.help_cache,
            signature_cache: self.signature_cache,
            artifacts_map: self.artifacts_map,
            metadata_map: self.metadata_map,
            raw_text_map: self.raw_text_map,
            scope_contribution: self.scope_contribution,
            persistent_cache_enabled: self.persistent_cache_enabled,
        }
    }
}

#[derive(Clone)]
pub(crate) struct CrossFileScopeSnapshot {
    pub(crate) cross_file_graph: Arc<crate::cross_file::dependency::DependencyGraph>,
    pub(crate) cross_file_edge_revision: u64,
    pub(crate) standalone_scope_invalidation_generation: u64,
    pub(crate) standalone_scope_cache: Arc<scope::StandaloneScopeCache>,
    pub(crate) workspace_folders: Vec<Url>,
    pub(crate) cross_file_config: crate::cross_file::config::CrossFileConfig,
    pub(crate) base_exports: Arc<HashSet<String>>,
    pub(crate) package_library: Arc<crate::package_library::PackageLibrary>,
    pub(crate) package_library_ready: bool,
    pub(crate) package_facts: Option<crate::package_library::PackageFactSnapshot>,
    pub(crate) help_cache: crate::help::HelpCache,
    pub(crate) signature_cache: Arc<crate::parameter_resolver::SignatureCache>,
    pub(crate) artifacts_map: HashMap<Url, Arc<scope::ScopeArtifacts>>,
    pub(crate) metadata_map: HashMap<Url, Arc<crate::cross_file::CrossFileMetadata>>,
    raw_text_map: HashMap<Url, SnapshotText>,
    pub(crate) scope_contribution: crate::package_state::PackageScopeContribution,
    persistent_cache_enabled: bool,
}

impl CrossFileScopeSnapshot {
    /// Convenience wrapper that captures and immediately finalizes a bounded
    /// cross-file snapshot for one scope-bearing request.
    ///
    /// Production LSP paths should prefer [`Self::capture`], drop the
    /// `WorldState` read guard, and then call
    /// [`CrossFileScopeSnapshotCapture::finish`] before invoking
    /// [`Self::scope_at`] or snapshot-backed parameter/signature resolution.
    /// Finalization can materialize active standalone closure members, and
    /// persistent standalone-scope cache misses can recursively resolve a callee
    /// closure; neither belongs under the read lock while `did_change` writers
    /// are waiting.
    pub(crate) fn build(state: &WorldState, uri: &Url) -> Self {
        Self::capture(state, uri).finish(&|| false)
    }

    #[cfg(test)]
    pub(crate) fn build_with_cancel(
        state: &WorldState,
        uri: &Url,
        is_cancelled: &impl Fn() -> bool,
    ) -> Self {
        Self::capture(state, uri).finish(is_cancelled)
    }

    pub(crate) fn capture(state: &WorldState, uri: &Url) -> CrossFileScopeSnapshotCapture {
        let max_depth = state.cross_file_config.max_chain_depth;
        let max_visited = state.cross_file_config.max_transitive_dependents_visited;
        let payload =
            state
                .cross_file_graph
                .cached_neighborhood_subgraph(uri, max_depth, max_visited);
        let content_provider = state.content_provider();
        let mut corpus = SnapshotCorpus::default();

        let mut seed_uris: Vec<Url> = payload.neighborhood.iter().cloned().collect();
        seed_uris.sort_unstable_by(|a, b| a.as_str().cmp(b.as_str()));
        let snapshot_uris: HashSet<Url> = seed_uris.iter().cloned().collect();
        for neighbor_uri in &seed_uris {
            if !corpus.insert_state_document_if_open(state, neighbor_uri) {
                precollect_scope_snapshot_uri(
                    &content_provider,
                    neighbor_uri,
                    &mut corpus.artifacts_map,
                    &mut corpus.metadata_map,
                );
                precollect_text_for_scope_snapshot(state, neighbor_uri, &mut corpus.raw_text_map);
            }
        }
        let has_standalone_seed = seed_uris.iter().any(|seed| {
            corpus
                .metadata_map
                .get(seed)
                .is_some_and(|metadata| metadata.standalone)
        });
        let has_deferred_seed_artifacts = corpus.has_deferred_artifacts(&seed_uris);

        let active_corpus = if has_standalone_seed || has_deferred_seed_artifacts {
            capture_active_open_documents(state, &mut corpus);
            Some(SnapshotCorpus::from_snapshot_maps(
                &corpus.artifacts_map,
                &corpus.metadata_map,
                &corpus.raw_text_map,
            ))
        } else {
            None
        };

        CrossFileScopeSnapshotCapture {
            subgraph: payload.subgraph.clone(),
            cross_file_edge_revision: state.cross_file_graph.edge_revision(),
            standalone_scope_invalidation_generation: state
                .standalone_scope_invalidation_generation(),
            standalone_scope_cache: state.standalone_scope_cache.clone(),
            workspace_folders: state.workspace_folders.clone(),
            cross_file_config: state.cross_file_config.clone(),
            base_exports: cross_file_base_exports(state),
            package_library: state.package_library.clone(),
            package_library_ready: state.package_library_ready,
            package_facts: (state.cross_file_config.packages_enabled
                && state.package_library_ready)
                .then(|| state.package_library.package_fact_snapshot()),
            help_cache: state.help_cache.clone(),
            signature_cache: state.signature_cache.clone(),
            scope_contribution: state.package_state.scope_contribution().clone(),
            seed_uris,
            snapshot_uris,
            artifacts_map: corpus.artifacts_map,
            metadata_map: corpus.metadata_map,
            raw_text_map: corpus.raw_text_map,
            active_corpus,
            expand_active_standalone_members: has_standalone_seed,
            persistent_cache_enabled: true,
            max_depth,
            max_visited,
        }
    }

    pub(crate) fn get_artifacts(&self, uri: &Url) -> Option<Arc<scope::ScopeArtifacts>> {
        self.artifacts_map.get(uri).cloned()
    }

    pub(crate) fn get_metadata(
        &self,
        uri: &Url,
    ) -> Option<Arc<crate::cross_file::CrossFileMetadata>> {
        self.metadata_map.get(uri).cloned()
    }

    pub(crate) fn get_text_and_tree(&self, uri: &Url) -> Option<(String, tree_sitter::Tree)> {
        let text = self.raw_text_map.get(uri)?;
        let analysis_text = text.analysis_string();
        let tree = match text.tree() {
            Some(tree) => tree,
            None => crate::parser_pool::with_parser(|parser| parser.parse(&analysis_text, None))?,
        };
        Some((analysis_text, tree))
    }

    pub(crate) fn get_raw_text(&self, uri: &Url) -> Option<String> {
        self.raw_text_map.get(uri).map(SnapshotText::raw_string)
    }

    pub(crate) fn scope_at(
        &self,
        uri: &Url,
        line: u32,
        column: u32,
        cancel: &DiagCancelToken,
        prefix_cache: &mut scope::ParentPrefixCache,
    ) -> scope::ScopeAtPosition {
        let get_artifacts = |target_uri: &Url| -> Option<Arc<scope::ScopeArtifacts>> {
            self.get_artifacts(target_uri)
        };
        let get_metadata = |target_uri: &Url| -> Option<Arc<crate::cross_file::CrossFileMetadata>> {
            self.get_metadata(target_uri)
        };
        let is_cancelled = || cancel.is_cancelled();

        let data_lookup = |pkg: &str, stem: &str| -> Vec<String> {
            self.package_facts
                .as_ref()
                .map_or_else(Vec::new, |facts| facts.data_objects_for_stem(pkg, stem))
        };
        let data_provider = self.package_facts.as_ref().map(|facts| {
            scope::DataAliasProvider::with_cache_epoch(
                &data_lookup,
                self.package_library.base_packages(),
                facts.cache_epoch(),
            )
        });

        let standalone_cache_context = self.persistent_cache_enabled.then(|| {
            scope::StandaloneScopeCacheContext::new(
                &self.standalone_scope_cache,
                self.cross_file_edge_revision,
                self.standalone_scope_invalidation_generation,
            )
        });

        scope::scope_at_position_with_graph_cached_with_standalone_cache(
            uri,
            line,
            column,
            &get_artifacts,
            &get_metadata,
            &self.cross_file_graph,
            self.workspace_folders.first(),
            self.cross_file_config.max_chain_depth,
            &self.base_exports,
            self.cross_file_config.hoist_globals_in_functions,
            self.cross_file_config.backward_dependencies,
            &is_cancelled,
            prefix_cache,
            Some(&self.scope_contribution),
            data_provider.as_ref(),
            standalone_cache_context,
        )
    }
}
