// Tests for workspace scanning functionality

#[cfg(test)]
mod workspace_scan_tests {
    use super::super::*;
    use std::path::Path;
    use std::fs;
    use tempfile::TempDir;
    use tower_lsp::lsp_types::Url;

    // Use default max_chain_depth for tests
    const TEST_MAX_CHAIN_DEPTH: usize = 20;

    #[test]
    fn test_scan_workspace_finds_uppercase_r_files() {
        let temp_dir = TempDir::new().unwrap();
        let test_file = temp_dir.path().join("test.R");
        fs::write(&test_file, "x <- 1").unwrap();

        let workspace_url = Url::from_file_path(temp_dir.path()).unwrap();
        let (index, _, cross_file_entries, new_index_entries, _, _, _) = scan_workspace(&[workspace_url], TEST_MAX_CHAIN_DEPTH);

        assert_eq!(index.len(), 1, "Should find 1 .R file");
        assert_eq!(cross_file_entries.len(), 1, "Should have 1 cross-file entry");
        assert_eq!(new_index_entries.len(), 1, "Should have 1 new index entry");
    }

    #[test]
    fn test_scan_workspace_finds_lowercase_r_files() {
        let temp_dir = TempDir::new().unwrap();
        let test_file = temp_dir.path().join("test.r");
        fs::write(&test_file, "x <- 1").unwrap();

        let workspace_url = Url::from_file_path(temp_dir.path()).unwrap();
        let (index, _, cross_file_entries, new_index_entries, _, _, _) = scan_workspace(&[workspace_url], TEST_MAX_CHAIN_DEPTH);

        assert_eq!(index.len(), 1, "Should find 1 .r file");
        assert_eq!(cross_file_entries.len(), 1, "Should have 1 cross-file entry");
        assert_eq!(new_index_entries.len(), 1, "Should have 1 new index entry");
    }

    #[test]
    fn test_scan_workspace_finds_mixed_case_r_files() {
        let temp_dir = TempDir::new().unwrap();
        
        // Create files with different case extensions
        fs::write(temp_dir.path().join("uppercase.R"), "x <- 1").unwrap();
        fs::write(temp_dir.path().join("lowercase.r"), "y <- 2").unwrap();
        
        let workspace_url = Url::from_file_path(temp_dir.path()).unwrap();
        let (index, _, cross_file_entries, new_index_entries, _, _, _) = scan_workspace(&[workspace_url], TEST_MAX_CHAIN_DEPTH);

        assert_eq!(index.len(), 2, "Should find both .R and .r files");
        assert_eq!(cross_file_entries.len(), 2, "Should have 2 cross-file entries");
        assert_eq!(new_index_entries.len(), 2, "Should have 2 new index entries");
        
        // Verify both files are indexed
        let uris: Vec<String> = index.keys().map(|u| u.to_string()).collect();
        assert!(uris.iter().any(|u| u.contains("uppercase.R")), "Should find uppercase.R");
        assert!(uris.iter().any(|u| u.contains("lowercase.r")), "Should find lowercase.r");
    }

    #[test]
    fn test_scan_workspace_computes_cross_file_metadata() {
        let temp_dir = TempDir::new().unwrap();
        
        // Create a file with a function definition
        let test_file = temp_dir.path().join("functions.r");
        fs::write(&test_file, "my_func <- function() { 42 }").unwrap();
        
        let workspace_url = Url::from_file_path(temp_dir.path()).unwrap();
        let (_, _, cross_file_entries, new_index_entries, _, _, _) = scan_workspace(&[workspace_url], TEST_MAX_CHAIN_DEPTH);

        assert_eq!(cross_file_entries.len(), 1);
        assert_eq!(new_index_entries.len(), 1);
        
        // Verify the entry has artifacts with exported symbols
        let entry = cross_file_entries.values().next().unwrap();
        assert!(entry.artifacts.exported_interface.contains_key("my_func"), 
            "Should export my_func symbol");
        
        // Verify new index entry also has the same artifacts
        let new_entry = new_index_entries.values().next().unwrap();
        assert!(new_entry.artifacts.exported_interface.contains_key("my_func"), 
            "New index entry should export my_func symbol");
    }

