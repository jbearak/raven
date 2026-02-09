# R Smart Indentation in VS Code -- Research

## The Problem

VS Code's R indentation doesn't handle two common patterns well:

1. **Pipe continuation**: After `|>` or `%>%` at end of line, the next line should be indented +2 from the chain start (not from the pipe line)
2. **Open-paren alignment**: Inside unclosed `(`, continuation lines should align appropriately (either to the paren column, or +2 from the call)
3. **De-indenting**: When a pipe chain ends (no trailing `|>`), the next statement should return to base indentation

Emacs+ESS handles all of this; VS Code currently does not.

---

## Current State in Raven

### Language Configuration (`editors/vscode/language-configuration.json`)

```json
"indentationRules": {
  "increaseIndentPattern": "^.*\\{[^}]*$|^.*\\([^)]*$",
  "decreaseIndentPattern": "^\\s*[})]"
}
```

This handles `{`/`(` indent and `}`/`)` de-indent, but nothing for pipes, `+`, `~`, or other continuation operators.

### LSP On-Type Formatting

**Removed** (commit `bb9e89a`). The previous handler was registered for `"\n"` and hardcoded 2-space indentation. It conflicted with VS Code's declarative `indentationRules` -- the LSP response inserted whitespace additively on top of what VS Code already applied, producing incorrect indentation (e.g., 6 spaces instead of the user's configured 4). Since the declarative rules already handle `{`/`(` correctly, the handler was removed entirely. It should be reintroduced only when we implement proper AST-aware indentation for pipes and argument alignment (Tier 2 below).

**Important lesson for reimplementation:** The `textDocument/onTypeFormatting` response TextEdits must **replace** the full indentation on the new line, not insert at column 0. The edit range should span from `(line, 0)` to `(line, <existing_whitespace_length>)` so it overwrites whatever VS Code's declarative rules produced. Additionally, the handler must respect `FormattingOptions.tab_size` and `FormattingOptions.insert_spaces` from the request params rather than hardcoding spaces.

---

## How ESS Does It

ESS treats indentation as a function of syntactic context. Key findings:

### Pipes are ordinary continuation operators

`%>%`, `|>`, `+`, `~`, and all binary operators go through the same code path. When a line ends with any operator, `ess-ahead-continuation-p` returns true and continuation indentation applies.

### The continuation algorithm

1. Walk backward through consecutive operator-terminated lines to find the **chain start** (first line NOT preceded by an operator-terminated line)
2. Indent continuation lines by `ess-indent-offset` (2 in RStudio style) from the chain start's column
3. All continuation lines get the **same** indentation (the `straight` mode, which is the default)

**For VS Code implementation:** Use `editor.tabSize` instead of hardcoding 2 spaces. Read from `editor.options.tabSize` and `editor.options.insertSpaces` to respect user configuration.

Example (assuming tabSize=2):
```r
result <- data %>%        # chain start, col 11
  filter(x > 0) %>%      # +tabSize from "result" (col 0 + 2 = col 2)
  mutate(y = x + 1) %>%  # same +tabSize
  select(y)              # same +tabSize
```

### Argument alignment (inside parentheses)

Three modes controlled by `ess-offset-arguments`:

| Mode | Behavior | Example |
|------|----------|---------|
| `open-delim` (default + RStudio) | Align to column after `(` | `func(arg1,`<br>`     arg2)` |
| `prev-call` | +offset from function name | `func(arg1,`<br>`    arg2)` |
| `prev-line` (RStudio-) | +offset from line indentation | `func(arg1,`<br>`  arg2)` |

When `(` is followed by a newline, `ess-offset-arguments-newline` applies instead (RStudio uses `prev-line` for this case):

```r
long_function_name(
  arg1,  # +tabSize from function line
  arg2
)
```

### RStudio style settings

