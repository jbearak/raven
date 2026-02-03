# Design Document: Function Parameter and Dollar-Sign Completions

## Overview

This design adds two new completion contexts to Raven's LSP completion handler:

1. **Function Parameter Completions**: When the cursor is inside a function call's parentheses, suggest parameter names with their default values
2. **Dollar-Sign Completions**: When the cursor follows a `$` operator, suggest member/column names from the object

The implementation leverages existing infrastructure:
- Tree-sitter AST for context detection and user-defined function parameter extraction
- R subprocess for querying base R and package function signatures
- Cross-file scope resolution for functions defined in sourced files
- Package library for resolving which package a function belongs to

## Architecture

```mermaid
graph TD
    A[Completion Request] --> B{Detect Context}
    B -->|Function Call| C[Parameter Completion Flow]
    B -->|Dollar Sign| D[Dollar Completion Flow]
    B -->|Neither| E[Standard Completions]
    
    C --> F{Resolve Function}
    F -->|User-defined| G[AST Parameter Extraction]
    F -->|Package Function| H[R Subprocess Query]
    F -->|Base R| H
    
    G --> I[Parameter Cache]
    H --> I
    I --> J[Format Completions]
    
    D --> K{Resolve Object}
    K -->|Built-in Dataset| L[R Subprocess names()]
    K -->|AST-defined| M[AST Member Extraction]
    K -->|Unknown| N[Empty List]
    
    L --> O[Dataset Cache]
    M --> O
    O --> P[Format Completions]
```

## Components and Interfaces

### 1. Completion Context Detection

New module: `crates/raven/src/completion_context.rs`

```rust
/// Represents the completion context at cursor position
pub enum CompletionContext {
    /// Inside function call parentheses
    FunctionCall {
        /// Name of the function being called
        function_name: String,
        /// Optional namespace qualifier (e.g., "dplyr" in dplyr::filter)
        namespace: Option<String>,
        /// Parameters already specified in the call
        existing_params: Vec<String>,
        /// Position of the function call node
        call_position: (u32, u32),
    },
    /// After dollar sign operator
    DollarSign {
        /// The object expression before $
        object_name: String,
        /// Prefix typed after $ (for filtering)
        prefix: String,
    },
    /// Standard completion context (no special handling)
    Standard,
}

/// Detect completion context from AST at cursor position
pub fn detect_completion_context(
    tree: &Tree,
    text: &str,
    position: Position,
) -> CompletionContext;

/// Check if cursor is inside function call arguments
fn is_inside_function_call(node: Node, text: &str) -> Option<FunctionCallInfo>;

/// Check if cursor follows dollar sign operator
fn is_after_dollar_sign(node: Node, text: &str) -> Option<DollarSignInfo>;

/// Extract already-specified parameter names from function call
fn extract_existing_parameters(call_node: Node, text: &str) -> Vec<String>;
```

### 2. Parameter Resolver

New module: `crates/raven/src/parameter_resolver.rs`

```rust
/// Cached function signature information
#[derive(Debug, Clone)]
pub struct FunctionSignature {
    /// Function name
    pub name: String,
    /// Parameters with optional default values
    pub parameters: Vec<ParameterInfo>,
    /// Source of the signature (for cache invalidation)
    pub source: SignatureSource,
}

#[derive(Debug, Clone)]
pub struct ParameterInfo {
    /// Parameter name
    pub name: String,
    /// Default value as string (if any)
    pub default_value: Option<String>,
    /// Whether this is the ... parameter (excluded from completions)
    pub is_dots: bool,
}

#[derive(Debug, Clone)]
pub enum SignatureSource {
    /// From R subprocess query
    RSubprocess { package: Option<String> },
    /// From AST in current file
    CurrentFile { uri: Url, line: u32 },
    /// From AST in sourced file
    CrossFile { uri: Url, line: u32 },
}

/// Thread-safe signature cache
pub struct SignatureCache {
    /// Package function signatures (package::function -> signature)
    package_signatures: RwLock<HashMap<String, FunctionSignature>>,
    /// User-defined function signatures (uri#function -> signature)
    user_signatures: RwLock<HashMap<String, FunctionSignature>>,
    /// Cache configuration
    max_entries: usize,
}

impl SignatureCache {
    pub fn new(max_entries: usize) -> Self;
    
    /// Get cached signature or None
    pub fn get(&self, key: &str) -> Option<FunctionSignature>;
    
    /// Insert signature into cache
    pub fn insert(&self, key: String, signature: FunctionSignature);
    
    /// Invalidate signatures from a specific file
    pub fn invalidate_file(&self, uri: &Url);
    
    /// Clear all user-defined signatures
    pub fn clear_user_signatures(&self);
}

/// Resolve function parameters from various sources
pub struct ParameterResolver<'a> {
    state: &'a WorldState,
    cache: &'a SignatureCache,
}

impl<'a> ParameterResolver<'a> {
    /// Resolve parameters for a function
    pub async fn resolve(
        &self,
        function_name: &str,
        namespace: Option<&str>,
        current_uri: &Url,
        position: Position,
    ) -> Option<FunctionSignature>;
    
    /// Try to resolve from user-defined functions (AST)
    fn resolve_user_defined(
        &self,
        function_name: &str,
        current_uri: &Url,
        position: Position,
    ) -> Option<FunctionSignature>;
    
    /// Try to resolve from package functions (R subprocess)
    async fn resolve_package_function(
        &self,
        function_name: &str,
        package: Option<&str>,
    ) -> Option<FunctionSignature>;
    
    /// Extract parameters from function definition AST node
    fn extract_from_ast(
        &self,
        func_node: Node,
        text: &str,
        uri: &Url,
    ) -> Option<FunctionSignature>;
}
```