    #[test]
    fn test_scan_workspace_recursive() {
        let temp_dir = TempDir::new().unwrap();
        
        // Create nested directory structure
        let subdir = temp_dir.path().join("subdir");
        fs::create_dir(&subdir).unwrap();
        
        fs::write(temp_dir.path().join("root.r"), "x <- 1").unwrap();
        fs::write(subdir.join("nested.r"), "y <- 2").unwrap();
        
        let workspace_url = Url::from_file_path(temp_dir.path()).unwrap();
        let (index, _, _, new_index_entries, _, _, _) = scan_workspace(&[workspace_url], TEST_MAX_CHAIN_DEPTH);

        assert_eq!(index.len(), 2, "Should find files in root and subdirectory");
        assert_eq!(new_index_entries.len(), 2, "Should have 2 new index entries");
    }

    #[test]
    fn test_scan_workspace_new_index_entry_has_all_fields() {
        let temp_dir = TempDir::new().unwrap();
        
        // Create a file with library call and function definition
        let test_file = temp_dir.path().join("complete.r");
        fs::write(&test_file, r#"
library(dplyr)
my_func <- function(x) { x + 1 }
"#).unwrap();
        
        let workspace_url = Url::from_file_path(temp_dir.path()).unwrap();
        let (_, _, _, new_index_entries, _, _, _) = scan_workspace(&[workspace_url], TEST_MAX_CHAIN_DEPTH);

        assert_eq!(new_index_entries.len(), 1);
        
        let entry = new_index_entries.values().next().unwrap();
        
        // Verify all fields are populated
        assert!(!entry.contents.to_string().is_empty(), "Should have contents");
        assert!(entry.tree.is_some(), "Should have parsed tree");
        assert!(entry.loaded_packages.contains(&"dplyr".to_string()), "Should have loaded packages");
        assert!(entry.snapshot.size > 0, "Should have valid snapshot");
        assert!(entry.artifacts.exported_interface.contains_key("my_func"), 
            "Should have exported symbols in artifacts");
    }

    #[test]
    fn test_is_stat_model_extension_matches_supported_extensions_case_insensitively() {
        assert!(is_stat_model_extension(Path::new("script.R")));
        assert!(is_stat_model_extension(Path::new("script.r")));
        assert!(is_stat_model_extension(Path::new("model.JAGS")));
        assert!(is_stat_model_extension(Path::new("model.Bugs")));
        assert!(is_stat_model_extension(Path::new("model.STAN")));
        assert!(!is_stat_model_extension(Path::new("notes.txt")));
        assert!(!is_stat_model_extension(Path::new("README")));
    }
}


// ============================================================================
// JAGS/Stan Workspace Indexing Tests
// **Validates: Requirements 11.1** (Property 11)
// ============================================================================

#[cfg(test)]
mod jags_stan_indexing_tests {
    use super::super::*;
    use std::fs;
    use tempfile::TempDir;
    use tower_lsp::lsp_types::Url;

    const TEST_MAX_CHAIN_DEPTH: usize = 20;

    #[test]
    fn test_scan_workspace_includes_jags_stan_files() {
        // **Validates: Requirements 11.1**
        let temp_dir = TempDir::new().unwrap();
        let dir = temp_dir.path();

        // Create test files with various extensions
        fs::write(dir.join("model.jags"), "model { x ~ dnorm(0, 1) }").unwrap();
        fs::write(dir.join("model.bugs"), "model { y ~ dgamma(1, 1) }").unwrap();
        fs::write(dir.join("model.stan"), "data { int N; }").unwrap();
        fs::write(dir.join("script.R"), "x <- 1").unwrap();
        fs::write(dir.join("readme.txt"), "not indexed").unwrap();

        let workspace_url = Url::from_file_path(dir).unwrap();
        let (index, _, cross_file_entries, new_index_entries, _, _, _) =
            scan_workspace(&[workspace_url], TEST_MAX_CHAIN_DEPTH);

        // All R, JAGS, and Stan files should be indexed (4 total), .txt excluded
        assert_eq!(index.len(), 4, "Should index .jags, .bugs, .stan, and .R files");
        assert_eq!(cross_file_entries.len(), 4, "Should have 4 cross-file entries");
        assert_eq!(new_index_entries.len(), 4, "Should have 4 new index entries");

        // Verify specific files are indexed by checking URIs
        let uris: Vec<String> = index.keys().map(|u| u.to_string()).collect();
        assert!(uris.iter().any(|u| u.contains("model.jags")), "Should index .jags files");
        assert!(uris.iter().any(|u| u.contains("model.bugs")), "Should index .bugs files");
        assert!(uris.iter().any(|u| u.contains("model.stan")), "Should index .stan files");
        assert!(uris.iter().any(|u| u.contains("script.R")), "Should index .R files");
        assert!(!uris.iter().any(|u| u.contains("readme.txt")), "Should NOT index .txt files");
    }

