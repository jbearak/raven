# Syntax highlighting

[Docs](README.md) › Navigation and editing

Raven colors function names by what they are, and its VS Code extension adds grammars so R, R Markdown, JAGS, Stan, and R package files highlight without other extensions.

| File | Highlighted by |
|---|---|
| `.R` | An R grammar, plus Raven's semantic highlighting of function names |
| `.Rmd`, `.Rmarkdown` | An R Markdown grammar, plus semantic highlighting in R chunks |
| `.qmd` | Raven's R Markdown grammar, plus semantic highlighting in R chunks. The [Quarto extension](https://marketplace.visualstudio.com/items?itemName=quarto.quarto) adds full Quarto highlighting. |
| `.jags`, `.bugs`, `.bug`, `.stan` | Raven's JAGS and Stan grammars |
| `DESCRIPTION`, `NAMESPACE`, `.Rd`, `.Rbuildignore`, `.Rproj`, `.lintr` | Raven's R package file grammars |
| Code in the Knit Preview panel | A GitHub light or dark palette, using the editor's grammars |

## R

Raven highlights two kinds of names as functions, using the standard LSP `function` semantic token:

- names assigned a `function(...)` value with `<-`, `=`, `<<-`, `->`, or `->>`
- the function in a call, including qualified calls like `pkg::fn()`

That is deliberately all. Raven finds call and definition sites reliably from the parsed code and leaves everything else to the grammar: comments, strings, numbers, operators, roxygen tags, constants, storage types, and brackets. Semantic highlighting adds to the grammar; it doesn't replace it. Any LSP editor that supports semantic tokens shows these colors.

Semantic highlighting also works inside R chunks of `.Rmd`, `.Rmarkdown`, and `.qmd` documents. Raven reads each R chunk separately and places the colors at the right lines in the document. Python, SQL, Bash, and other non-R chunks get no semantic highlighting from Raven.

The language server bundled with the full `REditorSupport.r` extension also sends semantic tokens, and covers more kinds of names. See [Coexistence](coexistence.md) if you run both.

In VS Code, Raven ships its own copy of the REditorSupport R grammar, so highlighting works locally and over Remote SSH, Dev Containers, WSL, and Codespaces. If `REditorSupport.r-syntax`, `REditorSupport.r`, or VS Code's built-in `vscode.r` is installed, its grammar is used instead; Raven's copy is the fallback.

<a id="rendered-html-raven-knit-preview"></a>

## Rendered HTML in Knit Preview

**Raven: Knit Preview** writes a self-contained `.html` file to a temporary folder and shows it in the Knit Preview panel. Code blocks in that HTML are highlighted with a GitHub light or dark palette, using whichever VS Code grammar handles the chunk's language:

- For R chunks, Raven uses the first grammar it finds among `REditorSupport.r-syntax`, `REditorSupport.r`, VS Code's built-in `vscode.r`, and its own copy, in that order. Function names also get Raven's semantic `function` color on top of the grammar.
- For other chunks (Python, SQL, Bash, Julia, …), Raven uses whichever installed extension provides a grammar for the language. Languages with no grammar render as plain monospace.
- Fences without a language tag are left as they are, as in the editor.

The panel uses the palette that matches your VS Code theme. The standalone file that **Open in Browser** opens contains both palettes and follows the system's light or dark setting.

Math (`$x$`, `$$x = y$$`, LaTeX environments) is rendered through VS Code's built-in `vscode.markdown-math` extension, which bundles KaTeX. Raven copies its CSS into the standalone HTML, so math also renders when you open the file in a browser.

## R package development files

VS Code has no grammars for the files inside every R package, so Raven adds grammars and language settings for four file types. Each gets highlighting, bracket matching, and comment toggling: `#` for DCF, NAMESPACE, and `.Rbuildignore`, and `%` for Rd.

<a id="dcf-description-rproj-lintr"></a>

### DCF files: `DESCRIPTION`, `.Rproj`, `.lintr`

These use the `r-dcf` language. DCF (Debian Control File) is the format of R package metadata and project files. The grammar highlights:

- field names before `:` (`Package`, `Version`, `Depends`), as keywords
- field values after `:` on the same line, as strings
- continuation lines, which start with whitespace and continue a field value
- comments, from `#` to the end of the line

### NAMESPACE

The `NAMESPACE` file uses the `r-namespace` language. The grammar highlights:

- directives, as keywords: `export`, `exportClasses`, `exportMethods`, `exportPattern`, `import`, `importClassesFrom`, `importFrom`, `importMethodsFrom`, `S3method`, `S4method`, `useDynLib`
- package and function names inside directive arguments
- double-quoted strings
- comments, from `#` to the end of the line

<a id="rd-rd-rd"></a>

### Rd files: `.Rd`, `.rd`

These use the `rd` language. Rd is R's documentation format. The grammar highlights:

- section tags such as `\title`, `\usage`, `\arguments`, `\description`, `\details`, `\value`, and `\examples`, as keywords
- inline tags such as `\code`, `\emph`, `\strong`, `\link`, `\pkg`, `\url`, and `\var`, as entity names
- escapes: `\{`, `\}`, `\\`, `\%`
- comments, from `%` to the end of the line (an escaped `\%` is a literal percent sign)

<a id="rbuildignore"></a>

