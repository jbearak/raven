// cross_file.rs - Benchmarks for cross-file scope resolution and dependency graph traversal
//
// Run with: cargo bench --bench cross_file
// Compare baselines: cargo bench --bench cross_file -- --baseline before
//
// Allocation tracking: set RAVEN_BENCH_ALLOC=1 to report allocation counts.
//
// Requirements: 1.4, 1.3

use criterion::{BenchmarkId, Criterion, black_box, criterion_group, criterion_main};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use url::Url;

use raven::cross_file::types::CrossFileMetadata;
use raven::cross_file::{
    DependencyGraph, FunctionScopeTree, Position, ScopeArtifacts, compute_artifacts,
    extract_metadata, scope_at_position,
};
use raven::test_utils::fixture_workspace::{FixtureConfig, create_fixture_workspace};

/// Pre-compute scope artifacts and metadata for all files in a workspace.
///
/// Returns maps keyed by URI for use with `scope_at_position_with_graph`.
fn precompute_artifacts(
    workspace_path: &std::path::Path,
) -> (
    HashMap<Url, Arc<ScopeArtifacts>>,
    HashMap<Url, Arc<CrossFileMetadata>>,
) {
    let mut artifacts_map = HashMap::new();
    let mut metadata_map = HashMap::new();

    let mut entries: Vec<_> = std::fs::read_dir(workspace_path)
        .expect("failed to read workspace directory")
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|ext| ext == "R").unwrap_or(false))
        .collect();
    entries.sort_by_key(|e| e.path());

    for entry in &entries {
        let path = entry.path();
        let content = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
        let uri = Url::from_file_path(&path)
            .unwrap_or_else(|_| panic!("invalid file path: {}", path.display()));

        let meta = extract_metadata(&content);
        let tree = raven::parser_pool::with_parser(|parser| parser.parse(&content, None));
        if let Some(tree) = tree {
            let arts = Arc::new(compute_artifacts(&uri, &tree, &content));
            artifacts_map.insert(uri.clone(), arts);
        }
        metadata_map.insert(uri, Arc::new(meta));
    }

    (artifacts_map, metadata_map)
}

/// Build a DependencyGraph from pre-computed metadata for all files.
fn build_dependency_graph(
    metadata_map: &HashMap<Url, Arc<CrossFileMetadata>>,
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

fn build_nested_scope_artifacts(
    depth: usize,
    defs_per_scope: usize,
) -> (Url, Arc<ScopeArtifacts>, u32, u32) {
    let mut content = String::new();

    for my_depth in 0..depth {
        let indent = "    ".repeat(my_depth);
        content.push_str(&format!(
            "{indent}scope_{my_depth} <- function(arg_{my_depth}) {{\n"
        ));
        for my_def in 0..defs_per_scope {
            content.push_str(&format!(
                "{indent}    local_{my_depth}_{my_def} <- {my_def}\n"
            ));
        }
    }

    let query_indent = "    ".repeat(depth);
    content.push_str(&format!("{query_indent}hotspot_marker\n"));
    let query_line = content.lines().count() as u32 - 1;
    let query_column = query_indent.len() as u32;

    for my_depth in (0..depth).rev() {
        let indent = "    ".repeat(my_depth);
        content.push_str(&format!("{indent}}}\n"));
    }

    let uri = Url::parse("file:///nested_scope_bench.R").unwrap();
    let tree = raven::parser_pool::with_parser(|parser| parser.parse(&content, None))
        .expect("nested benchmark fixture should parse");
    let artifacts = Arc::new(compute_artifacts(&uri, &tree, &content));

    (uri, artifacts, query_line, query_column)
}

fn build_nested_interval_tree(depth: usize) -> FunctionScopeTree {
    let the_scopes: Vec<(u32, u32, u32, u32)> = (0..depth)
        .map(|my_depth| {
            let start_line = my_depth as u32;
            let end_line = (depth * 2 - my_depth) as u32;
            (start_line, 0, end_line, 0)
        })
        .collect();
    FunctionScopeTree::from_scopes(&the_scopes)
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

        group.bench_with_input(BenchmarkId::new("depth", depth), &depth, |b, _| {
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
                    true,
                    raven::cross_file::config::BackwardDependencyMode::Explicit,
                    &|| false,
                    None,
                ))
            })
        });
    }

    group.finish();
}

