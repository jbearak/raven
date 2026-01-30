//
// cross_file/property_tests.rs
//
// Property-based tests for cross-file awareness
//

#![cfg(test)]

use proptest::prelude::*;
use std::path::PathBuf;

use super::directive::parse_directives;
use super::path_resolve::{resolve_working_directory, PathContext};
use super::types::{CallSiteSpec, CrossFileMetadata};

// ============================================================================
// Generators for valid R file paths
// ============================================================================

/// Generate a valid R file path component (no special chars that break parsing)
fn path_component() -> impl Strategy<Value = String> {
    "[a-zA-Z][a-zA-Z0-9_]{0,10}"
}

/// Generate a valid relative R file path
fn relative_path() -> impl Strategy<Value = String> {
    prop::collection::vec(path_component(), 1..=3)
        .prop_map(|parts| format!("{}.R", parts.join("/")))
}

/// Generate a valid relative path with optional parent directory navigation
fn relative_path_with_parents() -> impl Strategy<Value = String> {
    (0..3usize, relative_path()).prop_map(|(parents, path)| {
        let prefix = "../".repeat(parents);
        format!("{}{}", prefix, path)
    })
}

// ============================================================================
// Property 1: Backward Directive Synonym Equivalence
// Validates: Requirements 1.1, 1.2, 1.3
// ============================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    /// Property 1: For any valid path string, parsing @lsp-sourced-by, @lsp-run-by,
    /// and @lsp-included-by SHALL produce equivalent BackwardDirective structures.
    #[test]
    fn prop_backward_directive_synonym_equivalence(path in relative_path_with_parents()) {
        let sourced_by = format!("# @lsp-sourced-by {}", path);
        let run_by = format!("# @lsp-run-by {}", path);
        let included_by = format!("# @lsp-included-by {}", path);

        let meta1 = parse_directives(&sourced_by);
        let meta2 = parse_directives(&run_by);
        let meta3 = parse_directives(&included_by);

        // All should produce exactly one backward directive
        prop_assert_eq!(meta1.sourced_by.len(), 1);
        prop_assert_eq!(meta2.sourced_by.len(), 1);
        prop_assert_eq!(meta3.sourced_by.len(), 1);

        // All should have the same path
        prop_assert_eq!(&meta1.sourced_by[0].path, &path);
        prop_assert_eq!(&meta2.sourced_by[0].path, &path);
        prop_assert_eq!(&meta3.sourced_by[0].path, &path);

        // All should have the same call site (Default)
        prop_assert_eq!(&meta1.sourced_by[0].call_site, &CallSiteSpec::Default);
        prop_assert_eq!(&meta2.sourced_by[0].call_site, &CallSiteSpec::Default);
        prop_assert_eq!(&meta3.sourced_by[0].call_site, &CallSiteSpec::Default);
    }

    /// Property 1 extended: Synonyms with colon should also be equivalent
    #[test]
    fn prop_backward_directive_synonym_with_colon(path in relative_path_with_parents()) {
        let sourced_by = format!("# @lsp-sourced-by: {}", path);
        let run_by = format!("# @lsp-run-by: {}", path);
        let included_by = format!("# @lsp-included-by: {}", path);

        let meta1 = parse_directives(&sourced_by);
        let meta2 = parse_directives(&run_by);
        let meta3 = parse_directives(&included_by);

        prop_assert_eq!(meta1.sourced_by.len(), 1);
        prop_assert_eq!(meta2.sourced_by.len(), 1);
        prop_assert_eq!(meta3.sourced_by.len(), 1);

        prop_assert_eq!(&meta1.sourced_by[0].path, &path);
        prop_assert_eq!(&meta2.sourced_by[0].path, &path);
        prop_assert_eq!(&meta3.sourced_by[0].path, &path);
    }

    /// Property 1 extended: Synonyms with quotes should also be equivalent
    #[test]
    fn prop_backward_directive_synonym_with_quotes(path in relative_path_with_parents()) {
        let sourced_by = format!("# @lsp-sourced-by \"{}\"", path);
        let run_by = format!("# @lsp-run-by \"{}\"", path);
        let included_by = format!("# @lsp-included-by \"{}\"", path);

        let meta1 = parse_directives(&sourced_by);
        let meta2 = parse_directives(&run_by);
        let meta3 = parse_directives(&included_by);

        prop_assert_eq!(meta1.sourced_by.len(), 1);
        prop_assert_eq!(meta2.sourced_by.len(), 1);
        prop_assert_eq!(meta3.sourced_by.len(), 1);

        prop_assert_eq!(&meta1.sourced_by[0].path, &path);
        prop_assert_eq!(&meta2.sourced_by[0].path, &path);
        prop_assert_eq!(&meta3.sourced_by[0].path, &path);
    }
}

