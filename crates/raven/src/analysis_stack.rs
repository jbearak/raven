//! Stack size for the threads that walk R syntax trees (issue #882).
//!
//! Raven's analysis passes are recursive: each level of syntax nesting adds
//! native stack frames. R's grammar makes an operator chain a left-nested
//! tree, so `x1 + x2 + ... + xN`, a long pipeline, or a generated model
//! formula is `N` levels deep. The most expensive pass, the scope artifact
//! walk in `cross_file/scope.rs`, uses about 6.3 KiB of stack per level in a
//! release build and 23 KiB in a debug build (measured on arm64 macOS). On
//! default stacks that overflowed, and aborted the process, at about 330
//! levels on a 2 MiB tokio or rayon thread and about 1300 on an 8 MiB main
//! thread.
//!
//! So every thread that can walk a tree gets [`stack_size`] instead:
//!
//! - the thread that runs the CLI commands and drives the tokio runtime
//!   ([`run_main`]), unless the OS main thread's own stack is already as large;
//! - tokio's worker and blocking threads (`main.rs` passes [`stack_size`] to
//!   the runtime builder);
//! - the global rayon pool ([`run_main`]);
//! - the library-routing derivation thread in `backend.rs`.
//!
//! A new thread that analyses R code must be given [`stack_size`] too. Tests
//! and benches run on default stacks, so a test of deep input has to run the
//! `raven` binary as a subprocess (see `tests/deep_nesting.rs`).
//!
//! The size is a reservation of address space. The kernel commits a stack page
//! only when it is first touched, so ordinary files cost no extra memory.
//! [`stack_size`] shrinks the reservation where address space itself is
//! rationed.
//!
//! # Remaining limit
//!
//! This moves the limit; it does not remove it. At [`ANALYSIS_STACK_SIZE`] a
//! release build handles about 20,000 levels of nesting and then aborts with
//! the same stack-overflow message as before. R itself gives up sooner by
//! default: it stops evaluating a `+` chain at 5000 terms ("evaluation nested
//! too deeply"), a pipeline at about 5000 steps (C stack), and `terms()` on a
//! formula somewhere between 5000 and 20,000 terms.
//!
//! Stack depth was not the only cost of deep nesting. Climbing ancestors with
//! repeated `Node::parent` calls is quadratic in depth; see
//! `parser_pool::ancestors`.

use std::sync::OnceLock;

const MIB: usize = 1024 * 1024;

/// Stack reserved for each analysis thread when address space is not rationed.
///
/// 128 MiB is about 20,000 nesting levels in a release build and 5700 in a
/// debug build, at the per-level costs in the module docs.
pub const ANALYSIS_STACK_SIZE: usize = 128 * MIB;

/// The default stack of a tokio, rayon, or `std` thread: what every analysis
/// thread had before, and the floor for [`stack_size`].
const DEFAULT_THREAD_STACK_SIZE: usize = 2 * MIB;

/// Stack size for a thread that walks R syntax trees.
///
/// [`ANALYSIS_STACK_SIZE`], unless this process may not reserve that much
/// address space for its startup threads; see `stack_size_within`.
pub fn stack_size() -> usize {
    static SIZE: OnceLock<usize> = OnceLock::new();
    *SIZE.get_or_init(|| {
        let cores = std::thread::available_parallelism().map_or(1, usize::from);
        let var = |name| std::env::var(name).ok();
        let rayon = rayon_workers(
            var("RAYON_NUM_THREADS").as_deref(),
            var("RAYON_RS_NUM_CPUS").as_deref(),
            cores,
        );
        let tokio = tokio_workers(var("TOKIO_WORKER_THREADS").as_deref(), cores);
        // Plus the thread `run_main` starts. Saturating: the counts come from
        // the environment, and an absurd one must not overflow the sum.
        let startup_threads = rayon.saturating_add(tokio).saturating_add(1);
        stack_size_within(address_space_limit(), startup_threads)
    })
}

/// How many workers rayon's global pool starts, by rayon's own rule
/// (`ThreadPoolBuilder::get_num_threads`): a positive `RAYON_NUM_THREADS`;
/// one per core when it is `0`; otherwise a positive `RAYON_RS_NUM_CPUS` (the
/// deprecated spelling), else one per core.
fn rayon_workers(num_threads: Option<&str>, legacy_num_cpus: Option<&str>, cores: usize) -> usize {
    let count = |value: Option<&str>| value.and_then(|value| value.parse::<usize>().ok());
    match count(num_threads) {
        Some(0) => cores,
        Some(threads) => threads,
        None => count(legacy_num_cpus)
            .filter(|&threads| threads > 0)
            .unwrap_or(cores),
    }
}

