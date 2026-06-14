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
6. **`FormalOrderTracker` gate is UNCHANGED** (`call_args_enabled && !nse_declarations.is_empty()`). See Task 4 for why widening is unnecessary (a foreign directive never borrows a local def's order — tier 3.6 is shadowed by step-1 local defs).
7. **Revalidation:** add `nse_declarations` (name+package+scope+**line**) and `DeclaredSymbol.formals` to `compute_interface_hash`.
8. **Hint + code-action governance** treat file-level foreign entries as governing regardless of line.

---

## Testing discipline — avoid vacuous suppression (CRITICAL)

In the test harness there is **no `package_library`**, so a callee that is unknown to `is_builtin`/`base_exports` (e.g. `lmer`, `myverb`) is **unresolved → tier 6 `WholeCall` → all its args suppressed for free**, with or without a directive. Using such a callee for a *whole-call* propagation test is **vacuous** (it passes even if propagation is broken) and makes the negative test (B5) *fail* (the arg is suppressed regardless). Discipline:

- **Whole-call tests (B1–B4b, B5, B8):** use a **builtin** callee that resolves to `Standard` in tests and is NOT in any NSE table — `nrow` (verified `is_builtin`, not NSE-tabled; `nrow(undefined_var)` reports `undefined_var` by default, as in `test_sysdata_symbol_suppresses_undefined_in_r_source`). Then: no directive → `nrow(undefined_var)` reports; foreign `# raven: nse: nrow` → tier 3.6 (before step 4) suppresses. The difference is attributable to propagation. No `library(...)` needed.
- **Per-formal tests (B6, Task 4):** an unresolved callee (e.g. `myverb`) is fine because the discriminator is that an **uncaptured** positional stays **reported** — which only happens if the per-formal directive fired (a bare unresolved callee would `WholeCall`-suppress *everything*, including the uncaptured arg). Assert the uncaptured arg IS reported.
- Every suppression test must have a paired/within-test control proving the arg is reported absent the directive, so suppression is never vacuous.

---

## File structure

- **Modify** `crates/raven/src/cross_file/scope.rs` — `compute_interface_hash` signature + body (nse + formals); both call sites. (Task 1)
- **Modify** `crates/raven/src/handlers.rs` —
  - `DirectiveNsePolicy.file_level` field. (Task 2)
  - `NseAnalysis::build` foreign params, translation, own-first formal-order helper. (Tasks 2–4)
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
        &test_uri(), &parse_r(a), a,
        Some(&crate::cross_file::extract_metadata(a)),
    ).interface_hash;
    let hb = compute_artifacts_with_metadata(
        &test_uri(), &parse_r(b), b,
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
        &test_uri(), &parse_r(a), a, Some(&crate::cross_file::extract_metadata(a)),
    ).interface_hash;
    let hb = compute_artifacts_with_metadata(
        &test_uri(), &parse_r(b), b, Some(&crate::cross_file::extract_metadata(b)),
    ).interface_hash;
    assert_ne!(ha, hb, "reordering same-callee NSE directives must change interface_hash");
}

