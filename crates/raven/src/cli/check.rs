//! `raven check` subcommand: index a workspace, then report the full diagnostic
//! set (syntax, semantic, style lints, cross-file, package, and
//! undefined-variable) for the requested files — the same diagnostics the
//! editor publishes, run headlessly for CI.
//!
//! Unlike `raven lint` (style rules only; no `WorldState`, no cross-file), this
//! builds a real `WorldState`, runs the same workspace scan the LSP server runs
//! on startup, auto-detects R to populate the package library, then drives the
//! shared diagnostic pipeline per reported file:
//! `DiagnosticsSnapshot::build` → `handlers::diagnostics_from_snapshot` →
//! `handlers::diagnostics_async_standalone` (the same three steps as the LSP
//! publish path — notably NOT the `handlers::diagnostics()` convenience
//! wrapper, which skips the async on-disk missing-file checks).
//!
//! The whole workspace is always indexed so cross-file resolution is accurate;
//! `PATHS` only filter which files have their diagnostics *reported*.

use std::path::{Path, PathBuf};

use tower_lsp::lsp_types::{Diagnostic, DiagnosticSeverity, Url};

use crate::cli::shared::{
    ColorChoice, EXIT_LINT_FAILED, EXIT_OK, EXIT_OPERATOR_ERROR, OutputFormat, SeverityLevel,
    absolute_path, collect_check_target_paths, encoding_diagnostic, is_chunk_file, is_r_file,
    parse_color_choice, parse_output_format, parse_severity_level, render, resolve_color_from_env,
};

#[derive(Debug, PartialEq, Clone)]
pub struct CheckArgs {
    /// Files / directories to report on. Empty means "every R file in the
    /// workspace". These filter only what is *reported*; the whole workspace is
    /// always indexed regardless.
    pub paths: Vec<PathBuf>,
    /// Workspace root to index. Defaults to the current directory.
    pub workspace: Option<PathBuf>,
    pub config_path: Option<PathBuf>,
    pub no_config: bool,
    pub format: OutputFormat,
    pub max_severity: SeverityLevel,
    pub quiet: bool,
    /// Color control for `text` output. `--no-color` parses to
    /// [`ColorChoice::Never`]; `--color auto|always|never` sets it directly.
    /// Resolved to on/off by [`resolve_color_from_env`] (TTY +
    /// `NO_COLOR`/`FORCE_COLOR`).
    pub color: ColorChoice,
    /// Enable the missing-package ("not installed") diagnostic. Disabled by
    /// default because `raven check` often runs in environments without package
    /// installation. Reports `library()` calls absent from the local library
    /// paths — NOT relative to Tier 2/Tier 3 metadata (see docs/diagnostics.md).
    pub report_uninstalled: bool,
}

pub fn parse_args(mut argv: impl Iterator<Item = String>) -> Result<CheckArgs, String> {
    let mut paths = Vec::new();
    let mut workspace = None;
    let mut config_path = None;
    let mut no_config = false;
    let mut format = OutputFormat::Text;
    let mut max_severity = SeverityLevel::Info;
    let mut quiet = false;
    // `--color` and `--no-color` write the same field; last-one-wins on conflict
    // (`--no-color --color always` ⇒ always), matching cargo/ripgrep.
    let mut color = ColorChoice::Auto;
    let mut report_uninstalled = false;

    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--workspace" => {
                workspace = Some(PathBuf::from(
                    argv.next().ok_or("--workspace needs a path")?,
                ));
            }
            "--config" => {
                config_path = Some(PathBuf::from(argv.next().ok_or("--config needs a path")?));
            }
            "--no-config" => no_config = true,
            "--format" => {
                let v = argv.next().ok_or("--format needs a value")?;
                format = parse_output_format(&v)?;
            }
            "--max-severity" => {
                let v = argv.next().ok_or("--max-severity needs a value")?;
                max_severity = parse_severity_level(&v)?;
            }
            "--quiet" => quiet = true,
            "--color" => {
                let v = argv.next().ok_or("--color needs a value")?;
                color = parse_color_choice(&v)?;
            }
            "--no-color" => color = ColorChoice::Never,
            "--report-uninstalled" => report_uninstalled = true,
            "--help" => return Err("HELP".into()),
            s if s.starts_with("--") => return Err(format!("unknown flag: {s}")),
            p => paths.push(PathBuf::from(p)),
        }
    }
    Ok(CheckArgs {
        paths,
        workspace,
        config_path,
        no_config,
        format,
        max_severity,
        quiet,
        color,
        report_uninstalled,
    })
}

pub fn print_help() {
    println!(
        "raven check {} — full R diagnostics for CI

Usage: raven check [OPTIONS] [PATHS...]

Indexes the workspace, then reports the full diagnostic set for the requested
files (or every R / R Markdown / Quarto file in the workspace when no PATHS are
given): syntax errors, semantic checks, style lints, cross-file diagnostics
(missing source files, circular dependencies, out-of-scope usage),
missing-package warnings, and undefined-variable diagnostics. For .Rmd / .qmd
the R code inside chunks is analyzed; prose and non-R chunks are ignored.
Honors raven.toml / .lintr.

Options:
  --workspace DIR             Workspace root to index (default: current directory)
  --config PATH               Path to raven.toml (default: search upward from --workspace)
  --no-config                 Use built-in defaults; ignore raven.toml/.lintr
  --format text|json|sarif    Output format (default: text)
  --max-severity LEVEL        Highest severity that does NOT fail the build
                              (off, hint, info, warning, error; default: info)
  --quiet                     Suppress summary line in text output
  --color auto|always|never   When to colorize text output (default: auto —
                              color when stdout is a terminal). Honors NO_COLOR
                              and FORCE_COLOR under auto; json/sarif are never
                              colorized.
  --no-color                  Alias for --color never

R / packages:
  raven check auto-detects R on PATH to resolve installed-package exports and
  base R symbols. If R is not found, package and base-symbol diagnostics are
  limited and a note is printed to stderr; all other diagnostics still run.

  --report-uninstalled        Report packages from library() calls that are not
                              present in the local library paths. Disabled by
                              default; useful when the environment DID install
                              packages (e.g. renv::restore()) and you want to
                              catch failures.

Exit codes:
  0   No diagnostic exceeded --max-severity
  1   A diagnostic exceeded --max-severity, or a usage error (unknown flag / bad option value)
  2   Operator error while running (config parse failure, unreadable path)
",
        env!("CARGO_PKG_VERSION")
    );
}

/// Open a report target that the workspace scan did NOT index (a path reached
/// through a different symlink alias, OR a chunk file — `.Rmd`/`.qmd` are
/// deliberately outside the R-only workspace scan) into `state.documents` and
/// wire its outgoing edges into the dependency graph.
///
/// `text` is the already-decoded file contents (the caller owns the
/// `read_source` error handling). `path` is used only to classify the chunk
/// kind via its extension.
///
/// Workspace-scanned files get their edges from
/// `build_dependency_graph_from_workspace`, but a disk-fallback target was never
/// passed to `update_file`. Without this, `cached_neighborhood_subgraph(uri, …)`
/// returns an empty neighborhood, so a chunk `source("R/util.R")` wouldn't
/// resolve — producing false undefined-variable positives and losing
/// missing-file context. This mirrors `backend`'s did_open: extract masked
/// metadata for the path, enrich it with the inherited working directory,
/// pre-collect parent content for any backward directives, then update the
/// graph. The masked extraction reads chunk-body `source()`/`library()` calls
/// only (never prose).
///
/// Single source of truth for both `run`'s report loop and the
/// `collect_diagnostics_blocking` test helper, so production and test exercise
/// identical disk-fallback behavior.
fn open_disk_fallback_target(
    state: &mut crate::state::WorldState,
    uri: &Url,
    path: &Path,
    text: &str,
) {
    // Pass an honest language id so the Document classifies the chunk kind
    // correctly: "rmd" for `.Rmd`/`.qmd` (the constructor reads the URI to
    // classify it as Rmd and masks the prose), "r" otherwise.
    // `file_type_from_language_id("rmd")` is `None`, so the `FileType` still
    // falls back to R via the URI — only the chunk masking differs.
    let language_id = if is_chunk_file(path) { "rmd" } else { "r" };
    state.open_document_with_language_id(uri.clone(), text, Some(1), Some(language_id));

    let workspace_root = state.workspace_folders.first().cloned();
    let max_chain_depth = state.cross_file_config.max_chain_depth;
    let mut meta = crate::cross_file::extract_metadata_for_path(uri.path(), text);
    crate::cross_file::enrich_metadata_with_inherited_wd(
        &mut meta,
        uri,
        workspace_root.as_ref(),
        |parent_uri| state.get_enriched_metadata(parent_uri),
        max_chain_depth,
    );

    // Resolve system.file() source entries into concrete paths
    {
        let ws = state.package_state.workspace();
        let ws_name = ws.map(|w| w.name.as_str());
        let ws_root = ws.map(|w| w.root.as_path());
        let lib_paths = state.package_library.lib_paths();
        crate::cross_file::resolve_system_file_sources(&mut meta, ws_name, ws_root, lib_paths);
    }

    // Pre-collect parent content for any backward directives (`# raven: sourced-by`
    // with `match=`/inference call sites) before the mutable `update_file`
    // borrow, mirroring did_open. Forward `source()` edges — the only kind chunk
    // targets normally have — don't consult this closure, so it's empty in the
    // common case.
    let backward_path_ctx =
        crate::cross_file::path_resolve::PathContext::new(uri, workspace_root.as_ref());
    let parent_content: std::collections::HashMap<Url, String> = meta
        .sourced_by
        .iter()
        .filter_map(|d| {
            let ctx = backward_path_ctx.as_ref()?;
            let resolved = crate::cross_file::path_resolve::resolve_path(&d.path, ctx)?;
            let parent_uri = Url::from_file_path(resolved).ok()?;
            let content = state
                .documents
                .get(&parent_uri)
                .map(|doc| doc.text())
                .or_else(|| state.cross_file_file_cache.get(&parent_uri))?;
            Some((parent_uri, content))
        })
        .collect();
    state
        .cross_file_graph
        .update_file(uri, &meta, workspace_root.as_ref(), |parent_uri| {
            parent_content.get(parent_uri).cloned()
        });
}

