# Apply-Family Library Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Raven recognise package loads like `sapply(c("dplyr","tidyr"), require, character.only = TRUE)` and `sapply(libs, require, character.only = TRUE)` so the per-package `{...}` exports become available and the "undefined variable" diagnostic disappears (issue #172).

**Architecture:** Stay inside `crates/raven/src/cross_file/source_detect.rs`. Extend `detect_library_calls` so that when an apply-family call passes a bare `library`/`require` reference plus `character.only = TRUE`, we extract the X argument's static string vector (inline `c(...)` or a same-file variable assigned exactly once via `<-`/`=`/`assign()`) and emit one `LibraryCall` per package. All emitted calls share the apply call's end position. `LibraryCall`'s shape is unchanged, so every consumer (`extract_metadata`, `compute_artifacts*`, `extract_loaded_packages_from_library_calls`) picks up the new entries automatically.

**Tech Stack:** Rust + tree-sitter-r 0.x. Existing helpers `is_c_call`, `extract_string_literal`, `byte_offset_to_utf16_column`, `has_character_only_true`. Tests use the existing `parse_r` helper plus the same `#[test]` style as the surrounding library-call tests.

**Out of scope (don't implement):** dynamic vector construction (`paste0`/`tolower`/`setdiff`/`c(libs1, libs2)`), variables defined in another file, `for` loops, anonymous-function FUNs (`\(x) library(x)`, `~require(.x)`), and any runtime evaluation. These should be silently skipped, not diagnosed.

---

## File Structure

**Modified files:**

- `crates/raven/src/cross_file/source_detect.rs` — primary changes (apply detection + var lookup + tests, all alongside the existing library detection)
- `docs/cross-file.md` — append a row to the "Supported Call Patterns" table and mention the apply pattern

**No other files need changes.** `LibraryCall`'s struct stays the same. Downstream code in `cross_file/mod.rs::extract_metadata`, `cross_file/scope.rs::compute_artifacts*`, and `backend.rs::extract_loaded_packages_from_library_calls` already iterates each `LibraryCall`, so emitting multiple entries from one apply call slots in without changes.

**Why one file:** All new detection work fits inside `source_detect.rs`'s existing "Library Call Detection" section. New helpers should sit between the existing helpers (`extract_package_value`) and the test module. Tests go inside the existing `#[cfg(test)] mod tests` at the bottom of the existing tests, in a clearly demarcated subsection.

---

## Background — what the AST looks like

These shapes drive the implementation. They were verified by parsing real code with tree-sitter-r in this repo:

```text
sapply(c("a","b"), require, character.only = TRUE)
└─ call
   ├─ identifier "sapply"                               ← function field
   └─ arguments
      ├─ argument [no name field]                       ← positional X
      │  └─ call (the c())
      │     ├─ identifier "c"
      │     └─ arguments
      │        ├─ argument: string "a"
      │        └─ argument: string "b"
      ├─ argument [no name field]                       ← positional FUN
      │  └─ identifier "require"
      └─ argument [name = identifier "character.only"]  ← named arg
         └─ true "TRUE"                                 ← value field

purrr::map(libs, library, character.only = TRUE)
└─ call
   ├─ namespace_operator "purrr::map"                   ← function field
   │  ├─ identifier "purrr"
   │  ├─ ::
   │  └─ identifier "map"
   └─ arguments (same shape as above; X is identifier "libs")

libs <- c("a", "b")
└─ binary_operator
   ├─ identifier "libs"
   ├─ <-
   └─ call (c)

assign("libs", c("a", "b"))
└─ call
   ├─ identifier "assign"
   └─ arguments
      ├─ argument: string "libs"
      └─ argument: call (c with strings)
```

Key facts:
- `argument` nodes expose `name` (the LHS of `=`) and `value` (the RHS) via tree-sitter field names. A positional argument has no `name` field but does have `value`.
- `character.only = TRUE` parses with `value` being the `true` keyword node whose text is `"TRUE"` — `node_text(value_node, content) == "TRUE"` works (existing `has_character_only_true` already handles this).
- `purrr::map` uses `kind = "namespace_operator"` with three children: the namespace identifier, `::`, and the function identifier (in that order).

---

## Behaviour spec (what the code must enforce)

For every `call` node in the tree:

1. **Apply call?** The function child is either:
   - an `identifier` whose text is in the bare apply set (below), OR
   - a `namespace_operator` whose left identifier is `"purrr"` and whose right identifier is in the purrr apply set.
2. **`character.only = TRUE` present?** If not (missing, `FALSE`, `F`, or any other expression), skip silently. (Reuse `has_character_only_true`.)
3. **Library FUN found?** Walk positional args (those without a `name` field). At least one must be an `identifier` whose text is `"library"` or `"require"`. (`loadNamespace` is intentionally **not** supported here; its signature differs.)
4. **Static X vector found?** Among the *other* positional args, exactly one must resolve to `Some(Vec<String>)` via:
   - **Inline:** the arg's value is a `c(...)` call where every argument is a string literal and there are no named args. (`extract_c_strings_strict` below.)
   - **Same-file variable:** the arg's value is an `identifier` whose name has a `Resolved { packages, byte_offset }` entry in the variable map AND `byte_offset < apply_call.start_byte()`.
5. **Emit:** for each package, push a `LibraryCall { package, line, column, function_scope: None }` where `(line, column)` is the UTF-16 end position of the apply call.

If multiple positional args satisfy step 4, treat as ambiguous and skip silently. If none satisfies step 4, skip silently. If FUN is missing, skip silently. The downstream wiring requires `function_scope` to stay `None` here — `compute_artifacts*` populates it later via `find_containing_function_scope`.

The variable-lookup map is built once per `detect_library_calls` invocation. Every binding to an identifier name `n` (anywhere in the file) increments `n`'s count. We extract the c-of-strings RHS only for assignments of the form `<-` / `=` / `assign("n", ...)`. After traversal:

- `count == 1` AND we extracted a c-of-strings → `Resolved { packages, byte_offset }`.
- Anything else (count == 0, count > 1, or count == 1 but RHS isn't a c-of-strings) → no usable binding (entry absent or `Unresolvable`).

Function parameter names also increment the count (so a `libs` parameter shadowing a global `libs` causes us to skip — conservative). `<<-`, `->`, `->>` increment the count but never extract.

---

## Apply function name sets

Use these exact sets in `is_apply_family_function`:

```rust
const APPLY_BARE_NAMES: &[&str] = &[
    // base R apply family
    "sapply", "lapply", "vapply", "mapply",
    // purrr (callable bare when `library(purrr)` is in scope)
    "map", "walk", "pmap", "imap", "iwalk", "pwalk",
    "map_chr", "map_int", "map_dbl", "map_lgl", "map_raw",
    "map_dfr", "map_dfc", "map_vec",
    "map_if", "map_at",
    "map2", "map2_chr", "map2_int", "map2_dbl", "map2_lgl",
    "map2_dfr", "map2_dfc", "map2_vec",
    "walk2",
];

const APPLY_PURRR_NAMES: &[&str] = &[
    "map", "walk", "pmap", "imap", "iwalk", "pwalk",
    "map_chr", "map_int", "map_dbl", "map_lgl", "map_raw",
    "map_dfr", "map_dfc", "map_vec",
    "map_if", "map_at",
    "map2", "map2_chr", "map2_int", "map2_dbl", "map2_lgl",
    "map2_dfr", "map2_dfc", "map2_vec",
    "walk2",
];
```

Both lists may be defined as `const` arrays at the top of the new helpers section.

---

## Task 1: Inline `c(...)` apply detection (sapply + library)

**Files:**
- Modify: `crates/raven/src/cross_file/source_detect.rs` — add helpers and tests in the `// ==================== library()/require()/loadNamespace() detection tests ====================` section (around line 1382) for the tests, and immediately after `extract_package_value` (around line 720) for the new helpers.

- [ ] **Step 1: Write the failing test for inline `c(...)`**

Insert into `mod tests` (before the property-tests module, e.g. after `test_library_function_scope_is_none`):

```rust
#[test]
fn test_apply_inline_c_with_library() {
    // sapply(c("dplyr","tidyr"), library, character.only = TRUE)
    // Validates issue #172 — the "inline c()" path.
    let code = r#"sapply(c("dplyr", "tidyr"), library, character.only = TRUE)"#;
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 2);
    assert_eq!(lib_calls[0].package, "dplyr");
    assert_eq!(lib_calls[1].package, "tidyr");
    // Both share the apply call's end position
    assert_eq!(lib_calls[0].line, 0);
    assert_eq!(lib_calls[1].line, 0);
    assert_eq!(lib_calls[0].column, lib_calls[1].column);
    assert!(lib_calls[0].function_scope.is_none());
}
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cargo test -p raven --lib test_apply_inline_c_with_library 2>&1 | tail -20
```

Expected: `assertion `left == right` failed: 0 vs 2` (or similar — current detection returns 0 calls).

- [ ] **Step 3: Add the apply-detection helpers**

Insert these helpers in `source_detect.rs` immediately after `extract_package_value` (around line 720, before `#[cfg(test)] mod tests`):

```rust
// ============================================================================
// Apply-family library detection (issue #172)
// ============================================================================

const APPLY_BARE_NAMES: &[&str] = &[
    "sapply", "lapply", "vapply", "mapply",
    "map", "walk", "pmap", "imap", "iwalk", "pwalk",
    "map_chr", "map_int", "map_dbl", "map_lgl", "map_raw",
    "map_dfr", "map_dfc", "map_vec",
    "map_if", "map_at",
    "map2", "map2_chr", "map2_int", "map2_dbl", "map2_lgl",
    "map2_dfr", "map2_dfc", "map2_vec",
    "walk2",
];

const APPLY_PURRR_NAMES: &[&str] = &[
    "map", "walk", "pmap", "imap", "iwalk", "pwalk",
    "map_chr", "map_int", "map_dbl", "map_lgl", "map_raw",
    "map_dfr", "map_dfc", "map_vec",
    "map_if", "map_at",
    "map2", "map2_chr", "map2_int", "map2_dbl", "map2_lgl",
    "map2_dfr", "map2_dfc", "map2_vec",
    "walk2",
];

/// Returns true if `func_node` names a base-R or purrr apply-family function we
/// support for static library-vector detection. Accepts bare identifiers
/// (`sapply`, `map`, ...) and `purrr::xxx` namespace_operator nodes.
fn is_apply_family_function(func_node: Node, content: &str) -> bool {
    match func_node.kind() {
        "identifier" => {
            let name = node_text(func_node, content);
            APPLY_BARE_NAMES.contains(&name)
        }
        "namespace_operator" => {
            // Children are: identifier (namespace), :: (anonymous), identifier (name).
            let mut cursor = func_node.walk();
            let named_children: Vec<Node> = func_node
                .children(&mut cursor)
                .filter(|c| c.is_named())
                .collect();
            if named_children.len() != 2 {
                return false;
            }
            let ns = node_text(named_children[0], content);
            let name = node_text(named_children[1], content);
            ns == "purrr" && APPLY_PURRR_NAMES.contains(&name)
        }
        _ => false,
    }
}

/// Strict variant of `extract_c_string_args`: returns `Some(packages)` only if
/// `node` is `c(arg1, arg2, ...)` where every argument is a positional string
/// literal and at least one argument is present. Returns `None` for any
/// non-string element, named argument, or empty `c()`.
fn extract_c_strings_strict(node: Node, content: &str) -> Option<Vec<String>> {
    if !is_c_call(node, content) {
        return None;
    }
    let args_node = node.child_by_field_name("arguments")?;
    if args_node.has_error() {
        return None;
    }
    let mut strings = Vec::new();
    let mut cursor = args_node.walk();
    for child in args_node.children(&mut cursor) {
        if child.kind() != "argument" {
            continue;
        }
        if child.child_by_field_name("name").is_some() {
            return None; // named arg in c() — treat as dynamic
        }
        let value_node = child.child_by_field_name("value")?;
        if value_node.kind() != "string" {
            return None;
        }
        let s = extract_string_literal(value_node, content)?;
        strings.push(s);
    }
    if strings.is_empty() {
        None
    } else {
        Some(strings)
    }
}

/// Try to interpret `node` (a "call" AST node) as an apply-family call that
/// loads packages dynamically — e.g.
/// `sapply(c("dplyr","tidyr"), require, character.only = TRUE)`.
///
/// Returns one `LibraryCall` per package when:
/// - the function is a supported apply-family name (see `is_apply_family_function`),
/// - `character.only = TRUE` (or `T`) is set,
/// - exactly one positional arg resolves to `Some(Vec<String>)` (inline `c(...)`
///   for now; same-file variables come in Task 3),
/// - at least one positional arg is the bare identifier `library` or `require`,
/// - and the X arg precedes nothing dynamic (we already excluded that above).
///
/// All returned `LibraryCall`s share the apply call's end position. Position
/// columns use UTF-16 code units to match the rest of the LSP surface.
fn try_parse_apply_library_call(node: Node, content: &str) -> Vec<LibraryCall> {
    let func_node = match node.child_by_field_name("function") {
        Some(n) => n,
        None => return Vec::new(),
    };
    if !is_apply_family_function(func_node, content) {
        return Vec::new();
    }

    let args_node = match node.child_by_field_name("arguments") {
        Some(n) => n,
        None => return Vec::new(),
    };
    if args_node.has_error() {
        return Vec::new();
    }

    if !has_character_only_true(&args_node, content) {
        return Vec::new();
    }

    let mut has_library_fun = false;
    let mut packages: Option<Vec<String>> = None;
    let mut ambiguous = false;
    let mut cursor = args_node.walk();
    for child in args_node.children(&mut cursor) {
        if child.kind() != "argument" {
            continue;
        }
        if child.child_by_field_name("name").is_some() {
            continue;
        }
        let value_node = match child.child_by_field_name("value") {
            Some(n) => n,
            None => continue,
        };

        if value_node.kind() == "identifier" {
            let text = node_text(value_node, content);
            if text == "library" || text == "require" {
                has_library_fun = true;
                continue;
            }
            // Variable lookup comes in Task 3; for now identifiers other than
            // `library`/`require` are skipped silently.
            continue;
        }

        if let Some(strings) = extract_c_strings_strict(value_node, content) {
            if packages.is_some() {
                ambiguous = true;
            }
            packages = Some(strings);
        }
    }

    if !has_library_fun || ambiguous {
        return Vec::new();
    }
    let packages = match packages {
        Some(p) => p,
        None => return Vec::new(),
    };

    let end = node.end_position();
    let line_text = content.lines().nth(end.row).unwrap_or("");
    let column = byte_offset_to_utf16_column(line_text, end.column);
    let line = end.row as u32;

    packages
        .into_iter()
        .map(|package| LibraryCall {
            package,
            line,
            column,
            function_scope: None,
        })
        .collect()
}
```

Then update `visit_node_for_library` to also try the apply parser. Replace the existing function body (around line 547) with:

```rust
fn visit_node_for_library(node: Node, content: &str, library_calls: &mut Vec<LibraryCall>) {
    if node.kind() == "identifier" {
        return;
    }
    if node.kind() == "call" {
        if let Some(lib_call) = try_parse_library_call(node, content) {
            library_calls.push(lib_call);
        } else {
            // Fall through to apply-family detection only when the call wasn't
            // a direct library/require/loadNamespace match — the two parsers
            // are mutually exclusive (different function names).
            library_calls.extend(try_parse_apply_library_call(node, content));
        }
    }

    for child in node.children(&mut node.walk()) {
        visit_node_for_library(child, content, library_calls);
    }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
cargo test -p raven --lib test_apply_inline_c_with_library 2>&1 | tail -10
```

Expected: `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/cross_file/source_detect.rs
git commit -m "feat(cross-file): detect inline c() vector in apply-family library calls (#172)"
```

---

## Task 2: All apply families — sapply / lapply / vapply / mapply, plus require

**Files:**
- Modify: `crates/raven/src/cross_file/source_detect.rs` (tests only)

- [ ] **Step 1: Write the failing tests**

Add immediately after `test_apply_inline_c_with_library`:

```rust
#[test]
fn test_apply_lapply_inline_c_with_require() {
    let code = r#"lapply(c("dplyr"), require, character.only = TRUE)"#;
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 1);
    assert_eq!(lib_calls[0].package, "dplyr");
}

#[test]
fn test_apply_vapply_inline_c() {
    // vapply has extra signature args, but library FUN + c() X still detect.
    let code = r#"vapply(c("dplyr","tidyr"), require, logical(1), character.only = TRUE)"#;
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 2);
    assert_eq!(lib_calls[0].package, "dplyr");
    assert_eq!(lib_calls[1].package, "tidyr");
}

#[test]
fn test_apply_mapply_inline_c() {
    // mapply puts FUN first; we're position-agnostic so it still matches.
    let code = r#"mapply(library, c("dplyr","tidyr"), character.only = TRUE)"#;
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 2);
    assert_eq!(lib_calls[0].package, "dplyr");
    assert_eq!(lib_calls[1].package, "tidyr");
}

#[test]
fn test_apply_with_require_named_x_arg_skipped() {
    // c() inside a named arg is currently *not* detected — only positional X
    // args are considered. This documents the limitation.
    let code = r#"sapply(X = c("dplyr"), FUN = require, character.only = TRUE)"#;
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 0);
}
```

- [ ] **Step 2: Run the tests and confirm**

```bash
cargo test -p raven --lib 'test_apply_' 2>&1 | tail -20
```

Expected: 4 passed (the prior `test_apply_inline_c_with_library` plus three new ones; one new test asserts non-detection).

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/cross_file/source_detect.rs
git commit -m "test(cross-file): cover lapply/vapply/mapply + require in apply detection"
```

---

## Task 3: purrr — bare and `purrr::`-qualified

**Files:**
- Modify: `crates/raven/src/cross_file/source_detect.rs` (tests only)

- [ ] **Step 1: Write the failing tests**

Append to the same library-test block:

```rust
#[test]
fn test_apply_purrr_bare_walk() {
    let code = r#"walk(c("dplyr","tidyr"), library, character.only = TRUE)"#;
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 2);
    assert_eq!(lib_calls[0].package, "dplyr");
    assert_eq!(lib_calls[1].package, "tidyr");
}

#[test]
fn test_apply_purrr_qualified_map() {
    let code = r#"purrr::map(c("dplyr"), library, character.only = TRUE)"#;
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 1);
    assert_eq!(lib_calls[0].package, "dplyr");
}

