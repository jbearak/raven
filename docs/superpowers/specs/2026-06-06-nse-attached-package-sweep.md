# NSE Policy Table — Attached/Ecosystem Package Sweep (research)

Date: 2026-06-06 · Workflow: `nse-attached-package-sweep` (66 agents, R 4.6.0)

> Status: **implemented 2026-06-06** in `crates/raven/src/nse.rs`. All 43 confirmed
> additions landed (including the Tier-3 data-maskers, per maintainer decision).
> Produced by a multi-agent sweep: per-package static NSE detection + empirical
> unique-sentinel probing, then an adversarial refutation pass that independently
> re-probed every proposed addition. Before implementing, the maintainer re-verified
> every function's `formals()` and the tricky captures (Tier-1 data-maskers, the
> `rename_with`/`tar_pattern` dots-not-captured corrections, `dplyr` re-export of the
> `tibble` constructors) against R 4.6.0. The refuted/excluded sets in §3 were NOT
> added. Implementation note: default-attached `stats`/`methods` helpers (`lm`, `glm`,
> `hasArg`, …) live in `base_policy` + `builtin_nse_home` (home `"stats"`/`"methods"`),
> not `package_policy`, so **bare** calls resolve without the package being in-play.

## Methodology caveat (read first)

The unique-sentinel probe (`f(.__probe__)` → "object not found" ⇒ evaluated) cleanly
classifies **pure-capture** NSE (`help`, `rm`, `quote`, `getAnywhere`). It does **not**
cleanly separate a **data-mask** (`lm(subset=)`, `tibble()`, dplyr verbs) from
standard-eval, because an undefined sentinel errors in both. Data-masking captured-
formal sets below are therefore lower-confidence than the name-helper ones and should
be re-verified per-formal (bare *column* name resolves ⇒ suppress) before committing.
Confirmed for the Tier-1 data-maskers; the rest inherit the same shape but were not all
hand-verified.

The data-masking tradeoff: suppressing `subset`/`weights`/columns avoids false positives
on bare column names, but means a *genuinely* undefined symbol there (`lm(..., subset = typo)`)
is no longer flagged. This is identical to the tradeoff already accepted for `mutate`/`filter`.

## Executive summary

**43 additions survived refutation.** 6 proposed `add`s were refuted as standard-eval
lookalikes (`get_all_vars` + the conditional-NSE stats family generators `poisson`,
`quasibinomial`, `quasipoisson`, `quasi`, `C`); 4 more GLM family generators
(`binomial`, `gaussian`, `Gamma`, `inverse.gaussian`) were conservatively excluded as a
group because they share the identical conditional-NSE mechanism. Three confirmed
additions required corrections (`rename_with` and `tar_pattern` → `dots_captured=false`;
`data_frame` → formals reduced to `["..."]`). **No existing table entry was mismodeled.**

Count: base 1 · utils 7 · methods 1 · stats 7 · dplyr 6 · tidyr 9 · targets 9 · tibble 3.

## 1. Confirmed additions (survived refutation)

### base → `base_policy` (home `base`, no `builtin_nse_home` edit)
| Fn | ArgPolicy | Likelihood |
|---|---|---|
| `alist` | `ArgPolicy::WholeCall` | low |

Body is `as.list(sys.call())[-1L]` (pure capture); WholeCall is exact, mirrors `expression`.

### utils → `base_policy` **and** `builtin_nse_home` ⇒ `"utils"`
Add `"news" | "getAnywhere" | "argsAnywhere" | "demo" | "fix" | "debugcall" | "undebugcall" => "utils"`
to the existing `"data" | "help" | "example" => "utils"` arm.

| Fn | ArgPolicy | Likelihood |
|---|---|---|
| `news` | `per_formal(&["query","package","lib.loc","format","reader","db"], &["query"], false)` | medium |
| `getAnywhere` | `per_formal(&["x"], &["x"], false)` | medium |
| `argsAnywhere` | `per_formal(&["x"], &["x"], false)` | medium |
| `demo` | `per_formal(&["topic","package","lib.loc","character.only","verbose","type","echo","ask","encoding"], &["topic"], false)` | medium |
| `fix` | `per_formal(&["x","..."], &["x"], false)` | low |
| `debugcall` | `per_formal(&["call","once"], &["call"], false)` | low |
| `undebugcall` | `per_formal(&["call"], &["call"], false)` | low |

### methods → new `package_policy` arm `"methods"`
| Fn | ArgPolicy | Likelihood |
|---|---|---|
| `hasArg` | `per_formal(&["name"], &["name"], false)` | medium |

Optional sibling (NSE, not refuted): `missingArg` → `per_formal(&["symbol","envir","eval"], &["symbol"], false)`.

