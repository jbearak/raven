//! `raven graph`: print the cross-file graph Raven stores for a workspace.
//!
//! The graph is built exactly as `raven check` builds it, through the shared
//! setup (`cli::check::prepare_workspace`) with plan tracing on, so
//! each file's edge plan is kept. The report's rows are the stored graph's
//! edges joined to those plans (see `cross_file::dependency::export`), plus the
//! call sites Raven detected and dropped, with the reason it recorded.
//!
//! `--format json` is the contract (`schema_version` 1; see `docs/cli.md`).
//! `--format text` renders the same model for people and may change.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tower_lsp::lsp_types::Url;

use crate::cli::check::{
    PreparedWorkspace, WorkspaceSetup, prepare_workspace, resolve_workspace_root,
};
use crate::cli::shared::{EXIT_OK, EXIT_OPERATOR_ERROR};
use crate::cross_file::dependency::DependencyEdge;
use crate::cross_file::dependency::DependencyEdgeKind;
use crate::cross_file::dependency::export::TracedGraph;
use crate::cross_file::dependency::plan::{
    CallSiteBasis, CallSiteFailure, DropReason, PlanEntry, PlannedEdge, PlannedResolution,
    StoredFilePlan,
};
use crate::cross_file::path_resolve::CaseMismatchRegime;
use crate::cross_file::types::{ForwardSource, SourceBatchKind, SourceLocality};

/// JSON schema version. Adding a field or enum value keeps it; removing or
/// renaming a field, or changing its meaning, increments it.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraphFormat {
    Text,
    Json,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GraphArgs {
    pub workspace: Option<PathBuf>,
    pub config_path: Option<PathBuf>,
    pub no_config: bool,
    pub format: GraphFormat,
}

pub fn parse_args(mut argv: impl Iterator<Item = String>) -> Result<GraphArgs, String> {
    let mut args = GraphArgs {
        workspace: None,
        config_path: None,
        no_config: false,
        format: GraphFormat::Text,
    };
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--workspace" => {
                args.workspace = Some(PathBuf::from(
                    argv.next().ok_or("--workspace needs a path")?,
                ));
            }
            "--config" => {
                args.config_path = Some(PathBuf::from(argv.next().ok_or("--config needs a path")?));
            }
            "--no-config" => args.no_config = true,
            "--format" => {
                args.format = match argv.next().ok_or("--format needs a value")?.as_str() {
                    "text" => GraphFormat::Text,
                    "json" => GraphFormat::Json,
                    other => {
                        return Err(format!(
                            "unknown --format value: {other} (raven graph supports text and json)"
                        ));
                    }
                };
            }
            "--help" => return Err("HELP".into()),
            s if s.starts_with("--") => return Err(format!("unknown flag: {s}")),
            p => {
                return Err(format!(
                    "unexpected argument: {p} (raven graph takes no paths)"
                ));
            }
        }
    }
    Ok(args)
}

pub fn print_help() {
    println!(
        "raven graph {} — print the cross-file graph Raven builds for a workspace

Usage: raven graph [OPTIONS]

Indexes the workspace exactly as `raven check` does, then prints every link
Raven stored between files (`source()` calls, `# raven:` directives, source
batches, `box::use()` modules, report documents), the call sites it detected
but didn't link and why, and warnings when the graph is incomplete.

Options:
  --workspace DIR      Workspace root to index (default: current directory)
  --config PATH        Path to raven.toml or .lintr (default: search upward
                       from --workspace)
  --no-config          Use built-in defaults; ignore raven.toml/.lintr
  --format text|json   Output format (default: text). JSON is the stable
                       contract (schema_version {SCHEMA_VERSION}); text may change.

Exit codes:
  0   The graph was printed (even with dropped call sites or complete: false)
  1   A usage error (unknown flag / bad option value)
  2   Operator error while running (config load failure)
",
        env!("CARGO_PKG_VERSION")
    );
}

pub async fn run(args: GraphArgs) -> i32 {
    let cwd = match std::env::current_dir() {
        Ok(path) => path,
        Err(e) => {
            eprintln!("raven graph: cannot read current directory: {e}");
            return EXIT_OPERATOR_ERROR;
        }
    };
    match build_graph_report(&args, &cwd).await {
        Ok(report) => {
            match args.format {
                GraphFormat::Json => println!(
                    "{}",
                    serde_json::to_string_pretty(&report).expect("graph report serializes")
                ),
                GraphFormat::Text => print!("{}", render_text(&report)),
            }
            EXIT_OK
        }
        Err(code) => code,
    }
}

/// Run the shared setup with tracing on and build the report. Startup notes
/// go to stderr.
pub(crate) async fn build_graph_report(args: &GraphArgs, cwd: &Path) -> Result<GraphReport, i32> {
    let (root, workspace_url) =
        resolve_workspace_root("raven graph", args.workspace.as_deref(), cwd)?;
    let prepared = prepare_workspace(WorkspaceSetup {
        command: "raven graph",
        root: &root,
        workspace_url: &workspace_url,
        no_config: args.no_config,
        config_path: args.config_path.as_deref(),
        explicit_config_base: cwd,
        trace_graph: true,
    })
    .await?;
    for note in &prepared.startup_notes {
        eprintln!("{note}");
    }
    Ok(report_from_prepared(&prepared, &root))
}

