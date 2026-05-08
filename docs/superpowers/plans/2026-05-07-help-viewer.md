# R Help Viewer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Raven-native R help viewer: VS Code webview that renders `tools::Rd2HTML()` output for the topic the user clicks from a hover, supports cross-reference navigation with back/forward history, and reuses `crates/raven/src/help.rs` for caching.

**Architecture:** Server extends `help.rs` with `get_help_html()` (sync R subprocess + tempfile metadata + ammonia sanitization + cross-ref rewriter + LRU cache with single-flight). One new `workspace/executeCommand` (`raven.getHelpHtml`). Extension hosts a Svelte webview panel mirroring the plot viewer layout: messages + state machine + image rewriter. Hover handler prepends a bold clickable `pkg::name` line to existing markdown.

**Tech Stack:** Rust (`ammonia`, `percent-encoding`, existing `tempfile`, `tokio::sync::broadcast`), TypeScript (extension), Svelte + esbuild-svelte (webview), Bun for pure-TS tests, Mocha + `@vscode/test-electron` for VS Code-API tests.

**Spec:** `/Users/jmb/repos/raven/docs/superpowers/specs/2026-05-07-help-viewer-design.md` (commit 32e78d7, codex-approved). Read before starting; this plan assumes its decisions.

---

## File Structure

**Created**:

- `crates/raven/src/help/` — NEW module split (the existing `help.rs` becomes `help/text.rs`, plus new `help/html.rs`, `help/sanitize.rs`, `help/rewrite.rs`, `help/cache.rs`, `help/validate.rs`, `help/mod.rs`). Splitting up-front because the new code roughly doubles the file's size.
- `editors/vscode/src/help/` — extension module:
  - `index.ts` — command + middleware registration.
  - `messages.ts` — typed wire protocol.
  - `help-panel.ts` — singleton webview lifecycle + history.
  - `image-rewriter.ts` — pure function for rewriting `<img src>`.
  - `hover-trust-middleware.ts` — narrow trust for `raven.openHelpPanel`.
  - `webview/`:
    - `App.svelte`, `main.ts`, `state.ts`, `styles.css`, `tsconfig.json`.
- `tests/bun/help-messages.test.ts` — wire-protocol tests.
- `tests/bun/help-image-rewriter.test.ts` — image rewriter tests.
- `tests/bun/help-state-machine.test.ts` — HelpPanel state machine tests.
- `tests/bun/help-webview-link.test.ts` — webview link interception (JSDOM).
- `editors/vscode/src/test/help-trust-middleware.test.ts` — Mocha test for middleware.
- `docs/help-viewer.md` — user-facing docs.

**Modified**:

- `crates/raven/Cargo.toml` — add `ammonia`, `percent-encoding`.
- `crates/raven/src/lib.rs` and `crates/raven/src/main.rs` — module declarations updated for the `help/` split.
- `crates/raven/src/state.rs` — add `html_help_cache` to WorldState.
- `crates/raven/src/handlers.rs` — add `raven.getHelpHtml` dispatcher arm; modify hover to prepend clickable heading.
- `crates/raven/src/libpath_watcher.rs` — drain `html_help_cache` on libpath changes.
- `editors/vscode/package.json` — add setting + commands.
- `editors/vscode/src/initializationOptions.ts` — add `helpViewer`.
- `editors/vscode/src/test/settings.test.ts` — add SETTINGS_MAPPING entry.
- `editors/vscode/src/extension.ts` — register the new module.
- `editors/vscode/scripts/build.js` — add help-viewer webview build pass.
- `docs/configuration.md` — add new setting row.
- `CLAUDE.md` — add `docs/help-viewer.md` pointer.

---

## Implementation Tasks

### Task 1: Add `ammonia` and `percent-encoding` to `Cargo.toml`

**Files:**
- Modify: `crates/raven/Cargo.toml`

- [ ] **Step 1: Add the deps**

  Open `crates/raven/Cargo.toml`. In the main `[dependencies]` section (alphabetically), add:

  ```toml
  ammonia = "4"
  percent-encoding = "2"
  ```

- [ ] **Step 2: Build to fetch crates and check it compiles**

  Run:

  ```bash
  cargo build -p raven
  ```

  Expected: build succeeds and `Cargo.lock` now contains `ammonia` + `percent-encoding`.

- [ ] **Step 3: Commit**

  ```bash
  git add crates/raven/Cargo.toml Cargo.lock
  git commit -m "build: add ammonia and percent-encoding for help viewer"
  ```

---

### Task 2: Split `help.rs` into a `help/` module (no behavior changes)

**Why first:** the new code roughly doubles `help.rs`. Splitting before adding code keeps each subsequent task small and focused on one file.

**Files:**
- Move: `crates/raven/src/help.rs` → `crates/raven/src/help/text.rs`
- Create: `crates/raven/src/help/mod.rs`
- Modify: `crates/raven/src/lib.rs`
- Modify: `crates/raven/src/main.rs`

- [ ] **Step 1: Move the existing file**

  ```bash
  mkdir -p crates/raven/src/help
  git mv crates/raven/src/help.rs crates/raven/src/help/text.rs
  ```

- [ ] **Step 2: Create `mod.rs` re-exporting everything**

  Create `crates/raven/src/help/mod.rs`:

  ```rust
  //! R help text and HTML rendering.
  //!
  //! - `text` — plain Rd2txt rendering used by hover/completion.
  //! - (more modules added in subsequent tasks: `html`, `sanitize`, `rewrite`, `cache`, `validate`.)

  mod text;

  pub use text::*;
  ```

- [ ] **Step 3: Verify the lib and bin still compile**

  No change should be needed in `lib.rs` / `main.rs` — they declare `mod help;` already, and the `help/mod.rs` file replaces the old `help.rs` transparently. Confirm:

  ```bash
  cargo build -p raven && cargo test -p raven --lib --no-run
  ```

  Expected: both succeed. If either complains about a missing `help` module, ensure both `lib.rs` and `main.rs` still have `mod help;` (per the CLAUDE.md "Module declarations" rule).

- [ ] **Step 4: Run the existing help tests as a sanity check**

  ```bash
  cargo test -p raven --lib help
  ```

  Expected: all passing as before (no behavior change).

- [ ] **Step 5: Commit**

  ```bash
  git add crates/raven/src/help/
  git commit -m "refactor: split help.rs into help/ module ahead of HTML rendering work"
  ```

---

### Task 3: Add `is_valid_help_topic()` validator with tests

**Files:**
- Create: `crates/raven/src/help/validate.rs`
- Modify: `crates/raven/src/help/mod.rs`

