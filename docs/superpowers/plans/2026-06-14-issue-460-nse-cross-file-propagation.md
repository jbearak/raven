# Issue #460 — Cross-file `# raven: nse` propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `# raven: nse` (and the `# raven: func` formal-order context it relies on) propagate across the resolved `source()` dependency graph, so a directive declared in any connected file governs undefined-variable suppression at matching call sites in the others.

**Architecture:** A new collector gathers "foreign" NSE/func declarations from the directed set `S(Q) = ancestors(Q) ∪ descendants(ancestors(Q) ∪ {Q})` computed over the snapshot's trimmed neighborhood subgraph (the inverse of the existing revalidation relation, so collection and revalidation stay consistent). Foreign declarations are collapsed to one per `(name, package)` (smallest origin URI, then within-file latest-line) and threaded into `NseAnalysis::build` as **file-level** policies that resolve at a new precedence tier — below own directives, local definitions, and built-in tables, but above the step-4 resolvable-standard-eval classification. Two revalidation gaps are closed by adding `nse_declarations` (incl. line) and `DeclaredSymbol.formals` to `compute_interface_hash`.

**Tech Stack:** Rust (`crates/raven`), tree-sitter-r, tower-lsp 0.20. CI gates: `cargo fmt --all --check` and `cargo clippy --workspace --all-targets --features test-support -- -D warnings` on toolchain `1.96.0` (MSRV).

**Design spec:** `docs/superpowers/specs/2026-06-14-issue-460-nse-cross-file-propagation-design.md` (read it first; this plan implements it).

---

## Design decisions (locked — from the reviewed spec)

1. **Propagation set `S(Q)`** computed over `snapshot.cross_file_graph` (trimmed neighborhood subgraph): `ancestors = get_transitive_dependents(Q)`, `descendants = get_transitive_dependencies_multi_root({Q} ∪ ancestors)`, `S(Q) = (ancestors ∪ descendants) \ {Q}`. Read each member's metadata via `metadata_map.get(uri)`; **skip members with no entry** (unresolved/missing-file nodes carry no declarations).
2. **Foreign declarations are file-level** (no line gate). **Own declarations keep** position-gated latest-wins.
3. **Collapse foreign declarations** to one per `(name, package)`: iterate members in sorted-URI order, first (smallest URI) file to set a key wins; within the same file, the highest-line declaration wins. Same collapse for foreign `# raven: func` (by `name`), so the existing `declared_function_formals` (which does `max_by_key(line)`) is safe on the single-per-key foreign list (no cross-file line comparison).
4. **Precedence ladder** (`resolve_call_arg_policy`): own-exact → local defs → local aliases → own-qualified → built-in tables → **FOREIGN (tier 3.6)** → resolvable-std-eval → Shiny → unresolved⇒suppress. Namespace-qualified branch: own-qualified → tables → **FOREIGN** → Standard.
5. **Formal-order resolution** (own-first): own `# raven: func` → own local def (bare, non-ambiguous) → foreign `# raven: func` → named-only.
6. **`FormalOrderTracker` enabled** when `call_args_enabled && (own_nse non-empty || foreign_nse non-empty)`.
7. **Revalidation:** add `nse_declarations` (name+package+scope+**line**) and `DeclaredSymbol.formals` to `compute_interface_hash`.
8. **Hint + code-action governance** treat file-level foreign entries as governing regardless of line.

---

## File structure

- **Modify** `crates/raven/src/cross_file/scope.rs` — `compute_interface_hash` signature + body (nse + formals); both call sites. (Task 1)
- **Modify** `crates/raven/src/handlers.rs` —
  - `DirectiveNsePolicy.file_level` field. (Task 2)
  - `NseAnalysis::build` foreign params, translation, formal-order helper, `FormalOrderTracker` gate. (Tasks 2–4)
  - `own_directive_nse_policy` / `foreign_directive_nse_policy` split + tier-3.6 wiring in `resolve_call_arg_policy`. (Task 3)
  - `collect_cross_file_nse` collector + wire into the `NseAnalysis::build` call at `handlers.rs:5712`. (Task 5)
  - `nse_directive_governs` file-level handling + `nse_hint_for_usage`. (Task 6)
  - Tests. (Tasks 1–7)
- **Modify** `crates/raven/src/backend.rs` — code-action governance foreign awareness. (Task 6)
- **Modify** `docs/cross-file.md`, `docs/directives.md`, `docs/diagnostics.md`, `CLAUDE.md`. (Task 8)

---

## Task 1: Revalidation — hash `nse_declarations` and `DeclaredSymbol.formals`

Closes Gap A (NSE directive edits never revalidated dependents) and Gap B (`# raven: func` formal-order edits never revalidated dependents). Independent and unit-testable first.

**Files:**
- Modify: `crates/raven/src/cross_file/scope.rs` (`compute_interface_hash` ~4162; call sites ~1300, ~1605)
- Test: same file, `#[cfg(test)]` module (alongside `interface_hash_*` tests ~7547)

- [ ] **Step 1: Write failing tests** in the scope.rs test module.

