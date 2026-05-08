//! HTML sanitization for Rd2HTML output.
//!
//! Two-step:
//!   1. Regex pre-pass strips any `style="..."` attribute whose value
//!      contains `url(` (case-insensitive).
//!   2. `ammonia::clean()` with a help-specific allowlist removes
//!      dangerous tags/attributes.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

/// Sanitize Rd2HTML output to a safe allowlist.
pub fn sanitize_help_html(html: &str) -> String {
    let pre = strip_style_url(html);
    build_ammonia_sanitized(&pre)
}

fn strip_style_url(html: &str) -> std::borrow::Cow<'_, str> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r#"(?i)\s+style\s*=\s*"[^"]*url\s*\([^"]*""#)
            .expect("valid regex")
    });
    re.replace_all(html, "")
}

fn build_ammonia_sanitized(html: &str) -> String {
    static TAGS: OnceLock<HashSet<&'static str>> = OnceLock::new();
    static GENERIC_ATTRS: OnceLock<HashSet<&'static str>> = OnceLock::new();
    static TAG_ATTRS: OnceLock<HashMap<&'static str, HashSet<&'static str>>> = OnceLock::new();
    static URL_SCHEMES: OnceLock<HashSet<&'static str>> = OnceLock::new();

    let tags = TAGS.get_or_init(|| {
        [
            "h1", "h2", "h3", "h4", "h5", "h6", "p", "div", "pre", "blockquote", "hr",
            "table", "thead", "tbody", "tr", "th", "td", "caption", "dl", "dt", "dd",
            "ul", "ol", "li", "a", "code", "em", "strong", "i", "b", "span", "br",
            "sub", "sup", "img",
        ]
        .into_iter()
        .collect()
    });
    let generic = GENERIC_ATTRS.get_or_init(|| {
        ["class", "id", "title", "style"].into_iter().collect()
    });
    let per_tag = TAG_ATTRS.get_or_init(|| {
        let mut m = HashMap::new();
        m.insert("a", ["href"].into_iter().collect());
        m.insert(
            "img",
            ["src", "alt", "width", "height"].into_iter().collect(),
        );
        for tag in ["table", "th", "td"] {
            m.insert(
                tag,
                ["colspan", "rowspan", "align"].into_iter().collect(),
            );
        }
        m
    });
    let schemes = URL_SCHEMES.get_or_init(|| {
        ["http", "https", "mailto", "raven-help", "data"]
            .into_iter()
            .collect()
    });

    let mut b = ammonia::Builder::default();
    b.tags(tags.clone());
    b.generic_attributes(generic.clone());
    b.tag_attributes(per_tag.clone());
    b.url_schemes(schemes.clone());
    b.clean(html).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_script_tags() {
        let html = r#"<p>hi</p><script>alert(1)</script>"#;
        let out = sanitize_help_html(html);
        assert!(out.contains("<p>hi</p>"));
        assert!(!out.contains("<script>"));
        assert!(!out.contains("alert"));
    }

    #[test]
    fn strips_iframe_object_embed_form() {
        let html = r#"<iframe src="x"></iframe><object></object><embed/><form></form>"#;
        let out = sanitize_help_html(html);
        assert!(!out.contains("<iframe"));
        assert!(!out.contains("<object"));
        assert!(!out.contains("<embed"));
        assert!(!out.contains("<form"));
    }

    #[test]
    fn strips_event_attrs() {
        let html = r##"<a href="#" onclick="alert(1)" onerror="x">click</a>"##;
        let out = sanitize_help_html(html);
        assert!(out.contains(r##"href="#""##));
        assert!(!out.contains("onclick"));
        assert!(!out.contains("onerror"));
    }

    #[test]
    fn keeps_inline_style_without_url() {
        let html = r#"<span style="color: red">x</span>"#;
        let out = sanitize_help_html(html);
        assert!(out.contains(r#"style="color: red""#));
    }

    #[test]
    fn drops_style_with_url() {
        let html = r#"<span style="background: url(http://evil/x)">x</span>"#;
        let out = sanitize_help_html(html);
        assert!(!out.contains("url("));
    }

    #[test]
    fn drops_style_with_url_case_insensitive() {
        let html = r#"<span style="background: URL(x)">x</span>"#;
        let out = sanitize_help_html(html);
        assert!(!out.to_lowercase().contains("url("));
    }

    #[test]
    fn keeps_help_table_structure() {
        let html = r#"<table><tr><th>a</th><td colspan="2">b</td></tr></table>"#;
        let out = sanitize_help_html(html);
        assert!(out.contains("<table>"));
        assert!(out.contains("<tr>"));
        assert!(out.contains("<th>"));
        assert!(out.contains(r#"colspan="2""#));
    }

    #[test]
    fn keeps_a_href_attribute() {
        let html = r#"<a href="https://example.com">link</a>"#;
        let out = sanitize_help_html(html);
        assert!(out.contains(r#"href="https://example.com""#));
    }

    #[test]
    fn keeps_img_src_attribute() {
        let html = r#"<img src="figures/x.png" alt="x" width="100" height="50">"#;
        let out = sanitize_help_html(html);
        assert!(out.contains(r#"src="figures/x.png""#));
        assert!(out.contains(r#"alt="x""#));
    }
}