/// How many workers the tokio runtime starts: `TOKIO_WORKER_THREADS` when set,
/// else one per core. Tokio refuses to start on a zero or unparsable value, so
/// what this returns for one does not matter.
fn tokio_workers(worker_threads: Option<&str>, cores: usize) -> usize {
    worker_threads
        .and_then(|value| value.parse().ok())
        .filter(|&threads| threads > 0)
        .unwrap_or(cores)
}

/// [`ANALYSIS_STACK_SIZE`], reduced so that `startup_threads` stacks fit in
/// half of `address_space_limit`, and never below the default thread stack.
///
/// Without this, a 64-core login node with `ulimit -v` set to 8 GiB could not
/// start Raven at all: 129 threads at 128 MiB each is 16 GiB of reservations,
/// and tokio panics when it cannot spawn a worker. Under a limit Raven starts
/// as it always did and simply overflows at a shallower depth.
fn stack_size_within(address_space_limit: Option<u64>, startup_threads: usize) -> usize {
    let Some(limit) = address_space_limit else {
        return ANALYSIS_STACK_SIZE;
    };
    let per_thread = limit / 2 / startup_threads.max(1) as u64;
    let per_thread = usize::try_from(per_thread).unwrap_or(usize::MAX);
    let whole_mib = per_thread - per_thread % MIB;
    whole_mib.clamp(DEFAULT_THREAD_STACK_SIZE, ANALYSIS_STACK_SIZE)
}

/// The most address space this process may reserve, or `None` when unlimited.
///
/// Two things ration it: `RLIMIT_AS` (`ulimit -v`), and Linux strict
/// overcommit (`vm.overcommit_memory = 2`), under which a thread stack counts
/// against the commit limit in full the moment it is mapped. Strict overcommit
/// reports a limit of zero, which keeps the default stack size.
fn address_space_limit() -> Option<u64> {
    #[cfg(target_os = "linux")]
    if std::fs::read_to_string("/proc/sys/vm/overcommit_memory")
        .is_ok_and(|mode| mode.trim() == "2")
    {
        return Some(0);
    }
    #[cfg(unix)]
    if let Some(limit) = soft_limit(Resource::AddressSpace) {
        return (limit != libc::RLIM_INFINITY).then_some(limit);
    }
    None
}

/// The stack the OS gives the process's own main thread (`ulimit -s`), or
/// `None` where that is not known. An unlimited stack reports `u64::MAX`.
fn os_main_thread_stack() -> Option<u64> {
    #[cfg(unix)]
    if let Some(limit) = soft_limit(Resource::Stack) {
        return Some(if limit == libc::RLIM_INFINITY {
            u64::MAX
        } else {
            limit
        });
    }
    None
}

#[cfg(unix)]
enum Resource {
    AddressSpace,
    Stack,
}

/// The soft limit of `resource`, or `None` when the OS will not report it.
#[cfg(unix)]
fn soft_limit(resource: Resource) -> Option<libc::rlim_t> {
    // Chosen here, not passed in, because the constants' type differs by
    // platform (`c_int` on macOS, `c_uint` on GNU/Linux).
    let resource = match resource {
        Resource::AddressSpace => libc::RLIMIT_AS,
        Resource::Stack => libc::RLIMIT_STACK,
    };
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `limit` is a valid, writable `rlimit` for the call to fill.
    let ok = unsafe { libc::getrlimit(resource, &mut limit) } == 0;
    ok.then_some(limit.rlim_cur)
}

/// Whether `main` needs a new thread to get a `size`-byte stack. It does not
/// when the OS main thread's own stack is already that large, which happens
/// when [`stack_size`] had to shrink: a 2 MiB replacement for an 8 MiB main
/// thread would make the CLI overflow sooner than it did before.
fn needs_new_main_thread(size: usize, os_main_thread_stack: Option<u64>) -> bool {
    os_main_thread_stack.is_none_or(|os_stack| os_stack < size as u64)
}

