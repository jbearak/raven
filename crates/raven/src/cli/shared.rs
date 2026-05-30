//! Output formatting, severity gating, and file-type helpers shared by the
//! `lint` and `check` subcommands.
//!
//! Both subcommands accumulate `(PathBuf, Diagnostic)` pairs and render them
//! identically (`text` / `json` / `sarif`), gate the process exit code on a
//! `--max-severity` threshold, and agree on which files are R sources versus
//! chunk-bearing documents. That common surface lives here so the two commands
//! share one implementation without depending on each other's internals.

use std::path::{Path, PathBuf};

use serde_json::json;
use tower_lsp::lsp_types::{Diagnostic, DiagnosticSeverity, NumberOrString};

/// Exit codes are returned as plain `i32` so `main()` can pass them directly
/// to `std::process::exit`. Avoids the `ExitCode` cast trap (`ExitCode` is not
/// a primitive and cannot be cast with `as`).
pub const EXIT_OK: i32 = 0;
pub const EXIT_LINT_FAILED: i32 = 1;
pub const EXIT_OPERATOR_ERROR: i32 = 2;

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
    pub fn from_diag(d: &Diagnostic) -> Self {
        match d.severity {
            Some(DiagnosticSeverity::ERROR) => SeverityLevel::Error,
            Some(DiagnosticSeverity::WARNING) => SeverityLevel::Warning,
            Some(DiagnosticSeverity::INFORMATION) => SeverityLevel::Info,
            Some(DiagnosticSeverity::HINT) => SeverityLevel::Hint,
            _ => SeverityLevel::Off,
        }
    }
}

/// Parse a `--format` value into an [`OutputFormat`].
pub fn parse_output_format(v: &str) -> Result<OutputFormat, String> {
    match v {
        "text" => Ok(OutputFormat::Text),
        "json" => Ok(OutputFormat::Json),
        "sarif" => Ok(OutputFormat::Sarif),
        other => Err(format!("unknown --format value: {other}")),
    }
}

/// Parse a `--max-severity` value into a [`SeverityLevel`].
pub fn parse_severity_level(v: &str) -> Result<SeverityLevel, String> {
    match v {
        "off" => Ok(SeverityLevel::Off),
        "hint" => Ok(SeverityLevel::Hint),
        "info" => Ok(SeverityLevel::Info),
        "warning" => Ok(SeverityLevel::Warning),
        "error" => Ok(SeverityLevel::Error),
        other => Err(format!("unknown --max-severity value: {other}")),
    }
}

pub fn is_r_file(p: &Path) -> bool {
    matches!(p.extension().and_then(|s| s.to_str()), Some("R") | Some("r"))
}

pub fn is_chunk_file(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|s| s.to_str()),
        Some("Rmd") | Some("rmd") | Some("RMD") | Some("qmd") | Some("Qmd") | Some("QMD")
    )
}

/// Return `path` unchanged when already absolute; otherwise resolve it against
/// `base`.
pub fn absolute_path(base: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    }
}

/// Recursively collect `.R` / `.r` file paths under `dir`. A thin R-only
/// wrapper over the shared directory walk [`crate::state::collect_files_matching`]:
/// symlinked directories are followed with canonical-path cycle detection and
/// non-source directories are pruned. Reusing the indexer's walk is what keeps
/// `raven check`'s *reported* file set equal to its *indexed* set — a `.R` file
/// reachable only through a symlink (e.g. a monorepo `src -> ../shared` layout)
/// is both indexed and reported, not one or the other. Results are unsorted;
/// callers that need deterministic order sort afterwards.
///
/// Shared by `raven check` (which reports diagnostics for the collected files)
/// and `analysis-stats` (which reads their contents in a second pass). `.r` and
/// `.R` are the only matched extensions — equivalent to a case-insensitive
/// match on the single-character extension.
pub fn collect_r_file_paths(dir: &Path, out: &mut Vec<PathBuf>) {
    crate::state::collect_files_matching(dir, out, is_r_file);
}

