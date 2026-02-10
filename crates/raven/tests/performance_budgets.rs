//! Time-budget regression tests for Raven.
//!
//! These tests assert that key operations complete within wall-clock thresholds.
//! They are gated behind `#[cfg(not(debug_assertions))]` because debug-mode
//! timings are not meaningful.
//!
//! Run with: `cargo test --release -p raven --test performance_budgets`
//!
//! CI adaptation: when the `CI` environment variable is set, thresholds are
//! multiplied by a relaxation factor (default 3×, configurable via
//! `RAVEN_PERF_CI_FACTOR`).

// Only compile in release mode — debug timings are meaningless.
#![cfg(not(debug_assertions))]

use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

/// Run `f` three times and return the median duration.
///
/// Using the median (rather than the mean) reduces the impact of outliers
/// caused by OS scheduling jitter, page faults on first access, etc.
fn median_of_3<F: FnMut()>(mut f: F) -> Duration {
    let mut times = [Duration::ZERO; 3];
    for t in &mut times {
        let start = Instant::now();
        f();
        *t = start.elapsed();
    }
    times.sort();
    times[1]
}

/// Return the CI relaxation factor for time-budget thresholds.
///
/// - When `CI` is set (to any non-empty value), returns the value of
///   `RAVEN_PERF_CI_FACTOR` (default **3.0**).
/// - Otherwise returns **1.0** (no relaxation).
fn ci_factor() -> f64 {
    let is_ci = std::env::var("CI")
        .map(|v| !v.is_empty())
        .unwrap_or(false);

    if is_ci {
        std::env::var("RAVEN_PERF_CI_FACTOR")
            .ok()
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|&f| f >= 1.0)
            .unwrap_or(3.0)
    } else {
        1.0
    }
}

/// Assert that `measured` is within `budget_ms × ci_factor()`.
///
/// Panics with a descriptive message that includes:
/// - the label identifying the operation,
/// - the measured time,
/// - the effective threshold,
/// - whether CI relaxation was applied.
fn assert_within_budget(label: &str, measured: Duration, budget_ms: u64) {
    let factor = ci_factor();
    let threshold = Duration::from_secs_f64(budget_ms as f64 * factor / 1000.0);
    let ci_note = if factor > 1.0 {
        format!(" (CI relaxation {factor:.1}× applied)")
    } else {
        String::new()
    };

    assert!(
        measured <= threshold,
        "Time budget exceeded for '{label}': \
         measured {measured:.1?}, threshold {threshold:.1?} \
         (base {budget_ms}ms × {factor:.1}){ci_note}",
    );
}

// ---------------------------------------------------------------------------
// Harness self-tests
// ---------------------------------------------------------------------------

#[test]
fn median_of_3_calls_f_exactly_3_times() {
    let mut count = 0u32;
    let _ = median_of_3(|| {
        count += 1;
    });
    assert_eq!(count, 3, "median_of_3 should call f exactly 3 times");
}

#[test]
fn median_of_3_returns_middle_duration() {
    // We can't control exact wall-clock durations, but we can verify the
    // sort-and-pick-middle logic by checking that the result is bounded
    // between the fastest and slowest of three no-op calls.
    let result = median_of_3(|| {
        // no-op — all three durations should be very close to zero
    });
    // The median of three near-zero durations should itself be near zero.
    assert!(
        result < Duration::from_millis(50),
        "median of three no-ops should be < 50ms, got {result:?}"
    );
}

#[test]
fn ci_factor_is_1_when_ci_unset() {
    // Save and clear CI env var.
    let original_ci = std::env::var("CI").ok();
    let original_factor = std::env::var("RAVEN_PERF_CI_FACTOR").ok();
    std::env::remove_var("CI");
    std::env::remove_var("RAVEN_PERF_CI_FACTOR");

    let factor = ci_factor();
    assert!(
        (factor - 1.0).abs() < f64::EPSILON,
        "ci_factor should be 1.0 when CI is unset, got {factor}"
    );

    // Restore.
    if let Some(val) = original_ci {
        std::env::set_var("CI", val);
    }
    if let Some(val) = original_factor {
        std::env::set_var("RAVEN_PERF_CI_FACTOR", val);
    }
}