// ============================================================================
// Property 2: Working Directory Synonym Equivalence
// Validates: Requirements 3.1-3.6
// ============================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    /// Property 2: For any valid path string, all working directory directive synonyms
    /// SHALL produce equivalent working directory configurations.
    #[test]
    fn prop_working_directory_synonym_equivalence(path in relative_path_with_parents()) {
        let synonyms = [
            "@lsp-working-directory",
            "@lsp-working-dir",
            "@lsp-current-directory",
            "@lsp-current-dir",
            "@lsp-cd",
            "@lsp-wd",
        ];

        let results: Vec<_> = synonyms
            .iter()
            .map(|syn| {
                let content = format!("# {} {}", syn, path);
                parse_directives(&content)
            })
            .collect();

        // All should produce the same working directory
        for (i, meta) in results.iter().enumerate() {
            prop_assert_eq!(
                meta.working_directory.as_ref(),
                Some(&path),
                "Synonym {} failed", synonyms[i]
            );
        }
    }

    /// Property 2 extended: Working directory synonyms with colon
    #[test]
    fn prop_working_directory_synonym_with_colon(path in relative_path_with_parents()) {
        let synonyms = [
            "@lsp-working-directory:",
            "@lsp-working-dir:",
            "@lsp-current-directory:",
            "@lsp-current-dir:",
            "@lsp-cd:",
            "@lsp-wd:",
        ];

        let results: Vec<_> = synonyms
            .iter()
            .map(|syn| {
                let content = format!("# {} {}", syn, path);
                parse_directives(&content)
            })
            .collect();

        for (i, meta) in results.iter().enumerate() {
            prop_assert_eq!(
                meta.working_directory.as_ref(),
                Some(&path),
                "Synonym {} failed", synonyms[i]
            );
        }
    }

    /// Property 2 extended: Working directory synonyms with quotes
    #[test]
    fn prop_working_directory_synonym_with_quotes(path in relative_path_with_parents()) {
        let synonyms = [
            "@lsp-working-directory",
            "@lsp-wd",
            "@lsp-cd",
        ];

        for syn in synonyms {
            let double_quoted = format!("# {} \"{}\"", syn, path);
            let single_quoted = format!("# {} '{}'", syn, path);

            let meta1 = parse_directives(&double_quoted);
            let meta2 = parse_directives(&single_quoted);

            prop_assert_eq!(meta1.working_directory.as_ref(), Some(&path));
            prop_assert_eq!(meta2.working_directory.as_ref(), Some(&path));
        }
    }
}