#[test]
fn test_apply_purrr_qualified_map_chr() {
    let code = r#"purrr::map_chr(c("dplyr","tidyr"), library, character.only = TRUE)"#;
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 2);
}

#[test]
fn test_apply_other_namespace_not_detected() {
    // foo::map(...) is not purrr — skip.
    let code = r#"foo::map(c("dplyr"), library, character.only = TRUE)"#;
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 0);
}
```

- [ ] **Step 2: Run the tests**

```bash
cargo test -p raven --lib 'test_apply_purrr' 2>&1 | tail -15
cargo test -p raven --lib test_apply_other_namespace_not_detected 2>&1 | tail -10
```

Expected: all four tests pass with no implementation changes (the helpers from Task 1 already accept `namespace_operator`).

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/cross_file/source_detect.rs
git commit -m "test(cross-file): cover purrr bare and qualified apply detection"
```

---

## Task 4: Same-file variable assignment lookup — single `<-`

**Files:**
- Modify: `crates/raven/src/cross_file/source_detect.rs` (helper + threading + tests)

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn test_apply_var_single_arrow_assignment() {
    // Same-file variable assigned exactly once via `<-` to c() of strings.
    let code = "libs <- c(\"dplyr\", \"tidyr\")\nsapply(libs, require, character.only = TRUE)";
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 2);
    assert_eq!(lib_calls[0].package, "dplyr");
    assert_eq!(lib_calls[1].package, "tidyr");
    // Both share the apply call's end position (line 1).
    assert_eq!(lib_calls[0].line, 1);
    assert_eq!(lib_calls[1].line, 1);
}
```

- [ ] **Step 2: Run and confirm it fails**

```bash
cargo test -p raven --lib test_apply_var_single_arrow_assignment 2>&1 | tail -10
```

Expected: `assertion 'left == right' failed: 0 vs 2`.

- [ ] **Step 3: Add `VarBinding` + the variable-collection pre-pass + thread it through**

Add this near the new apply helpers (right before `try_parse_apply_library_call`):

```rust
use std::collections::HashMap;

