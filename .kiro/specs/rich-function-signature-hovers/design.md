# Design Document: Rich Function Signature Help

## Overview

This design enhances Raven's signature help functionality to display rich function signatures with documentation when typing function calls. Currently, when typing `function_name(`, the signature help shows minimal information: just "function_name(...)". The implementation leverages existing infrastructure (HelpCache, Roxygen_Parser, Parameter_Resolver) and enhances the signature_help() function in handlers.rs to provide rich parameter information.

The key insight is that all necessary data is already available through existing systems - we just need to format it better and populate the LSP SignatureHelp structure properly. Package functions use R help text (already cached), user functions use AST + roxygen comments (already parsed). The enhancement focuses on presentation and proper LSP structure, not data gathering.

## Architecture

### Component Interaction

```
┌─────────────────────────────────────────────────────────────┐
│                  signature_help() function                   │
│                     (handlers.rs)                            │
└───────────┬─────────────────────────────────────────────────┘
            │
            ├──> HelpCache (help.rs)
            │    └──> extract_signature_from_help()
            │    └──> extract_description_from_help()
            │    └──> get_arguments()
            │
            ├──> Roxygen_Parser (roxygen.rs)
            │    └──> extract_roxygen_block()
            │    └──> get_function_doc()
            │    └──> get_param_doc()
            │
            ├──> Parameter_Resolver (parameter_resolver.rs)
            │    └──> resolve()
            │    └──> extract_from_ast()
            │
            └──> New: build_signature_information()
                 New: build_parameter_information()
                 New: detect_active_parameter()
```

### Data Flow

1. **Package Functions**:
   - signature_help() detects function call being typed
   - Uses Parameter_Resolver to identify function and get signature
   - Fetches help text from HelpCache (already cached)
   - Calls extract_signature_from_help() to get signature
   - Calls extract_description_from_help() to get description
   - Calls get_arguments() to get parameter documentation
   - Builds SignatureInformation with parameters
   - Returns SignatureHelp with active parameter highlighted

2. **User Functions**:
   - signature_help() detects function call being typed
   - Uses Parameter_Resolver to find function definition
   - Extracts parameters using Parameter_Resolver
   - Formats signature using build_signature_information()
   - Extracts documentation using Roxygen_Parser
   - Extracts parameter docs using get_param_doc()
   - Builds SignatureInformation with parameters
   - Returns SignatureHelp with active parameter highlighted

## Components and Interfaces

### New Helper Functions (handlers.rs)

#### build_signature_information

```rust
/// Build LSP SignatureInformation from function signature data.
///
/// Creates a SignatureInformation structure with:
/// - Label: formatted signature string
/// - Documentation: optional description as markdown
/// - Parameters: vector of ParameterInformation for each parameter
///
/// # Arguments
/// * `name` - Function name
/// * `params` - Vector of ParameterInfo from Parameter_Resolver
/// * `description` - Optional description text
/// * `param_docs` - Optional HashMap of parameter name -> documentation
///
/// # Returns
/// SignatureInformation for LSP response
async fn build_signature_information(
    name: &str,
    params: &[ParameterInfo],
    description: Option<String>,
    param_docs: Option<HashMap<String, String>>
) -> SignatureInformation
```

#### build_parameter_information

```rust
/// Build LSP ParameterInformation for a single parameter.
///
/// Creates a ParameterInformation structure with:
/// - Label: parameter name (or "name = default" if default present)
/// - Documentation: optional parameter documentation as markdown
///
/// # Arguments
/// * `param` - ParameterInfo from Parameter_Resolver
/// * `param_doc` - Optional documentation string for this parameter
///
/// # Returns
/// ParameterInformation for LSP response
fn build_parameter_information(
    param: &ParameterInfo,
    param_doc: Option<&str>
) -> ParameterInformation
```

#### detect_active_parameter

```rust
/// Detect which parameter is currently being typed.
///
/// Counts commas before the cursor position within the current call
/// to determine the active parameter index.
///
/// # Arguments
/// * `call_node` - The tree-sitter call node
/// * `cursor_point` - Current cursor position
/// * `text` - Source text
///
/// # Returns
/// Index of the active parameter (0-based), or None if cannot determine
fn detect_active_parameter(
    call_node: Node,
    cursor_point: Point,
    text: &str
) -> Option<u32>
```

