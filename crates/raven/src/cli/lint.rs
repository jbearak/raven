//! `raven lint` subcommand: walk paths, run native lint rules, format output.

use std::path::{Path, PathBuf};

use serde_json::json;
use tower_lsp::lsp_types::{Diagnostic, DiagnosticSeverity, NumberOrString};

/// Exit codes are returned as plain `i32` so `main()` can pass them directly
/// to `std::process::exit`. Avoids the `ExitCode` cast trap (`ExitCode` is not
/// a primitive and cannot be cast with `as`).
pub const EXIT_OK: i32 = 0;
pub const EXIT_LINT_FAILED: i32 = 1;
pub const EXIT_OPERATOR_ERROR: i32 = 2;

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

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum OutputFormat {
    Text,
    Json,
    Sarif,
}

#[derive(Debug, PartialEq, Clone, Copy, PartialOrd, Eq, Ord)]
pub enum SeverityLevel {
    Off,
    Hint,
    Info,
    Warning,
    Error,
}

impl SeverityLevel {
    fn from_diag(d: &Diagnostic) -> Self {
        match d.severity {
            Some(DiagnosticSeverity::ERROR) => SeverityLevel::Error,
            Some(DiagnosticSeverity::WARNING) => SeverityLevel::Warning,
            Some(DiagnosticSeverity::INFORMATION) => SeverityLevel::Info,
            Some(DiagnosticSeverity::HINT) => SeverityLevel::Hint,
            _ => SeverityLevel::Off,
        }
    }
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
                format = match v.as_str() {
                    "text" => OutputFormat::Text,
                    "json" => OutputFormat::Json,
                    "sarif" => OutputFormat::Sarif,
                    other => return Err(format!("unknown --format value: {other}")),
                };
            }
            "--max-severity" => {
                let v = argv.next().ok_or("--max-severity needs a value")?;
                max_severity = match v.as_str() {
                    "off" => SeverityLevel::Off,
                    "hint" => SeverityLevel::Hint,
                    "info" => SeverityLevel::Info,
                    "warning" => SeverityLevel::Warning,
                    "error" => SeverityLevel::Error,
                    other => return Err(format!("unknown --max-severity value: {other}")),
                };
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
  1   At least one diagnostic exceeded --max-severity
  2   Operator error (config / path / flag)
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

    // Resolve project root + project settings.
    let (root, project_settings) = if args.no_config {
        (cwd.clone(), None)
    } else if let Some(explicit) = args.config_path.as_ref() {
        match crate::config_file::load_toml(explicit) {
            Some(l) => {
                for w in l.warnings {
                    eprintln!("{w}");
                }
                let root = explicit.parent().unwrap_or(&cwd).to_path_buf();
                (root, Some(l.settings))
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
                (p.parent().unwrap_or(&cwd).to_path_buf(), Some(l.settings))
            }
            crate::config_file::DiscoveredConfig::Lintr(p) => {
                let l = crate::config_file::load_lintr_str(
                    &std::fs::read_to_string(&p).unwrap_or_default(),
                );
                for w in l.warnings {
                    eprintln!("{w}");
                }
                (p.parent().unwrap_or(&cwd).to_path_buf(), Some(l.settings))
            }
            crate::config_file::DiscoveredConfig::None => (cwd.clone(), None),
        }
    };

    // Parse the base lint config from the (project-only) settings, since the
    // CLI has no LSP client. Merge with an empty client layer for correctness.
    let merged = crate::config_file::merge_settings(
        &serde_json::Value::Object(Default::default()),
        project_settings.as_ref(),
    );
    let lint_config = crate::backend::parse_lint_config(&merged).unwrap_or_default();
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
        OutputFormat::Text => print_text(&diagnostics, &args, &root),
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
        let uri = tower_lsp::lsp_types::Url::from_file_path(path)
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

fn is_r_file(p: &Path) -> bool {
    matches!(p.extension().and_then(|s| s.to_str()), Some("R") | Some("r"))
}

fn is_chunk_file(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|s| s.to_str()),
        Some("Rmd") | Some("rmd") | Some("RMD") | Some("qmd") | Some("Qmd") | Some("QMD")
    )
}