### `.Rbuildignore` files

These use the `r-buildignore` language. Each line of `.Rbuildignore` is an extended regular expression for paths to leave out of the package tarball. The grammar highlights:

- patterns (every line that isn't a comment), as `string.regexp`
- comments, from `#` to the end of the line

## JAGS and Stan

VS Code has no grammars for JAGS or Stan, so Raven ships its own. These files get no semantic highlighting; all their colors come from the grammar.

### JAGS

The JAGS grammar applies to `.jags`, `.bugs`, and `.bug` in any letter case. These extensions mean JAGS, not general OpenBUGS, WinBUGS, MultiBUGS, or NIMBLE compatibility. The grammar highlights:

- comments, from `#` to the end of the line
- double-quoted strings with backslash escapes
- block keywords: `model`, `data`
- control flow: `for`, `in`, `if`, `else`
- distributions: `dnorm`, `dbern`, `dgamma`, `dunif`, `dpois`, `dbin`, `dbeta`, `dexp`, `dt`, `dweib`, `dlnorm`, `dchisqr`, `dlogis`, `dmulti`, `ddirch`, `dwish`, `dmnorm`, `dmt`, `dinterval`, `dcat`
- math functions: `abs`, `sqrt`, `log`, `exp`, `pow`, `sin`, `cos`, `sum`, `prod`, `min`, `max`, `mean`, `sd`, `inverse`, `logit`, `probit`, `cloglog`, `ilogit`, `phi`, `step`, `equals`, `round`, `trunc`, `inprod`, `interp.lin`, `logfact`, `loggam`, `rank`, `sort`, `ifelse`, `T`
- integer, decimal, and scientific-notation numbers
- operators: `<-`, `~`, `&&`, `||`, comparisons (`==`, `!=`, `<=`, `>=`), and arithmetic (`+`, `-`, `*`, `/`, `^`)

### Stan

The Stan grammar applies to `.stan`, `.Stan`, and `.STAN`. It highlights:

- `//` line comments and `/* ... */` block comments
- double-quoted strings with backslash escapes
- block keywords: `functions`, `data`, `transformed data`, `parameters`, `transformed parameters`, `model`, `generated quantities`
- types: `int`, `real`, `vector`, `row_vector`, `matrix`, `simplex`, `unit_vector`, `ordered`, `positive_ordered`, `corr_matrix`, `cov_matrix`, `cholesky_factor_corr`, `cholesky_factor_cov`, `void`, `array`, `complex`, `complex_vector`, `complex_row_vector`, `complex_matrix`, `tuple`
- constraints: `lower`, `upper`, `offset`, `multiplier`
- control flow: `for`, `in`, `while`, `if`, `else`, `return`, `break`, `continue`, `print`, `reject`, `profile`
- any name ending in `_lpdf`, `_lupdf`, `_lpmf`, `_lupmf`, `_cdf`, `_lcdf`, `_lccdf`, or `_rng`, so your own density and sampling functions highlight like built-in ones
- integer, decimal, and scientific-notation numbers
- operators: `<-`, `~`, `&&`, `||`, comparisons, arithmetic, and Stan's `'` (transpose), `%` (modulus), `!`, `?`, `:`

## Limitations

- Raven doesn't ship a Quarto-specific grammar. `.qmd` files fall back to Raven's R Markdown grammar; install the [Quarto extension](https://marketplace.visualstudio.com/items?itemName=quarto.quarto) for full Quarto highlighting and preview.
- Semantic highlighting covers function names only. Everything else comes from the grammar.
- The grammars are part of the VS Code extension. Other editors use their own R grammars and get only the semantic highlighting.

## Details

### Why Raven vendors the R and R Markdown grammars

VS Code's built-in `vscode.r` extension and [`REditorSupport.r-syntax`](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r-syntax) contain no code, so VS Code installs them only where its user interface runs. The built-in grammar is a periodic copy of [REditorSupport/vscode-R-syntax](https://github.com/REditorSupport/vscode-R-syntax), so all three copies come from the same source.

Raven contains a language server, so VS Code runs it next to your workspace. Locally that is the same machine. In Remote SSH, Dev Container, WSL, and Codespaces setups, the workspace is on a different machine, which can't see interface-only extensions or their grammar files. Knit Preview highlights code on the workspace side, so it needs a grammar there.

Raven therefore includes the REditorSupport R and R Markdown grammars (MIT licensed). As a result:

- `.Rmd` and `.Rmarkdown` files highlight with no other extension: Markdown prose, R chunks, a dozen other languages in their fenced blocks, and inline `` `r ` `` expressions.
- Knit Preview always finds an R grammar, even in a new remote session where you haven't installed, or can't install, an interface-only grammar extension.
- Other grammar extensions still win when installed. For `.R` files the order is `REditorSupport.r-syntax`, `REditorSupport.r`, `vscode.r`, then Raven's copy. For `.Rmd` and `.Rmarkdown` files it is `REditorSupport.r-syntax`, `REditorSupport.r`, then Raven's copy; `vscode.r` has no R Markdown grammar.

If you install the upstream extension, you get its latest grammar. Everyone else gets the copy Raven shipped.

## See also

- [Document outline](document-outline.md)
- [R Markdown preview and export](knit.md)
- [Quarto](quarto.md)
- [Coexistence](coexistence.md)