| Variable | RStudio value |
|----------|--------------|
| `ess-indent-offset` | 2 (use `editor.tabSize` in VS Code) |
| `ess-offset-arguments` | `open-delim` |
| `ess-offset-arguments-newline` | `prev-line` |
| `ess-offset-block` | `prev-line` |
| `ess-offset-continued` | `straight` |
| `ess-align-continuations-in-calls` | `nil` |
| `ess-indent-from-chain-start` | `t` |

Key: `ess-align-continuations-in-calls = nil` means pipe chains inside function calls DON'T align to the paren column, they indent normally from line context:

```r
result <- some_function(
  data %>%
    filter(x > 0) %>%
    mutate(y = x + 1)
)
```

---

## VS Code Indentation Mechanisms Available

### 1. `indentationRules` (declarative, regex)

- `increaseIndentPattern`: Next line gets +1 indent
- `decreaseIndentPattern`: Current line gets -1 indent
- Fires at `editor.autoIndent = "full"` (the default)
- **Limitation**: Only relative +1/-1 indent steps; no column alignment

### 2. `onEnterRules` (declarative, regex)

- Matches `beforeText`, optionally `afterText` and `previousLineText`
- Actions: `Indent`, `Outdent`, `IndentOutdent`, `None`
- Can `appendText` to the new line
- Fires at `editor.autoIndent >= "advanced"`
- **Limitations**: No capture groups (VS Code issue #17281, open), no dynamic column alignment (issue #66235, open), only relative indent changes

What onEnterRules CAN do for pipes:
```json
{
  "beforeText": ".*(\\|>|%>%|%\\w+%|\\+|~)\\s*(#.*)?$",
  "action": { "indent": "indent" }
}
```
This gives "+1 indent after trailing pipe/plus/tilde" -- basic but functional.

What onEnterRules CANNOT do:
- Align to opening paren column
- Detect chain start for consistent continuation indent
- Handle nested contexts (pipe inside function call inside pipe)

### 3. LSP `textDocument/onTypeFormatting` (programmatic, AST-aware)

- Server declares trigger characters (including `"\n"`)
- On trigger, VS Code sends position + context to server
- Server returns `TextEdit[]` that **override** the auto-indent result
- **Requires `editor.formatOnType = true`** (disabled by default)
- Can compute exact indentation using full AST via tree-sitter

**Order of operations on Enter:**
1. VS Code inserts newline
2. Built-in auto-indent runs (indentationRules/onEnterRules)
3. If `formatOnType` enabled + server registered `"\n"`, sends `textDocument/onTypeFormatting`
4. Server's TextEdit response overrides auto-indent

### 4. Future: tree-sitter indentation queries (VS Code issue #208985)

VS Code has acknowledged interest in declarative tree-sitter-based `@indent`/`@outdent`/`@aligned_indent` captures (like Neovim). Not yet implemented.

---

## Recommended Implementation Strategy

### Tier 1: Declarative rules (always-on, no user opt-in needed)

Enhance `language-configuration.json`:

```json
"indentationRules": {
  "increaseIndentPattern": "^.*[{(\\[]\\s*(#.*)?$",
  "decreaseIndentPattern": "^\\s*[})]"
},
"onEnterRules": [
  {
    "beforeText": ".*(\\|>|%>%)\\s*(#.*)?$",
    "action": { "indent": "indent" }
  },
  {
    "beforeText": ".*\\+\\s*(#.*)?$",
    "action": { "indent": "indent" }
  },
  {
    "beforeText": ".*~\\s*(#.*)?$",
    "action": { "indent": "indent" }
  },
  {
    "beforeText": ".*(%\\w+%)\\s*(#.*)?$",
    "action": { "indent": "indent" }
  },
  {
    "beforeText": "^\\s*\\)\\s*$",
    "action": { "indent": "outdent" }
  }
]
```

This gets "80% correct" indentation with zero server dependency.

### Tier 2: AST-aware on-type formatting (precise, opt-in via `formatOnType`)

Reintroduce `textDocument/onTypeFormatting` in the LSP server (removed in `bb9e89a`) with a proper AST-aware implementation using tree-sitter:

**Algorithm (RStudio style):**

On newline, inspect the AST at the cursor position:

1. **Inside unclosed `(`/`[`/`{`**:
   - If opener is followed by content on same line → align to column after opener (open-delim)
   - If opener is followed by newline → indent +tabSize from the line containing the opener (prev-line)
   - Special: `{` always indents +tabSize (block indent)

2. **After continuation operator** (`|>`, `%>%`, `+`, `~`, `%infix%`):
   - Walk backward through the AST to find the chain start (first expression not preceded by an operator-terminated line)
   - Indent +tabSize from the chain start's column
   - All continuation lines in the chain get the same indentation (straight mode)

3. **Closing delimiter on its own line** (`)`, `]`, `}`):
   - Align to the column of the matching opener's line

4. **After a complete expression** (no trailing operator, no unclosed delimiters):
   - Return to the indentation of the enclosing block

**Implementation note:** Read `FormattingOptions.tab_size` and `FormattingOptions.insert_spaces` from the LSP request params to respect user configuration. The TextEdit response must replace the full indentation range `(line, 0)` to `(line, existing_whitespace_length)` to override VS Code's declarative rules.

**tree-sitter nodes to use:**
- `pipe_operator` (for `|>`)
- `special_operator` (for `%>%`, `%in%`, etc.)
- `binary_operator` with `+`, `~` operators
- `call` / `arguments` nodes for function call context
- `brace_list` for `{}`-delimited blocks

### Configuration

Expose an indentation style setting:

```json
"raven.indentation.style": {
  "type": "string",
  "enum": ["rstudio", "rstudio-minus"],
  "default": "rstudio",
  "description": "Indentation style for R code"
}
```

| Style | Args (same-line) | Args (next-line) | Continuations in calls |
|-------|-----------------|-------------------|----------------------|
| `rstudio` | open-delim | prev-line (+tabSize) | Not aligned to paren |
| `rstudio-minus` | prev-line (+tabSize) | prev-line (+tabSize) | Not aligned to paren |

The difference: RStudio aligns arguments to the opening paren when on the same line, while RStudio- indents them relative to the previous line.

Note: `+tabSize` refers to the user's configured `editor.tabSize` setting (typically 2 for R).

---

## What Ben Specifically Wants (from the Slack thread)

1. After `|>` or `%>%` at end of line → indent the verb on the next line by +tabSize from the pipeline object (chain start)
2. Inside unclosed `()` → align or indent continuation arguments properly
3. Smart de-indentation when a pipe chain ends

All three are achievable with the Tier 2 approach. Tier 1 alone handles #1 partially (indents, but doesn't track chain start for consistent indent across the chain).

---

## References

- VS Code language configuration: https://code.visualstudio.com/api/language-extensions/language-configuration-guide
- LSP onTypeFormatting spec: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_onTypeFormatting
- ESS source (indentation): https://github.com/emacs-ess/ESS/blob/master/lisp/ess-r-mode.el
- ESS source (styles): https://github.com/emacs-ess/ESS/blob/master/lisp/ess-custom.el
- ESS source (syntax/operators): https://github.com/emacs-ess/ESS/blob/master/lisp/ess-r-syntax.el
- VS Code issue #17281 (onEnterRules capture groups): https://github.com/Microsoft/vscode/issues/17281
- VS Code issue #66235 (powerful onEnterRules): https://github.com/microsoft/vscode/issues/66235
- VS Code issue #208985 (tree-sitter indentation): https://github.com/microsoft/vscode/issues/208985
- Tidyverse style guide (pipes): https://style.tidyverse.org/pipes.html
- ruby-lsp onTypeFormatting (reference): https://github.com/Shopify/ruby-lsp/blob/main/lib/ruby_lsp/requests/on_type_formatting.rb
