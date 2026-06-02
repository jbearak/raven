//! HTML help cache mirroring the structure of `HelpCache` (LRU 512,
//! negative TTL 300s, libpath-drain), with single-flight de-duplication so
//! concurrent misses for the same `(topic, package)` share one R subprocess
//! call instead of spawning duplicates.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use lru::LruCache;
use std::num::NonZeroUsize;
use tokio::sync::broadcast;

use super::types::{HelpHtml, HelpHtmlError};

const HTML_HELP_CACHE_MAX_ENTRIES: usize = 512;
const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(300);

type Result_ = Result<HelpHtml, HelpHtmlError>;
type ResultShared = Arc<Result_>;

#[derive(Clone)]
struct Entry {
    result: Result_,
    cached_at: Instant,
}

#[derive(Clone)]
pub struct HtmlHelpCache {
    inner: Arc<RwLock<LruCache<String, Entry>>>,
    negative_ttl: Duration,
    /// In-flight fetches keyed by `cache_key(topic, package)`. All concurrent
    /// callers that miss the LRU cache subscribe to the same sender and wait
    /// for the owner to broadcast its result, so only one R subprocess runs
    /// per `(topic, package)` at a time.
    in_flight: Arc<Mutex<HashMap<String, broadcast::Sender<ResultShared>>>>,
    /// Monotonic counter bumped by `drain()`. The Owner snapshots this value
    /// before fetching and skips its post-fetch LRU insert if the counter
    /// has changed — meaning a libpath / package change happened during the
    /// fetch and the rendered HTML is now stale w.r.t. the new corpus.
    /// Without this gate, a pre-drain Owner finishing after `drain()` would
    /// repopulate the freshly-cleared LRU with stale data, and a pre-drain
    /// Owner finishing after a fresh post-drain Owner would overwrite the
    /// fresh entry. Subscribers still receive the broadcast even when the
    /// insert is skipped — they made their request before the drain too.
    generation: Arc<AtomicU64>,
}

fn cache_key(topic: &str, package: Option<&str>) -> String {
    match package {
        Some(p) => format!("{p}\0{topic}"),
        None => topic.to_string(),
    }
}

impl HtmlHelpCache {
    pub fn new() -> Self {
        Self::with_config(HTML_HELP_CACHE_MAX_ENTRIES, NEGATIVE_CACHE_TTL)
    }

