// help.rs - Minimal R help system for static LSP
//
// This module calls R as a subprocess to get help documentation.
// It's "static" in that it doesn't embed R, but can still access help.

use std::io::Read;
use std::process::Command;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use lru::LruCache;

/// Maximum number of entries in the help cache. When this limit is reached,
/// the least-recently-used entries are evicted to make room for new ones.
const HELP_CACHE_MAX_ENTRIES: usize = 512;

/// Duration after which negative cache entries (no help found) expire.
/// Positive entries never expire since help text doesn't change during a session.
const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(300);

/// A cached help lookup result, with a timestamp for TTL-based expiry of
/// negative entries.
#[derive(Clone)]
struct CachedHelp {
    content: Option<String>,
    cached_at: Instant,
}

/// Bounded cache for help content. Uses LRU eviction to prevent unbounded
/// memory growth in long-running LSP sessions.
///
/// Keys use composite format: `"package\0topic"` for package-qualified lookups,
/// plain `"topic"` for unqualified lookups. The null-byte separator prevents
/// collisions since R identifiers cannot contain null bytes.
///
/// Negative entries (no help found) expire after a configurable TTL so that
/// transient R failures don't permanently suppress help lookups.
///
/// Uses `peek()` for reads (no LRU promotion, works under read lock) and
/// `push()` for writes (promotes/evicts under write lock).
#[derive(Clone)]
pub struct HelpCache {
    inner: Arc<RwLock<LruCache<String, CachedHelp>>>,
    negative_ttl: Duration,
}

/// Builds a cache key from a topic and optional package.
///
/// Uses `\0` as separator since R identifiers cannot contain null bytes,
/// preventing collisions between e.g. unqualified topic `"a::b"` and
/// package `"a"` + topic `"b"`.
fn cache_key(topic: &str, package: Option<&str>) -> String {
    match package {
        Some(pkg) => format!("{pkg}\0{topic}"),
        None => topic.to_string(),
    }
}

impl HelpCache {
    pub fn new() -> Self {
        Self::with_config(HELP_CACHE_MAX_ENTRIES, NEGATIVE_CACHE_TTL)
    }

    /// Returns cached help content, or `None` on cache miss.
    ///
    /// Returns `Some(None)` for a negative cache hit (topic was looked up but
    /// had no help). Expired negative entries are evicted and treated as cache
    /// misses. Returns `Some(Some(text))` for a positive cache hit.
    pub fn get(&self, topic: &str, package: Option<&str>) -> Option<Option<String>> {
        let key = cache_key(topic, package);

        // Check under read lock (concurrent reads allowed)
        {
            let guard = self.inner.read().ok()?;
            let entry = guard.peek(&key)?;
            if entry.content.is_some() {
                return Some(entry.content.clone());
            }
            // Negative entry — return if still fresh
            if entry.cached_at.elapsed() <= self.negative_ttl {
                return Some(None);
            }
            // Expired — drop read lock, fall through to evict
        }

        // Evict the expired entry under a write lock so it doesn't waste a slot
        if let Ok(mut guard) = self.inner.write() {
            // Re-check: another thread may have refreshed or removed it
            let still_expired = guard
                .peek(&key)
                .map(|e| e.content.is_none() && e.cached_at.elapsed() > self.negative_ttl)
                .unwrap_or(false);
            if still_expired {
                guard.pop(&key);
            }
        }

        None
    }

    pub fn insert(&self, topic: &str, package: Option<&str>, content: Option<String>) {
        let key = cache_key(topic, package);
        let entry = CachedHelp {
            content,
            cached_at: Instant::now(),
        };
        if let Ok(mut guard) = self.inner.write() {
            guard.push(key, entry);
        }
    }

    /// Looks up help text, using the cache to avoid redundant R subprocess calls.
    ///
    /// On cache hit, returns the cached content. On cache miss, calls `get_help()`
    /// to spawn an R subprocess, caches the result (including negative), and returns it.
    ///
    /// **Note:** This method blocks on R subprocess I/O. Callers on an async
    /// runtime should use `tokio::task::spawn_blocking`.
    pub fn get_or_fetch(&self, topic: &str, package: Option<&str>) -> Option<String> {
        if let Some(cached) = self.get(topic, package) {
            return cached;
        }
        let result = get_help(topic, package);
        self.insert(topic, package, result.clone());
        result
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner.read().map(|c| c.len()).unwrap_or(0)
    }

