//! Individual lint rules.
//!
//! Each rule is a small module exposing a `collect(...)` function that pushes
//! diagnostics into a `&mut Vec<Diagnostic>`. Rules consult the shared
//! [`crate::linting::nolint::Suppressions`] before producing output.

pub(crate) mod assignment_operator;
pub(crate) mod line_length;
pub(crate) mod no_tab;
pub(crate) mod trailing_blank_lines;
pub(crate) mod trailing_whitespace;
