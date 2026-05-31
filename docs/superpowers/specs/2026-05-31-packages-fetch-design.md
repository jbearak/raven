# Design: `raven packages fetch` — R-free CI producer of the Tier 2 export database

**Date:** 2026-05-31
**Status:** Approved design — pending written-spec review.
**Builds on:** [`2026-05-30-ci-package-exports-db-design.md`](2026-05-30-ci-package-exports-db-design.md), which established the three-tier export-resolution model (Tier 1 installed → Tier 2 committed `.raven/packages.json` → Tier 3 shipped `names.db`). That spec is authoritative for the tier model; this one adds a **second producer** of the Tier 2 artifact and does not change the resolution seam.

---

## 1. Goal & motivation

Add `raven packages fetch` — a command that produces the same `.raven/packages.json` Tier 2 artifact `raven packages freeze` produces, but sources export metadata **from CRAN/Bioconductor r-universe** (`cran.r-universe.dev`, `bioc.r-universe.dev`) instead of from a local R install.

It exists to give CI a way to get project-scoped package-export coverage that:

- **does not require R or installed packages** (plain `fetch`), and
- **does not depend on the `jbearak/raven` `names-db` GitHub Release** that Tier 3 (`raven packages update`) pulls from.

Today a CI pipeline without R has exactly one zero-install option: `raven packages update`, which downloads the whole-ecosystem Tier 3 sidecars from a single maintainer-owned Release. `fetch` is the alternative: it fetches only the packages the project actually references, straight from community infrastructure, and writes them into the Tier 2 file that `raven check` already reads.

**This is a new producer, not a new tier.** The output is byte-compatible with `freeze`'s output and is consumed through the existing `read_repo_db_file` / `RepoDbProvider` path with **no new consumption code**. What differs from `freeze` is the *source* of records (r-universe vs. local install) and the *lifecycle* (ephemeral CI artifact, regenerated per run, gitignored — vs. committed and reviewed).

---

## 2. Boundary & non-goals

`fetch` is scoped to **producing the Tier 2 file from r-universe**. It is explicitly **not**:

- **A change to `freeze`.** `freeze` keeps its contract intact: offline, deterministic, version-exact "frozen Tier 1," refuses without R. No flag is added to it here.
- **A change to the resolution seam or tier precedence.** `raven check` / the language server read `.raven/packages.json` exactly as before. `fetch` only writes that file.
- **A whole-ecosystem floor.** Unlike Tier 3, `fetch` captures only packages the project references (the "used set"). It does not give zero-adoption coverage for packages the code hasn't mentioned yet.
- **A committed, version-pinned artifact.** The fetched records carry **latest** CRAN/Bioc exports, not the versions the project pins. The file is meant to be regenerated each CI run, not reviewed in a PR. (A user *may* commit it, but that is not the design target and the docs steer away from it.)
- **A base/recommended-package source.** Base packages (`base`, `stats`, `utils`, `methods`, …) are not on r-universe; they are part of R itself. They are resolved at analysis time from local R (Tier 1) or the binary's embedded base fallback, exactly as today. `fetch` never tries to fetch them.

---

## 3. Locked decisions

Settled during design Q&A (the dialogue that produced this spec):

