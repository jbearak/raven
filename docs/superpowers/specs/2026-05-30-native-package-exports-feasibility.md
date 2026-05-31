# Feasibility: native (R-free) package exports & signatures

**Date:** 2026-05-30
**Status:** Feasibility memo — no commitment to build.
**Question:** Does Raven really need to call R subprocesses to get package exports? What exactly does R do that Raven does not, and how hard would it be for Raven to do it itself?

This memo records the analysis. It deliberately stops short of a design spec or
implementation plan; the closing section lists what a future spec would cover if
the work is ever greenlit.

---

## 1. What R actually does today

Raven's package intelligence is **mostly static**: it reads installed packages'
`NAMESPACE`, `DESCRIPTION`, `INDEX`, and `data/` files directly, with no R
session. It shells out to a short-lived, non-interactive R subprocess in exactly
**three** situations:

| # | What | Where | R expression | Fallback when R absent |
|---|------|-------|--------------|------------------------|
| 1 | Find where packages are installed | [`r_subprocess.rs:320`](../../../crates/raven/src/r_subprocess.rs) `get_lib_paths` | `.libPaths()` (renv-aware: sources `renv/activate.R` first) | hardcoded platform locations + `raven.packages.additionalLibraryPaths` |
| 2 | Expand `exportPattern()` exports | [`r_subprocess.rs:414`](../../../crates/raven/src/r_subprocess.rs) `get_package_exports` (+ batch `get_multiple_package_exports` at `:577`) | `getNamespaceExports(asNamespace(pkg))` | `INDEX` file + explicit `export()` entries (misses pattern-only / dynamic symbols) |
| 3 | Function signatures (hover / signature help) | [`r_subprocess.rs:649`](../../../crates/raven/src/r_subprocess.rs) `get_function_formals`, live via [`parameter_resolver.rs:333`](../../../crates/raven/src/parameter_resolver.rs) | `formals(fn)` / `formals(args(fn))` for primitives, resolved via `getExportedValue` / `asNamespace` | none — package-function signatures are simply unavailable |

Cases 1 and 2 are documented in [`docs/cross-file.md`](../../cross-file.md) under
"When Raven calls R." **Case 3 is currently undocumented.**

**Out of scope.** Raven's *other* R usage — the R console, Send-to-R, knit,
plot/data/help viewers, build commands — genuinely needs R because it **executes
the user's R code**. None of that is a candidate for native reimplementation.
Only the three static-analysis queries above are.

**Why a subprocess at all (not in-process).** The `r_subprocess` module doc makes
process isolation an explicit invariant: every call is wrapped in
`tokio::time::timeout()` so a hung R can't block the LSP, and user-controlled
strings are never interpolated into R code. This matters for §4.

---

## 2. The on-disk reality (what makes native parsing possible)

For an *installed* package (verified against `R.oo`, a real `exportPattern`
package, under `/Library/Frameworks/R.framework/.../library`):

- **`R/<pkg>.rdx`** — gzip-compressed RDS, ~4 KB. The lazy-load **index**: the
  **names of every object in the namespace** plus each object's `(offset, length)`
  into the `.rdb`. Expanding `exportPattern("<regex>")` = read these names, apply
  the regex. Needs only a *minimal* RDS reader (lists / strings / symbols / ints /
  attributes).
- **`R/<pkg>.rdb`** — the blob store: each object is a separately-compressed RDS
  chunk at the offset the `.rdx` records. Seek + decompress + RDS-parse one
  closure → its `formals` (parameter names + default expressions). Needs the
  *full* SEXP reader + an R-expression deparser.
- **`Meta/nsInfo.rds`** — gzip RDS, the *parsed* NAMESPACE (exports, patterns,
  imports, S3 methods).

