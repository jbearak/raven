// cross_file.rs - Benchmarks for cross-file scope resolution and dependency graph traversal
//
// Run with: cargo bench --bench cross_file
// Compare baselines: cargo bench --bench cross_file -- --baseline before
//
// Allocation tracking: set RAVEN_BENCH_ALLOC=1 to report allocation counts.
//
// Requirements: 1.4, 1.3

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use std::collections::{HashMap, HashSet};
use url::Url;

use raven::test_utils::fixture_workspace::{create_fixture_workspace, FixtureConfig};
use raven::cross_file::{
    compute_artifacts, extract_metadata, DependencyGraph, ScopeArtifacts,
};
use raven::cross_file::types::CrossFileMetadata;


/// Pre-compute scope artifacts and metadata for all files in a workspace.
///
/// Returns maps keyed by URI for use with `scope_at_position_with_graph`.
fn precompute_artifacts(
    workspace_path: &std::path::Path,
) -> (
    HashMap<Url, ScopeArtifacts>,
    HashMap<Url, CrossFileMetadata>,
) {
    let mut artifacts_map = HashMap::new();
    let mut metadata_map = HashMap::new();

    let mut entries: Vec<_> = std::fs::read_dir(workspace_path)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| ext == "R")
                .unwrap_or(false)
        })
        .collect();
    entries.sort_by_key(|e| e.path());

    for entry in &entries {
        let path = entry.path();
        let content = std::fs::read_to_string(&path).unwrap();
        let uri = Url::from_file_path(&path).unwrap();

        let meta = extract_metadata(&content);
        let tree = raven::parser_pool::with_parser(|parser| parser.parse(&content, None));
        if let Some(tree) = tree {
            let arts = compute_artifacts(&uri, &tree, &content);
            artifacts_map.insert(uri.clone(), arts);
        }
        metadata_map.insert(uri, meta);
    }

    (artifacts_map, metadata_map)
}

/// Build a DependencyGraph from pre-computed metadata for all files.
fn build_dependency_graph(
    metadata_map: &HashMap<Url, CrossFileMetadata>,
    workspace_root: Option<&Url>,
) -> DependencyGraph {
    let mut graph = DependencyGraph::new();
    for (uri, meta) in metadata_map {
        graph.update_file(uri, meta, workspace_root, |_| None);
    }
    graph
}

/// Return the URI of `file_0.R` in the given workspace path.
fn file_0_uri(workspace_path: &std::path::Path) -> Url {
    Url::from_file_path(workspace_path.join("file_0.R")).unwrap()
}

// ---------------------------------------------------------------------------
// Benchmark: Scope resolution with varying source chain depths
// Requirements: 1.4, 1.3
//
// Measures the cost of resolving the full cross-file scope at the end of
// file_0.R (the root of the source chain) for chain depths 1, 5, and 15.
// ---------------------------------------------------------------------------

fn bench_scope_resolution(c: &mut Criterion) {
    let mut group = c.benchmark_group("cross_file_scope_resolution");
    group.sample_size(20);

    let chain_depths: &[usize] = &[1, 5, 15];

    for &depth in chain_depths {
        // Create a workspace with the specified chain depth.
        // Use enough files to cover the chain, plus a few extra.
        let file_count = (depth + 5).max(10);
        let config = FixtureConfig {
            file_count,
            functions_per_file: 5,
            source_chain_depth: depth,
            library_calls_per_file: 1,
            extra_lines_per_file: 3,
        };

        let workspace = create_fixture_workspace(&config);
        let workspace_path = workspace.path();
        let folder_url = Url::from_file_path(workspace_path).unwrap();

        let (artifacts_map, metadata_map) = precompute_artifacts(workspace_path);
        let graph = build_dependency_graph(&metadata_map, Some(&folder_url));
        let uri = file_0_uri(workspace_path);
        let base_exports: HashSet<String> = HashSet::new();

        group.bench_with_input(
            BenchmarkId::new("depth", depth),
            &depth,
            |b, _| {
                b.iter(|| {
                    black_box(raven::cross_file::scope_at_position_with_graph(
                        black_box(&uri),
                        u32::MAX,
                        u32::MAX,
                        &|u| artifacts_map.get(u).cloned(),
                        &|u| metadata_map.get(u).cloned(),
                        &graph,
                        Some(&folder_url),
                        black_box(20),
                        &base_exports,
                    ))
                })
            },
        );
    }

    group.finish();
}

// ---------------------------------------------------------------------------
// Benchmark: Dependency graph traversal on small and medium workspaces
// Requirements: 1.4, 1.3
//
// Measures the cost of:
//   - Building the dependency graph from metadata
//   - Querying direct dependencies and dependents
//   - Querying transitive dependents
// ---------------------------------------------------------------------------

fn bench_dependency_graph(c: &mut Criterion) {
    let mut group = c.benchmark_group("cross_file_dependency_graph");
    group.sample_size(20);

    let configs: &[(&str, FixtureConfig)] = &[
        ("small_10", FixtureConfig::small()),
        ("medium_50", FixtureConfig::medium()),
    ];

    for (label, config) in configs {
        let workspace = create_fixture_workspace(config);
        let workspace_path = workspace.path();
        let folder_url = Url::from_file_path(workspace_path).unwrap();

        let (_artifacts_map, metadata_map) = precompute_artifacts(workspace_path);

        // Benchmark: building the dependency graph from scratch
        group.bench_with_input(
            BenchmarkId::new("build_graph", *label),
            &metadata_map,
            |b, meta_map| {
                b.iter(|| {
                    black_box(build_dependency_graph(
                        black_box(meta_map),
                        Some(&folder_url),
                    ))
                })
            },
        );

        // Pre-build graph for query benchmarks
        let graph = build_dependency_graph(&metadata_map, Some(&folder_url));
        let root_uri = file_0_uri(workspace_path);

        // Benchmark: querying direct dependencies of the root file
        group.bench_with_input(
            BenchmarkId::new("get_dependencies", *label),
            &(&graph, &root_uri),
            |b, &(graph, uri)| {
                b.iter(|| {
                    black_box(graph.get_dependencies(black_box(uri)))
                })
            },
        );

        // Benchmark: querying direct dependents of the last file in the chain
        // (the most-sourced file has the most dependents)
        let chain_end_idx = config.source_chain_depth.min(config.file_count - 1);
        let chain_end_uri = Url::from_file_path(
            workspace_path.join(format!("file_{}.R", chain_end_idx)),
        )
        .unwrap();

        group.bench_with_input(
            BenchmarkId::new("get_dependents", *label),
            &(&graph, &chain_end_uri),
            |b, &(graph, uri)| {
                b.iter(|| {
                    black_box(graph.get_dependents(black_box(uri)))
                })
            },
        );

        // Benchmark: querying transitive dependents from the chain end
        group.bench_with_input(
            BenchmarkId::new("get_transitive_dependents", *label),
            &(&graph, &chain_end_uri),
            |b, &(graph, uri)| {
                b.iter(|| {
                    black_box(graph.get_transitive_dependents(black_box(uri), 20))
                })
            },
        );
    }

    group.finish();
}

criterion_group!(
    benches,
    bench_scope_resolution,
    bench_dependency_graph,
);
criterion_main!(benches);