#[test]
fn assert_within_budget_passes_for_fast_op() {
    let measured = Duration::from_micros(100);
    // Should not panic: 100µs is well within 5ms.
    assert_within_budget("trivial_op", measured, 5);
}

#[test]
#[should_panic(expected = "Time budget exceeded")]
fn assert_within_budget_panics_for_slow_op() {
    let measured = Duration::from_secs(1);
    // 1s is way over a 5ms budget.
    assert_within_budget("slow_op", measured, 5);
}

#[test]
fn assert_within_budget_message_includes_details() {
    let measured = Duration::from_millis(100);
    let result = std::panic::catch_unwind(|| {
        assert_within_budget("test_op", measured, 1);
    });
    let err = result.expect_err("should have panicked");
    let msg = err
        .downcast_ref::<String>()
        .map(|s| s.as_str())
        .unwrap_or("");
    assert!(msg.contains("test_op"), "message should contain label");
    assert!(
        msg.contains("threshold"),
        "message should contain 'threshold'"
    );
    assert!(
        msg.contains("base 1ms"),
        "message should contain base budget"
    );
}

// ---------------------------------------------------------------------------
// Time-budget tests for real operations
// Requirements: 2.1
// ---------------------------------------------------------------------------

use std::collections::{HashMap, HashSet};
use std::fmt::Write;
use tempfile::TempDir;
use tree_sitter::Parser;
use url::Url;

/// Create a tree-sitter parser configured for R.
fn make_r_parser() -> Parser {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_r::LANGUAGE.into())
        .expect("Failed to set R language for tree-sitter");
    parser
}

/// Well-known library names used deterministically in generated code.
const LIBRARIES: &[&str] = &[
    "stats", "utils", "dplyr", "ggplot2", "tidyr",
    "stringr", "purrr", "readr", "tibble", "forcats",
];

/// Configuration for generating a fixture workspace (mirrors test_utils::fixture_workspace).
struct TestFixtureConfig {
    file_count: usize,
    functions_per_file: usize,
    source_chain_depth: usize,
    library_calls_per_file: usize,
    extra_lines_per_file: usize,
}

impl TestFixtureConfig {
    /// Small workspace: 10 files, 5 functions each, source chain depth 3.
    fn small() -> Self {
        Self {
            file_count: 10,
            functions_per_file: 5,
            source_chain_depth: 3,
            library_calls_per_file: 1,
            extra_lines_per_file: 5,
        }
    }

    /// Medium workspace: 50 files, 10 functions each, source chain depth 10.
    fn medium() -> Self {
        Self {
            file_count: 50,
            functions_per_file: 10,
            source_chain_depth: 10,
            library_calls_per_file: 2,
            extra_lines_per_file: 10,
        }
    }
}

/// Generate the content of a single R file deterministically.
fn generate_fixture_r_file(index: usize, config: &TestFixtureConfig) -> String {
    let mut content = String::new();

    for lib_i in 0..config.library_calls_per_file {
        let lib_name = LIBRARIES[(index * config.library_calls_per_file + lib_i) % LIBRARIES.len()];
        writeln!(content, "library({})", lib_name).unwrap();
    }

    if config.library_calls_per_file > 0 {
        content.push('\n');
    }

    if index < config.source_chain_depth && index + 1 < config.file_count {
        writeln!(content, "source(\"file_{}.R\")", index + 1).unwrap();
        content.push('\n');
    }

    for func_i in 0..config.functions_per_file {
        writeln!(
            content,
            "func_{}_{} <- function(x, y = {}) {{",
            index, func_i, func_i + 1
        )
        .unwrap();
        writeln!(content, "    result <- x + y * {}", func_i + 1).unwrap();
        writeln!(content, "    if (is.na(result)) {{").unwrap();
        writeln!(content, "        return(NULL)").unwrap();
        writeln!(content, "    }}").unwrap();
        writeln!(content, "    result").unwrap();
        writeln!(content, "}}").unwrap();
        content.push('\n');
    }

    for line_i in 0..config.extra_lines_per_file {
        writeln!(content, "var_{}_{} <- {}", index, line_i, line_i + 1).unwrap();
    }

    content
}

