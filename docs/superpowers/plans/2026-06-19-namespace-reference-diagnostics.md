# Namespace Reference Warming and Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pkg::member` namespace references first-class cross-file metadata, use them to warm the package cache, extend `package-not-installed` to them, and add a new exports-authoritative `namespace-member-not-found` diagnostic.

**Architecture:** Phase 1 adds a tree-sitter scanner that records `NamespaceReference`s into `CrossFileMetadata`, feeds their package names into the existing warm-set builders through one shared helper, and extends the missing-package collector. Phase 2 adds an exports-completeness signal to `PackageInfo`, a synchronous `namespace_member_status_sync` authority (data objects are positive-only; absence only from a complete exports set), the new diagnostic + its severity setting, cross-document force-republish, and the VS Code settings wiring.

**Tech Stack:** Rust (tower-lsp, tree-sitter-r, serde, ArcSwap), TypeScript (VS Code extension), Bun tests, Mocha/`vscode-test`.

**Spec:** `docs/superpowers/specs/2026-06-19-namespace-reference-diagnostics-design.md`. Follow-up (option 3, `::`-accurate data-member authority): GitHub issue #505.

**CI gates (keep green before every commit):**
- `cargo fmt --all`
- `cargo clippy --workspace --all-targets --features test-support -- -D warnings`
- `cargo test -p raven <test_name>` for the task's tests.

---

## File map

**Phase 1**
- `crates/raven/src/cross_file/source_detect.rs` — new `SourceRange`, `NamespaceMember`, `NamespaceReference` types; new `detect_namespace_references`; UTF-16 range helper.
- `crates/raven/src/cross_file/types.rs` — `CrossFileMetadata.namespace_references` field + re-exports.
- `crates/raven/src/cross_file/mod.rs` — populate `namespace_references` in `extract_metadata_with_tree`.
- `crates/raven/src/namespace_completion.rs` — make `unquote_package` reusable (`pub(crate)`).
- `crates/raven/src/backend.rs` — `namespace_warm_packages` helper; wire into `did_open`, `did_change`, `collect_open_document_packages`.
- `crates/raven/src/handlers.rs` — extend `collect_missing_package_diagnostics_from_snapshot`; regression test for structural-non-reference.

**Phase 2**
- `crates/raven/src/package_library.rs` — `MemberCompleteness`/`MemberSource` enums; `PackageInfo.exports_completeness`; stamping at construction sites; monotonic `insert_package`; `namespace_member_status_sync`.
- `crates/raven/src/package_db/model.rs` — provider records stamp `Complete`.
- `crates/raven/src/diagnostic_code.rs` — `NAMESPACE_MEMBER_NOT_FOUND` constant + `SUPPRESSIBLE_ANALYZER_CODES`.
- `crates/raven/src/cross_file/config.rs` — `packages_namespace_member_severity` field.
- `crates/raven/src/backend.rs` — parse `namespaceMemberSeverity`.
- `crates/raven/src/handlers.rs` — `collect_namespace_member_diagnostics_from_snapshot` + wire into `diagnostics_from_snapshot`; cross-document force-republish in `did_change`.
- `editors/vscode/package.json`, `editors/vscode/src/initializationOptions.ts`, `editors/vscode/src/test/settings.test.ts` — settings wiring.
- `docs/diagnostics.md`, `docs/settings-reference.md` (generated), `docs/completion.md`, `docs/package-database.md`, `docs/development.md`.

---

# PHASE 1 — Detection, warming, missing-package

## Task 1: Namespace reference metadata types

**Files:**
- Modify: `crates/raven/src/cross_file/source_detect.rs` (add types near `LibraryCall`, ~line 84)

- [ ] **Step 1: Add the types**

Insert after the `LibraryCall` struct (after line 84):

