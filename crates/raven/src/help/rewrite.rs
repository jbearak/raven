//! Pure cross-reference link rewriter for Rd2HTML output.
//!
//! Two rewrites happen here:
//!   1. `<a href="../../<pkg>/help/<topic>[#anchor]">` →
//!      `raven-help://topic/<pkg>/<topic>[#anchor]`, so the webview only
//!      needs to recognize one in-panel URL form.
//!   2. `<a href="/doc/manual/<basename>.html[#anchor]">` →
//!      `https://cran.r-project.org/doc/manuals/r-release/<basename>.html[#anchor]`
//!      for the canonical R manuals listed in `R_MANUAL_BASENAMES`, so
//!      external browsers can open them. Unknown basenames Drop.
//!
//! See the help-viewer spec ("Cross-reference link rewriting") for full rules.

use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use std::sync::OnceLock;

/// Canonical basenames of R's bundled manuals that CRAN serves at
/// `https://cran.r-project.org/doc/manuals/r-release/<basename>.html`.
///
/// Rd2HTML emits `<a href="/doc/manual/<basename>.html">` for `\link[<basename>:...]{...}`
/// references in Rd. The allowlist is intentionally conservative: it covers
/// the manuals shipped in `$R_HOME/doc/manual/` that CRAN mirrors under
/// `/doc/manuals/r-release/`. Other paths Rd2HTML might emit (notably
/// `rw-FAQ.html`, which CRAN serves under `/bin/windows/base/` instead)
/// fall through to `Drop` rather than producing a CRAN URL that 404s.
const R_MANUAL_BASENAMES: &[&str] = &[
    "R-admin", "R-data", "R-exts", "R-FAQ", "R-ints", "R-intro", "R-lang",
];

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
            HrefKind::Replace(url) => format!("{prefix}{url}{suffix}"),
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
    /// Replace the href with this fully-formed URL (typically an https:// link
    /// that downstream sanitization will pass through unchanged).
    Replace(String),
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
    // R's bundled manuals: Rd2HTML emits `<a href="/doc/manual/<basename>.html[#anchor]">`
    // for `\link[R-exts]{...}`, `\link[R-admin:section]{...}`, etc. The path
    // resolves on R's internal dynamic-help server but not in our webview;
    // map known basenames to the canonical CRAN URL so VS Code's webview
    // link handler opens them in the user's default browser. Without this,
    // the rewriter would Drop these and ammonia would then strip the
    // resulting `javascript:void(0)` href entirely, leaving a bare `<a>`
    // that the CSS still styles like a link but the browser renders with
    // an I-beam cursor and dead clicks.
    //
    // Unknown basenames (e.g. `rw-FAQ.html`, custom manuals) Drop rather
    // than synthesize a CRAN URL that would 404. See `R_MANUAL_BASENAMES`.
    if let Some(rest) = href.strip_prefix("/doc/manual/") {
        if let Some(url) = r_manual_cran_url(rest) {
            return HrefKind::Replace(url);
        }
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

/// Map a `/doc/manual/<rest>` tail to a CRAN URL if `<rest>` resolves to
/// `<basename>.html[#anchor]` for one of R's canonical bundled manuals.
///
/// Returns `None` for unknown basenames, missing `.html`, empty basenames,
/// or anything containing path separators after the basename — letting the
/// caller fall through to `Drop`. The anchor (if any) is run through the
/// same `canon_segment` decode-once-then-encode-once pipeline used for
/// help-topic anchors, so adversarial Rd cannot smuggle unsafe characters
/// into the URL.
fn r_manual_cran_url(rest: &str) -> Option<String> {
    let (basename_html, anchor) = match rest.split_once('#') {
        Some((bh, a)) => (bh, Some(a)),
        None => (rest, None),
    };
    let basename = basename_html.strip_suffix(".html")?;
    // The basename itself must be exactly one of the canonical manuals —
    // no path traversal, no slashes, no extra segments.
    if basename.contains('/') || basename.contains('\\') {
        return None;
    }
    if !R_MANUAL_BASENAMES.contains(&basename) {
        return None;
    }
    let mut url =
        format!("https://cran.r-project.org/doc/manuals/r-release/{basename}.html");
    if let Some(a) = anchor {
        url.push('#');
        url.push_str(&canon_segment(a));
    }
    Some(url)
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
        assert!(out.contains(r#"href="javascript:void(0)""#));
        assert!(out.contains(r#"data-raven-dropped="1""#));
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

    #[test]
    fn r_manual_link_rewritten_to_cran() {
        // Rd2HTML emits `<a href="/doc/manual/R-exts.html"><cite>...</cite></a>`
        // for cross-references to R's bundled manuals (e.g. `\link[R-exts]{...}`
        // in package.skeleton's References section). The absolute path
        // resolves on R's local dynamic-help server but not in our webview,
        // so previously the rewriter neutralized it to javascript:void(0)
        // — and ammonia then stripped that scheme entirely, leaving a bare
        // <a> with no href. The CSS still styled it as a link, but the
        // browser showed an I-beam cursor and clicks did nothing. Map these
        // paths to CRAN's canonical r-release URL so external browsers can
        // open them.
        let html =
            r#"Read the <a href="/doc/manual/R-exts.html"><cite>Writing R Extensions</cite></a>."#;
        let out = rewrite_help_html(html, "utils");
        assert!(
            out.contains(
                r#"<a href="https://cran.r-project.org/doc/manuals/r-release/R-exts.html""#
            ),
            "expected CRAN URL; got: {out}"
        );
        assert!(
            !out.contains("javascript:void(0)"),
            "must not neutralize R-manual links; got: {out}"
        );
        assert!(
            !out.contains("data-raven-dropped"),
            "must not mark R-manual links as dropped; got: {out}"
        );
    }

    #[test]
    fn r_manual_link_preserves_anchor() {
        // Anchors are commonly used to deep-link into a manual section,
        // e.g. `\link[R-admin:Installing-packages]{...}` in package.skeleton.
        let html = r#"<a href="/doc/manual/R-admin.html#Installing-packages">x</a>"#;
        let out = rewrite_help_html(html, "utils");
        assert!(
            out.contains(
                r#"<a href="https://cran.r-project.org/doc/manuals/r-release/R-admin.html#Installing-packages""#
            ),
            "expected anchor preserved in CRAN URL; got: {out}"
        );
    }

    #[test]
    fn r_manual_link_other_basenames() {
        // The mapping is not specific to R-exts; cover R-intro and R-FAQ
        // since they are common references too.
        for (path, expect) in [
            (
                "/doc/manual/R-intro.html",
                "https://cran.r-project.org/doc/manuals/r-release/R-intro.html",
            ),
            (
                "/doc/manual/R-FAQ.html#Why-doesn_0027t-R-have-X_003f",
                "https://cran.r-project.org/doc/manuals/r-release/R-FAQ.html#Why-doesn_0027t-R-have-X_003f",
            ),
        ] {
            let html = format!(r#"<a href="{path}">x</a>"#);
            let out = rewrite_help_html(&html, "base");
            assert!(
                out.contains(&format!(r#"<a href="{expect}""#)),
                "expected {expect}; got: {out}"
            );
        }
    }

    #[test]
    fn r_manual_link_survives_sanitizer() {
        // Regression for the I-beam-cursor bug: the rewriter's output must
        // also survive ammonia. https:// is on ammonia's url_schemes
        // allowlist, so this is the structural cure for the previous
        // pipeline (rewriter produced javascript:void(0) — ammonia stripped
        // it — bare <a>, no href, I-beam cursor).
        use crate::help::sanitize::sanitize_help_html;
        let raw =
            r#"Read the <a href="/doc/manual/R-exts.html"><cite>Writing R Extensions</cite></a>."#;
        let rewritten = rewrite_help_html(raw, "utils");
        let cleaned = sanitize_help_html(&rewritten);
        assert!(
            cleaned.contains(
                r#"href="https://cran.r-project.org/doc/manuals/r-release/R-exts.html""#
            ),
            "href must survive sanitization; got: {cleaned}"
        );
    }

    #[test]
    fn r_manual_link_idempotent() {
        // After the first rewrite, the href starts with `https://`, which
        // classify_href passes through. A second pass must be a no-op
        // (mirrors the existing `idempotent` test for the help-ref path).
        let html = r#"<a href="/doc/manual/R-exts.html#section">x</a>"#;
        let once = rewrite_help_html(html, "utils");
        let twice = rewrite_help_html(&once, "utils");
        assert_eq!(once, twice);
    }

    #[test]
    fn r_manual_link_anchor_is_canon_encoded() {
        // The anchor must go through canon_segment (decode-once /
        // encode-once) so adversarial Rd cannot smuggle structural chars
        // like `"`, `<`, or `>` into the constructed URL. Verify both
        // an unencoded special char and a percent-encoded form survive
        // as a canonical encoding.
        let html = r#"<a href="/doc/manual/R-exts.html#a%20b">x</a>"#;
        let out = rewrite_help_html(html, "utils");
        assert!(
            out.contains("#a%20b"),
            "percent-encoded space must round-trip as %20; got: {out}"
        );
        let html2 = r#"<a href="/doc/manual/R-exts.html#a b">x</a>"#;
        let out2 = rewrite_help_html(html2, "utils");
        assert!(
            out2.contains("#a%20b"),
            "literal space in anchor must be percent-encoded; got: {out2}"
        );
    }

    #[test]
    fn r_manual_link_unknown_basename_drops() {
        // Rd can reference custom manuals like \link[customdoc]{...},
        // which Rd2HTML would emit as /doc/manual/customdoc.html. CRAN
        // doesn't serve these, so we Drop rather than synthesize a 404.
        // Same goes for Windows-only docs like rw-FAQ.html, which CRAN
        // hosts under /bin/windows/base/ instead of /doc/manuals/r-release/.
        for path in [
            "/doc/manual/customdoc.html",
            "/doc/manual/rw-FAQ.html",
            "/doc/manual/UNKNOWN.html",
        ] {
            let html = format!(r#"<a href="{path}">x</a>"#);
            let out = rewrite_help_html(&html, "base");
            assert!(
                !out.contains("https://cran.r-project.org"),
                "unknown manual {path:?} must not synthesize a CRAN URL; got: {out}"
            );
            assert!(
                out.contains("javascript:void(0)"),
                "unknown manual {path:?} must Drop; got: {out}"
            );
            assert!(
                out.contains(r#"data-raven-dropped="1""#),
                "unknown manual {path:?} must be marked dropped; got: {out}"
            );
        }
    }

    #[test]
    fn r_manual_link_rejects_traversal_and_malformed() {
        // Defense-in-depth: the basename allowlist must reject anything
        // that isn't exactly `<basename>.html[#anchor]`. Path traversal,
        // extra segments, missing `.html`, and empty tails all Drop.
        for path in [
            "/doc/manual/../R-exts.html",     // traversal
            "/doc/manual/sub/R-exts.html",     // extra segment
            "/doc/manual/R-exts.html/extra",   // trailing segment
            "/doc/manual/R-exts",              // missing .html
            "/doc/manual/.html",               // empty basename
            "/doc/manual/",                    // empty rest
        ] {
            let html = format!(r#"<a href="{path}">x</a>"#);
            let out = rewrite_help_html(&html, "base");
            assert!(
                !out.contains("https://cran.r-project.org"),
                "malformed {path:?} must not produce a CRAN URL; got: {out}"
            );
        }
    }

    #[test]
    fn r_manual_link_html_substring_does_not_match() {
        // The rewriter must not accept hrefs that merely contain the
        // /doc/manual/ string anywhere — only those starting with it.
        let html = r#"<a href="https://evil/doc/manual/R-exts.html">x</a>"#;
        let out = rewrite_help_html(html, "base");
        // Should PassThrough as an https URL; original href intact.
        assert!(
            out.contains(r#"<a href="https://evil/doc/manual/R-exts.html">x</a>"#),
            "https URLs containing /doc/manual/ must pass through unchanged; got: {out}"
        );
    }

    #[test]
    fn dropped_unknown_path_renders_as_bare_anchor_after_sanitize() {
        // Documents the existing (intentionally unsupported) Drop +
        // ammonia interaction: for paths that aren't `../../<pkg>/help/...`
        // or a known R manual, the rewriter emits `javascript:void(0)` +
        // `data-raven-dropped="1"`, and ammonia then strips BOTH (the
        // `javascript:` scheme isn't on its url_schemes allowlist, and
        // `data-raven-dropped` isn't on the attribute allowlist), leaving
        // a bare `<a>` with no href.
        //
        // This is the failure mode the R-manual fix addresses for known
        // basenames. Linking it to a test pins the contract so a future
        // change to ammonia's allowlist (e.g. allowing the data attribute
        // through) doesn't silently fix this for unsupported paths without
        // a deliberate decision and accompanying click-handler check.
        use crate::help::sanitize::sanitize_help_html;
        let raw = r#"<a href="/some/unsupported/path">link</a>"#;
        let rewritten = rewrite_help_html(raw, "base");
        let cleaned = sanitize_help_html(&rewritten);
        assert!(
            !cleaned.contains("javascript:void(0)"),
            "ammonia must strip javascript: href; got: {cleaned}"
        );
        assert!(
            !cleaned.contains("data-raven-dropped"),
            "ammonia must strip data-raven-dropped; got: {cleaned}"
        );
        assert!(
            cleaned.contains(">link</a>"),
            "inner text must survive; got: {cleaned}"
        );
    }
}
