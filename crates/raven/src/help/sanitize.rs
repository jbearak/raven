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
///
/// Note: dead-link stripping (`Run examples`, `Index`) lives in
/// [`strip_dead_links`] and must run on the raw R output BEFORE the
/// cross-reference rewriter, because the rewriter converts unrecognized
/// hrefs to `javascript:void(0)`+`data-raven-dropped` and the strip regexes
/// match by the original href.
pub fn sanitize_help_html(html: &str) -> String {
    let pre = strip_style_url(html);
    let pre2 = strip_rd_doc_header_table(&pre);
    build_ammonia_sanitized(&pre2)
}

/// Strip elements that point at endpoints we don't implement (R's dynamic
/// help server's `../Example/<topic>` runner and the per-package
/// `00Index.html` page). Must run on the raw Rd2HTML output BEFORE the
/// cross-reference rewriter — the rewriter overwrites unmatched hrefs with
/// `javascript:void(0)`, after which these regexes can no longer recognize
/// the original URL.
pub fn strip_dead_links(html: &str) -> String {
    let pre = strip_run_examples_link(html);
    let pre2 = strip_index_link(&pre);
    pre2.into_owned()
}

fn strip_style_url(html: &str) -> std::borrow::Cow<'_, str> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        // Match `style=...` whose value contains `url(`, regardless of quoting:
        //   - double-quoted: style="...url(...)..."
        //   - single-quoted: style='...url(...)...'
        //   - unquoted: style=foo:url(x); (terminated by whitespace or `>`)
        // Attribute parsing is irregular; this is best-effort defense-in-depth.
        // Final HTML cleanup still goes through ammonia below.
        regex::Regex::new(
            r#"(?i)\s+style\s*=\s*(?:"[^"]*url\s*\([^"]*"|'[^']*url\s*\([^']*'|[^\s>'"]*url\s*\([^\s>]*)"#,
        )
        .expect("valid regex")
    });
    re.replace_all(html, "")
}

/// Remove the decorative `<table>...<td>topic {pkg}</td><td>R Documentation</td>...</table>`
/// header that Rd2HTML emits at the top of every page. The same information
/// already lives in the panel's editor-tab title; rendering it inline as a
/// one-row table is just visual noise.
fn strip_rd_doc_header_table(html: &str) -> std::borrow::Cow<'_, str> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(
            r#"(?is)<table\b[^>]*>\s*<tr\b[^>]*>\s*<td\b[^>]*>[^<]*\{[^}]+\}\s*</td>\s*<td\b[^>]*>\s*R\s+Documentation\s*</td>\s*</tr>\s*</table>"#,
        )
        .expect("valid regex")
    });
    re.replace(html, "")
}

/// Remove the `<p><a href='../Example/<topic>'>Run examples</a></p>` paragraph
/// emitted by Rd2HTML(dynamic = TRUE). The link points at R's dynamic help
/// server endpoint that runs example code; we have no equivalent runner, so
/// clicking does nothing. Stripping the element entirely is preferable to
/// leaving a no-op link in place.
fn strip_run_examples_link(html: &str) -> std::borrow::Cow<'_, str> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(
            r#"(?is)<p>\s*<a\b[^>]*\bhref=['"][^'"]*Example/[^'"]*['"][^>]*>\s*Run\s+examples\s*</a>\s*</p>"#,
        )
        .expect("valid regex")
    });
    re.replace(html, "")
}

/// Remove the trailing `<a href="00Index.html">Index</a>` link from the
/// page footer (`[Package <em>pkg</em> version X.Y.Z <a ...>Index</a>]`).
/// The link points at a per-package index page that we don't render, so it
/// would be a dead link. Strip the entire anchor — including the leading
/// whitespace — leaving `[Package <em>pkg</em> version X.Y.Z]`.
fn strip_index_link(html: &str) -> std::borrow::Cow<'_, str> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r#"(?is)\s*<a\b[^>]*\bhref=['"]00Index\.html['"][^>]*>\s*Index\s*</a>"#)
            .expect("valid regex")
    });
    re.replace(html, "")
}