1. **Surface = a flag, not a third subcommand.** `raven packages fetch` and `raven packages fetch --missing-only`. The only behavioral delta between the two is "consult the local install and subtract what's already there," which is a modifier on one command, not a separate concept.
2. **Plain `fetch` requires no R.** It computes the used set (R-free, via tree-sitter + file reads), skips base packages (known offline via the embedded base set), and fetches the rest from r-universe.
3. **`--missing-only` also requires no R — it is a pure optimization.** When R is present with a populated library, it subtracts already-installed packages from the fetch set (they will resolve via Tier 1 in the same CI run). When R is absent or `.libPaths()` is empty, the "installed?" filter matches nothing, so **every** used package is treated as missing and `--missing-only` degrades to a full `fetch`. It is therefore never an error to pass `--missing-only` without R; it simply has nothing to subtract.
4. **Provenance gains an optional `source` field** on `RepoDbProvenance`, added with `#[serde(default)]` so the Tier 2 **schema version stays at 1** (older Raven ignores the field; newer Raven defaults it for files that lack it). Fetched files stamp it (e.g. `"r-universe (cran+bioc) @ 2026-05-31"`); `freeze` leaves it empty/default.
5. **`--fail-on-missing` is opt-in.** By default, packages that resolve nowhere produce warnings and a success exit. `--fail-on-missing` turns the warning set into a non-zero exit so a pipeline can gate on unresolvable references.
6. **Clobber guard.** Checked **up front (step 0), before any fetching.** If the file at the target path already exists, parses as a valid Tier 2 file, and was written by `freeze` (its provenance `source` is empty/install-sourced), and the user did not pass `--output`, `fetch` **refuses** rather than overwrite a committed, version-exact file with latest-from-network records. An absent, corrupt, or fetch-written (non-empty `source`) target does not trip the guard. `--output PATH` overrides the guard and the default location.

---

## 4. Architecture overview

`fetch` is a new async entry point `run_fetch` in `crates/raven/src/cli/packages.rs`, dispatched from the existing `packages` subcommand router alongside `freeze` / `update` / `build-shipped-db`. Its pipeline:

```
0. Clobber guard               (refuse early if target is a freeze file & no --output)
1. Compute the used set        (shared with freeze; R-free)
2. Drop base packages          (embedded base set; R-free)
3. [--missing-only] subtract installed packages   (Tier-1 package_exists; no-op without R)
4. Inform: print the packages about to be downloaded
5. Fetch each from r-universe  (curl, CRAN then Bioc fallback, bounded concurrency)
6. Parse responses             (existing parse_runiverse_json → PackageRecord)
7. Collect "resolved nowhere"  (used − fetched − [installed if --missing-only])
8. Warn per unresolved package; honor --fail-on-missing
9. Write .raven/packages.json atomically (temp-then-rename), with source provenance
```

The clobber guard is **step 0** — checked up front so the command fails fast without doing network work it would only discard. Steps 1, 2, 6, and 9's writer already exist; the net-new logic is steps 0, 3–8 and the per-package fetch helper.

---

## 5. Components

### 5.1 Shared used-set computation (extracted)

`run_freeze` currently inlines the used-set computation: `scan_workspace_referenced_packages` ∪ `read_description_depends_imports(DESCRIPTION)` ∪ `read_renv_lock_package_names(renv.lock)`, plus transitive `Depends` expanded during the capture loop. `fetch` needs the identical set.

**Extract a shared helper** (e.g. `collect_used_package_names(root) -> Vec<String>`) that returns the seed used set (pre-transitive), and have both `freeze` and `fetch` call it. The transitive-`Depends` expansion differs slightly between the two (freeze reads `Depends` from installed `PackageInfo`; fetch reads `_dependencies` role=`Depends` from r-universe JSON), so transitive expansion stays in each command's capture loop, but the seed computation is shared. This avoids two copies of the maximally-inclusive scan rule drifting apart.

The R-free scanner `collect_referenced_packages` (tree-sitter; handles `library`/`require`/`loadNamespace`/`requireNamespace` + `::`/`:::` LHS) is reused unchanged.

### 5.2 Base-package filter without R

`fetch` must skip base/recommended packages without an R subprocess. It uses the embedded base set — `embedded_base::load()` returns `(exports, packages)` where `packages` is derived from `r_subprocess::get_fallback_base_packages()`. `fetch` checks membership in that set rather than calling `PackageLibrary::is_base_package` (which is fine to use when a library is built for `--missing-only`, but plain `fetch` builds no library). A single helper that answers "is this name base?" from the embedded set keeps both paths consistent.

### 5.3 Installed-package filter (`--missing-only`)