**Prevalence:** of 299 installed packages on the test machine, only **15 (~5%)**
use `exportPattern` (`AsioHeaders carData e1071 exactRankTests fields jpeg KMsurv
mcmcplots png R.utils R.methodsS3 R.oo raster roxygen2 snow`). This matches the
docs' "minority" and bounds the value of case 2.

**Bonus beneficiary:** dataset discovery today is purely **filename-based**
([`namespace_parser.rs:452`](../../../crates/raven/src/namespace_parser.rs)) — it
never deserializes `.rda`/`.rds`. A native RDS reader would also yield real
dataset object names.

**Current dependencies:** `regex 1.10` is present, but it is Rust's regex engine
(not POSIX ERE), so `exportPattern` matching would be *close to* but not
byte-identical with R's `grepl` — a small fidelity caveat. gzip/bzip2/xz are
**not** yet dependencies; even reading the gzip'd `.rdx` needs a new
decompression crate.

---

## 3. The two parity ceilings (what no static reader can reach)

Full parity is achievable for **what R serializes to disk**, but two cases are
unreachable in principle by *any* static implementation:

1. **Symbols created by load hooks.** `getNamespaceExports()` reflects the
   namespace *after* `loadNamespace` runs the package's `.onLoad`/`.onAttach`
   hooks. Most exports are *not* affected by this, so it is worth being precise
   about the true size of the gap:
   - Export *names* for `export()`, `exportClasses()`, `exportMethods()` are
     literal in `NAMESPACE` — known statically today (e.g. `raster` lists all 7
     classes and ~250 methods verbatim).
   - S4 class/method objects from *top-level* `setClass`/`setGeneric`/`setMethod`
     **are** serialized into `.rdx` at build time, so they are reachable.
     **Verified empirically:** decompressing `raster`'s `.rdx` shows the class and
     method-table objects directly (`.__C__RasterLayer`, `.__C__Extent`,
     `.__T__$:base`, … — 1650 objects). An earlier draft of this memo wrongly
     listed S4-at-load as a blind spot; it is not.
   - The only genuinely unreachable exports are bindings an `.onLoad`/`.onAttach`
     hook creates at *load* time (`assign()` into the namespace,
     `makeActiveBinding`) **and** that match an `exportPattern()` /
     `exportClassPattern()`. That intersection — a rare mechanism, within the ~5%
     pattern packages, with the pattern actually matching the dynamic name — is
     vanishingly small.

   The deeper point: R sees those stragglers only because
   `getNamespaceExports(asNamespace(pkg))` *loads the package and runs `.onLoad`*.
   Being provably 100% complete requires executing the package's load code —
   exactly the subprocess we are removing. FFI to `libR` would not close it either
   unless it loaded the namespace (ran `.onLoad`), i.e. ran R. So this residual is
   the irreducible cost of static analysis, not a weakness of a Rust reader.

   **Crucially, today's subprocess already catches this corner.** Raven currently
   runs `getNamespaceExports(asNamespace(pkg))`, and `asNamespace` loads the
   namespace (runs `.onLoad`) — so for the ~5% pattern packages where Raven shells
   out today, it *does* see `.onLoad`-created pattern matches. A native reader is
   therefore not "parity minus nothing": going **pure-native** would *regress* this
   sliver. For the pattern packages, the four cases are:

   | | R present | R absent |
   |---|---|---|
   | **Today** | subprocess loads → **full** (incl. `.onLoad`∩pattern) | `INDEX` + explicit → **crude** |
   | **Native** | keep subprocess → **full** (unchanged); *or* pure-native → **loses** `.onLoad`∩pattern | `.rdx` → **near-full** (misses only `.onLoad`∩pattern) |

   So the native reader is a *strict improvement* to the R-absent path (beats
   `INDEX`) and only forfeits a current capability if the subprocess is also
   deleted. This is the decisive argument for the **hybrid** architecture (§6):
   native reader as the R-free floor, subprocess as the ceiling when R is present —
   no regression anywhere.
