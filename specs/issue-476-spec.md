# Spec — #476: Cross-file resolver drops top-level symbols from large-closure sourced files

Follow-up to #473. The title blames "traversal caps," but the #472/#473
implementation harness **disproved** that: on `~/repos/worldwide` (242 R files,
release build of merged #477) the budget is never hit (the `raven check` stderr
budget note never fires; zero "Maximum chain depth exceeded" diagnostics), and
the repro still drops symbols with `maxChainDepth = 500` /
`maxTransitiveDependentsVisited = 500000`. **Do not tune caps.**

Diagnosis (via the `diagnose` skill, release binary on `worldwide`) found
**three distinct, independent bugs**. Each was reproduced and its drop point
confirmed by neutralizing it in isolation.

---

## Bug A — Run-to-run non-determinism (highest priority)

### Reproduced
Three identical `raven check . 2>/dev/null | grep -c undefined-variable` on
worldwide → **709 / 711 / 680** (and 694/678/676 on another triple). A single
file checked in isolation (`raven check scripts/compare_modeled_estimates.r`)
is deterministic (0 issues); only the **whole-workspace** result flips. The
flipping set is small per run (e.g. `getPosterior ×2`, `latent.r` `r ×2`) but
varies run to run.

### Root cause
`WorldState::build_dependency_graph_from_workspace` (state.rs:1093-1096)
collects graph-build inputs by iterating `self.workspace_index_new.iter()` and
calls `update_file` in that order. `update_file`/`add_edge`
(dependency.rs:1407-1425) append each incoming edge to `backward[child]` (a
`Vec<DependencyEdge>`), so the **backward-edge `Vec` ordering** is whatever order
files are fed to `update_file`. Cross-file scope resolution preserves and is
sensitive to that order (the parent-prefix walk follows `get_dependents` /
`backward` vector order; first-writer-wins among multiple definers), so the
dropped-symbol set varies run to run.

The feed order is non-deterministic in origin: `workspace_index_new` is a
`WorkspaceIndex` wrapping `RwLock<LruCache<Url, IndexEntry>>`
(workspace_index.rs:126-128), and its `.iter()` follows LRU order, which follows
**insertion order**. Insertions come from `apply_workspace_index` consuming the
`new_index_entries` **`HashMap`** by value (`for (uri, entry) in
new_index_entries`, state.rs:1044) — `HashMap` iteration order — which in turn
was built by the rayon `fold`/`reduce` parallel scan (state.rs:1839-1864). So
the nondeterminism enters at the parallel scan → `HashMap` → LRU insertion
chain, surfacing as `update_file` feed order. (Correction vs. an earlier draft:
the backing store is an LRU cache, not a raw `HashMap`; the fix is unchanged.)

This is NOT the visited-budget `break` (no budget is hit). It is iteration-order
non-determinism in graph construction.

### Fix
Make graph construction order deterministic: sort the collected `entries` by URI
string before the `update_file` loop in `build_dependency_graph_from_workspace`.

```rust
let mut entries: Vec<(Url, Arc<CrossFileMetadata>)> = ...;
entries.sort_by(|(a, _), (b, _)| a.as_str().cmp(b.as_str()));
```

### Verified
With the sort applied, `raven check .` on worldwide is **byte-identical across 5
runs** (md5 of the sorted `undefined-variable` set identical each time).

### Notes / adversarial focus
- The sort is the *correct* layer: deterministic graph construction is a virtue
  regardless of resolution sensitivity. But the underlying order-sensitivity of
  resolution to backward-edge `Vec` order is itself a latent smell — the
  determinism *gate test* (below) is what locks the behavior, not the sort alone.
- Verify there is no *other* non-deterministic iteration in the CLI path. The
  5×-byte-identical result is strong evidence the build order was the sole
  source, but the gate test must assert identical **symbol sets** (not just
  counts) across two runs on a fixed large-closure fixture.

---

## Bug B — Case-canonicalization mismatch (filesystem case-insensitivity)

### Reproduced (tightest)
```r
# zz.r at worldwide repo root:
source("scripts/country_profiles/templates.r")   # lowercase .r
all.values        # flagged Undefined — WRONG (defined at templates.R:27)
templatefinder    # same
template.inputs   # same
```
`raven check zz.r` → 3 false positives, deterministically. Changing the source
string to the on-disk casing `templates.R` → **0 issues**. The file on disk is
`templates.R` (uppercase); `templates.r`/`templates.R` are the same inode on the
case-insensitive macOS FS.