/// Information collected for an identifier appearing on the LHS of any binding
/// (assignment operator or `assign("name", ...)` call) or as a function
/// parameter, anywhere in the file. Used to resolve apply-X arguments that are
/// variable references.
///
/// `assignment_count` includes every binding form (`<-`, `=`, `<<-`, `->`,
/// `->>`, `assign(...)`, function parameter). Only assignments via `<-`, `=`,
/// or `assign("name", ...)` *to a `c(...)` of string literals* populate
/// `static_packages`; everything else leaves it empty.
#[derive(Debug, Default)]
struct VarBinding {
    assignment_count: u32,
    /// Populated only when there is at least one supported, statically-resolved
    /// assignment. Stores `(packages, byte_offset_of_assignment_node)`.
    static_packages: Option<(Vec<String>, usize)>,
}

impl VarBinding {
    /// Return packages iff `count == 1` and we extracted a static c-of-strings
    /// from that single assignment, AND the assignment node started before
    /// `before_byte`.
    fn resolved_before(&self, before_byte: usize) -> Option<&[String]> {
        if self.assignment_count != 1 {
            return None;
        }
        let (pkgs, off) = self.static_packages.as_ref()?;
        if *off < before_byte {
            Some(pkgs.as_slice())
        } else {
            None
        }
    }
}