#[test]
fn interface_hash_changes_when_func_formals_reordered() {
    let a = "# raven: func g(a, b)\n";
    let b = "# raven: func g(b, a)\n";
    let ha = compute_artifacts_with_metadata(
        &test_uri(), &parse_r(a), a, Some(&crate::cross_file::extract_metadata(a)),
    ).interface_hash;
    let hb = compute_artifacts_with_metadata(
        &test_uri(), &parse_r(b), b, Some(&crate::cross_file::extract_metadata(b)),
    ).interface_hash;
    assert_ne!(ha, hb, "reordering # raven: func formals must change interface_hash");
}
```

Use the existing scope.rs test-module helpers: `parse_r(code) -> Tree` (~scope.rs:7520) and `test_uri()` (~7523). `compute_artifacts_with_metadata` is at scope.rs:1377 and `extract_metadata` at `cross_file/mod.rs:63` (the tests use `crate::cross_file::extract_metadata`). Confirm the exact names with `rg -n "fn parse_r|fn test_uri" crates/raven/src/cross_file/scope.rs` before writing.

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

- [ ] **Step 4: Update ALL `NseAnalysis::build` call sites to pass `&[], &[]`** for the two new params (compile-only; no behavior change yet). `rg -n "NseAnalysis::build" crates/raven/src` is authoritative; at the time of writing there are **nine** call sites, all in `handlers.rs`:
  - `:5712` (production undefined-variable collector — the one Task 5 later replaces with the real foreign data).
  - `:15342` (`#[cfg(test)]` `collect_usages_with_context`).
  - `:21456`, `:21468`, `:21644`, `:21686`, `:21882`, `:21936`, `:22265` (test call sites).

  Append `&[], &[],` after the `declared_functions` argument at each. Verify the count with `rg -c "NseAnalysis::build" crates/raven/src/handlers.rs` and that the crate compiles.

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
// Local test helper used by Tasks 3-4. Parses `code`, builds an NseAnalysis with
// the four declaration slices, runs the collector, returns the used-identifier
// names. Parser setup mirrors `test_sysdata_symbol_suppresses_undefined_in_r_source`
// (~handlers.rs:29040). `tree` is kept alive on the stack (root borrows it).
fn build_used(
    code: &str,
    own_nse: &[crate::cross_file::types::NseDeclaration],
    own_funcs: &[crate::cross_file::types::DeclaredSymbol],
    foreign_nse: &[crate::cross_file::types::NseDeclaration],
    foreign_funcs: &[crate::cross_file::types::DeclaredSymbol],
) -> Vec<String> {
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&tree_sitter_r::LANGUAGE.into()).unwrap();
    let tree = parser.parse(code, None).unwrap();
    let root = tree.root_node();
    let analysis = NseAnalysis::build(
        root, code, true, true, vec![], None, None, None,
        own_nse, own_funcs, foreign_nse, foreign_funcs,
    );
    let mut used = Vec::new();
    collect_usages_with_analysis(root, code, &analysis, &UsageContext::default(), &mut used);
    used.into_iter().map(|(n, _)| n).collect()
}

#[test]
fn foreign_whole_call_directive_suppresses_builtin_callee() {
    // `nrow` is is_builtin → resolves to Standard (step 4) in the test harness,
    // so its arg is checked by DEFAULT. That makes the suppression below
    // attributable to the foreign directive, not to free tier-6 suppression.
    let code = "nrow(undefined_var)\n";
    let foreign = vec![crate::cross_file::types::NseDeclaration {
        name: "nrow".into(), package: None,
        scope: crate::cross_file::types::NseScope::WholeCall, line: 0,
    }];
    // Control: no foreign directive → arg is reported (proves non-vacuous).
    assert!(build_used(code, &[], &[], &[], &[]).iter().any(|n| n == "undefined_var"),
        "baseline: nrow's arg must be checked without a directive");
    // With a foreign whole-call directive → suppressed at tier 3.6.
    assert!(!build_used(code, &[], &[], &foreign, &[]).iter().any(|n| n == "undefined_var"),
        "a foreign whole-call NSE directive must suppress the arg");
}

#[test]
fn foreign_directive_does_not_override_local_definition() {
    // A local standard-eval `nrow` (step 1) shadows the foreign directive (3.6).
    let code = "nrow <- function(x) x + 1\nnrow(undefined_var)\n";
    let foreign = vec![crate::cross_file::types::NseDeclaration {
        name: "nrow".into(), package: None,
        scope: crate::cross_file::types::NseScope::WholeCall, line: 0,
    }];
    assert!(build_used(code, &[], &[], &foreign, &[]).iter().any(|n| n == "undefined_var"),
        "foreign directive must not suppress a locally-defined standard-eval callee");
}

#[test]
fn own_directive_beats_foreign_for_same_callee() {
    // Own per-formal nrow(x) wins over a foreign whole-call nrow. With order
    // resolved by the own # raven: func, only the x-bound arg is suppressed;
    // the data-bound arg stays reported — proving own beat foreign (which would
    // have whole-call-suppressed BOTH).
    let code = "# raven: func nrow(data, x)\n# raven: nse nrow(x)\nnrow(real_df, masked_col)\n";
    let meta = crate::cross_file::extract_metadata(code);
    let foreign = vec![crate::cross_file::types::NseDeclaration {
        name: "nrow".into(), package: None,
        scope: crate::cross_file::types::NseScope::WholeCall, line: 0,
    }];
    let used = build_used(code, &meta.nse_declarations, &meta.declared_functions, &foreign, &[]);
    assert!(used.iter().any(|n| n == "real_df"),
        "own per-formal directive must win over foreign whole-call (data arg stays reported)");
    assert!(!used.iter().any(|n| n == "masked_col"),
        "own per-formal directive suppresses the x-bound arg");
}
```

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
        decl, declared_functions, foreign_funcs, &local_function_defs, &formal_order, text,
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

(`foreign_funcs` is the new `build` parameter from Task 2.)

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

## Task 4: Foreign per-formal order via `# raven: func`; local-def precedence

