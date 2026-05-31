// cli/mod.rs — CLI subcommands for Raven
//
// This module contains non-LSP CLI commands like `analysis-stats`, `lint`, and
// `check`. `shared` holds the output formatting + severity gating both `lint`
// and `check` render with.

pub mod analysis_stats;
pub mod check;
pub mod lint;
pub mod packages;
pub mod shared;
