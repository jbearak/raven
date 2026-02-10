// cli/analysis_stats.rs — `raven analysis-stats` subcommand
//
// Loads a workspace and reports timing metrics for each analysis phase,
// inspired by rust-analyzer's `analysis-stats` command.
//
// Phases measured:
//   1. scan     — discovering R files in the workspace
//   2. parse    — tree-sitter parsing all files
//   3. metadata — extracting cross-file metadata
//   4. scope    — scope resolution / cross-file analysis
//   5. packages — package loading/resolution
//
// Requirements: 5.1, 5.2, 5.3, 5.4

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use url::Url;

use crate::cross_file;
use crate::parser_pool;
use crate::perf::TimingGuard;

/// Parsed arguments for the `analysis-stats` subcommand.
#[derive(Debug)]
pub struct AnalysisStatsArgs {
    pub path: PathBuf,
    pub csv: bool,
    pub only: Option<String>,
}

/// Result of running a single analysis phase.
pub struct PhaseResult {
    pub name: String,
    pub duration: Duration,
    pub peak_rss_bytes: Option<u64>,
    pub detail: String,
}

/// All valid phase names.
const VALID_PHASES: &[&str] = &["scan", "parse", "metadata", "scope", "packages"];

/// Parse `analysis-stats` arguments from the remaining CLI args.
///
/// Expected usage: `raven analysis-stats <path> [--csv] [--only <phase>]`
pub fn parse_args(args: &mut impl Iterator<Item = String>) -> Result<AnalysisStatsArgs, String> {
    let mut path: Option<PathBuf> = None;
    let mut csv = false;
    let mut only: Option<String> = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--csv" => csv = true,
            "--only" => {
                let phase = args
                    .next()
                    .ok_or_else(|| "--only requires a phase name".to_string())?;
                if !VALID_PHASES.contains(&phase.as_str()) {
                    return Err(format!(
                        "Unknown phase '{}'. Valid phases: {}",
                        phase,
                        VALID_PHASES.join(", ")
                    ));
                }
                only = Some(phase);
            }
            other if other.starts_with('-') => {
                return Err(format!("Unknown flag: '{}'", other));
            }
            _ => {
                if path.is_some() {
                    return Err("Multiple paths provided; expected exactly one".to_string());
                }
                path = Some(PathBuf::from(arg));
            }
        }
    }

    let path = path.ok_or_else(|| "Missing required <path> argument".to_string())?;
    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.display()));
    }

    Ok(AnalysisStatsArgs { path, csv, only })
}

