# Nested `$`/`@` member completion and go-to-definition (Step 2)

Date: 2026-06-04
Status: Draft for review

## Problem

Raven resolves the RHS of a single `$`/`@` access — it completes `beta` in
`alpha$beta` and jumps to its definition. It does **not** handle chained access
like `alpha$beta$gamma`. The original qualified-member work
(`2026-05-02-dollar-rhs-goto-def-design.md`) explicitly deferred this:
"Chained access (`foo$bar$baz` — returns `None`)."

For **go-to-definition** the chained case already degrades safely: the resolver
receives the LHS AST node, sees it is an `extract_operator` rather than an
`identifier`, and returns `None` (`qualified_resolve.rs` rejects
`lhs_node_kind != "identifier"`).

For **completion** it does not degrade safely — it can resolve to the *wrong
variable*. Completion does not use the AST for the LHS; it uses a text scanner,
`detect_dollar_member_completion_context` (`handlers.rs`), which walks back
exactly one identifier before the final `$` and bails only when the character
before that identifier is `:` or `@` — **not** `$`:

```rust
if lhs_start > 0 && matches!(bytes[lhs_start - 1], b':' | b'@') {
    return None;
}
let lhs_name = line[lhs_start..dollar_byte].to_string();
```

So for `alpha$beta$gamma` it extracts `lhs_name = "beta"` and resolves `beta`
as a free variable. If an unrelated top-level `beta` exists, completion offers
*its* members:

```r
beta  <- list(zeta = 1)             # unrelated top-level `beta`
alpha <- list(beta = list(gamma = 2))
alpha$beta$    # completion offers `zeta` — a member of the WRONG variable
```

This is a latent correctness bug, not merely a missing feature.

## Goal

Make completion and go-to-definition for the RHS of a `$`/`@` chain resolve
against the **full container path**, at arbitrary depth:

1. Complete and jump to members of `alpha$beta` (`gamma`), `alpha$beta$gamma`
   (its members), and so on — unbounded depth.
2. Eliminate the wrong-variable completion: an intermediate segment is never
   reinterpreted as a free variable.
3. Keep `$`/`@`/mixed chains working symmetrically.

Surfaces in scope: **completion + go-to-definition** (they share the core
resolver). Hover is out of scope — it is not wired to this resolver today.

Out of scope (unchanged from Step 1, plus one Step-2 limitation):

- Aliasing (`x <- alpha$beta; x$…`).
- Function-return inference (`alpha <- make_thing()`).
- S4 slot / R6 field declarations as a structure source.
- Package-data introspection (`pkg::dataset$col`).
- **Whole-prefix reassignment delete semantics** — see Limitations.

## Why unbounded depth is not extra work

The hard step is generalizing the LHS from a *single identifier* to a *path*.
Today the LHS is modeled as one `lhs_name: &str` in three places — the
completion text scanner, the resolver's `identifier`-only gate, and the member
collectors. Once the LHS is a path and discovery does prefix-matching plus
recursive constructor descent, depth 3, 5, and unbounded are the same loop:
depth is just the number of intermediate segments. Capping at N would be *extra*
code (a length check that discards longer chains) for *less* capability.

## Core model

Today's single-level code is the **base case** of the general one. Everything
keyed on a single `lhs_name` becomes keyed on a **container path** — a head
identifier plus zero or more intermediate segments. Zero intermediate segments
is exactly today's behavior, so the generalization is backward-compatible by
construction.

```
QualifiedPath { head: String, segments: Vec<Segment> }
Segment        { name: String, op: ExtractOp /* Dollar | At */ }
```

For `alpha$beta$gamma` with the cursor / typed prefix on `gamma`:
`head = "alpha"`, `segments = [Segment { name: "beta", op: Dollar }]`, and
`gamma` is the member being resolved or completed. `segments == []` is the
depth-1 case.

## Building the path (two entry points, both already exist)

- **Completion** — `detect_dollar_member_completion_context` (`handlers.rs`)
  currently walks back one identifier. Generalize it to consume a leftward chain
  of `<ident>$` segments, building `head + segments`, and bail to `None` on any
  non-static boundary (`]`, `)`, a computed index). This preserves its
  robustness to the incomplete trailing-`$` case that tree-sitter parses poorly.
  `[["literal"]]` segments inside the chain are a stretch/parity item for
  completion (goto-def gets them free via the AST); the initial completion
  scanner handles `$`-delimited identifier segments.

- **Go-to-definition** — `handlers.rs` already hands the resolver the `lhs_node`
  AST node (`extract_operator_rhs`). Walk that node's left-spine to collect
  segments; the head must bottom out at an `identifier`. Any non-static segment
  → bail (it already returns `None` safely today).

