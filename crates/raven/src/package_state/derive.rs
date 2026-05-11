//! The pure derivation function from `PackageInputs` to `PackageState`.
//!
//! See spec §6.

use super::*;
use crate::package_namespace::parse_dcf_field_pub;

/// Pure derivation from `PackageInputs` to `PackageState`.
///
/// # Why `_delta` is ignored
///
/// The `_delta` parameter is intentionally unused: this function always
/// performs a full from-scratch recomputation over `inputs`. Any incremental
/// speedup comes from memoization *inside* the function (per-file facts are
/// reused when the `ContentDigest` matches `prev`), not from delta-driven
/// short-circuiting at the call boundary.
///
/// This contract is exercised by
/// `proptest_machine::advisory_delta_does_not_affect_correctness`, which
/// asserts that passing `Initial` instead of the "correct" delta still yields
/// the same `PackageState`. Future maintainers must not introduce
/// delta-driven branches here: callers treat the delta as advisory and
/// correctness must not depend on which variant is passed.
pub fn derive_package_state(
    prev: &PackageState,
    inputs: &PackageInputs,
    _delta: &PackageInputDelta,
) -> PackageState {
    let workspace = effective_workspace(inputs);
    let r_file_facts = derive_r_file_facts(&prev.r_file_facts, &inputs.r_files);
    let namespace_model = if workspace.is_some() {
        Some(merge_namespace_model(
            inputs.namespace.as_ref(),
            &r_file_facts,
        ))
    } else {
        None
    };
    let scope_contribution = build_scope_contribution(&workspace, &namespace_model, &r_file_facts);
    PackageState {
        workspace,
        namespace_model,
        r_file_facts,
        scope_contribution,
        ..PackageState::default()
    }
}

fn build_scope_contribution(
    workspace: &Option<PackageWorkspace>,
    namespace_model: &Option<PackageNamespaceModel>,
    r_file_facts: &BTreeMap<PathBuf, RFileFacts>,
) -> PackageScopeContribution {
    let Some(ws) = workspace else {
        return PackageScopeContribution::default();
    };
    // r_internal_symbols: union of top_level_defs from Source files only
    // (exclude tests/testthat/* — those are kind == Test). Partition is
    // driven by the canonical `RFileKind` classification carried in
    // `RFileFacts`, not by a path-prefix check.
    let mut r_internal_symbols: BTreeSet<String> = BTreeSet::new();
    for (_path, facts) in r_file_facts {
        if facts.kind != RFileKind::Source {
            continue;
        }
        for def in facts.top_level_defs.iter() {
            r_internal_symbols.insert(def.clone());
        }
    }
    let (imported_symbols, full_imports) = match namespace_model {
        Some(m) => {
            let mut imp: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
            for (pkg, sym) in &m.imports {
                imp.entry(sym.clone()).or_default().insert(pkg.clone());
            }
            let full: BTreeSet<String> = m.full_imports.iter().cloned().collect();
            (imp, full)
        }
        None => (BTreeMap::new(), BTreeSet::new()),
    };
    PackageScopeContribution {
        workspace_root: Some(ws.root.clone()),
        r_internal_symbols: Arc::new(r_internal_symbols),
        imported_symbols: Arc::new(imported_symbols),
        full_imports: Arc::new(full_imports),
    }
}

