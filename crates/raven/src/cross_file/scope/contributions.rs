//! File-level scope contributions shared by point and streaming resolution.
//!
//! Preparation classifies the canonical query path once and borrows the applicable
//! name/package groups. Every lookup and materialization consumes that selection;
//! callers never repeat package-layout or preamble-order rules. Function-body
//! queries can see later peer preamble definitions, but package attachments always
//! describe the environment before the queried file executes. Own-file entries
//! are excluded because the ordinary timeline owns their position and hoisting.
//!
//! Membership indexes are lazy and retained for a stream. They borrow names from
//! the contribution snapshot, whose lifetime covers the stream, so indexing does
//! not copy name bytes or allocate an `Arc` per name. Point queries iterate the
//! borrowed groups directly, avoiding an extra name set when building a scope.

use std::cell::OnceCell;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::Path;
use std::sync::Arc;

use tower_lsp::lsp_types::Url;

use super::{PACKAGE_INTERNAL_URI, ScopeAtPosition, ScopedSymbol, SymbolKind};
use crate::package_state::{self, PackageScopeContribution, RFileKind};

use super::evaluation::ScopePhase;

/// R installs this binding in the namespace, not the attached package environment.
/// Keep it separate from package internals exposed by `load_all(export_all=TRUE)`.
static NAMESPACE_RUNTIME_SYMBOLS: std::sync::LazyLock<BTreeSet<String>> =
    std::sync::LazyLock::new(|| BTreeSet::from([".packageName".to_owned()]));

/// Prepared contributions for one canonical query file, independent of cursor position.
#[derive(Default)]
pub(super) struct ScopeContributions<'a> {
    r6: Option<&'a super::r6::PackageClasses>,
    r6_omitted_parent_context: Option<&'a HashSet<Url>>,
    r6_graph_context_truncated: bool,
    immediate_groups: Vec<&'a BTreeSet<String>>,
    imported_names: Option<&'a BTreeMap<String, BTreeSet<String>>>,
    deferred_helper_groups: Vec<&'a BTreeSet<String>>,
    attachment_groups: Vec<&'a BTreeSet<String>>,
    remove_load_all: bool,
    immediate_names: OnceCell<HashSet<&'a str>>,
    deferred_names: OnceCell<HashSet<&'a str>>,
    symbol_uri: OnceCell<Url>,
}

impl<'a> ScopeContributions<'a> {
    /// Select contributions using the canonical package URI, not the client's alias.
    pub(super) fn new(uri: &Url, contribution: Option<&'a PackageScopeContribution>) -> Self {
        let mut selected = Self::default();
        let Some(contrib) = contribution else {
            return selected;
        };
        selected.r6_graph_context_truncated = contrib.r6_graph_context_truncated;
        let Ok(path) = uri.to_file_path() else {
            return selected;
        };

        // Script workspaces have no package root but can still have a profile.
        if rprofile_prelude_applies(&path, contrib) {
            selected.immediate_groups.push(&contrib.rprofile_symbols);
            selected
                .attachment_groups
                .push(&contrib.rprofile_attached_packages);
        }
        let Some(root) = contrib.workspace_root.as_ref() else {
            return selected;
        };
        selected.remove_load_all = !path.starts_with(root);
        if package_state::is_package_workspace_r_file(&path, root) {
            selected.immediate_groups.push(&contrib.dataset_symbols);
        }
        let kind = package_state::is_r_source_path(&path, root);
        // testthat evaluates package tests in a child of the namespace. Other
        // test frameworks and dev-context scripts only get the existing package
        // contribution approximation, not namespace-runtime bindings.
        if kind == Some(RFileKind::Source)
            || (kind == Some(RFileKind::Test)
                && path.starts_with(root.join("tests").join("testthat")))
        {
            selected.immediate_groups.push(&NAMESPACE_RUNTIME_SYMBOLS);
        }
        if kind.is_some() || package_state::is_dev_context_path(&path, root) {
            selected.r6 = Some(&contrib.r6);
            selected.r6_omitted_parent_context = Some(&contrib.r6_omitted_parent_context);
            selected.immediate_groups.extend([
                contrib.r_internal_symbols.as_ref(),
                contrib.sysdata_symbols.as_ref(),
                contrib.onload_symbols.as_ref(),
            ]);
            selected.imported_names = Some(&contrib.imported_symbols);
        }
        let Some(is_preamble) = test_preamble_context(&path, root, kind) else {
            return selected;
        };

        selected
            .attachment_groups
            .push(&contrib.test_attached_packages);
        for (peer, names) in contrib.test_helper_symbols.iter() {
            match preamble_phase(peer, &path, is_preamble) {
                Some(ScopePhase::Immediate) => selected.immediate_groups.push(names),
                Some(ScopePhase::Deferred) => selected.deferred_helper_groups.push(names),
                None => {}
            }
        }
        for (peer, packages) in contrib.test_helper_attached_packages.iter() {
            if preamble_phase(peer, &path, is_preamble) == Some(ScopePhase::Immediate) {
                selected.attachment_groups.push(packages);
            }
        }
        selected
    }

