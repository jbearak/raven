# Bioconductor Tidy-Omics NSE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add empirically verified NSE policies for the Bioconductor tidy-omics packages in #403.

**Architecture:** Keep `crates/raven/src/nse.rs` as the single policy-table entry point. Add package-specific helper functions only for verified Bioconductor packages, model re-exports only when R proves they share formals and behavior, and update `docs/diagnostics.md` only for implemented coverage.

**Tech Stack:** Rust, Cargo, R 4.6.x, BiocManager/Bioconductor packages, GitHub CLI.

---

## Execution Note

The empirical survey found that current installed Bioconductor releases do not export package-qualified dplyr/tidyr verbs such as `plyranges::filter` or `tidySummarizedExperiment::pivot_longer`. Instead, `library(plyranges)`, `library(tidySummarizedExperiment)`, and `library(tidySingleCellExperiment)` attach dplyr/tidyr generics and register object-specific S3 methods. The implementation therefore expands those packages to the attached generic owners in `meta_package_members`, and deliberately keeps invalid `pkg::filter` spellings standard-eval. `tidybulk` did not attach dplyr/tidyr verbs in a fresh R session, so no NSE route was added for it.

## File Structure

- Modify `crates/raven/src/nse.rs`: add verified Bioconductor policy helpers, wire them into `package_policy`, and add unit tests for masks and shape-locking.
- Modify `docs/diagnostics.md`: update the NSE coverage limitation sentence if verified package policies land.
- Create or update a temporary probe script outside the repo, under `/tmp/opencode/issue403-bioc-nse-probe.R`, to collect R evidence. Do not commit the probe script.
- Modify `docs/superpowers/specs/2026-06-07-bioc-tidy-omics-nse-design.md` only if implementation discoveries contradict the approved design.

## Task 1: Empirical R Survey

**Files:**
- Create: `/tmp/opencode/issue403-bioc-nse-probe.R`

- [ ] **Step 1: Write the probe script**

Create `/tmp/opencode/issue403-bioc-nse-probe.R` with this content:

```r
options(repos = c(CRAN = "https://cloud.r-project.org"))

if (!requireNamespace("BiocManager", quietly = TRUE)) {
  install.packages("BiocManager")
}

packages <- c(
  "plyranges",
  "tidybulk",
  "tidySummarizedExperiment",
  "tidySingleCellExperiment"
)

missing <- packages[!vapply(packages, requireNamespace, logical(1), quietly = TRUE)]
if (length(missing) > 0) {
  BiocManager::install(missing, ask = FALSE, update = FALSE)
}

for (pkg in packages) {
  suppressPackageStartupMessages(library(pkg, character.only = TRUE))
  cat("\n## PACKAGE", pkg, "\n")
  ns <- asNamespace(pkg)
  exports <- getNamespaceExports(ns)
  candidates <- intersect(
    c(
      "filter", "mutate", "select", "summarise", "summarize", "arrange",
      "group_by", "ungroup", "rename", "transmute", "distinct", "count",
      "add_count", "pull", "slice", "relocate", "pivot_longer", "pivot_wider",
      "nest", "unnest", "drop_na", "fill", "unite", "separate"
    ),
    exports
  )
  for (name in candidates) {
    fn <- getExportedValue(pkg, name)
    cat("\n###", pkg, "::", name, "\n", sep = "")
    print(formals(fn))
    cat("environment:", environmentName(environment(fn)), "\n")
    if (name %in% getNamespaceExports("dplyr") && requireNamespace("dplyr", quietly = TRUE)) {
      cat("identical-to-dplyr:", identical(fn, getExportedValue("dplyr", name)), "\n")
    }
    if (name %in% getNamespaceExports("tidyr") && requireNamespace("tidyr", quietly = TRUE)) {
      cat("identical-to-tidyr:", identical(fn, getExportedValue("tidyr", name)), "\n")
    }
  }
}

suppressPackageStartupMessages({
  library(plyranges)
  library(GenomicRanges)
})

gr <- GRanges(
  seqnames = c("chr1", "chr2"),
  ranges = IRanges::IRanges(start = c(10L, 200L), width = c(5L, 10L)),
  strand = c("+", "-"),
  score = c(1, 2)
)

cat("\n## PLYRANGES BEHAVIOR\n")
print(plyranges::filter(gr, start > 100 & seqnames == "chr2"))
print(plyranges::mutate(gr, end2 = end + score))
print(plyranges::select(gr, score))
print(plyranges::arrange(gr, width))
print(plyranges::group_by(gr, seqnames))
print(plyranges::summarise(group_by(gr, seqnames), n = dplyr::n()))
```