```rust
#[test]
fn interface_hash_changes_when_nse_directive_added() {
    let a = "library(arm)\nlmer(x)\n";
    let b = "library(arm)\n# raven: nse: lmer\nlmer(x)\n";
    let ha = compute_artifacts_with_metadata(
        &test_uri(), &parse(a), a,
        Some(&crate::cross_file::extract_metadata(a)),
    ).interface_hash;
    let hb = compute_artifacts_with_metadata(
        &test_uri(), &parse(b), b,
        Some(&crate::cross_file::extract_metadata(b)),
    ).interface_hash;
    assert_ne!(ha, hb, "adding a # raven: nse directive must change interface_hash");
}

#[test]
fn interface_hash_changes_when_nse_directive_reordered() {
    // Two declarations for the same callee; swapping their lines changes which
    // is "last" (file-level latest-wins), so dependents must be revalidated.
    let a = "# raven: nse f(x)\n# raven: nse f(y)\nf(1)\n";
    let b = "# raven: nse f(y)\n# raven: nse f(x)\nf(1)\n";
    let ha = compute_artifacts_with_metadata(
        &test_uri(), &parse(a), a, Some(&crate::cross_file::extract_metadata(a)),
    ).interface_hash;
    let hb = compute_artifacts_with_metadata(
        &test_uri(), &parse(b), b, Some(&crate::cross_file::extract_metadata(b)),
    ).interface_hash;
    assert_ne!(ha, hb, "reordering same-callee NSE directives must change interface_hash");
}

#[test]
fn interface_hash_changes_when_func_formals_reordered() {
    let a = "# raven: func g(a, b)\n";
    let b = "# raven: func g(b, a)\n";
    let ha = compute_artifacts_with_metadata(
        &test_uri(), &parse(a), a, Some(&crate::cross_file::extract_metadata(a)),
    ).interface_hash;
    let hb = compute_artifacts_with_metadata(
        &test_uri(), &parse(b), b, Some(&crate::cross_file::extract_metadata(b)),
    ).interface_hash;
    assert_ne!(ha, hb, "reordering # raven: func formals must change interface_hash");
}
```

Use the existing test-module helpers for parsing (`test_uri()`, and the `parse`/tree helper already used by neighboring `interface_hash_*` tests — match their exact spelling; several use `tree_sitter` directly via a local helper). If `compute_artifacts_with_metadata` is not in scope in the test module, call it via its module path as the neighboring tests do.

- [ ] **Step 2: Run tests, verify they FAIL** (hashes equal today).

Run: `cargo test -p raven --lib interface_hash_changes_when_nse -- --nocapture` and `... interface_hash_changes_when_func_formals_reordered`
Expected: FAIL (`assert_ne!` fires — hashes are equal).

- [ ] **Step 3: Add `nse_declarations` parameter to `compute_interface_hash`.**

Change the signature (scope.rs ~4162) to add a parameter after `declared_symbols`:

```rust
fn compute_interface_hash(
    interface: &HashMap<Arc<str>, ScopedSymbol>,
    packages: &[String],
    declared_symbols: &[super::types::DeclaredSymbol],
    nse_declarations: &[super::types::NseDeclaration],
    top_level_removals: &[TopLevelRemoval<'_>],
    data_loads: &[DataCallInfo],
) -> u64 {
```

- [ ] **Step 4: Hash `formals` in the declared-symbols loop and add the nse loop.**

In the declared-symbols loop (~4194-4198) add `formals`:

```rust
let mut sorted_declared: Vec<_> = declared_symbols.iter().collect();
sorted_declared.sort_by_key(|d| (&d.name, d.is_function, d.line));
for decl in sorted_declared {
    decl.name.hash(&mut hasher);
    decl.is_function.hash(&mut hasher);
    decl.line.hash(&mut hasher);
    decl.formals.hash(&mut hasher); // issue #460 Gap B: formal order feeds cross-file NSE positional matching
}
```

After that loop, add the NSE-declaration hashing (field-by-field, mirroring the
declared-symbol approach — `NseDeclaration`/`NseScope` are not `Hash`-derived,
so hash the scope by discriminant + formals):

```rust
// issue #460 Gap A: # raven: nse declarations participate in cross-file
// suppression, so a change to any of them must invalidate dependents. Line is
// included because file-level cross-file collapse keeps the highest-line
// declaration per callee, so a pure reorder changes the propagated winner.
let mut sorted_nse: Vec<_> = nse_declarations.iter().collect();
sorted_nse.sort_by_key(|d| (&d.name, &d.package, d.line));
for decl in sorted_nse {
    decl.name.hash(&mut hasher);
    decl.package.hash(&mut hasher);
    decl.line.hash(&mut hasher);
    match &decl.scope {
        crate::cross_file::types::NseScope::WholeCall => 0u8.hash(&mut hasher),
        crate::cross_file::types::NseScope::Formals(fs) => {
            1u8.hash(&mut hasher);
            fs.hash(&mut hasher);
        }
    }
}
```

- [ ] **Step 5: Update both call sites.**

At ~1300 (`compute_artifacts`, no metadata) add `&[]`:

```rust
artifacts.interface_hash = compute_interface_hash(
    &top_level, &loaded_packages, &[], &[], &removal_refs, &data_loads,
);
```

At ~1605 (`compute_artifacts_with_metadata`) pass the metadata's NSE declarations:

```rust
let nse_decls: &[super::types::NseDeclaration] =
    metadata.map(|m| m.nse_declarations.as_slice()).unwrap_or(&[]);
artifacts.interface_hash = compute_interface_hash(
    &top_level, &loaded_packages, &declared_symbols, nse_decls, &removal_refs, &data_loads,
);
```

- [ ] **Step 6: Run tests, verify they PASS.**

Run: `cargo test -p raven --lib interface_hash`
Expected: PASS (all `interface_hash_*` tests, including the three new ones).

- [ ] **Step 7: fmt + clippy + commit.**

```bash
cargo fmt --all
cargo clippy -p raven --all-targets --features test-support -- -D warnings
git add crates/raven/src/cross_file/scope.rs
git commit -m "fix(nse): hash nse_declarations + func formals into interface_hash (#460)

Closes the cross-file revalidation gaps for issue #460: a # raven: nse
directive edit, and a # raven: func formal-order edit, now invalidate
dependents that rely on them for cross-file NSE suppression."
```

---

## Task 2: Data model — `file_level` on `DirectiveNsePolicy`; foreign params on `build`

