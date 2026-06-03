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

use tower_lsp::lsp_types::{Diagnostic, Url};

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
    // its own one-line note to stderr.
    maybe_init_r(&mut state, &root).await;

    // Resolve which files to report diagnostics for. A named path that does not
    // exist is an operator error (exit 2), matching `raven lint`.
    let mut operator_error = false;
    let targets = collect_report_targets(&args.paths, &root, &mut operator_error);

    // Warm the package-export cache before computing diagnostics, matching the
    // editor's post-scan prefetch (see [`prefetch_reported_packages`]).
    prefetch_reported_packages(&state, &targets).await;

    let mut all_diags: Vec<(PathBuf, Diagnostic)> = Vec::new();
    let mut reported_loaded_packages = std::collections::BTreeSet::new();

    for path in &targets {
        let Ok(uri) = Url::from_file_path(path) else {
            eprintln!(
                "raven check: cannot convert path to URL: {}",
                path.display()
            );
            operator_error = true;
            continue;
        };
        // `DiagnosticsSnapshot::build` reads the target from `state.documents`,
        // which the workspace scan does NOT populate — it stores parsed
        // `Document`s (tree included) in `state.workspace_index`. Reuse that
        // already-parsed `Document` instead of re-reading the file from disk
        // and re-parsing it: in the common "report the whole workspace" run
        // that halves the tree-sitter work (parse once during the scan, not
        // again here). Fall back to reading from disk only for a target the
        // scan didn't index (e.g. a path the report walk reached through a
        // different symlink alias, OR a chunk file — `.Rmd`/`.qmd` are
        // deliberately outside the R-only workspace scan). Either way the
        // document is removed afterwards to bound memory across a large report
        // set; the clone keeps the index entry intact for other files'
        // cross-file resolution.
        if let Some(doc) = state.workspace_index.get(&uri).cloned() {
            state.documents.insert(uri.clone(), doc);
        } else {
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
            // Pass an honest language id so the Document classifies the chunk
            // kind correctly: "rmd" for `.Rmd`/`.qmd` (the constructor reads
            // the URI to classify it as Rmd and masks the prose), "r"
            // otherwise. `file_type_from_language_id("rmd")` is `None`, so the
            // `FileType` still falls back to R via the URI — only the chunk
            // masking differs.
            let language_id = if is_chunk_file(path) { "rmd" } else { "r" };
            state.open_document_with_language_id(uri.clone(), &text, Some(1), Some(language_id));

            // Wire the disk-fallback target's outgoing edges into the
            // dependency graph. Workspace-scanned files get their edges from
            // `build_dependency_graph_from_workspace`, but a disk-fallback
            // target (always the case for `.Rmd`/`.qmd`, which the R-only scan
            // skips) was never passed to `update_file`. Without this,
            // `cached_neighborhood_subgraph(uri, …)` returns an empty
            // neighborhood, so a chunk `source("R/util.R")` wouldn't resolve —
            // producing false undefined-variable positives and losing
            // missing-file context. Mirror `backend`'s did_open: extract masked
            // metadata for the path, enrich it with the inherited working
            // directory, then update the graph. The masked extraction reads
            // chunk-body `source()`/`library()` calls only (never prose).
            let workspace_root = state.workspace_folders.first().cloned();
            let max_chain_depth = state.cross_file_config.max_chain_depth;
            let mut meta = crate::cross_file::extract_metadata_for_path(uri.path(), &text);
            crate::cross_file::enrich_metadata_with_inherited_wd(
                &mut meta,
                &uri,
                workspace_root.as_ref(),
                |parent_uri| state.get_enriched_metadata(parent_uri),
                max_chain_depth,
            );
            // Pre-collect parent content for any backward directives
            // (`@lsp-sourced-by` with `match=`/inference call sites) before the
            // mutable `update_file` borrow, mirroring did_open. Forward
            // `source()` edges — the only kind chunk targets normally have —
            // don't consult this closure, so it's empty in the common case.
            let backward_path_ctx =
                crate::cross_file::path_resolve::PathContext::new(&uri, workspace_root.as_ref());
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
            state.cross_file_graph.update_file(
                &uri,
                &meta,
                workspace_root.as_ref(),
                |parent_uri| parent_content.get(parent_uri).cloned(),
            );
        }
        // Both arms above leave the document in `state.documents`; collect its
        // attached packages from the doc already in hand (free — the loop opens
        // each target for diagnostics regardless). This intentionally also covers
        // the disk-fallback arm, unlike the index-only up-front
        // `prefetch_reported_packages` warm-up.
        if let Some(doc) = state.documents.get(&uri) {
            reported_loaded_packages.extend(doc.loaded_packages.iter().cloned());
        }
        let diags = compute_file_diagnostics(&state, &uri).await;
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
        let tier3_present = crate::package_db::locate_shipped_db_candidates()
            .into_iter()
            .any(|p| p.exists());
        eprintln!(
            "{}",
            format_missing_export_metadata_warning(
                &missing_export_metadata_packages,
                tier3_present
            )
        );
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

    let mut state = crate::state::WorldState::new(crate::r_env::find_library_paths());
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
async fn maybe_init_r(state: &mut crate::state::WorldState, root: &Path) {
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
/// relative to the editor. Cross-file *inherited* packages (attached in a
/// `source()`d file) and packages of non-chunk targets the scan did not index
/// are not prefetched here, so calls relying on those stay conservatively
/// suppressed — a narrower gap than before, noted in `docs/cli.md`. No-op when
/// the library isn't ready (e.g. R absent with no configured library paths).
async fn prefetch_reported_packages(state: &crate::state::WorldState, targets: &[PathBuf]) {
    if !state.package_library_ready {
        return;
    }
    let mut packages: std::collections::HashSet<String> = std::collections::HashSet::new();
    for path in targets {
        let Ok(uri) = Url::from_file_path(path) else {
            continue;
        };
        if let Some(doc) = state.workspace_index.get(&uri) {
            packages.extend(doc.loaded_packages.iter().cloned());
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
            }
        }
    }
    let packages: Vec<String> = packages
        .into_iter()
        .filter(|p| crate::r_subprocess::is_valid_package_name(p))
        .collect();
    // `prefetch_packages` is a no-op on an empty slice, so no length guard here.
    state.package_library.prefetch_packages(&packages).await;
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

fn format_missing_export_metadata_warning(packages: &[String], tier3_present: bool) -> String {
    let mut names = packages.to_vec();
    names.sort();
    names.dedup();
    names.truncate(8);
    let names = names.join(", ");

    let (detail, verb) = if tier3_present {
        (
            "Raven checked installed packages, .raven/packages.json, and names.db.",
            "refresh",
        )
    } else {
        ("Tier 3 names.db is not installed.", "install")
    };
    format!(
        "raven check: package export metadata is missing for {names}.\n{detail}\nRun `raven packages update` to {verb} names.db, or `raven packages freeze` to capture project package metadata."
    )
}

/// Run the full diagnostic pipeline for one already-opened document. Returns an
/// empty vec when the snapshot can't be built (parse failure or document not
/// open). A malformed file is not an operator error here — its reportable
/// syntax errors are surfaced like any other diagnostic when the tree still
/// builds.
async fn compute_file_diagnostics(state: &crate::state::WorldState, uri: &Url) -> Vec<Diagnostic> {
    let Some(snapshot) = crate::handlers::DiagnosticsSnapshot::build(state, uri) else {
        return Vec::new();
    };
    let cancel = crate::handlers::DiagCancelToken::never();
    let Some(sync_diags) = crate::handlers::diagnostics_from_snapshot(&snapshot, uri, &cancel)
    else {
        return Vec::new();
    };
    // Replace the snapshot's cache-based missing-file checks with real on-disk
    // existence checks — exactly what the LSP publish path does.
    let missing_file_severity = snapshot.cross_file_config.missing_file_severity;
    crate::handlers::diagnostics_async_standalone(
        uri,
        sync_diags,
        &snapshot.directive_meta,
        state.workspace_folders.first(),
        missing_file_severity,
    )
    .await
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
    fn formats_missing_metadata_warning_for_absent_tier3() {
        let msg =
            super::format_missing_export_metadata_warning(&["foo".into(), "bar".into()], false);
        assert!(
            msg.contains("package export metadata is missing for bar, foo")
                || msg.contains("package export metadata is missing for foo, bar")
        );
        assert!(msg.contains("Tier 3 names.db is not installed"));
        assert!(msg.contains("raven packages update"));
        assert!(msg.contains("raven packages freeze"));
    }

    #[test]
    fn formats_missing_metadata_warning_for_present_tier3_miss() {
        let msg = super::format_missing_export_metadata_warning(&["foo".into()], true);
        assert!(
            msg.contains("Raven checked installed packages, .raven/packages.json, and names.db")
        );
        assert!(msg.contains("raven packages update"));
        assert!(msg.contains("raven packages freeze"));
    }

    #[test]
    fn missing_metadata_gate_respects_packages_disabled() {
        let mut state = crate::state::WorldState::new(vec![]);
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
        let mut state = crate::state::WorldState::new(vec![]);
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
        // (is_chunk_file matches the explicit list Rmd/rmd/RMD/qmd/Qmd/QMD).
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
    fn clean_file_exits_ok() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("clean.R"), "x <- 1\ny <- x + 1\n").unwrap();
        assert_eq!(run_blocking(base_args(tmp.path())), EXIT_OK);
    }

    /// Run `raven check` and capture the diagnostics it would compute, without
    /// the process-global stdout capture the renderer uses. Mirrors `run`'s
    /// indexing + report loop so a test can assert on the exact `(path,
    /// Diagnostic)` pairs (line/character) rather than just the exit code.
    /// R-independent: callers that want package awareness configure
    /// `additionalLibraryPaths`.
    fn collect_diagnostics_blocking(args: &CheckArgs) -> Vec<(PathBuf, Diagnostic)> {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let root = std::fs::canonicalize(args.workspace.as_ref().unwrap()).unwrap();
            let workspace_url = Url::from_file_path(&root).unwrap();
            let mut state =
                build_indexed_state(&root, &workspace_url, args.no_config, None).unwrap();
            if !args.report_uninstalled {
                state.cross_file_config.packages_missing_package_severity = None;
            }
            maybe_init_r(&mut state, &root).await;
            let mut operator_error = false;
            let targets = collect_report_targets(&args.paths, &root, &mut operator_error);
            prefetch_reported_packages(&state, &targets).await;
            let mut all = Vec::new();
            for path in &targets {
                let uri = Url::from_file_path(path).unwrap();
                if let Some(doc) = state.workspace_index.get(&uri).cloned() {
                    state.documents.insert(uri.clone(), doc);
                } else {
                    let text = crate::state::read_source(path).unwrap();
                    let language_id = if is_chunk_file(path) { "rmd" } else { "r" };
                    state.open_document_with_language_id(
                        uri.clone(),
                        &text,
                        Some(1),
                        Some(language_id),
                    );
                    let workspace_root = state.workspace_folders.first().cloned();
                    let max_chain_depth = state.cross_file_config.max_chain_depth;
                    let mut meta = crate::cross_file::extract_metadata_for_path(uri.path(), &text);
                    crate::cross_file::enrich_metadata_with_inherited_wd(
                        &mut meta,
                        &uri,
                        workspace_root.as_ref(),
                        |parent_uri| state.get_enriched_metadata(parent_uri),
                        max_chain_depth,
                    );
                    // Unlike `run`, skip the `parent_content` map: no test
                    // routed through this helper uses backward directives
                    // (`@lsp-sourced-by` match=/inference), which is all that
                    // closure feeds. The production path in `run` is complete.
                    state.cross_file_graph.update_file(
                        &uri,
                        &meta,
                        workspace_root.as_ref(),
                        |_| None,
                    );
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
        let mut state = crate::state::WorldState::new(vec![]);
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
        let mut state = crate::state::WorldState::new(vec![]);
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
        let mut state = crate::state::WorldState::new(vec![]);
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
