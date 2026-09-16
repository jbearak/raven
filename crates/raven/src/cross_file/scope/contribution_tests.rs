//! Contribution contracts exercised through recursive resolution and every
//! streaming lookup interface. Fixtures use Unix file URLs; the parent module
//! gates this test module accordingly.

use super::*;
use crate::cross_file::config::BackwardDependencyMode;
use crate::cross_file::dependency::DependencyGraph;
use crate::package_state::PackageScopeContribution;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

const CONTRIBUTED_NAMES: &[&str] = &[
    "internal",
    "imported",
    "sysdata",
    "onload",
    "dataset",
    "profile",
    "earlier",
    "own",
    "later",
    "setup",
    "foreign",
    "full_import",
    "missing",
];

/// Build a shared name set for the fixture.
fn names(values: &[&str]) -> Arc<BTreeSet<String>> {
    Arc::new(values.iter().map(|value| (*value).to_owned()).collect())
}

/// Give each contribution source its own name and package so accidental
/// widening or omission cannot hide behind another source's matching name.
fn contribution_fixture() -> PackageScopeContribution {
    let preambles = [
        ("tests/testthat/helper-a.R", "earlier", "earlier_pkg"),
        ("tests/testthat/helper-b.R", "own", "own_pkg"),
        ("tests/testthat/helper-z.R", "later", "later_pkg"),
        ("tests/testthat/setup-env.R", "setup", "setup_pkg"),
        ("tests/testit/helper-a.R", "foreign", "foreign_pkg"),
    ];
    let root = PathBuf::from("/work/pkg");
    PackageScopeContribution {
        workspace_root: Some(root.clone()),
        r_internal_symbols: names(&["internal"]),
        imported_symbols: Arc::new(BTreeMap::from([(
            "imported".to_owned(),
            BTreeSet::from(["dependency".to_owned()]),
        )])),
        full_imports: names(&["full_import"]),
        sysdata_symbols: names(&["sysdata"]),
        onload_symbols: names(&["onload"]),
        dataset_symbols: names(&["dataset"]),
        rprofile_root: Some(root.clone()),
        rprofile_symbols: names(&["profile"]),
        rprofile_attached_packages: names(&["profile_pkg"]),
        test_attached_packages: names(&["test_framework"]),
        test_helper_symbols: Arc::new(
            preambles
                .iter()
                .map(|(path, name, _)| (root.join(path), names(&[name])))
                .collect(),
        ),
        test_helper_attached_packages: Arc::new(
            preambles
                .iter()
                .map(|(path, _, package)| (root.join(path), names(&[package])))
                .collect(),
        ),
        ..Default::default()
    }
}

/// Independently expected names and pre-execution packages at one cursor.
struct ExpectedContribution {
    position: (u32, u32),
    symbols: Vec<&'static str>,
    packages: Vec<&'static str>,
}

/// Keep one stream alive across every checkpoint. This catches a deferred
/// lookup that accidentally changes subsequent top-level visibility. Expected
/// names and symbol metadata are asserted independently before resolver parity.
fn assert_contribution_contract(
    query_uri: &Url,
    canonical_uri: Option<&Url>,
    code: &str,
    contribution: &PackageScopeContribution,
    hoist_globals: bool,
    checkpoints: &[ExpectedContribution],
) {
    let mut parser = tree_sitter::Parser::new();
    parser
        .set_language(&tree_sitter_r::LANGUAGE.into())
        .unwrap();
    let tree = parser.parse(code, None).unwrap();
    let metadata = Arc::new(crate::cross_file::extract_metadata(code));
    let artifacts = Arc::new(compute_artifacts_with_metadata(
        query_uri,
        &tree,
        code,
        Some(&metadata),
    ));
    let get_artifacts = |uri: &Url| (uri == query_uri).then(|| artifacts.clone());
    let get_metadata = |uri: &Url| (uri == query_uri).then(|| metadata.clone());
    let workspace_root = contribution
        .workspace_root
        .as_ref()
        .or(contribution.rprofile_root.as_ref())
        .map(|root| Url::from_directory_path(root).unwrap());
    let graph = DependencyGraph::new();
    let base_exports = HashSet::new();
    let prefix_cache = std::cell::RefCell::new(ParentPrefixCache::new());
    let mut stream = ScopeStream::new_with_standalone_cache_and_package_query_uri(
        query_uri,
        &get_artifacts,
        &get_metadata,
        &graph,
        workspace_root.as_ref(),
        10,
        &base_exports,
        hoist_globals,
        BackwardDependencyMode::Explicit,
        &|| false,
        &prefix_cache,
        Some(contribution),
        None,
        None,
        None,
        canonical_uri,
    )
    .expect("contribution fixture has scope artifacts");

    for expected in checkpoints {
        let (line, column) = expected.position;
        let context = format!("{query_uri}, {line}:{column}, hoist={hoist_globals}");
        let recursive = scope_at_position_with_graph_with_package_query_uri(
            query_uri,
            line,
            column,
            &get_artifacts,
            &get_metadata,
            &graph,
            workspace_root.as_ref(),
            10,
            &base_exports,
            hoist_globals,
            BackwardDependencyMode::Explicit,
            &|| false,
            Some(contribution),
            None,
            None,
            canonical_uri,
        );
        stream.advance_to(line, column);
        for &name in CONTRIBUTED_NAMES {
            let visible = expected.symbols.contains(&name);
            assert_eq!(
                recursive.symbols.contains_key(name),
                visible,
                "recursive {name}: {context}"
            );
            assert_eq!(
                stream.is_visible(name),
                visible,
                "stream visibility {name}: {context}"
            );
            let expected_symbol = visible.then(|| ScopedSymbol {
                name: Arc::from(name),
                kind: SymbolKind::Variable,
                source_uri: Url::parse("package:///internal").unwrap(),
                defined_line: 0,
                defined_column: 0,
                defined_end_column: crate::utf16::utf16_len(name),
                signature: None,
                is_declared: false,
            });
            assert_eq!(
                recursive.symbols.get(name),
                expected_symbol.as_ref(),
                "recursive symbol {name}: {context}"
            );
            assert_eq!(
                stream.symbol_for(name),
                expected_symbol,
                "stream symbol {name}: {context}"
            );
        }
        let expected_packages: HashSet<String> = expected
            .packages
            .iter()
            .map(|package| (*package).to_owned())
            .collect();
        assert_eq!(
            recursive.inherited_packages, expected_packages,
            "inherited packages: {context}"
        );
        assert_eq!(
            recursive.attached_packages, expected_packages,
            "attached packages: {context}"
        );
        assert!(
            recursive.loaded_packages.is_empty(),
            "pre-execution contributions are inherited, not local loads: {context}"
        );
        let snapshot = stream.snapshot();
        assert_eq!(snapshot.symbols, recursive.symbols, "symbols: {context}");
        assert_eq!(
            snapshot.inherited_packages, recursive.inherited_packages,
            "stream inherited packages: {context}"
        );
        assert_eq!(
            snapshot.attached_packages, recursive.attached_packages,
            "stream attached packages: {context}"
        );
        assert_eq!(
            snapshot.loaded_packages, recursive.loaded_packages,
            "stream loaded packages: {context}"
        );
    }
}