Pure scaffolding: add the field and parameters with behavior unchanged when the foreign inputs are empty. Keeps the tree compiling between tasks.

**Files:**
- Modify: `crates/raven/src/handlers.rs` (`DirectiveNsePolicy` ~12797; `NseAnalysis::build` ~12935; the `#[cfg(test)]` build at ~15342; the production call at ~5712; the existing test call at ~21456)

- [ ] **Step 1: Add `file_level` to `DirectiveNsePolicy`.**

```rust
struct DirectiveNsePolicy {
    /// 0-based directive line for own (current-file) entries; ignored (0) for
    /// file-level foreign entries. See `file_level`.
    line: u32,
    package: Option<String>,
    policy: crate::nse::ArgPolicy,
    /// True for a declaration propagated from another file in the source graph
    /// (issue #460): it governs the whole file, never position-gated by `line`.
    file_level: bool,
}
```

- [ ] **Step 2: Add foreign parameters to `build`.**

Append two parameters after `declared_functions`:

```rust
fn build(
    root: Node,
    text: &str,
    call_args_enabled: bool,
    bracket_indices_enabled: bool,
    in_play_packages: Vec<String>,
    self_nse_package: Option<String>,
    package_library: Option<&'a crate::package_library::PackageLibrary>,
    base_exports: Option<&'a HashSet<String>>,
    nse_declarations: &[crate::cross_file::types::NseDeclaration],
    declared_functions: &[crate::cross_file::types::DeclaredSymbol],
    foreign_nse_declarations: &[crate::cross_file::types::NseDeclaration],
    foreign_funcs: &[crate::cross_file::types::DeclaredSymbol],
) -> Self {
```

- [ ] **Step 3: Set `file_level: false` on the existing own-translation push** (~13202):

```rust
.push(DirectiveNsePolicy {
    line: decl.line,
    package: decl.package.clone(),
    policy,
    file_level: false,
});
```

- [ ] **Step 4: Update all call sites to pass `&[], &[]`** for the two new params (compile-only; no behavior change yet):
  - Production: `handlers.rs:5712` — append `&[], &[],` after `&snapshot.directive_meta.declared_functions,`.
  - `#[cfg(test)]` `collect_usages_with_context` build (~15342) — append `&[], &[],`.
  - Any other `NseAnalysis::build(` call (the test at ~21456 and ~21653/21695 paths) — append `&[], &[],`. Find them all with `rg -n "NseAnalysis::build" crates/raven/src/handlers.rs`.

- [ ] **Step 5: Run the build, verify it compiles and existing NSE tests still pass.**

Run: `cargo test -p raven --lib nse 2>&1 | tail -20`
Expected: PASS (no behavior change).

- [ ] **Step 6: fmt + clippy + commit.**

```bash
cargo fmt --all
cargo clippy -p raven --all-targets --features test-support -- -D warnings
git add crates/raven/src/handlers.rs
git commit -m "refactor(nse): add file_level flag + foreign build params (no-op) (#460)"
```

---

## Task 3: Foreign translation + own/foreign lookup split + tier 3.6

Make foreign declarations actually suppress at the right precedence. Test by passing foreign declarations directly to `build` (no graph needed).

**Files:**
- Modify: `crates/raven/src/handlers.rs` (`build` translation ~13104-13211; `directive_nse_policy` ~13220; `resolve_call_arg_policy` ~14737-14839)
- Test: `#[cfg(test)]` module in handlers.rs

- [ ] **Step 1: Write failing tests** that build an `NseAnalysis` with foreign declarations and assert suppression precedence.

```rust
#[test]
fn foreign_whole_call_directive_suppresses_unknown_callee() {
    let code = "lmer(undefined_var)\n";
    let (tree, root) = parse_root(code); // local helper: parse + root_node
    let foreign = vec![crate::cross_file::types::NseDeclaration {
        name: "lmer".into(), package: None,
        scope: crate::cross_file::types::NseScope::WholeCall, line: 999,
    }];
    let analysis = NseAnalysis::build(
        root, code, true, true, vec![], None, None, None,
        &[], &[], &foreign, &[],
    );
    let mut used = Vec::new();
    collect_usages_with_analysis(root, code, &analysis, &UsageContext::default(), &mut used);
    assert!(!used.iter().any(|(n, _)| n == "undefined_var"),
        "a foreign whole-call NSE directive must suppress the arg");
}

#[test]
fn foreign_directive_does_not_override_local_definition() {
    // A local standard-eval `lmer` must NOT be suppressed by a foreign directive.
    let code = "lmer <- function(x) x + 1\nlmer(undefined_var)\n";
    let (_t, root) = parse_root(code);
    let foreign = vec![crate::cross_file::types::NseDeclaration {
        name: "lmer".into(), package: None,
        scope: crate::cross_file::types::NseScope::WholeCall, line: 0,
    }];
    let analysis = NseAnalysis::build(
        root, code, true, true, vec![], None, None, None,
        &[], &[], &foreign, &[],
    );
    let mut used = Vec::new();
    collect_usages_with_analysis(root, code, &analysis, &UsageContext::default(), &mut used);
    assert!(used.iter().any(|(n, _)| n == "undefined_var"),
        "foreign directive must not suppress a locally-defined standard-eval callee");
}

#[test]
fn own_directive_beats_foreign_for_same_callee() {
    // Own per-formal f(x) at line 0 should win over a foreign whole-call f.
    let code = "# raven: nse f(x)\nf(captured_x = a, b)\n";
    let (_t, root) = parse_root(code);
    let own = crate::cross_file::extract_metadata(code).nse_declarations;
    let foreign = vec![crate::cross_file::types::NseDeclaration {
        name: "f".into(), package: None,
        scope: crate::cross_file::types::NseScope::WholeCall, line: 0,
    }];
    let analysis = NseAnalysis::build(
        root, code, true, true, vec![], None, None, None,
        &own, &[], &foreign, &[],
    );
    let mut used = Vec::new();
    collect_usages_with_analysis(root, code, &analysis, &UsageContext::default(), &mut used);
    // Own f(x) suppresses only the x-bound arg; `b` (positional, uncaptured) stays.
    assert!(used.iter().any(|(n, _)| n == "b"),
        "own per-formal directive must win over foreign whole-call (b stays reported)");
}
```

