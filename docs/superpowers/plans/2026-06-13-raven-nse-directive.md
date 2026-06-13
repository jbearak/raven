# `# raven: nse` Directive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `# raven: nse` directive so users can declare which function formals are non-standard-evaluation (data-masked / captured), suppressing false-positive `undefined-variable` diagnostics inside those call arguments — plus extend `# raven: func` to accept formals, and add a discoverability hint + code action.

**Architecture:** A new directive family parses into `CrossFileMetadata`. The pure NSE policy model (`crate::nse::ArgPolicy`) is reused unchanged — directive declarations are translated into `ArgPolicy` values (whole-call or per-formal) inside `NseAnalysis`, consulted at the **top** of `resolve_call_arg_policy` (authoritative user override), and **position-gated** by the call's line. Named-argument-only matching (when formal order is unknown) is expressed via the existing `per_formal_mask` by putting `"..."` first in the formals list, so no change to `nse.rs` matching is required. Discoverability is delivered as (a) an enriched diagnostic message and (b) a new `code_action` LSP provider offering a quick-fix.

**Tech Stack:** Rust (crate `crates/raven`), tree-sitter-r, tower-lsp 0.20, regex. Docs in Markdown. CI gates: `cargo fmt --all --check` and `cargo clippy --workspace --all-targets --features test-support -- -D warnings` on toolchain `1.96.0`.

---

## Design decisions (locked)

1. **Syntax.** `# raven: nse my_func` (whole-call), `# raven: nse my_func(x)`, `# raven: nse my_func(x, y)`, `# raven: nse pkg::my_func(x, y)`. Optional colon/spacing and `@lsp-nse` alias follow existing families (`# raven:nse`, `# raven: nse:`). One function per directive (v1). No square brackets (reserved for selectors).
2. **Semantics.**
   - No parens → `ArgPolicy::WholeCall` for that callee.
   - `name(x, y)` → per-formal: suppress args bound to `x`/`y` only.
   - Empty parens `name()` → **malformed**, ignored (no blanket suppression).
3. **Position-aware.** A declaration on line `L` (0-based) applies only to calls whose start line is `> L` ("from the line after the directive"). The most recent applicable declaration (largest `L < call_line`) for a given callee wins.
4. **Resolution / precedence.** The directive is an explicit user override and is consulted **first** in `resolve_call_arg_policy` (before local-definition inference). It is authoritative and standalone (does not union with inferred captures).
   - Unqualified directive (`package=None`) matches unqualified calls to that name.
   - Qualified directive (`package=Some(p)`) matches `p::name` calls, **and** unqualified `name` calls when `p` is in `in_play_packages` (mirrors package-owned policy reaching unqualified calls in scope).
5. **Formal-order sources (for positional matching), in priority:** (a) a `# raven: func name(formals…)` declaration before the call; (b) a visible local `name <- function(formals…)` definition. When neither is available, fall back to **named-only matching** (positional args are not suppressed). Installed-package positional matching is a documented limitation — the package library exposes export *names* only, not formals, in the synchronous diagnostic pass.
6. **`# raven: func` formals.** Extend the existing directive to optionally capture a parenthesized formal list, stored on `DeclaredSymbol.formals: Option<Vec<String>>`. Existing `# raven: func name` (no parens) keeps `formals: None`.
7. **Named-only via existing matcher.** Express "match by name only" as `PerFormal { formals: ["..."] ++ captured, captured, captured_dots: false }`. `per_formal_mask`'s positional pass hits `"..."` immediately (all positionals → `captured_dots=false`, i.e. checked) while named args still bind to the captured formals. No change to `nse.rs`.
8. **Diagnostic hint.** When an `undefined-variable` is reported for a bare identifier that sits inside a `call` argument whose callee is *not* a high-confidence standard-eval builtin (i.e. a plausible NSE boundary), append guidance to the message pointing at `# raven: nse`.
9. **Code action.** New `code_action` provider offering a quick-fix that inserts the directive line above the call.

---

## File structure

- **Modify** `crates/raven/src/cross_file/types.rs` — add `NseScope`, `NseDeclaration`; add `nse_declarations` to `CrossFileMetadata`; add `formals` to `DeclaredSymbol`.
- **Modify** `crates/raven/src/cross_file/directive.rs` — add `nse` regex + parse branch; extend `declare_func` regex + parse to capture formals; unit tests.
- **Modify** `crates/raven/src/handlers.rs` — `NseAnalysis` new field + `build` param + `resolve_call_arg_policy` integration + formal-order helper + diagnostic-hint enrichment + code-action support fn; unit tests.
- **Modify** `crates/raven/src/backend.rs` — advertise `code_action_provider`; implement `async fn code_action`.
- **Modify** `docs/directives.md`, `docs/diagnostics.md`, `README.md` — user docs.
- **Possibly modify** `editors/vscode/*` — only if the client needs explicit code-action enablement (vscode-languageclient auto-supports it; verify in Task 8).

---

## Task 1: Data model

**Files:**
- Modify: `crates/raven/src/cross_file/types.rs`

- [ ] **Step 1: Add the NSE declaration types** after `DeclaredSymbol` (around `types.rs:75`).

```rust
/// The argument-evaluation scope a `# raven: nse` directive declares for a
/// callee. `WholeCall` (no parentheses) means every argument is NSE; `Formals`
/// names the captured/data-masked formals.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum NseScope {
    /// `# raven: nse my_func` — suppress undefined-variable in every argument.
    WholeCall,
    /// `# raven: nse my_func(x, y)` — suppress only arguments bound to these
    /// formals. Never empty (an empty parameter list is malformed and dropped
    /// during parsing).
    Formals(Vec<String>),
}

