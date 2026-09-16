//! Static inputs for qualified box imports. No R code is executed.
//!
//! A context is captured under the state lock and resolved off-lock once per
//! detached operation. Its shared cell avoids parsing `.Rprofile` for every
//! imported module. Unknown writes deliberately block lower-priority inference.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use tree_sitter::Node;

use crate::cross_file::binding::{
    extract_plain_string, plain_argument_name, plain_identifier_name,
};
use crate::cross_file::static_path::StaticBindings;

/// Absent/reset, statically known, or unknowable input. Empty known lists are
/// distinct from absent values: Rhino sets its default only for absent values.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum SearchPaths {
    #[default]
    Absent,
    Known(Vec<PathBuf>),
    Unknown,
}

impl SearchPaths {
    /// Read the inherited environment exactly when the server/CLI state starts.
    pub(crate) fn startup() -> Self {
        match (std::env::var("R_BOX_PATH"), std::env::current_dir()) {
            (Ok(value), Ok(cwd)) => {
                split_environment(&value, if cfg!(windows) { ';' } else { ':' }, &cwd)
            }
            (Err(std::env::VarError::NotPresent), _) => Self::Absent,
            _ => Self::Unknown,
        }
    }

    /// Project-only override. The configuration file, not the current script,
    /// anchors relative entries. Malformed explicit values fail closed.
    pub(crate) fn project(settings: Option<&serde_json::Value>, config: Option<&Path>) -> Self {
        let Some(value) = settings
            .and_then(|v| v.get("box"))
            .and_then(|v| v.get("searchPaths"))
        else {
            return Self::Absent;
        };
        let Some(base) = config.and_then(Path::parent) else {
            return Self::Unknown;
        };
        let Some(paths) = value.as_array().and_then(|values| {
            values
                .iter()
                .map(|value| value.as_str().map(|path| anchor(base, path)))
                .collect()
        }) else {
            log::warn!("raven.toml: box.searchPaths must be an array of strings");
            return Self::Unknown;
        };
        Self::Known(paths)
    }
}

fn split_environment(value: &str, separator: char, cwd: &Path) -> SearchPaths {
    if value.is_empty() {
        return SearchPaths::Absent;
    }
    // R's strsplit drops the final empty entry, retaining leading/interior
    // empty entries. split_paths has different quoting/trailing-empty rules.
    SearchPaths::Known(
        value
            .split_terminator(separator)
            .map(|path| anchor(cwd, path))
            .collect(),
    )
}

fn anchor(base: &Path, value: &str) -> PathBuf {
    crate::cross_file::path_resolve::normalize_path_public(&base.join(value))
        .unwrap_or_else(|| base.join(value))
}

/// Owned inputs for detached resolution. Defaults preserve Rhino inference for
/// callers without project context (including isolated parser/resolver tests).
#[derive(Clone, Debug, Default)]
pub(crate) struct SearchPathContext {
    generation: (u64, u64),
    override_paths: SearchPaths,
    profile: Option<(PathBuf, Option<ropey::Rope>)>,
    resolved: Arc<OnceLock<SearchPaths>>,
}

impl SearchPathContext {
    pub(crate) fn new(
        project: &SearchPaths,
        startup: &SearchPaths,
        profile: Option<(PathBuf, Option<ropey::Rope>)>,
    ) -> Self {
        Self {
            generation: (0, 0),
            override_paths: if *project == SearchPaths::Absent {
                startup.clone()
            } else {
                project.clone()
            },
            profile,
            resolved: Arc::default(),
        }
    }

    pub(crate) fn with_generation(mut self, generation: (u64, u64)) -> Self {
        self.generation = generation;
        self
    }

    pub(crate) fn same_inputs(&self, other: &Self) -> bool {
        self.generation == other.generation
            && self.override_paths == other.override_paths
            && match (&self.profile, &other.profile) {
                (None, None) => true,
                (Some((left, a)), Some((right, b))) => {
                    left == right
                        && match (a, b) {
                            (None, None) => true,
                            (Some(a), Some(b)) => a.is_instance(b),
                            _ => false,
                        }
                }
                _ => false,
            }
    }

    /// Override the captured profile for an edit that has not been installed
    /// yet. The caller's transaction token guards the resulting metadata.
    pub(crate) fn with_profile_text(mut self, text: ropey::Rope) -> Self {
        if let Some((_, current)) = &mut self.profile {
            *current = Some(text);
            self.resolved = Arc::default();
        }
        self
    }

