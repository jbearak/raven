// Targeted benchmarks for issue #414.
//
// Run with:
//   cargo bench -p raven --features test-support --bench package_cache_and_fanout
//
// These benchmarks intentionally exercise the paths changed by the package-cache
// contention refactor and the bounded diagnostic fan-out driver. They complement
// `startup.rs`, whose metadata/tree-sitter/workspace-scan groups are mostly
// orthogonal to those changes.

use criterion::{BatchSize, Criterion, black_box, criterion_group, criterion_main};
use raven::package_library::{PackageInfo, PackageLibrary};
use std::collections::HashSet;
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::Duration;
use tokio::runtime::{Builder, Runtime};

const PACKAGE_COUNT: usize = 24;
const EXPORTS_PER_PACKAGE: usize = 400;
const FANOUT_ITEMS: usize = 32;
const FANOUT_LIMIT: usize = 8;

fn runtime() -> Runtime {
    Builder::new_multi_thread()
        .worker_threads(FANOUT_LIMIT)
        .enable_all()
        .build()
        .expect("benchmark runtime should build")
}

fn package_info(index: usize) -> PackageInfo {
    let exports = (0..EXPORTS_PER_PACKAGE)
        .map(|export| format!("pkg_{index}_symbol_{export}"))
        .collect::<HashSet<_>>();
    PackageInfo::with_details(format!("pkg_{index}"), exports, Vec::new(), Vec::new())
}

fn seeded_package_library(rt: &Runtime) -> (Arc<PackageLibrary>, Vec<String>, String) {
    let lib = Arc::new(PackageLibrary::new_empty());
    rt.block_on(async {
        for index in 0..PACKAGE_COUNT {
            lib.insert_package(package_info(index)).await;
        }
    });

    let loaded_packages = (0..PACKAGE_COUNT)
        .map(|index| format!("pkg_{index}"))
        .collect::<Vec<_>>();
    let target_symbol = format!(
        "pkg_{}_symbol_{}",
        PACKAGE_COUNT - 1,
        EXPORTS_PER_PACKAGE - 1
    );

    (lib, loaded_packages, target_symbol)
}

struct HoldRequest {
    duration: Duration,
    acquired: mpsc::Sender<()>,
}

struct PackageWriteContention {
    requests: mpsc::Sender<HoldRequest>,
}

impl PackageWriteContention {
    fn start(lib: Arc<PackageLibrary>) -> Self {
        let (requests, receiver) = mpsc::channel::<HoldRequest>();
        let _ = thread::spawn(move || {
            while let Ok(request) = receiver.recv() {
                lib.with_packages_write_lock_for_test(|| {
                    let _ = request.acquired.send(());
                    thread::sleep(request.duration);
                });
            }
        });
        Self { requests }
    }

    fn hold_for(&self, duration: Duration) {
        let (acquired, ready) = mpsc::channel();
        self.requests
            .send(HoldRequest { duration, acquired })
            .expect("contention worker should be alive");
        ready
            .recv()
            .expect("contention worker should acquire the write lock");
    }
}

fn bench_package_cache(c: &mut Criterion) {
    let rt = runtime();
    let (lib, loaded_packages, target_symbol) = seeded_package_library(&rt);

    let mut group = c.benchmark_group("package_cache");

    group.bench_function("uncontended/is_symbol_hit_24_loaded", |b| {
        b.iter(|| {
            assert!(black_box(lib.is_symbol_from_loaded_packages(
                black_box(&target_symbol),
                black_box(&loaded_packages),
            )));
        })
    });

    group.bench_function("uncontended/find_owner_hit_24_loaded", |b| {
        b.iter(|| {
            let owner = lib.find_package_owner_for_symbol(
                black_box(&target_symbol),
                black_box(&loaded_packages),
            );
            black_box(owner);
        })
    });

    group.bench_function("uncontended/completions_24x400_exports", |b| {
        b.iter(|| {
            let completions = lib.get_exports_for_completions(black_box(&loaded_packages));
            assert_eq!(completions.len(), PACKAGE_COUNT * EXPORTS_PER_PACKAGE);
            black_box(completions);
        })
    });

    // Measures time-to-correct-answer while an unrelated writer holds the same
    // package-cache write lock. On the pre-refactor try_read implementation, a
    // single read during this window returned a false cache miss; this benchmark
    // loops until the correct hit is observed so both main and PR can be compared
    // without failing the benchmark. The attempt count is black-boxed: old code
    // spins/yields through repeated false misses, while the refactored reader
    // blocks once and returns the correct hit when the writer releases the lock.
    let contention = PackageWriteContention::start(Arc::clone(&lib));
    group.bench_function("contention/time_to_correct_symbol_read", |b| {
        b.iter(|| {
            contention.hold_for(Duration::from_micros(100));
            let mut attempts = 0usize;
            loop {
                attempts += 1;
                if lib.is_symbol_from_loaded_packages(
                    black_box(&target_symbol),
                    black_box(&loaded_packages),
                ) {
                    break;
                }
                thread::yield_now();
            }
            black_box(attempts);
        })
    });

    group.finish();
}

fn diagnostic_payload() -> Arc<Vec<u64>> {
    Arc::new(
        (0..2048)
            .map(|i| {
                let value = i as u64;
                value.wrapping_mul(0x9E37_79B9_7F4A_7C15)
            })
            .collect(),
    )
}

async fn diagnostic_like_work(item: usize, payload: Arc<Vec<u64>>) {
    let mut acc = item as u64;
    for round in 0..32u64 {
        for value in payload.iter() {
            acc = acc.rotate_left(7) ^ value.wrapping_add(round);
            acc = acc.wrapping_mul(0xBF58_476D_1CE4_E5B9);
        }
    }
    black_box(acc);
    tokio::task::yield_now().await;
}

async fn run_serial_fanout(items: Vec<usize>, payload: Arc<Vec<u64>>) {
    for item in items {
        diagnostic_like_work(item, Arc::clone(&payload)).await;
    }
}

fn bench_diagnostic_fanout(c: &mut Criterion) {
    let rt = runtime();
    let items = (0..FANOUT_ITEMS).collect::<Vec<_>>();
    let payload = diagnostic_payload();

    let mut group = c.benchmark_group("diagnostic_fanout");
    group.sample_size(10);

    group.bench_function("serial_32_diagnostic_like_items", |b| {
        b.iter_batched(
            || items.clone(),
            |items| rt.block_on(run_serial_fanout(items, Arc::clone(&payload))),
            BatchSize::SmallInput,
        )
    });

    group.bench_function("bounded_8_of_32_diagnostic_like_items", |b| {
        b.iter_batched(
            || items.clone(),
            |items| {
                rt.block_on(raven::backend::run_bounded_fanout_for_test(
                    items,
                    FANOUT_LIMIT,
                    {
                        let payload = Arc::clone(&payload);
                        move |item| {
                            let payload = Arc::clone(&payload);
                            async move {
                                diagnostic_like_work(item, payload).await;
                            }
                        }
                    },
                ))
            },
            BatchSize::SmallInput,
        )
    });

    group.finish();
}

criterion_group!(benches, bench_package_cache, bench_diagnostic_fanout);
criterion_main!(benches);