## Discovery — three shapes, each a generalization of an existing collector

The members of the value at a container path are discovered from statically
declared structure. Each shape walks `segments` of arbitrary length.

1. **Path-prefixed assignments.** `member_assignment_candidate_from_extract`
   today requires the assignment target's `lhs` to be an `identifier` matching
   `lhs_name`. Generalize to: the target's left-spine equals `head + segments`
   and the final extract `rhs` is the member. So `alpha$beta$gamma <- …` matches
   container `[alpha, beta]` and yields member `gamma`. The `[["…"]]`
   string-subscript collector generalizes the same way.

2. **Constructor descent.** `collect_constructor_candidates` today finds
   `alpha <- list(…)` and reads top-level named args. Generalize to: find the
   head's defining constructor, descend following `segments` (each must be a
   named arg whose value is itself an allowlisted constructor), then enumerate
   named args at the terminal. So `alpha <- list(beta = list(gamma = …, delta =
   …))` yields `gamma, delta` for container `[alpha, beta]`. The constructor
   allowlist is unchanged (`list`, `c`, `data.frame`, `tibble`, `data.table`,
   `environment`, `list2env`, `new`).

3. **Intermediate constructor assignment.** `alpha$beta <- list(gamma = …)`:
   the target spine equals the container path and the RHS is an allowlisted
   constructor; enumerate its named args. This is shape 1's matcher feeding
   shape 2's enumerator.

## Position-aware and cross-file — reused, not rebuilt

The head (`alpha`) still resolves through the existing position-aware cross-file
scope, so "which binding of `alpha` is live at the cursor" is untouched.

- **Defining-file candidates** keep the same `fn_scope` + effect-after-binding +
  `candidate_effect_visible_in_scope` filters.
- **Cross-file candidates** keep the per-site re-validation that re-resolves the
  **head** at each candidate site (`candidate_lhs_matches_symbol`). Only the
  syntactic site-matcher widens, from "LHS is `alpha`" to "LHS spine-prefix is
  `alpha$beta`".
- **`pick_winner`** (latest-effect-wins → graph distance → contributor order) is
  unchanged and operates per member name.

So cross-file nested resolution costs almost nothing beyond the wider matcher.

## Safety — false positive eliminated by construction

An intermediate segment is never reinterpreted as a free variable. The path is
either fully static (head resolves in scope; every segment is a literal
`$`/`@`/`[["lit"]]`) or the resolver bails to an empty result. This kills the
`beta`-collision case: `alpha$beta$` resolves `alpha`, not `beta`, so an
unrelated top-level `beta` can never leak its members. Head unresolved, head
resolving to a `package:` symbol, or any non-static segment → empty result,
matching goto-def's existing safe degradation.

## Limitations

**Whole-prefix reassignment delete semantics.** A later whole reassignment of an
intermediate value should remove members declared earlier:

```r
alpha <- list(beta = list(gamma = 1))
alpha$beta <- list(delta = 2)   # ideally `gamma` no longer a member
alpha$beta$                     # this design still offers BOTH gamma and delta
```

Discovery unions member candidates and resolves *collisions* with the existing
latest-effect-wins rule, but it does not model a whole-prefix overwrite as
deleting the earlier structure. The result over-offers; it is never the
wrong variable. This is documented and pinned by a test asserting the current
behavior, so a future fix has a baseline.

## Testing

`qualified_resolve.rs` already has a substantial test module; extend it.

- Each discovery shape at depth-2 and depth-3; mixed `$`/`@` chains.
- The false-positive regression: the `beta`-collision must yield only
  `alpha$beta`'s members.
- Cross-file nested: structure declared in a sourced file and extended in the
  cursor file; plus position-awareness (a member assigned below the cursor is
  not offered).
- The reassignment limitation, asserting current (over-offering) behavior.
- Completion integration (handlers/completion tests) and goto-def integration
  for nested paths.
- Non-static bail cases: `f()$x$`, `alpha[[i]]$x$` → empty result.

## Documentation

- `docs/completion.md` — `$ Member Completions`: note nested paths.
- `docs/go-to-definition.md` — nested member jumps.
- The module doc atop `crates/raven/src/qualified_resolve.rs` — the path
  framing and the base-case relationship.
- `docs/superpowers/specs/2026-05-02-dollar-rhs-goto-def-design.md` — add a
  forward reference to this Step-2 spec.

## Edit surface

- `crates/raven/src/qualified_resolve.rs` — `QualifiedPath`/`Segment` types, the
  generalized collectors, reused winner selection.
- `crates/raven/src/handlers.rs` — the two path-builders (completion text
  scanner; goto-def AST left-spine walk).
- The three doc files above.

No new modules. No changes to scope resolution, the dependency graph, or the
diagnostics gate.