### Root cause
`normalize_path` (path_resolve.rs:362) is purely **lexical**: it resolves
`.`/`..` but never reconciles component casing with the filesystem (despite the
"canonical path" log wording — it is not `fs::canonicalize`). So
`source("…/templates.r")` resolves to a path ending in lowercase `templates.r`
(which `.exists()` accepts on a case-insensitive FS), and `path_to_uri` keys the
dependency edge under `…/templates.r`. But the workspace directory walk
(`scan_workspace` → `collect_files_matching`) indexes the file under its real
directory-entry name `…/templates.R`. The edge target URL never matches the
index key, so scope resolution finds an **empty child scope** for the sourced
file and drops *all* of `templates.R`'s top-level symbols.

Trace evidence: `Adding edge: …/zz.r -> …/templates.r` while the index logs
`Indexing cross-file entry: …/templates.R`.

### Fix
At the two `.exists()`-success return points in `resolve_path_impl`
(path_resolve.rs:243 and :268), rewrite the resolved path's component casing to
the real on-disk entry names, **without resolving symlinks**, correcting only
the components **below a trusted base prefix**.

`canonicalize_case_below(base, full)` keeps `base`'s spelling verbatim and walks
`full`'s remaining components via `read_dir`, replacing each `Normal` component
with the directory entry that matches it (prefer an exact match; else the unique
case-insensitive match; else keep as typed). The `base` is the prefix that
resolution already derived from a trusted source:
- file-relative / working-dir branch (:243): `base = context.effective_working_directory()`;
- workspace-root fallback branch (:268): `base = workspace_root`.

**Why correct only below `base` (Codex M-B1).** The workspace index keys files
under `Url::from_file_path(folder.to_file_path() joined with read_dir names)`
(state.rs:1750-1753, :1574-1619). The index **preserves the workspace-folder
prefix spelling as registered** and never symlink-canonicalizes it. The resolver
derives `base` from the same file/workspace URIs, so `base` already carries the
matching prefix spelling. Case-correcting the prefix too (walking from the FS
root) risks rewriting the prefix to a *different* on-disk casing than the
registered folder URI when a workspace is opened through a differently-cased
path — re-breaking the match. Trusting `base` avoids that and bounds `read_dir`
to the appended source-path depth (1-3 components), cutting cost.

**Why not `std::fs::canonicalize`.** It resolves symlinks, diverging from the
non-symlink-canonicalized index keys. On macOS the system temp dir (`$TMPDIR`,
`/var/...`) is a symlink to `/private/var/...`; `fs::canonicalize` would turn an
index key under `/var/...` into `/private/var/...` and re-break the match (and
break every temp-dir test fixture). `fs::canonicalize` is used in `scan_workspace`
only for directory cycle/skip bookkeeping (state.rs:1555-1561), never for the
indexed file path. Case-only correction keeps the walk's spelling.

On a case-sensitive FS the exact-match branch always wins, so the helper is a
no-op there (and correctly leaves a genuinely-missing `templates.r` unresolved
when only `templates.R` exists).

**Also cover `resolve_system_file` (Codex m-B2).** Its existing-file branches
(path_resolve.rs:447, :458) return `candidate` directly, bypassing
`resolve_path_impl`. `system.file()` sources are resolved before `update_file`
during graph build (state.rs:1106-1115), so a case-mismatched `system.file()`
target would have the same empty-child-scope failure. Apply
`canonicalize_case_below` (base = the `inst`/lib prefix that branch joined onto)
at those return points too, for uniformity. (Not exercised by the worldwide
repro, but cheap and closes the class.)

### Verified
2-file repro → **0 issues**. On the full worldwide check the clusters
`all.values` 110→0, `templatefinder` 20→0, `template.inputs` 9→0.

### Notes / adversarial focus
- **Perf**: `read_dir` per component on every resolved `source()`. Bounded by
  source-path depth (usually 1-3 dirs) and only runs when the file exists.
  Re-run the #472 `cross_file_forward_child_memo` bench and report whole-
  workspace timing; if material, cache directory listings per resolution batch
  or fix only components below a trusted base (the workspace root / file dir,
  which already carry the index spelling).
- This sits in the single resolution chokepoint, satisfying the CLAUDE.md
  invariant that case handling holds uniformly across graph resolution, scope
  resolution, missing-file diagnostics, go-to-definition, and path completion.
