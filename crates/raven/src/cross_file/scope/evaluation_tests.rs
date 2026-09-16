//! Observable evaluation contracts shared by point and streaming resolvers.
//! Expected names and package facts are stated independently of either engine;
//! full-result comparisons then guard metadata and cache consistency.

use super::*;
use crate::cross_file::config::BackwardDependencyMode;
use crate::cross_file::dependency::DependencyGraph;
use crate::selective_import::{ExportSet, ImportEnv};

/// An explicit cursor expectation; omitted names are checked through parity.
struct Checkpoint {
    position: (u32, u32),
    present: &'static [&'static str],
    absent: &'static [&'static str],
    packages: &'static [&'static str],
    aliases: &'static [&'static str],
}

impl Checkpoint {
    /// Describe a cursor with no package loads or namespace aliases.
    fn at(
        position: (u32, u32),
        present: &'static [&'static str],
        absent: &'static [&'static str],
    ) -> Self {
        Self {
            position,
            present,
            absent,
            packages: &[],
            aliases: &[],
        }
    }

    /// State packages both known and attached in these library-based fixtures.
    fn with_packages(mut self, packages: &'static [&'static str]) -> Self {
        self.packages = packages;
        self
    }

    /// State the surviving namespace-alias bindings independently of symbols.
    fn with_aliases(mut self, aliases: &'static [&'static str]) -> Self {
        self.aliases = aliases;
        self
    }
}

/// A complete, deterministic package export set for selective-import fixtures.
struct ContractImportEnv;

impl ImportEnv for ContractImportEnv {
    fn package_exports(&self, _package: &str) -> ExportSet {
        ExportSet::complete(["a"])
    }

    fn module_exports(
        &self,
        _module: &crate::selective_import::LocalModuleIdentity,
    ) -> Option<ExportSet> {
        None
    }
}

/// Expand distinct global and local dataset stems without a package database.
fn dataset_objects(package: &str, stem: &str) -> Vec<String> {
    match (package, stem) {
        ("fixture", "global") => vec!["global_object".into()],
        ("fixture", "local") => vec!["local_object".into()],
        _ => Vec::new(),
    }
}

/// Check semantic expectations before comparing two implementations.
fn assert_expected(scope: &ScopeAtPosition, expected: &Checkpoint, context: &str) {
    for &name in expected.present {
        assert!(
            scope.symbols.contains_key(name),
            "missing {name}: {context}"
        );
    }
    for &name in expected.absent {
        assert!(
            !scope.symbols.contains_key(name),
            "unexpected {name}: {context}"
        );
    }
    let packages: HashSet<_> = scope
        .loaded_packages
        .union(&scope.inherited_packages)
        .map(String::as_str)
        .collect();
    let expected_packages: HashSet<_> = expected.packages.iter().copied().collect();
    assert_eq!(packages, expected_packages, "known packages: {context}");
    assert_eq!(
        scope
            .attached_packages
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>(),
        expected_packages,
        "attached packages: {context}"
    );
    assert_eq!(
        scope
            .namespace_import_aliases
            .keys()
            .map(|name| name.as_ref())
            .collect::<HashSet<_>>(),
        expected.aliases.iter().copied().collect::<HashSet<_>>(),
        "namespace aliases: {context}"
    );
}

/// Compare binding identity and package routing after independent expectations.
fn assert_same_scope(actual: &ScopeAtPosition, expected: &ScopeAtPosition, context: &str) {
    assert_eq!(actual.symbols, expected.symbols, "symbols: {context}");
    assert_eq!(
        actual.loaded_packages, expected.loaded_packages,
        "loads: {context}"
    );
    assert_eq!(
        actual.inherited_packages, expected.inherited_packages,
        "inherited: {context}"
    );
    assert_eq!(
        actual.attached_packages, expected.attached_packages,
        "attachments: {context}"
    );
    assert_eq!(
        actual.namespace_import_aliases, expected.namespace_import_aliases,
        "aliases: {context}"
    );
}