pub async fn run(args: CheckArgs) -> i32 {
    let cwd = match std::env::current_dir() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("raven check: cannot read current directory: {e}");
            return EXIT_OPERATOR_ERROR;
        }
    };

    // Workspace root: --workspace (resolved against CWD if relative), else CWD.
    // Canonicalize so `Url::from_file_path` gets an absolute path and the
    // relative paths in output are stable.
    let abs_workspace = match args.workspace {
        Some(ref p) if p.is_absolute() => p.clone(),
        Some(ref p) => cwd.join(p),
        None => cwd.clone(),
    };
    let root = std::fs::canonicalize(&abs_workspace).unwrap_or(abs_workspace);

    let Ok(workspace_url) = Url::from_file_path(&root) else {
        eprintln!("raven check: invalid workspace path: {}", root.display());
        return EXIT_OPERATOR_ERROR;
    };

    // Build the indexed WorldState (config + workspace scan + package-mode).
    let mut state = match build_indexed_state(
        &root,
        &workspace_url,
        args.no_config,
        args.config_path.as_deref(),
    ) {
        Ok(s) => s,
        Err(code) => return code,
    };

    // CI default: suppress the missing-package ("not installed") diagnostic,
    // because CI deliberately omits installation (spec §10.1). The CLI owns
    // `state` exclusively, so a direct field set here is safe.
    // `--report-uninstalled` opts back in.
    if !args.report_uninstalled {
        state.cross_file_config.packages_missing_package_severity = None;
    }

    // Auto-detect R for installed-package / base-symbol awareness. Any failure
    // (R absent, init error, no library paths) degrades gracefully and prints
    // its own one-line note to stderr. The returned verdict feeds the
    // missing-export-metadata warning below.
    let shipped_db_load = maybe_init_r(&mut state, &root).await;

    // Resolve system.file() sources now that both package state AND library
    // paths are available (maybe_init_r populates lib_paths from R discovery
    // and additionalLibraryPaths).
    state.resolve_system_file_in_workspace();

    // R fallback for sysdata: when the AST scan found nothing AND
    // R/sysdata.rda exists, load it via the R subprocess (see
    // `maybe_load_sysdata_fallback`).
    maybe_load_sysdata_fallback(&mut state).await;

    // Resolve which files to report diagnostics for. A named path that does not
    // exist is an operator error (exit 2), matching `raven lint`.
    let mut operator_error = false;
    let targets = collect_report_targets(&args.paths, &root, &mut operator_error);

    // Warm the package-export cache before computing diagnostics, matching the
    // editor's post-scan prefetch (see [`prefetch_reported_packages`]).
    prefetch_reported_packages(&state, &targets).await;

    let (all_diags, reported_loaded_packages, collect_operator_error) =
        collect_target_diagnostics(&mut state, &targets).await;
    operator_error |= collect_operator_error;

    let any_above_threshold = all_diags
        .iter()
        .any(|(_, d)| SeverityLevel::from_diag(d) > args.max_severity);

    let missing_export_metadata_packages =
        if should_check_missing_export_metadata(&state, &all_diags) {
            collect_missing_export_metadata_packages(&state, &reported_loaded_packages).await
        } else {
            Vec::new()
        };

    let use_color = resolve_color_from_env(args.color);
    render(args.format, &all_diags, &root, args.quiet, use_color);

    if !missing_export_metadata_packages.is_empty() {
        eprintln!(
            "{}",
            format_missing_export_metadata_warning(
                &missing_export_metadata_packages,
                shipped_db_load
            )
        );
    }

    // Surface cross-file traversal-budget exhaustion (issue #473). The owned
    // `state.cross_file_graph` accumulates these counters across every target's
    // diagnostic pass (neighborhood collection records on the full graph), so
    // reading them after the loop reflects the whole run. When a budget is hit
    // the resolver silently stops following `source()` edges, so some
    // "Undefined variable" warnings above may be false positives — say so, on
    // stderr, so CI output is not misleading. The editor surfaces the same via
    // a throttled `window/showMessage`; `raven check` had no equivalent.
    if let Some(note) = format_traversal_budget_note(&state) {
        eprintln!("{note}");
    }

    // Operator error takes priority over a threshold breach: a half-read run
    // shouldn't masquerade as a clean (or merely failing) lint result.
    if operator_error {
        EXIT_OPERATOR_ERROR
    } else if any_above_threshold {
        EXIT_LINT_FAILED
    } else {
        EXIT_OK
    }
}

/// Build a fully-indexed `WorldState`: load project config, scan the workspace,
/// and derive package-mode scope. The R package library is initialized
/// separately (see [`maybe_init_r`]) since it depends on an external process.
///
/// This is the synchronous, single-owner counterpart to the LSP server's
/// startup (`backend::initialized`, "Task B"). The two intentionally differ
/// only in *wiring* — the server is async, takes write locks, and records perf;
/// the CLI owns `state` exclusively — while every piece of *logic* that could
/// drift is single-sourced through shared seams: config discovery+load
/// ([`crate::config_file::discover_and_load`]), the workspace scan
/// ([`crate::state::scan_workspace`] + [`WorldState::apply_workspace_index`]),
/// package-input seeding ([`crate::backend::initialize_package_inputs_from_state`]),
/// and the R package library ([`crate::package_library::build_package_library`]).
/// Keep new startup logic in those seams, not duplicated here.
fn build_indexed_state(
    root: &Path,
    workspace_url: &Url,
    no_config: bool,
    config_path: Option<&Path>,
) -> Result<crate::state::WorldState, i32> {
    let (project_settings, project_config_path) =
        resolve_project_config(no_config, config_path, root)?;

    let mut state = crate::state::WorldState::new();
    state.workspace_folders = vec![workspace_url.clone()];
    state.raw_project_settings = project_settings;
    state.project_config_path = project_config_path;
    // `recompute_parsed_configs` is the only writer of the parsed config fields.
    // It reads `project_config_path` to detect a discovered `.lintr` and gate
    // its auto-enable (which, for the CLI's empty client layer, defaults on).
    crate::config_file::recompute_parsed_configs(&mut state);

    // Index the workspace exactly as the LSP server does on startup. This is
    // rayon-parallel internally; there's no lock contention here since the CLI
    // owns `state` exclusively.
    let max_chain_depth = state.cross_file_config.max_chain_depth;
    let (index, cross_file_entries, new_index_entries) =
        crate::state::scan_workspace(std::slice::from_ref(workspace_url), max_chain_depth);
    state.apply_workspace_index(index, cross_file_entries, new_index_entries);

    // Derive package-mode scope (so `R/*.R` files in an R package see each
    // other's top-level definitions without explicit `source()`). This is
    // independent of the R subprocess — it's derived from the workspace files,
    // DESCRIPTION, and NAMESPACE — but MUST run after `apply_workspace_index`,
    // which resets package state.
    //
    // The disk seed is empty: `initialize_package_inputs_from_state` hydrates
    // every package R file from the workspace index we just applied, so reading
    // them from disk here would only be overwritten. This mirrors the LSP's
    // with-scan startup path, which seeds package inputs from disk only on the
    // no-scan branch (see `backend.rs`).
    let desc_text: Option<std::sync::Arc<str>> = std::fs::read_to_string(root.join("DESCRIPTION"))
        .ok()
        .map(|t| t.into());
    let ns_text: Option<std::sync::Arc<str>> = std::fs::read_to_string(root.join("NAMESPACE"))
        .ok()
        .map(|t| t.into());
    crate::backend::initialize_package_inputs_from_state(
        &mut state,
        root.to_path_buf(),
        desc_text,
        ns_text,
        Default::default(),
    );

    Ok(state)
}

/// Discover and load the project config at or above `search_start` (the search
/// itself is done by `find_config`). Returns `(settings, config_path)` to wire
/// into the `WorldState`. Prints warnings to stderr; returns
/// `Err(EXIT_OPERATOR_ERROR)` when a config that exists cannot be loaded.
fn resolve_project_config(
    no_config: bool,
    config_path: Option<&Path>,
    search_start: &Path,
) -> Result<(Option<serde_json::Value>, Option<PathBuf>), i32> {
    if no_config {
        return Ok((None, None));
    }
    // Every loader yields `settings` + `warnings`; emit the warnings and tag the
    // settings with the config path they came from.
    let loaded = |warnings: Vec<String>, settings: serde_json::Value, path: PathBuf| {
        for w in warnings {
            eprintln!("{w}");
        }
        Ok((Some(settings), Some(path)))
    };
    if let Some(explicit) = config_path {
        return match crate::config_file::load_toml(explicit) {
            Some(l) => loaded(l.warnings, l.settings, explicit.to_path_buf()),
            None => {
                eprintln!(
                    "raven check: failed to load --config {}",
                    explicit.display()
                );
                Err(EXIT_OPERATOR_ERROR)
            }
        };
    }
    // Discovery (raven.toml beats .lintr) and loading are shared with the LSP
    // server via `config_file::discover_and_load`, so the CLI and editor can't
    // drift on discovery precedence or which loader reads `.lintr`.
    match crate::config_file::discover_and_load(search_start) {
        crate::config_file::DiscoveredLoad::Loaded {
            path,
            settings,
            warnings,
        } => loaded(warnings, settings, path),
        crate::config_file::DiscoveredLoad::LoadFailed { path } => {
            eprintln!("raven check: failed to load {}", path.display());
            Err(EXIT_OPERATOR_ERROR)
        }
        crate::config_file::DiscoveredLoad::None => Ok((None, None)),
    }
}

/// Auto-detect R and store the resulting package library on `state`, so
/// installed-package exports and base R symbols are available.
///
/// The shared construction and classification rules — the `packages.enabled`
/// gate *before* any R discovery, `packages.rPath` selection, applying
/// `packages.additionalLibraryPaths` *after* discovery, and the readiness
/// predicate — all live in [`crate::package_library::build_package_library`];
/// see its doc comment for that contract. Routing through it is what keeps this
/// CLI path and the editor's startup paths from drifting.
///
/// This function owns only the *caller policy*: it always installs the returned
/// library, then uses `PackageLibraryOutcome::consumer_ready` for the diagnostic
/// readiness gate. The three R-related degradations each print a one-line note
/// to stderr so CI shows what was missing; `Disabled` (the user turned package
/// awareness off in `raven.toml`) is silent, matching the editor.
///
/// Returns the build's [`ShippedDbLoad`] verdict so the caller can tailor the
/// missing-export-metadata warning (absent / loaded / present-but-failed)
/// without re-stat-ing disk — the build already knows whether the shipped
/// `names.db` actually loaded, which a bare `Path::exists()` cannot tell.
async fn maybe_init_r(
    state: &mut crate::state::WorldState,
    root: &Path,
) -> crate::package_library::ShippedDbLoad {
    // Snapshot config into locals before the call so the later `state`
    // mutation doesn't conflict with the borrow.
    let r_path = state.cross_file_config.packages_r_path.clone();
    let additional = state
        .cross_file_config
        .packages_additional_library_paths
        .clone();
    let enabled = state.cross_file_config.packages_enabled;

    let outcome = crate::package_library::build_package_library(
        r_path,
        &additional,
        Some(root.to_path_buf()),
        enabled,
    )
    .await;

    // Surface present-but-unusable package-DB notes (e.g. a `.raven/packages.json`
    // from a newer Raven, or a corrupt/incompatible `names.db`). These are
    // build-time events carried on the outcome; print them before the status
    // match below partially moves `outcome.library`.
    for note in &outcome.load_notes {
        eprintln!("raven check: {note}");
    }

    // Always install the returned library: on a non-`Ready` status it may still
    // carry Tier 2/3 providers or bundled base exports, which are the whole
    // point of CI resolution without R. Dropping it here would send `raven
    // check` back to an empty library and lose the offline path.
    use crate::package_library::PackageLibraryStatus::*;
    state.package_library_ready = outcome.consumer_ready();
    let status = outcome.status;
    let shipped_db_load = outcome.shipped_db_load;
    state.package_library = outcome.library;
    match status {
        Ready | Disabled => {}
        RNotFound => eprintln!(
            "raven check: R not found on PATH; package and base-symbol diagnostics will be limited"
        ),
        InitFailed(e) => eprintln!(
            "raven check: R found but its package library failed to initialize ({e}); package and base-symbol diagnostics will be limited"
        ),
        NoLibraryPaths => eprintln!(
            "raven check: R found but no library paths were discovered; package and base-symbol diagnostics will be limited"
        ),
    }
    shipped_db_load
}

/// `raven check`'s counterpart of the LSP startup's sysdata R fallback (the
/// "R fallback for sysdata" block in `backend.rs`): when the AST scan of
/// `data-raw/` found nothing but a binary `R/sysdata.rda` exists on disk
/// (e.g. r-lib/cli commits the `.rda` with no generating script), load it via
/// the package library's R subprocess so the package's own `R/` code can
/// reference its internal data objects without false undefined-variable
/// findings. The trigger predicate is shared
/// ([`crate::backend::sysdata_r_fallback_needed`]) so the two paths can't
/// drift. The names feed only package-mode scope (`contrib.sysdata_symbols`);
/// a user script that attaches the package still flags these objects —
/// `library(cli); emojis` remains a real R error.
///
/// Must run after [`maybe_init_r`] (needs the library's R subprocess) and
/// before diagnostics. Fail-soft: no R, no `.rda`, or a load failure leaves
/// the AST-scan result in place.
async fn maybe_load_sysdata_fallback(state: &mut crate::state::WorldState) {
    if !crate::backend::sysdata_r_fallback_needed(state) {
        return;
    }
    let Some(root) = state.package_inputs.workspace_root.clone() else {
        return;
    };
    let names = match state.package_library.r_subprocess() {
        Some(r) => crate::package_state::sysdata::load_sysdata_via_r(r, &root).await,
        None => return,
    };
    if !names.is_empty() {
        state.package_inputs.sysdata_names = names;
        state.apply_package_event(&crate::package_state::PackageInputDelta::DataDirChanged);
    }
}

