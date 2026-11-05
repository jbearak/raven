//! Joining a traced graph's stored edges to the plans that produced them, for
//! `raven graph`.
//!
//! The rows are the graph's edges, not the plans: each stored edge is joined to
//! the plan of the file that owns it (the caller for forward edges, the child
//! for backward directives) by [`GraphEdgeDedupKey`], indexing only each
//! plan's surviving candidate per key. An edge another operation removed later
//! (the `system.file()` pass dropping an orphaned external file) is simply not
//! a row, and its plan record is counted as missing from the graph. An edge
//! with no plan record would be a bug; it is still a row, with no annotations.

use std::collections::{HashMap, HashSet};

use tower_lsp::lsp_types::Url;

use super::plan::{PlannedEdge, StoredFilePlan};
use super::{DependencyEdge, DependencyGraph, GraphEdgeDedupKey};

/// One stored edge and its plan record.
pub(crate) struct JoinedEdge<'g> {
    pub(crate) edge: &'g DependencyEdge,
    /// The owner's stored plan and the surviving candidate for this edge, or
    /// `None` when no plan record matches.
    pub(crate) planned: Option<(&'g StoredFilePlan, &'g PlannedEdge)>,
}

/// A candidate apply skipped because an earlier one had the same key.
pub(crate) struct DuplicateCandidate<'g> {
    /// The file whose plan holds it.
    pub(crate) owner: &'g Url,
    pub(crate) stored: &'g StoredFilePlan,
    pub(crate) candidate: &'g PlannedEdge,
}

/// A traced graph's edges joined to its plans.
pub(crate) struct TracedGraph<'g> {
    pub(crate) edges: Vec<JoinedEdge<'g>>,
    pub(crate) duplicates: Vec<DuplicateCandidate<'g>>,
    /// Every stored plan, by owning file.
    pub(crate) plans: &'g HashMap<Url, StoredFilePlan>,
    /// Files whose last update found no path context.
    pub(crate) no_path_context: Vec<&'g Url>,
    /// Graph edges with no plan record.
    pub(crate) unplanned_edges: usize,
    /// Surviving planned candidates whose edge is no longer in the graph.
    pub(crate) planned_edges_missing: usize,
}

impl DependencyGraph {
    /// Join every stored edge to its owner's plan, or `None` when tracing is
    /// off. Walks `forward` only: each edge is stored in both indexes.
    pub(crate) fn traced(&self) -> Option<TracedGraph<'_>> {
        let trace = self.trace.as_ref()?;

        // Each plan's surviving candidates by key; later candidates with the
        // same key are duplicates.
        let mut survivors: HashMap<&Url, HashMap<GraphEdgeDedupKey, &PlannedEdge>> = HashMap::new();
        let mut duplicates = Vec::new();
        for (owner, stored) in &trace.plans {
            let by_key = survivors.entry(owner).or_default();
            for (candidate, keep) in stored
                .plan
                .candidates
                .iter()
                .zip(stored.plan.survivor_mask())
            {
                if keep {
                    by_key.insert(candidate.edge.graph_dedup_key(), candidate);
                } else {
                    duplicates.push(DuplicateCandidate {
                        owner,
                        stored,
                        candidate,
                    });
                }
            }
        }

        let mut edges = Vec::new();
        let mut matched: HashSet<(&Url, GraphEdgeDedupKey)> = HashSet::new();
        let mut unplanned_edges = 0;
        for edge in self.forward.values().flatten() {
            let owner = if edge.is_backward_directive {
                &edge.to
            } else {
                &edge.from
            };
            let key = edge.graph_dedup_key();
            let planned = trace.plans.get(owner).and_then(|stored| {
                survivors
                    .get(owner)
                    .and_then(|by_key| by_key.get(&key))
                    .map(|candidate| (stored, *candidate))
            });
            if planned.is_some() {
                matched.insert((owner, key));
            } else {
                unplanned_edges += 1;
            }
            edges.push(JoinedEdge { edge, planned });
        }

        let planned_edges_missing = survivors
            .iter()
            .flat_map(|(owner, by_key)| by_key.keys().map(move |key| (*owner, key)))
            .filter(|(owner, key)| !matched.contains(&(*owner, (*key).clone())))
            .count();

