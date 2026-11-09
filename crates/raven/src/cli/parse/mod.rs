//! `raven parse`: print what Raven parsed in each R file, as one JSON document
//! per file (JSON Lines).
//!
//! The command runs the setup `raven check` and `raven graph` share
//! (`cli::check::prepare_workspace`), so configuration, exclusions and paths
//! agree with theirs. Each document's `path` is formatted by the graph's own
//! path function, so it equals the graph's `files[].path` for the same file.
//!
//! Layout:
//! - `document`: the per-file envelope, the error document, positions.
//! - `statements`: statements and the comments each one owns.
//! - `tree`: the expression tree on each statement.
//! - `literals`: number types and values, string and name decoding, as R reads them.
//! - `errors`: the `errors` list (syntax errors, literal errors and warnings).
//! - `directives`: each comment's parsed directive.
//! - `resolve`: what each call, and each value name, resolves to.
//!
//! `docs/cli.md` (`raven parse`) is the contract.

mod directives;
mod document;
mod errors;
mod literals;
mod resolve;
mod statements;
mod tree;

use std::io::Write as _;
use std::path::{Path, PathBuf};

use tower_lsp::lsp_types::Url;

use crate::cli::check::{
    PreparedWorkspace, WorkspaceSetup, maybe_load_sysdata_fallback, prefetch_reported_packages,
    prepare_workspace, resolve_workspace_root,
};
use crate::cli::graph::{display_fs_path, display_path};
use crate::cli::shared::{
    EXIT_OK, EXIT_OPERATOR_ERROR, absolute_path, collect_r_file_paths_with_exclusions, is_r_file,
};

pub use document::SCHEMA_VERSION;

/// Every requested file was printed, but at least one as the error document.
pub const EXIT_UNREADABLE: i32 = 3;

#[derive(Debug, Clone, PartialEq)]
pub struct ParseArgs {
    /// Files or directories to print. Empty means every R file the workspace
    /// scan finds.
    pub files: Vec<PathBuf>,
    pub workspace: Option<PathBuf>,
    pub config_path: Option<PathBuf>,
    pub no_config: bool,
}

pub fn parse_args(mut argv: impl Iterator<Item = String>) -> Result<ParseArgs, String> {
    let mut args = ParseArgs {
        files: Vec::new(),
        workspace: None,
        config_path: None,
        no_config: false,
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
            "--format" => match argv.next().ok_or("--format needs a value")?.as_str() {
                "json" => {}
                other => {
                    return Err(format!(
                        "unknown --format value: {other} (raven parse supports json)"
                    ));
                }
            },
            "--help" => return Err("HELP".into()),
            s if s.starts_with("--") => return Err(format!("unknown flag: {s}")),
            path => args.files.push(PathBuf::from(path)),
        }
    }
    Ok(args)
}

pub fn print_help() {
    println!(
        "raven parse {} — print what Raven parsed in each R file, as JSON

Usage: raven parse [OPTIONS] [FILES...]

Indexes the workspace exactly as `raven check` does, then prints one JSON
document per line for each requested `.R`/`.r` file, in the order requested:
every statement with its source text, range, and syntax tree, every comment
with the directive it carries, what each call's function resolves to (as
`raven check`'s scope sees it), and what R's parser would reject or warn
about. With no FILES, prints every R file in the workspace, sorted by path.
Relative FILES resolve against the workspace root; a directory stands for the R
files under it.

Options:
  --workspace DIR      Workspace root to index (default: current directory)
  --config PATH        Path to raven.toml or .lintr (default: search upward
                       from --workspace)
  --no-config          Use built-in defaults; ignore raven.toml/.lintr
  --format json        Output format (default and only value: json; the
                       stable contract, schema_version {SCHEMA_VERSION})

Exit codes:
  0   Every requested file has a parsed document (syntax errors included)
  3   At least one file couldn't be read or decoded; its error document was
      printed in its place and every other document was still printed
  1   A usage error (unknown flag / bad option value)
  2   Operator error while running (config load failure, workspace not a
      directory)
",
        env!("CARGO_PKG_VERSION")
    );
}