**Design note — `FormalOrderTracker` does NOT need widening.** Codex round-2
finding #6 proposed enabling the tracker when foreign declarations exist. On
analysis this is unnecessary: the tracker is consulted ONLY in
`directive_arg_policy`'s "borrow a local `name <- function(...)` definition's
formal order" branch, and that branch is unreachable for a *foreign* directive.
A foreign directive resolves at tier 3.6, which is reached only when the callee
has no local definition (a local def resolves at **step 1**, before tier 3.6 —
see Task 3 Step 5). So a foreign directive never borrows a local def's order;
its order comes from foreign `# raven: func` or the named-only fallback. Leave
the gate `call_args_enabled && !nse_declarations.is_empty()` UNCHANGED. The
two tests below pin both halves of this reasoning.

**Files:**
- Test only: `crates/raven/src/handlers.rs` test module (no production change)

- [ ] **Step 1: Write the foreign-`# raven: func` order test.**

```rust
#[test]
fn foreign_per_formal_uses_foreign_func_order() {
    // No local def of `myverb`; a foreign `# raven: func myverb(data, expr)`
    // supplies positional order to a foreign `# raven: nse myverb(expr)`, so only
    // the expr-bound positional is suppressed. `real_df` (data-bound, uncaptured)
    // stays reported — which a bare unresolved callee would NOT (it would
    // whole-call-suppress everything), so this assertion is non-vacuous.
    let code = "myverb(real_df, undefined_expr)\n";
    let foreign_nse = vec![crate::cross_file::types::NseDeclaration {
        name: "myverb".into(), package: None,
        scope: crate::cross_file::types::NseScope::Formals(vec!["expr".into()]), line: 0,
    }];
    let foreign_funcs = vec![crate::cross_file::types::DeclaredSymbol {
        name: "myverb".into(), line: 0, is_function: true,
        formals: Some(vec!["data".into(), "expr".into()]),
    }];
    let used = build_used(code, &[], &[], &foreign_nse, &foreign_funcs);
    assert!(used.iter().any(|n| n == "real_df"), "data-bound positional stays reported");
    assert!(!used.iter().any(|n| n == "undefined_expr"), "expr-bound positional suppressed");
}
```

(Confirm `DeclaredSymbol`'s exact fields with `rg -n "pub struct DeclaredSymbol" -A8 crates/raven/src/cross_file/types.rs` — it is `name`, `line`, `is_function`, `formals: Option<Vec<String>>`; the literal must set all four.)

- [ ] **Step 2: Write the local-definition-precedence test** (per-formal analog of Task 3's whole-call shadow test).

```rust
#[test]
fn foreign_directive_yields_to_local_definition() {
    // A local standard-eval `myverb` resolves at step 1, before tier 3.6, so the
    // foreign directive never fires and the positional stays reported.
    let code = "myverb <- function(data, expr) data\nmyverb(a, undefined_expr)\n";
    let foreign_nse = vec![crate::cross_file::types::NseDeclaration {
        name: "myverb".into(), package: None,
        scope: crate::cross_file::types::NseScope::Formals(vec!["expr".into()]), line: 0,
    }];
    let used = build_used(code, &[], &[], &foreign_nse, &[]);
    assert!(used.iter().any(|n| n == "undefined_expr"),
        "local def resolves at step 1; foreign tier 3.6 must not fire");
}
```

- [ ] **Step 3: Run both, verify PASS** (Task 3's wiring already makes them pass).

Run: `cargo test -p raven --lib foreign_per_formal_uses_foreign_func_order foreign_directive_yields_to_local_definition -- --nocapture`
Expected: PASS.

- [ ] **Step 4: fmt + clippy + commit.**

```bash
cargo fmt --all
cargo clippy -p raven --all-targets --features test-support -- -D warnings
git add crates/raven/src/handlers.rs
git commit -m "test(nse): foreign per-formal order via # raven: func; local-def precedence (#460)"
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

