// startup.rs - Performance benchmarks for Raven startup and initialization
//
// Run with: cargo bench --bench startup
// Compare baselines: cargo bench --bench startup -- --baseline before
//
// Allocation tracking: set RAVEN_BENCH_ALLOC=1 to report allocation counts.

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use std::collections::HashMap;
use std::path::PathBuf;
use tree_sitter::Parser;
use url::Url;

// Re-use the fixture workspace generator from the raven crate.
#[path = "../src/test_utils/fixture_workspace.rs"]
#[allow(dead_code, unused_imports)]
mod fixture_workspace;

// Optional allocation counting (active when RAVEN_BENCH_ALLOC=1).
#[path = "../src/test_utils/alloc_counter.rs"]
mod alloc_counter;

#[global_allocator]
static ALLOC: alloc_counter::CountingAllocator = alloc_counter::CountingAllocator;

use fixture_workspace::{create_fixture_workspace, FixtureConfig};

/// Generate a synthetic R file with specified characteristics (for inline use).
fn generate_r_file(
    index: usize,
    functions_per_file: usize,
    include_source: bool,
) -> String {
    let mut content = String::new();

    content.push_str("library(stats)\n\n");

    if include_source && index > 0 {
        content.push_str(&format!("source(\"file_{}.R\")\n\n", index - 1));
    }

    for func_idx in 0..functions_per_file {
        content.push_str(&format!(
            r#"func_{}_{} <- function(x, y) {{
    result <- x + y
    if (is.na(result)) {{
        return(NULL)
    }}
    return(result * 2)
}}

"#,
            index, func_idx
        ));
    }

    content.push_str(&format!(
        "data_{} <- data.frame(x = 1:10, y = rnorm(10))\n",
        index
    ));

    content
}

/// Create a thread-local tree-sitter parser configured for R.
fn make_r_parser() -> Parser {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_r::LANGUAGE.into())
        .expect("Failed to set R language for tree-sitter");
    parser
}

// ---------------------------------------------------------------------------
// Benchmark: metadata extraction using real cross-file analysis
// Requirements: 1.1
// ---------------------------------------------------------------------------

fn bench_metadata_extraction(c: &mut Criterion) {
    let mut group = c.benchmark_group("metadata_extraction");

    let small_code = r#"
# @lsp-cd: /some/path
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

    group.bench_function("extract_metadata_small", |b| {
        b.iter(|| {
            black_box(raven::cross_file::extract_metadata(black_box(small_code)))
        })
    });

    // Larger code: ~50 repetitions of the sample
    let large_code = small_code.repeat(50);
    group.bench_function("extract_metadata_large", |b| {
        b.iter(|| {
            black_box(raven::cross_file::extract_metadata(black_box(&large_code)))
        })
    });

    group.finish();
}

// ---------------------------------------------------------------------------
// Benchmark: workspace scanning with real scan_workspace()
// Requirements: 1.1, 1.3
// ---------------------------------------------------------------------------

fn bench_workspace_scan(c: &mut Criterion) {
    let mut group = c.benchmark_group("workspace_scan");
    group.sample_size(10);

    let configs: &[(&str, FixtureConfig)] = &[
        ("small_10", FixtureConfig::small()),
        ("medium_50", FixtureConfig::medium()),
    ];

    for (label, config) in configs {
        // Pre-create the workspace so fixture generation isn't measured.
        let workspace = create_fixture_workspace(config);

        group.bench_with_input(
            BenchmarkId::new("scan", *label),
            &workspace,
            |b, ws| {
                let folder_url = Url::from_file_path(ws.path()).unwrap();
                b.iter(|| {
                    black_box(raven::state::scan_workspace(
                        black_box(&[folder_url.clone()]),
                        20, // default max_chain_depth
                    ))
                })
            },
        );
    }

    group.finish();
}

// ---------------------------------------------------------------------------
// Benchmark: batch init output parsing (kept as-is — already real logic)
// ---------------------------------------------------------------------------