If a `parse_root` helper does not already exist in the test module, add a tiny one mirroring the parser setup used in `test_sysdata_symbol_suppresses_undefined_in_r_source` (handlers.rs ~29040).

- [ ] **Step 2: Run tests, verify FAIL** (foreign declarations are ignored today).

Run: `cargo test -p raven --lib foreign_ -- --nocapture`
Expected: FAIL.

- [ ] **Step 3: Translate foreign declarations in `build`.**

After the existing own-translation loop and its `entries.sort_by_key` (~13208-13210), add the foreign translation. Extract the per-decl policy/formal-order computation used by the own loop into a helper so both share it (DRY):

```rust
// Helper near `build` (free fn). Resolves formal order own-first, then a
// deterministic foreign `# raven: func` fallback, then named-only. Never
// compares raw line numbers across files: `foreign_funcs` is pre-collapsed to
// one entry per name (Task 5), so declared_function_formals' max_by_key(line)
// is within a single file.
fn directive_arg_policy(
    decl: &crate::cross_file::types::NseDeclaration,
    declared_functions: &[crate::cross_file::types::DeclaredSymbol],
    foreign_funcs: &[crate::cross_file::types::DeclaredSymbol],
    local_function_defs: &HashMap<String, Node>,
    formal_order: &FormalOrderTracker,
    text: &str,
) -> crate::nse::ArgPolicy {
    use crate::cross_file::types::NseScope;
    match &decl.scope {
        NseScope::WholeCall => crate::nse::ArgPolicy::WholeCall,
        NseScope::Formals(listed) => {
            let captured_dots = listed.iter().any(|c| c == "...");
            let captured: Vec<String> =
                listed.iter().filter(|c| c.as_str() != "...").cloned().collect();
            let order = declared_function_formals(declared_functions, &decl.name, decl.package.as_deref())
                .or_else(|| {
                    if decl.package.is_some() { return None; }
                    if formal_order.is_ambiguous(&decl.name) { return None; }
                    local_function_defs.get(&decl.name)
                        .map(|def| function_formal_names(*def, text))
                        .filter(|f| !f.is_empty())
                })
                .or_else(|| declared_function_formals(foreign_funcs, &decl.name, decl.package.as_deref()));
            build_per_formal_policy(order, captured, captured_dots) // extract the existing Some/None arm body (~13160-13196) into this fn
        }
    }
}
```

Refactor the existing own loop body (~13113-13206) to call `directive_arg_policy`, then add the foreign loop:

```rust
for decl in foreign_nse_declarations {
    let policy = directive_arg_policy(
        decl, declared_functions, foreign_nse_funcs_ref, &local_function_defs, &formal_order, text,
    );
    directive_nse.entry(decl.name.clone()).or_default().push(DirectiveNsePolicy {
        line: 0,
        package: decl.package.clone(),
        policy,
        file_level: true,
    });
}
// Re-sort so own entries order by line and foreign entries sort after them.
for entries in directive_nse.values_mut() {
    entries.sort_by_key(|e| (e.file_level, e.line));
}
```

(`foreign_nse_funcs_ref` = the `foreign_funcs` param; name it consistently.)

- [ ] **Step 4: Split `directive_nse_policy` into own/foreign lookups.**

Replace `directive_nse_policy` (~13220) with two methods. Keep the exact `qualifier_matches` logic from today's body:

```rust
fn own_directive_nse_policy(&self, name: &str, qualifier: CallQualifier, call_line: u32)
    -> Option<crate::nse::ArgPolicy>
{
    let entries = self.directive_nse.get(name)?;
    entries.iter().rev()
        .find(|e| !e.file_level && e.line < call_line && Self::qualifier_matches(e, &qualifier, &self.in_play_packages))
        .map(|e| e.policy.clone())
}

fn foreign_directive_nse_policy(&self, name: &str, qualifier: CallQualifier)
    -> Option<crate::nse::ArgPolicy>
{
    let entries = self.directive_nse.get(name)?;
    entries.iter()
        .find(|e| e.file_level && Self::qualifier_matches(e, &qualifier, &self.in_play_packages))
        .map(|e| e.policy.clone())
}

