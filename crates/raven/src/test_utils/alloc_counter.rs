// alloc_counter.rs — Global allocator wrapper that counts allocations.
//
// Gated behind the `RAVEN_BENCH_ALLOC=1` environment variable (checked at
// runtime). When the env-var is unset or not `"1"`, the wrapper delegates
// directly to `std::alloc::System` with zero bookkeeping overhead beyond
// the atomic load on the fast path.
//
// # Usage from benchmark binaries
//
// Benchmark crates include this module via `#[path]` and install the
// global allocator at crate root:
//
// ```rust
// #[path = "../src/test_utils/alloc_counter.rs"]
// mod alloc_counter;
//
// #[global_allocator]
// static ALLOC: alloc_counter::CountingAllocator = alloc_counter::CountingAllocator;
// ```
//
// Then, around the code region of interest:
//
// ```rust
// alloc_counter::reset();
// /* … work … */
// let n = alloc_counter::allocation_count();
// println!("allocations: {n}");
// ```
//
// Requirements: 6.2

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/// Total number of `alloc` calls observed since the last `reset()`.
static ALLOC_COUNT: AtomicU64 = AtomicU64::new(0);

/// Total number of `dealloc` calls observed since the last `reset()`.
static DEALLOC_COUNT: AtomicU64 = AtomicU64::new(0);

/// Total bytes requested via `alloc` since the last `reset()`.
static ALLOC_BYTES: AtomicU64 = AtomicU64::new(0);

/// Whether tracking is enabled. Resolved lazily on first allocation.
static ENABLED: AtomicBool = AtomicBool::new(false);

/// Whether we have already checked the environment variable.
static INITIALIZED: AtomicBool = AtomicBool::new(false);

/// Check (once) whether `RAVEN_BENCH_ALLOC=1` is set.
#[inline]
fn is_enabled() -> bool {
    // Fast path: already initialised. Use Acquire to pair with the Release
    // store below, ensuring visibility of the ENABLED store.
    if INITIALIZED.load(Ordering::Acquire) {
        return ENABLED.load(Ordering::Relaxed);
    }
    // Slow path (runs at most once per process).
    let val = std::env::var("RAVEN_BENCH_ALLOC")
        .map(|v| v == "1")
        .unwrap_or(false);
    ENABLED.store(val, Ordering::Relaxed);
    INITIALIZED.store(true, Ordering::Release);
    val
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Reset all counters to zero.
pub fn reset() {
    ALLOC_COUNT.store(0, Ordering::Relaxed);
    DEALLOC_COUNT.store(0, Ordering::Relaxed);
    ALLOC_BYTES.store(0, Ordering::Relaxed);
}

/// Number of `alloc` calls since the last `reset()`.
pub fn allocation_count() -> u64 {
    ALLOC_COUNT.load(Ordering::Relaxed)
}

/// Number of `dealloc` calls since the last `reset()`.
pub fn deallocation_count() -> u64 {
    DEALLOC_COUNT.load(Ordering::Relaxed)
}

/// Total bytes requested via `alloc` since the last `reset()`.
pub fn allocated_bytes() -> u64 {
    ALLOC_BYTES.load(Ordering::Relaxed)
}

/// Returns `true` when allocation tracking is active
/// (`RAVEN_BENCH_ALLOC=1`).
pub fn is_tracking_enabled() -> bool {
    is_enabled()
}

/// Print a summary line to stdout. Intended to be called after a
/// benchmark iteration when `RAVEN_BENCH_ALLOC=1`.
///
/// Output format (easily grep-able):
///   `[alloc] <label>: <N> allocs, <M> deallocs, <B> bytes`
pub fn print_report(label: &str) {
    if !is_enabled() {
        return;
    }
    println!(
        "[alloc] {}: {} allocs, {} deallocs, {} bytes",
        label,
        allocation_count(),
        deallocation_count(),
        allocated_bytes(),
    );
}

// ---------------------------------------------------------------------------
// Global allocator wrapper
// ---------------------------------------------------------------------------

/// A thin wrapper around [`System`] that counts allocations when
/// `RAVEN_BENCH_ALLOC=1` is set.
pub struct CountingAllocator;

unsafe impl GlobalAlloc for CountingAllocator {
    #[inline]
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if is_enabled() {
            ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
            ALLOC_BYTES.fetch_add(layout.size() as u64, Ordering::Relaxed);
        }
        // SAFETY: delegates to the system allocator.
        unsafe { System.alloc(layout) }
    }

    #[inline]
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        if is_enabled() {
            DEALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
        }
        // SAFETY: delegates to the system allocator.
        unsafe { System.dealloc(ptr, layout) }
    }

    #[inline]
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if is_enabled() {
            ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
            ALLOC_BYTES.fetch_add(layout.size() as u64, Ordering::Relaxed);
        }
        // SAFETY: delegates to the system allocator.
        unsafe { System.alloc_zeroed(layout) }
    }

    #[inline]
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // realloc is conceptually dealloc + alloc, but we only count it as
        // one allocation to avoid inflating the count.
        if is_enabled() {
            ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
            DEALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
            ALLOC_BYTES.fetch_add(new_size as u64, Ordering::Relaxed);
        }
        // SAFETY: delegates to the system allocator.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}