    fn with_config(cap: usize, negative_ttl: Duration) -> Self {
        let cap = crate::cross_file::cache::non_zero_or(cap, HELP_CACHE_MAX_ENTRIES);
        Self {
            inner: Arc::new(RwLock::new(LruCache::new(cap))),
            negative_ttl,
        }
    }

    #[cfg(test)]
    fn with_max_entries(cap: usize) -> Self {
        Self::with_config(cap, NEGATIVE_CACHE_TTL)
    }

    #[cfg(test)]
    fn with_max_entries_and_ttl(cap: usize, negative_ttl: Duration) -> Self {
        Self::with_config(cap, negative_ttl)
    }
}

impl Default for HelpCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Timeout for R help subprocess calls. Prevents hung R processes from
/// blocking threads indefinitely.
const HELP_TIMEOUT: Duration = Duration::from_secs(10);

/// Kill a process by PID. Used by the help subprocess watchdog on timeout.
///
/// On Unix, sends SIGKILL directly. On Windows, delegates to `taskkill /F`.
/// If the process has already exited, the call is harmless on all platforms.
#[cfg(unix)]
fn kill_process_by_pid(pid: u32) {
    match i32::try_from(pid) {
        Ok(pid_i32) => {
            // SAFETY: Sending SIGKILL to a known child PID. If the process
            // already exited, kill() returns ESRCH harmlessly.
            unsafe {
                libc::kill(pid_i32, libc::SIGKILL);
            }
        }
        Err(_) => {
            // PID > i32::MAX would wrap to negative, which kill() interprets
            // as a process group signal — bail rather than risk that.
            log::trace!("get_help: pid {} exceeds i32::MAX, cannot kill", pid);
        }
    }
}

#[cfg(windows)]
fn kill_process_by_pid(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

#[cfg(not(any(unix, windows)))]
fn kill_process_by_pid(_pid: u32) {
    log::trace!("get_help: timeout kill not supported on this platform");
}

/// Fetches help text for an R topic by invoking R and returns the rendered help if available.
///
/// Returns `Some(String)` containing the help text when R executes successfully, the output is not empty,
/// and the output does not contain the phrase "No documentation". Returns `None` otherwise.
///
/// The subprocess is killed after [`HELP_TIMEOUT`] to prevent hung R processes from
/// blocking threads indefinitely.
///
/// # Examples
///
/// ```no_run
/// // Attempt to get help for `mean` from the base package
/// if let Some(text) = rlsp::help::get_help("mean", Some("base")) {
///     assert!(text.contains("Usage:"));
/// }
/// ```
pub fn get_help(topic: &str, package: Option<&str>) -> Option<String> {
    log::trace!("get_help: topic={}, package={:?}", topic, package);

    let r_code = r#"
args <- commandArgs(trailingOnly = TRUE)
topic <- args[1]
pkg <- if (length(args) >= 2 && nzchar(args[2])) args[2] else NULL
txt <- capture.output(
  tools::Rd2txt(
    utils:::.getHelpFile(help(topic, package = (pkg))),
    options = list(underline_titles = FALSE)
  )
)
cat(paste(txt, collapse = "\n"))
"#;

    let mut cmd = Command::new("R");
    cmd.args([
        "--slave",
        "--no-save",
        "--no-restore",
        "-e",
        r_code,
        "--args",
        topic,
    ]);
    if let Some(pkg) = package {
        cmd.arg(pkg);
    }

    // Spawn as child process so we can enforce a timeout.
    // Pipe both stdout (for help text) and stderr (to prevent it polluting
    // the LSP server's stderr stream).
    let mut child = match cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            log::trace!("get_help: subprocess spawn error: {}", e);
            return None;
        }
    };

    let child_pid = child.id();

    // Take pipe handles before spawning threads. Reading pipes in separate
    // threads prevents deadlock when pipe buffers fill before the child exits.
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let stdout_thread = std::thread::spawn(move || -> Vec<u8> {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stdout_pipe {
            if let Err(e) = pipe.read_to_end(&mut buf) {
                log::trace!("get_help: failed to read stdout pipe: {}", e);
            }
        }
        buf
    });
    let stderr_thread = std::thread::spawn(move || -> Vec<u8> {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stderr_pipe {
            if let Err(e) = pipe.read_to_end(&mut buf) {
                log::trace!("get_help: failed to read stderr pipe: {}", e);
            }
        }
        buf
    });

    // Watchdog thread: kills the subprocess after HELP_TIMEOUT if it hasn't
    // exited. An atomic flag prevents killing a recycled PID after the child
    // has already exited naturally.
    let exited = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let exited_clone = exited.clone();
    std::thread::spawn(move || {
        std::thread::sleep(HELP_TIMEOUT);
        if !exited_clone.load(std::sync::atomic::Ordering::SeqCst) {
            log::trace!(
                "get_help: timeout after {:?}, killing pid {}",
                HELP_TIMEOUT,
                child_pid
            );
            kill_process_by_pid(child_pid);
        }
    });

    // Block efficiently via waitpid() instead of polling with try_wait()+sleep().
    let wait_result = child.wait();
    exited.store(true, std::sync::atomic::Ordering::SeqCst);

    let stdout_bytes = stdout_thread.join().unwrap_or_default();
    let stderr_bytes = stderr_thread.join().unwrap_or_default();

    match wait_result {
        Ok(status) => {
            log::trace!(
                "get_help: exit_status={}, stdout_len={}, stderr_len={}",
                status,
                stdout_bytes.len(),
                stderr_bytes.len()
            );
            if !stderr_bytes.is_empty() {
                log::trace!(
                    "get_help: stderr: {}",
                    String::from_utf8_lossy(&stderr_bytes)
                );
            }
            if status.success() {
                let text = String::from_utf8_lossy(&stdout_bytes).to_string();
                if !text.trim().is_empty() && !text.contains("No documentation") {
                    return Some(text);
                }
                log::trace!("get_help: empty or no documentation");
            }
            None
        }
        Err(e) => {
            log::trace!("get_help: wait error: {}", e);
            None
        }
    }
}