### 3. R Subprocess Extensions

Extensions to `crates/raven/src/r_subprocess.rs`:

```rust
impl RSubprocess {
    /// Query function parameters using formals()
    /// Returns parameter names and default values
    pub async fn get_function_formals(
        &self,
        function_name: &str,
        package: Option<&str>,
    ) -> Result<Vec<ParameterInfo>>;
    
    /// Query object member names using names()
    /// Used for data frame columns and list members
    pub async fn get_object_names(
        &self,
        object_expr: &str,
    ) -> Result<Vec<String>>;
}
```

R code for querying formals:
```r
# For package function
tryCatch({
  f <- formals(pkg::func)
  if (is.null(f)) {
    cat("")
  } else {
    for (name in names(f)) {
      default <- if (is.symbol(f[[name]]) && nchar(as.character(f[[name]])) == 0) {
        ""
      } else {
        deparse(f[[name]], width.cutoff = 500)[1]
      }
      cat(name, "\t", default, "\n", sep = "")
    }
  }
}, error = function(e) cat("__RLSP_ERROR__:", conditionMessage(e), sep = ""))
```

### 4. Dollar-Sign Resolver

New module: `crates/raven/src/dollar_resolver.rs`

```rust
/// Cached object member information
#[derive(Debug, Clone)]
pub struct ObjectMembers {
    /// Object name/expression
    pub object: String,
    /// Member names (columns for data frames, elements for lists)
    pub members: Vec<String>,
    /// Source of the information
    pub source: MemberSource,
}

#[derive(Debug, Clone)]
pub enum MemberSource {
    /// From R subprocess (built-in dataset)
    RSubprocess,
    /// From AST analysis (data.frame() or list() call)
    AstAnalysis { uri: Url },
    /// From tracking column assignments (df$col <- value)
    ColumnAssignment { uri: Url },
    /// Unknown/unresolvable
    Unknown,
}

/// Thread-safe member cache for datasets
pub struct DatasetCache {
    /// Built-in dataset members (dataset_name -> members)
    datasets: RwLock<HashMap<String, ObjectMembers>>,
}

impl DatasetCache {
    pub fn new() -> Self;
    pub fn get(&self, name: &str) -> Option<ObjectMembers>;
    pub fn insert(&self, name: String, members: ObjectMembers);
}

/// Resolve dollar-sign completions
pub struct DollarResolver<'a> {
    state: &'a WorldState,
    cache: &'a DatasetCache,
}

impl<'a> DollarResolver<'a> {
    /// Resolve members for an object
    pub async fn resolve(
        &self,
        object_name: &str,
        current_uri: &Url,
        position: Position,
    ) -> Option<ObjectMembers>;
    
    /// Check if object is a built-in dataset
    fn is_builtin_dataset(&self, name: &str) -> bool;
    
    /// Try to resolve from AST (data.frame/list construction)
    fn resolve_from_ast(
        &self,
        object_name: &str,
        current_uri: &Url,
    ) -> Option<ObjectMembers>;
    
    /// Track column assignments (df$col <- value) in the AST
    fn collect_column_assignments(
        &self,
        object_name: &str,
        tree: &Tree,
        text: &str,
        position: Position,
    ) -> Vec<String>;
}
```