/// Validate either stream without unifying the lifetimes of their separate caches.
fn assert_stream_checkpoint<F, G>(
    stream: &mut ScopeStream<'_, F, G>,
    expected: &Checkpoint,
    recursive: &ScopeAtPosition,
    label: &str,
    context: &str,
) where
    F: Fn(&Url) -> Option<Arc<ScopeArtifacts>>,
    G: Fn(&Url) -> Option<Arc<crate::cross_file::types::CrossFileMetadata>>,
{
    stream.advance_to(expected.position.0, expected.position.1);
    for (&name, visible) in expected
        .present
        .iter()
        .map(|name| (name, true))
        .chain(expected.absent.iter().map(|name| (name, false)))
    {
        assert_eq!(
            stream.is_visible(name),
            visible,
            "{label} visibility {name}: {context}"
        );
        assert_eq!(
            stream.symbol_for(name),
            recursive.symbols.get(name).cloned(),
            "{label} symbol {name}: {context}"
        );
    }
    let snapshot = stream.snapshot();
    assert_expected(&snapshot, expected, &format!("{label}: {context}"));
    assert_same_scope(&snapshot, recursive, &format!("{label}: {context}"));
}

/// Parse real files, retain one stream and prefix cache across checkpoints, and
/// also jump a fresh stream directly to every cursor. Single-file APIs are
/// included only when the fixture needs neither sources nor query-time providers.
fn assert_evaluation_contract(
    files: &[(&str, &str)],
    hoist: bool,
    check_single_file: bool,
    checkpoints: &[Checkpoint],
) {
    let root = Url::parse("file:///evaluation-contract/").unwrap();
    let uri = root.join("main.R").unwrap();
    let mut metadata = HashMap::new();
    let mut artifacts = HashMap::new();
    for &(path, code) in files {
        let file_uri = root.join(path).unwrap();
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&tree_sitter_r::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code, None).unwrap();
        let file_metadata = Arc::new(crate::cross_file::extract_metadata_with_tree(
            code,
            Some(&tree),
        ));
        let file_artifacts = Arc::new(compute_artifacts_with_metadata(
            &file_uri,
            &tree,
            code,
            Some(&file_metadata),
        ));
        metadata.insert(file_uri.clone(), file_metadata);
        artifacts.insert(file_uri, file_artifacts);
    }
    let mut graph = DependencyGraph::new();
    for (file_uri, file_metadata) in &metadata {
        graph.update_file(file_uri, file_metadata, Some(&root), |_| None);
    }
    let get_artifacts = |candidate: &Url| artifacts.get(candidate).cloned();
    let get_metadata = |candidate: &Url| metadata.get(candidate).cloned();
    let base_exports = HashSet::new();
    let data_provider = DataAliasProvider {
        lookup: &dataset_objects,
        base_packages: &base_exports,
    };
    let import_provider = SelectiveImportProvider {
        env: &ContractImportEnv,
    };
    let stream_cache = std::cell::RefCell::new(ParentPrefixCache::new());
    let mut recursive_cache = ParentPrefixCache::new();
    let mut stream = ScopeStream::new_with_standalone_cache_and_package_query_uri(
        &uri,
        &get_artifacts,
        &get_metadata,
        &graph,
        Some(&root),
        10,
        &base_exports,
        hoist,
        BackwardDependencyMode::Explicit,
        &|| false,
        &stream_cache,
        None,
        Some(&data_provider),
        Some(&import_provider),
        None,
        None,
    )
    .expect("evaluation fixture has scope artifacts");

    for expected in checkpoints {
        let (line, column) = expected.position;
        let context = format!("{line}:{column}, hoist={hoist}, code={}", files[0].1);
        let recursive = scope_at_position_with_graph_with_package_query_uri(
            &uri,
            line,
            column,
            &get_artifacts,
            &get_metadata,
            &graph,
            Some(&root),
            10,
            &base_exports,
            hoist,
            BackwardDependencyMode::Explicit,
            &|| false,
            None,
            Some(&data_provider),
            Some(&import_provider),
            None,
        );
        assert_expected(&recursive, expected, &format!("recursive: {context}"));
        let cached =
            scope_at_position_with_graph_cached_with_standalone_cache_and_package_query_uri(
                &uri,
                line,
                column,
                &get_artifacts,
                &get_metadata,
                &graph,
                Some(&root),
                10,
                &base_exports,
                hoist,
                BackwardDependencyMode::Explicit,
                &|| false,
                &mut recursive_cache,
                None,
                Some(&data_provider),
                Some(&import_provider),
                None,
                None,
            );
        assert_expected(&cached, expected, &format!("cached: {context}"));
        assert_same_scope(&cached, &recursive, &format!("cached: {context}"));

        if check_single_file {
            for (label, scope) in [
                (
                    "single",
                    scope_at_position(&artifacts[&uri], line, column, hoist),
                ),
                (
                    "single with packages",
                    scope_at_position_with_packages(
                        &artifacts[&uri],
                        line,
                        column,
                        &|_| HashSet::new(),
                        &base_exports,
                        hoist,
                    ),
                ),
            ] {
                assert_expected(&scope, expected, &format!("{label}: {context}"));
                assert_same_scope(&scope, &recursive, &format!("{label}: {context}"));
            }
        }

        let direct_cache = std::cell::RefCell::new(ParentPrefixCache::new());
        let mut direct = ScopeStream::new_with_standalone_cache_and_package_query_uri(
            &uri,
            &get_artifacts,
            &get_metadata,
            &graph,
            Some(&root),
            10,
            &base_exports,
            hoist,
            BackwardDependencyMode::Explicit,
            &|| false,
            &direct_cache,
            None,
            Some(&data_provider),
            Some(&import_provider),
            None,
            None,
        )
        .unwrap();
        assert_stream_checkpoint(
            &mut stream,
            expected,
            &recursive,
            "stepped stream",
            &context,
        );
        assert_stream_checkpoint(&mut direct, expected, &recursive, "direct stream", &context);
    }
}

