# Design: CI package-exports database (three-tier export resolution)

**Date:** 2026-05-30
**Status:** Approved design — refined during implementation-planning review (see §0). The implementation plan ([`docs/superpowers/plans/2026-05-30-ci-package-exports-db.md`](../plans/2026-05-30-ci-package-exports-db.md)) is the build-of-record; where this spec and the plan once differed, the plan's decisions ledger and §0 below govern.
**Depends on:** [raven#350](https://github.com/jbearak/raven/issues/350) — package-dataset (lazy-data) resolution — must land first (see §0.6, §11).
**Companion:** Builds on [`2026-05-30-native-package-exports-feasibility.md`](2026-05-30-native-package-exports-feasibility.md), which asked whether Raven *could* obtain package exports without R. This spec answers a narrower, concrete question: **how does Raven get export knowledge in CI without installing or compiling R packages?**

---

## 0. Post-review refinements (2026-05-30)

The §17 open items were resolved and several design points sharpened during a planning-review (grilling) pass. These **supersede** anything contradictory in the body below; the implementation plan's "Decisions revised in design review" ledger (#6–#15) carries the full rationale.

1. **Resolution seam (§5.2, §17):** a synchronous `PackageMetadataProvider` trait covering **only** Tier 2/3; Tier 1 stays a bespoke first step in `get_package` (the single hook). `package_exists()` never consults providers. `prefetch_packages` is unchanged — meta-packages and `Depends` chains resolve via the existing `get_all_exports → get_package` recursion.
2. **Tier 3 source & storage (§8):** the shipped `names.db` is built from **the build machine's entire installed library (authoritative reference-R capture) ∪ CRAN + Bioc r-universe, append-only** — *not* r-universe alone. The full installed library is the point: hard-to-install / GitHub-only / internal packages enter the floor this way and append-only never drops them. Precedence reference-R > r-universe > retained-from-prior. Stored on a **GitHub Release** (`names-db` tag), bootstrapped once from a richly-provisioned machine; bundled exe-relative with the binary/VSIX. r-universe is fetched from both `cran.r-universe.dev` and `bioc.r-universe.dev`.
3. **Base/recommended + base datasets (§6, §8):** ship in a **separate base-exports file** (also from the reference R), loaded into `base_exports` in CI when the base packages aren't on disk — so base symbols and base datasets (`mtcars`/`iris`) resolve without R.
4. **Tier 2 generation (§7, §9):** `raven packages freeze` builds a **provider-less** (Tier-1-only) library so the "frozen Tier 1" file can't be contaminated by Tier 2/3; the `--used` set is **maximally inclusive** (adds `requireNamespace`, `::`/`:::` LHS, and the repo's own `DESCRIPTION` `Imports`); regeneration is a **no-op when content is unchanged**.
5. **Robustness:** unreadable DBs are **explained, not silently dropped** (typed reader errors → stderr / `window/showMessage`, then degrade); Tier 2 carries a `schema_version`; the Tier 3 checksum is verified at open off-thread; tiny committed fixtures guard format back-compat. Names: `raven packages freeze`, `raven check --report-uninstalled`.
6. **Datasets scope (§3, §11):** *package* (non-base) dataset resolution is split to a prerequisite, **[raven#350](https://github.com/jbearak/raven/issues/350)** — implemented first. This work captures `lazy_data` in the records; #350 wires resolution so CI consumes it automatically.

---

## 1. Goal & motivation

Raven should be usable in CI (GitHub Actions, Bitbucket Pipelines) to gate on diagnostics — without installing or compiling R packages. Compiling CRAN packages is slow and a frequent source of CI failures, and the user explicitly does *not* want package installation to be a prerequisite for running Raven.

**The problem today.** Raven's package-aware diagnostics rely on resolving package exports. In CI with no R installed, `.libPaths()` is empty, so:

- every `library(pkg)` fires a **missing-package** warning, and
- every symbol from a package shows as an **undefined variable**.

Raven is effectively unusable in CI right now. This design fixes that by giving Raven a pre-built source of export *names* that needs neither R nor installed packages at analysis time.

**The key enabling fact.** [r-universe.dev](https://r-universe.dev) publishes, as free CORS-open JSON, an `_exports` array for all ~24,280 CRAN packages plus all of Bioconductor (`https://cran.r-universe.dev/api/packages/<pkg>`). Crucially, `_exports` is the *true post-load namespace export set* with `exportPattern()` already expanded — the one thing that normally requires building and loading a package. r-universe also exposes `_dependencies` and `_datasets`. This is the artifact the feasibility memo assumed had to be built from scratch; it already exists for the whole ecosystem.

---

## 2. Boundary & non-goals

This narrows **one** R dependency: static export intelligence (export *names* and package structure) when installed packages are absent. It is explicitly **not**:

- **R-free Raven.** Execution features — the R console, Send-to-R, knit, the plot/data/help viewers, build commands — run user R code and are untouched.
- **A signatures replacement (v1).** Function signatures (`formals`) stay R-subprocess-only, exactly as today. Signatures are a documented fast-follow (see §11).
- **A version-pinning oracle.** Export *names* are far more stable than function behavior across package versions; this design does not attempt byte-exact, per-version API reconstruction.

The new sources are a **floor**, never a replacement: when a package is resolvable from a real local install, the existing authoritative path stays in charge and is version-exact. The design **regresses nothing** on the installed-package path.

---

## 3. Locked decisions

Settled during design Q&A:

1. **Scope = export names + package structure** (exports, `Depends`, datasets, meta-package attaches). Function signatures deferred.
2. **Shipped database is "latest CRAN/Bioc," permanently** — no version-history indexing. Export names are stable enough that latest-only is an acceptable floor.
3. **Pre-built databases, not live API queries** — Raven never depends on a live external service during a CI run.
4. **Three tiers, all in v1** (§5). The marginal cost of the user-built tier is low because it reuses machinery the shipped tier already requires.
5. **Shipped database is sourced from an authoritative reference-R capture ∪ r-universe `_exports`/`_dependencies`/`_datasets`, append-only** (revised — see §0.2; the original draft said r-universe alone).

---

## 4. Architecture overview

Export resolution becomes an **ordered fallback over three sources**, consulted per package only when the package is not already resolved:

| Tier | When it applies | Source | Fidelity |
|---|---|---|---|
| **1 — Installed** | Package installed locally (and R reachable for `exportPattern`) | Existing on-disk path: static `NAMESPACE` parse + R subprocess to expand `exportPattern` | Authoritative, version-exact to the install |
| **2 — Repo DB** | Not installed, or R can't launch | A repo-specific, committed `.raven/packages.json` generated locally (see §7) | "Frozen Tier 1": full structure, version-exact to when it was generated |
| **3 — Shipped DB** | Otherwise | A Raven-bundled `names.db` built from r-universe latest (see §8) | Latest CRAN/Bioc; export-only |

Tier 2 outranks Tier 3 because it is project-specific and built through the authoritative path. A repo that never generates a Tier 2 file still works in CI via Tier 3 alone (latest-only). The two databases share one in-memory model, one reader, and one writer (§6).

---

## 5. Shared spine

Built once; used by all tiers.

### 5.1 `package_db` module

A new top-level module on the `raven` crate.

- **In-memory model:** Raven's existing `PackageInfo` (`crates/raven/src/package_library.rs:110`) — `{ name, exports: HashSet<String>, depends: Vec<String>, is_meta_package: bool, attached_packages: Vec<String>, lazy_data: Vec<String> }` — made serializable. No new in-memory representation.
- **Two on-disk encodings, one reader:**
  - **Tier 3 (`names.db`):** compact binary, indexed, memory-mapped, lazy per package. Sized for ~24k packages; never human-read.
  - **Tier 2 (`.raven/packages.json`):** deterministic, sorted, diff-friendly JSON. Generated, not hand-edited; reviewable in PRs so `git diff` shows "package Y gained export X."
  - One reader loads either encoding into `PackageInfo`.
- **Module declaration invariant:** a new top-level module must be declared in **both** `crates/raven/src/lib.rs` and `crates/raven/src/main.rs` (lib and bin have separate module trees).

### 5.2 Ordered-resolution seam

Today, metadata sourcing in `PackageLibrary` is hardcoded conditionals (`if r_subprocess.is_some()`), with no provider abstraction. Introduce a small `PackageMetadataProvider`-style boundary so the consumer queries route through a defined source order (Tier 1 → 2 → 3):

- `get_package()` (`package_library.rs:1145`)
- `find_package_for_symbol()` (`package_library.rs:760`)
- `package_exists()` (`package_library.rs:1393`)

The refactor is contained to this seam. **Tier 1 behavior is untouched** — it remains first and authoritative. Doing the abstraction first (rather than bolting two more branches onto the conditionals) keeps tier precedence reasoning honest, per code-review feedback on the design.

---

## 6. Tier 1 — installed (unchanged)

The existing authoritative path: static `NAMESPACE` parse (`namespace_parser.rs:46`) for explicit exports, R subprocess (`r_subprocess.rs:414`/`:577`) only to expand `exportPattern`, `Depends` from DESCRIPTION (`namespace_parser.rs:291`), dataset discovery from `data/` (`namespace_parser.rs:452`). No change.

---

## 7. Tier 2 — repo database (`.raven/packages.json`)

A committed, repo-specific snapshot generated on a machine that has R and the project's packages installed. Because it is produced through Raven's **authoritative path**, it is effectively *frozen Tier 1*: it captures the full `PackageInfo` — exports (with `exportPattern`/`.onLoad` correctly expanded, since generation uses `asNamespace()`), `Depends`, datasets, and meta-package attaches. It is **opt-in**: it exists only if the user runs the generation command, and Raven never auto-creates it.

### 7.1 Library source: renv-first, system-fills

Generation resolves each package from a **renv-aware library order** — the renv project library first, system-wide libraries only for packages renv doesn't cover. This is nearly free: `get_lib_paths` (`r_subprocess.rs:320`) already sources `renv/activate.R`, so `.libPaths()` already returns `[renv_lib, system_libs…]`. Walking that order and taking the first occurrence of each package yields "renv wins, system fills the gaps" automatically. This applies to **both** generation scopes.

### 7.2 What counts as a package the repo "uses"

renv.lock's role here is a **set selector** (which packages to include), *not* a version oracle.

- **`--used` (default) set = (packages referenced in the repo's R/Rmd scripts via `library`/`require`/`::`) ∪ (packages listed in `renv.lock`) ∪ their transitive `Depends`.**
  A package in `renv.lock` is included **even if no script ever calls it** — being locked counts as using it.
- **`--installed` / `--all` set = every package across the renv + system libraries.**

A small `renv.lock` reader (it is JSON; read the `Packages` keys) is the only net-new input. A locked package that isn't actually installed locally cannot be captured (no exports to read) and simply **falls through to Tier 3** in CI. Best coverage therefore comes from generating after `renv::restore()`, but nothing breaks otherwise.

### 7.3 File location, format, provenance

- **Location:** `.raven/packages.json` at the repo root, auto-discovered like `raven.toml` / `.lintr`; a config key may override the path.
- **Format:** sorted, deterministic JSON (the Tier 2 encoding from §5.1), committed to the repo.
- **Provenance (minimal):** record the generator Raven version, the R version, and the generation date — for debuggability only. **No drift-detection machinery**: no lockfile-hash comparison and no "snapshot is stale" diagnostic. Export names are stable; regeneration is a manual command the user runs when they choose.

### 7.4 Reuse

Generation reuses existing machinery — installed-package enumeration, the codebase package scan that `raven check` already performs to warm exports, the export-extraction subprocess, and the §5.1 writer. Net-new surface: the CLI/VS Code entry point, the `renv.lock` reader, the JSON encoding, and the provenance fields.

---

## 8. Tier 3 — shipped database (`names.db`)

A Raven-bundled, latest-CRAN/Bioc export database.

- **Source (revised — see §0.2):** an **authoritative reference-R capture of the build machine's entire installed library** ∪ **CRAN + Bioc r-universe**, merged **append-only**. The reference-R capture (via Raven's Tier-1 path: `NAMESPACE` + subprocess `exportPattern` expansion + `data/` datasets) covers base/recommended *and* every installed package — including hard-to-install / GitHub-only / internal ones that r-universe lacks. r-universe (`/api/ls` + per-package `_exports`/`_dependencies`/`_datasets`, from both `cran.r-universe.dev` and `bioc.r-universe.dev`) appends packages not already present. Precedence: reference-R > r-universe > retained-from-prior; rebuilds never drop a package.
- **Contents:** export names + `Depends` + dataset names for the union above. **Export-only** — no internal (`:::`) objects, no signatures. A companion **base-exports file** (base/recommended records, from the reference R) ships alongside so base symbols + base datasets resolve in CI (§0.3).
- **Delivery (revised — see §0.2):** bundled as a **sidecar file** shipped with both the binary and the VS Code extension, located exe-relative with an override (`RAVEN_NAMES_DB`). **Not** `include_bytes!` (avoids binary bloat) and **not** committed to git. Stored on a **GitHub Release** (`names-db` tag) — durable across runs, which a per-run CI artifact is not — bootstrapped once from a richly-provisioned machine, then refreshed append-only. Small fixture databases (`names.db` + `.raven/packages.json`) **are** checked in, as format back-compat guards (§0.5).
- **Integrity & provenance:** the build records source, snapshot date, package count, Raven version, and a `blake3` checksum in the db header; verified at open (off-thread). The build is reproducible. Bundling third-party data carries supply-chain responsibility — provenance and a tamper check are part of the pipeline, not an afterthought.
- **Freshness:** equals Raven's release/refresh cadence (weekly + on release). Acceptable because the database is latest-only by decision and export names are stable; append-only means coverage only grows.

---

## 9. The generation command

One implementation, two entry points:

- **CLI subcommand** on the `raven` binary (name to finalize, e.g. `raven packages freeze`).
- **VS Code command** (e.g. *"Raven: Generate Package Database for CI"*).

Both share logic, take `--used` (default) or `--installed`/`--all`, apply the renv-first resolution and the renv.lock set rule (§7), and write `.raven/packages.json` with provenance.

**VS Code wiring invariant:** the command is registered manually via `vscode.commands.registerCommand`, so `executeCommandProvider.commands` must remain `vec![]` to avoid the double-registration startup crash.

---

## 10. Critical invariant: the database provides export names, never installation status

"Missing package" answers *"will `library(X)` succeed at runtime?"* — i.e. *is X installed?* A database knowing X's exports must **never** make X count as installed. The two concerns are decoupled:

- **Export resolution** (suppresses undefined-variable noise): tiers 1 → 2 → 3, in every mode.
- **Install-status** (drives the missing-package diagnostic): **Tier 1 only**, and only when Raven can actually determine it (R present / libpaths known).

This matches the code's existing separation: `package_exists()` checks base packages + filesystem package directories, deliberately independent of the export cache; missing-package diagnostics (`handlers.rs:4986`) are already suppressed when install state is unknown.

### 10.1 Per-mode behavior

| | Export resolution | Missing-package ("not installed") |
|---|---|---|
| **Language server (interactive)** | tiers 1→2→3 (no symbol storm even when R absent) | Fires when install-state is known and X is absent — **regardless of the database**. Unchanged from today. The database stops the undefined-variable storm but does not mask the "install this dependency" nudge. |
| **`raven check` (CI)** | tiers 1→2→3 | **Suppressed by default** (CI deliberately omits installation). Opt back in with a flag. |

### 10.2 The `--report-uninstalled` flag

`raven check --report-uninstalled` (name adjustable) re-enables missing-package warnings in CI — useful when a pipeline *does* install packages (e.g. `renv::restore()`) and wants to catch any that failed. Its documentation must state precisely that it reports `library()` calls **not present in the local library paths** — *not* relative to Tier 2/Tier 3 metadata.

### 10.3 Accepted gap

With missing-package off by default in `raven check`, a genuine typo such as `library(dpylr)` (unknown to every tier) is **silent** unless `--report-uninstalled` is passed. This is documented behavior. A future refinement — "fire only for packages unknown to *every* tier" — would catch typos by default without nagging about known-but-uninstalled packages; deferred unless demand appears.

---

## 11. Scope (v1) and explicit deferrals

**In v1:** export names + package structure (exports, `Depends` transitive attach, datasets, meta-package attaches) across all three tiers; the generation command; the CI behavior split.

**Deferred (noted, not built):**

- **Function signatures (`formals`).** Stay R-subprocess-only. A fast-follow can add a signatures payload to both the generation path (Rd `\usage` is high-fidelity for names/order via roxygen + CRAN `codoc`; minor default-value drift) and the shipped database.
- **`:::` internal-object resolution.** Internals come from `ls(asNamespace(pkg))`, not `getNamespaceExports()`; `PackageInfo` has no internal-objects field today. Capturable later for Tier 2 (the `.rdx` lists every object) via a new field; Tier 3 from r-universe `_exports` cannot supply it. Orthogonal to this design.

---

## 12. Performance discipline

LSP hot paths (diagnostic collection) use non-blocking `try_read` cache access. The Tier 3 mmap database must not introduce disk/page-fault stalls on those paths:

- load/decompress per-package entries off the hot path (or preload the index), and
- keep lookups lock-free under read locks (`peek`, no promotion) per the LRU-under-locks invariant.

The locking-discipline invariant for cross-file work (snapshot inputs under the lock, drop the guard, then iterate) continues to apply.

---

## 13. Fidelity caveats (to document)

- **`exportPattern` → solved.** r-universe `_exports` is the post-load truth, so the ~5% of packages that need a built-and-loaded namespace are correct, including the `.onLoad`∩pattern corner (r-universe loads namespaces). Tier 2, generated via `asNamespace()`, is equally correct.
- **Tier 3 latest-only drift.** A just-removed export lingering, or a brand-new export not yet rebuilt — rare and soft, and a project that cares can pin exactly via Tier 2.
- **Tier 3 carries exports + `Depends` + datasets, but no `:::` internals and no signatures** — those come only from a local install (Tier 1/2).
- **Bioconductor cadence** differs from CRAN; the shipped latest snapshot may not match a project's Bioc release train. Tier 2 covers projects that need exactness.

---

## 14. Testing strategy

- **Build-side differential:** diff `names.db` against R's `getNamespaceExports()` over a sample corpus where R is available → catches build/parse drift.
- **Generation round-trip:** on a machine with R, generate `.raven/packages.json`, read it back, and assert parity with the live Tier 1 result for the same packages.
- **No-R consumer fixture:** with empty libpaths, `library(dplyr); mutate(df, x = 1)` yields **no** undefined-variable; `library(dpylr)` behaves per §10 (silent in `raven check` by default, reported with `--report-uninstalled`, reported in the language server).
- **Tier precedence:** a package present in both Tier 2 and Tier 3 resolves from Tier 2; a package only in Tier 3 still resolves.
- **No regression:** existing R-present (Tier 1) tests stay green.

---

## 15. Documentation updates

- `docs/cli.md` — the new generation subcommand; `--report-uninstalled`; the `raven check` missing-package default change.
- `docs/diagnostics.md` — missing-package CI default and the names-vs-install-status distinction.
- `docs/cross-file.md` / `docs/r-package-dev.md` — the three-tier resolution and renv-aware generation.
- A new `docs/` page for the package database (tiers, the committed file, the generation command, fidelity caveats).
- Settings/manifest touchpoints if any new setting is added (the `--report-uninstalled` opt-in is a CLI flag, not an LSP setting; a `.raven/packages.json` path override, if added, follows the three-place VS Code settings-sync discipline and the alphabetical settings-reference regeneration).

---

## 16. Code touchpoints (existing seams)

- **Data model:** `PackageInfo` (`package_library.rs:110`); signature types in `parameter_resolver.rs:28`/`:48` (untouched in v1).
- **Producer convergence:** `PackageLibrary::initialize()` (`package_library.rs:946`) and `get_package()` (`:1145`) tiered loading.
- **Consumer — names:** `find_package_for_symbol()` (`:760`), `package_exists()` (`:1393`); diagnostics in `handlers.rs` (`collect_undefined_variables_from_snapshot:5373`, `collect_missing_package_diagnostics_from_snapshot:4986`).
- **Library-path discovery (renv-aware):** `get_lib_paths` (`r_subprocess.rs:320`), fallback `get_fallback_lib_paths` (`:1189`).
- **CI entry point:** `raven check` (`docs/cli.md`).

---

## 17. Open items for the plan — RESOLVED

All resolved during planning review (§0; full rationale in the plan's decisions ledger):

- **Names** → `raven packages freeze` and `raven check --report-uninstalled` (§0.4–0.5).
- **Tier 3 encoding** → custom container + `postcard` payloads + `memmap2`, `blake3` integrity, header-index preloaded at open + lazy per-package payload decode (§0.5; plan decision #3).
- **Resolution seam** → synchronous `PackageMetadataProvider` trait over Tier 2/3 only; Tier 1 bespoke (§0.1).
- **Build-job hosting & cadence** → GitHub Actions `build-names-db.yml` publishing to the `names-db` GitHub Release; weekly + `workflow_dispatch` + on release; append-only (§0.2).
