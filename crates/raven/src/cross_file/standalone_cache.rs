//
// cross_file/standalone_cache.rs
//
// Persistent (cross-snapshot) cache of a `# raven: standalone` callee's
// isolated EOF scope (issue #483 / WI2b).
//
// Background. A `# raven: standalone` file C is resolved in isolation: its own
// backward parent-prefix walk is skipped (WI2a "part 1"), and when it is
// resolved as a caller's forward child it now receives canonical,
// caller-independent inputs — empty packages, no `data()` provider, its own
// `PathContext` (part 2, this issue). So C's isolated EOF scope is a pure
// function of its **contributing set** plus the traversal config — and that set
// does NOT depend on which file sourced C. The contributing set is the forward
// `source()` closure of C, PLUS the backward parents of any non-standalone
// closure member (a non-standalone member runs its own parent-prefix walk, so
// e.g. a file that `library()`s a package and also `source()`s the member leaks
// that package into C's scope), transitively. Crucially it never follows the
// backward edges out of a standalone file (C's own callers are excluded by part
// 1 / part 2), which is what keeps the set — and thus the scope — independent of
// who sourced C, and so cacheable globally keyed by C's URI. The cache key's
// `closure_interface_fingerprint` is hashed over this whole contributing set
// (see `standalone_closure_fingerprint_and_members` in `scope.rs`), so an edit
// to ANY contributing file invalidates the entry.
//
// What this buys. On a hub-heavy workspace (`~/repos/worldwide`, ~84 files
// `source("bootstrap.r")`), resolving the standalone hub's isolated scope is
// otherwise repeated (a) once per caller within a diagnostic pass, (b) once per
// dependent on the ×84 revalidation fan-out when the hub is edited, and (c)
// once per per-file snapshot of `raven check .`. Caching it across snapshots
// collapses all of those to a single compute + cheap clones.
//
// Soundness / byte-identity. A cache HIT must return EXACTLY what the
// un-memoized resolver would. This mirrors the per-query `ForwardChildMemo`
// (`scope.rs`) exactly:
//   * only **truncation-free** scopes (`depth_exceeded.is_empty()`) are stored,
//     and never one produced under cancellation;
//   * a stored scope computed at `compute_depth` is reused for a reach at
//     `reach_depth` only when `reach_depth <= compute_depth` — a truncation-free
//     scope is the full closure, and a shallower-or-equal reach has at least as
//     much depth budget, so it resolves the identical full subtree; the deepest
//     `compute_depth` seen is kept to maximize reuse.
// The cache is consulted only in acyclic graphs (a cycle makes the scope
// visited-dependent — the same guard `ForwardChildMemo` uses), and only at full
// EOF (`MAX,MAX`) resolutions of a standalone file at `current_depth >= 1` (so
// the depth-0 `base_exports` injection, which only the own-root query receives,
// never enters a cached scope).
//
// Caller-independence is enforced, not assumed. The only resolver input that can
// make C's "isolated" scope depend on its caller is the shared `visited` map (the
// caller's forward path): a contributing file already in `visited` is truncated by
// the revisit guard. So the EOF hook refuses to cache when ANY member of the FULL
// contributing set (forward closure PLUS backward parents of non-standalone
// members) is in `visited` — see `standalone_closure_fingerprint_and_members` in
// `scope.rs`, which returns that set and documents both truncation channels.
//
// What the key deliberately omits. The callee's effective `PathContext` is NOT in
// the key: it is caller-independent (`PathContext::from_metadata(C)`, no inherited
// working directory — part 2), the resolver resolves forward children from graph
// edges (never the `path_ctx` fallback, which the always-present edges shadow), and
// any `# raven: cd`/workspace change that redirects a `source()` bumps
// `edge_revision`. (Tripwire: if the inline `path_ctx` fallback in `scope.rs` STEP 2
// ever becomes authoritative over graph edges, add a `path_ctx` fingerprint to the
// key, mirroring `ForwardChildKey::path_fp`.)
//
// Locking discipline. The cache is owned by `WorldState` behind an `Arc`. Per
// CLAUDE.md, the diagnostics snapshot clones the `Arc` handle (and reads
// `edge_revision` / `package_config_generation`) under the `WorldState` read
// lock, then drops that guard before any lookup/miss-compute. The cache's own
// `RwLock` is independent of the `WorldState` lock and mirrors `subgraph_cache`:
// read locks `peek()` (no LRU promotion), write locks `push()`.