/// Declarations use an inclusive end-of-line cursor; evaluated captures preserve
/// their runtime function owner while global directives participate in hoisting.
#[test]
fn declarations_respect_cursor_deferred_lookup_and_runtime_owner() {
    let code = concat!(
        "probe\n",
        "f <- function() {\n",
        "  probe\n",
        "  bquote(function() .(exists(\"local_decl\")))\n",
        "  probe\n",
        "}\n",
        "# raven: var global_decl\n",
        "probe\n",
    );
    for hoist in [true, false] {
        assert_evaluation_contract(
            &[("main.R", code)],
            hoist,
            true,
            &[
                Checkpoint::at((0, 0), &[], &["global_decl", "local_decl"]),
                Checkpoint::at(
                    (2, 2),
                    if hoist { &["global_decl"] } else { &[] },
                    if hoist {
                        &["local_decl"]
                    } else {
                        &["global_decl", "local_decl"]
                    },
                ),
                Checkpoint::at((3, 0), &[], &["local_decl"]),
                Checkpoint::at((3, u32::MAX), &["local_decl"], &[]),
                Checkpoint::at((4, 2), &["local_decl"], &[]),
                Checkpoint::at((6, 0), &[], &["global_decl", "local_decl"]),
                Checkpoint::at((6, u32::MAX), &["global_decl"], &["local_decl"]),
                Checkpoint::at((u32::MAX, u32::MAX), &["global_decl"], &["local_decl"]),
            ],
        );
    }
}

/// Immediate assignment effects follow their RHS, including removals nested in it.
#[test]
fn assignment_effects_preserve_own_rhs_and_nested_removal_order() {
    assert_evaluation_contract(
        &[("main.R", "x <- x\nx <- { rm(x); 1 }\nx\n")],
        true,
        true,
        &[
            Checkpoint::at((0, 5), &[], &["x"]),
            Checkpoint::at((0, 6), &["x"], &[]),
            Checkpoint::at((1, 7), &["x"], &[]),
            Checkpoint::at((1, 8), &[], &["x"]),
            Checkpoint::at((2, 0), &["x"], &[]),
        ],
    );
}