// ---------------------------------------------------------------------------
// Benchmark: Diagnostic-style sweep — streaming vs per-position resolution
//
// Quantifies *why* `ScopeStream` exists: the production out-of-scope
// diagnostic collector (handlers.rs) sweeps every identifier usage in a file
// in document order, doing an `advance_to` + `is_visible` per usage against a
// single streaming cursor. This group compares that streaming sweep against
// the two per-position alternatives it replaced:
//
//   1. streaming           — one ScopeStream advanced through K positions.
//   2. per-position cached  — K `scope_at_position_with_graph_cached` calls
//                             sharing ONE ParentPrefixCache (fresh per
//                             iteration, shared within the K calls).
//   3. per-position uncached — K `scope_at_position_with_graph` calls.
//
// Parameterized by source_chain_depth (1, 5, 15) like the scope-resolution
// group. K is fixed within a depth so the three arms are directly comparable.
//
// Expected: streaming << per-position cached << per-position uncached.
// ---------------------------------------------------------------------------

/// Number of document-order positions to sweep per arm. Fixed across depths so
/// the three arms are directly comparable. The bench fixture's `file_0.R` has
/// fewer lines than K, so `sweep_positions` wraps and repeats; that is fine —
/// it exercises `advance_to` no-op/re-query paths consistently across all three
/// arms. The result is sorted back into document order (the ScopeStream cursor
/// requires monotonic advancement).
const SWEEP_POSITIONS: usize = 100;

/// Build `SWEEP_POSITIONS` document-order (line, column) positions that wrap
/// and repeat once `i` exceeds `line_count * columns.len()`. Repeated positions
/// exercise `advance_to` no-op/re-query paths without skewing comparisons.
/// Positions are sorted ascending so the streaming cursor advances monotonically.
fn sweep_positions(content: &str) -> Vec<(u32, u32)> {
    let line_count = content.lines().count().max(1) as u32;
    let columns: &[u32] = &[0, 4, 8];
    let mut positions = Vec::with_capacity(SWEEP_POSITIONS);
    for i in 0..SWEEP_POSITIONS {
        let line = (i as u32) % line_count;
        let column = columns[i % columns.len()];
        positions.push((line, column));
    }
    positions.sort_unstable();
    positions
}