// ============================================================================
// Property 2a: Workspace-Root-Relative Path Resolution
// Validates: Requirements 3.9
// ============================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    /// Property 2a: Paths starting with / SHALL resolve relative to workspace root.
    #[test]
    fn prop_workspace_root_relative_path(subpath in relative_path()) {
        let workspace_root = PathBuf::from("/workspace");
        let file_path = PathBuf::from("/workspace/src/main.R");

        let ctx = PathContext {
            file_path,
            working_directory: None,
            inherited_working_directory: None,
            workspace_root: Some(workspace_root.clone()),
        };

        let path_str = format!("/{}", subpath);
        let resolved = resolve_working_directory(&path_str, &ctx);

        prop_assert!(resolved.is_some());
        let resolved = resolved.unwrap();

        // Should start with workspace root
        prop_assert!(resolved.starts_with(&workspace_root));

        // Should NOT be filesystem root
        prop_assert!(!resolved.starts_with("/") || resolved.starts_with(&workspace_root));
    }

    /// Property 2a extended: Workspace-root-relative without workspace returns None
    #[test]
    fn prop_workspace_root_relative_no_workspace(subpath in relative_path()) {
        let ctx = PathContext {
            file_path: PathBuf::from("/some/file.R"),
            working_directory: None,
            inherited_working_directory: None,
            workspace_root: None,
        };

        let path_str = format!("/{}", subpath);
        let resolved = resolve_working_directory(&path_str, &ctx);

        prop_assert!(resolved.is_none());
    }
}

// ============================================================================
// Property 2b: File-Relative Path Resolution
// Validates: Requirements 3.10
// ============================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    /// Property 2b: Paths not starting with / SHALL resolve relative to file's directory.
    #[test]
    fn prop_file_relative_path(subpath in relative_path()) {
        let file_path = PathBuf::from("/project/src/main.R");
        let file_dir = PathBuf::from("/project/src");

        let ctx = PathContext {
            file_path,
            working_directory: None,
            inherited_working_directory: None,
            workspace_root: Some(PathBuf::from("/project")),
        };

        let resolved = resolve_working_directory(&subpath, &ctx);

        prop_assert!(resolved.is_some());
        let resolved = resolved.unwrap();

        // Should start with file's directory
        prop_assert!(resolved.starts_with(&file_dir));
    }

    /// Property 2b extended: Parent directory navigation
    #[test]
    fn prop_file_relative_with_parent_nav(
        parents in 1..3usize,
        subpath in relative_path()
    ) {
        let file_path = PathBuf::from("/project/a/b/c/main.R");

        let ctx = PathContext {
            file_path,
            working_directory: None,
            inherited_working_directory: None,
            workspace_root: Some(PathBuf::from("/project")),
        };

        let prefix = "../".repeat(parents);
        let path_str = format!("{}{}", prefix, subpath);
        let resolved = resolve_working_directory(&path_str, &ctx);

        prop_assert!(resolved.is_some());
        let resolved = resolved.unwrap();

        // Should still be under /project (not escape workspace)
        prop_assert!(resolved.starts_with("/project"));
    }
}

// ============================================================================
// Property 8: Directive Serialization Round-Trip
// Validates: Requirements 14.1-14.4
// ============================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    /// Property 8: Parsing then serializing then parsing SHALL produce equivalent structures.
    #[test]
    fn prop_directive_round_trip(path in relative_path_with_parents()) {
        let content = format!("# @lsp-sourced-by {}", path);
        let meta1 = parse_directives(&content);

        // Serialize to JSON
        let json = serde_json::to_string(&meta1).unwrap();

        // Deserialize back
        let meta2: CrossFileMetadata = serde_json::from_str(&json).unwrap();

        // Should be equivalent
        prop_assert_eq!(meta1.sourced_by.len(), meta2.sourced_by.len());
        if !meta1.sourced_by.is_empty() {
            prop_assert_eq!(&meta1.sourced_by[0].path, &meta2.sourced_by[0].path);
            prop_assert_eq!(&meta1.sourced_by[0].call_site, &meta2.sourced_by[0].call_site);
        }
    }

    /// Property 8 extended: Round-trip with all directive types
    #[test]
    fn prop_full_metadata_round_trip(
        backward_path in relative_path_with_parents(),
        forward_path in relative_path(),
        wd_path in relative_path(),
    ) {
        let content = format!(
            "# @lsp-sourced-by {}\n# @lsp-source {}\n# @lsp-working-directory {}\n# @lsp-ignore\n# @lsp-ignore-next",
            backward_path, forward_path, wd_path
        );
        let meta1 = parse_directives(&content);

        let json = serde_json::to_string(&meta1).unwrap();
        let meta2: CrossFileMetadata = serde_json::from_str(&json).unwrap();

        prop_assert_eq!(meta1.sourced_by.len(), meta2.sourced_by.len());
        prop_assert_eq!(meta1.sources.len(), meta2.sources.len());
        prop_assert_eq!(meta1.working_directory, meta2.working_directory);
        prop_assert_eq!(meta1.ignored_lines, meta2.ignored_lines);
        prop_assert_eq!(meta1.ignored_next_lines, meta2.ignored_next_lines);
    }
}