- [ ] **Step 3: Establish the canonical cross-file test harness (CRITICAL — used by Tasks 5 & 7).**

`open_document`/`documents.insert` do **NOT** populate the dependency graph; tests must call `cross_file_graph.update_file(...)` per file (see the existing cross-file revalidation test at `handlers.rs:~52466-52505`). And the existing top-level `diagnostics(&state, &uri, &DiagCancelToken::never()) -> Vec<Diagnostic>` function is the right way to get diagnostics (it builds the snapshot and runs all collectors), so there is **no need** for a bespoke `undefined_diags_for` helper. Add a tiny helper that wires both files and returns messages:

```rust
#[cfg(test)]
fn diag_messages_for(files: &[(&str, &str)], query: &str) -> Vec<String> {
    use crate::state::{Document, WorldState};
    let ws = Url::parse("file:///w/").unwrap();
    let mut state = WorldState::new();
    state.workspace_folders.push(ws.clone());
    state.workspace_scan_complete = true; // else undefined-var diagnostics defer
    for (name, code) in files {
        let uri = ws.join(name).unwrap();
        state.documents.insert(uri.clone(), Document::new(code, None));
        let meta = crate::cross_file::extract_metadata(code);
        state.cross_file_graph.update_file(&uri, &meta, Some(&ws), |_| None);
    }
    let q = ws.join(query).unwrap();
    diagnostics(&state, &q, &DiagCancelToken::never())
        .into_iter().map(|d| d.message).collect()
}
```

(Confirm `diagnostics`'s exact signature with `rg -n "pub(crate) fn diagnostics|fn diagnostics\(" crates/raven/src/handlers.rs`; the cross-file test at ~52483 calls `diagnostics(&state, &b_url, &DiagCancelToken::never())`. The undefined-variable message format is `"Undefined variable: <name>"`.)

- [ ] **Step 4: Write B1 (ancestor declares, descendant calls) + its control, using the harness.**

Uses the builtin callee `nrow` (Testing discipline) so the suppression is attributable to propagation, not free tier-6 suppression.

```rust
#[test]
fn nse_directive_propagates_from_sourced_parent_to_child() {
    // Control: child alone (no directive reachable) → nrow's arg is reported.
    let control = diag_messages_for(
        &[("child.R", "nrow(undefined_var)\n")],
        "child.R",
    );
    assert!(control.iter().any(|m| m.contains("undefined_var")),
        "baseline: nrow's arg must be checked. got: {control:?}");

    // Directive in the sourced parent must suppress the child call.
    let msgs = diag_messages_for(
        &[
            ("parent.R", "# raven: nse: nrow\n"),
            ("child.R", "source(\"parent.R\")\nnrow(undefined_var)\n"),
        ],
        "child.R",
    );
    assert!(!msgs.iter().any(|m| m.contains("undefined_var")),
        "NSE directive in a sourced parent must suppress the child call. got: {msgs:?}");
}
```

- [ ] **Step 5: Run, verify PASS.**

Run: `cargo test -p raven --lib nse_directive_propagates_from_sourced_parent_to_child -- --nocapture`
Expected: PASS (collector + Task 3 wiring). The control half also guards against a FALSE PASS from a missing `source()` edge: if the edge never formed, the second assertion's `nrow(undefined_var)` would still be *reported* (like the control), failing the test. If the edge is the problem, verify `source("parent.R")` resolves under workspace root `file:///w/` (it uses `from_metadata` + workspace fallback); if needed, use an explicit `# raven: source: parent.R` in `child.R`.

- [ ] **Step 6: fmt + clippy + commit.**

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
    // `nrow` is a builtin so the call is eligible for the hint; a governing
    // foreign per-formal directive must make the hint step aside.
    let code = "nrow(captured = a, undefined_b)\n";
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&tree_sitter_r::LANGUAGE.into()).unwrap();
    let tree = parser.parse(code, None).unwrap();
    let root = tree.root_node();
    let foreign = vec![crate::cross_file::types::NseDeclaration {
        name: "nrow".into(), package: None,
        scope: crate::cross_file::types::NseScope::Formals(vec!["captured".into()]), line: 0,
    }];
    let analysis = NseAnalysis::build(root, code, true, true, vec![], None, None, None, &[], &[], &foreign, &[]);
    // Locate the `undefined_b` identifier node (walk descendants; match node text).
    let usage = find_identifier_node(root, code, "undefined_b").expect("node");
    assert!(nse_hint_for_usage(usage, code, &analysis).is_none(),
        "a governing foreign directive must suppress the add-# raven: nse hint");
}
```

Add `find_identifier_node(root, text, name) -> Option<Node>` to the test module if absent: a recursive descent returning the first `identifier` node whose `node_text(n, text) == name`. (Mirror any existing descend helper; otherwise a short manual walk.)

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

- [ ] **Step 4: Update the backend code-action** (`backend.rs` ~5734) to feed own+foreign governance. **CRITICAL: keep the existing `d.name == bare` callee-name filter** — the current code (`backend.rs:~5764`) filters `nse_decls.iter().filter(|d| d.name == bare)` before calling `nse_directive_governs`; dropping it would let an unrelated callee's directive suppress this quick-fix. So the governing set must retain each declaration's NAME. Build a combined `Vec<NseDeclaration>` (own + foreign) once when an undefined diagnostic is present, and filter by name inside the per-diagnostic loop exactly as today:

```rust
// Own + foreign governing declarations, so the lightbulb stays in lockstep with
// the foreign-aware hint (issue #460). `false`/`true` is the file_level flag.
// Build once (only when an undefined diagnostic exists); keep full NseDeclarations
// so the per-diagnostic loop can still filter by `d.name == bare`.
let governing: Vec<(crate::cross_file::types::NseDeclaration, bool)> =
    if params.context.diagnostics.iter().any(&is_undefined) {
        let mut v: Vec<_> = state
            .get_enriched_metadata(&uri)
            .map(|m| m.nse_declarations.iter().cloned().map(|d| (d, false)).collect::<Vec<_>>())
            .unwrap_or_default();
        if let Some(snapshot) = handlers::DiagnosticsSnapshot::build(state, &uri) {
            let foreign = handlers::collect_cross_file_nse(&snapshot, &uri);
            v.extend(foreign.nse.into_iter().map(|d| (d, true)));
        }
        v
    } else {
        Vec::new()
    };
