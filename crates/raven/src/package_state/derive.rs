//! The pure derivation function from `PackageInputs` to `PackageState`.
//!
//! See spec §6.

use super::*;
use crate::package_namespace::parse_dcf_field_pub;

pub fn derive_package_state(
    prev: &PackageState,
    inputs: &PackageInputs,
    _delta: &PackageInputDelta,
) -> PackageState {
    let workspace = effective_workspace(inputs);
    let r_file_facts = derive_r_file_facts(&prev.r_file_facts, &inputs.r_files);
    let namespace_model = if workspace.is_some() {
        Some(merge_namespace_model(inputs.namespace.as_ref(), &r_file_facts))
    } else {
        None
    };
    PackageState {
        workspace,
        namespace_model,
        r_file_facts,
        ..PackageState::default()
    }
}

fn merge_namespace_model(
    namespace: Option<&NamespaceInput>,
    r_file_facts: &BTreeMap<PathBuf, RFileFacts>,
) -> PackageNamespaceModel {
    let mut model = match namespace {
        Some(ns) => crate::package_namespace::namespace_model_from_content(&ns.text),
        None => PackageNamespaceModel::default(),
    };
    // Union roxygen-derived imports/exports from R/ source files.
    // (We don't filter by `kind == Source` here yet — Task 2.9 covers that
    // via `scope_contribution`. Roxygen tags from any tracked file
    // contribute to the namespace model since R's namespace is package-wide.)
    for (_, facts) in r_file_facts {
        for sym in &facts.roxygen_namespace.exports {
            if !model.exports.contains(sym) {
                model.exports.insert(sym.clone());
            }
        }
        // RoxygenNamespace::import_from → PackageNamespaceModel::imports (Vec<(pkg, sym)>)
        for (pkg, sym) in &facts.roxygen_namespace.import_from {
            if !model.imports.iter().any(|(p, s)| p == pkg && s == sym) {
                model.imports.push((pkg.clone(), sym.clone()));
            }
        }
        // RoxygenNamespace::imports (full package imports) → PackageNamespaceModel::full_imports
        for pkg in &facts.roxygen_namespace.imports {
            if !model.full_imports.contains(pkg) {
                model.full_imports.push(pkg.clone());
            }
        }
    }
    model
}

fn derive_r_file_facts(
    prev: &BTreeMap<PathBuf, RFileFacts>,
    inputs: &BTreeMap<PathBuf, RFileInput>,
) -> BTreeMap<PathBuf, RFileFacts> {
    let mut out = BTreeMap::new();
    for (path, file) in inputs {
        let reuse = prev
            .get(path)
            .filter(|cached| cached.content_digest == file.content_digest);
        let facts = match reuse {
            Some(cached) => cached.clone(),
            None => RFileFacts {
                roxygen_namespace: crate::roxygen::extract_roxygen_namespace_tags(&file.text),
                top_level_defs: Arc::new(crate::roxygen::extract_top_level_defs(&file.text)),
                content_digest: file.content_digest,
            },
        };
        out.insert(path.clone(), facts);
    }
    out
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

    #[test]
    fn memoization_reuses_cached_facts_on_unchanged_content() {
        let path: PathBuf = "/work/pkg/R/foo.R".into();
        let text: Arc<str> = "foo <- function() 1\n".into();
        let digest = ContentDigest::of(&text);
        let mut inputs = with_description(PackageMode::Auto, "Package: foo\n");
        inputs.r_files.insert(path.clone(), RFileInput {
            kind: RFileKind::Source,
            origin: ContentOrigin::Disk,
            text: text.clone(),
            content_digest: digest,
        });
        let s1 = derive_package_state(&PackageState::default(), &inputs, &PackageInputDelta::Initial);
        let s2 = derive_package_state(&s1, &inputs, &PackageInputDelta::Initial);
        let f1 = s1.r_file_facts.get(&path).unwrap();
        let f2 = s2.r_file_facts.get(&path).unwrap();
        assert!(std::sync::Arc::ptr_eq(&f1.top_level_defs, &f2.top_level_defs));
    }

    #[test]
    fn memoization_recomputes_on_content_change() {
        let path: PathBuf = "/work/pkg/R/foo.R".into();
        let text1: Arc<str> = "foo <- function() 1\n".into();
        let text2: Arc<str> = "foo <- function() 2\n".into();
        let mut inputs = with_description(PackageMode::Auto, "Package: foo\n");
        inputs.r_files.insert(path.clone(), RFileInput {
            kind: RFileKind::Source,
            origin: ContentOrigin::Disk,
            text: text1.clone(),
            content_digest: ContentDigest::of(&text1),
        });
        let s1 = derive_package_state(&PackageState::default(), &inputs, &PackageInputDelta::Initial);
        let entry = inputs.r_files.get_mut(&path).unwrap();
        entry.text = text2.clone();
        entry.content_digest = ContentDigest::of(&text2);
        let s2 = derive_package_state(&s1, &inputs, &PackageInputDelta::Initial);
        let f1 = s1.r_file_facts.get(&path).unwrap();
        let f2 = s2.r_file_facts.get(&path).unwrap();
        assert!(!std::sync::Arc::ptr_eq(&f1.top_level_defs, &f2.top_level_defs));
    }

    #[test]
    fn merge_unions_namespace_and_roxygen() {
        let path: PathBuf = "/work/pkg/R/foo.R".into();
        let text: Arc<str> = "#' @importFrom dplyr filter\nfoo <- function() 1\n".into();
        let mut inputs = with_description(PackageMode::Auto, "Package: foo\n");
        inputs.namespace = Some(NamespaceInput {
            path: "/work/pkg/NAMESPACE".into(),
            text: "importFrom(dplyr, mutate)\nimport(magrittr)\n".into(),
        });
        inputs.r_files.insert(path, RFileInput {
            kind: RFileKind::Source,
            origin: ContentOrigin::Disk,
            text: text.clone(),
            content_digest: ContentDigest::of(&text),
        });
        let s = derive_package_state(&PackageState::default(), &inputs, &PackageInputDelta::Initial);
        let m = s.namespace_model.unwrap();
        assert!(m.imports.iter().any(|(p, n)| p == "dplyr" && n == "filter"), "missing roxygen filter: {:?}", m);
        assert!(m.imports.iter().any(|(p, n)| p == "dplyr" && n == "mutate"), "missing NAMESPACE mutate: {:?}", m);
        assert!(m.full_imports.iter().any(|p| p == "magrittr"), "missing magrittr: {:?}", m);
    }
}