// ============================================================================
// Property 9: Call Site Line Parameter Extraction
// Validates: Requirements 1.6
// ============================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    /// Property 9: For any backward directive with line=N, the parsed CallSiteSpec
    /// SHALL be Line(N-1) (converted to 0-based).
    #[test]
    fn prop_call_site_line_extraction(
        path in relative_path_with_parents(),
        line in 1..1000u32
    ) {
        let content = format!("# @lsp-sourced-by {} line={}", path, line);
        let meta = parse_directives(&content);

        prop_assert_eq!(meta.sourced_by.len(), 1);
        prop_assert_eq!(
            &meta.sourced_by[0].call_site,
            &CallSiteSpec::Line(line - 1) // 0-based
        );
    }

    /// Property 9 extended: Line=1 should become Line(0)
    #[test]
    fn prop_call_site_line_one_based_to_zero_based(path in relative_path_with_parents()) {
        let content = format!("# @lsp-sourced-by {} line=1", path);
        let meta = parse_directives(&content);

        prop_assert_eq!(meta.sourced_by.len(), 1);
        prop_assert_eq!(&meta.sourced_by[0].call_site, &CallSiteSpec::Line(0));
    }

    /// Property 9 extended: Line extraction with different directive synonyms
    #[test]
    fn prop_call_site_line_with_synonyms(
        path in relative_path_with_parents(),
        line in 1..100u32
    ) {
        let synonyms = ["@lsp-sourced-by", "@lsp-run-by", "@lsp-included-by"];

        for syn in synonyms {
            let content = format!("# {} {} line={}", syn, path, line);
            let meta = parse_directives(&content);

            prop_assert_eq!(meta.sourced_by.len(), 1);
            prop_assert_eq!(
                &meta.sourced_by[0].call_site,
                &CallSiteSpec::Line(line - 1)
            );
        }
    }
}

// ============================================================================
// Property 10: Call Site Match Parameter Extraction
// Validates: Requirements 1.7
// ============================================================================

/// Generate a valid match pattern (no quotes inside)
fn match_pattern() -> impl Strategy<Value = String> {
    "[a-zA-Z0-9_()., ]{1,20}"
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    /// Property 10: For any backward directive with match="pattern", the parsed
    /// CallSiteSpec SHALL be Match(pattern) with the exact pattern string.
    #[test]
    fn prop_call_site_match_extraction(
        path in relative_path_with_parents(),
        pattern in match_pattern()
    ) {
        let content = format!("# @lsp-sourced-by {} match=\"{}\"", path, pattern);
        let meta = parse_directives(&content);

        prop_assert_eq!(meta.sourced_by.len(), 1);
        prop_assert_eq!(
            &meta.sourced_by[0].call_site,
            &CallSiteSpec::Match(pattern)
        );
    }

    /// Property 10 extended: Match with single quotes
    #[test]
    fn prop_call_site_match_single_quotes(
        path in relative_path_with_parents(),
        pattern in match_pattern()
    ) {
        let content = format!("# @lsp-sourced-by {} match='{}'", path, pattern);
        let meta = parse_directives(&content);

        prop_assert_eq!(meta.sourced_by.len(), 1);
        prop_assert_eq!(
            &meta.sourced_by[0].call_site,
            &CallSiteSpec::Match(pattern)
        );
    }

    /// Property 10 extended: Match extraction with different directive synonyms
    #[test]
    fn prop_call_site_match_with_synonyms(
        path in relative_path_with_parents(),
        pattern in match_pattern()
    ) {
        let synonyms = ["@lsp-sourced-by", "@lsp-run-by", "@lsp-included-by"];

        for syn in synonyms {
            let content = format!("# {} {} match=\"{}\"", syn, path, pattern);
            let meta = parse_directives(&content);

            prop_assert_eq!(meta.sourced_by.len(), 1);
            prop_assert_eq!(
                &meta.sourced_by[0].call_site,
                &CallSiteSpec::Match(pattern.clone())
            );
        }
    }
}