/// A user-declared non-standard-evaluation contract from a `# raven: nse`
/// directive (`@lsp-nse` is a permanent alias that parses identically).
///
/// Position-aware: applies only to calls on a line strictly after `line`. The
/// callee is matched per the resolution model in `resolve_call_arg_policy`:
/// an unqualified declaration matches unqualified calls; a qualified
/// declaration matches `package::name` calls and unqualified `name` calls when
/// `package` is in scope.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NseDeclaration {
    /// Callee name as written (the `name` of a `package::name`, or the bare name).
    pub name: String,
    /// Package qualifier when written `package::name`, else `None`.
    pub package: Option<String>,
    /// Declared NSE scope (whole-call or named formals).
    pub scope: NseScope,
    /// 0-based line of the directive comment. Applies to calls on lines `> line`.
    pub line: u32,
}
```

- [ ] **Step 2: Add `formals` to `DeclaredSymbol`** (replace the struct at `types.rs:67-75`).

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeclaredSymbol {
    /// The symbol name (e.g., "myvar", "my.func")
    pub name: String,
    /// 0-based line number where the directive appears
    pub line: u32,
    /// true for `# raven: func`, false for `# raven: var`
    pub is_function: bool,
    /// For `# raven: func name(a, b, c)`, the declared ordered formal names.
    /// `None` when no parameter list was written (and always `None` for
    /// variables). `Some(vec)` carries the declared formal order, used as an
    /// authoritative source for NSE positional argument matching.
    #[serde(default)]
    pub formals: Option<Vec<String>>,
}
```

- [ ] **Step 3: Add `nse_declarations` to `CrossFileMetadata`** after `declared_functions` (around `types.rs:179`).

```rust
    /// NSE contracts declared via `# raven: nse` directives.
    #[serde(default)]
    pub nse_declarations: Vec<NseDeclaration>,
```

- [ ] **Step 4: Compile-check** (existing literal constructions of `DeclaredSymbol` now need `formals`).

Run: `cargo build -p raven 2>&1 | head -40`
Expected: errors at every `DeclaredSymbol { ... }` literal missing `formals`. Fix each by adding `formals: None` (directive.rs parse sites — fixed in Task 2 — and any test constructors). Re-run until it builds.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/cross_file/types.rs
git commit -m "feat(directives): add NseDeclaration model and func formals field"
```

---

## Task 2: Directive parsing

**Files:**
- Modify: `crates/raven/src/cross_file/directive.rs`

- [ ] **Step 1: Write failing parse tests** at the end of the `#[cfg(test)]` module in `directive.rs`.

```rust
#[test]
fn parses_nse_whole_call() {
    let meta = parse_directives("# raven: nse my_func\nmy_func(x > 1)\n");
    assert_eq!(meta.nse_declarations.len(), 1);
    let d = &meta.nse_declarations[0];
    assert_eq!(d.name, "my_func");
    assert_eq!(d.package, None);
    assert_eq!(d.scope, crate::cross_file::types::NseScope::WholeCall);
    assert_eq!(d.line, 0);
}

#[test]
fn parses_nse_per_formal_and_variants() {
    use crate::cross_file::types::NseScope;
    let cases = [
        ("# raven: nse my_func(x)", "my_func", None, vec!["x"]),
        ("# raven: nse my_func(x, y)", "my_func", None, vec!["x", "y"]),
        ("# raven:nse my_func(x)", "my_func", None, vec!["x"]),
        ("# raven: nse: my_func(x)", "my_func", None, vec!["x"]),
        ("# @lsp-nse my_func(x)", "my_func", None, vec!["x"]),
        ("# raven: nse pkg::my_func(x, y)", "my_func", Some("pkg"), vec!["x", "y"]),
    ];
    for (line, name, pkg, formals) in cases {
        let meta = parse_directives(&format!("{line}\n"));
        assert_eq!(meta.nse_declarations.len(), 1, "case: {line}");
        let d = &meta.nse_declarations[0];
        assert_eq!(d.name, name, "case: {line}");
        assert_eq!(d.package.as_deref(), pkg, "case: {line}");
        assert_eq!(
            d.scope,
            NseScope::Formals(formals.iter().map(|s| s.to_string()).collect()),
            "case: {line}"
        );
    }
}

#[test]
fn malformed_nse_is_ignored() {
    // Empty parens, no callee, and bracket form must NOT produce a declaration.
    for line in ["# raven: nse", "# raven: nse ()", "# raven: nse my_func()", "# raven: nse[my_func(x)]"] {
        let meta = parse_directives(&format!("{line}\n"));
        assert!(meta.nse_declarations.is_empty(), "case: {line}");
    }
}

#[test]
fn func_directive_captures_formals() {
    let meta = parse_directives("# raven: func my_func(data, x, y)\n");
    assert_eq!(meta.declared_functions.len(), 1);
    let f = &meta.declared_functions[0];
    assert_eq!(f.name, "my_func");
    assert_eq!(
        f.formals,
        Some(vec!["data".to_string(), "x".to_string(), "y".to_string()])
    );
}

#[test]
fn func_directive_without_formals_keeps_none() {
    let meta = parse_directives("# raven: func my_func\n");
    assert_eq!(meta.declared_functions[0].formals, None);
}
```

- [ ] **Step 2: Run tests to confirm they fail.**

Run: `cargo test -p raven --lib cross_file::directive 2>&1 | tail -20`
Expected: FAIL (no `nse` field/parsing; `formals` not captured).

- [ ] **Step 3: Add the `nse` regex field** to `DirectivePatterns` (after `declare_func`, `directive.rs:28`):

```rust
    declare_func: Regex,
    nse: Regex,
```

