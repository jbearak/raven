//! Long-running `raven check` corpus over real R package sources.
//!
//! The non-ignored tests validate the manifest, CRAN metadata parsing, JSON
//! diagnostic parsing, and triage matching without network access. The ignored
//! test fetches package sources into a temp dir and runs the built `raven`
//! binary.
//!
//! Smoke run, defaulting to `stats` from R SVN:
//!
//! `cargo test -p raven --test package_corpus -- --ignored --nocapture`
//!
//! Package-group triage examples:
//!
//! `RAVEN_CORPUS_GROUPS=base cargo test -p raven --test package_corpus -- --ignored --nocapture`
//! `RAVEN_CORPUS_PACKAGES=dplyr,DT cargo test -p raven --test package_corpus -- --ignored --nocapture`
//! `RAVEN_CORPUS_GROUPS=base RAVEN_CORPUS_ALLOW_UNCLASSIFIED=1 cargo test -p raven --test package_corpus -- --ignored --nocapture`
//! Add `RAVEN_CORPUS_KEEP_TEMP=1` to preserve fetched package sources for
//! minimal-edit confirmation.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tempfile::TempDir;

const R_SVN_LIBRARY_URL: &str = "https://svn.r-project.org/R/trunk/src/library";
const CRAN_CONTRIB_URL: &str = "https://cloud.r-project.org/src/contrib";
const TRIAGE_FIXTURE: &str = include_str!("fixtures/package_corpus/accepted_real_diagnostics.toml");
const FP_FIXTURE: &str = include_str!("fixtures/package_corpus/known_false_positives.toml");

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
enum PackageGroup {
    Base,
    Recommended,
    Tidyverse,
    Dt,
}

