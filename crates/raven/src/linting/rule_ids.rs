//! Stable rule identifiers for lint diagnostics.
//!
//! Each constant matches the rule name accepted by `# nolint: <rule>` markers
//! (see `docs/linting.md`). The strings are emitted as `Diagnostic.code` so the
//! `raven lint` CLI and SARIF output can map diagnostics back to rules.

pub const LINE_LENGTH: &str = "line_length";
pub const TRAILING_WHITESPACE: &str = "trailing_whitespace";
pub const NO_TAB: &str = "no_tab";
pub const TRAILING_BLANK_LINES: &str = "trailing_blank_lines";
pub const ASSIGNMENT_OPERATOR: &str = "assignment_operator";
pub const OBJECT_NAME: &str = "object_name";
pub const INFIX_SPACES: &str = "infix_spaces";
pub const COMMENTED_CODE: &str = "commented_code";
pub const QUOTES: &str = "quotes";
pub const COMMAS: &str = "commas";
pub const T_AND_F_SYMBOL: &str = "t_and_f_symbol";
pub const SEMICOLON: &str = "semicolon";
pub const EQUALS_NA: &str = "equals_na";
pub const OBJECT_LENGTH: &str = "object_length";
pub const VECTOR_LOGIC: &str = "vector_logic";
pub const FUNCTION_LEFT_PARENTHESES: &str = "function_left_parentheses";
pub const SPACES_INSIDE: &str = "spaces_inside";
pub const INDENTATION: &str = "indentation";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rule_ids_are_non_empty_and_unique() {
        let ids = [
            LINE_LENGTH, TRAILING_WHITESPACE, NO_TAB, TRAILING_BLANK_LINES,
            ASSIGNMENT_OPERATOR, OBJECT_NAME, INFIX_SPACES, COMMENTED_CODE,
            QUOTES, COMMAS, T_AND_F_SYMBOL, SEMICOLON, EQUALS_NA,
            OBJECT_LENGTH, VECTOR_LOGIC, FUNCTION_LEFT_PARENTHESES,
            SPACES_INSIDE, INDENTATION,
        ];
        for id in ids {
            assert!(!id.is_empty(), "rule id must be non-empty");
        }
        let mut sorted: Vec<&str> = ids.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), ids.len(), "rule ids must be unique");
    }
}