```

Then the existing governance check (`backend.rs:~5762`, the `if nse_directive_governs(... d.name == bare ...)` block) becomes — preserving the name filter and passing the `file_level` flag to the new 3-tuple signature:

```rust
if handlers::nse_directive_governs(
    governing.iter()
        .filter(|(d, _)| d.name == bare)
        .map(|(d, file_level)| (d.package.as_deref(), d.line, *file_level)),
    call_pkg,
    fix.insert_line,
) {
    continue;
}
```

Make `collect_cross_file_nse`, `CrossFileNse`, and `DiagnosticsSnapshot` reachable from `backend.rs` (they live in `handlers`; mark `pub(crate)` as needed — `DiagnosticsSnapshot` and its `build` are already `pub(crate)`). `DiagnosticsSnapshot::build` is already called from `backend.rs`/`handlers` synchronous paths, so calling it here in `code_action` is acceptable. **Fallback (spec §4.7):** if threading the snapshot here is undesirable, keep own-only governance (drop the foreign `extend`) and leave a `// #460: foreign code-action governance is best-effort` note — re-declaring a local `# raven: nse` is harmless, never conflicting.

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

Add the remaining matrix rows (B1 landed in Task 5). All use the `diag_messages_for(&[(name, code), …], query)` harness from Task 5 Step 3 (`documents.insert` + `cross_file_graph.update_file` per file, then the existing `diagnostics(...)` entry point). The undefined-variable message is `"Undefined variable: <name>"`.

**Files:**
- Test: `crates/raven/src/handlers.rs` test module

All rows use the builtin callee `nrow` for whole-call cases (Testing discipline); `myverb` only where a per-formal `uncaptured-arg-reported` discriminator is used (B6).

- [ ] **Step 1: B2 — descendant declares, ancestor calls.**

```rust
#[test]
fn nse_directive_propagates_from_sourced_child_to_parent() {
    let msgs = diag_messages_for(
        &[
            ("parent.R", "source(\"child.R\")\nnrow(undefined_var)\n"),
            ("child.R", "# raven: nse: nrow\n"),
        ],
        "parent.R",
    );
    assert!(!msgs.iter().any(|m| m.contains("undefined_var")), "got: {msgs:?}");
}
```

