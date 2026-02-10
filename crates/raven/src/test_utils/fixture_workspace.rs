//! Deterministic fixture workspace generator for benchmarks and tests.
//!
//! Generates synthetic R workspaces with controlled characteristics:
//! file count, functions per file, source() chains, library() calls,
//! and extra lines of non-function code.
//!
//! All output is deterministic — no randomness — so benchmarks are reproducible.

use std::fmt::Write;
use std::path::Path;
use tempfile::TempDir;

/// Configuration for generating a fixture workspace.
#[derive(Debug, Clone)]
pub struct FixtureConfig {
    pub file_count: usize,
    pub functions_per_file: usize,
    pub source_chain_depth: usize,
    pub library_calls_per_file: usize,
    pub extra_lines_per_file: usize,
}

/// A set of well-known library names used deterministically in generated code.
const LIBRARIES: &[&str] = &[
    "stats", "utils", "dplyr", "ggplot2", "tidyr",
    "stringr", "purrr", "readr", "tibble", "forcats",
];

impl FixtureConfig {
    /// Small workspace: 10 files, 5 functions each, source chain depth 3.
    pub fn small() -> Self {
        Self {
            file_count: 10,
            functions_per_file: 5,
            source_chain_depth: 3,
            library_calls_per_file: 1,
            extra_lines_per_file: 5,
        }
    }

    /// Medium workspace: 50 files, 10 functions each, source chain depth 10.
    pub fn medium() -> Self {
        Self {
            file_count: 50,
            functions_per_file: 10,
            source_chain_depth: 10,
            library_calls_per_file: 2,
            extra_lines_per_file: 10,
        }
    }

    /// Large workspace: 200 files, 20 functions each, source chain depth 15.
    pub fn large() -> Self {
        Self {
            file_count: 200,
            functions_per_file: 20,
            source_chain_depth: 15,
            library_calls_per_file: 3,
            extra_lines_per_file: 20,
        }
    }
}

/// Generate the content of a single R file deterministically.
///
/// - `index`: file index (0-based), used for naming and source chain linkage
/// - `config`: the workspace configuration
fn generate_r_file_content(index: usize, config: &FixtureConfig) -> String {
    let mut content = String::new();

    // Library calls — cycle through the known library list deterministically
    for lib_i in 0..config.library_calls_per_file {
        let lib_name = LIBRARIES[(index * config.library_calls_per_file + lib_i) % LIBRARIES.len()];
        writeln!(content, "library({})", lib_name).unwrap();
    }

    if config.library_calls_per_file > 0 {
        content.push('\n');
    }

    // Source chain: file_0 sources file_1, file_1 sources file_2, etc.
    // Only files within the chain depth get a source() call.
    if index < config.source_chain_depth && index + 1 < config.file_count {
        writeln!(content, "source(\"file_{}.R\")", index + 1).unwrap();
        content.push('\n');
    }

    // Function definitions
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

    // Extra lines of non-function code (variable assignments, data frames)
    for line_i in 0..config.extra_lines_per_file {
        writeln!(content, "var_{}_{} <- {}", index, line_i, line_i + 1).unwrap();
    }

    content
}

/// Create a temporary fixture workspace from the given configuration.
///
/// Returns a `TempDir` whose path contains the generated `.R` files.
/// The directory is cleaned up when the `TempDir` is dropped.
///
/// Calling this twice with the same `FixtureConfig` produces byte-identical files.
pub fn create_fixture_workspace(config: &FixtureConfig) -> TempDir {
    let temp_dir = TempDir::new().expect("Failed to create temp directory for fixture workspace");
    write_fixture_workspace(temp_dir.path(), config);
    temp_dir
}