- [ ] **Step 4: Build the `nse` and updated `declare_func` regexes** in `patterns()` (`directive.rs`, inside the `DirectivePatterns { … }` literal).

Replace the `declare_func` regex with one that optionally captures a parenthesized formal list (group 4):

```rust
            declare_func: Regex::new(
                &[
                    r"^\s*#\s*",
                    DIRECTIVE_PREFIX,
                    r#"(?:declare-function|declare-func|function|func)\s*:?\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9._:]+))(?:\s*\(([^)]*)\))?"#,
                ]
                .concat(),
            ).unwrap(),
            // `# raven: nse [pkg::]name` (whole-call) or `… name(formals…)`
            // (per-formal). Groups: 1=name (may be `pkg::name`), 2=formal list
            // body (may be absent → whole-call). Optional colon/spacing and the
            // `@lsp-nse` alias mirror the other declaration families.
            nse: Regex::new(
                &[
                    r"^\s*#\s*",
                    DIRECTIVE_PREFIX,
                    r#"nse\s*:?\s*([A-Za-z0-9._]+(?:::[A-Za-z0-9._]+)?)\s*(?:\(([^)]*)\))?\s*$"#,
                ]
                .concat(),
            ).unwrap(),
```

Note: the unquoted name group for `declare_func` is widened to `[A-Za-z0-9._:]+` so `pkg::name` is not split by `(`. The `nse` name group explicitly allows one `::`.

- [ ] **Step 5: Add a formals-splitting helper** near `capture_symbol_name` (`directive.rs:~150`).

```rust
/// Split a directive parameter list body (the text between `(` and `)`) into
/// trimmed, non-empty formal names. Returns `None` when the body has no usable
/// names (so an empty `()` is treated as malformed by callers).
fn split_formal_list(body: &str) -> Option<Vec<String>> {
    let names: Vec<String> = body
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if names.is_empty() {
        None
    } else {
        Some(names)
    }
}
```

- [ ] **Step 6: Capture formals in the `declare_func` parse branch** (`directive.rs:625-638`). Replace the push with:

```rust
        if let Some(caps) = patterns.declare_func.captures(line) {
            if let Some(name) = capture_symbol_name(&caps, 1) {
                let formals = caps.get(4).and_then(|m| split_formal_list(m.as_str()));
                meta.declared_functions.push(DeclaredSymbol {
                    name,
                    line: line_num,
                    is_function: true,
                    formals,
                });
            }
            continue;
        }
```

Also add `formals: None` to the `declare_var` push (`directive.rs:614`).

- [ ] **Step 7: Add the `nse` parse branch** immediately after the `declare_func` branch (before the loop's closing brace, ~`directive.rs:639`). Import `NseDeclaration, NseScope` in the `use super::types::{…}` block (`directive.rs:10`).

```rust
        // `# raven: nse [pkg::]name[(formals…)]` — NSE argument-policy
        // declaration. Position-aware (applies to calls after this line).
        if let Some(caps) = patterns.nse.captures(line) {
            if let Some(raw) = caps.get(1).map(|m| m.as_str()) {
                let (package, name) = match raw.split_once("::") {
                    Some((p, n)) if !p.is_empty() && !n.is_empty() => {
                        (Some(p.to_string()), n.to_string())
                    }
                    // A leading/trailing `::` is malformed — skip.
                    Some(_) => {
                        continue;
                    }
                    None => (None, raw.to_string()),
                };
                let scope = match caps.get(2) {
                    // Parentheses present: per-formal, unless the list is empty
                    // (malformed → drop the whole declaration).
                    Some(body) => match split_formal_list(body.as_str()) {
                        Some(formals) => NseScope::Formals(formals),
                        None => continue,
                    },
                    // No parentheses: whole-call NSE.
                    None => NseScope::WholeCall,
                };
                meta.nse_declarations.push(NseDeclaration {
                    name,
                    package,
                    scope,
                    line: line_num,
                });
            }
            continue;
        }
```

Note on the bracket form `# raven: nse[my_func(x)]`: the `raven_ignore`/suppression patterns do not match `nse`, and the `nse` regex requires `nse` followed by whitespace/colon then a bare name — `nse[` fails to match, so it is correctly ignored.

- [ ] **Step 8: Run the Task 2 tests to confirm they pass.**

Run: `cargo test -p raven --lib cross_file::directive 2>&1 | tail -20`
Expected: PASS. Then run the full directive module to catch regressions: same command, ensure all green.

- [ ] **Step 9: fmt + clippy + commit**

```bash
cargo fmt --all
cargo clippy -p raven --all-targets --features test-support -- -D warnings 2>&1 | tail -5
git add crates/raven/src/cross_file/directive.rs crates/raven/src/cross_file/types.rs
git commit -m "feat(directives): parse # raven: nse and # raven: func formals"
```

---

## Task 3: Thread directive NSE policies into `NseAnalysis`

**Files:**
- Modify: `crates/raven/src/handlers.rs`

This task adds the data + plumbing only; integration into resolution is Task 4.

- [ ] **Step 1: Add a `directive_nse` field to `NseAnalysis`** (after `base_exports`, `handlers.rs:12790`).

```rust
    /// Per-callee NSE contracts declared via `# raven: nse` directives, already
    /// translated to `(directive_line, ArgPolicy)` and resolved against the
    /// available formal-order sources (`# raven: func`, local definitions).
    /// Keyed by the callee name; each entry is sorted ascending by line so a
    /// position-gated lookup can pick the most recent applicable declaration.
    /// Qualified declarations are stored under their bare `name`; the qualifier
    /// is preserved in the tuple for call-site matching.
    directive_nse: HashMap<String, Vec<DirectiveNsePolicy>>,
```

Define the helper struct just above `NseAnalysis` (`handlers.rs:~12712`):

```rust
/// A `# raven: nse` declaration resolved to an `ArgPolicy`, retaining the
/// directive line (for position gating) and the optional package qualifier
/// (for qualified/unqualified call matching).
struct DirectiveNsePolicy {
    line: u32,
    package: Option<String>,
    policy: crate::nse::ArgPolicy,
}
```

- [ ] **Step 2: Add an `nse_declarations` parameter to `NseAnalysis::build`** (`handlers.rs:12804-12814`). Append after `base_exports`:

```rust
        base_exports: Option<&'a HashSet<String>>,
        nse_declarations: &[crate::cross_file::types::NseDeclaration],
        declared_functions: &[crate::cross_file::types::DeclaredSymbol],
```

- [ ] **Step 3: Build the `directive_nse` map at the end of `build`**, just before `analysis.local_function_policies.extend(dots_upgrades); analysis` (`handlers.rs:12933`). It needs `local_function_defs` (in scope) for the local-definition formal-order source.

```rust
        // Translate `# raven: nse` declarations into per-callee policies,
        // resolving formal order (for positional matching) from `# raven: func`
        // declarations first, then visible local function definitions. When no
        // order is available, fall back to named-only matching by placing
        // "..." first so the positional pass suppresses nothing.
        let mut directive_nse: HashMap<String, Vec<DirectiveNsePolicy>> = HashMap::new();
        for decl in nse_declarations {
            use crate::cross_file::types::NseScope;
            let policy = match &decl.scope {
                NseScope::WholeCall => crate::nse::ArgPolicy::WholeCall,
                NseScope::Formals(captured) => {
                    let order = declared_function_formals(declared_functions, &decl.name, decl.line)
                        .or_else(|| {
                            local_function_defs
                                .get(&decl.name)
                                .map(|def| function_formal_names(*def, text))
                                .filter(|f| !f.is_empty())
                        });
                    match order {
                        Some(mut formals) => {
                            // Ensure each captured name is matchable by name even
                            // if the user named a formal not in the declared order.
                            for c in captured {
                                if !formals.contains(c) {
                                    formals.push(c.clone());
                                }
                            }
                            crate::nse::ArgPolicy::PerFormal {
                                formals,
                                captured: captured.clone(),
                                captured_dots: false,
                            }
                        }
                        None => {
                            // Named-only: "..." first → positional pass stops
                            // immediately (positionals checked), named args still
                            // bind to the captured formals.
                            let mut formals = vec!["...".to_string()];
                            formals.extend(captured.iter().cloned());
                            crate::nse::ArgPolicy::PerFormal {
                                formals,
                                captured: captured.clone(),
                                captured_dots: false,
                            }
                        }
                    }
                }
            };
            directive_nse.entry(decl.name.clone()).or_default().push(
                DirectiveNsePolicy {
                    line: decl.line,
                    package: decl.package.clone(),
                    policy,
                },
            );
        }
        for entries in directive_nse.values_mut() {
            entries.sort_by_key(|e| e.line);
        }
        analysis.directive_nse = directive_nse;
        analysis.local_function_policies.extend(dots_upgrades);
        analysis
```

Add `directive_nse: HashMap::new()` to the `Self { … }` initializer (`handlers.rs:12856-12873`) so the struct is constructed before the map is filled (it is reassigned above).

- [ ] **Step 4: Add the `declared_function_formals` helper** near `function_formal_names` (`handlers.rs:~13483`).

```rust
/// The declared formal order for `name` from the most recent `# raven: func
/// name(formals…)` directive on a line strictly before `before_line`, if any.
fn declared_function_formals(
    declared_functions: &[crate::cross_file::types::DeclaredSymbol],
    name: &str,
    before_line: u32,
) -> Option<Vec<String>> {
    declared_functions
        .iter()
        .filter(|d| d.name == name && d.line < before_line && d.formals.is_some())
        .max_by_key(|d| d.line)
        .and_then(|d| d.formals.clone())
}
```

- [ ] **Step 5: Update the `build` call site** in `collect_undefined_variables_from_snapshot` (`handlers.rs:5712-5725`) to pass the new args:

```rust
        Some(snapshot.base_exports.as_ref()),
        &snapshot.directive_meta.nse_declarations,
        &snapshot.directive_meta.declared_functions,
    );
