//! Project-level configuration loader (raven.toml, .lintr).

pub mod discovery;
pub mod discovery_load;
pub mod lintr_loader;
pub mod merge;
pub mod overrides;
pub mod toml_loader;

pub use discovery::{DiscoveredConfig, find_config};
pub use discovery_load::{DiscoveredLoad, discover_and_load};
pub use lintr_loader::load as load_lintr;
pub use merge::merge as merge_settings;
pub use overrides::{
    CompiledLintOverride, compile_lint_overrides, is_skipped_by_overrides,
    resolve_lint_for_document,
};
pub use toml_loader::load as load_toml;

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
/// Strip `linting.enabled = "auto"` from a (cloned) project layer so it
/// behaves as if the key were omitted. Without this, the deep merge would
/// overwrite a client-explicit `true`/`false` with the project's `"auto"`
/// and then resolve `Auto → lintr_discovered`, which contradicts the
/// behavior matrix in `docs/linting.md` for `true` + `raven.toml enabled =
/// "auto"`. See #281.
fn strip_project_auto_enabled(project: Option<&serde_json::Value>) -> Option<serde_json::Value> {
    let mut cloned = project.cloned()?;
    if let Some(linting) = cloned.get_mut("linting").and_then(|l| l.as_object_mut())
        && linting.get("enabled") == Some(&serde_json::Value::String("auto".into()))
    {
        linting.remove("enabled");
    }
    Some(cloned)
}

