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
    /// The line each named binding was defined on, stated independently.
    defined_lines: &'static [(&'static str, u32)],
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
            defined_lines: &[],
        }
    }

    /// State which definition each name resolves to, by its line.
    fn defined_on(mut self, defined_lines: &'static [(&'static str, u32)]) -> Self {
        self.defined_lines = defined_lines;
        self
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
    for &(name, line) in expected.defined_lines {
        assert_eq!(
            scope.symbols.get(name).map(|symbol| symbol.defined_line),
            Some(line),
            "definition of {name}: {context}"
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

/// A child's `local()` block runs when the child is sourced, so with hoisting
/// on it still sees the parent only as of the call: an immediate interval must
/// not select the parent's end-of-file prefix the way a function body does.
#[test]
fn local_block_reads_the_parent_as_of_the_call_in_every_resolver() {
    assert_evaluation_contract(
        &[
            (
                "main.R",
                "# raven: sourced-by parent.R line=2\nlocal({ print(late) })\n",
            ),
            ("parent.R", "early <- 1\nsource(\"main.R\")\nlate <- 1\n"),
        ],
        true,
        false,
        &[
            Checkpoint::at((1, 0), &["early"], &["late"]),
            Checkpoint::at((1, 16), &["early"], &["late"]),
        ],
    );
}

/// An `rm()` in a `local()` block hides its name for the rest of the block,
/// whatever encloses it. That is wider than R, where the removal takes the
/// block's own binding and an enclosing one shows again (issue #884). These
/// fixtures pin it in every resolver. R stops at the read in some and accepts
/// others, and no narrower rule tried so far told the two apart from the
/// text, so a change to the rule has to account for each of them.
#[test]
fn block_removal_hides_the_name() {
    // The removal is wrapped in another call or operator, or has an argument
    // that can send it elsewhere. (R reads the top-level binding after the
    // second, third and fourth.)
    for removal in [
        "evalq(rm(shadow), globalenv())",
        "suppressWarnings(rm(shadow))",
        "if (TRUE) { (rm(shadow)) }",
        "rm(shadow) |> identity()",
        "rm(shadow, inherits = TRUE)",
        "rm(shadow, pos = \".GlobalEnv\")",
        "rm(shadow, \"envir\" = as.environment(1))",
    ] {
        let code = format!("shadow <- 1\nlocal({{\n  {removal}\n  shadow\n}})\n");
        for hoist in [true, false] {
            assert_evaluation_contract(
                &[("main.R", &code)],
                hoist,
                true,
                &[Checkpoint::at((3, 2), &[], &["shadow"])],
            );
        }
    }
    // Something else in the file removes the name, could remove any name, or
    // could rebind it without a timeline event.
    for other in [
        "rm(shadow, inherits = TRUE)",
        "f <- rm",
        "do.call(\"rm\", list(\"shadow\"))",
        "eval(parse(text = code))",
        "get(name)",
        "e$shadow <- 1",
        "assign(\"shadow\", 1)",
    ] {
        let code =
            format!("shadow <- 1\n{other}\nlocal({{\n  shadow <- 2\n  rm(shadow)\n  shadow\n}})\n");
        for hoist in [true, false] {
            assert_evaluation_contract(
                &[("main.R", &code)],
                hoist,
                true,
                &[Checkpoint::at((5, 2), &[], &["shadow"])],
            );
        }
    }
    // Nothing outside the block binds the name for certain. (R reads the
    // base `pi` in the last one.)
    let absent: [(&str, (u32, u32), &'static [&'static str]); 3] = [
        ("local({\n  y <- 2\n  rm(y)\n  y\n})\ny\n", (3, 2), &["y"]),
        (
            "if (FALSE) y <- 1\nlocal({\n  y <- 2\n  rm(y)\n  y\n})\n",
            (4, 2),
            &["y"],
        ),
        ("local({\n  pi <- 3\n  rm(pi)\n  pi\n})\n", (3, 2), &["pi"]),
    ];
    for (code, position, names) in absent {
        for hoist in [true, false] {
            assert_evaluation_contract(
                &[("main.R", code)],
                hoist,
                true,
                &[Checkpoint::at(position, &[], names)],
            );
        }
    }
    for hoist in [true, false] {
        // `<<-` from the block replaced the top-level binding. (R reads the
        // new one.)
        assert_evaluation_contract(
            &[(
                "main.R",
                "shadow <- 1\nlocal({\n  shadow <- 2\n  shadow <<- 3\n  rm(shadow)\n  shadow\n})\nshadow\n",
            )],
            hoist,
            true,
            &[
                Checkpoint::at((5, 2), &[], &["shadow"]),
                Checkpoint::at((7, 0), &["shadow"], &[]).defined_on(&[("shadow", 3)]),
            ],
        );
        // A branch may rebind the name at the top level. (R reads line 0.)
        assert_evaluation_contract(
            &[(
                "main.R",
                "shadow <- 1\nif (FALSE) shadow <- 5\nlocal({\n  shadow <- 2\n  rm(shadow)\n  shadow\n})\n",
            )],
            hoist,
            true,
            &[Checkpoint::at((5, 2), &[], &["shadow"])],
        );
        // `<<-` from the block created the only top-level binding. (R reads it.)
        assert_evaluation_contract(
            &[(
                "main.R",
                "local({\n  fresh <- 2\n  fresh <<- 3\n  rm(fresh)\n  fresh\n})\nfresh\n",
            )],
            hoist,
            true,
            &[
                Checkpoint::at((4, 2), &[], &["fresh"]),
                Checkpoint::at((6, 0), &["fresh"], &[]).defined_on(&[("fresh", 2)]),
            ],
        );
        // One more block, or a function, encloses the block. (R reads the
        // enclosing binding in the first two.)
        assert_evaluation_contract(
            &[(
                "main.R",
                "x <- 1\nlocal({\n  x <- 2\n  local({\n    x <- 3\n    rm(x)\n    x\n  })\n  x\n})\n",
            )],
            hoist,
            true,
            &[
                Checkpoint::at((6, 4), &[], &["x"]),
                Checkpoint::at((8, 2), &["x"], &[]).defined_on(&[("x", 2)]),
            ],
        );
        assert_evaluation_contract(
            &[(
                "main.R",
                "f <- function(x) {\n  local({\n    x <- 2\n    rm(x)\n    x\n  })\n}\n",
            )],
            hoist,
            true,
            &[Checkpoint::at((4, 4), &[], &["x"])],
        );
        assert_evaluation_contract(
            &[(
                "main.R",
                "f <- function(shadow) {\n  g <- function() {\n    shadow <- 2\n    rm(shadow)\n    shadow\n  }\n}\n",
            )],
            hoist,
            true,
            &[Checkpoint::at((4, 4), &[], &["shadow"])],
        );
        // The top-level binding isn't a function, so R finds nothing to call.
        assert_evaluation_contract(
            &[(
                "main.R",
                "shadow <- 1\nlocal({\n  shadow <- function() 2\n  rm(shadow)\n  shadow()\n})\n",
            )],
            hoist,
            true,
            &[Checkpoint::at((4, 2), &[], &["shadow"])],
        );
        // A variable handed to code that may call it.
        assert_evaluation_contract(
            &[(
                "main.R",
                "shadow <- 1\nlocal({\n  shadow <- 2\n  rm(shadow)\n  sapply(1:2, shadow)\n})\n",
            )],
            hoist,
            true,
            &[Checkpoint::at((4, 14), &[], &["shadow"])],
        );
        // A file that sources another: the child could remove the name.
        assert_evaluation_contract(
            &[
                (
                    "main.R",
                    "shadow <- 1\nsource(\"other.R\")\nlocal({\n  shadow <- 2\n  rm(shadow)\n  shadow\n})\n",
                ),
                ("other.R", "unrelated <- 1\n"),
            ],
            hoist,
            false,
            &[Checkpoint::at((5, 2), &[], &["shadow"])],
        );
    }
}

/// Where go-to-definition lands from `position` in `main.R`, as
/// `(file name, line)`, with every file open and the source graph wired up.
fn definition_target(files: &[(&str, &str)], position: (u32, u32)) -> Option<(String, u32)> {
    let root = Url::parse("file:///definition-target/").unwrap();
    let mut state = crate::state::WorldState::new();
    state.workspace_scan_complete = true;
    for &(path, code) in files {
        let uri = root.join(path).unwrap();
        state
            .documents
            .insert(uri.clone(), crate::state::Document::new(code, None));
        state.cross_file_graph.update_file(
            &uri,
            &crate::cross_file::extract_metadata(code),
            Some(&root),
            |_| None,
        );
    }
    let response = crate::handlers::goto_definition(
        &state,
        &root.join("main.R").unwrap(),
        tower_lsp::lsp_types::Position::new(position.0, position.1),
    )?;
    let tower_lsp::lsp_types::GotoDefinitionResponse::Scalar(location) = response else {
        panic!("expected one location, got {response:?}");
    };
    let file = location.uri.path().rsplit('/').next().unwrap().to_owned();
    Some((file, location.range.start.line))
}

/// The `(line, column)` of the last occurrence of `needle` in `code`.
fn last_position_of(code: &str, needle: &str) -> (u32, u32) {
    let offset = code.rfind(needle).unwrap();
    let line = code[..offset].matches('\n').count() as u32;
    let column = (offset - code[..offset].rfind('\n').map_or(0, |start| start + 1)) as u32;
    (line, column)
}

/// Review inputs where a narrower removal rule moved go-to-definition to a
/// binding R doesn't read. Each must land where it does today.
#[test]
fn removals_keep_their_definition_targets() {
    let inherits =
        "probe <- 1\nlocal({ rm(probe, inherits = TRUE); probe <- 2; rm(probe); print(probe) })\n";
    assert_eq!(
        definition_target(&[("main.R", inherits)], last_position_of(inherits, "probe")),
        None
    );
    let closure = "local({\n  shadow <- 1\n  f <- function() {\n    local({\n      shadow <- 2\n      rm(shadow)\n      print(shadow)\n    })\n  }\n  rm(shadow)\n  f()\n})\n";
    assert_eq!(
        definition_target(
            &[("main.R", closure)],
            last_position_of(closure, "shadow)\n    })")
        ),
        None
    );
    let repeated = "shadow <- 1\nlocal({\n  shadow <- 2\n  rm(shadow, shadow)\n  rm(shadow, envir = globalenv())\n  print(shadow)\n})\n";
    assert_eq!(
        definition_target(
            &[("main.R", repeated)],
            last_position_of(repeated, "shadow")
        ),
        None
    );
    // R reads `shadow <- 3` here: the closure runs after the block rebinds
    // the name.
    let rebound = "f <- function() 0\nshadow <- 1\nlocal({\n  shadow <- 2\n  rm(shadow)\n  f <- function() print(shadow)\n  shadow <- 3\n  f()\n})\n";
    assert_eq!(
        definition_target(
            &[("main.R", rebound)],
            last_position_of(rebound, "shadow)\n  shadow <- 3")
        ),
        None
    );
    let backticked =
        "shadow <- 1\nrm(`shadow`)\nlocal({\n  shadow <- 2\n  rm(shadow)\n  print(shadow)\n})\n";
    assert_eq!(
        definition_target(
            &[("main.R", backticked)],
            last_position_of(backticked, "shadow")
        ),
        None
    );
    let unrelated = "local({\n  other <- 0; rm(other)\n  source(\"child.R\", local = TRUE)\n  print(probe)\n})\n";
    assert_eq!(
        definition_target(
            &[
                ("main.R", unrelated),
                (
                    "child.R",
                    "assign(\"probe\", 1, envir = .GlobalEnv)\nprobe <- 2\n"
                ),
            ],
            last_position_of(unrelated, "probe")
        ),
        Some(("child.R".to_owned(), 1))
    );
}
