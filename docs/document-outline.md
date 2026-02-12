# Document Outline

Raven provides a hierarchical document outline view that displays all symbols (functions, variables, classes, sections) in your R files. This feature helps you navigate large files and understand code structure at a glance.

## Overview

The document outline appears in VS Code's **Outline** view (usually in the Explorer sidebar) and provides:

- **Hierarchical symbol tree** - See nested functions, variables within sections, and class methods
- **R code sections** - Organize your code with collapsible section headers (`# Section ----`)
- **Rich symbol types** - Distinguish functions, constants, classes, and methods with distinct icons
- **Quick navigation** - Click any symbol to jump to its definition
- **Breadcrumb navigation** - See your current position in the file structure

The outline updates automatically as you edit your code.

## Accessing the Outline

**VS Code:**
- Open the **Outline** view in the Explorer sidebar
- Use **Ctrl+Shift+O** (Windows/Linux) or **Cmd+Shift+O** (Mac) to open the symbol picker
- Enable breadcrumbs: **View → Show Breadcrumbs**

**Workspace symbols (project-wide search):**
- Use **Ctrl+T** (Windows/Linux) or **Cmd+T** (Mac) to search symbols across all files

## R Code Sections

Raven recognizes R code section comments as collapsible outline nodes. Sections help organize large files into logical groups.

### Section Syntax

A valid section comment requires:
1. One or more `#` characters (determines heading level)
2. A section name (text content)
3. Four or more delimiter characters: `-`, `=`, `#`, `*`, or `+`

```r
# Section Name ----
# Section Name ====
# Section Name ####
# Section Name ****
# Section Name ++++
```

**Optional features:**
- `%%` prefix for special sections: `# %% Section Name ----`
- Leading/trailing whitespace is ignored

### Heading Levels

Use multiple `#` characters to create nested sections:

```r
# Level 1 Section ----

## Level 2 Subsection ----

### Level 3 Subsection ----

# Another Level 1 Section ----
```

In the outline view:
- Level 1 sections (`#`) appear as top-level nodes
- Level 2 sections (`##`) nest under the preceding Level 1 section
- Level 3 sections (`###`) nest under the preceding Level 2 section

### Section Ranges

A section's range extends from its comment line to the line before the next sibling or parent section:

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

Symbols defined within a section's range appear as children of that section in the outline.

### Invalid Sections

These patterns are **not** recognized as sections:

```r
# ==================  (no text content - just delimiters)
# ----                (no text content)
# Section --          (only 2 delimiters, need 4+)
```

## Symbol Types

Raven recognizes the following R constructs and assigns appropriate symbol types:

### Functions

```r
# Standard function - shows parameter list in detail
calculate <- function(x, y, z = 10) {
  x + y + z
}
```

**Icon:** Function symbol  
**Detail:** `(x, y, z = 10)` (parameter list)

### Variables

```r
# Regular variable assignment
data <- read.csv("data.csv")
result = process_data(data)
global_value <<- 42
```

**Icon:** Variable symbol

### Constants

Variables with ALL_CAPS names (minimum 2 characters) are classified as constants:

```r
PI <- 3.14159
MAX_ITERATIONS <- 1000
DB_CONNECTION_STRING <- "postgresql://..."
```

**Icon:** Constant symbol  
**Pattern:** `^[A-Z][A-Z0-9_.]+$`

### Classes

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

**Icon:** Class symbol

### Methods

```r
# S4 method
setMethod("show", "Person",
  function(object) {
    cat("Person:", object@name, "\n")
  }
)
```

**Icon:** Method symbol  
**Name:** Extracted from the first string argument (`"show"`)

### Generics

```r
# S4 generic
setGeneric("process",
  function(x, ...) standardGeneric("process")
)
```

**Icon:** Interface symbol  
**Name:** Extracted from the first string argument (`"process"`)

## Hierarchical Nesting

The outline shows symbols nested within their containing scopes:

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

**Outline structure:**
```
▼ Data Processing
  ▼ process_data (df)
      clean_df
      validated_df
      helper (x)
  CACHE_SIZE
```

## Workspace Symbol Search

Press **Ctrl+T** (Windows/Linux) or **Cmd+T** (Mac) to search for symbols across your entire project:

```
Type: "calc"
Results:
  calculate        main.R
  calculate_total  utils.R
  recalculate      analysis.R
```

**Features:**
- Fuzzy matching: "calc" matches "calculate"
- Shows file location for each symbol
- Jump to definition with Enter
- Searches open documents and indexed workspace files

## Configuration

### Workspace Symbol Limit

Control the maximum number of results returned by workspace symbol search:

```json
{
  "raven.symbols.workspaceMaxResults": 1000
}
```

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| `raven.symbols.workspaceMaxResults` | 1000 | 100-10000 | Maximum symbols in Ctrl+T search results |

Higher values may impact performance on large projects.

## Examples

### Organizing a Large Analysis Script

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

**Outline view shows:**
```
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

1. Verify the file extension is `.R`
2. Check that Raven is running (status bar shows "Raven")
3. Reload VS Code: **Ctrl+Shift+P** → "Developer: Reload Window"

### Sections not appearing in outline

Verify your section comment syntax:
- Needs at least 4 delimiter characters: `# Section ----` ✓
- Only 2-3 delimiters won't work: `# Section --` ✗
- Must have text content: `# ----` ✗

### Symbols showing at wrong level

The hierarchy is determined by:
1. Code position (line numbers)
2. Section heading levels (`#` vs `##` vs `###`)
3. Function body boundaries

Check that your section heading levels match your intended hierarchy.

### Workspace symbol search returns too few results

Increase the limit:
```json
{
  "raven.symbols.workspaceMaxResults": 5000
}
```

### Wrong symbol type/icon

Symbol types are determined by:
- **Constants:** ALL_CAPS naming pattern (2+ characters)
- **Classes:** `R6Class()`, `setClass()`, `setRefClass()` calls
- **Methods:** `setMethod()` calls
- **Generics:** `setGeneric()` calls
- **Functions:** `function(...)` on right-hand side
- **Variables:** All other assignments

Reserved words (if, else, for, while, TRUE, FALSE, NULL, etc.) are automatically filtered out.