// ============================================================================
// Property 3: Quote Style Equivalence for Source Detection
// Validates: Requirements 4.1, 4.2
// ============================================================================

use super::source_detect::detect_source_calls;
use tree_sitter::Parser;

fn parse_r(code: &str) -> tree_sitter::Tree {
    let mut parser = Parser::new();
    parser.set_language(&tree_sitter_r::LANGUAGE.into()).unwrap();
    parser.parse(code, None).unwrap()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    /// Property 3: For any valid path string p, detecting source("p") and source('p')
    /// SHALL produce equivalent SourceCall structures with the same path.
    #[test]
    fn prop_quote_style_equivalence(path in relative_path()) {
        let double_quoted = format!("source(\"{}\")", path);
        let single_quoted = format!("source('{}')", path);

        let tree1 = parse_r(&double_quoted);
        let tree2 = parse_r(&single_quoted);

        let sources1 = detect_source_calls(&tree1, &double_quoted);
        let sources2 = detect_source_calls(&tree2, &single_quoted);

        prop_assert_eq!(sources1.len(), 1);
        prop_assert_eq!(sources2.len(), 1);
        prop_assert_eq!(&sources1[0].path, &path);
        prop_assert_eq!(&sources2[0].path, &path);
        prop_assert_eq!(sources1[0].is_sys_source, sources2[0].is_sys_source);
        prop_assert_eq!(sources1[0].local, sources2[0].local);
        prop_assert_eq!(sources1[0].chdir, sources2[0].chdir);
    }
}

// ============================================================================
// Property 15: Named Argument Source Detection
// Validates: Requirements 4.3
// ============================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    /// Property 15: For any source() call using source(file = "path.R") syntax,
    /// the Source_Detector SHALL extract "path.R" as the path.
    #[test]
    fn prop_named_argument_source_detection(path in relative_path()) {
        let code = format!("source(file = \"{}\")", path);
        let tree = parse_r(&code);
        let sources = detect_source_calls(&tree, &code);

        prop_assert_eq!(sources.len(), 1);
        prop_assert_eq!(&sources[0].path, &path);
    }

    /// Property 15 extended: Named argument with other arguments
    #[test]
    fn prop_named_argument_with_other_args(path in relative_path()) {
        let code = format!("source(file = \"{}\", local = TRUE)", path);
        let tree = parse_r(&code);
        let sources = detect_source_calls(&tree, &code);

        prop_assert_eq!(sources.len(), 1);
        prop_assert_eq!(&sources[0].path, &path);
        prop_assert!(sources[0].local);
    }
}

// ============================================================================
// Property 16: sys.source Detection
// Validates: Requirements 4.4
// ============================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    /// Property 16: For any sys.source() call with a string literal path,
    /// the Source_Detector SHALL extract the path and mark is_sys_source as true.
    #[test]
    fn prop_sys_source_detection(path in relative_path()) {
        let code = format!("sys.source(\"{}\", envir = globalenv())", path);
        let tree = parse_r(&code);
        let sources = detect_source_calls(&tree, &code);

        prop_assert_eq!(sources.len(), 1);
        prop_assert_eq!(&sources[0].path, &path);
        prop_assert!(sources[0].is_sys_source);
    }

    /// Property 16 extended: sys.source with single quotes
    #[test]
    fn prop_sys_source_single_quotes(path in relative_path()) {
        let code = format!("sys.source('{}', envir = globalenv())", path);
        let tree = parse_r(&code);
        let sources = detect_source_calls(&tree, &code);

        prop_assert_eq!(sources.len(), 1);
        prop_assert_eq!(&sources[0].path, &path);
        prop_assert!(sources[0].is_sys_source);
    }
}

