//! The planning half of [`super::DependencyGraph::update_file`].
//!
//! [`plan_file_edges`] turns one file's graph metadata into the ordered edge
//! candidates `update_file` inserts, without touching the graph. It reads the
//! filesystem and parent text exactly as `update_file` always has, through the
//! same resolvers, and records why each candidate exists and why each detected
//! entry produced no candidate. [`super::DependencyGraph::update_file`] applies the
//! plan (deduplication and insertion); when tracing is on the graph also keeps
//! each file's latest plan for `raven graph`.
//!
//! Candidate order is load-bearing: forward directives, then backward
//! directives, then AST-detected sources, `box::use()` modules, and report
//! documents. Apply keeps the first candidate per [`GraphEdgeDedupKey`], so
//! the plan's survivors ([`FileEdgePlan::survivor_mask`]) are exactly the edges
//! apply inserts.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;

use tower_lsp::lsp_types::Url;

use super::{DependencyEdge, DependencyEdgeKind, DirectiveConflictIdentity, GraphEdgeDedupKey};
use crate::cross_file::parent_resolve::{infer_call_site_from_parent, resolve_match_pattern};
use crate::cross_file::path_resolve::{
    CaseMismatchRegime, PathContext, ResolveOutcome, path_to_uri, resolve_backward_path_rich,
    resolve_source_path_rich,
};
use crate::cross_file::types::{
    BackwardDirective, CallSiteSpec, CrossFileMetadata, ForwardSource, SourceLocality,
};

/// Entries the exclusion filter removed from a file's metadata before the
/// graph saw it (`WorldState::metadata_for_dependency_graph_with_exclusions`),
/// each with the excluded target (forward) or parent (backward) it resolved
/// to. They reach the plan as `excluded` drops.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ExcludedGraphEntries {
    pub(crate) sources: Vec<(ForwardSource, Url)>,
    pub(crate) sourced_by: Vec<(BackwardDirective, Url)>,
}

/// The metadata entry a planned edge or drop came from.
///
/// Indices point into the metadata the plan was built from (kept beside the
/// plan when tracing; see [`StoredFilePlan`]), or into the excluded entries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlanEntry {
    /// `metadata.sources[i]`: a `source()`/`sys.source()` call, a forward
    /// directive, or a source-batch member.
    Source(usize),
    /// `metadata.sourced_by[i]`: a backward directive.
    SourcedBy(usize),
    /// The `i`th item of `metadata.selective_import_requests(uri)`.
    SelectiveImport(usize),
    /// `metadata.tarchetypes_document_links[i]`.
    TarchetypesDocument(usize),
    /// `excluded.sources[i]`.
    ExcludedSource(usize),
    /// `excluded.sourced_by[i]`.
    ExcludedSourcedBy(usize),
}

/// How a candidate's endpoint was resolved.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum PlannedResolution {
    /// Through the forward or backward path resolver: the resolved
    /// (case-corrected) path and the resolver's case signal.
    Resolver {
        path: PathBuf,
        case_mismatch: Option<CaseMismatchRegime>,
    },
    /// The entry arrived with `resolved_uri` set (an installed package's
    /// `system.file()`), so the resolver was skipped.
    PreResolved,
}

/// What a candidate's call site is based on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CallSiteBasis {
    /// A call in code.
    Call,
    /// A forward directive's own line.
    Directive,
    /// A forward directive's `line=N`.
    Line,
    /// A backward directive's `line=N`: the end of that line.
    LineEnd,
    /// `line=eof` / `line=end`, forward or backward.
    Eof,
    /// A backward directive's `match=`.
    Match,
    /// A backward directive with neither `line=` nor `match=`.
    Inferred,
    /// A Shiny batch, which has no call.
    Implicit,
}

/// Why a backward directive's call site wasn't found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CallSiteFailure {
    /// No `match=` hit, or no `source()` of the child in the parent.
    NotFound,
    /// The parent's text wasn't available.
    ParentContentUnavailable,
}

/// One edge `update_file` would insert, with its provenance.
#[derive(Debug, Clone)]
pub(crate) struct PlannedEdge {
    pub(crate) edge: DependencyEdge,
    pub(crate) entry: PlanEntry,
    /// `None` for batch members and `box::use()` modules, whose targets come
    /// from expansion or module resolution.
    pub(crate) resolution: Option<PlannedResolution>,
    pub(crate) basis: CallSiteBasis,
    pub(crate) failure: Option<CallSiteFailure>,
}