#### try_build_package_signature

```rust
/// Attempt to build rich signature help for a package function.
///
/// Fetches help text from cache, extracts signature and description,
/// gets parameter documentation, and builds SignatureInformation.
///
/// # Arguments
/// * `help_cache` - Reference to HelpCache
/// * `function_name` - Name of the function
/// * `package_name` - Name of the package
///
/// # Returns
/// Some(SignatureInformation) if successful, None if help unavailable
async fn try_build_package_signature(
    help_cache: &HelpCache,
    function_name: &str,
    package_name: &str
) -> Option<SignatureInformation>
```

#### try_build_user_signature

```rust
/// Attempt to build rich signature help for a user-defined function.
///
/// Extracts parameters from AST, gets roxygen documentation,
/// and builds SignatureInformation.
///
/// # Arguments
/// * `state` - WorldState reference
/// * `function_name` - Name of the function
/// * `uri` - URI of the file containing the call
/// * `position` - Position of the call
///
/// # Returns
/// Some(SignatureInformation) if successful, None if extraction fails
fn try_build_user_signature(
    state: &WorldState,
    function_name: &str,
    uri: &Url,
    position: Position
) -> Option<SignatureInformation>
```

### Modified Functions

#### signature_help() (handlers.rs)

The main signature_help() function will be completely rewritten to:
1. Detect the enclosing function call (existing logic)
2. Extract the function name (existing logic)
3. Determine if it's a package or user function
4. For package functions: call try_build_package_signature()
5. For user functions: call try_build_user_signature()
6. Detect the active parameter using detect_active_parameter()
7. Build and return SignatureHelp with rich information
8. Fall back to minimal signature if rich building fails

Current implementation (minimal):
```rust
pub fn signature_help(state: &WorldState, uri: &Url, position: Position) -> Option<SignatureHelp> {
    // ... find call node ...
    Some(SignatureHelp {
        signatures: vec![SignatureInformation {
            label: format!("{}(...)", func_name),
            documentation: None,
            parameters: None,
            active_parameter: None,
        }],
        active_signature: Some(0),
        active_parameter: None,
    })
}
```

New implementation (rich):
```rust
pub async fn signature_help(state: &WorldState, uri: &Url, position: Position) -> Option<SignatureHelp> {
    // ... find call node ...
    
    // Try to build rich signature
    let signature_info = if let Some(pkg) = determine_package(state, func_name, uri, position) {
        try_build_package_signature(&state.help_cache, func_name, &pkg).await
    } else {
        try_build_user_signature(state, func_name, uri, position)
    };
    
    // Detect active parameter
    let active_param = detect_active_parameter(call_node, cursor_point, text);
    
    // Build SignatureHelp
    let signature_info = signature_info.unwrap_or_else(|| {
        // Fallback to minimal signature
        SignatureInformation {
            label: format!("{}(...)", func_name),
            documentation: None,
            parameters: None,
            active_parameter: None,
        }
    });
    
    Some(SignatureHelp {
        signatures: vec![signature_info],
        active_signature: Some(0),
        active_parameter: active_param,
    })
}
```

### Existing Functions Used

From help.rs:
- `extract_signature_from_help(help_text: &str) -> Option<String>` - Already exists
- `extract_description_from_help(help_text: &str) -> Option<String>` - Already exists
- `HelpCache::get_or_fetch(topic: &str, package: Option<&str>) -> Option<String>` - Already exists
- `HelpCache::get_arguments(topic: &str, package: Option<&str>) -> Option<HashMap<String, String>>` - Already exists

From roxygen.rs:
- `extract_roxygen_block(text: &str, func_line: u32) -> Option<RoxygenBlock>` - Already exists
- `get_function_doc(block: &RoxygenBlock) -> Option<String>` - Already exists
- `get_param_doc(block: &RoxygenBlock, param_name: &str) -> Option<String>` - Already exists

From parameter_resolver.rs:
- `resolve(state, cache, function_name, namespace, is_internal, uri, position) -> Option<FunctionSignature>` - Already exists
- `extract_from_ast(params_node: Node, text: &str) -> Vec<ParameterInfo>` - Already exists

## Data Models