    /// Class lookup uses exactly the same package-context gate as internal names.
    pub(super) fn r6_classes(&self) -> Option<&'a super::r6::PackageClasses> {
        self.r6
    }

    pub(super) fn r6_context_incomplete(&self, uri: &Url) -> bool {
        self.r6_graph_context_truncated
            || self
                .r6_omitted_parent_context
                .is_some_and(|uris| uris.contains(uri))
    }

    /// Iterate strict names without allocating the stream's membership index.
    fn immediate_symbols(&self) -> impl Iterator<Item = &'a String> + '_ {
        self.immediate_groups
            .iter()
            .flat_map(|&names| names.iter())
            .chain(
                self.imported_names
                    .into_iter()
                    .flat_map(|names| names.keys()),
            )
    }

    /// Iterate only definitions that require the completed preamble environment.
    fn deferred_symbols(&self) -> impl Iterator<Item = &'a String> + '_ {
        self.deferred_helper_groups
            .iter()
            .flat_map(|&names| names.iter())
    }

    /// Seed prerequisites before evaluating conditional loaders on the timeline.
    pub(super) fn seed_attached_packages(&self, attached: &mut HashSet<String>) {
        attached.extend(
            self.attachment_groups
                .iter()
                .flat_map(|names| names.iter())
                .cloned(),
        );
    }

    /// Test membership with at most one index build per phase in a stream.
    pub(super) fn contains(&self, name: &str, phase: ScopePhase) -> bool {
        let immediate = self
            .immediate_names
            .get_or_init(|| self.immediate_symbols().map(String::as_str).collect());
        immediate.contains(name)
            || (phase == ScopePhase::Deferred
                && self
                    .deferred_names
                    .get_or_init(|| {
                        self.deferred_symbols()
                            .filter(|name| !immediate.contains(name.as_str()))
                            .map(String::as_str)
                            .collect()
                    })
                    .contains(name))
    }

    /// Return the same synthetic binding used by full scope materialization.
    pub(super) fn symbol_for(&self, name: &str, phase: ScopePhase) -> Option<ScopedSymbol> {
        self.contains(name, phase)
            .then(|| self.synthetic_symbol(Arc::from(name)))
    }

    /// Materialize after timeline evaluation, preserving local and sourced bindings.
    ///
    /// Contributions retain their existing fallback after `rm()`. Full namespace
    /// imports remain the package library's responsibility. The load-all gate
    /// filters loaded/inherited packages only; attachment projection is unchanged.
    pub(super) fn apply(&self, scope: &mut ScopeAtPosition, phase: ScopePhase) {
        scope.contributions_deferred = phase.is_deferred();
        if self.remove_load_all {
            scope
                .loaded_packages
                .remove(crate::package_library::LOAD_ALL_SENTINEL);
            scope
                .inherited_packages
                .remove(crate::package_library::LOAD_ALL_SENTINEL);
        }
        let deferred = (phase == ScopePhase::Deferred).then(|| self.deferred_symbols());
        for name in self
            .immediate_symbols()
            .chain(deferred.into_iter().flatten())
        {
            let name: Arc<str> = Arc::from(name.as_str());
            scope
                .symbols
                .entry(name.clone())
                .or_insert_with(|| self.synthetic_symbol(name));
        }
        self.seed_attached_packages(&mut scope.inherited_packages);
        self.seed_attached_packages(&mut scope.attached_packages);
    }

    /// Contribution facts carry names, not source locations or function signatures.
    fn synthetic_symbol(&self, name: Arc<str>) -> ScopedSymbol {
        ScopedSymbol {
            defined_end_column: crate::utf16::utf16_len(&name),
            name,
            kind: SymbolKind::Variable,
            source_uri: self
                .symbol_uri
                .get_or_init(|| Url::parse(PACKAGE_INTERNAL_URI).unwrap())
                .clone(),
            defined_line: 0,
            defined_column: 0,
            signature: None,
            is_declared: false,
        }
    }
}

/// Candidate origins for an already-resolved synthetic helper binding, newest
/// first. Shares the contribution selector's directory, own-file, source-order,
/// and hoisting gates. Names remain location-free on diagnostic hot paths;
/// interactive consumers recover provenance only for the requested name.
pub(crate) fn test_helper_sources_for_symbol<'a>(
    uri: &Url,
    deferred: bool,
    contribution: &'a PackageScopeContribution,
    name: &'a str,
) -> impl Iterator<Item = &'a Path> {
    let context = uri.to_file_path().ok().and_then(|path| {
        let root = contribution.workspace_root.as_ref()?;
        let is_preamble =
            test_preamble_context(&path, root, package_state::is_r_source_path(&path, root))?;
        Some((path, is_preamble))
    });
    contribution
        .test_helper_symbols
        .iter()
        .rev()
        .filter_map(move |(peer, names)| {
            let (path, is_preamble) = context.as_ref()?;
            let phase = preamble_phase(peer, path, *is_preamble)?;
            (names.contains(name) && (phase == ScopePhase::Immediate || deferred))
                .then_some(peer.as_path())
        })
}

/// Classify a query using the same package-layout gate for visibility and origin.
fn test_preamble_context(path: &Path, root: &Path, kind: Option<RFileKind>) -> Option<bool> {
    (kind == Some(RFileKind::Test) && package_state::is_testthat_or_testit_test(path, root)).then(
        || {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(package_state::is_test_preamble_filename)
        },
    )
}

/// Classify a peer by testthat's same-directory, byte-lexicographic source order.
/// Own entries never lend; tests see all peers immediately, while a preamble sees
/// later helpers/setups only through a deferred symbol lookup.
fn preamble_phase(peer: &Path, query: &Path, query_is_preamble: bool) -> Option<ScopePhase> {
    if peer == query || peer.parent() != query.parent() {
        None
    } else {
        Some(ScopePhase::from_deferred(query_is_preamble && peer > query))
    }
}

/// Whether a profile applies, including script mode without a package root.
/// Package-mode withholding uses the profile root, matching profile discovery.
pub(crate) fn rprofile_prelude_applies(path: &Path, contrib: &PackageScopeContribution) -> bool {
    let Some(root) = contrib.rprofile_root.as_ref() else {
        return false;
    };
    path.starts_with(root)
        && !(contrib.workspace_root.is_some()
            && package_state::rprofile_withheld_in_package_mode(path, root))
}
