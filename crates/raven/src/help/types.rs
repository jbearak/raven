//! Public types for HTML help rendering.

use std::path::PathBuf;

/// Successful HTML help render.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelpHtml {
    /// Canonical topic name (first `\alias` from the Rd object).
    pub topic: String,
    /// Canonical package name. Derived from the help file path
    /// (`basename(dirname(dirname(help_path)))` in `rd_to_html.R`) because
    /// R 4.6+ no longer populates `attr(rd, "package")`.
    pub package: String,
    /// Title from the rendered HTML's first `<h2>`, or canonical topic name.
    pub title: String,
    /// Sanitized + cross-ref-rewritten HTML body.
    pub html: String,
    /// Absolute path to the package's help directory (`system.file("help", ...)`).
    pub help_dir: PathBuf,
    /// All R `.libPaths()` at the time of rendering.
    pub lib_paths: Vec<PathBuf>,
}

/// Failure modes for `get_help_html`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HelpHtmlError {
    /// R returned no Rd db match for `(topic, package)`.
    NotFound,
    /// Package not in any libpath.
    PackageNotInstalled,
    /// Args failed `is_valid_help_topic` / `is_valid_package_name`.
    InvalidTopic { message: String },
    /// `tools::Rd2HTML` errored, sanitization panicked, or metadata parse failed.
    RenderFailed { message: String },
    /// Subprocess exceeded `HELP_TIMEOUT`.
    Timeout,
    /// R binary not configured / not found.
    RUnavailable { message: String },
    /// Stdout exceeded `HELP_HTML_MAX_BYTES`.
    TooLarge,
}

impl std::fmt::Display for HelpHtmlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => write!(f, "no help found for topic"),
            Self::PackageNotInstalled => write!(f, "package not installed"),
            Self::InvalidTopic { message } => write!(f, "invalid topic: {message}"),
            Self::RenderFailed { message } => write!(f, "render failed: {message}"),
            Self::Timeout => write!(f, "R subprocess timed out"),
            Self::RUnavailable { message } => write!(f, "R unavailable: {message}"),
            Self::TooLarge => write!(f, "help output exceeded the size cap"),
        }
    }
}

impl std::error::Error for HelpHtmlError {}

impl HelpHtmlError {
    /// Stable string identifier for the LSP response's `reason` field.
    pub fn reason(&self) -> &'static str {
        match self {
            Self::NotFound => "not-found",
            Self::PackageNotInstalled => "package-not-installed",
            Self::InvalidTopic { .. } => "invalid-topic",
            Self::RenderFailed { .. } => "render-failed",
            Self::Timeout => "timeout",
            Self::RUnavailable { .. } => "r-unavailable",
            Self::TooLarge => "too-large",
        }
    }

    /// Per the spec's classification table: which errors should be cached as
    /// negative entries (and which are transient and should not).
    pub fn is_cacheable(&self) -> bool {
        matches!(
            self,
            Self::NotFound
                | Self::PackageNotInstalled
                | Self::InvalidTopic { .. }
                | Self::RenderFailed { .. }
                | Self::TooLarge
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cacheable_classification() {
        assert!(HelpHtmlError::NotFound.is_cacheable());
        assert!(HelpHtmlError::PackageNotInstalled.is_cacheable());
        assert!(
            HelpHtmlError::InvalidTopic {
                message: "x".into()
            }
            .is_cacheable()
        );
        assert!(
            HelpHtmlError::RenderFailed {
                message: "x".into()
            }
            .is_cacheable()
        );
        assert!(HelpHtmlError::TooLarge.is_cacheable());
        assert!(!HelpHtmlError::Timeout.is_cacheable());
        assert!(
            !HelpHtmlError::RUnavailable {
                message: "x".into()
            }
            .is_cacheable()
        );
    }

    #[test]
    fn reason_strings_match_spec() {
        // Each variant must produce the exact string the webview's
        // `validReasons` set in `editors/vscode/src/help/messages.ts`
        // accepts. A typo here breaks the wire protocol silently.
        assert_eq!(HelpHtmlError::NotFound.reason(), "not-found");
        assert_eq!(
            HelpHtmlError::PackageNotInstalled.reason(),
            "package-not-installed"
        );
        assert_eq!(
            HelpHtmlError::InvalidTopic {
                message: "x".into()
            }
            .reason(),
            "invalid-topic"
        );
        assert_eq!(
            HelpHtmlError::RenderFailed {
                message: "x".into()
            }
            .reason(),
            "render-failed"
        );
        assert_eq!(HelpHtmlError::Timeout.reason(), "timeout");
        assert_eq!(
            HelpHtmlError::RUnavailable {
                message: "x".into()
            }
            .reason(),
            "r-unavailable"
        );
        assert_eq!(HelpHtmlError::TooLarge.reason(), "too-large");
    }
}