When `--missing-only` is set, build a Tier-1-only library via `build_package_library_tier1_only(None, &[], Some(root))` (the same call `freeze` uses) and filter the fetch set with `package_exists`, which is **Tier-1-only by contract** (guarded by the test `package_exists_never_consults_providers`). If the library is not ready (no R / no libpaths), `package_exists` returns false for everything, so nothing is subtracted — the documented degrade-to-full-fetch behavior. **No `is_ready()` refusal** is inherited from `freeze`; `fetch` must not refuse on missing R.

### 5.4 Per-package r-universe fetch

There is **no Rust HTTP client** in the codebase; networking shells out to `curl` (`download_asset_blocking` in `cli/packages.rs`, with `--fail --location --silent --show-error --proto =http,https --connect-timeout 20 --max-time 300 --max-filesize …`). `fetch` reuses that exact helper pattern, parameterized per package URL:

- Try `https://cran.r-universe.dev/api/packages/<pkg>` first; on failure (curl non-success / 404) fall back to `https://bioc.r-universe.dev/api/packages/<pkg>`.
- A package that fails on both is "resolved nowhere" (§5.5).
- Parse each success with the existing `parse_runiverse_json` → `PackageRecord`.
- **Bounded concurrency:** the transitive `Depends` closure can be dozens–hundreds of packages; serial curl (what the maintainer build workflow does) would be slow and rate-limit-prone interactively. Spawn fetches through `tokio::task::spawn_blocking` with a bounded concurrency limit (a small fixed cap, e.g. 8). The host list is overridable for testing (`--base-urls`, §6) so the CRAN→Bioc fallback can be exercised against a local server.

The two hosts are tried **in order**, so they are modeled as an ordered list of base URLs (default `[cran.r-universe.dev, bioc.r-universe.dev]`), not a single base. This is what lets a test point the first host at a 404-ing fixture and the second at a serving one to exercise the fallback (§8).

Transitive expansion: after fetching a package, enqueue its r-universe `Depends` (role-filtered, excluding `R`) that aren't already seen/base — mirroring `freeze`'s transitive loop but sourced from the fetched JSON.

### 5.5 "Resolved nowhere" detection, warnings, and `--fail-on-missing`

After fetching, compute the set of used packages (non-base) that produced **no** record — neither fetched from r-universe nor (under `--missing-only`) found installed. This set is exactly: GitHub-only / internal / private packages, packages not yet on r-universe, **and typos** (`library(dpylr)`). For each, emit a `stderr` warning naming the package. If `--fail-on-missing` is set and the set is non-empty, exit non-zero after writing the file.

> **Note — suppression is deferred.** Legitimately off-ecosystem packages (private/internal) will warn every run. A suppression mechanism (an allowlist in `raven.toml`, or a directive) is **out of scope for v1** and noted as a fast-follow. v1 behavior: they warn; `--fail-on-missing` users who have such packages either don't use the flag or accept the failure until suppression lands.

### 5.6 Provenance `source` field

Add to `RepoDbProvenance`:

```rust
#[serde(default)]
pub source: String,
```

`#[serde(default)]` is load-bearing: it keeps `REPO_DB_SCHEMA_VERSION` at `1` (an absent key deserializes to `""`, so files written by today's `freeze` still parse, and today's reader — which doesn't know the field — still parses tomorrow's files). `fetch` sets it to a human string like `"r-universe (cran+bioc) @ <date>"`. `freeze` continues to leave it empty. `r_version` for plain `fetch` is set to a sentinel such as `"none (fetched)"`; for `--missing-only` it reflects the R used for the install filter if any, else the same sentinel.

The clobber guard (§3.6) reads this field on the existing target file **before fetching**: a target that parses as a valid Tier 2 file with an empty `source` ⇒ treat as freeze-written ⇒ refuse without `--output`. An absent or corrupt target does not trip the guard (nothing committed to protect).

### 5.7 Atomic write

Reuse the temp-then-rename discipline from `update`'s `install_downloaded_sidecars` so a mid-fetch failure or partial network read can never feed a half-written `.raven/packages.json` to `raven check` in the same job. Write to a unique temp in the destination directory, then atomically rename over the target.

---

## 6. Arg parsing