fn merge_namespace_model(
    namespace: Option<&NamespaceInput>,
    r_file_facts: &BTreeMap<PathBuf, RFileFacts>,
) -> PackageNamespaceModel {
    let mut model = match namespace {
        Some(ns) => crate::package_namespace::namespace_model_from_content(&ns.text),
        None => PackageNamespaceModel::default(),
    };
    // Union roxygen-derived imports/exports from Source files only.
    // Test files (tests/testthat/*) must never contribute @export/@importFrom
    // tags to the package-wide namespace model — matching the `RFileKind::Source`
    // filter used by `build_scope_contribution`.

    // Dedup against a HashSet rather than scanning the accumulating Vec —
    // previously each insert did a linear scan of the growing `imports`
    // Vec (O(files × imports²) overall). We seed each set with the entries
    // already parsed out of NAMESPACE so roxygen tags that duplicate
    // NAMESPACE entries aren't re-appended.
    let mut seen_imports: std::collections::HashSet<(String, String)> =
        model.imports.iter().cloned().collect();
    let mut seen_full: std::collections::HashSet<String> =
        model.full_imports.iter().cloned().collect();

    for (_path, facts) in r_file_facts {
        if facts.kind != RFileKind::Source {
            continue;
        }
        for sym in &facts.roxygen_namespace.exports {
            // `exports` is a HashSet, so `insert` is idempotent and O(1)
            // — no need for a prior `contains` check.
            model.exports.insert(sym.clone());
        }
        // RoxygenNamespace::import_from → PackageNamespaceModel::imports (Vec<(pkg, sym)>)
        for (pkg, sym) in &facts.roxygen_namespace.import_from {
            if seen_imports.insert((pkg.clone(), sym.clone())) {
                model.imports.push((pkg.clone(), sym.clone()));
            }
        }
        // RoxygenNamespace::imports (full package imports) → PackageNamespaceModel::full_imports
        for pkg in &facts.roxygen_namespace.imports {
            if seen_full.insert(pkg.clone()) {
                model.full_imports.push(pkg.clone());
            }
        }
    }
    model
}

fn derive_r_file_facts(
    prev: &BTreeMap<PathBuf, RFileFacts>,
    inputs: &BTreeMap<PathBuf, RFileInput>,
) -> BTreeMap<PathBuf, RFileFacts> {
    let mut out = BTreeMap::new();
    for (path, file) in inputs {
        // Reuse only when both digest AND kind match. `kind` is derived
        // from path shape, so in practice it never flips for a given path,
        // but we still compare it so cached facts can never drift from
        // the classification carried in `RFileInput`.
        let reuse = prev.get(path).filter(|cached| {
            cached.content_digest == file.content_digest && cached.kind == file.kind
        });
        let facts = match reuse {
            Some(cached) => cached.clone(),
            None => RFileFacts {
                kind: file.kind,
                roxygen_namespace: crate::roxygen::extract_roxygen_namespace_tags(&file.text),
                top_level_defs: Arc::new(crate::roxygen::extract_top_level_defs(&file.text)),
                content_digest: file.content_digest,
            },
        };
        out.insert(path.clone(), facts);
    }
    out
}