- [ ] **Step 2: Run the probe script**

Run: `Rscript /tmp/opencode/issue403-bioc-nse-probe.R`

Expected: all four packages install/load; output lists candidate formals and re-export identity; plyranges behavior calls succeed.

- [ ] **Step 3: Interpret the output**

Classify each exported candidate as one of:

```text
Add per_formal: verified data-mask/tidy-select/capture behavior with known formals.
Route to existing dplyr/tidyr policy: identical exported function and matching behavior.
No policy: standard-eval, not exported, not a candidate, or insufficient evidence.
Stop: any package install/load/probe failure under the full selected scope.
```

## Task 2: Add Failing Unit Tests

**Files:**
- Modify: `crates/raven/src/nse.rs`

- [ ] **Step 1: Add representative failing tests before policy code**

Add tests near `meta_packages_expand_to_members()` and the end-to-end NSE tests:

```rust
    #[test]
    fn meta_packages_expand_to_members() {
        assert_eq!(meta_package_members("plyranges"), &["dplyr"]);
        assert_eq!(
            meta_package_members("tidySummarizedExperiment"),
            &["dplyr", "tidyr", "ggplot2"]
        );
        assert_eq!(
            meta_package_members("tidySingleCellExperiment"),
            &["dplyr", "tidyr", "ggplot2"]
        );
        assert!(meta_package_members("tidybulk").is_empty());
    }

    #[test]
    fn bioc_tidy_omics_qualified_verbs_are_not_policy_aliases() {
        assert_eq!(package_policy("plyranges", "filter"), None);
        assert_eq!(package_policy("tidySummarizedExperiment", "filter"), None);
        assert_eq!(package_policy("tidySingleCellExperiment", "mutate"), None);
        assert_eq!(package_policy("tidybulk", "filter"), None);
    }

    #[test]
    fn nse_bioc_tidy_omics_attach_expands_generics_but_load_namespace_does_not() {
        let attach_messages = collect_undefined_messages(
            "library(plyranges)\ndf <- data.frame(x = 1)\nfilter(df, masked_col)\nreally_undefined_xyz",
        );
        assert!(!attach_messages.iter().any(|m| m.contains("masked_col")));

        let load_namespace_messages = collect_undefined_messages(
            "loadNamespace(\"plyranges\")\ndf <- data.frame(x = 1)\nfilter(df, masked_col)",
        );
        assert!(load_namespace_messages
            .iter()
            .any(|m| m.contains("Undefined variable: masked_col")));
    }
```

If Task 1 shows different verified policies, adjust this exact test content to match the evidence before adding implementation.

- [ ] **Step 2: Run tests to verify failure**

Run: `cargo test -p raven nse::tests::meta_packages_expand_to_members -- --nocapture`

Expected: FAIL because `meta_package_members` has no Bioconductor attached-generic entries yet.

## Task 3: Implement Verified Attached-Generic Routing

**Files:**
- Modify: `crates/raven/src/nse.rs`

- [ ] **Step 1: Add meta-package members**

In `meta_package_members`, add only packages that Task 1 verified as attaching dplyr/tidyr generics:

```rust
        "plyranges" => &["dplyr"],
        "tidySummarizedExperiment" | "tidySingleCellExperiment" => &["dplyr", "tidyr", "ggplot2"],
```

