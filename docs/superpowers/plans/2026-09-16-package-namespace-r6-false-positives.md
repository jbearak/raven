# Package namespace and non-portable R6 false positives

Status: PR 1 implementation and review in progress; PR 2 is planned.

## Scope and success criteria

Address the 27 confirmed production-code false positives found after PRs #765
and #766 merged: two in box and 25 in targets. Keep Rhino and box.lsp clean,
including Rhino's application fixtures assembled into their intended layout.
All analysis remains static. No synchronization with a running R session and
no execution of project code to discover bindings.

Deliver two independently reviewable PRs, in order:

1. Package namespace bindings: `.packageName` and the namespace assignment
   through `base::topenv()` used by box. Keep this PR focused on the existing
   package contribution and load-hook extraction paths.
2. Bare member references in non-portable R6 methods, including inheritance
   between package source files as used by targets. Begin this PR with the
   `codebase-design` skill and a dedicated architecture-agent review, after
   the box PR has merged.

Each PR includes its regression tests, documentation, and corpus verification.
No finite test suite can guarantee the absence of regressions. The acceptance
criteria below explicitly check both false positives and false negatives,
editor lifecycle behavior, speed, and memory.

## Reproducible baseline

The audit used Raven 0.21.0 and these upstream revisions:

| Package | Repository | Commit | Diagnostics in `R/` | All repository diagnostics |
| --- | --- | --- | ---: | ---: |
| rhino | Appsilon/rhino | `02031ed6bf4ee4073687569c3321b7191c22b709` | 0 | 9 |
| box | klmr/box | `2eb1430241385747e2f5f75533fedadab4d3c87b` | 2 | 281 |
| box.lsp | Appsilon/box.lsp | `12445f1be9703968aeab405c568cbad324ee6e93` | 0 | 0 |
| targets | ropensci/targets | `06cae18bf0306ee98ce2f6f0a647e26410ddca22` | 25 | 1221 |

The production findings were inspected individually. The larger totals include
test-harness dependencies, loose fixtures, examples, and intentional errors;
they are not counts of confirmed bugs. Existing ignore rules and source
suppressions were honored. The audit's temporary artifacts are under
`/tmp/raven-package-fp-audit-3nrbw4ps/`; implementation must preserve the necessary
reproductions and provenance in the repository rather than depend on that path.

Before changing behavior:

- Turn the minimal namespace and R6 examples into deterministic CLI and editor
  diagnostic tests, and run them to establish that they fail on current main.
  Assertions must compare diagnostic names, locations, and codes, not exit
  status alone: the audit used `--max-severity error`, which still emits warnings.
- Record a structured baseline for the four pinned checkouts. Keep the scanner
  configuration, dependency metadata, ignore policy, and startup environment
  identical between base and candidate. Remove `R_BOX_PATH` in each scanner
  child process; do not mutate the shared test process environment.
- Preserve a small self-contained Rhino app fixture containing namespace and
  attached imports, renamed attachments, and `__init__.R` reexports. Assemble
  upstream fixtures according to Rhino's test setup before judging their
  missing-module warnings.
- Triage the remaining test/example diagnostics by cause. Capture any additional
  confirmed Raven bug as a minimal regression with an explicit scope decision;
  do not classify uninspected findings as accepted real errors or silently
  expand package/test scope to make repository totals zero.

The fast regressions must work offline without the four packages installed.
Use the existing package-corpus harness for repeatable upstream checks, adding
an opt-in selection for these four packages and revision-aware provenance as
needed. Keep fixture classifications specific and evidence-backed. Pin the
acceptance run to the revisions above even if a separate monitoring run follows
upstream HEAD. Existing corpus selections and their expectations must still pass.

## PR 1: package namespace bindings

### Existing implementation and change

`package_state/sysdata.rs` already extracts load-hook bindings into
`RFileFacts.onload_bindings`. `package_state/derive.rs` combines these into
`PackageScopeContribution.onload_symbols`; the shared contribution selector in
`cross_file/scope/contributions.rs` supplies them to scope consumers.

The namespace-expression recognizer currently matches bare `topenv` but not
`base::topenv`. Box uses `ns = base::topenv()` followed by
`ns$system_mod_path = ...` in `R/box-package.r`. Extend the existing recognizer
at that seam, with explicit namespace identity, rather than add a box-specific
name or a separate diagnostic suppression.

1. Model `.packageName` as an implicit package-namespace binding through the
   shared package contribution path. Gate it on active package mode and the
   relevant namespace context. It must not become a Base-7 symbol, an export,
   or a global exemption. Establish positive/negative cases for package source,
   test harnesses, dev-context files, and `load_all()` using their actual
   environments; a directory merely being inside a package is insufficient.
   Keep location-free bindings location-free: do not invent a definition site.
2. Recognize the necessary zero-argument `base::topenv()` alias through one
   exact call-identity helper, preserving the existing bare-call behavior.
   Keep qualified alias tracking separate from the legacy two-pass heuristics
   so existing constructor behavior stays unchanged. Only dollar writes through
   a proven identifier alias are added; the direct qualified replacement form
   is invalid R. Do not strip arbitrary namespace prefixes. Check argument
   shape and namespace provenance before contributing a name.
