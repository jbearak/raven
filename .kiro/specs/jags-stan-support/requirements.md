# Requirements Document

## Introduction

Raven currently treats all open files as R code, producing diagnostics (syntax errors, undefined variables, etc.) that are invalid for JAGS model files (`.jags`, `.bugs`) and Stan model files (`.stan`). These languages have different syntax from R, and their variable scoping cannot be statically determined. This feature suppresses all diagnostics for JAGS and Stan files while preserving best-effort LSP features (find references, go to definition, hover, document outline). Additionally, it introduces TextMate grammars for syntax highlighting of JAGS and Stan files in VS Code.

## Glossary

- **Raven**: The R language server (LSP) implemented in Rust, providing diagnostics, completions, and navigation features.
- **VS_Code_Extension**: The VS Code extension (`editors/vscode/`) that registers languages, grammars, and communicates with Raven via LSP.
- **Diagnostics_Pipeline**: The set of diagnostic collectors in `handlers::diagnostics()` that produce syntax errors, undefined variable warnings, and other diagnostic messages for open documents.
- **JAGS_File**: A file with `.jags` or `.bugs` extension containing a JAGS (Just Another Gibbs Sampler) model definition.
- **Stan_File**: A file with `.stan` extension containing a Stan probabilistic programming model definition.
- **TextMate_Grammar**: A JSON or plist file defining tokenization rules used by VS Code for syntax highlighting.
- **Document_Selector**: The VS Code `LanguageClientOptions.documentSelector` configuration that determines which files the LSP client sends to the server.
- **File_Watcher**: The VS Code `FileSystemWatcher` that monitors the workspace for file changes and notifies the LSP server.
- **LSP_Features**: Language Server Protocol features including find references, go to definition, hover, and document symbols (outline).
- **Completions_Provider**: The component in Raven that generates completion suggestions (e.g., function names, variable names, keywords) in response to LSP `textDocument/completion` requests.

## Requirements

### Requirement 1: Suppress Diagnostics for JAGS Files

**User Story:** As a developer working with JAGS models alongside R scripts, I want Raven to suppress all diagnostics for `.jags` and `.bugs` files, so that I do not see false-positive syntax errors and undefined variable warnings from the R parser.

#### Acceptance Criteria

1. WHEN a JAGS_File is opened, THE Diagnostics_Pipeline SHALL return an empty diagnostics list for that file.
2. WHEN a JAGS_File is edited, THE Diagnostics_Pipeline SHALL return an empty diagnostics list for that file.
3. WHEN a JAGS_File is opened, THE Raven SHALL publish zero diagnostics for that file to the client.

### Requirement 2: Suppress Diagnostics for Stan Files

**User Story:** As a developer working with Stan models alongside R scripts, I want Raven to suppress all diagnostics for `.stan` files, so that I do not see false-positive syntax errors and undefined variable warnings from the R parser.

#### Acceptance Criteria

1. WHEN a Stan_File is opened, THE Diagnostics_Pipeline SHALL return an empty diagnostics list for that file.
2. WHEN a Stan_File is edited, THE Diagnostics_Pipeline SHALL return an empty diagnostics list for that file.
3. WHEN a Stan_File is opened, THE Raven SHALL publish zero diagnostics for that file to the client.

### Requirement 3: Preserve LSP Features for JAGS Files

**User Story:** As a developer editing JAGS model files, I want find references, go to definition, hover, and document outline to work on a best-effort basis, so that I can still navigate JAGS code.

#### Acceptance Criteria

1. WHEN a find-references request is received for a JAGS_File, THE Raven SHALL attempt to return reference locations using the R parser on a best-effort basis.
2. WHEN a go-to-definition request is received for a JAGS_File, THE Raven SHALL attempt to return definition locations using the R parser on a best-effort basis.
3. WHEN a hover request is received for a JAGS_File, THE Raven SHALL attempt to return hover information using the R parser on a best-effort basis.
4. WHEN a document-symbols request is received for a JAGS_File, THE Raven SHALL attempt to return document symbols using the R parser on a best-effort basis.

