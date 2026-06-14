# Plan: Canonicalize redundant backtick-quoting of syntactic callee/identifier names (#459)

Status: approved for implementation (TDD). Review-hardened after four independent adversarial reviews.

## Problem

At a call/use site, Raven keys resolution on the **raw** tree-sitter `node_text`, which
includes backticks. A redundantly backtick-quoted **syntactic** name such as `` `my_func`() ``
is semantically identical to `my_func()`, yet it misses every lookup keyed on the bare name
`my_func`: the `# raven: nse` / `# raven: func` directives, local-definition shadowing and
formal order, builtin/base/in-play classification, go-to-definition, and find-references. The
result is false "undefined" diagnostics and broken navigation. (Issue #459; discovered while
reviewing PR #457.)

## The critical fact: THREE name-storage conventions (not one)

The naive "both sides converge on one canonical key" assumption is **false**. There are three
conventions, and a single transform is correct for only one of them. They agree **only** for the
syntactic redundant-backtick case (the reported bug); they **diverge for non-syntactic names**,
which is where naive application introduces regressions.

| Seam | Where defs are stored | Storage form | Correct use-site transform |
|------|-----------------------|--------------|----------------------------|
| **A — scope / undefined-existence / goto / find-refs** | `assignment_identifier_name` (scope.rs:3498) | **always bare** (backticks stripped unconditionally) | **unconditional `unquote_backtick_name`** (NOT canonical_use_name) |
| **B — directives** | `callee_name_for_match` (directive.rs:254) | non-syntactic **backtick-wrapped** | **`canonical_use_name`** |
| **C — local NSE policies** | `collect_nse_facts` (handlers.rs ~13334) | **raw** node_text (backticked) | `canonical_use_name` **only if storage canonicalized in lockstep** |

## Core rule

Add ONE shared function in `crates/raven/src/r_names.rs`:

```rust
/// Use-site counterpart to `cross_file::directive::callee_name_for_match` for the
/// DIRECTIVE seam: strip surrounding backticks iff the inner name is syntactic, so
/// `` `my_func` `` matches the bare key directives store, while a genuinely
/// non-syntactic name (`` `my fn` ``, `` `if` ``, `` `.2way` ``) keeps its required
/// backticks. NOT a literal round-trip inverse (it is many-to-one: both `foo` and
/// `` `foo` `` map to `foo`). Contract: `raw` is a BARE callee/identifier only — never
/// a `pkg::` qualifier and never surrounding context. Uses the Unicode-aware
/// `is_syntactic_r_name` (NOT scope.rs's ASCII-only `is_valid_unquoted_r_identifier`).
pub(crate) fn canonical_use_name(raw: &str) -> &str {
    // leading-backtick fast path keeps the hot diagnostic/find-refs loops cheap
    let Some(rest) = raw.strip_prefix('`') else { return raw; };
    match rest.strip_suffix('`') {
        Some(inner) if is_syntactic_r_name(inner) => inner,
        _ => raw,
    }
}
```

## Tasks (implement in order; each ends on green CI gates)

CI gates (AGENTS.md), run from repo root on the pinned toolchain:
- `cargo fmt --all` (never hand-format around it)
- `cargo clippy --workspace --all-targets --features test-support -- -D warnings` (zero warnings)
- `cargo build` / relevant `cargo test`

### Task 1 — `canonical_use_name` + unit tests (foundation)
- Add the function above to `r_names.rs`.
- TDD: write unit tests first. Cases: syntactic strips (`` `f` ``→`f`, `` `foo.bar` ``→`foo.bar`,
  `` `données` ``→`données`); non-syntactic kept (`` `my fn` ``, `` `if` ``, `` `TRUE` ``,
  `` `.2way` ``); bare unchanged (`f`→`f`, `pkg`→`pkg`); edge cases (``, `` ` ``, `` `` ``,
  backslash-in-backticks) unchanged.