impl PackageGroup {
    fn as_str(self) -> &'static str {
        match self {
            Self::Base => "base",
            Self::Recommended => "recommended",
            Self::Tidyverse => "tidyverse",
            Self::Dt => "dt",
        }
    }

    fn from_filter(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "base" => Some(Self::Base),
            "recommended" => Some(Self::Recommended),
            "tidyverse" => Some(Self::Tidyverse),
            "dt" => Some(Self::Dt),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
enum FetchKind {
    Svn,
    Git,
    CranTarball,
}

impl FetchKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Svn => "svn",
            Self::Git => "git",
            Self::CranTarball => "cran-tarball",
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct FetchSpec {
    kind: FetchKind,
    source_id: &'static str,
    url: &'static str,
    package_root_subdir: &'static str,
    cran_package: Option<&'static str>,
}

impl FetchSpec {
    const fn svn(
        source_id: &'static str,
        url: &'static str,
        package_root_subdir: &'static str,
    ) -> Self {
        Self {
            kind: FetchKind::Svn,
            source_id,
            url,
            package_root_subdir,
            cran_package: None,
        }
    }

    const fn git(
        source_id: &'static str,
        url: &'static str,
        package_root_subdir: &'static str,
    ) -> Self {
        Self {
            kind: FetchKind::Git,
            source_id,
            url,
            package_root_subdir,
            cran_package: None,
        }
    }

    const fn cran(package: &'static str) -> Self {
        Self {
            kind: FetchKind::CranTarball,
            source_id: package,
            url: CRAN_CONTRIB_URL,
            package_root_subdir: "",
            cran_package: Some(package),
        }
    }

    fn cache_key(self) -> String {
        format!("{}:{}:{}", self.kind.as_str(), self.source_id, self.url)
    }
}

#[derive(Debug)]
struct PackageSpec {
    name: &'static str,
    group: PackageGroup,
    fetches: Vec<FetchSpec>,
}

macro_rules! base_pkg {
    ($name:literal) => {
        PackageSpec {
            name: $name,
            group: PackageGroup::Base,
            fetches: vec![FetchSpec::svn(
                "r-source-library-trunk",
                R_SVN_LIBRARY_URL,
                $name,
            )],
        }
    };
}

macro_rules! cran_pkg {
    ($group:expr, $name:literal) => {
        PackageSpec {
            name: $name,
            group: $group,
            fetches: vec![FetchSpec::cran($name)],
        }
    };
}

macro_rules! svn_pkg {
    ($group:expr, $name:literal, $url:literal) => {
        PackageSpec {
            name: $name,
            group: $group,
            fetches: vec![
                FetchSpec::svn(concat!("svn:", $name), $url, ""),
                FetchSpec::cran($name),
            ],
        }
    };
}

macro_rules! git_pkg {
    ($group:expr, $name:literal, $url:literal) => {
        PackageSpec {
            name: $name,
            group: $group,
            fetches: vec![
                FetchSpec::git(concat!("git:", $name), $url, ""),
                FetchSpec::cran($name),
            ],
        }
    };
}

fn corpus_manifest() -> Vec<PackageSpec> {
    vec![
        base_pkg!("base"),
        base_pkg!("compiler"),
        base_pkg!("datasets"),
        base_pkg!("graphics"),
        base_pkg!("grDevices"),
        base_pkg!("grid"),
        base_pkg!("methods"),
        base_pkg!("parallel"),
        base_pkg!("splines"),
        base_pkg!("stats"),
        base_pkg!("stats4"),
        base_pkg!("tcltk"),
        base_pkg!("tools"),
        base_pkg!("utils"),
        cran_pkg!(PackageGroup::Recommended, "boot"),
        cran_pkg!(PackageGroup::Recommended, "class"),
        svn_pkg!(
            PackageGroup::Recommended,
            "cluster",
            "https://svn.r-project.org/R-packages/trunk/cluster/"
        ),
        git_pkg!(
            PackageGroup::Recommended,
            "codetools",
            "https://gitlab.com/luke-tierney/codetools"
        ),
        svn_pkg!(
            PackageGroup::Recommended,
            "foreign",
            "https://svn.r-project.org/R-packages/trunk/foreign/"
        ),
        cran_pkg!(PackageGroup::Recommended, "KernSmooth"),
        cran_pkg!(PackageGroup::Recommended, "lattice"),
        cran_pkg!(PackageGroup::Recommended, "MASS"),
        cran_pkg!(PackageGroup::Recommended, "Matrix"),
        cran_pkg!(PackageGroup::Recommended, "mgcv"),
        svn_pkg!(
            PackageGroup::Recommended,
            "nlme",
            "https://svn.r-project.org/R-packages/trunk/nlme/"
        ),
        cran_pkg!(PackageGroup::Recommended, "nnet"),
        git_pkg!(
            PackageGroup::Recommended,
            "rpart",
            "https://github.com/bethatkinson/rpart"
        ),
        cran_pkg!(PackageGroup::Recommended, "spatial"),
        git_pkg!(
            PackageGroup::Recommended,
            "survival",
            "https://github.com/therneau/survival"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "broom",
            "https://github.com/tidymodels/broom"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "cli",
            "https://github.com/r-lib/cli"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "conflicted",
            "https://github.com/r-lib/conflicted"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "dbplyr",
            "https://github.com/tidyverse/dbplyr"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "dplyr",
            "https://github.com/tidyverse/dplyr"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "dtplyr",
            "https://github.com/tidyverse/dtplyr"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "forcats",
            "https://github.com/tidyverse/forcats"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "ggplot2",
            "https://github.com/tidyverse/ggplot2"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "googledrive",
            "https://github.com/tidyverse/googledrive"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "googlesheets4",
            "https://github.com/tidyverse/googlesheets4"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "haven",
            "https://github.com/tidyverse/haven"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "hms",
            "https://github.com/tidyverse/hms"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "httr",
            "https://github.com/r-lib/httr"
        ),
        cran_pkg!(PackageGroup::Tidyverse, "jsonlite"),
        git_pkg!(
            PackageGroup::Tidyverse,
            "lubridate",
            "https://github.com/tidyverse/lubridate"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "magrittr",
            "https://github.com/tidyverse/magrittr"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "modelr",
            "https://github.com/tidyverse/modelr"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "pillar",
            "https://github.com/r-lib/pillar"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "purrr",
            "https://github.com/tidyverse/purrr"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "ragg",
            "https://github.com/r-lib/ragg"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "readr",
            "https://github.com/tidyverse/readr"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "readxl",
            "https://github.com/tidyverse/readxl"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "reprex",
            "https://github.com/tidyverse/reprex"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "rlang",
            "https://github.com/r-lib/rlang"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "rstudioapi",
            "https://github.com/rstudio/rstudioapi"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "rvest",
            "https://github.com/tidyverse/rvest"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "stringr",
            "https://github.com/tidyverse/stringr"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "tibble",
            "https://github.com/tidyverse/tibble"
        ),
        git_pkg!(
            PackageGroup::Tidyverse,
            "tidyr",
            "https://github.com/tidyverse/tidyr"
        ),
        cran_pkg!(PackageGroup::Tidyverse, "xml2"),
        git_pkg!(
            PackageGroup::Tidyverse,
            "tidyverse",
            "https://github.com/tidyverse/tidyverse"
        ),
        git_pkg!(PackageGroup::Dt, "DT", "https://github.com/rstudio/DT"),
    ]
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
struct DiagnosticRange {
    start_line: u32,
    start_character: u32,
    end_line: u32,
    end_character: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
struct ObservedDiagnostic {
    package: String,
    path: String,
    range: DiagnosticRange,
    severity: Option<u64>,
    message: String,
    code: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TriageFixture {
    #[serde(default, rename = "diagnostic")]
    diagnostics: Vec<TriageDiagnostic>,
}

#[derive(Debug, Deserialize)]
struct TriageDiagnostic {
    package: String,
    path: String,
    message: String,
    range: DiagnosticRangeToml,
    evidence: String,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    minimal_edit: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DiagnosticRangeToml {
    start_line: u32,
    start_character: u32,
    end_line: u32,
    end_character: u32,
}

#[derive(Debug, Deserialize)]
struct FalsePositiveFixture {
    #[serde(default, rename = "false_positive")]
    false_positives: Vec<FalsePositiveEntry>,
}

#[derive(Debug, Deserialize)]
struct FalsePositiveEntry {
    package: String,
    path: String,
    message: String,
    range: DiagnosticRangeToml,
    #[serde(default)]
    #[allow(dead_code)] // present for documentation in the TOML fixture
    reason: Option<String>,
}

impl FalsePositiveFixture {
    fn load() -> Self {
        toml::from_str(FP_FIXTURE).expect("known false positives fixture parses")
    }

    fn keys_for_package(&self, package: &str) -> BTreeSet<DiagnosticKey> {
        self.false_positives
            .iter()
            .filter(|fp| fp.package == package)
            .map(|fp| DiagnosticKey {
                package: fp.package.clone(),
                path: fp.path.clone(),
                message: fp.message.clone(),
                range: DiagnosticRange {
                    start_line: fp.range.start_line,
                    start_character: fp.range.start_character,
                    end_line: fp.range.end_line,
                    end_character: fp.range.end_character,
                },
            })
            .collect()
    }
}

impl TriageFixture {
    fn load() -> Self {
        toml::from_str(TRIAGE_FIXTURE).expect("package corpus triage fixture parses")
    }

    fn accepted_keys_for_package(&self, package: &str) -> BTreeSet<DiagnosticKey> {
        self.diagnostics
            .iter()
            .filter(|diag| diag.package == package)
            .map(TriageDiagnostic::key)
            .collect()
    }
}

impl TriageDiagnostic {
    fn key(&self) -> DiagnosticKey {
        DiagnosticKey {
            package: self.package.clone(),
            path: self.path.clone(),
            message: self.message.clone(),
            range: DiagnosticRange {
                start_line: self.range.start_line,
                start_character: self.range.start_character,
                end_line: self.range.end_line,
                end_character: self.range.end_character,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct DiagnosticKey {
    package: String,
    path: String,
    message: String,
    range: DiagnosticRange,
}

impl ObservedDiagnostic {
    fn key(&self) -> DiagnosticKey {
        DiagnosticKey {
            package: self.package.clone(),
            path: self.path.clone(),
            message: self.message.clone(),
            range: self.range.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
struct ResolvedSource {
    kind: FetchKind,
    source_id: String,
    url: String,
    reference: String,
    package_root: PathBuf,
}

#[derive(Debug, Serialize)]
struct CheckReport {
    package: String,
    group: PackageGroup,
    source: ResolvedSource,
    command: String,
    exit_code: Option<i32>,
    stderr: String,
    diagnostics: Vec<ObservedDiagnostic>,
}

#[derive(Debug)]
struct FetchedSource {
    kind: FetchKind,
    source_id: String,
    url: String,
    reference: String,
    root: PathBuf,
}

#[derive(Debug)]
struct PackageCheckout {
    source: ResolvedSource,
}

#[derive(Debug)]
struct Classification {
    unclassified: Vec<ObservedDiagnostic>,
    stale_acceptances: Vec<DiagnosticKey>,
}

#[test]
fn manifest_covers_requested_package_sets() {
    let manifest = corpus_manifest();

    let base: Vec<_> = manifest
        .iter()
        .filter(|pkg| pkg.group == PackageGroup::Base)
        .map(|pkg| pkg.name)
        .collect();
    let recommended: Vec<_> = manifest
        .iter()
        .filter(|pkg| pkg.group == PackageGroup::Recommended)
        .map(|pkg| pkg.name)
        .collect();
    let tidyverse: Vec<_> = manifest
        .iter()
        .filter(|pkg| pkg.group == PackageGroup::Tidyverse)
        .map(|pkg| pkg.name)
        .collect();
    let dt: Vec<_> = manifest
        .iter()
        .filter(|pkg| pkg.group == PackageGroup::Dt)
        .map(|pkg| pkg.name)
        .collect();

    assert_eq!(base.len(), 14, "base-priority packages: {base:?}");
    assert_eq!(
        recommended.len(),
        15,
        "recommended packages: {recommended:?}"
    );
    assert_eq!(tidyverse.len(), 31, "tidyverse packages: {tidyverse:?}");
    assert_eq!(dt, vec!["DT"]);
    assert!(base.contains(&"stats"));
    assert!(recommended.contains(&"survival"));
    assert!(tidyverse.contains(&"dplyr"));
}

#[test]
fn manifest_uses_all_required_fetch_strategies() {
    let kinds: BTreeSet<_> = corpus_manifest()
        .iter()
        .flat_map(|pkg| pkg.fetches.iter().map(|fetch| fetch.kind))
        .collect();

    assert!(kinds.contains(&FetchKind::Svn), "missing SVN sources");
    assert!(kinds.contains(&FetchKind::Git), "missing git sources");
    assert!(
        kinds.contains(&FetchKind::CranTarball),
        "missing CRAN tarball fallback sources"
    );
}

#[test]
fn manifest_package_names_are_unique() {
    let manifest = corpus_manifest();
    let names: BTreeSet<_> = manifest.iter().map(|pkg| pkg.name).collect();

    assert_eq!(
        names.len(),
        manifest.len(),
        "manifest contains duplicate package names"
    );
}

#[test]
fn triage_fixture_is_parseable_and_unique() {
    let fixture = TriageFixture::load();
    let mut keys = BTreeSet::new();

    for diagnostic in &fixture.diagnostics {
        assert!(
            !diagnostic.evidence.trim().is_empty(),
            "accepted real diagnostic must record evidence: {diagnostic:?}"
        );
        if let Some(source) = &diagnostic.source {
            assert!(
                !source.trim().is_empty(),
                "source field must not be blank: {diagnostic:?}"
            );
        }
        if let Some(minimal_edit) = &diagnostic.minimal_edit {
            assert!(
                !minimal_edit.trim().is_empty(),
                "minimal_edit field must not be blank: {diagnostic:?}"
            );
        }
        assert!(
            keys.insert(diagnostic.key()),
            "duplicate accepted diagnostic: {diagnostic:?}"
        );
    }
}

#[test]
fn parses_cran_package_versions() {
    let versions = parse_cran_versions(
        "Package: foo\nVersion: 1.2.3\nDepends: R\n\nPackage: bar\nVersion: 0.9-1\n",
    );

    assert_eq!(versions.get("foo").map(String::as_str), Some("1.2.3"));
    assert_eq!(versions.get("bar").map(String::as_str), Some("0.9-1"));
}

#[test]
fn parses_raven_json_diagnostics() {
    let json = r#"[
      {
        "path": "R/example.R",
        "diagnostic": {
          "range": {
            "start": { "line": 2, "character": 4 },
            "end": { "line": 2, "character": 11 }
          },
          "severity": 2,
          "message": "Undefined variable: missing",
          "code": "undefined-variable"
        }
      }
    ]"#;

    let diagnostics = parse_raven_json("pkg", json).unwrap();

    assert_eq!(
        diagnostics,
        vec![ObservedDiagnostic {
            package: "pkg".into(),
            path: "R/example.R".into(),
            range: DiagnosticRange {
                start_line: 2,
                start_character: 4,
                end_line: 2,
                end_character: 11,
            },
            severity: Some(2),
            message: "Undefined variable: missing".into(),
            code: Some("undefined-variable".into()),
        }]
    );
}

#[test]
fn classification_flags_unclassified_and_stale_diagnostics() {
    let fixture: TriageFixture = toml::from_str(
        r#"
        [[diagnostic]]
        package = "pkg"
        path = "R/accepted.R"
        message = "Undefined variable: accepted"
        evidence = "Confirmed by replacing the symbol with a local definition in a temp checkout."
        [diagnostic.range]
        start_line = 0
        start_character = 0
        end_line = 0
        end_character = 8

        [[diagnostic]]
        package = "pkg"
        path = "R/stale.R"
        message = "Undefined variable: stale"
        evidence = "Confirmed by replacing the symbol with a local definition in a temp checkout."
        [diagnostic.range]
        start_line = 1
        start_character = 0
        end_line = 1
        end_character = 5
        "#,
    )
    .unwrap();
    let accepted = ObservedDiagnostic {
        package: "pkg".into(),
        path: "R/accepted.R".into(),
        range: DiagnosticRange {
            start_line: 0,
            start_character: 0,
            end_line: 0,
            end_character: 8,
        },
        severity: Some(2),
        message: "Undefined variable: accepted".into(),
        code: None,
    };
    let unclassified = ObservedDiagnostic {
        package: "pkg".into(),
        path: "R/new.R".into(),
        range: DiagnosticRange {
            start_line: 2,
            start_character: 0,
            end_line: 2,
            end_character: 3,
        },
        severity: Some(2),
        message: "Undefined variable: new".into(),
        code: None,
    };

    let fp_fixture = FalsePositiveFixture {
        false_positives: vec![],
    };
    let classification =
        classify_observed(&[accepted, unclassified.clone()], &fixture, &fp_fixture);

    assert_eq!(classification.unclassified, vec![unclassified]);
    assert_eq!(classification.stale_acceptances.len(), 1);
    assert_eq!(
        classification.stale_acceptances[0].message,
        "Undefined variable: stale"
    );
}

#[test]
#[ignore]
fn package_corpus_selected() {
    let manifest = corpus_manifest();
    let selected = selected_packages(&manifest);
    let reports = run_corpus(&selected).expect("package corpus run should complete");

    assert!(
        !reports.is_empty(),
        "package corpus selection unexpectedly produced no reports"
    );
}

fn selected_packages(manifest: &[PackageSpec]) -> Vec<&PackageSpec> {
    let package_filter = std::env::var("RAVEN_CORPUS_PACKAGES")
        .ok()
        .map(|value| split_filter(&value));
    let group_filter = std::env::var("RAVEN_CORPUS_GROUPS").ok().map(|value| {
        split_filter(&value)
            .into_iter()
            .map(|group| {
                PackageGroup::from_filter(&group)
                    .unwrap_or_else(|| panic!("unknown RAVEN_CORPUS_GROUPS entry: {group}"))
            })
            .collect::<BTreeSet<_>>()
    });
    let run_all = std::env::var("RAVEN_CORPUS_ALL").is_ok_and(|value| value == "1");
    let limit = std::env::var("RAVEN_CORPUS_LIMIT").ok().map(|value| {
        value
            .parse::<usize>()
            .unwrap_or_else(|_| panic!("RAVEN_CORPUS_LIMIT must be an integer, got {value}"))
    });

    let default_smoke = package_filter.is_none() && group_filter.is_none() && !run_all;
    let mut selected: Vec<_> = manifest
        .iter()
        .filter(|pkg| {
            if default_smoke {
                pkg.name == "stats"
            } else {
                package_filter
                    .as_ref()
                    .is_none_or(|names| names.contains(pkg.name))
                    && group_filter
                        .as_ref()
                        .is_none_or(|groups| groups.contains(&pkg.group))
            }
        })
        .collect();

    if let Some(limit) = limit {
        selected.truncate(limit);
    }
    assert!(
        !selected.is_empty(),
        "package corpus selection is empty; check RAVEN_CORPUS_PACKAGES/RAVEN_CORPUS_GROUPS"
    );
    eprintln!(
        "package corpus selected: {}",
        selected
            .iter()
            .map(|pkg| format!("{}/{}", pkg.group.as_str(), pkg.name))
            .collect::<Vec<_>>()
            .join(", ")
    );
    selected
}

fn split_filter(value: &str) -> BTreeSet<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn run_corpus(packages: &[&PackageSpec]) -> Result<Vec<CheckReport>, String> {
    let temp = TempDir::new().map_err(|err| format!("create corpus temp dir: {err}"))?;
    eprintln!("package corpus temp root: {}", temp.path().display());
    let fetch_root = temp.path().join("sources");
    std::fs::create_dir_all(&fetch_root)
        .map_err(|err| format!("create fetch root {}: {err}", fetch_root.display()))?;

    let mut cache = BTreeMap::new();
    let mut reports = Vec::new();
    for package in packages {
        eprintln!(
            "package corpus checking {}/{}",
            package.group.as_str(),
            package.name
        );
        let checkout = materialize_package(package, &fetch_root, &mut cache)?;
        let report = run_raven_check(package, checkout)?;
        reports.push(report);
    }

    let report_path = write_run_report(&reports)?;
    eprintln!("package corpus report: {}", report_path.display());

    let fixture = TriageFixture::load();
    let fp_fixture = FalsePositiveFixture::load();
    let classification = classify_reports(&reports, &fixture, &fp_fixture);
    if !classification.unclassified.is_empty() || !classification.stale_acceptances.is_empty() {
        if allow_unclassified_collection() {
            eprintln!(
                "{}",
                format_classification_failure(&classification, &reports)
            );
            maybe_keep_temp(temp);
            return Ok(reports);
        }
        maybe_keep_temp(temp);
        return Err(format_classification_failure(&classification, &reports));
    }
    maybe_keep_temp(temp);

    Ok(reports)
}

fn allow_unclassified_collection() -> bool {
    std::env::var("RAVEN_CORPUS_ALLOW_UNCLASSIFIED").is_ok_and(|value| value == "1")
}

fn maybe_keep_temp(temp: TempDir) {
    if std::env::var("RAVEN_CORPUS_KEEP_TEMP").is_ok_and(|value| value == "1") {
        let path = temp.keep();
        eprintln!("package corpus kept temp root: {}", path.display());
    }
}

fn materialize_package(
    package: &PackageSpec,
    fetch_root: &Path,
    cache: &mut BTreeMap<String, FetchedSource>,
) -> Result<PackageCheckout, String> {
    let mut failures = Vec::new();

    for fetch in &package.fetches {
        let key = fetch.cache_key();
        if !cache.contains_key(&key) {
            match fetch_source(fetch, fetch_root) {
                Ok(source) => {
                    cache.insert(key.clone(), source);
                }
                Err(err) => {
                    failures.push(format!(
                        "{} {} failed: {err}",
                        fetch.kind.as_str(),
                        fetch.url
                    ));
                    continue;
                }
            }
        }

        let source = cache
            .get(&key)
            .expect("source cache entry should exist after successful fetch");
        let package_root = if fetch.package_root_subdir.is_empty() {
            source.root.clone()
        } else {
            source.root.join(fetch.package_root_subdir)
        };
        if package_root.is_dir() {
            return Ok(PackageCheckout {
                source: ResolvedSource {
                    kind: source.kind,
                    source_id: source.source_id.clone(),
                    url: source.url.clone(),
                    reference: source.reference.clone(),
                    package_root,
                },
            });
        }

        failures.push(format!(
            "{} fetched but package root does not exist: {}",
            fetch.kind.as_str(),
            package_root.display()
        ));
    }

    Err(format!(
        "failed to materialize package {}:\n{}",
        package.name,
        failures.join("\n")
    ))
}

fn fetch_source(fetch: &FetchSpec, fetch_root: &Path) -> Result<FetchedSource, String> {
    match fetch.kind {
        FetchKind::Svn => fetch_svn_source(fetch, fetch_root),
        FetchKind::Git => fetch_git_source(fetch, fetch_root),
        FetchKind::CranTarball => fetch_cran_source(fetch, fetch_root),
    }
}

fn fetch_svn_source(fetch: &FetchSpec, fetch_root: &Path) -> Result<FetchedSource, String> {
    let root = fetch_root.join(sanitize_cache_key(&fetch.cache_key()));
    let args = vec![
        OsString::from("export"),
        OsString::from("--quiet"),
        OsString::from(fetch.url),
        root.as_os_str().to_os_string(),
    ];
    run_checked("svn", args)?;
    Ok(FetchedSource {
        kind: FetchKind::Svn,
        source_id: fetch.source_id.to_string(),
        url: fetch.url.to_string(),
        reference: "trunk".to_string(),
        root,
    })
}

fn fetch_git_source(fetch: &FetchSpec, fetch_root: &Path) -> Result<FetchedSource, String> {
    let root = fetch_root.join(sanitize_cache_key(&fetch.cache_key()));
    let args = vec![
        OsString::from("clone"),
        OsString::from("--depth"),
        OsString::from("1"),
        OsString::from(fetch.url),
        root.as_os_str().to_os_string(),
    ];
    run_checked("git", args)?;

    let rev_output = run_checked(
        "git",
        vec![
            OsString::from("-C"),
            root.as_os_str().to_os_string(),
            OsString::from("rev-parse"),
            OsString::from("--short"),
            OsString::from("HEAD"),
        ],
    )?;
    let reference = String::from_utf8_lossy(&rev_output.stdout)
        .trim()
        .to_string();

    Ok(FetchedSource {
        kind: FetchKind::Git,
        source_id: fetch.source_id.to_string(),
        url: fetch.url.to_string(),
        reference,
        root,
    })
}

fn fetch_cran_source(fetch: &FetchSpec, fetch_root: &Path) -> Result<FetchedSource, String> {
    let package = fetch
        .cran_package
        .expect("CRAN tarball fetch should carry package name");
    let version = cran_versions()?
        .get(package)
        .ok_or_else(|| format!("CRAN metadata does not contain package {package}"))?
        .clone();
    let root_parent = fetch_root.join(sanitize_cache_key(&format!("cran:{package}:{version}")));
    std::fs::create_dir_all(&root_parent)
        .map_err(|err| format!("create CRAN extract dir {}: {err}", root_parent.display()))?;
    let archive = fetch_root.join(format!("{package}_{version}.tar.gz"));
    let archive_url = format!("{CRAN_CONTRIB_URL}/{package}_{version}.tar.gz");

    run_checked(
        "curl",
        vec![
            OsString::from("-fsSL"),
            OsString::from("-o"),
            archive.as_os_str().to_os_string(),
            OsString::from(&archive_url),
        ],
    )?;
    run_checked(
        "tar",
        vec![
            OsString::from("-xzf"),
            archive.as_os_str().to_os_string(),
            OsString::from("-C"),
            root_parent.as_os_str().to_os_string(),
        ],
    )?;

    let root = root_parent.join(package);
    if !root.is_dir() {
        return Err(format!(
            "CRAN archive for {package} did not extract expected root {}",
            root.display()
        ));
    }

    Ok(FetchedSource {
        kind: FetchKind::CranTarball,
        source_id: package.to_string(),
        url: archive_url,
        reference: version,
        root,
    })
}

fn cran_versions() -> Result<&'static BTreeMap<String, String>, String> {
    static CRAN_VERSIONS: OnceLock<Result<BTreeMap<String, String>, String>> = OnceLock::new();
    match CRAN_VERSIONS.get_or_init(fetch_cran_versions) {
        Ok(versions) => Ok(versions),
        Err(err) => Err(err.clone()),
    }
}

fn fetch_cran_versions() -> Result<BTreeMap<String, String>, String> {
    let output = run_checked(
        "curl",
        vec![
            OsString::from("-fsSL"),
            OsString::from(format!("{CRAN_CONTRIB_URL}/PACKAGES")),
        ],
    )?;
    let text = String::from_utf8(output.stdout)
        .map_err(|err| format!("CRAN PACKAGES metadata is not UTF-8: {err}"))?;
    Ok(parse_cran_versions(&text))
}

fn parse_cran_versions(packages_text: &str) -> BTreeMap<String, String> {
    let mut versions = BTreeMap::new();
    for block in packages_text.split("\n\n") {
        let mut package = None;
        let mut version = None;
        for line in block.lines() {
            if let Some(value) = line.strip_prefix("Package: ") {
                package = Some(value.trim().to_string());
            } else if let Some(value) = line.strip_prefix("Version: ") {
                version = Some(value.trim().to_string());
            }
        }
        if let (Some(package), Some(version)) = (package, version) {
            versions.insert(package, version);
        }
    }
    versions
}

fn run_raven_check(
    package: &PackageSpec,
    checkout: PackageCheckout,
) -> Result<CheckReport, String> {
    let binary = raven_binary();
    let args = vec![
        OsString::from("check"),
        OsString::from("--workspace"),
        checkout.source.package_root.as_os_str().to_os_string(),
        OsString::from("--format"),
        OsString::from("json"),
        OsString::from("--max-severity"),
        OsString::from("error"),
        OsString::from("--no-config"),
    ];
    let command = command_string(binary.as_os_str(), &args);
    let output = Command::new(&binary)
        .args(&args)
        .output()
        .map_err(|err| format!("failed to run {command}: {err}"))?;
    let stdout = String::from_utf8(output.stdout)
        .map_err(|err| format!("{command} produced non-UTF-8 stdout: {err}"))?;
    let diagnostics = parse_raven_json(package.name, &stdout)?;
    let exit_code = output.status.code();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if exit_code == Some(2) {
        return Err(format!("{command} failed with operator error:\n{stderr}"));
    }

    Ok(CheckReport {
        package: package.name.to_string(),
        group: package.group,
        source: checkout.source,
        command,
        exit_code,
        stderr,
        diagnostics,
    })
}

fn raven_binary() -> PathBuf {
    let mut path = std::env::current_exe().unwrap();
    path.pop();
    path.pop();
    path.push(if cfg!(windows) { "raven.exe" } else { "raven" });
    path
}

fn parse_raven_json(package: &str, stdout: &str) -> Result<Vec<ObservedDiagnostic>, String> {
    #[derive(Deserialize)]
    struct JsonDiagnosticItem {
        path: String,
        diagnostic: JsonDiagnostic,
    }

    #[derive(Deserialize)]
    struct JsonDiagnostic {
        range: JsonRange,
        severity: Option<u64>,
        message: String,
        #[serde(default)]
        code: Option<Value>,
    }

    #[derive(Deserialize)]
    struct JsonRange {
        start: JsonPosition,
        end: JsonPosition,
    }

    #[derive(Deserialize)]
    struct JsonPosition {
        line: u32,
        character: u32,
    }

    let items: Vec<JsonDiagnosticItem> = serde_json::from_str(stdout)
        .map_err(|err| format!("raven check JSON could not be parsed: {err}\nstdout:\n{stdout}"))?;
    Ok(items
        .into_iter()
        .map(|item| ObservedDiagnostic {
            package: package.to_string(),
            path: item.path,
            range: DiagnosticRange {
                start_line: item.diagnostic.range.start.line,
                start_character: item.diagnostic.range.start.character,
                end_line: item.diagnostic.range.end.line,
                end_character: item.diagnostic.range.end.character,
            },
            severity: item.diagnostic.severity,
            message: item.diagnostic.message,
            code: item.diagnostic.code.and_then(code_to_string),
        })
        .collect())
}

fn code_to_string(value: Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) => Some(s),
        Value::Number(n) => Some(n.to_string()),
        other => Some(other.to_string()),
    }
}

fn classify_reports(
    reports: &[CheckReport],
    fixture: &TriageFixture,
    fp_fixture: &FalsePositiveFixture,
) -> Classification {
    let observed = reports
        .iter()
        .flat_map(|report| report.diagnostics.iter().cloned())
        .collect::<Vec<_>>();
    classify_observed(&observed, fixture, fp_fixture)
}

fn classify_observed(
    observed: &[ObservedDiagnostic],
    fixture: &TriageFixture,
    fp_fixture: &FalsePositiveFixture,
) -> Classification {
    let observed_keys: BTreeSet<_> = observed.iter().map(ObservedDiagnostic::key).collect();
    let observed_packages: BTreeSet<_> =
        observed.iter().map(|diag| diag.package.as_str()).collect();
    let unclassified = observed
        .iter()
        .filter(|diag| {
            !fixture
                .accepted_keys_for_package(&diag.package)
                .contains(&diag.key())
                && !fp_fixture
                    .keys_for_package(&diag.package)
                    .contains(&diag.key())
        })
        .cloned()
        .collect();
    let stale_acceptances = fixture
        .diagnostics
        .iter()
        .filter(|diag| observed_packages.contains(diag.package.as_str()))
        .map(TriageDiagnostic::key)
        .filter(|key| !observed_keys.contains(key))
        .collect();

    Classification {
        unclassified,
        stale_acceptances,
    }
}

fn format_classification_failure(
    classification: &Classification,
    reports: &[CheckReport],
) -> String {
    let mut message = String::new();
    if !classification.unclassified.is_empty() {
        message.push_str("unclassified package-corpus diagnostics:\n");
        for diag in &classification.unclassified {
            message.push_str(&format!(
                "- {} {}:{}:{} {}\n",
                diag.package,
                diag.path,
                diag.range.start_line + 1,
                diag.range.start_character + 1,
                diag.message
            ));
        }
    }
    if !classification.stale_acceptances.is_empty() {
        message.push_str("stale accepted diagnostics no longer observed:\n");
        for diag in &classification.stale_acceptances {
            message.push_str(&format!(
                "- {} {}:{}:{} {}\n",
                diag.package,
                diag.path,
                diag.range.start_line + 1,
                diag.range.start_character + 1,
                diag.message
            ));
        }
    }
    message.push_str("checked sources:\n");
    for report in reports {
        message.push_str(&format!(
            "- {}/{} via {} {} @ {} (exit {:?})\n",
            report.group.as_str(),
            report.package,
            report.source.kind.as_str(),
            report.source.url,
            report.source.reference,
            report.exit_code
        ));
    }
    message
}

fn write_run_report(reports: &[CheckReport]) -> Result<PathBuf, String> {
    let report_dir = std::env::var_os("RAVEN_CORPUS_REPORT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(default_report_dir);
    std::fs::create_dir_all(&report_dir)
        .map_err(|err| format!("create report dir {}: {err}", report_dir.display()))?;
    let text = serde_json::to_string_pretty(reports)
        .map_err(|err| format!("serialize corpus report: {err}"))?;
    let latest = report_dir.join("latest.json");
    std::fs::write(&latest, &text)
        .map_err(|err| format!("write corpus report {}: {err}", latest.display()))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("system time before UNIX_EPOCH: {err}"))?
        .as_secs();
    let stamped = report_dir.join(format!("{timestamp}.json"));
    std::fs::write(&stamped, text)
        .map_err(|err| format!("write corpus report {}: {err}", stamped.display()))?;
    Ok(latest)
}

fn default_report_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crate dir has parent")
        .parent()
        .expect("crates dir has parent")
        .join("target/package-corpus")
}

fn run_checked(program: &str, args: Vec<OsString>) -> Result<Output, String> {
    let command = command_string(std::ffi::OsStr::new(program), &args);
    let output = Command::new(program)
        .args(&args)
        .output()
        .map_err(|err| format!("failed to run {command}: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "{command} failed with status {:?}\nstdout:\n{}\nstderr:\n{}",
            output.status.code(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(output)
}

fn command_string(program: &std::ffi::OsStr, args: &[OsString]) -> String {
    std::iter::once(program.to_os_string())
        .chain(args.iter().cloned())
        .map(|arg| shell_display(&arg))
        .collect::<Vec<_>>()
        .join(" ")
}

fn shell_display(arg: &std::ffi::OsStr) -> String {
    let text = arg.to_string_lossy();
    if text.is_empty() {
        "''".to_string()
    } else if text
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "-_./:=@+".contains(c))
    {
        text.into_owned()
    } else {
        format!("'{}'", text.replace('\'', "'\\''"))
    }
}

fn sanitize_cache_key(key: &str) -> String {
    key.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}