```rust
/// A source range in LSP coordinates: 0-based line, **UTF-16** column.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRange {
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

/// The member (RHS) token of a `pkg::member` / `pkg:::member` reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamespaceMember {
    pub name: String,
    pub range: SourceRange,
}

/// A detected `pkg::member` / `pkg:::member` (or incomplete `pkg::`) reference.
///
/// INVARIANT: every member-diagnostic site MUST check `!internal` before using
/// `member` — `internal: true` is `:::`, which never gets member validation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamespaceReference {
    /// Package name, with any string/backtick delimiters stripped.
    pub package: String,
    /// Range of the package (LHS) token.
    pub package_range: SourceRange,
    /// Member (RHS) token; `None` for an incomplete `pkg::` with no RHS.
    pub member: Option<NamespaceMember>,
    /// `true` for `:::` (internal lookup), `false` for `::`.
    pub internal: bool,
    /// Range of the whole `pkg::member` expression.
    pub range: SourceRange,
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo build -p raven`
Expected: builds (types unused yet — that is fine, they are `pub`).

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/cross_file/source_detect.rs
git commit -m "feat(cross-file): add NamespaceReference metadata types"
```

---

## Task 2: Reuse `unquote_package` from the completion module

**Files:**
- Modify: `crates/raven/src/namespace_completion.rs:203` (change visibility)

- [ ] **Step 1: Make `unquote_package` crate-visible**

Change the signature at line 206 from `fn unquote_package` to:

```rust
pub(crate) fn unquote_package(raw: &str) -> &str {
```

(Leave the body unchanged. This is the single shared unquoting helper the spec requires, avoiding a divergent interpretation.)

- [ ] **Step 2: Verify it compiles**

Run: `cargo build -p raven`
Expected: builds.

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/namespace_completion.rs
git commit -m "refactor(completion): expose unquote_package as pub(crate) for reuse"
```

---

## Task 3: `detect_namespace_references` scanner

**Files:**
- Modify: `crates/raven/src/cross_file/source_detect.rs` (new fn + tests)
- Test: same file, `#[cfg(test)] mod tests` (~line 1655)

The scanner does its own full-tree walk (the spec accepts one extra walk; folding into `visit_node_for_library` is optional and not done here for clarity). It uses `byte_offset_to_utf16_column` (from `crate::utf16`) for column conversion, mirroring `detect_rm_calls`.

- [ ] **Step 1: Write failing tests**

Add inside `mod tests` (after the existing `parse_r` helper):

```rust
    #[test]
    fn ns_ref_basic_exported() {
        let code = "dplyr::mutate(x)\n";
        let tree = parse_r(code);
        let refs = detect_namespace_references(&tree, code);
        assert_eq!(refs.len(), 1, "got: {refs:?}");
        let r = &refs[0];
        assert_eq!(r.package, "dplyr");
        assert!(!r.internal);
        let m = r.member.as_ref().expect("member present");
        assert_eq!(m.name, "mutate");
        // package range covers "dplyr" at columns 0..5
        assert_eq!(
            (r.package_range.start_line, r.package_range.start_column, r.package_range.end_column),
            (0, 0, 5)
        );
    }

    #[test]
    fn ns_ref_internal_triple_colon() {
        let refs = detect_namespace_references(&parse_r("dplyr:::peek_mask()\n"), "dplyr:::peek_mask()\n");
        assert_eq!(refs.len(), 1);
        assert!(refs[0].internal);
        assert_eq!(refs[0].member.as_ref().unwrap().name, "peek_mask");
    }

    #[test]
    fn ns_ref_quoted_lhs_and_rhs() {
        for code in [r#""dplyr"::mutate"#, "`dplyr`::mutate", r#"dplyr::"mutate""#] {
            let src = format!("{code}\n");
            let refs = detect_namespace_references(&parse_r(&src), &src);
            assert_eq!(refs.len(), 1, "code: {code} got: {refs:?}");
            assert_eq!(refs[0].package, "dplyr", "code: {code}");
            assert_eq!(refs[0].member.as_ref().unwrap().name, "mutate", "code: {code}");
        }
    }

    #[test]
    fn ns_ref_nonsyntactic_member() {
        let src = "pkg::`non syntactic`\n";
        let refs = detect_namespace_references(&parse_r(src), src);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].member.as_ref().unwrap().name, "non syntactic");
    }

    #[test]
    fn ns_ref_incomplete_records_none_member() {
        // Incomplete `pkg::` parsed as a namespace_operator with no rhs is kept
        // for warming with member: None.
        let src = "library(dplyr)\ndplyr::\n";
        let refs = detect_namespace_references(&parse_r(src), src);
        let incomplete: Vec<_> = refs.iter().filter(|r| r.member.is_none()).collect();
        assert_eq!(incomplete.len(), 1, "got: {refs:?}");
        assert_eq!(incomplete[0].package, "dplyr");
    }

    #[test]
    fn ns_ref_ignores_invalid_lhs_and_comments() {
        // a$b::x has a non-identifier/non-string LHS -> ignored.
        // A `::` inside a comment or string is not a namespace_operator node.
        let src = "a$b::x\n# dplyr::mutate\ny <- \"tidyr::pivot\"\n";
        let refs = detect_namespace_references(&parse_r(src), src);
        assert!(refs.is_empty(), "got: {refs:?}");
    }

    #[test]
    fn ns_ref_utf16_columns() {
        // 🎉 is 2 UTF-16 units; pkg starts at column 2.
        let src = "🎉; dplyr::mutate\n";
        let refs = detect_namespace_references(&parse_r(src), src);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].package_range.start_column, 4); // 2 (emoji) + 2 ("; ")
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p raven ns_ref_ 2>&1 | tail -20`
Expected: FAIL — `cannot find function detect_namespace_references`.

- [ ] **Step 3: Implement the scanner**

Add near `detect_library_calls` (after line 856). Note the `use crate::utf16::byte_offset_to_utf16_column;` may already be present at module top; if not, add it.

```rust
/// Detect `pkg::member` / `pkg:::member` references (and incomplete `pkg::`
/// forms that parse as a `namespace_operator` with no RHS) across the document.
///
/// Canonical source for live LSP namespace metadata. Ranges are LSP UTF-16
/// coordinates. Reuses `namespace_completion::unquote_package` for delimiter
/// stripping (delimiter-strip only, not full R literal unescaping).
pub fn detect_namespace_references(tree: &Tree, content: &str) -> Vec<NamespaceReference> {
    let lines: Vec<&str> = content.lines().collect();
    let mut out = Vec::new();
    visit_node_for_namespace(tree.root_node(), content, &lines, &mut out);
    out.sort_by_key(|r| (r.range.start_line, r.range.start_column));
    out
}

fn visit_node_for_namespace(
    node: Node,
    content: &str,
    lines: &[&str],
    out: &mut Vec<NamespaceReference>,
) {
    if node.kind() == "namespace_operator"
        && let Some(reference) = parse_namespace_operator(node, content, lines)
    {
        out.push(reference);
    }
    let mut walk = node.walk();
    for child in node.children(&mut walk) {
        visit_node_for_namespace(child, content, lines, out);
    }
}

fn parse_namespace_operator(
    ns: Node,
    content: &str,
    lines: &[&str],
) -> Option<NamespaceReference> {
    let lhs = ns.child_by_field_name("lhs")?;
    // R accepts only an identifier or string/backtick literal as the package
    // qualifier. Anything else (`a$b::x`) is an invalid LHS — ignore it.
    if !matches!(lhs.kind(), "identifier" | "string") {
        return None;
    }
    let package = crate::namespace_completion::unquote_package(node_text_local(lhs, content));
    if package.is_empty() {
        return None;
    }

    // The operator (`::`/`:::`) is the unnamed child whose text is colons.
    let mut walk = ns.walk();
    let op = ns
        .children(&mut walk)
        .find(|c| matches!(node_text_local(*c, content), "::" | ":::"))?;
    let internal = node_text_local(op, content) == ":::";

    let member = ns.child_by_field_name("rhs").and_then(|rhs| {
        if !matches!(rhs.kind(), "identifier" | "string") {
            return None;
        }
        let name = crate::namespace_completion::unquote_package(node_text_local(rhs, content));
        if name.is_empty() {
            return None;
        }
        Some(NamespaceMember {
            name: name.to_string(),
            range: node_range_utf16(rhs, lines),
        })
    });

    Some(NamespaceReference {
        package: package.to_string(),
        package_range: node_range_utf16(lhs, lines),
        member,
        internal,
        range: node_range_utf16(ns, lines),
    })
}

fn node_text_local<'a>(node: Node, content: &'a str) -> &'a str {
    &content[node.byte_range()]
}

/// Convert a node's tree-sitter byte-column range into LSP UTF-16 columns.
fn node_range_utf16(node: Node, lines: &[&str]) -> SourceRange {
    let start = node.start_position();
    let end = node.end_position();
    let col = |row: usize, byte_col: usize| -> u32 {
        let line = lines.get(row).copied().unwrap_or("");
        crate::utf16::byte_offset_to_utf16_column(line, byte_col)
    };
    SourceRange {
        start_line: start.row as u32,
        start_column: col(start.row, start.column),
        end_line: end.row as u32,
        end_column: col(end.row, end.column),
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p raven ns_ref_ 2>&1 | tail -20`
Expected: PASS (all 7).

If `ns_ref_incomplete_records_none_member` fails because tree-sitter recovers `dplyr::` as an `ERROR` node rather than a `namespace_operator`, that is the documented limitation (spec Component 1): change the test to assert `refs.iter().all(|r| r.member.is_some()) || incomplete.len() == 1` is too loose — instead delete that test and add a comment test asserting `detect_namespace_references` does not panic on `"dplyr::\n"`. Verify actual tree-sitter-r behavior first with a quick `dbg!` of node kinds before deciding.

- [ ] **Step 5: Run fmt + clippy**

Run: `cargo fmt --all && cargo clippy --workspace --all-targets --features test-support -- -D warnings 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add crates/raven/src/cross_file/source_detect.rs
git commit -m "feat(cross-file): detect pkg::member namespace references"
```

---

## Task 4: Store references in `CrossFileMetadata` and populate them

**Files:**
- Modify: `crates/raven/src/cross_file/types.rs:11` (re-export) and `:251` (field)
- Modify: `crates/raven/src/cross_file/mod.rs:197` (populate in `extract_metadata_with_tree`)
- Test: `crates/raven/src/cross_file/mod.rs` tests

- [ ] **Step 1: Add the re-export**

In `crates/raven/src/cross_file/types.rs`, extend the import at line 11:

```rust
use super::source_detect::{LibraryCall, NamespaceReference};
```

- [ ] **Step 2: Add the field**

In the `CrossFileMetadata` struct (before the closing brace at line 251, after `nse_declarations`):

```rust
    /// Detected `pkg::member` namespace references (issue #503).
    #[serde(default)]
    pub namespace_references: Vec<NamespaceReference>,
```

- [ ] **Step 3: Write a failing population test**

Add to the `#[cfg(test)] mod tests` in `crates/raven/src/cross_file/mod.rs`:

```rust
    #[test]
    fn extract_metadata_populates_namespace_references() {
        let code = "dplyr::mutate(x)\n";
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&tree_sitter_r::LANGUAGE.into()).unwrap();
        let tree = parser.parse(code, None).unwrap();
        let meta = extract_metadata_with_tree(code, Some(&tree));
        assert_eq!(meta.namespace_references.len(), 1);
        assert_eq!(meta.namespace_references[0].package, "dplyr");
    }
```

- [ ] **Step 4: Run to verify it fails**

Run: `cargo test -p raven extract_metadata_populates_namespace_references 2>&1 | tail -10`
Expected: FAIL — `namespace_references` is empty.

- [ ] **Step 5: Populate in `extract_metadata_with_tree`**

In `crates/raven/src/cross_file/mod.rs`, inside the `if let Some(tree) = tree {` block (right after the `meta.library_calls = library_calls;` line ~197):

```rust
        meta.namespace_references =
            source_detect::detect_namespace_references(tree, content);
```

- [ ] **Step 6: Run to verify it passes**

Run: `cargo test -p raven extract_metadata_populates_namespace_references 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 7: fmt + clippy + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets --features test-support -- -D warnings 2>&1 | tail -3
git add crates/raven/src/cross_file/types.rs crates/raven/src/cross_file/mod.rs
git commit -m "feat(cross-file): store namespace references in CrossFileMetadata"
```

---

## Task 5: Shared warm-set helper + `did_open` wiring

**Files:**
- Modify: `crates/raven/src/backend.rs` (helper near line 62; `did_open` ~3621)
- Test: `crates/raven/src/backend.rs` tests

- [ ] **Step 1: Write a failing helper test**

Add to backend.rs's `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn namespace_warm_packages_validates_and_dedups() {
        let mut meta = crate::cross_file::CrossFileMetadata::default();
        let mk = |pkg: &str| crate::cross_file::source_detect::NamespaceReference {
            package: pkg.to_string(),
            package_range: crate::cross_file::source_detect::SourceRange {
                start_line: 0, start_column: 0, end_line: 0, end_column: 0,
            },
            member: None,
            internal: false,
            range: crate::cross_file::source_detect::SourceRange {
                start_line: 0, start_column: 0, end_line: 0, end_column: 0,
            },
        };
        meta.namespace_references = vec![
            mk("dplyr"),
            mk("dplyr"),                                       // dup
            mk(crate::package_library::LOAD_ALL_SENTINEL),     // sentinel filtered
            mk("not a package"),                               // invalid filtered
        ];
        let pkgs = namespace_warm_packages(&meta);
        assert_eq!(pkgs, vec!["dplyr".to_string()]);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p raven namespace_warm_packages_validates_and_dedups 2>&1 | tail -10`
Expected: FAIL — function not found.

- [ ] **Step 3: Implement the helper**

Add after `extract_loaded_packages_from_library_calls` (after line 62):

```rust
/// Package names worth warming from a document's namespace references.
///
/// Validated and sentinel-filtered at this boundary (the same guard the
/// loader-call path uses) because `prefetch_packages()` trusts its callers.
/// Namespace references warm metadata only — they never attach the package to
/// bare-name scope.
fn namespace_warm_packages(meta: &crate::cross_file::CrossFileMetadata) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut packages = Vec::new();
    for r in &meta.namespace_references {
        if !is_valid_package_name(&r.package)
            || crate::package_library::is_load_all_sentinel(&r.package)
        {
            continue;
        }
        if seen.insert(r.package.clone()) {
            packages.push(r.package.clone());
        }
    }
    packages
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p raven namespace_warm_packages_validates_and_dedups 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Wire into `did_open`**

In `did_open` (~line 3621), replace:

```rust
            let packages_to_prefetch: Vec<String> = if packages_enabled {
                extract_loaded_packages_from_library_calls(&meta.library_calls)
            } else {
                Vec::new()
            };
```

with:

```rust
            let packages_to_prefetch: Vec<String> = if packages_enabled {
                let mut p = extract_loaded_packages_from_library_calls(&meta.library_calls);
                p.extend(namespace_warm_packages(&meta));
                p
            } else {
                Vec::new()
            };
```

- [ ] **Step 6: Build + commit**

```bash
cargo build -p raven && cargo fmt --all
git add crates/raven/src/backend.rs
git commit -m "feat(packages): warm namespace-reference packages on did_open"
```

---

## Task 6: `did_change` warm-set wiring

**Files:**
- Modify: `crates/raven/src/backend.rs` (`did_change` ~4513)

The `did_change` path already builds a fresh `meta` and uses `edited_document_warm_packages(&meta.library_calls, doc)`. Add namespace packages from `meta` at the call site (the helper takes `library_calls`, not `meta`, so extend after).

- [ ] **Step 1: Wire it**

In `did_change` (~line 4513) replace:

```rust
                let pkgs: Vec<String> = if packages_enabled {
                    match state.documents.get(&uri_clone) {
                        Some(doc) => edited_document_warm_packages(&meta.library_calls, doc),
                        None => extract_loaded_packages_from_library_calls(&meta.library_calls),
                    }
                } else {
                    Vec::new()
                };
```

with:

```rust
                let pkgs: Vec<String> = if packages_enabled {
                    let mut p = match state.documents.get(&uri_clone) {
                        Some(doc) => edited_document_warm_packages(&meta.library_calls, doc),
                        None => extract_loaded_packages_from_library_calls(&meta.library_calls),
                    };
                    p.extend(namespace_warm_packages(&meta));
                    p
                } else {
                    Vec::new()
                };
```

- [ ] **Step 2: Build + commit**

```bash
cargo build -p raven && cargo fmt --all
git add crates/raven/src/backend.rs
git commit -m "feat(packages): warm namespace-reference packages on did_change"
```

---

## Task 7: Open-document warmup wiring (from metadata)

**Files:**
- Modify: `crates/raven/src/backend.rs` (`collect_open_document_packages` ~8269)

Per the spec's shared-extractor decision, source namespace-ref packages from each open document's metadata via `WorldState::get_enriched_metadata`, not a new `Document` field.

- [ ] **Step 1: Wire it**

Replace `collect_open_document_packages` (lines 8269–8285) with:

```rust
fn collect_open_document_packages(
    state: &WorldState,
) -> (std::collections::HashSet<String>, Vec<(Url, u32)>) {
    let mut doc_pkgs = std::collections::HashSet::new();
    let mut docs = Vec::new();
    for (uri, doc) in &state.documents {
        for p in &doc.loaded_packages {
            doc_pkgs.insert(p.clone());
        }
        for p in &doc.data_packages {
            doc_pkgs.insert(p.clone());
        }
        // Namespace references warm metadata but never attach scope; pull them
        // from the document's enriched metadata (the shared source of truth).
        if let Some(meta) = state.get_enriched_metadata(uri) {
            for r in &meta.namespace_references {
                if is_valid_package_name(&r.package)
                    && !crate::package_library::is_load_all_sentinel(&r.package)
                {
                    doc_pkgs.insert(r.package.clone());
                }
            }
        }
        let line = doc.text().lines().count().saturating_sub(1) as u32;
        docs.push((uri.clone(), line));
    }
    (doc_pkgs, docs)
}
```

- [ ] **Step 2: Build + commit**

```bash
cargo build -p raven && cargo fmt --all
git add crates/raven/src/backend.rs
git commit -m "feat(packages): include namespace-reference packages in open-document warmup"
```

---

## Task 8: Extend `package-not-installed` to namespace references

**Files:**
- Modify: `crates/raven/src/handlers.rs` (`collect_missing_package_diagnostics_from_snapshot` ~5078)
- Test: `crates/raven/src/handlers.rs` tests

- [ ] **Step 1: Write a failing test**

Find an existing missing-package test in handlers.rs (search `package-not-installed` or `collect_missing_package`) and mirror its harness. Add:

```rust
    #[test]
    fn namespace_ref_reports_missing_package() {
        // Build a snapshot for "missingpkg::foo\n" with a package library that
        // has known lib_paths but no such package. Reuse the existing missing-
        // package test's snapshot builder/helper in this module.
        let snapshot = build_missing_pkg_test_snapshot("missingpkg::foo\n");
        let mut diags = Vec::new();
        collect_missing_package_diagnostics_from_snapshot(&snapshot, &mut diags, None);
        assert_eq!(diags.len(), 1, "got: {diags:?}");
        assert!(diags[0].message.contains("missingpkg"));
        // Anchored to the package token (columns 0..10), not the whole expr.
        assert_eq!(diags[0].range.start.character, 0);
        assert_eq!(diags[0].range.end.character, 10);
    }
```

> If no reusable snapshot builder exists, copy the construction from the nearest existing `collect_missing_package_diagnostics_from_snapshot` test verbatim and inline it; do not invent a helper that isn't there.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p raven namespace_ref_reports_missing_package 2>&1 | tail -15`
Expected: FAIL — only `library_calls` are checked, so 0 diagnostics.

- [ ] **Step 3: Add the namespace-reference loop**

In `collect_missing_package_diagnostics_from_snapshot`, after the existing `for lib_call in &snapshot.directive_meta.library_calls { ... }` loop, add:

```rust
    for ns_ref in &snapshot.directive_meta.namespace_references {
        // Both `::` and `:::` qualify for the missing-package diagnostic.
        if snapshot.package_library.package_exists(&ns_ref.package) {
            continue;
        }
        let line = ns_ref.package_range.start_line;
        if crate::cross_file::directive::is_line_ignored_for_code(
            &snapshot.directive_meta,
            line,
            Some(crate::diagnostic_code::PACKAGE_NOT_INSTALLED),
        ) {
            if let Some(out) = suppressed_out.as_deref_mut() {
                out.push((line, crate::diagnostic_code::PACKAGE_NOT_INSTALLED.to_string()));
            }
            continue;
        }
        diagnostics.push(Diagnostic {
            range: Range {
                start: Position::new(line, ns_ref.package_range.start_column),
                end: Position::new(ns_ref.package_range.end_line, ns_ref.package_range.end_column),
            },
            severity: Some(severity),
            message: format!("Package '{}' is not installed", ns_ref.package),
            code: Some(NumberOrString::String(
                crate::diagnostic_code::PACKAGE_NOT_INSTALLED.to_string(),
            )),
            ..Default::default()
        });
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p raven namespace_ref_reports_missing_package 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: fmt + clippy + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets --features test-support -- -D warnings 2>&1 | tail -3
git add crates/raven/src/handlers.rs
git commit -m "feat(diagnostics): report package-not-installed for namespace references"
```

---

## Task 9: Regression test — namespace operators stay structural non-references

`is_structural_non_reference` already returns `true` for both sides of a `namespace_operator` (handlers.rs:6759). This task only locks that behavior so the new metadata work cannot regress undefined-variable/out-of-scope handling.

**Files:**
- Test: `crates/raven/src/handlers.rs` tests

- [ ] **Step 1: Add the regression test**

Mirror the existing `check_predicate` helper used by `test_is_structural_non_reference_namespace_operator_both_sides` (search for it; ~line 56691):

```rust
    #[test]
    fn namespace_operator_sides_remain_structural_after_metadata() {
        check_predicate("dplyr::filter(df)\n", "dplyr", 0, true);
        check_predicate("dplyr::filter(df)\n", "filter", 0, true);
        check_predicate("dplyr:::peek(df)\n", "dplyr", 0, true);
        check_predicate("dplyr:::peek(df)\n", "peek", 0, true);
    }
```

- [ ] **Step 2: Run to verify it passes (no production change needed)**

Run: `cargo test -p raven namespace_operator_sides_remain_structural 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/handlers.rs
git commit -m "test(diagnostics): lock namespace operators as structural non-references"
```

**Phase 1 gate:** run `cargo test -p raven` (full) and confirm green before starting Phase 2.

---

# PHASE 2 — Member authority and diagnostic

## Task 10: Exports completeness on `PackageInfo`

**Files:**
- Modify: `crates/raven/src/package_library.rs` (enums + field + constructors ~148)
- Test: `crates/raven/src/package_library.rs` tests

- [ ] **Step 1: Write a failing test**

Add to package_library.rs `mod tests`:

```rust
    #[test]
    fn package_info_defaults_exports_completeness_unknown() {
        let info = PackageInfo::new("p".to_string(), HashSet::new());
        assert_eq!(info.exports_completeness, MemberCompleteness::Unknown);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p raven package_info_defaults_exports_completeness_unknown 2>&1 | tail -10`
Expected: FAIL — no such field/type.

- [ ] **Step 3: Add the enums and field**

Add near the top of package_library.rs (after the existing `use`s):

```rust
/// How complete a package's exported-member set is, for absence diagnostics.
/// `Absent` may be concluded only from a `Complete` set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MemberCompleteness {
    Complete,
    Partial,
    #[default]
    Unknown,
}
```

> The spec also sketches a `MemberSource` provenance enum "for debugging". It is
> deliberately omitted here (YAGNI — no task consumes it and an unused enum is
> dead weight). Add it later only if a concrete debugging need arises.

Add the field to `PackageInfo` (after `data_aliases`):

```rust
    /// Completeness of `exports` for member-absence diagnostics. Defaults to
    /// `Unknown` (never absence-authoritative) via every constructor; production
    /// load paths stamp the real value. See `namespace_member_status_sync`.
    pub exports_completeness: MemberCompleteness,
```

In **both** `PackageInfo::new` and `PackageInfo::with_details`, add to the struct literal:

```rust
            exports_completeness: MemberCompleteness::Unknown,
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p raven package_info_defaults_exports_completeness_unknown 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: fmt + clippy (catches any struct-literal site missing the field) + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets --features test-support -- -D warnings 2>&1 | tail -10
git add crates/raven/src/package_library.rs
git commit -m "feat(packages): add exports completeness to PackageInfo"
```

> If clippy/build reports other `PackageInfo { .. }` literals missing the field, add `exports_completeness: MemberCompleteness::Unknown` to each (search `PackageInfo {`). Constructors via `new`/`with_details` are already covered.

---

## Task 11: Stamp exports completeness at installed-package load paths

**Files:**
- Modify: `crates/raven/src/package_library.rs` (construction sites)
- Test: `crates/raven/src/package_library.rs` tests

The on-disk loads route through `package_info_from_dir`. Stamp completeness based on the source: static parse without `exportPattern`/`exportClassPattern` → `Complete`; R-subprocess expansion → `Complete`; INDEX fallback → `Partial`; failed/empty → `Unknown`.

- [ ] **Step 1: Stamp the static branch**

At the static branch (~1268), after constructing `info`:

```rust
        info.exports_completeness = if parse_result.has_pattern {
            MemberCompleteness::Partial
        } else {
            MemberCompleteness::Complete
        };
```

> Verify the field name on `parse_result` that signals an export pattern (the disk parse returns a `has_pattern`-style flag; `get_exports_sync` destructures `(exports, _has_pattern)`). Use the actual field. If a static parse with a pattern reaches this branch, exports are not fully enumerable from disk → `Partial`.

- [ ] **Step 2: Stamp the pattern/R branch**

At the pattern/R branch (~1300), the exports came from R's `getNamespaceExports`. After building `info`:

```rust
        info.exports_completeness = MemberCompleteness::Complete;
```

For the `None` directory + empty set fallback in that branch, leave whatever the provider stamped (Task 12) or `Unknown`.

- [ ] **Step 3: Stamp the INDEX-fallback branch**

At the INDEX-fallback branch (~1088), after building `info`:

```rust
        info.exports_completeness = MemberCompleteness::Partial;
```

- [ ] **Step 4: Stamp the base-init exports loop**

At base init (~1816/1830), the per-package exports come from the base-package enumeration (authoritative). After each `with_details`, set:

```rust
        // Base-package exports are enumerated authoritatively at init.
        let mut info = info;
        info.exports_completeness = MemberCompleteness::Complete;
```

> Apply to the per-package-exports `with_details` (Step 5 in init). Base-package datasets are merged into `base_exports` separately; the member authority consults `base_exports` (Task 13).

- [ ] **Step 5: Write a test for completeness stamping**

Add a test that builds a package library against a temp lib dir containing a package with a static NAMESPACE (no pattern) and asserts `get_package(...).exports_completeness == Complete`. Mirror the existing temp-dir package construction used in package_library.rs tests (search `tempfile::tempdir` in that test module).

```rust
    #[tokio::test]
    async fn static_namespace_exports_are_complete() {
        let dir = tempfile::tempdir().unwrap();
        let pkg = dir.path().join("mypkg");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("DESCRIPTION"), "Package: mypkg\nVersion: 1.0\n").unwrap();
        std::fs::write(pkg.join("NAMESPACE"), "export(foo)\nexport(bar)\n").unwrap();
        let lib = build_package_library_tier1_only(None, &[dir.path().to_path_buf()], None).await;
        let info = lib.library.get_package("mypkg").await.expect("loads");
        assert_eq!(info.exports_completeness, MemberCompleteness::Complete);
    }
```

> Use the actual tier-1 builder name observed in the test module (`build_package_library_tier1_only` appears in existing tests). Adjust the lib-path argument shape to match its signature.

- [ ] **Step 6: Run + fmt + clippy + commit**

```bash
cargo test -p raven static_namespace_exports_are_complete 2>&1 | tail -10
cargo fmt --all && cargo clippy --workspace --all-targets --features test-support -- -D warnings 2>&1 | tail -3
git add crates/raven/src/package_library.rs
git commit -m "feat(packages): stamp exports completeness at load paths"
```

---

## Task 12: Provider records are export-complete

**Files:**
- Modify: `crates/raven/src/package_db/model.rs:90` (`into_info`)
- Test: `crates/raven/src/package_db/model.rs` tests

Provider records (Tier 2/3, embedded base) carry a full export list, so `into_info` must stamp `Complete` — otherwise all provider-derived member diagnostics silently never fire.

- [ ] **Step 1: Write a failing test**

Add to model.rs tests:

```rust
    #[test]
    fn record_into_info_is_export_complete() {
        let rec = PackageRecord {
            name: "p".into(),
            version: "1.0".into(),
            exports: vec!["a".into(), "b".into()],
            depends: vec![],
            lazy_data: vec![],
        };
        let info = rec.into_info();
        assert_eq!(
            info.exports_completeness,
            crate::package_library::MemberCompleteness::Complete
        );
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p raven record_into_info_is_export_complete 2>&1 | tail -10`
Expected: FAIL — defaults to `Unknown`.

- [ ] **Step 3: Stamp in `into_info`**

In `into_info`, after building via `with_details`, set the field before returning:

```rust
    pub fn into_info(self) -> PackageInfo {
        let mut info = PackageInfo::with_details(
            self.name,
            self.exports.into_iter().collect::<HashSet<String>>(),
            self.depends,
            self.lazy_data,
        );
        // Provider records carry a full export list for the captured version.
        info.exports_completeness = crate::package_library::MemberCompleteness::Complete;
        info
    }
```

- [ ] **Step 4: Run + commit**

```bash
cargo test -p raven record_into_info_is_export_complete 2>&1 | tail -10
cargo fmt --all
git add crates/raven/src/package_db/model.rs
git commit -m "feat(packages): provider records stamp Complete exports completeness"
```

---

## Task 13: `namespace_member_status_sync` + monotonic cache authority

**Files:**
- Modify: `crates/raven/src/package_library.rs` (new API + `insert_package` guard)
- Test: `crates/raven/src/package_library.rs` tests

- [ ] **Step 1: Write failing tests**

```rust
    #[tokio::test]
    async fn member_status_present_absent_partial() {
        let dir = tempfile::tempdir().unwrap();
        let pkg = dir.path().join("mypkg");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("DESCRIPTION"), "Package: mypkg\nVersion: 1.0\n").unwrap();
        std::fs::write(pkg.join("NAMESPACE"), "export(foo)\n").unwrap();
        let lib = build_package_library_tier1_only(None, &[dir.path().to_path_buf()], None)
            .await
            .library;
        lib.get_package("mypkg").await; // warm

        assert_eq!(lib.namespace_member_status_sync("mypkg", "foo"), NamespaceMemberStatus::Present);
        assert_eq!(lib.namespace_member_status_sync("mypkg", "nope"), NamespaceMemberStatus::Absent);
        // Never-loaded package: Unknown, never Absent.
        assert_eq!(lib.namespace_member_status_sync("ghost", "x"), NamespaceMemberStatus::Unknown);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p raven member_status_present_absent_partial 2>&1 | tail -15`
Expected: FAIL — type/function not found.

- [ ] **Step 3: Add the status enum and API**

Add the enum near `MemberCompleteness`:

```rust
/// Result of a synchronous `pkg::member` membership query.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NamespaceMemberStatus {
    Present,
    Absent,
    Partial,
    Unknown,
}
```

Add the method to `impl PackageLibrary`:

```rust
    /// Synchronous, cache/provider/static-only `pkg::member` authority. Never
    /// spawns R and never mutates the cache. `Absent` only from a `Complete`
    /// exports set. Data objects (`lazy_data`, base exports) are positive-only:
    /// they confirm-present but never prove absent (issue #505 tightens this).
    pub fn namespace_member_status_sync(
        &self,
        package: &str,
        member: &str,
    ) -> NamespaceMemberStatus {
        if is_load_all_sentinel(package) {
            return NamespaceMemberStatus::Unknown;
        }
        // Base-package datasets/exports are merged into base_exports, not the
        // per-package lazy_data — positive-only present check (C1 fix).
        if self.is_base_package(package) && self.is_base_export(member) {
            return NamespaceMemberStatus::Present;
        }

        // Resolve the best available exports set + completeness without R/mutation.
        // Tier 1: cache snapshot (already-stamped completeness).
        if let Some(info) = self.packages.load().get(package) {
            if info.exports.contains(member) || info.lazy_data.contains(member) {
                return NamespaceMemberStatus::Present;
            }
            match info.exports_completeness {
                MemberCompleteness::Complete => return NamespaceMemberStatus::Absent,
                MemberCompleteness::Partial => return NamespaceMemberStatus::Partial,
                MemberCompleteness::Unknown => {} // fall through to other sources
            }
        }

        // Tier 2: installed on disk — static NAMESPACE parse (no R).
        if let Some(pkg_dir) = self.find_package_directory(package) {
            let (exports, has_pattern) = crate::namespace_parser::parse_namespace_explicit_exports(
                &pkg_dir.join("NAMESPACE"),
            );
            if exports.iter().any(|e| e == member) {
                return NamespaceMemberStatus::Present;
            }
            return if has_pattern {
                NamespaceMemberStatus::Partial
            } else {
                NamespaceMemberStatus::Absent
            };
        }

        // Tier 3: providers (Complete export lists).
        if let Some(info) = self.resolve_from_providers(package) {
            if info.exports.contains(member) || info.lazy_data.contains(member) {
                return NamespaceMemberStatus::Present;
            }
            return match info.exports_completeness {
                MemberCompleteness::Complete => NamespaceMemberStatus::Absent,
                MemberCompleteness::Partial => NamespaceMemberStatus::Partial,
                MemberCompleteness::Unknown => NamespaceMemberStatus::Unknown,
            };
        }

        NamespaceMemberStatus::Unknown
    }
```

> Confirm `parse_namespace_explicit_exports` returns `(exports, has_pattern)` (it does — `get_exports_sync` destructures it) and the exports element type (use `.iter().any(|e| e == member)` to be type-agnostic).

- [ ] **Step 4: Add the monotonic-authority guard to `insert_package`**

Find `insert_package` (the single cache-write chokepoint). Before publishing the new entry, if an existing cached entry has `exports_completeness == Complete` and the incoming one is weaker (`Partial`/`Unknown`) with a non-superset exports set, do not downgrade the exports/completeness. Add a focused guard:

```rust
        // Monotonic member authority: never let a weaker entry shadow a Complete
        // exports set. Allow upgrades (Unknown/Partial -> Complete) and equal-or-
        // stronger replacements.
        if incoming.exports_completeness != MemberCompleteness::Complete
            && let Some(existing) = self.packages.load().get(&incoming.name)
            && existing.exports_completeness == MemberCompleteness::Complete
        {
            // Keep the stronger existing exports + completeness; merge any new
            // lazy_data/data_aliases the incoming entry adds.
            // (Implement by copying existing.exports + completeness into `incoming`
            // before the COW publish.)
        }
```

> Read `insert_package`'s actual body and adapt: the goal is that after insert, a previously-`Complete` package's exports/completeness are never replaced by a `Partial`/`Unknown` set. Write a test (Step 5) that proves it, then implement the minimal merge that passes it.

- [ ] **Step 5: Write the monotonic test**

```rust
    #[tokio::test]
    async fn complete_exports_not_downgraded_by_partial() {
        // Construct a library, insert a Complete entry, then insert a Partial
        // entry for the same package, and assert the cached completeness stays
        // Complete and the member remains Absent (not Unknown).
        // Use the test-only insert path / builder available in this module.
    }
```

> Implement using whatever test-visible insert path exists (e.g. a `#[cfg(test)]` helper or `insert_package` if reachable). If no test-visible insert exists, drive it through two `get_package` calls against changing on-disk state, or add a small `#[cfg(test)]` accessor. Keep the assertion: completeness stays `Complete`.

- [ ] **Step 6: Run + fmt + clippy + commit**

```bash
cargo test -p raven member_status 2>&1 | tail -15
cargo test -p raven complete_exports_not_downgraded_by_partial 2>&1 | tail -10
cargo fmt --all && cargo clippy --workspace --all-targets --features test-support -- -D warnings 2>&1 | tail -3
git add crates/raven/src/package_library.rs
git commit -m "feat(packages): add namespace_member_status_sync with monotonic authority"
```

---

## Task 14: `namespaceMemberSeverity` config (Rust)

**Files:**
- Modify: `crates/raven/src/cross_file/config.rs:101` (field)
- Modify: `crates/raven/src/backend.rs:421` (parse)
- Test: `crates/raven/src/backend.rs` tests

- [ ] **Step 1: Add the config field**

After `packages_missing_package_severity` in `CrossFileConfig` (config.rs:101):

```rust
    pub packages_namespace_member_severity: Option<DiagnosticSeverity>,
```

> If `CrossFileConfig` has a manual `Default` impl, add `packages_namespace_member_severity: Some(DiagnosticSeverity::WARNING)` there (default `warning` per spec). If it derives `Default`, set the default in the parse path instead and document it. Check which it is.

- [ ] **Step 2: Write a failing parse test**

Mirror the existing severity-parse test in backend.rs (search `missingPackageSeverity` in tests):

```rust
    #[test]
    fn parses_namespace_member_severity() {
        let json = serde_json::json!({ "packages": { "namespaceMemberSeverity": "error" } });
        let mut config = CrossFileConfig::default();
        apply_init_options(&mut config, &json); // use the real config-apply entry point
        assert_eq!(
            config.packages_namespace_member_severity,
            Some(DiagnosticSeverity::ERROR)
        );
    }
```

> Replace `apply_init_options` with the actual function that contains the `missingPackageSeverity` parse block (backend.rs ~417). Match its signature.

- [ ] **Step 3: Run to verify it fails**

Run: `cargo test -p raven parses_namespace_member_severity 2>&1 | tail -10`
Expected: FAIL.

- [ ] **Step 4: Add the parse block**

After the `missingPackageSeverity` block (backend.rs ~421):

```rust
        if let Some(sev) = packages
            .get("namespaceMemberSeverity")
            .and_then(|v| v.as_str())
        {
            config.packages_namespace_member_severity = parse_severity(sev);
        }
```

- [ ] **Step 5: Run + commit**

```bash
cargo test -p raven parses_namespace_member_severity 2>&1 | tail -10
cargo fmt --all
git add crates/raven/src/cross_file/config.rs crates/raven/src/backend.rs
git commit -m "feat(config): parse packages.namespaceMemberSeverity"
```

---

## Task 15: Diagnostic code registration

**Files:**
- Modify: `crates/raven/src/diagnostic_code.rs:41` (constant) and `:74` (suppressible list)

- [ ] **Step 1: Add the constant**

After `PACKAGE_NOT_INSTALLED` (line 41):

```rust
pub const NAMESPACE_MEMBER_NOT_FOUND: &str = "namespace-member-not-found";
```

- [ ] **Step 2: Add to the suppressible list**

In `SUPPRESSIBLE_ANALYZER_CODES` (line 74):

```rust
pub const SUPPRESSIBLE_ANALYZER_CODES: &[&str] = &[
    UNDEFINED_VARIABLE,
    ASSIGN_TO_STRING_LITERAL,
    PACKAGE_NOT_INSTALLED,
    NAMESPACE_MEMBER_NOT_FOUND,
];
```

- [ ] **Step 3: Build + commit**

```bash
cargo build -p raven && cargo fmt --all
git add crates/raven/src/diagnostic_code.rs
git commit -m "feat(diagnostics): register namespace-member-not-found code"
```

---

## Task 16: `namespace-member-not-found` collector + wiring

**Files:**
- Modify: `crates/raven/src/handlers.rs` (new collector + call in `diagnostics_from_snapshot` ~640)
- Test: `crates/raven/src/handlers.rs` tests

- [ ] **Step 1: Write failing tests**

```rust
    #[test]
    fn member_diag_absent_complete_reports() {
        // Snapshot for "mypkg::nope\n" with mypkg loaded, exports {foo}, Complete.
        let snapshot = build_member_test_snapshot("mypkg::nope\n", &["foo"], MemberCompleteness::Complete);
        let mut diags = Vec::new();
        collect_namespace_member_diagnostics_from_snapshot(&snapshot, &mut diags, None);
        assert_eq!(diags.len(), 1, "got: {diags:?}");
        assert!(diags[0].message.contains("nope"));
        assert_eq!(diags[0].code, Some(NumberOrString::String(
            crate::diagnostic_code::NAMESPACE_MEMBER_NOT_FOUND.to_string())));
    }

    #[test]
    fn member_diag_present_export_silent() {
        let snapshot = build_member_test_snapshot("mypkg::foo\n", &["foo"], MemberCompleteness::Complete);
        let mut diags = Vec::new();
        collect_namespace_member_diagnostics_from_snapshot(&snapshot, &mut diags, None);
        assert!(diags.is_empty(), "got: {diags:?}");
    }

    #[test]
    fn member_diag_partial_silent() {
        let snapshot = build_member_test_snapshot("mypkg::nope\n", &["foo"], MemberCompleteness::Partial);
        let mut diags = Vec::new();
        collect_namespace_member_diagnostics_from_snapshot(&snapshot, &mut diags, None);
        assert!(diags.is_empty(), "got: {diags:?}");
    }

    #[test]
    fn member_diag_internal_never_reports() {
        let snapshot = build_member_test_snapshot("mypkg:::nope\n", &["foo"], MemberCompleteness::Complete);
        let mut diags = Vec::new();
        collect_namespace_member_diagnostics_from_snapshot(&snapshot, &mut diags, None);
        assert!(diags.is_empty(), "got: {diags:?}");
    }
```

> Write `build_member_test_snapshot` in the test module: it builds a `PackageLibrary` with one package whose `exports` and `exports_completeness` are set (use a `#[cfg(test)]` insert helper or the temp-dir NAMESPACE approach from Task 13), extracts metadata for the source text, and assembles a `DiagnosticsSnapshot` the same way the existing missing-package collector tests do. Reuse the missing-package test harness as the template.

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p raven member_diag_ 2>&1 | tail -20`
Expected: FAIL — collector not found.

- [ ] **Step 3: Implement the collector**

Add near `collect_missing_package_diagnostics_from_snapshot`:

```rust
fn collect_namespace_member_diagnostics_from_snapshot(
    snapshot: &DiagnosticsSnapshot,
    diagnostics: &mut Vec<Diagnostic>,
    mut suppressed_out: Option<&mut Vec<(u32, String)>>,
) {
    if !snapshot.cross_file_config.packages_enabled {
        return;
    }
    if !snapshot.package_library_ready {
        return;
    }
    let Some(severity) = snapshot.cross_file_config.packages_namespace_member_severity else {
        return;
    };

    for ns_ref in &snapshot.directive_meta.namespace_references {
        if ns_ref.internal {
            continue; // never validate `:::`
        }
        let Some(member) = &ns_ref.member else {
            continue;
        };
        let status = snapshot
            .package_library
            .namespace_member_status_sync(&ns_ref.package, &member.name);
        if status != crate::package_library::NamespaceMemberStatus::Absent {
            continue;
        }
        let line = member.range.start_line;
        if crate::cross_file::directive::is_line_ignored_for_code(
            &snapshot.directive_meta,
            line,
            Some(crate::diagnostic_code::NAMESPACE_MEMBER_NOT_FOUND),
        ) {
            if let Some(out) = suppressed_out.as_deref_mut() {
                out.push((line, crate::diagnostic_code::NAMESPACE_MEMBER_NOT_FOUND.to_string()));
            }
            continue;
        }
        diagnostics.push(Diagnostic {
            range: Range {
                start: Position::new(line, member.range.start_column),
                end: Position::new(member.range.end_line, member.range.end_column),
            },
            severity: Some(severity),
            message: format!(
                "Package '{}' has no known exported member or data object named '{}'",
                ns_ref.package, member.name
            ),
            code: Some(NumberOrString::String(
                crate::diagnostic_code::NAMESPACE_MEMBER_NOT_FOUND.to_string(),
            )),
            ..Default::default()
        });
    }
}
```

- [ ] **Step 4: Wire into `diagnostics_from_snapshot`**

After the `collect_missing_package_diagnostics_from_snapshot(...)` call (~line 640), add:

```rust
    collect_namespace_member_diagnostics_from_snapshot(
        snapshot,
        &mut diagnostics,
        if track_unused {
            Some(&mut suppressed_pairs)
        } else {
            None
        },
    );
```

- [ ] **Step 5: Run to verify they pass**

Run: `cargo test -p raven member_diag_ 2>&1 | tail -20`
Expected: PASS (all 4).

- [ ] **Step 6: fmt + clippy + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets --features test-support -- -D warnings 2>&1 | tail -3
git add crates/raven/src/handlers.rs
git commit -m "feat(diagnostics): add namespace-member-not-found diagnostic"
```

---

## Task 17: Cross-document force-republish on namespace prefetch

**Files:**
- Modify: `crates/raven/src/backend.rs` (`did_change` background prefetch ~4513–4773)

After a `did_change` background prefetch that includes namespace-reference packages, warming `pkg` can change member/missing diagnostics in *other* open documents referencing `pkg::`. Mark those documents for force-republish too.

- [ ] **Step 1: Write/extend a test**

Add an integration-style test (mirror existing `did_change` force-republish tests; search `mark_force_republish` in backend tests) asserting: open doc B uses `pkg::x`; editing doc A that first warms `pkg` results in doc B being marked for force-republish. If the existing test harness cannot easily assert the gate state, assert at the unit level that the new helper returns doc B's URI.

> Implement the smallest helper that is unit-testable: `fn open_docs_referencing_packages(state, warmed: &HashSet<String>) -> Vec<Url>` that scans each open doc's enriched metadata `namespace_references` for an intersection with `warmed`. Test that directly.

- [ ] **Step 2: Implement the helper**

```rust
fn open_docs_referencing_packages(
    state: &WorldState,
    warmed: &std::collections::HashSet<String>,
) -> Vec<Url> {
    let mut out = Vec::new();
    for (uri, _doc) in &state.documents {
        if let Some(meta) = state.get_enriched_metadata(uri) {
            if meta
                .namespace_references
                .iter()
                .any(|r| warmed.contains(&r.package))
            {
                out.push(uri.clone());
            }
        }
    }
    out
}
```

- [ ] **Step 3: Use it after the background prefetch**

In the `did_change` background prefetch path, after warming completes and before/with the existing `mark_force_republish_many(affected...)` call (~4771), union in the cross-document set:

```rust
            let warmed: std::collections::HashSet<String> = pkgs.iter().cloned().collect();
            let ns_dependents = open_docs_referencing_packages(&state, &warmed);
            state.diagnostics_gate.mark_force_republish_many(
                ns_dependents.iter().filter(|u| **u != uri),
            );
```

> Place this where `state` (the post-warm world-state guard) and `pkgs` are in scope. Keep it within the existing version-monotonic model — `mark_force_republish_many` is the same API the edited-file path uses.

- [ ] **Step 4: Run + fmt + clippy + commit**

```bash
cargo test -p raven open_docs_referencing_packages 2>&1 | tail -10
cargo fmt --all && cargo clippy --workspace --all-targets --features test-support -- -D warnings 2>&1 | tail -3
git add crates/raven/src/backend.rs
git commit -m "feat(packages): force-republish sibling docs after namespace prefetch"
```

---

## Task 18: VS Code settings wiring

**Files:**
- Modify: `editors/vscode/package.json` (~1264, alphabetical)
- Modify: `editors/vscode/src/initializationOptions.ts` (~86 type, ~329 extract)
- Modify: `editors/vscode/src/test/settings.test.ts` (~113 mapping, ~490 named-value test)

- [ ] **Step 1: Add the package.json schema entry**

Insert **before** `raven.packages.missingPackageSeverity` (alphabetical: `namespaceMemberSeverity` < `missingPackageSeverity`):

```json
        "raven.packages.namespaceMemberSeverity": {
          "type": "string",
          "enum": [
            "error",
            "warning",
            "information",
            "hint",
            "off"
          ],
          "enumDescriptions": [
            "Report unknown namespace members as errors",
            "Report unknown namespace members as warnings",
            "Report unknown namespace members as information",
            "Report unknown namespace members as hints",
            "Disable namespace member diagnostics"
          ],
          "default": "warning",
          "description": "Severity for diagnostics when `pkg::member` references a member that a complete package export set does not contain. Data objects are positive-only; member absence is reported only from complete metadata."
        },
```

- [ ] **Step 2: Add the type + extraction in initializationOptions.ts**

Add to the `packages` interface (near line 86):

```typescript
        namespaceMemberSeverity?: SeverityLevel;
```

Add the extraction (near line 329):

```typescript
    const namespaceMemberSeverity = getExplicitSetting<SeverityLevel>(config, 'packages.namespaceMemberSeverity');
```

Add `namespaceMemberSeverity !== undefined ||` to the `if (...)` guard that decides whether to build `options.packages`, and add the pass-through:

```typescript
        if (namespaceMemberSeverity !== undefined) {
            options.packages.namespaceMemberSeverity = namespaceMemberSeverity;
        }
```

- [ ] **Step 3: Add the settings.test.ts mapping + named-value assertion**

Add to `SETTINGS_MAPPING` (near line 113):

```typescript
    { vsCodeKey: 'packages.namespaceMemberSeverity', jsonPath: ['packages', 'namespaceMemberSeverity'], type: 'enum', enumValues: ['error', 'warning', 'information', 'hint', 'off'] as const },
```

In the `'severity settings transmit correctly'` test (near line 490), add to the configured map and assertions:

```typescript
                ['packages.namespaceMemberSeverity', severity],
```
```typescript
            assert.strictEqual(options.packages?.namespaceMemberSeverity, severity);
```

- [ ] **Step 4: Typecheck**

Run: `./editors/vscode/node_modules/.bin/tsc --project editors/vscode/tsconfig.json --noEmit 2>&1 | tail -10`
Expected: clean (no new errors).

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/package.json editors/vscode/src/initializationOptions.ts editors/vscode/src/test/settings.test.ts
git commit -m "feat(vscode): wire packages.namespaceMemberSeverity setting"
```

---

## Task 19: Docs + generated settings reference

**Files:**
- Modify: `docs/diagnostics.md` (codes table ~line 29)
- Regenerate: `docs/settings-reference.md`
- Modify: `docs/completion.md`, `docs/package-database.md`, `docs/development.md`

- [ ] **Step 1: Add the diagnostics.md row**

Insert in the codes table (alphabetical, between `assign-to-string-literal`/`package-not-installed` and `syntax-error` as fits the existing order):

```markdown
| `namespace-member-not-found` | `pkg::member` where a complete package export set has no such exported member or data object (never for `pkg:::`) | Yes |
```

Add a short prose section explaining: exports-authoritative; data objects are positive-only; absence only from complete metadata; warming-driven; setting `raven.packages.namespaceMemberSeverity` (default `warning`); option-3 follow-up is issue #505.

- [ ] **Step 2: Regenerate the settings reference**

Run: `bun editors/vscode/scripts/generate-settings-reference.mjs`
Then verify drift gate: `bun tests/bun/settings-reference.test.ts 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 3: Update completion.md / package-database.md / development.md**

- `docs/completion.md`: note that `pkg::` use now warms package metadata even without `library(pkg)`, and that `pkg:::` warms but yields no completions.
- `docs/package-database.md`: document `exports_completeness` (Complete/Partial/Unknown), the source mapping (static-no-pattern/R = Complete, INDEX = Partial, provider = Complete, failed = Unknown), and the monotonic-authority rule.
- `docs/development.md`: note `namespace_member_status_sync` is the member-diagnostic authority (not `get_exports_sync`), the sync/no-R contract, and the cross-document force-republish for namespace warming.

- [ ] **Step 4: Commit**

```bash
git add docs/diagnostics.md docs/settings-reference.md docs/completion.md docs/package-database.md docs/development.md
git commit -m "docs: document namespace member diagnostics and exports completeness"
```

---

## Final verification

- [ ] **Full test suite**

Run: `cargo test -p raven 2>&1 | tail -20`
Expected: all pass.

- [ ] **Both CI gates**

Run: `cargo fmt --all --check && cargo clippy --workspace --all-targets --features test-support -- -D warnings 2>&1 | tail -5`
Expected: no diff, zero warnings.

- [ ] **Bun gates**

Run: `bun tests/bun/settings-reference.test.ts && bun tests/bun/grammar-contribution-paths.test.ts 2>&1 | tail -5`
Expected: PASS.

- [ ] **Spec acceptance walk-through (manual sanity):** confirm each bullet in the spec's "Acceptance" section maps to a passing test:
  - `dplyr::mutate` warms `dplyr` (Task 5/6/7) ·
  - `missingpkg::foo` reports `package-not-installed` (Task 8) ·
  - `dplyr::mutatee` reports `namespace-member-not-found` with complete exports (Task 16) ·
  - partial/unknown → silent (Task 16) ·
  - `datasets::mtcars` accepted via `base_exports` (Task 13) ·
  - `dplyr:::internal` never member-reports (Task 16) ·
  - no bare-name scope leak (Task 9 + warming tests).