/// Warm the package-export cache for the packages the reported files attach,
/// matching the editor's post-scan prefetch
/// ([`crate::backend::prefetch_packages_for_open_documents`]).
///
/// The undefined-variable check is synchronous and treats an installed-but-
/// uncached package as "pending", suppressing bare calls that could resolve to
/// it (`handlers.rs`). Without this warm-up `raven check` would under-report
/// undefined symbols from attached packages relative to the editor whenever R
/// (or a configured library path) makes the package installed-but-uncached.
///
/// Covers the directly-attached packages (`library()` / `require()`) of each
/// reported file. R-source targets read their already-parsed `loaded_packages`
/// from the workspace index (free). Chunk-bearing targets (`.Rmd`/`.qmd`) are
/// never in the R-only scan, so they're read from disk and masked here so a
/// chunk `library()` call warms its package's exports too — without this the
/// undefined-variable check would conservatively suppress bare calls to an
/// installed-but-uncached package attached only inside a chunk, under-reporting
/// relative to the editor.
///
/// In package mode, also covers NAMESPACE whole-package `import(pkg)`
/// directives (`scope_contribution.full_imports`) and packages attached by
/// testthat preamble files (`scope_contribution.test_helper_attached_packages`,
/// issue #432). For both, the undefined-variable
/// check resolves call- and value-position uses of the package's exports via
/// `is_package_export`, which needs the cache warm; without this
/// the "pending" heuristic suppresses only call-position uses, so
/// value-position references (default args, bare identifiers) would emit
/// false "Undefined variable" diagnostics — an asymmetry the editor avoids.
/// (The helper-attach union is flat; the source-order gate that governs
/// visibility is irrelevant to warming.)
///
/// Cross-file *inherited* packages (attached in a `source()`d file) and
/// packages of non-chunk targets the scan did not index are not prefetched
/// here, so calls relying on those stay conservatively suppressed — a narrower
/// gap than before, noted in `docs/cli.md`. No-op when the library isn't ready
/// (e.g. R absent with no configured library paths).
async fn prefetch_reported_packages(state: &crate::state::WorldState, targets: &[PathBuf]) {
    if !state.package_library_ready {
        return;
    }
    let packages: Vec<String> = reported_packages_to_warm(state, targets)
        .into_iter()
        .filter(|p| crate::r_subprocess::is_valid_package_name(p))
        .collect();
    // `prefetch_packages` is a no-op on an empty slice, so no length guard here.
    state.package_library.prefetch_packages(&packages).await;
}

/// Pure (R-free) computation of the package set [`prefetch_reported_packages`]
/// warms, before the validity filter and the async cache prefetch. Extracted so
/// the warming wiring is unit-testable without an R subprocess. Reads target
/// files from disk for chunk files (best-effort), but performs no R calls.
fn reported_packages_to_warm(
    state: &crate::state::WorldState,
    targets: &[PathBuf],
) -> std::collections::HashSet<String> {
    let mut packages: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Package mode: NAMESPACE `import(pkg)` puts every export of `pkg` in
    // scope for the package's own R files, so warm those exports too.
    packages.extend(
        state
            .package_state
            .scope_contribution()
            .full_imports
            .iter()
            .cloned(),
    );
    // Package mode: packages attached by testthat preamble files
    // (`helper*.R`/`setup*.R`) via `library()`/`require()` propagate to sibling
    // test files (issue #432), so warm their exports too — the undefined-
    // variable check resolves them via `is_package_export` reading the
    // (preamble-injected) `inherited_packages`, which needs the cache warm.
    // Warming is a union, so the source-order gate that governs *visibility*
    // (see `append_package_contribution`) is irrelevant here.
    for pkgs in state
        .package_state
        .scope_contribution()
        .test_helper_attached_packages
        .values()
    {
        packages.extend(pkgs.iter().cloned());
    }
    for path in targets {
        let Ok(uri) = Url::from_file_path(path) else {
            continue;
        };
        if let Some(doc) = state.workspace_index.get(&uri) {
            packages.extend(doc.loaded_packages.iter().cloned());
            // Issue #429: warm packages named in `data(..., package = "pkg")`
            // so the diagnostics-time `data()` alias expansion can resolve the
            // dataset object names. Unlike `library()` these are not attached,
            // but their `data/` enumeration must be cached.
            packages.extend(doc.data_packages.iter().cloned());
        } else if is_chunk_file(path) {
            // Chunk files are outside the R-only scan, so they have no index
            // entry. Read + construct a throwaway Document best-effort so its
            // masked `loaded_packages` (chunk-body `library()`/`require()` calls
            // only, never prose) drive the warm-up exactly as an indexed R
            // file's would. An unreadable / mis-encoded file just contributes no
            // packages — its read failure surfaces as a finding in the report
            // loop.
            if let Ok(text) = crate::state::read_source(path) {
                let doc =
                    crate::state::Document::new_with_language_id(&text, Some(1), &uri, Some("rmd"));
                packages.extend(doc.loaded_packages.iter().cloned());
                packages.extend(doc.data_packages.iter().cloned());
            }
        }
    }
    packages
}

fn has_package_metadata_sensitive_undefined_diagnostic(
    all_diags: &[(PathBuf, Diagnostic)],
) -> bool {
    all_diags.iter().any(|(_, d)| {
        d.message.starts_with("Undefined variable:")
            && !d.message.contains("(defined later on line ")
    })
}

fn should_check_missing_export_metadata(
    state: &crate::state::WorldState,
    all_diags: &[(PathBuf, Diagnostic)],
) -> bool {
    state.cross_file_config.packages_enabled
        && has_package_metadata_sensitive_undefined_diagnostic(all_diags)
}

/// Caller must gate on [`should_check_missing_export_metadata`] (which already
/// requires `packages_enabled`); this only walks the reported packages.
async fn collect_missing_export_metadata_packages(
    state: &crate::state::WorldState,
    reported_loaded_packages: &std::collections::BTreeSet<String>,
) -> Vec<String> {
    let mut missing = Vec::new();
    for package in reported_loaded_packages
        .iter()
        .filter(|p| crate::r_subprocess::is_valid_package_name(p))
    {
        if state.package_library.export_metadata_missing(package).await {
            missing.push(package.clone());
        }
    }
    missing
}

/// Warn that some attached packages' exported symbols couldn't be loaded, so the
/// undefined-variable diagnostics above may be unreliable — then steer the user
/// to a fix. Leads with impact, then the obvious remedy (install the package),
/// then a database-specific fallback.
///
/// The fallback depends on the Tier 3 shipped database's actual load state
/// ([`ShippedDbLoad`]) — a three-way signal, not a present/absent boolean. The
/// distinction matters because `p.exists()` ("a database file is on disk") does
/// NOT mean it loaded and was searched: a corrupt/unsupported file also exists.
///
/// - `Loaded` — the database loaded and was searched; the package genuinely
///   isn't in it, so it's likely private or off CRAN/Bioconductor → `freeze`.
/// - `Absent` — no database installed → `raven packages update` to download it
///   (or `freeze` a snapshot from a machine where the package is installed).
/// - `Failed` — a database file is present but corrupt/unsupported, so it was
///   never searched. `freeze` is the wrong advice here (the package may well be
///   in a working copy); steer to `raven packages update` to re-download a good
///   copy. The specific load error is printed separately as a load note.
fn format_missing_export_metadata_warning(
    packages: &[String],
    shipped_db_load: crate::package_library::ShippedDbLoad,
) -> String {
    use crate::package_library::ShippedDbLoad::*;

    let mut names = packages.to_vec();
    names.sort();
    names.dedup();
    let n = names.len();
    names.truncate(8);
    let names = names.join(", ");

    // Count-aware nouns/pronouns so a single package reads naturally.
    let (noun, obj, inst) = if n == 1 {
        ("this package", "it", "it's")
    } else {
        ("these packages", "them", "they're")
    };

    let head = format!(
        "raven check: couldn't load exported symbols for {names}.\n\
         Some \"Undefined variable\" warnings above may be inaccurate as a result.\n\
         To fix: install {noun} in your R library."
    );

    match shipped_db_load {
        Loaded => format!(
            "{head}\n\
             Raven's package symbol database doesn't provide {obj} — {inst} likely private or not on CRAN/Bioconductor.\n\
             Capture {obj} with `raven packages freeze` on a machine where {inst} installed, and commit the result."
        ),
        Absent => format!(
            "{head}\n\
             In CI without R, run `raven packages update` before `raven check` to download Raven's package symbol database,\n\
             or commit a `raven packages freeze` snapshot made on a machine where {inst} installed."
        ),
        Failed => format!(
            "{head}\n\
             Raven's package symbol database is present but failed to load (corrupt or unsupported format), so it was not searched — see the load note above.\n\
             Run `raven packages update` to re-download a working database."
        ),
    }
}

/// Build the cross-file traversal-budget note for `raven check`, or `None` if
/// no traversal was truncated (issue #473).
///
/// Two independent budgets can truncate cross-file analysis: the visited-node
/// budget (`maxTransitiveDependentsVisited`), recorded by the neighborhood walk
/// on the full graph; and the chain-depth limit (`maxChainDepth`) on the
/// bidirectional neighborhood walk (resolver-level depth exceedances also
/// surface per-site as `depth_exceeded` diagnostics). Either truncation can drop
/// `source()` edges, so dropped symbols may appear as false-positive
/// `undefined-variable` warnings. The note tells the user which budget to raise
/// so a budget-induced drop is distinguishable from a genuine undefined variable
/// in CI.
fn format_traversal_budget_note(state: &crate::state::WorldState) -> Option<String> {
    let visited_trunc = state.cross_file_graph.visited_budget_truncations();
    let depth_trunc = state.cross_file_graph.depth_truncations();
    if visited_trunc == 0 && depth_trunc == 0 {
        return None;
    }
    let mut lines = Vec::new();
    if visited_trunc > 0 {
        let max_visited = state.cross_file_config.max_transitive_dependents_visited;
        lines.push(format!(
            "raven check: a bounded cross-file neighborhood traversal was truncated \
             (maxTransitiveDependentsVisited = {max_visited}); some source() edges were \
             not followed, so some \"Undefined variable\" warnings above may be false \
             positives. Raise `crossFile.maxTransitiveDependentsVisited` in raven.toml to \
             analyze more files."
        ));
    }
    if depth_trunc > 0 {
        let max_chain_depth = state.cross_file_config.max_chain_depth;
        lines.push(format!(
            "raven check: a cross-file traversal hit the depth limit \
             (maxChainDepth = {max_chain_depth}); some deeply-nested source() edges were \
             not followed. Raise `crossFile.maxChainDepth` in raven.toml to analyze deeper \
             dependency chains."
        ));
    }
    Some(lines.join("\n"))
}

/// Run the full diagnostic pipeline for one already-opened document. Returns an
/// empty vec when the snapshot can't be built (parse failure or document not
/// open). A malformed file is not an operator error here — its reportable
/// syntax errors are surfaced like any other diagnostic when the tree still
/// builds.
/// The synchronous half of a file's diagnostics: build the snapshot and run the
/// CPU-bound scope-resolution pass. Returns the pre-async findings plus the
/// inputs the async missing-file pass needs (`directive_meta`, severity). Split
/// out so `raven check` can run this — the expensive part — across files in
/// parallel (issue #479 WI3), then do the cheap async filesystem checks
/// afterward. `open_documents` is the worker's one-entry overlay (see
/// [`crate::handlers::DiagnosticsSnapshot::build_with_open_documents`]).
fn compute_file_diagnostics_sync(
    state: &crate::state::WorldState,
    uri: &Url,
    open_documents: &std::collections::HashMap<Url, crate::state::Document>,
) -> Option<(
    Vec<Diagnostic>,
    crate::cross_file::CrossFileMetadata,
    Option<DiagnosticSeverity>,
)> {
    let snapshot = crate::handlers::DiagnosticsSnapshot::build_with_open_documents(
        state,
        uri,
        open_documents,
    )?;
    let cancel = crate::handlers::DiagCancelToken::never();
    let sync_diags = crate::handlers::diagnostics_from_snapshot(&snapshot, uri, &cancel)?;
    let missing_file_severity = snapshot.cross_file_config.missing_file_severity;
    Some((sync_diags, snapshot.directive_meta, missing_file_severity))
}

