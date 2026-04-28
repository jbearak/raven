//
// cross_file/cache.rs
//
// Caching structures with interior mutability for cross-file awareness
//

use std::collections::HashSet;
use std::num::NonZeroUsize;
use std::sync::RwLock;

use lru::LruCache;
use tower_lsp::lsp_types::Url;

use super::types::CrossFileMetadata;

/// Convert a `usize` to `NonZeroUsize`, falling back to `default` if zero.
pub(crate) fn non_zero_or(value: usize, default: usize) -> NonZeroUsize {
    NonZeroUsize::new(value).unwrap_or(NonZeroUsize::new(default).unwrap())
}

/// Insert `(uri, entry)` into a URI-keyed `LruCache` while honoring a pin set.
///
/// Behavior:
/// - If the URI already exists in the cache, value is replaced in place via
///   `lru::push` — no eviction occurs and the pin set is not consulted.
///   This keeps freshness updates and disk-driven replacement working for
///   pinned URIs.
/// - Otherwise, when at capacity, the LRU non-pinned entry is popped to
///   make room. If every in-cache URI is pinned, the cache is resized to
///   `len() + 1` rather than evicting a reachable neighbor.
///
/// Lock order: caller holds `guard` (`&mut LruCache`); this function
/// acquires `pinned.read()` and holds the read guard across both the LRU
/// search and the `pop` so a racing `pinned.write()` cannot install a pin
/// on the chosen victim between selection and removal.
///
/// Poison recovery: if `pinned` is poisoned, the pin lookup is skipped
/// and `push` runs unmodified — `lru` may evict a pinned entry, but the
/// lock state is already unreliable so this is acceptable.
pub(crate) fn pin_aware_push<V>(
    guard: &mut LruCache<Url, V>,
    pinned: &RwLock<HashSet<Url>>,
    uri: Url,
    entry: V,
) {
    let already_present = guard.contains(&uri);
    let cap = guard.cap().get();
    if !already_present && guard.len() >= cap {
        if let Ok(p) = pinned.read() {
            let lru_unpinned = guard
                .iter()
                .rev()
                .find(|(k, _)| !p.contains(*k))
                .map(|(k, _)| k.clone());

            if let Some(victim) = lru_unpinned {
                guard.pop(&victim);
            } else {
                let new_cap = NonZeroUsize::new(guard.len() + 1)
                    .expect("len() + 1 is always non-zero");
                guard.resize(new_cap);
            }
        }
        // pinned.read() poisoned: fall through to push() — may evict a
        // pinned entry, but the lock is already in a bad state.
    }
    guard.push(uri, entry);
}

/// Default capacity for the metadata cache
const DEFAULT_METADATA_CACHE_CAPACITY: usize = 1000;

/// Metadata cache with LRU eviction and interior mutability.
///
/// Uses `peek()` for reads (no LRU promotion, works under read lock) and
/// `push()` for writes (promotes/evicts under write lock). This makes eviction
/// "LRU by insertion/update time" which keeps the read path fully concurrent.
pub struct MetadataCache {
    inner: RwLock<LruCache<Url, std::sync::Arc<CrossFileMetadata>>>,
}

impl std::fmt::Debug for MetadataCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MetadataCache").finish_non_exhaustive()
    }
}

impl Default for MetadataCache {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_METADATA_CACHE_CAPACITY)
    }
}

impl MetadataCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_capacity(cap: usize) -> Self {
        let cap = non_zero_or(cap, DEFAULT_METADATA_CACHE_CAPACITY);
        Self {
            inner: RwLock::new(LruCache::new(cap)),
        }
    }

    pub fn get(&self, uri: &Url) -> Option<std::sync::Arc<CrossFileMetadata>> {
        self.inner.read().ok()?.peek(uri).cloned()
    }

    pub fn insert(&self, uri: Url, meta: CrossFileMetadata) {
        if let Ok(mut guard) = self.inner.write() {
            guard.push(uri, std::sync::Arc::new(meta));
        }
    }

    pub fn remove(&self, uri: &Url) {
        if let Ok(mut guard) = self.inner.write() {
            guard.pop(uri);
        }
    }

    /// Invalidate (remove) multiple metadata cache entries at once.
    ///
    /// This is more efficient than calling `remove` multiple times when
    /// invalidating several entries, as it only acquires the write lock once.
    ///
    /// # Arguments
    /// * `uris` - Iterator of URIs whose cache entries should be invalidated
    ///
    /// # Returns
    /// The number of entries that were actually removed from the cache.
    ///
    /// _Requirements: 8.3_
    pub fn invalidate_many<'a>(&self, uris: impl IntoIterator<Item = &'a Url>) -> usize {
        if let Ok(mut guard) = self.inner.write() {
            let mut count = 0;
            for uri in uris {
                if guard.pop(uri).is_some() {
                    count += 1;
                }
            }
            count
        } else {
            0
        }
    }

    /// Resize the cache capacity. If shrinking, LRU entries are evicted.
    pub fn resize(&self, cap: usize) {
        let cap = non_zero_or(cap, DEFAULT_METADATA_CACHE_CAPACITY);
        if let Ok(mut guard) = self.inner.write() {
            guard.resize(cap);
        }
    }
}