// ============================================================================
// Property 17: Dynamic Path Graceful Handling
// Validates: Requirements 4.5, 4.6
// ============================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    /// Property 17: For any source() call where the path argument is a variable,
    /// the Source_Detector SHALL not extract a path and SHALL not emit an error.
    #[test]
    fn prop_dynamic_path_variable_skipped(varname in "[a-zA-Z][a-zA-Z0-9_]{0,10}") {
        let code = format!("source({})", varname);
        let tree = parse_r(&code);
        let sources = detect_source_calls(&tree, &code);

        // Should skip, not error
        prop_assert_eq!(sources.len(), 0);
    }

    /// Property 17 extended: paste0() calls should be skipped
    #[test]
    fn prop_dynamic_path_paste0_skipped(
        prefix in "[a-zA-Z]{1,5}",
        varname in "[a-zA-Z][a-zA-Z0-9_]{0,5}"
    ) {
        let code = format!("source(paste0(\"{}/\", {}))", prefix, varname);
        let tree = parse_r(&code);
        let sources = detect_source_calls(&tree, &code);

        prop_assert_eq!(sources.len(), 0);
    }

    /// Property 17 extended: Expression paths should be skipped
    #[test]
    fn prop_dynamic_path_expression_skipped(
        base in "[a-zA-Z]{1,5}",
        suffix in "[a-zA-Z]{1,5}"
    ) {
        let code = format!("source(paste({}, \"{}\"))", base, suffix);
        let tree = parse_r(&code);
        let sources = detect_source_calls(&tree, &code);

        prop_assert_eq!(sources.len(), 0);
    }
}

// ============================================================================
// Property 18: Source Call Parameter Extraction
// Validates: Requirements 4.7, 4.8
// ============================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    /// Property 18: For any source() call with local = TRUE, the extracted
    /// SourceCall SHALL have local = true.
    #[test]
    fn prop_source_local_true_extraction(path in relative_path()) {
        let code = format!("source(\"{}\", local = TRUE)", path);
        let tree = parse_r(&code);
        let sources = detect_source_calls(&tree, &code);

        prop_assert_eq!(sources.len(), 1);
        prop_assert!(sources[0].local);
    }

    /// Property 18 extended: local = FALSE should have local = false
    #[test]
    fn prop_source_local_false_extraction(path in relative_path()) {
        let code = format!("source(\"{}\", local = FALSE)", path);
        let tree = parse_r(&code);
        let sources = detect_source_calls(&tree, &code);

        prop_assert_eq!(sources.len(), 1);
        prop_assert!(!sources[0].local);
    }

    /// Property 18: For any source() call with chdir = TRUE, the extracted
    /// SourceCall SHALL have chdir = true.
    #[test]
    fn prop_source_chdir_true_extraction(path in relative_path()) {
        let code = format!("source(\"{}\", chdir = TRUE)", path);
        let tree = parse_r(&code);
        let sources = detect_source_calls(&tree, &code);

        prop_assert_eq!(sources.len(), 1);
        prop_assert!(sources[0].chdir);
    }

    /// Property 18 extended: chdir = FALSE should have chdir = false
    #[test]
    fn prop_source_chdir_false_extraction(path in relative_path()) {
        let code = format!("source(\"{}\", chdir = FALSE)", path);
        let tree = parse_r(&code);
        let sources = detect_source_calls(&tree, &code);

        prop_assert_eq!(sources.len(), 1);
        prop_assert!(!sources[0].chdir);
    }

    /// Property 18 extended: Both local and chdir together
    #[test]
    fn prop_source_local_and_chdir_extraction(path in relative_path()) {
        let code = format!("source(\"{}\", local = TRUE, chdir = TRUE)", path);
        let tree = parse_r(&code);
        let sources = detect_source_calls(&tree, &code);

        prop_assert_eq!(sources.len(), 1);
        prop_assert!(sources[0].local);
        prop_assert!(sources[0].chdir);
    }
}