    #[test]
    fn test_scan_workspace_jags_stan_case_insensitive() {
        // **Validates: Requirements 11.1**
        let temp_dir = TempDir::new().unwrap();
        let dir = temp_dir.path();

        fs::write(dir.join("upper.JAGS"), "model { x ~ dnorm(0, 1) }").unwrap();
        fs::write(dir.join("upper.BUGS"), "model { y ~ dgamma(1, 1) }").unwrap();
        fs::write(dir.join("upper.STAN"), "data { int N; }").unwrap();

        let workspace_url = Url::from_file_path(dir).unwrap();
        let (index, _, _, _, _, _, _) = scan_workspace(&[workspace_url], TEST_MAX_CHAIN_DEPTH);

        assert_eq!(index.len(), 3, "Should index uppercase JAGS/BUGS/STAN extensions");
    }
}

#[cfg(test)]
mod jags_stan_indexing_property_tests {
    use super::super::*;
    use proptest::prelude::*;
    use std::fs;
    use tempfile::TempDir;
    use tower_lsp::lsp_types::Url;

    const TEST_MAX_CHAIN_DEPTH: usize = 20;

    /// Generate a valid filename stem (alphanumeric, non-empty)
    fn filename_stem_strategy() -> impl Strategy<Value = String> {
        "[a-z][a-z0-9_]{0,10}".prop_map(|s| s)
    }

    /// Generate a JAGS/Stan extension
    fn jags_stan_extension_strategy() -> impl Strategy<Value = String> {
        prop_oneof![
            Just("jags".to_string()),
            Just("JAGS".to_string()),
            Just("bugs".to_string()),
            Just("BUGS".to_string()),
            Just("stan".to_string()),
            Just("STAN".to_string()),
            Just("Jags".to_string()),
            Just("Bugs".to_string()),
            Just("Stan".to_string()),
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]

        /// **Property 11: Workspace indexing includes JAGS/Stan files**
        ///
        /// For any file path with a `.jags`, `.bugs`, or `.stan` extension present
        /// in a workspace directory, after `scan_directory` completes, the workspace
        /// index shall contain an entry for that file's URI.
        ///
        /// **Validates: Requirements 11.1**
        #[test]
        fn prop_workspace_indexing_includes_jags_stan_files(
            stem in filename_stem_strategy(),
            ext in jags_stan_extension_strategy(),
        ) {
            let temp_dir = TempDir::new().unwrap();
            let dir = temp_dir.path();

            let filename = format!("{}.{}", stem, ext);
            let file_path = dir.join(&filename);
            fs::write(&file_path, "model { x ~ dnorm(0, 1) }").unwrap();

            let workspace_url = Url::from_file_path(dir).unwrap();
            let (index, _, _, new_index_entries, _, _, _) =
                scan_workspace(&[workspace_url], TEST_MAX_CHAIN_DEPTH);

            // The file must be present in the index
            prop_assert_eq!(
                index.len(), 1,
                "File '{}' should be indexed", filename
            );
            prop_assert_eq!(
                new_index_entries.len(), 1,
                "File '{}' should have a new index entry", filename
            );

            // Verify the indexed URI matches the exact file path
            let uri = index.keys().next().unwrap();
            let expected_uri = Url::from_file_path(&file_path).unwrap();
            prop_assert_eq!(
                uri, &expected_uri,
                "Indexed URI should match the exact file path"
            );
        }
    }
}


// ============================================================================
// Bug Condition Exploration Test — JAGS/Stan files have None tree
// **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8**
// ============================================================================

#[cfg(test)]
mod bug_condition_exploration {
    use super::super::*;
    use proptest::prelude::*;

    /// Map a JAGS/Stan extension string to its FileType.
    fn file_type_from_ext(ext: &str) -> FileType {
        match ext.to_ascii_lowercase().as_str() {
            "jags" | "bugs" => FileType::Jags,
            "stan" => FileType::Stan,
            _ => unreachable!("strategy only generates jags/bugs/stan extensions"),
        }
    }

    /// Generate a JAGS/Stan extension (reuses the same set as jags_stan_extension_strategy)
    fn jags_stan_extension_strategy() -> impl Strategy<Value = String> {
        prop_oneof![
            Just("jags".to_string()),
            Just("JAGS".to_string()),
            Just("bugs".to_string()),
            Just("BUGS".to_string()),
            Just("stan".to_string()),
            Just("STAN".to_string()),
            Just("Jags".to_string()),
            Just("Bugs".to_string()),
            Just("Stan".to_string()),
        ]
    }