fn bench_diagnostic_sweep(c: &mut Criterion) {
    let mut group = c.benchmark_group("cross_file_diagnostic_sweep");
    group.sample_size(20);

    let chain_depths: &[usize] = &[1, 5, 15];

    // Identifier names that actually exist in the fixture so `is_visible`
    // does real work: `func_0_0` (local def in file_0.R), `var_0_0` (local
    // extra-line def), `func_1_0` (inherited via `source("file_1.R")`), and
    // `missing_sym` (genuinely absent — exercises the not-found path).
    let names: &[&str] = &["func_0_0", "var_0_0", "func_1_0", "missing_sym"];

    for &depth in chain_depths {
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

        let content = std::fs::read_to_string(workspace_path.join("file_0.R")).unwrap();
        let positions = sweep_positions(&content);

        let get_artifacts = |u: &Url| artifacts_map.get(u).cloned();
        let get_metadata = |u: &Url| metadata_map.get(u).cloned();
        let is_cancelled = || false;

        // Arm 1: streaming sweep.
        group.bench_with_input(BenchmarkId::new("streaming", depth), &depth, |b, _| {
            b.iter(|| {
                let prefix_cache =
                    std::cell::RefCell::new(raven::cross_file::ParentPrefixCache::new());
                black_box(raven::cross_file::bench_scope_stream_sweep(
                    black_box(&uri),
                    &get_artifacts,
                    &get_metadata,
                    &graph,
                    Some(&folder_url),
                    black_box(20),
                    &base_exports,
                    true,
                    raven::cross_file::config::BackwardDependencyMode::Explicit,
                    &is_cancelled,
                    &prefix_cache,
                    None,
                    black_box(&positions),
                    black_box(names),
                ))
            })
        });

        // Arm 2: per-position, cached — one ParentPrefixCache shared across
        // the K calls (fresh per iteration, shared within).
        group.bench_with_input(
            BenchmarkId::new("per_position_cached", depth),
            &depth,
            |b, _| {
                b.iter(|| {
                    let mut prefix_cache = raven::cross_file::ParentPrefixCache::new();
                    let mut acc = 0usize;
                    for &(line, column) in &positions {
                        let scope = raven::cross_file::scope_at_position_with_graph_cached(
                            black_box(&uri),
                            line,
                            column,
                            &get_artifacts,
                            &get_metadata,
                            &graph,
                            Some(&folder_url),
                            black_box(20),
                            &base_exports,
                            true,
                            raven::cross_file::config::BackwardDependencyMode::Explicit,
                            &is_cancelled,
                            &mut prefix_cache,
                            None,
                        );
                        for name in names {
                            if scope.symbols.contains_key(*name) {
                                acc += 1;
                            }
                        }
                    }
                    black_box(acc)
                })
            },
        );

        // Arm 3: per-position, uncached.
        group.bench_with_input(
            BenchmarkId::new("per_position_uncached", depth),
            &depth,
            |b, _| {
                b.iter(|| {
                    let mut acc = 0usize;
                    for &(line, column) in &positions {
                        let scope = raven::cross_file::scope_at_position_with_graph(
                            black_box(&uri),
                            line,
                            column,
                            &get_artifacts,
                            &get_metadata,
                            &graph,
                            Some(&folder_url),
                            black_box(20),
                            &base_exports,
                            true,
                            raven::cross_file::config::BackwardDependencyMode::Explicit,
                            &is_cancelled,
                            None,
                        );
                        for name in names {
                            if scope.symbols.contains_key(*name) {
                                acc += 1;
                            }
                        }
                    }
                    black_box(acc)
                })
            },
        );
    }

    group.finish();
}

fn bench_scope_hotspots(c: &mut Criterion) {
    let mut group = c.benchmark_group("cross_file_scope_hotspots");
    group.sample_size(10);

    let the_configs: &[(&str, FixtureConfig)] = &[
        (
            "package_heavy_deep_graph",
            FixtureConfig {
                file_count: 120,
                functions_per_file: 4,
                source_chain_depth: 35,
                library_calls_per_file: 12,
                extra_lines_per_file: 4,
            },
        ),
        (
            "function_heavy_deep_graph",
            FixtureConfig {
                file_count: 120,
                functions_per_file: 40,
                source_chain_depth: 35,
                library_calls_per_file: 0,
                extra_lines_per_file: 4,
            },
        ),
    ];

    for (label, config) in the_configs {
        let workspace = create_fixture_workspace(config);
        let workspace_path = workspace.path();
        let folder_url = Url::from_file_path(workspace_path).unwrap();
        let (artifacts_map, metadata_map) = precompute_artifacts(workspace_path);
        let graph = build_dependency_graph(&metadata_map, Some(&folder_url));
        let uri = file_0_uri(workspace_path);
        let base_exports: HashSet<String> = HashSet::new();

        group.bench_with_input(
            BenchmarkId::new("graph_scope", *label),
            &(&uri, &artifacts_map, &metadata_map, &graph, &folder_url),
            |b, &(uri, artifacts_map, metadata_map, graph, folder_url)| {
                b.iter(|| {
                    black_box(raven::cross_file::scope_at_position_with_graph(
                        black_box(uri),
                        u32::MAX,
                        u32::MAX,
                        &|u| artifacts_map.get(u).cloned(),
                        &|u| metadata_map.get(u).cloned(),
                        graph,
                        Some(folder_url),
                        black_box(40),
                        &base_exports,
                        true,
                        raven::cross_file::config::BackwardDependencyMode::Explicit,
                        &|| false,
                        None,
                    ))
                })
            },
        );
    }

    let the_nested_cases: &[(usize, usize)] = &[(16, 16), (32, 32)];
    for &(depth, defs_per_scope) in the_nested_cases {
        let (_uri, artifacts, query_line, query_column) =
            build_nested_scope_artifacts(depth, defs_per_scope);
        let label = format!("depth_{depth}_defs_{defs_per_scope}");
        group.bench_with_input(
            BenchmarkId::new("nested_scope", label),
            &artifacts,
            |b, artifacts| {
                b.iter(|| {
                    black_box(scope_at_position(
                        artifacts,
                        black_box(query_line),
                        black_box(query_column),
                        false,
                    ))
                })
            },
        );
    }

    group.finish();
}

