//! R package mode subsystem.
//!
//! See `docs/superpowers/specs/2026-05-10-r-package-mode-architecture-design.md`
//! for the architectural rationale.
//!
//! This module owns all derived state for R package mode. Outside of this
//! module, `PackageState` is read-only — it can only be replaced as a
//! whole, never partially mutated.

pub mod derive;
pub use derive::derive_package_state;
pub mod digest;
pub use digest::ContentDigest;
pub mod event;

#[cfg(test)]
mod proptest_machine;

use std::path::PathBuf;
use std::sync::Arc;

use crate::package_namespace::{PackageNamespaceModel, PackageWorkspace};
use crate::roxygen::RoxygenNamespace;

/// Derived state for R package mode. Owned by `WorldState`.
/// Fully derive-based since Phase 5b: all fields are computed by `derive_package_state`.
#[derive(Default, Debug, Clone, PartialEq, Eq)]
pub struct PackageState {
    pub(super) workspace: Option<PackageWorkspace>,
    pub(super) namespace_model: Option<PackageNamespaceModel>,

    // Populated by derive_package_state
    pub(super) r_file_facts: BTreeMap<PathBuf, RFileFacts>,
    pub(super) scope_contribution: PackageScopeContribution,
}

impl PackageState {
    pub fn new() -> Self {
        Self {
            workspace: None,
            namespace_model: None,
            r_file_facts: BTreeMap::new(),
            scope_contribution: PackageScopeContribution::default(),
        }
    }

    pub fn workspace(&self) -> Option<&PackageWorkspace> {
        self.workspace.as_ref()
    }

    pub fn namespace_model(&self) -> Option<&PackageNamespaceModel> {
        self.namespace_model.as_ref()
    }

    pub fn r_file_facts(&self) -> &BTreeMap<PathBuf, RFileFacts> {
        &self.r_file_facts
    }

    pub fn scope_contribution(&self) -> &PackageScopeContribution {
        &self.scope_contribution
    }

    /// Replace all derived package-mode state in one step.
    ///
    /// `PackageState` fields stay non-public so consumers cannot update one
    /// derived cache without the others. Event handlers update
    /// `PackageInputs`, call `derive_package_state`, and then install the
    /// complete result through this method.
    pub(super) fn set_from(&mut self, new: PackageState) {
        *self = new;
    }
}

// ============== INPUTS ==============

use crate::cross_file::config::PackageMode;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default)]
pub struct PackageInputs {
    pub workspace_root: Option<PathBuf>,
    pub package_mode: PackageMode,
    pub description: Option<DescriptionInput>,
    pub namespace: Option<NamespaceInput>,
    pub r_files: BTreeMap<PathBuf, RFileInput>,
}

#[derive(Clone, Debug)]
pub struct DescriptionInput {
    pub text: Arc<str>,
}

#[derive(Clone, Debug)]
pub struct NamespaceInput {
    pub text: Arc<str>,
}

#[derive(Clone, Debug)]
pub struct RFileInput {
    pub kind: RFileKind,
    pub text: Arc<str>,
    pub content_digest: ContentDigest,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum RFileKind {
    Source,
    Test,
}

#[cfg(test)]
mod input_tests {
    use super::*;

