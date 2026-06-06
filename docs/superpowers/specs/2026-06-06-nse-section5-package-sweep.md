# NSE Policy Table — §5 Follow-up Sweep (Shiny / gt / gtsummary / recipes / parsnip / DBI / dbplyr)

Date: 2026-06-06 · Method: curated + empirical (no workflow), R 4.6.0

> Status: **implemented 2026-06-06** in `crates/raven/src/nse.rs`. Follows the
> §5 "natural next target" list from
> `2026-06-06-nse-attached-package-sweep.md`. Every addition was verified by
> reading `formals()` and probing the unique-sentinel / per-formal column
> behavior live in R 4.6.0, then adversarially re-probed (does a bare *undefined*
> symbol in the position actually error? is `...` evaluated or captured?). A
> design question on prefix-matching vs. enumeration was reviewed with a second
> agent before committing.

## Methodology caveat (read first)

Same sentinel limitation as the prior sweep: an undefined sentinel errors in
both a data-mask and standard eval. The discriminator used here is the **error
message shape**:

- `"Can't select columns that don't exist. ✖ Column \`.__s__\` doesn't exist"` ⇒
  **tidyselect** capture ⇒ suppress (a bare *column* resolves; the bare symbol is
  never looked up in the calling env).
- `"object '.__s__' not found"` ⇒ either a **data-mask** (bare column resolves,
  bare non-column falls through to the env) or **standard eval**. Disambiguated by
  also probing a real column: if a bare *column* name resolves, it is a data mask
  ⇒ suppress (same tradeoff as `mutate`/`lm(subset=)`); if even a real column is
  looked up in the env, it is standard eval ⇒ keep checked.

The data-mask tradeoff is the one already accepted project-wide: suppressing a
column position avoids false positives on bare column names but means a genuinely
undefined symbol there is no longer flagged.

## Executive summary

**~150 functions newly covered across 4 packages; 3 families (Shiny, parsnip,
DBI) surveyed with no additions.** The large, empirically uniform export
families are matched by **name prefix** rather than enumerated; the non-uniform
remainder is enumerated.

Count: gt — `fmt_*` (31, prefix) + `sub_*` (5, prefix) + `cells_*` (14, prefix,
whole-call) + 13 enumerated cols/tab/data_color/summary verbs · gtsummary 3 ·
recipes — `step_*` (98, prefix) + 3 role helpers + 5 user-facing `check_*` ·
dbplyr 1.

## 1. Confirmed additions

### gt → new `gt_policy` arm
Selects columns with tidyselect (`columns`, `after`, `hide_columns`,
`target_columns`, `spanners`, `groups`) and filters rows with a data mask
(`rows`); literal controls (`decimals`, `locale`, …) stay checked.

| Fn(s) | Match | ArgPolicy |
|---|---|---|
| `fmt_*` (31) | prefix | `per_formal(["data","columns","rows"], ["columns","rows"], false)` |
| `sub_*` (5) | prefix | `per_formal(["data","columns","rows"], ["columns","rows"], false)` |
| `cells_*` (14) | prefix | `WholeCall` (location helpers; all args are selectors/keywords) |
| `cols_hide`/`cols_unhide`/`cols_move_to_start`/`cols_move_to_end` | exact | suppress `columns` |
| `cols_move` | exact | suppress `columns`, `after` |
| `cols_label_with` | exact | suppress `columns` (check `fn`) |
| `cols_align` | exact | suppress `columns` |
| `cols_merge` | exact | suppress `columns`, `hide_columns`, `rows` |
| `cols_merge_n_pct`/`_range`/`_uncert` | exact | suppress the two column args + `rows` |
| `tab_spanner` | exact | suppress `columns`, `spanners` |
| `data_color` | exact | suppress `columns`, `rows`, `target_columns` |
| `summary_rows` | exact | suppress `groups`, `columns` |
| `grand_summary_rows` | exact | suppress `columns` |
| `row_group_order` | exact | suppress `groups` |

Why prefix for `fmt_*`/`sub_*`/`cells_*`: all 31 `fmt_*` and 5 `sub_*` exports
share `(data, columns, rows, …)` (0 non-conforming); all 14 `cells_*` are pure
location helpers. The `cols_*` family is *not* uniform (label/width/merge/add
variants differ), so its column-selecting members are enumerated and the rest
(`cols_label`, `cols_width`, `cols_units`, `cols_add`) left checked.