### Requirement 4: Preserve LSP Features for Stan Files

**User Story:** As a developer editing Stan model files, I want find references, go to definition, hover, and document outline to work on a best-effort basis, so that I can still navigate Stan code.

#### Acceptance Criteria

1. WHEN a find-references request is received for a Stan_File, THE Raven SHALL attempt to return reference locations using the R parser on a best-effort basis.
2. WHEN a go-to-definition request is received for a Stan_File, THE Raven SHALL attempt to return definition locations using the R parser on a best-effort basis.
3. WHEN a hover request is received for a Stan_File, THE Raven SHALL attempt to return hover information using the R parser on a best-effort basis.
4. WHEN a document-symbols request is received for a Stan_File, THE Raven SHALL attempt to return document symbols using the R parser on a best-effort basis.

### Requirement 5: Register JAGS Language in VS Code

**User Story:** As a developer, I want VS Code to recognize `.jags` and `.bugs` files as JAGS language files, so that they receive appropriate language-specific treatment.

#### Acceptance Criteria

1. THE VS_Code_Extension SHALL register a language with id `jags` for files with `.jags` and `.bugs` extensions.
2. THE VS_Code_Extension SHALL provide a language configuration for JAGS files that defines comment syntax, brackets, and auto-closing pairs appropriate for JAGS.

### Requirement 6: Register Stan Language in VS Code

**User Story:** As a developer, I want VS Code to recognize `.stan` files as Stan language files, so that they receive appropriate language-specific treatment.

#### Acceptance Criteria

1. THE VS_Code_Extension SHALL register a language with id `stan` for files with `.stan` extension.
2. THE VS_Code_Extension SHALL provide a language configuration for Stan files that defines comment syntax, brackets, and auto-closing pairs appropriate for Stan.

### Requirement 7: JAGS Syntax Highlighting

**User Story:** As a developer editing JAGS model files, I want syntax highlighting for JAGS keywords, distributions, operators, and comments, so that the code is readable and visually structured.

#### Acceptance Criteria

1. THE VS_Code_Extension SHALL provide a TextMate_Grammar for the `jags` language scope.
2. WHEN a JAGS_File is opened, THE VS_Code_Extension SHALL highlight JAGS block keywords (`model`, `data`).
3. WHEN a JAGS_File is opened, THE VS_Code_Extension SHALL highlight JAGS distribution names (e.g., `dnorm`, `dbern`, `dgamma`, `dunif`, `dpois`, `dbin`, `dbeta`, `dexp`, `dt`, `dweib`, `dlnorm`, `dchisqr`, `dlogis`, `dmulti`, `ddirch`, `dwish`, `dmnorm`, `dmt`, `dinterval`, `dcat`).
4. WHEN a JAGS_File is opened, THE VS_Code_Extension SHALL highlight JAGS mathematical functions (e.g., `abs`, `sqrt`, `log`, `exp`, `pow`, `sin`, `cos`, `sum`, `prod`, `min`, `max`, `mean`, `sd`, `inverse`, `logit`, `probit`, `cloglog`, `ilogit`, `phi`, `step`, `equals`, `round`, `trunc`, `inprod`, `interp.lin`, `logfact`, `loggam`, `rank`, `sort`, `ifelse`, `T`).
5. WHEN a JAGS_File is opened, THE VS_Code_Extension SHALL highlight JAGS comments (lines starting with `#`).
6. WHEN a JAGS_File is opened, THE VS_Code_Extension SHALL highlight numeric literals, string literals, and operators (`<-`, `~`, `+`, `-`, `*`, `/`, `^`, `<=`, `>=`, `==`, `!=`, `<`, `>`, `&&`, `||`).
7. WHEN a JAGS_File is opened, THE VS_Code_Extension SHALL highlight JAGS control flow keywords (`for`, `in`, `if`, `else`).

### Requirement 8: Stan Syntax Highlighting

