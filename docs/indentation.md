# Smart Indentation

Raven provides intelligent indentation for R code through a two-tier system that balances immediate usability with precise, context-aware formatting.

## Overview

| Tier | Activation | What It Handles |
|------|------------|-----------------|
| **Tier 1** | Always active | Basic indentation for pipes, operators, and brackets |
| **Tier 2** | Opt-in via `editor.formatOnType` | AST-aware indentation with style-specific alignment |

Tier 1 works immediately with no configuration. Tier 2 provides additional precision for users who want RStudio-style formatting.

## Tier 1: Basic Indentation (Always Active)

Declarative rules in VS Code's language configuration provide automatic indentation for common R patterns.

**Supported patterns:**

| Pattern | Example | Behavior |
|---------|---------|----------|
| Pipe operators | `\|>`, `%>%` | Indent next line |
| Binary operators | `+`, `~` | Indent next line |
| Custom infix operators | `%in%`, `%*%`, `%custom%` | Indent next line |
| Opening brackets | `{`, `(`, `[` | Indent next line |
| Closing brackets | `}`, `)`, `]` | Outdent current line |

**Example:**
```r
result <- data %>%
  filter(x > 0) %>%    # Tier 1 indents after %>%
  select(y)
```

Tier 1 rules apply immediately when you press Enter—no configuration required.

## Tier 2: AST-Aware Indentation (Opt-In)

For precise, context-aware indentation, enable `editor.formatOnType` in VS Code settings:

```json
{
  "editor.formatOnType": true
}
```

Tier 2 uses tree-sitter AST analysis to provide:

- **Consistent pipe chain indentation**: All continuation lines align relative to the chain start
- **Smart argument alignment**: Function arguments align based on your chosen style
- **Correct nested structure handling**: Pipes inside functions, functions inside pipes
- **Style-specific formatting**: RStudio vs RStudio-minus conventions

### How It Works

When you press Enter with `formatOnType` enabled:

1. VS Code applies Tier 1 rules (basic indentation)
2. Raven's LSP analyzes the AST at your cursor position
3. The LSP returns a TextEdit that replaces the indentation with the correct amount
4. Your cursor lands at the precise column for your code style

## Configuration

### Indentation Style

Choose between two indentation styles:

```json
{
  "raven.indentation.style": "rstudio"
}
```

| Value | Description |
|-------|-------------|
| `"rstudio"` | (Default) Same-line arguments align to opening paren; next-line arguments indent from function line |
| `"rstudio-minus"` | All arguments indent from previous line, regardless of paren position |

### RStudio Style (Default)

When the opening parenthesis is followed by content on the same line, continuation arguments align to the column after the paren:

```r
result <- function_call(first_arg,
                        second_arg,   # Aligns to column after (
                        third_arg)
```

When the opening parenthesis is followed by a newline, arguments indent by one level from the function line:

```r
result <- function_call(
  first_arg,    # Indents from function line
  second_arg,
  third_arg
)
```

### RStudio-Minus Style

All arguments indent from the previous line, regardless of where the opening paren is:

```r
result <- function_call(first_arg,
  second_arg,   # Indents from previous line
  third_arg)
```

This style is simpler and produces more consistent indentation across different function call patterns.

## Examples

### Pipe Chains

All continuation lines in a pipe chain align relative to the chain start:

```r
result <- data %>%
  filter(x > 0) %>%
  mutate(y = x * 2) %>%
  select(y)
```

The chain start is `result <- data %>%`, so all continuation lines indent one level from column 0.

### Nested Pipes in Function Calls

When a pipe chain appears inside a function call, indentation is computed relative to the pipe context:

```r
output <- some_function(
  data %>%
    filter(x > 0) %>%
    select(y),
  other_arg
)
```

### Function Calls in Pipe Chains

When a function call appears inside a pipe chain, argument indentation follows your configured style:

```r
result <- data %>%
  mutate(new_col = complex_function(arg1,
                                    arg2,
                                    arg3)) %>%
  filter(new_col > 0)
```

### Brace Blocks

Code inside braces indents one level from the line containing the opening brace:

```r
if (condition) {
  do_something()
  do_something_else()
}
```

### Closing Delimiters

Closing delimiters on their own line align to the line containing the matching opener:

```r
result <- function_call(
  arg1,
  arg2
)  # Aligns to the function_call line
```

## Troubleshooting

### Indentation not working at all

1. Check that you're editing an R file (`.R` extension)
2. Verify Raven is running: look for "Raven" in VS Code's status bar
3. Try reloading VS Code: `Ctrl+Shift+P` → "Developer: Reload Window"

### Tier 2 not activating

1. Verify `editor.formatOnType` is enabled:
   - Open Settings (`Ctrl+,`)
   - Search for "formatOnType"
   - Ensure "Editor: Format On Type" is checked
2. Check that the setting applies to R files (not overridden by language-specific settings)

### Wrong indentation style

1. Check your `raven.indentation.style` setting
2. Ensure you're using the correct style name: `"rstudio"` or `"rstudio-minus"`
3. Reload VS Code after changing the setting

### Indentation looks doubled

This can happen if both Tier 1 and another extension are applying indentation. Tier 2 should override Tier 1, but conflicts with other extensions may occur. Try:

1. Disable other R-related extensions temporarily
2. Check for conflicting `editor.formatOnType` handlers

### Pipe chains not aligning correctly

Tier 2 detects the "chain start" by walking backward through operator-terminated lines. If alignment seems wrong:

1. Ensure there's no blank line breaking the chain
2. Check that each line in the chain ends with a continuation operator (`%>%`, `|>`, `+`, `~`, or `%infix%`)

### Performance issues in large files

AST analysis runs on every Enter keypress when `formatOnType` is enabled. For very large files (1000+ lines), you may notice slight delays. If this is problematic:

1. Consider disabling `formatOnType` for large files
2. Use Tier 1 only (still provides basic indentation)