    /// Generate arbitrary text content that could appear in a JAGS/Stan file
    fn content_strategy() -> impl Strategy<Value = String> {
        prop_oneof![
            Just("x <- 1".to_string()),
            Just("model { x ~ dnorm(0, 1) }".to_string()),
            Just("data { int N; }".to_string()),
            Just("alpha <- dnorm(mu, tau)".to_string()),
            Just("".to_string()),
            "[a-zA-Z0-9 _<>~(){};.,\n]{1,100}",
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(50))]

        /// **Property 1: Bug Condition — JAGS/Stan files have None tree**
        ///
        /// For any JAGS or Stan file type with arbitrary text content,
        /// `parse_document` should return `Some(Tree)` so that tree-dependent
        /// LSP features (find-references, go-to-definition, hover, document
        /// symbols) can operate on a best-effort basis.
        ///
        /// On UNFIXED code this test is EXPECTED TO FAIL because
        /// `parse_document` returns `None` for JAGS/Stan file types.
        ///
        /// **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8**
        #[test]
        fn bug_condition_jags_stan_tree_is_some(
            content in content_strategy(),
            ext in jags_stan_extension_strategy(),
        ) {
            let file_type = file_type_from_ext(&ext);
            let doc = Document::new_with_file_type(&content, None, file_type);
            prop_assert!(
                doc.tree.is_some(),
                "parse_document returned None for FileType::{:?} with content {:?} \
                 (extension '{}') — tree-dependent LSP features will not work",
                file_type, content, ext
            );
        }
    }
}


// ============================================================================
// Preservation Property Tests — R parsing, diagnostics suppression, completion filtering
// **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
// ============================================================================

#[cfg(test)]
mod preservation {
    use super::super::*;
    use proptest::prelude::*;

    /// Generate simple R code patterns that tree-sitter-r can parse.
    fn r_code_strategy() -> impl Strategy<Value = String> {
        prop_oneof![
            // Assignments
            "[a-z]{1,6}".prop_map(|name| format!("{} <- 1", name)),
            // Function calls
            "[a-z]{1,6}".prop_map(|name| format!("{}()", name)),
            // Function definitions
            "[a-z]{1,6}".prop_map(|name| format!("{} <- function(x) x + 1", name)),
            // Library calls
            "[a-z]{1,6}".prop_map(|pkg| format!("library({})", pkg)),
            // Simple expressions
            Just("1 + 2".to_string()),
            Just("x <- c(1, 2, 3)".to_string()),
            Just("if (TRUE) 1 else 2".to_string()),
            Just("for (i in 1:10) print(i)".to_string()),
            // Empty content (still valid)
            Just("".to_string()),
        ]
    }

    /// Generate a JAGS/Stan file type.
    fn jags_stan_file_type_strategy() -> impl Strategy<Value = FileType> {
        prop_oneof![Just(FileType::Jags), Just(FileType::Stan),]
    }

    /// Generate arbitrary content for JAGS/Stan files.
    fn jags_stan_content_strategy() -> impl Strategy<Value = String> {
        prop_oneof![
            Just("model { x ~ dnorm(0, 1) }".to_string()),
            Just("data { int N; }".to_string()),
            Just("x <- 1".to_string()),
            Just("".to_string()),
            "[a-zA-Z0-9 _<>~(){};.,]{1,80}",
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(50))]

        /// **Property 2a: R parsing preservation**
        ///
        /// For any R code string with `FileType::R`, `parse_document` returns
        /// `Some(Tree)` with a valid root node. This behavior must be preserved
        /// before and after the JAGS/Stan parse fix.
        ///
        /// **Validates: Requirements 3.1**
        #[test]
        fn prop_r_parsing_returns_tree(code in r_code_strategy()) {
            let doc = Document::new_with_file_type(&code, None, FileType::R);
            prop_assert!(
                doc.tree.is_some(),
                "parse_document returned None for FileType::R with code {:?}",
                code
            );
            let tree = doc.tree.as_ref().unwrap();
            let root = tree.root_node();
            // Root node should always be "program" for R parser
            prop_assert_eq!(
                root.kind(),
                "program",
                "Root node should be 'program' for R code {:?}",
                code
            );
        }