- Confirm the missing-file diagnostic path is unaffected (the "file may not
  exist" return at :287 stays lexical — correct, nothing to canonicalize).

---

## Bug C — Parent-prefix leak filter drops genuine forward-sourced symbols in dense hub graphs

### Reproduced
```r
# zz.r at worldwide root:
source("bootstrap.r")
getArray          # flagged Undefined — WRONG
```
`getArray` is a plain top-level def in `scripts/functions/getArray.r`, reached
forward as `bootstrap.r → main.r → scripts/functions.r → …/getArray.r`. Sourcing
`scripts/functions.r` *directly* resolves `getArray` (and 50 of its 52 siblings);
reaching it through the heavily-sourced **hub** `bootstrap.r` (sourced by ~82
files) drops it. Not cap-sensitive (no stderr note at 500/500000), no cycle, no
`depth_exceeded`.

### Root cause
`child_source_symbol_is_leak` (scope.rs:919-926) condition 2 drops a child
symbol when its **name** is in the child's `parent_prefix_symbol_names`:

```rust
symbol.source_uri == *queried_uri || child_parent_prefix_names.contains(name)
```

`bootstrap.r`'s parent-prefix is the over-approximated **union over its ~82
callers'** pre-`source()` scopes (338 names). Because at least one caller has
`getArray` visible before it sources bootstrap, `getArray` lands in bootstrap's
`parent_prefix_symbol_names` — *even though* `getArray` is also genuinely
produced by executing bootstrap (its `source_uri` is correctly `getArray.r`, a
forward descendant). The name collision makes the leak filter classify the
genuine forward-produced binding as "inherited-only" and drop it on the way out
through the forward edge to `zz.r`.

Confirmed by instrumenting `ScopeStream::resolve_source_contribution` (the
diagnostic path): bootstrap's child scope contains `getArray`
(`has_getArray=true`, `source_uri=getArray.r`) AND `getArray_in_pp=true`
(`pp_len=338`). Neutralizing condition 2 makes `getArray` resolve.

The compounding factor: the **identical-binding no-op** at scope.rs:5884-5890.
When bootstrap's own forward source (`functions.r`) re-binds an *identical*
`getArray` (same `source_uri`/position as the one already present from the
parent prefix), the no-op `continue`s and skips the
`scope.parent_prefix_symbol_names.remove(&name)` at :5892. So the name is never
cleared from the parent-prefix set and stays misclassified as parent-prefix-only.

### Fix
Sharpen the parent-prefix set so it reflects only names the child *inherited and
did not itself (re)produce*. In `scope_at_position_with_graph_recursive`'s STEP 2,
record every name a forward source genuinely contributed (passed its own leak
filter and was merged into `scope.symbols`) — **including the identical-binding
no-op case** — into a per-frame `forward_contributed` set. After the forward-
source loop completes, remove those names from
`scope.parent_prefix_symbol_names`:

```rust
scope.parent_prefix_symbol_names.retain(|n| !forward_contributed.contains(n));
```

The `retain` must run after the forward-source loop and **before the function's
final `return scope`** (scope.rs:~6066) so both fresh and memoized callers see
the corrected scope (the memo caches the returned value, scope.rs:1171-1191).

This is safe and minimal:
- Within-frame override semantics are **unchanged**: the no-op still preserves
  the marker *during* STEP 2 so a later sibling/local def can override
  (the :5892 path still runs per-merge for non-identical bindings). The retain
  runs only *after* STEP 2, when all overrides are settled.
- Timeline-defined names are already removed at :5613; this fix covers
  forward-source-reproduced names, which the identical-binding no-op missed.
- Both resolution paths inherit the fix: `ScopeStream::resolve_source_contribution`
  builds the child scope via the same recursive resolver (scope.rs:7750), then
  reads `child_scope.parent_prefix_symbol_names` for its leak filter (:7761).
  With `getArray` removed from that set, the streaming leak filter no longer
  drops it. The recursive STEP 2 merge filter (:5862) likewise benefits.
- Names the child *only* inherited (never reproduced) remain in the set and are
  still correctly filtered out — the legitimate purpose of condition 2 is
  preserved.

### Verified
On worldwide the `getArray` cluster (56) drops to 0 with the retain fix, while
the recursive/streaming equivalence tests
(`test_scope_stream_parent_prefix_override_matches_recursive`,
`test_scope_stream_chain_from_forward_source_matches_recursive`,
`memo_equiv_dense_hub_shared_children`) stay green. (`getPhrase` is a SEPARATE
bug — see Bug D.)

### Notes / adversarial focus
- The equivalence between the recursive resolver and `ScopeStream` is the
  load-bearing invariant. Any change to parent-prefix bookkeeping must keep the
  master equivalence gate (forward-child-memo-disabled comparison) and the two
  named tests green.
- Confirm `forward_contributed` is recorded for symbols that pass `functions.r`'s
  own leak filter and merge into bootstrap — i.e. the set captures the genuine
  cross-file forward bindings, not the leaked ones.
- Watch the interaction with the forward-child memo: the memo caches a child's
  EOF scope (including `parent_prefix_symbol_names`). The retain mutates that
  scope before it is cached, so cached and fresh values stay consistent —
  confirm the memo stores the post-retain scope.

---

## Bug D — `local = TRUE` backward inheritance drops the parent's regular symbols

### Reproduced
Minimal: `parent.r` does `source("defs.r")` then `source("use.r", local = TRUE)`;
`defs.r` has `X <- 1`; `use.r` references `X`. With `local = TRUE`, `X` is flagged
undefined in `use.r`; with plain `source("use.r")` it resolves. Worldwide:
`scripts/reports/profiles.r` sources `init.r` (→ `table_functions.r`, defining
`getPhrase`) then `source("country_tables.r", local = TRUE)` — so `country_tables.r`
should inherit `getPhrase` but doesn't (22 false positives).

### A masking interaction (why it looked package-dependent)
The false positive only *surfaced* once a target set was large enough that
`prefetch_reported_packages` (cli/check.rs:685) warmed the packages
`country_tables.r` attaches (`library(latexpdf/stringr/xtable)`). The undefined
check has a **cold-package suppression** (`package_cache_pending`,
handlers.rs:~6406) that defers function-call-identifier warnings while an
installed package is still uncached. Cold → suppressed (looked resolved);
warmed → reported. So the warming only *unmasked* a pre-existing scope miss; it
is NOT the bug. (This is the "result depends on cache-warming/eval order" anti-
pattern — see Principle below. We do NOT fix it by disabling prefetch.)

### Root cause
`parent_prefix_at` (scope.rs:5067-5221) treats EVERY `local = TRUE` (and
sys.source-non-global) backward edge as `is_local_scoped`, inheriting only
**declared** symbols from the parent ("Requirement 9.4"). But R's `?source`:
`local = TRUE` evaluates the child in the **caller's environment**, which at top
level is `.GlobalEnv`. So a TOP-LEVEL `local = TRUE` child sees ALL the parent's
prior top-level bindings (regular AND declared) — identical to `local = FALSE`.
Only a `local = TRUE` call sited *inside a function* binds the child to a
non-global frame. The blanket declared-only rule is wrong for the (dominant)
top-level case. (Confirmed against `?source` by an independent Codex review.)

### Fix
Restrict the declared-only policy to **function-scoped** local sources. The
`DependencyEdge` doesn't carry function-scope, but `ForwardSource.is_function_scoped`
does (types.rs:311, set by `source_detect`). In `parent_prefix_at`, look up the
parent's `ForwardSource` matching this edge's call site and only set
`is_local_scoped` for `edge.local` when that source `is_function_scoped`:

```rust
let call_is_function_scoped = get_metadata(&edge.from).is_some_and(|meta| {
    meta.sources.iter().any(|s| s.line == call_site_line
        && s.local == edge.local && s.is_sys_source == edge.is_sys_source
        && s.is_function_scoped)
});
let is_local_scoped = if edge.local { call_is_function_scoped }
    else if edge.is_sys_source { /* unchanged non-global check */ } else { false };
```

Top-level `local = TRUE` → `is_local_scoped = false` → inherit all (like
`local = FALSE`). Function-scoped `local = TRUE` → declared-only retained
(conservative; exact function-frame modeling is out of scope and the rarer case).

### Verified
Minimal repro resolves; worldwide `getPhrase` cluster (22) → 0. The forward
child-symbol-leak handling (`should_apply_local_scoping` at scope.rs:5643/7021/7561)
is a SEPARATE concern and is untouched.

### Tests updated (justified by correct R semantics)
`test_cross_file_declared_symbols_inherited_with_local_true` and
`test_auto_mode_local_true_blocks_parent_scope` (renamed
`..._inherits_top_level_parent_scope`) and
`prop_cross_file_declaration_vs_regular_symbol_with_local_true` (renamed
`..._with_top_level_local_true`) all used top-level `local = TRUE` fixtures and
asserted regular symbols are NOT inherited — flipped to assert they ARE.

---

## Cross-cutting principle (from the literature review)

All four bugs reduce to one principle confirmed by compiler/IDE prior art
(rustc `potential_query_instability`; rust-analyzer/Salsa query model; Bazel
hermeticity; clangd dynamic index; soundness-vs-completeness): **a diagnostic
must be a deterministic, pure function of its declared inputs** — invariant to
(1) hash/parallel iteration order [bug A], (2) which other files/packages were
analyzed or cache-warmed first [bug D's masking], and (3) background-indexing
completion order. Caches must *memoize*, never *decide*; ordering must be
canonical at emit points. Bugs A and D's masking are textbook violations; B and
C are correctness misses that the determinism work made reliably observable.

---

## Acceptance criteria (from the issue)

1. The 2-file `templates.r` repro resolves `all.values` / `templatefinder` /
   `template.inputs` to **0** issues. *(Bug B — verified.)*
2. Full `raven check` on worldwide drops the `all.values` (110), `getArray`
   (47–56), `getPhrase` (22), `templatefinder` (20) clusters to **0**. *(All
   verified 0. B clears all.values/templatefinder/template.inputs; C clears
   getArray; D clears getPhrase. `ubf`/`ubu` remain — not in this list; see
   below.)*
3. Resolution is deterministic run-to-run: `raven check` twice → identical
   counts AND identical symbol sets. *(Bug A — verified byte-identical ×5; total
   711 → 361.)*
4. Re-run the #472 `cross_file_forward_child_memo` bench; report whole-workspace
   `raven check` timing on worldwide (cap change is NOT the fix; this grounds the
   case-canonicalization perf cost).
5. Existing cross-file scope tests stay green; add fixtures (below).

## Test plan (new regression tests)

- **A — determinism gate**: a fixed large-closure fixture (hub sourced by many
  files, deep forward closure); run the resolver/diagnostics **twice** and assert
  **byte-identical** diagnostics (symbol set, not just count). Place at a seam
  that builds the full workspace graph (CLI `collect_diagnostics_blocking` or a
  `scan_workspace`-based integration test), since the bug only manifests in the
  whole-workspace build.
- **B — case mismatch**: fixture where a file `source("child.r")` (lowercase)
  resolves a top-level symbol defined in on-disk `child.R` (uppercase). On a
  case-insensitive FS this must resolve; gate it so it is meaningful only where
  the FS folds case (skip/no-op assertion on case-sensitive FS, since two files
  can coexist there). A unit test for `canonicalize_existing_case` covering
  exact-match-preferred, case-insensitive-fallback, and keep-as-typed-on-miss.
- **C — hub forward-source**: fixture mirroring the bootstrap diamond — a hub
  sourced by many files, the hub forward-sources a file defining symbol `X`, and
  one of the hub's callers also has `X` visible before sourcing the hub (so `X`
  enters the hub's parent-prefix). Assert a fresh file that `source()`s the hub
  resolves `X`. Keep the two recursive/streaming equivalence tests green.

- **D — local=TRUE backward inheritance**: top-level `source(child, local = TRUE)`
  child inherits the parent's prior regular symbols (CLI integration test); the
  flipped unit/property tests; function-scoped `local = TRUE` stays declared-only.

All five regression tests added and green
(`test_dependency_graph_build_order_is_deterministic_476`,
`canonicalize_case_below_*` ×5, `case_mismatched_source_resolves_on_case_insensitive_fs_476`,
`hub_forward_sourced_symbol_resolves_when_also_in_parent_prefix_476`,
`top_level_local_true_child_inherits_parent_regular_symbols_476`).

## Out of scope (tracked separately)
- #474 (sp/maptools/rgeos/xtable export resolution)
- #475 (NSE hint over-firing on user-defined functions)
- **`ubf`/`ubu` (~31)**: NOT in #476's formal acceptance "→0" list (listed only as
  symptom clusters). Remaining after A–D. Worth a follow-up: likely the same
  cold-package-suppression masking (bug D's surface) over a genuine resolution
  gap, OR a sibling-ordering case in `scripts/data/births/`. Should be filed
  separately rather than expanding this PR's scope.
