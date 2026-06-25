pub mod fixture_workspace;
pub mod standalone_hub;

/// True when the host filesystem distinguishes directory entries by case
/// (Linux/CI). Used to gate tests whose fixtures can only be constructed on a
/// case-sensitive filesystem — two entries differing only by case cannot coexist
/// on a case-insensitive one (macOS, typical Windows). Issue #530 / #535.
pub fn host_is_case_sensitive() -> bool {
    let dir = tempfile::tempdir().expect("create temp dir for case-sensitivity probe");
    std::fs::write(dir.path().join("caseprobe"), "").expect("write case probe");
    // If the upper-cased name does NOT resolve to the same file, the FS is
    // case-sensitive.
    !dir.path().join("CASEPROBE").exists()
}