use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::RwLock;
use std::sync::atomic::{AtomicU64, Ordering};

use lru::LruCache;
use tower_lsp::lsp_types::Url;

use super::config::BackwardDependencyMode;
use super::scope::ScopeAtPosition;

/// Default LRU capacity. One slot per standalone callee × distinct
/// fingerprint/config; a few thousand covers a large workspace with headroom.
const DEFAULT_STANDALONE_SCOPE_CACHE_CAPACITY: usize = 4096;

/// Whether the WI2b standalone-scope cache is disabled via the
/// `RAVEN_DISABLE_STANDALONE_CACHE` environment variable (set to any value).
/// Read once. This exists so `raven check .` can be run cache-on vs cache-off
/// from a single binary to verify a cache HIT is byte-identical to the
/// un-memoized resolution (issue #483 acceptance gate). When disabled, the
/// diagnostics snapshot supplies `None` for the cache context, so the EOF hook
/// never fires and resolution is exactly the pre-WI2b behavior.
pub fn standalone_cache_disabled() -> bool {
    static DISABLED: OnceLock<bool> = OnceLock::new();
    *DISABLED.get_or_init(|| std::env::var_os("RAVEN_DISABLE_STANDALONE_CACHE").is_some())
}

/// Per-snapshot handle to the persistent cache plus the key components that are
/// captured from `WorldState` under its read lock (the snapshot's cloned graph
/// resets its own `edge_revision`, so the *real* graph's value must be carried
/// in here). The remaining key components (closure fingerprint, config scalars)
/// are computed at resolution time from the resolver's own inputs.
#[derive(Clone)]
pub struct StandaloneCacheCtx {
    pub cache: Arc<StandaloneScopeCache>,
    /// Global `edge_revision` of the real `WorldState` dependency graph,
    /// pinning forward-closure membership and call-site positions.
    pub edge_revision: u64,
    /// Coarse counter bumped on package-library re-init (defensive; the
    /// depth-≥1 cached scope is independent of `base_exports`/package content,
    /// but this guards against any package-state input the analysis missed).
    pub package_config_generation: u64,
}

impl std::fmt::Debug for StandaloneCacheCtx {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StandaloneCacheCtx")
            .field("edge_revision", &self.edge_revision)
            .field("package_config_generation", &self.package_config_generation)
            .finish_non_exhaustive()
    }
}

/// Key for a standalone callee's cached isolated EOF scope.
///
/// `max_chain_depth` is in the key (not folded into the `compute_depth` reuse
/// rule) because a `maxChainDepth` change makes the same reach truncate
/// differently — a scope verified truncation-free under depth 64 is not
/// necessarily truncation-free under depth 3. `hoist_globals` /
/// `backward_dep_mode` change how the closure's (non-standalone) members resolve
/// their own walks, so they are in the key too.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct StandaloneScopeKey {
    pub callee_uri: Url,
    pub edge_revision: u64,
    pub closure_interface_fingerprint: u64,
    pub max_chain_depth: usize,
    pub hoist_globals: bool,
    pub backward_dep_mode: BackwardDependencyMode,
    pub package_config_generation: u64,
}

/// Cross-snapshot cache of standalone callees' isolated EOF scopes.
pub struct StandaloneScopeCache {
    entries: RwLock<LruCache<StandaloneScopeKey, (Arc<ScopeAtPosition>, usize)>>,
    hits: AtomicU64,
    misses: AtomicU64,
}

impl std::fmt::Debug for StandaloneScopeCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StandaloneScopeCache")
            .field("hits", &self.hits.load(Ordering::Relaxed))
            .field("misses", &self.misses.load(Ordering::Relaxed))
            .finish_non_exhaustive()
    }
}

impl Default for StandaloneScopeCache {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_STANDALONE_SCOPE_CACHE_CAPACITY)
    }
}

