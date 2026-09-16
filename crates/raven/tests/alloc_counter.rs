//! Exercise allocator initialization in isolated processes so recursive
//! allocation or a deadlock fails this test without taking down the test runner.

#[path = "../src/test_utils/alloc_counter.rs"]
mod alloc_counter;

use std::hint::black_box;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[global_allocator]
static ALLOC: alloc_counter::CountingAllocator = alloc_counter::CountingAllocator;

const CHILD_MARKER: &str = "RAVEN_ALLOC_COUNTER_TEST_CHILD";

#[test]
fn initialization_does_not_reenter_allocator() {
    for setting in [None, Some("0"), Some("1")] {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "allocator_child",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(CHILD_MARKER, "1")
            .env_remove("RAVEN_BENCH_ALLOC")
            .stdout(Stdio::null());
        if let Some(setting) = setting {
            command.env("RAVEN_BENCH_ALLOC", setting);
        }
        let mut child = command.spawn().expect("allocator test child should start");
        let deadline = Instant::now() + Duration::from_secs(10);
        let status = loop {
            if let Some(status) = child
                .try_wait()
                .expect("allocator child should be waitable")
            {
                break status;
            }
            if Instant::now() >= deadline {
                child.kill().expect("timed-out allocator child should stop");
                child
                    .wait()
                    .expect("killed allocator child should be reaped");
                panic!("allocator initialization timed out with setting {setting:?}");
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(
            status.success(),
            "allocator child failed with setting {setting:?}: {status}"
        );
    }
}

#[test]
fn allocator_child() {
    if std::env::var_os(CHILD_MARKER).is_none() {
        return;
    }
    let expected_enabled = std::env::var("RAVEN_BENCH_ALLOC").as_deref() == Ok("1");

    // Startup allocations and the environment reads above must not initialize
    // tracking from inside a GlobalAlloc callback.
    assert_eq!(alloc_counter::allocation_count(), 0);
    assert_eq!(alloc_counter::allocated_bytes(), 0);
    assert_eq!(alloc_counter::is_tracking_enabled(), expected_enabled);
    assert_eq!(alloc_counter::is_tracking_enabled(), expected_enabled);

    alloc_counter::reset();
    let allocation = black_box(vec![0_u8; 4096]);
    let allocations = alloc_counter::allocation_count();
    let bytes = alloc_counter::allocated_bytes();
    drop(black_box(allocation));
    let deallocations = alloc_counter::deallocation_count();
    if expected_enabled {
        assert!(allocations >= 1);
        assert!(bytes >= 4096);
        assert!(deallocations >= 1);
    } else {
        assert_eq!((allocations, bytes, deallocations), (0, 0, 0));
    }
    alloc_counter::print_report("allocator_child");
}
