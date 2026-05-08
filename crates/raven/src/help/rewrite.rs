//! Pure cross-reference link rewriter for Rd2HTML output.
//!
//! Replaces `<a href="../../<pkg>/help/<topic>[#anchor]">` with a custom
//! scheme `raven-help://topic/<pkg>/<topic>[#anchor]` so the webview only
//! needs to recognize one URL form. See the help-viewer spec
//! ("Cross-reference link rewriting") for full rules.

use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use std::sync::OnceLock;

/// RFC 3986 unreserved set: keep `A-Za-z0-9._~-` unencoded; encode the rest.
const ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// Apply our canonical decode-once-then-encode-once pipeline to a path segment.
fn canon_segment(s: &str) -> String {
    let decoded = percent_encoding::percent_decode_str(s).decode_utf8_lossy();
    utf8_percent_encode(decoded.as_ref(), ENCODE_SET).to_string()
}

/// Walks `<a href="...">` attributes and rewrites cross-references.
pub fn rewrite_help_html(html: &str, _source_pkg: &str) -> String {
    let re = href_regex();
    re.replace_all(html, |caps: &regex::Captures<'_>| {
        let prefix = &caps[1];
        let href = &caps[2];
        let suffix = &caps[3];

        match classify_href(href) {
            HrefKind::HelpRef { pkg, topic, anchor } => {
                let pkg_e = canon_segment(&pkg);
                let topic_e = canon_segment(&topic);
                let url = match anchor {
                    Some(a) => {
                        format!("raven-help://topic/{pkg_e}/{topic_e}#{}", canon_segment(&a))
                    }
                    None => format!("raven-help://topic/{pkg_e}/{topic_e}"),
                };
                format!("{prefix}{url}{suffix}")
            }
            HrefKind::PassThrough => format!("{prefix}{href}{suffix}"),
            HrefKind::Drop => {
                // Replace href with javascript:void(0) and add a data attribute.
                // Rebuild the suffix to inject the data attribute before `>`.
                let sfx = suffix.trim_end_matches('>');
                format!(r#"{prefix}javascript:void(0){sfx} data-raven-dropped="1">"#)
            }
        }
    })
    .into_owned()
}

enum HrefKind {
    HelpRef {
        pkg: String,
        topic: String,
        anchor: Option<String>,
    },
    PassThrough,
    Drop,
}

fn classify_href(href: &str) -> HrefKind {
    if href.starts_with("http://")
        || href.starts_with("https://")
        || href.starts_with("mailto:")
        || (href.starts_with('#') && !href.contains("://"))
    {
        return HrefKind::PassThrough;
    }
    // Detect already-rewritten URLs (idempotency): pass through.
    if href.starts_with("raven-help://") {
        return HrefKind::PassThrough;
    }
    if href.starts_with("javascript:") {
        return HrefKind::PassThrough; // already neutralized
    }
    if let Some(rest) = href.strip_prefix("../../") {
        let mut parts = rest.splitn(3, '/');
        let pkg = parts.next();
        let kind = parts.next();
        let tail = parts.next();
        if let (Some(pkg), Some(kind), Some(tail)) = (pkg, kind, tail) {
            if (kind == "help" || kind == "topic") && !pkg.is_empty() && !tail.is_empty() {
                let (topic, anchor) = match tail.split_once('#') {
                    Some((t, a)) => (t.to_string(), Some(a.to_string())),
                    None => (tail.to_string(), None),
                };
                if topic.is_empty() {
                    return HrefKind::Drop;
                }
                return HrefKind::HelpRef {
                    pkg: pkg.to_string(),
                    topic,
                    anchor,
                };
            }
            return HrefKind::Drop;
        }
        return HrefKind::Drop;
    }
    HrefKind::Drop
}

fn href_regex() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r#"(<a[^>]*\bhref=")([^"]*)("[^>]*>)"#).expect("valid regex")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_basic_help_anchor() {
        let html = r#"<p>See <a href="../../base/help/sum">sum</a>.</p>"#;
        let out = rewrite_help_html(html, "graphics");
        assert!(out.contains(r#"<a href="raven-help://topic/base/sum">sum</a>"#));
    }

    #[test]
    fn rewrites_with_anchor() {
        let html = r#"<a href="../../dplyr/help/filter#examples">x</a>"#;
        let out = rewrite_help_html(html, "dplyr");
        assert!(out.contains(r#"<a href="raven-help://topic/dplyr/filter#examples">x</a>"#));
    }

    #[test]
    fn rewrites_topic_format_alias() {
        let html = r#"<a href="../../utils/topic/citation">cite</a>"#;
        let out = rewrite_help_html(html, "tools");
        assert!(out.contains(r#"<a href="raven-help://topic/utils/citation">cite</a>"#));
    }

    #[test]
    fn percent_encodes_operator_topics() {
        let html = r#"<a href="../../base/help/%5B">[</a>"#;
        let out = rewrite_help_html(html, "base");
        assert!(out.contains(r#"<a href="raven-help://topic/base/%5B">[</a>"#));
        let html2 = r#"<a href="../../base/help/+">+</a>"#;
        let out2 = rewrite_help_html(html2, "base");
        assert!(out2.contains(r#"<a href="raven-help://topic/base/%2B">+</a>"#));
    }

    #[test]
    fn external_links_pass_through() {
        let html = r#"<a href="https://example.com/x">ex</a>"#;
        let out = rewrite_help_html(html, "x");
        assert!(out.contains(r#"<a href="https://example.com/x">ex</a>"#));
        let html2 = r#"<a href="mailto:a@b.c">mail</a>"#;
        let out2 = rewrite_help_html(html2, "x");
        assert!(out2.contains(r#"<a href="mailto:a@b.c">mail</a>"#));
    }

    #[test]
    fn in_page_anchors_pass_through() {
        let html = r##"<a href="#examples">examples</a>"##;
        let out = rewrite_help_html(html, "x");
        assert!(out.contains(r##"<a href="#examples">examples</a>"##));
    }

    #[test]
    fn vignette_links_neutralized() {
        let html = r#"<a href="../../dplyr/doc/intro.html">vignette</a>"#;
        let out = rewrite_help_html(html, "dplyr");
        assert!(out.contains("data-raven-dropped=\"1\"") || out.contains("javascript:void(0)"));
        assert!(!out.contains("href=\"../../dplyr/doc/intro.html\""));
    }

    #[test]
    fn malformed_relative_neutralized() {
        let html = r#"<a href="../foo">x</a><a href="../../">y</a>"#;
        let out = rewrite_help_html(html, "x");
        assert!(!out.contains(r#"href="../foo""#));
        assert!(!out.contains(r#"href="../../""#));
    }

    #[test]
    fn idempotent() {
        let html = r#"<a href="../../base/help/sum">sum</a>"#;
        let once = rewrite_help_html(html, "base");
        let twice = rewrite_help_html(&once, "base");
        assert_eq!(once, twice);
    }
}