        /// **Property 2b: Diagnostics suppression — JAGS/Stan file types are non-R**
        ///
        /// Diagnostics suppression depends on `file_type != FileType::R` in
        /// `diagnostics_from_snapshot`. This test verifies that JAGS/Stan
        /// `Document` instances have the correct non-R file type, ensuring
        /// diagnostics suppression will work regardless of parse_document changes.
        ///
        /// **Validates: Requirements 3.2**
        #[test]
        fn prop_jags_stan_file_type_is_not_r(
            content in jags_stan_content_strategy(),
            file_type in jags_stan_file_type_strategy(),
        ) {
            let doc = Document::new_with_file_type(&content, None, file_type);
            prop_assert_ne!(
                doc.file_type,
                FileType::R,
                "JAGS/Stan document should not have FileType::R — \
                 diagnostics suppression depends on file_type != R"
            );
            // Verify the file type is preserved exactly
            prop_assert_eq!(
                doc.file_type,
                file_type,
                "Document file_type should match the file_type passed to new_with_file_type"
            );
        }

        /// **Property 2c: Completion filtering — file type preservation**
        ///
        /// Completion filtering depends on `doc.file_type` to route JAGS files
        /// to JAGS-specific completions and Stan files to Stan-specific completions.
        /// This test verifies that `Document::new_with_file_type` correctly
        /// preserves the file type for all variants.
        ///
        /// **Validates: Requirements 3.3, 3.4**
        #[test]
        fn prop_file_type_preserved_in_document(
            content in jags_stan_content_strategy(),
            file_type in jags_stan_file_type_strategy(),
        ) {
            let doc = Document::new_with_file_type(&content, None, file_type);
            prop_assert_eq!(
                doc.file_type,
                file_type,
                "Document should preserve file_type {:?} for completion filtering",
                file_type
            );
            // Verify JAGS stays JAGS and Stan stays Stan
            match file_type {
                FileType::Jags => prop_assert_eq!(doc.file_type, FileType::Jags),
                FileType::Stan => prop_assert_eq!(doc.file_type, FileType::Stan),
                FileType::R => unreachable!("strategy only generates Jags/Stan"),
            }
        }
    }
}

// ============================================================================
// Package mode: tests/testthat one-way visibility integration tests (Phase 6.2)
//
// These tests drive the full pipeline:
//   PackageInputs → WorldState::apply_package_event → scope_at_position_with_graph
// to confirm end-to-end that test files see R/ symbols (one-way visibility) and
// R/ files do NOT see test-only symbols.
// ============================================================================

#[cfg(test)]
mod package_testthat_visibility_tests {
    use super::super::*;
    use std::collections::HashSet;
    use std::path::PathBuf;
    use std::sync::Arc;
    use tower_lsp::lsp_types::Url;

    use crate::cross_file::dependency::DependencyGraph;
    use crate::cross_file::scope::{
        compute_artifacts, scope_at_position_with_graph, ScopeArtifacts,
    };
    use crate::cross_file::config::PackageMode;
    use crate::package_state::{
        ContentDigest, ContentOrigin, DescriptionInput, PackageInputDelta, RFileInput, RFileKind,
    };

