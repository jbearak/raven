//! Individual lint rules.
//!
//! Each rule is a small module exposing a `collect(...)` function that pushes
//! diagnostics into a `&mut Vec<Diagnostic>`. Rules consult the shared
//! [`crate::linting::nolint::Suppressions`] before producing output.

pub(crate) mod assignment_operator;
pub(crate) mod commas;
pub(crate) mod commented_code;
pub(crate) mod equals_na;
pub(crate) mod function_left_parentheses;
pub(crate) mod indentation;
pub(crate) mod infix_spaces;
pub(crate) mod line_length;
pub(crate) mod no_tab;
pub(crate) mod object_length;
pub(crate) mod object_name;
pub(crate) mod quotes;
pub(crate) mod semicolon;
pub(crate) mod spaces_inside;
pub(crate) mod t_and_f_symbol;
pub(crate) mod trailing_blank_lines;
pub(crate) mod trailing_whitespace;
pub(crate) mod vector_logic;
