# Requirements Document

## Introduction

This document specifies requirements for enhancing Raven's signature help functionality to display rich function signatures with documentation. Currently, when typing function arguments (e.g., `function_name(`), the signature help tooltip shows minimal information: just "function_name(...)". The enhancement will provide clean, formatted signatures with parameter lists, default values, and descriptions, similar to Positron/Ark's signature help experience.

## Glossary

- **Signature_Help_System**: The LSP signature help handler that displays parameter information when typing function calls
- **HelpCache**: The existing cache system for R help documentation (help.rs)
- **Roxygen_Parser**: The existing parser for roxygen2-style documentation comments (roxygen.rs)
- **Parameter_Resolver**: The existing system for extracting function parameters from AST (parameter_resolver.rs)
- **Package_Function**: A function exported by an R package (e.g., base::mean, dplyr::filter)
- **User_Function**: A function defined in user code (current file or sourced files)
- **Function_Signature**: The formatted representation of a function with its parameters and defaults
- **Signature_Formatter**: The new component that formats function signatures for display
- **Active_Parameter**: The parameter currently being typed by the user

## Requirements

### Requirement 1: Format Package Function Signatures

**User Story:** As a developer, I want to see formatted function signatures when typing function calls for package functions, so that I can quickly understand the function's parameters without reading documentation.

#### Acceptance Criteria

1. WHEN typing a package function call (e.g., "mean("), THE Signature_Help_System SHALL display a formatted signature with all parameters and default values
2. WHEN the signature is displayed, THE Signature_Formatter SHALL extract parameter information from R help text
3. WHEN parameter defaults are available, THE Signature_Formatter SHALL include them in the signature
4. WHEN the function has a description in help text, THE Signature_Help_System SHALL display it in the signature documentation
5. THE Signature_Help_System SHALL use existing HelpCache to avoid redundant R subprocess calls

### Requirement 2: Format User-Defined Function Signatures

**User Story:** As a developer, I want to see formatted function signatures when typing calls to user-defined functions, so that I can understand function interfaces without looking up definitions.

#### Acceptance Criteria

1. WHEN typing a user-defined function call, THE Signature_Help_System SHALL display a formatted signature extracted from the AST
2. WHEN the function has roxygen documentation, THE Signature_Help_System SHALL display the title and description in signature documentation
3. WHEN the function has plain comments, THE Signature_Help_System SHALL display the comment text as fallback documentation
4. THE Signature_Help_System SHALL use existing Roxygen_Parser to extract documentation
5. THE Signature_Help_System SHALL use existing Parameter_Resolver to extract parameter information

### Requirement 3: Extract Signatures from R Help Text

**User Story:** As a developer, I want function signatures extracted from R help text, so that signature help displays are consistent and accurate.

#### Acceptance Criteria

1. WHEN R help text contains a Usage section, THE Signature_Formatter SHALL extract the first function signature
2. WHEN the signature spans multiple lines, THE Signature_Formatter SHALL join them into a single line
3. WHEN S3 method signatures are present, THE Signature_Formatter SHALL prefer generic signatures over S3 methods
4. WHEN no signature can be extracted, THE Signature_Help_System SHALL display the function name with source attribution (package name or file location)
5. THE Signature_Formatter SHALL handle multi-line parameter lists correctly

### Requirement 4: Extract Descriptions from R Help Text

**User Story:** As a developer, I want function descriptions extracted from R help text, so that I understand what the function does while typing arguments.

#### Acceptance Criteria

1. WHEN R help text contains a Description section, THE Signature_Formatter SHALL extract the description text
2. WHEN the description spans multiple lines, THE Signature_Formatter SHALL join them with spaces
3. WHEN the help text contains a title line, THE Signature_Formatter SHALL include it above the description
4. THE Signature_Formatter SHALL convert R's Unicode curly quotes to markdown backticks
5. WHEN no description is available, THE Signature_Help_System SHALL display only the signature

### Requirement 5: Format User Function Signatures from AST

**User Story:** As a developer, I want user function signatures formatted from AST data, so that signature help displays show accurate parameter information.

#### Acceptance Criteria

1. WHEN a user function is found in the AST, THE Signature_Formatter SHALL format it as "function_name(param1, param2, ...)"
2. WHEN parameters have default values, THE Signature_Formatter SHALL include them in the format "param = default"
3. WHEN the parameter list is long, THE Signature_Formatter SHALL format it on a single line
4. WHEN the function has no parameters, THE Signature_Formatter SHALL display "function_name()"
5. THE Signature_Formatter SHALL use existing Parameter_Resolver extract_from_ast function

### Requirement 6: Display Parameter Information

**User Story:** As a developer, I want to see individual parameter information, so that I understand what each parameter does while typing.

#### Acceptance Criteria

1. WHEN the signature has multiple parameters, THE Signature_Help_System SHALL display each parameter as a separate SignatureInformation parameter
2. WHEN a parameter has documentation (from @param or R help Arguments section), THE Signature_Help_System SHALL include it in the parameter documentation
3. WHEN typing arguments, THE Signature_Help_System SHALL highlight the active parameter being typed
4. THE Signature_Help_System SHALL use existing HelpCache get_arguments method for package function parameter docs
5. THE Signature_Help_System SHALL use existing Roxygen_Parser get_param_doc for user function parameter docs

### Requirement 7: Preserve Existing Signature Help Behavior

**User Story:** As a developer, I want existing signature help functionality preserved, so that no information is lost in the enhancement.

#### Acceptance Criteria

1. WHEN signature extraction fails, THE Signature_Help_System SHALL display the function name with source attribution (package or file location)
2. WHEN typing arguments for undefined functions, THE Signature_Help_System SHALL attempt to fetch R help as before
3. WHEN no information is available, THE Signature_Help_System SHALL display the function name only
4. THE Signature_Help_System SHALL maintain existing call detection logic
5. THE Signature_Help_System SHALL maintain existing active parameter detection

### Requirement 8: Maintain Performance

**User Story:** As a developer, I want signature help responses to remain fast, so that my typing experience is not degraded.

#### Acceptance Criteria

1. THE Signature_Help_System SHALL use existing HelpCache for all R help lookups
2. THE Signature_Help_System SHALL not introduce additional R subprocess calls
3. THE Signature_Help_System SHALL reuse existing AST traversals from Parameter_Resolver
4. THE Signature_Help_System SHALL reuse existing roxygen parsing from Roxygen_Parser
5. WHEN help text is already cached, THE Signature_Help_System SHALL respond without blocking on I/O

### Requirement 9: Handle Edge Cases Gracefully

**User Story:** As a developer, I want signature help to handle edge cases gracefully, so that I always get useful information or a clear fallback.

#### Acceptance Criteria

1. WHEN a function has no parameters, THE Signature_Formatter SHALL display "function_name()"
2. WHEN help text parsing fails, THE Signature_Help_System SHALL display the function name with source attribution
3. WHEN roxygen parsing returns no documentation, THE Signature_Help_System SHALL display only the signature
4. WHEN AST extraction fails, THE Signature_Help_System SHALL display the function name with file location
5. WHEN a package function has no help available, THE Signature_Help_System SHALL display the function name with package attribution