/// Result of parent resolution
#[derive(Debug, Clone)]
pub enum ParentResolution {
    /// Single unambiguous parent
    Single {
        parent_uri: Url,
        call_site_line: Option<u32>,
        call_site_column: Option<u32>,
    },
    /// Multiple possible parents - deterministic but ambiguous
    Ambiguous {
        selected_uri: Url,
        selected_line: Option<u32>,
        selected_column: Option<u32>,
        alternatives: Vec<Url>,
    },
    /// No parent found
    None,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_uri(name: &str) -> Url {
        Url::parse(&format!("file:///{}", name)).unwrap()
    }

    #[test]
    fn test_metadata_cache() {
        let cache = MetadataCache::new();
        let uri = test_uri("test.R");
        let meta = CrossFileMetadata::default();

        cache.insert(uri.clone(), meta);
        assert!(cache.get(&uri).is_some());

        cache.remove(&uri);
        assert!(cache.get(&uri).is_none());
    }

    #[test]
    fn test_metadata_cache_lru_eviction() {
        let cache = MetadataCache::with_capacity(3);
        let uri1 = test_uri("a.R");
        let uri2 = test_uri("b.R");
        let uri3 = test_uri("c.R");
        let uri4 = test_uri("d.R");

        cache.insert(uri1.clone(), CrossFileMetadata::default());
        cache.insert(uri2.clone(), CrossFileMetadata::default());
        cache.insert(uri3.clone(), CrossFileMetadata::default());

        // All three should be present
        assert!(cache.get(&uri1).is_some());
        assert!(cache.get(&uri2).is_some());
        assert!(cache.get(&uri3).is_some());

        // Inserting a 4th evicts the LRU (uri1, oldest by insertion time)
        cache.insert(uri4.clone(), CrossFileMetadata::default());
        assert!(cache.get(&uri1).is_none(), "LRU entry should be evicted");
        assert!(cache.get(&uri2).is_some());
        assert!(cache.get(&uri3).is_some());
        assert!(cache.get(&uri4).is_some());
    }

    #[test]
    fn test_metadata_cache_resize() {
        let cache = MetadataCache::with_capacity(5);
        for i in 0..5 {
            cache.insert(test_uri(&format!("{}.R", i)), CrossFileMetadata::default());
        }

        // Shrink to 2 — oldest 3 entries evicted
        cache.resize(2);
        // Only the 2 most recently inserted (3.R, 4.R) should remain
        assert!(cache.get(&test_uri("0.R")).is_none());
        assert!(cache.get(&test_uri("1.R")).is_none());
        assert!(cache.get(&test_uri("2.R")).is_none());
        assert!(cache.get(&test_uri("3.R")).is_some());
        assert!(cache.get(&test_uri("4.R")).is_some());
    }

    #[test]
    fn test_metadata_cache_invalidate_many() {
        let cache = MetadataCache::new();
        let uri1 = test_uri("test1.R");
        let uri2 = test_uri("test2.R");
        let uri3 = test_uri("test3.R");
        let uri4 = test_uri("test4.R"); // Not in cache

        // Insert some entries
        cache.insert(uri1.clone(), CrossFileMetadata::default());
        cache.insert(uri2.clone(), CrossFileMetadata::default());
        cache.insert(uri3.clone(), CrossFileMetadata::default());

        // Verify all are present
        assert!(cache.get(&uri1).is_some());
        assert!(cache.get(&uri2).is_some());
        assert!(cache.get(&uri3).is_some());

        // Invalidate uri1 and uri2 (and uri4 which doesn't exist)
        let uris_to_invalidate = vec![uri1.clone(), uri2.clone(), uri4.clone()];
        let count = cache.invalidate_many(&uris_to_invalidate);

        // Should have invalidated 2 entries (uri1 and uri2, not uri4)
        assert_eq!(count, 2);

        // uri1 and uri2 should be gone
        assert!(cache.get(&uri1).is_none());
        assert!(cache.get(&uri2).is_none());

        // uri3 should still be present
        assert!(cache.get(&uri3).is_some());
    }

    #[test]
    fn test_metadata_cache_invalidate_many_empty() {
        let cache = MetadataCache::new();
        let uri1 = test_uri("test1.R");

        cache.insert(uri1.clone(), CrossFileMetadata::default());

        // Invalidate with empty iterator
        let count = cache.invalidate_many(&Vec::<Url>::new());
        assert_eq!(count, 0);

        // Entry should still be present
        assert!(cache.get(&uri1).is_some());
    }
}
