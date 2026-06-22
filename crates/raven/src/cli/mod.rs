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

/// Map a top-level CLI token to the `packages` subcommand it aliases, if any.
/// `raven freeze ARGS` ≡ `raven packages freeze ARGS`; `raven fetch ARGS` ≡
/// `raven packages fetch ARGS`. Only these two are aliased (§6); `update` /
/// `build-shipped-db` stay nested. Returns the token unchanged (it is already
/// the subcommand `packages::run` expects as its first arg) so the caller can
/// delegate the full arg vector with no rewriting.
pub fn packages_top_level_alias(token: &str) -> Option<&'static str> {
    match token {
        "freeze" => Some("freeze"),
        "fetch" => Some("fetch"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packages_top_level_alias_recognizes_freeze_and_fetch() {
        assert_eq!(packages_top_level_alias("freeze"), Some("freeze"));
        assert_eq!(packages_top_level_alias("fetch"), Some("fetch"));
        assert_eq!(packages_top_level_alias("update"), None);
        assert_eq!(packages_top_level_alias("build-shipped-db"), None);
        assert_eq!(packages_top_level_alias("check"), None);
        assert_eq!(packages_top_level_alias("lint"), None);
        assert_eq!(packages_top_level_alias(""), None);
    }

    #[tokio::test]
    async fn packages_run_help_via_alias_argv_matches_nested() {
        // The alias `raven fetch --help` passes ["fetch", "--help"] to packages::run.
        // The nested `raven packages fetch --help` also passes ["fetch", "--help"] after skip(1).
        // Both must be handled directly by packages::run.
        let result = packages::run(["fetch", "--help"].into_iter().map(String::from)).await;
        assert_eq!(result, Ok(()));

        let result = packages::run(["freeze", "--help"].into_iter().map(String::from)).await;
        assert_eq!(result, Ok(()));
    }
}
