# Issue #467 — plyr `*ply` verbs: data-masked `...` forwarded to `summarise`/`mutate`/`transform` (design spec)

**Status:** v2 — reconciled with the implementation after the review passes (§3.2 helper signature/return and the `suppressed_arguments`-vs-`call_argument_suppression` choice; §5 test list expanded to match the shipped tests). The on-function doc comments in the code are authoritative.
**Issue:** #467 "NSE: model plyr *ply verbs' data-masked `...` forwarded to summarise/mutate/transform"
**Builds on:** #466 (`plyr::.()` modeled as a `WholeCall` quoting helper), branch `issue467`
**Verified against:** plyr 1.8.9 + R 4.6.0

---

## 1. Problem and goal

plyr's split-apply verbs have the signature `ddply(.data, .variables, .fun, ...)`,
where `...` are forwarded to `.fun` (plyr calls `.fun(piece, ...)` per slice).
When `.fun` is a **data-masking verb** (plyr `summarise`/`summarize`/`mutate`, or
`base::transform`), those forwarded expressions are evaluated in the data mask of
each slice, so bare names in them are **columns**, not free variables:

```r
# `team` is a column of each year-slice, evaluated by plyr::summarise.
ddply(baseball, .(year), summarise, nteams = length(unique(team)))
```

Today Raven resolves `ddply` as a plain plyr export → `ArgPolicy::Standard` → it
descends into every argument and flags `team` as `undefined-variable`. This is the
same family of false positive as the `.()` one fixed in #466, reached through a
different path (the `...`, not `.variables`).

**Goal:** suppress the `*ply` `...` **iff `.fun` resolves to a data-masking verb**,
while leaving `.data` / `.variables` / `.margins` / `.fun` checked, and leaving
`...` checked when `.fun` is ordinary (so genuine typos are still flagged).

**Non-goal:** `r*ply` (`raply`/`rdply`/`rlply`/`r_ply`) — these take `.n, .expr`
(no `.fun`); `.expr` is evaluated in the caller frame, not a data mask, so they
stay standard-eval (unmodeled), exactly as today.

## 2. Empirical facts (plyr 1.8.9 / R 4.6.0)

Formal orders, grouped by leading shape:

| Family | Verbs | Formals (prefix) | `.fun` position |
|--------|-------|------------------|-----------------|
| `a*ply` | `aaply` `adply` `alply` `a_ply` | `.data, .margins, .fun, ...` | 3rd |
| `d*ply` | `daply` `ddply` `dlply` `d_ply` | `.data, .variables, .fun, ...` | 3rd |
| `l*ply` | `laply` `ldply` `llply` `l_ply` | `.data, .fun, ...` | 2nd |
| `m*ply` | `maply` `mdply` `mlply` `m_ply` | `.data, .fun, ...` | 2nd |
| `r*ply` | `raply` `rdply` `rlply` `r_ply` | `.n, .expr, .progress, ...` | — (excluded) |

Post-`...` control formals differ per verb (`.progress`, `.inform`, `.drop`,
`.parallel`, `.paropts`, `.expand`, `.id`, `.print`, `.drop_i`, `.drop_o`,
`.dims`) and are matched by name only; their exact order past `...` does not
affect matching.

Data-masking verbs usable as `.fun`:
- `plyr::summarise` = `plyr::summarize` (identical objects) = `(.data, ...)` — `...` data-masked.
- `plyr::mutate` = `(.data, ...)` — `...` data-masked.
- `transform` is **base R** (`base::transform`, not exported by plyr); already
  modeled in `base_policy` as `per_formal(["_data", "..."], [], captured_dots: true)`.

Confirmed empirically that `summarise`/`mutate`/`transform` as `.fun` evaluate
`...` against each slice's columns.

## 3. Approach (decisions locked with the maintainer)

