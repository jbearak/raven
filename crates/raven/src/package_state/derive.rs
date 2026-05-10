//! The pure derivation function from `PackageInputs` to `PackageState`.
//!
//! See spec §6.

use super::*;
use crate::package_namespace::parse_dcf_field_pub;

pub fn derive_package_state(
    _prev: &PackageState,
    inputs: &PackageInputs,
    _delta: &PackageInputDelta,
) -> PackageState {
    let workspace = effective_workspace(inputs);
    PackageState {
        workspace,
        ..PackageState::default()
    }
}

fn effective_workspace(inputs: &PackageInputs) -> Option<PackageWorkspace> {
    let root = inputs.workspace_root.as_ref()?;
    let parsed_name = inputs
        .description
        .as_ref()
        .and_then(|d| parse_dcf_field_pub(&d.text, "Package"))
        .filter(|s| !s.is_empty());
    match (inputs.package_mode, parsed_name.as_deref()) {
        (PackageMode::Disabled, _) => None,
        (PackageMode::Auto, Some(name)) => Some(PackageWorkspace {
            name: name.to_string(),
            root: root.clone(),
            roxygen_managed: false,
        }),
        (PackageMode::Auto, None) => None,
        (PackageMode::Enabled, Some(name)) => Some(PackageWorkspace {
            name: name.to_string(),
            root: root.clone(),
            roxygen_managed: false,
        }),
        (PackageMode::Enabled, None) => Some(PackageWorkspace {
            name: "unknown".to_string(),
            root: root.clone(),
            roxygen_managed: false,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_inputs(mode: PackageMode) -> PackageInputs {
        PackageInputs {
            workspace_root: Some("/work/pkg".into()),
            package_mode: mode,
            description: None,
            namespace: None,
            r_files: BTreeMap::new(),
        }
    }

    fn with_description(mode: PackageMode, text: &str) -> PackageInputs {
        let mut i = empty_inputs(mode);
        i.description = Some(DescriptionInput {
            path: "/work/pkg/DESCRIPTION".into(),
            text: text.into(),
        });
        i
    }

    #[test]
    fn disabled_mode_yields_no_workspace() {
        let s = derive_package_state(
            &PackageState::default(),
            &with_description(PackageMode::Disabled, "Package: foo\n"),
            &PackageInputDelta::Initial,
        );
        assert!(s.workspace.is_none());
    }

    #[test]
    fn auto_with_no_description_yields_no_workspace() {
        let s = derive_package_state(
            &PackageState::default(),
            &empty_inputs(PackageMode::Auto),
            &PackageInputDelta::Initial,
        );
        assert!(s.workspace.is_none());
    }

    #[test]
    fn auto_with_description_yields_workspace() {
        let s = derive_package_state(
            &PackageState::default(),
            &with_description(PackageMode::Auto, "Package: foo\n"),
            &PackageInputDelta::Initial,
        );
        assert_eq!(s.workspace.as_ref().unwrap().name, "foo");
    }

    #[test]
    fn enabled_with_no_description_synthesizes_unknown() {
        let s = derive_package_state(
            &PackageState::default(),
            &empty_inputs(PackageMode::Enabled),
            &PackageInputDelta::Initial,
        );
        assert_eq!(s.workspace.as_ref().unwrap().name, "unknown");
    }

    #[test]
    fn enabled_with_invalid_description_synthesizes_unknown() {
        let s = derive_package_state(
            &PackageState::default(),
            &with_description(PackageMode::Enabled, "no Package field here\n"),
            &PackageInputDelta::Initial,
        );
        assert_eq!(s.workspace.as_ref().unwrap().name, "unknown");
    }
}