/// Why a detected entry produced no edge candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DropReason {
    /// The target (forward) or parent (backward) is project-excluded.
    Excluded,
    /// The path couldn't be normalized.
    Unresolvable,
    /// A `system.file()` call that didn't resolve.
    SystemFileUnresolved,
    /// A forward directive stands in for this call (`update_file`'s
    /// directive-vs-AST coverage rule).
    Superseded,
}

/// One detected entry that produced no edge candidate.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PlannedDrop {
    pub(crate) entry: PlanEntry,
    pub(crate) reason: DropReason,
    /// The resolved target, when one was found (an excluded target).
    pub(crate) target: Option<Url>,
}

/// One file's planned edges and dropped entries.
#[derive(Debug, Clone, Default)]
pub(crate) struct FileEdgePlan {
    /// Every candidate, in apply order, duplicates included.
    pub(crate) candidates: Vec<PlannedEdge>,
    pub(crate) dropped: Vec<PlannedDrop>,
    /// The base forward paths were resolved against when it wasn't the file's
    /// own directory: an explicit or inherited `# raven: cd`, a Shiny
    /// application directory, or the implicit testthat directory.
    pub(crate) forward_working_directory: Option<PathBuf>,
}

impl FileEdgePlan {
    /// For each candidate, whether apply inserts it: the first candidate per
    /// [`GraphEdgeDedupKey`], in order. Later candidates with the same key
    /// are duplicates. Apply uses this same mask, so the two can't disagree.
    pub(crate) fn survivor_mask(&self) -> Vec<bool> {
        let mut seen: HashSet<GraphEdgeDedupKey> = HashSet::new();
        self.candidates
            .iter()
            .map(|candidate| seen.insert(candidate.edge.graph_dedup_key()))
            .collect()
    }

    /// The edges apply inserts, consuming the plan.
    pub(crate) fn into_surviving_edges(self) -> Vec<DependencyEdge> {
        let mask = self.survivor_mask();
        self.candidates
            .into_iter()
            .zip(mask)
            .filter_map(|(candidate, keep)| keep.then_some(candidate.edge))
            .collect()
    }

    /// The edges apply inserts, cloned.
    pub(crate) fn surviving_edges(&self) -> Vec<DependencyEdge> {
        self.candidates
            .iter()
            .zip(self.survivor_mask())
            .filter(|(_, keep)| *keep)
            .map(|(candidate, _)| candidate.edge.clone())
            .collect()
    }
}

/// A file's latest plan as the graph stores it when tracing is on, with the
/// inputs its [`PlanEntry`] indices point into.
#[derive(Debug, Clone)]
pub(crate) struct StoredFilePlan {
    pub(crate) plan: FileEdgePlan,
    /// The graph metadata the plan was built from (after exclusion filtering).
    pub(crate) metadata: CrossFileMetadata,
    pub(crate) excluded: ExcludedGraphEntries,
}

/// What a traced graph records: each file's latest plan, and the files whose
/// last update returned early because no path context could be built.
#[derive(Debug, Clone, Default)]
pub(crate) struct GraphTrace {
    pub(crate) plans: HashMap<Url, StoredFilePlan>,
    pub(crate) no_path_context: BTreeSet<Url>,
}

/// `update_file` couldn't build a path context for the file, so it changed
/// nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct NoPathContext;

