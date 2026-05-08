//! R help text and HTML rendering.
//!
//! - `text` — plain Rd2txt rendering used by hover/completion.
//! - `validate` — input validation for help topic names.

mod text;
mod validate;

pub use text::*;
pub use validate::is_valid_help_topic;