/// Write fixture files into an existing directory.
///
/// Useful when you need to control the directory path (e.g., for named temp dirs).
pub fn write_fixture_workspace(dir: &Path, config: &FixtureConfig) {
    for i in 0..config.file_count {
        let content = generate_r_file_content(i, config);
        let filename = format!("file_{}.R", i);
        let filepath = dir.join(&filename);
        std::fs::write(&filepath, &content)
            .unwrap_or_else(|e| panic!("Failed to write fixture file {}: {}", filename, e));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_small_preset_values() {
        let config = FixtureConfig::small();
        assert_eq!(config.file_count, 10);
        assert_eq!(config.functions_per_file, 5);
        assert_eq!(config.source_chain_depth, 3);
    }

    #[test]
    fn test_medium_preset_values() {
        let config = FixtureConfig::medium();
        assert_eq!(config.file_count, 50);
        assert_eq!(config.functions_per_file, 10);
        assert_eq!(config.source_chain_depth, 10);
    }

    #[test]
    fn test_large_preset_values() {
        let config = FixtureConfig::large();
        assert_eq!(config.file_count, 200);
        assert_eq!(config.functions_per_file, 20);
        assert_eq!(config.source_chain_depth, 15);
    }

    #[test]
    fn test_file_count_matches_config() {
        let config = FixtureConfig::small();
        let workspace = create_fixture_workspace(&config);
        let r_files: Vec<_> = std::fs::read_dir(workspace.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.path()
                    .extension()
                    .map(|ext| ext == "R")
                    .unwrap_or(false)
            })
            .collect();
        assert_eq!(r_files.len(), config.file_count);
    }

    #[test]
    fn test_deterministic_output() {
        let config = FixtureConfig::small();
        let ws1 = create_fixture_workspace(&config);
        let ws2 = create_fixture_workspace(&config);

        for i in 0..config.file_count {
            let filename = format!("file_{}.R", i);
            let content1 = std::fs::read_to_string(ws1.path().join(&filename)).unwrap();
            let content2 = std::fs::read_to_string(ws2.path().join(&filename)).unwrap();
            assert_eq!(content1, content2, "File {} should be identical across runs", filename);
        }
    }

    #[test]
    fn test_source_chain_structure() {
        let config = FixtureConfig {
            file_count: 5,
            functions_per_file: 1,
            source_chain_depth: 3,
            library_calls_per_file: 0,
            extra_lines_per_file: 0,
        };
        let workspace = create_fixture_workspace(&config);

        // file_0 should source file_1
        let content_0 = std::fs::read_to_string(workspace.path().join("file_0.R")).unwrap();
        assert!(content_0.contains("source(\"file_1.R\")"), "file_0 should source file_1");

        // file_1 should source file_2
        let content_1 = std::fs::read_to_string(workspace.path().join("file_1.R")).unwrap();
        assert!(content_1.contains("source(\"file_2.R\")"), "file_1 should source file_2");

        // file_2 should source file_3
        let content_2 = std::fs::read_to_string(workspace.path().join("file_2.R")).unwrap();
        assert!(content_2.contains("source(\"file_3.R\")"), "file_2 should source file_3");

        // file_3 should NOT source anything (depth = 3 means indices 0,1,2 source)
        let content_3 = std::fs::read_to_string(workspace.path().join("file_3.R")).unwrap();
        assert!(!content_3.contains("source("), "file_3 should not have source() calls");

        // file_4 should NOT source anything
        let content_4 = std::fs::read_to_string(workspace.path().join("file_4.R")).unwrap();
        assert!(!content_4.contains("source("), "file_4 should not have source() calls");
    }

    #[test]
    fn test_generated_files_parse_without_errors() {
        use crate::parser_pool::with_parser;

        let config = FixtureConfig::small();
        let workspace = create_fixture_workspace(&config);

        for i in 0..config.file_count {
            let filename = format!("file_{}.R", i);
            let content = std::fs::read_to_string(workspace.path().join(&filename)).unwrap();
            let tree = with_parser(|parser| parser.parse(&content, None))
                .unwrap_or_else(|| panic!("Failed to parse {}", filename));

            let root = tree.root_node();
            assert!(
                !root.has_error(),
                "File {} should parse without errors. Content:\n{}",
                filename,
                content
            );
        }
    }

    #[test]
    fn test_library_calls_present() {
        let config = FixtureConfig {
            file_count: 1,
            functions_per_file: 0,
            source_chain_depth: 0,
            library_calls_per_file: 3,
            extra_lines_per_file: 0,
        };
        let workspace = create_fixture_workspace(&config);
        let content = std::fs::read_to_string(workspace.path().join("file_0.R")).unwrap();

        let lib_count = content.lines().filter(|l| l.starts_with("library(")).count();
        assert_eq!(lib_count, 3, "Should have exactly 3 library() calls");
    }

    #[test]
    fn test_functions_present() {
        let config = FixtureConfig {
            file_count: 1,
            functions_per_file: 4,
            source_chain_depth: 0,
            library_calls_per_file: 0,
            extra_lines_per_file: 0,
        };
        let workspace = create_fixture_workspace(&config);
        let content = std::fs::read_to_string(workspace.path().join("file_0.R")).unwrap();

        let func_count = content.lines().filter(|l| l.contains("<- function(")).count();
        assert_eq!(func_count, 4, "Should have exactly 4 function definitions");
    }
}
