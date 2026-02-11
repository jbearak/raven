//! R Smart Indentation Module
//!
//! This module provides AST-aware indentation for R code through the LSP
//! `textDocument/onTypeFormatting` handler. It implements a context-based
//! approach that detects syntactic context (pipe chains, function arguments,
//! brace blocks) and computes appropriate indentation.
//!
//! # Architecture
//!
//! - `context`: Detects syntactic context at cursor position using tree-sitter AST
//! - `calculator`: Computes indentation amount based on context and style configuration
//! - `formatter`: Generates LSP TextEdit for indentation replacement

use tower_lsp::lsp_types::DocumentOnTypeFormattingOptions;

mod calculator;
mod context;
mod formatter;

pub use calculator::{calculate_indentation, IndentationConfig, IndentationStyle};
#[allow(unused_imports)] // Used by integration tests
pub use context::{detect_context, IndentContext, OperatorType};
pub use formatter::format_indentation;

/// Returns the LSP capability options for on-type formatting.
///
/// This registers the newline character (`\n`) as the trigger for on-type formatting,
/// enabling AST-aware indentation when the user presses Enter.
///
/// # Requirements
///
/// Validates: Requirement 8.1 - Register `textDocument/onTypeFormatting` capability
/// with trigger character `"\n"`.
pub fn on_type_formatting_capability() -> DocumentOnTypeFormattingOptions {
    DocumentOnTypeFormattingOptions {
        first_trigger_character: "\n".to_string(),
        more_trigger_character: None,
    }
}


#[cfg(test)]
mod tests {
    use super::on_type_formatting_capability;

    /// Test that server capabilities include onTypeFormatting with trigger "\n".
    ///
    /// **Validates: Requirement 8.1** - Register `textDocument/onTypeFormatting`
    /// capability with trigger character `"\n"`.
    #[test]
    fn test_on_type_formatting_capability_registration() {
        let capability = on_type_formatting_capability();

        // Verify first_trigger_character is "\n"
        assert_eq!(
            capability.first_trigger_character, "\n",
            "first_trigger_character should be newline"
        );

        // Verify more_trigger_character is None
        assert_eq!(
            capability.more_trigger_character, None,
            "more_trigger_character should be None"
        );
    }
}

