//! R help text and HTML rendering.
//!
//! - `text` — plain Rd2txt rendering used by hover/completion.
//! - (more modules added in subsequent tasks: `html`, `sanitize`, `rewrite`, `cache`, `validate`.)

mod text;

pub use text::*;
