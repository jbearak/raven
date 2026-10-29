# Linting

[Docs](README.md) › Analysis

Raven's optional style linter checks line length, naming, spacing, and 15 more of [`lintr`](https://lintr.r-lib.org/)'s default rules as you type and in CI, with no R session or `lintr` install.

| You write | Rule | Why it's flagged |
|---|---|---|
| `x = 1` | `assignment_operator` | The default style is `<-` for assignment. |
| `if (x == NA)` | `equals_na` | Comparing with `NA` always returns `NA`; use `is.na(x)`. |
| `f( x )` | `spaces_inside` | No spaces just inside parentheses. |
| `plot(T)` | `t_and_f_symbol` | `T` and `F` can be reassigned; write `TRUE` and `FALSE`. |

Raven implements 18 of `lintr`'s rules, most of its default set, in Rust on the same parse tree it already builds for completion and diagnostics.

> [!NOTE]
> In Raven, "linting" means subjective style rules, and the whole group is off until you turn it on. Correctness diagnostics (parse errors, semantic warnings, cross-file issues, assignment-target errors) are on by default and are not controlled by `raven.linting.*`; see [Diagnostics](diagnostics.md). For example, the orphan-`else` parse error is a diagnostic, not a lint.

## Quick start

Turn linting on in any of three ways.

In a `raven.toml` at the project root, which the editor and the CLI both read:

```toml
[linting]
enabled = true
```

