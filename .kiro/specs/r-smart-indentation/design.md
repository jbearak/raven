# Design Document: R Smart Indentation

## Overview

This feature implements intelligent indentation for R code in VS Code through a two-tier architecture:

**Tier 1 (Declarative)**: Regex-based rules in `language-configuration.json` that provide basic indentation for pipes, operators, and brackets. These rules are always active and require no user configuration.

**Tier 2 (AST-Aware)**: LSP `textDocument/onTypeFormatting` handler that uses tree-sitter AST analysis to provide precise, context-aware indentation. This tier is opt-in via the `editor.formatOnType` setting and handles complex cases like chain-start detection, nested contexts, and style-specific alignment.

The design respects user preferences for tab size and space/tab usage, and supports both RStudio and RStudio-minus indentation styles.

## Architecture

### Component Overview

```text
┌─────────────────────────────────────────────────────────────┐
│                        VS Code Editor                        │
│  ┌────────────────────┐         ┌──────────────────────┐   │
│  │ Language Config    │         │ Editor Settings      │   │
│  │ (Tier 1)           │         │ - formatOnType       │   │
│  │ - onEnterRules     │         │ - tabSize            │   │
│  │ - indentationRules │         │ - insertSpaces       │   │
│  └────────────────────┘         └──────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                           │
                           │ LSP Protocol
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Raven LSP Server                          │
│  ┌────────────────────────────────────────────────────────┐ │
│  │         OnTypeFormatting Handler (Tier 2)              │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │ │
│  │  │ Context      │  │ Indentation  │  │ Style       │ │ │
│  │  │ Detector     │→ │ Calculator   │→ │ Formatter   │ │ │
│  │  └──────────────┘  └──────────────┘  └─────────────┘ │ │
│  │         ▲                                              │ │
│  │         │                                              │ │
│  │  ┌──────────────┐                                     │ │
│  │  │ Tree-Sitter  │                                     │ │
│  │  │ AST Parser   │                                     │ │
│  │  └──────────────┘                                     │ │
│  └────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Configuration Manager                     │ │
│  │              - raven.indentation.style                 │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Execution Flow

**On Enter Key Press:**

1. User presses Enter in R file
2. VS Code inserts newline character
3. **Tier 1**: VS Code applies declarative rules from `language-configuration.json`
   - Checks `onEnterRules` patterns against previous line
   - Applies indent/outdent actions
4. **Tier 2** (if `editor.formatOnType` is enabled):
   - VS Code sends `textDocument/onTypeFormatting` request to LSP server
   - Server's Context Detector analyzes AST at cursor position
   - Indentation Calculator computes correct indentation
   - Style Formatter generates TextEdit with proper whitespace
   - TextEdit **replaces** the indentation VS Code applied in step 3
5. Final indented line appears in editor

### Key Design Decisions

**Why Two Tiers?**
- Tier 1 provides immediate value with zero configuration
- Tier 2 provides precision for users who want it
- Separation allows graceful degradation if LSP is unavailable

**Why Replace Instead of Insert?**
- VS Code's declarative rules run first and insert indentation
- LSP response must replace that indentation, not add to it
- TextEdit range: `(line, 0)` to `(line, existing_whitespace_length)`
- This prevents double-indentation bugs (e.g., 6 spaces instead of 4)

**Auto-Closing Pairs and Closing Delimiter Detection**

VS Code's auto-closing pairs feature (e.g., typing `(` inserts `()`) interacts with `onTypeFormatting` in a critical way. When the user presses Enter between auto-inserted delimiters:

1. User types `func(` → VS Code auto-inserts `)` → cursor is between: `func(|)`
2. User presses Enter → document becomes `func(\n)` with cursor on the new line
3. `onTypeFormatting` fires for the new line, which now starts with `)`

The closing delimiter detection must NOT treat this as a "closing delimiter line" — the user wants content indentation, not closing delimiter alignment. The heuristic: if a line contains ONLY a closing delimiter (with optional whitespace), skip closing delimiter detection and let the normal `InsideParens`/`InsideBraces` detection handle it. This ensures the line gets content-level indentation (including paren-alignment in RStudio style).

This applies to all auto-closed delimiters: `)`, `]`, `}`.

**Why Tree-Sitter?**
- Provides accurate syntactic context (not just regex matching)
- Already integrated into Raven for other features
- Handles nested contexts correctly
- Distinguishes between operator types reliably

## Components and Interfaces

### Tier 1: Language Configuration

**File**: `editors/vscode/language-configuration.json`

**Enhanced indentationRules**:
```json
{
  "indentationRules": {
    "increaseIndentPattern": "^.*[{(\\[]\\s*(#.*)?$",
    "decreaseIndentPattern": "^\\s*[})\\]]"
  }
}
```

**New onEnterRules**:
```json
{
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
    }
  ]
}
```

**Pattern Explanation**:
- `.*` - any characters before operator
- `(\\|>|%>%)` - pipe operators (escaped for JSON)
- `\\s*` - optional trailing whitespace
- `(#.*)?` - optional comment
- `$` - end of line

### Tier 2: OnTypeFormatting Handler

**Module**: `crates/raven/src/handlers/on_type_formatting.rs` (to be created)

**LSP Registration**:
```rust
pub fn on_type_formatting_capability() -> OnTypeFormattingOptions {
    OnTypeFormattingOptions {
        first_trigger_character: "\n".to_string(),
        more_trigger_character: None,
    }
}
```

**Handler Signature**:
```rust
pub async fn on_type_formatting(
    state: Arc<GlobalState>,
    params: DocumentOnTypeFormattingParams,
) -> Result<Option<Vec<TextEdit>>> {
    // Implementation
}
```

**Request Parameters** (from LSP):
```rust
struct DocumentOnTypeFormattingParams {
    text_document: TextDocumentIdentifier,
    position: Position,  // Cursor position after newline
    ch: String,          // Trigger character ("\n")
    options: FormattingOptions,
}

struct FormattingOptions {
    tab_size: u32,        // User's editor.tabSize
    insert_spaces: bool,  // User's editor.insertSpaces
}
```

### Context Detector

**Module**: `crates/raven/src/indentation/context.rs` (to be created)

**Purpose**: Analyze tree-sitter AST to determine syntactic context at cursor position.

**Interface**:
```rust
pub enum IndentContext {
    /// Inside unclosed parentheses
    InsideParens {
        opener_line: u32,
        opener_col: u32,
        has_content_on_opener_line: bool,
    },
    
    /// Inside unclosed braces
    InsideBraces {
        opener_line: u32,
        opener_col: u32,
    },
    
    /// After continuation operator (pipe, plus, tilde, infix)
    AfterContinuationOperator {
        chain_start_line: u32,
        chain_start_col: u32,
        operator_type: OperatorType,
    },
    
    /// After complete expression (no trailing operator, no unclosed delimiters)
    AfterCompleteExpression {
        enclosing_block_indent: u32,
    },
    
    /// Closing delimiter on its own line
    ClosingDelimiter {
        opener_line: u32,
        opener_col: u32,
        delimiter: char,
    },
}

pub enum OperatorType {
    Pipe,           // |>
    MagrittrPipe,   // %>%
    Plus,           // +
    Tilde,          // ~
    CustomInfix,    // %word%
}

pub fn detect_context(
    tree: &Tree,
    source: &str,
    position: Position,
) -> IndentContext {
    // Implementation
}
```

**Algorithm**:

1. Get tree-sitter node at cursor position
2. Walk up the AST to find relevant parent nodes
3. Check for unclosed delimiters:
   - Look for `arguments` node (inside parens)
   - Look for `brace_list` node (inside braces)
   - Check if delimiter is closed before cursor position
4. Check for continuation operators:
   - Look for `pipe_operator`, `special_operator`, or `binary_operator` nodes
   - Check if operator is at end of previous line
   - Walk backward to find chain start
5. Check for closing delimiters:
   - Check if current line starts with `)`, `]`, or `}`
   - Find matching opener
6. Default to complete expression context

**Tree-Sitter Node Types**:
- `pipe_operator` - native pipe `|>`
- `special_operator` - magrittr pipe `%>%` and custom infix `%word%`
- `binary_operator` - `+`, `~`, and other binary ops
- `call` - function call expression
- `arguments` - argument list inside `()`
- `brace_list` - code block inside `{}`

### Indentation Calculator

**Module**: `crates/raven/src/indentation/calculator.rs` (to be created)

**Purpose**: Compute the correct indentation amount based on context and style.

**Interface**:
```rust
pub struct IndentationConfig {
    pub tab_size: u32,
    pub insert_spaces: bool,
    pub style: IndentationStyle,
}

pub enum IndentationStyle {
    RStudio,
    RStudioMinus,
    Off,
}

pub fn calculate_indentation(
    context: IndentContext,
    config: IndentationConfig,
    source: &str,
) -> u32 {
    // Returns column number for indentation
}
```

**Algorithm by Context**:

**InsideParens**:
- RStudio style:
  - If `has_content_on_opener_line` is true: return `opener_col + 1`
  - If false: return `get_line_indent(opener_line) + tab_size`
- RStudioMinus style:
  - Always return `get_line_indent(previous_line) + tab_size`

**InsideBraces**:
- Return `get_line_indent(opener_line) + tab_size`

**AfterContinuationOperator**:
- Return `chain_start_col + tab_size`
- All continuation lines in chain get same indentation (straight mode)

**AfterCompleteExpression**:
- Return `enclosing_block_indent`

**ClosingDelimiter**:
- Return `get_line_indent(opener_line)`

**Helper Functions**:
```rust
fn get_line_indent(source: &str, line: u32) -> u32 {
    // Count leading whitespace on specified line
}

fn find_chain_start(tree: &Tree, source: &str, position: Position) -> (u32, u32) {
    // Walk backward through operator-terminated lines
    // Return (line, column) of first non-continuation line
}
```

### Style Formatter

**Module**: `crates/raven/src/indentation/formatter.rs` (to be created)

**Purpose**: Generate TextEdit with proper whitespace characters.

**Interface**:
```rust
pub fn format_indentation(
    line: u32,
    target_column: u32,
    config: IndentationConfig,
    source: &str,
) -> TextEdit {
    // Implementation
}
```

**Algorithm**:

1. Calculate existing whitespace length on target line:
   ```rust
   let existing_ws_len = source.lines()
       .nth(line as usize)
       .map(|l| l.chars().take_while(|c| c.is_whitespace()).count())
       .unwrap_or(0);
   ```

2. Generate new whitespace string:
   ```rust
   let new_indent = if config.insert_spaces {
       " ".repeat(target_column as usize)
   } else {
       let tabs = target_column / config.tab_size;
       let spaces = target_column % config.tab_size;
       "\t".repeat(tabs as usize) + &" ".repeat(spaces as usize)
   };
   ```

3. Create TextEdit that replaces existing whitespace:
   ```rust
   TextEdit {
       range: Range {
           start: Position { line, character: 0 },
           end: Position { line, character: existing_ws_len as u32 },
       },
       new_text: new_indent,
   }
   ```

**Critical**: The range must span from column 0 to the end of existing whitespace. This ensures the LSP response overrides VS Code's declarative indentation instead of adding to it.

### Configuration Manager

**Module**: `crates/raven/src/config.rs` (existing, to be extended)

**New Configuration Field**:
```rust
pub struct Config {
    // ... existing fields ...
    pub indentation_style: IndentationStyle,
}

impl Config {
    pub fn from_lsp_config(value: &serde_json::Value) -> Self {
        let style = value
            .get("indentation")
            .and_then(|v| v.get("style"))
            .and_then(|v| v.as_str())
            .and_then(|s| match s {
                "rstudio" => Some(IndentationStyle::RStudio),
                "rstudio-minus" => Some(IndentationStyle::RStudioMinus),
                "off" => Some(IndentationStyle::Off),
                _ => None,
            })
            .unwrap_or(IndentationStyle::RStudio);
        
        // ... rest of config parsing ...
    }
}
```

**VS Code Settings Schema** (`editors/vscode/package.json`):
```json
{
  "configuration": {
    "properties": {
      "raven.indentation.style": {
        "type": "string",
        "enum": ["rstudio", "rstudio-minus", "off"],
        "default": "rstudio",
        "description": "Indentation style for R code. 'rstudio' aligns same-line arguments to opening paren; 'rstudio-minus' indents all arguments relative to previous line; 'off' disables AST-aware indentation (Tier 2) while keeping basic declarative rules (Tier 1) active."
      }
    }
  }
}
```

**Tier 2 Disable Behavior**: When `raven.indentation.style` is set to `"off"`, the `onTypeFormatting` handler returns `None` (no edits). This effectively disables Tier 2 while:
- Tier 1 declarative rules remain active (they are in `language-configuration.json`, independent of LSP)
- `editor.formatOnType` can remain `true` for other languages without affecting R
- The LSP capability is still registered (no restart needed to re-enable)

### Documentation

**File**: `docs/indentation.md` (to be created)

**Purpose**: User-facing documentation explaining the indentation feature, configuration options, and usage.

**Content Structure**:
1. **Overview**: Explain the two-tier approach and what each tier provides
2. **Tier 1 (Always-On)**: Describe declarative rules and what they handle
3. **Tier 2 (Opt-In)**: Explain AST-aware formatting and how to enable it
4. **Configuration**: Document the `raven.indentation.style` setting with examples
5. **Examples**: Show before/after for pipe chains, function arguments, nested structures
6. **Troubleshooting**: Common issues and solutions

**Example Content**:
```markdown
# R Smart Indentation

Raven provides intelligent indentation for R code through a two-tier system.

## Tier 1: Basic Indentation (Always Active)

Declarative rules in VS Code's language configuration provide automatic indentation for:
- Pipe operators (`|>`, `%>%`)
- Binary operators (`+`, `~`, `%infix%`)
- Opening brackets (`{`, `(`, `[`)
- Closing brackets (`}`, `)`)

These rules work immediately with no configuration required.

## Tier 2: AST-Aware Indentation (Opt-In)

For precise, context-aware indentation, enable `editor.formatOnType` in VS Code settings:

```json
{
  "editor.formatOnType": true
}
```

This enables:
- Consistent pipe chain indentation relative to chain start
- Smart argument alignment in function calls
- Correct handling of nested structures
- Style-specific formatting (RStudio vs RStudio-minus)

## Configuration

### Indentation Style

Choose between two indentation styles:

```json
{
  "raven.indentation.style": "rstudio"  // or "rstudio-minus"
}
```

**RStudio style** (default):
- Same-line arguments align to opening paren
- Next-line arguments indent from function line

**RStudio-minus style**:
- All arguments indent from previous line

[Examples and more details...]
```

## Data Models

### Position and Range

**From LSP Types** (already defined in `lsp-types` crate):
```rust
pub struct Position {
    pub line: u32,      // 0-indexed line number
    pub character: u32, // 0-indexed UTF-16 code unit offset
}

pub struct Range {
    pub start: Position,
    pub end: Position,
}
```

**Note**: LSP uses UTF-16 code units for character offsets. Tree-sitter uses byte offsets. Conversion is required when mapping between them.

### TextEdit

**From LSP Types**:
```rust
pub struct TextEdit {
    pub range: Range,     // Range to replace
    pub new_text: String, // Replacement text
}
```

### IndentContext (defined above in Context Detector section)

Enum representing the syntactic context at cursor position, with variants for each indentation scenario.

### IndentationConfig (defined above in Indentation Calculator section)

Struct containing user preferences for tab size, space/tab usage, and indentation style.

### Tree-Sitter Node Wrappers

**Purpose**: Convenience wrappers for common tree-sitter operations.

```rust
pub struct NodeExt<'a> {
    node: Node<'a>,
    source: &'a str,
}

impl<'a> NodeExt<'a> {
    pub fn text(&self) -> Option<&'a str> {
        self.node.utf8_text(self.source.as_bytes()).ok()
    }
    
    pub fn kind(&self) -> &'a str {
        self.node.kind()
    }
    
    pub fn start_position(&self) -> tree_sitter::Point {
        self.node.start_position()
    }
    
    pub fn end_position(&self) -> tree_sitter::Point {
        self.node.end_position()
    }
    
    pub fn parent(&self) -> Option<Node<'a>> {
        self.node.parent()
    }
    
    pub fn child_by_field_name(&self, name: &str) -> Option<Node<'a>> {
        self.node.child_by_field_name(name)
    }
}
```

### Chain Start Detection State

**Purpose**: Track state while walking backward through operator-terminated lines.

```rust
struct ChainWalker<'a> {
    tree: &'a Tree,
    source: &'a str,
    current_line: u32,
}

impl<'a> ChainWalker<'a> {
    pub fn find_chain_start(&mut self, start_position: Position) -> (u32, u32) {
        // Walk backward from start_position
        // Stop at first line NOT ending with continuation operator
        // Return (line, column) of that line's first non-whitespace char
    }
    
    fn line_ends_with_operator(&self, line: u32) -> bool {
        // Check if line ends with pipe, plus, tilde, or infix operator
    }
    
    fn get_line_start_column(&self, line: u32) -> u32 {
        // Return column of first non-whitespace character
    }
}
```


## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Chain Start Detection

*For any* R code snippet containing a pipe chain (consecutive lines ending with continuation operators), the chain start detection algorithm should identify the first line that is NOT preceded by a continuation operator, and return its line number and starting column.

**Validates: Requirements 3.1**

### Property 2: Pipe Chain Indentation Calculation

*For any* pipe chain with a detected chain start at column C and any tab_size value T, the computed indentation for continuation lines should equal C + T.

**Validates: Requirements 3.2**

### Property 3: Uniform Continuation Indentation

*For any* pipe chain with multiple continuation lines, all continuation lines should receive identical indentation values (straight mode).

**Validates: Requirements 3.3**

### Property 4: Same-Line Argument Alignment (RStudio Style)

*For any* function call with RStudio style configured, where the opening parenthesis is followed by content on the same line, the computed indentation for continuation arguments should equal the column immediately after the opening parenthesis (opener_col + 1).

**Validates: Requirements 4.1**

### Property 5: Next-Line Argument Indentation

*For any* function call where the opening parenthesis is followed by a newline, the computed indentation for the first argument should equal the indentation of the line containing the opening parenthesis plus tab_size.

**Validates: Requirements 4.2**

### Property 6: RStudio-Minus Style Indentation

*For any* function call with RStudio-minus style configured, the computed indentation for continuation arguments should equal the indentation of the previous line plus tab_size, regardless of whether the opening parenthesis is followed by content or a newline.

**Validates: Requirements 4.3**

### Property 7: Brace Block Indentation

*For any* code block with an opening brace `{`, the computed indentation for lines inside the block should equal the indentation of the line containing the opening brace plus tab_size.

**Validates: Requirements 4.4**

### Property 8: Closing Delimiter Alignment

*For any* closing delimiter (`)`, `]`, or `}`) that appears on its own line, the computed indentation should equal the indentation of the line containing the matching opening delimiter.

**Validates: Requirements 5.1**

### Property 9: Complete Expression De-indentation

*For any* complete expression (no trailing continuation operator, no unclosed delimiters), the computed indentation for the following line should equal the indentation of the enclosing block.

**Validates: Requirements 5.2**

### Property 10: FormattingOptions Respect

*For any* indentation computation, the system should read and apply both tab_size and insert_spaces values from the LSP FormattingOptions parameter, such that different tab_size values produce proportionally different indentation amounts.

**Validates: Requirements 6.1, 6.2**

### Property 11: Whitespace Character Generation

*For any* indentation computation, when insert_spaces is true, the generated indentation should contain only space characters; when insert_spaces is false, the generated indentation should contain tab characters (with possible trailing spaces for alignment).

**Validates: Requirements 6.3, 6.4**

### Property 12: TextEdit Range Replacement

*For any* line with existing leading whitespace of length W, the generated TextEdit should have a range spanning from (line, 0) to (line, W), ensuring complete replacement of existing indentation.

**Validates: Requirements 6.5**

### Property 13: Style Configuration Behavior

*For any* function call, when raven.indentation.style is set to "rstudio", same-line arguments should align to the opening paren (opener_col + 1) and next-line arguments should indent from the function line; when set to "rstudio-minus", all arguments should indent from the previous line.

**Validates: Requirements 7.2, 7.3**

### Property 14: TextEdit Response Structure

*For any* onTypeFormatting request, the handler should return a result containing a Vec<TextEdit>, where each TextEdit specifies a range and new_text for indentation replacement.

**Validates: Requirements 8.4**

### Property 15: AST Node Detection

*For any* R code containing continuation operators (`|>`, `%>%`, `+`, `~`, `%word%`), function calls, or brace blocks, the context detector should correctly identify the corresponding tree-sitter nodes (pipe_operator, special_operator, binary_operator, call/arguments, brace_list).

**Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5**

### Property 16: Nested Context Priority

*For any* R code with multiple levels of nesting (e.g., pipe chain inside function call inside another pipe chain), the context detector should identify the innermost syntactically relevant context for the cursor position, such that indentation decisions are based on the most specific applicable rule.

**Validates: Requirements 3.4, 10.1, 10.2, 10.3**

## Error Handling

### Invalid AST States

**Scenario**: Tree-sitter parse errors or incomplete AST due to syntax errors in user code.

**Handling**:
- Context detector should gracefully handle missing or error nodes
- Fall back to simpler heuristics (e.g., check previous line text for operators)
- Never panic or crash the LSP server
- Log warnings for debugging but don't surface errors to user

**Implementation**:
```rust
pub fn detect_context(tree: &Tree, source: &str, position: Position) -> IndentContext {
    let node = tree.root_node().descendant_for_point_range(
        point_from_position(position),
        point_from_position(position),
    );
    
    match node {
        Some(n) if !n.is_error() => {
            // Normal AST-based detection
        }
        _ => {
            // Fallback: regex-based detection on previous line
            fallback_detect_context(source, position)
        }
    }
}
```

### UTF-16 to Byte Offset Conversion Errors

**Scenario**: LSP Position uses UTF-16 code units, tree-sitter uses byte offsets. Conversion can fail with invalid UTF-16 or out-of-bounds positions.

**Handling**:
- Validate position is within document bounds before conversion
- Handle multi-byte Unicode characters correctly
- Return None/Error for invalid positions rather than panicking
- Use existing Raven utilities for position conversion

**Implementation**:
```rust
fn point_from_position(position: Position, source: &str) -> tree_sitter::Point {
    let row = position.line as usize;
    let byte_column = source.lines()
        .nth(row)
        .map(|line| utf16_offset_to_byte_offset(line, position.character as usize))
        .unwrap_or(0);
    // See existing utf16_column_to_byte_offset in completion_context.rs / handlers.rs
    tree_sitter::Point {
        row,
        column: byte_column,
    }
}
```

### Configuration Parsing Errors

**Scenario**: Invalid or missing configuration values for indentation.style.

**Handling**:
- Default to RStudio style if config is invalid or missing
- Log warning about invalid config value
- Never fail the formatting request due to config errors

**Implementation**:
```rust
let style = config
    .get("indentation")
    .and_then(|v| v.get("style"))
    .and_then(|v| v.as_str())
    .and_then(|s| match s {
        "rstudio" => Some(IndentationStyle::RStudio),
        "rstudio-minus" => Some(IndentationStyle::RStudioMinus),
        _ => {
            log::warn!("Invalid indentation.style: {}, defaulting to rstudio", s);
            None
        }
    })
    .unwrap_or(IndentationStyle::RStudio);
```

### Chain Start Detection Infinite Loop

**Scenario**: Malformed AST or edge case causes chain start walker to loop indefinitely.

**Handling**:
- Implement maximum iteration limit (e.g., 1000 lines)
- Break loop if we reach start of document
- Return current position as chain start if limit exceeded

**Implementation**:
```rust
impl<'a> ChainWalker<'a> {
    pub fn find_chain_start(&mut self, start_position: Position) -> (u32, u32) {
        let mut current_line = start_position.line;
        let max_iterations = 1000;
        let mut iterations = 0;
        
        while current_line > 0 && iterations < max_iterations {
            if !self.line_ends_with_operator(current_line - 1) {
                break;
            }
            current_line -= 1;
            iterations += 1;
        }
        
        if iterations >= max_iterations {
            log::warn!("Chain start detection exceeded max iterations");
        }
        
        (current_line, self.get_line_start_column(current_line))
    }
}
```

### Missing or Unmatched Delimiters

**Scenario**: User is actively typing, so code may have unclosed parens/braces or mismatched delimiters.

**Handling**:
- Context detector should handle unclosed delimiters gracefully
- If matching opener not found, use heuristic (e.g., indent from previous line)
- Don't assume delimiters are balanced

**Implementation**:
```rust
fn find_matching_opener(node: Node, delimiter: char) -> Option<Node> {
    // Walk up AST to find matching opener
    // Return None if not found (unclosed delimiter)
}

// In context detector:
match find_matching_opener(node, ')') {
    Some(opener) => {
        // Use opener position for alignment
    }
    None => {
        // Fallback: indent from previous line
        IndentContext::AfterCompleteExpression {
            enclosing_block_indent: get_previous_line_indent(source, position.line),
        }
    }
}
```

## Testing Strategy

### Dual Testing Approach

This feature requires both unit tests and property-based tests for comprehensive coverage:

**Unit Tests**: Verify specific examples, edge cases, and error conditions
- Specific R code snippets with known correct indentation
- Edge cases: empty lines, comments, mixed operators
- Error conditions: invalid AST, malformed config, out-of-bounds positions
- Integration points: LSP request/response handling, config parsing

**Property Tests**: Verify universal properties across all inputs
- Generate random R code with pipes, function calls, and nesting
- Verify properties hold for all generated inputs
- Use property-based testing library (e.g., `proptest` for Rust)
- Minimum 100 iterations per property test

### Property-Based Testing Configuration

**Library**: Use `proptest` crate for Rust property-based testing

**Test Structure**:
```rust
use proptest::prelude::*;

proptest! {
    #[test]
    fn property_chain_start_detection(
        chain_length in 1..10usize,
        tab_size in 1..8u32,
    ) {
        // Feature: r-smart-indentation, Property 1: Chain start detection
        
        // Generate R code with pipe chain of specified length
        let code = generate_pipe_chain(chain_length);
        
        // Parse with tree-sitter
        let tree = parse_r_code(&code);
        
        // Detect chain start
        let (start_line, start_col) = find_chain_start(&tree, &code, end_position);
        
        // Verify: chain start should be line 0 (first line of chain)
        prop_assert_eq!(start_line, 0);
        
        // Verify: chain start column should be first non-whitespace
        prop_assert_eq!(start_col, get_first_non_ws_col(&code, 0));
    }
}
```

**Test Configuration**:
- Minimum 100 iterations per test (configured via `ProptestConfig`)
- Each test tagged with comment: `// Feature: r-smart-indentation, Property N: <description>`
- Tests organized by component: context detection, indentation calculation, formatting

### Unit Test Coverage

**Context Detector Tests** (`tests/indentation/context_tests.rs`):
- Test each IndentContext variant with specific examples
- Test nested contexts (pipe in function, function in pipe)
- Test edge cases (empty lines, comments, EOF)
- Test error handling (invalid AST, missing nodes)

**Indentation Calculator Tests** (`tests/indentation/calculator_tests.rs`):
- Test each context type with various tab_size values
- Test both RStudio and RStudio-minus styles
- Test edge cases (column 0, very large indentation)
- Test configuration defaults

**Style Formatter Tests** (`tests/indentation/formatter_tests.rs`):
- Test space generation (insert_spaces=true)
- Test tab generation (insert_spaces=false)
- Test mixed tabs+spaces for alignment
- Test TextEdit range calculation
- Test existing whitespace replacement

**Integration Tests** (`tests/indentation/integration_tests.rs`):
- Test full onTypeFormatting request/response cycle
- Test with real R code examples from tidyverse style guide
- Test configuration loading and application
- Test LSP capability registration

### Example Unit Tests

**Chain Start Detection**:
```rust
#[test]
fn test_chain_start_simple_pipe() {
    let code = r#"
result <- data %>%
  filter(x > 0) %>%
  select(y)
"#;
    
    let tree = parse_r_code(code);
    let position = Position { line: 2, character: 0 }; // On "select" line
    
    let (start_line, start_col) = find_chain_start(&tree, code, position);
    
    assert_eq!(start_line, 1); // "result <- data %>%" line
    assert_eq!(start_col, 0);  // Start of "result"
}
```

**RStudio Style Alignment**:
```rust
#[test]
fn test_rstudio_style_same_line_args() {
    let code = "func(arg1,";
    let tree = parse_r_code(code);
    let position = Position { line: 0, character: 10 }; // After comma
    
    let config = IndentationConfig {
        tab_size: 2,
        insert_spaces: true,
        style: IndentationStyle::RStudio,
    };
    
    let context = detect_context(&tree, code, position);
    let indent = calculate_indentation(context, config, code);
    
    // Should align to column after opening paren: "func(" = 5 chars, so column 5
    assert_eq!(indent, 5);
}
```

**TextEdit Range Replacement**:
```rust
#[test]
fn test_textedit_replaces_existing_whitespace() {
    let code = "    existing_indent";
    let line = 0;
    let target_column = 2;
    
    let config = IndentationConfig {
        tab_size: 2,
        insert_spaces: true,
        style: IndentationStyle::RStudio,
    };
    
    let edit = format_indentation(line, target_column, config, code);
    
    // Range should span from column 0 to 4 (length of existing whitespace)
    assert_eq!(edit.range.start.character, 0);
    assert_eq!(edit.range.end.character, 4);
    
    // New text should be 2 spaces
    assert_eq!(edit.new_text, "  ");
}
```

### Test Data Generators

For property-based tests, implement generators for R code structures:

```rust
fn generate_pipe_chain(length: usize) -> String {
    let mut code = String::from("data");
    for i in 0..length {
        code.push_str(" %>%\n  ");
        code.push_str(&format!("step{}", i));
    }
    code
}

fn generate_function_call(arg_count: usize, newline_after_paren: bool) -> String {
    let mut code = String::from("func(");
    if newline_after_paren {
        code.push('\n');
    }
    for i in 0..arg_count {
        if i > 0 {
            code.push_str(",\n");
        }
        code.push_str(&format!("arg{}", i));
    }
    code.push(')');
    code
}

fn generate_nested_structure(depth: usize) -> String {
    // Generate nested pipes and function calls
    // Used for testing Property 16 (nested context priority)
}
```

### Manual Testing Checklist

Before release, manually verify in VS Code:

1. **Basic pipe indentation**: Type a pipe chain, verify continuation lines indent correctly
2. **Function argument alignment**: Type function call with args, verify alignment
3. **Nested structures**: Type pipe inside function inside pipe, verify correct indentation
4. **Configuration changes**: Change tab_size and indentation.style, verify behavior updates
5. **formatOnType toggle**: Disable formatOnType, verify Tier 1 still works; enable, verify Tier 2 activates
6. **Real-world code**: Test with actual tidyverse code examples
7. **Performance**: Test with large files (1000+ lines) to ensure no lag

### Continuous Integration

Add to CI pipeline:
- Run all unit tests on every commit
- Run property tests with 100 iterations
- Check code coverage (aim for >80% on new code)
- Run integration tests against VS Code LSP client