**User Story:** As a developer editing Stan model files, I want syntax highlighting for Stan keywords, types, distributions, operators, and comments, so that the code is readable and visually structured.

#### Acceptance Criteria

1. THE VS_Code_Extension SHALL provide a TextMate_Grammar for the `stan` language scope.
2. WHEN a Stan_File is opened, THE VS_Code_Extension SHALL highlight Stan program block keywords (`functions`, `data`, `transformed data`, `parameters`, `transformed parameters`, `model`, `generated quantities`).
3. WHEN a Stan_File is opened, THE VS_Code_Extension SHALL highlight Stan type keywords (`int`, `real`, `vector`, `row_vector`, `matrix`, `simplex`, `unit_vector`, `ordered`, `positive_ordered`, `corr_matrix`, `cov_matrix`, `cholesky_factor_corr`, `cholesky_factor_cov`, `void`, `array`, `complex`, `complex_vector`, `complex_row_vector`, `complex_matrix`, `tuple`).
4. WHEN a Stan_File is opened, THE VS_Code_Extension SHALL highlight Stan constraint keywords (`lower`, `upper`, `offset`, `multiplier`).
5. WHEN a Stan_File is opened, THE VS_Code_Extension SHALL highlight Stan control flow keywords (`for`, `in`, `while`, `if`, `else`, `return`, `break`, `continue`, `print`, `reject`, `profile`).
6. WHEN a Stan_File is opened, THE VS_Code_Extension SHALL highlight Stan single-line comments (`//`) and block comments (`/* ... */`).
7. WHEN a Stan_File is opened, THE VS_Code_Extension SHALL highlight Stan operators (`~`, `<-`, `=`, `+`, `-`, `*`, `/`, `^`, `%`, `<=`, `>=`, `==`, `!=`, `<`, `>`, `&&`, `||`, `!`, `?`, `:`, `'`, `\`).
8. WHEN a Stan_File is opened, THE VS_Code_Extension SHALL highlight Stan numeric literals (integers, reals, scientific notation) and string literals.
9. WHEN a Stan_File is opened, THE VS_Code_Extension SHALL highlight Stan distribution sampling statements using the `~` operator and the `_lpdf`, `_lpmf`, `_lcdf`, `_lccdf`, `_rng` suffixed function names.

### Requirement 9: LSP Client Registration for JAGS and Stan

**User Story:** As a developer, I want the VS Code extension to send JAGS and Stan files to the Raven LSP server, so that best-effort LSP features work for these file types.

#### Acceptance Criteria

1. THE VS_Code_Extension SHALL include `jags` and `stan` language IDs in the Document_Selector sent to the LSP client.
2. THE VS_Code_Extension SHALL include `.jags`, `.bugs`, and `.stan` extensions in the File_Watcher glob pattern.
3. WHEN a JAGS_File or Stan_File is opened in VS Code, THE VS_Code_Extension SHALL send the file to Raven via the LSP protocol.

### Requirement 10: Diagnostics Suppression Does Not Affect R Files

**User Story:** As a developer working with R files, I want diagnostics to continue working normally for `.r`, `.R`, `.rmd`, `.Rmd`, and `.qmd` files, so that the JAGS/Stan changes do not regress existing functionality.

#### Acceptance Criteria

1. WHEN an R file (`.r`, `.R`, `.rmd`, `.Rmd`, `.qmd`) is opened, THE Diagnostics_Pipeline SHALL continue to produce diagnostics as before.
2. WHEN an R file is edited, THE Diagnostics_Pipeline SHALL continue to produce diagnostics as before.

### Requirement 11: JAGS and Stan Files Included in Workspace Indexing

**User Story:** As a developer working with JAGS/Stan models alongside R scripts, I want JAGS and Stan files to be included in workspace indexing, so that variables defined in model files appear in cross-file find references when invoked from R files or other model files.

#### Acceptance Criteria

1. WHILE workspace indexing is running, THE Raven SHALL include files with `.jags`, `.bugs`, and `.stan` extensions in the workspace index.
2. WHEN a find-references request is invoked for a symbol in an R file, THE Raven SHALL include matching references found in indexed JAGS_File and Stan_File documents.
3. WHEN a find-references request is invoked for a symbol in a JAGS_File or Stan_File, THE Raven SHALL include matching references found in indexed R files and other model files.

### Requirement 12: JAGS Completion Filtering

**User Story:** As a developer editing JAGS model files, I want completions to suggest only JAGS-relevant items, so that I do not see irrelevant R functions and package exports in my completion list.

#### Acceptance Criteria

1. WHEN a completion request is received for a JAGS_File, THE Completions_Provider SHALL exclude R functions, R package exports, and R reserved words from the completion list.
2. WHEN a completion request is received for a JAGS_File, THE Completions_Provider SHALL suggest JAGS built-in distribution names (e.g., `dnorm`, `dbern`, `dgamma`, `dunif`, `dpois`, `dbin`, `dbeta`, `dexp`, `dt`, `dweib`, `dlnorm`, `dchisqr`, `dlogis`, `dmulti`, `ddirch`, `dwish`, `dmnorm`, `dmt`, `dinterval`, `dcat`).
3. WHEN a completion request is received for a JAGS_File, THE Completions_Provider SHALL suggest JAGS built-in function names (e.g., `abs`, `sqrt`, `log`, `exp`, `pow`, `sin`, `cos`, `sum`, `prod`, `min`, `max`, `mean`, `sd`, `inverse`, `logit`, `probit`, `cloglog`, `ilogit`, `phi`, `step`, `equals`, `round`, `trunc`, `inprod`, `interp.lin`, `logfact`, `loggam`, `rank`, `sort`, `ifelse`, `T`).
4. WHEN a completion request is received for a JAGS_File, THE Completions_Provider SHALL suggest JAGS keywords (`model`, `data`, `for`, `in`, `if`, `else`).
5. WHEN a completion request is received for a JAGS_File, THE Completions_Provider SHALL suggest variable and node names defined within the current JAGS_File.

### Requirement 13: Stan Completion Filtering

**User Story:** As a developer editing Stan model files, I want completions to suggest only Stan-relevant items, so that I do not see irrelevant R functions and package exports in my completion list.

#### Acceptance Criteria

1. WHEN a completion request is received for a Stan_File, THE Completions_Provider SHALL exclude R functions, R package exports, and R reserved words from the completion list.
2. WHEN a completion request is received for a Stan_File, THE Completions_Provider SHALL suggest Stan built-in function names (including distribution functions with `_lpdf`, `_lpmf`, `_lcdf`, `_lccdf`, `_rng` suffixes, and math functions such as `log`, `exp`, `sqrt`, `fabs`, `inv_logit`, `logit`, `softmax`, `to_vector`, `to_matrix`, `to_array_1d`, `rep_vector`, `rep_matrix`, `append_row`, `append_col`).
3. WHEN a completion request is received for a Stan_File, THE Completions_Provider SHALL suggest Stan type keywords (`int`, `real`, `vector`, `row_vector`, `matrix`, `simplex`, `unit_vector`, `ordered`, `positive_ordered`, `corr_matrix`, `cov_matrix`, `cholesky_factor_corr`, `cholesky_factor_cov`, `void`, `array`, `complex`, `complex_vector`, `complex_row_vector`, `complex_matrix`, `tuple`).
4. WHEN a completion request is received for a Stan_File, THE Completions_Provider SHALL suggest Stan program block keywords (`functions`, `data`, `transformed data`, `parameters`, `transformed parameters`, `model`, `generated quantities`).
5. WHEN a completion request is received for a Stan_File, THE Completions_Provider SHALL suggest Stan control flow and statement keywords (`for`, `in`, `while`, `if`, `else`, `return`, `break`, `continue`, `print`, `reject`, `profile`).
6. WHEN a completion request is received for a Stan_File, THE Completions_Provider SHALL suggest variable names defined within the current Stan_File.