/// Package layout selects the same sources for every resolver interface.
#[test]
fn contribution_sources_obey_path_contract_in_all_scope_interfaces() {
    let contribution = contribution_fixture();
    // Path, namespace visibility, dataset visibility, profile visibility,
    // managed test framework. Peer preambles require the exact same directory.
    for (path, namespace, dataset, profile, framework) in [
        ("R/main.R", true, true, false, false),
        ("R/unix/main.R", true, true, false, false),
        ("R/scripts/main.R", false, true, true, false),
        ("R/_hidden.R", false, true, true, false),
        ("tests/testthat/test-main.R", true, true, false, true),
        ("tests/testthat/nested/test-main.R", true, true, false, true),
        ("tests/testit/test-main.R", true, true, false, true),
        ("tests/plain.R", true, true, false, false),
        ("tests/other/main.R", false, true, true, false),
        ("inst/tinytest/test-main.R", true, true, false, false),
        ("inst/unitTests/test-main.R", true, true, false, false),
        ("vignettes/main.qmd", true, true, false, false),
        ("man/main.Rmd", true, true, false, false),
        ("demo/main.R", true, true, false, false),
        ("data-raw/main.R", true, true, true, false),
        ("inst/examples/main.R", false, true, true, false),
        ("revdep/main.R", false, true, true, false),
        ("scripts/main.R", false, true, true, false),
        ("../outside/main.R", false, false, false, false),
    ] {
        let mut symbols = Vec::new();
        let mut packages = Vec::new();
        if namespace {
            symbols.extend(["internal", "imported", "sysdata", "onload"]);
        }
        if dataset {
            symbols.push("dataset");
        }
        if profile {
            symbols.push("profile");
            packages.push("profile_pkg");
        }
        if framework {
            packages.push("test_framework");
        }
        match path {
            "tests/testthat/test-main.R" => {
                symbols.extend(["earlier", "own", "later", "setup"]);
                packages.extend(["earlier_pkg", "own_pkg", "later_pkg", "setup_pkg"]);
            }
            "tests/testit/test-main.R" => {
                symbols.push("foreign");
                packages.push("foreign_pkg");
            }
            _ => {}
        }
        let uri = Url::parse("file:///work/pkg/").unwrap().join(path).unwrap();
        assert_contribution_contract(
            &uri,
            None,
            "",
            &contribution,
            true,
            &[ExpectedContribution {
                position: (0, 0),
                symbols,
                packages,
            }],
        );
    }
    assert_contribution_contract(
        &Url::parse("untitled:main.R").unwrap(),
        None,
        "",
        &contribution,
        true,
        &[ExpectedContribution {
            position: (0, 0),
            symbols: Vec::new(),
            packages: Vec::new(),
        }],
    );
}

