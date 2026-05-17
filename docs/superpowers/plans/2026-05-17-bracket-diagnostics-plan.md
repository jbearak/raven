# Bracket diagnostics: opener-anchored unclosed + named stray-closer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic `"Syntax error"` diagnostic for stray/unclosed brackets, braces, and parens with targeted messages anchored on the offending delimiter character. Spec: `docs/superpowers/specs/2026-05-17-bracket-diagnostics-design.md`.

**Architecture:** All changes are local to `crates/raven/src/handlers.rs`. A new `CollectState` struct threads through `collect_syntax_errors` to carry per-traversal coalescing state. `classify_error` returns a new `ErrorClassification` enum (Whole vs Multi) instead of a `String`, so a single ERROR can produce multiple diagnostics when it contains multiple distinct delimiter faults. A new delimiter-scan pass walks each ERROR's direct children left-to-right with a stack, producing per-opener and per-closer diagnostics. Bracket-kind `MISSING` nodes route through a new `find_opener_for_missing` helper that walks up one level to the structural parent (`arguments` / `braced_expression` / `parenthesized_expression`) and anchors on the opener token. A new `end_of_meaningful_content` helper trims trailing comments/whitespace from the opener-line range.

**Tech Stack:** Rust, `tree-sitter` 0.20.x via `tree-sitter-r` (rev `95aff097aa927a66bb357f715b58cde821be8867`), `tower-lsp` for LSP types, `proptest` for property tests.

---

## Working environment

All work happens in this worktree:

```text
/Users/jmb/repos/Extensions/raven/.claude/worktrees/issue286-bracket-spec
```

The current branch is `issue286`. The spec lives at `docs/superpowers/specs/2026-05-17-bracket-diagnostics-design.md`. Run all commands from the worktree root.

Build and test commands:

```bash
cargo build -p raven          # ~30s incremental
cargo test  -p raven --lib    # full test suite
cargo test  -p raven --lib syntax_error_range_tests::<NAME> -- --nocapture
```

Existing file landmarks in `crates/raven/src/handlers.rs`:

- `collect_syntax_errors` — line ~6293
- `classify_error` — line ~6369
- `detect_consecutive_pipe`, `detect_mismatched_bracket`, `detect_fat_arrow` — adjacent
- `has_unclosed_quote_child`, `is_string_quote_kind` — adjacent
- `minimize_error_range` — line ~6164
- `anchor_missing_position` — line ~5907
- `find_first_missing_descendant` — line ~5961
- `find_innermost_error` — line ~5999
- `mod syntax_error_range_tests` — line ~6485
- `prop_missing_node_priority` — line ~7802
- `prop_missing_node_width` — line ~8098

UTF-16 helpers live in `crates/raven/src/utf16.rs`:

- `byte_offset_to_utf16_column(line: &str, byte_offset: usize) -> u32`

---

## Task 1: Add `end_of_meaningful_content` helper

**Files:**
- Modify: `crates/raven/src/handlers.rs` (add helper near other line-utility code)
- Test: same file, inside `mod syntax_error_range_tests`

**Why this is first:** Every opener-line range depends on this. Self-contained pure function, no tree-sitter dependency.

**Contract:**

```rust
/// Compute the UTF-16 column just past the last non-comment, non-whitespace
/// character on `line`. Used to trim trailing comments and whitespace from
/// the opener-line range of an `Unclosed X` diagnostic.
///
/// Comment detection is string-aware: a `#` inside a string literal (`"..."`,
/// `'...'`, or backtick-quoted) does NOT start a comment.
///
/// CRLF: `\r` is treated as trailing whitespace (trimmed).
///
/// Examples:
///   `f( # comment`   -> 2  (just past `(`)
///   `f(   `          -> 2  (just past `(`)
///   `x <- "a # b"`   -> 12 (just past closing `"`)
///   `f(x, y)`        -> 7  (just past `)`)
fn end_of_meaningful_content(line: &str) -> u32;
```

- [ ] **Step 1: Add the failing tests**

Add this block at the end of `mod syntax_error_range_tests` (just before the closing `}` of the module, line ~7470 region — confirm by grep for `^}` after `incomplete_assignment_in_block_minimized`'s helpers):

```rust
    // ------------------------------------------------------------------
    // end_of_meaningful_content
    // ------------------------------------------------------------------

    use super::end_of_meaningful_content;

    #[test]
    fn eomc_plain_content() {
        assert_eq!(end_of_meaningful_content("f(x, y)"), 7);
    }

    #[test]
    fn eomc_trailing_whitespace() {
        assert_eq!(end_of_meaningful_content("f(   "), 2);
    }

    #[test]
    fn eomc_trailing_comment() {
        assert_eq!(end_of_meaningful_content("f( # comment"), 2);
    }

    #[test]
    fn eomc_content_then_comment() {
        // last meaningful char `1` at col 4; just past = 5
        assert_eq!(end_of_meaningful_content("f(1) # tail"), 4);
    }

    #[test]
    fn eomc_hash_inside_double_quoted_string() {
        // "a # b" -- the `#` is inside the string; meaningful content
        // continues to the closing `"` at col 11; just past = 12.
        assert_eq!(end_of_meaningful_content("x <- \"a # b\""), 12);
    }

    #[test]
    fn eomc_hash_inside_single_quoted_string() {
        assert_eq!(end_of_meaningful_content("x <- 'a # b'"), 12);
    }

    #[test]
    fn eomc_hash_inside_backticks() {
        // backticks quote identifiers in R; `#` inside them is not a comment
        assert_eq!(end_of_meaningful_content("x <- `a # b`"), 12);
    }

    #[test]
    fn eomc_crlf_carriage_return_trimmed() {
        // \r is trailing whitespace
        assert_eq!(end_of_meaningful_content("f(\r"), 2);
    }

    #[test]
    fn eomc_only_comment() {
        // pure comment line — meaningful content ends at col 0
        assert_eq!(end_of_meaningful_content("# nothing here"), 0);
    }

    #[test]
    fn eomc_empty_line() {
        assert_eq!(end_of_meaningful_content(""), 0);
    }

    #[test]
    fn eomc_non_ascii_identifier() {
        // `é` is 2 UTF-8 bytes but 1 UTF-16 code unit; line "é <- 1"
        // last meaningful char `1` at UTF-16 col 5; just past = 6.
        assert_eq!(end_of_meaningful_content("é <- 1"), 6);
    }

    #[test]
    fn eomc_astral_emoji() {
        // `😀` is 4 UTF-8 bytes, 2 UTF-16 code units; line "😀 <- 1"
        // `1` lands at UTF-16 col 6 (😀=2 + " <- "=4 = 6); just past = 7.
        assert_eq!(end_of_meaningful_content("😀 <- 1"), 7);
    }
```

- [ ] **Step 2: Verify the tests fail to compile (helper not yet defined)**

```bash
cargo test -p raven --lib eomc_ 2>&1 | tail -20
```

Expected: compile error: `cannot find function "end_of_meaningful_content" in module "super"`.

- [ ] **Step 3: Implement `end_of_meaningful_content`**

Add this function in `handlers.rs` near `anchor_missing_position` (line ~5907 region — find a natural insertion point above `anchor_missing_position` so it's available to all consumers):

```rust
/// Compute the UTF-16 column just past the last non-comment, non-whitespace
/// character on `line`. Comment detection is string-aware: a `#` inside
/// `"..."`, `'...'`, or `` `...` `` is not a comment. `\r` is treated as
/// trailing whitespace.
///
/// Used to trim trailing comments and whitespace from the opener-line range
/// of an `Unclosed X` diagnostic. See bracket-diagnostics design spec.
fn end_of_meaningful_content(line: &str) -> u32 {
    use crate::cross_file::types::byte_offset_to_utf16_column;

    // Walk forward through `line`, tracking the current "in-string" state.
    // `comment_byte` records where a `#` outside any string was first seen.
    let mut in_double = false;
    let mut in_single = false;
    let mut in_backtick = false;
    let mut escape = false;
    let mut comment_byte: Option<usize> = None;

    for (byte_idx, ch) in line.char_indices() {
        if escape {
            escape = false;
            continue;
        }
        if in_double {
            match ch {
                '\\' => escape = true,
                '"' => in_double = false,
                _ => {}
            }
            continue;
        }
        if in_single {
            match ch {
                '\\' => escape = true,
                '\'' => in_single = false,
                _ => {}
            }
            continue;
        }
        if in_backtick {
            if ch == '`' { in_backtick = false; }
            continue;
        }
        match ch {
            '"' => in_double = true,
            '\'' => in_single = true,
            '`' => in_backtick = true,
            '#' => {
                comment_byte = Some(byte_idx);
                break;
            }
            _ => {}
        }
    }

    // The "meaningful" prefix ends at `comment_byte` (if a comment was
    // found) or at the end of `line`. Then trim trailing whitespace from
    // that prefix.
    let cutoff_byte = comment_byte.unwrap_or(line.len());
    let meaningful = &line[..cutoff_byte];
    let trimmed = meaningful.trim_end_matches(|c: char| c.is_whitespace());

    byte_offset_to_utf16_column(line, trimmed.len())
}
```

- [ ] **Step 4: Run the helper tests**

```bash
cargo test -p raven --lib eomc_ -- --nocapture
```

Expected: all 12 `eomc_*` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/handlers.rs
git commit -m "feat(diagnostics): add end_of_meaningful_content helper

String-aware trim of trailing comments and whitespace from a source line,
returning the UTF-16 column just past the last meaningful character.
Foundation for the new opener-anchored bracket diagnostics."
```

---

## Task 2: Add `CollectState`, `ClassifiedSyntaxDiagnostic`, `ErrorClassification` types

**Files:**
- Modify: `crates/raven/src/handlers.rs`

**Why this is second:** Subsequent tasks reference these types. No behavior change yet; just types.

