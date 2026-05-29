//! `raven lint` subcommand: walk paths, run native lint rules, format output.

use std::path::{Path, PathBuf};

use serde_json::json;
use tower_lsp::lsp_types::Diagnostic;

use crate::cli::shared::{
    is_chunk_file, is_r_file, parse_output_format, parse_severity_level, print_json, print_sarif,
    print_text, OutputFormat, SeverityLevel, EXIT_LINT_FAILED, EXIT_OK, EXIT_OPERATOR_ERROR,
};

#[derive(Debug, PartialEq, Clone)]
pub struct LintArgs {
    pub paths: Vec<PathBuf>,
    pub config_path: Option<PathBuf>,
    pub no_config: bool,
    pub format: OutputFormat,
    pub max_severity: SeverityLevel,
    pub quiet: bool,
    pub no_color: bool,
}

pub fn parse_args(mut argv: impl Iterator<Item = String>) -> Result<LintArgs, String> {
    let mut paths = Vec::new();
    let mut config_path = None;
    let mut no_config = false;
    let mut format = OutputFormat::Text;
    let mut max_severity = SeverityLevel::Info;
    let mut quiet = false;
    let mut no_color = false;

    while let Some(arg) = argv.next() {
        match arg.as_str() {
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
    if paths.is_empty() {
        paths.push(PathBuf::from("."));
    }
    Ok(LintArgs {
        paths,
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
        "raven lint {} — native R style linter

Usage: raven lint [OPTIONS] [PATHS...]

Lints each .R / .r file against the rules configured in raven.toml
(or .lintr) and prints diagnostics.

Options:
  --config PATH               Path to raven.toml (default: search upward)
  --no-config                 Use built-in defaults; ignore raven.toml/.lintr
  --format text|json|sarif    Output format (default: text)
  --max-severity LEVEL        Highest severity that does NOT fail the build
                              (off, hint, info, warning, error; default: info)
  --quiet                     Suppress summary line in text output
  --no-color                  Disable ANSI colors

Exit codes:
  0   No diagnostic exceeded --max-severity
  1   A diagnostic exceeded --max-severity, or a usage error (unknown flag / bad option value)
  2   Operator error while running (config parse failure, unreadable or missing path)
",
        env!("CARGO_PKG_VERSION")
    );
}

pub fn run(args: LintArgs) -> i32 {
    let cwd = match std::env::current_dir() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("raven lint: cannot read current directory: {e}");
            return EXIT_OPERATOR_ERROR;
        }
    };

    // Resolve project root + project settings + lintr-discovered signal.
    // `lintr_discovered` is the input to `Auto` resolution in
    // `parse_lint_config`. `--config` is currently raven.toml-only — see
    // the design spec for tri-state enabled, section 7.
    let (root, project_settings, lintr_discovered) = if args.no_config {
        (cwd.clone(), None, false)
    } else if let Some(explicit) = args.config_path.as_ref() {
        match crate::config_file::load_toml(explicit) {
            Some(l) => {
                for w in l.warnings {
                    eprintln!("{w}");
                }
                // Canonicalize the parent so `root` is absolute even when
                // `--config` points at a relative path. Without this,
                // `resolve_lint_for_document`'s `strip_prefix(root)`
                // check fails for the absolute URIs produced by `walk`
                // — silently dropping every per-file
                // `[[linting.overrides]]` patch (same failure mode as
                // commit 81978f0 fixed for the non-explicit root).
                let parent = explicit.parent().unwrap_or(&cwd).to_path_buf();
                let root = if parent.is_absolute() {
                    parent
                } else {
                    cwd.join(&parent)
                };
                (root, Some(l.settings), false)
            }
            None => {
                eprintln!(
                    "raven lint: failed to load --config {}",
                    explicit.display()
                );
                return EXIT_OPERATOR_ERROR;
            }
        }
    } else {
        match crate::config_file::find_config(&cwd) {
            crate::config_file::DiscoveredConfig::RavenToml(p) => {
                let l = match crate::config_file::load_toml(&p) {
                    Some(v) => v,
                    None => return EXIT_OPERATOR_ERROR,
                };
                for w in l.warnings {
                    eprintln!("{w}");
                }
                (p.parent().unwrap_or(&cwd).to_path_buf(), Some(l.settings), false)
            }
            crate::config_file::DiscoveredConfig::Lintr(p) => {
                let text = match std::fs::read_to_string(&p) {
                    Ok(t) => t,
                    Err(e) => {
                        eprintln!("raven lint: cannot read {}: {e}", p.display());
                        return EXIT_OPERATOR_ERROR;
                    }
                };
                let l = crate::config_file::load_lintr_str(&text);
                for w in l.warnings {
                    eprintln!("{w}");
                }
                (p.parent().unwrap_or(&cwd).to_path_buf(), Some(l.settings), true)
            }
            crate::config_file::DiscoveredConfig::None => (cwd.clone(), None, false),
        }
    };

    // Parse the base lint config from the (project-only) settings, since the
    // CLI has no LSP client. Merge with an empty client layer for correctness.
    let merged = crate::config_file::merge_settings(
        &serde_json::Value::Object(Default::default()),
        project_settings.as_ref(),
    );
    let lint_config = crate::backend::parse_lint_config(&merged, lintr_discovered).unwrap_or_default();
    let base_section = merged.get("linting").cloned().unwrap_or(json!({}));
    let overrides = crate::config_file::compile_lint_overrides(&merged, &root);

    let mut diagnostics: Vec<(PathBuf, Diagnostic)> = Vec::new();
    let mut operator_error = false;
    for p in &args.paths {
        walk(
            p,
            &root,
            &base_section,
            &lint_config,
            &overrides,
            &mut diagnostics,
            &mut operator_error,
        );
    }
    if operator_error {
        return EXIT_OPERATOR_ERROR;
    }

    let any_above_threshold = diagnostics
        .iter()
        .any(|(_, d)| SeverityLevel::from_diag(d) > args.max_severity);

    match args.format {
        OutputFormat::Text => print_text(&diagnostics, &root, args.quiet),
        OutputFormat::Json => print_json(&diagnostics, &root),
        OutputFormat::Sarif => print_sarif(&diagnostics, &root),
    }

    if any_above_threshold {
        EXIT_LINT_FAILED
    } else {
        EXIT_OK
    }
}

fn walk(
    path: &Path,
    root: &Path,
    base_section: &serde_json::Value,
    base_lint: &crate::linting::LintConfig,
    overrides: &[crate::config_file::CompiledLintOverride],
    out: &mut Vec<(PathBuf, Diagnostic)>,
    operator_error: &mut bool,
) {
    if path.is_file() {
        if is_chunk_file(path) {
            // Design requires a one-line note; the file otherwise contributes
            // nothing to JSON / SARIF output.
            eprintln!(
                "raven lint: skipping {} (chunk-bearing file; lint is R-only — see docs/cli.md)",
                path.display()
            );
            return;
        }
        if !is_r_file(path) {
            return;
        }
        let rel = path.strip_prefix(root).unwrap_or(path);
        if crate::config_file::is_skipped_by_overrides(base_section, overrides, rel) {
            return;
        }
        // `Url::from_file_path` requires an absolute path. The CLI is
        // commonly invoked with `raven lint .`, which produces relative
        // entries like `R/foo.R` from the directory walk — without
        // canonicalization the URL build falls back to `file:///` and
        // `resolve_lint_for_document`'s `strip_prefix(root)` check
        // silently drops every per-file `[[linting.overrides]]` patch.
        // Canonicalize against `root` to preserve file identity.
        let abs_path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            root.join(path)
        };
        let uri = tower_lsp::lsp_types::Url::from_file_path(&abs_path)
            .unwrap_or_else(|_| tower_lsp::lsp_types::Url::parse("file:///").unwrap());
        let effective = crate::config_file::resolve_lint_for_document(
            base_lint,
            base_section,
            overrides,
            &uri,
        );
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("raven lint: cannot read {}: {e}", path.display());
                *operator_error = true;
                return;
            }
        };
        // Use the same thread-local parser pool the LSP uses; avoids
        // per-file Parser construction.
        let parse_result = crate::parser_pool::with_parser(|p| p.parse(&text, None));
        let tree = match parse_result {
            Some(t) => t,
            None => {
                eprintln!("raven lint: parse failed for {}", path.display());
                *operator_error = true;
                return;
            }
        };
        for d in crate::linting::run_lints(&text, tree.root_node(), &effective) {
            out.push((path.to_path_buf(), d));
        }
    } else if path.is_dir() {
        let entries = match std::fs::read_dir(path) {
            Ok(it) => it,
            Err(e) => {
                eprintln!("raven lint: cannot read dir {}: {e}", path.display());
                *operator_error = true;
                return;
            }
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_symlink() {
                continue;
            }
            walk(
                &p,
                root,
                base_section,
                base_lint,
                overrides,
                out,
                operator_error,
            );
        }
    } else {
        eprintln!("raven lint: path does not exist: {}", path.display());
        *operator_error = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_default_paths() {
        let args = parse_args(Vec::<String>::new().into_iter()).unwrap();
        assert_eq!(args.paths, vec![PathBuf::from(".")]);
        assert_eq!(args.format, OutputFormat::Text);
        assert_eq!(args.max_severity, SeverityLevel::Info);
    }

    #[test]
    fn parse_explicit_paths() {
        let args = parse_args(["R/", "scripts/foo.R"].iter().map(|s| s.to_string())).unwrap();
        assert_eq!(
            args.paths,
            vec![PathBuf::from("R/"), PathBuf::from("scripts/foo.R")]
        );
    }

    #[test]
    fn parse_format_json() {
        let args = parse_args(["--format", "json"].iter().map(|s| s.to_string())).unwrap();
        assert_eq!(args.format, OutputFormat::Json);
    }

    #[test]
    fn parse_max_severity_warning() {
        let args =
            parse_args(["--max-severity", "warning"].iter().map(|s| s.to_string())).unwrap();
        assert_eq!(args.max_severity, SeverityLevel::Warning);
    }

    #[test]
    fn unknown_flag_errors() {
        assert!(parse_args(["--bogus"].iter().map(|s| s.to_string())).is_err());
    }

    #[test]
    fn end_to_end_finds_line_length_violation() {
        use std::fs;
        use tempfile::TempDir;
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("raven.toml"),
            "[linting]\nenabled = true\nlineLength = 20\nlineLengthSeverity = \"warning\"\n",
        )
        .unwrap();
        fs::write(
            tmp.path().join("over.R"),
            "x <- 'this line is intentionally way more than twenty characters wide'\n",
        )
        .unwrap();

        // Use --config + absolute path arguments instead of mutating CWD.
        // CWD is process-global; cargo runs tests in parallel by default, so
        // touching it from a test races with any other test that does the same.
        let args = LintArgs {
            paths: vec![tmp.path().to_path_buf()],
            config_path: Some(tmp.path().join("raven.toml")),
            no_config: false,
            format: OutputFormat::Json,
            max_severity: SeverityLevel::Info,
            quiet: true,
            no_color: true,
        };
        // Redirect stdout to a buffer is non-trivial; instead just call run() and
        // assert the exit code. Stdout assertions live in the integration test
        // suite that runs the binary.
        let code = run(args);
        assert_eq!(code, EXIT_LINT_FAILED); // warning > info default
    }
}