**Detection rule — policy-driven (`captured_dots`).** Resolve `.fun` shadow-aware
through the existing call-site machinery and treat it as data-masking **iff its
resolved NSE policy is `PerFormal { captured_dots: true, .. }`**. This reuses the
existing resolution so it cannot drift from the call-site matching rules (the
issue's stated preference), and it is safe-direction: a verb that data-masks via a
named/positional formal but not `...` (e.g. base `subset`) is *under*-suppressed
(a possible false positive), never over-suppressed. The set it admits —
`summarise`/`summarize`/`mutate`/`transform`, plus `filter`/`with`/etc. when those
are the `.fun` — is exactly the set whose forwarded dots are genuinely data-masked.

**Family scope — all 16** (`a*ply`/`d*ply`/`l*ply`/`m*ply`), excluding `r*ply`.
Uniform mechanism, no confusing gaps.

**Architecture — hybrid (mirrors the existing wrapper-dots upgrade at
`handlers.rs` ~13301).** A static base policy in `package_policy` plus a
call-site `captured_dots` upgrade in `resolve_call_arg_policy`:

### 3.1 `nse.rs` — `package_policy`

1. Add plyr data-masking verbs so they resolve both as direct calls and as `.fun`:
   - `summarise` | `summarize` | `mutate` → `per_formal(&[".data", "..."], &[], true)`.
   - (Side benefit: fixes direct `summarise(df, x = mean(y))` false positives in
     plyr-only files, where `summarise` previously resolved as a no-policy export →
     `Standard`.)
2. Add the 16 `*ply` verbs → a **base** `PerFormal` carrying the empirically
   verified formal order, `captured: []`, `captured_dots: false`. With nothing
   captured this is behaviorally identical to `Standard` (every arg checked) —
   the base policy exists only to (a) supply the formal order so the call-site
   step can locate `.fun`/`...` by R's matching rules, and (b) mark the call as a
   recognized `*ply` for the upgrade.
3. Expose a predicate `pub(crate) fn is_plyr_split_apply_verb(name: &str) -> bool`
   (the 16 names) so `handlers.rs` can recognize the family without restating it.

### 3.2 `handlers.rs` — `resolve_call_arg_policy`

After a callee resolves to a `*ply` policy via `table_verb_policy` (both the
namespace `plyr::ddply` branch and the bare-identifier branch), call a new helper
`upgrade_plyr_ply_dots(call_node, name, text, analysis, policy: ArgPolicy) -> ArgPolicy`
(it returns the **base `policy` unchanged** when no upgrade applies, rather than an
`Option`):

1. Gate on `is_plyr_split_apply_verb(name)`.
2. Locate the argument bound to `.fun`. Reuse the existing matching by building a
   probe policy `PerFormal { formals: <ply formals>, captured: vec![".fun"], captured_dots: false }`,
   collecting the call's argument labels and running `crate::nse::suppressed_arguments(&probe, &labels, pipe_fed)`
   directly (NOT the `call_argument_suppression` wrapper — that wrapper
   force-suppresses any argument literally named `subset`, which would misidentify
   `.fun` if a user passed a `subset =` argument that `*ply` forwards through
   `...`), then taking the node whose mask bit is set.
   `pipe_fed = call_is_pipe_fed(call_node, text)` so `baseball %>% ddply(.(g),
   summarise, …)` locates `.fun` correctly. This cannot drift from R's
   named-then-positional matching because it is the same primitive the suppression
   mask uses.
3. Resolve that `.fun` value node's verb policy **shadow-aware**:
   - identifier in `local_function_policies` → that policy (covers a local wrapper
     whose dots were upgraded to `captured_dots: true`);
   - identifier in `local_callee_aliases` → resolve the alias (qualified →
     `package_policy`; `Unknown` → not data-masking);
   - identifier in `local_callee_shadows` but not the above → opaque local binding
     → not data-masking (safe direction);
   - otherwise → `table_verb_policy(value, text, analysis)`.
4. If the resolved policy is `PerFormal { captured_dots: true, .. }`, return the
   `*ply` policy with `captured_dots: true`; otherwise return the base `policy`
   unchanged (leave the `...` checked).

`.data`/`.variables`/`.margins`/`.fun` are never in `captured`, so they stay
checked; for `d*ply` the `.variables` `.()` call suppresses its own quoted columns
exactly as in #466.

### 3.3 Precedence interaction (unchanged)

A local `ddply <- function(...)` (step 1) or an own `# raven: nse ddply` directive
(step 0) is resolved *before* `table_verb_policy`, so the upgrade only fires when
`ddply` genuinely resolves to plyr's export. The upgrade is purely additive on top
of the existing `table_verb_policy` result.

## 4. Known limitations (documented, safe-direction)

- **One level deep.** The `.fun` resolution mirrors the existing wrapper inference:
  a `.fun` that is a deeply-nested or opaque computed value is not chased. A local
  `.fun` is honored via `local_function_policies` (so a `function(d, ...)
  summarise(d, ...)` wrapper used as `.fun` is recognized), but second-order
  indirection is not.
- **Data-masking-via-named-formal verbs** (e.g. `subset` as `.fun`) are *not*
  recognized (they have `captured_dots: false`), so their forwarded columns stay
  checked — a possible false positive, never a hidden bug.
- **Control-arg values.** Post-`...` control args (e.g. `.paropts = list(...)`)
  passed when `.fun` is data-masking may have their value suppressed if not listed
  among the verb's formals; the per-verb formal lists include the control formals
  to avoid this for the common cases.
- `r*ply` stays unmodeled (no `.fun`).

## 5. Testing

Unit (`nse.rs`):
- `package_policy("plyr", "summarise"|"summarize"|"mutate")` → `PerFormal`,
  `captured_dots: true`.
- Each of the 16 `*ply` verbs → `PerFormal`, `captured: []`, `captured_dots: false`,
  with `.fun` and `...` in the formals at the verified positions.
- `is_plyr_split_apply_verb` true for the 16, false for `r*ply` and `.`.
- Update the #466 table-shape assertions (`("plyr","ddply",None)` → `PerFormal`;
  `plyr_dot_is_whole_call_quoting_helper`'s `ddply`/`llply` `is_none()` lines).

End-to-end (`handlers.rs`, mirroring the #466 synthetic-package harness):
- **Positive:** `ddply(df, .(year), summarise, nteams = length(unique(team)))` —
  `team` NOT flagged; an undefined `.data` arg IS flagged (scoping boundary);
  a `totally_undefined_baseline` IS flagged (collector-ran sentinel).
- **Negative:** `ddply(df, .(g), nrow, extra = undefined_typo)` (ordinary `.fun`) —
  `undefined_typo` IS flagged.
- `transform` as `.fun` (positive) to exercise the base-table resolution path; an
  `l*ply` shape (`.fun` 2nd positional) to pin the differing formal position.
  (`mutate` shares the identical `package_policy` arm as `summarise` and is pinned
  by the unit test, so a dedicated `mutate` end-to-end case is redundant.)
- A locally-shadowed verb name as `.fun` (`summarise <- function(x) nrow(x)`;
  `ddply(df, .(g), summarise, undefined_typo)`) — `undefined_typo` IS flagged
  (shadow beats the package policy).
- A pipe-fed call (`some_df %>% ddply(.(g), summarise, …)`) and a qualified
  `plyr::summarise` `.fun` (positive).
- A named control formal staying checked under a data-masking `.fun`
  (`ddply(df, .(g), summarise, .drop = bad_typo, …)`) — `bad_typo` IS flagged
  (the control-formal listing is load-bearing) while the data-masked `...` column
  is suppressed.
- `.fun` supplied by name (`ddply(df, .variables = .(g), .fun = summarise, …)`) —
  exercises the named-matching pass.

## 6. Docs

- `docs/diagnostics.md` — extend the NSE coverage sentence (the same line #466
  touched) to note the plyr `*ply` `...`-forwarding model.
- `crates/raven/src/nse.rs` module doc — add the `*ply` family to the coverage
  list and the empirical-verification note.