- [ ] **Step 1: Define the types**

Insert near the existing classifier helpers (above `classify_error`, around line 6360):

```rust
/// One classified syntax-error diagnostic produced by `classify_error`.
/// Kept separate from `tower_lsp::lsp_types::Diagnostic` so that the
/// classifier doesn't need to fill in `source` / `severity` / etc. — the
/// caller (`collect_syntax_errors_inner`) does that.
#[derive(Debug, Clone)]
struct ClassifiedSyntaxDiagnostic {
    message: String,
    range: Range,
}

/// Result of classifying an ERROR node. A single ERROR can now produce
/// either one whole-error diagnostic (the existing classifiers) or
/// multiple per-fault diagnostics (the new delimiter scan).
#[derive(Debug, Clone)]
enum ErrorClassification {
    /// Single diagnostic describing the whole ERROR. Used by unclosed
    /// string, consecutive pipe, mismatched bracket, fat-arrow.
    Whole(ClassifiedSyntaxDiagnostic),
    /// Zero or more diagnostics, each describing a distinct delimiter
    /// fault inside the ERROR. An empty Vec means "no classifier matched
    /// — caller falls back to a single generic 'Syntax error' at the
    /// minimized range".
    Multi(Vec<ClassifiedSyntaxDiagnostic>),
}

/// Per-traversal mutable state threaded through `collect_syntax_errors_inner`
/// so that the mismatched-bracket coalescing rule can suppress a duplicate
/// `Unclosed X` diagnostic for the same opener.
#[derive(Default)]
struct CollectState {
    /// `Node::id()` values of opener tokens already covered by a
    /// `Mismatched brackets` diagnostic. The MISSING-anchoring branch
    /// skips emitting `Unclosed X` for any opener whose id appears here.
    covered_openers: std::collections::HashSet<usize>,
}
```

- [ ] **Step 2: Verify the crate still builds**

```bash
cargo build -p raven 2>&1 | tail -5
```

Expected: warnings about unused types, but no errors. (Warnings are OK at this stage — the types will be used in the next task.)

If you see "unused" warnings on the new types, that's fine and expected. Don't suppress them; they'll resolve as soon as Task 3 lands.

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/handlers.rs
git commit -m "feat(diagnostics): introduce ErrorClassification + CollectState types

Foundation for letting a single ERROR node produce multiple diagnostics
(one per distinct delimiter fault) while preserving the single-classifier
contract for existing classifiers. CollectState carries the
opener-coalescing suppression set through the recursion."
```

---

## Task 3: Refactor existing classifiers + `collect_syntax_errors` to new types (no behavior change)

**Files:**
- Modify: `crates/raven/src/handlers.rs` — `classify_error`, `collect_syntax_errors`, existing detector helpers

**Why this is third:** Convert `classify_error` from `String` to `ErrorClassification::Whole(...)` and thread `CollectState`. This is a pure refactor; the existing test suite must still pass byte-for-byte after this task.

The public signature `pub fn collect_syntax_errors(node, text, diagnostics)` is preserved by adding an inner helper.

- [ ] **Step 1: Find every existing caller of `classify_error` / `collect_syntax_errors`**

```bash
grep -n "classify_error\|collect_syntax_errors" crates/raven/src/handlers.rs | grep -v "^.*://" | head -30
```

Expected: one production caller of `classify_error` (inside `collect_syntax_errors` itself), one production caller of `collect_syntax_errors` (line 364 in this file), plus several test callsites that use the `collect()` helper in `mod syntax_error_range_tests`.

The public API must NOT change. Only the internal call from `collect_syntax_errors` to `classify_error` is affected by the refactor.

- [ ] **Step 2: Refactor `classify_error` to return `ErrorClassification`**

Replace the current function (around line 6369):

```rust
fn classify_error(node: Node, text: &str) -> String {
    if has_unclosed_quote_child(node) {
        return "Unclosed string literal".to_string();
    }
    if let Some(msg) = detect_consecutive_pipe(node, text) {
        return msg;
    }
    if let Some(msg) = detect_mismatched_bracket(node, text) {
        return msg;
    }
    if let Some(msg) = detect_fat_arrow(node, text) {
        return msg;
    }
    "Syntax error".to_string()
}
```

with:

```rust
fn classify_error(node: Node, text: &str, _state: &mut CollectState) -> ErrorClassification {
    let range = minimize_error_range(node, text);

    if has_unclosed_quote_child(node) {
        return ErrorClassification::Whole(ClassifiedSyntaxDiagnostic {
            message: "Unclosed string literal".to_string(),
            range,
        });
    }
    if let Some(msg) = detect_consecutive_pipe(node, text) {
        return ErrorClassification::Whole(ClassifiedSyntaxDiagnostic { message: msg, range });
    }
    if let Some(msg) = detect_mismatched_bracket(node, text) {
        return ErrorClassification::Whole(ClassifiedSyntaxDiagnostic { message: msg, range });
    }
    if let Some(msg) = detect_fat_arrow(node, text) {
        return ErrorClassification::Whole(ClassifiedSyntaxDiagnostic { message: msg, range });
    }
    // No classifier matched. Caller falls back to a single generic
    // "Syntax error" at the minimized range. Returning Multi(vec![]) is
    // the sentinel for "delimiter scan / fallback".
    ErrorClassification::Multi(Vec::new())
}
```

The `_state` parameter is unused for now — it's wired up so subsequent tasks (mismatched-bracket coalescing) can populate `covered_openers` without changing the signature again.

- [ ] **Step 3: Refactor `collect_syntax_errors` to use an inner helper that threads state**

Replace the current function (around line 6293):

```rust
fn collect_syntax_errors(node: Node, text: &str, diagnostics: &mut Vec<Diagnostic>) {
    if node.is_error() {
        let message = classify_error(node, text);
        diagnostics.push(Diagnostic {
            range: minimize_error_range(node, text),
            severity: Some(DiagnosticSeverity::ERROR),
            message,
            ..Default::default()
        });
        // Don't recurse into ERROR children — the minimized range already
        // accounts for nested MISSING nodes, and recursing would produce
        // duplicate diagnostics for nested ERROR children.
        return;
    }

    if node.is_missing() {
        // ... existing MISSING branch ...
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_syntax_errors(child, text, diagnostics);
    }
}
```

with:

```rust
fn collect_syntax_errors(node: Node, text: &str, diagnostics: &mut Vec<Diagnostic>) {
    let mut state = CollectState::default();
    collect_syntax_errors_inner(node, text, diagnostics, &mut state);
}

fn collect_syntax_errors_inner(
    node: Node,
    text: &str,
    diagnostics: &mut Vec<Diagnostic>,
    state: &mut CollectState,
) {
    if node.is_error() {
        match classify_error(node, text, state) {
            ErrorClassification::Whole(diag) => {
                diagnostics.push(Diagnostic {
                    range: diag.range,
                    severity: Some(DiagnosticSeverity::ERROR),
                    message: diag.message,
                    ..Default::default()
                });
            }
            ErrorClassification::Multi(diags) if diags.is_empty() => {
                // Fallback: generic "Syntax error" at the minimized range.
                diagnostics.push(Diagnostic {
                    range: minimize_error_range(node, text),
                    severity: Some(DiagnosticSeverity::ERROR),
                    message: "Syntax error".to_string(),
                    ..Default::default()
                });
            }
            ErrorClassification::Multi(diags) => {
                for diag in diags {
                    diagnostics.push(Diagnostic {
                        range: diag.range,
                        severity: Some(DiagnosticSeverity::ERROR),
                        message: diag.message,
                        ..Default::default()
                    });
                }
            }
        }
        // Don't recurse into ERROR children — same reasoning as before.
        return;
    }

    if node.is_missing() {
        // ... preserve the existing MISSING branch verbatim ...
        // (this task does NOT change MISSING behavior — Task 8 does)
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_syntax_errors_inner(child, text, diagnostics, state);
    }
}
```

Important: in this task you are NOT changing the MISSING branch. Copy-paste the existing MISSING logic from the original `collect_syntax_errors` into `collect_syntax_errors_inner` verbatim. Task 8 changes it.

- [ ] **Step 4: Run the full test suite**

```bash
cargo test -p raven --lib 2>&1 | tail -30
```

Expected: every test still passes. Pay particular attention to:

- `syntax_error_range_tests::*`
- `prop_missing_node_priority`, `prop_missing_node_width`, `prop_diagnostic_deduplication`, `prop_error_detection_completeness`, `prop_nested_condition_errors`

If any test fails, the refactor broke behavior — fix before continuing.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/handlers.rs
git commit -m "refactor(diagnostics): classify_error returns ErrorClassification

Pure refactor of the classifier boundary so that future delimiter-scan
logic can emit multiple diagnostics per ERROR. Existing classifiers all
return Whole(...); the unmatched fallthrough returns Multi(vec![]) which
the caller maps to a single 'Syntax error' (current behavior preserved).
CollectState is threaded but not yet consulted."
```

---

## Task 4: Add `find_opener_for_missing` helper

**Files:**
- Modify: `crates/raven/src/handlers.rs`

**Why this is fourth:** Needed by Task 8 (opener anchoring for bracket-kind MISSING).

**Contract:**

```rust
/// Walk up one level from a bracket-kind MISSING node to its structural
/// parent (`arguments`, `braced_expression`, `parenthesized_expression`)
/// and return the parent + a Range anchored on the parent's first child
/// (the opener token), spanning to end-of-meaningful-content on the
/// opener's line.
///
/// Returns `None` for:
/// - MISSINGs whose kind is not a bracket closer
/// - MISSINGs whose parent isn't one of the three structural kinds
///   (defensive: keep callers from blindly trusting the result on
///   unknown tree shapes)
fn find_opener_for_missing(missing: Node, text: &str) -> Option<(Node, Range)>;
```