/// Whether a discovered `.lintr` is allowed to auto-enable Raven's native
/// linting, per the client-only `linting.autoEnableFromDotLintr` signal.
///
/// `.lintr` is REditorSupport's / `lintr`'s config file; its mere presence
/// only signals "I want lintr-style linting" in a context where that
/// diagnostic path is actually live. The VS Code client clears this flag to
/// `false` when REditorSupport is installed+enabled with its LSP lint path on
/// (`r.lsp.enabled` and `r.lsp.diagnostics`), or when running inside Positron —
/// contexts where a `.lintr` is dormant config for another tool and must not
/// flip Raven's lints on. See #337.
///
/// Read from the CLIENT layer only: this is a VS Code environment signal and
/// must not be overridable by a project `raven.toml`. Absent or malformed
/// (non-VS-Code clients, older clients, the CLI) defaults to `true`,
/// preserving the historical behavior.
fn lintr_auto_enable_allowed(raw_client: &serde_json::Value) -> bool {
    raw_client
        .get("linting")
        .and_then(|l| l.get("autoEnableFromDotLintr"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

pub fn recompute_parsed_configs(state: &mut crate::state::WorldState) {
    let old_cross_file_config = state.cross_file_config.clone();
    let mut cross_file_config_updated = false;
    let normalized_project = strip_project_auto_enabled(state.raw_project_settings.as_ref());
    let merged = merge_settings(&state.raw_client_settings, normalized_project.as_ref());

    match crate::backend::parse_cross_file_config(&merged) {
        Ok(Some(cfg)) => {
            state.resize_caches(&cfg);
            state.cross_file_config = cfg;
            cross_file_config_updated = true;
        }
        Ok(None) => {
            let cfg = crate::cross_file::CrossFileConfig::default();
            state.resize_caches(&cfg);
            state.cross_file_config = cfg;
            cross_file_config_updated = true;
        }
        Err(err) => {
            log::warn!("recompute_parsed_configs: cross_file validation error: {err}");
        }
    }
    if cross_file_config_updated
        && standalone_scope_cache_config_changed(&old_cross_file_config, &state.cross_file_config)
    {
        state.bump_standalone_scope_package_config_generation();
    }
    state.symbol_config = crate::backend::parse_symbol_config(&merged).unwrap_or_default();
    state.completion_config = crate::backend::parse_completion_config(&merged).unwrap_or_default();
    state.indentation_config =
        crate::backend::parse_indentation_config(&merged).unwrap_or_default();
    let lintr_discovered = state
        .project_config_path
        .as_deref()
        .and_then(|p| p.file_name())
        .map(|n| n == std::ffi::OsStr::new(".lintr"))
        .unwrap_or(false);
    // Gate ONLY the `.lintr` auto-enable path on the client environment signal
    // (#337). An explicit client `on`/`off` and `raven.toml enabled = true`
    // flow through `merged` independently and are unaffected, because they
    // resolve via `On`/`Off` and never route through `lintr_discovered`.
    let lintr_auto = lintr_discovered && lintr_auto_enable_allowed(&state.raw_client_settings);
    state.lint_config = crate::backend::parse_lint_config(&merged, lintr_auto).unwrap_or_default();

    // Recompile per-document lint overrides as part of the centralized
    // recompute. Splitting this into a separate caller step (as earlier
    // versions did) was error-prone — a future caller could call
    // `recompute_parsed_configs` and forget to recompile overrides,
    // leaving them stale relative to the new merged settings. Tying
    // them together here is the per-CLAUDE.md invariant: this function
    // is the only place that writes any parsed config field after a
    // settings change.
    if let Some(root) = state
        .workspace_folders
        .first()
        .and_then(|u| u.to_file_path().ok())
    {
        state.lint_overrides = compile_lint_overrides(&merged, &root);
    } else {
        // No workspace root yet — clear any stale overrides so we don't
        // resolve against patches whose globs were computed against a
        // since-removed root.
        state.lint_overrides = Vec::new();
    }
}

fn standalone_scope_cache_config_changed(
    old: &crate::cross_file::CrossFileConfig,
    new: &crate::cross_file::CrossFileConfig,
) -> bool {
    old.scope_settings_changed(new)
        || old.packages_enabled != new.packages_enabled
        || old.packages_r_path != new.packages_r_path
        || old.packages_additional_library_paths != new.packages_additional_library_paths
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::WorldState;
    use serde_json::json;
    use std::path::PathBuf;

    fn state_with(
        client: serde_json::Value,
        project_config_path: &str,
        project: Option<serde_json::Value>,
    ) -> WorldState {
        let mut state = WorldState::new();
        state.raw_client_settings = client;
        state.raw_project_settings = project;
        state.project_config_path = Some(PathBuf::from(project_config_path));
        state
    }

    #[test]
    fn dot_lintr_auto_enable_gated_off_disables_lint() {
        // #337: a `.lintr` is discovered, but the client signals that
        // REditorSupport's lintr path is live (or we're in Positron). The
        // dormant `.lintr` must not flip Raven's lints on.
        let mut state = state_with(
            json!({ "linting": { "enabled": "auto", "autoEnableFromDotLintr": false } }),
            "/ws/.lintr",
            None,
        );
        recompute_parsed_configs(&mut state);
        assert!(!state.lint_config.enabled);
    }

    #[test]
    fn dot_lintr_auto_enable_allowed_enables_lint() {
        // #337: the signal is present and `true` → historical opt-in survives.
        let mut state = state_with(
            json!({ "linting": { "enabled": "auto", "autoEnableFromDotLintr": true } }),
            "/ws/.lintr",
            None,
        );
        recompute_parsed_configs(&mut state);
        assert!(state.lint_config.enabled);
    }

    #[test]
    fn dot_lintr_auto_enable_absent_defaults_on() {
        // #337: older clients and the CLI omit the signal entirely. Absent
        // defaults to "allowed" so the pre-#337 behavior is preserved.
        let mut state = state_with(
            json!({ "linting": { "enabled": "auto" } }),
            "/ws/.lintr",
            None,
        );
        recompute_parsed_configs(&mut state);
        assert!(state.lint_config.enabled);
    }

    #[test]
    fn dot_lintr_gate_does_not_touch_raven_toml_enabled_true() {
        // #337: the gate is scoped to the `.lintr` discovery branch only. A
        // discovered `raven.toml` with `enabled = true` keeps linting on even
        // when the client clears the `.lintr` signal — that resolves through
        // `On`, never through `lintr_discovered`.
        let mut state = state_with(
            json!({ "linting": { "autoEnableFromDotLintr": false } }),
            "/ws/raven.toml",
            Some(json!({ "linting": { "enabled": true } })),
        );
        recompute_parsed_configs(&mut state);
        assert!(state.lint_config.enabled);
    }

    #[test]
    fn dot_lintr_gate_does_not_override_explicit_client_on() {
        // #337: an explicit client `enabled = "on"` wins regardless of the
        // `.lintr` gate — the gate only governs `Auto` resolution.
        let mut state = state_with(
            json!({ "linting": { "enabled": "on", "autoEnableFromDotLintr": false } }),
            "/ws/.lintr",
            None,
        );
        recompute_parsed_configs(&mut state);
        assert!(state.lint_config.enabled);
    }

    #[test]
    fn lintr_auto_enable_allowed_reads_client_flag() {
        // Explicit false suppresses; explicit true allows.
        assert!(!lintr_auto_enable_allowed(
            &json!({ "linting": { "autoEnableFromDotLintr": false } })
        ));
        assert!(lintr_auto_enable_allowed(
            &json!({ "linting": { "autoEnableFromDotLintr": true } })
        ));
        // Absent (no key, no section, non-VS-Code clients) → allowed.
        assert!(lintr_auto_enable_allowed(&json!({ "linting": {} })));
        assert!(lintr_auto_enable_allowed(&json!({})));
        assert!(lintr_auto_enable_allowed(&serde_json::Value::Null));
        // Malformed (non-bool) → allowed (defensive default).
        assert!(lintr_auto_enable_allowed(
            &json!({ "linting": { "autoEnableFromDotLintr": "no" } })
        ));
    }
}