fn qualifier_matches(e: &DirectiveNsePolicy, qualifier: &CallQualifier, in_play: &[String]) -> bool {
    match (&e.package, qualifier) {
        (None, CallQualifier::BareExact) => true,
        (None, _) => false,
        (Some(p), CallQualifier::Qualified(q)) => p == q,
        (Some(p), CallQualifier::BareInPlayQualified) => in_play.iter().any(|ip| ip == p),
        (Some(_), CallQualifier::BareExact) => false,
    }
}
```

- [ ] **Step 5: Wire own→foreign tiers in `resolve_call_arg_policy`.**

In the **namespace-qualified** branch (~14739-14749):

```rust
if let Some((pkg, n)) = namespace_parts(func, text) {
    let n = crate::r_names::canonical_use_name(n);
    if let Some(p) = self_own(analysis, n, CallQualifier::Qualified(pkg), call_line) { return p; }
    if let Some(p) = table_verb_policy(func, text, analysis) { return p; }
    if let Some(p) = analysis.foreign_directive_nse_policy(n, CallQualifier::Qualified(pkg)) { return p; }
    return ArgPolicy::Standard;
}
```

(Here `self_own(analysis, …)` = `analysis.own_directive_nse_policy(…)`; inline it.)

In the **bare-identifier** branch: change step 0 (~14770) and step 1c (~14802) from `directive_nse_policy` to `own_directive_nse_policy`. Then insert tier 3.6 **after** `table_verb_policy` (~14809-14811) and **before** step 4 (~14814):

```rust
// 3.6 (issue #460). A file-level directive propagated from a connected file
// governs this callee — below own directives, local bindings, and the precise
// built-in tables, but above the resolvable-standard-eval classification so it
// can suppress a loaded-package export like `lmer`.
if let Some(p) = analysis.foreign_directive_nse_policy(name, CallQualifier::BareExact) { return p; }
if let Some(p) = analysis.foreign_directive_nse_policy(name, CallQualifier::BareInPlayQualified) { return p; }
```

- [ ] **Step 6: Run tests, verify PASS** (the three new tests + all existing `nse` tests).

Run: `cargo test -p raven --lib nse 2>&1 | tail -25`
Expected: PASS.

- [ ] **Step 7: fmt + clippy + commit.**

```bash
cargo fmt --all
cargo clippy -p raven --all-targets --features test-support -- -D warnings
git add crates/raven/src/handlers.rs
git commit -m "feat(nse): translate + resolve foreign directives at tier 3.6 (#460)"
```

---

## Task 4: `FormalOrderTracker` enablement + foreign formal-order coverage

**Files:**
- Modify: `crates/raven/src/handlers.rs` (`FormalOrderTracker` gate ~12968; its doc ~13313)
- Test: handlers.rs test module

- [ ] **Step 1: Write a failing test** that a foreign per-formal directive borrows the current file's local definition for positional order.

```rust
#[test]
fn foreign_per_formal_borrows_local_definition_order() {
    // Local def gives order (a, b); foreign `# raven: nse f(b)` must suppress
    // only the b-bound positional, leaving a reported.
    let code = "f <- function(a, b) a\nf(real_a, undefined_b)\n";
    let (_t, root) = parse_root(code);
    let foreign = vec![crate::cross_file::types::NseDeclaration {
        name: "f".into(), package: None,
        scope: crate::cross_file::types::NseScope::Formals(vec!["b".into()]), line: 0,
    }];
    let analysis = NseAnalysis::build(
        root, code, true, true, vec![], None, None, None,
        &[], &[], &foreign, &[],
    );
    let mut used = Vec::new();
    collect_usages_with_analysis(root, code, &analysis, &UsageContext::default(), &mut used);
    assert!(used.iter().any(|(n, _)| n == "real_a"), "a-bound arg must stay reported");
    assert!(!used.iter().any(|(n, _)| n == "undefined_b"), "b-bound arg must be suppressed");
}
```

- [ ] **Step 2: Run, verify FAIL** (tracker disabled → `is_ambiguous` path may misbehave, or the order is not consulted).

Run: `cargo test -p raven --lib foreign_per_formal_borrows -- --nocapture`
Expected: FAIL or incorrect mask.

- [ ] **Step 3: Widen the `FormalOrderTracker` gate** (~12968):

```rust
let mut formal_order = FormalOrderTracker {
    enabled: call_args_enabled
        && (!nse_declarations.is_empty() || !foreign_nse_declarations.is_empty()),
    ..FormalOrderTracker::default()
};
```

Update its doc comment (~13313-13320) to note foreign declarations also enable it (a foreign per-formal directive may borrow the current file's local definition for formal order).

- [ ] **Step 4: Run, verify PASS.**

Run: `cargo test -p raven --lib foreign_per_formal_borrows`
Expected: PASS.

- [ ] **Step 5: fmt + clippy + commit.**

```bash
cargo fmt --all
cargo clippy -p raven --all-targets --features test-support -- -D warnings
git add crates/raven/src/handlers.rs
git commit -m "fix(nse): enable FormalOrderTracker for foreign directives (#460)"
```

---

## Task 5: Cross-file collector + wire into the production call site

**Files:**
- Modify: `crates/raven/src/handlers.rs` (new `collect_cross_file_nse` near `collect_in_play_packages` ~5511; call at ~5712)
- Test: handlers.rs test module (cross-file integration begins here; full matrix in Task 7)

- [ ] **Step 1: Add the collector** (near `collect_in_play_packages`):

```rust
/// Foreign `# raven: nse` and `# raven: func` declarations propagated from the
/// files connected to `uri` through the source graph (issue #460).
///
/// Computes the directed set `S(uri) = ancestors ∪ descendants(ancestors ∪ {uri})`
/// over the snapshot's TRIMMED neighborhood subgraph — the inverse of
/// `compute_affected_dependents_after_edit`, so collection and revalidation stay
/// consistent. Declarations are collapsed to one per `(name, package)`: members
/// are visited in sorted-URI order, the first (smallest URI) file to set a key
/// wins, and within one file the highest-line declaration wins (file-level
/// latest-wins). `# raven: func` declarations are collapsed by `name` the same
/// way so the existing `declared_function_formals` (max_by_key line) never
/// compares lines across files. Members absent from `metadata_map` (unresolved /
/// missing-file nodes) are skipped — they carry no declarations.
struct CrossFileNse {
    nse: Vec<crate::cross_file::types::NseDeclaration>,
    funcs: Vec<crate::cross_file::types::DeclaredSymbol>,
}