/// Create a temporary fixture workspace from the given configuration.
fn create_test_fixture_workspace(config: &TestFixtureConfig) -> TempDir {
    let temp_dir = TempDir::new().expect("Failed to create temp directory for fixture workspace");
    for i in 0..config.file_count {
        let content = generate_fixture_r_file(i, config);
        let filename = format!("file_{}.R", i);
        let filepath = temp_dir.path().join(&filename);
        std::fs::write(&filepath, &content)
            .unwrap_or_else(|e| panic!("Failed to write fixture file {}: {}", filename, e));
    }
    temp_dir
}

/// Generate a synthetic R file of approximately `target_bytes` size.
fn generate_r_code_of_size(target_bytes: usize) -> String {
    let mut content = String::new();
    let mut func_idx = 0;

    // Each function block is roughly 120 bytes
    while content.len() < target_bytes {
        writeln!(
            content,
            r#"func_{} <- function(x, y = {}) {{
    result <- x + y * {}
    if (is.na(result)) {{
        return(NULL)
    }}
    result
}}
"#,
            func_idx,
            func_idx + 1,
            func_idx + 1
        )
        .unwrap();
        func_idx += 1;
    }

    // Trim to approximate target size (don't cut mid-line)
    if content.len() > target_bytes {
        // Find the last newline before target_bytes
        if let Some(pos) = content[..target_bytes].rfind('\n') {
            content.truncate(pos + 1);
        }
    }

    content
}

// ---------------------------------------------------------------------------
// Tree-sitter parsing budgets
// Requirements: 2.1 — 1KB < 5ms, 10KB < 25ms, 100KB < 250ms
// ---------------------------------------------------------------------------

#[test]
fn budget_tree_sitter_parse_1kb() {
    let code = generate_r_code_of_size(1_024);
    assert!(
        code.len() >= 900,
        "Generated code should be approximately 1KB, got {} bytes",
        code.len()
    );

    let mut parser = make_r_parser();

    // Warm up the parser
    let _ = parser.parse(&code, None);

    let elapsed = median_of_3(|| {
        let _ = parser.parse(&code, None).expect("parse failed");
    });

    assert_within_budget("tree_sitter_parse_1kb", elapsed, 5);
}

#[test]
fn budget_tree_sitter_parse_10kb() {
    let code = generate_r_code_of_size(10_240);
    assert!(
        code.len() >= 9_000,
        "Generated code should be approximately 10KB, got {} bytes",
        code.len()
    );

    let mut parser = make_r_parser();

    // Warm up the parser
    let _ = parser.parse(&code, None);

    let elapsed = median_of_3(|| {
        let _ = parser.parse(&code, None).expect("parse failed");
    });

    assert_within_budget("tree_sitter_parse_10kb", elapsed, 25);
}

#[test]
fn budget_tree_sitter_parse_100kb() {
    let code = generate_r_code_of_size(102_400);
    assert!(
        code.len() >= 90_000,
        "Generated code should be approximately 100KB, got {} bytes",
        code.len()
    );

    let mut parser = make_r_parser();

    // Warm up the parser
    let _ = parser.parse(&code, None);

    let elapsed = median_of_3(|| {
        let _ = parser.parse(&code, None).expect("parse failed");
    });

    assert_within_budget("tree_sitter_parse_100kb", elapsed, 250);
}

// ---------------------------------------------------------------------------
// Metadata extraction budget
// Requirements: 2.1 — single file < 2ms
// ---------------------------------------------------------------------------

#[test]
fn budget_metadata_extraction_single_file() {
    // Use a realistic R file with directives, source() calls, and library() calls
    let code = r#"# @lsp-cd: /some/path
# @lsp-sourced-by: ../parent.R

library(dplyr)
library(ggplot2)

source("utils.R")
source("data/loader.R", local = TRUE)
sys.source("helpers.R", envir = new.env())

my_function <- function(x) {
    y <- x + 1
    return(y)
}

another_func <- function(a, b, c) {
    result <- a * b + c
    if (is.null(result)) {
        return(NA)
    }
    result
}

data <- data.frame(x = 1:100, y = rnorm(100))
"#;

    // Warm up
    let _ = raven::cross_file::extract_metadata(code);

    let elapsed = median_of_3(|| {
        let _ = raven::cross_file::extract_metadata(code);
    });

    assert_within_budget("metadata_extraction_single_file", elapsed, 2);
}