2. **Programmatic library paths.** `.Rprofile` / `Rprofile.site` can call
   `.libPaths(...)` with arbitrary logic. `renv.lock` + env vars + standard
   locations cover the overwhelming majority, but arbitrary startup code is
   unreplicable.

These ceilings are the reason a future design keeps R as an *optional oracle*
rather than deleting it (see §6).

---

## 4. Why "just call R's C code" does not solve this

R is open source and its (de)serializer is C, so the natural question is: why
reimplement it in Rust instead of calling it via FFI? "Call R's C code" splits
into two very different things.

**Licensing is not the obstacle.** Raven is **GPL-3.0** ([`LICENSE`](../../../LICENSE),
`Cargo.toml`, `package.json`) and R is GPL-2/3, so linking `libR` raises no
license problem. The obstacles are technical.

### Option A — FFI to R's own C (`libR` / `serialize.c`). Excluded by the goal.

1. **It cannot satisfy zero-R.** `serialize.c` is not freestanding C. Every
   primitive it uses (`Rf_allocVector`, `mkChar`, `install`, `CONS`, the REFSXP
   reference table, the ALTREP class registry) constructs **SEXPs** via R's
   allocator, GC, symbol table, and startup-registered ALTREP classes. You cannot
   compile `serialize.c` alone — to use it you must embed **all of `libR`** via
   `Rf_initEmbeddedR()`, which requires an R installation present (`R_HOME` + base
   packages). FFI to `libR` is "R, in-process" — not "no R." If R is not
   installed, there is no `libR` to call.
2. **A thin shim collapses into reimplementing R.** Stubbing out
   `allocVector`/`mkChar`/`install` to build your own structs instead of SEXPs
   *is* rewriting R's object model — more work than parsing the format directly.
   The reusable surface area of `serialize.c` minus the rest of `libR` is near
   zero.
3. **Even where R is installed, embedding is a robustness downgrade.** R is
   single-threaded, non-reentrant, and uses `longjmp` for errors with C-stack
   checks; the LSP is async and multithreaded (tower-lsp). An R error/hang/crash
   in-process can take down the server — discarding the deliberate subprocess
   isolation (§1). `libR`'s internal ABI is not stable across R versions
   (relink per version). And it buys nothing the subprocess does not already
   provide, since the only *new* capability is zero-R, which FFI-to-`libR`
   structurally cannot deliver.

### Option B — FFI to a standalone C library that parses the RDS *format*. Partial.