pub async fn run(args: ParseArgs) -> i32 {
    let cwd = match std::env::current_dir() {
        Ok(path) => path,
        Err(e) => {
            eprintln!("raven parse: cannot read current directory: {e}");
            return EXIT_OPERATOR_ERROR;
        }
    };
    let (root, workspace_url) =
        match resolve_workspace_root("raven parse", args.workspace.as_deref(), &cwd) {
            Ok(resolved) => resolved,
            Err(code) => return code,
        };
    let mut prepared = match prepare_workspace(WorkspaceSetup {
        command: "raven parse",
        root: &root,
        workspace_url: &workspace_url,
        no_config: args.no_config,
        config_path: args.config_path.as_deref(),
        explicit_config_base: &cwd,
        trace_graph: false,
    })
    .await
    {
        Ok(prepared) => prepared,
        Err(code) => return code,
    };
    for note in &prepared.startup_notes {
        eprintln!("{note}");
    }
    // The rest of `raven check`'s setup before it resolves names: package-mode
    // data loaded through R, and the attached packages' exports warmed. Unlike
    // `raven check`, which warms only the reported files' packages, warm every
    // scanned file's: a requested file resolves names through what its callers
    // attach.
    maybe_load_sysdata_fallback(&mut prepared.state).await;
    let requests = requests(&args.files, &root, &prepared);
    let mut warm: Vec<PathBuf> = prepared.scan.discovered.clone();
    warm.extend(requests.iter().filter_map(|request| match &request.target {
        Target::RFile(path) => Some(path.clone()),
        Target::Unsupported => None,
    }));
    prefetch_reported_packages(&prepared.state, &warm).await;

    let package_data = prepared.package_data;
    let state = &mut prepared.state;
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    let mut code = EXIT_OK;
    for request in requests {
        let document = match &request.target {
            Target::RFile(fs_path) => {
                document::document_for_file(fs_path, request.path, package_data, &mut |text| {
                    resolve::workspace_names(state, fs_path, text, &root)
                })
            }
            Target::Unsupported => document::error_document(
                request.path,
                "only .R and .r files are supported".to_string(),
            ),
        };
        if document.is_error() {
            code = EXIT_UNREADABLE;
        }
        let line = serde_json::to_string(&document).expect("parse document serializes");
        // A closed pipe (`raven parse | head -1`) ends the output, not the run's
        // verdict on the files already printed.
        if writeln!(out, "{line}").is_err() {
            return code;
        }
    }
    let _ = out.flush();
    code
}

/// One requested file: its printed `path` and what to do with it.
struct Request {
    path: String,
    target: Target,
}

enum Target {
    RFile(PathBuf),
    /// A file that isn't an R script (`.Rmd`, `.qmd`, `.stan`, ...).
    Unsupported,
}

/// A file's printed path: the graph's path for the file's URI.
fn printed_path(path: &Path, root: &Path) -> String {
    match Url::from_file_path(path) {
        Ok(uri) => display_path(&uri, root),
        Err(()) => display_fs_path(path, root),
    }
}

/// The requested files, in output order. With no FILES: every `.R`/`.r` file
/// the workspace scan discovered, sorted by printed path. Otherwise each
/// FILE in order; a directory stands for its R files (discovery walk, with
/// exclusions), sorted by printed path.
fn requests(files: &[PathBuf], root: &Path, prepared: &PreparedWorkspace) -> Vec<Request> {
    let r_files = |paths: Vec<PathBuf>| {
        let mut found: Vec<Request> = paths
            .into_iter()
            .filter(|path| is_r_file(path))
            .map(|path| Request {
                path: printed_path(&path, root),
                target: Target::RFile(path),
            })
            .collect();
        found.sort_by(|a, b| a.path.cmp(&b.path));
        found
    };
    if files.is_empty() {
        return r_files(prepared.scan.discovered.clone());
    }
    let mut out = Vec::new();
    for file in files {
        let path = requested_path(file, root);
        if path.is_dir() {
            let mut walked = Vec::new();
            collect_r_file_paths_with_exclusions(
                &path,
                &mut walked,
                &prepared.state.workspace_exclusions,
            );
            out.extend(r_files(walked));
        } else {
            out.push(Request {
                path: printed_path(&path, root),
                target: if is_r_file(&path) {
                    Target::RFile(path)
                } else {
                    Target::Unsupported
                },
            });
        }
    }
    out
}

/// Where a FILE argument points. Relative FILES resolve against the workspace
/// root, as `raven check`'s do. The path is normalized lexically (`.` and
/// `..`, no symlink resolution), so a file under a symlinked directory keeps
/// the spelling the graph gives it. Only when that path isn't under the
/// canonical root but its canonical form is (an absolute path through an
/// alias of the root, such as macOS's `/var` for `/private/var`) is the
/// canonical form used.
fn requested_path(file: &Path, root: &Path) -> PathBuf {
    let absolute = absolute_path(root, file);
    let lexical =
        crate::cross_file::path_resolve::normalize_path_public(&absolute).unwrap_or(absolute);
    if lexical.starts_with(root) {
        return lexical;
    }
    match std::fs::canonicalize(&lexical) {
        Ok(canonical) if canonical.starts_with(root) => canonical,
        _ => lexical,
    }
}

#[cfg(test)]
mod tests;