// ============================================================================
// Property 11: Relative Path Resolution
// Validates: Requirements 1.8, 1.9, 3.9
// ============================================================================

use super::path_resolve::resolve_path;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    /// Property 11: For any file at path /a/b/c.R and relative directive path ../d/e.R,
    /// the Path_Resolver SHALL resolve to /a/d/e.R.
    #[test]
    fn prop_relative_path_resolution(
        dir_a in path_component(),
        dir_b in path_component(),
        dir_c in path_component(),
        dir_d in path_component(),
        file_e in path_component()
    ) {
        let file_path = PathBuf::from(format!("/{}/{}/{}/main.R", dir_a, dir_b, dir_c));
        let workspace_root = PathBuf::from(format!("/{}", dir_a));

        let ctx = PathContext {
            file_path,
            working_directory: None,
            inherited_working_directory: None,
            workspace_root: Some(workspace_root),
        };

        let relative_path = format!("../{}/{}.R", dir_d, file_e);
        let resolved = resolve_path(&relative_path, &ctx);

        prop_assert!(resolved.is_some());
        let resolved = resolved.unwrap();

        // Should resolve to /dir_a/dir_b/dir_d/file_e.R
        let expected = PathBuf::from(format!("/{}/{}/{}/{}.R", dir_a, dir_b, dir_d, file_e));
        prop_assert_eq!(resolved, expected);
    }

    /// Property 11 extended: Multiple parent directory navigation
    #[test]
    fn prop_multiple_parent_navigation(
        dir_a in path_component(),
        dir_b in path_component(),
        dir_c in path_component(),
        file in path_component()
    ) {
        let file_path = PathBuf::from(format!("/{}/{}/{}/main.R", dir_a, dir_b, dir_c));
        let workspace_root = PathBuf::from(format!("/{}", dir_a));

        let ctx = PathContext {
            file_path,
            working_directory: None,
            inherited_working_directory: None,
            workspace_root: Some(workspace_root),
        };

        // Go up two levels
        let relative_path = format!("../../{}.R", file);
        let resolved = resolve_path(&relative_path, &ctx);

        prop_assert!(resolved.is_some());
        let resolved = resolved.unwrap();

        // Should resolve to /dir_a/file.R
        let expected = PathBuf::from(format!("/{}/{}.R", dir_a, file));
        prop_assert_eq!(resolved, expected);
    }
}