fn collect_var_bindings(root: Node, content: &str) -> HashMap<String, VarBinding> {
    let mut map: HashMap<String, VarBinding> = HashMap::new();
    visit_var_bindings(root, content, &mut map);
    map
}

fn visit_var_bindings(node: Node, content: &str, map: &mut HashMap<String, VarBinding>) {
    match node.kind() {
        "binary_operator" => record_binary_assignment(node, content, map),
        "call" => record_assign_call(node, content, map),
        "function_definition" => record_function_params(node, content, map),
        _ => {}
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        visit_var_bindings(child, content, map);
    }
}

fn record_binary_assignment(node: Node, content: &str, map: &mut HashMap<String, VarBinding>) {
    // Find named children: lhs, op, rhs (skipping anonymous tokens).
    let mut cursor = node.walk();
    let named: Vec<Node> = node.children(&mut cursor).filter(|c| c.is_named()).collect();
    if named.len() != 2 {
        return; // shape we expect is two named children with the op between as anonymous text
    }
    // The assignment operator is an anonymous child. Read it from the full
    // children list to determine direction.
    let mut walker = node.walk();
    let all: Vec<Node> = node.children(&mut walker).collect();
    let op_text = all.iter().find_map(|c| {
        let t = node_text(*c, content);
        if matches!(t, "<-" | "=" | "<<-" | "->" | "->>") {
            Some(t)
        } else {
            None
        }
    });
    let Some(op) = op_text else { return };

    let (name_node, value_node) = match op {
        "<-" | "=" | "<<-" => (named[0], named[1]),
        "->" | "->>" => (named[1], named[0]),
        _ => return,
    };
    if name_node.kind() != "identifier" {
        return;
    }
    let name = node_text(name_node, content).to_string();
    let entry = map.entry(name).or_default();
    entry.assignment_count = entry.assignment_count.saturating_add(1);

    // Only `<-` and `=` extract.
    if matches!(op, "<-" | "=") {
        if let Some(packages) = extract_c_strings_strict(value_node, content) {
            // First static extraction wins; if a later one comes in, the count
            // will already be > 1 so `resolved_before` will reject it anyway.
            if entry.static_packages.is_none() {
                entry.static_packages = Some((packages, node.start_byte()));
            }
        }
    }
}