/// Extracts the first function signature from R help text.
///
/// Scans the "Usage:" section of R help output and returns the first available
/// signature, preferring a generic signature over an S3 method. Handles
/// multi-line signatures and stops at the next section header (a non-parenthesized
/// line ending with ':').
///
/// # Returns
///
/// `Some(String)` containing the joined signature lines if a signature is found,
/// `None` otherwise.
///
/// # Examples
///
/// ```
/// let help = r#"
/// Arithmetic Mean
///
/// Description:
///     Generic function for the (trimmed) arithmetic mean.
///
/// Usage:
///     mean(x, ...)
///
///     ## Default S3 method:
///     mean(x, trim = 0, na.rm = FALSE, ...)
///
/// Arguments:
///     ...
/// "#;
///
/// assert_eq!(extract_signature_from_help(help), Some("mean(x, ...)".to_string()));
/// ```
#[allow(dead_code)] // Used in tests, may be useful in the future
pub fn extract_signature_from_help(help_text: &str) -> Option<String> {
    let lines: Vec<&str> = help_text.lines().collect();

    // Find the "Usage:" section
    let usage_idx = lines.iter().position(|line| line.trim() == "Usage:")?;

    // Collect lines after "Usage:" until we hit another section (like "Arguments:")
    let mut signature_lines: Vec<&str> = Vec::new();
    let mut in_s3_comment = false;

    for line in lines.iter().skip(usage_idx + 1) {
        let trimmed = line.trim();

        // Stop at the next section header (ends with ":" and doesn't contain parentheses)
        if !trimmed.is_empty() && trimmed.ends_with(':') && !trimmed.contains('(') {
            break;
        }

        // Check for S3 method comments
        if trimmed.starts_with("## S3 method") || trimmed.starts_with("## Default S3 method") {
            // If we already have a non-S3 signature, we're done
            if !signature_lines.is_empty() {
                break;
            }
            in_s3_comment = true;
            continue;
        }

        // Skip empty lines
        if trimmed.is_empty() {
            // If we have a complete signature (ends with ')'), we're done
            if !signature_lines.is_empty() {
                let last = signature_lines.last().unwrap_or(&"");
                if last.ends_with(')') {
                    break;
                }
            }
            in_s3_comment = false;
            continue;
        }

        // If we're after an S3 comment and don't have a signature yet, take this one
        // Otherwise, if we're not after an S3 comment, this is a generic signature
        if in_s3_comment && signature_lines.is_empty() {
            // This is an S3 method signature - take it as fallback
            signature_lines.push(trimmed);
            if trimmed.ends_with(')') {
                // Complete S3 signature, but keep looking for a generic one
                // Actually, let's just return this since it's useful
                break;
            }
        } else if !in_s3_comment {
            // This is a generic signature
            signature_lines.push(trimmed);
            if trimmed.ends_with(')') {
                break;
            }
        }
    }

    if signature_lines.is_empty() {
        return None;
    }

    // Join multi-line signatures
    let signature = signature_lines.join("\n");

    Some(signature)
}

