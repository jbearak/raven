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

Keep `crates/raven/src/nse.rs` as the single source of truth for built-in NSE argument policies. Add explicit package handling through `package_policy(package, name)`, using small helper functions when a package has more than one verified entry.

Existing helpers such as `dplyr_policy`, `tidyr_policy`, and `tibble_policy` remain unchanged unless probing proves a Bioconductor export is a true re-export whose formals and behavior are safely identical. Otherwise, model each Bioconductor package under its own package key because the resolver classifies NSE by `(package, name)`.

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
5. Translate only confirmed behavior into `ArgPolicy::per_formal` or `ArgPolicy::WholeCall`.
6. Record excluded cases in comments or the PR summary when they look NSE-like but evaluate normally.

If installation or probing fails for any of the four requested packages, stop rather than landing partial guessed policy. The selected scope is the full issue scope.

## Tests

Add Rust unit tests in `crates/raven/src/nse.rs` that pin representative behavior:

- Mask tests for confirmed Bioconductor data-masking / tidy-select policies.
- Pipe-fed masks where the first syntactic positional argument changes meaning because `.data` is supplied by the pipe.
- Table-lock shape tests so accidental package-policy drops fail CI.
- Negative shape tests for surveyed functions that should remain standard-eval when useful.

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