/// Deferred global effects never hoist function locals or leak sibling frames.
#[test]
fn deferred_globals_keep_local_order_and_restore_top_level_context() {
    let code = concat!(
        "gone <- 1\n",
        "f <- function(p) {\n",
        "  probe\n",
        "  local <- local\n",
        "  local\n",
        "}\n",
        "g <- function(q) {\n",
        "  sibling <- 1\n",
        "  probe\n",
        "}\n",
        "later <- 2\n",
        "rm(gone)\n",
        "library(stats)\n",
    );
    for hoist in [true, false] {
        let packages: &'static [&'static str] = if hoist { &["stats"] } else { &[] };
        assert_evaluation_contract(
            &[("main.R", code)],
            hoist,
            true,
            &[
                Checkpoint::at(
                    (2, 2),
                    if hoist {
                        &["f", "g", "p", "later"]
                    } else {
                        &["f", "p", "gone"]
                    },
                    if hoist {
                        &["gone", "local", "q", "sibling"]
                    } else {
                        &["g", "later", "local", "q", "sibling"]
                    },
                )
                .with_packages(packages),
                Checkpoint::at((3, 11), &["p"], &["local", "sibling"]).with_packages(packages),
                Checkpoint::at((4, u32::MAX), &["f", "p", "local"], &["q", "sibling"])
                    .with_packages(packages),
                Checkpoint::at((8, 2), &["g", "q", "sibling"], &["p", "local"])
                    .with_packages(packages),
                Checkpoint::at(
                    (u32::MAX, u32::MAX),
                    &["f", "g", "later"],
                    &["gone", "p", "q", "local", "sibling"],
                )
                .with_packages(&["stats"]),
            ],
        );
    }
}

/// Source and removal anchors remain strict even though other effects are inclusive.
#[test]
fn source_and_removal_effects_are_strict_at_the_call_anchor() {
    assert_evaluation_contract(
        &[
            ("main.R", "source(\"helper.R\")\nrm(child)\nprobe\n"),
            ("helper.R", "child <- 1\n"),
        ],
        false,
        false,
        &[
            Checkpoint::at((0, 0), &[], &["child"]),
            Checkpoint::at((0, 1), &["child"], &[]),
            Checkpoint::at((1, 0), &["child"], &[]),
            Checkpoint::at((1, 1), &[], &["child"]),
        ],
    );
}

/// Data expansion and selective imports follow the same global/local timing policy.
#[test]
fn provider_events_respect_deferred_globals_and_function_ownership() {
    let code = concat!(
        "f <- function() {\n",
        "  probe\n",
        "  data(local, package = \"fixture\")\n",
        "  box::use(inner = pkg[a])\n",
        "  probe\n",
        "}\n",
        "data(global, package = \"fixture\")\n",
        "box::use(outer = pkg[a])\n",
        "probe\n",
    );
    for hoist in [true, false] {
        assert_evaluation_contract(
            &[("main.R", code)],
            hoist,
            false,
            &[
                Checkpoint::at(
                    (1, 2),
                    if hoist {
                        &["f", "global_object", "outer", "a"]
                    } else {
                        &["f"]
                    },
                    if hoist {
                        &["local_object", "inner"]
                    } else {
                        &["global_object", "outer", "a", "local_object", "inner"]
                    },
                )
                .with_aliases(if hoist { &["outer"] } else { &[] }),
                Checkpoint::at((4, 2), &["local_object", "inner", "a"], &[]).with_aliases(
                    if hoist {
                        &["inner", "outer"]
                    } else {
                        &["inner"]
                    },
                ),
                Checkpoint::at(
                    (8, 0),
                    &["global_object", "outer", "a"],
                    &["local_object", "inner"],
                )
                .with_aliases(&["outer"]),
            ],
        );
    }
}

/// Only a preceding Shiny attachment turns a bare helper body into a deferred scope.
#[test]
fn conditional_shiny_ownership_uses_attachment_state_at_the_call() {
    let preceding = concat!(
        "source(\"attach.R\")\n",
        "reactive({\n",
        "  later\n",
        "  hidden <- 1\n",
        "})\n",
        "later <- 2\n",
        "probe\n",
    );
    assert_evaluation_contract(
        &[("main.R", preceding), ("attach.R", "library(shiny)\n")],
        true,
        false,
        &[
            Checkpoint::at((2, 2), &["later"], &["hidden"]).with_packages(&["shiny"]),
            Checkpoint::at((5, 0), &[], &["later", "hidden"]).with_packages(&["shiny"]),
            Checkpoint::at((6, 0), &["later"], &["hidden"]).with_packages(&["shiny"]),
        ],
    );
    assert_evaluation_contract(
        &[
            (
                "main.R",
                "reactive({\n  hidden <- 1\n})\nsource(\"attach.R\")\nprobe\n",
            ),
            ("attach.R", "library(shiny)\n"),
        ],
        true,
        false,
        &[
            Checkpoint::at((2, 0), &["hidden"], &[]),
            Checkpoint::at((4, 0), &["hidden"], &[]).with_packages(&["shiny"]),
        ],
    );
}