- [ ] **Step 2: Gate meta expansion on attach semantics**

In `collect_in_play_packages`, keep raw package names from `loadNamespace()` in play for namespace/object-dispatch surfaces, but expand `meta_package_members` only for `LibraryCall { attaches: true, .. }` and `test_attached_packages`:

```rust
let mut attached_packages_for_meta: HashSet<String> = HashSet::new();
// Insert into attached_packages_for_meta only when call.attaches is true.
let members: Vec<String> = packages
    .iter()
    .filter(|p| attached_packages_for_meta.contains(*p))
    .flat_map(|p| crate::nse::meta_package_members(p))
    .map(|m| m.to_string())
    .collect();
```

- [ ] **Step 3: Run targeted tests**

Run: `cargo test -p raven handlers::function_parameter_tests::nse_bioc_tidy_omics_attach_expands_generics_but_load_namespace_does_not -- --nocapture`

Expected: PASS.

## Task 4: Shape-Lock Tests And Docs

**Files:**
- Modify: `crates/raven/src/nse.rs`
- Modify: `docs/diagnostics.md`

- [ ] **Step 1: Extend shape tests**

Add verified negative qualified-policy cases near `meta_packages_expand_to_members()`:

```rust
        assert_eq!(package_policy("plyranges", "filter"), None);
        assert_eq!(package_policy("tidySummarizedExperiment", "filter"), None);
        assert_eq!(package_policy("tidySingleCellExperiment", "mutate"), None);
        assert_eq!(package_policy("tidybulk", "filter"), None);
```

These tests pin that invalid namespace-qualified spellings remain standard-eval.

- [ ] **Step 2: Update diagnostics docs**

In `docs/diagnostics.md`, update the NSE coverage sentence so the package list includes the verified Bioconductor tidy-omics package names. Keep the limitation wording that the table is not exhaustive.

- [ ] **Step 3: Run broader NSE tests**

Run: `cargo test -p raven nse -- --nocapture`

Expected: PASS.

## Task 5: Full Validation And PR

**Files:**
- Commit modified files only.

- [ ] **Step 1: Format**

Run: `cargo fmt --all`

Expected: command exits 0.

- [ ] **Step 2: Check formatting**

Run: `cargo fmt --all --check`

Expected: command exits 0.

- [ ] **Step 3: Run clippy gate**

Run: `cargo clippy --workspace --all-targets --features test-support -- -D warnings`

Expected: command exits 0.

- [ ] **Step 4: Inspect changes**

Run: `git status --short && git diff --check && git diff`

Expected: only intended files changed; no whitespace errors.

- [ ] **Step 5: Commit implementation**

Run:

```bash
git add crates/raven/src/nse.rs docs/diagnostics.md docs/superpowers/plans/2026-06-07-bioc-tidy-omics-nse.md
git commit -m "fix(nse): cover Bioc tidy-omics data masks"
```

Expected: commit succeeds.

- [ ] **Step 6: Push branch and open PR**

Run:

```bash
git push -u origin issue403
gh pr create --fill --base main --head issue403
```

Expected: GitHub returns a PR URL. Ensure PR body says it addresses #403 and lists R probe evidence plus validation commands.

## Self-Review

Spec coverage:

- Full package scope is covered by Task 1.
- Conservative policy-table implementation is covered by Tasks 2 and 3.
- Tests are covered by Tasks 2, 3, and 4.
- Documentation is covered by Task 4.
- Validation and PR creation are covered by Task 5.

Placeholder scan: no TBD/TODO/later placeholders remain. The plan gives exact file paths, commands, expected outputs, and code shapes. Where code must vary, it is explicitly tied to empirical Task 1 evidence.

Type consistency: all Rust snippets use existing `ArgPolicy`, `package_policy`, `dplyr_policy`, `tidyr_policy`, `suppressed_arguments`, and `labels` names from `crates/raven/src/nse.rs`.
