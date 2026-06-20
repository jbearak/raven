# `.lintr` Syntax Leniency & Silent-Drop Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Raven's `.lintr` reader from silently dropping valid lintr config, and accept the common multi-line layout (closing `)` at column 0) that real lintr rejects but whose intent is unambiguous.

**Architecture:** A `.lintr` field value is an **R expression** whose line continuation is governed by **bracket balance**, not DCF leading-whitespace. Rework `dcf_fold` to be bracket- and comment-aware and to join continuation lines with `\n` (matching R's `read.dcf`), so a column-0 `)` still attaches to its field and trailing `#` comments don't eat the rest of the value. Fix the narrower parse gaps (`120L` integer literals, whitespace before `(`). All scanning runs through one shared string/comment/bracket state machine so folding and comma-splitting cannot drift.

**Tech Stack:** Rust (crate `raven`); the `.lintr` reader is `crates/raven/src/config_file/lintr_loader.rs`. Tests are the `#[cfg(test)]` module in that file plus `crates/raven/src/cli/lint.rs`. Verified against installed `lintr 3.3.0.1` / R 4.6.0.

---

## Background: what real lintr does (verified empirically, not from memory)

lintr reads a `.lintr` as DCF via `read.dcf(file, all = TRUE)`, then for each field runs `str2lang()` → `eval()` (source: `lintr:::read_config_file`). Probed against `lintr 3.3.0.1`:

| `.lintr` form | Real lintr 3.3.0.1 |
|---|---|
| Closing `)` at **column 0** (multi-line) | **Hard error**: `Invalid DCF format. Regular lines must have a tag.` |
| Closing `)` **indented** (`    )`) | ✅ accepted |
| `line_length_linter(120L)` (integer literal) | ✅ accepted (valid R) |
| `linters_with_defaults (...)` (space before `(`) | ✅ accepted (valid R) |
| `with_defaults(...)` | **Error**: `could not find function` — removed after deprecation |
| `all_linters(...)`, `linters_with_tags(...)` | ✅ accepted |
| `# comment` inside a multi-line value | ✅ accepted (read.dcf keeps newlines, so the comment ends at its line) |
| `read.dcf` continuation join character | **`\n`** (newline), not a space |

**Implications for this work:**

1. The user's column-0 file is **invalid in lintr too** — it is *not* "the natural way people write it." The form that works in lintr is the indented closing paren, which Raven already handles and the existing fixtures already use. **Do not** relax the existing indented fixtures; they are correct. **Do** add column-0 fixtures and make them pass (leniency decision below).
2. Raven currently folds continuation lines with a **space**. A trailing `#` comment therefore eats the rest of the folded value (including the closing `)`), silently dropping config. Folding with `\n` (as read.dcf does) fixes this.
3. `with_defaults` is gone in current lintr; supporting it is *legacy* leniency, not lintr-fidelity. Included as an optional, clearly-separable task.

## Decisions (settled with the user)

- **Column-0 closing paren → ACCEPT it** via bracket-aware folding. The intent is unambiguous and most Raven users don't run lintr; for those who do, lintr fails loudly so nothing is hidden.
- **Emit a single informational portability note** when a field used a column-0 continuation ("Raven accepted this; lintr requires continuation lines indented"). This is the **one reversible UX knob** — Step set is isolated in Task 2 so it can be dropped if the user prefers fully-silent acceptance.
- **PR structure:** new **stacked PR on top of #511** (base = `claude/zen-haibt-c942bc`), worked on the current branch `claude/stupefied-wozniak-5f1863` in this worktree.

## Non-goals (warn clearly, do not silently drop — but do not implement)

- `defaults = list()` / `default = list()` ("start from no defaults"): Raven always starts from its full default rule set; "only these linters" is not representable. Keep warning.
- `all_linters(...)`, `linters_with_tags(...)`: not mappable to Raven's fixed rule set. Keep warning.
- `exclusions: list("f.R" = 1:10)` per-file **line ranges**: Raven's override model is whole-file globs; line ranges are not representable. Keep warning. (Multi-line `exclusions:` *folding* is fixed for free by Task 2.)
- **Malformed DCF/R that lintr itself rejects** (a column-0 line that is neither `Key:` nor a bracket-continuation, e.g. a leading-comma line; or a value with unbalanced `)` so `net_bracket_depth` floors at 0 and the fold ends early): Raven does *not* attempt to recover these. The scope claim is "never silently drop **valid** lintr config." For these inputs, lintr errors too, and in the common shapes Raven still surfaces the batch "unrecognized construct" warning (e.g. an entry that fails the `ends_with(')')` check) rather than being fully silent. We intentionally do not add negative-depth/imbalance detection (YAGNI for malformed input). The one genuinely-silent residue — a column-0 line with no colon while brackets are balanced — is pre-existing `dcf_fold` behavior and is left as-is.

## File Structure

- Modify: `crates/raven/src/config_file/lintr_loader.rs` — the whole change lives here:
  - New: `ScanState` (shared string/comment/bracket state machine) + `net_bracket_depth`.
  - Rework: `dcf_fold` (bracket/comment-aware, newline-join, column-0 detection), `split_top_level_commas` (route through `ScanState`).
  - New: `parse_r_uint`, `strip_named_call`. Rework: `parse_positional_int`, `parse_named_int`, `strip_linters_with_defaults`, `apply_exclusions`, `strip_c_vector`, `load_str`.
  - New tests in the `#[cfg(test)]` module.
- Modify: `crates/raven/src/cli/lint.rs` — one end-to-end `resolve_lint_config` test on the user's exact file (Task 7).
- Modify: `docs/linting.md` — runtime-support paragraph (Task 8).
- Optional (Task 9, bundled cleanups, separable): `crates/raven/src/config_file/lintr_loader.rs` (`load_str` simplification), `crates/raven/src/cli/lint.rs:125` doc, `editors/vscode/package.json` + regenerated `docs/settings-reference.md`, `docs/diagnostics.md`, `docs/linting.md:66`.

## Gates (run before every commit; full run at the end)

```bash
cargo fmt --all && cargo fmt --all --check
cargo clippy --workspace --all-targets --features test-support -- -D warnings   # zero warnings
cargo test -p raven --lib config_file::lintr_loader::tests
```

---

### Task 1: Shared string/comment/bracket scanner + `net_bracket_depth`

**Files:**
- Modify: `crates/raven/src/config_file/lintr_loader.rs` (add `ScanState`, `net_bracket_depth`; reroute `split_top_level_commas`)

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests`:

```rust
#[test]
fn net_bracket_depth_respects_strings_and_comments() {
    assert_eq!(net_bracket_depth("f(a, b)"), 0);
    assert_eq!(net_bracket_depth("f("), 1);
    assert_eq!(net_bracket_depth("f(g("), 2);
    // Brackets inside a string literal are not structural.
    assert_eq!(net_bracket_depth("f(\"a (b\")"), 0);
    // Brackets inside a `#` comment are not structural; the comment ends at \n.
    assert_eq!(net_bracket_depth("f( # )(\n)"), 0);
    // A `#` inside a string is not a comment.
    assert_eq!(net_bracket_depth("f(\"# (\")"), 0);
    // A string ending in an escaped backslash closes correctly: this is
    // R `f("a\\")` (one backslash in the string), so depth returns to 0.
    assert_eq!(net_bracket_depth("f(\"a\\\\\")"), 0);
    // An escaped quote does NOT close the string, so the `)` stays inside it.
    assert_eq!(net_bracket_depth("f(\"a\\\"\")"), 1);
}

#[test]
fn split_top_level_commas_ignores_commas_in_comments() {
    // The comma in the trailing comment must not create a phantom split.
    let parts = split_top_level_commas("a # x, y\nb");
    assert_eq!(parts, vec!["a # x, y\nb"]);
    // Real top-level comma still splits; nested + quoted commas do not.
    let parts = split_top_level_commas("f(1, 2), \"x,y\", g()");
    assert_eq!(parts, vec!["f(1, 2)", " \"x,y\"", " g()"]);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p raven --lib config_file::lintr_loader::tests::net_bracket_depth_respects_strings_and_comments config_file::lintr_loader::tests::split_top_level_commas_ignores_commas_in_comments`
Expected: FAIL — `cannot find function net_bracket_depth` (and the comment-aware split assertion fails).

- [ ] **Step 3: Add `ScanState` + `net_bracket_depth`, and reroute `split_top_level_commas` through them**

Add near the other free functions (after `split_top_level_commas`'s current location is fine; place `ScanState` above `split_top_level_commas`):

```rust
/// Shared lexical state for scanning a `.lintr` field value as R-ish text:
/// tracks whether we are inside a string literal (with backslash-escape
/// handling), inside a `#` comment, and the net bracket depth. One state
/// machine so `dcf_fold` (continuation detection), `split_top_level_commas`,
/// and `strip_comments` cannot drift on what counts as "inside a string /
/// comment / bracket".
#[derive(Default)]
struct ScanState {
    /// `Some(quote)` while inside a string literal opened by `quote`.
    in_str: Option<char>,
    /// Inside a string, `true` when the previous char was an unescaped `\`, so
    /// the current char is escaped (and a quote does not close the string).
    escaped: bool,
    /// `true` while inside a `#` comment (until the next newline).
    in_comment: bool,
    /// Net `(`/`[`/`{` minus `)`/`]`/`}`, floored at 0.
    depth: i32,
}

impl ScanState {
    /// Advance over one byte-as-char `c`. Returns `true` when `c` is a
    /// *structural* character — not inside a string or comment — so callers can
    /// act on `,` / brackets only when this is `true`. Escape state is tracked
    /// internally (no `prev` parameter needed), so a string ending in an
    /// escaped backslash (`"a\\"`) closes correctly.
    fn step(&mut self, c: char) -> bool {
        if self.in_comment {
            if c == '\n' {
                self.in_comment = false;
            }
            return false;
        }
        if let Some(q) = self.in_str {
            if self.escaped {
                self.escaped = false;
            } else if c == '\\' {
                self.escaped = true;
            } else if c == q {
                self.in_str = None;
            }
            return false;
        }
        match c {
            '"' | '\'' => {
                self.in_str = Some(c);
                false
            }
            '#' => {
                self.in_comment = true;
                false
            }
            '(' | '[' | '{' => {
                self.depth += 1;
                true
            }
            ')' | ']' | '}' => {
                self.depth = (self.depth - 1).max(0);
                true
            }
            _ => true,
        }
    }
}

/// Net bracket depth of `s`, ignoring brackets inside string literals and `#`
/// comments. `> 0` means an unclosed `(`/`[`/`{` — the value is a mid-flight R
/// expression that continues on the next physical line regardless of DCF
/// indentation rules.
fn net_bracket_depth(s: &str) -> i32 {
    let mut st = ScanState::default();
    for &b in s.as_bytes() {
        st.step(b as char);
    }
    st.depth
}
```

Replace the body of `split_top_level_commas` with the `ScanState`-driven version. Iterate `bytes().enumerate()` (not `for i in 0..len` with indexing — that trips `clippy::needless_range_loop`, a hard CI gate). Byte iteration is safe: only ASCII `"'#()[]{},\\` and `\n` are structural, and UTF-8 continuation bytes never collide with them.

```rust
/// Split a token string on commas at depth 0 (ignoring parens / brackets /
/// quotes / `#` comments).
fn split_top_level_commas(input: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut st = ScanState::default();
    let mut start = 0usize;
    for (i, &b) in input.as_bytes().iter().enumerate() {
        let c = b as char;
        let structural = st.step(c);
        if structural && c == ',' && st.depth == 0 {
            out.push(&input[start..i]);
            start = i + 1;
        }
    }
    if start <= input.len() {
        out.push(&input[start..]);
    }
    out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p raven --lib config_file::lintr_loader::tests`
Expected: PASS (new tests pass; all pre-existing `split_top_level_commas`-dependent tests still pass).

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/config_file/lintr_loader.rs
git commit -m "refactor(lintr): shared string/comment/bracket scanner for .lintr parsing"
```

---

### Task 2: Bracket-aware, newline-joining `dcf_fold` (column-0 paren works; comments safe) + portability note

This is the core fix. `dcf_fold` consumes continuation lines while brackets are open (regardless of indentation), joins with `\n`, and records column-0 continuations so `load_str` can emit one informational portability note.

**Files:**
- Modify: `crates/raven/src/config_file/lintr_loader.rs` (`dcf_fold`, `load_str`)

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn column_zero_closing_paren_folds_and_applies_all_entries() {
    // The user's exact real-world file: closing ')' at column 0.
    let input = "linters: linters_with_defaults(\n\
        line_length_linter(120),\n\
        trailing_whitespace_linter = NULL\n\
        )\n";
    let out = load_str(input);
    let l = &out.settings["linting"];
    assert_eq!(l["lineLength"], json!(120));
    assert_eq!(l["trailingWhitespaceSeverity"], json!("off"));
    // Nothing was lost: no "unrecognized construct" batch warning.
    assert!(
        !out.warnings.iter().any(|w| w.contains("unrecognized construct")),
        "column-0 fold must not drop the field: {:?}",
        out.warnings
    );
}

#[test]
fn column_zero_continuation_emits_portability_note() {
    // The one reversible UX knob (see plan Task 2): accepting a column-0
    // continuation surfaces a single informational note about lintr's stricter
    // DCF rule. If the user opts for fully-silent acceptance, drop the
    // `column0_continuations` note block in `load_str` and this test.
    let input = "linters: linters_with_defaults(\n    line_length_linter(120)\n)\n";
    let out = load_str(input);
    assert!(
        out.warnings.iter().any(|w| w.contains("column 0") && w.contains("lintr")),
        "expected a lintr-portability note: {:?}",
        out.warnings
    );
}

#[test]
fn indented_closing_paren_does_not_emit_portability_note() {
    // The valid-lintr form (indented ')') must stay silent.
    let input = "linters: linters_with_defaults(\n    line_length_linter(120)\n    )\n";
    let out = load_str(input);
    assert_eq!(out.settings["linting"]["lineLength"], json!(120));
    assert!(
        !out.warnings.iter().any(|w| w.contains("column 0")),
        "indented continuation must not warn: {:?}",
        out.warnings
    );
}

#[test]
fn trailing_comment_in_multiline_value_does_not_eat_following_entries() {
    // A '#' comment after the first linter must not swallow the rest when
    // folding (folding joins with '\n', matching read.dcf).
    let input = "linters: linters_with_defaults(\n\
        line_length_linter(120), # set the limit\n\
        object_length_linter(40)\n\
        )\n";
    let out = load_str(input);
    let l = &out.settings["linting"];
    assert_eq!(l["lineLength"], json!(120));
    assert_eq!(l["objectLength"], json!(40), "comment must not drop object_length");
}

#[test]
fn multiline_exclusions_with_column_zero_close_folds() {
    let input = "exclusions: list(\n    \"R/legacy.R\",\n    \"tests/\"\n)\n";
    let out = load_str(input);
    let overrides = out.settings["linting"]["overrides"].as_array().unwrap();
    let files = overrides[0]["files"].as_array().unwrap();
    assert!(files.iter().any(|v| v == &json!("R/legacy.R")));
    assert!(files.iter().any(|v| v == &json!("tests/**")));
}

#[test]
fn blank_line_inside_open_brackets_is_insignificant() {
    let input = "linters: linters_with_defaults(\n    line_length_linter(120),\n\n    object_length_linter(40)\n)\n";
    let out = load_str(input);
    let l = &out.settings["linting"];
    assert_eq!(l["lineLength"], json!(120));
    assert_eq!(l["objectLength"], json!(40));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p raven --lib config_file::lintr_loader::tests::column_zero_closing_paren_folds_and_applies_all_entries`
Expected: FAIL — `lineLength` missing / `unrecognized construct` warning present (current column-0 bug). The other new tests fail similarly (missing keys, missing note, dropped `object_length`).

- [ ] **Step 3: Rework `dcf_fold` and update `load_str`**

Replace the entire `dcf_fold` function with:

```rust
/// Result of folding a `.lintr` file into per-field values.
struct FoldResult {
    /// `(key, value)` pairs in file order.
    fields: Vec<(String, String)>,
    /// Continuation lines that began at **column 0** (no leading whitespace).
    /// lintr's `read.dcf` rejects these ("Regular lines must have a tag");
    /// Raven accepts them leniently and surfaces one informational note so a
    /// user who also runs lintr learns the file is not lintr-portable.
    column0_continuations: Vec<String>,
}

/// Fold a `.lintr` into per-field values.
///
/// A `.lintr` field value is an **R expression**; its continuation is governed
/// by **bracket balance**, not DCF leading-whitespace. So:
///
/// * While the current field's accumulated value has unbalanced brackets
///   (string/comment-aware, see [`net_bracket_depth`]), the next physical line
///   continues it **regardless of indentation** — this is what lets a closing
///   `)` at column 0 still attach to its field.
/// * Otherwise the classic DCF rule applies: a line starting with whitespace
///   continues the previous value; a column-0 `Name:` line starts a new field.
///
/// Continuation lines are joined with `\n` (matching R's `read.dcf`), so a
/// trailing `#` comment terminates at its own line instead of commenting out
/// the rest of the folded value.
fn dcf_fold(text: &str) -> FoldResult {
    let mut fields: Vec<(String, String)> = Vec::new();
    let mut column0_continuations: Vec<String> = Vec::new();
    let mut current: Option<(String, String)> = None;
    for raw_line in text.lines() {
        // Mid-expression: brackets are still open, so this physical line is a
        // continuation no matter its indentation.
        if let Some((_, val)) = current.as_mut()
            && net_bracket_depth(val) > 0
        {
            if raw_line.trim().is_empty() {
                // Blank lines inside an open bracket are insignificant in R.
                continue;
            }
            if !raw_line.starts_with(|c: char| c.is_whitespace()) {
                column0_continuations.push(raw_line.trim().to_string());
            }
            val.push('\n');
            val.push_str(raw_line.trim());
            continue;
        }
        if raw_line.trim().is_empty() {
            continue;
        }
        if raw_line.starts_with(|c: char| c.is_whitespace()) {
            // DCF continuation: balanced value, indented line.
            if let Some((_, val)) = current.as_mut() {
                val.push('\n');
                val.push_str(raw_line.trim());
            }
            continue;
        }
        // Column 0, non-blank, balanced value: a new field.
        if let Some(kv) = current.take() {
            fields.push(kv);
        }
        if let Some(colon) = raw_line.find(':') {
            let key = raw_line[..colon].trim().to_string();
            let val = raw_line[colon + 1..].trim().to_string();
            current = Some((key, val));
        }
        // A column-0 line with no colon while balanced is malformed; drop it
        // (it cannot be a continuation — brackets are closed).
    }
    if let Some(kv) = current.take() {
        fields.push(kv);
    }
    FoldResult {
        fields,
        column0_continuations,
    }
}
```

**Critical (BLOCKER from plan review):** newline-joining is *necessary but not sufficient* for `#` comments. `split_top_level_commas` correctly does not split inside a comment, but the comment text stays embedded in the entry — so `apply_linters`'s `entry[..paren_idx]` name extraction would see `# set the limit\nobject_length_linter` and fail to match. Add a string-aware `strip_comments` and call it at the top of both entry-parsers, *before* splitting. Add `strip_comments` near `net_bracket_depth`:

```rust
/// Remove `#`-to-end-of-line comments from an R-ish value, preserving any `#`
/// inside a string literal. String state is tracked across the whole input
/// (via the shared [`ScanState`]), so a string spanning multiple
/// newline-joined lines is handled. The terminating newline of each comment is
/// kept so token boundaries created by folding survive.
fn strip_comments(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut st = ScanState::default();
    for &b in s.as_bytes() {
        let c = b as char;
        let was_comment = st.in_comment;
        let was_str = st.in_str.is_some();
        st.step(c);
        if was_comment {
            // Drop comment body; keep only the newline that ends it.
            if c == '\n' {
                out.push(c);
            }
        } else if was_str {
            out.push(c);
        } else if c != '#' {
            out.push(c);
        }
        // (`#` while not in a string/comment starts a comment: dropped.)
    }
    out
}
```

In `apply_linters`, strip comments before stripping the wrapper. Change the first two lines of the body from:

```rust
    let inner = strip_linters_with_defaults(body);
    let entries = split_top_level_commas(inner);
```

to:

```rust
    let body = strip_comments(body);
    let inner = strip_linters_with_defaults(&body);
    let entries = split_top_level_commas(inner);
```

In `apply_exclusions`, strip comments at the top. Change:

```rust
    let body = body.trim();
```

to:

```rust
    let body = strip_comments(body);
    let body = body.trim();
```

> Note: `net_bracket_depth` in `dcf_fold` still runs on the *un-stripped* accumulated value (folding happens before parsing), and `ScanState` already ignores brackets inside comments — so depth tracking during folding stays correct. `strip_comments` only cleans the value handed to the structured parsers.

In `load_str`, change the fold call and field iteration, and add the note. Replace:

```rust
    let fields = dcf_fold(text);
```

with:

```rust
    let FoldResult {
        fields,
        column0_continuations,
    } = dcf_fold(text);
```

Then, immediately after the `for (key, value) in fields { ... }` loop and before the `if unrecognized_constructs > 0` block, insert the portability note (this is the reversible UX knob — drop this block for fully-silent acceptance):

```rust
    if !column0_continuations.is_empty() {
        warnings.push(format!(
            ".lintr: accepted {} continuation line(s) beginning at column 0; lintr's read.dcf requires every continuation line (including the closing `)`) to be indented (\"Regular lines must have a tag\"). Indent them for lintr compatibility.",
            column0_continuations.len(),
        ));
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p raven --lib config_file::lintr_loader::tests`
Expected: PASS — all new Task 2 tests pass; pre-existing `multi_line_dcf_field_is_folded`, `user_example_*`, and `exclusions_become_disabled_overrides` still pass (indented fixtures fold identically and emit no note).

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/config_file/lintr_loader.rs
git commit -m "fix(lintr): bracket-aware newline folding so column-0 ')' and comments work"
```

---

### Task 3: R integer literals (`120L`)

**Files:**
- Modify: `crates/raven/src/config_file/lintr_loader.rs` (add `parse_r_uint`; reroute `parse_positional_int`, `parse_named_int`)

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn integer_literal_suffix_maps_positional_and_named() {
    let out = load_str("linters: linters_with_defaults(line_length_linter(120L))\n");
    assert_eq!(out.settings["linting"]["lineLength"], json!(120));

    let out = load_str("linters: linters_with_defaults(object_length_linter(length = 40L))\n");
    assert_eq!(out.settings["linting"]["objectLength"], json!(40));

    let out = load_str("linters: linters_with_defaults(indentation_linter(4L))\n");
    assert_eq!(out.settings["linting"]["indentationUnit"], json!(4));
    assert!(out.warnings.is_empty(), "L-suffixed integers must not warn: {:?}", out.warnings);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p raven --lib config_file::lintr_loader::tests::integer_literal_suffix_maps_positional_and_named`
Expected: FAIL — `lineLength` is absent (`"120L".parse::<u64>()` returns `None`).

- [ ] **Step 3: Add `parse_r_uint`; reroute the two int parsers**

Add near `parse_positional_int`:

```rust
/// Parse an R unsigned-integer literal: digits with an optional trailing `L`
/// integer-type suffix (e.g. `120`, `120L`). R only accepts the uppercase `L`
/// suffix, so we match that exactly. Returns `None` for floats, hex, signed, or
/// anything else.
fn parse_r_uint(s: &str) -> Option<u64> {
    let s = s.trim();
    let digits = s.strip_suffix('L').unwrap_or(s);
    digits.parse::<u64>().ok()
}
```

Change `parse_positional_int`'s last line from `first.parse::<u64>().ok()` to:

```rust
    parse_r_uint(first)
```

Change `parse_named_int`'s body from `parse_named_arg(args, name)?.parse::<u64>().ok()` to:

```rust
    parse_r_uint(parse_named_arg(args, name)?)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p raven --lib config_file::lintr_loader::tests`
Expected: PASS (new test passes; `line_length_param_maps` etc. still pass — plain `120` has no `L` suffix and `unwrap_or(s)` keeps it).

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/config_file/lintr_loader.rs
git commit -m "fix(lintr): accept R integer literals (120L) in numeric linter args"
```

---

### Task 4: Tolerate whitespace before `(` on call wrappers

**Files:**
- Modify: `crates/raven/src/config_file/lintr_loader.rs` (add `strip_named_call`; reroute `strip_linters_with_defaults`, `apply_exclusions`, `strip_c_vector`)

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn whitespace_before_paren_on_wrappers_is_tolerated() {
    // Valid R: space between the function name and '('.
    let out = load_str("linters: linters_with_defaults (line_length_linter(120))\n");
    assert_eq!(out.settings["linting"]["lineLength"], json!(120));
    assert!(out.warnings.is_empty(), "space before '(' must not warn: {:?}", out.warnings);

    let out = load_str("exclusions: list (\"R/legacy.R\")\n");
    let files = out.settings["linting"]["overrides"][0]["files"].as_array().unwrap();
    assert!(files.iter().any(|v| v == &json!("R/legacy.R")));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p raven --lib config_file::lintr_loader::tests::whitespace_before_paren_on_wrappers_is_tolerated`
Expected: FAIL — `lineLength` absent: `strip_prefix("linters_with_defaults(")` does not match `linters_with_defaults (`, so the whole field is treated as one unrecognized entry.

- [ ] **Step 3: Add `strip_named_call`; reroute the wrappers**

Add near `strip_c_vector`:

```rust
/// Strip a `name(...)` call wrapper, tolerating whitespace between `name` and
/// `(` (valid R: `linters_with_defaults (x)`). Returns the inner argument text,
/// or `None` if `s` is not a `name(...)` call. The required `(` immediately
/// after the (whitespace-trimmed) name is what prevents a false match on a
/// longer identifier: `strip_named_call("listings(x)", "list")` strips the
/// `list` prefix to `"ings(x)"`, whose next non-space char is not `(`, so it
/// returns `None`.
fn strip_named_call<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    let after = s.trim().strip_prefix(name)?.trim_start();
    after.strip_prefix('(').and_then(|r| r.strip_suffix(')'))
}
```

Replace `strip_linters_with_defaults` with:

```rust
fn strip_linters_with_defaults(body: &str) -> &str {
    let trimmed = body.trim();
    if let Some(inner) = strip_named_call(trimmed, "linters_with_defaults") {
        return inner.trim();
    }
    trimmed
}
```

In `apply_exclusions`, replace:

```rust
    let inner = body
        .strip_prefix("list(")
        .and_then(|r| r.strip_suffix(')'))
        .unwrap_or(body);
```

with:

```rust
    let inner = strip_named_call(body, "list").unwrap_or(body);
```

Replace `strip_c_vector`'s body to reuse `strip_named_call` (it already tolerated whitespace; this just removes the duplication):

```rust
fn strip_c_vector(s: &str) -> Option<&str> {
    strip_named_call(s, "c")
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p raven --lib config_file::lintr_loader::tests`
Expected: PASS (new test passes; `object_name_c_vector_tolerates_space_before_paren` and all exclusions/wrapper tests still pass).

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/config_file/lintr_loader.rs
git commit -m "fix(lintr): tolerate whitespace before '(' on linters_with_defaults/list/c wrappers"
```

---

### Task 5 (OPTIONAL — legacy leniency, separable): accept `with_defaults(...)` alias

`with_defaults` was lintr's pre-3.0 name for `linters_with_defaults` and is **removed** in lintr 3.3 (it errors there). Supporting it helps users with older `.lintr` files; it is *not* lintr-3.3 fidelity. Include or cut as a unit.

**Files:**
- Modify: `crates/raven/src/config_file/lintr_loader.rs` (`strip_linters_with_defaults`)

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn legacy_with_defaults_alias_is_accepted() {
    // lintr removed `with_defaults` after 3.0; Raven accepts it leniently as an
    // alias for `linters_with_defaults`.
    let out = load_str("linters: with_defaults(line_length_linter(120))\n");
    assert_eq!(out.settings["linting"]["lineLength"], json!(120));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p raven --lib config_file::lintr_loader::tests::legacy_with_defaults_alias_is_accepted`
Expected: FAIL — `lineLength` absent (`with_defaults(...)` is treated as one unrecognized entry).

- [ ] **Step 3: Match both names in `strip_linters_with_defaults`**

Replace `strip_linters_with_defaults` with:

```rust
fn strip_linters_with_defaults(body: &str) -> &str {
    let trimmed = body.trim();
    // `linters_with_defaults` is the canonical (lintr >= 3.0) name; `with_defaults`
    // is the removed pre-3.0 alias, accepted leniently for older `.lintr` files.
    // Try the canonical name first so it wins (it is not a suffix of the alias).
    for name in ["linters_with_defaults", "with_defaults"] {
        if let Some(inner) = strip_named_call(trimmed, name) {
            return inner.trim();
        }
    }
    trimmed
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p raven --lib config_file::lintr_loader::tests`
Expected: PASS (new test passes; existing `linters_with_defaults` tests still pass — that name is tried first and matches first).

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/config_file/lintr_loader.rs
git commit -m "feat(lintr): accept legacy with_defaults() alias for linters_with_defaults()"
```

---

### Task 6: End-to-end coverage — the user's exact file resolves correctly

Prove the full pipeline (`.lintr` text → `load_str` → `parse_lint_config` → `LintConfig`) on the reported file, and add a CLI-layer regression in `cli/lint.rs`.

**Files:**
- Modify: `crates/raven/src/config_file/lintr_loader.rs` (loader→LintConfig test)
- Modify: `crates/raven/src/cli/lint.rs` (`resolve_lint_config` test)

- [ ] **Step 1: Write the failing tests**

In `lintr_loader.rs` tests:

```rust
#[test]
fn reported_column_zero_file_resolves_to_expected_lint_config() {
    // Exactly the file from the bug report (closing ')' at column 0).
    let input = "linters: linters_with_defaults(\n\
        line_length_linter(120),\n\
        commented_code_linter(),\n\
        object_length_linter(40),\n\
        indentation_linter(4),\n\
        trailing_blank_lines_linter = NULL,\n\
        trailing_whitespace_linter = NULL\n\
        )\n";
    let out = load_str(input);
    let cfg = crate::backend::parse_lint_config(&out.settings, true).unwrap();
    assert!(cfg.enabled);
    assert_eq!(cfg.line_length, 120);
    assert_eq!(cfg.object_length, 40);
    assert_eq!(cfg.indentation_unit, 4);
    assert_eq!(cfg.trailing_blank_lines_severity, None);
    assert_eq!(cfg.trailing_whitespace_severity, None);
    // commented_code stays at its default (recognized, not disabled).
    assert!(cfg.commented_code_severity.is_some());
}
```

In `cli/lint.rs` tests, mirror the existing `resolve_lint_config_honors_discovered_lintr` test exactly — it writes a `.lintr` into a `TempDir` and resolves via the discovery branch using the in-file `discovery_args()` helper. (`LintArgs` does **not** derive `Default`, so do not use `..Default::default()`; the `discovery_args()` helper at `cli/lint.rs:495` is the established way to build it.)

```rust
#[test]
fn resolve_lint_config_reads_column_zero_lintr_file() {
    use std::fs;
    use tempfile::TempDir;
    let tmp = TempDir::new().unwrap();
    fs::write(
        tmp.path().join(".lintr"),
        "linters: linters_with_defaults(\n    line_length_linter(120),\n    trailing_whitespace_linter = NULL\n)\n",
    )
    .unwrap();
    let (_root, settings, lintr_discovered) =
        resolve_lint_config(tmp.path(), &discovery_args()).unwrap();
    let settings = settings.expect("a discovered .lintr yields project settings");
    assert!(lintr_discovered, "a configured .lintr opts in");
    assert_eq!(settings["linting"]["lineLength"], serde_json::json!(120));
    assert_eq!(
        settings["linting"]["trailingWhitespaceSeverity"],
        serde_json::json!("off")
    );
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p raven --lib config_file::lintr_loader::tests::reported_column_zero_file_resolves_to_expected_lint_config cli::lint::tests::resolve_lint_config_reads_column_zero_lintr_file`
Expected: before Task 2 these would fail; after Task 2 the loader test should already PASS. The CLI test is new coverage — it should PASS once written (Task 2's fix flows through). If it fails, fix the test harness (field names), not the loader.

- [ ] **Step 3: (No new implementation)** — these are regression tests over Tasks 2–4. If the loader test fails, the fix is incomplete; return to Task 2.

- [ ] **Step 4: Run the full loader + cli suites**

Run: `cargo test -p raven --lib config_file::lintr_loader cli::lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/config_file/lintr_loader.rs crates/raven/src/cli/lint.rs
git commit -m "test(lintr): end-to-end + CLI coverage for the reported column-0 .lintr"
```

---

### Task 7: Documentation

**Files:**
- Modify: `docs/linting.md` (the "Runtime support" blockquote in "Migrating from `.lintr`", ~line 226)

- [ ] **Step 1: Update the runtime-support note**

Append to the "Runtime support" blockquote (after "Forms outside the supported subset log a single batch warning and are otherwise ignored."):

```markdown
> Multi-line `linters:`/`exclusions:` values are folded by bracket balance, so a closing `)` works whether it sits at column 0 or is indented. (Real `lintr` reads `.lintr` as strict DCF and *rejects* a column-0 continuation — "Regular lines must have a tag" — so Raven logs a one-line note suggesting you indent the closing line if you also run `lintr`.) Numeric arguments accept R integer literals with the `L` suffix (`line_length_linter(120L)`), and whitespace before `(` is tolerated (`linters_with_defaults (...)`). The pre-3.0 `with_defaults(...)` spelling is accepted as an alias for `linters_with_defaults(...)`.
```

> If Task 5 was cut, delete the final sentence about `with_defaults`. If the portability note was cut (fully-silent acceptance), delete the parenthetical about the one-line note.

- [ ] **Step 2: Verify docs build/links unaffected**

Run: `rg -n "read.dcf|column 0|120L|with_defaults" docs/linting.md`
Expected: the new lines are present and the surrounding table is intact.

- [ ] **Step 3: Commit**

```bash
git add docs/linting.md
git commit -m "docs(linting): document bracket-aware folding, L literals, whitespace, with_defaults alias"
```

---

### Task 8 (OPTIONAL — bundled cleanups from the prior session's reviews, separable)

Minor polish surfaced by reviews on the already-committed `b8dcf92d` (blank-`.lintr` gating). Include or cut as a unit; none are required by the syntax fix.

**Files:**
- Modify: `crates/raven/src/config_file/lintr_loader.rs` (`load_str` simplification)
- Modify: `crates/raven/src/cli/lint.rs:125` (doc comment)
- Modify: `editors/vscode/package.json` (~line 1516) + regenerate `docs/settings-reference.md`
- Modify: `docs/diagnostics.md` (lines ~7 and ~254), `docs/linting.md:66`

- [ ] **Step 1: Simplify `load_str`'s emit guard**

In `load_str`, replace:

```rust
    if !linting.is_empty() || expresses_config {
```

with:

```rust
    if expresses_config {
```

Rationale: `linting` is non-empty only when a `linters:`/`exclusions:` branch ran, and those branches set `expresses_config = true`; so `expresses_config` subsumes `!linting.is_empty()`. Confirm by re-running `blank_lintr_contributes_no_linting_object` and `empty_linters_with_defaults_expresses_intent_via_empty_linting_object`.

- [ ] **Step 2: Fix the `lintr_discovered` doc at `cli/lint.rs:125`**

Update the doc comment so it states `lintr_discovered` is true only when a `.lintr` is discovered **and expresses linting intent** (it now also requires the marker via `lintr_expresses_linting`), matching the code at `cli/lint.rs:191` and `:214`.

- [ ] **Step 3: Qualify the blank-`.lintr` wording in docs + settings schema**

- `editors/vscode/package.json` `raven.linting.enabled` description (~1516): add that a blank/empty `.lintr` does NOT count as opting in.
- Regenerate the settings reference: `bun editors/vscode/scripts/generate-settings-reference.mjs`
- `docs/diagnostics.md` lines ~7 and ~254: add the same blank-`.lintr` qualifier.
- `docs/linting.md:66`: change the matrix row "literal `~/.lintr` + readHomeLintr=true ⇒ on" to "configured `~/.lintr`" (a blank home `.lintr` stays off under the gate).

- [ ] **Step 4: Run the full gate + drift test**

Run:
```bash
cargo test -p raven --lib config_file
bun test tests/bun/settings-reference.test.ts
```
Expected: PASS (the settings-reference drift test gates the regenerated file).

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/config_file/lintr_loader.rs crates/raven/src/cli/lint.rs editors/vscode/package.json docs/settings-reference.md docs/diagnostics.md docs/linting.md
git commit -m "docs+cleanup(lintr): blank-.lintr qualifiers, load_str guard, lintr_discovered doc"
```

---

### Final gate + manual verification (do not skip)

- [ ] **Step 1: Full gates green**

```bash
cargo fmt --all && cargo fmt --all --check
cargo clippy --workspace --all-targets --features test-support -- -D warnings
cargo test -p raven --lib
```
Expected: clean format, zero clippy warnings, all tests pass.

- [ ] **Step 2: Rebuild and re-run the reported repro against the new binary**

```bash
cargo build -q
BIN=target/debug/raven
T=$(mktemp -d)
printf 'x <- 1\n\n\n' > "$T/f.R"
printf 'y <- "a line that is definitely more than eighty characters wide to trip line length default now"\n' >> "$T/f.R"
# A: column-0 closing paren -> line_length now 120 (line under limit, no flag); trailing-whitespace disabled
printf 'linters: linters_with_defaults(\n    line_length_linter(120),\n    trailing_whitespace_linter = NULL\n)\n' > "$T/.lintr"
"$BIN" lint --config "$T/.lintr" --max-severity off "$T/f.R"
# C: 120L -> line_length now 120
printf 'linters: linters_with_defaults(line_length_linter(120L))\n' > "$T/.lintr"
"$BIN" lint --config "$T/.lintr" --max-severity off "$T/f.R"
rm -rf "$T"
```
Expected: for A, **0 issues** for the line-length lint (97-char line still flagged only if it exceeds 120 — the sample line is 97 chars, so it is now under the 120 limit and NOT flagged), and no trailing-whitespace flag; the portability note prints once to stderr. For C, the 97-char line is under 120 and not flagged.

> Sanity note for the verifier: with `line_length=120`, the 97-char sample line is *under* the limit, so the only way to see the fix is the **absence** of the previous `Line is 97 characters long; limit is 80` message. Optionally lengthen the sample line beyond 120 to see the limit echoed as `limit is 120`.

- [ ] **Step 3: Confirm against real lintr (fidelity check)** — the indented form must remain identical, and the column-0 form is the one Raven is deliberately lenient about:

```bash
Rscript -e 'f<-tempfile(fileext=".lintr"); writeLines(c("linters: linters_with_defaults(","    line_length_linter(120)","    )"), f); cfg<-lintr:::read_config_file(f); cat("indented OK, n=", length(cfg$linters), "\n")'
```
Expected: `indented OK, n= ...` (lintr accepts the indented form; Raven matches it).

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Column-0 silent failure → Task 2 (accept via bracket-aware fold) + portability note. ✓
- `120L` integer literals → Task 3. ✓
- Whitespace before `(` → Task 4. ✓
- `#`-comment silent drop (discovered during investigation) → Task 2 (newline join + comment-aware scanner from Task 1). ✓
- `with_defaults` alias → Task 5 (optional). ✓
- Multi-line `exclusions:` → covered free by Task 2 (test included). ✓
- "Never silently drop" for non-representable forms (`defaults=list()`, `all_linters`, `linters_with_tags`, line-range exclusions) → already warn; documented as non-goals. ✓
- Docs → Task 7; bundled prior-session cleanups → Task 8 (optional). ✓
- Verification → Final gate Steps 1–3 (re-run repro + lintr fidelity). ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to" — every code step shows the code. The one flagged uncertainty (`LintArgs` field names in Task 6 CLI test) is explicitly called out with the action to confirm. ✓

**Type consistency:** `ScanState`/`net_bracket_depth` (Task 1) are used by `dcf_fold` (Task 2), `split_top_level_commas` (Task 1), and `strip_comments` (Task 2). `FoldResult { fields, column0_continuations }` defined and destructured consistently in Task 2. `strip_named_call` (Task 4) reused by `strip_linters_with_defaults`, `apply_exclusions`, `strip_c_vector`, and extended in Task 5. `parse_r_uint` (Task 3) used by both int parsers. ✓

## Adversarial review (incorporated)

An independent adversarial review of the first draft found one BLOCKER and several smaller issues, all folded in above:
- **[BLOCKER] Comment text survives folding.** Newline-joining alone left `# …` embedded in the entry, breaking `apply_linters`'s name extraction. Fixed by adding `strip_comments` (string-aware, shared `ScanState`) called at the top of `apply_linters` and `apply_exclusions`, before splitting.
- **[MAJOR] `needless_range_loop` clippy denial.** Rewrote `net_bracket_depth` / `split_top_level_commas` to iterate `bytes().enumerate()` instead of `for i in 0..len` with indexing.
- **[MINOR→fixed] Escaped-backslash string bug.** Replaced the naive `prev != Some(b'\\')` check with an `escaped` flag in `ScanState` (also removes the `prev` parameter). Added test coverage (`"a\\"` closes; `"a\""` stays open).
- **[MINOR] Misleading `strip_named_call` docstring** corrected (the guard is the immediate-`(` requirement). **Portability note** reworded to not single out a content line. **Malformed-input** column-0/unbalanced cases documented as explicit non-goals.
- The review **cleared**: the `split_top_level_commas` reroute is behavior-preserving for existing tests; `parse_r_uint` has no plain-integer regression; `strip_named_call(s,"c")` faithfully replaces `strip_c_vector`; `with_defaults` cannot prefix-collide; first-field depth is computed on the post-colon value; UTF-8 byte iteration is safe.