    /// Parse R source into `ScopeArtifacts` using tree-sitter-r.
    fn make_artifacts(uri: &Url, code: &str) -> Arc<ScopeArtifacts> {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&tree_sitter_r::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code, None).unwrap();
        Arc::new(compute_artifacts(uri, &tree, code))
    }

    /// Resolve visible symbols at EOF in `uri` using the given contribution.
    fn resolve_symbols(
        uri: &Url,
        artifacts: Arc<ScopeArtifacts>,
        workspace_root: &Url,
        contribution: &crate::package_state::PackageScopeContribution,
    ) -> std::collections::HashMap<Arc<str>, crate::cross_file::scope::ScopedSymbol> {
        let get_artifacts = |u: &Url| -> Option<Arc<ScopeArtifacts>> {
            if u == uri { Some(artifacts.clone()) } else { None }
        };
        let get_metadata =
            |_u: &Url| -> Option<Arc<crate::cross_file::types::CrossFileMetadata>> { None };
        let graph = DependencyGraph::new();

        let scope = scope_at_position_with_graph(
            uri,
            u32::MAX,
            u32::MAX,
            &get_artifacts,
            &get_metadata,
            &graph,
            Some(workspace_root),
            10,
            &HashSet::new(),
            false,
            crate::cross_file::config::BackwardDependencyMode::Explicit,
            &|| false,
            Some(contribution),
        );
        scope.symbols
    }

    /// Build a `WorldState` pre-populated with DESCRIPTION + the given R files,
    /// then call `apply_package_event(Initial)` to drive full package-mode derivation.
    fn build_state_with_files(
        workspace_root_path: &str,
        r_files: Vec<(PathBuf, RFileKind, &str)>,
    ) -> WorldState {
        let mut state = WorldState::new(vec![]);
        state.package_inputs.workspace_root = Some(PathBuf::from(workspace_root_path));
        state.package_inputs.package_mode = PackageMode::Auto;
        state.package_inputs.description = Some(DescriptionInput {
            path: PathBuf::from(format!("{}/DESCRIPTION", workspace_root_path)),
            text: "Package: foo\n".into(),
        });
        for (path, kind, text) in r_files {
            let text: Arc<str> = Arc::from(text);
            let digest = ContentDigest::of(&text);
            state.package_inputs.r_files.insert(
                path,
                RFileInput { kind, origin: ContentOrigin::Disk, text, content_digest: digest },
            );
        }
        state.apply_package_event(&PackageInputDelta::Initial);
        state
    }

    // ------------------------------------------------------------------
    // Test A: test file sees R/ symbol (one-way: tests → R/)
    // ------------------------------------------------------------------

    /// End-to-end: a symbol defined in R/utils.R is visible when resolving
    /// scope inside tests/testthat/test-utils.R.
    #[test]
    fn test_file_sees_r_dir_symbol_end_to_end() {
        let root = "/work/pkg";
        let state = build_state_with_files(
            root,
            vec![
                (
                    PathBuf::from(format!("{}/R/utils.R", root)),
                    RFileKind::Source,
                    "helper <- function() 1\n",
                ),
                (
                    PathBuf::from(format!("{}/tests/testthat/test-utils.R", root)),
                    RFileKind::Test,
                    "result <- helper()\n",
                ),
            ],
        );

        // The derived contribution must carry `helper` from R/.
        assert!(
            state.package_state.scope_contribution.r_internal_symbols.contains("helper"),
            "helper must appear in r_internal_symbols for injection into test files"
        );

        let workspace_root = Url::parse("file:///work/pkg").unwrap();
        let test_uri = Url::parse("file:///work/pkg/tests/testthat/test-utils.R").unwrap();
        let test_arts = make_artifacts(&test_uri, "result <- helper()\n");

        let symbols = resolve_symbols(
            &test_uri,
            test_arts,
            &workspace_root,
            &state.package_state.scope_contribution,
        );

        assert!(
            symbols.contains_key("helper"),
            "helper must be visible in tests/testthat/ file after end-to-end package derivation. \
             visible: {:?}",
            symbols.keys().collect::<Vec<_>>()
        );
    }

    // ------------------------------------------------------------------
    // Test B: R/ file does NOT see test-only symbol (asymmetry enforced)
    // ------------------------------------------------------------------

    /// End-to-end: a symbol defined only in tests/testthat/ must NOT appear
    /// in scope when resolving inside R/main.R — confirming the asymmetry.
    #[test]
    fn r_file_does_not_see_test_only_symbol_end_to_end() {
        let root = "/work/pkg";
        let state = build_state_with_files(
            root,
            vec![
                (
                    PathBuf::from(format!("{}/R/main.R", root)),
                    RFileKind::Source,
                    "result <- test_helper()\n",
                ),
                (
                    PathBuf::from(format!("{}/tests/testthat/test-utils.R", root)),
                    RFileKind::Test,
                    "test_helper <- function() 99\n",
                ),
            ],
        );

        // The derived contribution must NOT carry `test_helper` (test symbols
        // are excluded from r_internal_symbols by build_scope_contribution).
        assert!(
            !state.package_state.scope_contribution.r_internal_symbols.contains("test_helper"),
            "test_helper must NOT appear in r_internal_symbols"
        );

        let workspace_root = Url::parse("file:///work/pkg").unwrap();
        let main_uri = Url::parse("file:///work/pkg/R/main.R").unwrap();
        let main_arts = make_artifacts(&main_uri, "result <- test_helper()\n");

        let symbols = resolve_symbols(
            &main_uri,
            main_arts,
            &workspace_root,
            &state.package_state.scope_contribution,
        );

        assert!(
            !symbols.contains_key("test_helper"),
            "test_helper must NOT be visible in R/main.R. \
             visible: {:?}",
            symbols.keys().collect::<Vec<_>>()
        );
    }
}