3. Cover alias lifetime and source order for the newly recognized forms.
   Rebinding an alias to `new.env()` or an unknown value must stop it from
   contributing subsequent assignments. An alias defined after a write cannot
   justify that earlier write. Ignore quoted code and deferred nested functions.
   Keep genuine package hooks distinct from local functions named `.onLoad`.
4. Preserve the existing pure package derivation and open-buffer authority.
   Inputs change through the existing event/derive/install path; no additional
   package-state writer, filesystem scan, or R subprocess is needed.

### Regression coverage

- Positive: `.packageName` in a real package function; box's exact `=`-assignment
  pattern; equivalent `<-` spelling; qualified and supported bare constructors;
  references from another package source file; a package without NAMESPACE.
- Negative: ordinary scripts, package mode disabled, `library(pkg)` in another
  project, similarly named variables, unrelated environment writes, alias
  rebinding, shadowed bare helpers, other-package functions named `topenv`,
  quoted hooks, and assignments inside uncalled nested functions. Confirm a
  neighboring typo still produces its diagnostic.
- Lifecycle: edit/remove the hook assignment, close a modified buffer, change
  package mode, remove/restore DESCRIPTION, and exclude/reinclude the source.
  Check both diagnostic appearance and disappearance in dependent files.
- Run existing sysdata, active-binding, package contribution, imports, test
  preamble, and `load_all()` tests. Preserve synthetic-binding behavior for
  completion, hover, signature help, and go-to-definition.

Acceptance: box's two production warnings disappear; targets still has its
recorded R6 findings; Rhino and box.lsp stay clean. Any other diagnostic change
requires inspection and a test that explains it.

## PR 2: non-portable R6 member scope

### Architecture work before implementation

Apply the `codebase-design` skill to the R6 scope work. Delegate a bounded
design review to an architecture agent while the implementation owner prepares
the failing same-file and cross-file inheritance regressions. The agent should
read the current scope/artifact, package derivation, and revalidation contracts
and recommend where class facts and method bindings belong.

Require the design review to address:

- Whether to deepen the existing scope module or introduce a dedicated R6
  module with a small interface. Treat the module outline below as a proposal,
  not a settled file layout.
- One authority for class identity, member visibility, and inheritance, shared
  by CLI and editor consumers. Avoid a second diagnostic-only scope model.
- Ownership and lifetime of per-file facts and resolved inheritance results;
  invalidation when a base class changes; bounded lookup cost and memory.
- Compatibility with lexical shadowing, package contributions, point and
  streaming scope resolution, and existing R6 pronoun handling.
- Tests through the same interface production callers use, including cases
  that prove real undefined names remain visible to diagnostics.

Record the selected interface, the alternatives considered, and the trade-offs
in this plan before implementing it. Resolve architecture findings first. This
design review supplements the independent post-implementation review loop;
it does not replace the code quality gates below.

### Existing implementation and change

`handlers.rs` recognizes `self`, `private`, and `super` in inline R6 methods,
but does not model bare member bindings. Targets declares its affected classes
with `portable = FALSE`. Most findings refer to members declared in the same
class; others, such as `scheduler` and `seconds_meta_append`, are inherited
from classes in other `R/` files.

1. Add a small shared R6 scope module, with a single implementation of call
   recognition, class facts, and member visibility. Capture compact facts during
   existing analysis: class binding identity, portability, member names/kinds,
   method intervals, and an optional statically identifiable superclass.
   Reuse the existing parser/artifact and package-input lifetimes; do not retain
   a second full AST or reparse every superclass for every identifier.
2. Match `R6::R6Class` explicitly and bare `R6Class` only under the appropriate
   binding/shadowing rules. A local `R6Class` must not shadow a namespace-qualified
   call. Handle named and positional arguments with R's matching rules for the
   supported static forms, including reordered named arguments. Treat omitted
   or literal-true portability as portable. Grant bare members only when false
   is proven; a variable named `F` is not intrinsically a false constant.
3. For proven non-portable classes, expose the statically declared public,
   private, and active members inside the associated methods and their lexical
   closures. Preserve ordinary local/parameter precedence and method default
   argument behavior. Member initializers are evaluated outside the instance
   environment and must not acquire method scope. Unrelated functions and
   neighboring classes must not inherit these names.
4. Resolve static inheritance using class binding identity and the existing
   visibility rules: same-file lexical bindings, eligible package source
   siblings, and supported explicit source relationships. Do not search for a
   same-named class anywhere in the workspace. Use bounded, cycle-safe traversal
   with results shared across queries in a snapshot. Ambiguous, dynamic, or
   unavailable bases contribute no guessed members; independently proven own
   members remain available. Respect known overrides and parent-environment
   constraints. Runtime `$set()` changes, evaluated superclass factories, and
   discovery from a live instance remain outside this static subset.
5. Feed method-scoped bindings through shared scope resolution so point and
   streaming queries agree. Do not inject member names into package globals or
   turn off analysis of whole R6 bodies. Retain existing pronoun behavior and
   genuine undefined/use-before-definition checks under regression tests.
