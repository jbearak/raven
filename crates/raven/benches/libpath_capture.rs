// libpath_capture.rs - Benchmark for LibpathSnapshot::capture filesystem cost.
//
// Run with: cargo bench --bench libpath_capture --features test-support
// Real libpath: RAVEN_BENCH_LIBPATH=/usr/local/lib/R/site-library cargo bench --bench libpath_capture --features test-support

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use raven::libpath_watcher::LibpathSnapshot;
use std::path::PathBuf;
use tempfile::TempDir;

fn make_synthetic_libpath(n: usize) -> TempDir {
    let t = tempfile::tempdir().expect("create tempdir");
    for i in 0..n {
        let pkg = t.path().join(format!("pkg{i}"));
        std::fs::create_dir(&pkg).unwrap();
        std::fs::write(pkg.join("DESCRIPTION"), format!("Package: pkg{i}\n")).unwrap();
    }
    t
}

fn bench_capture(c: &mut Criterion) {
    let mut group = c.benchmark_group("libpath_capture");

    // Optional real libpath from env var.
    if let Ok(real) = std::env::var("RAVEN_BENCH_LIBPATH") {
        let p = PathBuf::from(&real);
        if p.is_dir() {
            let count = std::fs::read_dir(&p).map(|rd| rd.count()).unwrap_or(0);
            let paths = vec![p];
            group.bench_function(BenchmarkId::new("real", count), |b| {
                b.iter(|| black_box(LibpathSnapshot::capture(&paths)));
            });
        }
    }

    for n in [100, 500] {
        let t = make_synthetic_libpath(n);
        let paths = vec![t.path().to_path_buf()];
        group.bench_function(BenchmarkId::new("synthetic", n), |b| {
            b.iter(|| black_box(LibpathSnapshot::capture(&paths)));
        });
    }

    group.finish();
}

criterion_group!(benches, bench_capture);
criterion_main!(benches);