/// Canonical aliases preserve deferred symbols without widening attachments.
#[test]
fn canonical_helper_alias_restores_strict_scope_after_deferred_lookup() {
    let contribution = contribution_fixture();
    let alias = Url::parse("file:///alias/pkg/tests/testthat/helper-b.R").unwrap();
    let canonical = Url::parse("file:///work/pkg/tests/testthat/helper-b.R").unwrap();
    let code = "later\nf <- function() {\n  later\n}\nlater\n";
    for hoist in [true, false] {
        let strict = vec![
            "internal", "imported", "sysdata", "onload", "dataset", "earlier",
        ];
        let mut deferred = strict.clone();
        if hoist {
            deferred.extend(["later", "setup"]);
        }
        let packages = vec!["test_framework", "earlier_pkg"];
        assert_contribution_contract(
            &alias,
            Some(&canonical),
            code,
            &contribution,
            hoist,
            &[
                ExpectedContribution {
                    position: (0, 0),
                    symbols: strict.clone(),
                    packages: packages.clone(),
                },
                ExpectedContribution {
                    position: (2, 2),
                    symbols: deferred,
                    packages: packages.clone(),
                },
                ExpectedContribution {
                    position: (4, 0),
                    symbols: strict,
                    packages,
                },
            ],
        );
    }
}

/// Profile selection remains active without a package workspace root.
#[test]
fn script_mode_profile_contribution_needs_no_package_root() {
    let mut contribution = contribution_fixture();
    contribution.workspace_root = None;
    // Keep all package fields populated. Script mode must select only the
    // profile, even for paths that would be namespace or managed test files.
    for path in ["R/main.R", "tests/testthat/test-main.R", "scripts/main.R"] {
        let canonical = Url::parse("file:///work/pkg/").unwrap().join(path).unwrap();
        let alias = Url::parse("file:///alias/pkg/")
            .unwrap()
            .join(path)
            .unwrap();
        for (query, canonical_uri, visible) in [
            (&canonical, None, true),
            (&alias, Some(&canonical), true),
            (&alias, None, false),
        ] {
            assert_contribution_contract(
                query,
                canonical_uri,
                "",
                &contribution,
                true,
                &[ExpectedContribution {
                    position: (0, 0),
                    symbols: if visible { vec!["profile"] } else { Vec::new() },
                    packages: if visible {
                        vec!["profile_pkg"]
                    } else {
                        Vec::new()
                    },
                }],
            );
        }
    }
}

/// Local bindings retain their source metadata while present; after removal,
/// the existing additive contribution fallback restores the synthetic binding.
#[test]
fn local_shadowing_and_removal_preserve_contribution_precedence() {
    let contribution = contribution_fixture();
    let root = Url::parse("file:///work/pkg/").unwrap();
    for (path, name) in [
        ("R/main.R", "internal"),
        ("scripts/main.R", "profile"),
        ("tests/testthat/helper-b.R", "earlier"),
    ] {
        let uri = root.join(path).unwrap();
        let code = format!("# local binding\n  {name} <- 42\n{name}\nrm({name})\n{name}\n");
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&tree_sitter_r::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(&code, None).unwrap();
        let artifacts = Arc::new(compute_artifacts(&uri, &tree, &code));
        let get_artifacts = |candidate: &Url| (candidate == &uri).then(|| artifacts.clone());
        let get_metadata = |_candidate: &Url| None;
        let graph = DependencyGraph::new();
        let base_exports = HashSet::new();
        let cache = std::cell::RefCell::new(ParentPrefixCache::new());
        let mut stream = ScopeStream::new(
            &uri,
            &get_artifacts,
            &get_metadata,
            &graph,
            Some(&root),
            10,
            &base_exports,
            true,
            BackwardDependencyMode::Explicit,
            &|| false,
            &cache,
            Some(&contribution),
            None,
        )
        .expect("local binding fixture has scope artifacts");
        for (line, removed) in [(2, false), (4, true)] {
            let recursive = scope_at_position_with_graph(
                &uri,
                line,
                0,
                &get_artifacts,
                &get_metadata,
                &graph,
                Some(&root),
                10,
                &base_exports,
                true,
                BackwardDependencyMode::Explicit,
                &|| false,
                Some(&contribution),
                None,
            );
            let column = if removed { 0 } else { 2 };
            let expected = ScopedSymbol {
                name: Arc::from(name),
                kind: SymbolKind::Variable,
                source_uri: if removed {
                    Url::parse("package:///internal").unwrap()
                } else {
                    uri.clone()
                },
                defined_line: if removed { 0 } else { 1 },
                defined_column: column,
                defined_end_column: column + crate::utf16::utf16_len(name),
                signature: None,
                is_declared: false,
            };
            stream.advance_to(line, 0);
            assert_eq!(
                recursive.symbols.get(name),
                Some(&expected),
                "recursive {name}, removed={removed}"
            );
            assert!(
                stream.is_visible(name),
                "stream visibility {name}, removed={removed}"
            );
            assert_eq!(
                stream.symbol_for(name),
                Some(expected.clone()),
                "stream symbol {name}, removed={removed}"
            );
            let snapshot = stream.snapshot();
            assert_eq!(
                snapshot.symbols.get(name),
                Some(&expected),
                "stream snapshot {name}, removed={removed}"
            );
            assert_eq!(snapshot.symbols, recursive.symbols);
        }
    }
}