    /// Performs disk I/O only for a closed project profile. Call only off-lock.
    pub(crate) fn paths(&self) -> &SearchPaths {
        self.resolved.get_or_init(|| {
            if self.override_paths != SearchPaths::Absent {
                return self.override_paths.clone();
            }
            let Some((path, text)) = &self.profile else {
                return SearchPaths::Absent;
            };
            let text = match text {
                Some(text) => text.to_string(),
                None => match crate::state::read_source(path) {
                    Ok(text) => text,
                    Err(crate::state::SourceReadError::Io(error))
                        if error.kind() == std::io::ErrorKind::NotFound =>
                    {
                        return SearchPaths::Absent;
                    }
                    Err(_) => return SearchPaths::Unknown,
                },
            };
            scan_profile(&text, path.parent().expect("profile path has a parent"))
        })
    }
}

/// Deliberately smaller than the suppressive scope-prelude scan: only direct,
/// unconditional calls establish values. Conditional writes invalidate values;
/// function bodies and quoted expressions never execute during this scan.
pub(crate) fn scan_profile(text: &str, root: &Path) -> SearchPaths {
    crate::parser_pool::with_parser(|parser| {
        let Some(tree) = parser.parse(text, None) else {
            return SearchPaths::Unknown;
        };
        if tree.root_node().has_error() {
            return SearchPaths::Unknown;
        }
        let bindings = StaticBindings::collect(tree.root_node(), text);
        let mut paths = SearchPaths::Absent;
        visit(tree.root_node(), text, root, &bindings, true, &mut paths);
        paths
    })
}

/// Match namespace fields, not source spelling: whitespace/backticks are legal.
fn call_named(node: Node, text: &str, name: &str) -> Option<bool> {
    let function = node.child_by_field_name("function")?;
    if plain_identifier_name(function, text) == Some(name) {
        return Some(false);
    }
    if function.kind() == "namespace_operator"
        && function
            .child_by_field_name("operator")
            .is_some_and(|op| &text[op.byte_range()] == "::")
        && function
            .child_by_field_name("lhs")
            .and_then(|lhs| plain_identifier_name(lhs, text))
            == Some("base")
        && function
            .child_by_field_name("rhs")
            .and_then(|rhs| plain_identifier_name(rhs, text))
            == Some(name)
    {
        return Some(true);
    }
    None
}

fn base_call(node: Node, text: &str, bindings: &StaticBindings<'_, '_>, name: &str) -> bool {
    call_named(node, text, name).is_some_and(|qualified| {
        qualified || !bindings.named_binding_may_shadow_at(name, node, false)
    })
}

fn literal_string(node: Node, text: &str) -> Option<String> {
    (node.kind() == "string")
        .then(|| extract_plain_string(node, text))
        .flatten()
}

fn visit(
    node: Node,
    text: &str,
    root: &Path,
    bindings: &StaticBindings<'_, '_>,
    unconditional: bool,
    paths: &mut SearchPaths,
) {
    if node.kind() == "function_definition" {
        return;
    }
    if node.kind() == "call" {
        if let Some(kind) = crate::cross_file::binding::capturing_call_kind(node, text, |name| {
            !bindings.named_binding_may_shadow_at(name, node, false)
        }) {
            // Captured syntax is inert, but bquote splices and environment
            // controls can write options even in another evaluation frame.
            crate::cross_file::binding::visit_evaluated_capture_parts_for_invalidation(
                node,
                text,
                kind,
                &mut |part, _, _, _| {
                    visit(part, text, root, bindings, false, paths);
                },
            );
            return;
        }
        if call_named(node, text, "options").is_some() {
            if let Some(arguments) = node.child_by_field_name("arguments") {
                let args: Vec<_> = arguments
                    .named_children(&mut arguments.walk())
                    .filter(|n| n.kind() == "argument")
                    .collect();
                if has_missing_arguments(arguments, &args)
                    || args.iter().any(|arg| {
                        arg.child_by_field_name("name").is_none()
                            && arg
                                .child_by_field_name("value")
                                .is_none_or(|value| literal_string(value, text).is_none())
                    })
                {
                    // Missing actuals or a computed/list setter cannot establish
                    // a path, even if a named literal appears later in the call.
                    *paths = SearchPaths::Unknown;
                    return;
                }
                for argument in args {
                    if argument
                        .child_by_field_name("name")
                        .and_then(|n| plain_argument_name(n, text))
                        .as_deref()
                        == Some("box.path")
                    {
                        *paths = if unconditional && base_call(node, text, bindings, "options") {
                            argument
                                .child_by_field_name("value")
                                .map(|value| literal_paths(value, text, root, bindings))
                                .unwrap_or(SearchPaths::Unknown)
                        } else {
                            SearchPaths::Unknown
                        };
                    } else if let Some(value) = argument.child_by_field_name("value") {
                        visit(value, text, root, bindings, false, paths);
                    }
                }
            }
            return;
        }
    }
    // Only program/braced statement sequences retain unconditional execution.
    // Descendants of arbitrary expressions can invalidate, never establish.
    let unconditional = unconditional && matches!(node.kind(), "program" | "brace_list");
    for child in node.named_children(&mut node.walk()) {
        visit(child, text, root, bindings, unconditional, paths);
    }
}