/// Run `main` on a thread with the analysis stack, and give the global rayon
/// pool the same stack size.
///
/// The process's real main thread cannot be resized, so the CLI commands and
/// the tokio runtime run on a thread started here. It is named `main`, so
/// panic messages read as they did. A panic in `main` is re-raised on the
/// calling thread and exits the process the way it always has. Where the real
/// main thread's stack is already at least [`stack_size`], `main` runs on it
/// directly.
///
/// Call this once, before anything uses rayon: the global pool can only be
/// configured before its first use.
pub fn run_main<T: Send + 'static>(
    main: impl FnOnce() -> T + Send + 'static,
) -> std::io::Result<T> {
    let size = stack_size();
    rayon::ThreadPoolBuilder::new()
        .stack_size(size)
        .build_global()
        .map_err(std::io::Error::other)?;
    if !needs_new_main_thread(size, os_main_thread_stack()) {
        return Ok(main());
    }
    let thread = std::thread::Builder::new()
        .name("main".to_string())
        .stack_size(size)
        .spawn(main)?;
    match thread.join() {
        Ok(value) => Ok(value),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn unlimited_address_space_gets_the_full_stack() {
        assert_eq!(stack_size_within(None, 33), ANALYSIS_STACK_SIZE);
    }

    #[test]
    fn generous_limit_gets_the_full_stack() {
        // 33 threads at 128 MiB is about 4 GiB, within half of 64 GiB.
        assert_eq!(stack_size_within(Some(64 * GIB), 33), ANALYSIS_STACK_SIZE);
    }

    #[test]
    fn tight_limit_shrinks_the_stack_to_fit() {
        // Half of 8 GiB over 129 threads is 31.75 MiB each.
        let size = stack_size_within(Some(8 * GIB), 129);
        assert_eq!(size, 31 * MIB);
        assert!(size as u64 * 129 <= 4 * GIB);
    }

    #[test]
    fn stack_never_drops_below_the_default() {
        assert_eq!(
            stack_size_within(Some(GIB / 4), 129),
            DEFAULT_THREAD_STACK_SIZE
        );
        assert_eq!(stack_size_within(Some(0), 33), DEFAULT_THREAD_STACK_SIZE);
        assert_eq!(stack_size_within(Some(GIB), 0), ANALYSIS_STACK_SIZE);
    }

    #[test]
    fn rayon_worker_count_follows_rayons_own_rule() {
        assert_eq!(rayon_workers(None, None, 8), 8);
        assert_eq!(rayon_workers(Some("32"), None, 8), 32);
        assert_eq!(rayon_workers(Some("32"), Some("4"), 8), 32);
        // An explicit zero means one per core, whatever the legacy variable says.
        assert_eq!(rayon_workers(Some("0"), Some("32"), 8), 8);
        // Absent or unparsable falls back to the legacy variable.
        assert_eq!(rayon_workers(None, Some("32"), 8), 32);
        assert_eq!(rayon_workers(Some("many"), Some("32"), 8), 32);
        assert_eq!(rayon_workers(None, Some("0"), 8), 8);
    }

    #[test]
    fn tokio_worker_count_follows_its_override() {
        assert_eq!(tokio_workers(None, 8), 8);
        assert_eq!(tokio_workers(Some("32"), 8), 32);
    }

    /// Eight cores under a 2 GiB limit with 32 rayon workers requested through
    /// either variable: sized for the 41 threads that start, not the 17 a
    /// per-core count predicts.
    #[test]
    fn override_counts_toward_the_address_space_budget() {
        for rayon in [
            rayon_workers(Some("32"), None, 8),
            rayon_workers(None, Some("32"), 8),
        ] {
            let threads = rayon + tokio_workers(None, 8) + 1;
            let size = stack_size_within(Some(2 * GIB), threads);
            assert_eq!(size, 24 * MIB);
            assert!(size as u64 * threads as u64 <= GIB);
        }
    }

    #[test]
    fn main_runs_in_place_when_its_own_stack_is_large_enough() {
        let os_stack = Some(8 * MIB as u64);
        assert!(needs_new_main_thread(ANALYSIS_STACK_SIZE, os_stack));
        // A shrunken replacement must not undercut the real main thread.
        assert!(!needs_new_main_thread(DEFAULT_THREAD_STACK_SIZE, os_stack));
        assert!(!needs_new_main_thread(ANALYSIS_STACK_SIZE, Some(u64::MAX)));
        // Unknown (Windows): its main thread has 1 MiB, so always replace it.
        assert!(needs_new_main_thread(ANALYSIS_STACK_SIZE, None));
    }
}