### Task 2 — `resolve_call_arg_policy` (Seam B + C), SYMMETRIC
- Canonicalize the identifier-branch `name` AND the `namespace_operator` **bare component**
  (canonicalize `n` before the `pkg::` reassembly; `namespace_parts` ~12725 does not strip).
- Feed canonical key into: nse directive lookups (`BareExact`, `BareInPlayQualified`),
  `local_function_policies`, `local_callee_aliases`, builtin/base/in-play, shiny helper, AND
  **`table_verb_policy`** (handlers.rs:14139/14151 — primary data-mask seam, was missed).
- Canonicalize the **Seam-C storage keys** in `collect_nse_facts` (~13334) in lockstep
  (`local_function_defs`/`local_callee_aliases`/formal order/shadows). Storage and lookup move
  together or not at all.
- TDD tests: `` `my_func`(x) `` under bare `# raven: nse my_func(x)`; `` `my_func`(x) `` picks up
  local def formal order; `` `filter`(df, col) `` data-mask via `table_verb_policy`;
  redundantly-backticked DEFINITION + call still match; `` `my fn` `` still matched via wrapped key.

### Task 3 — func-existence / undefined-call path (Seam B)
- Route the `# raven: func` and undefined-call existence comparison through `canonical_use_name`.
- DO NOT touch the Seam-A unconditional `unquote_backtick_name` fallback (handlers.rs ~5953 and
  ~6013/6051/6088). It already resolves the syntactic case; replacing it with `canonical_use_name`
  would regress non-syntactic locals to false-undefined and fix nothing.
- TDD tests: `` `my_func`() `` not flagged when declared via `# raven: func`; non-syntactic local
  used backticked still resolves.

### Task 4 — go-to-definition + find-references
- Canonicalize the **lookup key** in `qualified_resolve.rs` and the directive-declared goto path.
- In `find_references_in_tree` (handlers.rs ~19940) canonicalize **both** equality operands and
  union bare + backticked occurrences.
- Keep Seam-A scope reads on unconditional unquote. Audit hover (~18270) and signature lookup
  (`completion_context.rs` ~274, `parameter_resolver.rs`): canonicalize the lookup KEY only,
  never the backtick-insertion FSM.
- TDD tests: goto/refs through redundant backticks; non-syntactic symbols still navigable.

### Task 5 — simplification (gated, minimal, characterization-tested)
- Only after Tasks 1–4 green. **Explicitly KEEP**: `callee_name_for_match` (storage half of the
  pair), the formal-label `is_syntactic_r_name` filter (~14545, guards named-arg labels — removing
  it reintroduces the empty-formal-list → whole-call over-suppression bug), `callee_directive_form`
  (user-facing suggestion text), `is_formal_name` (deliberately laxer), `is_well_formed_callee_name`.
- Remove ONLY filters provably made redundant by canonicalization, each behind a golden/
  characterization test proving no behavior change. A near-empty diff is an acceptable outcome.

## Regression tripwires (must stay green)
- `backtick_quoted_base_operators_as_values_not_flagged`
- NSE suite: `nse_phase1_named_label_suppressed_value_checked`, `nse_phase1_aes_whole_call_suppressed`,
  `nse_phase2_local_shadowing_checks_arg`, `nse_phase2_qualified_package_policy`,
  `nse_phase2_namespace_distinction`, `nse_phase2_in_play_package_shadows_base`,
  `nse_phase2_unresolved_callee_suppresses_args`
- directive storage tests (~1763/2039), `is_syntactic_r_name` units
- **ADD**: non-syntactic local-def-used-backticked must NOT flag
  (`` `my fn` <- function(){}; `my fn`() ``) — currently uncovered.

## Out of scope / do not touch
- tree-sitter tree mutation; global `node_text` change; rename replacement spelling; hover/
  diagnostic SPANS; `source()` path string content; completion backtick-insertion FSM;
  `is_well_formed_callee_name` / `declared_name_matches` `::` splitting; `is_builtin`'s internal
  unconditional unquote (correct as-is; builtins are all syntactic).
- Diagnostics-publishing monotonicity is unaffected (pure read transform).