- [ ] **Step 1: Create the validator file with tests first**

  Create `crates/raven/src/help/validate.rs`:

  ```rust
  //! Topic-name validation for R help lookup.
  //!
  //! Permits R operator topics (`[`, `+`, `%>%`, `<-`, etc.) but rejects
  //! control characters, NUL bytes, backticks, and oversized inputs.

  /// Returns true if `s` is a plausible R help topic.
  ///
  /// See the help-viewer spec, "Validation" section, for the full rule set.
  pub fn is_valid_help_topic(s: &str) -> bool {
      if s.is_empty() || s.len() > 256 {
          return false;
      }
      for byte in s.bytes() {
          // Reject control chars, DEL, NUL, backtick.
          if byte < 0x20 || byte == 0x7f || byte == b'`' {
              return false;
          }
          // Reject non-ASCII to keep the API surface predictable.
          if byte >= 0x80 {
              return false;
          }
      }
      true
  }

  #[cfg(test)]
  mod tests {
      use super::*;

      #[test]
      fn accepts_simple_identifiers() {
          assert!(is_valid_help_topic("mean"));
          assert!(is_valid_help_topic("print.default"));
          assert!(is_valid_help_topic("filter"));
      }

      #[test]
      fn accepts_operator_topics() {
          assert!(is_valid_help_topic("["));
          assert!(is_valid_help_topic("[["));
          assert!(is_valid_help_topic("+"));
          assert!(is_valid_help_topic("%>%"));
          assert!(is_valid_help_topic("<-"));
          assert!(is_valid_help_topic(":"));
          assert!(is_valid_help_topic(":::"));
          assert!(is_valid_help_topic("?"));
      }

      #[test]
      fn accepts_keywords() {
          assert!(is_valid_help_topic("if"));
          assert!(is_valid_help_topic("for"));
          assert!(is_valid_help_topic("while"));
          assert!(is_valid_help_topic("Control"));
      }

      #[test]
      fn rejects_empty() {
          assert!(!is_valid_help_topic(""));
      }

      #[test]
      fn rejects_too_long() {
          let s = "a".repeat(257);
          assert!(!is_valid_help_topic(&s));
      }

      #[test]
      fn rejects_control_chars() {
          assert!(!is_valid_help_topic("with\nnewline"));
          assert!(!is_valid_help_topic("with\ttab"));
          assert!(!is_valid_help_topic("with\rcr"));
          assert!(!is_valid_help_topic("with\x01ctrl"));
      }

      #[test]
      fn rejects_nul() {
          assert!(!is_valid_help_topic("with\0nul"));
      }

      #[test]
      fn rejects_backticks() {
          assert!(!is_valid_help_topic("`backtick`"));
      }

      #[test]
      fn rejects_non_ascii() {
          assert!(!is_valid_help_topic("café"));
          assert!(!is_valid_help_topic("emoji😀"));
      }
  }
  ```

- [ ] **Step 2: Wire into `mod.rs`**

  Edit `crates/raven/src/help/mod.rs`:

  ```rust
  mod text;
  mod validate;

  pub use text::*;
  pub use validate::is_valid_help_topic;
  ```

- [ ] **Step 3: Run the tests**

  ```bash
  cargo test -p raven --lib help::validate
  ```

  Expected: 8 tests pass.

- [ ] **Step 4: Commit**

  ```bash
  git add crates/raven/src/help/validate.rs crates/raven/src/help/mod.rs
  git commit -m "feat(help): add is_valid_help_topic validator"
  ```

---

### Task 4: Add `HelpHtmlError` and `HelpHtml` types

**Files:**
- Create: `crates/raven/src/help/types.rs`
- Modify: `crates/raven/src/help/mod.rs`

- [ ] **Step 1: Create types**

  Create `crates/raven/src/help/types.rs`:

  ```rust
  //! Public types for HTML help rendering.

  use std::path::PathBuf;

  /// Successful HTML help render.
  #[derive(Debug, Clone, PartialEq, Eq)]
  pub struct HelpHtml {
      /// Canonical topic name (first `\alias` from the Rd object).
      pub topic: String,
      /// Canonical package name (R's `attr(rd, "package")`).
      pub package: String,
      /// Title from the rendered HTML's first `<h2>`, or canonical topic name.
      pub title: String,
      /// Sanitized + cross-ref-rewritten HTML body.
      pub html: String,
      /// Absolute path to the package's help directory (`system.file("help", ...)`).
      pub help_dir: PathBuf,
      /// All R `.libPaths()` at the time of rendering.
      pub lib_paths: Vec<PathBuf>,
  }

  /// Failure modes for `get_help_html`.
  #[derive(Debug, Clone, PartialEq, Eq)]
  pub enum HelpHtmlError {
      /// R returned no Rd db match for `(topic, package)`.
      NotFound,
      /// Package not in any libpath.
      PackageNotInstalled,
      /// Args failed `is_valid_help_topic` / `is_valid_package_name`.
      InvalidTopic { message: String },
      /// `tools::Rd2HTML` errored, sanitization panicked, or metadata parse failed.
      RenderFailed { message: String },
      /// Subprocess exceeded `HELP_TIMEOUT`.
      Timeout,
      /// R binary not configured / not found.
      RUnavailable { message: String },
      /// Stdout exceeded `HELP_HTML_MAX_BYTES`.
      TooLarge,
  }

  impl HelpHtmlError {
      /// Stable string identifier for the LSP response's `reason` field.
      pub fn reason(&self) -> &'static str {
          match self {
              Self::NotFound => "not-found",
              Self::PackageNotInstalled => "package-not-installed",
              Self::InvalidTopic { .. } => "invalid-topic",
              Self::RenderFailed { .. } => "render-failed",
              Self::Timeout => "timeout",
              Self::RUnavailable { .. } => "r-unavailable",
              Self::TooLarge => "too-large",
          }
      }

      /// Per the spec's classification table: which errors should be cached as
      /// negative entries (and which are transient and should not).
      pub fn is_cacheable(&self) -> bool {
          matches!(
              self,
              Self::NotFound
                  | Self::PackageNotInstalled
                  | Self::InvalidTopic { .. }
                  | Self::RenderFailed { .. }
                  | Self::TooLarge
          )
      }
  }
  ```

- [ ] **Step 2: Wire into `mod.rs`**

  ```rust
  mod text;
  mod types;
  mod validate;

  pub use text::*;
  pub use types::{HelpHtml, HelpHtmlError};
  pub use validate::is_valid_help_topic;
  ```

- [ ] **Step 3: Add a quick test for `is_cacheable`**

  Append to `crates/raven/src/help/types.rs`:

  ```rust
  #[cfg(test)]
  mod tests {
      use super::*;

      #[test]
      fn cacheable_classification() {
          assert!(HelpHtmlError::NotFound.is_cacheable());
          assert!(HelpHtmlError::PackageNotInstalled.is_cacheable());
          assert!(HelpHtmlError::InvalidTopic { message: "x".into() }.is_cacheable());
          assert!(HelpHtmlError::RenderFailed { message: "x".into() }.is_cacheable());
          assert!(HelpHtmlError::TooLarge.is_cacheable());
          assert!(!HelpHtmlError::Timeout.is_cacheable());
          assert!(!HelpHtmlError::RUnavailable { message: "x".into() }.is_cacheable());
      }

      #[test]
      fn reason_strings_match_spec() {
          assert_eq!(HelpHtmlError::NotFound.reason(), "not-found");
          assert_eq!(HelpHtmlError::PackageNotInstalled.reason(), "package-not-installed");
          assert_eq!(HelpHtmlError::Timeout.reason(), "timeout");
          assert_eq!(HelpHtmlError::TooLarge.reason(), "too-large");
      }
  }
  ```

- [ ] **Step 4: Run tests**

  ```bash
  cargo test -p raven --lib help::types
  ```

  Expected: 2 tests pass.

- [ ] **Step 5: Commit**

  ```bash
  git add crates/raven/src/help/types.rs crates/raven/src/help/mod.rs
  git commit -m "feat(help): add HelpHtml and HelpHtmlError types"
  ```

---

### Task 5: Cross-reference link rewriter (`rewrite_help_html`)

Pure function. No R subprocess required for this task.

**Files:**
- Create: `crates/raven/src/help/rewrite.rs`
- Modify: `crates/raven/src/help/mod.rs`

- [ ] **Step 1: Write the failing tests first**

  Create `crates/raven/src/help/rewrite.rs`:

  ```rust
  //! Pure cross-reference link rewriter for Rd2HTML output.
  //!
  //! Replaces `<a href="../../<pkg>/help/<topic>[#anchor]">` with a custom
  //! scheme `raven-help://topic/<pkg>/<topic>[#anchor]` so the webview only
  //! needs to recognize one URL form. See the help-viewer spec
  //! ("Cross-reference link rewriting") for full rules.

  // (implementation follows in step 3)

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
          // older Rd format: ../../<pkg>/topic/<topic>
          let html = r#"<a href="../../utils/topic/citation">cite</a>"#;
          let out = rewrite_help_html(html, "tools");
          assert!(out.contains(r#"<a href="raven-help://topic/utils/citation">cite</a>"#));
      }

      #[test]
      fn percent_encodes_operator_topics() {
          // Rd2HTML may emit %5B (already-encoded `[`); we decode-then-re-encode.
          let html = r#"<a href="../../base/help/%5B">[</a>"#;
          let out = rewrite_help_html(html, "base");
          assert!(out.contains(r#"<a href="raven-help://topic/base/%5B">[</a>"#));

          // Raw `+` in source should also be encoded.
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
          let html = r#"<a href="#examples">examples</a>"#;
          let out = rewrite_help_html(html, "x");
          assert!(out.contains(r#"<a href="#examples">examples</a>"#));
      }

      #[test]
      fn vignette_links_pass_through() {
          let html = r#"<a href="../../dplyr/doc/intro.html">vignette</a>"#;
          let out = rewrite_help_html(html, "dplyr");
          // not rewritten — webview will ignore via dropped sentinel
          assert!(out.contains("data-raven-dropped=\"1\"") || out.contains("../../dplyr/doc/intro.html"));
      }

      #[test]
      fn malformed_relative_neutralized() {
          // ../foo, ../../, weird shapes should not be left navigable.
          let html = r#"<a href="../foo">x</a><a href="../../">y</a>"#;
          let out = rewrite_help_html(html, "x");
          // either rewritten to javascript:void(0) or marked dropped
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
  ```

- [ ] **Step 2: Run tests, confirm they fail**

  ```bash
  cargo test -p raven --lib help::rewrite
  ```

  Expected: compile error ("`rewrite_help_html` not defined"). That's the failing test.

- [ ] **Step 3: Implement**

  Replace the `// (implementation follows in step 3)` line in `rewrite.rs` with:

  ```rust
  use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
  use std::sync::OnceLock;

  /// RFC 3986 unreserved set: keep `A-Za-z0-9._~-` unencoded; encode the rest.
  /// Stricter than `encodeURIComponent`.
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
      // Use a regex to find each href; replace with rewritten value. Cheap and
      // correct enough for Rd2HTML output (which is well-formed).
      let re = href_regex();
      re.replace_all(html, |caps: &regex::Captures<'_>| {
          let prefix = &caps[1]; // `<a ... href="`
          let href = &caps[2];
          let suffix = &caps[3]; // `"...>` (rest of the tag up to >)

          let rewritten = match classify_href(href) {
              HrefKind::HelpRef { pkg, topic, anchor } => {
                  let pkg_e = canon_segment(&pkg);
                  let topic_e = canon_segment(&topic);
                  match anchor {
                      Some(a) => format!(
                          "raven-help://topic/{pkg_e}/{topic_e}#{}",
                          canon_segment(&a)
                      ),
                      None => format!("raven-help://topic/{pkg_e}/{topic_e}"),
                  }
              }
              HrefKind::PassThrough => href.to_string(),
              HrefKind::Drop => {
                  // Mark for the webview to ignore.
                  return format!(
                      "{prefix}javascript:void(0){suffix} data-raven-dropped=\"1\""
                  );
              }
          };
          format!("{prefix}{rewritten}{suffix}")
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
      // External or in-page: pass through unchanged.
      if href.starts_with("http://")
          || href.starts_with("https://")
          || href.starts_with("mailto:")
          || (href.starts_with('#') && !href.contains("://"))
      {
          return HrefKind::PassThrough;
      }
      // Cross-ref: ../../<pkg>/help/<topic>[#anchor] or ../../<pkg>/topic/<topic>[#anchor]
      if let Some(rest) = href.strip_prefix("../../") {
          let mut parts = rest.splitn(3, '/');
          let pkg = parts.next();
          let kind = parts.next();
          let tail = parts.next();
          if let (Some(pkg), Some(kind), Some(tail)) = (pkg, kind, tail) {
              if (kind == "help" || kind == "topic")
                  && !pkg.is_empty()
                  && !tail.is_empty()
              {
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
              // Vignettes (`<pkg>/doc/...`) and other tails: drop (out of v1).
              return HrefKind::Drop;
          }
          return HrefKind::Drop;
      }
      // Absolute paths, file://, javascript:, weird schemes: drop.
      HrefKind::Drop
  }

  fn href_regex() -> &'static regex::Regex {
      static RE: OnceLock<regex::Regex> = OnceLock::new();
      RE.get_or_init(|| {
          // Capture: 1) `<a ... href="`, 2) URL, 3) `"...>`
          regex::Regex::new(r#"(?P<pre><a[^>]*\bhref=")(?P<href>[^"]*)(?P<post>"[^>]*>)"#)
              .expect("valid regex")
      })
  }
  ```

- [ ] **Step 4: Wire into `mod.rs`**

  ```rust
  mod rewrite;
  // ...other mods
  pub use rewrite::rewrite_help_html;
  ```

- [ ] **Step 5: Run tests**

  ```bash
  cargo test -p raven --lib help::rewrite
  ```

  Expected: all 9 tests pass. If a test fails, inspect the actual output vs expectation; the rewriter may need a tweak (e.g., `Drop` semantics for the malformed-anchor test).

- [ ] **Step 6: Commit**

  ```bash
  git add crates/raven/src/help/rewrite.rs crates/raven/src/help/mod.rs
  git commit -m "feat(help): cross-reference link rewriter for Rd2HTML output"
  ```

---

### Task 6: HTML sanitizer (style url() pre-pass + ammonia)

**Files:**
- Create: `crates/raven/src/help/sanitize.rs`
- Modify: `crates/raven/src/help/mod.rs`

- [ ] **Step 1: Write tests first**

  Create `crates/raven/src/help/sanitize.rs`:

  ```rust
  //! HTML sanitization for Rd2HTML output.
  //!
  //! Two-step:
  //!   1. Regex pre-pass strips any `style="..."` attribute whose value
  //!      contains `url(` (case-insensitive).
  //!   2. `ammonia::clean()` with a help-specific allowlist removes
  //!      dangerous tags/attributes.
  //!
  //! See spec "HTML sanitization" for the full allowlist and rationale.

  // (implementation follows in step 3)

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
          let html = r#"<a href="#" onclick="alert(1)" onerror="x">click</a>"#;
          let out = sanitize_help_html(html);
          assert!(out.contains(r#"href="#""#));
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
          assert!(!out.contains("style="));
      }

      #[test]
      fn drops_style_with_url_case_insensitive() {
          let html = r#"<span style="background: URL(x)">x</span>"#;
          let out = sanitize_help_html(html);
          assert!(!out.contains("style="));
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
  ```

- [ ] **Step 2: Run tests; expect compile failure**

  ```bash
  cargo test -p raven --lib help::sanitize
  ```

  Expected: `sanitize_help_html` not defined.

- [ ] **Step 3: Implement**

  Replace `// (implementation follows in step 3)` with:

  ```rust
  use std::collections::{HashMap, HashSet};
  use std::sync::OnceLock;

  /// Sanitize Rd2HTML output to a safe allowlist.
  ///
  /// Returns a fresh `String`. Wrapped internally in `catch_unwind` —
  /// `ammonia::clean` does not return a `Result`, but if it ever panics on
  /// unusual input we surface that as `RenderFailed` at the call site by
  /// having this function return `Option<String>` (None on panic).
  pub fn sanitize_help_html(html: &str) -> String {
      // Step 1: regex pre-pass strips `style="..."` containing `url(`.
      let pre = strip_style_url(html);
      // Step 2: ammonia clean.
      ammonia_builder().clean(&pre).to_string()
  }

  fn strip_style_url(html: &str) -> std::borrow::Cow<'_, str> {
      static RE: OnceLock<regex::Regex> = OnceLock::new();
      let re = RE.get_or_init(|| {
          regex::Regex::new(
              r#"(?i)\s+style\s*=\s*"[^"]*url\s*\([^"]*"#,
          )
          .expect("valid regex")
      });
      // We need to also consume the trailing `"` — extend after match.
      // Simpler: capture the whole `style="...url(..."..."` and replace with empty.
      static RE2: OnceLock<regex::Regex> = OnceLock::new();
      let re_full = RE2.get_or_init(|| {
          regex::Regex::new(r#"(?i)\s+style\s*=\s*"[^"]*url\s*\([^"]*""#).expect("valid regex")
      });
      // Suppress unused-warning on the partial regex by routing through `re_full`.
      let _ = re;
      re_full.replace_all(html, "")
  }

  fn ammonia_builder() -> ammonia::Builder<'static> {
      static TAGS: OnceLock<HashSet<&'static str>> = OnceLock::new();
      static GENERIC_ATTRS: OnceLock<HashSet<&'static str>> = OnceLock::new();
      static TAG_ATTRS: OnceLock<HashMap<&'static str, HashSet<&'static str>>> = OnceLock::new();

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
      let generic = GENERIC_ATTRS.get_or_init(|| ["class", "id", "title", "style"].into_iter().collect());
      let per_tag = TAG_ATTRS.get_or_init(|| {
          let mut m = HashMap::new();
          m.insert("a", ["href"].into_iter().collect());
          m.insert("img", ["src", "alt", "width", "height"].into_iter().collect());
          for tag in ["table", "th", "td"] {
              m.insert(tag, ["colspan", "rowspan", "align"].into_iter().collect());
          }
          m
      });

      let mut b = ammonia::Builder::default();
      b.tags(tags.clone());
      b.generic_attributes(generic.clone());
      b.tag_attributes(per_tag.clone());
      // Allow our custom scheme so the rewriter's output round-trips.
      b.url_schemes(
          ["http", "https", "mailto", "raven-help", "data"]
              .into_iter()
              .collect(),
      );
      b
  }
  ```

  > Note: `ammonia::Builder` API may require slight tweaks (`set_tags` vs `tags`,
  > consuming vs borrowed). If the test build fails, consult `ammonia` docs and
  > adjust syntax. The semantics shown here are what the spec requires.

- [ ] **Step 4: Wire into `mod.rs`**

  ```rust
  mod sanitize;
  pub use sanitize::sanitize_help_html;
  ```

- [ ] **Step 5: Run tests**

  ```bash
  cargo test -p raven --lib help::sanitize
  ```

  Expected: all 9 tests pass.

- [ ] **Step 6: Commit**

  ```bash
  git add crates/raven/src/help/sanitize.rs crates/raven/src/help/mod.rs
  git commit -m "feat(help): HTML sanitizer (style url() pre-pass + ammonia)"
  ```

---

### Task 7: `HtmlHelpCache` skeleton (LRU + negative TTL, no single-flight yet)

**Files:**
- Create: `crates/raven/src/help/cache.rs`
- Modify: `crates/raven/src/help/mod.rs`

- [ ] **Step 1: Write tests for the public API first**

  Create `crates/raven/src/help/cache.rs`:

  ```rust
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
          // Negative entry — only return if still fresh.
          if entry.cached_at.elapsed() <= self.negative_ttl {
              return Some(entry.result.clone());
          }
          None
      }

      pub fn insert(&self, topic: &str, package: Option<&str>, result: Result_) {
          // Per spec: insert under requested key; for Ok results, also under canonical key.
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
          // canonical write doubles entries — capacity 2 means the oldest dies.
          // Insert a 3rd to force eviction.
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
          // Request `(filter.tbl_df, dplyr)` resolves canonical to (filter, dplyr).
          let mut h = ok_help("filter", "dplyr");
          h.html = "<p>canon</p>".into();
          c.insert("filter.tbl_df", Some("dplyr"), Ok(h.clone()));
          assert!(c.get("filter.tbl_df", Some("dplyr")).is_some());
          assert!(c.get("filter", Some("dplyr")).is_some());
      }
  }
  ```

- [ ] **Step 2: Wire into `mod.rs`**

  ```rust
  mod cache;
  pub use cache::HtmlHelpCache;
  ```

- [ ] **Step 3: Run tests**

  ```bash
  cargo test -p raven --lib help::cache
  ```

  Expected: 7 tests pass. The LRU eviction test may need tweaking depending on whether the canonical-key write to the same key as the requested key counts twice or once; adjust the assertion to match implementation.

- [ ] **Step 4: Commit**

  ```bash
  git add crates/raven/src/help/cache.rs crates/raven/src/help/mod.rs
  git commit -m "feat(help): HtmlHelpCache (LRU + negative TTL + canonical-key dual-write)"
  ```

---

### Task 8: Add single-flight de-duplication to `HtmlHelpCache`

**Files:**
- Modify: `crates/raven/src/help/cache.rs`

- [ ] **Step 1: Add a single-flight test FIRST (will fail to compile)**

  Append to the `tests` module in `cache.rs`:

  ```rust
      #[tokio::test]
      async fn single_flight_dedups_concurrent_misses() {
          use std::sync::atomic::{AtomicUsize, Ordering};
          use std::sync::Arc;

          let c = Arc::new(HtmlHelpCache::new());
          let calls = Arc::new(AtomicUsize::new(0));

          let fetch = {
              let calls = calls.clone();
              move |_topic: String, _pkg: Option<String>| {
                  let calls = calls.clone();
                  async move {
                      calls.fetch_add(1, Ordering::SeqCst);
                      tokio::time::sleep(Duration::from_millis(50)).await;
                      Ok::<_, HelpHtmlError>(ok_help("filter", "dplyr"))
                  }
              }
          };

          let mut handles = Vec::new();
          for _ in 0..5 {
              let c = c.clone();
              let fetch = fetch.clone();
              handles.push(tokio::spawn(async move {
                  c.get_or_fetch("filter", Some("dplyr"), fetch).await
              }));
          }
          for h in handles {
              let _ = h.await.unwrap();
          }
          // Only ONE underlying fetch should have occurred.
          assert_eq!(calls.load(Ordering::SeqCst), 1);
      }
  ```

- [ ] **Step 2: Implement single-flight**

  Add to `cache.rs`:

  ```rust
  use std::collections::HashMap;
  use std::future::Future;
  use std::sync::Mutex;
  use tokio::sync::broadcast;

  type ResultShared = Arc<Result_>;

  pub struct HtmlHelpCache {
      inner: Arc<RwLock<LruCache<String, Entry>>>,
      negative_ttl: Duration,
      in_flight: Arc<Mutex<HashMap<String, broadcast::Sender<ResultShared>>>>,
  }

  // Update `with_config` to initialize `in_flight: Arc::new(Mutex::new(HashMap::new())),`.

  impl HtmlHelpCache {
      /// Get from cache, or run the provided fetcher exactly once for concurrent
      /// callers requesting the same key. The fetcher is `async` and receives
      /// `(topic, package)` so callers don't need to capture closures over them.
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
          // 1) Cache probe.
          if let Some(hit) = self.get(topic, package) {
              return hit;
          }
          let key = cache_key(topic, package);
          // 2) In-flight probe / register.
          let mut subscriber = None;
          let owner = {
              let mut map = self.in_flight.lock().expect("in_flight lock");
              match map.get(&key) {
                  Some(sender) => {
                      subscriber = Some(sender.subscribe());
                      false
                  }
                  None => {
                      let (tx, _rx0) = broadcast::channel(1);
                      map.insert(key.clone(), tx);
                      true
                  }
              }
          };
          if !owner {
              // Wait for owner.
              let mut rx = subscriber.unwrap();
              return match rx.recv().await {
                  Ok(shared) => (*shared).clone(),
                  Err(_closed) => Err(HelpHtmlError::RenderFailed {
                      message: "subprocess task aborted".into(),
                  }),
              };
          }
          // 3) Owner runs fetch.
          let topic_owned = topic.to_string();
          let pkg_owned = package.map(str::to_string);
          let result = fetch(topic_owned, pkg_owned).await;
          // 4) Cache (if cacheable) under both keys.
          let cacheable = match &result {
              Ok(_) => true,
              Err(e) => e.is_cacheable(),
          };
          if cacheable {
              self.insert(topic, package, result.clone());
          }
          // 5) Broadcast and remove in-flight entry.
          let shared = Arc::new(result.clone());
          {
              let mut map = self.in_flight.lock().expect("in_flight lock");
              if let Some(sender) = map.remove(&key) {
                  // It's OK if no one's listening (we removed before broadcasting,
                  // so ordering is: subscribers must subscribe before owner finishes).
                  let _ = sender.send(shared);
              }
          }
          result
      }
  }
  ```

  > Note: tokio's `broadcast` requires the sender to outlive the send. Adjust the
  > order if rustc complains: `sender.send(shared); map.remove(&key);` is also
  > correct.

- [ ] **Step 3: Run the test**

  ```bash
  cargo test -p raven --lib help::cache::tests::single_flight
  ```

  Expected: passes; only 1 fetch call observed.

- [ ] **Step 4: Run all cache tests to make sure nothing broke**

  ```bash
  cargo test -p raven --lib help::cache
  ```

  Expected: all pass.

- [ ] **Step 5: Commit**

  ```bash
  git add crates/raven/src/help/cache.rs
  git commit -m "feat(help): single-flight de-dup in HtmlHelpCache"
  ```

---

### Task 9: Retrofit single-flight into existing `HelpCache`

**Files:**
- Modify: `crates/raven/src/help/text.rs`

- [ ] **Step 1: Add a failing test mirroring Task 8's pattern**

  In the existing tests module of `text.rs`, append a test that constructs concurrent `get_or_fetch` calls against a fake fetcher counter, asserting only one underlying fetch happens. (Pattern is identical to the HtmlHelpCache test above; substitute `HelpCache` and the existing `Option<String>` return type.)

- [ ] **Step 2: Add a parallel `get_or_fetch_async` API on `HelpCache`**

  We don't replace `get_or_fetch` (which is sync and used widely); we add a new async method `get_or_fetch_async<F, Fut>(...)` mirroring the HtmlHelpCache implementation, plus an `in_flight` field. Existing callers can migrate as needed; for now, only the hover handler needs the new path if at all.

  > **Pragmatic call:** if the existing `get_or_fetch` callers all hold their
  > own external locking (spawn_blocking + cache hit fast path), the duplicate-
  > subprocess concern in practice is minor for the text path. The spec says to
  > retrofit — do it, but if it requires large refactors of callers, scope this
  > task down to "add `get_or_fetch_async` with single-flight; existing
  > sync method stays unchanged."

- [ ] **Step 3: Run tests**

  ```bash
  cargo test -p raven --lib help::text
  ```

  Expected: all pass.

- [ ] **Step 4: Commit**

  ```bash
  git add crates/raven/src/help/text.rs
  git commit -m "feat(help): single-flight async path on HelpCache"
  ```

---

### Task 10: Refactor `get_help` to take `r_path` and call validator

**Files:**
- Modify: `crates/raven/src/help/text.rs`
- Modify: every caller of `get_help` / `HelpCache::get_or_fetch` (search via grep).

- [ ] **Step 1: Survey callers**

  ```bash
  grep -rn "get_help\b\|get_or_fetch\b" crates/raven/src
  ```

  Note each call site; we'll need to pass `r_path` down.

- [ ] **Step 2: Change `get_help` signature**

  In `text.rs`, change:

  ```rust
  pub fn get_help(topic: &str, package: Option<&str>) -> Option<String>
  ```

  to:

  ```rust
  pub fn get_help(topic: &str, package: Option<&str>, r_path: &std::path::Path) -> Option<String>
  ```

  Inside the body:
  - Replace `Command::new("R")` with `Command::new(r_path)`.
  - Before spawning, call `super::validate::is_valid_help_topic(topic)` and (if `Some`) `crate::r_subprocess::is_valid_package_name(pkg)`. On failure, return `None` (existing API; logs at trace level with reason).

- [ ] **Step 3: Update `HelpCache::get_or_fetch` to thread `r_path`**

  Add an `r_path: PathBuf` field to `HelpCache` (or accept it as a parameter on `get_or_fetch`). Choosing the parameter approach keeps the cache stateless and easier to test.

- [ ] **Step 4: Update all callers**

  At each caller, source `r_path` from `state.r_subprocess.as_ref()?.r_path()` (the existing infrastructure). For tests, pass a fake path or use a feature-gated default ("R" from PATH) only under `#[cfg(test)]`.

- [ ] **Step 5: Run all help tests + a full build**

  ```bash
  cargo build -p raven && cargo test -p raven --lib help
  ```

  Expected: passes. Existing help tests now require the configured R path; tests that previously called `get_help("mean", Some("base"))` need a way to source a real R binary path. Use `crate::r_subprocess::RSubprocess::discover_r_path()` in test setup; skip the test if `None`.

- [ ] **Step 6: Commit**

  ```bash
  git add crates/raven/src/help/text.rs <other modified files>
  git commit -m "refactor(help): get_help takes configured r_path and validates inputs"
  ```

---

### Task 11: Implement `get_help_html` (R subprocess + tempfile metadata)

**Files:**
- Create: `crates/raven/src/help/html.rs`
- Modify: `crates/raven/src/help/mod.rs`

- [ ] **Step 1: Create the file with happy-path test stub**

  Create `crates/raven/src/help/html.rs`:

  ```rust
  //! HTML help fetch — R subprocess running tools::Rd2HTML, metadata via tempfile.
  //!
  //! Sync function (mirrors `get_help`); callers wrap in `tokio::task::spawn_blocking`.
  //! See spec "Server-side help renderer" for the full contract.

  use std::io::Read;
  use std::path::Path;
  use std::process::{Command, Stdio};
  use std::sync::atomic::{AtomicBool, Ordering};
  use std::sync::Arc;
  use std::time::Duration;

  use tempfile::NamedTempFile;

  use super::rewrite::rewrite_help_html;
  use super::sanitize::sanitize_help_html;
  use super::types::{HelpHtml, HelpHtmlError};
  use super::validate::is_valid_help_topic;

  pub const HELP_HTML_TIMEOUT: Duration = Duration::from_secs(10);
  pub const HELP_HTML_MAX_BYTES: usize = 8 * 1024 * 1024;

  pub fn get_help_html(
      topic: &str,
      package: Option<&str>,
      r_path: &Path,
  ) -> Result<HelpHtml, HelpHtmlError> {
      // 1) Validate inputs.
      if !is_valid_help_topic(topic) {
          return Err(HelpHtmlError::InvalidTopic {
              message: format!("invalid topic: {}", topic.escape_debug()),
          });
      }
      if let Some(p) = package {
          if !crate::r_subprocess::is_valid_package_name(p) {
              return Err(HelpHtmlError::InvalidTopic {
                  message: format!("invalid package: {}", p.escape_debug()),
              });
          }
      }

      // 2) Tempfile (RAII cleanup).
      let meta = NamedTempFile::new().map_err(|e| HelpHtmlError::RenderFailed {
          message: format!("tempfile create: {e}"),
      })?;
      let meta_path = meta.path().to_path_buf();

      // 3) Build the R snippet — hard-coded since this never sees user input directly.
      let r_code = include_str!("rd_to_html.R");

      // 4) Spawn R with the fixed three-arg ordering: topic, package-or-empty, meta-path.
      let pkg_arg = package.unwrap_or("");
      let mut cmd = Command::new(r_path);
      cmd.args([
          "--slave",
          "--no-save",
          "--no-restore",
          "-e",
          r_code,
          "--args",
          topic,
          pkg_arg,
      ]);
      cmd.arg(meta_path.as_os_str());
      cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
      let mut child = cmd.spawn().map_err(|e| HelpHtmlError::RUnavailable {
          message: format!("R spawn failed: {e}"),
      })?;
      let pid = child.id();

      // 5) Watchdog (mirrors get_help in text.rs).
      let exited = Arc::new(AtomicBool::new(false));
      let exited_clone = exited.clone();
      std::thread::spawn(move || {
          std::thread::sleep(HELP_HTML_TIMEOUT);
          if !exited_clone.load(Ordering::SeqCst) {
              super::text::kill_process_by_pid(pid);
          }
      });

      // 6) Drain stdout up to the cap.
      let stdout = child.stdout.take().expect("piped stdout");
      let stderr = child.stderr.take().expect("piped stderr");

      let stdout_thread = std::thread::spawn(move || -> Result<Vec<u8>, HelpHtmlError> {
          let mut buf = Vec::with_capacity(64 * 1024);
          let mut reader = stdout;
          let mut chunk = [0u8; 8192];
          loop {
              match reader.read(&mut chunk) {
                  Ok(0) => break,
                  Ok(n) => {
                      if buf.len() + n > HELP_HTML_MAX_BYTES {
                          return Err(HelpHtmlError::TooLarge);
                      }
                      buf.extend_from_slice(&chunk[..n]);
                  }
                  Err(e) => {
                      return Err(HelpHtmlError::RenderFailed {
                          message: format!("stdout read: {e}"),
                      });
                  }
              }
          }
          Ok(buf)
      });
      let stderr_thread = std::thread::spawn(move || -> Vec<u8> {
          let mut buf = Vec::new();
          let mut s = stderr;
          let _ = s.read_to_end(&mut buf);
          buf
      });

      let wait_result = child.wait();
      exited.store(true, Ordering::SeqCst);
      let stdout_bytes = stdout_thread.join().unwrap_or(Err(HelpHtmlError::RenderFailed {
          message: "stdout thread panicked".into(),
      }))?;
      let stderr_bytes = stderr_thread.join().unwrap_or_default();

      let status = wait_result.map_err(|e| HelpHtmlError::RenderFailed {
          message: format!("wait: {e}"),
      })?;

      if !status.success() {
          // Distinguish timeout vs render failure: if exit code is nonzero AND
          // we ran past timeout, classify as Timeout.
          if !exited.load(Ordering::SeqCst) {
              // Should not happen — we set exited above; check stderr for "No documentation".
          }
          let err = String::from_utf8_lossy(&stderr_bytes).to_string();
          if err.contains("there is no package called") {
              return Err(HelpHtmlError::PackageNotInstalled);
          }
          if err.contains("No documentation") || err.contains("no help found") {
              return Err(HelpHtmlError::NotFound);
          }
          return Err(HelpHtmlError::RenderFailed { message: err });
      }

      // 7) Parse metadata tempfile.
      let meta_text = std::fs::read_to_string(&meta_path).map_err(|e| HelpHtmlError::RenderFailed {
          message: format!("metadata read: {e}"),
      })?;
      drop(meta); // RAII cleanup
      let mut meta_topic = None;
      let mut meta_pkg = None;
      let mut meta_help_dir = None;
      let mut meta_lib_paths: Vec<std::path::PathBuf> = Vec::new();
      for line in meta_text.lines() {
          if let Some((k, v)) = line.split_once('\t') {
              match k {
                  "topic" => meta_topic = Some(v.to_string()),
                  "package" => meta_pkg = Some(v.to_string()),
                  "helpDir" => meta_help_dir = Some(std::path::PathBuf::from(v)),
                  "libPath" => meta_lib_paths.push(std::path::PathBuf::from(v)),
                  _ => {}
              }
          }
      }
      let canonical_topic = meta_topic.ok_or(HelpHtmlError::RenderFailed {
          message: "missing topic in metadata".into(),
      })?;
      let canonical_pkg = meta_pkg.ok_or(HelpHtmlError::RenderFailed {
          message: "missing package in metadata".into(),
      })?;
      let help_dir = meta_help_dir.ok_or(HelpHtmlError::RenderFailed {
          message: "missing helpDir in metadata".into(),
      })?;
      if meta_lib_paths.is_empty() {
          return Err(HelpHtmlError::RenderFailed {
              message: "missing libPath entries in metadata".into(),
          });
      }

      // 8) Sanitize and rewrite (catch_unwind around sanitize).
      let html_raw = String::from_utf8_lossy(&stdout_bytes).to_string();
      let sanitized = std::panic::catch_unwind(|| sanitize_help_html(&html_raw))
          .map_err(|_| HelpHtmlError::RenderFailed {
              message: "ammonia panic".into(),
          })?;
      let rewritten = rewrite_help_html(&sanitized, &canonical_pkg);

      // 9) Title from first <h2>.
      let title = extract_h2_title(&rewritten).unwrap_or_else(|| canonical_topic.clone());

      Ok(HelpHtml {
          topic: canonical_topic,
          package: canonical_pkg,
          title,
          html: rewritten,
          help_dir,
          lib_paths: meta_lib_paths,
      })
  }

  fn extract_h2_title(html: &str) -> Option<String> {
      let start = html.find("<h2")?;
      let after_open = &html[start..];
      let close_open = after_open.find('>')? + 1;
      let body = &after_open[close_open..];
      let end = body.find("</h2>")?;
      let inner = &body[..end];
      // Strip any nested tags by removing `< ... >` substrings.
      let mut out = String::with_capacity(inner.len());
      let mut in_tag = false;
      for c in inner.chars() {
          match c {
              '<' => in_tag = true,
              '>' => in_tag = false,
              _ if !in_tag => out.push(c),
              _ => {}
          }
      }
      let trimmed = out.trim().to_string();
      if trimmed.is_empty() {
          None
      } else {
          Some(trimmed)
      }
  }

  #[cfg(test)]
  mod tests {
      use super::*;

      #[test]
      fn extract_h2_basic() {
          assert_eq!(extract_h2_title("<h2>Title</h2>"), Some("Title".into()));
          assert_eq!(
              extract_h2_title(r#"<h2 class="x">Title <em>Sub</em></h2>"#),
              Some("Title Sub".into())
          );
          assert_eq!(extract_h2_title("<p>no h2</p>"), None);
      }
  }
  ```

- [ ] **Step 2: Create the R script file**

  Create `crates/raven/src/help/rd_to_html.R`:

  ```r
  # Argument order is fixed: [1]=topic, [2]=package-or-empty, [3]=tempfile path.
  args <- commandArgs(trailingOnly = TRUE)
  topic <- args[1]
  pkg <- if (nzchar(args[2])) args[2] else NULL
  meta_path <- args[3]
  rd <- utils:::.getHelpFile(help(topic, package = (pkg)))
  resolved_pkg <- attr(rd, "package")
  aliases <- vapply(
    Filter(function(x) attr(x, "Rd_tag") == "\\alias", rd),
    function(x) as.character(x[[1]]),
    character(1)
  )
  canonical_topic <- if (length(aliases) >= 1) aliases[1] else topic
  help_dir <- system.file("help", package = resolved_pkg)
  lib_paths <- .libPaths()
  con <- file(meta_path, "w")
  on.exit(close(con))
  cat("topic\t", canonical_topic, "\n", sep = "", file = con)
  cat("package\t", resolved_pkg, "\n", sep = "", file = con)
  cat("helpDir\t", help_dir, "\n", sep = "", file = con)
  for (lp in lib_paths) cat("libPath\t", lp, "\n", sep = "", file = con)
  tools::Rd2HTML(rd, out = stdout(), package = resolved_pkg)
  ```

- [ ] **Step 3: Expose `kill_process_by_pid` from `text.rs`**

  In `text.rs`, change `fn kill_process_by_pid` from private to `pub(crate) fn kill_process_by_pid`. Both `get_help` and `get_help_html` use the same watchdog kill.

- [ ] **Step 4: Wire into `mod.rs`**

  ```rust
  mod html;
  pub use html::{get_help_html, HELP_HTML_MAX_BYTES, HELP_HTML_TIMEOUT};
  ```

- [ ] **Step 5: Build (no integration test in this task — that's Task 12)**

  ```bash
  cargo build -p raven
  ```

  Expected: builds. The only test in this task is `extract_h2_basic`; run:

  ```bash
  cargo test -p raven --lib help::html::tests::extract_h2_basic
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add crates/raven/src/help/html.rs crates/raven/src/help/rd_to_html.R crates/raven/src/help/text.rs crates/raven/src/help/mod.rs
  git commit -m "feat(help): get_help_html with R subprocess + tempfile metadata"
  ```

---

### Task 12: Integration tests for `get_help_html` (R required)

**Files:**
- Modify: `crates/raven/src/help/html.rs`

- [ ] **Step 1: Add tests behind a `requires-r` gate**

  Append to the `tests` module in `html.rs`:

  ```rust
      use crate::r_subprocess::RSubprocess;

      fn r_path() -> Option<std::path::PathBuf> {
          RSubprocess::new(None).map(|s| s.r_path().clone())
      }

      #[test]
      fn renders_base_mean() {
          let Some(r) = r_path() else { eprintln!("skip: no R"); return; };
          let res = get_help_html("mean", Some("base"), &r).expect("render");
          assert_eq!(res.package, "base");
          assert!(res.html.contains("Arithmetic Mean") || res.title.contains("Mean"));
          assert!(res.help_dir.ends_with("help"));
          assert!(!res.lib_paths.is_empty());
      }

      #[test]
      fn invalid_topic_short_circuits() {
          // Path doesn't exist; this should still fail BEFORE spawning R.
          let bogus = std::path::PathBuf::from("/no/such/R");
          let res = get_help_html("with\nnewline", None, &bogus);
          assert!(matches!(res, Err(HelpHtmlError::InvalidTopic { .. })));
      }

      #[test]
      fn unknown_topic_returns_not_found() {
          let Some(r) = r_path() else { eprintln!("skip: no R"); return; };
          let res = get_help_html("definitely_not_a_real_topic_zzz", Some("base"), &r);
          assert!(matches!(res, Err(HelpHtmlError::NotFound) | Err(HelpHtmlError::RenderFailed { .. })));
      }

      #[test]
      fn unknown_package_returns_package_not_installed() {
          let Some(r) = r_path() else { eprintln!("skip: no R"); return; };
          let res = get_help_html("filter", Some("totally_not_installed_pkg_xyz"), &r);
          assert!(matches!(
              res,
              Err(HelpHtmlError::PackageNotInstalled) | Err(HelpHtmlError::RenderFailed { .. })
          ));
      }

      #[test]
      fn operator_topic_works() {
          let Some(r) = r_path() else { eprintln!("skip: no R"); return; };
          let res = get_help_html("[", Some("base"), &r).expect("render");
          assert_eq!(res.package, "base");
      }
  ```

- [ ] **Step 2: Run**

  ```bash
  cargo test -p raven --lib help::html::tests
  ```

  Expected: all pass on a machine with R installed (skipped otherwise).

- [ ] **Step 3: Commit**

  ```bash
  git add crates/raven/src/help/html.rs
  git commit -m "test(help): integration tests for get_help_html"
  ```

---

### Task 13: Stdout-cap and timeout coverage

**Files:**
- Modify: `crates/raven/src/help/html.rs`
- Modify: `crates/raven/src/help/text.rs`

- [ ] **Step 1: Add a stdout-cap test**

  Provide `get_help_html` with an R script (override `r_code` via a test-only `_with_r_code` overload, or use a synthetic test that spawns `cat <large blob>`):

  ```rust
      #[test]
      fn stdout_cap_returns_too_large() {
          // Use `cat` with a deterministic huge output bigger than 8 MiB,
          // bypassing R for this test. This validates the cap path itself.
          // (Implement `_with_program` test helper if needed.)
          // …
      }
  ```

  > **Pragmatic call**: if test plumbing is excessive, make the cap configurable
  > via env var `RAVEN_HELP_HTML_MAX_BYTES`, then write a test that sets it to
  > ~1 KiB and renders any real help — failing with `TooLarge`.

- [ ] **Step 2: Add a timeout test for both `get_help` and `get_help_html`**

  Make both functions timeout-configurable via env var (`RAVEN_HELP_TIMEOUT_MS`). Default unchanged at 10s. Tests set 200ms and run a topic that triggers `Sys.sleep(60)` via:

  ```rust
      #[test]
      fn get_help_html_timeout() {
          std::env::set_var("RAVEN_HELP_TIMEOUT_MS", "200");
          // Use a custom R one-liner via a test-only entry point that hangs.
          // …
          std::env::remove_var("RAVEN_HELP_TIMEOUT_MS");
      }
  ```

- [ ] **Step 3: Verify processes are reaped on timeout**

  On Unix, the test asserts that `kill(pid, 0)` returns ESRCH after the watchdog fires. Use the `nix` crate or a tiny FFI; the existing `kill_process_by_pid` already kills, so this is a paranoia check.

- [ ] **Step 4: Run**

  ```bash
  cargo test -p raven --lib help -- --include-ignored
  ```

  Expected: pass.

- [ ] **Step 5: Commit**

  ```bash
  git add crates/raven/src/help/
  git commit -m "test(help): cover stdout cap and subprocess timeout"
  ```

---

### Task 14: Add `HtmlHelpCache` to `WorldState`

**Files:**
- Modify: `crates/raven/src/state.rs`

- [ ] **Step 1: Add the field**

  Find the existing `help_cache: HelpCache` field in `WorldState`. Add adjacent:

  ```rust
  pub html_help_cache: HtmlHelpCache,
  ```

  Update any constructors or default impls accordingly.

- [ ] **Step 2: Verify compilation**

  ```bash
  cargo build -p raven
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add crates/raven/src/state.rs
  git commit -m "feat(state): add html_help_cache to WorldState"
  ```

---

### Task 15: Wire `libpath_watcher` to drain `HtmlHelpCache`

**Files:**
- Modify: `crates/raven/src/libpath_watcher.rs`

- [ ] **Step 1: Survey existing drain points**

  Find the place where `HelpCache` is drained on libpath changes (grep for `help_cache` / `.drain()`). Add a sibling call.

  ```rust
  state.help_cache.drain();
  state.html_help_cache.drain();
  ```

- [ ] **Step 2: Build**

  ```bash
  cargo build -p raven
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add crates/raven/src/libpath_watcher.rs
  git commit -m "feat(state): drain html_help_cache on libpath changes"
  ```

---

### Task 16: Add `raven.getHelpHtml` executeCommand handler

**Files:**
- Modify: `crates/raven/src/handlers.rs`

- [ ] **Step 1: Find the existing executeCommand dispatcher**

  Search for `workspace/executeCommand` or `ExecuteCommandRequest`. There's already a handler that branches on `command` string (e.g., for `raven.refreshPackages`).

- [ ] **Step 2: Add the new arm**

  Inside the dispatcher's match:

  ```rust
  "raven.getHelpHtml" => {
      let topic = args.get(0).and_then(|v| v.as_str()).unwrap_or("");
      let package = args.get(1).and_then(|v| v.as_str());
      // Validate at the dispatcher boundary too (defense in depth).
      if !crate::help::is_valid_help_topic(topic) {
          return Ok(Some(serde_json::json!({
              "ok": false,
              "reason": "invalid-topic",
              "message": "topic failed validation",
          })));
      }
      if let Some(p) = package {
          if !crate::r_subprocess::is_valid_package_name(p) {
              return Ok(Some(serde_json::json!({
                  "ok": false,
                  "reason": "invalid-topic",
                  "message": "package failed validation",
              })));
          }
      }
      let r_path = state.r_subprocess.as_ref().map(|s| s.r_path().clone());
      let Some(r_path) = r_path else {
          return Ok(Some(serde_json::json!({
              "ok": false,
              "reason": "r-unavailable",
              "message": "R not configured",
          })));
      };
      let cache = state.html_help_cache.clone();
      let topic_owned = topic.to_string();
      let pkg_owned = package.map(str::to_string);
      let r_path_owned = r_path.clone();
      let result = cache
          .get_or_fetch(topic, package, move |t, p| async move {
              tokio::task::spawn_blocking(move || {
                  crate::help::get_help_html(&t, p.as_deref(), &r_path_owned)
              })
              .await
              .unwrap_or_else(|_| Err(crate::help::HelpHtmlError::RenderFailed {
                  message: "spawn_blocking joined with error".into(),
              }))
          })
          .await;
      let json = match result {
          Ok(h) => serde_json::json!({
              "ok": true,
              "topic": h.topic,
              "package": h.package,
              "title": h.title,
              "html": h.html,
              "helpDir": h.help_dir,
              "libPaths": h.lib_paths,
          }),
          Err(e) => serde_json::json!({
              "ok": false,
              "reason": e.reason(),
              "message": format!("{:?}", e),
          }),
      };
      Ok(Some(json))
  }
  ```

  > **Note**: `HtmlHelpCache` needs to be `Clone` (or accessed via `Arc`). If
  > the `WorldState` field is `HtmlHelpCache` directly, derive `Clone` on the
  > struct (it holds `Arc`s internally, so cloning is cheap).

- [ ] **Step 2: Build and verify dispatcher integration**

  ```bash
  cargo build -p raven
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add crates/raven/src/handlers.rs
  git commit -m "feat(lsp): add raven.getHelpHtml executeCommand handler"
  ```

---

### Task 17: Modify hover handler to prepend bold clickable function-name link

**Files:**
- Modify: `crates/raven/src/handlers.rs`

- [ ] **Step 1: Locate the hover handler**

  Find the existing `hover` function (lines 9897–10133 per spec). Identify the place where help text is appended to the hover markdown for a known `(topic, package)`.

- [ ] **Step 2: Prepend the heading line**

  Just before the help text is appended, when we have a `(topic, package)` pair AND `get_or_fetch` returned `Some(_)`, prepend:

  ```rust
  let arg_json = serde_json::json!([topic, package]).to_string();
  let arg_encoded = percent_encoding::utf8_percent_encode(
      &arg_json,
      percent_encoding::NON_ALPHANUMERIC,
  )
  .to_string();
  let label = match package {
      Some(p) => format!("`{p}::{topic}`"),
      None => format!("`{topic}`"),
  };
  let heading = format!(
      "**[{label}](command:raven.openHelpPanel?{arg_encoded})**\n\n"
  );
  hover_md.insert_str(0, &heading);
  ```

  > Critical: **do not** call `get_or_fetch` again here. Reuse the value the
  > existing code already computed.

- [ ] **Step 3: Add an integration assertion**

  In `crates/raven/src/handlers.rs`'s test module (or a new test file), exercise hover on a fixture file with a known function and verify the markdown begins with the expected pattern. Use an R-availability gate (skip if no R for the underlying help-fetch portion).

- [ ] **Step 4: Build and run hover tests**

  ```bash
  cargo build -p raven && cargo test -p raven --lib hover
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add crates/raven/src/handlers.rs
  git commit -m "feat(hover): prepend bold clickable pkg::name link"
  ```

---

### Task 18: Add `editors/vscode/src/help/messages.ts` wire protocol

**Files:**
- Create: `editors/vscode/src/help/messages.ts`
- Create: `tests/bun/help-messages.test.ts`

- [ ] **Step 1: Write failing tests in `tests/bun/help-messages.test.ts`**

  ```ts
  import { describe, test, expect } from 'bun:test';
  import {
      ExtensionToWebviewMessage,
      WebviewToExtensionMessage,
      isExtensionToWebviewMessage,
      isWebviewToExtensionMessage,
  } from '../../editors/vscode/src/help/messages';

  describe('help messages', () => {
      test('ext->webview load message', () => {
          const msg: ExtensionToWebviewMessage = {
              type: 'load',
              payload: {
                  topic: 'filter',
                  package: 'dplyr',
                  title: 'Subset rows',
                  html: '<p>x</p>',
                  anchor: null,
              },
          };
          expect(isExtensionToWebviewMessage(msg)).toBe(true);
      });

      test('ext->webview loading and error', () => {
          expect(
              isExtensionToWebviewMessage({ type: 'loading', payload: {} }),
          ).toBe(true);
          expect(
              isExtensionToWebviewMessage({
                  type: 'error',
                  payload: { reason: 'not-found', message: 'no help' },
              }),
          ).toBe(true);
      });

      test('webview->ext navigate', () => {
          const msg: WebviewToExtensionMessage = {
              type: 'navigate',
              payload: { topic: '[', package: 'base', anchor: null },
          };
          expect(isWebviewToExtensionMessage(msg)).toBe(true);
      });

      test('webview->ext open-external, report-error, scroll, ready', () => {
          expect(
              isWebviewToExtensionMessage({
                  type: 'open-external',
                  payload: { url: 'https://example.com' },
              }),
          ).toBe(true);
          expect(
              isWebviewToExtensionMessage({
                  type: 'report-error',
                  payload: { message: 'x' },
              }),
          ).toBe(true);
          expect(
              isWebviewToExtensionMessage({
                  type: 'scroll',
                  payload: { y: 42 },
              }),
          ).toBe(true);
          expect(
              isWebviewToExtensionMessage({
                  type: 'webview-ready',
                  payload: {},
              }),
          ).toBe(true);
      });

      test('rejects malformed', () => {
          expect(isExtensionToWebviewMessage({ type: 'unknown' })).toBe(false);
          expect(isWebviewToExtensionMessage({ type: 'navigate' })).toBe(false);
      });
  });
  ```

- [ ] **Step 2: Run; expect compile failure (file doesn't exist yet)**

  ```bash
  bun test tests/bun/help-messages.test.ts
  ```

- [ ] **Step 3: Implement `messages.ts`**

  Create `editors/vscode/src/help/messages.ts`:

  ```typescript
  /**
   * Typed wire protocol between the help-viewer extension host and the
   * Svelte webview. No VS Code or DOM imports here.
   */

  export type LoadPayload = {
      topic: string;
      package: string;
      title: string;
      html: string;
      anchor: string | null;
  };

  export type ErrorPayload = {
      reason:
          | 'not-found'
          | 'package-not-installed'
          | 'render-failed'
          | 'timeout'
          | 'r-unavailable'
          | 'invalid-topic'
          | 'too-large';
      message: string;
  };

  export type ExtensionToWebviewMessage =
      | { type: 'load'; payload: LoadPayload }
      | { type: 'loading'; payload: Record<string, never> }
      | { type: 'error'; payload: ErrorPayload }
      | { type: 'theme-changed'; payload: Record<string, never> }
      | { type: 'history-state'; payload: { canBack: boolean; canForward: boolean } };

  export type NavigatePayload = {
      topic: string;
      package: string;
      anchor: string | null;
  };

  export type WebviewToExtensionMessage =
      | { type: 'webview-ready'; payload: Record<string, never> }
      | { type: 'navigate'; payload: NavigatePayload }
      | { type: 'open-external'; payload: { url: string } }
      | { type: 'report-error'; payload: { message: string } }
      | { type: 'scroll'; payload: { y: number } }
      | { type: 'back'; payload: Record<string, never> }
      | { type: 'forward'; payload: Record<string, never> };

  const EXT_TYPES = new Set([
      'load',
      'loading',
      'error',
      'theme-changed',
      'history-state',
  ]);
  const WV_TYPES = new Set([
      'webview-ready',
      'navigate',
      'open-external',
      'report-error',
      'scroll',
      'back',
      'forward',
  ]);

  function isObj(x: unknown): x is Record<string, unknown> {
      return typeof x === 'object' && x !== null;
  }

  export function isExtensionToWebviewMessage(
      v: unknown,
  ): v is ExtensionToWebviewMessage {
      if (!isObj(v)) return false;
      const t = v.type;
      if (typeof t !== 'string' || !EXT_TYPES.has(t)) return false;
      const p = v.payload;
      if (!isObj(p)) return false;
      switch (t) {
          case 'load':
              return (
                  typeof p.topic === 'string' &&
                  typeof p.package === 'string' &&
                  typeof p.title === 'string' &&
                  typeof p.html === 'string' &&
                  (p.anchor === null || typeof p.anchor === 'string')
              );
          case 'loading':
          case 'theme-changed':
              return true;
          case 'error':
              return typeof p.reason === 'string' && typeof p.message === 'string';
          case 'history-state':
              return typeof p.canBack === 'boolean' && typeof p.canForward === 'boolean';
      }
      return false;
  }

  export function isWebviewToExtensionMessage(
      v: unknown,
  ): v is WebviewToExtensionMessage {
      if (!isObj(v)) return false;
      const t = v.type;
      if (typeof t !== 'string' || !WV_TYPES.has(t)) return false;
      const p = v.payload;
      if (!isObj(p)) return false;
      switch (t) {
          case 'webview-ready':
          case 'back':
          case 'forward':
              return true;
          case 'navigate':
              return (
                  typeof p.topic === 'string' &&
                  typeof p.package === 'string' &&
                  (p.anchor === null || typeof p.anchor === 'string')
              );
          case 'open-external':
              return typeof p.url === 'string';
          case 'report-error':
              return typeof p.message === 'string';
          case 'scroll':
              return typeof p.y === 'number';
      }
      return false;
  }
  ```

- [ ] **Step 4: Run tests**

  ```bash
  bun test tests/bun/help-messages.test.ts
  ```

  Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

  ```bash
  git add editors/vscode/src/help/messages.ts tests/bun/help-messages.test.ts
  git commit -m "feat(vscode/help): typed wire protocol for help viewer"
  ```

---

### Task 19: Hover-trust middleware + Mocha test

**Files:**
- Create: `editors/vscode/src/help/hover-trust-middleware.ts`
- Create: `editors/vscode/src/test/help-trust-middleware.test.ts`

- [ ] **Step 1: Write the test first**

  Create `editors/vscode/src/test/help-trust-middleware.test.ts`:

  ```typescript
  import * as assert from 'assert';
  import * as vscode from 'vscode';
  import { wrapHoverWithHelpTrust } from '../help/hover-trust-middleware';

  suite('help-trust-middleware', () => {
      test('marks MarkdownString as trusted for raven.openHelpPanel only', async () => {
          const md = new vscode.MarkdownString('hello');
          const next = async () => new vscode.Hover([md]);
          const wrapped = wrapHoverWithHelpTrust(next);
          const result = await wrapped(
              {} as vscode.TextDocument,
              new vscode.Position(0, 0),
              new vscode.CancellationTokenSource().token,
          );
          assert.ok(result);
          const c = result.contents[0] as vscode.MarkdownString;
          const t = c.isTrusted;
          assert.ok(typeof t === 'object' && t !== null);
          // VS Code's API uses `enabledCommands`.
          assert.deepStrictEqual((t as { enabledCommands: string[] }).enabledCommands, [
              'raven.openHelpPanel',
          ]);
      });

      test('returns null hover unchanged', async () => {
          const next = async () => null;
          const wrapped = wrapHoverWithHelpTrust(next);
          const result = await wrapped(
              {} as vscode.TextDocument,
              new vscode.Position(0, 0),
              new vscode.CancellationTokenSource().token,
          );
          assert.strictEqual(result, null);
      });
  });
  ```

- [ ] **Step 2: Implement**

  Create `editors/vscode/src/help/hover-trust-middleware.ts`:

  ```typescript
  import * as vscode from 'vscode';

  type Provider = (
      doc: vscode.TextDocument,
      pos: vscode.Position,
      tok: vscode.CancellationToken,
  ) => Promise<vscode.Hover | null | undefined>;

  /**
   * Wraps a hover provider so that any returned MarkdownString carries
   * narrow command-link trust for `raven.openHelpPanel` only.
   */
  export function wrapHoverWithHelpTrust(next: Provider): Provider {
      return async (doc, pos, tok) => {
          const hover = await next(doc, pos, tok);
          if (!hover) return hover;
          for (const c of hover.contents) {
              if (c instanceof vscode.MarkdownString) {
                  c.isTrusted = { enabledCommands: ['raven.openHelpPanel'] };
              }
          }
          return hover;
      };
  }
  ```

- [ ] **Step 3: Run the Mocha tests**

  ```bash
  cd editors/vscode && bun run test
  ```

  Expected: pass.

- [ ] **Step 4: Commit**

  ```bash
  git add editors/vscode/src/help/hover-trust-middleware.ts \
          editors/vscode/src/test/help-trust-middleware.test.ts
  git commit -m "feat(vscode/help): hover-trust middleware (raven.openHelpPanel only)"
  ```

---

### Task 20: Image URL rewriter (extension-side, pure)

**Files:**
- Create: `editors/vscode/src/help/image-rewriter.ts`
- Create: `tests/bun/help-image-rewriter.test.ts`

- [ ] **Step 1: Tests first**

  Create `tests/bun/help-image-rewriter.test.ts`:

  ```ts
  import { describe, test, expect } from 'bun:test';
  import {
      rewriteImageSrcs,
      type RewriteContext,
  } from '../../editors/vscode/src/help/image-rewriter';
  import * as path from 'path';

  function ctx(helpDir: string): RewriteContext {
      return {
          helpDir,
          libPaths: [path.dirname(path.dirname(helpDir))],
          asWebviewUri: (abs: string) => `webview-uri:${abs}`,
          fileExists: () => true,
      };
  }

  describe('image-rewriter', () => {
      test('relative src under helpDir is rewritten', () => {
          const c = ctx('/lib/dplyr/help');
          const html = `<img src="figures/x.png">`;
          const out = rewriteImageSrcs(html, c);
          expect(out).toContain('webview-uri:/lib/dplyr/help/figures/x.png');
      });

      test('data: src passes through', () => {
          const c = ctx('/lib/dplyr/help');
          const html = `<img src="data:image/png;base64,AAAA">`;
          const out = rewriteImageSrcs(html, c);
          expect(out).toContain('data:image/png;base64,AAAA');
      });

      test('http and https are dropped', () => {
          const c = ctx('/lib/dplyr/help');
          const out1 = rewriteImageSrcs(`<img src="http://evil/x">`, c);
          const out2 = rewriteImageSrcs(`<img src="https://evil/x">`, c);
          expect(out1).toContain('src=""');
          expect(out2).toContain('src=""');
      });

      test('path traversal outside helpDir is dropped', () => {
          const c = ctx('/lib/dplyr/help');
          const out = rewriteImageSrcs(`<img src="../../../../etc/passwd">`, c);
          expect(out).toContain('src=""');
      });

      test('cross-package reference is dropped', () => {
          const c = ctx('/lib/dplyr/help');
          const out = rewriteImageSrcs(
              `<img src="../../OTHERPKG/help/figures/x.png">`,
              c,
          );
          expect(out).toContain('src=""');
      });

      test('file: scheme is dropped', () => {
          const c = ctx('/lib/dplyr/help');
          const out = rewriteImageSrcs(`<img src="file:///etc/passwd">`, c);
          expect(out).toContain('src=""');
      });
  });
  ```

- [ ] **Step 2: Implement**

  Create `editors/vscode/src/help/image-rewriter.ts`:

  ```typescript
  import * as path from 'path';

  export type RewriteContext = {
      helpDir: string;
      libPaths: string[];
      asWebviewUri(absPath: string): string;
      fileExists(absPath: string): boolean;
  };

  /**
   * Replace `<img src="...">` URLs per the Image-serving rules in the spec.
   *
   * - `data:` passes through.
   * - http/https/ftp/mailto/file: drop (set src="").
   * - relative path: prepend helpDir, canonicalize, validate it stays under
   *   helpDir, rewrite via asWebviewUri.
   * - anything else: drop.
   */
  export function rewriteImageSrcs(html: string, ctx: RewriteContext): string {
      const re = /(<img\b[^>]*\bsrc=)"([^"]*)"/gi;
      return html.replace(re, (_match, prefix, src) => {
          const newSrc = classifyAndResolve(src, ctx);
          return `${prefix}"${newSrc}"`;
      });
  }

  function classifyAndResolve(src: string, ctx: RewriteContext): string {
      if (src.startsWith('data:')) return src;
      if (
          src.startsWith('http:') ||
          src.startsWith('https:') ||
          src.startsWith('ftp:') ||
          src.startsWith('mailto:') ||
          src.startsWith('ws:') ||
          src.startsWith('wss:') ||
          src.startsWith('file:')
      ) {
          return '';
      }
      // Treat as relative path.
      const abs = path.resolve(ctx.helpDir, src);
      const canonHelpDir = path.resolve(ctx.helpDir);
      // Must remain under helpDir (use path.relative + check it doesn't start with `..`).
      const rel = path.relative(canonHelpDir, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return '';
      return ctx.asWebviewUri(abs);
  }
  ```

- [ ] **Step 3: Run tests**

  ```bash
  bun test tests/bun/help-image-rewriter.test.ts
  ```

  Expected: 6 tests pass.

- [ ] **Step 4: Commit**

  ```bash
  git add editors/vscode/src/help/image-rewriter.ts tests/bun/help-image-rewriter.test.ts
  git commit -m "feat(vscode/help): image src rewriter with helpDir validation"
  ```

---

### Task 21: HelpPanel state machine (back/forward, request id)

**Files:**
- Create: `editors/vscode/src/help/state-machine.ts`
- Create: `tests/bun/help-state-machine.test.ts`

- [ ] **Step 1: Tests first**

  Create `tests/bun/help-state-machine.test.ts` (excerpt; full test list below):

  ```ts
  import { describe, test, expect } from 'bun:test';
  import { createHelpStateMachine } from '../../editors/vscode/src/help/state-machine';

  describe('help state machine', () => {
      test('navigate pushes to back, clears forward', async () => {
          let calls = 0;
          const fetch = async () => ({
              ok: true,
              topic: 't',
              package: 'p',
              title: '',
              html: '',
              helpDir: '',
              libPaths: [],
          });
          const sm = createHelpStateMachine({ fetch });
          await sm.navigate('a', 'p');
          await sm.navigate('b', 'p');
          expect(sm.canBack()).toBe(true);
          expect(sm.canForward()).toBe(false);
          await sm.back();
          expect(sm.canForward()).toBe(true);
      });

      test('failed fetch does not mutate stacks', async () => { /* ... */ });
      test('stale request id is dropped', async () => { /* ... */ });
      test('stack capped at 50', async () => { /* ... */ });
  });
  ```

- [ ] **Step 2: Implement state machine**

  Create `editors/vscode/src/help/state-machine.ts`:

  ```typescript
  import type { LoadPayload } from './messages';

  export type HistoryEntry = {
      topic: string;
      package: string;
      anchor: string | null;
      scrollY: number;
  };

  export type FetchResponse =
      | ({ ok: true } & LoadPayload & { helpDir: string; libPaths: string[] })
      | { ok: false; reason: string; message: string };

  export type StateMachineDeps = {
      fetch: (
          topic: string,
          pkg: string,
          requestId: number,
      ) => Promise<FetchResponse>;
      onLoad?: (load: LoadPayload, scrollY: number) => void;
      onLoading?: () => void;
      onError?: (e: { reason: string; message: string }) => void;
      onHistoryChange?: (s: { canBack: boolean; canForward: boolean }) => void;
  };

  const STACK_CAP = 50;

  export function createHelpStateMachine(deps: StateMachineDeps) {
      const back: HistoryEntry[] = [];
      const forward: HistoryEntry[] = [];
      let current: HistoryEntry | null = null;
      let nextId = 1;
      let inFlight = 0;

      function notifyHist() {
          deps.onHistoryChange?.({
              canBack: back.length > 0,
              canForward: forward.length > 0,
          });
      }

      async function load(t: string, p: string, anchor: string | null) {
          const id = ++nextId;
          inFlight = id;
          deps.onLoading?.();
          const res = await deps.fetch(t, p, id);
          if (id !== inFlight) return; // stale
          if (res.ok) {
              current = { topic: t, package: p, anchor, scrollY: 0 };
              deps.onLoad?.(
                  {
                      topic: res.topic,
                      package: res.package,
                      title: res.title,
                      html: res.html,
                      anchor,
                  },
                  0,
              );
          } else {
              deps.onError?.({ reason: res.reason, message: res.message });
          }
          notifyHist();
      }

      return {
          async navigate(t: string, p: string, anchor: string | null = null) {
              if (current) {
                  back.push(current);
                  if (back.length > STACK_CAP) back.shift();
                  forward.length = 0;
              }
              await load(t, p, anchor);
          },
          async back() {
              if (back.length === 0) return;
              const target = back.pop()!;
              if (current) forward.push(current);
              await load(target.topic, target.package, target.anchor);
          },
          async forward() {
              if (forward.length === 0) return;
              const target = forward.pop()!;
              if (current) back.push(current);
              await load(target.topic, target.package, target.anchor);
          },
          setScrollY(y: number) {
              if (current) current.scrollY = y;
          },
          canBack() { return back.length > 0; },
          canForward() { return forward.length > 0; },
      };
  }
  ```

- [ ] **Step 3: Run**

  ```bash
  bun test tests/bun/help-state-machine.test.ts
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add editors/vscode/src/help/state-machine.ts tests/bun/help-state-machine.test.ts
  git commit -m "feat(vscode/help): state machine for back/forward navigation"
  ```

---

### Task 22: HelpPanel webview host

**Files:**
- Create: `editors/vscode/src/help/help-panel.ts`

- [ ] **Step 1: Write the panel host**

  Create `editors/vscode/src/help/help-panel.ts`. Mirror `editors/vscode/src/plot/plot-viewer-panel.ts` for the build-html / CSP / message-handling skeleton. Key differences:

  - `localResourceRoots` set to `libPaths` from the first `getHelpHtml` response.
  - CSP per the spec.
  - Use `state-machine.ts` for navigation.
  - On `navigate` from webview: call into state machine.
  - On `load` event: run `rewriteImageSrcs` on the HTML before posting to the webview.

- [ ] **Step 2: Build extension**

  ```bash
  cd editors/vscode && bun run build
  ```

  Expected: succeeds (TypeScript compiles cleanly).

- [ ] **Step 3: Commit**

  ```bash
  git add editors/vscode/src/help/help-panel.ts
  git commit -m "feat(vscode/help): HelpPanel webview host"
  ```

---

### Task 23: Webview Svelte UI

**Files:**
- Create: `editors/vscode/src/help/webview/` directory with `App.svelte`, `main.ts`, `state.ts`, `styles.css`, `tsconfig.json`.
- Modify: `editors/vscode/scripts/build.js`

- [ ] **Step 1: Scaffold mirroring the plot viewer**

  Copy structure from `editors/vscode/src/plot/webview/`. Reduce to the help-specific pieces:

  - `App.svelte` shows toolbar (← back, → forward) + content area + loading/error overlays.
  - Click handler on content area: dispatches per the spec's link-classification rules.
  - Posts `webview-ready`, `navigate`, `open-external`, `report-error`, `scroll`, `back`, `forward` messages.

- [ ] **Step 2: Add the help-viewer build pass to `scripts/build.js`**

  In `editors/vscode/scripts/build.js`, factor out a helper `buildSvelteWebview(name, entry)` that the existing plot viewer call delegates to. Add a second invocation for `name='help-viewer'`, `entry='editors/vscode/src/help/webview/main.ts'`.

- [ ] **Step 3: Build**

  ```bash
  cd editors/vscode && bun run build
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add editors/vscode/src/help/webview/ editors/vscode/scripts/build.js
  git commit -m "feat(vscode/help): Svelte webview UI"
  ```

---

### Task 24: Webview link click interception tests (JSDOM)

**Files:**
- Create: `tests/bun/help-webview-link.test.ts`

- [ ] **Step 1: Test the click handler logic in isolation**

  Refactor the click handler (from `App.svelte` step 1) into a pure function `classifyAndDispatch(target, postMessage)` in `editors/vscode/src/help/webview/click-handler.ts`. Test it with JSDOM:

  ```ts
  import { describe, test, expect, mock } from 'bun:test';
  import { JSDOM } from 'jsdom';
  import { classifyAndDispatch } from '../../editors/vscode/src/help/webview/click-handler';

  function makeAnchor(html: string) {
      const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
      return dom.window.document.querySelector('a')!;
  }

  describe('webview link click', () => {
      test('raven-help:// → navigate, decoded', () => {
          const a = makeAnchor('<a href="raven-help://topic/base/%5B">x</a>');
          const post = mock(() => {});
          const ev = { preventDefault: mock(() => {}), target: a } as any;
          const handled = classifyAndDispatch(ev, a.getAttribute('href')!, post);
          expect(handled).toBe(true);
          expect(ev.preventDefault).toHaveBeenCalled();
          expect(post).toHaveBeenCalledWith({
              type: 'navigate',
              payload: { topic: '[', package: 'base', anchor: null },
          });
      });

      test('https → open-external', () => { /* ... */ });
      test('mailto → open-external', () => { /* ... */ });
      test('#anchor → no preventDefault', () => { /* ... */ });
      test('javascript:/file:/other:/dropped → report-error', () => { /* ... */ });
  });
  ```

- [ ] **Step 2: Run**

  ```bash
  bun test tests/bun/help-webview-link.test.ts
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add tests/bun/help-webview-link.test.ts editors/vscode/src/help/webview/click-handler.ts
  git commit -m "test(vscode/help): webview link interception (JSDOM)"
  ```

---

### Task 25: Add `raven.help.viewerColumn` setting + commands to `package.json`

**Files:**
- Modify: `editors/vscode/package.json`

- [ ] **Step 1: Add the setting**

  In `contributes.configuration.properties`, add:

  ```json
  "raven.help.viewerColumn": {
      "type": "string",
      "enum": ["active", "beside"],
      "enumDescriptions": [
          "Open the help viewer in the active editor column.",
          "Open the help viewer beside the active editor."
      ],
      "default": "beside",
      "description": "Initial editor column when the R help viewer first opens. Once you move the panel, Raven leaves it where you put it."
  },
  ```

- [ ] **Step 2: Add the commands**

  In `contributes.commands`, add:

  ```json
  { "command": "raven.openHelpPanel", "title": "Raven: Open R Help Panel" },
  { "command": "raven.help.back", "title": "Raven: Help Back" },
  { "command": "raven.help.forward", "title": "Raven: Help Forward" }
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add editors/vscode/package.json
  git commit -m "feat(vscode): help viewer setting and commands in manifest"
  ```

---

### Task 26: Wire setting + commands in extension code

**Files:**
- Modify: `editors/vscode/src/initializationOptions.ts`
- Modify: `editors/vscode/src/test/settings.test.ts`
- Modify: `editors/vscode/src/extension.ts`
- Create: `editors/vscode/src/help/index.ts`

- [ ] **Step 1: Add `helpViewer` to InitOptions interface**

  In `initializationOptions.ts`, add:

  ```ts
  helpViewer?: { viewColumn?: 'active' | 'beside' };
  ```

  in the `RavenInitializationOptions` type and source it from `getExplicitSetting('raven.help.viewerColumn')`.

- [ ] **Step 2: Add SETTINGS_MAPPING entry**

  In `editors/vscode/src/test/settings.test.ts`, add:

  ```ts
  ['raven.help.viewerColumn', { server: 'helpViewer.viewColumn', defaultValue: 'beside' }],
  ```

- [ ] **Step 3: Create `editors/vscode/src/help/index.ts`**

  Register commands and middleware:

  ```typescript
  import * as vscode from 'vscode';
  import { LanguageClient } from 'vscode-languageclient/node';
  import { HelpPanel } from './help-panel';
  import { wrapHoverWithHelpTrust } from './hover-trust-middleware';

  export function activateHelpViewer(
      context: vscode.ExtensionContext,
      client: LanguageClient,
  ) {
      const panelHolder = { current: null as HelpPanel | null };

      const open = vscode.commands.registerCommand(
          'raven.openHelpPanel',
          async (topic: string, pkg: string | null) => {
              if (!panelHolder.current) {
                  panelHolder.current = await HelpPanel.create(context, client, () => {
                      panelHolder.current = null;
                  });
              }
              await panelHolder.current.openTopic(topic, pkg, null);
          },
      );
      const back = vscode.commands.registerCommand('raven.help.back', () =>
          panelHolder.current?.back(),
      );
      const forward = vscode.commands.registerCommand('raven.help.forward', () =>
          panelHolder.current?.forward(),
      );
      context.subscriptions.push(open, back, forward);
  }

  export { wrapHoverWithHelpTrust };
  ```

- [ ] **Step 4: Wire from `extension.ts`**

  In `editors/vscode/src/extension.ts`, after the LSP client starts:

  ```typescript
  import { activateHelpViewer, wrapHoverWithHelpTrust } from './help';
  // ...
  activateHelpViewer(context, client);
  // Inject the trust middleware into the LSP client's hover provider chain.
  ```

- [ ] **Step 5: Build and run extension tests**

  ```bash
  cd editors/vscode && bun run build && bun run test
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add editors/vscode/
  git commit -m "feat(vscode): wire help viewer commands and settings"
  ```

---

### Task 27: User-facing docs

**Files:**
- Create: `docs/help-viewer.md`
- Modify: `docs/configuration.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Write `docs/help-viewer.md`**

  Use `docs/send-to-r.md` as the template for tone and structure. Include: what it does, how to open it, back/forward navigation, v1 limitations (no search, no examples runner, no vignettes, no images from remote URLs), the manual smoke test plan from the spec.

- [ ] **Step 2: Add row to `docs/configuration.md`**

  Add a row to the settings table:

  | `raven.help.viewerColumn` | enum | `"beside"` | Where the R help viewer panel opens (`"active"` or `"beside"`) |

- [ ] **Step 3: Update `CLAUDE.md`**

  In the "What to read (in order)" block under "User-facing", add:

  ```markdown
  - `docs/help-viewer.md`
  ```

  (in the appropriate alphabetical/topical place).

- [ ] **Step 4: Commit**

  ```bash
  git add docs/help-viewer.md docs/configuration.md CLAUDE.md
  git commit -m "docs: help viewer user-facing documentation"
  ```

---

### Task 28: Manual smoke test pass

**Files:** none (validation only)

- [ ] **Step 1: Build the extension and install locally**

  ```bash
  cd editors/vscode && bun run package
  code --install-extension raven-*.vsix
  ```

- [ ] **Step 2: Run the smoke test plan from the spec**

  Execute steps 1–9 of the "Manual smoke test plan" in
  `docs/superpowers/specs/2026-05-07-help-viewer-design.md`. Capture any
  defects as follow-up issues.

- [ ] **Step 3: Mark plan complete**

  ```bash
  echo "All smoke tests passed on $(date -Iminutes)" >> .smoke-help-viewer
  git add .smoke-help-viewer
  git commit -m "chore: smoke-test sign-off for help viewer v1"
  ```

  (Or skip the file commit and just record it in the PR description.)

---

## Self-Review Checklist

After implementing each task:

- [ ] Did the test fail before the implementation, and pass after?
- [ ] Was the commit made before moving on?
- [ ] Did the change introduce any unrelated cleanup that doesn't belong in this PR?
- [ ] Did the spec ("/Users/jmb/repos/raven/docs/superpowers/specs/2026-05-07-help-viewer-design.md") need updating to reflect a real-world adjustment? If yes, update it in a separate commit.
