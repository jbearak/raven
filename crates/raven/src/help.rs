// help.rs - Minimal R help system for static LSP
//
// This module calls R as a subprocess to get help documentation.
// It's "static" in that it doesn't embed R, but can still access help.

use std::process::Command;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use lru::LruCache;

/// Maximum number of entries in the help cache. When this limit is reached,
/// the least-recently-used entries are evicted to make room for new ones.
const HELP_CACHE_MAX_ENTRIES: usize = 512;

/// Bounded cache for help content. Uses LRU eviction to prevent unbounded
/// memory growth in long-running LSP sessions.
///
/// Keys use composite format: `"package::topic"` for package-qualified lookups,
/// plain `"topic"` for unqualified lookups. This prevents collisions when
/// different packages export the same function name (e.g., `dplyr::filter`
/// vs `stats::filter`).
///
/// Uses `peek()` for reads (no LRU promotion, works under read lock) and
/// `push()` for writes (promotes/evicts under write lock).
#[derive(Clone)]
pub struct HelpCache {
    inner: Arc<RwLock<LruCache<String, Option<String>>>>,
}

/// Builds a cache key from a topic and optional package.
fn cache_key(topic: &str, package: Option<&str>) -> String {
    match package {
        Some(pkg) => format!("{pkg}::{topic}"),
        None => topic.to_string(),
    }
}

impl HelpCache {
    pub fn new() -> Self {
        Self::with_max_entries(HELP_CACHE_MAX_ENTRIES)
    }

    pub fn get(&self, topic: &str, package: Option<&str>) -> Option<Option<String>> {
        let key = cache_key(topic, package);
        self.inner.read().ok()?.peek(&key).cloned()
    }

    pub fn insert(&self, topic: &str, package: Option<&str>, content: Option<String>) {
        let key = cache_key(topic, package);
        if let Ok(mut guard) = self.inner.write() {
            guard.push(key, content);
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner.read().map(|c| c.len()).unwrap_or(0)
    }

    fn with_max_entries(cap: usize) -> Self {
        let cap = crate::cross_file::cache::non_zero_or(cap, HELP_CACHE_MAX_ENTRIES);
        Self {
            inner: Arc::new(RwLock::new(LruCache::new(cap))),
        }
    }
}

impl Default for HelpCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Fetches help text for an R topic by invoking R and returns the rendered help if available.
///
/// Returns `Some(String)` containing the help text when R executes successfully, the output is not empty,
/// and the output does not contain the phrase "No documentation". Returns `None` otherwise.
///
/// # Examples
///
/// ```no_run
/// // Attempt to get help for `mean` from the base package
/// if let Some(text) = rlsp::help::get_help("mean", Some("base")) {
///     assert!(text.contains("Usage:"));
/// }
/// ```
/// Timeout for R help subprocess calls. Prevents hung R processes from
/// blocking threads indefinitely.
const HELP_TIMEOUT: Duration = Duration::from_secs(10);

/// Poll interval when waiting for R subprocess to finish.
const HELP_POLL_INTERVAL: Duration = Duration::from_millis(50);

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

    // Spawn as child process so we can enforce a timeout
    let mut child = match cmd.stdout(std::process::Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(e) => {
            log::trace!("get_help: subprocess spawn error: {}", e);
            return None;
        }
    };

    let deadline = Instant::now() + HELP_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // Process exited — read output
                let output = child.wait_with_output().ok()?;
                log::trace!(
                    "get_help: exit_status={}, stdout_len={}, stderr_len={}",
                    status,
                    output.stdout.len(),
                    output.stderr.len()
                );
                if status.success() {
                    let text = String::from_utf8_lossy(&output.stdout).to_string();
                    if !text.trim().is_empty() && !text.contains("No documentation") {
                        return Some(text);
                    }
                    log::trace!("get_help: empty or no documentation");
                }
                return None;
            }
            Ok(None) => {
                // Still running — check timeout
                if Instant::now() >= deadline {
                    log::trace!(
                        "get_help: timeout after {:?}, killing subprocess",
                        HELP_TIMEOUT
                    );
                    let _ = child.kill();
                    let _ = child.wait(); // reap zombie
                    return None;
                }
                std::thread::sleep(HELP_POLL_INTERVAL);
            }
            Err(e) => {
                log::trace!("get_help: try_wait error: {}", e);
                return None;
            }
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
    while desc_lines.first() == Some(&"") {
        desc_lines.remove(0);
    }
    while desc_lines.last() == Some(&"") {
        desc_lines.pop();
    }

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
