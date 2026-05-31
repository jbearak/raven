# Package Export Databases (Offline & CI Gating)

> **Status: planned — tracking [the CI package-exports DB work]. Not yet available in a released build.**

To allow Raven to resolve package exports and lazy-loaded datasets without requiring an active R installation or on-disk package installation, Raven implements an ordered, three-tier fallback mechanism. This is designed primarily for zero-install CI/CD pipelines (enabling `raven check` to run immediately on unprovisioned containers) and offline development.

---

## The Three Tiers of Export Resolution

| Tier | Name / Location | Source / Capture Mechanism | Scope / Fidelity | Usage Environment |
|---|---|---|---|---|
| **Tier 1** | Local Installation | Live R library paths (`.libPaths()`) | Full fidelity: public exports, datasets, internal `:::`, function parameter lists. | Local developer machine, fully provisioned containers. |
| **Tier 2** | Repository Database (`.raven/packages.json`) | Static JSON generated via `raven packages freeze` and committed to git. | Public exports and dataset names for project-specific dependencies only. No parameter lists or `:::`. | CI gating pipelines, joint team environments. |
| **Tier 3** | Shipped Database (`names.db`) | Compiled weekly from CRAN, Bioconductor, and reference R; bundled next to Raven's binary. | Global fallback. Public exports and dataset names for almost all CRAN/Bioc packages. No parameter lists or `:::`. | Fallback in all environments when local or repo databases miss. |

---

## Tier 2: Repository Database (`.raven/packages.json`)

The Tier 2 database is a committed, project-specific JSON file. It should **never be edited by hand**; instead, it is generated via the CLI or the VS Code editor.

### Generation (`raven packages freeze`)

To generate or update `.raven/packages.json`, run the freeze command in an environment where your project's dependencies are fully installed (e.g., right after `renv::restore()`):

```bash
raven packages freeze
```

Under `--used` (the default scope):
1. **Maximally-Inclusive Detection:** Raven scans the entire workspace workspace-scripts tree to gather all package references from `library()`, `require()`, `loadNamespace()`, `requireNamespace()`, as well as `::` and `:::` namespace operators.
2. **`renv.lock` Integration:** If `renv.lock` is present, it acts as a **set selector** (which package names to include), ignoring version numbers.
3. **Repository Metadata:** It parses the project's own `DESCRIPTION` file for `Imports` and `Depends` fields.
4. **Transitive Dependencies:** It traverses and adds all transitive `Depends` for each detected package (since loading a package implicitly attaches its `Depends` list).

All detected packages are then looked up against your installed library (Tier 1) and written out to `.raven/packages.json`.

### Key Invariants

- **Deterministic and Diff-Friendly:** Inside `.raven/packages.json`, package records are sorted alphabetically, and their respective exports, depends, and lazy-data names are sorted and de-duplicated. This ensures that regenerating the file does not create random git noise.
- **No-Op When Unchanged:** If you run `raven packages freeze` and the resulting package contents are identical to what is already on disk, Raven **will not write to the file** (preventing timestamp-only changes from causing dirty git states).
- **Version-Skew Safety:** If a newer Raven version generates `.raven/packages.json` with a higher `schema_version` than your current Raven binary understands, or if the file becomes corrupted, **Raven will not crash**. It will print an explanatory warning to stderr (or show an editor warning notification) and degrade gracefully to Tier 3.

---

## Tier 3: Shipped Global Database (`names.db`)

The Tier 3 database is a read-only, memory-mapped binary container bundled with Raven's distribution. It acts as an absolute safety floor.

### Construction and Freshness

The database is built and updated automatically every week via a GitHub Actions workflow (`build-names-db.yml`) and is published on a moving **GitHub Release** tagged `names-db`. 

- **Reference-R Seed:** The build job bootstraps from a richly-provisioned reference machine containing a full installation of R, CRAN, and Bioconductor packages. This captures the complete set of exports, datasets, and complex regex-pattern exports (`exportPattern()`).
- **Append-Only Merging:** Rebuilds download the prior `names.db` Release asset and overlay new CRAN and Bioconductor updates from `r-universe` APIs. Packages are **never dropped**, guaranteeing that old, archived, custom, or internal packages originally bootstrapped into the seed remain in the database forever.
- **Integrity Gating:** Every database contains a `blake3` checksum of its payload region verified upon opening. Opening the database is offloaded to a background thread using `spawn_blocking` to preserve the real-time responsiveness of the LSP.

### Base-Exports Companion File

Because base R packages (such as `stats`, `graphics`, `utils`) also use dynamic patterns like `exportPattern` to export their symbols, Raven bundles a companion `base-exports.json` file. When `raven check` runs in CI without any R installation on disk, this file is loaded during `initialize()` to populate the base exports, allowing common functions and base datasets (like `mtcars` or `iris`) to resolve natively.

---

## Dataset (Lazy-Data) Resolution

R packages frequently expose data symbols (such as `mtcars`, `flights`, or `diamonds`) that are not listed in traditional namespace exports. Thanks to prerequisite [raven#350](https://github.com/jbearak/raven/issues/350), both Tier 2 and Tier 3 capture these symbols in the `lazy_data` field of the package record. 

When a package is attached (either via `library()` or transitively), these dataset symbols are automatically folded into the resolvable scope, resolving them under CI gating.

---

## Fidelity Caveats & Known Gaps

While Tier 2 and Tier 3 databases are highly effective at suppressing undefined-variable noise, they are not a perfect substitute for a live R installation (Tier 1). Be aware of the following design trade-offs:

1. **Latest-Only CRAN Drift:** Because Tier 3 is updated weekly from CRAN/Bioconductor, it tracks the *latest* public release of each package. If your project relies on an older version of a package that has since removed or renamed a function, the global database will reflect the newer names. To lock your specific package versions, generate a local **Tier 2** database (`packages.json`) on your machine instead.
2. **No `:::` Internal Object Resolution:** Fallback databases only store public exports. Direct calls to internal package namespaces (e.g., `dplyr:::mutate_template`) cannot be validated offline and will be ignored or flagged depending on your configuration.
3. **No Signature Autocomplete:** Autocomplete hints and hover text will not show formal parameter lists (`formals`) when resolving packages from Tier 2 or Tier 3. Parameter lists are dynamic and require R-subprocess execution.
4. **Bioconductor Cadence:** The weekly update script queries both `cran.r-universe.dev` and `bioc.r-universe.dev`. Slower release cadences or custom Bioconductor branches may exhibit minor delay before appearing in Tier 3.