fn bench_batch_init_parsing(c: &mut Criterion) {
    let sample_output = r#"__RAVEN_LIB_PATHS__
/Library/Frameworks/R.framework/Versions/4.4/Resources/library
/Users/test/Library/R/arm64/4.4/library

__RAVEN_BASE_PACKAGES__
base
methods
utils
grDevices
graphics
stats
datasets

__RAVEN_EXPORTS__
__PKG:base__
c
list
print
cat
paste
paste0
sprintf
format
nchar
substr
strsplit
grep
grepl
sub
gsub
__PKG:methods__
setClass
setGeneric
setMethod
new
show
slot
__PKG:utils__
help
str
head
tail
View
edit
__PKG:stats__
lm
glm
t.test
anova
mean
sd
var
cor
__RAVEN_END__
"#;

    c.bench_function("parse_batch_init_output", |b| {
        b.iter(|| {
            let mut lib_paths: Vec<PathBuf> = Vec::new();
            let mut base_packages: Vec<String> = Vec::new();
            let mut exports: HashMap<String, Vec<String>> = HashMap::new();

            let lib_start = sample_output.find("__RAVEN_LIB_PATHS__").unwrap();
            let base_start = sample_output.find("__RAVEN_BASE_PACKAGES__").unwrap();
            let exports_start = sample_output.find("__RAVEN_EXPORTS__").unwrap();

            let lib_section = &sample_output[lib_start + 19..base_start];
            for line in lib_section.lines() {
                let line = line.trim();
                if !line.is_empty() {
                    lib_paths.push(PathBuf::from(line));
                }
            }

            let base_section = &sample_output[base_start + 23..exports_start];
            for line in base_section.lines() {
                let line = line.trim();
                if !line.is_empty() {
                    base_packages.push(line.to_string());
                }
            }

            let exports_section = &sample_output[exports_start + 17..];
            let mut current_pkg: Option<String> = None;
            let mut current_exports: Vec<String> = Vec::new();

            for line in exports_section.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                if line.starts_with("__PKG:") && line.ends_with("__") {
                    if let Some(pkg) = current_pkg.take() {
                        exports.insert(pkg, std::mem::take(&mut current_exports));
                    }
                    current_pkg = Some(line[6..line.len() - 2].to_string());
                } else if line == "__RAVEN_END__" {
                    if let Some(pkg) = current_pkg.take() {
                        exports.insert(pkg, current_exports);
                    }
                    break;
                } else if current_pkg.is_some() {
                    current_exports.push(line.to_string());
                }
            }

            black_box((lib_paths, base_packages, exports))
        })
    });
}

// ---------------------------------------------------------------------------
// Benchmark: tree-sitter parsing of R code (real parser)
// Requirements: 1.1, 1.3
// ---------------------------------------------------------------------------

fn bench_tree_sitter_parsing(c: &mut Criterion) {
    let mut group = c.benchmark_group("tree_sitter_parsing");

    let small_code = generate_r_file(0, 3, false);
    let medium_code = generate_r_file(0, 20, false);
    let large_code = generate_r_file(0, 100, false);

    let mut parser = make_r_parser();

    group.bench_function("parse_small", |b| {
        b.iter(|| {
            let tree = parser
                .parse(black_box(&small_code), None)
                .expect("parse failed");
            black_box(tree)
        })
    });

    group.bench_function("parse_medium", |b| {
        b.iter(|| {
            let tree = parser
                .parse(black_box(&medium_code), None)
                .expect("parse failed");
            black_box(tree)
        })
    });

    group.bench_function("parse_large", |b| {
        b.iter(|| {
            let tree = parser
                .parse(black_box(&large_code), None)
                .expect("parse failed");
            black_box(tree)
        })
    });

    group.finish();
}

// ---------------------------------------------------------------------------
// Allocation-tracking wrappers (active only when RAVEN_BENCH_ALLOC=1)
//
// These run each benchmark group once and print allocation counts alongside
// the normal Criterion output. When the env-var is unset the functions are
// still registered but return immediately, adding negligible overhead.
// ---------------------------------------------------------------------------

fn bench_alloc_report(c: &mut Criterion) {
    if !alloc_counter::is_tracking_enabled() {
        return;
    }

    let mut group = c.benchmark_group("alloc_report");
    group.sample_size(10);

    // --- metadata extraction (small) ---
    let small_code = r#"
library(dplyr)
source("utils.R")
my_func <- function(x) { x + 1 }
"#;
    group.bench_function("metadata_extraction_small", |b| {
        b.iter(|| {
            alloc_counter::reset();
            let result = black_box(raven::cross_file::extract_metadata(black_box(small_code)));
            alloc_counter::print_report("metadata_extraction_small");
            result
        })
    });

    // --- tree-sitter parse (small) ---
    let parse_code = generate_r_file(0, 5, false);
    let mut parser = make_r_parser();
    group.bench_function("tree_sitter_parse_small", |b| {
        b.iter(|| {
            alloc_counter::reset();
            let tree = parser
                .parse(black_box(&parse_code), None)
                .expect("parse failed");
            alloc_counter::print_report("tree_sitter_parse_small");
            black_box(tree)
        })
    });

    group.finish();
}

criterion_group!(
    benches,
    bench_metadata_extraction,
    bench_workspace_scan,
    bench_batch_init_parsing,
    bench_tree_sitter_parsing,
    bench_alloc_report,
);
criterion_main!(benches);