    fn with_config(cap: usize, negative_ttl: Duration) -> Self {
        let cap = NonZeroUsize::new(cap).unwrap_or(NonZeroUsize::new(1).unwrap());
        Self {
            inner: Arc::new(RwLock::new(LruCache::new(cap))),
            negative_ttl,
            in_flight: Arc::new(Mutex::new(HashMap::new())),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn get(&self, topic: &str, package: Option<&str>) -> Option<Result_> {
        let key = cache_key(topic, package);
        let guard = self.inner.read().ok()?;
        let entry = guard.peek(&key)?;
        if entry.result.is_ok() {
            return Some(entry.result.clone());
        }
        if entry.cached_at.elapsed() <= self.negative_ttl {
            return Some(entry.result.clone());
        }
        None
    }

    #[cfg(test)]
    pub fn insert(&self, topic: &str, package: Option<&str>, result: Result_) {
        if let Ok(mut guard) = self.inner.write() {
            Self::insert_locked(&mut guard, topic, package, result);
        }
    }

    fn insert_locked(
        guard: &mut LruCache<String, Entry>,
        topic: &str,
        package: Option<&str>,
        result: Result_,
    ) {
        let entry = Entry {
            result: result.clone(),
            cached_at: Instant::now(),
        };
        guard.push(cache_key(topic, package), entry.clone());
        if let Ok(ref h) = result {
            let canon = cache_key(&h.topic, Some(&h.package));
            guard.push(canon, entry);
        }
    }

    fn insert_if_generation_current(
        &self,
        topic: &str,
        package: Option<&str>,
        result: Result_,
        expected_generation: u64,
    ) -> bool {
        if let Ok(mut guard) = self.inner.write() {
            if self.generation.load(Ordering::SeqCst) == expected_generation {
                Self::insert_locked(&mut guard, topic, package, result);
                return true;
            }
        }
        false
    }

    /// Return a cached result if one exists, otherwise call `fetch` exactly once
    /// even when multiple async callers concurrently miss the same key.
    ///
    /// Concurrent callers for the same `(topic, package)` subscribe to a shared
    /// `broadcast` channel and await the single owner's result. The owner caches
    /// the result (if the error classification deems it cacheable) and broadcasts
    /// to all subscribers before returning.
    ///
    /// If the owner is dropped or panics before broadcasting, subscribers receive
    /// `RecvError::Closed`, which is mapped to
    /// `HelpHtmlError::RenderFailed { message: "subprocess task aborted" }`.
    pub async fn get_or_fetch<F, Fut>(
        &self,
        topic: &str,
        package: Option<&str>,
        fetch: F,
    ) -> Result_
    where
        F: FnOnce(String, Option<String>) -> Fut + Send + 'static,
        Fut: Future<Output = Result_> + Send + 'static,
    {
        // 1) Fast path: cache hit.
        if let Some(hit) = self.get(topic, package) {
            return hit;
        }

        let key = cache_key(topic, package);
        // Snapshot the generation BEFORE the in_flight probe so that any
        // `drain()` ordered after this point will be observed at insert time
        // and force-skip our LRU write. A pre-drain snapshot can never be
        // larger than the post-drain value, so a missed comparison can only
        // err on the side of skipping (= safe).
        let gen_at_start = self.generation.load(Ordering::SeqCst);

        // 2) In-flight probe / register.
        enum Role {
            Owner(broadcast::Sender<ResultShared>),
            Subscriber(broadcast::Receiver<ResultShared>),
        }
        let role = {
            let mut map = self.in_flight.lock().expect("in_flight lock");
            match map.get(&key) {
                Some(sender) => Role::Subscriber(sender.subscribe()),
                None => {
                    // capacity 1: the owner sends exactly one value.
                    let (tx, _rx0) = broadcast::channel(1);
                    map.insert(key.clone(), tx.clone());
                    Role::Owner(tx)
                }
            }
        };

        match role {
            // 3a) Subscriber: wait for the owner's result.
            Role::Subscriber(mut rx) => match rx.recv().await {
                Ok(shared) => (*shared).clone(),
                Err(_closed) => Err(HelpHtmlError::RenderFailed {
                    message: "subprocess task aborted".into(),
                }),
            },

            // 3b) Owner: run the fetch, cache if appropriate, broadcast.
            Role::Owner(sender) => {
                let result = fetch(topic.to_string(), package.map(str::to_string)).await;

                // 4) Cache if the result is worth keeping AND a `drain()` did
                //    not fire while we were fetching. The generation check is
                //    performed while holding the LRU write lock, so it is
                //    ordered with `drain()`'s clear: either this insert happens
                //    before the clear, or it observes the new generation and
                //    skips. Subscribers still receive the broadcast below —
                //    they issued their request before the drain too.
                let cacheable = match &result {
                    Ok(_) => true,
                    Err(e) => e.is_cacheable(),
                };
                if cacheable {
                    self.insert_if_generation_current(topic, package, result.clone(), gen_at_start);
                }

                // 5) Remove in-flight entry, then broadcast to waiting subscribers.
                //
                // Identity-check before removing: `drain()` may have cleared
                // the map mid-fetch, after which a new caller becomes a fresh
                // Owner and inserts its own sender. Removing unconditionally
                // by key would evict that new sender, leaving subsequent
                // callers without an entry to subscribe to and degrading the
                // single-flight guarantee until the new Owner finishes.
                {
                    let mut map = self.in_flight.lock().expect("in_flight lock");
                    if let Some(current) = map.get(&key) {
                        if current.same_channel(&sender) {
                            map.remove(&key);
                        }
                    }
                }
                let shared = Arc::new(result.clone());
                let _ = sender.send(shared);

                result
            }
        }
    }

    /// Clear cached entries.
    ///
    /// Called when libpath changes invalidate the help corpus (package install,
    /// uninstall, or upgrade). Drops in-flight entries too — mirroring
    /// `HelpCache::drain` — so a freshly-arriving caller starts a new fetch
    /// instead of subscribing to (and trusting) a result that began before the
    /// libpath changed.
    ///
    /// Bumps `generation` BEFORE clearing. Owners compare their start
    /// generation while holding the same LRU write lock used here, so a
    /// pre-drain result can only be inserted before this clear or skipped
    /// after it; it cannot repopulate the LRU after the clear.
    pub fn drain(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut guard) = self.inner.write() {
            guard.clear();
        }
        if let Ok(mut guard) = self.in_flight.lock() {
            guard.clear();
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner.read().map(|g| g.len()).unwrap_or(0)
    }

    #[cfg(test)]
    fn with_max_entries_and_ttl(cap: usize, negative_ttl: Duration) -> Self {
        Self::with_config(cap, negative_ttl)
    }
}

impl Default for HtmlHelpCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn ok_help(topic: &str, pkg: &str) -> HelpHtml {
        HelpHtml {
            topic: topic.into(),
            package: pkg.into(),
            title: "title".into(),
            html: "<p>x</p>".into(),
            help_dir: PathBuf::from("/lib").join(pkg).join("help"),
            lib_paths: vec![PathBuf::from("/lib")],
        }
    }

    #[test]
    fn empty_cache_misses() {
        let c = HtmlHelpCache::new();
        assert!(c.get("mean", Some("base")).is_none());
    }

    #[test]
    fn positive_hit() {
        let c = HtmlHelpCache::new();
        c.insert("mean", Some("base"), Ok(ok_help("mean", "base")));
        assert!(matches!(c.get("mean", Some("base")), Some(Ok(_))));
    }

    #[test]
    fn negative_entry_returned_when_fresh() {
        let c = HtmlHelpCache::with_max_entries_and_ttl(10, Duration::from_secs(60));
        c.insert("nope", Some("base"), Err(HelpHtmlError::NotFound));
        let got = c.get("nope", Some("base"));
        assert!(matches!(got, Some(Err(HelpHtmlError::NotFound))));
    }

    #[test]
    fn negative_entry_expires() {
        let c = HtmlHelpCache::with_max_entries_and_ttl(10, Duration::from_millis(20));
        c.insert("nope", Some("base"), Err(HelpHtmlError::NotFound));
        std::thread::sleep(Duration::from_millis(30));
        assert!(c.get("nope", Some("base")).is_none());
    }

    #[test]
    fn lru_evicts_oldest() {
        let c = HtmlHelpCache::with_max_entries_and_ttl(2, Duration::from_secs(60));
        c.insert("a", Some("p"), Ok(ok_help("a", "p")));
        c.insert("b", Some("p"), Ok(ok_help("b", "p")));
        c.insert("c", Some("p"), Ok(ok_help("c", "p")));
        assert!(c.len() <= 2);
    }

    #[test]
    fn drain_clears() {
        let c = HtmlHelpCache::new();
        c.insert("mean", Some("base"), Ok(ok_help("mean", "base")));
        c.drain();
        assert_eq!(c.len(), 0);
    }

    #[test]
    fn canonical_key_dual_write() {
        let c = HtmlHelpCache::new();
        let h = ok_help("filter", "dplyr");
        c.insert("filter.tbl_df", Some("dplyr"), Ok(h.clone()));
        assert!(c.get("filter.tbl_df", Some("dplyr")).is_some());
        assert!(c.get("filter", Some("dplyr")).is_some());
    }

    #[tokio::test]
    async fn drain_during_fetch_skips_stale_lru_insert() {
        // Regression: an Owner that started fetching BEFORE `drain()` must
        // not write its result back into the freshly-cleared LRU. Otherwise
        // the next caller would hit a stale entry that reflects a pre-drain
        // libpath / package state.
        use std::sync::atomic::{AtomicUsize, Ordering as StdOrdering};
        use tokio::sync::Notify;

        let c = Arc::new(HtmlHelpCache::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let owner_started = Arc::new(Notify::new());
        let owner_unblock = Arc::new(Notify::new());

        // Owner: begins, signals it has registered, then waits to be unblocked.
        let c1 = c.clone();
        let calls1 = calls.clone();
        let started = owner_started.clone();
        let unblock = owner_unblock.clone();
        let owner = tokio::spawn(async move {
            c1.get_or_fetch("filter", Some("dplyr"), move |_t, _p| {
                let calls = calls1.clone();
                let started = started.clone();
                let unblock = unblock.clone();
                async move {
                    calls.fetch_add(1, StdOrdering::SeqCst);
                    started.notify_one();
                    unblock.notified().await;
                    Ok::<_, HelpHtmlError>(ok_help("filter", "dplyr"))
                }
            })
            .await
        });

        // Wait until the Owner has registered its in_flight sender.
        owner_started.notified().await;

        // Drain mid-flight: bumps generation, clears LRU and in_flight.
        c.drain();

        // Release the Owner — its post-fetch insert must be skipped.
        owner_unblock.notify_one();
        let _ = owner.await.unwrap();

        // The LRU must still be empty: the Owner's pre-drain result is stale
        // and must not repopulate the cache.
        assert!(
            c.get("filter", Some("dplyr")).is_none(),
            "pre-drain Owner must not repopulate the LRU after drain()"
        );

        // A subsequent caller must trigger a fresh fetch (call counter
        // increments to 2 — Owner 1 pre-drain and a new Owner 2).
        let calls2 = calls.clone();
        let res2 = c
            .get_or_fetch("filter", Some("dplyr"), move |_t, _p| {
                let calls = calls2.clone();
                async move {
                    calls.fetch_add(1, StdOrdering::SeqCst);
                    Ok::<_, HelpHtmlError>(ok_help("filter", "dplyr"))
                }
            })
            .await;
        assert!(res2.is_ok());
        assert_eq!(
            calls.load(StdOrdering::SeqCst),
            2,
            "second caller must run a fresh fetch — Owner 1's stale result must not have populated the LRU"
        );

        // Now the LRU should hold Owner 2's fresh result.
        assert!(c.get("filter", Some("dplyr")).is_some());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn drain_generation_check_is_atomic_with_lru_insert() {
        // Regression: checking `generation` before acquiring the LRU write
        // lock still lets a drain clear the cache between the check and the
        // write. This pins the interleaving by holding the LRU lock while the
        // Owner completes its fetch, then simulating drain's generation bump
        // and clear before allowing the Owner's insert path to continue.
        use std::sync::atomic::{AtomicBool, Ordering as StdOrdering};
        use tokio::sync::Notify;

        let c = Arc::new(HtmlHelpCache::new());
        let owner_started = Arc::new(Notify::new());
        let owner_unblock = Arc::new(Notify::new());
        let fetch_returned = Arc::new(AtomicBool::new(false));

        let c1 = c.clone();
        let started = owner_started.clone();
        let unblock = owner_unblock.clone();
        let returned = fetch_returned.clone();
        let owner = tokio::spawn(async move {
            c1.get_or_fetch("filter", Some("dplyr"), move |_t, _p| {
                let started = started.clone();
                let unblock = unblock.clone();
                let returned = returned.clone();
                async move {
                    started.notify_one();
                    unblock.notified().await;
                    returned.store(true, StdOrdering::SeqCst);
                    Ok::<_, HelpHtmlError>(ok_help("filter", "dplyr"))
                }
            })
            .await
        });

        owner_started.notified().await;

        let mut lru_guard = c.inner.write().expect("LRU write lock");
        owner_unblock.notify_one();
        while !fetch_returned.load(StdOrdering::SeqCst) {
            std::thread::sleep(Duration::from_millis(1));
        }
        std::thread::sleep(Duration::from_millis(50));

        // Simulate the ordering inside `drain()` after the Owner's fetch has
        // returned but before its LRU write can acquire the lock.
        c.generation.fetch_add(1, Ordering::SeqCst);
        lru_guard.clear();
        drop(lru_guard);

        let _ = owner.await.unwrap();
        assert!(
            c.get("filter", Some("dplyr")).is_none(),
            "Owner must not repopulate the LRU after a drain generation bump and clear"
        );
    }

    #[tokio::test]
    async fn owner_returning_uncacheable_error_does_not_poison_in_flight() {
        // Regression: if the Owner returns a non-cacheable error (e.g. the
        // outer `tokio::time::timeout` mapped to `HelpHtmlError::Timeout`),
        // the Owner branch must still remove the `in_flight` entry and
        // broadcast so subsequent callers start a fresh fetch instead of
        // subscribing to a sender that no surviving clone will ever fire.
        use std::sync::atomic::{AtomicUsize, Ordering};

        let c = Arc::new(HtmlHelpCache::new());
        let calls = Arc::new(AtomicUsize::new(0));

        let calls1 = calls.clone();
        let res1 = c
            .get_or_fetch("filter", Some("dplyr"), move |_t, _p| {
                let calls = calls1.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    // Mirror what the production fetch closure returns when
                    // its inner `tokio::time::timeout` fires: a non-cacheable
                    // `Timeout` error.
                    Err::<HelpHtml, _>(HelpHtmlError::Timeout)
                }
            })
            .await;
        assert!(matches!(res1, Err(HelpHtmlError::Timeout)));

        // After the Owner returned, in_flight must be empty and the LRU must
        // not have cached the Timeout (it's classified as non-cacheable).
        assert!(
            c.in_flight.lock().unwrap().is_empty(),
            "in_flight must be cleaned up after Err(Timeout)"
        );
        assert!(
            c.get("filter", Some("dplyr")).is_none(),
            "Timeout must not be LRU-cached"
        );

        // A second caller for the same key must trigger a fresh fetch (not
        // hang on a subscriber waiting for a sender that won't ever fire).
        let calls2 = calls.clone();
        let res2 = c
            .get_or_fetch("filter", Some("dplyr"), move |_t, _p| {
                let calls = calls2.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok::<_, HelpHtmlError>(ok_help("filter", "dplyr"))
                }
            })
            .await;
        assert!(res2.is_ok());
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "second caller must run a fresh fetch — Owner cleanup must have removed the in_flight entry"
        );
    }