### stats → new `package_policy` arm `"stats"`
`formula` is left **checked** in every entry (raven's `in_formula` path already covers `~`).

| Fn | ArgPolicy | Likelihood |
|---|---|---|
| `lm` | `per_formal(&["formula","data","subset","weights","na.action","method","model","x","y","qr","singular.ok","contrasts","offset","..."], &["subset","weights","offset"], false)` | high |
| `glm` | `per_formal(&["formula","family","data","weights","subset","na.action","start","etastart","mustart","offset","control","model","method","x","y","singular.ok","contrasts","..."], &["weights","subset","etastart","mustart","offset"], false)` | high |
| `loess` | `per_formal(&["formula","data","weights","subset","na.action","model","span","enp.target","degree","parametric","drop.square","normalize","family","method","control","..."], &["weights","subset"], false)` | medium |
| `nls` | `per_formal(&["formula","data","start","control","algorithm","trace","subset","weights","na.action","model","lower","upper","..."], &["subset","weights"], false)` | medium |
| `xtabs` | `per_formal(&["formula","data","subset","sparse","na.action","na.rm","addNA","exclude","drop.unused.levels"], &["subset"], false)` | medium |
| `oneway.test` | `per_formal(&["formula","data","subset","na.action","var.equal"], &["subset"], false)` | low |
| `factanal` | `per_formal(&["x","factors","data","covmat","n.obs","subset","na.action","start","scores","rotation","control","..."], &["subset"], false)` | low |

### dplyr → extend `dplyr_policy`
| Fn | ArgPolicy | Likelihood |
|---|---|---|
| `join_by` | `ArgPolicy::WholeCall` | high |
| `top_n` | `per_formal(&["x","n","wt"], &["n","wt"], false)` | high |
| `tally` | `per_formal(&["x","wt","sort","name"], &["wt"], false)` | medium |
| `add_tally` | `per_formal(&["x","wt","sort","name"], &["wt"], false)` | medium |
| `with_groups` | `per_formal(&[".data",".groups",".f","..."], &[".groups"], true)` | medium |
| `rename_with` | `per_formal(&[".data",".fn",".cols","..."], &[".cols"], false)` | medium |

`rename_with` CORRECTED: survey said `dots_captured=true`; refutation proved dots are evaluated by `.fn(sel, ...)`. Use `false`.

### tidyr → extend `tidyr_policy`
| Fn | ArgPolicy | Likelihood |
|---|---|---|
| `chop` | `per_formal(&["data","cols","...","error_call"], &["cols"], false)` | medium |
| `unchop` | `per_formal(&["data","cols","...","keep_empty","ptype","error_call"], &["cols"], false)` | medium |
| `pack` | `per_formal(&[".data","...",".names_sep",".error_call"], &[], true)` | low |
| `unpack` | `per_formal(&["data","cols","...","names_sep","names_repair","error_call"], &["cols"], false)` | low |
| `separate_rows` | `per_formal(&["data","...","sep","convert"], &[], true)` | medium |
| `uncount` | `per_formal(&["data","weights","...",".remove",".id"], &["weights"], false)` | medium |
| `separate_wider_delim` | `per_formal(&["data","cols","delim","...","names","names_sep","names_repair","too_few","too_many","cols_remove"], &["cols"], false)` | medium |
| `separate_wider_position` | `per_formal(&["data","cols","widths","...","names_sep","names_repair","too_few","too_many","cols_remove"], &["cols"], false)` | low |
| `separate_wider_regex` | `per_formal(&["data","cols","patterns","...","names_sep","names_repair","too_few","cols_remove"], &["cols"], false)` | low |

### targets → extend existing `"targets"` arm
| Fn | ArgPolicy | Likelihood |
|---|---|---|
| `tar_read` | `per_formal(&["name","branches","meta","store"], &["name"], false)` | high |
| `tar_load` | `per_formal(&["names","branches","meta","strict","silent","envir","store"], &["names"], false)` | high |
| `tar_meta` | `per_formal(&["names","fields","targets_only","complete_only","store"], &["names","fields"], false)` | medium |
| `tar_objects` | `per_formal(&["names","cloud","store"], &["names"], false)` | medium |
| `tar_progress` | `per_formal(&["names","fields","store"], &["names","fields"], false)` | low |
| `tar_branch_names` | `per_formal(&["name","index","store"], &["name"], false)` | low |
| `tar_branches` | `per_formal(&["name","pattern","script","store"], &["name","pattern"], false)` | low |
| `tar_pattern` | `per_formal(&["pattern","...","seed"], &["pattern"], false)` | low |
| `tar_deps` | `per_formal(&["expr"], &["expr"], false)` | low |

`tar_pattern` CORRECTED: dots are evaluated (`lapply(list(...), as.integer)`) → `dots_captured=false`, capture only `pattern`. `tar_read.branches` is evaluated (not enquo'd) → stays checked.

### tibble → new `package_policy` arm `"tibble"`
| Fn | ArgPolicy | Likelihood |
|---|---|---|
| `tibble` | `per_formal(&["...",".rows",".name_repair"], &[], true)` | high |
| `tibble_row` | `per_formal(&["...",".name_repair"], &[], true)` | medium |
| `data_frame` | `per_formal(&["..."], &[], true)` | low |

`data_frame` CORRECTED: its only formal is `...`. Deprecated alias; include only to maximize coverage.
Note: `dplyr::tibble` is `identical()` to `tibble::tibble` — resolver keys by `(package, name)`, so the dplyr arm may also need routing or rely on meta-member resolution.

## 2. Current-table corrections

**None.** Re-verified entries (`quote`, `substitute`, `bquote`, `expression`, `evalq`,
`on.exit`, `library`/`require`, `with`/`within`, `subset`, `transform`, `rm`/`remove`,
`save`, `help`, `example`, `data`, `curve`, `mutate`, `filter`, `count`, `pull`,
`pivot_longer`, `tar_target`, `stats::filter`) all confirmed correct.

## 3. Deliberately excluded (standard-eval lookalikes — MUST NOT add)

- **stats conditional-NSE** (refuted): `poisson`, `quasibinomial`, `quasipoisson`, `quasi`, `C` — capture only a fixed whitelist of magic literals; any other symbol (typo/undefined) is evaluated, so a `per_formal` mask would silence real bugs. The valid bare names (`logit`, `log`, …) are already raven builtins ⇒ near-zero FP protection.
- **GLM family group** (conservative): `binomial`, `gaussian`, `Gamma`, `inverse.gaussian` — refutation *upheld* these but they share the identical mechanism as the refuted four. Excluded as a group; decide together if ever revisited.
- **`stats::get_all_vars`** (refuted): no `subset` formal (survey invented it); all positions evaluated.
- **`stats::model.frame.default`**: if the S3 generic `model.frame` is ever keyed, use `dots_captured=true`: `per_formal(&["formula","data","subset","na.action","drop.unused.levels","xlev","..."], &["subset"], true)`.
- **Confirmed standard-eval (documented):** base `call`/`switch`/`local`/`try`/`replicate`/`do.call`/`stopifnot`/`Vectorize`/`match.arg`/…; utils `vignette`/`citation`/`View`/`packageVersion`/…; methods `setClass`/`setGeneric`/`new`/`slot`/…; the stats `deparse(substitute(x))` *label* trap (`acf`, `*.test`, `density.default`, `interaction.plot`, `ecdf`, …); graphics `plot.default`/`matplot`/`hist.default`/…; **tidyselect `all_of`/`any_of`/`one_of` (evaluate an external char vector — `all_of(typo)` is a real bug, must stay checked)**, `starts_with`/`ends_with`/… (take strings); rlang `inject`/`eval_tidy`/`sym`; data.table `setkeyv`/`fcase`/`dcast`; **glue/str_glue (interpolate inside string literals — no AST identifier to flag)**; purrr (only `~` lambda, already covered); tibble `tribble`/`add_column`.

## 4. Priority ranking

**Tier 1 (ship first):** `dplyr::join_by`, `stats::lm`, `stats::glm`, `tibble::tibble`,
`targets::tar_read`, `targets::tar_load`, `dplyr::top_n`.

**Tier 2:** `utils::news`/`demo`/`getAnywhere`/`argsAnywhere`, `methods::hasArg`,
`stats::loess`/`nls`/`xtabs`, `dplyr::tally`/`add_tally`/`with_groups`/`rename_with`,
`tidyr::chop`/`unchop`/`separate_rows`/`uncount`/`separate_wider_delim`,
`tibble::tibble_row`, `targets::tar_meta`/`tar_objects`.

**Tier 3 (consistency):** `stats::oneway.test`/`factanal`, `base::alist`, `utils::fix`/`debugcall`/`undebugcall`,
`tidyr::pack`/`unpack`/`separate_wider_position`/`separate_wider_regex`, `tibble::data_frame`,
`targets::tar_progress`/`tar_branch_names`/`tar_branches`/`tar_pattern`/`tar_deps`.

## 5. Coverage and gaps

Reached/probed live (R 4.6.0): base (1407 exports), utils (237), methods, stats, graphics,
grDevices (137), datasets, tools (138); dplyr 1.2.1, tidyr 1.3.2, ggplot2 4.0.3, rlang 1.2.0,
data.table 1.18.4, targets 1.12.0, tidyselect, glue, purrr, stringr, tibble, forcats, lubridate, bit64.

Lower-confidence / follow-up: destructive `targets` verbs (`tar_delete`/`tar_invalidate`)
inferred not executed; `methods::missingArg` (NSE, not refuted); `stats::model.extract`
(internal); `grDevices::recordGraphics` (held off).

Not surveyed (largest remaining NSE surfaces, natural next target): Shiny
(`reactive`/`observe`/`render*`), `gt`/`gtsummary`, `recipes`/`parsnip`, `DBI`/`dbplyr` lazy SQL.