/// Build the reported finding for a target that isn't valid UTF-8. A
/// mis-encoded source file (typically Latin-1 / Windows-1252 saved without a
/// BOM) can't be parsed, but it's a property of the user's code — so it's an
/// error-severity diagnostic (exit 1, like a syntax error) rather than an
/// operator error (exit 2). The range is `0:0` because the file can't be
/// decoded into lines; the byte offset in the message is the actionable
/// pointer. `byte == 0` marks the rare malformed-UTF-16 case, where there's no
/// single offending byte to name.
///
/// Shared by `raven check` (report loop) and `raven lint` (`walk`) so the two
/// emit the identical message for an undecodable [`crate::state::read_source`]
/// failure.
pub fn encoding_diagnostic(offset: usize, byte: u8) -> Diagnostic {
    use tower_lsp::lsp_types::{Position, Range};
    // Compose the whole message per branch rather than gluing a fixed
    // "not valid UTF-8" prefix onto the detail: the `byte == 0` case can be a
    // malformed UTF-16 file (which carried a BOM), so a "not valid UTF-8" prefix
    // would contradict its own tail.
    let message = if byte == 0 {
        // No single offending byte to name: a truncated multibyte sequence at
        // EOF, or malformed/odd-length UTF-16.
        "File could not be decoded as UTF-8 or UTF-16. Re-save the file as UTF-8.".to_string()
    } else {
        format!(
            "File is not valid UTF-8: first invalid byte {byte:#04x} at offset {offset} \
             (looks like Latin-1/Windows-1252). Re-save the file as UTF-8."
        )
    };
    Diagnostic {
        range: Range {
            start: Position { line: 0, character: 0 },
            end: Position { line: 0, character: 0 },
        },
        severity: Some(DiagnosticSeverity::ERROR),
        message,
        ..Default::default()
    }
}

/// Render diagnostics in the requested format. The single dispatch point both
/// `lint` and `check` call after collecting their `(path, diagnostic)` pairs,
/// so the format → renderer mapping lives in one place next to the renderers.
pub fn render(format: OutputFormat, diags: &[(PathBuf, Diagnostic)], root: &Path, quiet: bool) {
    match format {
        OutputFormat::Text => print_text(diags, root, quiet),
        OutputFormat::Json => print_json(diags, root),
        OutputFormat::Sarif => print_sarif(diags, root),
    }
}