This is the legitimate "reuse C, no R" path: e.g. `librdata` (Evan Miller's C
library behind Python's `pyreadr`) reads `.rds`/`.rda` with no R installed,
proving the **format** is parseable without the runtime. The catch is scope:
`librdata`-class libraries target **data objects** (data frames, vectors). They
do **not** deserialize **closures / language objects** or navigate lazy-load
`.rdb`/`.rdx` — because no freestanding C library does; the only C that
deserializes R closures is `libR` itself (Option A). So a standalone C lib covers
**datasets** and *maybe* the `.rdx` name list, but **not signatures** — the hard
half.

### "Rewrite the serializer" overstates it.

RDS is a **stable, documented, versioned wire format**, distinct from R's
runtime. Implementing a reader for it is a bounded *format-parsing* task — like a
PNG or Parquet reader written without linking the reference implementation's whole
runtime. It emits Rust values (a list of names; a formals list as strings), never
R objects. **Decision (this memo): pure Rust, all of it** — no C toolchain, no
cross-platform `.a`/`.dll` story, one language, full control.

---

## 5. The circularity — and the real (narrower) value

Package exports and signatures come from **installed package files**
(`.rdx`/`.rdb`/`NAMESPACE`). Those exist only because the packages were
*installed*, which requires R. A reviewer with **truly no R toolchain** usually
also has **no installed library tree** to read — so there is nothing for the
native reader to parse.

So "zero-R" most realistically means **"no R *subprocess execution*, given
package files already on disk"** — not "no R artifacts anywhere." The genuine
beneficiaries:

- locked-down / sandboxed / CI environments where spawning R is slow, restricted,
  or non-deterministic;
- remote/container hosts with a **mounted or copied** `library/` (or `renv`
  cache) but no working R binary;
- anyone wanting fully deterministic, no-subprocess static analysis.

And the ceiling on the other side: even a perfect reader removes R only from
**static analysis**. The R console, Send-to-R, knit, plot/data/help viewers, and
build commands all execute R and are untouched. **This narrows one R dependency;
it does not make Raven R-free.**

---

## 6. If it were ever built: design shape & effort

Recorded for completeness; not a commitment.

**One asset, three payoffs.** A pure-Rust `rds` reader (RDS v2/v3 + common
ALTREP classes; gzip/bzip2/xz) plus a lazy-load `.rdx`/`.rdb` navigator yields:
`.rdx` names → `exportPattern` expansion; `.rdb` closures → signatures (+ an
R-expression deparser for defaults); `.rda`/`.rds` → real dataset names.

**Independent piece.** Native `.libPaths()` — `renv.lock` + `R_LIBS_*` +
version/platform-derived defaults. No RDS reader needed; brittle only at the
`.Rprofile` edge (Ceiling 2).

**Architecture.** Native-first behind a `PackageMetadataProvider` trait with
`NativeRds` + `RSubprocess` impls. When R is present it serves two roles: at
runtime it stays the **authority for the `.onLoad`∩pattern corner** the native
reader cannot reach (§3), so the hybrid regresses nothing relative to today; and
in CI it is a **differential-testing oracle** — diff both paths over a package
corpus so the reader never silently drifts. Native reader as the R-free floor,
subprocess as the ceiling when R is present. Never silently wrong; zero-R works
without it.

**Build order** (each milestone ships and self-validates against R):
1. minimal RDS reader + gzip → `exportPattern` expansion (~1–2 weeks; kills the
   case-2 subprocess for the ~5% of packages that need it);
2. full SEXP reader + lazy-load `.rdb` navigation + bzip2/xz;
3. R-expression **deparser** for default values → signatures;
4. native `.libPaths()` + renv;
5. `PackageMetadataProvider` trait, caching, differential-test harness.

**Effort: months,** lopsided. The **deparser long tail** (operator precedence,
control flow, indexing, special forms) and ALTREP/compression edges are the
open-ended risk. The step-1 slice is cheap and high-value-per-effort; the
signatures slice is where parity gets expensive.

---

## 7. Verdict

- **Does Raven *need* R for package exports?** For ~95% of packages, no — exports
  are already read statically from `NAMESPACE`. R is needed today only for the
  ~5% using `exportPattern` (case 2), for library-path discovery (case 1), and
  for function signatures (case 3).
- **What does R do that Raven doesn't?** Expand `exportPattern` against the loaded
  namespace, discover `.libPaths()` (renv/env/version-aware), and read `formals`.
- **How hard to do natively?** `exportPattern` and signatures both reduce to one
  asset — a pure-Rust RDS + lazy-load reader — feasible but months-scale for full
  parity, with the deparser as the long pole. `.libPaths()` is moderate and
  brittle.
- **Worth it?** Tempered by two facts: the **circularity** (no toolchain usually
  means no packages to read, so the real win is "no subprocess," not "no R"), and
  that **execution features need R regardless.** The cheap `exportPattern` slice
  is the only piece with a clearly favorable effort/value ratio; full parity is a
  large investment for a narrow scenario.

A future implementation spec, if pursued, would formalize §6: the `rds` crate's
supported SEXP types and ALTREP classes, the lazy-load DB format, the deparser's
coverage target and fallback, the `PackageMetadataProvider` trait boundary, the
differential-test corpus, and the `.libPaths()` resolution algorithm with its
documented unreplicable edges.
