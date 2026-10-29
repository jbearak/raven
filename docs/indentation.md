# Indentation

[Docs](README.md) › Analysis

When you press Enter in R code, Raven indents the new line to fit the call, pipe chain, assignment, or block it continues.

<a id="smart-indentation"></a>

```r
# The editor's line rules alone: each pipe adds another level
x |>
  y |>
    z

# With Raven: the chain stays at one level
x |>
  y |>
  z
```

The editor's built-in rules see only the line above, so each `|>` looks like a new reason to indent. Raven reads the whole chain, sees that `y` and `z` are peers, and puts them in the same column.

<a id="overview"></a>

## How it works

Two mechanisms work together, and both are on by default.

| Mechanism | What it does | How it works |
|---|---|---|
| Built-in indentation | A quick first pass for pipes, operators, assignments, and brackets | Line-based rules in the VS Code extension |
| Syntax-aware indentation | Fixes argument and operator indentation using the surrounding R code | Raven's language server, through on-type formatting, using the same analysis as the indentation lint |

> [!NOTE]
> When you press Enter, the R expression is often incomplete. The built-in rules make a fast first guess from the line above. Raven then works out the surrounding call, assignment, block, or operator chain and replaces the first guess only when it can find a safe column. When it can't, the built-in indent stays.

Syntax-aware indentation works in any editor that sends on-type formatting requests. The built-in rules come with the VS Code extension. See [Editor setup](editor-integrations.md#feature-availability).

<a id="configuration"></a>
<a id="auto-indentation-settings"></a>

## Choose an argument style

`raven.indentation.argumentStyle` sets how arguments continue after a same-line `(`.

`aligned` (the default) lines arguments up after the opener, like RStudio's default vertical alignment. ESS calls this style `RStudio`. Use it when you want the arguments to read as one column:

```r
result <- function_call(first_arg,
                        second_arg,
                        third_arg)
```

`indented` indents one level from the line with the opener. ESS calls this style `RStudio-`. Use it to keep long calls from drifting to the right:

```r
result <- function_call(first_arg,
  second_arg,
  third_arg)
```

When the opener ends its line, both styles give the same result, one level in:

```r
result <- function_call(
  first_arg,
  second_arg
)
```

`off` leaves argument indentation to the editor's built-in bracket handling.

## Choose an infix style

`raven.indentation.infixContinuationStyle` sets how a chain of operators (`+`, `|>`, `%>%`, …) continues.

- `aligned` (the default) lines operands up under the first operand, but never less than one level past the start of the statement. Peer operands in one column make equations, conditions, and pipelines easier to scan.
- `indented` adds one level beyond the surrounding indentation, matching strict `lintr`. Use it if your project runs `lintr`, styler, or Air.
- `off` leaves infix continuations to the editor's built-in indentation. Raven still handles braces, assignments, and the other cases this setting doesn't control.

```r
# aligned
total <- first_term +
         second_term +
         third_term

# indented
total <- first_term +
  second_term +
  third_term
```

`indented` doesn't copy the cascade the built-in rules produce (shown at the top of this page). It gives every operand the same one-level indent.

## Infix examples

These examples use a 2-space indentation unit. Every column scales with your unit; with 4 spaces, one level is column 4.

In an assigned chain, `aligned` puts operands at column 10, under `data`. `indented` puts them at column 2:

```r
# aligned
result <- data %>%
          filter(x > 0) %>%
          select(y)

# indented
result <- data %>%
  filter(x > 0) %>%
  select(y)
```

A chain that starts a statement continues one level in, never at column 0, because a continuation at column 0 would look like a new statement. Inside braces, a statement at column 2 continues at column 4:

```r
data |>
  transform()

if (condition) {
  data |>
    transform()
}
```

A chain that starts inside a call argument on its own line continues one level past that line (column 4, not 2) in either style, so it stays visibly inside the argument:

```r
output <- some_function(
  data %>%
    filter(x > 0) %>%
    select(y)
)
```

## Assignment continuations

An assignment operator (`<-`, `<<-`, `=`, `:=`, `->`, `->>`) adds one level, in both styles, to whatever the surrounding code already sets. The right side of an assignment isn't a peer of the left side, so it isn't aligned with it. Inside a call, `argumentStyle` sets the starting point, so the final column can differ. Operators nested inside the right side still follow `infixContinuationStyle`.

At the top level, the right side starts one level in:

```r
result <-
  compute_something(x)
```

When the right side starts on the next line, a chain stays at that column in every style:

```r
result <-
  data %>%
  filter(x > 0) %>%
  select(y)
```

In a continuous arithmetic chain, all right-side operands stay aligned with each other. With a 4-space unit they sit at column 4, whatever column the left side starts in:

```r
x <-
    y +
    z +
    w
```

An opener before the assignment adds its level first. With a 2-space unit, `b <-` is at column 2 (the call's level) and `value` at column 4 (plus the assignment's):

```r
f(
  b <-
    value
)
```

A same-line opener sets the starting column from `argumentStyle` before the assignment adds its level. In this incomplete assignment, `aligned` picks column 21, after the opener. `indented` picks column 4, two 2-space levels for the call and the assignment:

```r
long_function_name(x <-
                     value
```

The same shape with `:=` gives column 5 (after the opener) with `aligned` and column 4 (two 2-space levels) with `indented`:

```r
dt[, y :=
     value
```

When a broken assignment's right side starts with a same-line call that begins a chain, the next line follows the infix style. With a 2-space unit, `aligned` gives column 4 and `indented` gives column 6:

```r
# aligned
result <-
  f(data %>%
    value

# indented
result <-
  f(data %>%
      value
```

The built-in rules handle `<-` and `<<-` too. The other assignment operators need syntax-aware indentation, because a rule that sees one line at a time can't classify them safely.

## Brace blocks

The body of a brace block is indented one level whatever the style settings, even when both are `off`. With a 2-space unit the body starts at column 2:

```r
if (condition) {
  do_something()
}
```

<a id="corresponding-lint-settings"></a>

## Match your lint settings

Auto-indentation writes leading whitespace as you type. The [indentation lint](linting.md#indentation) checks the whitespace already in a file. They have separate settings, so a project can choose what Raven writes without forcing that choice on existing code.

| Setting | Values | Default | Effect |
|---|---|---|---|
| `raven.linting.enabled` | `"auto"`, `"on"`, `"off"`, `true`, `false` | `"auto"` | Turns Raven's style lints on or off. `"auto"` is normally off until project configuration opts in. |
| `raven.linting.indentationSeverity` | `error`, `warning`, `information` (`info`), `hint`, `off` | `information` | Severity of indentation diagnostics. `off` turns the rule off. |
| `raven.linting.indentationUnit` | `"auto"`, or an integer from `1` to `8` | `"auto"` | Spaces per level. In VS Code, `"auto"` follows the file's `editor.tabSize`. |
| `raven.linting.infixContinuationStyle` | `aligned`, `indented`, `either` | `either` | Whether infix continuations must use one style or may use either |

The lint has no argument-style setting; it accepts both argument layouts shown above. For infix chains, set the lint to the same style as auto-indent if you want the lint to require it. The lint default, `either`, accepts both. You can set a mismatched pair. When Raven can tell that auto-indent produced a flagged column, the diagnostic names the settings that resolve the conflict.

A project that runs `lintr`, styler, or Air in CI should set both `raven.indentation.infixContinuationStyle` and `raven.linting.infixContinuationStyle` to `indented`. With `lintr`, Raven should also use the same indentation width as `lintr`'s `indent` value (default `2`). In VS Code, the simplest way is to leave `raven.linting.indentationUnit` at `"auto"` and set `editor.tabSize` to that width. A project that wants strict alignment sets both infix settings to `aligned`. See [Linting: quick start](linting.md#quick-start) for how the lint's opt-in switch works.

<a id="disabling-syntax-aware-indentation"></a>

## Turn syntax-aware indentation off

Set `raven.indentation.enabled` to `false` to stop all of Raven's indentation edits and keep only the built-in rules. This also turns off Raven's cleanup of duplicated closing brackets after Enter.

Setting both style settings to `off` is different: Raven still handles braces, assignments, and the other cases those settings don't control, and still cleans up duplicated closing brackets.

To stop the editor from asking Raven at all, set `editor.formatOnType` to `false` for R files:

```json
"[r]": {
  "editor.formatOnType": false
}
```

## Troubleshooting

If indentation doesn't happen, check the file's language mode, `raven.indentation.enabled`, the relevant style setting, and `editor.formatOnType`. Setting changes take effect immediately.

If a chain uses the wrong style, compare `raven.indentation.infixContinuationStyle` (what auto-indent writes) with `raven.linting.infixContinuationStyle` (what the lint accepts). Use matching values for a strict project, or the lint's `either` when both layouts are fine.

## Settings

| Setting | Values | Default | Effect |
|---|---|---|---|
| `raven.indentation.enabled` | `true`, `false` | `true` | Turns syntax-aware indentation on or off |
| `raven.indentation.argumentStyle` | `aligned`, `indented`, `off` | `aligned` | How arguments continue after a same-line `(` |
| `raven.indentation.infixContinuationStyle` | `aligned`, `indented`, `off` | `aligned` | How operator chains continue |

See [Settings reference](settings-reference.md) for every setting and its `raven.toml` key.

<a id="when-syntax-aware-indentation-cannot-answer"></a>

## Limitations

Raven makes no edit, and the editor's built-in indentation stays, when:

- the cursor is inside a multiline string or backticks
- the editor indents with tabs, or the surrounding code contains a real tab
- the incomplete code and the indentation around it don't establish a safe column

With tabs, Raven also leaves out lint advice that would blame a conflicting column on auto-indent.

In R Markdown and Quarto, syntax-aware indentation works inside R chunks and stays out of prose, YAML, and non-R chunks.

## Details

### Why Raven's defaults differ

Raven copies neither RStudio nor `lintr` wholesale. RStudio's default vertical alignment lines arguments up after a same-line opener, which `argumentStyle = aligned` matches. RStudio's operator indentation depends on context: it can align continuations in some parenthesized control-flow expressions, but statement-level operator chains get a fixed offset. [`lintr`'s indentation rule](https://lintr.r-lib.org/reference/indentation_linter.html) instead expects non-assignment operator continuations one level beyond the surrounding indentation.

Raven extends alignment to operator chains in general, because peer operands in one visual column make equations, conditions, and pipelines easier to scan. The one-level minimum keeps a top-level continuation visibly indented even when its first operand starts at column 0.

So that this preference doesn't become a lint rule by default, Raven writes `aligned` chains while its lint defaults to `either` and accepts both. Raven's lint also stays more lenient than `lintr` about some argument layouts; [Linting: indentation](linting.md#indentation) lists them.

### How auto-indent picks the indentation unit

While Raven's indentation lint is active, syntax-aware indentation uses the lint's `indentationUnit`, including `"auto"` and any `[[linting.overrides]]`. Otherwise it uses the editor's `tabSize`. The lint's infix style never changes what auto-indent writes.

In `.lintr`, `indentation_linter(indent = N)` sets `indentationUnit`, and turning that linter off sets `indentationSeverity = "off"`. `.lintr` can't set Raven's infix style.

### Permanent compatibility alias

`raven.indentation.style`, the older single setting, is still accepted and always will be:

| Alias value | Equivalent |
|---|---|
| `rstudio` | `argumentStyle = aligned` |
| `rstudio-minus` | `argumentStyle = indented` |
| `off` | `enabled = false` |

The alias never changes the infix setting. Each field resolves on its own:

| Field | Highest precedence | Then | Default |
|---|---|---|---|
| `enabled` | explicit `indentation.enabled` | alias `style = off` | `true` |
| `argumentStyle` | explicit `indentation.argumentStyle` | alias `rstudio` or `rstudio-minus` | `aligned` |
| `infixContinuationStyle` | explicit `indentation.infixContinuationStyle` | — | `aligned` |

So `enabled = true` overrides the alias `off`, and `argumentStyle = aligned` overrides the alias `rstudio-minus`, without changing either infix setting.

## See also

- [Linting](linting.md)
- [Configuration](configuration.md)
- [Editor setup](editor-integrations.md)
