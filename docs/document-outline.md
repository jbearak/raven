# Document outline

[Docs](README.md) › Navigation and editing

The outline and breadcrumbs show your file's sections, functions, variables, and classes as a tree, so you can see a long file's structure and jump to any part of it.

```r
# Data loading ----
load_data <- function(path) {
  read.csv(path)
}
raw_data <- load_data("data.csv")

## Cleaning ----
MAX_RECORDS <- 10000
```

The Outline view shows:

```text
▼ Data loading
    load_data (path)
    raw_data
  ▼ Cleaning
      MAX_RECORDS
```

<a id="overview"></a>

## What appears in the outline

- Section comments such as `# Section ----`, as collapsible nodes. `##` sections nest under `#` sections.
- Functions, variables, constants, classes, S4 methods, and generics, each with its own icon.
- Symbols inside functions and sections, nested under them.
- In R Markdown and Quarto, the Markdown headings and every code chunk. In `.R` files, each `# %%` cell.
- In JAGS and Stan files, model blocks, decorative comment headings, and `for` loops.

The outline updates as you edit. Click any entry to jump to it.

## Accessing the outline

In VS Code:

- Open the **Outline** view in the Explorer sidebar.
- Press Cmd+Shift+O (Ctrl+Shift+O on Windows and Linux) to pick a symbol in the current file.
- Turn on breadcrumbs with **View → Show Breadcrumbs** to see where the cursor is in the tree.
- Press Cmd+T (Ctrl+T on Windows and Linux) to search symbols across all files; see [Workspace symbol search](#workspace-symbol-search).

Other LSP editors show the same symbols in their own outline or symbol picker.

## R code sections

A comment that ends in four or more dashes (or `=`, `#`, `*`, `+`) is a section. Sections are collapsible outline nodes that group the code below them.

### Section syntax

A section comment needs:

1. one or more `#` characters, which set the heading level
2. a section name
3. four or more of the same delimiter: `-`, `=`, `#`, `*`, or `+`

```r
# Section Name ----
# Section Name ====
# Section Name ####
# Section Name ****
# Section Name ++++
```

You can also start a section with `%%`, as in `# %% Section Name ----`. Leading and trailing whitespace is ignored.

### Heading levels

Use more `#` characters to nest sections:

```r
# Level 1 Section ----

## Level 2 Subsection ----

### Level 3 Subsection ----

# Another Level 1 Section ----
```

In the outline, `#` sections are top-level nodes, `##` sections nest under the `#` section before them, and `###` sections nest under the `##` section before them.

### Section ranges

A section runs from its comment line to the line before the next section at the same or a higher level:

```r
# Data Loading ----
data <- read.csv("data.csv")

## Cleaning ----
data <- clean_data(data)

## Validation ----
validate_data(data)
# This line is still in the "Validation" section

# Analysis ----
# This starts a new Level 1 section
```

Symbols defined inside a section's range appear as its children.

### Invalid sections

These are not sections:

```r
# ==================  (no name, only delimiters)
# ----                (no name)
# Section --          (only 2 delimiters; 4 or more are needed)
```

<a id="r-markdown--quarto-chunks"></a>

## R Markdown and Quarto chunks

In `.Rmd` and `.qmd` files, every fenced code chunk gets its own outline entry. A chunk's label becomes the entry name. Unlabeled chunks are named `Chunk #N`, numbered in order through the whole document. Non-R chunks (`{python}`, `{julia}`, …) show their language as the detail.

`````rmd
```{r setup, include=FALSE}
library(dplyr)
```

```{r}
analysis(data)
```

```{python}
print("hi")
```
`````

The Outline view shows:

```text
setup
Chunk #2
Chunk #3        {python}
```

Chunks have their own symbol kind (object), so the outline's filter can show or hide them separately from section comments.

R symbols defined inside an R chunk (functions, variables, S4 and R6 classes) also appear, nested under their chunk at their real line in the document. Prose, YAML front matter, and non-R chunks are ignored, so a `library(...)` call in prose or a Python chunk never creates an outline entry. Non-R chunks show only the chunk entry.

### `# %%` cells in `.R` files

Plain `.R` files can use the VS Code cell convention: a `# %%` line starts a cell that runs until the next marker, a section comment, or the end of the file. Text after the marker becomes the cell's name:

```r
# %% Setup
library(dplyr)

# %% Analysis
fit_model(data)
```

Cells with no name are called `Chunk #N`.

> [!NOTE]
> A line like `# %% Setup ----` is both a cell marker and a section comment, so it appears twice in the outline: once as a collapsible section and once as a cell. Write `# %% Setup`, without the trailing `----`, if you want only a cell.

<a id="r-markdown--quarto-headings"></a>

## R Markdown and Quarto headings

In `.Rmd` and `.qmd` files, the Markdown headings (`#`, `##`, …) form the outline, so the Outline view and breadcrumbs follow the document's structure as you edit.

`````rmd
---
title: "My Report"
---

# Introduction

Some prose.

```{r setup}
library(dplyr)
```

## Methods

```{r model}
fit <- lm(y ~ x, data = df)
```
`````

The Outline view shows:

```text
▼ Introduction
  ▼ setup
  ▼ Methods
    ▼ model
        fit
```

- Headings nest by level, from `#` (level 1) to `######`, like R code sections.
- A chunk appears under the heading whose section contains it, and the R symbols defined in the chunk nest under the chunk.
- Only prose headings count. Headings inside YAML front matter, fenced code blocks, and R chunks are ignored, so a `#` comment in code never becomes a heading. A `# Section ----` comment inside a chunk still appears as an entry, but it doesn't take part in the document's heading structure.
- Headings have their own icon (the string symbol kind), so the outline's filter can show or hide them separately from code chunks (object) and R sections (module).
- Only `#`-style (ATX) headings are recognized. Text underlined with `===` or `---` (setext headings) isn't.

## Symbol types

Raven gives each kind of R definition its own icon:

| Definition | Icon | Example |
|---|---|---|
| Function | Function, with the parameter list as the detail | `calculate <- function(x, y) …` |
| Variable assigned a call or other expression | Field | `data <- read.csv("data.csv")` |
| Variable assigned a literal | Boolean, Number, String, Null, Constant, Array, or List | `count <- 42` |
| ALL_CAPS name | Constant | `MAX_ITERATIONS <- 1000` |
| R6, S4, or reference class | Class | `MyClass <- R6Class("MyClass", …)` |
| S4 method | Method | `setMethod("show", "Person", …)` |
| S4 generic | Interface | `setGeneric("process", …)` |

### Functions

```r
# Standard function: shows its parameter list as the detail
calculate <- function(x, y, z = 10) {
  x + y + z
}
```

The entry has the Function icon and `(x, y, z = 10)` as its detail.

### Variables

```r
# The right side is a function call, so these are Fields
data <- read.csv("data.csv")
result = process_data(data)
cached_value <<- compute_default()
```

These get the Field icon. Field is the fallback for a right side that isn't a recognized literal. When the right side is a literal, Raven uses a more specific icon; see [Value-typed variables](#value-typed-variables).

### Value-typed variables

When a variable whose name isn't ALL_CAPS is assigned a literal value, its icon follows the value's type:

```r
flag    <- TRUE          # Boolean
count   <- 42            # Number (integer, float, or complex literal)
label   <- "summary"     # String
empty   <- NULL          # Null
missing <- NA            # Constant (also NA_integer_/…, Inf, NaN)
items   <- c(1, 2, 3)    # Array (c(), vector(), matrix(), array())
config  <- list(a = 1)   # List
```

The name is checked before the value, so `MAX <- 42` is a Constant while `count <- 42` is a Number. The [full order](#wrong-symbol-typeicon) is under Troubleshooting.

### Constants

Names in ALL_CAPS, at least 2 characters long and matching `^[A-Z][A-Z0-9_.]+$`, get the Constant icon:

```r
PI <- 3.14159
MAX_ITERATIONS <- 1000
DB_CONNECTION_STRING <- "postgresql://..."
```

### Classes

R6 classes, S4 classes, and reference classes get the Class icon:

```r
# R6 class
MyClass <- R6Class("MyClass",
  public = list(
    initialize = function(x) { self$x <- x }
  )
)

# S4 class
setClass("Person",
  slots = c(name = "character", age = "numeric")
)

# Reference class
MyRefClass <- setRefClass("MyRefClass",
  fields = list(value = "numeric")
)
```

<a id="methods-1"></a>

### Methods

S4 methods get the Method icon. The entry is named from the first string argument, here `show`:

```r
setMethod("show", "Person",
  function(object) {
    cat("Person:", object@name, "\n")
  }
)
```

### Generics

S4 generics get the Interface icon. The entry is named from the first string argument, here `process`:

```r
setGeneric("process",
  function(x, ...) standardGeneric("process")
)
```

## Hierarchical nesting

Symbols nest under the function or section that contains them:

```r
# Data Processing ----

process_data <- function(df) {
  # These assignments appear as children of process_data()
  clean_df <- remove_na(df)
  validated_df <- validate(clean_df)

  # Nested function also appears as a child
  helper <- function(x) { x * 2 }

  return(validated_df)
}

# This variable is a child of the "Data Processing" section
CACHE_SIZE <- 1000
```

The Outline view shows:

```text
▼ Data Processing
  ▼ process_data (df)
      clean_df
      validated_df
      helper (x)
  CACHE_SIZE
```

## JAGS and Stan model structure

In JAGS and Stan files, the model blocks are the top level of the outline. Decorative comment headings nest inside the blocks, and `for` loops are containers for the symbols declared in them.

### JAGS blocks

JAGS files (`.jags`, `.bugs`, `.bug`, in any letter case) have two blocks. These extensions mean JAGS, not general OpenBUGS, WinBUGS, MultiBUGS, or NIMBLE compatibility.

| Block | Outline name |
|---|---|
| `data { }` | data |
| `model { }` | model |

### Stan blocks

Stan files (`.stan`) have seven blocks:

| Block | Outline name |
|---|---|
| `functions { }` | functions |
| `data { }` | data |
| `transformed data { }` | transformed data |
| `parameters { }` | parameters |
| `transformed parameters { }` | transformed parameters |
| `model { }` | model |
| `generated quantities { }` | generated quantities |

A constrained declaration shows the declared name, so `real<lower=0, upper=1> foo;` appears as `foo`, not as the constraint names.

### Decorative comment headings

JAGS and Stan files recognize decorative headings only. A plain comment such as `// DIMENSIONS` or `# levels:` isn't added to the outline.

Banner headings are recognized:

```stan
// =====================================================================
// DIMENSIONS
// =====================================================================
```

So are inline decorative headings:

```stan
// --- Incomplete official statistics (minima) ---
```

```jags
# --- Priors ---
```

Banner headings sit at the top level inside their block, and inline headings one level below. Hash-decorated banner titles such as `## NAME ##` in JAGS keep the depth they spell out.

### Loops

`for` loops in JAGS and Stan files are container nodes in the outline, with or without braces:

```stan
for (p_idx in 1:n_p1) {
  real foo = p_idx;
}

for (j in 1:M)
  real bar = j;
```

Symbols declared inside a loop appear as its children, and nested loops nest in the outline.

### Example

```stan
data {
  // =====================================================================
  // DIMENSIONS
  // =====================================================================
  int<lower=0> N;
  vector[N] y;
}
parameters {
  real mu;
  real<lower=0> sigma;
}
model {
  // --- Likelihood ---
  for (n in 1:N) {
    y[n] ~ normal(mu, sigma);
  }
}
```

The Outline view shows:

```text
▼ data
  ▼ DIMENSIONS
      N
      y
▼ parameters
    mu
    sigma
▼ model
  ▼ Likelihood
    ▼ for (n in 1:N)
```

Braces nested inside a block are handled correctly, and decorative headings nest under their block rather than competing with blocks at the top level. If a block's closing brace is missing, the block runs to the end of the file.

## Workspace symbol search

Press Cmd+T (Ctrl+T on Windows and Linux) to search for symbols across the whole project:

```text
Type: "calc"
Results:
  calculate        main.R
  calculate_total  utils.R
  recalculate      analysis.R
```

- Matching is by substring and ignores case, so "calc" matches "calculate".
- Each result shows its file. Press Enter to jump to the definition.
- The search covers open files and indexed workspace files.

## Examples

### Organizing a large analysis script

```r
# Setup ----

library(dplyr)
library(ggplot2)

DATA_PATH <- "data/raw"
OUTPUT_PATH <- "output"

## Configuration ----

MAX_RECORDS <- 10000
CONFIDENCE_THRESHOLD <- 0.95

# Data Loading ----

load_data <- function(path) {
  read.csv(path, stringsAsFactors = FALSE)
}

raw_data <- load_data(DATA_PATH)

# Analysis ----

## Preprocessing ----

clean_data <- function(df) {
  df %>%
    filter(!is.na(value)) %>%
    filter(value > 0)
}

processed_data <- clean_data(raw_data)

## Modeling ----

fit_model <- function(df) {
  lm(y ~ x, data = df)
}

model <- fit_model(processed_data)
```

The Outline view shows:

```text
▼ Setup
    DATA_PATH
    OUTPUT_PATH
  ▼ Configuration
      MAX_RECORDS
      CONFIDENCE_THRESHOLD
▼ Data Loading
    load_data (path)
    raw_data
▼ Analysis
  ▼ Preprocessing
      clean_data (df)
      processed_data
  ▼ Modeling
      fit_model (df)
      model
```

## Troubleshooting

### Outline view is empty

1. Check that the file extension is `.R`, `.Rmd`, `.qmd`, `.jags`, `.bugs`, `.bug`, or `.stan`.
2. Check that Raven is running: in VS Code, the **Raven** channel in the Output panel shows the server's log.
3. Reload the window: run **Developer: Reload Window** from the command palette.

### Sections not appearing in outline

Check the section comment:

- `# Section ----` works: it has a name and at least 4 delimiters.
- `# Section --` doesn't: 2 or 3 delimiters aren't enough.
- `# ----` doesn't: it has no name.

### Symbols showing at wrong level

The tree comes from three things: the order of lines, the section levels (`#`, `##`, `###`), and function bodies. Check that your section levels match the hierarchy you want.

### Workspace symbol search returns too few results

Raise `raven.symbols.workspaceMaxResults`:

```json
{
  "raven.symbols.workspaceMaxResults": 5000
}
```

### Wrong symbol type/icon

Raven picks the icon by checking these in order; the first match wins:

1. Class: an `R6Class()`, `setClass()`, or `setRefClass()` call.
2. Constant: an ALL_CAPS name of 2 or more characters.
3. Function: `function(...)` on the right side.
4. Value type: a literal on the right side gives Boolean (`TRUE`/`FALSE`), Number, String, Null (`NULL`), Constant (`NA`, `Inf`, `NaN`), Array (`c()`, `vector()`, `matrix()`, `array()`), or List (`list()`).
5. Field: every other assignment.

So `x <- 42` is a Number, not a Field, and `MAX <- 42` is a Constant because the name is checked before the value. Reserved words (`if`, `else`, `for`, `while`, `TRUE`, `FALSE`, `NULL`, and so on) never appear as symbols.

<a id="configuration"></a>

## Settings

<a id="workspace-symbol-limit"></a>

| Setting | Default | Range | What it does |
|---|---|---|---|
| `raven.symbols.workspaceMaxResults` | `1000` | 100 to 10000 | Maximum number of results in workspace symbol search (Cmd/Ctrl+T) |

Higher values can slow the search in large projects. See [Settings reference](settings-reference.md) for every setting.

## See also

- [Code chunks](chunks.md)
- [Find references](find-references.md)
- [Syntax highlighting](syntax-highlighting.md)