fn print_text(diags: &[(PathBuf, Diagnostic)], args: &LintArgs, root: &Path) {
    let mut errors = 0;
    let mut warnings = 0;
    let mut hints = 0;
    for (path, d) in diags {
        let rel = path.strip_prefix(root).unwrap_or(path);
        let level = match d.severity {
            Some(DiagnosticSeverity::ERROR) => {
                errors += 1;
                "error"
            }
            Some(DiagnosticSeverity::WARNING) => {
                warnings += 1;
                "warning"
            }
            Some(DiagnosticSeverity::INFORMATION) => {
                warnings += 1;
                "info"
            }
            Some(DiagnosticSeverity::HINT) => {
                hints += 1;
                "hint"
            }
            _ => "note",
        };
        let line = d.range.start.line + 1;
        let col = d.range.start.character + 1;
        let rule = match &d.code {
            Some(NumberOrString::String(s)) => s.as_str(),
            _ => "",
        };
        println!(
            "{}:{}:{} {}: {} [{}]",
            rel.display(),
            line,
            col,
            level,
            d.message,
            rule
        );
    }
    if !args.quiet {
        println!(
            "{} issues ({} errors, {} warnings, {} hints)",
            diags.len(),
            errors,
            warnings,
            hints
        );
    }
}

fn print_json(diags: &[(PathBuf, Diagnostic)], root: &Path) {
    let arr: Vec<_> = diags
        .iter()
        .map(|(p, d)| {
            let rel = p.strip_prefix(root).unwrap_or(p);
            json!({ "path": rel.display().to_string(), "diagnostic": d })
        })
        .collect();
    println!("{}", serde_json::to_string_pretty(&json!(arr)).unwrap());
}

fn print_sarif(diags: &[(PathBuf, Diagnostic)], root: &Path) {
    use std::collections::BTreeSet;
    let rule_ids: BTreeSet<String> = diags
        .iter()
        .filter_map(|(_, d)| match &d.code {
            Some(NumberOrString::String(s)) => Some(s.clone()),
            _ => None,
        })
        .collect();
    let rules: Vec<_> = rule_ids
        .iter()
        .map(|id| {
            json!({
                "id": id, "name": id, "shortDescription": { "text": id }
            })
        })
        .collect();
    let results: Vec<_> = diags
        .iter()
        .map(|(p, d)| {
            let rel = p.strip_prefix(root).unwrap_or(p);
            let level = match d.severity {
                Some(DiagnosticSeverity::ERROR) => "error",
                Some(DiagnosticSeverity::WARNING) => "warning",
                _ => "note",
            };
            let rule_id = match &d.code {
                Some(NumberOrString::String(s)) => s.clone(),
                _ => String::new(),
            };
            json!({
                "ruleId": rule_id,
                "level": level,
                "message": { "text": d.message },
                "locations": [{
                    "physicalLocation": {
                        "artifactLocation": { "uri": rel.display().to_string() },
                        "region": {
                            "startLine": d.range.start.line + 1,
                            "startColumn": d.range.start.character + 1,
                            "endLine": d.range.end.line + 1,
                            "endColumn": d.range.end.character + 1,
                        }
                    }
                }]
            })
        })
        .collect();
    let sarif = json!({
        "version": "2.1.0",
        "$schema": "https://docs.oasis-open.org/sarif/sarif/v2.1.0/cos02/schemas/sarif-schema-2.1.0.json",
        "runs": [{
            "tool": { "driver": { "name": "raven", "rules": rules } },
            "results": results
        }]
    });
    println!("{}", serde_json::to_string_pretty(&sarif).unwrap());
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