/// The async half: replace the snapshot's cache-based missing-file checks with
/// real on-disk existence checks — exactly what the LSP publish path does.
async fn finalize_file_diagnostics(
    state: &crate::state::WorldState,
    uri: &Url,
    sync_diags: Vec<Diagnostic>,
    directive_meta: &crate::cross_file::CrossFileMetadata,
    missing_file_severity: Option<DiagnosticSeverity>,
) -> Vec<Diagnostic> {
    crate::handlers::diagnostics_async_standalone(
        uri,
        sync_diags,
        directive_meta,
        state.workspace_folders.first(),
        missing_file_severity,
    )
    .await
}

async fn compute_file_diagnostics(state: &crate::state::WorldState, uri: &Url) -> Vec<Diagnostic> {
    let Some((sync_diags, directive_meta, missing_file_severity)) =
        compute_file_diagnostics_sync(state, uri, &state.documents)
    else {
        return Vec::new();
    };
    finalize_file_diagnostics(
        state,
        uri,
        sync_diags,
        &directive_meta,
        missing_file_severity,
    )
    .await
}

/// Compute the sorted `(path, Diagnostic)` set for every report target (issue
/// #479 WI3). Returns the diagnostics, the union of attached loaded packages
/// (for the missing-export-metadata warning), and whether any per-target
/// operator error occurred (bad URL / unreadable disk-fallback target).
///
/// The CPU-bound diagnostic pass is parallelized across files: the graph/index
/// caches are `RwLock`/atomic and immutable after the scan, so per-file scope
/// resolution is safe to run concurrently. The one hazard (Codex review) is that
/// open documents outrank index content in the content provider, so sharing
/// `state.documents` across workers would make each worker treat the others'
/// targets as "open" and pull the wrong artifacts. We avoid that entirely:
/// `state.documents` stays empty during the parallel region, and each worker
/// passes a one-entry overlay holding only its target (see
/// `compute_file_diagnostics_sync` /
/// `DiagnosticsSnapshot::build_with_open_documents`). This reproduces the
/// sequential "exactly one open target" semantics per task, so output is
/// byte-identical to a sequential run (asserted by
/// `parallel_collection_matches_sequential`). The async on-disk missing-file
/// checks (cheap I/O) and the rare disk-fallback targets (not in the workspace
/// index) are handled afterward on the async runtime.
///
/// Blocking-in-async note: the phase-1 `par_iter().collect()` is a synchronous,
/// CPU-bound rayon join that runs on rayon's own thread pool while blocking the
/// calling tokio worker until it returns. We deliberately do NOT wrap it in
/// `block_in_place`/`spawn_blocking`. `raven check`'s tokio runtime runs exactly
/// one root future (`cli::check::run`, awaited inline from `#[tokio::main]`) with
/// no sibling tasks competing for a worker in this region, so there is nothing
/// for `block_in_place` to migrate — it would be a runtime no-op here while
/// adding a panic-on-`current_thread`-runtime hazard. The process exits right
/// after the report loop. If `raven check` ever gains concurrent tokio tasks
/// around this call, revisit and wrap the rayon phase then.
async fn collect_target_diagnostics(
    state: &mut crate::state::WorldState,
    targets: &[PathBuf],
) -> (
    Vec<(PathBuf, Diagnostic)>,
    std::collections::BTreeSet<String>,
    bool,
) {
    use rayon::prelude::*;

    struct SyncResult {
        path: PathBuf,
        uri: Url,
        sync_diags: Vec<Diagnostic>,
        directive_meta: crate::cross_file::CrossFileMetadata,
        missing_file_severity: Option<DiagnosticSeverity>,
        loaded_packages: Vec<String>,
    }

    let mut all_diags: Vec<(PathBuf, Diagnostic)> = Vec::new();
    let mut reported_loaded_packages = std::collections::BTreeSet::new();
    let mut operator_error = false;

    // Phase 1 (parallel, CPU-bound): indexed targets only. A target that is not
    // in the workspace index (disk-fallback) or whose path can't be a URL is
    // skipped here and handled sequentially below.
    let sync_results: Vec<SyncResult> = targets
        .par_iter()
        .filter_map(|path| {
            let uri = Url::from_file_path(path).ok()?;
            // Reuse the already-parsed `Document` from the scan (tree included),
            // exactly as the sequential path did — no disk re-read / re-parse.
            let doc = state.workspace_index.get(&uri).cloned()?;
            let loaded_packages: Vec<String> = doc.loaded_packages.to_vec();
            let mut open_documents = std::collections::HashMap::new();
            open_documents.insert(uri.clone(), doc);
            let (sync_diags, directive_meta, missing_file_severity) =
                compute_file_diagnostics_sync(state, &uri, &open_documents)?;
            Some(SyncResult {
                path: path.clone(),
                uri,
                sync_diags,
                directive_meta,
                missing_file_severity,
                loaded_packages,
            })
        })
        .collect();

    // Phase 2 (async): finalize the parallel results with on-disk missing-file
    // checks and collect their attached packages. Order is irrelevant — the
    // whole `all_diags` set is sorted below.
    for r in sync_results {
        reported_loaded_packages.extend(r.loaded_packages);
        let diags = finalize_file_diagnostics(
            state,
            &r.uri,
            r.sync_diags,
            &r.directive_meta,
            r.missing_file_severity,
        )
        .await;
        for d in diags {
            all_diags.push((r.path.clone(), d));
        }
    }

    // Phase 3 (sequential): targets not handled in phase 1 — a bad URL, or a
    // disk-fallback target the scan didn't index (e.g. a symlink-alias path, or
    // an `.Rmd`/`.qmd` chunk file outside the R-only scan). Rare; the existing
    // open → compute → close path (which uses `state.documents`) is preserved
    // verbatim, so behavior for these is unchanged.
    for path in targets {
        let Ok(uri) = Url::from_file_path(path) else {
            eprintln!(
                "raven check: cannot convert path to URL: {}",
                path.display()
            );
            operator_error = true;
            continue;
        };
        if state.workspace_index.contains_key(&uri) {
            continue; // already handled in the parallel phase
        }
        let text = match crate::state::read_source(path) {
            Ok(t) => t,
            Err(crate::state::SourceReadError::Io(e)) => {
                eprintln!("raven check: cannot read {}: {e}", path.display());
                operator_error = true;
                continue;
            }
            // A mis-encoded file is a property of the code, like a syntax
            // error — not an operator error. Report it as a finding (see
            // `encoding_diagnostic`) and keep going, so the exit code
            // reflects findings rather than a half-read abort.
            Err(crate::state::SourceReadError::InvalidEncoding { offset, byte }) => {
                all_diags.push((path.clone(), encoding_diagnostic(offset, byte)));
                continue;
            }
        };
        open_disk_fallback_target(state, &uri, path, &text);
        if let Some(doc) = state.documents.get(&uri) {
            reported_loaded_packages.extend(doc.loaded_packages.iter().cloned());
        }
        let diags = compute_file_diagnostics(state, &uri).await;
        state.close_document(&uri);
        for d in diags {
            all_diags.push((path.clone(), d));
        }
    }

    // Deterministic output regardless of the scan's parallel HashMap order.
    all_diags.sort_by(|(pa, da), (pb, db)| {
        pa.cmp(pb)
            .then(da.range.start.line.cmp(&db.range.start.line))
            .then(da.range.start.character.cmp(&db.range.start.character))
    });

    (all_diags, reported_loaded_packages, operator_error)
}