    #[test]
    fn default_inputs_are_empty() {
        let inputs = PackageInputs::default();
        assert!(inputs.workspace_root.is_none());
        assert!(inputs.r_files.is_empty());
    }
}

// ============== DELTA ==============

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PackageInputDelta {
    Initial,
    RFileChanged { path: PathBuf, kind: RFileKind },
    RFileDeleted { path: PathBuf, kind: RFileKind },
    NamespaceChanged,
    DescriptionChanged,
    SettingChanged,
    Batch(Vec<PackageInputDelta>),
}

// ============== PATH HELPERS ==============

use std::path::Path;

/// Returns `Some(kind)` if `path` is a package source/test file we track,
/// based on the workspace root. Returns `None` otherwise.
///
/// Rules:
/// - `<root>/R/**/*.R` (or `*.r`) → `Source`
/// - `<root>/tests/testthat/**/*.R` (or `*.r`) → `Test`
/// - `<root>/tests/testit/**/*.R` (or `*.r`) → `Test`
/// - everything else → `None`
pub fn is_r_source_path(path: &Path, workspace_root: &Path) -> Option<RFileKind> {
    let rel = path.strip_prefix(workspace_root).ok()?;
    let mut comps = rel.components();
    let first = comps.next()?.as_os_str().to_str()?;

    let is_r_extension = matches!(path.extension().and_then(|e| e.to_str()), Some("R" | "r"),);
    if !is_r_extension {
        return None;
    }

    match first {
        "R" => Some(RFileKind::Source),
        "tests" => {
            let second = comps.next()?.as_os_str().to_str()?;
            if second == "testthat" || second == "testit" {
                Some(RFileKind::Test)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Returns `true` for testthat-recognized helper files: files under
/// `tests/testthat/` whose basename starts with `"helper"` (case-insensitive
/// match against testthat's own loader, which sources `^helper.*\\.[rR]$`
/// before each test file). Helper top-level definitions are visible to peer
/// files under `tests/testthat/`, but never propagate to `R/`. Setup files
/// (`setup-*.R`) are not currently treated as helpers; if that scope expands,
/// adjust here.
///
/// The caller is responsible for first confirming the file is under
/// `tests/testthat/` (e.g. via `is_r_source_path` returning `RFileKind::Test`);
/// this function only inspects the basename.
pub fn is_test_helper_filename(file_name: &str) -> bool {
    // Case-insensitive ASCII "helper" prefix. Slicing by raw byte index
    // would panic when byte 6 lands inside a multi-byte UTF-8 sequence
    // (e.g. `tes\u{00E9}.R`), so iterate `bytes()` and compare against
    // the ASCII prefix instead. Filenames are not normalized by Raven —
    // a leading non-ASCII glyph that happens to lowercase to "helper" is
    // intentionally not matched; testthat's loader matches the ASCII
    // pattern `^helper.*\.[rR]$`.
    const PREFIX: &[u8] = b"helper";
    let bytes = file_name.as_bytes();
    if bytes.len() < PREFIX.len() {
        return false;
    }
    for (i, p) in PREFIX.iter().enumerate() {
        if !bytes[i].eq_ignore_ascii_case(p) {
            return false;
        }
    }
    matches!(
        Path::new(file_name).extension().and_then(|e| e.to_str()),
        Some("R" | "r")
    )
}

#[cfg(test)]
mod path_tests {
    use super::*;

    #[test]
    #[allow(non_snake_case)]
    fn r_source_path_recognizes_R_dir() {
        assert_eq!(
            is_r_source_path(Path::new("/work/pkg/R/utils.R"), Path::new("/work/pkg")),
            Some(RFileKind::Source),
        );
    }

    #[test]
    fn r_source_path_recognizes_testthat() {
        assert_eq!(
            is_r_source_path(
                Path::new("/work/pkg/tests/testthat/test-utils.R"),
                Path::new("/work/pkg")
            ),
            Some(RFileKind::Test),
        );
    }

    #[test]
    fn r_source_path_recognizes_testit() {
        assert_eq!(
            is_r_source_path(
                Path::new("/work/pkg/tests/testit/test-utils.R"),
                Path::new("/work/pkg")
            ),
            Some(RFileKind::Test),
        );
    }

    #[test]
    #[allow(non_snake_case)]
    fn r_source_path_rejects_non_R_files() {
        let root = Path::new("/work/pkg");
        assert_eq!(
            is_r_source_path(Path::new("/work/pkg/R/utils.txt"), root),
            None
        );
        assert_eq!(
            is_r_source_path(Path::new("/work/pkg/inst/data.R"), root),
            None
        );
        assert_eq!(
            is_r_source_path(Path::new("/elsewhere/utils.R"), root),
            None
        );
    }

    #[test]
    fn r_source_path_handles_lowercase_extension() {
        assert_eq!(
            is_r_source_path(Path::new("/work/pkg/R/utils.r"), Path::new("/work/pkg")),
            Some(RFileKind::Source),
        );
    }

    #[test]
    #[allow(non_snake_case)]
    fn r_source_path_recognizes_subdirs_in_R() {
        assert_eq!(
            is_r_source_path(
                Path::new("/work/pkg/R/unix/utils.R"),
                Path::new("/work/pkg")
            ),
            Some(RFileKind::Source),
        );
    }

    #[test]
    fn test_helper_filename_recognizes_helper_prefix() {
        assert!(is_test_helper_filename("helper.R"));
        assert!(is_test_helper_filename("helper-utils.R"));
        assert!(is_test_helper_filename("helper_utils.R"));
        assert!(is_test_helper_filename("helper.r"));
        assert!(is_test_helper_filename("Helper-mixedCase.R"));
        assert!(is_test_helper_filename("HELPER-shouty.R"));
    }

    #[test]
    fn test_helper_filename_rejects_non_helpers() {
        assert!(!is_test_helper_filename("test-utils.R"));
        assert!(!is_test_helper_filename("setup.R"));
        assert!(!is_test_helper_filename("teardown.R"));
        // Prefix matches but extension is not R.
        assert!(!is_test_helper_filename("helper-data.csv"));
        assert!(!is_test_helper_filename("helper.txt"));
        // Too short to start with "helper".
        assert!(!is_test_helper_filename("help.R"));
        // Doesn't start with the helper prefix.
        assert!(!is_test_helper_filename("my-helper.R"));
    }

    /// Regression: byte-indexed slicing of a multi-byte UTF-8 filename
    /// must not panic. The original implementation evaluated
    /// `file_name[..6].eq_ignore_ascii_case("helper")`, which panics when
    /// byte index 6 falls inside a non-ASCII character.
    #[test]
    fn test_helper_filename_multibyte_safe() {
        // "hel😀.R" — 3 ASCII bytes followed by the 4-byte UTF-8 sequence
        // for U+1F600. Byte index 6 sits in the MIDDLE of the 4-byte
        // emoji (bytes 3..7), so the old `file_name[..6]` slice would
        // panic with "byte index 6 is not a char boundary". The byte-iter
        // implementation must not panic and must not match (prefix bytes
        // 0..6 are "hel" + 3 bytes of emoji, which do not equal "helper").
        let name = "hel\u{1F600}.R";
        assert!(!is_test_helper_filename(name));
        // A purely non-ASCII prefix must not match (and must not panic).
        assert!(!is_test_helper_filename("βλέπω-utils.R"));
        // A non-ASCII-leading name that happens to share a tail must not match either.
        assert!(!is_test_helper_filename("éhelper.R"));
    }
}

// ============== OUTPUTS (continued) ==============

use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RFileFacts {
    /// Canonical `Source` vs `Test` classification for this file,
    /// carried through from the corresponding `RFileInput`. Consumers
    /// that need to partition facts by location (e.g. `build_scope_contribution`,
    /// `merge_namespace_model`) MUST filter on `kind` rather than re-deriving
    /// the classification from the path, so there is a single source of truth.
    pub kind: RFileKind,
    pub roxygen_namespace: RoxygenNamespace,
    pub top_level_defs: Arc<BTreeSet<String>>,
    pub content_digest: ContentDigest,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PackageScopeContribution {
    /// The workspace root for this package, if known. Carried here so that
    /// scope-injection logic (Phase 5) can check whether the queried file is
    /// under `R/` or `tests/testthat/` without requiring a separate parameter.
    pub workspace_root: Option<PathBuf>,
    pub r_internal_symbols: Arc<BTreeSet<String>>,
    pub imported_symbols: Arc<BTreeMap<String, BTreeSet<String>>>,
    pub full_imports: Arc<BTreeSet<String>>,

    /// Packages that should be treated as if attached (via `library(...)`)
    /// when resolving scope for any file under `<root>/tests/testthat/`.
    ///
    /// Populated for testthat when the package's `DESCRIPTION` declares
    /// `testthat` in `Suggests:`, `Imports:`, or `Depends:`. The standard
    /// `tests/testthat.R` runner attaches testthat before sourcing each test
    /// file (matching `testthat::test_check`'s semantics), so test files
    /// transitively see testthat exports without an explicit `library(testthat)`.
    /// These packages are NOT visible to files under `R/` — they are scoped
    /// to `tests/testthat/` only.
    pub test_attached_packages: Arc<BTreeSet<String>>,

    /// Top-level definitions contributed by `tests/testthat/helper-*.R`
    /// files, keyed by the helper file's path so the scope-injection layer
    /// can skip a helper's own definitions when querying that helper file
    /// (otherwise a `use_x()` line earlier in the helper would falsely see
    /// `x <- ...` defined later in the same file).
    ///
    /// Visible from any file under `<root>/tests/testthat/` — peer helpers
    /// see each other and `test-*.R` files see them all. Never injected
    /// into files under `R/`. Mirrors `r_internal_symbols` but with the
    /// opposite visibility direction.
    ///
    /// `BTreeMap` ordering is intentional — derive iteration is
    /// deterministic so cached `PackageState` equality (used by the
    /// proptest machine) is stable across runs.
    pub test_helper_symbols: Arc<BTreeMap<PathBuf, Arc<BTreeSet<String>>>>,
}