/// Run the analysis-stats command and return phase results.
pub fn run_analysis_stats(args: &AnalysisStatsArgs) -> Vec<PhaseResult> {
    let mut results = Vec::new();

    let should_run = |phase: &str| -> bool {
        args.only.as_ref().map_or(true, |only| only == phase)
    };

    // Phase 1: Scan — discover R files
    let mut r_files: Vec<(PathBuf, String)> = Vec::new();
    if should_run("scan") {
        let _guard = TimingGuard::new("analysis-stats:scan");
        let start = Instant::now();
        r_files = discover_r_files(&args.path);
        let duration = start.elapsed();
        results.push(PhaseResult {
            name: "scan".to_string(),
            duration,
            peak_rss_bytes: crate::perf::peak_rss_bytes(),
            detail: format!("{} files", r_files.len()),
        });
    }

    // If we skipped scan but need files for later phases, scan without timing
    if r_files.is_empty() && !should_run("scan") {
        r_files = discover_r_files(&args.path);
    }

    // Phase 2: Parse — tree-sitter parse all files
    let mut parsed_trees: Vec<(Url, String, Option<tree_sitter::Tree>)> = Vec::new();
    if should_run("parse") {
        let _guard = TimingGuard::new("analysis-stats:parse");
        let start = Instant::now();
        for (path, content) in &r_files {
            let tree = parser_pool::with_parser(|parser| parser.parse(content, None));
            let uri = Url::from_file_path(path).unwrap_or_else(|_| {
                Url::parse(&format!("file://{}", path.display())).expect("valid URL")
            });
            parsed_trees.push((uri, content.clone(), tree));
        }
        let duration = start.elapsed();
        let parse_count = parsed_trees.iter().filter(|(_, _, t)| t.is_some()).count();
        results.push(PhaseResult {
            name: "parse".to_string(),
            duration,
            peak_rss_bytes: crate::perf::peak_rss_bytes(),
            detail: format!("{} files parsed ({} succeeded)", r_files.len(), parse_count),
        });
    }

    // If we skipped parse but need trees for later phases, parse without timing
    if parsed_trees.is_empty() && !should_run("parse") {
        for (path, content) in &r_files {
            let tree = parser_pool::with_parser(|parser| parser.parse(content, None));
            let uri = Url::from_file_path(path).unwrap_or_else(|_| {
                Url::parse(&format!("file://{}", path.display())).expect("valid URL")
            });
            parsed_trees.push((uri, content.clone(), tree));
        }
    }

    // Phase 3: Metadata — extract cross-file metadata
    let mut metadata_map: HashMap<Url, cross_file::CrossFileMetadata> = HashMap::new();
    if should_run("metadata") {
        let _guard = TimingGuard::new("analysis-stats:metadata");
        let start = Instant::now();
        for (uri, content, tree) in &parsed_trees {
            let meta = cross_file::extract_metadata_with_tree(content, tree.as_ref());
            metadata_map.insert(uri.clone(), meta);
        }
        let duration = start.elapsed();
        let total_sources: usize = metadata_map.values().map(|m| m.sources.len()).sum();
        let total_lib_calls: usize = metadata_map.values().map(|m| m.library_calls.len()).sum();
        results.push(PhaseResult {
            name: "metadata".to_string(),
            duration,
            peak_rss_bytes: crate::perf::peak_rss_bytes(),
            detail: format!(
                "{} files, {} source() refs, {} library() calls",
                metadata_map.len(),
                total_sources,
                total_lib_calls
            ),
        });
    }

    // If we skipped metadata but need it for scope, extract without timing
    if metadata_map.is_empty() && !should_run("metadata") {
        for (uri, content, tree) in &parsed_trees {
            let meta = cross_file::extract_metadata_with_tree(content, tree.as_ref());
            metadata_map.insert(uri.clone(), meta);
        }
    }

    // Phase 4: Scope — scope resolution / compute artifacts
    if should_run("scope") {
        let _guard = TimingGuard::new("analysis-stats:scope");
        let start = Instant::now();
        let mut artifacts_count = 0usize;
        let mut total_symbols = 0usize;
        for (uri, content, tree) in &parsed_trees {
            if let Some(tree) = tree {
                let meta = metadata_map.get(uri);
                let artifacts = cross_file::scope::compute_artifacts_with_metadata(
                    uri,
                    tree,
                    content,
                    meta,
                );
                total_symbols += artifacts.timeline.len();
                artifacts_count += 1;
            }
        }
        let duration = start.elapsed();
        results.push(PhaseResult {
            name: "scope".to_string(),
            duration,
            peak_rss_bytes: crate::perf::peak_rss_bytes(),
            detail: format!("{} files, {} scope events", artifacts_count, total_symbols),
        });
    }

    // Phase 5: Packages — package loading/resolution
    // This phase collects unique library() calls and resolves packages via
    // the static NAMESPACE parser (no R subprocess in CLI mode).
    if should_run("packages") {
        let _guard = TimingGuard::new("analysis-stats:packages");
        let start = Instant::now();
        let mut unique_packages = std::collections::HashSet::new();
        for meta in metadata_map.values() {
            for lc in &meta.library_calls {
                unique_packages.insert(lc.package.clone());
            }
        }
        let pkg_count = unique_packages.len();

        // Attempt static NAMESPACE resolution for each package
        let pkg_lib = crate::package_library::PackageLibrary::new_empty();
        let mut resolved = 0usize;
        for pkg_name in &unique_packages {
            if let Some(pkg_dir) = pkg_lib.find_package_directory(pkg_name) {
                if pkg_lib.parse_package_static(&pkg_dir).is_some() {
                    resolved += 1;
                }
            }
        }

        let duration = start.elapsed();
        results.push(PhaseResult {
            name: "packages".to_string(),
            duration,
            peak_rss_bytes: crate::perf::peak_rss_bytes(),
            detail: format!(
                "{} unique packages referenced, {} resolved statically",
                pkg_count, resolved
            ),
        });
    }

    results
}

/// Print phase results in human-readable format.
pub fn print_results(results: &[PhaseResult]) {
    println!("=== Raven Analysis Stats ===\n");
    for result in results {
        let rss_str = match result.peak_rss_bytes {
            Some(bytes) => format_bytes(bytes),
            None => "N/A".to_string(),
        };
        println!(
            "  {:<12} {:>10.2?}   RSS: {:<10}  ({})",
            result.name, result.duration, rss_str, result.detail
        );
    }

    if results.len() > 1 {
        let total: Duration = results.iter().map(|r| r.duration).sum();
        println!("\n  {:<12} {:>10.2?}", "TOTAL", total);
    }
    println!();
}

