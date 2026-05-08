//! HTML help cache mirroring the structure of `HelpCache` (LRU 512,
//! negative TTL 300s, libpath-drain), with single-flight de-duplication so
//! concurrent misses for the same `(topic, package)` share one R subprocess
//! call instead of spawning duplicates.

use std::collections::HashMap;
use std::future::Future;
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

pub struct HtmlHelpCache {
    inner: Arc<RwLock<LruCache<String, Entry>>>,
    negative_ttl: Duration,
    /// In-flight fetches keyed by `cache_key(topic, package)`. All concurrent
    /// callers that miss the LRU cache subscribe to the same sender and wait
    /// for the owner to broadcast its result, so only one R subprocess runs
    /// per `(topic, package)` at a time.
    in_flight: Arc<Mutex<HashMap<String, broadcast::Sender<ResultShared>>>>,
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

    pub fn insert(&self, topic: &str, package: Option<&str>, result: Result_) {
        let entry = Entry {
            result: result.clone(),
            cached_at: Instant::now(),
        };
        if let Ok(mut guard) = self.inner.write() {
            guard.push(cache_key(topic, package), entry.clone());
            if let Ok(ref h) = result {
                let canon = cache_key(&h.topic, Some(&h.package));
                guard.push(canon, entry);
            }
        }
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

                // 4) Cache if the result is worth keeping.
                let cacheable = match &result {
                    Ok(_) => true,
                    Err(e) => e.is_cacheable(),
                };
                if cacheable {
                    self.insert(topic, package, result.clone());
                }

                // 5) Remove in-flight entry, then broadcast to waiting subscribers.
                {
                    let mut map = self.in_flight.lock().expect("in_flight lock");
                    map.remove(&key);
                }
                let shared = Arc::new(result.clone());
                let _ = sender.send(shared);

                result
            }
        }
    }

    pub fn drain(&self) {
        if let Ok(mut guard) = self.inner.write() {
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