// ---------------------------------------------------------------------------
// The JSON model. Field order and names are the contract.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct GraphReport {
    pub(crate) schema_version: u32,
    pub(crate) raven_version: String,
    pub(crate) root: String,
    pub(crate) package_mode: bool,
    pub(crate) complete: bool,
    pub(crate) warnings: Vec<String>,
    pub(crate) files: Vec<FileRow>,
    pub(crate) edges: Vec<EdgeRow>,
    pub(crate) dropped: Vec<DroppedRow>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct FileRow {
    pub(crate) path: String,
    pub(crate) indexed: bool,
    pub(crate) exists: bool,
    pub(crate) self_contained: bool,
    pub(crate) syntax_errors: bool,
    pub(crate) working_directory: Option<WorkingDirectory>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct WorkingDirectory {
    pub(crate) raw: String,
    pub(crate) resolved: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Position {
    pub(crate) line: u32,
    pub(crate) character: Option<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct CallSite {
    pub(crate) basis: &'static str,
    pub(crate) position: Option<Position>,
    pub(crate) failure: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct DirectiveLocation {
    pub(crate) file: String,
    pub(crate) line: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct SystemFile {
    pub(crate) package: String,
    pub(crate) parts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct Resolution {
    pub(crate) endpoint: &'static str,
    pub(crate) exists: bool,
    pub(crate) case: Option<&'static str>,
    pub(crate) outside_root: bool,
    pub(crate) working_directory: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct EdgeRow {
    pub(crate) caller: String,
    pub(crate) target: String,
    pub(crate) kind: &'static str,
    pub(crate) origin: &'static str,
    pub(crate) call_site: Option<CallSite>,
    pub(crate) directive: Option<DirectiveLocation>,
    pub(crate) raw_path: Option<String>,
    pub(crate) system_file: Option<SystemFile>,
    pub(crate) batch_ordinal: Option<u32>,
    pub(crate) locality: Option<&'static str>,
    pub(crate) chdir: Option<bool>,
    pub(crate) function_scoped: Option<bool>,
    pub(crate) guarded_by_file_exists: Option<bool>,
    pub(crate) resolution: Option<Resolution>,
    pub(crate) portable_from_root: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct DroppedRow {
    pub(crate) caller: String,
    pub(crate) position: Option<Position>,
    pub(crate) kind: Option<&'static str>,
    pub(crate) origin: Option<&'static str>,
    pub(crate) raw_path: Option<String>,
    pub(crate) system_file: Option<SystemFile>,
    pub(crate) target: Option<String>,
    pub(crate) reason: &'static str,
}

// ---------------------------------------------------------------------------
// Building the report.
// ---------------------------------------------------------------------------

/// Paths are relative to the canonicalized root with `/` separators, or
/// absolute outside it. A URI that isn't a file path prints as the URI.
///
/// `raven parse` prints its `path` values with this function too, so a parsed
/// document joins the graph's `files[].path` byte for byte.
pub(crate) fn display_path(uri: &Url, root: &Path) -> String {
    match uri.to_file_path() {
        Ok(path) => display_fs_path(&path, root),
        Err(()) => uri.to_string(),
    }
}

/// The root itself (a working directory) is `.`.
pub(crate) fn display_fs_path(path: &Path, root: &Path) -> String {
    match path.strip_prefix(root) {
        Ok(relative) if relative.as_os_str().is_empty() => ".".to_string(),
        Ok(relative) => relative
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/"),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

fn locality_name(locality: SourceLocality) -> &'static str {
    match locality {
        SourceLocality::Global => "global",
        SourceLocality::CurrentFrame => "current_frame",
        SourceLocality::NonInheriting => "non_inheriting",
    }
}

fn edge_kind(edge: &DependencyEdge) -> &'static str {
    match edge.kind {
        DependencyEdgeKind::SelectiveModule => "box",
        DependencyEdgeKind::TarchetypesDocument => "tarchetypes_document",
        DependencyEdgeKind::OrdinarySource => match edge.source_batch_kind {
            Some(batch) => batch_kind_name(batch),
            None if edge.is_sys_source => "sys_source",
            None => "source",
        },
    }
}

fn batch_kind_name(batch: SourceBatchKind) -> &'static str {
    match batch {
        SourceBatchKind::TarSource => "tar_source",
        SourceBatchKind::ListFiles => "list_files",
        SourceBatchKind::ShinyGlobal => "shiny_global",
        SourceBatchKind::Shiny => "shiny",
    }
}

fn source_kind(source: &ForwardSource) -> &'static str {
    match source.source_batch_kind {
        Some(batch) => batch_kind_name(batch),
        None if source.is_sys_source => "sys_source",
        None => "source",
    }
}

fn edge_origin(edge: &DependencyEdge) -> &'static str {
    if edge.is_backward_directive {
        "backward_directive"
    } else if edge.is_directive {
        "directive"
    } else {
        "call"
    }
}

fn basis_name(basis: CallSiteBasis) -> &'static str {
    match basis {
        CallSiteBasis::Call => "call",
        CallSiteBasis::Directive => "directive",
        CallSiteBasis::Line => "line",
        CallSiteBasis::LineEnd => "line_end",
        CallSiteBasis::Eof => "eof",
        CallSiteBasis::Match => "match",
        CallSiteBasis::Inferred => "inferred",
        CallSiteBasis::Implicit => "implicit",
    }
}

fn failure_name(failure: CallSiteFailure) -> &'static str {
    match failure {
        CallSiteFailure::NotFound => "not_found",
        CallSiteFailure::ParentContentUnavailable => "parent_content_unavailable",
    }
}

fn reason_name(reason: DropReason) -> &'static str {
    match reason {
        DropReason::Excluded => "excluded",
        DropReason::Unresolvable => "unresolvable",
        DropReason::SystemFileUnresolved => "system_file_unresolved",
        DropReason::Superseded => "superseded",
    }
}

/// The raw path for a `source`/`sys_source` call or forward directive: null
/// for a `system.file()` call (Raven rewrites its path) and batch members.
fn source_raw_path(source: &ForwardSource) -> Option<String> {
    (source.system_file.is_none() && source.source_batch_kind.is_none())
        .then(|| source.path.clone())
}

fn system_file_of(source: &ForwardSource) -> Option<SystemFile> {
    source.system_file.as_ref().map(|call| SystemFile {
        package: call.package.clone(),
        parts: call.parts.clone(),
    })
}

/// The position recorded for a metadata entry in the file that holds it.
fn source_position(source: &ForwardSource) -> Option<Position> {
    (source.line != u32::MAX).then_some(Position {
        line: source.line,
        character: Some(source.column),
    })
}

/// The call-site position: null for `eof` and for a backward call site that
/// wasn't found; `character` null for `line_end`.
fn call_site_position(edge: &DependencyEdge, planned: &PlannedEdge) -> Option<Position> {
    if planned.failure.is_some() || planned.basis == CallSiteBasis::Eof {
        return None;
    }
    let line = edge.call_site_line?;
    let character = match planned.basis {
        CallSiteBasis::LineEnd => None,
        _ => edge.call_site_column,
    };
    Some(Position { line, character })
}

/// `exact` / `filesystem_folds_case` / `raven_leniency`; null when the file
/// doesn't exist.
fn case_name(exists: bool, case_mismatch: Option<CaseMismatchRegime>) -> Option<&'static str> {
    if !exists {
        return None;
    }
    Some(match case_mismatch {
        None => "exact",
        Some(CaseMismatchRegime::CaseInsensitiveFs) => "filesystem_folds_case",
        Some(CaseMismatchRegime::CaseSensitiveFs) => "raven_leniency",
    })
}

/// An exact-case portability check for code that runs from the project root:
/// `raw_path` has no leading `/`, and the resolved endpoint is exactly
/// `ROOT/raw_path`, normalized, with the same case, and exists.
fn portable_from_root(raw_path: &str, resolved: &Path, exists: bool, root: &Path) -> bool {
    if !exists || raw_path.starts_with('/') || Path::new(raw_path).is_absolute() {
        return false;
    }
    crate::cross_file::path_resolve::normalize_path_public(&root.join(raw_path))
        .is_some_and(|expected| expected.as_os_str() == resolved.as_os_str())
}

fn edge_row(
    edge: &DependencyEdge,
    planned: Option<(&StoredFilePlan, &PlannedEdge)>,
    root: &Path,
) -> EdgeRow {
    let backward = edge.is_backward_directive;
    let is_batch = edge.source_batch_kind.is_some();
    let kind = edge_kind(edge);
    let source_like = edge.kind == DependencyEdgeKind::OrdinarySource && !backward;
    let mut row = EdgeRow {
        caller: display_path(&edge.from, root),
        target: display_path(&edge.to, root),
        kind,
        origin: edge_origin(edge),
        call_site: None,
        directive: None,
        raw_path: None,
        system_file: None,
        batch_ordinal: if is_batch {
            edge.tar_source_ordinal
        } else {
            None
        },
        locality: source_like.then(|| locality_name(edge.locality)),
        chdir: (!backward).then_some(edge.chdir),
        function_scoped: (!backward).then_some(edge.is_function_scoped),
        guarded_by_file_exists: None,
        resolution: None,
        portable_from_root: None,
    };
    let Some((stored, candidate)) = planned else {
        // No plan record: a bug the warnings report. Plan annotations stay null.
        return row;
    };
    row.call_site = Some(CallSite {
        basis: basis_name(candidate.basis),
        position: call_site_position(edge, candidate),
        failure: candidate.failure.map(failure_name),
    });
    row.guarded_by_file_exists = Some(false);
    match candidate.entry {
        PlanEntry::Source(index) => {
            let source = &stored.metadata.sources[index];
            if source.is_directive {
                row.directive = Some(DirectiveLocation {
                    file: display_path(&edge.from, root),
                    line: source.directive_line,
                });
            }
            row.raw_path = source_raw_path(source);
            row.system_file = system_file_of(source);
            row.guarded_by_file_exists = Some(source.guarded_by_file_exists);
        }
        PlanEntry::SourcedBy(index) => {
            let directive = &stored.metadata.sourced_by[index];
            row.directive = Some(DirectiveLocation {
                file: display_path(&edge.to, root),
                line: directive.directive_line,
            });
            row.raw_path = Some(directive.path.clone());
        }
        PlanEntry::TarchetypesDocument(index) => {
            row.raw_path = Some(
                stored.metadata.tarchetypes_document_links[index]
                    .path
                    .clone(),
            );
        }
        PlanEntry::SelectiveImport(_)
        | PlanEntry::ExcludedSource(_)
        | PlanEntry::ExcludedSourcedBy(_) => {}
    }
    // The endpoint a backward directive's written path names is the parent.
    let (endpoint, endpoint_uri) = if backward {
        ("caller", &edge.from)
    } else {
        ("target", &edge.to)
    };
    row.resolution = match &candidate.resolution {
        None => None,
        Some(PlannedResolution::Resolver {
            path,
            case_mismatch,
        }) => {
            let exists = path.exists();
            Some(Resolution {
                endpoint,
                exists,
                case: case_name(exists, *case_mismatch),
                outside_root: !path.starts_with(root),
                working_directory: if backward {
                    None
                } else {
                    stored
                        .plan
                        .forward_working_directory
                        .as_deref()
                        .map(|dir| display_fs_path(dir, root))
                },
            })
        }
        Some(PlannedResolution::PreResolved) => {
            let path = endpoint_uri.to_file_path().ok();
            let exists = path.as_deref().is_some_and(Path::exists);
            Some(Resolution {
                endpoint,
                exists,
                case: case_name(exists, None),
                outside_root: path.as_deref().is_none_or(|p| !p.starts_with(root)),
                working_directory: None,
            })
        }
    };
    if !backward
        && !is_batch
        && let Some(raw_path) = &row.raw_path
    {
        let resolved = match &candidate.resolution {
            Some(PlannedResolution::Resolver { path, .. }) => Some(path.clone()),
            _ => edge.to.to_file_path().ok(),
        };
        let exists = row.resolution.as_ref().is_some_and(|r| r.exists);
        row.portable_from_root = Some(
            resolved.is_some_and(|resolved| portable_from_root(raw_path, &resolved, exists, root)),
        );
    }
    row
}

/// A dropped row's fields for a metadata entry of `owner`'s stored plan.
/// `caller` is the file that holds the entry.
fn dropped_row(
    owner: &Url,
    stored: &StoredFilePlan,
    entry: PlanEntry,
    target: Option<&Url>,
    reason: &'static str,
    root: &Path,
) -> DroppedRow {
    let mut row = DroppedRow {
        caller: display_path(owner, root),
        position: None,
        kind: None,
        origin: None,
        raw_path: None,
        system_file: None,
        target: target.map(|t| display_path(t, root)),
        reason,
    };
    let source_fields = |row: &mut DroppedRow, source: &ForwardSource| {
        row.position = source_position(source);
        row.kind = Some(source_kind(source));
        row.origin = Some(if source.is_directive {
            "directive"
        } else {
            "call"
        });
        row.raw_path = source_raw_path(source);
        row.system_file = system_file_of(source);
    };
    let directive_fields =
        |row: &mut DroppedRow, directive: &crate::cross_file::types::BackwardDirective| {
            row.position = Some(Position {
                line: directive.directive_line,
                character: Some(0),
            });
            row.kind = Some("source");
            row.origin = Some("backward_directive");
            row.raw_path = Some(directive.path.clone());
        };
    match entry {
        PlanEntry::Source(index) => source_fields(&mut row, &stored.metadata.sources[index]),
        PlanEntry::ExcludedSource(index) => {
            source_fields(&mut row, &stored.excluded.sources[index].0)
        }
        PlanEntry::SourcedBy(index) => {
            directive_fields(&mut row, &stored.metadata.sourced_by[index])
        }
        PlanEntry::ExcludedSourcedBy(index) => {
            directive_fields(&mut row, &stored.excluded.sourced_by[index].0)
        }
        PlanEntry::SelectiveImport(index) => {
            if let Some(request) = stored.metadata.selective_import_requests(owner).nth(index) {
                row.position = Some(Position {
                    line: request.provenance.line,
                    character: Some(request.provenance.column),
                });
            }
            row.kind = Some("box");
            row.origin = Some("call");
        }
        PlanEntry::TarchetypesDocument(index) => {
            let link = &stored.metadata.tarchetypes_document_links[index];
            row.position = Some(Position {
                line: link.line,
                character: Some(link.column),
            });
            row.kind = Some("tarchetypes_document");
            row.origin = Some("call");
            row.raw_path = Some(link.path.clone());
        }
    }
    row
}

fn position_sort_key(position: Option<Position>) -> (u8, u32, u32) {
    match position {
        Some(Position { line, character }) => (0, line, character.unwrap_or(u32::MAX)),
        None => (1, 0, 0),
    }
}

/// Facts the report reads from the prepared state, separated from the graph
/// so the join and the file inventory can be built from one place.
fn report_from_prepared(prepared: &PreparedWorkspace, root: &Path) -> GraphReport {
    let state = &prepared.state;
    let traced = state
        .cross_file_graph
        .traced()
        .expect("raven graph sets up a traced graph");
    let artifacts: BTreeMap<Url, crate::workspace_index::ArtifactEntry> =
        state.workspace_index.artifact_iter().into_iter().collect();

    let edges = edge_rows(&traced, root);
    let dropped = dropped_rows(&traced, root);
    let (complete, warnings) = completeness(prepared, &traced, &artifacts, root);

    // Every indexed file and every edge endpoint.
    let mut uris: BTreeSet<Url> = artifacts.keys().cloned().collect();
    for joined in &traced.edges {
        uris.insert(joined.edge.from.clone());
        uris.insert(joined.edge.to.clone());
    }
    let mut files: Vec<FileRow> = uris
        .iter()
        .map(|uri| file_row(state, uri, artifacts.get(uri), root))
        .collect();
    files.sort();

    GraphReport {
        schema_version: SCHEMA_VERSION,
        raven_version: env!("CARGO_PKG_VERSION").to_string(),
        root: root.to_string_lossy().into_owned(),
        package_mode: state.package_state.workspace().is_some(),
        complete,
        warnings,
        files,
        edges,
        dropped,
    }
}

fn edge_rows(traced: &TracedGraph<'_>, root: &Path) -> Vec<EdgeRow> {
    let mut rows: Vec<EdgeRow> = traced
        .edges
        .iter()
        .map(|joined| edge_row(joined.edge, joined.planned, root))
        .collect();
    rows.sort_by(|a, b| {
        let key = |row: &EdgeRow| {
            (
                row.caller.clone(),
                position_sort_key(row.call_site.as_ref().and_then(|c| c.position)),
                row.batch_ordinal.map_or((1, 0), |o| (0, o)),
                row.kind,
                row.origin,
                row.target.clone(),
            )
        };
        key(a).cmp(&key(b))
    });
    rows
}

fn dropped_rows(traced: &TracedGraph<'_>, root: &Path) -> Vec<DroppedRow> {
    let mut rows = Vec::new();
    for (owner, stored) in traced.plans {
        for drop in &stored.plan.dropped {
            rows.push(dropped_row(
                owner,
                stored,
                drop.entry,
                drop.target.as_ref(),
                reason_name(drop.reason),
                root,
            ));
        }
    }
    for duplicate in &traced.duplicates {
        let edge = &duplicate.candidate.edge;
        let target = if edge.is_backward_directive {
            &edge.from
        } else {
            &edge.to
        };
        rows.push(dropped_row(
            duplicate.owner,
            duplicate.stored,
            duplicate.candidate.entry,
            Some(target),
            "duplicate",
            root,
        ));
    }
    for uri in &traced.no_path_context {
        rows.push(DroppedRow {
            caller: display_path(uri, root),
            position: None,
            kind: None,
            origin: None,
            raw_path: None,
            system_file: None,
            target: None,
            reason: "no_path_context",
        });
    }
    rows.sort_by(|a, b| {
        let key = |row: &DroppedRow| {
            (
                row.caller.clone(),
                position_sort_key(row.position),
                row.kind,
                row.origin,
                row.target.clone(),
                row.reason,
            )
        };
        key(a).cmp(&key(b))
    });
    rows
}

fn file_row(
    state: &crate::state::WorldState,
    uri: &Url,
    artifact: Option<&crate::workspace_index::ArtifactEntry>,
    root: &Path,
) -> FileRow {
    let path = uri.to_file_path().ok();
    let exists = path.as_deref().is_some_and(Path::exists);
    let mut row = FileRow {
        path: display_path(uri, root),
        indexed: artifact.is_some(),
        exists,
        self_contained: false,
        syntax_errors: false,
        working_directory: None,
    };
    let Some(artifact) = artifact else {
        return row;
    };
    let metadata = &artifact.metadata;
    row.self_contained = metadata.standalone;
    row.working_directory = metadata.working_directory.as_ref().map(|raw| {
        let workspace_root = Url::from_file_path(root).ok();
        let resolved = crate::cross_file::path_resolve::PathContext::from_metadata(
            uri,
            metadata,
            workspace_root.as_ref(),
        )
        .and_then(|ctx| ctx.working_directory)
        .map(|dir| display_fs_path(&dir, root));
        WorkingDirectory {
            raw: raw.clone(),
            resolved,
        }
    });
    row.syntax_errors = match state.workspace_index.get(uri) {
        Some(entry) => entry.tree.is_some_and(|tree| tree.root_node().has_error()),
        // Artifact without full text: parse the file once to answer.
        None => path
            .as_deref()
            .and_then(|path| std::fs::read(path).ok())
            .map(|bytes| {
                let text = String::from_utf8_lossy(&bytes);
                crate::state::Document::new_with_uri(&text, None, uri)
                    .tree
                    .is_some_and(|tree| tree.root_node().has_error())
            })
            .unwrap_or(false),
    };
    row
}

/// `complete` and the warnings. `complete` means every file the scan
/// discovered has a stored plan.
fn completeness(
    prepared: &PreparedWorkspace,
    traced: &TracedGraph<'_>,
    artifacts: &BTreeMap<Url, crate::workspace_index::ArtifactEntry>,
    root: &Path,
) -> (bool, Vec<String>) {
    let scan = &prepared.scan;
    let state = &prepared.state;
    let mut warnings = Vec::new();
    let list = |paths: &[String]| paths.join(", ");

    let unprocessed: BTreeSet<PathBuf> = scan.unprocessed.iter().cloned().collect();
    let no_path_context: HashSet<&Url> = traced.no_path_context.iter().copied().collect();
    let mut failed: Vec<String> = scan
        .unprocessed
        .iter()
        .map(|path| display_fs_path(path, root))
        .collect();
    let mut evicted: Vec<String> = Vec::new();
    for path in &scan.discovered {
        if unprocessed.contains(path) {
            continue;
        }
        let Ok(uri) = Url::from_file_path(path) else {
            continue;
        };
        if traced.plans.contains_key(&uri) {
            continue;
        }
        if no_path_context.contains(&uri) {
            failed.push(display_fs_path(path, root));
        } else {
            evicted.push(display_fs_path(path, root));
        }
    }
    failed.sort();
    failed.dedup();
    evicted.sort();
    if !failed.is_empty() {
        warnings.push(format!(
            "{} file(s) couldn't be read or processed, so their links are missing: {}",
            failed.len(),
            list(&failed)
        ));
    }
    if !evicted.is_empty() {
        warnings.push(format!(
            "{} file(s) were evicted from the index's artifact capacity before the graph was built, so their links are missing: {}",
            evicted.len(),
            list(&evicted)
        ));
    }
    let complete = failed.is_empty() && evicted.is_empty();

    let mut no_full_text: Vec<String> = artifacts
        .keys()
        .filter(|uri| !state.workspace_index.contains(uri))
        .map(|uri| display_path(uri, root))
        .collect();
    no_full_text.sort();
    if !no_full_text.is_empty() {
        warnings.push(format!(
            "{} indexed file(s) had no full text available, which can leave backward call sites into them unfound: {}",
            no_full_text.len(),
            list(&no_full_text)
        ));
    }
    if !scan.failed_list_files_batches.is_empty() {
        let batches: Vec<String> = scan
            .failed_list_files_batches
            .iter()
            .map(|(uri, failure)| {
                format!(
                    "{}:{}:{} (directory {:?}): {}",
                    display_path(uri, root),
                    failure.line + 1,
                    failure.column + 1,
                    failure.directory,
                    failure.reason
                )
            })
            .collect();
        warnings.push(format!(
            "{} list.files() source batch(es) failed and contributed no members: {}",
            batches.len(),
            batches.join("; ")
        ));
    }
    if traced.unplanned_edges > 0 {
        warnings.push(format!(
            "{} graph edge(s) have no plan record, so their annotations are null (a Raven bug)",
            traced.unplanned_edges
        ));
    }
    if traced.planned_edges_missing > 0 {
        warnings.push(format!(
            "{} planned edge(s) are no longer in the graph (for example, a call into an external file the system.file() pass removed), so those call sites are in neither edges nor dropped",
            traced.planned_edges_missing
        ));
    }
    (complete, warnings)
}

// ---------------------------------------------------------------------------
// Text output.
// ---------------------------------------------------------------------------

fn text_position(position: Option<Position>) -> String {
    match position {
        Some(Position {
            line,
            character: Some(character),
        }) => format!("{}:{}", line + 1, character + 1),
        Some(Position {
            line,
            character: None,
        }) => format!("{}", line + 1),
        None => "-".to_string(),
    }
}

/// One line per edge, then dropped call sites, then warnings.
pub(crate) fn render_text(report: &GraphReport) -> String {
    let mut out = String::new();
    for edge in &report.edges {
        let position = text_position(edge.call_site.as_ref().and_then(|c| c.position));
        let mut details = vec![edge.kind.to_string(), edge.origin.to_string()];
        if let Some(locality) = edge.locality {
            details.push(locality.to_string());
        }
        if let Some(ordinal) = edge.batch_ordinal {
            details.push(format!("#{ordinal}"));
        }
        if let Some(resolution) = &edge.resolution
            && !resolution.exists
        {
            details.push("missing".to_string());
        }
        if edge.portable_from_root == Some(false) {
            details.push("not portable from root".to_string());
        }
        out.push_str(&format!(
            "{}:{} -> {} ({})\n",
            edge.caller,
            position,
            edge.target,
            details.join(", ")
        ));
    }
    if !report.dropped.is_empty() {
        out.push_str("\nDropped:\n");
        for row in &report.dropped {
            let what = row
                .raw_path
                .clone()
                .or_else(|| row.target.clone())
                .unwrap_or_default();
            out.push_str(&format!(
                "{}:{} {} ({})\n",
                row.caller,
                text_position(row.position),
                what,
                row.reason
            ));
        }
    }
    if !report.warnings.is_empty() {
        out.push_str("\nWarnings:\n");
        for warning in &report.warnings {
            out.push_str(&format!("{warning}\n"));
        }
    }
    out.push_str(&format!(
        "\n{} edge(s), {} dropped, {} file(s){}\n",
        report.edges.len(),
        report.dropped.len(),
        report.files.len(),
        if report.complete { "" } else { " (incomplete)" }
    ));
    out
}

/// The golden workspace (`crates/raven/tests/fixtures/graph/workspace`)
/// copied to `<tmp>/ws`, with `<tmp>/outside.R` beside it for the
/// outside-the-workspace edge. Returns the temporary directory and `ws`.
#[cfg(test)]
pub(crate) fn golden_workspace() -> (tempfile::TempDir, PathBuf) {
    fn copy_dir(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let dest = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_dir(&entry.path(), &dest);
            } else {
                std::fs::copy(entry.path(), dest).unwrap();
            }
        }
    }
    let tmp = tempfile::TempDir::new().unwrap();
    let ws = tmp.path().join("ws");
    copy_dir(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/graph/workspace"),
        &ws,
    );
    std::fs::write(tmp.path().join("outside.R"), "o <- 1\n").unwrap();
    (tmp, ws)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn golden_path() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/graph/golden.json")
    }

    fn write(root: &Path, file: &str, text: &str) {
        let path = root.join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn args(workspace: &Path, no_config: bool) -> GraphArgs {
        GraphArgs {
            workspace: Some(workspace.to_path_buf()),
            config_path: None,
            no_config,
            format: GraphFormat::Json,
        }
    }

    fn report(workspace: &Path, no_config: bool) -> GraphReport {
        tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(build_graph_report(&args(workspace, no_config), workspace))
            .unwrap_or_else(|code| panic!("raven graph setup failed with {code}"))
    }

    fn edge<'r>(report: &'r GraphReport, caller: &str, target: &str, line: u32) -> &'r EdgeRow {
        report
            .edges
            .iter()
            .find(|e| {
                e.caller == caller
                    && e.target == target
                    && e.call_site
                        .as_ref()
                        .and_then(|c| c.position)
                        .map(|p| p.line)
                        == Some(line)
            })
            .unwrap_or_else(|| panic!("no edge {caller}:{line} -> {target}"))
    }

    /// The report as JSON with the machine-specific parts replaced: the
    /// temporary root and its parent, the version, and the case regime
    /// (`filesystem_folds_case` on macOS, `raven_leniency` on Linux).
    fn normalized_json(mut report: GraphReport, tmp: &Path) -> String {
        report.raven_version = "<VERSION>".into();
        let root = report.root.clone();
        let parent = std::fs::canonicalize(tmp).unwrap();
        let json = serde_json::to_string_pretty(&report).unwrap();
        json.replace(&root, "<ROOT>")
            .replace(&format!("{}/", parent.display()), "<TMP>/")
            .replace("\"filesystem_folds_case\"", "\"<case differs>\"")
            .replace("\"raven_leniency\"", "\"<case differs>\"")
            + "\n"
    }

    /// The full report for the golden workspace. Regenerate after an intended
    /// change with `UPDATE_GRAPH_GOLDEN=1 cargo test -p raven --lib cli::graph`.
    #[cfg(unix)]
    #[test]
    fn golden_fixture() {
        let (tmp, ws) = golden_workspace();
        let actual = normalized_json(report(&ws, false), tmp.path());
        if std::env::var_os("UPDATE_GRAPH_GOLDEN").is_some() {
            std::fs::write(golden_path(), &actual).unwrap();
        }
        let expected = std::fs::read_to_string(golden_path()).unwrap();
        assert_eq!(
            actual, expected,
            "raven graph output changed; rerun with UPDATE_GRAPH_GOLDEN=1 if intended"
        );
    }

    /// The two `local = TRUE` shapes (inside `local()` and at the top level)
    /// and the three `portable_from_root: false` cases,
    /// spelled out so the golden file isn't the only record of them.
    #[cfg(unix)]
    #[test]
    fn local_true_shapes_and_portability() {
        let (_tmp, ws) = golden_workspace();
        let report = report(&ws, false);

        // d <- local({ source("R/a.R", local = TRUE); d })
        let local_block = edge(&report, "main.R", "R/a.R", 2);
        assert_eq!(local_block.locality, Some("current_frame"));
        assert_eq!(local_block.portable_from_root, Some(true));
        // Top-level source("R/b.R", local = TRUE) evaluates in the file's frame.
        let top_level = edge(&report, "main.R", "R/b.R", 1);
        assert_eq!(top_level.locality, Some("global"));
        assert_eq!(top_level.portable_from_root, Some(true));

        // Found only in the caller's directory.
        let caller_dir = edge(&report, "tools/run.R", "tools/util.R", 0);
        assert!(caller_dir.resolution.as_ref().unwrap().exists);
        assert_eq!(caller_dir.portable_from_root, Some(false));
        // Leading `/`: root-relative to Raven, absolute to R.
        let leading_slash = edge(&report, "tools/run.R", "R/top.R", 1);
        assert_eq!(leading_slash.raw_path.as_deref(), Some("/R/top.R"));
        assert_eq!(leading_slash.portable_from_root, Some(false));
        // Case mismatch.
        let case = edge(&report, "tools/run.R", "R/top.R", 2);
        assert_ne!(case.resolution.as_ref().unwrap().case, Some("exact"));
        assert_eq!(case.portable_from_root, Some(false));
    }

    /// Every `line` in the JSON is 0-based, as documented in `docs/cli.md`
    /// ("Graph JSON"): `directive.line`, `call_site.position.line`, and
    /// `dropped[].position.line`. A directive on a file's first line has
    /// `line: 0`, and a backward directive's 1-based `line=N` appears as
    /// `N - 1`.
    #[test]
    fn line_fields_are_zero_based() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path();
        write(ws, "raven.toml", "[workspace]\nexclude = [\"skip/\"]\n");
        write(
            ws,
            "main.R",
            "# raven: source R/a.R\nsource(\"R/b.R\")\nx <- 1\n",
        );
        write(ws, "R/a.R", "a <- 1\n");
        write(ws, "R/b.R", "b <- 1\n");
        write(
            ws,
            "R/c.R",
            "\n\n# raven: sourced-by ../main.R line=3\nc <- x\n",
        );
        write(ws, "R/d.R", "d <- 1\nsource(\"skip/s.R\")\n");
        write(ws, "skip/s.R", "s <- 1\n");
        let report = report(ws, false);

        // Forward directive on line 1 of main.R.
        let directive = edge(&report, "main.R", "R/a.R", 0);
        let location = directive.directive.as_ref().unwrap();
        assert_eq!((location.file.as_str(), location.line), ("main.R", 0));
        // source() call on line 2 of main.R.
        let call = edge(&report, "main.R", "R/b.R", 1);
        assert!(call.directive.is_none());
        // Backward directive on line 3 of R/c.R, naming main.R's line 3.
        let backward = edge(&report, "main.R", "R/c.R", 2);
        let location = backward.directive.as_ref().unwrap();
        assert_eq!((location.file.as_str(), location.line), ("R/c.R", 2));
        // Dropped source() call on line 2 of R/d.R.
        let dropped = report
            .dropped
            .iter()
            .find(|d| d.caller == "R/d.R")
            .unwrap_or_else(|| panic!("no dropped row for R/d.R: {:?}", report.dropped));
        assert_eq!(dropped.reason, "excluded");
        assert_eq!(dropped.position.map(|p| p.line), Some(1));
    }

    fn prepared(workspace: &Path, no_config: bool, trace_graph: bool) -> PreparedWorkspace {
        let root = std::fs::canonicalize(workspace).unwrap();
        let workspace_url = Url::from_file_path(&root).unwrap();
        tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(prepare_workspace(WorkspaceSetup {
                command: "raven graph",
                root: &root,
                workspace_url: &workspace_url,
                no_config,
                config_path: None,
                explicit_config_base: &root,
                trace_graph,
            }))
            .unwrap_or_else(|code| panic!("setup failed with {code}"))
    }

    /// `raven graph` (tracing) and `raven check` (no tracing) build the same
    /// graph through the shared setup.
    #[cfg(unix)]
    #[test]
    fn tracing_does_not_change_the_workspace_graph() {
        let (_tmp, ws) = golden_workspace();
        let traced = prepared(&ws, false, true);
        let untraced = prepared(&ws, false, false);
        assert!(traced.state.cross_file_graph.traced().is_some());
        assert!(untraced.state.cross_file_graph.traced().is_none());
        assert_eq!(
            traced.state.cross_file_graph.edge_identity_snapshot(),
            untraced.state.cross_file_graph.edge_identity_snapshot()
        );
    }

    #[test]
    fn lowered_artifact_capacity_is_incomplete() {
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "raven.toml",
            "[crossFile.cache]\nworkspaceIndexMaxEntries = 2\n",
        );
        for name in ["a", "b", "c", "d", "e"] {
            write(tmp.path(), &format!("{name}.R"), "x <- 1\n");
        }
        let report = report(tmp.path(), false);
        assert!(!report.complete);
        assert!(
            report
                .warnings
                .iter()
                .any(|w| w.starts_with("3 file(s) were evicted")),
            "{:?}",
            report.warnings
        );
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_file_is_incomplete() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "main.R", "source(\"a.R\")\n");
        write(tmp.path(), "a.R", "x <- 1\n");
        write(tmp.path(), "locked.R", "y <- 1\n");
        let locked = tmp.path().join("locked.R");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(&locked).is_ok() {
            // Running as root: permissions don't stop the read.
            return;
        }
        let report = report(tmp.path(), true);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!report.complete);
        assert!(
            report
                .warnings
                .iter()
                .any(|w| w.starts_with("1 file(s) couldn't be read") && w.ends_with("locked.R")),
            "{:?}",
            report.warnings
        );
        assert_eq!(report.edges.len(), 1);
    }

    #[test]
    fn oversized_file_stays_complete() {
        let tmp = TempDir::new().unwrap();
        let mut big = String::from("source(\"a.R\")\n");
        while big.len() <= 600 * 1024 {
            big.push_str("# padding padding padding padding padding padding padding\n");
        }
        write(tmp.path(), "big.R", &big);
        write(tmp.path(), "a.R", "x <- 1\n");
        let report = report(tmp.path(), true);
        assert!(report.complete, "{:?}", report.warnings);
        let row = edge(&report, "big.R", "a.R", 0);
        assert!(row.resolution.as_ref().unwrap().exists);
    }

    #[test]
    fn list_files_batch_over_cap_warns_and_has_no_members() {
        let tmp = TempDir::new().unwrap();
        for i in 0..257 {
            write(tmp.path(), &format!("many/f{i:03}.R"), "x <- 1\n");
        }
        write(
            tmp.path(),
            "main.R",
            "for (file in list.files(\"many\", pattern = \"[.]R$\", full.names = TRUE)) source(file)\n",
        );
        let report = report(tmp.path(), true);
        assert!(report.edges.iter().all(|e| e.kind != "list_files"));
        assert!(
            report
                .warnings
                .iter()
                .any(|w| w.starts_with("1 list.files() source batch(es) failed")
                    && w.contains("main.R:1:")),
            "{:?}",
            report.warnings
        );
        // A failed batch isn't a missing plan.
        assert!(report.complete);
    }

    #[test]
    fn package_mode_is_reported() {
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "DESCRIPTION",
            "Package: graphpkg\nVersion: 0.1.0\nTitle: Test\n",
        );
        write(tmp.path(), "R/f.R", "f <- function() 1\n");
        assert!(report(tmp.path(), true).package_mode);

        let plain = TempDir::new().unwrap();
        write(plain.path(), "main.R", "x <- 1\n");
        assert!(!report(plain.path(), true).package_mode);
    }

    #[test]
    fn missing_workspace_is_an_operator_error() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("no-such-dir");
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(build_graph_report(&args(&missing, true), tmp.path()));
        assert_eq!(result.err(), Some(EXIT_OPERATOR_ERROR));
    }

    #[test]
    fn text_output_smoke() {
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "main.R",
            "source(\"a.R\")\nsource(\"missing.R\")\n",
        );
        write(tmp.path(), "a.R", "x <- 1\n");
        let text = render_text(&report(tmp.path(), true));
        assert_eq!(
            text,
            "main.R:1:1 -> a.R (source, call, global)\n\
             main.R:2:1 -> missing.R (source, call, global, missing, not portable from root)\n\
             \n2 edge(s), 0 dropped, 3 file(s)\n"
        );
    }

    #[test]
    fn parse_args_accepts_the_documented_flags_and_rejects_sarif() {
        let parse = |argv: &[&str]| parse_args(argv.iter().map(|s| s.to_string()));
        assert_eq!(
            parse(&["--workspace", "w", "--no-config", "--format", "json"]).unwrap(),
            GraphArgs {
                workspace: Some(PathBuf::from("w")),
                config_path: None,
                no_config: true,
                format: GraphFormat::Json,
            }
        );
        assert_eq!(parse(&[]).unwrap().format, GraphFormat::Text);
        assert!(parse(&["--format", "sarif"]).unwrap_err().contains("sarif"));
        assert_eq!(parse(&["--help"]).unwrap_err(), "HELP");
        assert!(parse(&["main.R"]).is_err());
        assert!(parse(&["--max-severity", "info"]).is_err());
    }
}
