# Bioconductor Tidy-Omics NSE Policy Design

Date: 2026-06-07  
Issue: #403

## Goal

Survey the tidy-omics / grammar-of-genomics Bioconductor packages named in #403 and add NSE policy-table entries only for behavior verified against installed R packages. The target packages are `plyranges`, `tidybulk`, `tidySummarizedExperiment`, and `tidySingleCellExperiment`.

The change should reduce undefined-variable false positives for dplyr/tidyr-style data-masking over Bioconductor objects, especially attached-generic examples like `library(plyranges); filter(gr, start > 100 & seqnames == "chr1")`, without suppressing evaluated arguments that should still report real undefined-variable bugs.

## Non-Goals

- Do not survey all Bioconductor packages.
- Do not guess from package names or dplyr-like naming alone.
- Do not add broad whole-call suppression for wrappers unless R behavior proves every meaningful argument is captured.
- Do not change the general undefined-variable diagnostic pipeline.

## Architecture

Keep `crates/raven/src/nse.rs` as the single source of truth for built-in NSE argument policies. The empirical result determines the representation:

- If a Bioconductor package exports its own NSE verb, add explicit handling through `package_policy(package, name)`.
- If a Bioconductor package instead attaches existing dplyr/tidyr generics and contributes object-specific S3 methods, route bare calls to the attached generic owner's existing policy through `meta_package_members`.

Do not add `package_policy` aliases for namespace-qualified spellings that R does not export.

Existing helpers such as `dplyr_policy`, `tidyr_policy`, and `tibble_policy` remain unchanged unless probing proves a Bioconductor export is a true re-export whose formals and behavior are safely identical. Current verified packages use attached dplyr/tidyr generics rather than package-qualified exports, so bare calls under `library(plyranges)`, `library(tidySummarizedExperiment)`, and `library(tidySingleCellExperiment)` route to the existing generic-owner policies. `loadNamespace("pkg")` must not trigger that attached-generic routing because it does not attach bare names to the search path.

Policies stay conservative:

- Data object arguments are checked.
- Data-masked, tidy-selected, or captured column/accessor arguments are suppressed.
- Literal controls, functions, environments, and other evaluated arguments are checked.
- Functions that evaluate normally receive no policy entry.

## Verification Data Flow

R is the source of truth for this work.

1. Install `BiocManager` and the full package set from #403: `plyranges`, `tidybulk`, `tidySummarizedExperiment`, and `tidySingleCellExperiment`.
2. For each candidate verb, record `formals()`, the exported owner, and whether `pkg::name` is a package-local wrapper or a re-export/imported function.
3. Probe captured-vs-evaluated formals with unique sentinels.
4. For data-mask cases, verify representative bare columns or accessors resolve inside an appropriate object. For `plyranges`, this must include range accessors such as `seqnames`, `start`, `end`, `width`, or `strand` where exported behavior supports them.
5. Translate only confirmed behavior into either `ArgPolicy::per_formal` / `ArgPolicy::WholeCall` entries for real package exports, or attach-gated `meta_package_members` expansion for packages that attach existing NSE generics.
6. Record excluded cases in comments or the PR summary when they look NSE-like but evaluate normally.

If installation or probing fails for any of the four requested packages, stop rather than landing partial guessed policy. The selected scope is the full issue scope.

## Tests

Add Rust unit tests in `crates/raven/src/nse.rs` that pin representative behavior:

- Meta-member tests for packages that attach existing dplyr/tidyr generic owners.
- End-to-end tests showing `library(pkg)` suppresses masked columns through the attached generic policy.
- End-to-end tests showing `loadNamespace("pkg")` does not attach the generic policy.
- Negative package-policy tests for invalid namespace-qualified spellings such as `plyranges::filter`.

The tests should exercise policy-table behavior, not R subprocess probing. The empirical R probe is a development input; the checked-in behavior is the resulting curated policy table.

## Documentation

Update `docs/diagnostics.md` if the final verified entries expand the user-facing NSE coverage meaningfully. Mention Bioconductor/tidy-omics data-masking coverage only for packages actually verified and implemented.

No README change is planned unless the implemented behavior is broad enough to deserve top-level mention.

## Validation

Before opening the PR, run:

- `cargo fmt --all`
- Targeted Rust tests for `nse`
- `cargo fmt --all --check`
- `cargo clippy --workspace --all-targets --features test-support -- -D warnings`

If time or environment prevents running a gate, report that explicitly in the PR summary and final handoff.
