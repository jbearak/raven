# Requirements Document

## Introduction

This feature adds function parameter completions to Raven (an R language server). When the cursor is inside a function call, the LSP will suggest parameter names for that function alongside standard completions (variables, functions, keywords). This enables developers to quickly discover and use function parameters without consulting documentation.

## Glossary

- **Completion_Handler**: The LSP component that processes completion requests and returns completion items
- **Parameter_Resolver**: The component that extracts and caches function parameter information
- **Function_Signature**: The parameter list of a function including parameter names and default values
- **R_Subprocess**: The interface for querying R about package information and function signatures
- **Package_Library**: The cache of installed R packages and their exports
- **Cross_File_Scope**: The scope resolution system that tracks symbols across sourced files
- **Tree_Sitter**: The incremental parsing library used to analyze R code structure
- **Completion_Resolve**: The LSP `completionItem/resolve` handler that lazily loads documentation for a selected completion item

## Requirements

### Requirement 1: Function Call Context Detection

**User Story:** As a developer, I want the LSP to detect when my cursor is inside a function call, so that I can receive relevant parameter suggestions alongside standard completions.

#### Acceptance Criteria

1. WHEN the cursor is positioned after `(` and before `)` in a function call, THE Completion_Handler SHALL detect the function call context
2. WHEN the cursor is positioned after a comma within function arguments, THE Completion_Handler SHALL detect the function call context
3. WHEN the cursor is positioned inside nested function calls, THE Completion_Handler SHALL detect the innermost function call context
4. WHEN the cursor is positioned outside any function call parentheses, THE Completion_Handler SHALL NOT provide parameter completions
5. WHEN the cursor is positioned inside a string literal within function arguments, THE Completion_Handler SHALL NOT provide parameter completions
6. WHEN the argument list spans multiple lines or contains incomplete syntax (e.g., unbalanced parentheses during typing), THE Completion_Handler SHALL still detect function call context using a fallback heuristic that finds the nearest unmatched `(`, matching the robustness of the official R language server. The bracket scanner SHALL have the following properties:
   - **Line-by-line forward scan**: it MUST process lines from the cursor line backward, and within each line scan **forward** from position 0 (up to the cursor column on the cursor line, or to the end on prior lines). The FSM state is re-initialized at each new line. This forward-within-backward approach matches the R-LS C implementation (`search.c`) and is necessary for correct FSM state tracking (raw strings, escape sequences, and comments can only be detected reliably by forward scanning). The R-LS FSM does NOT carry quote state across line boundaries — if a previous line ends with an unmatched quote (indicating a multi-line string), the scanner MUST stop searching further backward (bail out) rather than continuing with corrupted state.
   - **String-aware**: it MUST track string boundaries (single-quoted, double-quoted, backtick-quoted, and R 4.0+ raw strings like `r"(...)"` / `R"(...)"`) so that brackets inside string literals are ignored (e.g., `f("(", |)` must detect `f` as the enclosing call, not be confused by the `(` inside the string)
   - **Comment-aware**: it MUST ignore brackets inside R comments (`# ...`). When the forward scanner encounters `#` outside any string literal, it MUST stop scanning the remainder of that line (from `#` to end-of-line), since everything after `#` is comment text. This prevents brackets inside comments from affecting nesting, e.g., `f(x, # adjust ( balance\n  |)` must detect `f`.
   - **Multi-bracket nesting**: it MUST track opening and closing brackets — `()`, `[]`, `{}` — using a stack, though it need NOT match bracket types (the R-LS implementation treats any closing bracket as matching any opening bracket, which is sufficient for syntactically valid R code). Only an unmatched `(` triggers parameter completions. This prevents incorrect matches in cases like `df[func(x, |)]` where the `[` must be tracked to avoid matching the outer `[` as an unmatched `(`.
7. WHEN the document is R Markdown (or another embedded-R format), THE Completion_Handler SHALL only provide parameter completions inside R code blocks, not in markdown/text regions

### Requirement 2: Base R Function Parameter Completions

**User Story:** As a developer, I want to see parameter suggestions for base R functions, so that I can quickly write correct function calls without consulting documentation.

#### Acceptance Criteria

1. WHEN the cursor is inside a base R function call, THE Parameter_Resolver SHALL query R subprocess using `formals()` to get parameter names; IF `formals()` returns `NULL` (e.g., for primitive/special functions), THEN it SHALL fall back to `args()`/`formals(args(fn))` to obtain parameters
2. WHEN R subprocess returns parameter information, THE Completion_Handler SHALL display parameter names as completion items
3. WHEN a parameter has a default value, THE Completion_Handler MAY include the default value in the completion detail (optional enhancement; the official R language server does not surface defaults in the completion list)
4. IF R subprocess is unavailable, THEN THE Parameter_Resolver SHALL return an empty parameter list gracefully
5. THE Parameter_Resolver SHALL cache function signatures to avoid repeated R subprocess queries
6. WHEN the function is `options()` (in package `base`), THE Completion_Handler SHALL include `names(.Options)` (global option names) in the completion list, matching the behavior of the official R language server