fn build_ammonia_sanitized(html: &str) -> String {
    static TAGS: OnceLock<HashSet<&'static str>> = OnceLock::new();
    static GENERIC_ATTRS: OnceLock<HashSet<&'static str>> = OnceLock::new();
    static TAG_ATTRS: OnceLock<HashMap<&'static str, HashSet<&'static str>>> = OnceLock::new();
    static URL_SCHEMES: OnceLock<HashSet<&'static str>> = OnceLock::new();

    let tags = TAGS.get_or_init(|| {
        [
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "p",
            "div",
            "pre",
            "blockquote",
            "hr",
            "table",
            "thead",
            "tbody",
            "tr",
            "th",
            "td",
            "caption",
            "dl",
            "dt",
            "dd",
            "ul",
            "ol",
            "li",
            "a",
            "code",
            "em",
            "strong",
            "i",
            "b",
            "span",
            "br",
            "sub",
            "sup",
            "img",
        ]
        .into_iter()
        .collect()
    });
    let generic =
        GENERIC_ATTRS.get_or_init(|| ["class", "id", "title", "style"].into_iter().collect());
    let per_tag = TAG_ATTRS.get_or_init(|| {
        let mut m = HashMap::new();
        m.insert("a", ["href"].into_iter().collect());
        m.insert(
            "img",
            ["src", "alt", "width", "height"].into_iter().collect(),
        );
        for tag in ["table", "th", "td"] {
            m.insert(tag, ["colspan", "rowspan", "align"].into_iter().collect());
        }
        m
    });
    // `data:` is allowlisted globally so `<img src="data:image/...">` (used
    // for inline icons in some packages' Rd documentation, where the CSP also
    // permits `img-src ... data:`) survives sanitization. We then drop
    // `data:` from `<a href>` specifically via `attribute_filter` below —
    // ammonia has no per-tag scheme allowlist, so a global allow + targeted
    // filter is the only way to keep inline images while denying `data:` URLs
    // as link targets.
    let schemes = URL_SCHEMES.get_or_init(|| {
        ["http", "https", "mailto", "raven-help", "data"]
            .into_iter()
            .collect()
    });

    static CLEAN_CONTENT_TAGS: OnceLock<HashSet<&'static str>> = OnceLock::new();
    let clean_content = CLEAN_CONTENT_TAGS.get_or_init(|| {
        // Tags whose CONTENTS we also strip. Without these, `<title>R: ...</title>`
        // in the head leaks "R: ..." as raw text into the rendered body
        // (ammonia's default for unknown tags is to keep inner text).
        ["script", "style", "title", "head", "meta", "link"]
            .into_iter()
            .collect()
    });

    let mut b = ammonia::Builder::default();
    b.tags(tags.clone());
    b.generic_attributes(generic.clone());
    b.tag_attributes(per_tag.clone());
    b.url_schemes(schemes.clone());
    b.clean_content_tags(clean_content.clone());
    // Drop `data:` href values on `<a>` even though `data:` is in the
    // global url_schemes (needed for `<img src>`). `data:` link navigation
    // is a known XSS / phishing vector and the CSP / click handler are
    // secondary defenses; the sanitizer should be the primary gate.
    //
    // Compare on `as_bytes()` to keep the prefix check UTF-8-safe — R help
    // legitimately ships hrefs with non-ASCII bytes (e.g. relative links
    // like `doc/é`), and indexing the `&str` directly with `[..5]` would
    // panic if byte 5 fell inside a multibyte character.
    b.attribute_filter(|element, attribute, value| {
        if element.eq_ignore_ascii_case("a") && attribute.eq_ignore_ascii_case("href") {
            let bytes = value.trim_start().as_bytes();
            if bytes.len() >= 5 && bytes[..5].eq_ignore_ascii_case(b"data:") {
                return None;
            }
        }
        Some(std::borrow::Cow::Borrowed(value))
    });
    // Keep relative URLs (e.g. `<a href="../../base/help/sum">`,
    // `<img src="figures/x.png">`) so the rewriter and the extension's
    // image rewriter can convert them downstream. Default Deny would
    // strip them before either could run.
    b.url_relative(ammonia::UrlRelative::PassThrough);
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
    fn drops_style_with_single_quoted_url() {
        let html = r#"<span style='background: url(http://evil/x)'>x</span>"#;
        let out = sanitize_help_html(html);
        assert!(!out.to_lowercase().contains("url("));
    }

    #[test]
    fn drops_style_with_unquoted_url() {
        let html = r#"<span style=background:url(x)>x</span>"#;
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

    #[test]
    fn keeps_relative_a_href() {
        // url_relative(PassThrough) means the rewriter and the extension
        // can both see relative URLs and convert them downstream.
        let html = r#"<a href="../../base/help/sum">sum</a>"#;
        let out = sanitize_help_html(html);
        assert!(out.contains(r#"href="../../base/help/sum""#));
    }

    #[test]
    fn keeps_raven_help_scheme() {
        let html = r#"<a href="raven-help://topic/base/sum">sum</a>"#;
        let out = sanitize_help_html(html);
        assert!(out.contains(r#"href="raven-help://topic/base/sum""#));
    }

    #[test]
    fn drops_data_url_on_a_href() {
        // `data:` must be allowed only for `<img src>`, never for `<a href>`,
        // so a malicious or buggy package can't ship inline-document or
        // phishing links. The CSP and click handler both block `data:`
        // navigation in practice, but the sanitizer is the primary gate.
        let html = r#"<a href="data:text/html,<b>x</b>">click</a>"#;
        let out = sanitize_help_html(html);
        assert!(
            !out.contains("data:"),
            "data: href on <a> must be stripped by sanitizer: {}",
            out
        );
    }

    #[test]
    fn keeps_data_url_on_img_src() {
        // Inline `data:` images remain allowed — the CSP's `img-src ... data:`
        // permits them for inline icons in package help pages.
        let html = r#"<img src="data:image/png;base64,iVBORw==" alt="x">"#;
        let out = sanitize_help_html(html);
        assert!(
            out.contains("data:image/png;base64"),
            "data: src on <img> must be preserved: {}",
            out
        );
    }

    #[test]
    fn allows_non_ascii_href_without_panic() {
        // Regression: an earlier version did `trimmed[..5]` on the href,
        // which is a byte slice — for hrefs whose first non-ASCII char
        // straddles byte index 5 (e.g. "doc/é", 6 bytes UTF-8) it would
        // panic inside ammonia's attribute filter and turn a valid help
        // page into a render failure. R help legitimately emits non-ASCII
        // relative hrefs, so the prefix check must be UTF-8-safe.
        let cases = [
            r##"<a href="doc/é">x</a>"##,
            r##"<a href="#xxxé">x</a>"##,
            r##"<a href="café">x</a>"##,
            r##"<a href="日本語">x</a>"##,
        ];
        for html in cases {
            // Must not panic and must preserve the anchor tag.
            let out = sanitize_help_html(html);
            assert!(
                out.contains("<a "),
                "non-ASCII href must survive sanitization: {html} -> {out}"
            );
        }
    }

    #[test]
    fn drops_data_url_on_a_href_case_and_whitespace_insensitive() {
        // Defense-in-depth: case variation and leading whitespace must not
        // smuggle a `data:` href past the filter.
        for raw_href in [
            r#"DATA:text/html,x"#,
            r#"  data:text/html,x"#,
            r#"Data:text/html,x"#,
        ] {
            let html = format!(r#"<a href="{raw_href}">x</a>"#);
            let out = sanitize_help_html(&html);
            assert!(
                !out.to_ascii_lowercase().contains("data:"),
                "variant {raw_href:?} must be stripped: got {out}"
            );
        }
    }

    #[test]
    fn strips_title_content() {
        // Without title in clean_content_tags, ammonia would keep the
        // "R: ..." inner text and leak it into the rendered body.
        let html = r#"<html><head><title>R: Foo</title></head><body><h2>Body</h2></body></html>"#;
        let out = sanitize_help_html(html);
        assert!(
            !out.contains("R: Foo"),
            "title content must be stripped: {}",
            out
        );
        assert!(out.contains("<h2>Body</h2>"));
    }

    #[test]
    fn strips_decorative_rd_header_table() {
        // The `<table><tr><td>topic {pkg}</td><td>R Documentation</td></tr></table>`
        // chrome at the top of every Rd2HTML page is duplicate of the
        // editor tab title; strip it.
        let html = r#"<table style="width: 100%;"><tr><td>filter {dplyr}</td><td style="text-align: right;">R Documentation</td></tr></table><h2>Subset rows</h2>"#;
        let out = sanitize_help_html(html);
        assert!(
            !out.contains("R Documentation"),
            "decorative table must be removed: {}",
            out
        );
        assert!(
            !out.contains("filter {dplyr}"),
            "decorative table must be removed: {}",
            out
        );
        assert!(out.contains("<h2>Subset rows</h2>"));
    }

    #[test]
    fn strip_decorative_table_does_not_eat_real_tables() {
        // A table with multiple rows or different content should NOT be stripped.
        let html = r#"<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>"#;
        let out = sanitize_help_html(html);
        assert!(out.contains("<table>"));
        assert!(out.contains("<td>c</td>"));
    }

    #[test]
    fn strip_dead_links_removes_run_examples() {
        // Rd2HTML(dynamic = TRUE) emits a dynamic-server "Run examples" link
        // before every <pre> example block. Clicking it does nothing in our
        // viewer, so strip the whole paragraph.
        let html = r#"<h3>Examples</h3><p><a href='../Example/plot'>Run examples</a></p><pre>plot(1:10)</pre>"#;
        let out = strip_dead_links(html);
        assert!(
            !out.contains("Run examples"),
            "Run examples must be stripped: {}",
            out
        );
        assert!(
            !out.contains("../Example/"),
            "Example href must be gone: {}",
            out
        );
        assert!(out.contains("<h3>Examples</h3>"));
        assert!(out.contains("plot(1:10)"));
    }

    #[test]
    fn strip_dead_links_handles_double_quoted_run_examples() {
        // Defensive: handle either quote style.
        let html = r#"<p><a href="../Example/mean">Run examples</a></p>"#;
        let out = strip_dead_links(html);
        assert!(!out.contains("Run examples"));
    }

    #[test]
    fn strip_dead_links_removes_index_footer() {
        // Rd2HTML emits `[Package <em>pkg</em> version X.Y.Z <a href="00Index.html">Index</a>]`.
        // Strip the link AND its leading whitespace, leaving the package/version text.
        let html = r#"<hr><div style="text-align: center;">[Package <em>base</em> version 4.6.0 <a href="00Index.html">Index</a>]</div>"#;
        let out = strip_dead_links(html);
        assert!(
            !out.contains("00Index.html"),
            "Index href must be gone: {}",
            out
        );
        assert!(!out.contains(">Index<"), "Index text must be gone: {}", out);
        assert!(
            out.contains("[Package <em>base</em> version 4.6.0]"),
            "footer text preserved: {}",
            out
        );
    }

    #[test]
    fn strip_dead_links_runs_before_rewrite() {
        // Regression: previously the strips lived inside sanitize_help_html, which
        // runs AFTER the cross-reference rewriter. The rewriter converts unknown
        // hrefs (`00Index.html`) to `javascript:void(0)`+`data-raven-dropped`,
        // after which the strip regex (which keys on the original href) no longer
        // matches. The strip must run on raw R output, before the rewriter.
        //
        // This test asserts strip_dead_links is callable on raw HTML and produces
        // output that contains neither the original href nor the post-rewrite
        // form's text "Index" inside an <a>.
        let raw = r#"[Package <em>base</em> version 4.6.0 <a href="00Index.html">Index</a>]"#;
        let stripped = strip_dead_links(raw);
        assert!(!stripped.contains("00Index.html"));
        assert!(!stripped.contains(">Index<"));
    }
}