- [ ] **Step 2: B3 — transitive (≥2 edges), both directions.** Chain `a.R` sources `b.R` sources `c.R`. Test 1: `# raven: nse: nrow` in `a.R`, `nrow(undefined_var)` in `c.R` (query `c.R`). Test 2 (mirror): directive in `c.R`, call in `a.R` (query `a.R`). Assert no `undefined_var` message in each.

- [ ] **Step 3: B4 — shared sourced helper.** `a.R` and `b.R` each `source("h.R")`; `# raven: nse: nrow` in `h.R`; `nrow(undefined_var)` in both `a.R` and `b.R`. Two queries (`a.R`, `b.R`); assert suppressed in both.

- [ ] **Step 4: B4b — sibling via shared parent.** `main.R` = `source("setup.R")\nsource("analysis.R")\n`; `setup.R` = `# raven: nse: nrow\n`; `analysis.R` = `nrow(undefined_var)\n`. Query `analysis.R`; assert suppressed (setup ∈ descendants(main), main ∈ ancestors(analysis), so setup ∈ S(analysis)).

- [ ] **Step 5: B5 — negative (unconnected).** `a.R` = `# raven: nse: nrow\n`; `b.R` = `nrow(undefined_var)\n`; no `source()` between them. Query `b.R`; assert the diagnostic IS reported: `assert!(msgs.iter().any(|m| m.contains("undefined_var")))`. (Uses `nrow` so the baseline reports — with an unresolved callee this would suppress for free and the assertion could never hold.)

- [ ] **Step 6: B6 — per-formal cross-file.** `helper.R` = `# raven: func myverb(data, expr)\n`; `main.R` = `source("helper.R")\n# raven: nse: myverb(expr)\nmyverb(real_df, undefined_expr)\n`. Query `main.R`; assert `Undefined variable: real_df` IS present and `Undefined variable: undefined_expr` is NOT.

- [ ] **Step 7: B7b — cross-file ordering.** Variant of B6 with the `# raven: func` in a connected file and the `library()` placed after the `# raven: nse` line; assert suppression unchanged. (B7a within-file ordering is already covered by #455 tests; add one explicit within-file regression only if `rg -n "before or after" crates/raven/src/handlers.rs` shows none exists.)

- [ ] **Step 8: B8 — revalidation.** This needs the mutate-then-rediagnose pattern (see `handlers.rs:~52466-52505`), so write it as a `#[test]` building `WorldState` directly rather than via `diag_messages_for`:
  1. Insert `parent.R` = `source("child.R")\nnrow(undefined_var)\n` and `child.R` = `# raven: nse: other\n` (a directive that does NOT govern `nrow`); `update_file` both.
  2. `diagnostics(&state, &parent, &DiagCancelToken::never())` → assert `Undefined variable: undefined_var` IS present (nrow is a builtin → checked; the unrelated directive does not suppress it).
  3. Edit child: `let new_child = "# raven: nse: nrow\n"; state.documents.insert(child.clone(), Document::new(new_child, None));` then `state.cross_file_graph.update_file(&child, &crate::cross_file::extract_metadata(new_child), Some(&ws), |_| None);`.
  4. `diagnostics(&state, &parent, ...)` again → assert the diagnostic is now SUPPRESSED. (`diagnostics` rebuilds the snapshot, re-collecting foreign NSE — this proves end-to-end suppression-after-edit. Task 1's hash test separately proves dependents are *triggered* in the production incremental path.)

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
- Foreign tier 3.6 (OD5) → Task 3 Step 5. Own-first formal order (findings #3/#7) → Task 3 Step 3 + Task 4. FormalOrderTracker (round-2 #6) → analyzed in Task 4 as a no-op (foreign tier is shadowed by local defs; gate unchanged), pinned by the Task 4 precedence test. Hint/code-action (#7/#10) → Task 6 (backend keeps the `d.name == bare` filter). Determinism/collapse (#2, OD3) → Task 5. Snapshot-bounds (round-2 BLOCKER) → Task 5 collector computes over `snapshot.cross_file_graph` and skips members absent from `metadata_map`.
- L1 (no cross-file real-def formal order) — intentionally not implemented; documented (Task 8) and asserted indirectly by B6 using `# raven: func`.