### Requirement 3: Package Function Parameter Completions

**User Story:** As a developer, I want to see parameter suggestions for functions from loaded packages, so that I can use package functions efficiently.

#### Acceptance Criteria

1. WHEN the cursor is inside a call to a function from a loaded package, THE Parameter_Resolver SHALL resolve the function's package and query its parameters
2. WHEN using namespace-qualified calls (e.g., `dplyr::filter(` or `stats:::filter(`), THE Parameter_Resolver SHALL query parameters for the specified package's function directly
3. WHEN using the triple-colon operator (`:::`), THE Parameter_Resolver SHALL attempt to query formals for internal/non-exported functions
4. WHEN multiple packages export the same function name, THE Parameter_Resolver SHALL use the scope resolver to determine which package's function is in scope at the cursor position (based on which `library()` calls precede the cursor in the current file and its sourced dependencies)
5. THE Parameter_Resolver SHALL cache package function signatures per package to minimize R subprocess queries
6. IF `formals()` returns `NULL` for a package function (e.g., primitives), THE Parameter_Resolver SHALL fall back to `args()`/`formals(args(fn))` to obtain parameters (matching official R language server behavior)

### Requirement 4: User-Defined Function Parameter Completions

**User Story:** As a developer, I want to see parameter suggestions for functions I've defined in my project, so that I can use my own functions consistently.

#### Acceptance Criteria

1. WHEN the cursor is inside a call to a user-defined function in the current file, THE Parameter_Resolver SHALL extract parameters from the function definition AST
2. WHEN the cursor is inside a call to a function defined in a sourced file, THE Parameter_Resolver SHALL use cross-file scope to locate and extract parameters
3. WHEN a user-defined function has parameters with default values, THE Completion_Handler MAY include the default value in the completion detail (optional enhancement)
4. WHEN multiple user-defined functions with the same name exist in different scopes, THE Parameter_Resolver SHALL prefer the nearest definition in the innermost enclosing scope that appears before the cursor position
5. WHEN the current document is untitled/unsaved (no filesystem path), parameter completions for user-defined functions SHALL still work using in-memory content

### Requirement 5: Parameter Completion Formatting

**User Story:** As a developer, I want parameter completions to be clearly formatted and sorted above other completions, so that I can distinguish them and access them quickly.

#### Acceptance Criteria

1. THE Completion_Handler SHALL display parameter completions with `CompletionItemKind::VARIABLE` (matching the official R language server)
2. THE Completion_Handler SHALL set the detail field to a clear parameter marker (e.g., `parameter`); if default values are available, it MAY append `= <default>` (optional enhancement)
3. WHEN inserting a parameter completion, THE Completion_Handler SHALL append an equals sign followed by a space (`= `) after the parameter name, EXCEPT for the `...` parameter which SHALL be inserted as-is without ` = ` (since `... = value` is not valid R syntax). Note: this intentionally improves on the official R language server, which unconditionally appends ` = ` to all parameters including `...`
4. THE Completion_Handler SHALL filter parameter completions using case-insensitive substring matching (consistent with the official R language server), not strict prefix-only matching
5. WHEN a function signature includes `...`, THE Completion_Handler SHALL include `...` in the parameter completion list (matching the official R language server)
6. THE Completion_Handler SHALL assign parameter completions a sort prefix of `0-{index}` (e.g., `0-001`, `0-002`) corresponding to their definition order, ensuring they appear before all other completion types AND preserve their original order in the function signature
7. THE Completion_Handler SHALL set `insertTextFormat` to `InsertTextFormat::PLAIN_TEXT` on parameter completion items (matching the official R language server) to prevent clients from interpreting the insert text as a snippet template

### Requirement 6: Mixed Completions in Function Call Context

**User Story:** As a developer, I want parameter completions to appear alongside standard completions when inside a function call, so that I can access both parameter names and variable names needed as argument values.

#### Acceptance Criteria