In a `.lintr` file at the project root, if you already use `lintr` (Raven reads a [subset](#migrating-from-lintr)):

```r
linters: linters_with_defaults(line_length_linter(120))
```

In VS Code settings, for yourself only:

```json
{
  "raven.linting.enabled": true
}
```

From a terminal, `raven lint .` always lints, whether or not the project turns linting on. See [`raven lint`](cli.md#raven-lint).

All rules default to severity `information`, matching how REditorSupport's `languageserver` maps `lintr` style findings. To raise a rule to `warning`, lower it to `hint`, or turn it off, set its severity:

```json
{
  "raven.linting.enabled": true,
  "raven.linting.lineLengthSeverity": "warning",
  "raven.linting.commentedCodeSeverity": "off"
}
```

To change the line-length limit or allow other naming styles:

```json
{
  "raven.linting.enabled": true,
  "raven.linting.lineLength": 120,
  "raven.linting.objectNameStyleFunction": ["snake_case", "camelCase"],
  "raven.linting.objectNameStyleVariable": "snake_case",
  "raven.linting.objectNameStyleArgument": [],
  "raven.linting.objectNameRegexesArgument": ["^\\.?(x|y)$"]
}
```

The same keys work in `raven.toml` under `[linting]`, without the `raven.linting.` prefix. Lint diagnostics carry the source `raven (lint)`, so you can filter them from Raven's other diagnostics in the Problems pane. Style findings never fail `raven check` at its default threshold; see [Gate on style](ci.md#gate-on-style) to make them fail CI.

<a id="settings-reference-by-rule"></a>

## Rules

Each rule mirrors one `lintr` linter. The code is what appears in output; suppression comments accept it in this `snake_case` form or in kebab-case (`line-length`). Severity settings accept `"error"`, `"warning"`, `"information"` (or its `"info"` alias), `"hint"`, or `"off"`.

| Rule | Code | `lintr` linter (`.lintr` form) | Raven settings |
|---|---|---|---|
| [Line length](#line-length) | `line_length` | `line_length_linter(length = N)` | `lineLength = N`, `lineLengthSeverity` |
| [Trailing whitespace](#trailing-whitespace) | `trailing_whitespace` | `trailing_whitespace_linter()` | `trailingWhitespaceSeverity` |
| [Tab characters](#tab-characters) | `no_tab` | `whitespace_linter()` (no-tab portion) | `noTabSeverity` |
| [Trailing blank lines](#trailing-blank-lines) | `trailing_blank_lines` | `trailing_blank_lines_linter()` | `trailingBlankLinesSeverity` |
| [Assignment operator](#assignment-operator) | `assignment_operator` | `assignment_linter()` | `assignmentOperator`, `assignmentOperatorSeverity` |
| [Object names](#object-names) | `object_name` | `object_name_linter(styles = c("snake_case"), regexes = c("^x$"))` | `objectNameStyleFunction`, `objectNameStyleVariable`, `objectNameStyleArgument`, `objectNameRegexesFunction`, `objectNameRegexesVariable`, `objectNameRegexesArgument`, `objectNameSeverity` |
| [Infix spaces](#infix-spaces) | `infix_spaces` | `infix_spaces_linter()` | `infixSpacesSeverity` |
| [Commented code](#commented-code) | `commented_code` | `commented_code_linter()` | `commentedCodeSeverity` |
| [Quotes](#quotes) | `quotes` | `quotes_linter()` / `single_quotes_linter()` | `stringDelimiter`, `quotesSeverity` |
| [Commas](#commas) | `commas` | `commas_linter()` | `commasSeverity` |
| [T / F symbol](#t--f-symbol) | `t_and_f_symbol` | `T_and_F_symbol_linter()` | `tAndFSymbolSeverity` |
| [Semicolon](#semicolon) | `semicolon` | `semicolon_linter()` | `semicolonSeverity` |
| [Equals NA](#equals-na) | `equals_na` | `equals_na_linter()` | `equalsNaSeverity` |
| [Object length](#object-length) | `object_length` | `object_length_linter(length = N)` | `objectLength = N`, `objectLengthSeverity` |
| [Vector logic](#vector-logic) | `vector_logic` | `vector_logic_linter()` | `vectorLogicSeverity` |
| [Function left parentheses](#function-left-parentheses) | `function_left_parentheses` | `function_left_parentheses_linter()` | `functionLeftParenthesesSeverity` |
| [Spaces inside](#spaces-inside) | `spaces_inside` | `spaces_inside_linter()` | `spacesInsideSeverity` |
| [Indentation](#indentation) | `indentation` | `indentation_linter(indent = N)` | `indentationUnit = N`, `infixContinuationStyle`, `indentationSeverity` |

Settings are shown without their `raven.linting.` prefix. Every severity defaults to `"information"`.

`mixed_logical` and `condition_assignment` are not in this table because they have no `lintr` equivalent and are not style lints. They are always-on semantic warnings, configured with `raven.diagnostics.mixedLogicalSeverity` and `raven.diagnostics.conditionAssignmentSeverity`. See [Semantic warnings](diagnostics.md#semantic-warnings).

### Line length

Default `80`. Mirrors `lintr::line_length_linter(length = 80L)`. Length is measured in characters, matching `lintr`'s `nchar()`, so an emoji counts as 1.

### Trailing whitespace

Mirrors `lintr::trailing_whitespace_linter()` with its defaults (`allow_empty_lines = FALSE`, `allow_in_strings = TRUE`). Whitespace-only lines are flagged. Trailing whitespace inside a multi-line string literal is part of the string's value and is not.

### Tab characters

Mirrors `lintr::whitespace_linter()`. Flags tabs used for *indentation* only, matching `lintr`: tabs in comments, strings, or between tokens are left alone, and a line starting inside a multi-line string is part of the string's value. One diagnostic per offending line, at the tab run.

### Trailing blank lines

Mirrors `lintr::trailing_blank_lines_linter()`. Also fires when the file is missing a final newline; a file can get both diagnostics, as in `lintr`. It does not apply to `.Rmd` or `.qmd` documents, because the rule describes the file's shape and a chunk document's shape is Markdown, not R. This is a deliberate difference: `lintr` checks chunk contents in knitr documents.

### Assignment operator

`raven.linting.assignmentOperator` defaults to `"<-"` (alternative `"="`). Mirrors `lintr::assignment_linter()`.

Under the default `<-` style, the flagged operators are `=`, `->`, `->>`, and the magrittr assignment pipe `%<>%`. `<<-` is allowed, matching `lintr` 3.3's default `operator = c("<-", "<<-")`, and `:=` is never linted. Under the `=` style, `<-`, `<<-`, `->`, `->>`, and `%<>%` are flagged.

Named-argument `=` (`f(name = value)`) is never flagged. `lintr`'s implicit-assignment exclusion is mirrored: an assignment nested inside a call argument, an `if`/`while` condition, or a `for` sequence is skipped (`lapply(xs, function(x) { y = x; y })` and `if ({a = TRUE}) 1` are clean) unless the enclosing expression is explicitly parenthesized (`fun((blah = fun(1)))` is still flagged).

### Object names

Mirrors `lintr::object_name_linter(styles = ..., regexes = ...)`. Each of `objectNameStyleFunction`, `objectNameStyleVariable`, and `objectNameStyleArgument` defaults to `["snake_case", "symbols"]`, `lintr`'s default `styles`. Each `objectNameRegexes*` defaults to `[]`.

Each style setting accepts `"snake_case"`, `"camelCase"`, `"dotted.case"`, `"UPPER_CASE"`, `"lowercase"`, `"symbols"` (names made only of non-alphanumeric characters, such as an operator overload like `` `%+%` ``), `"any"`, or an array of those. A name passes when it matches any listed style or any regex for that kind. `"any"` turns off the check for that kind and ignores its regexes, leaving the other two kinds active. An explicit empty style array with regexes checks regexes only; empty styles and empty regexes together turn that kind off. Setting `raven.linting.objectNameSeverity` to `"off"` turns off the rule entirely.

<details markdown="1">
<summary>Regex rules, name normalization, and exemptions</summary>

**Regexes.** Regexes are Rust regexes applied as partial matches against the full identifier, including any leading `.`. Use anchors such as `^...$` when the whole name must match. Rust's regex engine does not support PCRE lookaround such as `(?=...)`. Unsupported patterns are warned about and skipped: from settings or `raven.toml` the warning goes to the server log, and from a `.lintr` file it appears as a notification. Empty regex strings are rejected because they would match every identifier.

If regex-only mode supplies regexes but none are valid, Raven keeps the default named style instead of silently turning the check off. In `.lintr`, the invalid call still clears editor-level regexes, since it stated the project's regex policy.

A style value with no recognized style names is warned about and treated as empty. With valid regexes configured the kind becomes regex-only; with no regex setting at all it is turned off; and if the regex setting is present but has no valid patterns, the default style is restored rather than silently turning the check off.

**Name normalization.** Backtick-quoted and string names are normalized the way `lintr` does it (`strip_names`): surrounding backticks or quotes and `%` are removed, as is a trailing `<-`, so a replacement function `` `height<-` `` is checked as `height`. The result goes through normal matching: `` `myBadName` <- 1 `` is flagged exactly like `myBadName <- 1`, and `` `%+%` `` strips to `+` and passes through the default `symbols` style. A name that strips to nothing (such as `` `%%` ``) is skipped.

**Leading dots and special functions.** Named styles always allow an optional leading `.`, but the rest of the name must still match, so `.helper` is fine under `snake_case` and `.myHelper` is not. `lintr`'s special functions are never flagged: `.onLoad`, `.onAttach`, `.onUnload`, `.onDetach`, `.Last.lib`, `.First`, `.Last`, and `...`.

**S3 methods.** Names of the form `<generic>.<class>` (`print.MyClass`, `as.Date.character`, `` `+.foo` ``) are exempt when the generic is a base R S3 generic (the list is ported from `lintr`, including operator generics) or a generic declared in the same file with `UseMethod` (`lintr`'s `declared_s3_generics`). Hidden methods (`.print.MyClass`) are also exempt, a deliberate leniency over `lintr`, which flags them. For methods of other generics, use `# nolint` or `# raven: ignore`.

**Non-ASCII names** are skipped when no regexes are configured for that kind. When regexes are configured, non-ASCII names are checked against the regexes, and the named ASCII styles never match them. This is more lenient than `lintr`, whose ASCII style regexes flag non-ASCII names.

**Assignment targets.** A compound target checks its base object through `$`/`@` chains, subscripts, and replacement calls: `a$b$c <- 1`, `a[[1]] <- 1`, and `names(a) <- 1` all check `a`, matching `lintr`. Symbols used as subscript indices (`x[i] <- 1`) are not targets. Literal binding names in `assign("name", …)` and `setGeneric("name", …)` are checked.

</details>

### Infix spaces

Mirrors `lintr::infix_spaces_linter()`. It lints exactly `lintr`'s default operator set, the style guide's low-precedence operators, and each needs at least one space on both sides:

- arithmetic (`+`, `-`, `*`, `/`), comparison, and logical operators
- assignment (`<-`, `<<-`, `:=`, `->`, `->>`, `=`), including named-argument `=` in calls and formal defaults (`lintr`'s `EQ_SUB`/`EQ_FORMALS`)
- pipes (`|>`, `%>%`, and any `%...%` user-defined operator) and binary `~`

High-precedence operators (`^`/`**`, `:`, `::`, `:::`, `$`, `@`, `?`) and unary `-`, `+`, `!`, `~` are never linted, matching `lintr`, so `x^2`, `x ^ 2`, and `1:10` are all fine. Alignment whitespace (`x   <- 1`) is allowed, line continuations with the operator at the end of a line are skipped, and `/` inside `box::use(...)` module paths is exempt. A named argument with a missing value still needs a space after `=`: `alist(a = )` is fine and `alist(a =)` is flagged, as pinned by `lintr`'s own tests.

### Commented code

Mirrors `lintr::commented_code_linter()`. Flags a standalone comment block (consecutive `#` lines) whose body parses as R and contains a call, assignment, operator, or function definition.

Prose that merely contains code shapes is not flagged. Juxtaposed expressions (`# use foo(x) instead`) are not valid R, and binary `-` or unary `-`, `+`, `?` alone are not evidence (`# 1-a` and `# ?data.frame` are prose, matching `lintr`). A dangling trailing `,`, `%>%`, or `|>`, or a leading `,`, is stripped before the parse test, so commented-out argument-list lines and pipe fragments are still caught.

Roxygen (`#'`), shebangs, annotation comments (`# TODO:`, `# FIXME:`, `# NOTE:`, `# XXX:`, `# HACK:`, `# BUG:`, `# WARNING:`, `# OPTIMIZE:`), Emacs mode lines, and `# nolint`, `# raven:`, and `# @lsp-…` comments are skipped. End-of-line comments next to real code are checked too, like `lintr`: `x <- 1 # other_call()` is flagged and `x <- 1 # explain` is not.

### Quotes

`raven.linting.stringDelimiter` defaults to `"\""` (alternative `"'"`). Mirrors `lintr::quotes_linter()` and `lintr::single_quotes_linter()`, which map to the two settings. Raw strings are checked like ordinary literals (`R'(plain)'` is flagged under the double-quote default). A literal whose source contains the preferred quote character is exempt, because switching delimiters would force escaping (`'he said "hi"'`, `r'(")'`).

### Commas

Mirrors `lintr::commas_linter()`. Flags whitespace before `,` and missing whitespace after `,`. A newline after a comma is fine, so multi-line argument lists are not flagged. It matches `lintr`'s exemptions: a comma that starts its own line (leading-comma style), a comma right after another comma (`a[1, , 2]`), and a comma after a value-less named argument's `=` (`switch(op, x = , y = bar)`) are clean. It matches `lintr`'s default `allow_trailing = FALSE`, so a comma directly against a closing bracket (`a[1,]`) is flagged.

### T / F symbol

Mirrors `lintr::T_and_F_symbol_linter()`. Flags bare `T` and `F` used as `TRUE` and `FALSE`. Assignment targets (`T <- 0`) get `lintr`'s dedicated "don't use `T` as a variable name" message. These positions don't read the boolean and are exempt: named arguments (`foo(T = TRUE)`), formal parameters (`function(T) ...`), `$` and `@` field names (`obj$T`), formula terms (`y ~ T + F`, though a named-argument value inside a formula call is still a real read), subscripted uses (`T[1]`), and callees (`T(1)`).

### Semicolon

Mirrors `lintr::semicolon_linter()`. Flags `;` separators in source, one diagnostic per `;`. A `;` inside any token, such as a string literal, comment, backtick-quoted identifier (`` `a;b` ``), or user infix operator (`%;%`), is left alone.

### Equals NA

Mirrors `lintr::equals_na_linter()`. Flags `x == NA`, `x != NA`, and the typed variants (`NA_integer_`, `NA_real_`, `NA_character_`, `NA_complex_`) on either side, plus `x %in% NA` (right-hand side only; `NA %in% x` is a legitimate membership test). The comparison always returns `NA`; use `is.na(x)` instead.

### Object length

`raven.linting.objectLength` defaults to `30`. Mirrors `lintr::object_length_linter(length = 30)`. Flags assignment targets and formal parameters whose names are longer than the limit. Names are normalized like object names (backticks and quotes stripped), and a leading `<generic>.` prefix is removed for S3 methods so only an overlong class part is flagged, matching `lintr`. Every character of the remaining name counts, including a leading `.`.

### Vector logic

Mirrors `lintr::vector_logic_linter()`. Flags `&` or `|` in `if` and `while` conditions, where `&&` and `||` are the scalar short-circuit forms, and in `expect_true()` and `expect_false()`. The scan follows nested logical operators but stops at calls, so `if (any(x & y))` is left alone because the `&` runs on a vector inside `any()`.

Bitwise arithmetic is exempt: an operand that is a string literal or an `as.raw()`, `as.octmode()`, or `as.hexmode()` call (`if (info & as.raw(12))`) marks the operator as bitwise, matching `lintr`. The mirror check flags scalar `&&` and `||` inside `subset()` and `filter()` arguments (bare, `pkg::`-qualified except `stats::filter`, or as a pipe target), since subsetting is a vector context. Nested function definitions inside those arguments are skipped.

### Function left parentheses

Mirrors `lintr::function_left_parentheses_linter()`. Flags whitespace between `function` (or the `\` lambda shorthand) and its parameter `(`, and between a called function's name and its `(`: `blah (1)`, `base::print (x)`, `` `+` (1, 1) ``, `x$foo (1)`. A `(` on a later line than the function name gets its own message. `@` slot calls get only that cross-line check; same-line whitespace after `@` access is not flagged. String callees (`"print"(x)`, `base::"mean"(x)`) and computed callees (`f(x)(y)`, immediately invoked functions) are left alone, matching `lintr`.

### Spaces inside

Mirrors `lintr::spaces_inside_linter()`. Flags whitespace just inside `(`, `[`, `[[` and their closing counterparts (`f( x )`, `df[ 1 ]`, `mat[[ i ]]`), including the parentheses of `if`, `while`, `for`, and function or lambda parameter lists. Whitespace-only groupings (`f( )`, `x[ ]`) are flagged on both sides, as in `lintr`; wrapping across lines is never flagged. Exemptions, matching `lintr`: a comma before the closer (`x[i, ]`, `f(a, )`), a value-less named argument's `=` before `)` only (`alist(a = )` is clean, `x[j = ]` is flagged), and an opener followed by a same-line comment.

### Indentation

Mirrors `lintr::indentation_linter()` with its tidy-default hanging style. Settings:

- `raven.linting.indentationUnit` defaults to `"auto"`, which uses each file's `editor.tabSize`; a fixed integer is clamped to 1 to 8. A matching `[[linting.overrides]]` entry still wins for that file.
- `raven.linting.infixContinuationStyle` defaults to `"either"`.
- `raven.linting.indentationSeverity` defaults to `"information"`.

It uses `lintr`'s model of accumulated indent changes, checked against a 112-case comparison corpus. Bracket openers, end-of-line operators, and unbraced bodies add indentation; standalone closers align with their owning context. A run of consecutive lines wrong by the same amount produces one diagnostic.

Raven keeps two argument-layout leniencies, independent of the infix setting: it accepts same-line arguments aligned after the opener, and it accepts a block form where tidy `lintr` demands a hanging or double indent. There is deliberately no lint-side `argumentStyle` setting. A standalone comment-only line aligned with the trailing-comment column of a neighboring line that expects the same indent is exempt. Suppression comments are never alignment anchors.

<details markdown="1">
<summary>Infix continuation styles, with examples</summary>

`raven.linting.infixContinuationStyle` is Raven-specific; `.lintr` has no equivalent and cannot override it. It checks non-assignment end-of-line operators (`|`, `&`, `+`, comparisons, pipes, `%…%`, and `$`/`@` chains):

- `"indented"`: strict `lintr` parity. The continuation gets exactly one more block level; the older deeper-only chain-start tolerance is not part of this mode.
- `"aligned"`: strict floored alignment. Later operands use `max(first_operand_column, statement_indent + unit)`; the indented alternative is flagged.
- `"either"` (default): the union of the two. It accepts both editor traditions and both outputs of Raven's [indentation setting](indentation.md#configuration), and still flags anything matching neither.

With a 4-space unit, strict `indented` requires the second operand at column 8:

```r
changed <- !(
    first_condition |
        second_condition
)
```

Strict `aligned` requires column 4, matching the first operand; `either` accepts both:

```r
changed <- !(
    first_condition |
    second_condition
)
```

The aligned floor applies at statement level. A top-level chain continues at column 2 with a 2-space unit, and column 0 is flagged:

```r
x |>
  y
```

For `x <- y |>` the first operand begins at column 5, so aligned mode requires the continuation under `y`; indented mode requires column 2.

The auto-indenter follows its own `raven.indentation.infixContinuationStyle`. Matching indenter and lint values never conflict, and lint `either` is compatible with either indenter value. If a flagged non-assignment continuation sits at exactly the column the enabled auto-indenter produces, Raven adds advice naming both settings: match the lint style to the indenter, use lint `either`, or change the indenter to the lint style. No advice is added for assignments, genuinely mis-indented or malformed code, an indenter set to off, lint `either`, CLI runs without an `[indentation]` policy, or documents where `editor.insertSpaces` or `editor.formatOnType` turns off the auto-indenter (synced per document from VS Code).

RStudio's vertical-alignment preference and ESS's `ess-align-continuations-in-calls` produce aligned operator continuations inside parentheses and calls, and both use a fixed continuation offset at statement level. Real `lintr` 3.3.0.1, styler, and Air require the indented tradition. Projects that run those tools in CI should set both infix settings to `indented`; strict-alignment projects should set both to `aligned`.

Assignment operators (`<-`, `<<-`, `=`, `:=`, `->`, `->>`) and named-argument `=` continuations are exempt from the infix setting in every mode. A right-hand side begun on the next line gets one level, never alignment under the left-hand side. A continued right-hand-side chain stays at that level:

```r
x <-
  a +
  b
```

</details>

<a id="master-switch-ravenlintingenabled"></a>

## When linting is on

`raven.linting.enabled` takes `"auto"` (the default), `true` (or `"on"`), or `false` (or `"off"`). Booleans are accepted for compatibility with older settings.

- `"auto"`: lint when a project config opts in. That means a discovered `.lintr` **that contains linting configuration** (a `linters:` or `exclusions:` field; a bare `linters_with_defaults()` counts, a blank file does not), or a `raven.toml` with `[linting] enabled = true`. Otherwise off. The `.lintr` half is ignored when REditorSupport or Positron already runs `lintr`; see [below](#auto-and-reditorsupport--positron).
- `true` / `"on"`: always lint. Discovered rule severities still apply.
- `false` / `"off"`: don't lint, unless a discovered `raven.toml` explicitly sets `enabled = true`. A `raven.toml` value always wins over the editor value. A discovered `.lintr` alone never turns linting back on.

Raven looks for `.lintr` by walking upward from the active project root: the first editor workspace folder, `raven check --workspace`, or the `raven lint` working directory. The literal home-directory `~/.lintr` is ignored by default. In VS Code and other editors, set `raven.linting.readHomeLintr = true` to include it; the CLI uses it only when passed explicitly with `--config ~/.lintr`.

`raven lint` ignores this switch: choosing that command opts into linting, so it runs with built-in defaults even when no config is discovered or `--no-config` is passed, and it ignores a base `enabled = false`. Per-file `enabled = false` overrides and `.lintr` exclusions still skip matching files, rule severities set to `off` stay off, and all other rule values still apply. This doesn't change editor diagnostics or `raven check`.

### `"auto"` and REditorSupport / Positron

Under `"auto"`, a discovered `.lintr` counts as an opt-in only when nothing else already runs `lintr` on it. A `.lintr` is `lintr`'s own config file, so when REditorSupport is already linting your project, also turning on Raven's lints from the same file would report style issues twice. Raven ignores a discovered `.lintr` under `"auto"` when **either**:

- the **REditorSupport (R) extension** is installed and enabled **and** both `r.lsp.enabled` and `r.lsp.diagnostics` are on (the default), so its language server is reporting `lintr` diagnostics; **or**
- you are running in **Positron**, which has its own R-session linting.

This affects only the `.lintr` path:

- A `raven.toml` opt-in (`[linting] enabled = true`) is **unaffected** and always turns Raven's linting on.
- An explicit editor `true`/`"on"` or `false`/`"off"` is **unaffected**; only `"auto"` checks for REditorSupport or Positron.
- Turning off REditorSupport's `r.lsp.diagnostics` or `r.lsp.enabled`, or disabling or uninstalling the extension, restores the `.lintr` opt-in live, with no window reload.

To run Raven's lints *alongside* REditorSupport's `lintr` on purpose, set `raven.linting.enabled` to `true`, or move the project to `raven.toml`. See [Coexistence](coexistence.md#language-servers-raven-alone-vs-both).

The VS Code extension computes this signal from REditorSupport's state and `r.lsp.*`, and a project `raven.toml` can't override it. Other editors and the CLI don't send it, so for them a discovered workspace or non-home *configured* `.lintr` always turns linting on. A blank `.lintr` still never does, and the literal `~/.lintr` stays off unless the editor setting is on or the CLI receives it with `--config ~/.lintr`.

## Migrating from `.lintr`

The recommended path is to configure Raven with `raven.toml` at the project root (see [Project config](configuration.md#project-config-raventoml)). For each `lintr` linter you use, set the matching Raven keys from the [Rules](#settings-reference-by-rule) table. For linters Raven doesn't have, see [Gaps vs `lintr`](#gaps-vs-lintr).

When no `raven.toml` is discovered, Raven reads a documented subset of the discovered `.lintr`: the linter calls in the Rules table and the `exclusions:` field. In the editor that `.lintr` is watched and reloaded live; the CLI reads it once per command. Forms outside the subset produce a single combined warning and are otherwise ignored.

To disable a rule from a `.lintr` `linters_with_defaults(..., default = list())` setup, set its severity to `"off"`. To match a rule that `lintr` reports as a `warning`, raise its severity from `"information"` to `"warning"`.

**Raven: Create linting settings** in the Command Palette writes every project-scoped `raven.linting.*` key into `.vscode/settings.json`, each with a `//` comment naming its `lintr` equivalent (see [Scaffold commands](configuration.md#scaffold-commands)). Raven doesn't generate a `.lintr`; if you also want to run `lintr` itself, see [Filling the gaps](#filling-the-gaps-with-lintr-itself).

<details markdown="1">
<summary>How Raven parses <code>.lintr</code> fields</summary>

Multi-line `linters:` and `exclusions:` values are joined by **bracket balance**, so a closing `)` works whether it sits at column 0 or is indented, and `#` comments inside the value are handled. Real `lintr` reads `.lintr` as strict DCF and *rejects* a column-0 continuation (`read.dcf`: "Regular lines must have a tag"), so Raven logs a one-line note suggesting you indent the closing line if you also run `lintr`. A column-0 `#` comment line is valid DCF and doesn't count toward that note.

A field whose brackets don't balance (a missing `)`, a stray extra one, or a mismatched type) is reported specifically (`field 'linters' has unbalanced brackets …`) and parsed best-effort, rather than swallowing the next field. A recognized field still opts the project into linting even with a typo, so a single missing `)` never silently turns all linting off.

Most linter arguments accept either `lintr`'s named form or a leading positional value (`line_length_linter(120)`, `assignment_linter("=")`, `object_name_linter("snake_case")`). Numeric arguments accept R integer literals, decimal or hexadecimal, each with an optional `L` suffix (`line_length_linter(120L)`, `line_length_linter(0x50)`), and whitespace before `(` is allowed (`linters_with_defaults (...)`). The pre-3.0 `with_defaults(...)` spelling is accepted as an alias for `linters_with_defaults(...)`.

`line_length_linter(80)` and `line_length_linter(length = 80)` are equivalent, as are `object_length_linter(40)` / `object_length_linter(length = 40)` and `indentation_linter(4)` / `indentation_linter(indent = 4)`.

</details>

<details markdown="1">
<summary>How Raven reads <code>object_name_linter()</code> arguments</summary>

`object_name_linter` accepts styles positionally or as `styles =`, as a scalar or a `c(...)` vector (`object_name_linter("camelCase")`, `object_name_linter(styles = c("snake_case", "camelCase"))`), and applies them to functions, variables, and arguments. Known style names (`snake_case`, `camelCase`, `dotted.case`, `UPPER_CASE`, `lowercase`, `symbols`, `any`) map to the three style arrays and are ORed.

Regexes may be named (`regexes =`) or passed as the second positional argument, as a scalar or vector. Names on vector entries (such as `c(public = "^[a-z]")`) are labels and don't change the patterns. Matching `lintr`, supplying `regexes` **replaces** the default styles (regex-only mode) unless `styles` is also supplied; give both to combine them.

R string escapes are processed, so `"^\\.on[A-Z]"` means the regex `^\.on[A-Z]`. R raw strings (`r"(^\.on[A-Z])"`) are taken verbatim. R's numeric escapes (octal `"\056"`, hex `"\x2e"`, Unicode `"\u{2e}"`) decode with R semantics before the pattern reaches the regex engine. Escapes R itself rejects (such as a bare `"\d"`; write `"\\d"`) are warned about as unrecognized.

`lintr` styles Raven has no equivalent for (`CamelCase`, `UPPERCASE`, `SNAKE_CASE`) are warned about and skipped, as are case or punctuation typos of Raven's style names, with a did-you-mean hint. Any other unknown non-empty `styles` element is treated as a regex, a Raven extension over `lintr`. Empty style elements are still unrecognized, because an empty regex would match every identifier.

An explicit empty vector (`styles = c()`, `styles = character()`, or `character(0)`) maps to empty style arrays: regex-only mode when regexes are also given, otherwise the check is off. Whenever a call states a style policy it also states the regex policy. A styles-only call (including the empty forms) or any call with a `regexes` argument, even one whose patterns were all rejected, sets the regex arrays (to the accepted patterns, or `[]`), so editor-level `objectNameRegexes*` values are cleared rather than silently ORed in.

</details>

### Exclusions

A `.lintr` `exclusions:` field that lists files and directories, such as `exclusions: list("R/legacy.R", "tests", "NAMESPACE")`, becomes a single `[[linting.overrides]]` entry with `enabled = false`, anchored at the project root. Each entry becomes one or more globs matched against the project-relative path:

| `exclusions:` entry | Globs | Matches |
|---|---|---|
| `"R/"` (trailing slash means directory) | `R/**` | every file under `R/` |
| any other entry (`"R/foo.R"`, `"NAMESPACE"`, `"pkg.Rcheck"`, …) | `<entry>` **and** `<entry>/**` | the path itself if it's a file, or its contents if it's a directory |

Raven resolves exclusions without touching the filesystem, so it can't tell whether a bare entry like `NAMESPACE` (a file) or `pkg.Rcheck` (a directory) is which, and a dot is no help. It emits both an exact and a recursive glob for every entry that doesn't end in `/`. The extra glob only affects a path that doesn't exist, so it is harmless. Add a trailing slash to match directories only.

Not supported: the named line-range form `list("file.R" = 1:10)`, which excludes specific lines, has no Raven equivalent and is ignored with the combined warning. A `=` *inside* a quoted name (such as `"a=b.R"`) is an ordinary filename, not this form.

## Gaps vs `lintr`

`lintr` ships more than 140 linters, about two dozen of them on by default. Raven implements 18 of those defaults, the ones in the [Rules](#settings-reference-by-rule) table. Common `lintr` linters with **no Raven equivalent** include:

- `object_usage_linter`, which flags undefined globals inside function bodies with `codetools::checkUsage()`. Raven's [undefined-variable diagnostic](diagnostics.md#undefined-variables) covers similar ground with different semantics: it is scope- and position-aware across `source()` chains, while `object_usage_linter` runs R's own analyzer inside individual function bodies.
- `cyclocomp_linter` (cyclomatic complexity).
- `seq_linter`.
- `brace_linter`, `paren_body_linter`, `spaces_left_parentheses_linter`.
- `pipe_continuation_linter`, `pipe_call_linter`.
- `absolute_path_linter`.

If you rely on any of these, run `lintr` through the REditorSupport extension alongside Raven, as described next.

### Filling the gaps with `lintr` itself

The [REditorSupport extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) runs `lintr` from its own R-based language server, so it covers every linter `lintr` ships. To run both:

1. Keep Raven installed and enabled.
2. Install the REditorSupport extension and leave `r.lsp.enabled` at its default (`true`).
3. Put a `.lintr` file at your project root. Raven doesn't create this file, because its format is `lintr`'s own. (Raven reads a [subset](#migrating-from-lintr) of it when no `raven.toml` is present, but the file exists mainly for `lintr`.) A one-line starter that mirrors `lintr`'s default rules with a 120-character line limit:

   ```r
   linters: linters_with_defaults(line_length_linter(120))
   ```

4. Install `lintr` in the R session REditorSupport uses (`install.packages("lintr")`).

REditorSupport reports `lintr` diagnostics and Raven reports its own. Both appear in the Problems pane, and the source field tells them apart: `raven (lint)` for Raven, `lintr` for REditorSupport. Note that a `.lintr` with REditorSupport active doesn't turn on Raven's lints under `"auto"` (see [above](#auto-and-reditorsupport--positron)). See [Coexistence](coexistence.md#language-servers-raven-alone-vs-both) for the broader picture.

<a id="suppression-matrix"></a>

## Suppressing lints

Every suppression comment works on lints: `# raven: ignore`, `# raven: expect`, their `@lsp-` aliases, and `lintr`'s `# nolint`, `# nolint: rule_a, rule_b`, and `# nolint start` / `# nolint end`. The syntax and exactly which comment silences which diagnostics are in [Suppressing diagnostics](diagnostics.md#suppressing-diagnostics).

For lints specifically, a rule list is honored per rule: `# nolint: line_length` silences only the line-length lint, just as `# raven: ignore[line-length]` does, and both spellings work in both forms. `# nolint` silences only lints and the `mixed_logical` and `condition_assignment` checks. Markers work inside R chunks of `.Rmd` and `.qmd` files as in plain `.R` files; to silence a whole chunk, see [Suppressing diagnostics in a chunk](chunks.md#suppressing-diagnostics-in-a-chunk).

## Settings

Every rule setting is listed in the [Rules](#settings-reference-by-rule) table. Defaults and types for every `raven.linting.*` key are in the [Settings reference](settings-reference.md).

| Setting | Default | What it does |
|---|---|---|
| `raven.linting.enabled` | `"auto"` | Turns linting on or off; see [When linting is on](#master-switch-ravenlintingenabled) |
| `raven.linting.readHomeLintr` | `false` | Editor-only. Also read the literal `~/.lintr` |
| `raven.linting.*Severity` | `"information"` | Severity of one rule, or `"off"` |

In `raven.toml`, set the same keys under `[linting]`, and use `[[linting.overrides]]` to change them for some files (see [Per-file overrides](configuration.md#per-file-overrides)).

<a id="performance-and-scope-notes"></a>

## Limitations

- **`commented_code` can disagree with `lintr` on edge cases.** Both decide whether a comment looks like code by parsing it, but Raven uses its own R parser and `lintr` uses R. Comments that exercise unusual R syntax (very old `_` assignment, non-ASCII operator overloads, and the like) may be classified differently.
- **Not data-flow-aware.** Most rules walk the syntax tree and don't run data-flow analysis. Rules that need it (`object_usage_linter`, `cyclocomp_linter`, `seq_linter`) are out of scope; run `lintr` for those (see [Filling the gaps](#filling-the-gaps-with-lintr-itself)).
- **Trailing blank lines** is not checked in R Markdown or Quarto documents (see [Trailing blank lines](#trailing-blank-lines)).

## Details

<a id="r-markdown-and-quarto"></a>

**R Markdown and Quarto.** Lint rules apply inside R chunk bodies of `.Rmd` and `.qmd` documents, in the editor and with `raven lint`. Prose, YAML front matter, and non-R chunks are never linted.

**No R process.** Lint rules run on the parse tree Raven already keeps for completion and diagnostics: no `lintr` install, no R process, no startup cost. `commented_code` re-parses each candidate comment; every other rule only walks the existing tree.

### Behavior matrix

How `raven.linting.enabled` combines with the project's config files. `raven.toml` and `.lintr` are never both used: when the upward walk finds a `raven.toml`, `.lintr` is not consulted.

<!-- markdownlint-disable MD013 -->

| Editor (`raven.linting.enabled`) | Project state | Result |
|---|---|---|
| `"auto"` (default) | no `.lintr`, no `raven.toml` | off |
| `"auto"` | blank `.lintr` (no `linters:` / `exclusions:` field) | off; a blank `.lintr` doesn't opt in |
| `"auto"` | configured `.lintr` discovered (workspace or non-home ancestor) | on, **unless** REditorSupport's `lintr` is live or you're in Positron, then off ([details](#auto-and-reditorsupport--positron)) |
| `"auto"` | literal `~/.lintr` exists, `raven.linting.readHomeLintr = false` (default) | off |
| `"auto"` | literal `~/.lintr` exists, `raven.linting.readHomeLintr = true` | on, **unless** REditorSupport's `lintr` is live or you're in Positron, then off ([details](#auto-and-reditorsupport--positron)) |
| `"auto"` | `raven.toml` with `enabled = true` (or `"on"`) | on |
| `"auto"` | `raven.toml` with `enabled = false` (or `"off"`) | off; `.lintr` not consulted |
| `"auto"` | `raven.toml` with `enabled = "auto"` or no `[linting]` | off (`raven.toml` was found, so no `.lintr` is read) |
| `false` / `"off"` | no project config | off |
| `false` / `"off"` | `.lintr` discovered | off |
| `false` / `"off"` | `raven.toml` with `enabled = true` | on (`raven.toml` wins) |
| `false` / `"off"` | `raven.toml` with `enabled = false` / `"auto"` / no `[linting]` | off |
| `true` / `"on"` | no project config | on with built-in defaults |
| `true` / `"on"` | `.lintr` discovered | on with `.lintr`'s rule severities |
| `true` / `"on"` | `raven.toml` with `enabled = true` | on |
| `true` / `"on"` | `raven.toml` with `enabled = false` | off (`raven.toml` wins) |
| `true` / `"on"` | `raven.toml` with `enabled = "auto"` or no `[linting]` | on (`raven.toml` doesn't set `enabled`, so the editor value applies) |

<!-- markdownlint-enable MD013 -->

## See also

- [Diagnostics](diagnostics.md#style-lints): these rules alongside Raven's other diagnostics.
- [Configuration](configuration.md): how `raven.toml`, `.lintr`, and editor settings combine.
- [Coexistence](coexistence.md#language-servers-raven-alone-vs-both): running Raven and REditorSupport together.
- [Comparison](comparison.md): how Raven differs from REditorSupport, Positron, and RStudio.