fn collect_cross_file_nse(snapshot: &DiagnosticsSnapshot, uri: &Url) -> CrossFileNse {
    use std::collections::BTreeMap;
    let g = snapshot.cross_file_graph.as_ref();
    let max_depth = snapshot.cross_file_config.max_chain_depth;
    let max_visited = snapshot.cross_file_config.max_transitive_dependents_visited;

    let ancestors = g.get_transitive_dependents(uri, max_depth, max_visited);
    let mut roots: Vec<Url> = ancestors.clone();
    roots.push(uri.clone());
    let descendants = g.get_transitive_dependencies_multi_root(roots.iter(), max_depth, max_visited);

    let mut members: Vec<Url> =
        ancestors.into_iter().chain(descendants).filter(|u| u != uri).collect();
    members.sort();
    members.dedup();

    // Collapse: smallest URI first (members already ascending), within-file max line.
    let mut nse_chosen: BTreeMap<(String, Option<String>), (Url, crate::cross_file::types::NseDeclaration)> = BTreeMap::new();
    let mut func_chosen: BTreeMap<String, (Url, crate::cross_file::types::DeclaredSymbol)> = BTreeMap::new();
    for m in &members {
        let Some(meta) = snapshot.metadata_map.get(m) else { continue };
        for d in &meta.nse_declarations {
            let key = (d.name.clone(), d.package.clone());
            match nse_chosen.get(&key) {
                Some((u, _)) if u != m => {}                       // earlier (smaller) URI won
                Some((_, existing)) if existing.line >= d.line => {} // same file, keep later line
                _ => { nse_chosen.insert(key, (m.clone(), d.clone())); }
            }
        }
        for d in &meta.declared_functions {
            match func_chosen.get(&d.name) {
                Some((u, _)) if u != m => {}
                Some((_, existing)) if existing.line >= d.line => {}
                _ => { func_chosen.insert(d.name.clone(), (m.clone(), d.clone())); }
            }
        }
    }
    CrossFileNse {
        nse: nse_chosen.into_values().map(|(_, d)| d).collect(),
        funcs: func_chosen.into_values().map(|(_, d)| d).collect(),
    }
}
```

- [ ] **Step 2: Wire it into the `NseAnalysis::build` call** (~5712). Replace the trailing `&[], &[],` placeholders from Task 2 with the collected data:

```rust
let cross_file_nse = collect_cross_file_nse(snapshot, uri);
let nse_analysis = NseAnalysis::build(
    node, text,
    snapshot.cross_file_config.undefined_variable_in_call_arguments,
    snapshot.cross_file_config.undefined_variable_in_bracket_indices,
    in_play_packages,
    self_nse_package_for_file(snapshot, uri),
    Some(snapshot.package_library.as_ref()),
    Some(snapshot.base_exports.as_ref()),
    &snapshot.directive_meta.nse_declarations,
    &snapshot.directive_meta.declared_functions,
    &cross_file_nse.nse,
    &cross_file_nse.funcs,
);
```

- [ ] **Step 3: Write a first cross-file integration test (B1 — ancestor declares, descendant calls).**

Model on `test_sysdata_symbol_suppresses_undefined_in_r_source` (~28999). Open two files so the dependency graph is populated; `child.R` sources `parent.R`; the directive is in `parent.R`.

```rust
#[tokio::test]
async fn nse_directive_propagates_from_sourced_parent_to_child() {
    use crate::state::{Document, WorldState};
    let mut state = WorldState::new();
    state.workspace_scan_complete = true;
    let parent = Url::parse("file:///w/parent.R").unwrap();
    let child = Url::parse("file:///w/child.R").unwrap();
    state.open_document(parent.clone(), "library(arm)\n# raven: nse: lmer\n".into(), None);
    state.open_document(child.clone(), "source(\"parent.R\")\nlmer(undefined_var)\n".into(), None);

    let diags = undefined_diags_for(&state, &child); // small test helper, below
    assert!(!diags.iter().any(|m| m.contains("undefined_var")),
        "NSE directive in a sourced parent must suppress the child call. got: {diags:?}");
}
```

Add a test helper in the module if one does not exist:

```rust
#[cfg(test)]
fn undefined_diags_for(state: &crate::state::WorldState, uri: &Url) -> Vec<String> {
    let doc = state.get_document(uri).unwrap();
    let tree = doc.tree.clone().unwrap();
    let text = doc.analysis_text();
    let mut diags = Vec::new();
    let snapshot = DiagnosticsSnapshot::build(state, uri).expect("snapshot");
    collect_undefined_variables_from_snapshot(
        &snapshot, uri, tree.root_node(), &text,
        DiagnosticSeverity::WARNING, &mut diags_vec_adapter(&mut diags),
        &mut std::collections::HashMap::new(), &DiagCancelToken::never(), None,
    );
    diags
}
```

Note: `collect_undefined_variables_from_snapshot` pushes `Diagnostic`s; adapt by collecting into a `Vec<Diagnostic>` then mapping `.message`. (Match the exact shape used by existing snapshot tests — see ~29045; do not invent `diags_vec_adapter`, just collect `Vec<Diagnostic>` and map messages.)

Verify the graph is actually built by `open_document` for these URIs; if `open_document` does not populate `cross_file_graph` in the unit-test path, follow the setup used by `test_completion_transitive_chain_*` (handlers.rs ~48076) which wires multi-file graphs for tests.

- [ ] **Step 4: Run, verify FAIL then implement-already-done → PASS.**

Run: `cargo test -p raven --lib nse_directive_propagates_from_sourced_parent_to_child -- --nocapture`
Expected: PASS (collector + Task 3 wiring make it pass). If it FAILS because the graph isn't populated in the test, fix the test setup (graph wiring), not the production code.

- [ ] **Step 5: fmt + clippy + commit.**

```bash
cargo fmt --all
cargo clippy -p raven --all-targets --features test-support -- -D warnings
git add crates/raven/src/handlers.rs
git commit -m "feat(nse): collect + propagate cross-file NSE/func declarations (#460)"
```

---

## Task 6: Hint + code-action governance for foreign directives

**Files:**
- Modify: `crates/raven/src/handlers.rs` (`nse_directive_governs` ~14497; `nse_hint_for_usage` ~14553)
- Modify: `crates/raven/src/backend.rs` (code-action governance ~5734)
- Test: handlers.rs test module

- [ ] **Step 1: Write a failing test** that the hint steps aside when a foreign per-formal directive governs the callee (surviving var on an uncaptured formal).

```rust
#[test]
fn hint_suppressed_when_foreign_directive_governs() {
    let code = "f(captured = a, undefined_b)\n";
    let (_t, root) = parse_root(code);
    let foreign = vec![crate::cross_file::types::NseDeclaration {
        name: "f".into(), package: None,
        scope: crate::cross_file::types::NseScope::Formals(vec!["captured".into()]), line: 0,
    }];
    let analysis = NseAnalysis::build(root, code, true, true, vec![], None, None, None, &[], &[], &foreign, &[]);
    // The `undefined_b` usage node — find it, then assert no hint is offered.
    let usage = find_identifier(root, code, "undefined_b");
    assert!(nse_hint_for_usage(usage, code, &analysis).is_none(),
        "a governing foreign directive must suppress the add-# raven: nse hint");
}
```

(`find_identifier` — small descend helper; if absent, locate via `descendant_for_point_range` like the backend does.)

- [ ] **Step 2: Run, verify FAIL** (foreign entry has `line: 0`; `nse_directive_governs`'s `line < call_line` may pass by accident or the entries shape differs — make the behavior explicit rather than accidental).

- [ ] **Step 3: Make `nse_directive_governs` foreign-aware.** Change its input to carry the `file_level` flag and treat file-level entries as governing regardless of line:

```rust
pub(crate) fn nse_directive_governs<'a>(
    entries: impl IntoIterator<Item = (Option<&'a str>, u32, bool)>, // (package, line, file_level)
    call_pkg: Option<&str>,
    call_line: u32,
) -> bool {
    entries.into_iter().any(|(pkg, line, file_level)| {
        pkg == call_pkg && (file_level || line < call_line)
    })
}
```

Update `nse_hint_for_usage` (~14568) to pass the flag:

```rust
if analysis.directive_nse.get(bare).is_some_and(|entries| {
    nse_directive_governs(
        entries.iter().map(|e| (e.package.as_deref(), e.line, e.file_level)),
        call_pkg, call_line,
    )
}) {
    return None;
}
```

- [ ] **Step 4: Update the backend code-action** (`backend.rs` ~5734) to feed own+foreign governance. The backend has `state` (graph + metadata) access. Build a snapshot and reuse the same collector so the governance set matches diagnostics:

```rust
// Own + foreign governing declarations, so the lightbulb stays in lockstep with
// the foreign-aware hint (issue #460). Only when an undefined diagnostic exists.
let governing: Vec<(Option<String>, u32, bool)> = if params.context.diagnostics.iter().any(&is_undefined) {
    let mut v: Vec<_> = state.get_enriched_metadata(&uri)
        .map(|m| m.nse_declarations.iter().map(|d| (d.package.clone(), d.line, false)).collect::<Vec<_>>())
        .unwrap_or_default();
    if let Some(snapshot) = handlers::DiagnosticsSnapshot::build(state, &uri) {
        let foreign = handlers::collect_cross_file_nse(&snapshot, &uri);
        v.extend(foreign.nse.iter().map(|d| (d.package.clone(), 0, true)));
    }
    v
} else { Vec::new() };
```

Then the governance check (~5762) becomes:

```rust
if handlers::nse_directive_governs(
    governing.iter().filter(|(_, _, _)| true)
        .filter_map(|(p, l, f)| Some((p.as_deref(), *l, *f)))
        .filter(|_| true),
    call_pkg, fix.insert_line,
) { continue; }
```

(Simplify the closure plumbing to match the final `nse_directive_governs` signature; the key requirement: pass own entries with `file_level=false` and foreign entries with `file_level=true`, filtered to `d.name == bare`.) Make `collect_cross_file_nse`, `CrossFileNse`, and `DiagnosticsSnapshot` reachable from backend (they are `pub(crate)` / in `handlers`); add `pub(crate)` where needed. If threading the snapshot here proves too costly, the documented fallback (spec §4.7) is acceptable: keep own-only governance and accept a harmless redundant local suggestion — in that case, skip the foreign part and leave a `// #460: foreign governance is best-effort` note.