impl StandaloneScopeCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_capacity(cap: usize) -> Self {
        let cap = super::cache::non_zero_or(cap, DEFAULT_STANDALONE_SCOPE_CACHE_CAPACITY);
        Self {
            entries: RwLock::new(LruCache::new(cap)),
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
        }
    }

    /// Look up a cached isolated scope usable for a reach at `reach_depth`.
    ///
    /// Returns the scope only when a stored entry exists whose `compute_depth`
    /// is `>= reach_depth` (so the shallower-or-equal reach resolves the
    /// identical full closure). Uses `peek()` (no LRU promotion) so reads stay
    /// concurrent. Records a hit or a miss for diagnostics/tests.
    pub fn get(
        &self,
        key: &StandaloneScopeKey,
        reach_depth: usize,
    ) -> Option<Arc<ScopeAtPosition>> {
        let usable = self.entries.read().ok().and_then(|guard| {
            guard
                .peek(key)
                .filter(|(_, compute_depth)| reach_depth <= *compute_depth)
                .map(|(scope, _)| Arc::clone(scope))
        });
        if usable.is_some() {
            self.hits.fetch_add(1, Ordering::Relaxed);
        } else {
            self.misses.fetch_add(1, Ordering::Relaxed);
        }
        usable
    }

    /// Store a truncation-free isolated scope computed at `compute_depth`.
    ///
    /// Keeps the entry with the **largest** `compute_depth` seen for a key (a
    /// deeper truncation-free compute serves strictly more reaches, and the
    /// scope value is identical for any truncation-free compute), so a shallower
    /// recompute never displaces a more broadly-reusable entry.
    pub fn store(
        &self,
        key: StandaloneScopeKey,
        scope: Arc<ScopeAtPosition>,
        compute_depth: usize,
    ) {
        if let Ok(mut guard) = self.entries.write() {
            let already_better = guard
                .peek(&key)
                .is_some_and(|(_, existing_depth)| *existing_depth >= compute_depth);
            if !already_better {
                guard.push(key, (scope, compute_depth));
            }
        }
    }

    /// Cache hits served since construction. For tests/diagnostics.
    pub fn hits(&self) -> u64 {
        self.hits.load(Ordering::Relaxed)
    }

    /// Cache misses (lookup with no usable entry) since construction.
    pub fn misses(&self) -> u64 {
        self.misses.load(Ordering::Relaxed)
    }

    /// Number of entries currently stored. For tests.
    pub fn len(&self) -> usize {
        self.entries.read().map(|g| g.len()).unwrap_or(0)
    }

    /// Whether the cache holds no entries. For tests.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(uri: &str, fp: u64) -> StandaloneScopeKey {
        StandaloneScopeKey {
            callee_uri: Url::parse(uri).unwrap(),
            edge_revision: 1,
            closure_interface_fingerprint: fp,
            max_chain_depth: 64,
            hoist_globals: false,
            backward_dep_mode: BackwardDependencyMode::Auto,
            package_config_generation: 0,
        }
    }

    fn scope() -> Arc<ScopeAtPosition> {
        Arc::new(ScopeAtPosition::default())
    }

    #[test]
    fn hit_only_when_reach_depth_within_compute_depth() {
        let cache = StandaloneScopeCache::new();
        let k = key("file:///c.r", 7);
        cache.store(k.clone(), scope(), 2);
        // reach 0,1,2 <= compute_depth 2 -> hit
        assert!(cache.get(&k, 0).is_some());
        assert!(cache.get(&k, 2).is_some());
        // reach 3 > 2 -> miss (the deeper reach could truncate)
        assert!(cache.get(&k, 3).is_none());
    }

    #[test]
    fn store_keeps_max_compute_depth() {
        let cache = StandaloneScopeCache::new();
        let k = key("file:///c.r", 7);
        cache.store(k.clone(), scope(), 3);
        // A shallower recompute must not displace the deeper entry.
        cache.store(k.clone(), scope(), 1);
        assert!(cache.get(&k, 3).is_some(), "deeper entry must be retained");
    }

    #[test]
    fn distinct_fingerprints_do_not_collide() {
        let cache = StandaloneScopeCache::new();
        let k1 = key("file:///c.r", 7);
        let k2 = key("file:///c.r", 8);
        cache.store(k1.clone(), scope(), 5);
        assert!(
            cache.get(&k2, 0).is_none(),
            "different fingerprint must miss"
        );
        assert!(cache.get(&k1, 0).is_some());
    }
}