- [ ] **Step 1: Add unit tests inside `mod syntax_error_range_tests`**

```rust
    // ------------------------------------------------------------------
    // find_opener_for_missing
    // ------------------------------------------------------------------

    use super::find_opener_for_missing;

    fn first_missing(tree: &tree_sitter::Tree) -> Option<tree_sitter::Node> {
        // Walks the tree and returns the first MISSING node encountered.
        fn walk<'a>(n: tree_sitter::Node<'a>) -> Option<tree_sitter::Node<'a>> {
            if n.is_missing() { return Some(n); }
            let mut c = n.walk();
            for child in n.children(&mut c) {
                if let Some(m) = walk(child) {
                    return Some(m);
                }
            }
            None
        }
        walk(tree.root_node())
    }

    #[test]
    fn fofm_call_arguments_paren() {
        // library( -> arguments( "(" MISSING ")" )
        let code = "library(";
        let tree = parse_r(code);
        let missing = first_missing(&tree).expect("expected MISSING");
        let (opener, range) = find_opener_for_missing(missing, code)
            .expect("should find opener for ( inside arguments");
        assert_eq!(opener.kind(), "(");
        assert_eq!(range.start.line, 0);
        assert_eq!(range.start.character, 7);  // `(` is at col 7
        assert_eq!(range.end.line, 0);
        assert_eq!(range.end.character, 8);    // EOL/eomc col
    }

    #[test]
    fn fofm_subset_arguments_bracket() {
        let code = "vec[1, 2\n";
        let tree = parse_r(code);
        let missing = first_missing(&tree).unwrap();
        let (opener, range) = find_opener_for_missing(missing, code).unwrap();
        assert_eq!(opener.kind(), "[");
        assert_eq!(range.start.character, 3);  // `[` is at col 3
        // end = end of meaningful content on line 0 = col 8 (just past "2")
        assert_eq!(range.end.character, 8);
    }

    #[test]
    fn fofm_subset2_arguments_double_bracket() {
        let code = "vec[[1, 2\n";
        let tree = parse_r(code);
        let missing = first_missing(&tree).unwrap();
        let (opener, range) = find_opener_for_missing(missing, code).unwrap();
        assert_eq!(opener.kind(), "[[");
        assert_eq!(range.start.character, 3);  // `[[` starts at col 3
        assert_eq!(range.end.character, 9);    // just past "2" at col 8
    }

    #[test]
    fn fofm_braced_expression() {
        let code = "f <- function() {\n  x <- 1\n";
        let tree = parse_r(code);
        let missing = first_missing(&tree).unwrap();
        let (opener, range) = find_opener_for_missing(missing, code).unwrap();
        assert_eq!(opener.kind(), "{");
        assert_eq!(range.start.line, 0);
        assert_eq!(range.start.character, 16);
        assert_eq!(range.end.character, 17);  // opener at EOL → range collapses to `{`
    }

    #[test]
    fn fofm_non_bracket_missing_returns_none() {
        // `x <-` produces a MISSING identifier at end of input.
        // Not a bracket closer kind — function returns None.
        let code = "x <-";
        let tree = parse_r(code);
        let missing = first_missing(&tree).unwrap();
        assert!(find_opener_for_missing(missing, code).is_none());
    }
```

- [ ] **Step 2: Run them to verify failure**

```bash
cargo test -p raven --lib fofm_ 2>&1 | tail -10
```

Expected: compile error (`find_opener_for_missing` not yet defined).

- [ ] **Step 3: Implement `find_opener_for_missing`**

Add this near `anchor_missing_position` (line ~5907):

```rust
/// Walk up one level from a bracket-kind MISSING node to its structural
/// parent and return that parent's opening delimiter token plus the
/// computed UTF-16 Range from the opener column through
/// `end_of_meaningful_content` of the opener's line.
///
/// Returns None when:
/// - `missing.kind()` is not one of `)` `}` `]` `]]`
/// - the parent's kind is not `arguments`, `braced_expression`, or
///   `parenthesized_expression`
fn find_opener_for_missing(missing: Node, text: &str) -> Option<(Node, Range)> {
    use crate::cross_file::types::byte_offset_to_utf16_column;

    // Only bracket-kind MISSINGs route through this helper.
    if !matches!(missing.kind(), ")" | "}" | "]" | "]]") {
        return None;
    }

    let parent = missing.parent()?;
    if !matches!(
        parent.kind(),
        "arguments" | "braced_expression" | "parenthesized_expression"
    ) {
        return None;
    }

    // The opener is the parent's first child whose token text matches
    // `(`, `{`, `[`, or `[[`. For `arguments` / `braced_expression` /
    // `parenthesized_expression` the opener is invariably the first
    // named or anonymous child after the structural parent's start,
    // so we scan from the beginning.
    let mut cursor = parent.walk();
    let opener = parent
        .children(&mut cursor)
        .find(|n| {
            let t = text.get(n.start_byte()..n.end_byte()).unwrap_or("");
            matches!(t, "(" | "{" | "[" | "[[")
        })?;

    let opener_row = opener.start_position().row as u32;
    let opener_start_byte = opener.start_position().column;

    let line = text.lines().nth(opener_row as usize).unwrap_or("");
    let start_col = byte_offset_to_utf16_column(line, opener_start_byte);
    let end_col = end_of_meaningful_content(line);

    // If end_of_meaningful_content reports a column <= start, the opener
    // is the last meaningful character on its line. Give the range a
    // single-column width so the squiggle is visible.
    let end_col = if end_col > start_col {
        end_col
    } else {
        // For multi-char openers like `[[`, span the opener token's width.
        let opener_end_byte = opener.end_position().column;
        byte_offset_to_utf16_column(line, opener_end_byte).max(start_col + 1)
    };

    Some((
        opener,
        Range {
            start: Position::new(opener_row, start_col),
            end: Position::new(opener_row, end_col),
        },
    ))
}
```

- [ ] **Step 4: Run the helper tests**

```bash
cargo test -p raven --lib fofm_ -- --nocapture
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/handlers.rs
git commit -m "feat(diagnostics): add find_opener_for_missing helper

Single-level parent walk from a bracket-kind MISSING node to its
structural parent (arguments / braced_expression /
parenthesized_expression), returning the opener token + range anchored
on the opener through end-of-meaningful-content."
```

---

## Task 5: Delimiter-scan event extraction

**Files:**
- Modify: `crates/raven/src/handlers.rs`

**Why this is fifth:** The delimiter scan is the core new mechanism. Build it bottom-up: events first, stack processing next.

**Contract:**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DelimiterKind { Paren, Brace, Bracket, DoubleBracket }

#[derive(Debug, Clone)]
struct DelimEvent {
    is_open: bool,
    kind: DelimiterKind,
    /// Byte range of the underlying source. start_byte..end_byte.
    range_bytes: std::ops::Range<usize>,
    /// Row of the start position (for line lookups).
    row: u32,
}

/// Walk an ERROR node's *direct* children left-to-right and emit a
/// flat stream of opener/closer events. Special-cases:
///   - A leaf whose entire text is a homogeneous run of one closer
///     character (`}}}`, `)))`, repeated `]]`) emits ONE close event
///     covering the whole leaf.
///   - A leaf with a *mixed* run of closer chars (`])`, `}]`, etc.)
///     emits one event per character, with `]]` recognized greedily.
///   - Nested ERRORs are recursed into for delimiter extraction.
///   - Non-error, non-leaf children (identifiers, complete subtrees)
///     are skipped — they have their own balanced delimiters which the
///     parser has already validated.
fn delimiter_events(error: Node, text: &str) -> Vec<DelimEvent>;
```

- [ ] **Step 1: Add the type + tests**

Insert the types just above the new helper. Add tests inside `mod syntax_error_range_tests`:

```rust
    use super::{delimiter_events, DelimiterKind};

    fn find_first_error(tree: &tree_sitter::Tree) -> Option<tree_sitter::Node> {
        fn walk<'a>(n: tree_sitter::Node<'a>) -> Option<tree_sitter::Node<'a>> {
            if n.is_error() { return Some(n); }
            let mut c = n.walk();
            for child in n.children(&mut c) {
                if let Some(e) = walk(child) {
                    return Some(e);
                }
            }
            None
        }
        walk(tree.root_node())
    }

    #[test]
    fn devents_flat_nested_openers() {
        // f(g(h(   -> ERROR("(" "g" "(" "h" "(")
        let code = "f(g(h(\n";
        let tree = parse_r(code);
        let err = find_first_error(&tree).unwrap();
        let evs = delimiter_events(err, code);
        // Three opener events for the three `(`
        assert_eq!(evs.len(), 3);
        for ev in &evs {
            assert!(ev.is_open);
            assert_eq!(ev.kind, DelimiterKind::Paren);
        }
    }

    #[test]
    fn devents_stray_close_brace() {
        // x <- 1\n}\n  -> sibling ERROR(ERROR "}")
        let code = "x <- 1\n}\n";
        let tree = parse_r(code);
        let err = find_first_error(&tree).unwrap();
        let evs = delimiter_events(err, code);
        assert_eq!(evs.len(), 1);
        assert!(!evs[0].is_open);
        assert_eq!(evs[0].kind, DelimiterKind::Brace);
    }

    #[test]
    fn devents_homogeneous_run() {
        // }}}  -> ERROR(ERROR "}}}")
        // One close event spanning the whole run.
        let code = "}}}\n";
        let tree = parse_r(code);
        let err = find_first_error(&tree).unwrap();
        let evs = delimiter_events(err, code);
        assert_eq!(evs.len(), 1);
        assert!(!evs[0].is_open);
        assert_eq!(evs[0].kind, DelimiterKind::Brace);
        assert_eq!(evs[0].range_bytes, 0..3);
    }

    #[test]
    fn devents_mixed_closer_run() {
        // Construct a code snippet where a leaf with mixed closer text
        // appears inside an ERROR. The simplest reliable shape:
        // `f(])`  -> the inner ERROR contains a "])" leaf.
        // Verify the test against the actual parse before locking in
        // expectations; the assertion below is what the spec requires.
        let code = "f(])";
        let tree = parse_r(code);
        let err = find_first_error(&tree).unwrap();
        let evs = delimiter_events(err, code);
        // Expect at least one open `(` and two close events `]` and `)`.
        let open_count = evs.iter().filter(|e| e.is_open).count();
        let close_count = evs.iter().filter(|e| !e.is_open).count();
        assert!(open_count >= 1, "expected at least one open event, got: {evs:?}");
        assert!(close_count >= 2, "expected at least two close events, got: {evs:?}");
        // Confirm the two closes are kinds `]` then `)`.
        let mut closes = evs.iter().filter(|e| !e.is_open);
        let first = closes.next().unwrap();
        let second = closes.next().unwrap();
        assert_eq!(first.kind, DelimiterKind::Bracket);
        assert_eq!(second.kind, DelimiterKind::Paren);
    }

    #[test]
    fn devents_double_bracket_run() {
        // `]]]]`  -> homogeneous run of `]]` pairs
        // Greedy pairing: two `]]` events.
        let code = "]]]]\n";
        let tree = parse_r(code);
        let err = find_first_error(&tree).unwrap();
        let evs = delimiter_events(err, code);
        // Expect: two close events of kind DoubleBracket
        let closes: Vec<_> = evs.iter().filter(|e| !e.is_open).collect();
        assert_eq!(closes.len(), 2, "got events: {evs:?}");
        for c in closes {
            assert_eq!(c.kind, DelimiterKind::DoubleBracket);
        }
    }

    #[test]
    fn devents_triple_bracket_pairs_then_single() {
        // `]]]`  -> one `]]` event followed by one `]` event (greedy left-to-right)
        let code = "]]]\n";
        let tree = parse_r(code);
        let err = find_first_error(&tree).unwrap();
        let evs = delimiter_events(err, code);
        let closes: Vec<_> = evs.iter().filter(|e| !e.is_open).collect();
        assert_eq!(closes.len(), 2, "got events: {evs:?}");
        assert_eq!(closes[0].kind, DelimiterKind::DoubleBracket);
        assert_eq!(closes[1].kind, DelimiterKind::Bracket);
    }
```

- [ ] **Step 2: Verify the tests fail to compile**

```bash
cargo test -p raven --lib devents_ 2>&1 | tail -10
```

Expected: compile error (types / function not defined).

- [ ] **Step 3: Implement event extraction**

Add the types + helper near `classify_error`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DelimiterKind {
    Paren,         // ( )
    Brace,         // { }
    Bracket,       // [ ]
    DoubleBracket, // [[ ]]
}

impl DelimiterKind {
    fn opener_str(self) -> &'static str {
        match self {
            DelimiterKind::Paren => "(",
            DelimiterKind::Brace => "{",
            DelimiterKind::Bracket => "[",
            DelimiterKind::DoubleBracket => "[[",
        }
    }
    fn closer_str(self) -> &'static str {
        match self {
            DelimiterKind::Paren => ")",
            DelimiterKind::Brace => "}",
            DelimiterKind::Bracket => "]",
            DelimiterKind::DoubleBracket => "]]",
        }
    }
    fn from_opener(s: &str) -> Option<Self> {
        match s {
            "(" => Some(Self::Paren),
            "{" => Some(Self::Brace),
            "[" => Some(Self::Bracket),
            "[[" => Some(Self::DoubleBracket),
            _ => None,
        }
    }
    fn from_closer(s: &str) -> Option<Self> {
        match s {
            ")" => Some(Self::Paren),
            "}" => Some(Self::Brace),
            "]" => Some(Self::Bracket),
            "]]" => Some(Self::DoubleBracket),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
struct DelimEvent {
    is_open: bool,
    kind: DelimiterKind,
    range_bytes: std::ops::Range<usize>,
    row: u32,
}

/// Walk an ERROR node's direct children and produce a flat stream of
/// delimiter events. See doc on `delimiter_events` in the spec.
fn delimiter_events(error: Node, text: &str) -> Vec<DelimEvent> {
    let mut out = Vec::new();
    walk_for_delimiters(error, text, &mut out, /*allow_recurse_into_error=*/ true);
    out
}

fn walk_for_delimiters(
    node: Node,
    text: &str,
    out: &mut Vec<DelimEvent>,
    allow_recurse_into_error: bool,
) {
    // Only the ROOT ERROR is walked with `allow_recurse_into_error=true`;
    // we recurse one level into nested ERRORs but not into balanced
    // semantic children.
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.is_error() && allow_recurse_into_error {
            // Recurse into nested ERROR with allow=false (one level only).
            walk_for_delimiters(child, text, out, false);
            continue;
        }
        if child.child_count() == 0 {
            // Leaf — extract delimiter events from raw text
            let raw = text.get(child.start_byte()..child.end_byte()).unwrap_or("");
            extract_from_leaf(raw, child.start_byte(), child.start_position().row as u32, out);
            continue;
        }
        // Non-leaf, non-error child: skip (its delimiters are balanced).
    }
}

/// Extract delimiter events from a raw leaf text slice. Implements the
/// homogeneous-run rule (`}}}` → one event) and the mixed-run rule
/// (`])` → per-character events with `]]` recognized greedily).
fn extract_from_leaf(raw: &str, base_byte: usize, row: u32, out: &mut Vec<DelimEvent>) {
    // First pass: recognize opener/closer tokens as exact matches.
    // For most leaves (`(`, `}`, `]]`, etc.), the leaf is a single token.
    if let Some(k) = DelimiterKind::from_opener(raw) {
        out.push(DelimEvent {
            is_open: true,
            kind: k,
            range_bytes: base_byte..base_byte + raw.len(),
            row,
        });
        return;
    }
    if let Some(k) = DelimiterKind::from_closer(raw) {
        out.push(DelimEvent {
            is_open: false,
            kind: k,
            range_bytes: base_byte..base_byte + raw.len(),
            row,
        });
        return;
    }

    // Leaf contains multiple characters (run of closers or mixed).
    // Check homogeneity for `}}}`/`)))`/`]]]...]` patterns.
    let all_brace = !raw.is_empty() && raw.chars().all(|c| c == '}');
    let all_paren = !raw.is_empty() && raw.chars().all(|c| c == ')');
    if all_brace {
        out.push(DelimEvent {
            is_open: false,
            kind: DelimiterKind::Brace,
            range_bytes: base_byte..base_byte + raw.len(),
            row,
        });
        return;
    }
    if all_paren {
        out.push(DelimEvent {
            is_open: false,
            kind: DelimiterKind::Paren,
            range_bytes: base_byte..base_byte + raw.len(),
            row,
        });
        return;
    }

    // Otherwise: tokenize per-character left-to-right, recognizing `]]`
    // greedily.
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b']' && i + 1 < bytes.len() && bytes[i + 1] == b']' {
            out.push(DelimEvent {
                is_open: false,
                kind: DelimiterKind::DoubleBracket,
                range_bytes: base_byte + i..base_byte + i + 2,
                row,
            });
            i += 2;
            continue;
        }
        let one = std::str::from_utf8(&bytes[i..i + 1]).unwrap_or("");
        if let Some(k) = DelimiterKind::from_opener(one) {
            out.push(DelimEvent {
                is_open: true,
                kind: k,
                range_bytes: base_byte + i..base_byte + i + 1,
                row,
            });
        } else if let Some(k) = DelimiterKind::from_closer(one) {
            out.push(DelimEvent {
                is_open: false,
                kind: k,
                range_bytes: base_byte + i..base_byte + i + 1,
                row,
            });
        }
        // Non-delimiter chars in a leaf are skipped silently.
        i += 1;
    }
}
```