6. Include member/portability/inheritance changes in the relevant change
   detection and invalidation. Reuse package revalidation for package siblings
   and source-graph revalidation elsewhere. Newly added facts must survive cold
   indexing and bounded-cache eviction. Snapshot under locks, compute outside
   locks, and retain existing revision/epoch checks when publishing diagnostics.

### Regression coverage

- Positive: fields, calls to sibling methods, private members, active bindings,
  inherited members across multiple files and multiple generations, nested
  closures, named/positional forms, and the exact targets patterns. Include a
  superclass declared later in a package source file.
- Negative: default/explicit portable classes, unknown portability, a rebound
  `F`, masked constructors/member-list builders, member-value initializer
  expressions, undefined superclasses, class-name collisions, arbitrary
  `list()` calls, out-of-class uses, and genuine misspellings inside methods.
  Verify that an unknown superclass never suppresses every unknown name.
- Scope behavior: local arguments and assignments shadow members; members do
  not leak to callers, other classes, unrelated source files, or package exports.
  Exercise reads and replacement assignments, including targets' indexed
  updates and `<<-` idioms, without treating every assignment as a declaration.
- Lifecycle: rename/remove a base member, change `portable`, switch a superclass,
  create/delete/exclude a base file, close/reopen buffers, and change package
  mode. Confirm inherited diagnostics refresh from authoritative text and stale
  work cannot republish. Test cycles and traversal bounds explicitly.
- Consumers: compare CLI and editor diagnostic sets; retain existing completion,
  hover, signature, definition, and references tests. If new member provenance
  is surfaced, verify it selects the actual member rather than a same-named
  package/global symbol. Synthetic or unresolved facts must not fabricate
  navigation/signature results.

Acceptance: all 25 recorded targets production warnings disappear, box remains
at zero, and Rhino and box.lsp remain at zero. The valid Rhino app fixture must
also remain clean. Deliberately introduced typos must still be diagnosed.

## Performance, documentation, and quality gates

Keep work proportional to parsed declarations and actual inherited relationships,
not identifiers multiplied by all project files. Store/share compact immutable
facts and bounded snapshot-local lookup results. Measure repeated diagnostics,
large classes, deep inheritance, and edit/delete cycles; inspect retained memory
for stale class generations. Reuse existing scope/package benchmarks and add a
focused R6 benchmark where the current suite does not exercise the new work.

Update `docs/r-package-dev.md`, `docs/diagnostics.md`, and relevant limitations.
Document the static R6 subset and namespace-context rules with small examples.
Update `docs/development.md` for any new facts, caches, or invalidation paths.
Put implementation invariants next to the responsible functions. Declare any
new top-level Rust module in `crates/raven/src/lib.rs`.

For each implementation PR, use the pinned Rust 1.96.0 toolchain. Run
`cargo fmt --all` as preparation before reviewing and committing the changes.
Then validate the resulting tree with these read-only gates:

```sh
cargo fmt --all --check
cargo test -p raven --features test-support
cargo test -p tree-sitter-jags
cargo clippy --workspace --all-targets --features test-support -- -D warnings
RUSTDOCFLAGS="-D warnings" cargo doc -p raven --no-deps --document-private-items
RUSTDOCFLAGS="-D warnings" cargo doc -p raven --no-deps --document-private-items --features test-support
```

Run the focused regressions first, then the complete required suites, existing
package corpus checks, and the four-package differential audit. Run relevant
Bun/extension checks if those files change. Inspect the performance comparison
report against the PR base; preserve the CI threshold and investigate noisy or
missing evidence rather than treating a green status alone as sufficient.

Follow the established delivery procedure for each PR:

1. Independent subagent reviews for correctness/regressions, lifecycle and
   speed/memory, and coverage/simplicity. Resolve findings and repeat until all
   reviewers return clean on the final changes.
2. Open the PR with the reproduction, resulting behavior, exact audit deltas,
   supported limits, and validation evidence.
3. Inspect CodeRabbit comments and every required CI gate, including Linux and
   performance. Resolve agreed comments and failures, then repeat the subagent
   review loop after changes.
4. Merge only after the final revision has clean reviews and all required gates
   pass. Begin the second PR from the merged first PR. Do not relax diagnostics,
   accept known false positives, or weaken test/performance thresholds to get
   a passing result.

## Semantic references

- [R6 class parameters and non-portable members](https://r6.r-lib.org/reference/R6Class.html).
- [R6 portable and non-portable environments](https://r6.r-lib.org/articles/Portable.html).
- [R top-level environments](https://stat.ethz.ch/R-manual/R-devel/library/base/html/ns-topenv.html).
- [Box's namespace initialization](https://github.com/klmr/box/blob/2eb1430241385747e2f5f75533fedadab4d3c87b/R/box-package.r#L45).
- [Targets' non-portable queue](https://github.com/ropensci/targets/blob/06cae18bf0306ee98ce2f6f0a647e26410ddca22/R/class_sequential.R#L20).