- [ ] **Step 5: Run, verify PASS** (hint test + existing hint/code-action tests).

Run: `cargo test -p raven --lib nse 2>&1 | tail; cargo test -p raven --lib hint 2>&1 | tail`
Expected: PASS.

- [ ] **Step 6: fmt + clippy + commit.**

```bash
cargo fmt --all
cargo clippy -p raven --all-targets --features test-support -- -D warnings
git add crates/raven/src/handlers.rs crates/raven/src/backend.rs
git commit -m "fix(nse): make hint + code-action governance foreign-aware (#460)"
```

---

## Task 7: Behavior-matrix integration tests (B2–B8)

Add the remaining matrix rows (B1 landed in Task 5). All follow the Task-5 harness (`open_document` for each file, `undefined_diags_for(&state, &uri)`).

**Files:**
- Test: `crates/raven/src/handlers.rs` test module

- [ ] **Step 1: B2 — descendant declares, ancestor calls.**

```rust
#[tokio::test]
async fn nse_directive_propagates_from_sourced_child_to_parent() {
    use crate::state::{WorldState};
    let mut state = WorldState::new();
    state.workspace_scan_complete = true;
    let parent = Url::parse("file:///w/parent.R").unwrap();
    let child = Url::parse("file:///w/child.R").unwrap();
    state.open_document(parent.clone(), "source(\"child.R\")\nlmer(undefined_var)\n".into(), None);
    state.open_document(child.clone(), "library(arm)\n# raven: nse: lmer\n".into(), None);
    let diags = undefined_diags_for(&state, &parent);
    assert!(!diags.iter().any(|m| m.contains("undefined_var")), "got: {diags:?}");
}
```

