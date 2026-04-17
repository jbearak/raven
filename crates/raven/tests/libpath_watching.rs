//! End-to-end integration: filesystem change under a watched libpath
//! propagates into a PackageLibrary cache invalidation.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use raven::libpath_watcher::{spawn_watcher, LibpathEvent};
use raven::package_library::{PackageInfo, PackageLibrary};
use tempfile::tempdir;
use tokio::sync::mpsc;

fn make_pkg(root: &Path, name: &str) {
    let d = root.join(name);
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("DESCRIPTION"), "Package: x\n").unwrap();
}

#[tokio::test]
#[ignore = "requires reliable macOS FSEvents delivery; run with `cargo test -- --ignored`"]
async fn install_triggers_cache_invalidation() {
    let t = tempdir().unwrap();

    // Pre-populate a cache entry for "foo" simulating a previous stale miss.
    let lib = Arc::new(PackageLibrary::new_empty());
    lib.insert_package(PackageInfo::new("foo".into(), HashSet::new()))
        .await;
    assert!(lib.is_cached("foo").await);

    let (tx, mut rx) = mpsc::channel::<LibpathEvent>(16);
    let _handle = spawn_watcher(
        vec![t.path().to_path_buf()],
        Duration::from_millis(300),
        tx,
    )
    .expect("watcher attached");

    tokio::time::sleep(Duration::from_millis(200)).await;
    make_pkg(t.path(), "foo");

    let evt = tokio::time::timeout(Duration::from_secs(3), rx.recv())
        .await
        .expect("event in time")
        .expect("channel open");

    let affected = evt.affected_packages();
    assert!(affected.contains("foo"), "expected 'foo' in {:?}", affected);

    lib.invalidate_many(&affected).await;
    assert!(!lib.is_cached("foo").await);
}

#[tokio::test]
#[ignore = "requires reliable FS notifications; run with `cargo test -- --ignored`"]
async fn in_place_upgrade_triggers_cache_invalidation() {
    // Regression: under `NonRecursive` this case silently did nothing because
    // no notify events ever reached `touched_from_events`. Under `Recursive`,
    // file-level events under `<libpath>/foo/` translate to `touched={"foo"}`
    // and the cached stale `foo` entry gets dropped.
    let t = tempdir().unwrap();
    make_pkg(t.path(), "foo");

    let lib = Arc::new(PackageLibrary::new_empty());
    lib.insert_package(PackageInfo::new("foo".into(), HashSet::new()))
        .await;
    assert!(lib.is_cached("foo").await);

    let (tx, mut rx) = mpsc::channel::<LibpathEvent>(16);
    let _handle = spawn_watcher(
        vec![t.path().to_path_buf()],
        Duration::from_millis(300),
        tx,
    )
    .expect("watcher attached");

    tokio::time::sleep(Duration::from_millis(200)).await;

    // Rewrite files inside the existing `foo/` directory — this is what
    // `install.packages("foo")` does for an already-installed package.
    std::fs::write(
        t.path().join("foo").join("DESCRIPTION"),
        "Package: foo\nVersion: 2.0\n",
    )
    .unwrap();
    std::fs::write(
        t.path().join("foo").join("NAMESPACE"),
        "export(new_fn)\n",
    )
    .unwrap();

    let evt = tokio::time::timeout(Duration::from_secs(3), rx.recv())
        .await
        .expect("event in time")
        .expect("channel open");

    let affected = evt.affected_packages();
    assert!(affected.contains("foo"), "expected 'foo' in {:?}", affected);

    lib.invalidate_many(&affected).await;
    assert!(!lib.is_cached("foo").await);
}