1. WHEN in function call context, THE Completion_Handler SHALL add parameter completions to the standard completion list rather than replacing it
2. WHEN in function call context, THE Completion_Handler SHALL include standard completions (local variables, package exports, cross-file symbols, keywords) alongside parameter completions
3. THE Completion_Handler SHALL maintain existing completion behavior when not in function call context
4. THE Completion_Handler SHALL sort parameter completions (`"0-"`) before all other completion types, and maintain the existing sort precedence for non-parameter items: local definitions (`"1-"`) before package exports (`"4-"`) before keywords (`"5-"`)
5. WHEN the current token being completed is namespace-qualified (e.g., `stats::` or `stats::o` inside a function call), THE Completion_Handler SHALL NOT add parameter completions, matching the official R language server's behavior. Specifically, token detection (checking for `::` or `:::` accessor) SHALL occur BEFORE function call detection: if a namespace accessor is detected at the cursor, the call detection step is skipped entirely
6. WHEN the cursor is inside a `library()` or `require()` call, THE Completion_Handler SHALL provide parameter completions alongside installed package name completions, matching the official R language server's behavior. R-LS does NOT suppress parameter completions for these functions — it shows both parameter names (from `arg_completion`) and installed package names (from `package_completion`, which runs for all tokens regardless of enclosing call). The same applies to any future special-case completion handlers: parameter completions are additive, not exclusive

### Requirement 7: Parameter Documentation on Resolve

**User Story:** As a developer, I want to see documentation for a parameter when I select it in the completion list, so that I understand what each parameter does.

#### Acceptance Criteria

1. WHEN a parameter completion item is selected, THE Completion_Resolve handler SHALL return documentation for that parameter
2. WHEN the function is from a package, THE Completion_Resolve handler SHALL extract the argument description from the Rd `\\arguments` section (or an equivalent structured help representation), not from literal `@param` tags
3. WHEN the function is user-defined with roxygen comments above the definition, THE Completion_Resolve handler SHALL extract the `@param` description using roxygen2-style parsing (supporting multi-line continuations) from the contiguous comment block immediately preceding the definition; if no roxygen tags are present, it MAY fall back to plain comment text
4. IF parameter documentation is unavailable, THEN THE Completion_Resolve handler SHALL return the completion item without documentation
5. THE Completion_Resolve handler SHALL clear the `data` field from the completion item before returning the response (matching the official R language server, which sets `params$data <- NULL` after resolve to avoid leaking internal resolve metadata back to the client)

### Requirement 8: Roxygen Documentation for User-Defined Function Completions

**User Story:** As a developer, I want to see the roxygen description when I select a user-defined function in the completion list, so that I understand what the function does without navigating to its definition.

#### Acceptance Criteria

1. WHEN a user-defined function completion item is resolved via `completionItem/resolve`, THE Completion_Resolve handler SHALL scan the contiguous comment block immediately above the function definition (roxygen `#'` lines preferred, plain `#` comments as fallback)
2. WHEN roxygen comments contain a title line (the first non-tag `#'` line), THE Completion_Resolve handler SHALL include it as the function's documentation
3. WHEN roxygen comments contain a `@description` tag or description paragraph, THE Completion_Resolve handler SHALL include it in the documentation
4. IF no roxygen comments are found above the function definition, THEN THE Completion_Resolve handler MAY fall back to plain comment text; if no comments exist, return the completion item without documentation
5. THE roxygen extraction logic SHALL be shared between parameter documentation (Requirement 7) and function documentation (this requirement) to avoid duplication

### Requirement 9: Signature Cache Management

**User Story:** As a developer, I want function signatures to be cached efficiently, so that completions are fast and responsive.

#### Acceptance Criteria

1. THE Parameter_Resolver SHALL store cached signatures in a thread-safe data structure
2. THE Parameter_Resolver SHALL invalidate user-defined function signatures when the defining file changes
3. ~~THE Parameter_Resolver SHALL persist package function signatures across LSP sessions where possible~~ **(Deferred)**: Cross-session persistence adds significant complexity (disk serialization, versioning, cache invalidation across R upgrades). The in-memory LRU cache provides sufficient performance since package `formals()` queries are fast (~100-300ms) and cached for the session duration. May revisit if profiling shows repeated cold-start latency is a problem.
4. WHEN cache memory exceeds a configurable threshold, THE Parameter_Resolver SHALL evict least-recently-used entries

### Requirement 10: R Subprocess Query Interface

**User Story:** As a developer, I want the LSP to query R for function information, so that completions are accurate for the installed R version.

#### Acceptance Criteria

1. THE R_Subprocess SHALL provide a method to query function parameters using `formals(func)`
2. THE R_Subprocess SHALL validate function names to prevent code injection
3. IF a query times out or fails, THEN THE R_Subprocess SHALL return an error without crashing the LSP
4. THE R_Subprocess SHALL support querying parameters for functions in specific packages using `formals(pkg::func)`
5. IF `formals()` returns `NULL` for a function (e.g., primitives), THE R_Subprocess SHALL fall back to `args()`/`formals(args(fn))` to obtain parameters