// ============================================================================
// Property 13: Working Directory Inheritance
// Validates: Requirements 3.11
// ============================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    /// Property 13: For any source chain A → B → C where only A has a working directory
    /// directive, files B and C SHALL inherit A's working directory for path resolution.
    #[test]
    fn prop_working_directory_inheritance(
        workspace in path_component(),
        wd_dir in path_component(),
        file_b in path_component(),
        file_c in path_component()
    ) {
        let workspace_root = PathBuf::from(format!("/{}", workspace));
        let working_dir = PathBuf::from(format!("/{}/{}", workspace, wd_dir));

        // File A has explicit working directory
        let ctx_a = PathContext {
            file_path: PathBuf::from(format!("/{}/src/a.R", workspace)),
            working_directory: Some(working_dir.clone()),
            inherited_working_directory: None,
            workspace_root: Some(workspace_root.clone()),
        };

        // File B inherits from A (via child_context)
        let ctx_b = ctx_a.child_context(&PathBuf::from(format!("/{}/src/{}.R", workspace, file_b)));

        // File C inherits from B (which inherited from A)
        let ctx_c = ctx_b.child_context(&PathBuf::from(format!("/{}/src/{}.R", workspace, file_c)));

        // All should have the same effective working directory
        prop_assert_eq!(ctx_a.effective_working_directory(), working_dir.clone());
        prop_assert_eq!(ctx_b.effective_working_directory(), working_dir.clone());
        prop_assert_eq!(ctx_c.effective_working_directory(), working_dir);
    }

    /// Property 13 extended: chdir=TRUE breaks inheritance
    #[test]
    fn prop_chdir_breaks_inheritance(
        workspace in path_component(),
        wd_dir in path_component(),
        child_dir in path_component()
    ) {
        let workspace_root = PathBuf::from(format!("/{}", workspace));
        let working_dir = PathBuf::from(format!("/{}/{}", workspace, wd_dir));
        let child_path = PathBuf::from(format!("/{}/{}/child.R", workspace, child_dir));

        // Parent has explicit working directory
        let ctx_parent = PathContext {
            file_path: PathBuf::from(format!("/{}/src/parent.R", workspace)),
            working_directory: Some(working_dir.clone()),
            inherited_working_directory: None,
            workspace_root: Some(workspace_root.clone()),
        };

        // Child with chdir=TRUE gets its own directory as working directory
        let ctx_child = ctx_parent.child_context_with_chdir(&child_path);

        // Child's effective working directory should be its own directory, not parent's
        let expected_child_wd = PathBuf::from(format!("/{}/{}", workspace, child_dir));
        prop_assert_eq!(ctx_child.effective_working_directory(), expected_child_wd);
    }
}

// ============================================================================
// Property 14: Default Working Directory
// Validates: Requirements 3.12
// ============================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    /// Property 14: For any file at path /a/b/c.R with no working directory directive
    /// and no inherited working directory, the effective working directory SHALL be /a/b/.
    #[test]
    fn prop_default_working_directory(
        dir_a in path_component(),
        dir_b in path_component(),
        file in path_component()
    ) {
        let file_path = PathBuf::from(format!("/{}/{}/{}.R", dir_a, dir_b, file));

        let ctx = PathContext {
            file_path,
            working_directory: None,
            inherited_working_directory: None,
            workspace_root: Some(PathBuf::from(format!("/{}", dir_a))),
        };

        let expected = PathBuf::from(format!("/{}/{}", dir_a, dir_b));
        prop_assert_eq!(ctx.effective_working_directory(), expected);
    }

    /// Property 14 extended: Explicit working directory takes precedence
    #[test]
    fn prop_explicit_wd_takes_precedence(
        dir_a in path_component(),
        dir_b in path_component(),
        explicit_wd in path_component()
    ) {
        let file_path = PathBuf::from(format!("/{}/{}/main.R", dir_a, dir_b));
        let explicit_working_dir = PathBuf::from(format!("/{}/{}", dir_a, explicit_wd));

        let ctx = PathContext {
            file_path,
            working_directory: Some(explicit_working_dir.clone()),
            inherited_working_directory: Some(PathBuf::from(format!("/{}/inherited", dir_a))),
            workspace_root: Some(PathBuf::from(format!("/{}", dir_a))),
        };

        // Explicit should take precedence over inherited
        prop_assert_eq!(ctx.effective_working_directory(), explicit_working_dir);
    }

    /// Property 14 extended: Inherited takes precedence over default
    #[test]
    fn prop_inherited_wd_takes_precedence(
        dir_a in path_component(),
        dir_b in path_component(),
        inherited_wd in path_component()
    ) {
        let file_path = PathBuf::from(format!("/{}/{}/main.R", dir_a, dir_b));
        let inherited_working_dir = PathBuf::from(format!("/{}/{}", dir_a, inherited_wd));

        let ctx = PathContext {
            file_path,
            working_directory: None,
            inherited_working_directory: Some(inherited_working_dir.clone()),
            workspace_root: Some(PathBuf::from(format!("/{}", dir_a))),
        };

        // Inherited should take precedence over default (file's directory)
        prop_assert_eq!(ctx.effective_working_directory(), inherited_working_dir);
    }
}