### ParameterInfo (existing in parameter_resolver.rs)

```rust
pub struct ParameterInfo {
    pub name: String,
    pub default_value: Option<String>,
    pub is_dots: bool,
}
```

### RoxygenBlock (existing in roxygen.rs)

```rust
pub struct RoxygenBlock {
    pub title: Option<String>,
    pub description: Option<String>,
    pub params: HashMap<String, String>,
    pub fallback: Option<String>,
}
```

### SignatureInformation (LSP type from tower_lsp)

```rust
pub struct SignatureInformation {
    pub label: String,
    pub documentation: Option<Documentation>,
    pub parameters: Option<Vec<ParameterInformation>>,
    pub active_parameter: Option<u32>,
}
```

### ParameterInformation (LSP type from tower_lsp)

```rust
pub struct ParameterInformation {
    pub label: ParameterLabel,
    pub documentation: Option<Documentation>,
}
```

### SignatureHelp (LSP type from tower_lsp)

```rust
pub struct SignatureHelp {
    pub signatures: Vec<SignatureInformation>,
    pub active_signature: Option<u32>,
    pub active_parameter: Option<u32>,
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*


### Property 1: Package Function Signature Formatting

*For any* package function with R help text containing a Usage section, building signature information should produce a SignatureInformation with a label containing the function name and all parameters with defaults, and documentation containing the description.

**Validates: Requirements 1.1, 1.2, 1.3, 3.1, 3.2, 3.5**

### Property 2: Help Text Description Extraction

*For any* R help text containing a Description section, extracting the description should produce a string that includes the title (if present), the description text with multi-line content joined by spaces, and Unicode curly quotes converted to markdown backticks.

**Validates: Requirements 4.1, 4.2, 4.3, 4.4**

### Property 3: User Function Signature Formatting

*For any* user-defined function in the AST, building signature information should produce a SignatureInformation with a label in the format "function_name(param1, param2 = default, ...)" where all parameters are included, defaults are shown when present, and the entire signature is on a single line regardless of parameter count.

**Validates: Requirements 5.1, 5.2, 5.3, 2.1**

### Property 4: Roxygen Documentation Display

*For any* user-defined function with roxygen comments, building signature information should include documentation with the title and description when present, or fall back to plain comment text when roxygen tags are absent.

**Validates: Requirements 2.2, 2.3**

### Property 5: Parameter Information Structure

*For any* function signature with parameters, the SignatureInformation should contain a parameters vector where each ParameterInformation has a label matching the parameter name (with default if present) and documentation from @param tags or R help Arguments section when available.

**Validates: Requirements 6.1, 6.2**

### Property 6: Active Parameter Detection

*For any* function call being typed, detecting the active parameter should return the index corresponding to the number of commas before the cursor position, with the first parameter being index 0.

**Validates: Requirements 6.3**

### Property 7: Signature Help Fallback

*For any* function where signature extraction fails, the signature help should return a SignatureInformation with label showing the function name and documentation showing the source attribution (package name or file location).

**Validates: Requirements 7.1, 7.3, 9.2, 9.4, 9.5**

### Property 8: S3 Method Signature Preference

*For any* R help text containing both generic and S3 method signatures in the Usage section, the signature extractor should return the generic signature rather than the S3 method signature.

**Validates: Requirements 3.3**

## Error Handling

### Signature Extraction Failures

When signature extraction from R help text fails:
1. Display the function name as the label
2. Include source attribution in documentation field (e.g., "from {package}")
3. Log the failure at trace level for debugging

### AST Extraction Failures

When AST parameter extraction fails for user functions:
1. Display the function name as the label
2. Include file location in documentation field (e.g., "defined in file.R, line 10")
3. Log the failure at trace level

### Help Text Unavailable

When R help text is not available for package functions:
1. Display function name as the label
2. Add package attribution in documentation field: "from {package}"
3. Do not block or retry - use cached result only

### Roxygen Parsing Failures

When roxygen parsing returns no documentation:
1. Display signature with parameters but no documentation field
2. Do not fall back to raw comments (they're already handled by fallback field)
3. Parameters should still be populated from AST

### Malformed Help Text

When help text is malformed or missing expected sections:
1. Extract whatever sections are available (signature OR description)
2. Display partial information rather than failing completely
3. Fall back to function name with source attribution if nothing can be extracted

### Active Parameter Detection Failures

When active parameter cannot be determined:
1. Return None for active_parameter field
2. Still display the full signature with all parameters
3. LSP client will handle missing active parameter gracefully

## Testing Strategy

### Unit Tests

Unit tests will verify specific examples and edge cases:

1. **Signature Information Building**:
   - Zero parameters: SignatureInformation with "func()" label
   - Single parameter: SignatureInformation with "func(x)" label
   - Multiple parameters: SignatureInformation with "func(x, y, z)" label
   - Parameters with defaults: SignatureInformation with "func(x = 1, y = TRUE)" label
   - Dots parameter: SignatureInformation with "func(x, ...)" label
   - Extraction failure: SignatureInformation with "func" label and source attribution in documentation

2. **Parameter Information Building**:
   - Parameter without default: ParameterInformation with "x" label
   - Parameter with default: ParameterInformation with "x = 1" label
   - Parameter with documentation: ParameterInformation with documentation field
   - Dots parameter: ParameterInformation with "..." label

3. **Help Text Parsing**:
   - Standard R help format (base::mean)
   - Multi-line signatures
   - S3 method signatures
   - Missing Usage section
   - Missing Description section

4. **Roxygen Extraction**:
   - Title only
   - Title + description
   - @param tags
   - Plain comments fallback
   - No comments

5. **Active Parameter Detection**:
   - First parameter (no commas): index 0
   - Second parameter (one comma): index 1
   - Third parameter (two commas): index 2
   - Inside nested call: correct index for outer call
   - After closing paren: None

6. **Edge Cases**:
   - Empty parameter list
   - Very long parameter list
   - Malformed help text
   - Missing AST nodes
   - Undefined functions

### Property-Based Tests

Property tests will verify universal properties across many generated inputs (minimum 100 iterations each):

1. **Property 1: Package Function Signature Formatting**
   - Generate: Random R help text with Usage sections
   - Verify: SignatureInformation contains function name and all parameters
   - Tag: **Feature: rich-function-signature-hovers, Property 1: Package Function Signature Formatting**

2. **Property 2: Help Text Description Extraction**
   - Generate: Random R help text with Description sections
   - Verify: Extracted description includes title and normalized text
   - Tag: **Feature: rich-function-signature-hovers, Property 2: Help Text Description Extraction**

3. **Property 3: User Function Signature Formatting**
   - Generate: Random R function definitions with various parameter lists
   - Verify: SignatureInformation label matches expected pattern
   - Tag: **Feature: rich-function-signature-hovers, Property 3: User Function Signature Formatting**

4. **Property 4: Roxygen Documentation Display**
   - Generate: Random R functions with roxygen comments
   - Verify: Documentation is extracted and included in SignatureInformation
   - Tag: **Feature: rich-function-signature-hovers, Property 4: Roxygen Documentation Display**

5. **Property 5: Parameter Information Structure**
   - Generate: Random function signatures with various parameters
   - Verify: Each parameter has corresponding ParameterInformation
   - Tag: **Feature: rich-function-signature-hovers, Property 5: Parameter Information Structure**

6. **Property 6: Active Parameter Detection**
   - Generate: Random function calls with cursor at various positions
   - Verify: Active parameter index matches comma count before cursor
   - Tag: **Feature: rich-function-signature-hovers, Property 6: Active Parameter Detection**

7. **Property 7: Signature Help Fallback**
   - Generate: Random functions where extraction fails
   - Verify: Label shows function name, documentation shows source attribution
   - Tag: **Feature: rich-function-signature-hovers, Property 7: Signature Help Fallback**

### Integration Tests

Integration tests will verify the complete signature help flow:

1. Type package function call (e.g., "mean(") - verify rich signature with parameters
2. Type user function call with roxygen - verify signature + docs + parameter docs
3. Type user function call without roxygen - verify signature + parameters only
4. Type undefined function call - verify minimal signature
5. Type nested function calls - verify correct active parameter detection
6. Type function with many parameters - verify all parameters shown

### Test Configuration

- Property tests: Minimum 100 iterations per test
- Use existing test infrastructure (cargo test)
- Property testing library: proptest (already used in Raven)
- Each property test references its design document property via tag comment