fn has_missing_arguments(arguments: Node, args: &[Node]) -> bool {
    let commas = arguments
        .children(&mut arguments.walk())
        .filter(|n| n.kind() == "comma")
        .count();
    (args.is_empty() && commas != 0)
        || (!args.is_empty() && commas + 1 != args.len())
        || args
            .iter()
            .any(|arg| arg.child_by_field_name("value").is_none())
}

fn literal_paths(
    node: Node,
    text: &str,
    root: &Path,
    bindings: &StaticBindings<'_, '_>,
) -> SearchPaths {
    if &text[node.byte_range()] == "NULL" {
        return SearchPaths::Absent;
    }
    if let Some(value) = literal_string(node, text) {
        return SearchPaths::Known(vec![anchor(root, &value)]);
    }
    if node.kind() != "call" {
        return SearchPaths::Unknown;
    }
    let Some(arguments) = node.child_by_field_name("arguments") else {
        return SearchPaths::Unknown;
    };
    let args: Vec<_> = arguments
        .named_children(&mut arguments.walk())
        .filter(|n| n.kind() == "argument")
        .collect();
    if has_missing_arguments(arguments, &args) {
        return SearchPaths::Unknown;
    }
    if base_call(node, text, bindings, "character")
        && args.len() == 1
        && args[0].child_by_field_name("name").is_none()
        && args[0]
            .child_by_field_name("value")
            .is_some_and(|value| matches!(&text[value.byte_range()], "0" | "0L"))
    {
        return SearchPaths::Known(Vec::new());
    }
    if !base_call(node, text, bindings, "c") {
        return SearchPaths::Unknown;
    }
    if args.is_empty() {
        return SearchPaths::Absent;
    }
    let Some(values) = args
        .into_iter()
        .map(|arg| {
            if arg
                .child_by_field_name("name")
                .and_then(|name| plain_argument_name(name, text))
                .is_some_and(|name| matches!(name.as_ref(), "use.names" | "recursive"))
            {
                return None;
            }
            let value = arg.child_by_field_name("value")?;
            literal_string(value, text).map(|value| anchor(root, &value))
        })
        .collect::<Option<Vec<_>>>()
    else {
        return SearchPaths::Unknown;
    };
    SearchPaths::Known(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_order_reset_and_unknown() {
        let root = Path::new("/project");
        assert_eq!(
            scan_profile("options(box.path=c('modules', '../shared'))", root),
            SearchPaths::Known(vec![root.join("modules"), PathBuf::from("/shared")])
        );
        for suffix in [
            "options(box.path = compute())",
            "if (flag) options(box.path='new')",
        ] {
            assert_eq!(
                scan_profile(&format!("options(box.path='old'); {suffix}"), root),
                SearchPaths::Unknown
            );
        }
        assert_eq!(
            scan_profile(
                "options(box.path=compute()); base::options(box.path='new')",
                root
            ),
            SearchPaths::Known(vec![root.join("new")])
        );
        assert_eq!(
            scan_profile("options(box.path='old'); options(box.path=NULL)", root),
            SearchPaths::Absent
        );
        assert_eq!(
            scan_profile("options(box.path=character(0))", root),
            SearchPaths::Known(vec![])
        );
        assert_eq!(
            scan_profile(
                "f <- function() options(box.path='ignored'); quote(options(box.path='ignored'))",
                root
            ),
            SearchPaths::Absent
        );
    }

    #[test]
    fn masked_helpers_are_unknown_but_qualified_calls_work() {
        let root = Path::new("/project");
        for text in [
            "options <- f; options(box.path='mod')",
            "c <- f; options(box.path=c('mod'))",
            "character <- f; options(box.path=character(0))",
        ] {
            assert_eq!(scan_profile(text, root), SearchPaths::Unknown, "{text}");
        }
        assert_eq!(
            scan_profile(
                "options <- f; c <- f; base::options(box.path=base::c('mod'))",
                root
            ),
            SearchPaths::Known(vec![root.join("mod")])
        );
    }

    #[test]
    fn literal_scanner_rejects_computation_and_missing_arguments() {
        let root = Path::new("/project");
        for text in [
            "options(box.path='mods',)",
            "options(box.path=c('mods', use.names='bogus'))",
            "options(box.path=c('mods', recursive='bogus'))",
            "options(box.path='mods'); bquote(.(options(box.path='other')))",
            "options(box.path='mods'); substitute(x, options(box.path='other'))",
            "options(box.path='mods'); bquote(list(..(options(box.path='other'))), splice=dynamic())",
        ] {
            assert_eq!(scan_profile(text, root), SearchPaths::Unknown, "{text}");
        }

        for expression in [
            "'mods' %||% 'other'",
            "c('mods',)",
            "c(, 'mods')",
            "character(0,)",
        ] {
            assert_eq!(
                scan_profile(&format!("options(box.path={expression})"), root),
                SearchPaths::Unknown,
                "{expression}"
            );
        }
        assert_eq!(
            scan_profile(
                "options(box.path='old'); base :: options(box.path=dynamic())",
                root
            ),
            SearchPaths::Unknown
        );
        assert_eq!(
            scan_profile("base :: `options`(box.path=base :: c('mods'))", root),
            SearchPaths::Known(vec![root.join("mods")])
        );
        for text in [
            "f <- function() { options <- identity }; options(box.path='mods')",
            "options(box.path='mods'); options <- identity",
            "options(box.path=c('mods')); c <- identity",
        ] {
            assert_eq!(
                scan_profile(text, root),
                SearchPaths::Known(vec![root.join("mods")]),
                "{text}"
            );
        }
    }

    #[test]
    fn context_precedence_and_empty_values() {
        let root = Path::new("/project");
        let profile = || {
            Some((
                root.join(".Rprofile"),
                Some(ropey::Rope::from_str("options(box.path='profile')")),
            ))
        };
        let config = SearchPaths::Known(vec![root.join("config")]);
        let env = SearchPaths::Known(vec![root.join("env")]);
        for (project, startup, expected) in [
            (config.clone(), env.clone(), config),
            (SearchPaths::Absent, env.clone(), env),
            (
                SearchPaths::Absent,
                SearchPaths::Absent,
                SearchPaths::Known(vec![root.join("profile")]),
            ),
            (
                SearchPaths::Known(vec![]),
                SearchPaths::Unknown,
                SearchPaths::Known(vec![]),
            ),
            (
                SearchPaths::Unknown,
                SearchPaths::Absent,
                SearchPaths::Unknown,
            ),
        ] {
            assert_eq!(
                SearchPathContext::new(&project, &startup, profile()).paths(),
                &expected
            );
        }
        for (text, expected) in [
            ("options(box.path=character(0))", SearchPaths::Known(vec![])),
            ("options(box.path=NULL)", SearchPaths::Absent),
            ("options(box.path=dynamic())", SearchPaths::Unknown),
        ] {
            assert_eq!(
                SearchPathContext::new(
                    &SearchPaths::Absent,
                    &SearchPaths::Absent,
                    Some((root.join(".Rprofile"), Some(ropey::Rope::from_str(text))))
                )
                .paths(),
                &expected
            );
        }
    }

    #[test]
    fn environment_empty_components_match_r() {
        let cwd = Path::new("/cwd");
        assert_eq!(split_environment("", ':', cwd), SearchPaths::Absent);
        assert_eq!(
            split_environment(":a::", ':', cwd),
            SearchPaths::Known(vec![cwd.into(), cwd.join("a"), cwd.into()])
        );
        assert_eq!(
            split_environment("a:", ':', cwd),
            SearchPaths::Known(vec![cwd.join("a")])
        );
        assert_eq!(
            split_environment("C:/mod;D:/shared;", ';', Path::new("")),
            SearchPaths::Known(vec![PathBuf::from("C:/mod"), PathBuf::from("D:/shared")])
        );
    }
}
