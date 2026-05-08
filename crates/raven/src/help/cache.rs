//! HTML help cache mirroring the structure of `HelpCache` (LRU 512,
//! negative TTL 300s, libpath-drain). Single-flight de-dup added in a
//! later task.

use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use lru::LruCache;
use std::num::NonZeroUsize;

use super::types::{HelpHtml, HelpHtmlError};

const HTML_HELP_CACHE_MAX_ENTRIES: usize = 512;
const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(300);

type Result_ = Result<HelpHtml, HelpHtmlError>;

#[derive(Clone)]
struct Entry {
    result: Result_,
    cached_at: Instant,
}

pub struct HtmlHelpCache {
    inner: Arc<RwLock<LruCache<String, Entry>>>,
    negative_ttl: Duration,
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
}