- [ ] **Step 2: B3 — transitive (≥2 edges), both directions.** Chain `a.R → b.R → c.R`; directive in `a.R`, call in `c.R`; and a mirror with directive in `c.R`, call in `a.R`. Assert suppression in each.

- [ ] **Step 3: B4 — shared sourced helper.** `a.R` and `b.R` both `source("h.R")`; `# raven: nse: lmer` in `h.R`; `lmer(undefined_var)` in both `a.R` and `b.R`; assert suppressed in both.

- [ ] **Step 4: B4b — sibling via shared parent.** `main.R` sources `setup.R` then `analysis.R`; `# raven: nse: lmer` in `setup.R`; `lmer(undefined_var)` in `analysis.R`; assert suppressed in `analysis.R`.

- [ ] **Step 5: B5 — negative (unconnected).** Two files with no `source()` relationship; directive in one; `lmer(undefined_var)` in the other; assert the diagnostic IS reported (`assert!(diags.iter().any(...))`).

- [ ] **Step 6: B6 — per-formal cross-file.** `helper.R` has `# raven: func myverb(data, expr)`; `main.R` sources `helper.R`, has `# raven: nse: myverb(expr)` and `myverb(real_df, undefined_expr)`; assert `real_df` reported, `undefined_expr` suppressed.

- [ ] **Step 7: B7b — cross-file ordering.** Same as B6 but place `library()`/`# raven: func` after the `# raven: nse` line and in a different connected file order; assert suppression unchanged. (B7a within-file ordering is already covered by #455 tests; add one explicit within-file regression if missing.)

- [ ] **Step 8: B8 — revalidation.** Open `parent.R` (calls `lmer(undefined_var)`, sources `child.R`) and `child.R` (no directive). Assert the diagnostic IS reported. Then `state.open_document(child, "# raven: nse: lmer\n", ...)` (simulating an edit) and re-run `undefined_diags_for(&state, &parent)`; assert the diagnostic is now suppressed — proving the interface-hash change (Task 1) makes the parent recompute. (If the unit-test path does not auto-revalidate, assert the lower-level invariant: `compute_artifacts` interface_hash for `child.R` differs before/after the edit — i.e. Task 1's guarantee — and that a fresh snapshot for `parent.R` suppresses.)

- [ ] **Step 9: Run all matrix tests.**

Run: `cargo test -p raven --lib nse_directive_propagates 2>&1 | tail; cargo test -p raven --lib nse_ 2>&1 | tail`
Expected: PASS.

- [ ] **Step 10: fmt + clippy + commit.**

```bash
cargo fmt --all
cargo clippy -p raven --all-targets --features test-support -- -D warnings
git add crates/raven/src/handlers.rs
git commit -m "test(nse): cross-file propagation behavior matrix B2-B8 (#460)"
```

---

## Task 8: Documentation

**Files:**
- Modify: `docs/directives.md`, `docs/cross-file.md`, `docs/diagnostics.md`, `CLAUDE.md`

- [ ] **Step 1: `docs/directives.md`** — in the `# raven: nse` section, add a paragraph: directives propagate through the resolved `source()` graph (forward and backward edges), so a directive declared next to the `library()`/definition/setup file governs matching call sites in connected files. Cross-file propagation is intentionally **coarse and file-level** (it ignores the directive's line in other files); within the declaring file, position-aware latest-wins still applies. Note the bound: connected within `max_chain_depth` source hops. Note L1 (cross-file positional matching needs `# raven: func`; a real `function()` definition in another file falls back to named-only).

- [ ] **Step 2: `docs/cross-file.md`** — add `# raven: nse` to the list of facts that propagate over the source graph, alongside symbols and `library()` loads; state it uses the revalidation-consistent set and that edits to a connected directive revalidate dependents.

- [ ] **Step 3: `docs/diagnostics.md`** — under undefined-variable / NSE suppression, note cross-file propagation and the coarse/file-level behavior.

- [ ] **Step 4: `CLAUDE.md`** — under "Key invariants → Path resolution / Workspace-root fallback", add a bullet: "`# raven: nse` / `# raven: func` facts propagate over the source graph using the revalidation-consistent set `S(Q) = ancestors ∪ descendants(ancestors ∪ {Q})`; they reuse graph edges (never resolve paths directly) and feed `interface_hash` so connected files revalidate on directive edits."

- [ ] **Step 5: Commit.**

```bash
git add docs/ CLAUDE.md
git commit -m "docs(nse): document cross-file # raven: nse propagation (#460)"
```

---

## Final verification (before requesting review)

- [ ] `cargo fmt --all --check`
- [ ] `cargo clippy --workspace --all-targets --features test-support -- -D warnings`
- [ ] `cargo test -p raven --lib nse` (all green)
- [ ] `cargo test -p raven` (full lib suite green)
- [ ] Re-read the spec §5 matrix; confirm each row maps to a passing test.

---

## Self-review notes (spec coverage)

- B1–B8/B4b → Tasks 5, 7. Gaps A/B revalidation → Task 1 + Task 7 Step 8.
- Foreign tier 3.6 (OD5) → Task 3 Step 5. Own-first formal order (findings #3/#7) → Task 3 Step 3 + Task 4. FormalOrderTracker (#6) → Task 4. Hint/code-action (#7/#10) → Task 6. Determinism/collapse (#2, OD3) → Task 5. Snapshot-bounds (round-2 BLOCKER) → Task 5 collector computes over `snapshot.cross_file_graph` and skips absent members.
- L1 (no cross-file real-def formal order) — intentionally not implemented; documented (Task 8) and asserted indirectly by B6 using `# raven: func`.