fn print_text(diags: &[(PathBuf, Diagnostic)], root: &Path, quiet: bool) {
    let mut errors = 0;
    let mut warnings = 0;
    let mut infos = 0;
    let mut hints = 0;
    let mut notes = 0;
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
                infos += 1;
                "info"
            }
            Some(DiagnosticSeverity::HINT) => {
                hints += 1;
                "hint"
            }
            _ => {
                notes += 1;
                "note"
            }
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
    if !quiet {
        // Buckets sum to diags.len(): errors + warnings + infos + hints
        // + notes (severity-less / unrecognized). Per-bucket reporting
        // keeps INFORMATION distinct from WARNING in summaries — SARIF
        // collapses them onto "note" by spec, but the human-readable
        // CLI output should reflect the original LSP severity.
        println!(
            "{} issues ({} errors, {} warnings, {} infos, {} hints, {} notes)",
            diags.len(),
            errors,
            warnings,
            infos,
            hints,
            notes
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
    use tower_lsp::lsp_types::{Position, Range};

    fn diag(severity: DiagnosticSeverity) -> Diagnostic {
        Diagnostic {
            range: Range {
                start: Position::new(0, 0),
                end: Position::new(0, 1),
            },
            severity: Some(severity),
            ..Default::default()
        }
    }

    #[test]
    fn encoding_diagnostic_message_matches_the_failure_kind() {
        // Latin-1 (a concrete offending byte): names UTF-8 and the byte/offset.
        let latin1 = encoding_diagnostic(930, 0xA0);
        assert!(
            latin1.message.contains("not valid UTF-8") && latin1.message.contains("0xa0"),
            "{}",
            latin1.message
        );
        // Malformed/odd-length UTF-16 (byte == 0): the file carried a BOM, so the
        // message must NOT claim "not valid UTF-8" and must mention UTF-16.
        let utf16 = encoding_diagnostic(0, 0);
        assert!(!utf16.message.contains("not valid UTF-8"), "{}", utf16.message);
        assert!(utf16.message.contains("UTF-16"), "{}", utf16.message);
    }

    #[test]
    fn severity_ordering() {
        assert!(SeverityLevel::Error > SeverityLevel::Warning);
        assert!(SeverityLevel::Warning > SeverityLevel::Info);
        assert!(SeverityLevel::Info > SeverityLevel::Hint);
        assert!(SeverityLevel::Hint > SeverityLevel::Off);
    }

    #[test]
    fn severity_from_diag() {
        assert_eq!(
            SeverityLevel::from_diag(&diag(DiagnosticSeverity::ERROR)),
            SeverityLevel::Error
        );
        assert_eq!(
            SeverityLevel::from_diag(&diag(DiagnosticSeverity::WARNING)),
            SeverityLevel::Warning
        );
        assert_eq!(
            SeverityLevel::from_diag(&diag(DiagnosticSeverity::INFORMATION)),
            SeverityLevel::Info
        );
        assert_eq!(
            SeverityLevel::from_diag(&diag(DiagnosticSeverity::HINT)),
            SeverityLevel::Hint
        );
    }

    #[test]
    fn format_parsing() {
        assert_eq!(parse_output_format("text").unwrap(), OutputFormat::Text);
        assert_eq!(parse_output_format("json").unwrap(), OutputFormat::Json);
        assert_eq!(parse_output_format("sarif").unwrap(), OutputFormat::Sarif);
        assert!(parse_output_format("toml").is_err());
    }

    #[test]
    fn severity_parsing() {
        assert_eq!(parse_severity_level("off").unwrap(), SeverityLevel::Off);
        assert_eq!(parse_severity_level("error").unwrap(), SeverityLevel::Error);
        assert!(parse_severity_level("fatal").is_err());
    }

    #[test]
    fn file_type_predicates() {
        assert!(is_r_file(Path::new("a.R")));
        assert!(is_r_file(Path::new("a.r")));
        assert!(!is_r_file(Path::new("a.Rmd")));
        assert!(is_chunk_file(Path::new("a.Rmd")));
        assert!(is_chunk_file(Path::new("a.qmd")));
        assert!(!is_chunk_file(Path::new("a.R")));
    }

    #[test]
    fn collect_r_file_paths_walks_and_prunes() {
        use std::fs;
        let tmp = tempfile::TempDir::new().unwrap();
        fs::write(tmp.path().join("a.R"), "1\n").unwrap();
        fs::create_dir(tmp.path().join("sub")).unwrap();
        fs::write(tmp.path().join("sub/b.r"), "2\n").unwrap();
        fs::write(tmp.path().join("c.Rmd"), "prose\n").unwrap();
        fs::create_dir(tmp.path().join(".git")).unwrap();
        fs::write(tmp.path().join(".git/d.R"), "3\n").unwrap();

        let mut out = Vec::new();
        collect_r_file_paths(tmp.path(), &mut out);
        // a.R + sub/b.r; .Rmd is not an R source; .git is pruned.
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|p| is_r_file(p)));
    }

    #[cfg(unix)]
    #[test]
    fn collect_r_file_paths_follows_symlinks_with_cycle_detection() {
        use std::fs;
        let tmp = tempfile::TempDir::new().unwrap();
        fs::write(tmp.path().join("real.R"), "1\n").unwrap();
        // A symlinked .R file is collected — the workspace indexer
        // (state.rs collect_file_paths_inner) includes it, so the report set
        // must too or `raven check` exits clean over a file the editor flags.
        std::os::unix::fs::symlink(tmp.path().join("real.R"), tmp.path().join("link.R")).unwrap();
        // Files reached only via a symlinked directory MUST be collected — the
        // monorepo `src -> ../shared` layout this guards against.
        fs::create_dir(tmp.path().join("d")).unwrap();
        fs::write(tmp.path().join("d/inner.R"), "2\n").unwrap();
        std::os::unix::fs::symlink(tmp.path().join("d"), tmp.path().join("dlink")).unwrap();
        // A self-referential symlink must terminate (cycle guard), not recurse
        // forever.
        std::os::unix::fs::symlink(tmp.path(), tmp.path().join("selfloop")).unwrap();

        let mut out = Vec::new();
        collect_r_file_paths(tmp.path(), &mut out);

        // real.R + link.R + inner.R: `inner.R` is reached exactly once (the
        // canonical-path cycle guard prevents visiting both `d` and `dlink`),
        // and `selfloop` is skipped. Termination itself proves the guard works.
        assert_eq!(out.len(), 3, "got {out:?}");
        let canon_inner = fs::canonicalize(tmp.path().join("d/inner.R")).unwrap();
        assert!(
            out.iter()
                .any(|p| fs::canonicalize(p).unwrap() == canon_inner),
            "the file under the symlinked directory must be collected; got {out:?}"
        );
    }
}