### 5. Integration with Completion Handler

Modified `crates/raven/src/handlers.rs`:

```rust
pub fn completion(
    state: &WorldState,
    uri: &Url,
    position: Position,
) -> Option<CompletionResponse> {
    let doc = state.get_document(uri)?;
    let tree = doc.tree.as_ref()?;
    let text = doc.text();
    
    // Detect completion context
    let context = detect_completion_context(tree, &text, position);
    
    match context {
        CompletionContext::FunctionCall { 
            function_name, 
            namespace, 
            existing_params,
            .. 
        } => {
            // Return parameter completions
            get_parameter_completions(
                state, uri, &function_name, namespace.as_deref(), 
                &existing_params, position
            )
        }
        CompletionContext::DollarSign { object_name, prefix } => {
            // Return member completions
            get_dollar_completions(state, uri, &object_name, &prefix)
        }
        CompletionContext::Standard => {
            // Existing completion logic
            get_standard_completions(state, uri, position)
        }
    }
}

fn get_parameter_completions(
    state: &WorldState,
    uri: &Url,
    function_name: &str,
    namespace: Option<&str>,
    existing_params: &[String],
    position: Position,
) -> Option<CompletionResponse> {
    let resolver = ParameterResolver::new(state, &state.signature_cache);
    
    // This needs to be sync for the completion handler
    // Use cached values or return None if not cached
    let signature = resolver.resolve_sync(function_name, namespace, uri, position)?;
    
    let mut items = Vec::new();
    for param in &signature.parameters {
        // Skip dots (...) - it's a pass-through mechanism, not a named parameter
        if param.is_dots {
            continue;
        }
        
        // Skip already-specified parameters
        if existing_params.contains(&param.name) {
            continue;
        }
        
        let detail = param.default_value.as_ref()
            .map(|d| format!("= {}", d));
        
        items.push(CompletionItem {
            label: param.name.clone(),
            kind: Some(CompletionItemKind::FIELD),
            detail,
            insert_text: Some(format!("{} = ", param.name)),
            ..Default::default()
        });
    }
    
    Some(CompletionResponse::Array(items))
}

fn get_dollar_completions(
    state: &WorldState,
    uri: &Url,
    object_name: &str,
    prefix: &str,
) -> Option<CompletionResponse> {
    let resolver = DollarResolver::new(state, &state.dataset_cache);
    
    let members = resolver.resolve_sync(object_name, uri)?;
    
    let items: Vec<_> = members.members.iter()
        .filter(|m| m.starts_with(prefix))
        .map(|m| CompletionItem {
            label: m.clone(),
            kind: Some(CompletionItemKind::FIELD),
            ..Default::default()
        })
        .collect();
    
    Some(CompletionResponse::Array(items))
}
```

## Data Models

### Signature Cache Key Format

```
Package functions: "package::function" (e.g., "dplyr::filter")
Base R functions: "base::function" (e.g., "base::print")
User functions: "file://uri#function" (e.g., "file:///path/to/file.R#my_func")
```

### Cache Entry Structure