fn bench_interval_tree_queries(c: &mut Criterion) {
    let mut group = c.benchmark_group("cross_file_interval_tree_queries");
    group.sample_size(10);

    let the_depths: &[usize] = &[256, 1024, 4096];
    for &depth in the_depths {
        let tree = build_nested_interval_tree(depth);

        // Near-leaf: query at the deepest nesting level
        let leaf_position = Position::new(depth as u32, 0);
        group.bench_with_input(
            BenchmarkId::new("query_point_leaf", depth),
            &tree,
            |b, tree| b.iter(|| black_box(tree.query_point(black_box(leaf_position)))),
        );
        group.bench_with_input(
            BenchmarkId::new("query_innermost_leaf", depth),
            &tree,
            |b, tree| b.iter(|| black_box(tree.query_innermost(black_box(leaf_position)))),
        );

        // Near-root: query at the shallowest nesting level
        let root_position = Position::new(1, 0);
        group.bench_with_input(
            BenchmarkId::new("query_point_root", depth),
            &tree,
            |b, tree| b.iter(|| black_box(tree.query_point(black_box(root_position)))),
        );
        group.bench_with_input(
            BenchmarkId::new("query_innermost_root", depth),
            &tree,
            |b, tree| b.iter(|| black_box(tree.query_innermost(black_box(root_position)))),
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
            |b, &(graph, uri)| b.iter(|| black_box(graph.get_dependencies(black_box(uri)))),
        );

        // Benchmark: querying direct dependents of the last file in the chain
        // (the most-sourced file has the most dependents)
        let chain_end_idx = config.source_chain_depth.min(config.file_count - 1);
        let chain_end_uri =
            Url::from_file_path(workspace_path.join(format!("file_{}.R", chain_end_idx))).unwrap();

        group.bench_with_input(
            BenchmarkId::new("get_dependents", *label),
            &(&graph, &chain_end_uri),
            |b, &(graph, uri)| b.iter(|| black_box(graph.get_dependents(black_box(uri)))),
        );

        // Benchmark: querying transitive dependents from the chain end
        let default_config = raven::cross_file::CrossFileConfig::default();
        group.bench_with_input(
            BenchmarkId::new("get_transitive_dependents", *label),
            &(&graph, &chain_end_uri),
            |b, &(graph, uri)| {
                b.iter(|| {
                    black_box(graph.get_transitive_dependents(
                        black_box(uri),
                        default_config.max_chain_depth,
                        default_config.max_transitive_dependents_visited,
                    ))
                })
            },
        );
    }

    group.finish();
}

criterion_group!(
    benches,
    bench_scope_resolution,
    bench_diagnostic_sweep,
    bench_dependency_graph,
    bench_scope_hotspots,
    bench_interval_tree_queries,
);
criterion_main!(benches);