fn record_assign_call(node: Node, content: &str, map: &mut HashMap<String, VarBinding>) {
    let func_node = match node.child_by_field_name("function") {
        Some(n) => n,
        None => return,
    };
    if node_text(func_node, content) != "assign" {
        return;
    }
    let args_node = match node.child_by_field_name("arguments") {
        Some(n) => n,
        None => return,
    };
    if args_node.has_error() {
        return;
    }
    let mut cursor = args_node.walk();
    let positional: Vec<Node> = args_node
        .children(&mut cursor)
        .filter(|c| c.kind() == "argument" && c.child_by_field_name("name").is_none())
        .collect();
    if positional.len() < 2 {
        return;
    }
    let name_value = match positional[0].child_by_field_name("value") {
        Some(n) => n,
        None => return,
    };
    let name = match extract_string_literal(name_value, content) {
        Some(s) => s,
        None => return, // dynamic name — don't bind
    };
    let value_node = match positional[1].child_by_field_name("value") {
        Some(n) => n,
        None => return,
    };
    let entry = map.entry(name).or_default();
    entry.assignment_count = entry.assignment_count.saturating_add(1);
    if let Some(packages) = extract_c_strings_strict(value_node, content) {
        if entry.static_packages.is_none() {
            entry.static_packages = Some((packages, node.start_byte()));
        }
    }
}