/// Plan the edges `update_file` inserts for `uri`, without touching the graph.
///
/// `meta` is the graph metadata (after exclusion filtering); `excluded` is
/// what that filter removed, which becomes `excluded` drops.
pub(crate) fn plan_file_edges<F>(
    uri: &Url,
    meta: &CrossFileMetadata,
    excluded: &ExcludedGraphEntries,
    workspace_root: Option<&Url>,
    get_content: F,
) -> Result<FileEdgePlan, NoPathContext>
where
    F: Fn(&Url) -> Option<String>,
{
    // Forward sources and directives resolve with the file's `# raven: cd`
    // (explicit or inherited); backward directives always resolve relative to
    // the file's own directory. See `DependencyGraph::update_file`.
    let path_ctx = PathContext::from_metadata(uri, meta, workspace_root).ok_or(NoPathContext)?;
    let backward_path_ctx = PathContext::new(uri, workspace_root).ok_or(NoPathContext)?;

    let mut plan = FileEdgePlan {
        forward_working_directory: path_ctx
            .working_directory
            .clone()
            .or_else(|| path_ctx.application_working_directory.clone())
            .or_else(|| path_ctx.inherited_working_directory.clone())
            .or_else(|| path_ctx.implicit_test_working_directory.clone()),
        ..FileEdgePlan::default()
    };

    let resolve = |outcome: ResolveOutcome| -> Option<(Url, PlannedResolution)> {
        let path = outcome.path?;
        let to = path_to_uri(&path)?;
        Some((
            to,
            PlannedResolution::Resolver {
                path,
                case_mismatch: outcome.case_mismatch,
            },
        ))
    };
    let do_resolve = |path: &str| resolve(resolve_source_path_rich(path, &path_ctx));
    let do_resolve_backward =
        |path: &str| resolve(resolve_backward_path_rich(path, &backward_path_ctx));

    for (index, (_, target)) in excluded.sources.iter().enumerate() {
        plan.dropped.push(PlannedDrop {
            entry: PlanEntry::ExcludedSource(index),
            reason: DropReason::Excluded,
            target: Some(target.clone()),
        });
    }
    for (index, (_, parent)) in excluded.sourced_by.iter().enumerate() {
        plan.dropped.push(PlannedDrop {
            entry: PlanEntry::ExcludedSourcedBy(index),
            reason: DropReason::Excluded,
            target: Some(parent.clone()),
        });
    }

    let mut directive_candidates: Vec<PlannedEdge> = Vec::new();
    // Relationship-only index for directive-vs-AST conflict detection. Edge
    // storage is call-site-aware and deduplicated by `GraphEdgeDedupKey`
    // after conflict resolution.
    let mut directive_from_to: HashSet<DirectiveConflictIdentity> = HashSet::new();

    // Forward directives (`# raven: source` / `run` / `include`).
    for (index, source) in meta.sources.iter().enumerate() {
        if !source.is_directive {
            continue;
        }
        let Some((to_uri, resolution)) = do_resolve(&source.path) else {
            log::trace!(
                "Forward directive @lsp-source '{}' at line {} could not be resolved, skipping edge creation",
                source.path,
                source.line
            );
            plan.dropped.push(PlannedDrop {
                entry: PlanEntry::Source(index),
                reason: DropReason::Unresolvable,
                target: None,
            });
            continue;
        };
        let edge = DependencyEdge {
            from: uri.clone(),
            to: to_uri,
            call_site_line: Some(source.line),
            call_site_column: Some(source.column),
            tar_source_ordinal: source.tar_source_ordinal,
            source_batch_kind: source.source_batch_kind,
            locality: source.locality,
            chdir: source.chdir,
            is_sys_source: source.is_sys_source,
            is_function_scoped: source.is_function_scoped,
            is_directive: true,
            is_backward_directive: false,
            non_lending: false,
            kind: DependencyEdgeKind::OrdinarySource,
        };
        directive_from_to.insert(edge.directive_conflict_identity());
        let basis = if !source.explicit_line {
            CallSiteBasis::Directive
        } else if source.line == u32::MAX {
            CallSiteBasis::Eof
        } else {
            CallSiteBasis::Line
        };
        directive_candidates.push(PlannedEdge {
            edge,
            entry: PlanEntry::Source(index),
            resolution: Some(resolution),
            basis,
            failure: None,
        });
    }

    // Backward directives (`# raven: sourced-by` / `run-by` / `included-by`):
    // forward edges from the named parent to this file.
    for (index, directive) in meta.sourced_by.iter().enumerate() {
        let Some((parent_uri, resolution)) = do_resolve_backward(&directive.path) else {
            plan.dropped.push(PlannedDrop {
                entry: PlanEntry::SourcedBy(index),
                reason: DropReason::Unresolvable,
                target: None,
            });
            continue;
        };
        let child_filename = uri
            .path_segments()
            .and_then(|mut s| s.next_back())
            .unwrap_or("");
        let found = |site: Option<(u32, u32)>| match site {
            Some((line, col)) => ((Some(line), Some(col)), None),
            None => ((None, None), Some(CallSiteFailure::NotFound)),
        };
        let unavailable = (
            (None, None),
            Some(CallSiteFailure::ParentContentUnavailable),
        );
        let ((call_site_line, call_site_column), failure, basis) = match &directive.call_site {
            CallSiteSpec::Line(n) => {
                let basis = if *n == u32::MAX {
                    CallSiteBasis::Eof
                } else {
                    CallSiteBasis::LineEnd
                };
                // End of line.
                ((Some(*n), Some(u32::MAX)), None, basis)
            }
            CallSiteSpec::Match(pattern) => {
                let (site, failure) = match get_content(&parent_uri) {
                    Some(parent_content) => found(resolve_match_pattern(
                        &parent_content,
                        pattern,
                        child_filename,
                    )),
                    None => unavailable,
                };
                (site, failure, CallSiteBasis::Match)
            }
            CallSiteSpec::Default => {
                let (site, failure) = match get_content(&parent_uri) {
                    Some(parent_content) => {
                        found(infer_call_site_from_parent(&parent_content, child_filename))
                    }
                    None => unavailable,
                };
                (site, failure, CallSiteBasis::Inferred)
            }
        };
        let edge = DependencyEdge {
            from: parent_uri,
            to: uri.clone(),
            call_site_line,
            call_site_column,
            tar_source_ordinal: None,
            source_batch_kind: None,
            locality: SourceLocality::Global,
            chdir: false,
            is_sys_source: false,
            is_function_scoped: false,
            is_directive: true,
            is_backward_directive: true,
            non_lending: false,
            kind: DependencyEdgeKind::OrdinarySource,
        };
        directive_from_to.insert(edge.directive_conflict_identity());
        directive_candidates.push(PlannedEdge {
            edge,
            entry: PlanEntry::SourcedBy(index),
            resolution: Some(resolution),
            basis,
            failure,
        });
    }

    // AST-detected sources and source-batch members, with directive-vs-AST
    // conflict resolution (Requirements 4.1-4.5).
    let mut ast_candidates: Vec<PlannedEdge> = Vec::new();
    for (index, source) in meta.sources.iter().enumerate() {
        if source.is_directive {
            continue;
        }
        let resolved = match &source.resolved_uri {
            Some(to) => {
                let resolution =
                    (source.source_batch_kind.is_none()).then_some(PlannedResolution::PreResolved);
                Some((to.clone(), resolution))
            }
            None => do_resolve(&source.path).map(|(to, resolution)| {
                let resolution = source.source_batch_kind.is_none().then_some(resolution);
                (to, resolution)
            }),
        };
        let Some((to_uri, resolution)) = resolved else {
            plan.dropped.push(PlannedDrop {
                entry: PlanEntry::Source(index),
                reason: if source.system_file.is_some() {
                    DropReason::SystemFileUnresolved
                } else {
                    DropReason::Unresolvable
                },
                target: None,
            });
            continue;
        };
        let edge = DependencyEdge {
            from: uri.clone(),
            to: to_uri.clone(),
            call_site_line: Some(source.line),
            call_site_column: Some(source.column),
            tar_source_ordinal: source.tar_source_ordinal,
            source_batch_kind: source.source_batch_kind,
            locality: source.locality,
            chdir: source.chdir,
            is_sys_source: source.is_sys_source,
            is_function_scoped: source.is_function_scoped,
            is_directive: false,
            is_backward_directive: false,
            non_lending: false,
            kind: DependencyEdgeKind::OrdinarySource,
        };
        let pair = edge.directive_conflict_identity();

        if directive_from_to.contains(&pair) {
            let mut found_matching_directive = false;
            let directive_covers_ast = directive_candidates
                .iter()
                .map(|candidate| &candidate.edge)
                .filter(|edge| edge.directive_conflict_identity() == pair)
                .any(|dir_edge| {
                    found_matching_directive = true;
                    let directive_call_site = dir_edge.call_site_identity();

                    if directive_call_site.is_known_directive_call_site() {
                        // A known directive covers only an AST edge at the
                        // same call site. All matching directives participate
                        // because one relationship can retain multiple
                        // distinct call sites.
                        directive_call_site == edge.call_site_identity()
                    } else {
                        // A directive without an explicit call site covers an
                        // AST edge at the same or a later line
                        // (Requirement 4.5).
                        let directive_line = meta
                            .sources
                            .iter()
                            .find(|source| {
                                source.is_directive
                                    && do_resolve(&source.path).map(|(to, _)| to)
                                        == Some(to_uri.clone())
                            })
                            .map(|source| source.line);
                        let ast_is_earlier = match directive_line {
                            Some(directive_line) => source.line < directive_line,
                            None => false,
                        };
                        !ast_is_earlier
                    }
                });

            if directive_covers_ast || !found_matching_directive {
                // The index and edge list are populated together, so the
                // no-match case should be impossible. Preserve the existing
                // fail-closed behavior if they ever drift.
                plan.dropped.push(PlannedDrop {
                    entry: PlanEntry::Source(index),
                    reason: DropReason::Superseded,
                    target: Some(to_uri),
                });
                continue;
            }
        }

        let basis = match source.source_batch_kind {
            Some(
                crate::cross_file::types::SourceBatchKind::ShinyGlobal
                | crate::cross_file::types::SourceBatchKind::Shiny,
            ) => CallSiteBasis::Implicit,
            _ => CallSiteBasis::Call,
        };
        ast_candidates.push(PlannedEdge {
            edge,
            entry: PlanEntry::Source(index),
            resolution,
            basis,
            failure: None,
        });
    }

    // Selective `box::use()` / `import` local-module imports (issue #662):
    // graph-structural, never lending. Package imports and unsupported specs
    // contribute no file edge and are not call sites to a file.
    let mut module_candidates: Vec<PlannedEdge> = Vec::new();
    for (index, request) in meta.selective_import_requests(uri).enumerate() {
        let crate::selective_import::ImportSource::LocalModule(source) = request.source else {
            continue;
        };
        module_candidates.push(PlannedEdge {
            edge: DependencyEdge {
                from: uri.clone(),
                to: source.uri,
                call_site_line: Some(request.provenance.line),
                call_site_column: Some(request.provenance.column),
                tar_source_ordinal: None,
                source_batch_kind: None,
                // Locality/chdir/sys are irrelevant for a non-lending module
                // edge; use neutral values. `is_function_scoped` is carried so
                // a top-level/function-scoped flip changes edge identity and
                // revalidates dependents.
                locality: SourceLocality::Global,
                chdir: false,
                is_sys_source: false,
                is_function_scoped: request.function_scoped,
                is_directive: false,
                is_backward_directive: false,
                non_lending: false,
                kind: DependencyEdgeKind::SelectiveModule,
            },
            entry: PlanEntry::SelectiveImport(index),
            resolution: None,
            basis: CallSiteBasis::Call,
            failure: None,
        });
    }

    // Literal report-document links from supported `{tarchetypes}` factories:
    // forward path semantics, non-lending kind.
    let mut report_candidates: Vec<PlannedEdge> = Vec::new();
    for (index, link) in meta.tarchetypes_document_links.iter().enumerate() {
        let Some((to, resolution)) = do_resolve(&link.path) else {
            plan.dropped.push(PlannedDrop {
                entry: PlanEntry::TarchetypesDocument(index),
                reason: DropReason::Unresolvable,
                target: None,
            });
            continue;
        };
        report_candidates.push(PlannedEdge {
            edge: DependencyEdge {
                from: uri.clone(),
                to,
                call_site_line: Some(link.line),
                call_site_column: Some(link.column),
                tar_source_ordinal: None,
                source_batch_kind: None,
                locality: SourceLocality::Global,
                chdir: false,
                is_sys_source: false,
                is_function_scoped: false,
                is_directive: false,
                is_backward_directive: false,
                non_lending: false,
                kind: DependencyEdgeKind::TarchetypesDocument,
            },
            entry: PlanEntry::TarchetypesDocument(index),
            resolution: Some(resolution),
            basis: CallSiteBasis::Call,
            failure: None,
        });
    }

    plan.candidates = directive_candidates
        .into_iter()
        .chain(ast_candidates)
        .chain(module_candidates)
        .chain(report_candidates)
        .collect();
    Ok(plan)
}