/// Retrieves the function signature for a topic within a package.
///
/// Attempts to fetch the topic's help text and extract the first available function signature from its Usage section.
///
/// # Returns
///
/// `Some(signature)` if a signature is found, `None` otherwise.
///
/// # Examples
///
/// ```
/// let sig = get_function_signature("mean", "base");
/// if let Some(s) = sig {
///     println!("{}", s);
/// }
/// ```
#[allow(dead_code)] // Used in tests, may be useful in the future
pub fn get_function_signature(topic: &str, package: &str) -> Option<String> {
    let help_text = get_help(topic, Some(package))?;
    extract_signature_from_help(&help_text)
}

/// Converts R help text's Unicode curly quotes to markdown inline code.
///
/// R help uses U+2018 (') and U+2019 (') to wrap code references.
/// This converts `'code'` patterns to `` `code` `` for markdown rendering.
fn r_quotes_to_markdown(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\u{2018}' {
            // Left curly quote — collect until matching right curly quote
            let mut code = String::new();
            let mut found_close = false;
            for inner in chars.by_ref() {
                if inner == '\u{2019}' {
                    found_close = true;
                    break;
                }
                code.push(inner);
            }
            if found_close && !code.is_empty() {
                result.push('`');
                result.push_str(&code);
                result.push('`');
            } else {
                // Unmatched quote — emit as-is
                result.push('\u{2018}');
                result.push_str(&code);
            }
        } else if ch == '\u{2019}' {
            // Stray right curly quote — pass through
            result.push(ch);
        } else {
            result.push(ch);
        }
    }

    result
}

