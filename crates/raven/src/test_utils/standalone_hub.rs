//! Shared synthetic hub-workspace builder for the WI2b standalone-scope cache
//! benchmarks and the directive performance gate (issue #483).
//!
//! Builds a worldwide-shaped hub: a `hub.R` that `source()`s a wide + deep
//! forward closure (`width` children, each starting a `source()` chain of
//! `depth` leaves), plus `callers` files that each `source("hub.R")`. The hub's
//! `# raven: standalone` header is toggleable so callers can compare directive
//! vs no-directive resolution cost.
//!
//! The cache hook fires only when the standalone hub is resolved as a *forward
//! child* (depth >= 1) — i.e. when resolving a **caller**, not the hub itself
//! (resolving `hub.R` directly is the depth-0 own-root path the cache
//! deliberately excludes). Benches/tests therefore resolve `caller_uris`.
//!
//! Shared (rather than bench-local) because the criterion bench
//! (`crates/raven/benches/cross_file.rs`) and the in-crate gate test
//! (`cross_file/standalone_cache.rs`) both need it, and a bench's local helpers
//! are not reachable from a crate test. See
//! `specs/issue-483-wi2b-benchmarks-design.md`.

use std::collections::HashMap;
use std::sync::Arc;

use tempfile::TempDir;
use url::Url;

use crate::cross_file::types::CrossFileMetadata;
use crate::cross_file::{DependencyGraph, ScopeArtifacts, compute_artifacts, extract_metadata};

/// A built hub workspace plus the precomputed inputs the resolver needs.
pub struct HubCorpus {
    /// Kept alive so the temp directory is not deleted while in use.
    pub _dir: TempDir,
    /// `hub.R` — the (optionally standalone) hub.
    pub hub_uri: Url,
    /// The files that `source("hub.R")`; resolving these exercises the cache.
    pub caller_uris: Vec<Url>,
    pub artifacts: HashMap<Url, Arc<ScopeArtifacts>>,
    pub metadata: HashMap<Url, Arc<CrossFileMetadata>>,
    pub graph: DependencyGraph,
    /// Workspace-root URL, passed as `workspace_root` to the resolver.
    pub folder: Url,
}

/// Build a hub workspace.
///
/// * `standalone` — emit `# raven: standalone` in the hub header.
/// * `width` — number of children the hub `source()`s directly.
/// * `depth` — length of the `source()` chain hanging off each child.
/// * `callers` — number of files that `source("hub.R")`.
pub fn build_hub_corpus(standalone: bool, width: usize, depth: usize, callers: usize) -> HubCorpus {
    let dir = tempfile::tempdir().expect("create temp hub workspace");
    let root = dir.path();

    // Children + their source() chains. Each leaf loads a package and defines
    // top-level symbols so resolution does non-trivial work.
    for i in 0..width {
        let mut mid = String::new();
        if depth > 0 {
            mid.push_str(&format!("source(\"leaf_{i}_0.R\")\n"));
        }
        mid.push_str(&format!(
            "library(stats)\nmid_fn_{i} <- function(x = {i}) mean(c(x, {i}))\nmid_const_{i} <- {i}\n"
        ));
        std::fs::write(root.join(format!("mid_{i}.R")), mid).unwrap();

        for l in 0..depth {
            let mut leaf = String::new();
            if l + 1 < depth {
                leaf.push_str(&format!("source(\"leaf_{i}_{}.R\")\n", l + 1));
            }
            leaf.push_str(&format!(
                "library(utils)\nleaf_fn_{i}_{l} <- function() {l}\nleaf_const_{i}_{l} <- {l}\n"
            ));
            std::fs::write(root.join(format!("leaf_{i}_{l}.R")), leaf).unwrap();
        }
    }

    // The hub.
    let mut hub = String::new();
    if standalone {
        hub.push_str("# raven: standalone\n");
    }
    for i in 0..width {
        hub.push_str(&format!("source(\"mid_{i}.R\")\n"));
    }
    hub.push_str("hub_main <- function() {\n");
    for i in 0..width {
        hub.push_str(&format!("  v{i} <- mid_fn_{i}()\n"));
    }
    hub.push_str("  v0\n}\n");
    std::fs::write(root.join("hub.R"), hub).unwrap();

    // Callers.
    let w = width.max(1);
    let mut caller_uris = Vec::with_capacity(callers);
    for k in 0..callers {
        let content = format!(
            "source(\"hub.R\")\ncaller_{k} <- function() hub_main() + mid_fn_{}()\n",
            k % w
        );
        let path = root.join(format!("caller_{k}.R"));
        std::fs::write(&path, content).unwrap();
        caller_uris.push(Url::from_file_path(&path).unwrap());
    }

    // Precompute artifacts + metadata for every .R file (sorted for determinism).
    let mut artifacts = HashMap::new();
    let mut metadata = HashMap::new();
    let mut entries: Vec<_> = std::fs::read_dir(root)
        .expect("read hub workspace dir")
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "R").unwrap_or(false))
        .collect();
    entries.sort_by_key(|e| e.path());
    for e in &entries {
        let path = e.path();
        let content = std::fs::read_to_string(&path).unwrap();
        let uri = Url::from_file_path(&path).unwrap();
        let meta = extract_metadata(&content);
        if let Some(tree) = crate::parser_pool::with_parser(|p| p.parse(&content, None)) {
            artifacts.insert(
                uri.clone(),
                Arc::new(compute_artifacts(&uri, &tree, &content)),
            );
        }
        metadata.insert(uri, Arc::new(meta));
    }

    let folder = Url::from_file_path(root).unwrap();
    let mut graph = DependencyGraph::new();
    for (uri, meta) in &metadata {
        graph.update_file(uri, meta, Some(&folder), |_| None);
    }

    let hub_uri = Url::from_file_path(root.join("hub.R")).unwrap();
    HubCorpus {
        _dir: dir,
        hub_uri,
        caller_uris,
        artifacts,
        metadata,
        graph,
        folder,
    }
}