### Requirement 11: Error Handling and Graceful Degradation

**User Story:** As a developer, I want the LSP to handle errors gracefully, so that completions work even when some information is unavailable.

#### Acceptance Criteria

1. IF R subprocess is unavailable, THEN THE Completion_Handler SHALL fall back to AST-based parameter extraction where possible
2. IF function signature cannot be determined, THEN THE Completion_Handler SHALL return standard completions without parameter suggestions
3. THE Completion_Handler SHALL log errors at trace level without displaying error messages to the user (except R subprocess timeouts, which SHALL be logged at warn level for operator visibility)

## Out of Scope

The following are explicitly excluded from this spec:

1. **Pipe operator argument exclusion**: R's pipe operators (`|>` and `%>%`) implicitly supply the first argument. This spec does not detect or exclude the piped-in parameter from completions. The official R language server does not handle this either.

2. **Anonymous and lambda function calls**: Parameter completions are not provided for calls to anonymous functions (`(function(x, y) x + y)(1, )`) or R 4.1+ lambda syntax (`(\(x, y) x + y)(1, )`). Only identifier and namespace-qualified callees are supported.

3. **Dollar-sign completions**: `list$` and `dataframe$` member completions are deferred to a separate follow-up spec.

4. **Filtering out already-specified named arguments**: The official R language server does not exclude previously used parameter names, so this behavior is not required for parity. It may be added later as an enhancement if desired.

5. **Workspace-but-not-sourced function resolution**: The official R language server resolves function parameters in two tiers: (a) search the current file's XML parse data using `xdoc_find_enclosing_scopes` to find local function definitions within enclosing scopes, taking the last (most recent) match; (b) if not found locally, call `guess_namespace()` which searches ALL open documents (via its `GlobalEnv` class that loops through `documents.values()`) before searching loaded packages in reverse order (most recently loaded first), then imported objects from NAMESPACE. Raven's resolution searches the current file, then cross-file scope (sourced files only), then packages. Functions defined in open-but-not-sourced files are discoverable via workspace symbol search but not via parameter resolution. This difference is intentional — Raven's cross-file model is source-chain-based, and broadening resolution to all open documents would introduce non-deterministic behavior (results depend on which files happen to be open). May revisit if users report missing completions for workspace-visible functions.

6. **Completion count limiting**: The official R language server truncates completion lists to `max_completions` (default: 200), with priority given to items whose labels start with the typed token, and sets `isIncomplete = true` on the response when truncating (signaling the client to re-request on further typing). This spec does not require a hard completion count limit or `isIncomplete` flag; VS Code clients already handle large completion lists efficiently. May revisit if performance profiling shows a need.

7. **`textDocument/signatureHelp`**: The official R language server provides a separate `textDocument/signatureHelp` handler that shows the full function signature with documentation as the user types arguments. This is a distinct LSP feature from completions and is out of scope for this spec. However, the infrastructure built here (parameter resolver, signature cache, roxygen extraction) is designed to be reusable by a future signature help implementation.

8. **`getOption()` parameter completions**: The official R language server gives special treatment only to `options()` (merging `names(.Options)` into its parameter list), not to `getOption()`. This spec matches that behavior. Adding option name completions for `getOption()` (which takes a single option name as its first argument) would be a natural enhancement but is deferred since R-LS does not implement it.

9. **S4 slot access (`@`) completions**: The official R language server does not provide completions for S4 slot access via `@`. This spec does not add it. Deferred to a separate follow-up alongside dollar-sign completions.

10. **NAMESPACE-imported object sort prefix**: The official R language server uses a `"3-"` sort prefix for objects explicitly imported via `importFrom()` in a package's NAMESPACE file, sitting between workspace symbols (`"2-"`) and global package exports (`"4-"`). Raven reserves `"3-"` but does not currently use it. This may be revisited when Raven adds package development support.

11. **`labelDetails` support for function completions**: The official R language server supports `labelDetailsSupport` (LSP 3.17+) for function completions — when the client advertises this capability, R-LS appends the function signature (minus the function name) to the completion item's `labelDetails.detail` field on resolve. This is a visual enhancement for function name completions (not parameter completions) and is deferred to a separate enhancement.

12. **Token completion deduplication**: The official R language server's `token_completion()` (which adds text tokens found in the document, sorted with `"5-"` prefix) excludes labels that already appear in the completion list to avoid duplicate entries. Raven should consider similar deduplication but this is not specific to parameter completions and is deferred.

13. **S3/S4 method parameter resolution**: The official R language server does not resolve parameters for S3 or S4 method dispatch — it uses the literal function name from `detect_call()`. For example, `print(x, |)` shows the generic `print()`'s parameters, not the method for `x`'s class. This spec matches that behavior.