fn record_function_params(node: Node, content: &str, map: &mut HashMap<String, VarBinding>) {
    // Conservative: increment count for every parameter name seen in any
    // function definition. This deliberately disqualifies file-global
    // identifiers shadowed by a same-named function parameter.
    let parameters = match node.child_by_field_name("parameters") {
        Some(n) => n,
        None => return,
    };
    let mut cursor = parameters.walk();
    for child in parameters.children(&mut cursor) {
        if child.kind() != "parameter" {
            continue;
        }
        // A parameter exposes the identifier via the `name` field.
        let Some(name_node) = child.child_by_field_name("name") else {
            continue;
        };
        if name_node.kind() != "identifier" {
            continue;
        }
        let name = node_text(name_node, content).to_string();
        let entry = map.entry(name).or_default();
        entry.assignment_count = entry.assignment_count.saturating_add(1);
    }
}
```

Now update `try_parse_apply_library_call` to take `&HashMap<String, VarBinding>` and resolve identifier args. Replace the existing function with:

```rust
fn try_parse_apply_library_call(
    node: Node,
    content: &str,
    var_lookup: &HashMap<String, VarBinding>,
) -> Vec<LibraryCall> {
    let func_node = match node.child_by_field_name("function") {
        Some(n) => n,
        None => return Vec::new(),
    };
    if !is_apply_family_function(func_node, content) {
        return Vec::new();
    }

    let args_node = match node.child_by_field_name("arguments") {
        Some(n) => n,
        None => return Vec::new(),
    };
    if args_node.has_error() {
        return Vec::new();
    }

    if !has_character_only_true(&args_node, content) {
        return Vec::new();
    }

    let call_start = node.start_byte();
    let mut has_library_fun = false;
    let mut packages: Option<Vec<String>> = None;
    let mut ambiguous = false;
    let mut cursor = args_node.walk();
    for child in args_node.children(&mut cursor) {
        if child.kind() != "argument" {
            continue;
        }
        if child.child_by_field_name("name").is_some() {
            continue;
        }
        let value_node = match child.child_by_field_name("value") {
            Some(n) => n,
            None => continue,
        };

        if value_node.kind() == "identifier" {
            let text = node_text(value_node, content);
            if text == "library" || text == "require" {
                has_library_fun = true;
                continue;
            }
            if let Some(binding) = var_lookup.get(text) {
                if let Some(pkgs) = binding.resolved_before(call_start) {
                    if packages.is_some() {
                        ambiguous = true;
                    }
                    packages = Some(pkgs.to_vec());
                }
            }
            continue;
        }

        if let Some(strings) = extract_c_strings_strict(value_node, content) {
            if packages.is_some() {
                ambiguous = true;
            }
            packages = Some(strings);
        }
    }

    if !has_library_fun || ambiguous {
        return Vec::new();
    }
    let packages = match packages {
        Some(p) => p,
        None => return Vec::new(),
    };

    let end = node.end_position();
    let line_text = content.lines().nth(end.row).unwrap_or("");
    let column = byte_offset_to_utf16_column(line_text, end.column);
    let line = end.row as u32;

    packages
        .into_iter()
        .map(|package| LibraryCall {
            package,
            line,
            column,
            function_scope: None,
        })
        .collect()
}
```

Update `detect_library_calls` to build the lookup once and pass it down. Replace the body of `detect_library_calls` with:

```rust
pub fn detect_library_calls(tree: &Tree, content: &str) -> Vec<LibraryCall> {
    log::trace!("Starting tree-sitter parsing for library() call detection");
    let mut library_calls = Vec::new();
    let root = tree.root_node();
    let var_lookup = collect_var_bindings(root, content);
    visit_node_for_library(root, content, &var_lookup, &mut library_calls);
    log::trace!(
        "Completed library() call detection, found {} calls",
        library_calls.len()
    );
    for lib_call in &library_calls {
        log::trace!(
            "  Detected library() call: package='{}' at line {} column {}",
            lib_call.package,
            lib_call.line,
            lib_call.column
        );
    }
    library_calls
}
```

And update `visit_node_for_library`'s signature to thread the lookup:

```rust
fn visit_node_for_library(
    node: Node,
    content: &str,
    var_lookup: &HashMap<String, VarBinding>,
    library_calls: &mut Vec<LibraryCall>,
) {
    if node.kind() == "identifier" {
        return;
    }
    if node.kind() == "call" {
        if let Some(lib_call) = try_parse_library_call(node, content) {
            library_calls.push(lib_call);
        } else {
            library_calls.extend(try_parse_apply_library_call(node, content, var_lookup));
        }
    }

    for child in node.children(&mut node.walk()) {
        visit_node_for_library(child, content, var_lookup, library_calls);
    }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
cargo test -p raven --lib test_apply_var_single_arrow_assignment 2>&1 | tail -10
cargo test -p raven --lib cross_file::source_detect 2>&1 | tail -10
```

Expected: target test passes; the existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/cross_file/source_detect.rs
git commit -m "feat(cross-file): resolve same-file variable in apply-family library detection"
```

---

## Task 5: `=` and `assign()` assignment forms; ordering rule

**Files:**
- Modify: `crates/raven/src/cross_file/source_detect.rs` (tests only)

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn test_apply_var_equals_assignment() {
    let code = "libs = c(\"dplyr\", \"tidyr\")\nsapply(libs, library, character.only = TRUE)";
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 2);
    assert_eq!(lib_calls[0].package, "dplyr");
    assert_eq!(lib_calls[1].package, "tidyr");
}

#[test]
fn test_apply_var_assign_call() {
    let code =
        "assign(\"libs\", c(\"dplyr\", \"tidyr\"))\nsapply(libs, library, character.only = TRUE)";
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 2);
}

#[test]
fn test_apply_var_assignment_after_apply_call_skipped() {
    // Variable assigned *after* the apply call must not resolve.
    let code = "sapply(libs, library, character.only = TRUE)\nlibs <- c(\"dplyr\")";
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 0);
}
```

- [ ] **Step 2: Run the tests**

```bash
cargo test -p raven --lib 'test_apply_var_' 2>&1 | tail -20
```

Expected: all three new tests pass (Task 4 already wired `=` and `assign()` and the byte-offset comparison).

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/cross_file/source_detect.rs
git commit -m "test(cross-file): cover = / assign() / ordering in apply var lookup"
```

---

## Task 6: Multi-assignment, function-arg, and dynamic skips