/// Extracts the title and description from R help text for use in completion documentation.
///
/// Returns a formatted string with the title (first line) and the "Description:" section content.
/// Stops at the next section header (e.g., "Usage:", "Arguments:").
///
/// # Examples
///
/// ```
/// let help = r#"Arithmetic Mean
///
/// Description:
///
///      Generic function for the (trimmed) arithmetic mean.
///
/// Usage:
///      mean(x, ...)
/// "#;
///
/// let desc = rlsp::help::extract_description_from_help(help);
/// assert!(desc.is_some());
/// let text = desc.unwrap();
/// assert!(text.contains("Arithmetic Mean"));
/// assert!(text.contains("arithmetic mean"));
/// ```
pub fn extract_description_from_help(help_text: &str) -> Option<String> {
    let lines: Vec<&str> = help_text.lines().collect();
    if lines.is_empty() {
        return None;
    }

    // First non-empty line is the title
    let title = lines.iter().find(|l| !l.trim().is_empty())?.trim();

    // Find the "Description:" section
    let desc_idx = lines
        .iter()
        .position(|line| line.trim() == "Description:")?;

    // Collect lines after "Description:" until we hit another section header
    let mut desc_lines: Vec<&str> = Vec::new();
    for line in lines.iter().skip(desc_idx + 1) {
        let trimmed = line.trim();

        // Stop at the next section header (non-empty, ends with ':', no parens)
        if !trimmed.is_empty() && trimmed.ends_with(':') && !trimmed.contains('(') {
            break;
        }

        desc_lines.push(trimmed);
    }

    // Trim leading/trailing empty lines
    let start = desc_lines.iter().position(|l| !l.is_empty()).unwrap_or(desc_lines.len());
    let end = desc_lines
        .iter()
        .rposition(|l| !l.is_empty())
        .map_or(start, |i| i + 1);
    let desc_lines = &desc_lines[start..end];

    if desc_lines.is_empty() {
        return Some(r_quotes_to_markdown(title));
    }

    let description = desc_lines.join(" ");
    // Collapse multiple spaces from line joining
    let description = description.split_whitespace().collect::<Vec<_>>().join(" ");

    Some(r_quotes_to_markdown(&format!("{title}\n\n{description}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_signature_simple() {
        let help_text = r#"Arithmetic Mean

Description:

     Generic function for the (trimmed) arithmetic mean.

Usage:

     mean(x, ...)

     ## Default S3 method:
     mean(x, trim = 0, na.rm = FALSE, ...)

Arguments:

       x: an R object.
"#;

        let sig = extract_signature_from_help(help_text);
        assert_eq!(sig, Some("mean(x, ...)".to_string()));
    }

    #[test]
    fn test_extract_signature_multiline() {
        let help_text = r#"Create, modify, and delete columns

Description:

     'mutate()' creates new columns.

Usage:

     mutate(.data, ...)

     ## S3 method for class 'data.frame'
     mutate(
       .data,
       ...,
       .by = NULL
     )

Arguments:

   .data: A data frame.
"#;

        let sig = extract_signature_from_help(help_text);
        assert_eq!(sig, Some("mutate(.data, ...)".to_string()));
    }

    #[test]
    fn test_extract_signature_no_usage() {
        let help_text = r#"Some Topic

Description:

     Some description without usage section.
"#;

        let sig = extract_signature_from_help(help_text);
        assert_eq!(sig, None);
    }

    #[test]
    fn test_extract_signature_only_s3_method() {
        // Some functions only have S3 method signatures
        // In this case, we should still return the S3 method signature
        // since it's useful information for the user
        let help_text = r#"Some Function

Description:

     A function.

Usage:

     ## S3 method for class 'foo'
     bar(x, y = 1)

Arguments:

       x: an object.
"#;

        // Should return the S3 method signature since there's no generic
        let sig = extract_signature_from_help(help_text);
        assert_eq!(sig, Some("bar(x, y = 1)".to_string()));
    }

    #[test]
    fn test_help_cache_bounded() {
        let cache = HelpCache::with_max_entries(3);

        cache.insert("a", None, Some("help_a".to_string()));
        cache.insert("b", None, Some("help_b".to_string()));
        cache.insert("c", None, Some("help_c".to_string()));
        assert_eq!(cache.len(), 3);

        // Inserting a 4th entry should evict the LRU ("a")
        cache.insert("d", None, Some("help_d".to_string()));
        assert_eq!(cache.len(), 3);
        assert!(cache.get("a", None).is_none());
        assert!(cache.get("d", None).is_some());
    }

    #[test]
    fn test_help_cache_update_existing() {
        let cache = HelpCache::with_max_entries(3);

        cache.insert("a", None, None);
        assert_eq!(cache.get("a", None), Some(None));

        // Updating same key should not grow the cache
        cache.insert("a", None, Some("updated".to_string()));
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.get("a", None), Some(Some("updated".to_string())));
    }

    #[test]
    fn test_help_cache_composite_key() {
        let cache = HelpCache::with_max_entries(10);

        // Same topic, different packages should be separate entries
        cache.insert("filter", Some("dplyr"), Some("dplyr filter".to_string()));
        cache.insert("filter", Some("stats"), Some("stats filter".to_string()));
        cache.insert("filter", None, Some("unqualified filter".to_string()));

        assert_eq!(cache.len(), 3);
        assert_eq!(
            cache.get("filter", Some("dplyr")),
            Some(Some("dplyr filter".to_string()))
        );
        assert_eq!(
            cache.get("filter", Some("stats")),
            Some(Some("stats filter".to_string()))
        );
        assert_eq!(
            cache.get("filter", None),
            Some(Some("unqualified filter".to_string()))
        );
    }

    #[test]
    fn test_help_cache_negative_caching() {
        let cache = HelpCache::with_max_entries(10);

        // Insert a negative result (topic exists in cache but has no help)
        cache.insert("nonexistent_func", Some("somepkg"), None);

        // get() should return Some(None) — "we looked it up and there's nothing"
        // This is distinct from a cache miss which returns None
        let result = cache.get("nonexistent_func", Some("somepkg"));
        assert_eq!(
            result,
            Some(None),
            "Negative cache entry should return Some(None), not a cache miss"
        );

        // A different package for the same topic should be a cache miss
        let result = cache.get("nonexistent_func", Some("otherpkg"));
        assert!(
            result.is_none(),
            "Different package should be a cache miss, not a negative hit"
        );
    }

    #[test]
    fn test_help_cache_clone_shares_state() {
        // This property is critical: backend.rs clones the cache before
        // spawn_blocking, so writes in the blocking thread must be visible
        // to the original cache (and vice versa).
        let cache1 = HelpCache::with_max_entries(10);
        let cache2 = cache1.clone();

        // Write through clone, read through original
        cache2.insert("mean", Some("base"), Some("help text".to_string()));
        assert_eq!(
            cache1.get("mean", Some("base")),
            Some(Some("help text".to_string())),
            "Clone and original must share underlying storage"
        );

        // Write through original, read through clone
        cache1.insert("filter", Some("dplyr"), Some("dplyr help".to_string()));
        assert_eq!(
            cache2.get("filter", Some("dplyr")),
            Some(Some("dplyr help".to_string())),
            "Writes through original must be visible through clone"
        );
    }

    #[test]
    fn test_help_cache_negative_ttl_expiry() {
        // Negative entries should expire after the TTL so that transient R
        // failures (e.g., timeout, R busy) don't permanently suppress lookups.
        let cache = HelpCache::with_max_entries_and_ttl(10, Duration::from_millis(50));

        cache.insert("hung_func", Some("slow_pkg"), None);
        assert_eq!(cache.len(), 1);

        // Immediately after insertion, negative entry should be a cache hit
        assert_eq!(
            cache.get("hung_func", Some("slow_pkg")),
            Some(None),
            "Fresh negative entry should be a cache hit"
        );

        // Wait for TTL to expire
        std::thread::sleep(Duration::from_millis(80));

        // After TTL, negative entry should be treated as a cache miss
        assert!(
            cache.get("hung_func", Some("slow_pkg")).is_none(),
            "Expired negative entry should be treated as cache miss, allowing retry"
        );

        // The expired entry should have been evicted from the LRU map, not just
        // hidden — it should not waste a cache slot
        assert_eq!(
            cache.len(),
            0,
            "Expired negative entry should be evicted from the cache, not left as a stale slot"
        );
    }

    #[test]
    fn test_help_cache_positive_entries_never_expire() {
        // Positive entries (actual help text) should never expire — help text
        // doesn't change during an LSP session.
        let cache = HelpCache::with_max_entries_and_ttl(10, Duration::from_millis(50));

        cache.insert("mean", Some("base"), Some("help text".to_string()));

        // Wait well past the negative TTL
        std::thread::sleep(Duration::from_millis(80));

        // Positive entry should still be a cache hit
        assert_eq!(
            cache.get("mean", Some("base")),
            Some(Some("help text".to_string())),
            "Positive cache entries must never expire"
        );
    }

    #[test]
    fn test_help_cache_get_or_fetch_uses_cache() {
        // get_or_fetch should return cached content without calling get_help().
        // We verify this by pre-populating the cache with synthetic help text
        // that R would never produce, then checking get_or_fetch returns it.
        let cache = HelpCache::with_max_entries(10);
        let synthetic = "SYNTHETIC_HELP_TEXT_NOT_FROM_R";
        cache.insert("fake_topic", Some("fake_pkg"), Some(synthetic.to_string()));

        let result = cache.get_or_fetch("fake_topic", Some("fake_pkg"));
        assert_eq!(
            result,
            Some(synthetic.to_string()),
            "get_or_fetch should return cached content without spawning R"
        );
    }

    #[test]
    fn test_help_cache_get_or_fetch_caches_negative() {
        // When get_help returns None (nonexistent package), get_or_fetch should
        // cache the negative result so subsequent calls don't spawn R again.
        let cache = HelpCache::with_max_entries(10);

        let _ = cache.get_or_fetch("no_such_func", Some("nonexistent_pkg_xyzzy"));

        let cached = cache.get("no_such_func", Some("nonexistent_pkg_xyzzy"));
        assert_eq!(
            cached,
            Some(None),
            "get_or_fetch should cache negative results from R subprocess"
        );
    }

    #[test]
    fn test_help_cache_negative_ttl_refresh_end_to_end() {
        // End-to-end test: a negative entry expires after TTL, and a subsequent
        // get_or_fetch() re-populates the cache (rather than returning stale data
        // or permanently treating the topic as missing).
        let cache = HelpCache::with_max_entries_and_ttl(10, Duration::from_millis(50));

        // Simulate a failed lookup by inserting a negative entry directly
        cache.insert("some_func", Some("nonexistent_pkg_xyzzy"), None);
        assert_eq!(
            cache.get("some_func", Some("nonexistent_pkg_xyzzy")),
            Some(None),
            "Fresh negative entry should be a cache hit"
        );

        // Wait for the TTL to expire
        std::thread::sleep(Duration::from_millis(80));

        // get() should now treat the expired entry as a cache miss
        assert!(
            cache.get("some_func", Some("nonexistent_pkg_xyzzy")).is_none(),
            "Expired negative entry should be a cache miss"
        );

        // get_or_fetch() should re-fetch from R (which will fail again for this
        // fake package) and re-populate the cache with a fresh negative entry
        let result = cache.get_or_fetch("some_func", Some("nonexistent_pkg_xyzzy"));
        assert!(result.is_none(), "R should still not find this fake package");

        // The cache should now have a fresh negative entry (not expired)
        assert_eq!(
            cache.get("some_func", Some("nonexistent_pkg_xyzzy")),
            Some(None),
            "get_or_fetch should have re-cached a fresh negative entry after TTL expiry"
        );
    }

    #[test]
    fn test_extract_description_basic() {
        let help_text = r#"Arithmetic Mean

Description:

     Generic function for the (trimmed) arithmetic mean.

Usage:

     mean(x, ...)
"#;

        let desc = extract_description_from_help(help_text);
        assert!(desc.is_some());
        let text = desc.unwrap();
        assert!(text.starts_with("Arithmetic Mean"));
        assert!(text.contains("arithmetic mean"));
    }

    #[test]
    fn test_extract_description_multiline() {
        // Use Unicode curly quotes (U+2018, U+2019) matching actual R help output
        let help_text = "Read R Code from a File, a Connection or Expressions\n\
            \n\
            Description:\n\
            \n\
            \x20\x20\x20\x20\x20\u{2018}source\u{2019} causes R to accept its input from the named file or URL\n\
            \x20\x20\x20\x20\x20or connection or expressions directly.  Input is read and \u{2018}parse\u{2019}d\n\
            \x20\x20\x20\x20\x20from that file until the end of the file is reached.\n\
            \n\
            Usage:\n\
            \n\
            \x20\x20\x20\x20\x20source(file, local = FALSE)\n";

        let desc = extract_description_from_help(help_text).unwrap();
        assert!(desc.starts_with("Read R Code from a File"));
        // Unicode curly quotes should be converted to markdown backticks
        assert!(
            desc.contains("`source`"),
            "should convert curly quotes to backticks: {desc}"
        );
        assert!(
            desc.contains("`parse`"),
            "should convert curly quotes to backticks: {desc}"
        );
        assert!(desc.contains("named file or URL"));
        // Should not include Usage section
        assert!(!desc.contains("local = FALSE"));
    }

    #[test]
    fn test_extract_description_no_description_section() {
        let help_text = "Some Title\n\nUsage:\n    foo(x)\n";
        assert!(extract_description_from_help(help_text).is_none());
    }

    #[test]
    fn test_extract_description_empty() {
        assert!(extract_description_from_help("").is_none());
    }

    #[test]
    fn test_extract_description_title_only() {
        let help_text = "My Function\n\nDescription:\n\n";
        let desc = extract_description_from_help(help_text).unwrap();
        assert_eq!(desc, "My Function");
    }

    #[test]
    fn test_r_quotes_to_markdown_basic() {
        let input = "\u{2018}source\u{2019} causes R to do things";
        let result = r_quotes_to_markdown(input);
        assert_eq!(result, "`source` causes R to do things");
    }

    #[test]
    fn test_r_quotes_to_markdown_multiple() {
        let input = "\u{2018}foo\u{2019} and \u{2018}bar\u{2019}";
        let result = r_quotes_to_markdown(input);
        assert_eq!(result, "`foo` and `bar`");
    }

    #[test]
    fn test_r_quotes_to_markdown_with_parens() {
        let input = "\u{2018}withAutoprint(exprs)\u{2019} is a wrapper";
        let result = r_quotes_to_markdown(input);
        assert_eq!(result, "`withAutoprint(exprs)` is a wrapper");
    }

    #[test]
    fn test_r_quotes_to_markdown_no_quotes() {
        let input = "No special quotes here";
        let result = r_quotes_to_markdown(input);
        assert_eq!(result, "No special quotes here");
    }

    #[test]
    fn test_r_quotes_to_markdown_unmatched() {
        // Unmatched left quote should be preserved
        let input = "text \u{2018}unmatched";
        let result = r_quotes_to_markdown(input);
        assert_eq!(result, "text \u{2018}unmatched");
    }
}
