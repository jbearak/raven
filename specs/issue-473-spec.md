# Spec — #473: Cross-file traversal caps cause silent false-positive undefined-variable

## Problem (reproduced)

A fixed cross-file traversal budget silently drops `source()` edges in dense
repos, surfacing as false-positive `undefined-variable`. Reproduced with a
synthetic hub workspace (one hub sourcing N children, a bootstrap sourcing the
hub, a `main.r` sourcing the bootstrap and calling all N children):

- `maxTransitiveDependentsVisited = 20`, 60 children → **43 false-positive
  `undefined-variable`** warnings (`getSym_18..60` dropped — *later siblings
  drop first*, matching the issue's "tracks position in the hub's source list").
- Default budget (2000) → **0 issues** (all resolve). So the cap is the sole lever.
- At budget 20, **stderr is empty** — `raven check` gives zero indication the
  budget was hit. The drops are indistinguishable from genuine undefined vars.

Root cause: `DependencyGraph::collect_neighborhood_multi`
(dependency.rs:1542) breaks out of edge iteration when
`visited.len() >= max_visited`, so the *trimmed neighborhood subgraph* the
resolver walks is missing `source()` targets → their symbols are dropped. The
break drops later-enumerated edges first; edge `Vec` order depends on
workspace-scan thread order, hence the issue's run-to-run variation.

The two caps:
- `max_chain_depth` (default **20**) — recursion depth in the resolver AND
  `max_depth` for the neighborhood BFS. Resolver-level exceedances already
  surface as `depth_exceeded` → "Maximum chain depth (N) exceeded" diagnostics
  (handlers.rs:4945), shown in `raven check`. Neighborhood-BFS depth truncation
  is **not** surfaced.
- `max_transitive_dependents_visited` (default **2000**) — node budget for all
  graph traversals (`collect_neighborhood_multi`, `collect_dependents`,
  `collect_dependencies`). Visited-budget truncation is surfaced **only in the
  editor** via `client.show_message` (backend.rs:1922), **never in `raven check`**.

## Requests (from the issue) and resolution

### 1. Re-tune the caps

Raise the defaults so realistic workspaces never hit them, keeping a high
safety valve against pathological graphs (cycles are already guarded; the cap
bounds legitimately huge fan-in graphs). #472's memoization makes the higher
traversal affordable.

- `max_transitive_dependents_visited`: **2000 → 50_000**. The neighborhood is
  naturally bounded by workspace file count; 50k comfortably exceeds any real R
  workspace (worldwide ≈ 200 scripts) while still bounding a runaway graph.
  Per-file diagnostics (the #473 false-positive path) use the **base** cap
  (handlers.rs:248), so 50k means no truncation for any <50k-file workspace.
- `max_chain_depth`: **20 → 64**. Real source chains are shallow, but the
  *bidirectional* neighborhood BFS depth (up to ancestors, back down through
  siblings) can exceed a linear chain; 64 is cheap insurance and keeps depth
  truncation from silently trimming the neighborhood.

**[Codex M3] Bound the package-scope multiplier.** `build_package_scope_snapshot`
scales the budget by open-doc count: `effective_max_visited = max_visited *
docs.len()` capped at `max_visited * 50` (state.rs:763-765). At base 50k that
ceiling is 2.5M. Actual visited nodes stay workspace-bounded, so this is a
ceiling not an operating point — but to keep the multiplier from ever becoming a
latency/memory cliff, add an **absolute ceiling** to that computation (e.g.
`.min(ABSOLUTE_MULTI_SEED_CEILING)` with `ABSOLUTE_MULTI_SEED_CEILING = 200_000`).
This decouples the multi-seed package path from the raised user-facing default.

(Decision: finite cap, not "remove by default" — unbounded traversal risks
pathological blowup; a finite-but-huge cap is strictly safer with no downside
for real repos.)

Update the `Default` doc-comment and the in-crate default-asserting tests
(config.rs:171, 241, 273) and any docs that quote the old numbers.

### 2. Surface budget exhaustion in `raven check`

After the per-target diagnostics loop in `cli/check.rs::run` (the owned `state`
accumulates truncation counters on `state.cross_file_graph` across all targets),
read the counters and emit a one-time note to **stderr** (same channel/pattern
as the missing-export-metadata warning, check.rs:395) when truncation occurred:

```rust
let visited_trunc = state.cross_file_graph.visited_budget_truncations();
let depth_trunc   = state.cross_file_graph.depth_truncations();
if visited_trunc > 0 {
    eprintln!("raven check: a bounded cross-file neighborhood traversal was \
        truncated (max_transitive_dependents_visited = {N}); some `source()` \
        edges were not followed, so some \"Undefined variable\" warnings above \
        may be false positives. Raise `crossFile.maxTransitiveDependentsVisited` \
        in raven.toml to analyze more files.");
}
if depth_trunc > 0 {
    eprintln!("raven check: a cross-file traversal hit the depth limit \
        (max_chain_depth = {N}); ... raise `crossFile.maxChainDepth` ...");
}
```

Notes:
- This is a **summary note**, not per-diagnostic noise; emit at most once each.
- **[Codex m2]** Counters live on the full graph (`cached_neighborhood_subgraph`
  records on `self`, dependency.rs:550), so they persist across the loop;
  extracted/trimmed subgraphs reset their own counters (dependency.rs:~1019) and
  those traversals are NOT counted. Phrase the note as "a bounded *neighborhood*
  traversal was truncated" — do not claim it covers every traversal. Resolver
  depth still surfaces per-site as `depth_exceeded` diagnostics regardless.
- A neighborhood **cache hit** skips re-recording (dependency.rs:~1654), but each
  target file has a distinct neighborhood root so the counter still fires on the
  first computation; we only need `> 0` as a signal.
- Respect `--quiet`? The missing-export-metadata warning is always emitted to
  stderr regardless of `--quiet` (which only suppresses the OK summary line).
  Match that: always emit the budget note to stderr. (Confirm with the `--quiet`
  semantics in render().)

### 3. Expose the caps in raven.toml

**Already implemented** — verify and document:
- `maxChainDepth` parsed at backend.rs:218.
- `maxTransitiveDependentsVisited` parsed at backend.rs:222.
- Both round-tripped by `recompute_parsed_configs` and covered by
  `scope_settings_changed` (config.rs:222/227) so a change triggers
  revalidation.

Gaps to close:
- Confirm `editors/vscode/package.json` exposes both settings (schema), the
  init-options factory passes them, and `SETTINGS_MAPPING` maps them (per
  CLAUDE.md's three-places rule). Add any missing wiring + regenerate the
  settings-reference index (`bun editors/vscode/scripts/generate-settings-reference.mjs`).
- Document both in `docs/settings-reference.md` (auto-generated) and mention the
  dense-repo tuning guidance in `docs/cross-file.md` and/or `docs/diagnostics.md`.

## Acceptance criteria

1. The synthetic dense fixture that currently mis-reports under a low cap
   resolves cleanly under the new defaults.
2. With an artificially low cap, `raven check` emits the budget-exhaustion note
   to stderr (new test in cli/check.rs covering counter > 0 → note printed).
3. Settings round-trip: `maxChainDepth` / `maxTransitiveDependentsVisited` set
   in raven.toml change the effective caps (existing backend tests + a CLI
   integration test).
4. VS Code settings wiring complete in all three places; settings-reference
   drift test green.
5. No regression in existing cross-file / CLI tests.

## Test plan (new tests)

- **CLI budget note**: build a dense fixture in a temp dir, run `check` with a
  config forcing a tiny budget, assert (a) the false positives appear AND (b)
  the stderr budget note is printed; then with the default cap assert 0 issues
  and no note.
- **Default values**: update config.rs default-asserting tests to the new
  numbers; add a test pinning the new defaults so they aren't silently changed.
- **VS Code settings**: extend `editors/vscode/src/test/settings.test.ts` named-
  value coverage for both keys if not already present.

## Risks / adversarial-review focus

1. **Note false-negatives/positives**: counters are cumulative across targets
   and cached; a cache hit won't re-record. We only need `> 0` as a signal, so
   this is fine — but confirm the neighborhood cache doesn't *reset* counters.
2. **Counter attribution**: ensure `visited_budget_truncations` increments are
   genuinely from neighborhood collection during `check`, not spurious. The
   reproduction confirms it fires; pin with a test asserting the counter > 0.
3. **50k cap memory**: a pathological 50k-node neighborhood clones a large
   subgraph per query. Acceptable because real workspaces are far smaller and
   the cap is a safety valve, not an operating point. Document the tradeoff.
4. **Interaction with #472**: higher caps mean more forward re-resolution; #472's
   memoization must land to keep `raven check` performant at the new caps. This
   is why #472 is implemented first.
