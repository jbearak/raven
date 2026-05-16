//! Project-level configuration loader (raven.toml, .lintr).

pub mod discovery;
pub mod lintr_loader;
pub mod merge;
pub mod overrides;
pub mod toml_loader;

pub use discovery::{find_config, DiscoveredConfig};
pub use lintr_loader::{load as load_lintr, load_str as load_lintr_str, LoadedLintr};
pub use merge::merge as merge_settings;
pub use overrides::{
    compile_lint_overrides, is_skipped_by_overrides, resolve_lint_for_document,
    CompiledLintOverride,
};
pub use toml_loader::{load as load_toml, load_str as load_toml_str, LoadedToml};

/// Re-run every `parse_*_config` over the merged `(client, project)` JSON
/// and overwrite the parsed configs on `state`. Idempotent.
///
/// Resets each parsed config to its struct default when the corresponding
/// section is absent in the merged JSON. This matches the spec's layered
/// precedence: built-in defaults are the floor; client-supplied settings
/// and project-supplied settings layer on top. Both layers being silent on
/// a section means "fall to default", not "preserve whatever was there".
///
/// One exception: `parse_cross_file_config` returns `Ok(None)` when ALL of
/// `crossFile`, `diagnostics`, `packages` are absent — in that case we still
/// overwrite with `CrossFileConfig::default()`. A validation error
/// (`Err(...)`) is logged and the existing config is preserved (best-effort
/// graceful degradation; same as the existing behavior at
/// `backend.rs:3819-3838`).
///
/// Callers: `backend::initialize`, `backend::did_change_configuration`,
/// `backend::did_change_watched_files` (project-config change).
pub fn recompute_parsed_configs(state: &mut crate::state::WorldState) {
    let merged = merge_settings(&state.raw_client_settings, state.raw_project_settings.as_ref());

    match crate::backend::parse_cross_file_config(&merged) {
        Ok(Some(cfg)) => {
            state.resize_caches(&cfg);
            state.cross_file_config = cfg;
        }
        Ok(None) => {
            let cfg = crate::cross_file::CrossFileConfig::default();
            state.resize_caches(&cfg);
            state.cross_file_config = cfg;
        }
        Err(err) => {
            log::warn!("recompute_parsed_configs: cross_file validation error: {err}");
        }
    }
    state.symbol_config = crate::backend::parse_symbol_config(&merged).unwrap_or_default();
    state.completion_config =
        crate::backend::parse_completion_config(&merged).unwrap_or_default();
    state.indentation_config =
        crate::backend::parse_indentation_config(&merged).unwrap_or_default();
    state.lint_config = crate::backend::parse_lint_config(&merged).unwrap_or_default();
}
