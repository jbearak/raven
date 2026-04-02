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
        let (index, _, cross_file_entries, new_index_entries) = scan_workspace(&[workspace_url], TEST_MAX_CHAIN_DEPTH);

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
        let (index, _, cross_file_entries, new_index_entries) = scan_workspace(&[workspace_url], TEST_MAX_CHAIN_DEPTH);

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
        let (index, _, cross_file_entries, new_index_entries) = scan_workspace(&[workspace_url], TEST_MAX_CHAIN_DEPTH);

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
        let (_, _, cross_file_entries, new_index_entries) = scan_workspace(&[workspace_url], TEST_MAX_CHAIN_DEPTH);

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
        let (index, _, _, new_index_entries) = scan_workspace(&[workspace_url], TEST_MAX_CHAIN_DEPTH);

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
        let (_, _, _, new_index_entries) = scan_workspace(&[workspace_url], TEST_MAX_CHAIN_DEPTH);

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
        let (index, _, cross_file_entries, new_index_entries) =
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
        let (index, _, _, _) = scan_workspace(&[workspace_url], TEST_MAX_CHAIN_DEPTH);

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
            let (index, _, _, new_index_entries) =
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