    #[tokio::test]
    async fn drain_during_inflight_does_not_evict_new_owner() {
        // Regression: when `drain()` ran mid-fetch, the original Owner's
        // unconditional `map.remove(&key)` would also evict the next Owner's
        // sender, breaking single-flight dedup until that next Owner finished.
        // The fix gates the removal on `Sender::same_channel`.
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::sync::Notify;

        let c = Arc::new(HtmlHelpCache::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let owner1_started = Arc::new(Notify::new());
        let owner1_unblock = Arc::new(Notify::new());

        // Owner 1: blocks until we explicitly let it finish, so we can drain
        // and start Owner 2 while Owner 1 is still in-flight.
        let c1 = c.clone();
        let calls1 = calls.clone();
        let started1 = owner1_started.clone();
        let unblock1 = owner1_unblock.clone();
        let owner1 = tokio::spawn(async move {
            c1.get_or_fetch("filter", Some("dplyr"), move |_t, _p| {
                let calls = calls1.clone();
                let started = started1.clone();
                let unblock = unblock1.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    started.notify_one();
                    unblock.notified().await;
                    Ok::<_, HelpHtmlError>(ok_help("filter", "dplyr"))
                }
            })
            .await
        });

        // Wait until Owner 1's fetch has registered its sender in the map.
        owner1_started.notified().await;

        // Drain (libpath change): clears LRU and in_flight.
        c.drain();

        // Owner 2: now becomes a fresh Owner for the same key.
        let c2 = c.clone();
        let calls2 = calls.clone();
        let owner2 = tokio::spawn(async move {
            c2.get_or_fetch("filter", Some("dplyr"), move |_t, _p| {
                let calls = calls2.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    Ok::<_, HelpHtmlError>(ok_help("filter", "dplyr"))
                }
            })
            .await
        });