**Files:**
- Modify: `crates/raven/src/cross_file/source_detect.rs` (tests only)

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn test_apply_var_multiple_assignments_skipped() {
    let code = "libs <- c(\"dplyr\")\nlibs <- c(\"tidyr\")\nsapply(libs, library, character.only = TRUE)";
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 0);
}

#[test]
fn test_apply_var_super_assignment_disqualifies() {
    // <<- alone counts but doesn't extract — single-assignment but no static
    // packages means the binding doesn't resolve.
    let code = "libs <<- c(\"dplyr\")\nsapply(libs, library, character.only = TRUE)";
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 0);
}

#[test]
fn test_apply_var_function_param_shadow_disqualifies() {
    // A function parameter named `libs` increments the count and disqualifies
    // the global binding.
    let code = "libs <- c(\"dplyr\")\nf <- function(libs) {}\nsapply(libs, library, character.only = TRUE)";
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 0);
}

#[test]
fn test_apply_dynamic_x_paste0_skipped() {
    let code = r#"sapply(paste0("dp", "lyr"), library, character.only = TRUE)"#;
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 0);
}

#[test]
fn test_apply_dynamic_x_setdiff_skipped() {
    let code = r#"sapply(setdiff(c("a","b"), "b"), library, character.only = TRUE)"#;
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 0);
}

#[test]
fn test_apply_dynamic_x_c_with_var_skipped() {
    // c() containing a non-string argument disqualifies the X arg entirely.
    let code = "libs1 <- c(\"a\")\nsapply(c(libs1, \"b\"), library, character.only = TRUE)";
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 0);
}

#[test]
fn test_apply_anonymous_fun_skipped() {
    // \(x) library(x) — FUN is not a bare identifier.
    let code = r#"sapply(c("dplyr"), \(x) library(x), character.only = TRUE)"#;
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 0);
}

#[test]
fn test_apply_no_character_only_skipped() {
    let code = r#"sapply(c("dplyr"), library)"#;
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 0);
}

#[test]
fn test_apply_character_only_false_skipped() {
    let code = r#"sapply(c("dplyr"), library, character.only = FALSE)"#;
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 0);
}

#[test]
fn test_apply_loadnamespace_fun_skipped() {
    // loadNamespace is intentionally not in the FUN allowlist.
    let code = r#"sapply(c("dplyr"), loadNamespace, character.only = TRUE)"#;
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 0);
}
```

- [ ] **Step 2: Run the tests**

```bash
cargo test -p raven --lib 'test_apply_' 2>&1 | tail -30
```

Expected: every test in this task passes (Task 4 covers all the negative paths).

- [ ] **Step 3: If any test fails, debug**

The most likely fragile cases:
- `test_apply_anonymous_fun_skipped` — confirm `\(x) library(x)` parses with the FUN argument's value being a `function_definition`, not an `identifier`. The current code ignores non-`identifier` args silently, so this should pass.
- `test_apply_var_function_param_shadow_disqualifies` — depends on `record_function_params` correctly walking `parameters > parameter > name`. If tree-sitter-r exposes parameters differently, dump the tree (`tree.root_node().to_sexp()`) and adjust field-name lookups; otherwise iterate `parameter` children and look for the first identifier child.

If a fix is needed, edit the helpers and rerun.

- [ ] **Step 4: Commit**

```bash
git add crates/raven/src/cross_file/source_detect.rs
git commit -m "test(cross-file): cover apply-family negative paths (multi-assign, dynamic, anonymous FUN, etc.)"
```

---

## Task 7: Position correctness (UTF-16 column at apply call end)

**Files:**
- Modify: `crates/raven/src/cross_file/source_detect.rs` (tests only)

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn test_apply_position_at_call_end_utf16() {
    // 🎉 is 4 UTF-8 bytes / 2 UTF-16 code units. Verify column accounting.
    let code = "🎉; sapply(c(\"dplyr\",\"tidyr\"), library, character.only = TRUE)";
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 2);
    let total_utf16 = code.encode_utf16().count() as u32;
    for call in &lib_calls {
        assert_eq!(call.line, 0);
        assert_eq!(call.column, total_utf16);
    }
}
```

- [ ] **Step 2: Run and confirm**

```bash
cargo test -p raven --lib test_apply_position_at_call_end_utf16 2>&1 | tail -10
```