- [ ] **Step 4: Run the tests**

```bash
cargo test -p raven --lib devents_ -- --nocapture
```

Expected: all 6 devents_ tests PASS. If `devents_mixed_closer_run` or other tests fail, FIRST run a one-off probe to print the actual parse tree (see the probe-test pattern below) before deciding whether the implementation is wrong or the test expectation is wrong. The spec assertions are derived from probed shapes for the listed inputs; if the parser version produces something different, update the test.

Probe pattern (paste into a temp `#[test]`, run, then remove):

```rust
#[test]
fn _probe() {
    let code = "f(])";
    let tree = parse_r(code);
    fn dump(n: tree_sitter::Node, src: &str, depth: usize) {
        let kind = n.kind();
        let txt = if n.child_count() == 0 { format!(" {:?}", &src[n.byte_range()]) } else { String::new() };
        let flag = if n.is_error() { "[ERROR]" } else if n.is_missing() { "[MISSING]" } else { "" };
        println!("{}{} {}{}", "  ".repeat(depth), kind, flag, txt);
        let mut c = n.walk();
        for ch in n.children(&mut c) { dump(ch, src, depth+1); }
    }
    dump(tree.root_node(), code, 0);
    panic!("probe");
}
```

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/handlers.rs
git commit -m "feat(diagnostics): delimiter_events extracts open/close stream