```rust
struct CacheEntry<T> {
    value: T,
    created_at: Instant,
    last_accessed: Instant,
    access_count: u32,
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*



### Property 1: Function Call Context Detection

*For any* R code containing function calls and *for any* cursor position inside the parentheses of a function call (after `(`, before `)`, or after a comma between arguments), the context detector SHALL return a `FunctionCall` context with the correct function name.

**Validates: Requirements 1.1, 1.2, 1.4**

### Property 2: Nested Function Call Resolution

*For any* R code containing nested function calls (e.g., `outer(inner(x))`), when the cursor is inside the inner function's parentheses, the context detector SHALL return the innermost function name.

**Validates: Requirements 1.3**

### Property 3: Parameter Extraction Round-Trip

*For any* user-defined R function with parameters, extracting parameters from the AST and formatting them as completion items SHALL produce items whose labels match the original parameter names in order.

**Validates: Requirements 4.1, 4.2**

### Property 4: Default Value Preservation

*For any* function parameter with a default value, the completion item's detail field SHALL contain the default value string.

**Validates: Requirements 2.3, 4.3, 5.2**

### Property 5: Cache Consistency

*For any* function signature query, if the signature is in the cache, subsequent queries for the same function SHALL return the cached value without invoking R subprocess.

**Validates: Requirements 2.5, 3.4, 7.5**

### Property 6: Already-Specified Parameter Exclusion

*For any* function call with some parameters already specified, the parameter completions SHALL NOT include any parameter names that appear in the existing arguments.

**Validates: Requirements 5.5**

### Property 7: Dots Parameter Exclusion

*For any* function with a `...` (dots) parameter, the parameter completions SHALL NOT include `...` as a completion item since it is a pass-through mechanism for forwarding arguments.

**Validates: Requirements 4.4**

### Property 8: Dollar-Sign Context Detection

*For any* R code containing `identifier$` or `identifier$prefix`, when the cursor is positioned after the `$`, the context detector SHALL return a `DollarSign` context with the correct object name and prefix.

**Validates: Requirements 6.1, 6.2**

### Property 9: Data Frame Column Extraction

*For any* `data.frame()` call with named arguments, the dollar resolver SHALL extract column names that match the argument names.

**Validates: Requirements 7.2**

### Property 10: Column Assignment Tracking

*For any* assignment of the form `df$col <- value` that appears before the cursor position, the dollar resolver SHALL include `col` in the completions for `df$`.

**Validates: Requirements 7.3**

### Property 11: List Member Extraction

*For any* `list()` call with named elements, the dollar resolver SHALL extract member names that match the element names.

**Validates: Requirements 8.1**

### Property 12: R Subprocess Input Validation

*For any* function or object name containing characters outside `[a-zA-Z0-9._]` or starting with invalid characters, the R subprocess query methods SHALL reject the input without executing R code.

**Validates: Requirements 10.3**

### Property 13: Graceful Degradation

*For any* function call where the function signature cannot be determined (R unavailable, function not found), the completion handler SHALL return either AST-extracted parameters (if user-defined) or standard completions (if unknown).

**Validates: Requirements 12.1, 12.2**

## Error Handling

### R Subprocess Failures

1. **Timeout**: If R subprocess query exceeds 5 seconds, return `Err` and log at trace level
2. **Invalid Output**: If R output cannot be parsed, return empty result
3. **Package Not Found**: If package doesn't exist, return empty parameter list
4. **Function Not Found**: If function doesn't exist in package, return empty parameter list

### AST Parsing Failures

1. **Malformed Code**: If tree-sitter cannot parse, fall back to standard completions
2. **Missing Nodes**: If expected AST nodes are missing, return empty result
3. **Invalid Position**: If cursor position is outside document, return None

### Cache Failures

1. **Lock Contention**: Use `try_read()`/`try_write()` with fallback to uncached query
2. **Memory Pressure**: Implement LRU eviction when cache exceeds threshold

## Testing Strategy

### Unit Tests

Unit tests verify specific examples and edge cases:

1. **Context Detection**
   - Test cursor at various positions in `func(a, b, c)`
   - Test nested calls `outer(inner(x))`
   - Test namespace-qualified calls `pkg::func()`
   - Test cursor inside string literals (should not trigger)

2. **Parameter Extraction**
   - Test simple function `function(x, y)`
   - Test with defaults `function(x = 1, y = "hello")`
   - Test with dots `function(...)` - dots should be excluded from completions
   - Test mixed `function(x, y = 1, ...)` - only x and y should appear

3. **Dollar-Sign Resolution**
   - Test `df$` with known data frame
   - Test `list$` with known list
   - Test with prefix `df$mp`
   - Test unknown object (should return empty)

4. **Cache Behavior**
   - Test cache hit returns same value
   - Test cache invalidation on file change
   - Test LRU eviction

### Property-Based Tests

Property-based tests verify universal properties across generated inputs. Each test runs minimum 100 iterations.

**Test Configuration**: Use `proptest` crate with custom strategies for generating:
- Valid R function definitions
- Function calls with various argument patterns
- Data frame and list constructions
- Cursor positions within code

**Tag Format**: Each property test is tagged with:
`Feature: function-parameter-completions, Property N: [property description]`

### Integration Tests

1. **End-to-End Completion Flow**
   - Start LSP, open document, request completions at various positions
   - Verify correct completion items returned

2. **Cross-File Parameter Resolution**
   - Create multi-file setup with sourced functions
   - Verify parameters from sourced files are available

3. **Package Function Parameters**
   - Load a package, call its function
   - Verify package function parameters are suggested
