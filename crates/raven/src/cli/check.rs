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
    collect_r_file_paths, is_chunk_file, is_r_file, parse_output_format, parse_severity_level,
    print_json, print_sarif, print_text, OutputFormat, SeverityLevel, EXIT_LINT_FAILED, EXIT_OK,
    EXIT_OPERATOR_ERROR,
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
    /// Accepted for forward compatibility; `text` output is currently uncolored,
    /// so this has no visible effect yet (parity with `raven lint`).
    pub no_color: bool,
}

pub fn parse_args(mut argv: impl Iterator<Item = String>) -> Result<CheckArgs, String> {
    let mut paths = Vec::new();
    let mut workspace = None;
    let mut config_path = None;
    let mut no_config = false;
    let mut format = OutputFormat::Text;
    let mut max_severity = SeverityLevel::Info;
    let mut quiet = false;
    let mut no_color = false;

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
            "--no-color" => no_color = true,
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
        no_color,
    })
}

pub fn print_help() {
    println!(
        "raven check {} — full R diagnostics for CI

Usage: raven check [OPTIONS] [PATHS...]

Indexes the workspace, then reports the full diagnostic set for the requested
files (or every R file in the workspace when no PATHS are given): syntax errors,
semantic checks, style lints, cross-file diagnostics (missing source files,
circular dependencies, out-of-scope usage), missing-package warnings, and
undefined-variable diagnostics. Honors raven.toml / .lintr.

Options:
  --workspace DIR             Workspace root to index (default: current directory)
  --config PATH               Path to raven.toml (default: search upward from --workspace)
  --no-config                 Use built-in defaults; ignore raven.toml/.lintr
  --format text|json|sarif    Output format (default: text)
  --max-severity LEVEL        Highest severity that does NOT fail the build
                              (off, hint, info, warning, error; default: info)
  --quiet                     Suppress summary line in text output
  --no-color                  Disable ANSI colors

R / packages:
  raven check auto-detects R on PATH to resolve installed-package exports and
  base R symbols. If R is not found, package and base-symbol diagnostics are
  limited and a note is printed to stderr; all other diagnostics still run.

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

    // Auto-detect R for installed-package / base-symbol awareness. Any failure
    // (R absent, init error, no library paths) degrades gracefully and prints
    // its own one-line note to stderr.
    maybe_init_r(&mut state, &root).await;

    // Resolve which files to report diagnostics for. A named path that does not
    // exist is an operator error (exit 2), matching `raven lint`.
    let mut operator_error = false;
    let targets = collect_report_targets(&args.paths, &root, &mut operator_error);

    let mut all_diags: Vec<(PathBuf, Diagnostic)> = Vec::new();

    for path in &targets {
        if is_chunk_file(path) {
            // Chunk extraction isn't supported on the command line; mirror lint.
            eprintln!(
                "raven check: skipping {} (chunk-bearing file; diagnostics are R-only — see docs/cli.md)",
                path.display()
            );
            continue;
        }
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("raven check: cannot read {}: {e}", path.display());
                operator_error = true;
                continue;
            }
        };
        let Ok(uri) = Url::from_file_path(path) else {
            eprintln!("raven check: cannot convert path to URL: {}", path.display());
            operator_error = true;
            continue;
        };
        // The diagnostic snapshot reads the target from `state.documents`, which
        // the workspace scan does NOT populate — so each reported file must be
        // opened explicitly. Close it afterwards to bound memory across a large
        // report set.
        state.open_document_with_language_id(uri.clone(), &text, Some(1), Some("r"));
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

    match args.format {
        OutputFormat::Text => print_text(&all_diags, &root, args.quiet),
        OutputFormat::Json => print_json(&all_diags, &root),
        OutputFormat::Sarif => print_sarif(&all_diags, &root),
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
    let desc_text: Option<std::sync::Arc<str>> =
        std::fs::read_to_string(root.join("DESCRIPTION")).ok().map(|t| t.into());
    let ns_text: Option<std::sync::Arc<str>> =
        std::fs::read_to_string(root.join("NAMESPACE")).ok().map(|t| t.into());
    let disk_r_files = crate::backend::collect_package_r_file_inputs_from_disk(root);
    crate::backend::initialize_package_inputs_from_state(
        &mut state,
        root.to_path_buf(),
        desc_text,
        ns_text,
        disk_r_files,
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
    if let Some(explicit) = config_path {
        return match crate::config_file::load_toml(explicit) {
            Some(l) => {
                for w in l.warnings {
                    eprintln!("{w}");
                }
                Ok((Some(l.settings), Some(explicit.to_path_buf())))
            }
            None => {
                eprintln!("raven check: failed to load --config {}", explicit.display());
                Err(EXIT_OPERATOR_ERROR)
            }
        };
    }
    match crate::config_file::find_config(search_start) {
        crate::config_file::DiscoveredConfig::RavenToml(p) => {
            match crate::config_file::load_toml(&p) {
                Some(l) => {
                    for w in l.warnings {
                        eprintln!("{w}");
                    }
                    Ok((Some(l.settings), Some(p)))
                }
                None => {
                    eprintln!("raven check: failed to load {}", p.display());
                    Err(EXIT_OPERATOR_ERROR)
                }
            }
        }
        crate::config_file::DiscoveredConfig::Lintr(p) => match std::fs::read_to_string(&p) {
            Ok(text) => {
                let l = crate::config_file::load_lintr_str(&text);
                for w in l.warnings {
                    eprintln!("{w}");
                }
                Ok((Some(l.settings), Some(p)))
            }
            Err(e) => {
                eprintln!("raven check: cannot read {}: {e}", p.display());
                Err(EXIT_OPERATOR_ERROR)
            }
        },
        crate::config_file::DiscoveredConfig::None => Ok((None, None)),
    }
}

/// Auto-detect R on PATH and initialize the package library so installed-package
/// exports and base R symbols are available. On success the library and
/// `package_library_ready = true` are stored on `state`. Every degradation path
/// (R absent, init error, no library paths) leaves the default empty library in
/// place and prints a specific one-line note to stderr so the message reflects
/// what actually happened.
async fn maybe_init_r(state: &mut crate::state::WorldState, root: &Path) {
    let root_owned = root.to_path_buf();
    // R discovery performs synchronous IO (which/where, R --version); run it off
    // the async executor, mirroring the LSP startup path in backend.rs.
    let subprocess = tokio::task::spawn_blocking(move || {
        crate::r_subprocess::RSubprocess::new(None).map(|s| s.with_working_dir(root_owned))
    })
    .await
    .unwrap_or(None);

    let Some(subprocess) = subprocess else {
        eprintln!(
            "raven check: R not found on PATH; package and base-symbol diagnostics will be limited"
        );
        return;
    };

    let mut lib = crate::package_library::PackageLibrary::with_subprocess(Some(subprocess));
    match lib.initialize().await {
        Ok(()) if !lib.lib_paths().is_empty() => {
            state.package_library = std::sync::Arc::new(lib);
            state.package_library_ready = true;
        }
        Ok(()) => {
            eprintln!(
                "raven check: R found but no library paths were discovered; package and base-symbol diagnostics will be limited"
            );
        }
        Err(e) => {
            eprintln!(
                "raven check: R found but its package library failed to initialize ({e}); package and base-symbol diagnostics will be limited"
            );
        }
    }
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
/// file under the workspace root. Explicit paths are taken as-is (files) or
/// walked (directories). The result is sorted and de-duplicated for stable
/// output. An explicitly-named chunk file (`.Rmd`/`.qmd`) is included so the
/// caller can emit the one-line skip note; chunk files found while walking a
/// directory are not collected (they aren't R sources for diagnostics).
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
fn collect_report_targets(paths: &[PathBuf], root: &Path, operator_error: &mut bool) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if paths.is_empty() {
        collect_r_file_paths(root, &mut out);
    } else {
        for p in paths {
            let abs = if p.is_absolute() { p.clone() } else { root.join(p) };
            let abs = std::fs::canonicalize(&abs).unwrap_or(abs);
            if abs.is_dir() {
                collect_r_file_paths(&abs, &mut out);
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
            no_color: true,
        }
    }

    #[test]
    fn parse_defaults() {
        let args = parse_args(Vec::<String>::new().into_iter()).unwrap();
        assert!(args.paths.is_empty());
        assert_eq!(args.workspace, None);
        assert_eq!(args.format, OutputFormat::Text);
        assert_eq!(args.max_severity, SeverityLevel::Info);
        assert!(!args.no_config);
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
        // Two .R/.r files; .Rmd not collected during the walk; .git skipped.
        assert_eq!(targets.len(), 2);
        assert!(targets.iter().all(|p| is_r_file(p)));
        assert!(!operator_error);
    }

    #[test]
    fn collect_targets_explicit_chunk_file_included() {
        let tmp = TempDir::new().unwrap();
        let rmd = tmp.path().join("report.Rmd");
        fs::write(&rmd, "prose\n").unwrap();
        let mut operator_error = false;
        let targets = collect_report_targets(&[rmd.clone()], tmp.path(), &mut operator_error);
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
        fs::write(tmp.path().join("R/helpers.R"), "add_one <- function(x) x + 1\n").unwrap();
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

    #[test]
    fn syntax_error_exits_failed() {
        let tmp = TempDir::new().unwrap();
        // Unbalanced paren — a hard syntax error, always reported at ERROR.
        fs::write(tmp.path().join("broken.R"), "f <- function( {\n").unwrap();
        assert_eq!(run_blocking(base_args(tmp.path())), EXIT_LINT_FAILED);
    }

    #[test]
    fn missing_source_file_exits_failed() {
        // Demonstrates a cross-file diagnostic that `raven lint` cannot produce:
        // a `source()` of a file that does not exist (missing-file = WARNING by
        // default, which exceeds the default --max-severity of `info`).
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("main.R"),
            "source(\"does_not_exist.R\")\n",
        )
        .unwrap();
        assert_eq!(run_blocking(base_args(tmp.path())), EXIT_LINT_FAILED);
    }

    #[test]
    fn missing_source_passes_when_threshold_raised() {
        // With --max-severity warning, a WARNING-level missing-file diagnostic
        // no longer fails the build.
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("main.R"),
            "source(\"does_not_exist.R\")\n",
        )
        .unwrap();
        let mut args = base_args(tmp.path());
        args.max_severity = SeverityLevel::Warning;
        assert_eq!(run_blocking(args), EXIT_OK);
    }
}