Walks an ERROR node's direct children left-to-right (one level of nested
ERROR recursion) and produces flat opener/closer events. Handles
homogeneous closer-runs (}}}) as a single event, mixed runs (]) as
per-character events with ]] recognized greedily."
```

---

## Task 6: Delimiter-scan stack processing → diagnostics

**Files:**
- Modify: `crates/raven/src/handlers.rs`

**Why this is sixth:** Convert events into diagnostics with proper messages, ranges, and the next-opener tie-breaking rule.

**Contract:**

```rust
/// Process a delimiter event stream through a stack and produce
/// classified diagnostics. Records any opener covered by a
/// `Mismatched brackets` diagnostic in `state.covered_openers`.
fn classify_via_delimiter_scan(
    error: Node,
    text: &str,
    state: &mut CollectState,
) -> Vec<ClassifiedSyntaxDiagnostic>;
```

- [ ] **Step 1: Add tests**

Inside `mod syntax_error_range_tests`:

```rust
    use super::classify_via_delimiter_scan;

    fn run_scan(code: &str) -> Vec<(String, lsp_types::Range)> {
        use super::CollectState;
        let tree = parse_r(code);
        let err = find_first_error(&tree).expect("expected ERROR node");
        let mut state = CollectState::default();
        classify_via_delimiter_scan(err, code, &mut state)
            .into_iter()
            .map(|d| (d.message, d.range))
            .collect()
    }

    #[test]
    fn scan_stray_close_brace() {
        let diags = run_scan("x <- 1\n}\n");
        assert_eq!(diags.len(), 1);
        assert!(diags[0].0.contains("Missing opening `{`"), "got: {}", diags[0].0);
        assert_eq!(diags[0].1.start.line, 1);
        assert_eq!(diags[0].1.start.character, 0);
        assert_eq!(diags[0].1.end.character, 1);
    }

    #[test]
    fn scan_stray_close_paren() {
        let diags = run_scan("x <- 1\n)\n");
        assert_eq!(diags.len(), 1);
        assert!(diags[0].0.contains("Missing opening `(`"));
    }

    #[test]
    fn scan_stray_close_bracket() {
        let diags = run_scan("x <- 1\n]\n");
        assert_eq!(diags.len(), 1);
        assert!(diags[0].0.contains("Missing opening `[`"));
    }

    #[test]
    fn scan_stray_double_close_bracket() {
        let diags = run_scan("x <- 1\n]]\n");
        assert_eq!(diags.len(), 1);
        assert!(diags[0].0.contains("Missing opening `[[`"));
        // range covers both `]`s on line 1
        assert_eq!(diags[0].1.start.character, 0);
        assert_eq!(diags[0].1.end.character, 2);
    }

    #[test]
    fn scan_homogeneous_brace_run_single_diagnostic() {
        let diags = run_scan("}}}\n");
        assert_eq!(diags.len(), 1, "got: {diags:?}");
        assert!(diags[0].0.contains("Missing opening `{`"));
        assert_eq!(diags[0].1.start.character, 0);
        assert_eq!(diags[0].1.end.character, 3);
    }

    #[test]
    fn scan_flat_nested_openers_three_diagnostics() {
        let diags = run_scan("f(g(h(\n");
        assert_eq!(diags.len(), 3, "got: {diags:?}");
        for d in &diags {
            assert!(d.0.contains("Unclosed `(`"));
        }
        // Ranges per spec (next-opener tie-breaking):
        //   outer `(` cols 1..3
        //   middle `(` cols 3..5
        //   inner  `(` cols 5..6
        let mut sorted = diags.clone();
        sorted.sort_by_key(|d| d.1.start.character);
        assert_eq!(sorted[0].1.start.character, 1);
        assert_eq!(sorted[0].1.end.character, 3);
        assert_eq!(sorted[1].1.start.character, 3);
        assert_eq!(sorted[1].1.end.character, 5);
        assert_eq!(sorted[2].1.start.character, 5);
        assert_eq!(sorted[2].1.end.character, 6);
    }

    #[test]
    fn scan_flat_error_mismatched_close_coalesces() {
        // `f(}` -> flat ERROR contains "(" and ERROR("}")
        // Inside the delimiter scan, top-of-stack is `(`, incoming
        // closer is `}`. The mismatched-bracket sub-rule fires:
        // one diagnostic, "Mismatched brackets: `(` opened here;
        // close with `)` not `}`."
        let diags = run_scan("f(}\n");
        assert_eq!(diags.len(), 1, "got: {diags:?}");
        assert!(
            diags[0].0.contains("Mismatched brackets") && diags[0].0.contains("`(`") && diags[0].0.contains("`}`"),
            "got: {}",
            diags[0].0,
        );
    }
```

- [ ] **Step 2: Verify the tests fail**

```bash
cargo test -p raven --lib scan_ 2>&1 | tail -10
```

Expected: compile error (`classify_via_delimiter_scan` not yet defined).

- [ ] **Step 3: Implement `classify_via_delimiter_scan`**

Add near `classify_error`:

```rust
fn classify_via_delimiter_scan(
    error: Node,
    text: &str,
    state: &mut CollectState,
) -> Vec<ClassifiedSyntaxDiagnostic> {
    use crate::cross_file::types::byte_offset_to_utf16_column;

    struct StackItem {
        kind: DelimiterKind,
        row: u32,
        start_byte: usize,
        node_id: usize,
    }

    let events = delimiter_events(error, text);
    let mut stack: Vec<StackItem> = Vec::new();
    let mut out: Vec<ClassifiedSyntaxDiagnostic> = Vec::new();

    // Map event byte ranges back to actual tree-sitter nodes so we
    // can record covered opener IDs. We do this by scanning the
    // error's direct children + one level of nested ERROR children,
    // matching by byte-range overlap with each open event.
    fn find_node_by_byte<'a>(
        root: Node<'a>,
        target: usize,
        depth: usize,
    ) -> Option<Node<'a>> {
        if depth > 2 { return None; }
        let mut c = root.walk();
        for ch in root.children(&mut c) {
            if ch.start_byte() == target && ch.child_count() == 0 {
                return Some(ch);
            }
            if ch.is_error() {
                if let Some(found) = find_node_by_byte(ch, target, depth + 1) {
                    return Some(found);
                }
            }
        }
        None
    }

    for ev in &events {
        if ev.is_open {
            stack.push(StackItem {
                kind: ev.kind,
                row: ev.row,
                start_byte: ev.range_bytes.start,
                node_id: find_node_by_byte(error, ev.range_bytes.start, 0)
                    .map(|n| n.id())
                    .unwrap_or(0),
            });
            continue;
        }
        // closer
        match stack.last() {
            None => {
                // stray closer
                let line = text.lines().nth(ev.row as usize).unwrap_or("");
                let line_start = line_start_byte(text, ev.row as usize);
                let start_col_byte = ev.range_bytes.start - line_start;
                let end_col_byte = ev.range_bytes.end - line_start;
                out.push(ClassifiedSyntaxDiagnostic {
                    message: format!("Missing opening `{}`", ev.kind.opener_str()),
                    range: Range {
                        start: Position::new(
                            ev.row,
                            byte_offset_to_utf16_column(line, start_col_byte),
                        ),
                        end: Position::new(
                            ev.row,
                            byte_offset_to_utf16_column(line, end_col_byte),
                        ),
                    },
                });
            }
            Some(top) if top.kind == ev.kind => {
                stack.pop();
            }
            Some(top) => {
                // mismatched — emit and pop
                let opener_kind = top.kind;
                let opener_node_id = top.node_id;
                let line = text.lines().nth(ev.row as usize).unwrap_or("");
                let line_start = line_start_byte(text, ev.row as usize);
                let start_col_byte = ev.range_bytes.start - line_start;
                let end_col_byte = ev.range_bytes.end - line_start;
                out.push(ClassifiedSyntaxDiagnostic {
                    message: format!(
                        "Mismatched brackets: `{}` opened here; close with `{}` not `{}`.",
                        opener_kind.opener_str(),
                        opener_kind.closer_str(),
                        ev.kind.closer_str(),
                    ),
                    range: Range {
                        start: Position::new(
                            ev.row,
                            byte_offset_to_utf16_column(line, start_col_byte),
                        ),
                        end: Position::new(
                            ev.row,
                            byte_offset_to_utf16_column(line, end_col_byte),
                        ),
                    },
                });
                if opener_node_id != 0 {
                    state.covered_openers.insert(opener_node_id);
                }
                stack.pop();
            }
        }
    }

    // Process unclosed openers remaining on the stack. Compute ranges
    // with the "next-opener-on-same-line" tie-breaking rule.
    //
    // For each opener at row R, the range end is min(
    //   next-opener-start on row R (if any),
    //   end_of_meaningful_content of row R,
    // ).
    if !stack.is_empty() {
        // Index openers on the stack by row so we can find the next
        // opener on the same line for each one.
        let row_of: Vec<u32> = stack.iter().map(|s| s.row).collect();
        let start_byte_of: Vec<usize> = stack.iter().map(|s| s.start_byte).collect();

        for (i, item) in stack.iter().enumerate() {
            let line = text.lines().nth(item.row as usize).unwrap_or("");
            let line_start = line_start_byte(text, item.row as usize);
            let start_col_utf16 = byte_offset_to_utf16_column(line, item.start_byte - line_start);

            // Next opener on the same row at a later byte offset
            let next_on_row = (i + 1..stack.len())
                .find(|&j| row_of[j] == item.row && start_byte_of[j] > item.start_byte)
                .map(|j| byte_offset_to_utf16_column(line, start_byte_of[j] - line_start));

            let eomc = end_of_meaningful_content(line);
            let mut end_col = next_on_row.unwrap_or(eomc).min(eomc);
            if end_col <= start_col_utf16 {
                // Collapse to opener-token width (1 or 2)
                let opener_len_utf16 = match item.kind {
                    DelimiterKind::DoubleBracket => 2,
                    _ => 1,
                };
                end_col = start_col_utf16 + opener_len_utf16;
            }

            out.push(ClassifiedSyntaxDiagnostic {
                message: format!(
                    "Unclosed `{}`: missing matching `{}`",
                    item.kind.opener_str(),
                    item.kind.closer_str(),
                ),
                range: Range {
                    start: Position::new(item.row, start_col_utf16),
                    end: Position::new(item.row, end_col),
                },
            });
        }
    }

    out
}