        // Yield to let Owner 2 register its sender.
        tokio::time::sleep(Duration::from_millis(10)).await;

        // A late Subscriber for the same key: must subscribe to Owner 2 (not
        // become a third Owner, which would happen if Owner 1's eventual
        // removal evicted Owner 2's sender).
        let c3 = c.clone();
        let calls3 = calls.clone();
        let subscriber = tokio::spawn(async move {
            c3.get_or_fetch("filter", Some("dplyr"), move |_t, _p| {
                let calls = calls3.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok::<_, HelpHtmlError>(ok_help("filter", "dplyr"))
                }
            })
            .await
        });

        // Now release Owner 1 — its post-fetch removal must NOT evict Owner 2.
        owner1_unblock.notify_one();

        let _ = owner1.await.unwrap();
        let _ = owner2.await.unwrap();
        let _ = subscriber.await.unwrap();

        // Two fetches total: Owner 1 (pre-drain) and Owner 2 (post-drain).
        // The subscriber must have ridden Owner 2's broadcast, not become a
        // third Owner.
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "expected exactly 2 fetches (Owner 1 + Owner 2); subscriber must not become a 3rd Owner"
        );
    }

    #[tokio::test]
    async fn single_flight_dedups_concurrent_misses() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let c = Arc::new(HtmlHelpCache::new());
        let calls = Arc::new(AtomicUsize::new(0));

        let mut handles = Vec::new();
        for _ in 0..5 {
            let c = c.clone();
            let calls = calls.clone();
            handles.push(tokio::spawn(async move {
                c.get_or_fetch("filter", Some("dplyr"), move |_t, _p| {
                    let calls = calls.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        Ok::<_, HelpHtmlError>(HelpHtml {
                            topic: "filter".into(),
                            package: "dplyr".into(),
                            title: "x".into(),
                            html: "x".into(),
                            help_dir: PathBuf::from("/lib/dplyr/help"),
                            lib_paths: vec![PathBuf::from("/lib")],
                        })
                    }
                })
                .await
            }));
        }
        for h in handles {
            let _ = h.await.unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