### gtsummary → new `gtsummary_policy` arm
| Fn | ArgPolicy |
|---|---|
| `tbl_summary` | suppress `by`, `include` (tidyselect); `label`/`type`/`statistic` are `col ~ "spec"` formula lists left checked for the `~` path |
| `tbl_continuous` | suppress `variable`, `include`, `by` |
| `tbl_cross` | suppress `row`, `col` |

`modify_header` and `tbl_uvregression` were **refuted**: their selector arguments
evaluate in the caller's environment (a bare undefined symbol is looked up, not
captured), so they stay checked.

### recipes → new `recipes_policy` arm
| Fn(s) | Match | ArgPolicy |
|---|---|---|
| `step_*` (98) | prefix | `per_formal(["recipe","..."], [], true)` |
| `update_role` | exact | suppress `...`; check `new_role`/`old_role` |
| `add_role` | exact | suppress `...`; check `new_role`/`new_type` |
| `remove_role` | exact | suppress `...`; check `old_role` |
| `check_class`/`check_cols`/`check_missing`/`check_new_values`/`check_range` | exact | `per_formal(["recipe","..."], [], true)` |

Why prefix for `step_*`: all 98 step constructors take tidyselect/data-mask
columns in `...`; selection is deferred to `prep()` so a bare undefined symbol
does not error at construction. The minimal `["recipe","..."]` model mirrors
`dplyr::select`/`transmute`. **TRADEOFF (documented):** named scalar controls
past `...` (e.g. `num_comp = k`) are absorbed and suppressed — the same data-mask
tradeoff already accepted for `mutate`. Role helpers list their controls so those
values stay checked.

Why **not** a `check_*` prefix: four `check_*` exports
(`check_name`/`check_new_data`/`check_options`/`check_type`) are internal helpers
with a different first formal, so the five user-facing column checks are
enumerated instead.

`recipes` is also added to `meta_package_members("tidymodels")` so a bare
`step_*` resolves under `library(tidymodels)` alone (recipes now carries NSE
policies, which is that list's membership criterion). `parsnip` stays out — it
has no policy.

### dbplyr → new `dbplyr` arm in `package_policy`
| Fn | ArgPolicy |
|---|---|
| `window_order` | `per_formal([".data","..."], [], true)` (ordering columns data-masked) |

`window_frame` (numeric `from`/`to`), `sql`/`build_sql`/`sql_expr` (strings) stay
checked. The dplyr verbs used on lazy tables (`mutate`/`filter`/…) already resolve
via `dplyr_policy` when dplyr is in play (the usual dbplyr setup).

## 2. Deliberately excluded (surveyed — no additions)

- **Shiny** — `reactive`/`observe`/`observeEvent`/`eventReactive`/`render*`/
  `isolate`/`req` capture their body but **evaluate it in the normal lexical
  scope**, so free symbols are *real references raven should check*. Probing
  `reactive(.__s__)` (then `isolate()`) and `isolate(.__s__)` both yield
  `object '.__s__' not found` — i.e. the symbol is looked up. **Standard eval;
  no additions.**
- **parsnip** — `set_engine`/`set_mode` take strings; `fit`/`fit_xy` take a
  `formula` (handled by the `~` path) + data; model specs (`linear_reg`, …) take
  literal tuning params. **No additions.**
- **DBI** — `dbGetQuery`/`dbExecute`/`dbSendQuery` take SQL **strings**;
  `dbReadTable`/`dbWriteTable` take table-name strings. **No additions.**
- **tidyselect helpers** (unchanged from prior sweep): `all_of`/`any_of` evaluate
  an external character vector — a typo there is a real bug, must stay checked.

## 3. Coverage and gaps

Probed live (R 4.6.0): gt 1.3.0, gtsummary 2.5.1, recipes 1.3.3, dbplyr 2.5.2,
parsnip, DBI, shiny.
Lower-confidence / follow-up: gtsummary `add_*`/`tbl_regression` passthrough
`...` (left checked — they forward to broom/standard eval, not column capture);
recipes `step_mutate`/`step_arrange`/`step_filter` data-mask exprs (covered by
the uniform `step_*` rule); dbplyr `tbl(src, ...)` table identifiers (usually
strings/`in_schema()` calls — left checked).

Not surveyed (natural next target): `ggplot2` non-`aes` mapping (`facet_*`,
`stat_*`), `data.table`'s `j`/`by` inside `[` beyond the existing set, `rlang`
`{{ }}` embracing, `glue`-style interpolation surfaces.