`parse_fetch_args` mirrors the existing `parse_freeze_args` shape:

| Flag | Meaning | Default |
|---|---|---|
| `--missing-only` | Subtract already-installed packages from the fetch set (no-op without R) | off |
| `--fail-on-missing` | Exit non-zero if any used package resolved nowhere | off |
| `--output PATH` | Where to write; overrides default and the clobber guard | `.raven/packages.json` |
| `--workspace DIR` | Workspace root to scan for usage/config | current dir |
| `--base-urls URL[,URL]` | Override the ordered r-universe host list (testing); tried in order | `cran.r-universe.dev,bioc.r-universe.dev` |
| `--help` | Usage | — |

`run` (the subcommand router) gains a `Some("fetch") => run_fetch(parse_fetch_args(argv)?)` arm; `print_help` gains the `fetch` usage line.

---

## 7. Error handling

- **No R, plain `fetch`:** normal. No refusal; base via embedded set; everything else fetched.
- **No R, `--missing-only`:** degrades to full `fetch` (nothing to subtract). No refusal.
- **Single package fails on both r-universe hosts:** not fatal — recorded as "resolved nowhere," warned, and (only with `--fail-on-missing`) gates the exit.
- **`curl` missing / network down for all:** the fetch helper surfaces curl's error; if *every* fetch fails the command reports the failure (and, like `update`, points at the manual/alternative path). A partial failure writes the records it got and warns about the rest.
- **Clobber guard tripped:** refuse with a message naming the freeze-written target and pointing to `--output`.
- **Write failure:** atomic-replace leaves any existing file intact (temp discarded).

---

## 8. Testing strategy