/// Print phase results in CSV format.
pub fn print_results_csv(results: &[PhaseResult]) {
    println!("phase,duration_ms,peak_rss_bytes,detail");
    for result in results {
        let rss = result
            .peak_rss_bytes
            .map_or(String::new(), |b| b.to_string());
        println!(
            "{},{:.3},{},\"{}\"",
            result.name,
            result.duration.as_secs_f64() * 1000.0,
            rss,
            result.detail.replace('"', "\"\"")
        );
    }
}

/// Recursively discover all `.R` files under `root` and read their contents.
fn discover_r_files(root: &Path) -> Vec<(PathBuf, String)> {
    let mut files = Vec::new();
    collect_r_files(root, &mut files);
    // Sort for deterministic ordering
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}
/// Format a byte count as a human-readable string (e.g., "12.3 MB").
fn format_bytes(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    const GB: u64 = 1024 * MB;
    if bytes >= GB {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.1} KB", bytes as f64 / KB as f64)
    } else {
        format!("{} B", bytes)
    }
}



fn collect_r_files(dir: &Path, out: &mut Vec<(PathBuf, String)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // Skip common non-R directories (mirrors state.rs logic)
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if should_skip_directory(name) {
                    continue;
                }
            }
            collect_r_files(&path, out);
        } else if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
            if ext.eq_ignore_ascii_case("r") {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    out.push((path, content));
                }
            }
        }
    }
}