Expected: pass (the helper uses `byte_offset_to_utf16_column` already).

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/cross_file/source_detect.rs
git commit -m "test(cross-file): verify UTF-16 end-of-call position for apply detection"
```

---

## Task 8: Issue #172 acceptance test (end-to-end via metadata)

**Files:**
- Modify: `crates/raven/src/cross_file/source_detect.rs` (tests only)

- [ ] **Step 1: Write the test from the issue**

```rust
#[test]
fn test_apply_issue_172_exact_example() {
    // Issue #172: this exact pattern should produce LibraryCalls so
    // downstream package-export plumbing turns the underlines off.
    let code = "libs <- c(\"lib1\", \"lib2\", \"lib3\")\nsapply(libs, require, character.only = TRUE)";
    let tree = parse_r(code);
    let lib_calls = detect_library_calls(&tree, code);
    assert_eq!(lib_calls.len(), 3);
    assert_eq!(lib_calls[0].package, "lib1");
    assert_eq!(lib_calls[1].package, "lib2");
    assert_eq!(lib_calls[2].package, "lib3");
    // Order is the c() literal order — apply call is on line 1.
    for call in &lib_calls {
        assert_eq!(call.line, 1);
    }
}
```

- [ ] **Step 2: Verify metadata pipeline picks them up**

Add a sibling test that goes through the public `extract_metadata` path so we know the wiring all the way up to the consumer is correct:

```rust
#[test]
fn test_apply_issue_172_via_extract_metadata() {
    let code = "libs <- c(\"lib1\", \"lib2\", \"lib3\")\nsapply(libs, require, character.only = TRUE)";
    let meta = crate::cross_file::extract_metadata(code);
    let pkgs: Vec<&str> = meta.library_calls.iter().map(|c| c.package.as_str()).collect();
    assert_eq!(pkgs, vec!["lib1", "lib2", "lib3"]);
}
```

(This test goes in the same module — `extract_metadata` is `pub` and re-exports work because `source_detect`'s test module already references the parent crate via `super::*`. If the import path needs adjusting, use `crate::cross_file::extract_metadata` as shown.)

- [ ] **Step 3: Run**

```bash
cargo test -p raven --lib 'test_apply_issue_172' 2>&1 | tail -15
```

Expected: both tests pass.

- [ ] **Step 4: Commit**

```bash
git add crates/raven/src/cross_file/source_detect.rs
git commit -m "test(cross-file): regression coverage for issue #172"
```

---

## Task 9: Update user-facing documentation

**Files:**
- Modify: `docs/cross-file.md` — extend the Supported Call Patterns table and add a short paragraph

- [ ] **Step 1: Edit the docs**

In `docs/cross-file.md`, extend the "Supported Call Patterns" table (currently around line 100). After the existing rows add:

```markdown
| `sapply(c("a","b"), library, character.only = TRUE)` | Yes (apply family) |
| `sapply(libs, library, character.only = TRUE)` where `libs <- c("a","b")` | Yes (same-file variable) |
| `purrr::map(c("a","b"), library, character.only = TRUE)` | Yes (purrr family) |
| `sapply(paste0(...), library, character.only = TRUE)` | No (dynamic vector) |
```

Then add a short subsection right after the table, before "Keeping Packages in Sync":

```markdown
### Apply-Family Loads

Raven also recognises package loads expressed through apply-family calls when
all the package names are statically determinable:

```r
libs <- c("dplyr", "tidyr")
sapply(libs, require, character.only = TRUE)
```

This works for `sapply`, `lapply`, `vapply`, `mapply`, and the purrr forms
(`map`, `walk`, `map_chr`, etc., bare or `purrr::`-qualified). The package
vector must be either an inline `c("a","b",...)` of string literals or a
same-file variable assigned exactly once via `<-`, `=`, or `assign()` to such a
literal vector. `character.only = TRUE` must be present (without it, R itself
would not load the strings as packages). Dynamic constructions such as
`paste0(...)`, `tolower(x)`, `c(libs1, libs2)`, or values defined in another
file are silently ignored.
```

(Note: the inner code fence in the second markdown block uses the same triple-backtick depth as the other code fences in the file — re-check that it's not nested inside another fence.)

- [ ] **Step 2: Lint check**

```bash
# Check the file still passes any existing markdown lint by eyeballing it
# alongside neighbouring rows. The project uses MD040 (language tags on
# fences) — make sure the new fence is `r`.
cat docs/cross-file.md | head -125 | tail -40
```

- [ ] **Step 3: Commit**

```bash
git add docs/cross-file.md
git commit -m "docs(cross-file): document apply-family library detection (#172)"
```

---

## Task 10: Final verification and feature commit

**Files:** none

- [ ] **Step 1: Full test suite**

```bash
cargo test -p raven 2>&1 | tail -30
```

Expected: all green. Pay attention to existing library tests and property tests in `cross_file::source_detect`.

- [ ] **Step 2: Build**

```bash
cargo build -p raven 2>&1 | tail -10
```

Expected: clean build, no warnings introduced (or only ones already present pre-change).

- [ ] **Step 3: Confirm no clippy regression on changed files**

```bash
cargo clippy -p raven --lib --no-deps -- -D warnings 2>&1 | tail -30
```

Expected: clean, or only pre-existing warnings — do not introduce new ones in `source_detect.rs`.

- [ ] **Step 4: Stop. Hand off to verification skill**

Use `superpowers:verification-before-completion` before claiming done. Confirm:
- All cargo commands above produced expected output
- The new tests cover every bullet under "Behaviour spec"
- Issue #172's exact pattern produces three `LibraryCall` entries

If anything is off, fix and re-run instead of declaring success.

---

## Self-review checklist

- **Spec coverage:** every bullet under "Behaviour spec" is exercised by a test in Tasks 1–8. The "function arg origin → skip" case is covered by `test_apply_var_function_param_shadow_disqualifies`. The "anything dynamic" case is covered by the dynamic-X tests in Task 6.
- **Placeholder scan:** none.
- **Type/name consistency:** `VarBinding`, `collect_var_bindings`, `try_parse_apply_library_call`, `is_apply_family_function`, `extract_c_strings_strict` are referenced consistently in every task. `LibraryCall`'s public shape is unchanged.
- **Downstream impact:** none — `LibraryCall`'s consumers in `mod.rs::extract_metadata`, `scope.rs::compute_artifacts*`, and `backend.rs::extract_loaded_packages_from_library_calls` already iterate the vector and tolerate multiple entries at the same `(line, column)`.
