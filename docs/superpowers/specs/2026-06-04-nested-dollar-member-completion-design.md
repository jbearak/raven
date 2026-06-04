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
3. Treat `$`, `@`, and `[["literal"]]` chain segments uniformly and at full
   parity across both surfaces — a chain may mix them at any position.
4. Reflect reassignment: members come from the value that is **live at the
   cursor**, so a whole reassignment of an intermediate value replaces its
   earlier members rather than unioning with them.

Surfaces in scope: **completion + go-to-definition** (they share the core
resolver). Hover is out of scope — it is not wired to this resolver today.

Out of scope (unchanged from Step 1):

- Aliasing (`x <- alpha$beta; x$…`).
- Function-return inference (`alpha <- make_thing()`).
- S4 slot / R6 field declarations as a structure source.
- Package-data introspection (`pkg::dataset$col`).
- Navigating to / completing the string-literal position *inside* a `[["…"]]`
  subscript (neither surface does this today); `[["…"]]` is supported only as a
  container-path segment.

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

## Building the path (one shared spine-walker)

Both surfaces build the container path with a single shared routine that walks
an `extract_operator` / `subset` / `subset2` node's **left-spine**, collecting
one `Segment` per `$`/`@`/`[["literal"]]` step until it bottoms out at the head
`identifier`. Any non-static step — a computed index (`alpha[[i]]`), a call
(`f()$x`), or a non-literal subscript — makes the walker bail to `None`. This
shared walker is what gives full `$`/`@`/`[["…"]]` parity on both surfaces.

- **Go-to-definition** already hands the resolver the `lhs_node` AST node
  (`extract_operator_rhs`, `handlers.rs`); feed it straight to the spine-walker.

- **Completion** keeps `detect_dollar_member_completion_context` for the part
  tree-sitter parses poorly — locating the trigger `$`, the typed prefix, and
  the replace range from text (the incomplete trailing token). But the
  **container path** is taken from the AST: descend to the node ending just
  before the trigger `$` (the LHS subexpression, e.g. `alpha[["beta"]]` in
  `alpha[["beta"]]$gam`) and hand it to the same spine-walker. The LHS of a
  trailing `$` is a complete subexpression even though the `$` itself parses to
  an error node, so this is robust. If the AST descent fails (an unbalanced or
  mid-edit LHS), bail to `None` rather than guessing.

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
   the target spine is a prefix of the container path (down to and including the
   path itself) and the RHS is an allowlisted constructor; descend the remaining
   segments and enumerate named args at the terminal. This is shape 1's matcher
   feeding shape 2's enumerator.

These three shapes are the *site inventory*, not the final answer. Shapes 2 and
3 produce **establishing sites** (whole-value writes); shape 1 produces
**member-extension writes**. The next section decides which establishing site is
live and which extensions sit after it — the combination is not a naive union.

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

Beyond the wider matcher, the one genuinely new phase is the establishing-site
cutoff (next section), which reuses this same ordering rather than introducing
its own.

## Safety — false positive eliminated by construction

An intermediate segment is never reinterpreted as a free variable. The path is
either fully static (head resolves in scope; every segment is a literal
`$`/`@`/`[["lit"]]`) or the resolver bails to an empty result. This kills the
`beta`-collision case: `alpha$beta$` resolves `alpha`, not `beta`, so an
unrelated top-level `beta` can never leak its members. Head unresolved, head
resolving to a `package:` symbol, or any non-static segment → empty result,
matching goto-def's existing safe degradation.

## Reassignment semantics — the establishing-site cutoff

Members must reflect the value that is **live at the cursor**. At depth-1 this
already works: scope resolves the head to its latest binding before the cursor,
and constructor descent reads only that binding. The Step-2 generalization
extends the same "latest write wins, and it replaces what came before" rule to
intermediate prefixes.

For a container path `P = head + segments`, resolve members in two phases:

1. **Find the establishing site** — the latest write, visible at the cursor,
   that (re)establishes the *whole* value at `P`. Candidates are:
   - the head's resolved scope binding (descended along `segments`), and
   - any assignment whose target spine is a **prefix** of `P` longer than the
     head (`alpha$beta <- …` when resolving `alpha$beta$…`; a write to a shorter
     prefix re-establishes everything below it).

   The latest is chosen with the same ordering the resolver already trusts —
   effect position with per-file visible cutoffs, then dependency-graph
   distance, then contributor order. "Descend to `P`" follows the write's RHS
   through allowlisted-constructor named args; if a step is opaque (a call, a
   bare identifier), `P` has no statically known members *at that site*, but the
   site still counts as the establishing cutoff.

2. **Enumerate members of `P`** as the union of:
   - named arguments of the constructor reached at the establishing site, and
   - member-extension writes to exactly `P` (`P$m <- …`, `P[["m"]] <- …`) whose
     effect is **after** the establishing site and at or before the cursor.

   Per-name collisions within the union resolve by latest-effect-wins, as today.

The phase-1 cutoff is what delivers delete semantics:

```r
alpha <- list(beta = list(gamma = 1))
alpha$beta <- list(delta = 2)   # latest establishing site for alpha$beta
alpha$beta$                     # offers `delta` only — `gamma` was replaced
```

The earlier `list(gamma = 1)` is an *earlier* establishing site, so it is below
the cutoff and excluded. A subsequent `alpha$beta$epsilon <- 3` is added (it is
after the cutoff).

**Residual cross-file imprecision.** Ordering establishing sites that live in
*different files* relies on the contributor-chain / visible-cutoff ordering —
the same basis `pick_winner` already uses for cross-file member selection. No
new class of imprecision is introduced; the worst case for a pathological
cross-file whole-prefix reassignment is the same coarse ordering the depth-1
cross-file path already accepts.

## Testing

`qualified_resolve.rs` already has a substantial test module; extend it.

- Each discovery shape at depth-2 and depth-3.
- `[["literal"]]` interior chain segments on both surfaces (`alpha[["beta"]]$`,
  `alpha$beta[["gamma"]]$`) and mixed `$`/`@`/`[[…]]` chains.
- The false-positive regression: the `beta`-collision must yield only
  `alpha$beta`'s members.
- Reassignment delete semantics: a whole reassignment of an intermediate value
  excludes its earlier members and keeps later extensions (`gamma` gone,
  `delta` + `epsilon` present).
- Cross-file nested: structure declared in a sourced file and extended in the
  cursor file; plus position-awareness (a member assigned below the cursor is
  not offered).
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
  shared left-spine path-builder, the generalized collectors, the
  establishing-site cutoff, reused winner selection.
- `crates/raven/src/handlers.rs` — `detect_dollar_member_completion_context`
  reduced to locating the trigger `$` / typed prefix / replace range, then
  seeding the shared spine-walker from the LHS AST node (the same walker
  goto-def uses).
- The three doc files above.

No new modules. No changes to scope resolution, the dependency graph, or the
diagnostics gate.