- **Arg parsing:** `--missing-only`, `--fail-on-missing`, `--output`, `--workspace`, `--base-urls`; defaults; unknown-flag error. (Mirrors `parse_freeze_args_defaults_to_used`.)
- **Used-set extraction is R-free:** already proven by `collect_referenced_packages_finds_namespace_and_calls`; add a test that the shared `collect_used_package_names` unions DESCRIPTION + renv.lock + scanned refs.
- **Base filter:** a used set containing `stats`/`utils` fetches neither (membership in the embedded base set), with no R.
- **`--missing-only` subtraction:** with a stub Tier-1 library reporting `dplyr` installed, `dplyr` is excluded from the fetch set; without a ready library, nothing is excluded (degrade-to-full).
- **Fetch + parse against a local server:** point `--base-urls` at a local fixture server returning the existing `tests/fixtures/package_db/runiverse/*.json`; assert the written file's records match. CRAN-miss → Bioc-fallback path covered by pointing the first host at a 404-ing fixture and the second at a serving one.
- **Resolved-nowhere + exit codes:** a used package absent from the fixture server warns; `--fail-on-missing` makes it exit non-zero while still writing the partial file; without the flag it exits zero.
- **Provenance round-trip:** a fetched file carries a non-empty `source`; a `freeze`-written file (empty `source`) round-trips unchanged; an old file lacking the key deserializes with `source == ""` (schema-v1 back-compat).
- **Clobber guard:** writing over a freeze file (empty `source`) without `--output` refuses; with `--output` it writes; over a fetch file (non-empty `source`) it overwrites.
- **Atomic write:** a simulated mid-write failure leaves a pre-existing target intact (reuse `update`'s rollback test shape).
- **No consumption regression:** `read_repo_db_file` / `RepoDbProvider` load a fetched file identically to a frozen one (same schema), so the `raven check` path needs no new test beyond confirming a fetched file resolves a package's exports with empty libpaths.

---

## 9. Documentation updates

This work includes a **docs cleanup of the `raven packages` material**, which is currently implementation-heavy and at times confusing. Concretely:

### 9.1 New: "Four ways to run `raven check` in CI"

Add a section (in `docs/cli.md` and/or `docs/package-database.md`) presenting the four strategies plainly, with a pros/cons table:

1. **R + all packages installed** on the CI system or image.
2. **`raven packages update`** in the workflow before `raven check` (or baked into the image).
3. **`raven packages fetch --missing-only`** in the workflow before `raven check`. *(If R is unavailable in CI, `--missing-only` is a no-op and this is equivalent to `raven packages fetch`, since all packages are then missing.)*
4. **`raven packages freeze`** locally (with all packages installed) and commit `.raven/packages.json`.

Each row should briefly say what it does and its trade-offs. Indicative axes for the table:

| Strategy | Needs R in CI | Network in CI | Coverage | Version fidelity | Committed | Depends on `names-db` Release |
|---|---|---|---|---|---|---|
| 1. R + packages installed | yes | (install) | exact, full | version-exact | no | no |
| 2. `packages update` | no | yes (2 files) | whole ecosystem | latest snapshot | no | **yes** |
| 3. `packages fetch [--missing-only]` | no | yes (per-pkg) | project's used set | latest (installed rows exact under `--missing-only`) | no (ephemeral) | no |
| 4. `freeze` + commit | no (in CI) | no | project's used set | version-exact | yes | no |

### 9.2 New: document `raven packages fetch`

A `cli.md` subsection paralleling `raven packages freeze` / `raven packages update`: synopsis, the two modes, the no-R behavior, the inform/warn output, `--fail-on-missing`, the gitignore guidance, the clobber guard, and the honest scope limits (no whole-ecosystem floor; base still from R/embedded).

### 9.3 Cleanup pass on `docs/package-database.md` and the `raven packages` CLI docs

Reduce implementation detail that confuses users, clarify the producer/consumer split (three **resolution tiers** vs. the **producers** of the Tier 2 file — `freeze` and now `fetch`), and make the "names vs. install status" and fidelity-caveat material easier to follow. Keep maintainer-only detail (e.g. `build-shipped-db` internals) clearly marked as such. This is a focused readability/accuracy pass tied to introducing `fetch` — not an unrelated rewrite.

### 9.4 Honest framing

Docs must state two limits plainly so `fetch` is not oversold:

- It does **not** replace Tier 3's zero-adoption, whole-ecosystem floor — it only covers referenced packages.
- It is **not** fully self-contained — base/recommended packages still come from local R or the embedded fallback at analysis time, because they are not on r-universe.

---

## 10. Code touchpoints

- **New:** `run_fetch`, `parse_fetch_args`, `FetchArgs`, the per-package r-universe fetch helper, the "is base (embedded)" helper, the shared `collect_used_package_names` — all in `crates/raven/src/cli/packages.rs` (fetch helper may share a small module with `download_asset_blocking`).
- **Modified:** `RepoDbProvenance` gains `#[serde(default)] source: String` (`package_db/json_db.rs`); `run_freeze` switches to the shared used-set helper (behavior-preserving); the `packages` `run` router + `print_help` gain the `fetch` arm.
- **Reused unchanged:** `parse_runiverse_json` (`package_db/runiverse.rs`), `collect_referenced_packages` / `read_description_depends_imports` / `read_renv_lock_package_names`, `build_package_library_tier1_only` + `package_exists` (Tier-1), `embedded_base::load`, `write_repo_db_file` + the atomic-replace pattern from `update`.

---

## 11. Scope (v1) and explicit deferrals

**In v1:** `raven packages fetch [--missing-only] [--fail-on-missing] [--output] [--workspace] [--base-urls]`; the optional `source` provenance field; the clobber guard; the inform/warn output; bounded-concurrency curl fetch with CRAN→Bioc fallback; atomic write; the docs (four-ways section, `fetch` reference, cleanup pass).

**Deferred (noted, not built):**

- **Suppression of expected-missing packages** (allowlist in `raven.toml` or a directive) so private/internal packages don't warn every run. v1 warns them.
- **A `freeze --fetch-missing` gap-fill flag** (one-shot "install-wins, network-fills" producing a single committed file). This is a separate, additive decision with mixed-fidelity provenance implications; not needed to ship `fetch`.
- **Caching fetched records** across runs (beyond what CI-level HTTP/dependency caching already offers).