/// Directories to skip during workspace scanning (mirrors `state::should_skip_directory`).
fn should_skip_directory(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".svn"
            | ".hg"
            | "node_modules"
            | ".Rproj.user"
            | "renv"
            | "packrat"
            | ".vscode"
            | ".idea"
            | "target"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_args_basic() {
        let mut args = vec![".".to_string()].into_iter();
        let result = parse_args(&mut args).unwrap();
        assert_eq!(result.path, PathBuf::from("."));
        assert!(!result.csv);
        assert!(result.only.is_none());
    }

    #[test]
    fn test_parse_args_csv_flag() {
        // Use a path that exists (current directory)
        let mut args = vec![".".to_string(), "--csv".to_string()].into_iter();
        let result = parse_args(&mut args).unwrap();
        assert!(result.csv);
    }

    #[test]
    fn test_parse_args_only_flag() {
        let mut args = vec![
            ".".to_string(),
            "--only".to_string(),
            "parse".to_string(),
        ]
        .into_iter();
        let result = parse_args(&mut args).unwrap();
        assert_eq!(result.only.as_deref(), Some("parse"));
    }

    #[test]
    fn test_parse_args_all_flags() {
        let mut args = vec![
            ".".to_string(),
            "--csv".to_string(),
            "--only".to_string(),
            "scope".to_string(),
        ]
        .into_iter();
        let result = parse_args(&mut args).unwrap();
        assert!(result.csv);
        assert_eq!(result.only.as_deref(), Some("scope"));
    }

    #[test]
    fn test_parse_args_missing_path() {
        let mut args = vec!["--csv".to_string()].into_iter();
        let result = parse_args(&mut args);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing required <path>"));
    }

    #[test]
    fn test_parse_args_invalid_phase() {
        let mut args = vec![
            ".".to_string(),
            "--only".to_string(),
            "invalid".to_string(),
        ]
        .into_iter();
        let result = parse_args(&mut args);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unknown phase"));
    }

    #[test]
    fn test_parse_args_only_missing_value() {
        let mut args = vec![".".to_string(), "--only".to_string()].into_iter();
        let result = parse_args(&mut args);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("--only requires a phase name"));
    }

    #[test]
    fn test_parse_args_unknown_flag() {
        let mut args = vec![".".to_string(), "--unknown".to_string()].into_iter();
        let result = parse_args(&mut args);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unknown flag"));
    }

    #[test]
    fn test_valid_phases_list() {
        assert_eq!(VALID_PHASES, &["scan", "parse", "metadata", "scope", "packages"]);
    }

    #[test]
    fn test_parse_args_all_valid_phases() {
        for phase in VALID_PHASES {
            let mut args = vec![
                ".".to_string(),
                "--only".to_string(),
                phase.to_string(),
            ]
            .into_iter();
            let result = parse_args(&mut args);
            assert!(result.is_ok(), "Phase '{}' should be valid", phase);
            assert_eq!(result.unwrap().only.as_deref(), Some(*phase));
        }
    }

    #[test]
    fn test_should_skip_directory() {
        assert!(should_skip_directory(".git"));
        assert!(should_skip_directory("node_modules"));
        assert!(should_skip_directory("renv"));
        assert!(should_skip_directory("target"));
        assert!(!should_skip_directory("R"));
        assert!(!should_skip_directory("src"));
        assert!(!should_skip_directory("data"));
    }

    #[test]
    fn test_run_analysis_stats_on_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        let args = AnalysisStatsArgs {
            path: dir.path().to_path_buf(),
            csv: false,
            only: None,
        };
        let results = run_analysis_stats(&args);
        assert_eq!(results.len(), 5); // all 5 phases
        for result in &results {
            assert!(VALID_PHASES.contains(&result.name.as_str()));
        }
    }

    #[test]
    fn test_run_analysis_stats_only_scan() {
        let dir = tempfile::tempdir().unwrap();
        let args = AnalysisStatsArgs {
            path: dir.path().to_path_buf(),
            csv: false,
            only: Some("scan".to_string()),
        };
        let results = run_analysis_stats(&args);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "scan");
    }

    #[test]
    fn test_run_analysis_stats_with_r_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("test.R"),
            "x <- 1\nmy_func <- function(a) a + 1\nlibrary(stats)\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("helper.R"),
            "source('test.R')\ny <- x + 2\n",
        )
        .unwrap();

        let args = AnalysisStatsArgs {
            path: dir.path().to_path_buf(),
            csv: false,
            only: None,
        };
        let results = run_analysis_stats(&args);
        assert_eq!(results.len(), 5);

        // Scan should find 2 files
        let scan = &results[0];
        assert_eq!(scan.name, "scan");
        assert!(scan.detail.contains("2 files"));

        // Parse should parse 2 files
        let parse = &results[1];
        assert_eq!(parse.name, "parse");
        assert!(parse.detail.contains("2 files parsed"));
    }

    #[test]
    fn test_csv_output_format() {
        let results = vec![
            PhaseResult {
                name: "scan".to_string(),
                duration: Duration::from_millis(10),
                peak_rss_bytes: Some(1024 * 1024 * 50),
                detail: "5 files".to_string(),
            },
            PhaseResult {
                name: "parse".to_string(),
                duration: Duration::from_millis(25),
                peak_rss_bytes: None,
                detail: "5 files parsed (5 succeeded)".to_string(),
            },
        ];

        // Just verify it doesn't panic; actual output goes to stdout
        print_results_csv(&results);
        print_results(&results);
    }

    #[test]
    fn test_discover_r_files_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        let files = discover_r_files(dir.path());
        assert!(files.is_empty());
    }

    #[test]
    fn test_discover_r_files_with_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.R"), "x <- 1").unwrap();
        std::fs::write(dir.path().join("b.r"), "y <- 2").unwrap(); // lowercase .r
        std::fs::write(dir.path().join("c.txt"), "not R").unwrap();

        let files = discover_r_files(dir.path());
        assert_eq!(files.len(), 2);
        // Should be sorted
        assert!(files[0].0 < files[1].0);
    }

    #[test]
    fn test_discover_r_files_skips_git() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".git/config.R"), "x <- 1").unwrap();
        std::fs::write(dir.path().join("real.R"), "y <- 2").unwrap();

        let files = discover_r_files(dir.path());
        assert_eq!(files.len(), 1);
        assert!(files[0].0.ends_with("real.R"));
    }

    #[test]
    fn test_format_bytes() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(1024), "1.0 KB");
        assert_eq!(format_bytes(1536), "1.5 KB");
        assert_eq!(format_bytes(1024 * 1024), "1.0 MB");
        assert_eq!(format_bytes(50 * 1024 * 1024), "50.0 MB");
        assert_eq!(format_bytes(1024 * 1024 * 1024), "1.0 GB");
        assert_eq!(format_bytes(2 * 1024 * 1024 * 1024), "2.0 GB");
    }

    #[test]
    fn test_phase_result_has_peak_rss() {
        let result = PhaseResult {
            name: "test".to_string(),
            duration: Duration::from_millis(100),
            peak_rss_bytes: Some(1024 * 1024 * 42),
            detail: "test detail".to_string(),
        };
        assert_eq!(result.peak_rss_bytes, Some(1024 * 1024 * 42));

        let result_none = PhaseResult {
            name: "test".to_string(),
            duration: Duration::from_millis(100),
            peak_rss_bytes: None,
            detail: "test detail".to_string(),
        };
        assert!(result_none.peak_rss_bytes.is_none());
    }
}