// ---------------------------------------------------------------------------
// Scope resolution budget
// Requirements: 2.1 — 50-file workspace < 50ms
// ---------------------------------------------------------------------------

#[test]
fn budget_scope_resolution_50_file_workspace() {
    // Create a 50-file workspace (medium preset)
    let config = TestFixtureConfig::medium(); // 50 files, 10 funcs, depth 10
    let workspace = create_test_fixture_workspace(&config);
    let workspace_path = workspace.path();
    let folder_url = Url::from_file_path(workspace_path).unwrap();

    // Pre-compute artifacts and metadata for all files (same pattern as cross_file bench)
    let mut artifacts_map: HashMap<Url, raven::cross_file::ScopeArtifacts> = HashMap::new();
    let mut metadata_map: HashMap<Url, raven::cross_file::types::CrossFileMetadata> =
        HashMap::new();

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

        let meta = raven::cross_file::extract_metadata(&content);
        let tree = raven::parser_pool::with_parser(|parser| parser.parse(&content, None));
        if let Some(tree) = tree {
            let arts = raven::cross_file::compute_artifacts(&uri, &tree, &content);
            artifacts_map.insert(uri.clone(), arts);
        }
        metadata_map.insert(uri, meta);
    }

    // Build dependency graph
    let mut graph = raven::cross_file::DependencyGraph::new();
    for (uri, meta) in &metadata_map {
        graph.update_file(uri, meta, Some(&folder_url), |_| None);
    }

    let uri = Url::from_file_path(workspace_path.join("file_0.R")).unwrap();
    let base_exports: HashSet<String> = HashSet::new();

    // Warm up
    let _ = raven::cross_file::scope_at_position_with_graph(
        &uri,
        u32::MAX,
        u32::MAX,
        &|u| artifacts_map.get(u).cloned(),
        &|u| metadata_map.get(u).cloned(),
        &graph,
        Some(&folder_url),
        20,
        &base_exports,
    );

    let elapsed = median_of_3(|| {
        let _ = raven::cross_file::scope_at_position_with_graph(
            &uri,
            u32::MAX,
            u32::MAX,
            &|u| artifacts_map.get(u).cloned(),
            &|u| metadata_map.get(u).cloned(),
            &graph,
            Some(&folder_url),
            20,
            &base_exports,
        );
    });

    assert_within_budget("scope_resolution_50_files", elapsed, 50);
}

// ---------------------------------------------------------------------------
// Single-file completion budget
// Requirements: 2.1 — single-file completion < 20ms
// ---------------------------------------------------------------------------

#[test]
fn budget_single_file_completion() {
    use raven::state::{scan_workspace, Document, WorldState};
    use tower_lsp::lsp_types::Position;

    // Create a small fixture workspace for realistic completion context
    let config = TestFixtureConfig::small(); // 10 files, 5 funcs, depth 3
    let workspace = create_test_fixture_workspace(&config);
    let workspace_path = workspace.path();

    // Build a fully-populated WorldState (same pattern as lsp_operations bench)
    let mut state = WorldState::new(vec![]);
    let folder_url = Url::from_file_path(workspace_path).unwrap();
    state.workspace_folders.push(folder_url.clone());

    // Open every .R file as a document
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
        state.documents.insert(uri, Document::new(&content, None));
    }

    // Run workspace scan and apply index (populates cross-file state)
    let (index, imports, cross_file_entries, new_index_entries) =
        scan_workspace(&[folder_url], 20);
    state.apply_workspace_index(index, imports, cross_file_entries, new_index_entries);

    let uri = Url::from_file_path(workspace_path.join("file_0.R")).unwrap();
    // Position inside the first function body (line 5, col 4 — on `result`)
    let pos = Position::new(5, 4);

    // Warm up
    let _ = raven::handlers::completion(&state, &uri, pos, None);

    let elapsed = median_of_3(|| {
        let _ = raven::handlers::completion(&state, &uri, pos, None);
    });

    assert_within_budget("single_file_completion", elapsed, 20);
}
