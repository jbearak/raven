//! Project-level configuration loader (raven.toml, .lintr).

pub mod discovery;
pub mod toml_loader;

pub use discovery::{find_config, DiscoveredConfig};
pub use toml_loader::{load as load_toml, load_str as load_toml_str, LoadedToml};

/// Placeholder until Task 5 lands the real type.
#[derive(Debug, Clone)]
pub struct CompiledLintOverride {
    pub _placeholder: (),
}