/// Resolve which files to report diagnostics for. Empty `paths` means every R
/// source (`.R`/`.r`) and chunk-bearing document (`.Rmd`/`.qmd`) under the
/// workspace root. Explicit paths are taken as-is (files) or walked
/// (directories). The result is sorted and de-duplicated for stable output.
/// Chunk files are collected both as explicit args and while walking a
/// directory, so `raven check` diagnoses the R chunks inside them (issue #343).
///
/// Every resolved path is canonicalized so its file URI matches the canonical
/// `root` used to build the dependency graph. Without this, on platforms where
/// the workspace root resolves through a symlink (e.g. macOS `/var` →
/// `/private/var`), an explicitly-passed `/var/...` path would neither match
/// the graph's `/private/var/...` keys (silently breaking cross-file
/// resolution) nor pass the workspace-boundary check.
///
/// A named path that does not exist sets `*operator_error`, so the caller can
/// return exit code 2 — matching `raven lint`.
fn collect_report_targets(
    paths: &[PathBuf],
    root: &Path,
    operator_error: &mut bool,
) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if paths.is_empty() {
        collect_check_target_paths(root, &mut out);
    } else {
        for p in paths {
            let abs = absolute_path(root, p);
            let abs = std::fs::canonicalize(&abs).unwrap_or(abs);
            if abs.is_dir() {
                collect_check_target_paths(&abs, &mut out);
            } else if abs.is_file() {
                if is_r_file(&abs) || is_chunk_file(&abs) {
                    out.push(abs);
                }
                // Other file types: silently ignored, matching lint's walk.
            } else {
                eprintln!("raven check: path does not exist: {}", p.display());
                *operator_error = true;
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn run_blocking(args: CheckArgs) -> i32 {
        tokio::runtime::Runtime::new().unwrap().block_on(run(args))
    }

    fn base_args(workspace: &Path) -> CheckArgs {
        CheckArgs {
            paths: Vec::new(),
            workspace: Some(workspace.to_path_buf()),
            config_path: None,
            no_config: true,
            format: OutputFormat::Json,
            max_severity: SeverityLevel::Info,
            quiet: true,
            color: ColorChoice::Never,
            report_uninstalled: false,
        }
    }

    #[test]
    fn parse_report_uninstalled_flag() {
        let args = parse_args(["--report-uninstalled".to_string()].into_iter()).unwrap();
        assert!(args.report_uninstalled);

        let default = parse_args(std::iter::empty()).unwrap();
        assert!(!default.report_uninstalled);
    }

    #[test]
    fn traversal_budget_note_none_when_no_truncation() {
        let state = crate::state::WorldState::new();
        assert!(super::format_traversal_budget_note(&state).is_none());
    }

    #[test]
    fn traversal_budget_note_fires_on_visited_truncation() {
        use crate::cross_file::types::{CrossFileMetadata, ForwardSource};
        use url::Url;

        let mut state = crate::state::WorldState::new();
        state.cross_file_config.max_transitive_dependents_visited = 1;
        let root = Url::parse("file:///p").unwrap();
        let a = Url::parse("file:///p/a.R").unwrap();
        let meta = CrossFileMetadata {
            sources: vec![ForwardSource {
                path: "b.R".to_string(),
                line: 1,
                column: 0,
                ..Default::default()
            }],
            ..Default::default()
        };
        state
            .cross_file_graph
            .update_file(&a, &meta, Some(&root), |_| None);
        // A budget of 1 with an a -> b edge truncates the neighborhood walk.
        let _ = state.cross_file_graph.collect_neighborhood(&a, 64, 1);

        let note = super::format_traversal_budget_note(&state)
            .expect("a truncated traversal must produce a note");
        assert!(note.contains("maxTransitiveDependentsVisited = 1"));
        assert!(note.contains("may be false"));
    }

    #[test]
    fn formats_missing_metadata_warning_for_absent_tier3() {
        use crate::package_library::ShippedDbLoad;
        let msg = super::format_missing_export_metadata_warning(
            &["foo".into(), "bar".into()],
            ShippedDbLoad::Absent,
        );
        // Names are sorted, so order is deterministic.
        assert!(msg.contains("couldn't load exported symbols for bar, foo"));
        assert!(msg.contains("install these packages in your R library"));
        // Absent steers to `update` (then `freeze`) as the CI fallback.
        assert!(msg.contains("run `raven packages update` before `raven check`"));
        assert!(msg.contains("raven packages freeze"));
        assert!(!msg.contains("Tier"));
    }

    #[test]
    fn formats_missing_metadata_warning_absent_tier3_singular() {
        use crate::package_library::ShippedDbLoad;
        let msg =
            super::format_missing_export_metadata_warning(&["foo".into()], ShippedDbLoad::Absent);
        assert!(msg.contains("couldn't load exported symbols for foo"));
        assert!(msg.contains("install this package in your R library"));
        assert!(msg.contains("where it's installed"));
        assert!(!msg.contains("Tier"));
    }

    #[test]
    fn formats_missing_metadata_warning_for_present_tier3_miss() {
        use crate::package_library::ShippedDbLoad;
        let msg =
            super::format_missing_export_metadata_warning(&["foo".into()], ShippedDbLoad::Loaded);
        assert!(msg.contains("couldn't load exported symbols for foo"));
        // Singular wording for a single package.
        assert!(msg.contains("install this package in your R library"));
        assert!(msg.contains("Raven's package symbol database doesn't provide it"));
        assert!(msg.contains("raven packages freeze"));
        assert!(!msg.contains("Tier"));
    }

    #[test]
    fn formats_missing_metadata_warning_for_failed_tier3() {
        use crate::package_library::ShippedDbLoad;
        let msg =
            super::format_missing_export_metadata_warning(&["foo".into()], ShippedDbLoad::Failed);
        assert!(msg.contains("couldn't load exported symbols for foo"));
        // A present-but-unusable DB: explain that, and steer toward re-downloading
        // a good copy rather than freezing project metadata.
        assert!(msg.contains("present but failed to load"));
        assert!(msg.contains("Run `raven packages update` to re-download"));
        assert!(
            !msg.contains("raven packages freeze"),
            "freeze is wrong advice when the DB merely failed to load: {msg}"
        );
    }

    #[test]
    fn missing_metadata_gate_respects_packages_disabled() {
        let mut state = crate::state::WorldState::new();
        state.cross_file_config.packages_enabled = false;
        let diags = vec![(
            PathBuf::from("main.R"),
            Diagnostic {
                message: "Undefined variable: missing_fun".into(),
                ..Default::default()
            },
        )];

        assert!(!super::should_check_missing_export_metadata(&state, &diags));
    }

    #[test]
    fn missing_metadata_gate_ignores_defined_later_diagnostics() {
        let mut state = crate::state::WorldState::new();
        state.cross_file_config.packages_enabled = true;
        let defined_later = vec![(
            PathBuf::from("main.R"),
            Diagnostic {
                message: "Undefined variable: x (defined later on line 3)".into(),
                ..Default::default()
            },
        )];
        assert!(!super::should_check_missing_export_metadata(
            &state,
            &defined_later
        ));

        let package_sensitive = vec![(
            PathBuf::from("main.R"),
            Diagnostic {
                message: "Undefined variable: mutate".into(),
                ..Default::default()
            },
        )];
        assert!(super::should_check_missing_export_metadata(
            &state,
            &package_sensitive
        ));
    }

    #[test]
    fn parse_defaults() {
        let args = parse_args(Vec::<String>::new().into_iter()).unwrap();
        assert!(args.paths.is_empty());
        assert_eq!(args.workspace, None);
        assert_eq!(args.format, OutputFormat::Text);
        assert_eq!(args.max_severity, SeverityLevel::Info);
        assert!(!args.no_config);
        assert_eq!(args.color, ColorChoice::Auto);
    }

    #[test]
    fn parse_color_and_no_color_alias() {
        let always = parse_args(["--color", "always"].iter().map(|s| s.to_string())).unwrap();
        assert_eq!(always.color, ColorChoice::Always);
        let never = parse_args(["--no-color"].iter().map(|s| s.to_string())).unwrap();
        assert_eq!(never.color, ColorChoice::Never);
        // Last-one-wins on conflict: `--no-color --color always` ⇒ always.
        let conflict = parse_args(
            ["--no-color", "--color", "always"]
                .iter()
                .map(|s| s.to_string()),
        )
        .unwrap();
        assert_eq!(conflict.color, ColorChoice::Always);
        // A bad --color value is a usage error.
        assert!(parse_args(["--color", "sometimes"].iter().map(|s| s.to_string())).is_err());
    }

    #[test]
    fn parse_workspace_and_paths() {
        let args = parse_args(
            ["--workspace", "/tmp/ws", "R/foo.R", "R/bar.R"]
                .iter()
                .map(|s| s.to_string()),
        )
        .unwrap();
        assert_eq!(args.workspace, Some(PathBuf::from("/tmp/ws")));
        assert_eq!(
            args.paths,
            vec![PathBuf::from("R/foo.R"), PathBuf::from("R/bar.R")]
        );
    }

    #[test]
    fn parse_format_and_severity() {
        let args = parse_args(
            ["--format", "sarif", "--max-severity", "error"]
                .iter()
                .map(|s| s.to_string()),
        )
        .unwrap();
        assert_eq!(args.format, OutputFormat::Sarif);
        assert_eq!(args.max_severity, SeverityLevel::Error);
    }

    #[test]
    fn parse_help_and_unknown_flag() {
        assert_eq!(
            parse_args(["--help"].iter().map(|s| s.to_string())).unwrap_err(),
            "HELP"
        );
        assert!(parse_args(["--bogus"].iter().map(|s| s.to_string())).is_err());
    }

    #[test]
    fn collect_targets_empty_walks_workspace() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("a.R"), "x <- 1\n").unwrap();
        fs::create_dir(tmp.path().join("R")).unwrap();
        fs::write(tmp.path().join("R/b.r"), "y <- 2\n").unwrap();
        fs::write(tmp.path().join("notes.Rmd"), "prose\n").unwrap();
        fs::create_dir(tmp.path().join(".git")).unwrap();
        fs::write(tmp.path().join(".git/c.R"), "z <- 3\n").unwrap();

        let mut operator_error = false;
        let targets = collect_report_targets(&[], tmp.path(), &mut operator_error);
        // Two .R/.r files + the .Rmd (its R chunks are diagnosed, #343); .git
        // skipped.
        assert_eq!(targets.len(), 3, "got {targets:?}");
        assert!(targets.iter().all(|p| is_r_file(p) || is_chunk_file(p)));
        assert!(targets.iter().any(|p| is_chunk_file(p)));
        assert!(!operator_error);
    }

    #[test]
    fn walk_includes_rmd_and_qmd() {
        // The empty-PATHS workspace walk collects chunk-bearing documents
        // alongside R sources, including mixed-case extensions
        // (is_chunk_file matches `.rmd`/`.qmd` case-insensitively).
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("a.R"), "x <- 1\n").unwrap();
        fs::write(tmp.path().join("report.Rmd"), "prose\n").unwrap();
        fs::write(tmp.path().join("paper.qmd"), "prose\n").unwrap();
        fs::write(tmp.path().join("UPPER.RMD"), "prose\n").unwrap();
        fs::write(tmp.path().join("UPPER.QMD"), "prose\n").unwrap();

        let mut operator_error = false;
        let targets = collect_report_targets(&[], tmp.path(), &mut operator_error);
        assert_eq!(targets.len(), 5, "got {targets:?}");
        let chunk_count = targets.iter().filter(|p| is_chunk_file(p)).count();
        assert_eq!(
            chunk_count, 4,
            "all four chunk files collected; got {targets:?}"
        );
        assert!(!operator_error);
    }

    #[test]
    fn collect_targets_explicit_chunk_file_included() {
        let tmp = TempDir::new().unwrap();
        let rmd = tmp.path().join("report.Rmd");
        fs::write(&rmd, "prose\n").unwrap();
        let mut operator_error = false;
        let targets =
            collect_report_targets(std::slice::from_ref(&rmd), tmp.path(), &mut operator_error);
        // Targets are canonicalized so they match the canonical workspace root.
        assert_eq!(targets, vec![std::fs::canonicalize(&rmd).unwrap()]);
        assert!(!operator_error);
    }

    #[test]
    fn collect_targets_nonexistent_flags_operator_error() {
        let tmp = TempDir::new().unwrap();
        let mut operator_error = false;
        let targets = collect_report_targets(
            &[PathBuf::from("no_such_file.R")],
            tmp.path(),
            &mut operator_error,
        );
        assert!(targets.is_empty());
        assert!(operator_error);
    }

    #[test]
    fn nonexistent_path_exits_operator_error() {
        let tmp = TempDir::new().unwrap();
        let mut args = base_args(tmp.path());
        args.paths = vec![tmp.path().join("missing.R")];
        assert_eq!(run_blocking(args), EXIT_OPERATOR_ERROR);
    }

    #[test]
    fn explicit_file_resolves_cross_file_scope() {
        // Regression: an explicitly-passed file must canonicalize so its URI
        // matches the canonical dependency-graph keys. Otherwise `add_one`
        // (defined in a sourced sibling) would be flagged undefined and the
        // sourced path would read as "outside workspace".
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("R")).unwrap();
        fs::write(
            tmp.path().join("R/helpers.R"),
            "add_one <- function(x) x + 1\n",
        )
        .unwrap();
        fs::write(
            tmp.path().join("R/main.R"),
            "source(\"helpers.R\")\nresult <- add_one(41)\n",
        )
        .unwrap();
        let mut args = base_args(tmp.path());
        args.paths = vec![tmp.path().join("R/main.R")];
        // A clean cross-file reference must not trip any diagnostic.
        assert_eq!(run_blocking(args), EXIT_OK);
    }
    #[test]
    fn namespace_only_package_root_gets_package_internal_scope() {
        // R's base-priority package sources use package-like roots with
        // NAMESPACE and R/ but no generated DESCRIPTION. Auto package mode must
        // still inject package-internal symbols for those workspaces, otherwise
        // sibling helpers in R/*.R are reported as undefined throughout the
        // corpus.
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("R")).unwrap();
        fs::write(tmp.path().join("NAMESPACE"), "export(helper_fn)\n").unwrap();
        fs::write(
            tmp.path().join("R/helper.R"),
            "helper_fn <- function(x) x + 1\n",
        )
        .unwrap();
        fs::write(tmp.path().join("R/main.R"), "result <- helper_fn(41)\n").unwrap();

        let args = base_args(tmp.path());
        let diags = collect_diagnostics_blocking(&args);
        assert!(
            !diags
                .iter()
                .any(|(_, d)| d.message.contains("Undefined variable: helper_fn")),
            "NAMESPACE + R/ without DESCRIPTION should still enable package-internal \
             scope. Diagnostics: {:?}",
            diags
                .iter()
                .map(|(_, d)| d.message.clone())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn base_priority_attached_package_exports_resolve_in_check() {
        // `grid` is a base-priority package shipped with R but not attached by
        // default. `raven check` must still resolve its exports after an
        // explicit `library(grid)` call; otherwise package tests that use
        // grid helpers like `grid.ls()` produce false undefined-variable
        // diagnostics.
        let Some(_) = crate::r_subprocess::RSubprocess::new(None) else {
            return;
        };
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("main.R"), "library(grid)\ngrid.ls()\n").unwrap();

        let args = base_args(tmp.path());
        let diags = collect_diagnostics_blocking(&args);
        assert!(
            !diags
                .iter()
                .any(|(_, d)| d.message == "Undefined variable: grid.ls"),
            "`library(grid)` must make `grid.ls` available to `raven check`. Diagnostics: {:?}",
            diags
                .iter()
                .map(|(_, d)| d.message.clone())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn package_own_sysdata_objects_resolve_without_data_raw() {
        // A fetched/committed package source can ship a binary `R/sysdata.rda`
        // with no `data-raw/` generating script at all (e.g. r-lib/cli). The
        // AST scan then finds nothing, so `raven check` must fall back to
        // loading the .rda via the R subprocess — otherwise the package's own
        // R/ code referencing its internal data flags as undefined (issue #429
        // corpus: cli's `emojis`, `spinners`, readr's `date_symbols`).
        let Some(_) = crate::r_subprocess::RSubprocess::new(None) else {
            eprintln!(
                "skipping package_own_sysdata_objects_resolve_without_data_raw: R not available"
            );
            return;
        };
        let fixture_rda =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sysdata_pkg/R/sysdata.rda");
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("R")).unwrap();
        fs::copy(&fixture_rda, tmp.path().join("R/sysdata.rda")).unwrap();
        fs::write(tmp.path().join("NAMESPACE"), "export(get_internal)\n").unwrap();
        fs::write(
            tmp.path().join("R/main.R"),
            "get_internal <- function() sysdata_var1\n",
        )
        .unwrap();

        let args = base_args(tmp.path());
        let diags = collect_diagnostics_blocking(&args);
        assert!(
            !diags
                .iter()
                .any(|(_, d)| d.message == "Undefined variable: sysdata_var1"),
            "a package's own R/ code must see its R/sysdata.rda objects via the \
             R fallback even with no data-raw/ script. Diagnostics: {:?}",
            diags
                .iter()
                .map(|(_, d)| d.message.clone())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn clean_file_exits_ok() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("clean.R"), "x <- 1\ny <- x + 1\n").unwrap();
        assert_eq!(run_blocking(base_args(tmp.path())), EXIT_OK);
    }

    /// Issue #476 (bug B): on a case-insensitive filesystem (macOS/Windows) a
    /// `source("child.r")` whose on-disk entry is `child.R` must still resolve the
    /// child's symbols — the resolved edge target URI is case-corrected to match
    /// the workspace-index key. Gated on actual FS case-insensitivity so it is a
    /// no-op (and not a false failure) on case-sensitive filesystems, where the
    /// two names are genuinely different files.
    #[test]
    fn case_mismatched_source_resolves_on_case_insensitive_fs_476() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("child.R"), "helper <- function() 1\n").unwrap();
        // Detect case-insensitivity: can we open the upper-case file via a
        // lower-case name?
        let case_insensitive = std::fs::metadata(tmp.path().join("child.r")).is_ok();
        if !case_insensitive {
            return; // case-sensitive FS: `child.r` is genuinely missing — skip.
        }
        fs::write(tmp.path().join("main.r"), "source(\"child.r\")\nhelper()\n").unwrap();

        let mut args = base_args(tmp.path());
        args.paths = vec![tmp.path().join("main.r")];
        let diags = collect_diagnostics_blocking(&args);
        assert!(
            !diags
                .iter()
                .any(|(_, d)| d.message == "Undefined variable: helper"),
            "source(\"child.r\") must resolve on-disk child.R on a case-insensitive FS \
             (issue #476). Diagnostics: {:?}",
            diags
                .iter()
                .map(|(_, d)| d.message.clone())
                .collect::<Vec<_>>()
        );
    }

    /// Issue #476 (bug B, converse): case-correction must NOT invent a resolution.
    /// On a case-SENSITIVE filesystem, `source("child.r")` when only `child.R`
    /// exists is a genuine missing file, so `helper` stays undefined. (The
    /// `canonical.exists()` guard means `canonicalize_case_below` never runs here.)
    /// Gated to case-sensitive filesystems; a no-op on macOS/Windows where the
    /// previous test covers the fold.
    #[test]
    fn case_mismatched_source_stays_undefined_on_case_sensitive_fs_476() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("child.R"), "helper <- function() 1\n").unwrap();
        let case_insensitive = std::fs::metadata(tmp.path().join("child.r")).is_ok();
        if case_insensitive {
            return; // case-insensitive FS: child.r aliases child.R — covered elsewhere.
        }
        fs::write(tmp.path().join("main.r"), "source(\"child.r\")\nhelper()\n").unwrap();

        let mut args = base_args(tmp.path());
        args.paths = vec![tmp.path().join("main.r")];
        let diags = collect_diagnostics_blocking(&args);
        assert!(
            diags
                .iter()
                .any(|(_, d)| d.message == "Undefined variable: helper"),
            "on a case-sensitive FS, source(\"child.r\") (only child.R exists) must NOT \
             resolve — case-correction only ever maps to a real on-disk entry. \
             Diagnostics: {:?}",
            diags
                .iter()
                .map(|(_, d)| d.message.clone())
                .collect::<Vec<_>>()
        );
    }

    /// Issue #476 (bug A): the WHOLE diagnostic pipeline must be deterministic, not
    /// just the graph-build order. Runs `collect_diagnostics_blocking` twice over a
    /// hub-and-spoke workspace (each run does an independent rayon scan + graph
    /// build + scope resolution) and asserts byte-identical diagnostic sets — so a
    /// future order-sensitivity introduced downstream of the graph sort (e.g. a
    /// HashMap in scope merging) is caught, not only backward-edge ordering.
    #[test]
    fn whole_pipeline_diagnostics_are_deterministic_476() {
        let tmp = TempDir::new().unwrap();
        // A shared helper hub plus several files that source it and a sibling that
        // (deliberately) references an undefined symbol, to give the run a stable
        // non-empty diagnostic set whose ordering/content could otherwise drift.
        fs::write(tmp.path().join("hub.r"), "shared <- function() 1\n").unwrap();
        for p in ["zeta.r", "alpha.r", "mike.r", "bravo.r"] {
            fs::write(
                tmp.path().join(p),
                "source(\"hub.r\")\nshared()\nnot_defined_here\n",
            )
            .unwrap();
        }

        let collect = || -> Vec<String> {
            let args = base_args(tmp.path());
            let mut v: Vec<String> = collect_diagnostics_blocking(&args)
                .into_iter()
                .map(|(p, d)| {
                    format!(
                        "{}:{}:{}",
                        p.file_name().and_then(|s| s.to_str()).unwrap_or(""),
                        d.range.start.line,
                        d.message
                    )
                })
                .collect();
            v.sort();
            v
        };

        let first = collect();
        let second = collect();
        assert_eq!(
            first, second,
            "whole-pipeline diagnostics must be identical run-to-run (issue #476 bug A)"
        );
        // Sanity: `shared` resolves (no false positive) while the genuine undefined
        // is reported — so the determinism assertion is over a meaningful set.
        assert!(
            !first
                .iter()
                .any(|d| d.contains("Undefined variable: shared")),
            "shared() should resolve via the hub. Got: {first:?}"
        );
        assert!(
            first
                .iter()
                .any(|d| d.contains("Undefined variable: not_defined_here")),
            "the genuine undefined should be reported. Got: {first:?}"
        );
    }

    /// Issue #476 (bug C): a heavily-sourced hub's parent-prefix over-approximates
    /// the union over ALL its callers, so a symbol the hub itself produces via a
    /// forward `source()` can ALSO land in the hub's parent prefix. The
    /// identical-binding no-op then left that name flagged parent-prefix-only and
    /// the leak filter dropped it when the hub was itself forward-sourced. This
    /// reproduces the `getArray` miniature: `caller` defines `helper` then sources
    /// `hub`; `hub` forward-sources `defs` (which also defines `helper`); `user`
    /// sources `hub` and must see `helper`.
    #[test]
    fn hub_forward_sourced_symbol_resolves_when_also_in_parent_prefix_476() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("defs.r"), "helper <- function() 1\n").unwrap();
        fs::write(tmp.path().join("hub.r"), "source(\"defs.r\")\n").unwrap();
        // A caller that sources `defs.r` itself BEFORE sourcing the hub. This seeds
        // `helper` into the hub's over-approximated parent prefix with the SAME
        // binding (`source_uri = defs.r`, same position) the hub's own forward
        // source produces — so the identical-binding no-op fires and (pre-fix)
        // leaves `helper` marked parent-prefix-only. This is the exact stale-marker
        // path the fix targets; a caller that defined its OWN `helper` would carry a
        // different `source_uri`, take the non-identical merge branch (which already
        // clears the marker), and resolve even without the fix.
        fs::write(
            tmp.path().join("caller.r"),
            "source(\"defs.r\")\nsource(\"hub.r\")\n",
        )
        .unwrap();
        // The file under test sources the hub and uses helper.
        fs::write(tmp.path().join("user.r"), "source(\"hub.r\")\nhelper()\n").unwrap();

        let mut args = base_args(tmp.path());
        args.paths = vec![tmp.path().join("user.r")];
        let diags = collect_diagnostics_blocking(&args);
        assert!(
            !diags
                .iter()
                .any(|(_, d)| d.message == "Undefined variable: helper"),
            "a hub's genuinely forward-sourced symbol must resolve even when it also \
             appears in the hub's parent prefix (issue #476). Diagnostics: {:?}",
            diags
                .iter()
                .map(|(_, d)| d.message.clone())
                .collect::<Vec<_>>()
        );
    }

    /// Issue #476 (bug D): a TOP-LEVEL `source(child, local = TRUE)` evaluates the
    /// child in the caller's environment (`.GlobalEnv` at top level, R `?source`),
    /// so the child sees the parent's prior top-level bindings — including regular
    /// (non-declared) symbols. This reproduces the `getPhrase` miniature: `parent`
    /// sources `defs` (defining `helper`) then sources `use` with `local = TRUE`;
    /// `use` must see `helper`.
    #[test]
    fn top_level_local_true_child_inherits_parent_regular_symbols_476() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("defs.r"), "helper <- function() 1\n").unwrap();
        fs::write(tmp.path().join("use.r"), "helper()\n").unwrap();
        fs::write(
            tmp.path().join("parent.r"),
            "source(\"defs.r\")\nsource(\"use.r\", local = TRUE)\n",
        )
        .unwrap();

        let mut args = base_args(tmp.path());
        args.paths = vec![tmp.path().join("use.r")];
        let diags = collect_diagnostics_blocking(&args);
        assert!(
            !diags
                .iter()
                .any(|(_, d)| d.message == "Undefined variable: helper"),
            "a top-level source(local = TRUE) child must inherit the parent's prior \
             regular symbols (issue #476). Diagnostics: {:?}",
            diags
                .iter()
                .map(|(_, d)| d.message.clone())
                .collect::<Vec<_>>()
        );
    }

    /// Shared setup for the two diagnostics-collection test drivers below.
    /// Mirrors `run`'s indexing + R-init + target-collection prelude and returns
    /// the indexed `WorldState` and report targets. Factored out so the
    /// sequential and parallel drivers resolve from byte-identical state — the
    /// precondition that makes `parallel_collection_matches_sequential` a
    /// like-for-like comparison (drift between two copied preludes would
    /// silently weaken the equivalence assertion). R-independent: callers that
    /// want package awareness configure `additionalLibraryPaths`.
    async fn setup_check_state_and_targets(
        args: &CheckArgs,
    ) -> (crate::state::WorldState, Vec<PathBuf>) {
        let root = std::fs::canonicalize(args.workspace.as_ref().unwrap()).unwrap();
        let workspace_url = Url::from_file_path(&root).unwrap();
        let mut state = build_indexed_state(&root, &workspace_url, args.no_config, None).unwrap();
        if !args.report_uninstalled {
            state.cross_file_config.packages_missing_package_severity = None;
        }
        maybe_init_r(&mut state, &root).await;
        state.resolve_system_file_in_workspace();
        maybe_load_sysdata_fallback(&mut state).await;
        let mut operator_error = false;
        let targets = collect_report_targets(&args.paths, &root, &mut operator_error);
        prefetch_reported_packages(&state, &targets).await;
        (state, targets)
    }

    /// Run `raven check` and capture the diagnostics it would compute, without
    /// the process-global stdout capture the renderer uses. Mirrors `run`'s
    /// indexing + report loop so a test can assert on the exact `(path,
    /// Diagnostic)` pairs (line/character) rather than just the exit code.
    fn collect_diagnostics_blocking(args: &CheckArgs) -> Vec<(PathBuf, Diagnostic)> {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (mut state, targets) = setup_check_state_and_targets(args).await;
            let mut all = Vec::new();
            for path in &targets {
                let uri = Url::from_file_path(path).unwrap();
                if let Some(doc) = state.workspace_index.get(&uri).cloned() {
                    state.documents.insert(uri.clone(), doc);
                } else {
                    let text = crate::state::read_source(path).unwrap();
                    // Same disk-fallback path `run` uses, so production and test
                    // exercise identical behavior (including the backward-directive
                    // parent_content map).
                    super::open_disk_fallback_target(&mut state, &uri, path, &text);
                }
                let diags = compute_file_diagnostics(&state, &uri).await;
                state.close_document(&uri);
                for d in diags {
                    all.push((path.clone(), d));
                }
            }
            all
        })
    }

    /// Like `collect_diagnostics_blocking` but drives the REAL parallel
    /// collection path (`collect_target_diagnostics`, the rayon phase `run`
    /// uses), so a test can assert the parallel output equals the sequential
    /// reference. Shares `setup_check_state_and_targets` with the sequential
    /// driver so the two start from identical state.
    fn collect_diagnostics_parallel_blocking(args: &CheckArgs) -> Vec<(PathBuf, Diagnostic)> {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (mut state, targets) = setup_check_state_and_targets(args).await;
            let (all, _packages, _oe) = collect_target_diagnostics(&mut state, &targets).await;
            all
        })
    }

    /// Issue #479 WI3: the parallel per-file collection must be byte-identical to
    /// a sequential run. The fixture is a hub sourced by several spokes with
    /// cross-file `source()` references, so neighbor artifacts are resolved —
    /// exactly the data a cross-worker open-document leak would corrupt. The
    /// sequential reference opens one doc at a time into `state.documents`; the
    /// parallel path uses per-worker one-entry overlays.
    #[test]
    fn parallel_collection_matches_sequential() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("hub.r"), "shared <- function() 1\n").unwrap();
        for p in ["a.r", "b.r", "c.r", "d.r"] {
            fs::write(
                tmp.path().join(p),
                "source(\"hub.r\")\nshared()\nbad_symbol\n",
            )
            .unwrap();
        }
        let args = base_args(tmp.path());

        let normalize = |mut v: Vec<(PathBuf, Diagnostic)>| {
            v.sort_by(|(pa, da), (pb, db)| {
                pa.cmp(pb)
                    .then(da.range.start.line.cmp(&db.range.start.line))
                    .then(da.range.start.character.cmp(&db.range.start.character))
                    .then(da.message.cmp(&db.message))
            });
            v.into_iter()
                .map(|(p, d)| (p, d.range.start.line, d.range.start.character, d.message))
                .collect::<Vec<_>>()
        };

        let seq = normalize(collect_diagnostics_blocking(&args));
        let par = normalize(collect_diagnostics_parallel_blocking(&args));
        assert_eq!(
            par, seq,
            "parallel collection must be byte-identical to the sequential reference"
        );
        // Sanity: the fixture actually exercises cross-file resolution — each
        // spoke flags `bad_symbol` (undefined), while `shared()` resolves through
        // the sourced hub and is NOT flagged.
        assert!(
            seq.iter().any(|(_, _, _, m)| m.contains("bad_symbol")),
            "fixture should produce undefined-variable diagnostics: {seq:?}"
        );
        assert!(
            !seq.iter().any(|(_, _, _, m)| m.contains("shared")),
            "shared() should resolve cross-file and not be flagged: {seq:?}"
        );
    }

    #[test]
    fn explicit_rmd_chunk_syntax_error_exits_failed() {
        // A syntax error inside an R chunk of a `.Rmd` must be reported, and at
        // DOCUMENT coordinates (not chunk-relative): the masked text preserves
        // line geometry, so the error's line equals its physical line in the
        // file. Prose lines precede the chunk to make the offset non-trivial.
        let tmp = TempDir::new().unwrap();
        let rmd = tmp.path().join("report.Rmd");
        // Lines (0-based):
        //   0: "# Title"
        //   1: ""
        //   2: "Some prose."
        //   3: "```{r}"
        //   4: "f <- function( {"   <- hard syntax error here
        //   5: "```"
        fs::write(
            &rmd,
            "# Title\n\nSome prose.\n```{r}\nf <- function( {\n```\n",
        )
        .unwrap();
        let mut args = base_args(tmp.path());
        args.paths = vec![rmd.clone()];
        assert_eq!(run_blocking(args.clone()), EXIT_LINT_FAILED);

        // Assert the finding lands on the chunk body line (document line 4),
        // proving geometry-preserving masking.
        let diags = collect_diagnostics_blocking(&args);
        assert!(
            diags.iter().any(|(_, d)| d.range.start.line == 4
                && d.severity == Some(tower_lsp::lsp_types::DiagnosticSeverity::ERROR)),
            "syntax error expected at document line 4 (0-based); got {:?}",
            diags
                .iter()
                .map(|(_, d)| (d.range.start.line, d.message.clone()))
                .collect::<Vec<_>>()
        );
    }

    /// R-free coverage that the CLI warming wiring extends the warm set with a
    /// document's `data(..., package = "pkg")` packages (issue #429). Deleting
    /// either `doc.data_packages` extend in `reported_packages_to_warm`
    /// regresses this. Builds the workspace index (no R subprocess) and inspects
    /// the pure package-set computation directly.
    fn warm_set_for(root: &Path) -> std::collections::HashSet<String> {
        let canon = std::fs::canonicalize(root).unwrap();
        let workspace_url = Url::from_file_path(&canon).unwrap();
        let state = build_indexed_state(&canon, &workspace_url, true, None).unwrap();
        let mut operator_error = false;
        let targets = collect_report_targets(&[], &canon, &mut operator_error);
        reported_packages_to_warm(&state, &targets)
    }

    #[test]
    fn warming_includes_data_package_from_indexed_r_file() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("analysis.R"),
            "data(api, package = \"survey\")\n",
        )
        .unwrap();
        let warm = warm_set_for(tmp.path());
        assert!(
            warm.contains("survey"),
            "data(api, package = \"survey\") in an indexed R file must contribute \
             `survey` to the warm set: {warm:?}"
        );
    }

    #[test]
    fn warming_includes_data_package_from_chunk_file() {
        // Chunk files are outside the R-only index, so the chunk-file branch of
        // `reported_packages_to_warm` reads them from disk and masks the body.
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("report.Rmd"),
            "# Title\n\n```{r}\ndata(lung, package = \"survival\")\n```\n",
        )
        .unwrap();
        let warm = warm_set_for(tmp.path());
        assert!(
            warm.contains("survival"),
            "data(lung, package = \"survival\") in an Rmd chunk must contribute \
             `survival` to the warm set: {warm:?}"
        );
    }

    #[test]
    fn rmd_prose_only_exits_ok() {
        // A `.Rmd` with no R chunks — only prose and a python chunk whose body
        // is invalid R — must produce no findings: prose is masked out and the
        // python chunk is not an R chunk, so its body never reaches the R
        // parser.
        let tmp = TempDir::new().unwrap();
        let rmd = tmp.path().join("prose.Rmd");
        fs::write(
            &rmd,
            "# Heading\n\nJust prose, no R here.\n\n```{python}\nthis is ( not valid R\n```\n",
        )
        .unwrap();
        let mut args = base_args(tmp.path());
        args.paths = vec![rmd.clone()];
        assert_eq!(run_blocking(args.clone()), EXIT_OK);
        assert!(
            collect_diagnostics_blocking(&args).is_empty(),
            "prose-only / non-R-chunk Rmd must yield no findings"
        );
    }

    #[test]
    fn rmd_chunk_source_resolves_cross_file() {
        // A chunk that `source()`s a sibling R file and then calls a function
        // defined there must NOT flag that function as undefined — proving the
        // CLI wires the opened Rmd's `source()` edge into the dependency graph
        // (the did_open parity step). The reverse — the same call WITHOUT the
        // source() line — IS flagged, so the test can't pass vacuously.
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("R")).unwrap();
        fs::write(
            tmp.path().join("R/util.R"),
            "helper_fn <- function(x) x + 1\n",
        )
        .unwrap();

        // With source(): clean.
        let analysis = tmp.path().join("analysis.Rmd");
        fs::write(
            &analysis,
            "# Analysis\n```{r}\nsource(\"R/util.R\")\nresult <- helper_fn(41)\n```\n",
        )
        .unwrap();
        let mut args = base_args(tmp.path());
        args.paths = vec![analysis.clone()];
        let with_source = collect_diagnostics_blocking(&args);
        assert!(
            !with_source
                .iter()
                .any(|(_, d)| d.message.contains("helper_fn")),
            "helper_fn must resolve through the sourced sibling; got {:?}",
            with_source
                .iter()
                .map(|(_, d)| d.message.clone())
                .collect::<Vec<_>>()
        );

        // Without source(): helper_fn is undefined and flagged. (Guards against
        // a vacuous pass where nothing is checked at all.)
        let no_source = tmp.path().join("nosrc.Rmd");
        fs::write(
            &no_source,
            "# Analysis\n```{r}\nresult <- helper_fn(41)\n```\n",
        )
        .unwrap();
        let mut args2 = base_args(tmp.path());
        args2.paths = vec![no_source.clone()];
        let without_source = collect_diagnostics_blocking(&args2);
        assert!(
            without_source
                .iter()
                .any(|(_, d)| d.message.contains("Undefined variable: helper_fn")),
            "without source(), helper_fn must be flagged undefined; got {:?}",
            without_source
                .iter()
                .map(|(_, d)| d.message.clone())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn rmd_params_respected_in_check() {
        // knitr/Quarto inject a `params` object into parameterized reports
        // whose frontmatter declares a top-level `params:` key. `raven check`
        // shares the snapshot diagnostic pipeline, so it must NOT flag `params`
        // as undefined for such a report. The use is a bare assignment RHS (not
        // a call argument) so the undefined-variable collector inspects it.
        let tmp = TempDir::new().unwrap();
        let rmd = tmp.path().join("report.Rmd");
        fs::write(
            &rmd,
            "---\ntitle: Report\nparams:\n  year: 2024\n---\n\n```{r}\nyr <- params$year\n```\n",
        )
        .unwrap();
        let mut args = base_args(tmp.path());
        args.paths = vec![rmd.clone()];
        assert_eq!(run_blocking(args.clone()), EXIT_OK);

        let diags = collect_diagnostics_blocking(&args);
        assert!(
            !diags
                .iter()
                .any(|(_, d)| d.message.contains("Undefined variable: params")),
            "params must not be flagged when frontmatter declares it; got {:?}",
            diags
                .iter()
                .map(|(_, d)| d.message.clone())
                .collect::<Vec<_>>()
        );

        // Guard against a vacuous pass: the SAME chunk without `params:` in the
        // frontmatter MUST flag `params` as undefined.
        let rmd2 = tmp.path().join("noparams.Rmd");
        fs::write(
            &rmd2,
            "---\ntitle: Report\n---\n\n```{r}\nyr <- params$year\n```\n",
        )
        .unwrap();
        let mut args2 = base_args(tmp.path());
        args2.paths = vec![rmd2.clone()];
        let diags2 = collect_diagnostics_blocking(&args2);
        assert!(
            diags2
                .iter()
                .any(|(_, d)| d.message.contains("Undefined variable: params")),
            "without a params: frontmatter, params must be flagged; got {:?}",
            diags2
                .iter()
                .map(|(_, d)| d.message.clone())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn rmd_missing_source_in_chunk_flagged() {
        // A chunk that source()s an absent file produces a missing-file
        // diagnostic (WARNING by default) at the chunk's document line.
        // Mirrors `missing_source_passes_when_threshold_raised`: it fails at the
        // default threshold and passes once --max-severity is raised to warning.
        let tmp = TempDir::new().unwrap();
        let rmd = tmp.path().join("main.Rmd");
        // Lines: 0 "# M", 1 "```{r}", 2 "source(\"nope.R\")", 3 "```"
        fs::write(&rmd, "# M\n```{r}\nsource(\"nope.R\")\n```\n").unwrap();
        let mut args = base_args(tmp.path());
        args.paths = vec![rmd.clone()];
        assert_eq!(run_blocking(args.clone()), EXIT_LINT_FAILED);

        // The missing-file finding lands on the chunk body line (document line 2).
        let diags = collect_diagnostics_blocking(&args);
        assert!(
            diags
                .iter()
                .any(|(_, d)| d.range.start.line == 2 && d.message.to_lowercase().contains("not")),
            "missing-source finding expected at document line 2; got {:?}",
            diags
                .iter()
                .map(|(_, d)| (d.range.start.line, d.message.clone()))
                .collect::<Vec<_>>()
        );

        // Raising the threshold to warning lets the WARNING-level missing-file
        // diagnostic pass, exactly like the plain-R case.
        let mut raised = args.clone();
        raised.max_severity = SeverityLevel::Warning;
        assert_eq!(run_blocking(raised), EXIT_OK);
    }

    #[test]
    fn syntax_error_exits_failed() {
        let tmp = TempDir::new().unwrap();
        // Unbalanced paren — a hard syntax error, always reported at ERROR.
        fs::write(tmp.path().join("broken.R"), "f <- function( {\n").unwrap();
        assert_eq!(run_blocking(base_args(tmp.path())), EXIT_LINT_FAILED);
    }

    /// Issue #433 acceptance criteria on the `raven check` surface: the
    /// tidy-eval wrapper repro produces no undefined-variable diagnostic,
    /// while a bare-symbol argument to a non-forwarding function still fails.
    ///
    /// The unqualified `filter` (no `library(dplyr)`) is deliberate — it is
    /// the issue's repro verbatim, and it pins the callee-blind embrace
    /// design: a bare `filter` resolves standard-eval through the builtin
    /// registry, so a covered-verb-position requirement would regress this.
    #[test]
    fn wrapper_mask_forwarding_passes_check() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("wrapper.R"),
            "df <- data.frame(x = 1:5)\n\
             my_filter <- function(data, cond) filter(data, {{ cond }})\n\
             my_filter(df, x > 2)\n",
        )
        .unwrap();
        assert_eq!(run_blocking(base_args(tmp.path())), EXIT_OK);
    }

    #[test]
    fn non_forwarding_function_argument_fails_check() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("plain.R"),
            "f <- function(x) x\nf(undefined_sym)\n",
        )
        .unwrap();
        assert_eq!(run_blocking(base_args(tmp.path())), EXIT_LINT_FAILED);
    }

    #[test]
    fn reports_undefined_symbol_from_attached_package() {
        // Regression (#8): editor/CI parity. When an installed package is
        // attached (`library(pkg)`), the editor prefetches its exports so a
        // bare call that ISN'T an export is flagged undefined. `raven check`
        // must do the same; without warming the cache the package reads as
        // "pending" and the call is suppressed, so the build would silently
        // pass over a real undefined symbol the editor flags.
        //
        // R-free: a fake installed package (a NAMESPACE with no exportPattern)
        // is parsed statically, and `additionalLibraryPaths` makes the library
        // `Ready` without R.
        let workspace = TempDir::new().unwrap();
        let libdir = TempDir::new().unwrap();
        let pkgdir = libdir.path().join("fakepkg");
        fs::create_dir_all(&pkgdir).unwrap();
        fs::write(
            pkgdir.join("DESCRIPTION"),
            "Package: fakepkg\nVersion: 1.0\n",
        )
        .unwrap();
        // Exports exactly one symbol; `fakepkg_missing` is deliberately absent.
        fs::write(pkgdir.join("NAMESPACE"), "export(real_export)\n").unwrap();
        fs::write(
            workspace.path().join("raven.toml"),
            format!(
                "[packages]\nadditionalLibraryPaths = [\"{}\"]\n",
                libdir.path().display()
            ),
        )
        .unwrap();
        fs::write(
            workspace.path().join("main.R"),
            "library(fakepkg)\nfakepkg_missing()\n",
        )
        .unwrap();

        let args = CheckArgs {
            paths: Vec::new(),
            workspace: Some(workspace.path().to_path_buf()),
            config_path: None,
            no_config: false,
            format: OutputFormat::Json,
            max_severity: SeverityLevel::Info,
            quiet: true,
            color: ColorChoice::Never,
            report_uninstalled: false,
        };
        assert_eq!(run_blocking(args), EXIT_LINT_FAILED);
    }

    #[test]
    fn namespace_full_import_export_resolves_in_value_position() {
        // Regression: in package mode, NAMESPACE `import(pkg)` whole-package
        // imports (`scope_contribution.full_imports`) must have their exports
        // prefetched just like per-file `library()` attaches. Without the
        // warm-up, call-position uses of an installed-but-uncached full
        // import are suppressed by the "pending" heuristic, but
        // value-position references (default args, bare identifiers) emit
        // false "Undefined variable" diagnostics — an asymmetry the editor
        // does not have once its cache is warm.
        //
        // R-free: a fake installed package (static NAMESPACE parse) made
        // `Ready` via `additionalLibraryPaths`, mirroring
        // `reports_undefined_symbol_from_attached_package`.
        let workspace = TempDir::new().unwrap();
        let libdir = TempDir::new().unwrap();
        let pkgdir = libdir.path().join("fakepkg");
        fs::create_dir_all(&pkgdir).unwrap();
        fs::write(
            pkgdir.join("DESCRIPTION"),
            "Package: fakepkg\nVersion: 1.0\n",
        )
        .unwrap();
        fs::write(pkgdir.join("NAMESPACE"), "export(real_export)\n").unwrap();

        // The workspace itself is a package whose NAMESPACE fully imports
        // fakepkg; R/uses.R references the export in VALUE position only.
        fs::write(
            workspace.path().join("DESCRIPTION"),
            "Package: testpkg\nVersion: 1.0\nImports: fakepkg\n",
        )
        .unwrap();
        fs::write(workspace.path().join("NAMESPACE"), "import(fakepkg)\n").unwrap();
        fs::create_dir_all(workspace.path().join("R")).unwrap();
        fs::write(
            workspace.path().join("R").join("uses.R"),
            "f <- function(x, .p = real_export) {\n  identical(x, real_export)\n}\n",
        )
        .unwrap();
        fs::write(
            workspace.path().join("raven.toml"),
            format!(
                "[packages]\nadditionalLibraryPaths = [\"{}\"]\n",
                libdir.path().display()
            ),
        )
        .unwrap();

        let args = CheckArgs {
            paths: Vec::new(),
            workspace: Some(workspace.path().to_path_buf()),
            config_path: None,
            no_config: false,
            format: OutputFormat::Json,
            max_severity: SeverityLevel::Info,
            quiet: true,
            color: ColorChoice::Never,
            report_uninstalled: false,
        };
        assert_eq!(
            run_blocking(args),
            EXIT_OK,
            "value-position references to a NAMESPACE full import must resolve \
             once its exports are prefetched"
        );
    }

    #[test]
    fn nonindexed_explicit_file_uses_disk_fallback() {
        // Regression (#3): the report loop reuses the workspace index's parsed
        // Document when present, but a target the scan didn't index — here an
        // explicit file outside the (empty) workspace root — must still be read
        // from disk and reported. A syntax error proves the fallback branch ran.
        let workspace = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let broken = outside.path().join("broken.R");
        fs::write(&broken, "g <- function( {\n").unwrap();
        let mut args = base_args(workspace.path());
        args.paths = vec![broken];
        assert_eq!(run_blocking(args), EXIT_LINT_FAILED);
    }

    #[test]
    fn non_utf8_file_is_reported_not_operator_error() {
        // A Latin-1 / Windows-1252 source file (here a bare 0xA0 non-breaking
        // space) is a property of the user's code, like a syntax error — not an
        // operator error. raven check reports it as a finding (exit 1) instead
        // of aborting the whole run (exit 2). The scan silently skips the
        // undecodable file; the report loop's disk fallback turns the encoding
        // failure into the diagnostic.
        let workspace = TempDir::new().unwrap();
        let mut bytes = b"x <- 1\n".to_vec();
        bytes.push(0xA0); // invalid UTF-8 start byte
        bytes.push(b'\n');
        fs::write(workspace.path().join("latin1.R"), bytes).unwrap();
        assert_eq!(run_blocking(base_args(workspace.path())), EXIT_LINT_FAILED);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_dir_file_is_reported() {
        // Regression (#1): a .R file reachable only through a symlinked
        // directory must have its diagnostics reported, not silently skipped.
        // Before the fix, the report walk skipped the symlink while the
        // indexer followed it, so `raven check` exited clean over a real
        // syntax error the editor would flag.
        let workspace = TempDir::new().unwrap();
        let external = TempDir::new().unwrap();
        // A hard syntax error lives in a directory OUTSIDE the workspace root,
        // reachable only via a symlink inside the workspace.
        fs::write(external.path().join("broken.R"), "f <- function( {\n").unwrap();
        std::os::unix::fs::symlink(external.path(), workspace.path().join("linked")).unwrap();

        assert_eq!(run_blocking(base_args(workspace.path())), EXIT_LINT_FAILED);
    }

    #[test]
    fn missing_source_file_exits_failed() {
        // Demonstrates a cross-file diagnostic that `raven lint` cannot produce:
        // a `source()` of a file that does not exist (missing-file = WARNING by
        // default, which exceeds the default --max-severity of `info`).
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("main.R"), "source(\"does_not_exist.R\")\n").unwrap();
        assert_eq!(run_blocking(base_args(tmp.path())), EXIT_LINT_FAILED);
    }

    #[test]
    fn missing_source_passes_when_threshold_raised() {
        // With --max-severity warning, a WARNING-level missing-file diagnostic
        // no longer fails the build.
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("main.R"), "source(\"does_not_exist.R\")\n").unwrap();
        let mut args = base_args(tmp.path());
        args.max_severity = SeverityLevel::Warning;
        assert_eq!(run_blocking(args), EXIT_OK);
    }

    /// Regression: `raven check` must honor `packages.additionalLibraryPaths`
    /// from `raven.toml`, exactly as the language server does via
    /// `backend::rebuild_package_library`. The configured path must end up in
    /// the resulting `PackageLibrary`'s search paths. R-independent: the
    /// additional paths are applied after R discovery, so the assertion holds
    /// whether or not R is installed.
    #[tokio::test]
    async fn maybe_init_r_honors_additional_library_paths() {
        let workspace = TempDir::new().unwrap();
        let extra_lib = TempDir::new().unwrap();
        let mut state = crate::state::WorldState::new();
        state.cross_file_config.packages_additional_library_paths =
            vec![extra_lib.path().to_path_buf()];

        maybe_init_r(&mut state, workspace.path()).await;

        assert!(
            state
                .package_library
                .lib_paths()
                .iter()
                .any(|p| p == extra_lib.path()),
            "check must honor packages.additionalLibraryPaths; got {:?}",
            state.package_library.lib_paths()
        );
    }

    /// Regression: `raven check` must honor `packages.enabled = false`,
    /// matching the language server's `backend::rebuild_package_library`, which
    /// returns an empty library without spawning R when packages are disabled.
    /// With the gate, even a configured additional library path is left
    /// unapplied and the library stays not-ready — so a user who disabled
    /// package awareness in their editor doesn't get package diagnostics in CI.
    /// R-independent: the gate short-circuits before R discovery.
    #[tokio::test]
    async fn maybe_init_r_skips_when_packages_disabled() {
        let workspace = TempDir::new().unwrap();
        let extra_lib = TempDir::new().unwrap();
        let mut state = crate::state::WorldState::new();
        state.cross_file_config.packages_enabled = false;
        state.cross_file_config.packages_additional_library_paths =
            vec![extra_lib.path().to_path_buf()];

        maybe_init_r(&mut state, workspace.path()).await;

        assert!(
            !state.package_library_ready,
            "packages.enabled = false must leave the library not-ready"
        );
        assert!(
            state.package_library.lib_paths().is_empty(),
            "packages.enabled = false must not populate library paths; got {:?}",
            state.package_library.lib_paths()
        );
    }

    /// Regression: `raven check` must KEEP the Tier 2/3-carrying library even on a
    /// degraded status (e.g. R absent in CI), and mark it ready so the offline
    /// package-resolution path this PR adds actually runs. A synthetic Tier 3
    /// package — installable nowhere — must resolve through `maybe_init_r`'s
    /// installed library.
    #[tokio::test]
    async fn maybe_init_r_keeps_provider_library_when_r_absent() {
        use crate::package_db::binary_db::{ShippedDbProvenance, write_shipped_db};
        use crate::package_db::model::PackageRecord;

        let _env = crate::package_db::RAVEN_NAMES_DB_ENV_LOCK.lock().await;
        let pkg = "ravenfakecheckpkg";
        let sym = "ravenfakechecksym";
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("names.db");
        write_shipped_db(
            &db_path,
            &[PackageRecord {
                name: pkg.into(),
                version: "1.0.0".into(),
                exports: vec![sym.into()],
                depends: vec![],
                lazy_data: vec![],
            }],
            ShippedDbProvenance {
                source: "test".into(),
                snapshot_date: "2026-05-30".into(),
                package_count: 1,
                raven_version: "9.9.9".into(),
            },
        )
        .unwrap();

        let workspace = TempDir::new().unwrap();
        let _db_env = crate::package_db::NamesDbEnvGuard::set(&db_path);
        let mut state = crate::state::WorldState::new();
        maybe_init_r(&mut state, workspace.path()).await;

        // The Tier 3 provider survived (library not dropped) and is marked ready,
        // so prefetch + resolution can run even though R is irrelevant here.
        assert!(
            state.package_library_ready,
            "a library carrying Tier 3 providers must be marked ready"
        );
        state
            .package_library
            .prefetch_packages(&[pkg.to_string()])
            .await;
        assert!(
            state
                .package_library
                .is_symbol_from_loaded_packages(sym, &[pkg.to_string()]),
            "Tier 3 export must resolve through the check-installed library"
        );
        // The synthetic package is still not "installed" (Tier-1-only).
        assert!(!state.package_library.package_exists(pkg));
    }
}