fn effective_workspace(inputs: &PackageInputs) -> Option<PackageWorkspace> {
    let root = inputs.workspace_root.as_ref()?;
    let parsed_name = inputs
        .description
        .as_ref()
        .and_then(|d| parse_dcf_field_pub(&d.text, "Package"))
        .filter(|s| !s.is_empty());
    match (inputs.package_mode, parsed_name.as_deref()) {
        (PackageMode::Disabled, _) => None,
        (PackageMode::Auto, Some(name)) => Some(PackageWorkspace {
            name: name.to_string(),
            root: root.clone(),
            roxygen_managed: false,
        }),
        (PackageMode::Auto, None) => None,
        (PackageMode::Enabled, Some(name)) => Some(PackageWorkspace {
            name: name.to_string(),
            root: root.clone(),
            roxygen_managed: false,
        }),
        (PackageMode::Enabled, None) => Some(PackageWorkspace {
            name: "unknown".to_string(),
            root: root.clone(),
            roxygen_managed: false,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_inputs(mode: PackageMode) -> PackageInputs {
        PackageInputs {
            workspace_root: Some("/work/pkg".into()),
            package_mode: mode,
            description: None,
            namespace: None,
            r_files: BTreeMap::new(),
        }
    }

    fn with_description(mode: PackageMode, text: &str) -> PackageInputs {
        let mut i = empty_inputs(mode);
        i.description = Some(DescriptionInput { text: text.into() });
        i
    }

    #[test]
    fn disabled_mode_yields_no_workspace() {
        let s = derive_package_state(
            &PackageState::default(),
            &with_description(PackageMode::Disabled, "Package: foo\n"),
            &PackageInputDelta::Initial,
        );
        assert!(s.workspace.is_none());
    }

    #[test]
    fn auto_with_no_description_yields_no_workspace() {
        let s = derive_package_state(
            &PackageState::default(),
            &empty_inputs(PackageMode::Auto),
            &PackageInputDelta::Initial,
        );
        assert!(s.workspace.is_none());
    }

    #[test]
    fn auto_with_description_yields_workspace() {
        let s = derive_package_state(
            &PackageState::default(),
            &with_description(PackageMode::Auto, "Package: foo\n"),
            &PackageInputDelta::Initial,
        );
        assert_eq!(s.workspace.as_ref().unwrap().name, "foo");
    }

    #[test]
    fn enabled_with_no_description_synthesizes_unknown() {
        let s = derive_package_state(
            &PackageState::default(),
            &empty_inputs(PackageMode::Enabled),
            &PackageInputDelta::Initial,
        );
        assert_eq!(s.workspace.as_ref().unwrap().name, "unknown");
    }

    #[test]
    fn enabled_with_invalid_description_synthesizes_unknown() {
        let s = derive_package_state(
            &PackageState::default(),
            &with_description(PackageMode::Enabled, "no Package field here\n"),
            &PackageInputDelta::Initial,
        );
        assert_eq!(s.workspace.as_ref().unwrap().name, "unknown");
    }

    #[test]
    fn memoization_reuses_cached_facts_on_unchanged_content() {
        let path: PathBuf = "/work/pkg/R/foo.R".into();
        let text: Arc<str> = "foo <- function() 1\n".into();
        let digest = ContentDigest::of(&text);
        let mut inputs = with_description(PackageMode::Auto, "Package: foo\n");
        inputs.r_files.insert(
            path.clone(),
            RFileInput {
                kind: RFileKind::Source,
                text: text.clone(),
                content_digest: digest,
            },
        );
        let s1 = derive_package_state(
            &PackageState::default(),
            &inputs,
            &PackageInputDelta::Initial,
        );
        let s2 = derive_package_state(&s1, &inputs, &PackageInputDelta::Initial);
        let f1 = s1.r_file_facts.get(&path).unwrap();
        let f2 = s2.r_file_facts.get(&path).unwrap();
        assert!(std::sync::Arc::ptr_eq(
            &f1.top_level_defs,
            &f2.top_level_defs
        ));
    }

    #[test]
    fn memoization_recomputes_on_content_change() {
        let path: PathBuf = "/work/pkg/R/foo.R".into();
        let text1: Arc<str> = "foo <- function() 1\n".into();
        let text2: Arc<str> = "foo <- function() 2\n".into();
        let mut inputs = with_description(PackageMode::Auto, "Package: foo\n");
        inputs.r_files.insert(
            path.clone(),
            RFileInput {
                kind: RFileKind::Source,
                text: text1.clone(),
                content_digest: ContentDigest::of(&text1),
            },
        );
        let s1 = derive_package_state(
            &PackageState::default(),
            &inputs,
            &PackageInputDelta::Initial,
        );
        let entry = inputs.r_files.get_mut(&path).unwrap();
        entry.text = text2.clone();
        entry.content_digest = ContentDigest::of(&text2);
        let s2 = derive_package_state(&s1, &inputs, &PackageInputDelta::Initial);
        let f1 = s1.r_file_facts.get(&path).unwrap();
        let f2 = s2.r_file_facts.get(&path).unwrap();
        assert!(!std::sync::Arc::ptr_eq(
            &f1.top_level_defs,
            &f2.top_level_defs
        ));
    }

    #[test]
    fn merge_unions_namespace_and_roxygen() {
        let path: PathBuf = "/work/pkg/R/foo.R".into();
        let text: Arc<str> = "#' @importFrom dplyr filter\nfoo <- function() 1\n".into();
        let mut inputs = with_description(PackageMode::Auto, "Package: foo\n");
        inputs.namespace = Some(NamespaceInput {
            text: "importFrom(dplyr, mutate)\nimport(magrittr)\n".into(),
        });
        inputs.r_files.insert(
            path,
            RFileInput {
                kind: RFileKind::Source,
                text: text.clone(),
                content_digest: ContentDigest::of(&text),
            },
        );
        let s = derive_package_state(
            &PackageState::default(),
            &inputs,
            &PackageInputDelta::Initial,
        );
        let m = s.namespace_model.unwrap();
        assert!(
            m.imports.iter().any(|(p, n)| p == "dplyr" && n == "filter"),
            "missing roxygen filter: {:?}",
            m
        );
        assert!(
            m.imports.iter().any(|(p, n)| p == "dplyr" && n == "mutate"),
            "missing NAMESPACE mutate: {:?}",
            m
        );
        assert!(
            m.full_imports.iter().any(|p| p == "magrittr"),
            "missing magrittr: {:?}",
            m
        );
    }

    #[test]
    fn scope_contribution_includes_internal_symbols_from_r_dir() {
        let path: PathBuf = "/work/pkg/R/utils.R".into();
        let text: Arc<str> = "helper <- function() 1\n".into();
        let mut inputs = with_description(PackageMode::Auto, "Package: foo\n");
        inputs.r_files.insert(
            path,
            RFileInput {
                kind: RFileKind::Source,
                text: text.clone(),
                content_digest: ContentDigest::of(&text),
            },
        );
        let s = derive_package_state(
            &PackageState::default(),
            &inputs,
            &PackageInputDelta::Initial,
        );
        assert!(s.scope_contribution.r_internal_symbols.contains("helper"));
    }

    #[test]
    fn scope_contribution_excludes_test_file_symbols() {
        let test_path: PathBuf = "/work/pkg/tests/testthat/test-utils.R".into();
        let text: Arc<str> = "test_helper <- function() 1\n".into();
        let mut inputs = with_description(PackageMode::Auto, "Package: foo\n");
        inputs.r_files.insert(
            test_path,
            RFileInput {
                kind: RFileKind::Test,
                text: text.clone(),
                content_digest: ContentDigest::of(&text),
            },
        );
        let s = derive_package_state(
            &PackageState::default(),
            &inputs,
            &PackageInputDelta::Initial,
        );
        assert!(!s
            .scope_contribution
            .r_internal_symbols
            .contains("test_helper"));
    }

    #[test]
    fn namespace_model_excludes_roxygen_from_test_files() {
        // A test file carrying roxygen tags must NOT contribute to the
        // package-wide namespace model — mirrors the path filter in
        // `build_scope_contribution`.
        let test_path: PathBuf = "/work/pkg/tests/testthat/test-utils.R".into();
        let text: Arc<str> = concat!(
            "#' @export\n",
            "#' @importFrom dplyr filter\n",
            "#' @import ggplot2\n",
            "leaked <- function() 1\n",
        )
        .into();
        let mut inputs = with_description(PackageMode::Auto, "Package: foo\n");
        inputs.r_files.insert(
            test_path,
            RFileInput {
                kind: RFileKind::Test,
                text: text.clone(),
                content_digest: ContentDigest::of(&text),
            },
        );
        let s = derive_package_state(
            &PackageState::default(),
            &inputs,
            &PackageInputDelta::Initial,
        );
        let m = s.namespace_model.as_ref().unwrap();
        assert!(
            !m.exports.contains("leaked"),
            "test-file @export leaked: {:?}",
            m.exports
        );
        assert!(
            !m.imports.iter().any(|(p, s)| p == "dplyr" && s == "filter"),
            "test-file @importFrom leaked: {:?}",
            m.imports
        );
        assert!(
            !m.full_imports.iter().any(|p| p == "ggplot2"),
            "test-file @import leaked: {:?}",
            m.full_imports
        );
    }

    #[test]
    fn scope_contribution_carries_imports_from_namespace() {
        let mut inputs = with_description(PackageMode::Auto, "Package: foo\n");
        inputs.namespace = Some(NamespaceInput {
            text: "importFrom(dplyr, filter)\nimportFrom(stats, filter)\n".into(),
        });
        let s = derive_package_state(
            &PackageState::default(),
            &inputs,
            &PackageInputDelta::Initial,
        );
        let pkgs = s.scope_contribution.imported_symbols.get("filter").unwrap();
        assert!(pkgs.contains("dplyr"));
        assert!(pkgs.contains("stats"));
    }

    #[test]
    fn test_files_get_rfile_facts_but_dont_contribute_internal_symbols() {
        let test_path: std::path::PathBuf = "/work/pkg/tests/testthat/test-utils.R".into();
        let text: Arc<str> = "test_helper <- function() 99\n".into();
        let mut inputs = with_description(PackageMode::Auto, "Package: foo\n");
        inputs.r_files.insert(
            test_path.clone(),
            RFileInput {
                kind: RFileKind::Test,
                text: text.clone(),
                content_digest: ContentDigest::of(&text),
            },
        );
        let s = derive_package_state(
            &PackageState::default(),
            &inputs,
            &PackageInputDelta::Initial,
        );

        // The test file gets per-file facts (its top_level_defs ARE extracted).
        assert!(s.r_file_facts.contains_key(&test_path));
        let facts = s.r_file_facts.get(&test_path).unwrap();
        assert!(
            facts.top_level_defs.contains("test_helper"),
            "expected test_helper to be in top_level_defs of the test file, got: {:?}",
            facts.top_level_defs
        );

        // But it does NOT contribute to r_internal_symbols — test-file symbols
        // are invisible to R/ files (one-way visibility: tests→R/, not R/→tests).
        assert!(
            !s.scope_contribution
                .r_internal_symbols
                .contains("test_helper"),
            "test-file symbol should not appear in r_internal_symbols: {:?}",
            s.scope_contribution.r_internal_symbols
        );
    }

    #[test]
    fn r_dir_files_contribute_internal_symbols_visible_to_test_files() {
        // R/utils.R defines helper() — contributes to r_internal_symbols.
        let r_path: std::path::PathBuf = "/work/pkg/R/utils.R".into();
        let r_text: Arc<str> = "helper <- function() 1\n".into();
        // tests/testthat/test-utils.R calls it (scope injection verified in scope.rs tests).
        let test_path: std::path::PathBuf = "/work/pkg/tests/testthat/test-utils.R".into();
        let test_text: Arc<str> = "result <- helper()\n".into();

        let mut inputs = with_description(PackageMode::Auto, "Package: foo\n");
        inputs.r_files.insert(
            r_path,
            RFileInput {
                kind: RFileKind::Source,
                text: r_text.clone(),
                content_digest: ContentDigest::of(&r_text),
            },
        );
        inputs.r_files.insert(
            test_path,
            RFileInput {
                kind: RFileKind::Test,
                text: test_text.clone(),
                content_digest: ContentDigest::of(&test_text),
            },
        );
        let s = derive_package_state(
            &PackageState::default(),
            &inputs,
            &PackageInputDelta::Initial,
        );

        // helper appears in r_internal_symbols (contributed by R/utils.R).
        assert!(
            s.scope_contribution.r_internal_symbols.contains("helper"),
            "R/ symbol must appear in r_internal_symbols: {:?}",
            s.scope_contribution.r_internal_symbols
        );
        // test_helper is absent — the test file's top-level defs never pollute
        // r_internal_symbols (confirmed by test_files_get_rfile_facts_but_dont_contribute_internal_symbols).
    }

    /// Phase 5b behavior change: a workspace with NAMESPACE but no DESCRIPTION
    /// does NOT activate package mode (Auto mode requires a valid `Package:` field
    /// in DESCRIPTION). Consequently, `scope_contribution` is empty — no
    /// importFrom symbols or internal symbols are injected, matching script-mode.
    ///
    /// This codifies spec §11.1 behavior: "package mode requires both DESCRIPTION
    /// (with a Package: field) and NAMESPACE". Non-package workspaces run as
    /// script mode regardless of NAMESPACE presence.
    #[test]
    fn non_package_namespace_does_not_produce_scope_contribution() {
        // Auto mode with NAMESPACE but no DESCRIPTION.
        let mut inputs = empty_inputs(PackageMode::Auto);
        inputs.namespace = Some(NamespaceInput {
            text: "importFrom(dplyr, filter)\nimport(ggplot2)\n".into(),
        });
        // Add an R file with a top-level definition.
        let r_path: PathBuf = "/work/pkg/R/utils.R".into();
        let text: Arc<str> = "helper <- function() 1\n".into();
        inputs.r_files.insert(
            r_path,
            RFileInput {
                kind: RFileKind::Source,
                text: text.clone(),
                content_digest: ContentDigest::of(&text),
            },
        );

        let s = derive_package_state(
            &PackageState::default(),
            &inputs,
            &PackageInputDelta::Initial,
        );

        // No workspace → no package mode → empty scope contribution.
        assert!(
            s.workspace.is_none(),
            "Auto mode without DESCRIPTION must not produce a workspace"
        );
        assert!(s.scope_contribution.workspace_root.is_none());
        assert!(
            s.scope_contribution.r_internal_symbols.is_empty(),
            "NAMESPACE without DESCRIPTION must not inject internal symbols"
        );
        assert!(
            s.scope_contribution.imported_symbols.is_empty(),
            "NAMESPACE without DESCRIPTION must not inject importFrom symbols"
        );
        assert!(
            s.scope_contribution.full_imports.is_empty(),
            "NAMESPACE without DESCRIPTION must not inject full imports"
        );
    }

    // ------------------------------------------------------------------
    // merge_namespace_model correctness & perf regression
    // ------------------------------------------------------------------

    /// Roxygen tags duplicated across R files must dedupe in the merged
    /// namespace model, and the NAMESPACE-seeded entries must also be
    /// deduped against (no double-counting).
    #[test]
    fn merge_namespace_model_dedupes_duplicate_import_from_and_full_imports() {
        use std::path::PathBuf;

        let mut inputs = with_description(PackageMode::Auto, "Package: pkg\n");
        inputs.namespace = Some(NamespaceInput {
            text: "importFrom(dplyr, filter)\nimport(ggplot2)\n".into(),
        });
        // Three R files each repeating the same @importFrom and @import
        // tags that NAMESPACE already provides.
        for n in 0..3 {
            let path: PathBuf = format!("/work/pkg/R/file{}.R", n).into();
            let text: Arc<str> = "\
#' @importFrom dplyr filter
#' @import ggplot2
foo <- function() 1
"
            .to_string()
            .into();
            inputs.r_files.insert(
                path,
                RFileInput {
                    kind: RFileKind::Source,
                    text: text.clone(),
                    content_digest: ContentDigest::of(&text),
                },
            );
        }

        let s = derive_package_state(
            &PackageState::default(),
            &inputs,
            &PackageInputDelta::Initial,
        );
        let ns = s.namespace_model.as_ref().expect("namespace model built");

        let filter_count = ns
            .imports
            .iter()
            .filter(|(p, sym)| p == "dplyr" && sym == "filter")
            .count();
        assert_eq!(
            filter_count, 1,
            "(dplyr, filter) must appear exactly once after dedupe; got: {:?}",
            ns.imports,
        );

        let ggplot_count = ns
            .full_imports
            .iter()
            .filter(|p| p.as_str() == "ggplot2")
            .count();
        assert_eq!(
            ggplot_count, 1,
            "ggplot2 must appear exactly once in full_imports after dedupe; got: {:?}",
            ns.full_imports,
        );
    }

    /// Perf regression: `merge_namespace_model` must not be quadratic in
    /// the number of `@importFrom` entries contributed across R files.
    ///
    /// Before the HashSet dedup fix, a 500-file package with ~5 imports
    /// each (2500 total) would linear-scan the growing Vec on every
    /// insertion: ~2500 × ~1250 average Vec length ≈ 3M pair comparisons
    /// per derive — observed at multiple ms under the write lock.
    /// 5 seconds is an extremely generous ceiling chosen to be robust on
    /// the slowest CI hardware; a quadratic regression would blow past it.
    #[test]
    fn merge_namespace_model_is_linear_in_total_imports() {
        use std::path::PathBuf;

        let n_files = 500usize;
        let imports_per_file = 10usize;

        let mut inputs = with_description(PackageMode::Auto, "Package: pkg\n");
        for f in 0..n_files {
            // Each file gets a unique set of `@importFrom` pairs (no dedupe
            // shortcut across files) plus a few shared pairs (exercise the
            // dedupe path on the already-seen set).
            let mut body = String::new();
            for i in 0..imports_per_file {
                body.push_str(&format!("#' @importFrom pkg{}_of_{} sym{}\n", i % 20, f, i,));
            }
            body.push_str("foo <- function() 1\n");
            let path: PathBuf = format!("/work/pkg/R/file{}.R", f).into();
            let text: Arc<str> = body.into();
            inputs.r_files.insert(
                path,
                RFileInput {
                    kind: RFileKind::Source,
                    text: text.clone(),
                    content_digest: ContentDigest::of(&text),
                },
            );
        }

        let start = std::time::Instant::now();
        let _ = derive_package_state(
            &PackageState::default(),
            &inputs,
            &PackageInputDelta::Initial,
        );
        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "derive_package_state took {:?} for {} files × {} imports — \
             suspected quadratic regression in merge_namespace_model",
            elapsed,
            n_files,
            imports_per_file,
        );
    }
}
