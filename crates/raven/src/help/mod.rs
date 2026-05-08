//! R help text and HTML rendering.
//!
//! - `text` — plain Rd2txt rendering used by hover/completion.
//! - `html` — HTML rendering via R subprocess (`tools::Rd2HTML`).
//! - `validate` — input validation for help topic names.

mod cache;
mod html;
mod rewrite;
mod sanitize;
mod text;
mod types;
mod validate;

pub use cache::HtmlHelpCache;
pub use html::get_help_html;
pub use text::*;
pub use types::{HelpHtml, HelpHtmlError};
pub use validate::is_valid_help_topic;