/// Byte offset of the start of line `row` in `text` (0-indexed row).
fn line_start_byte(text: &str, row: usize) -> usize {
    let mut start = 0;
    let mut current_row = 0;
    for (idx, b) in text.bytes().enumerate() {
        if current_row == row { return start; }
        if b == b'\n' {
            current_row += 1;
            start = idx + 1;
        }
    }
    if current_row == row { start } else { text.len() }
}
```

- [ ] **Step 4: Wire the scan into `classify_error`**

Modify `classify_error` (added in Task 3) so that after the existing classifiers fall through, the delimiter scan runs:

```rust
fn classify_error(node: Node, text: &str, state: &mut CollectState) -> ErrorClassification {
    let range = minimize_error_range(node, text);

    if has_unclosed_quote_child(node) {
        return ErrorClassification::Whole(ClassifiedSyntaxDiagnostic {
            message: "Unclosed string literal".to_string(),
            range,
        });
    }
    if let Some(msg) = detect_consecutive_pipe(node, text) {
        return ErrorClassification::Whole(ClassifiedSyntaxDiagnostic { message: msg, range });
    }
    if let Some(msg) = detect_mismatched_bracket(node, text) {
        return ErrorClassification::Whole(ClassifiedSyntaxDiagnostic { message: msg, range });
    }
    if let Some(msg) = detect_fat_arrow(node, text) {
        return ErrorClassification::Whole(ClassifiedSyntaxDiagnostic { message: msg, range });
    }

    // Delimiter scan: produces zero or more per-fault diagnostics.
    let scan = classify_via_delimiter_scan(node, text, state);
    ErrorClassification::Multi(scan)
}
```

- [ ] **Step 5: Run tests**

```bash
cargo test -p raven --lib scan_ -- --nocapture
```

Expected: all 7 scan_ tests PASS.

- [ ] **Step 6: Run the full suite to surface any regression**

```bash
cargo test -p raven --lib 2>&1 | tail -30
```

Expected: most existing tests still pass. Some EXISTING tests that asserted `message == "Syntax error"` for cases now classified by the delimiter scan will fail — those are intentional behavior changes. Specifically:

- `unclosed_paren_diagnostic_anchors_on_offending_line` — expected `Missing )`, now expects `Unclosed \`(\`: missing matching \`)\``. Update the test in this task.
- Any `assert!(diag.message == "Syntax error" || diag.message.starts_with("Missing"))` patterns — relax to also accept `Unclosed`/`Missing opening`.

For each affected existing test, update the assertions to reflect the new messages. Do NOT change the input or behavioral expectations beyond message text and (where applicable) the new opener-anchored ranges.

If a test that doesn't involve brackets fails, that's a real regression — stop and fix.

- [ ] **Step 7: Commit**

```bash
git add crates/raven/src/handlers.rs
git commit -m "feat(diagnostics): delimiter-scan stack processing emits per-fault diagnostics

Stack-based event processing inside ERROR nodes:
- stray closer  -> 'Missing opening X'
- matched pair  -> popped silently
- mismatched    -> 'Mismatched brackets' + records opener in covered_openers
- unclosed openers at end of stream -> 'Unclosed X: missing matching Y'
  with non-overlapping ranges (next opener on same line or eomc rule)"
```

---

## Task 7: Integrate delimiter scan into MISSING-node anchoring

**Files:**
- Modify: `crates/raven/src/handlers.rs`

**Why this is seventh:** Bracket-kind MISSING nodes need to route through `find_opener_for_missing` instead of `anchor_missing_position`. Non-bracket MISSINGs (e.g. trailing identifier of `x <-`) keep the old path. Also honors `state.covered_openers` to suppress duplicates.

- [ ] **Step 1: Add the unclosed-anchor tests**

Inside `mod syntax_error_range_tests`:

```rust
    #[test]
    fn unclosed_paren_anchors_on_opener() {
        // mean(c(1,2,3) -- opener `(` of mean( at col 9, EOL at col 20
        let diags = collect("x <- mean(c(1, 2, 3)\n\n# comment\n");
        let target = diags
            .iter()
            .find(|d| d.message.contains("Unclosed `(`"))
            .expect("expected Unclosed ( diagnostic");
        assert_eq!(target.range.start.line, 0);
        assert_eq!(target.range.start.character, 9);
        assert_eq!(target.range.end.line, 0);
        assert_eq!(target.range.end.character, 20);
    }

    #[test]
    fn unclosed_brace_anchors_on_opener() {
        // f <- function() { ... -- opener `{` at col 16, EOL at col 17
        let diags = collect("f <- function() {\n  x <- 1\n  y <- 2\n");
        let target = diags
            .iter()
            .find(|d| d.message.contains("Unclosed `{`"))
            .expect("expected Unclosed { diagnostic");
        assert_eq!(target.range.start.line, 0);
        assert_eq!(target.range.start.character, 16);
        assert_eq!(target.range.end.character, 17);
    }

    #[test]
    fn unclosed_bracket_anchors_on_opener() {
        let diags = collect("vec[1, 2\n");
        let target = diags
            .iter()
            .find(|d| d.message.contains("Unclosed `[`"))
            .expect("expected Unclosed [ diagnostic");
        assert_eq!(target.range.start.character, 3);
        assert_eq!(target.range.end.character, 8); // past "2"
    }

    #[test]
    fn unclosed_double_bracket_anchors_on_opener() {
        let diags = collect("vec[[1, 2\n");
        let target = diags
            .iter()
            .find(|d| d.message.contains("Unclosed `[[`"))
            .expect("expected Unclosed [[ diagnostic");
        assert_eq!(target.range.start.character, 3);
        assert_eq!(target.range.end.character, 9);
    }

    #[test]
    fn unclosed_paren_at_end_of_file() {
        let diags = collect("library(");
        let target = diags
            .iter()
            .find(|d| d.message.contains("Unclosed `(`"))
            .expect("expected Unclosed ( diagnostic");
        assert_eq!(target.range.start.line, 0);
        assert_eq!(target.range.start.character, 7); // `(` at col 7
        // EOL of `library(` is col 8 (after the `(`).
        assert_eq!(target.range.end.character, 8);
    }

    #[test]
    fn unclosed_opener_with_trailing_comment() {
        // `f( # comment\n` -- opener `(` at col 1; comment immediately follows.
        // Range collapses to just the `(` token (col 1..2).
        let diags = collect("f( # comment\n");
        let target = diags
            .iter()
            .find(|d| d.message.contains("Unclosed `(`"))
            .expect("expected Unclosed ( diagnostic");
        assert_eq!(target.range.start.character, 1);
        assert_eq!(target.range.end.character, 2);
    }

    #[test]
    fn unclosed_opener_with_trailing_whitespace() {
        let diags = collect("f(   \n");
        let target = diags
            .iter()
            .find(|d| d.message.contains("Unclosed `(`"))
            .expect("expected Unclosed ( diagnostic");
        assert_eq!(target.range.start.character, 1);
        assert_eq!(target.range.end.character, 2);
    }
```

- [ ] **Step 2: Verify the tests fail**

```bash
cargo test -p raven --lib unclosed_ 2>&1 | tail -20
```

Expected: failures (current code anchors on the MISSING position, not the opener; messages may be `Missing )` instead of the new `Unclosed \`(\``).

- [ ] **Step 3: Modify the MISSING branch of `collect_syntax_errors_inner`**

In the MISSING branch (which you preserved verbatim during Task 3), add a bracket-kind dispatch BEFORE the existing logic:

```rust
    if node.is_missing() {
        // Bracket-kind MISSING routes through the opener-anchoring helper
        // unless the opener is already covered by a mismatched-bracket
        // diagnostic emitted earlier in this traversal.
        if matches!(node.kind(), ")" | "}" | "]" | "]]") {
            if let Some((opener, range)) = find_opener_for_missing(node, text) {
                if !state.covered_openers.contains(&opener.id()) {
                    let opener_kind = DelimiterKind::from_opener(
                        text.get(opener.start_byte()..opener.end_byte()).unwrap_or(""),
                    );
                    if let Some(k) = opener_kind {
                        diagnostics.push(Diagnostic {
                            range,
                            severity: Some(DiagnosticSeverity::ERROR),
                            message: format!(
                                "Unclosed `{}`: missing matching `{}`",
                                k.opener_str(),
                                k.closer_str(),
                            ),
                            ..Default::default()
                        });
                    }
                }
                return;
            }
            // Bracket-kind MISSING but no structural parent: fall through
            // to the existing default branch (defensive).
        }

        // Existing default branch for non-bracket MISSING (e.g. identifier
        // missing after `x <-`):
        let (row, col) = anchor_missing_position(
            node.start_position().row,
            node.start_position().column,
            0,
            node.start_byte(),
            text,
        );
        let message = if is_string_quote_kind(node.kind()) {
            "Unclosed string literal".to_string()
        } else {
            format!("Missing {}", node.kind())
        };
        diagnostics.push(Diagnostic {
            range: Range {
                start: Position::new(row, col),
                end: Position::new(row, col.saturating_add(1)),
            },
            severity: Some(DiagnosticSeverity::ERROR),
            message,
            ..Default::default()
        });
    }
```

- [ ] **Step 4: Run the unclosed_ tests**

```bash
cargo test -p raven --lib unclosed_ -- --nocapture
```

Expected: all 7 `unclosed_*` tests PASS.

- [ ] **Step 5: Run the full suite + fix unavoidable existing-test message drift**

```bash
cargo test -p raven --lib 2>&1 | tail -40
```

Expected: tests that asserted exact `Missing )` / `Missing }` etc. need their assertions updated to the new `Unclosed X: missing matching Y` text. Adjust each by changing the assertion text only; don't change the input.

Tests likely affected (search for `Missing )` / `Missing }` in the test sections):

- `unclosed_paren_diagnostic_anchors_on_offending_line`
- `unclosed_library_call`
- Anything filtering by `d.message.starts_with("Missing")` — relax to also include `"Unclosed"`.

- [ ] **Step 6: Commit**

```bash
git add crates/raven/src/handlers.rs
git commit -m "feat(diagnostics): anchor bracket-kind MISSING on the opener

Bracket-kind MISSING nodes (), }, ], ]]) now route through
find_opener_for_missing for an opener-anchored range with the new
'Unclosed X: missing matching Y' message. Non-bracket MISSINGs (e.g.
the trailing identifier of 'x <-') keep their existing path.

state.covered_openers is honored: openers already covered by a
Mismatched-brackets diagnostic are not re-reported."
```

---

## Task 8: Arguments-shape coalescing for `f(} y`-style typos

**Files:**
- Modify: `crates/raven/src/handlers.rs`

**Why this is eighth:** Handle the parse shape where the wrong closer lives in an ERROR child of `arguments` and a MISSING `)` is the last child. Without this, the user gets two diagnostics for a single typo.

- [ ] **Step 1: Add the coalescing tests**

```rust
    #[test]
    fn coalesce_wrong_closer_in_arguments_with_trailing_arg() {
        // f(} y  -> arguments( "(" ERROR("}") argument MISSING ")" )
        // Coalesces to a single Mismatched-brackets diagnostic.
        let diags = collect("f(} y\n");
        assert_eq!(diags.len(), 1, "got: {diags:?}");
        let d = &diags[0];
        assert!(
            d.message.contains("Mismatched brackets") && d.message.contains("`(`") && d.message.contains("`}`"),
            "got: {}",
            d.message,
        );
    }

    #[test]
    fn coalesce_wrong_closer_for_subset() {
        // `vec[} y` -- analog of f(} y for `[`
        let diags = collect("vec[} y\n");
        assert_eq!(diags.len(), 1, "got: {diags:?}");
        let d = &diags[0];
        assert!(
            d.message.contains("Mismatched brackets") && d.message.contains("`[`") && d.message.contains("`}`"),
            "got: {}",
            d.message,
        );
    }

    #[test]
    fn coalesce_no_double_fire_unclosed_after_mismatch() {
        // After coalescing, the MISSING `)` follow-up MUST be suppressed.
        let diags = collect("f(} y\n");
        assert!(
            !diags.iter().any(|d| d.message.contains("Unclosed `(`")),
            "should NOT have a separate 'Unclosed (' diagnostic; got: {diags:?}"
        );
    }
```

- [ ] **Step 2: Verify failure**

```bash
cargo test -p raven --lib coalesce_ 2>&1 | tail -20
```

Expected: failures showing two diagnostics where one is expected.

- [ ] **Step 3: Extend `detect_mismatched_bracket` to walk up one level when needed**

Replace `detect_mismatched_bracket` (around line 6413) with the existing logic plus a structural-parent fallback. The function signature in the existing code is `(node, text) -> Option<String>`. Keep that public-message-only signature; instead, introduce a NEW path inside `classify_error` for the structural case that records the covered opener:

In `classify_error`, AFTER the existing `detect_mismatched_bracket` line, insert:

```rust
    if let Some(diag) = detect_mismatched_via_structural_parent(node, text, state) {
        return ErrorClassification::Whole(diag);
    }
```

Then add the new helper alongside `detect_mismatched_bracket`:

```rust
/// Detect `f(} y` / `vec[} y` style typos where the wrong closer is an
/// ERROR child of `arguments` / `braced_expression` / `parenthesized_expression`
/// and a MISSING closer of the expected kind sits at the parent's end.
/// Emits a single `Mismatched brackets` diagnostic anchored on the wrong
/// closer and records the parent's opener in `state.covered_openers` to
/// suppress the MISSING follow-up.
fn detect_mismatched_via_structural_parent(
    node: Node,
    text: &str,
    state: &mut CollectState,
) -> Option<ClassifiedSyntaxDiagnostic> {
    use crate::cross_file::types::byte_offset_to_utf16_column;

    // Only fire on ERROR nodes whose only non-whitespace content is a
    // single closer token (the wrong character the user typed).
    let inner_text = text.get(node.start_byte()..node.end_byte())?.trim();
    let wrong_kind = DelimiterKind::from_closer(inner_text)?;

    // Walk up one level.
    let parent = node.parent()?;
    if !matches!(
        parent.kind(),
        "arguments" | "braced_expression" | "parenthesized_expression"
    ) {
        return None;
    }

    // Parent's first delimiter child is the opener.
    let mut cursor = parent.walk();
    let opener = parent
        .children(&mut cursor)
        .find(|n| {
            let t = text.get(n.start_byte()..n.end_byte()).unwrap_or("");
            matches!(t, "(" | "{" | "[" | "[[")
        })?;
    let opener_text = text.get(opener.start_byte()..opener.end_byte())?;
    let opener_kind = DelimiterKind::from_opener(opener_text)?;

    // Must actually be a mismatch (different kind from the wrong closer).
    if opener_kind == wrong_kind {
        return None;
    }

    // Parent must end with a MISSING closer of the expected kind. Walk
    // children of parent to find the last child; if it's MISSING and its
    // kind matches opener_kind's closer, we have the coalescing shape.
    let mut last_child = None;
    let mut c2 = parent.walk();
    for ch in parent.children(&mut c2) {
        last_child = Some(ch);
    }
    let last = last_child?;
    if !last.is_missing() || last.kind() != opener_kind.closer_str() {
        return None;
    }

    // Record the opener so the MISSING branch skips it.
    state.covered_openers.insert(opener.id());

    // Build the diagnostic anchored on the wrong closer (node).
    let row = node.start_position().row as u32;
    let line = text.lines().nth(row as usize).unwrap_or("");
    let line_start = line_start_byte(text, row as usize);
    let start_col = byte_offset_to_utf16_column(line, node.start_byte() - line_start);
    let end_col = byte_offset_to_utf16_column(line, node.end_byte() - line_start);

    Some(ClassifiedSyntaxDiagnostic {
        message: format!(
            "Mismatched brackets: `{}` opened here; close with `{}` not `{}`.",
            opener_kind.opener_str(),
            opener_kind.closer_str(),
            wrong_kind.closer_str(),
        ),
        range: Range {
            start: Position::new(row, start_col),
            end: Position::new(row, end_col),
        },
    })
}
```

- [ ] **Step 4: Run the coalescing tests**

```bash
cargo test -p raven --lib coalesce_ -- --nocapture
```

Expected: all 3 `coalesce_*` tests PASS.

- [ ] **Step 5: Full suite**

```bash
cargo test -p raven --lib 2>&1 | tail -30
```

Expected: no new regressions beyond message-text updates already made in Task 6/7.

- [ ] **Step 6: Commit**

```bash
git add crates/raven/src/handlers.rs
git commit -m "feat(diagnostics): coalesce wrong-closer-for-opener typos

When the wrong closer (e.g. `}` instead of `)`) lives inside the
arguments/braced/parens shape with a MISSING expected closer, emit a
single Mismatched-brackets diagnostic instead of two separate ones.
The opener is recorded in CollectState::covered_openers so the MISSING
branch doesn't re-emit 'Unclosed X: missing matching Y'."
```

---

## Task 9: Encoding edge-case tests (CRLF / BOM / non-ASCII / astral)

**Files:**
- Modify: `crates/raven/src/handlers.rs`

**Why this is ninth:** Now that the core mechanism is in place, lock in correctness for line-ending and Unicode edge cases. These should all pass without further implementation changes (the helpers go through `byte_offset_to_utf16_column`), but they need explicit tests to prevent future regression.

- [ ] **Step 1: Add the tests**

```rust
    #[test]
    fn unclosed_opener_crlf() {
        // library(\r\n -- the line content is "library(" (sans the \r),
        // opener `(` at col 7, end of meaningful content at col 8.
        let diags = collect("library(\r\n");
        let target = diags
            .iter()
            .find(|d| d.message.contains("Unclosed `(`"))
            .expect("expected Unclosed ( diagnostic");
        assert_eq!(target.range.start.line, 0);
        assert_eq!(target.range.start.character, 7);
        assert_eq!(target.range.end.character, 8);
    }

    #[test]
    fn unclosed_opener_no_final_newline() {
        let diags = collect("library(");
        let target = diags
            .iter()
            .find(|d| d.message.contains("Unclosed `(`"))
            .expect("expected Unclosed ( diagnostic");
        assert_eq!(target.range.start.character, 7);
        assert_eq!(target.range.end.character, 8);
    }

    #[test]
    fn unclosed_opener_with_bom() {
        // BOM = U+FEFF, 3 UTF-8 bytes, 1 UTF-16 code unit at col 0.
        // `library(` follows, `(` at byte 10, UTF-16 col 8.
        let diags = collect("\u{FEFF}library(");
        let target = diags
            .iter()
            .find(|d| d.message.contains("Unclosed `(`"))
            .expect("expected Unclosed ( diagnostic");
        assert_eq!(target.range.start.line, 0);
        assert_eq!(target.range.start.character, 8);
        assert_eq!(target.range.end.character, 9);
    }

    #[test]
    fn unclosed_opener_non_ascii_before() {
        // `é_func(` -- `é` is 2 UTF-8 bytes, 1 UTF-16 unit at col 0.
        // `(` at UTF-16 col 6.
        let diags = collect("é_func(");
        let target = diags
            .iter()
            .find(|d| d.message.contains("Unclosed `(`"))
            .expect("expected Unclosed ( diagnostic");
        assert_eq!(target.range.start.character, 6);
        assert_eq!(target.range.end.character, 7);
    }

    #[test]
    fn unclosed_opener_astral_before() {
        // `😀_func(` -- `😀` is 4 UTF-8 bytes, 2 UTF-16 code units (surrogate pair).
        // `(` at UTF-16 col 7.
        let diags = collect("😀_func(");
        let target = diags
            .iter()
            .find(|d| d.message.contains("Unclosed `(`"))
            .expect("expected Unclosed ( diagnostic");
        assert_eq!(target.range.start.character, 7);
        assert_eq!(target.range.end.character, 8);
    }
```

- [ ] **Step 2: Run them**

```bash
cargo test -p raven --lib unclosed_opener_ -- --nocapture
```

Expected: all 5 tests PASS without further code changes (the helpers already use `byte_offset_to_utf16_column` correctly).

If any fail, the bug is in earlier code — likely a missed UTF-16 conversion. Fix at the source of the bug (do NOT special-case the test).

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/handlers.rs
git commit -m "test(diagnostics): lock encoding edge cases for unclosed-opener anchor

CRLF, BOM, non-ASCII identifier, astral-plane character. All routed
through byte_offset_to_utf16_column so columns are LSP-correct."
```

---

## Task 10: Update `prop_missing_node_width` for bracket-kind MISSING

**Files:**
- Modify: `crates/raven/src/handlers.rs` — the existing property test at line ~8098

**Why this is tenth:** The existing property asserts every diagnostic at a MISSING position has width 1. Our new design anchors bracket-kind MISSING on the opener with a multi-column range. The fix: scope the assertion to non-bracket MISSING kinds, then add a parallel property for bracket-kind.

- [ ] **Step 1: Read the existing property to make sure you understand its current contract**

```bash
awk 'NR>=8083 && NR<=8200' crates/raven/src/handlers.rs
```

Confirm: the property maps each `MISSING` node position to a diagnostic at that exact position, asserting width 1.

- [ ] **Step 2: Modify `prop_missing_node_width` to skip bracket-kind MISSING positions**

The cleanest change is at the point where `missing_positions` is iterated. Before the `for &(m_row, m_col) in &missing_positions {` loop, change `missing_positions` collection to also record the MISSING's kind, then skip the bracket kinds inside the loop.

Find `collect_missing_positions` and update it to also record `kind`:

```bash
grep -n "fn collect_missing_positions" crates/raven/src/handlers.rs
```

Update the signature and body to collect `(row, col, kind)` triples instead of `(row, col)` pairs. Update both call sites (in `prop_missing_node_priority` and `prop_missing_node_width`).

Then in `prop_missing_node_width`'s iteration loop, add:

```rust
            for &(m_row, m_col, ref m_kind) in &missing_positions {
                // Bracket-kind MISSING is now anchored on the opener with
                // a multi-column range — see Task 7 of bracket-diagnostics
                // plan. The width-1 invariant applies only to non-bracket
                // MISSING kinds.
                if matches!(m_kind.as_str(), ")" | "}" | "]" | "]]") {
                    continue;
                }
                // ... existing match logic ...
            }
```

For `prop_missing_node_priority`, no change is required to assertions (it counts `"Syntax error"` messages, not `"Missing X"` messages, and the count check still holds).

- [ ] **Step 3: Add a parallel property test for bracket-kind MISSING**

Just after `prop_missing_node_width`:

```rust
        // ============================================================================
        // Feature: bracket-diagnostics, Property: bracket-kind MISSING anchors on opener
        //
        // For each bracket-kind MISSING node, the corresponding diagnostic
        // is NOT at the MISSING's position; it's anchored on the opener
        // (an ancestor's first delimiter child) with a range whose start
        // <= the MISSING's column.
        //
        // **Validates: bracket-diagnostics design spec, section "Opener
        // anchoring via MISSING".**
        // ============================================================================

        #[test]
        fn prop_bracket_missing_anchors_on_opener(code in missing_node_code()) {
            let tree = parse_r(&code);
            let root = tree.root_node();

            let mut missing_positions: Vec<(u32, u32, String)> = Vec::new();
            collect_missing_positions(root, &mut missing_positions);

            prop_assume!(
                missing_positions.iter().any(|(_,_,k)| matches!(k.as_str(), ")" | "}" | "]" | "]]")),
                "Generated code must produce at least one bracket-kind MISSING"
            );

            let mut diagnostics = Vec::new();
            collect_syntax_errors(root, &code, &mut diagnostics);

            for &(m_row, m_col, ref m_kind) in &missing_positions {
                if !matches!(m_kind.as_str(), ")" | "}" | "]" | "]]") {
                    continue;
                }
                // Find a diagnostic whose row == m_row and whose start.character <= m_col
                // (anchored on the opener; if the MISSING is on a different line, allow row mismatch).
                let matching = diagnostics.iter().find(|d| {
                    (d.message.contains("Unclosed") || d.message.contains("Mismatched brackets"))
                        && d.range.start.line <= m_row
                });
                prop_assert!(
                    matching.is_some(),
                    "Expected an 'Unclosed' or 'Mismatched' diagnostic anchored at or before \
                     the MISSING position ({m_row}, {m_col}) kind {m_kind}, but none found. \
                     Code: {code:?}, Diagnostics: {diagnostics:?}",
                );
            }
        }
```

- [ ] **Step 4: Run the property tests**

```bash
cargo test -p raven --lib prop_missing_node -- --nocapture
cargo test -p raven --lib prop_bracket_missing -- --nocapture
```

Expected: PASS. Property tests use proptest's random generation; let them run their default cases.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/handlers.rs
git commit -m "test(diagnostics): scope prop_missing_node_width to non-bracket MISSING

Bracket-kind MISSING is now anchored on the opener with a multi-column
range, breaking the existing width-1 invariant. Skip those kinds in
the original property and add a parallel property asserting bracket-
kind MISSING produces an Unclosed-or-Mismatched diagnostic anchored
at or before the MISSING position."
```

---

## Task 11: Update `docs/diagnostics.md` table

**Files:**
- Modify: `docs/diagnostics.md`

- [ ] **Step 1: Find the current "Missing )" row**

```bash
grep -n "Missing )" docs/diagnostics.md
```

Expected: one row in the "Parse Errors" table.

- [ ] **Step 2: Replace it with the two new rows**

Open `docs/diagnostics.md`, locate the table row matching:

```text
| `Missing )` / `Missing ]` / etc. | A delimiter was opened but never closed (`library(`) |
```

Replace with:

```text
| `` Unclosed `(`: missing matching `)` `` / `` Unclosed `{`: missing matching `}` `` / `` Unclosed `[`: missing matching `]` `` / `` Unclosed `[[`: missing matching `]]` `` | A delimiter was opened but never closed (`library(`, `function() {`). The diagnostic is anchored on the opening delimiter, spanning to the end of meaningful content on that line. |
| `` Missing opening `{` `` / `` Missing opening `(` `` / `` Missing opening `[` `` / `` Missing opening `[[` `` | A closing delimiter appears with no matching opener (`}` at top level, `)` after a complete expression). A run of stray closers (`}}}`) reports a single diagnostic for the whole run. |
```

- [ ] **Step 3: Extend the existing `Mismatched brackets` note**

Find the existing `Mismatched brackets: ...` row. After it (or below the table), add a one-line note explaining the extended scope:

```text
The `Mismatched brackets` message now also covers wrong-closer typos where the user typed an unexpected closer immediately after an unclosed opener (e.g. `f(}` produces a single `Mismatched brackets: \`(\` opened here; close with \`)\` not \`}\`.` diagnostic rather than two separate ones).
```

- [ ] **Step 4: Sanity-check markdown rendering**

```bash
which markdownlint-cli2 2>/dev/null && markdownlint-cli2 docs/diagnostics.md || echo "(markdownlint not on PATH — skipping)"
```

Expected: no MD040 / MD013 / table errors.

- [ ] **Step 5: Commit**

```bash
git add docs/diagnostics.md
git commit -m "docs(diagnostics): document new bracket-diagnostic messages

Replace the 'Missing )' row with the new 'Unclosed X: missing matching Y'
and 'Missing opening X' rows. Note the extended scope of the existing
Mismatched-brackets message to cover f(} -style typos."
```

---

## Task 12: Final integration run + cleanup

**Files:**
- None to modify; this is a verification task

- [ ] **Step 1: Full test suite**

```bash
cargo test -p raven --lib 2>&1 | tail -40
```

Expected: all tests pass. Any remaining failures should be either:
1. A real regression — fix it before proceeding.
2. A test that asserted old behavior (`message == "Syntax error"` for a case now classified) — update the assertion.

- [ ] **Step 2: Build the release binary**

```bash
cargo build --release -p raven 2>&1 | tail -5
```

Expected: clean build.

- [ ] **Step 3: Spot-check the diagnostic in a real R file**

Create `/tmp/bracket_demo.R` with:

```r
library(
x <- mean(c(1, 2, 3)
f <- function() {
  y <- 1
```

Run the LSP against it (or use a unit test that mirrors a real-file load).

```bash
cargo test -p raven --lib bracket_demo 2>&1 | tail -20
```

(Skip if no such test exists — this is a sanity check, not gated.)

- [ ] **Step 4: Squash review**

Inspect the commit log:

```bash
git log --oneline issue286 ^main
```

Expected: ~12 commits, each scoped to one of the tasks above. This commit pattern is fine for merge; do NOT amend / squash unless the user asks for it.

- [ ] **Step 5: Final commit (no-op if everything was committed earlier)**

If you discovered fix-ups during Step 1–3, commit them as a separate `fix(diagnostics): ...` commit before merging.

---

## Verification checklist

After running through all tasks, the following should all be true:

- [ ] `cargo test -p raven --lib` passes
- [ ] `cargo build --release -p raven` succeeds
- [ ] All new tests in `mod syntax_error_range_tests` are named per the spec's test tables
- [ ] `docs/diagnostics.md` has the two new table rows
- [ ] `git log --oneline issue286 ^main` shows ~12 atomic commits
- [ ] No `TODO`/`TBD`/`FIXME` in the new code

If any of these is false, go back and fix before declaring the work complete.