```

- [ ] **Step 6: Find and update every other `NseAnalysis::build` call site** (test shims included).

Run: `rg -n "NseAnalysis::build" crates/raven/src`
For each non-production call (test shim), pass `&[]` and `&[]` for the two new slices. If a test-support helper constructs `NseAnalysis` via a lighter path, add the `directive_nse: HashMap::new()` field there too.

- [ ] **Step 7: Build.**

Run: `cargo build -p raven --features test-support 2>&1 | tail -20`
Expected: clean (no integration yet, so behavior unchanged).

- [ ] **Step 8: Commit**

```bash
cargo fmt --all
git add crates/raven/src/handlers.rs
git commit -m "feat(nse): thread # raven: nse declarations into NseAnalysis"
```

---

## Task 4: Position-aware resolution integration

**Files:**
- Modify: `crates/raven/src/handlers.rs`

- [ ] **Step 1: Write failing behavior tests.** Locate the existing collector test harness in `handlers.rs` tests (search for a helper that runs undefined-variable collection over a source string, e.g. a `collect(` helper used near `handlers.rs:11245`). Use that same helper. If it does not pass directive metadata, extend it (or add a sibling helper `collect_with_directives(src)` that parses directives via `crate::cross_file::directive::parse_directives(src)` and feeds them through the snapshot/collector). Add:

```rust
#[test]
fn nse_whole_call_suppresses_all_args() {
    let diags = collect("# raven: nse my_func\nmy_func(undefined_a, undefined_b > 1)\n");
    assert!(!diags.iter().any(|d| d.message.contains("undefined_a")));
    assert!(!diags.iter().any(|d| d.message.contains("undefined_b")));
}

#[test]
fn nse_per_formal_with_local_def_positional() {
    // Local def gives formal order (data, x); only x's arg is suppressed.
    let src = "my_func <- function(data, x) data\n# raven: nse my_func(x)\nmy_func(real_df, masked_col)\n";
    let diags = collect(src);
    assert!(diags.iter().any(|d| d.message.contains("real_df")), "data arg must be checked");
    assert!(!diags.iter().any(|d| d.message.contains("masked_col")), "x arg suppressed");
}

#[test]
fn nse_named_arg_matches_without_order() {
    let src = "# raven: nse my_func(x)\nmy_func(data = real_df, x = masked_col)\n";
    let diags = collect(src);
    assert!(diags.iter().any(|d| d.message.contains("real_df")));
    assert!(!diags.iter().any(|d| d.message.contains("masked_col")));
}

#[test]
fn nse_positional_without_order_does_not_suppress() {
    // No formal order known → positional args are checked (conservative).
    let src = "# raven: nse my_func(x)\nmy_func(masked_col)\n";
    let diags = collect(src);
    assert!(diags.iter().any(|d| d.message.contains("masked_col")));
}

#[test]
fn nse_is_position_aware() {
    // Call BEFORE the directive is not covered.
    let src = "my_func(before_col)\n# raven: nse my_func\nmy_func(after_col)\n";
    let diags = collect(src);
    assert!(diags.iter().any(|d| d.message.contains("before_col")), "call before directive checked");
    assert!(!diags.iter().any(|d| d.message.contains("after_col")), "call after directive suppressed");
}

#[test]
fn nse_qualified_matches_qualified_call() {
    let src = "# raven: nse pkg::my_func(x)\npkg::my_func(x = masked_col)\n";
    let diags = collect(src);
    assert!(!diags.iter().any(|d| d.message.contains("masked_col")));
}

#[test]
fn nse_paired_func_enables_positional() {
    let src = "# raven: func my_func(data, x, y)\n# raven: nse my_func(x, y)\nmy_func(real_df, m1, m2)\n";
    let diags = collect(src);
    assert!(diags.iter().any(|d| d.message.contains("real_df")));
    assert!(!diags.iter().any(|d| d.message.contains("m1")));
    assert!(!diags.iter().any(|d| d.message.contains("m2")));
}
```

- [ ] **Step 2: Run to confirm failure.**

Run: `cargo test -p raven --lib nse_ 2>&1 | tail -30`
Expected: FAIL (directive policies not consulted yet).

- [ ] **Step 3: Add the lookup method to `NseAnalysis`** (impl block, near `class_transition_before`, `handlers.rs:~12941`).

```rust
    /// The most recent `# raven: nse` policy applicable to a call to `name`
    /// (optionally qualified `qualifier::name`) at `call_line`, per the
    /// resolution model: a qualified declaration matches a matching qualified
    /// call, or an unqualified call when its package is in play; an unqualified
    /// declaration matches an unqualified call. Position-gated to declarations
    /// strictly before `call_line`.
    fn directive_nse_policy(
        &self,
        name: &str,
        qualifier: Option<&str>,
        call_line: u32,
    ) -> Option<crate::nse::ArgPolicy> {
        let entries = self.directive_nse.get(name)?;
        entries
            .iter()
            .rev()
            .find(|e| {
                e.line < call_line
                    && match (&e.package, qualifier) {
                        // Unqualified declaration: matches an unqualified call.
                        (None, None) => true,
                        // Unqualified declaration does not claim a qualified call.
                        (None, Some(_)) => false,
                        // Qualified declaration matches the same qualified call.
                        (Some(p), Some(q)) => p == q,
                        // Qualified declaration reaches an unqualified call only
                        // when its package is in play.
                        (Some(p), None) => self.in_play_packages.iter().any(|ip| ip == p),
                    }
            })
            .map(|e| e.policy.clone())
    }
```

- [ ] **Step 4: Consult it in `resolve_call_arg_policy`.**

In the namespace-qualified branch (`handlers.rs:14046-14049`), before the `table_verb_policy` fallback:

```rust
    if func.kind() == "namespace_operator" {
        let call_line = call_node.start_position().row as u32;
        if let Some((pkg, n)) = namespace_parts(func, text)
            && let Some(p) = analysis.directive_nse_policy(n, Some(pkg), call_line)
        {
            return p;
        }
        return table_verb_policy(func, text, analysis).unwrap_or(ArgPolicy::Standard);
    }
```

For the unqualified identifier path, insert **before** step 1 (the local-definition check, `handlers.rs:14057`):

```rust
    let name = node_text(func, text);

    // 0. An explicit `# raven: nse` declaration is an authoritative user
    //    override and is position-gated to calls after the directive line.
    let call_line = call_node.start_position().row as u32;
    if let Some(policy) = analysis.directive_nse_policy(name, None, call_line) {
        return policy;
    }

    // 1. A local definition shadows any package / base policy.
    if let Some(policy) = analysis.local_function_policies.get(name) {
```

- [ ] **Step 5: Run the Task 4 tests.**

Run: `cargo test -p raven --lib nse_ 2>&1 | tail -30`
Expected: PASS. Then run the whole crate test suite for regressions: `cargo test -p raven --features test-support 2>&1 | tail -20`.

- [ ] **Step 6: fmt + clippy + commit**

```bash
cargo fmt --all
cargo clippy -p raven --all-targets --features test-support -- -D warnings 2>&1 | tail -5
git add crates/raven/src/handlers.rs
git commit -m "feat(nse): position-aware # raven: nse resolution in arg-policy"
```

---

## Task 5: Local-definition shadowing interaction tests

**Files:**
- Modify: `crates/raven/src/handlers.rs` (tests only; resolution already places directive first)

- [ ] **Step 1: Add tests** confirming the documented precedence and that ordinary code is unaffected.

```rust
#[test]
fn nse_directive_overrides_local_inference() {
    // Local def has no captures (standard eval), but the directive declares x NSE.
    let src = "my_func <- function(data, x) NULL\n# raven: nse my_func(x)\nmy_func(real_df, masked_col)\n";
    let diags = collect(src);
    assert!(diags.iter().any(|d| d.message.contains("real_df")));
    assert!(!diags.iter().any(|d| d.message.contains("masked_col")));
}

#[test]
fn no_nse_directive_keeps_standard_checking() {
    // Sanity: without a directive, a plain local call checks its args.
    let src = "my_func <- function(data, x) NULL\nmy_func(real_df, masked_col)\n";
    let diags = collect(src);
    assert!(diags.iter().any(|d| d.message.contains("masked_col")));
}
```

- [ ] **Step 2: Run + commit.**

Run: `cargo test -p raven --lib nse_ 2>&1 | tail -20` (Expected: PASS)

```bash
git add crates/raven/src/handlers.rs
git commit -m "test(nse): cover directive-over-inference precedence"
```

---

## Task 6: Diagnostic message hint

**Files:**
- Modify: `crates/raven/src/handlers.rs`

- [ ] **Step 1: Write failing tests.** (Uses the same `collect` helper; assert on message text.)

```rust
#[test]
fn undefined_in_user_call_arg_gets_nse_hint() {
    // Local user function, no NSE declared: undefined `x` in its arg gets a hint.
    let src = "my_filter <- function(df, cond) df\nmy_filter(real_df, x)\n";
    let diags = collect(src);
    let d = diags.iter().find(|d| d.message.contains("Undefined variable: x")).expect("x reported");
    assert!(d.message.contains("# raven: nse"), "message should suggest the directive: {}", d.message);
}

#[test]
fn undefined_in_builtin_call_arg_has_no_hint() {
    // paste() is a high-confidence standard-eval builtin → no NSE hint noise.
    let src = "paste(undefined_x)\n";
    let diags = collect(src);
    let d = diags.iter().find(|d| d.message.contains("Undefined variable: undefined_x")).expect("reported");
    assert!(!d.message.contains("# raven: nse"), "no hint for builtins: {}", d.message);
}

#[test]
fn top_level_undefined_has_no_hint() {
    // Not inside a call argument → no hint.
    let src = "x + 1\n";
    let diags = collect(src);
    if let Some(d) = diags.iter().find(|d| d.message.contains("Undefined variable: x")) {
        assert!(!d.message.contains("# raven: nse"));
    }
}
```

- [ ] **Step 2: Run to confirm failure.**

Run: `cargo test -p raven --lib hint 2>&1 | tail -20`
Expected: FAIL.

- [ ] **Step 3: Add the hint helper** near `resolve_call_arg_policy` (`handlers.rs:~14114`).

```rust
/// If `usage_node` (an undefined identifier) sits inside a call argument whose
/// callee is a *plausible* NSE boundary (not a high-confidence standard-eval
/// builtin), return the callee name and the matched formal name (when known)
/// so the diagnostic can suggest `# raven: nse`. Returns `None` when no hint
/// should be shown (top-level usage, builtin callee, etc.).
fn nse_hint_for_usage<'t>(
    usage_node: Node<'t>,
    text: &'t str,
    analysis: &NseAnalysis,
) -> Option<(String, Option<String>)> {
    // Walk up to the enclosing `argument` within a `call`'s `arguments`.
    let mut cur = usage_node;
    let arg = loop {
        let parent = cur.parent()?;
        if parent.kind() == "arguments" && cur.kind() == "argument" {
            break cur;
        }
        cur = parent;
    };
    let args = arg.parent()?; // "arguments"
    let call = args.parent().filter(|n| n.kind() == "call")?;
    let func = call.child_by_field_name("function")?;
    let callee = match func.kind() {
        "identifier" => node_text(func, text).to_string(),
        "namespace_operator" => namespace_parts(func, text)?.1.to_string(),
        _ => return None,
    };
    // Suppress the hint for high-confidence standard-eval builtins (paste, c, …).
    if is_builtin(&callee)
        || analysis
            .base_exports
            .is_some_and(|e| e.contains(callee.as_str()))
    {
        return None;
    }
    // The matched formal: a named argument's name, else None (positional/unknown).
    let formal = arg
        .child_by_field_name("name")
        .map(|n| node_text(n, text).to_string());
    Some((callee, formal))
}
```

- [ ] **Step 4: Enrich the message at the emission site** (`handlers.rs:6217-6224`). Replace the `message` construction so the hint is appended:

```rust
        let mut message = match forward_ref_defined_line {
            Some(line) => format!(
                "Undefined variable: {} (defined later on line {})",
                name,
                line + 1
            ),
            None => format!("Undefined variable: {}", name),
        };
        if let Some((callee, formal)) = nse_hint_for_usage(usage_node, text, &nse_analysis) {
            match formal {
                Some(f) => message.push_str(&format!(
                    ". If `{callee}()` captures this argument with non-standard evaluation, declare it with `# raven: nse {callee}({f})`"
                )),
                None => message.push_str(&format!(
                    ". If `{callee}()` captures this argument with non-standard evaluation, declare it with `# raven: func {callee}(<formals>)` and `# raven: nse {callee}(<nse-formals>)`"
                )),
            }
        }
```

Note: `usage_node` and `nse_analysis` are both in scope in this loop (verify variable names against the surrounding code; the loop iterates `used` as `(name, usage_node)` and `nse_analysis` was built at the top of the function).

- [ ] **Step 5: Run + regressions.**

Run: `cargo test -p raven --lib hint 2>&1 | tail -20` (Expected: PASS)
Run: `cargo test -p raven --features test-support 2>&1 | tail -20` (Expected: no regressions; if pre-existing message-equality tests now fail because of the appended hint, update them to match the documented behavior — the hint only appears for non-builtin call-argument usages.)

- [ ] **Step 6: fmt + clippy + commit**

```bash
cargo fmt --all
cargo clippy -p raven --all-targets --features test-support -- -D warnings 2>&1 | tail -5
git add crates/raven/src/handlers.rs
git commit -m "feat(nse): suggest # raven: nse in undefined-variable messages"
```

---

## Task 7: Code-action quick-fix provider

**Files:**
- Modify: `crates/raven/src/backend.rs`
- Modify: `crates/raven/src/handlers.rs` (pure helper producing the edit text + range)

- [ ] **Step 1: Add a pure helper in `handlers.rs`** that, given a document, a position, and the diagnostics at it, returns the directive line to insert and the insertion line. Write its unit test first (in `handlers.rs` tests):

```rust
#[test]
fn code_action_inserts_nse_directive_above_call() {
    // Given source with an undefined var in a user call arg, the helper yields
    // an insertion at the call's line with matching indentation.
    let src = "my_filter <- function(df, cond) df\n  my_filter(real_df, x)\n";
    let edit = nse_quick_fix_edit(src, /*line*/ 1, /*identifier*/ "x").expect("edit");
    assert_eq!(edit.insert_line, 1);
    assert_eq!(edit.text, "  # raven: nse my_filter(<formal>)\n");
}
```

Implement `nse_quick_fix_edit` (signature returning a small `struct NseQuickFix { insert_line: u32, text: String, title: String }`). It reuses `nse_hint_for_usage`'s call-finding logic — factor the "find enclosing call + callee + formal + call start line + indentation" into a shared helper so the message hint and the code action agree. The inserted text:
- named/known formal `f`: `"{indent}# raven: nse {callee}({f})\n"`.
- unknown formal: `"{indent}# raven: nse {callee}(<formal>)\n"` plus title guiding the user to also add `# raven: func`.

Parse the document with the project's existing parser (search for how hover/definition build the tree from text — reuse `parse_*`/`Parser` helper) to locate the node at the given line/identifier.

- [ ] **Step 2: Advertise the capability** in `backend.rs:2281` capabilities literal:

```rust
                code_action_provider: Some(CodeActionProviderCapability::Simple(true)),
```

Add the needed imports (`CodeActionProviderCapability`, `CodeAction`, `CodeActionParams`, `CodeActionResponse`, `CodeActionOrCommand`, `WorkspaceEdit`, `TextEdit`) to the `lsp_types` use list.

- [ ] **Step 3: Implement `async fn code_action`** in the `#[tower_lsp::async_trait] impl LanguageServer for Backend` block (place near the other request handlers, e.g. after `references`). For each diagnostic in `params.context.diagnostics` whose `code` is `undefined-variable`, fetch the document text from `WorldState` (mirror how `hover`/`goto_definition` read the doc), call the shared helper to build an edit, and assemble a `CodeAction` with a `WorkspaceEdit { changes: {uri -> [TextEdit insert]} }` and `kind: Some(CodeActionKind::QUICKFIX)`. Return `Ok(Some(actions))`.

```rust
async fn code_action(
    &self,
    params: CodeActionParams,
) -> tower_lsp::jsonrpc::Result<Option<CodeActionResponse>> {
    let uri = params.text_document.uri;
    let Some(text) = self.document_text(&uri).await else {
        return Ok(None);
    };
    let mut actions: Vec<CodeActionOrCommand> = Vec::new();
    for diag in &params.context.diagnostics {
        let is_undef = matches!(
            &diag.code,
            Some(NumberOrString::String(c)) if c == crate::diagnostic_code::UNDEFINED_VARIABLE
        );
        if !is_undef {
            continue;
        }
        let line = diag.range.start.line;
        let ident = text
            .lines()
            .nth(line as usize)
            .map(|l| {
                let s = diag.range.start.character as usize;
                let e = diag.range.end.character as usize;
                l.chars().skip(s).take(e.saturating_sub(s)).collect::<String>()
            })
            .unwrap_or_default();
        if let Some(fix) = handlers::nse_quick_fix_edit(&text, line, &ident) {
            let edit = TextEdit {
                range: Range {
                    start: Position::new(fix.insert_line, 0),
                    end: Position::new(fix.insert_line, 0),
                },
                new_text: fix.text,
            };
            let mut changes = std::collections::HashMap::new();
            changes.insert(uri.clone(), vec![edit]);
            actions.push(CodeActionOrCommand::CodeAction(CodeAction {
                title: fix.title,
                kind: Some(CodeActionKind::QUICKFIX),
                diagnostics: Some(vec![diag.clone()]),
                edit: Some(WorkspaceEdit {
                    changes: Some(changes),
                    ..Default::default()
                }),
                ..Default::default()
            }));
        }
    }
    Ok(Some(actions))
}
```

Note: `self.document_text(&uri)` — reuse the existing accessor the other handlers use to read document text (search `backend.rs` for how `hover` obtains text; replace with that exact call). `handlers::nse_quick_fix_edit` must be `pub(crate)`.

- [ ] **Step 4: Build + test.**

Run: `cargo test -p raven --lib code_action 2>&1 | tail -20` (Expected: PASS)
Run: `cargo build -p raven 2>&1 | tail -10` (Expected: clean)

- [ ] **Step 5: fmt + clippy + commit**

```bash
cargo fmt --all
cargo clippy -p raven --all-targets --features test-support -- -D warnings 2>&1 | tail -5
git add crates/raven/src/backend.rs crates/raven/src/handlers.rs
git commit -m "feat(nse): code-action quick-fix to insert # raven: nse"
```

---

## Task 8: Client wiring check + docs

**Files:**
- Modify: `docs/directives.md`, `docs/diagnostics.md`, `README.md`
- Verify: `editors/vscode/*` (capability auto-handled by vscode-languageclient — confirm, change only if needed)

- [ ] **Step 1: Verify the VS Code client surfaces code actions.** `vscode-languageclient` auto-registers the code-action feature when the server advertises `codeActionProvider`; no manual command registration is needed (and must be avoided per the `executeCommandProvider` invariant in CLAUDE.md). Confirm by reading `editors/vscode/src/lsp.test.ts` capability assertions and adding/adjusting an assertion that `codeActionProvider` is present if that test enumerates capabilities.

Run: `rg -n "codeActionProvider|capabilities" editors/vscode/src/test/lsp.test.ts`

- [ ] **Step 2: Document the directive in `docs/directives.md`.** Add an `## NSE Directives` (or a `### NSE Declarations` subsection under Declaration Directives) after the Function Declarations block (`docs/directives.md:140`). Lead with `# raven:` (per the repo convention, commits #421/#454). Include: whole-call vs per-formal, qualified form, position-awareness, pairing with `# raven: func name(formals)` for positional matching, named-arg-only fallback, the `@lsp-nse` alias, and that it is **not** a blanket ignore — it teaches a reusable call policy. Example block:

````markdown
### NSE Declarations

Teach Raven that a function uses non-standard evaluation (NSE), so bare
identifiers in its captured arguments are not flagged as undefined variables.

```r
# raven: nse my_func              # whole-call: every argument is NSE
# raven: nse my_func(x)           # only the `x` formal is captured
# raven: nse my_func(x, y)        # `x` and `y` are captured
# raven: nse pkg::my_func(x, y)   # qualified
# @lsp-nse my_func(x)             # alias
```

`# raven: nse` is position-aware: it applies to calls **after** the directive
line. It is not a blanket diagnostic ignore — it declares a reusable
argument-evaluation policy for the named function.

Raven matches named arguments by formal name regardless of formal order. For
**positional** arguments it needs the formal order, which it reads from a
visible local definition or from a paired declaration:

```r
# raven: func my_func(data, x, y)   # declares existence + formal order
# raven: nse my_func(x, y)          # declares which formals are captured
my_func(df, col_a, col_b)           # col_a, col_b suppressed; df checked
```
````

- [ ] **Step 3: Document in `docs/diagnostics.md`.** In the NSE / undefined-variable section, explain the false-positive escape hatch, the discoverability hint in messages, and the quick-fix code action. (Find the section with `rg -n "non-standard|NSE|undefined-variable" docs/diagnostics.md`.)

- [ ] **Step 4: README.md** — add a one-line mention under the relevant directives/diagnostics bullet if directives are listed there (`rg -n "raven: " README.md`). Keep it brief.

- [ ] **Step 5: Settings reference.** `# raven: nse` adds no new setting, so no `package.json`/settings work is required. If Task 7 had added a setting, regenerate the index — it did not. Skip.

- [ ] **Step 6: Commit**

```bash
git add docs/directives.md docs/diagnostics.md README.md editors/vscode
git commit -m "docs(directives): document # raven: nse and func formals"
```

---

## Task 9: Whole-suite verification

- [ ] **Step 1: Format gate.**

Run: `cargo fmt --all --check`
Expected: clean (no diff).

- [ ] **Step 2: Clippy gate.**

Run: `cargo clippy --workspace --all-targets --features test-support -- -D warnings 2>&1 | tail -10`
Expected: zero warnings.

- [ ] **Step 3: Full Rust test suite.**

Run: `cargo test -p raven --features test-support 2>&1 | tail -20`
Expected: all pass.

- [ ] **Step 4: Bun/VS Code suites if touched.** If Task 8 changed `editors/vscode`, run the relevant bun test (`rg`-discover the wrapper) per CLAUDE.md test-harness notes.

- [ ] **Step 5: Commit any final fixups, then proceed to two consecutive clean `/code-review` passes before opening the PR.**

---

## Self-review notes (spec coverage)

- Whole-call suppression — Task 4 `nse_whole_call_suppresses_all_args`.
- Per-formal with visible local formals — Task 4 `nse_per_formal_with_local_def_positional`.
- Named-arg matching without order — Task 4 `nse_named_arg_matches_without_order`.
- Paired `# raven: func` + `# raven: nse` positional — Task 4 `nse_paired_func_enables_positional`.
- Qualified `pkg::my_func(x)` — Task 4 `nse_qualified_matches_qualified_call`.
- Local definitions shadowing / precedence — Task 5.
- Position-aware before/after — Task 4 `nse_is_position_aware`.
- Malformed directives ignored — Task 2 `malformed_nse_is_ignored`.
- Hint inside plausible NSE call — Task 6 `undefined_in_user_call_arg_gets_nse_hint`.
- No hint for high-confidence builtins — Task 6 `undefined_in_builtin_call_arg_has_no_hint`.
- Code action — Task 7.
- Docs — Task 8.

**Known v1 limitation (documented in Task 8):** positional NSE matching for *installed-package* functions requires a paired `# raven: func`, because the package library exposes export names but not formals synchronously. Named-argument matching works for them unaided.