        Some(TracedGraph {
            edges,
            duplicates,
            plans: &trace.plans,
            no_path_context: trace.no_path_context.iter().collect(),
            unplanned_edges,
            planned_edges_missing,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::plan::{ExcludedGraphEntries, PlanEntry};
    use super::*;
    use crate::cross_file::types::{CrossFileMetadata, ForwardSource};
    use tempfile::TempDir;

    fn workspace(files: &[&str]) -> (TempDir, Url) {
        let dir = TempDir::new().unwrap();
        for file in files {
            let path = dir.path().join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "x <- 1\n").unwrap();
        }
        let root = Url::from_file_path(dir.path()).unwrap();
        (dir, root)
    }

    fn file_url(dir: &TempDir, file: &str) -> Url {
        Url::from_file_path(dir.path().join(file)).unwrap()
    }

    fn call(path: &str, line: u32) -> ForwardSource {
        ForwardSource {
            path: path.to_string(),
            line,
            ..Default::default()
        }
    }

    fn meta(sources: Vec<ForwardSource>) -> CrossFileMetadata {
        CrossFileMetadata {
            sources,
            ..Default::default()
        }
    }

    fn traced_graph() -> DependencyGraph {
        let mut graph = DependencyGraph::new();
        graph.set_tracing(true);
        graph
    }

    fn update(graph: &mut DependencyGraph, uri: &Url, meta: &CrossFileMetadata, root: &Url) {
        graph.update_file_traced(
            uri,
            meta,
            &ExcludedGraphEntries::default(),
            Some(root),
            |_| None,
        );
    }

    /// An edge another operation removed after apply (the `system.file()`
    /// pass dropping an orphaned external file) is not a row; its stale plan
    /// record is counted as missing from the graph, not resurrected.
    #[test]
    fn edge_removed_after_apply_is_not_a_row() {
        let parent = TempDir::new().unwrap();
        let ws = parent.path().join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(parent.path().join("ext")).unwrap();
        for file in ["ws/main.R", "ws/a.R", "ext/lib.R"] {
            std::fs::write(parent.path().join(file), "x <- 1\n").unwrap();
        }
        let root = Url::from_file_path(&ws).unwrap();
        let main = Url::from_file_path(ws.join("main.R")).unwrap();
        let a = Url::from_file_path(ws.join("a.R")).unwrap();
        let external_uri = Url::from_file_path(parent.path().join("ext/lib.R")).unwrap();

        let mut graph = traced_graph();
        let main_meta = meta(vec![call("a.R", 0), call("../ext/lib.R", 1)]);
        update(&mut graph, &main, &main_meta, &root);
        assert_eq!(graph.traced().unwrap().edges.len(), 2);

        graph.remove_file(&external_uri);
        let traced = graph.traced().unwrap();
        let targets: Vec<&Url> = traced.edges.iter().map(|joined| &joined.edge.to).collect();
        assert_eq!(targets, vec![&a]);
        assert!(traced.edges[0].planned.is_some());
        assert_eq!(traced.planned_edges_missing, 1);
        assert_eq!(traced.unplanned_edges, 0);
    }

    /// Two candidates with one deduplication key but different provenance:
    /// the row carries the first (the one apply inserted) and the later one is
    /// a duplicate, never the other way round.
    #[test]
    fn duplicate_candidates_keep_the_first_record() {
        let (dir, root) = workspace(&["main.R", "R/x.R"]);
        let main = file_url(&dir, "main.R");
        let mut guarded = call("./R/x.R", 3);
        guarded.guarded_by_file_exists = true;
        let main_meta = meta(vec![call("R/x.R", 3), guarded]);

        let mut graph = traced_graph();
        update(&mut graph, &main, &main_meta, &root);
        let traced = graph.traced().unwrap();
        assert_eq!(traced.edges.len(), 1);
        let (_, survivor) = traced.edges[0].planned.expect("joined");
        assert_eq!(survivor.entry, PlanEntry::Source(0));
        assert_eq!(traced.duplicates.len(), 1);
        assert_eq!(traced.duplicates[0].candidate.entry, PlanEntry::Source(1));
        assert_eq!(traced.duplicates[0].owner, &main);
    }

    /// No path context on an empty graph: nothing is planned or applied, and
    /// the failure is recorded for `dropped`.
    #[test]
    fn no_path_context_on_empty_graph_records_the_failure() {
        let (_dir, root) = workspace(&["a.R"]);
        let untitled = Url::parse("untitled:Untitled-1").unwrap();
        let mut graph = traced_graph();
        let result = graph.update_file_traced(
            &untitled,
            &meta(vec![call("a.R", 0)]),
            &ExcludedGraphEntries::default(),
            Some(&root),
            |_| None,
        );
        assert!(!result.edges_changed && result.diagnostics.is_empty());
        let traced = graph.traced().unwrap();
        assert!(traced.edges.is_empty());
        assert!(traced.plans.is_empty());
        assert_eq!(traced.no_path_context, vec![&untitled]);
    }

    /// No path context on a populated graph leaves every edge and stored plan
    /// as it was.
    #[test]
    fn no_path_context_on_populated_graph_changes_nothing() {
        let (dir, root) = workspace(&["main.R", "a.R"]);
        let main = file_url(&dir, "main.R");
        let mut graph = traced_graph();
        update(&mut graph, &main, &meta(vec![call("a.R", 0)]), &root);
        let before_edges = graph.edge_identity_snapshot();
        let before_plans = graph.traced().unwrap().plans.clone();

        let untitled = Url::parse("untitled:Untitled-1").unwrap();
        update(&mut graph, &untitled, &meta(vec![call("a.R", 0)]), &root);

        assert_eq!(graph.edge_identity_snapshot(), before_edges);
        let traced = graph.traced().unwrap();
        assert_eq!(traced.plans.len(), before_plans.len());
        assert_eq!(
            traced.plans[&main].plan.candidates.len(),
            before_plans[&main].plan.candidates.len()
        );
        assert_eq!(traced.no_path_context, vec![&untitled]);
    }

    /// Plans are only kept when tracing is on, and tracing doesn't change the
    /// graph apply builds.
    #[test]
    fn tracing_on_and_off_build_the_same_graph() {
        let (dir, root) = workspace(&["main.R", "a.R", "b.R"]);
        let main = file_url(&dir, "main.R");
        let main_meta = meta(vec![call("a.R", 0), call("b.R", 1), call("a.R", 2)]);
        let mut traced = traced_graph();
        let mut untraced = DependencyGraph::new();
        untraced.set_tracing(false);
        update(&mut traced, &main, &main_meta, &root);
        update(&mut untraced, &main, &main_meta, &root);
        assert_eq!(
            traced.edge_identity_snapshot(),
            untraced.edge_identity_snapshot()
        );
        assert!(untraced.traced().is_none());
    }
}
