//! Static R6 method environments, separate from file exports and method locals.
//!
//! Facts retain declarations, never syntax trees. Resolution follows superclass
//! binding provenance in the completed creator environment, once per class in a
//! scope stream. Shared member layers avoid copying a superclass for each method.
//! Unknown creators, dynamic inheritance, cycles, and budgets grant no guessed
//! names; independently proven own members remain available.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use tower_lsp::lsp_types::Url;
use tree_sitter::Node;

use super::{
    FunctionScopeInterval, LineIndex, Position, ScopeAtPosition, ScopeEvent, ScopedSymbol,
    SymbolKind,
};
use crate::cross_file::binding::{
    CallActual, CallMatchMode, match_call_arguments, plain_argument_name, plain_identifier_name,
};
use crate::cross_file::static_path::LazyStaticBindings;

const FORMALS: &[&str] = &[
    "classname",
    "public",
    "private",
    "active",
    "inherit",
    "lock_objects",
    "class",
    "portable",
    "lock_class",
    "cloneable",
    "parent_env",
];
const MAX_INHERITANCE_DEPTH: usize = 32;
const MAX_MEMBERS: usize = 4096;

/// Compact R6 declarations retained with a file's authoritative scope facts.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct FileFacts {
    classes: Vec<Class>,
    exported_classes: BTreeMap<Arc<str>, usize>,
    // Compact declarations cannot reconstruct these creator-environment effects.
    requires_creator_context: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Class {
    uri: Url,
    binding: Option<(Arc<str>, Position)>,
    top_level: bool,
    bare_constructor: bool,
    nonportable: bool,
    inherit: Option<Arc<str>>,
    inherit_range: Option<(Position, Position)>,
    default_parent: bool,
    lists: Vec<MemberList>,
}

#[derive(Debug, Clone)]
struct MemberList {
    bare: bool,
    private: bool,
    fields: Arc<BTreeMap<Arc<str>, ScopedSymbol>>,
    functions: Arc<BTreeMap<Arc<str>, ScopedSymbol>>,
    methods: Vec<FunctionScopeInterval>,
}

// Method intervals select ownership in the current document; they are not an
// inherited interface. Body-only endpoint edits must refresh local ownership
// without invalidating every package consumer of the same member declarations.
impl PartialEq for MemberList {
    fn eq(&self, other: &Self) -> bool {
        self.bare == other.bare
            && self.private == other.private
            && self.fields == other.fields
            && self.functions == other.functions
    }
}
impl Eq for MemberList {}
impl Hash for MemberList {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.bare.hash(state);
        self.private.hash(state);
        self.fields.hash(state);
        self.functions.hash(state);
    }
}

impl FileFacts {
    pub(crate) fn is_empty(&self) -> bool {
        self.classes.is_empty()
    }

    /// Point dispatch needs only syntax ownership; resolution may still reject
    /// a bare helper masked by another file in the creator environment.
    pub(crate) fn contains_scope_point(&self, position: Position) -> bool {
        self.classes.iter().any(|class| {
            class
                .lists
                .iter()
                .flat_map(|list| &list.methods)
                .any(|method| method.contains(position))
                || class
                    .inherit_range
                    .is_some_and(|(start, end)| start <= position && position < end)
        })
    }

    fn class_for_symbol(&self, symbol: &ScopedSymbol) -> Option<usize> {
        let index = *self.exported_classes.get(&symbol.name)?;
        let class = &self.classes[index];
        let (_, position) = class.binding.as_ref()?;
        (class.uri == symbol.source_uri
            && *position == Position::new(symbol.defined_line, symbol.defined_column))
        .then_some(index)
    }
}

/// Eligible package classes, including ambiguity and helper-masking information.
/// Files without R6 declarations add no retained facts to this index.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PackageClasses {
    classes: BTreeMap<Arc<str>, Option<(Arc<FileFacts>, usize)>>,
    files: BTreeMap<Url, Arc<FileFacts>>,
    masked_helpers: BTreeSet<String>,
}

impl PackageClasses {
    pub(crate) fn creator_uris(&self) -> impl Iterator<Item = &Url> {
        self.files.keys()
    }

    pub(crate) fn build<'a>(
        inputs: impl Iterator<Item = (&'a BTreeSet<String>, &'a Arc<FileFacts>)>,
    ) -> Self {
        let inputs: Vec<_> = inputs.collect();
        let mut index = Self::default();
        for (_, facts) in &inputs {
            for (name, class) in &facts.exported_classes {
                index
                    .classes
                    .insert(name.clone(), Some(((*facts).clone(), *class)));
            }
            if let Some(class) = facts.classes.first() {
                index.files.insert(class.uri.clone(), (*facts).clone());
            }
        }
        if index.files.is_empty() {
            return index;
        }
        for name in ["R6Class", "list"] {
            if inputs.iter().any(|(names, _)| names.contains(name)) {
                index.masked_helpers.insert(name.to_owned());
            }
        }
        let mut counts = BTreeMap::<&str, usize>::new();
        for (names, _) in &inputs {
            for name in *names {
                if index.classes.contains_key(name.as_str()) {
                    *counts.entry(name).or_default() += 1;
                }
            }
        }
        for (name, candidate) in &mut index.classes {
            if counts.get(name.as_ref()) != Some(&1) {
                *candidate = None;
            }
        }
        index
    }
}

/// One instance environment shared by every inline method of its class.
#[derive(Debug, Default)]
pub(crate) struct MethodEnvironment {
    // Public fields, public methods, private fields, private methods; derived
    // before base within each category. Method locals live in ScopeFrame.
    layers: Vec<Arc<BTreeMap<Arc<str>, ScopedSymbol>>>,
}

impl MethodEnvironment {
    pub(crate) fn symbol_for(&self, name: &str) -> Option<ScopedSymbol> {
        if matches!(name, "self" | "private" | "super") {
            return Some(ScopedSymbol {
                name: Arc::from(name),
                kind: SymbolKind::Variable,
                source_uri: Url::parse(super::PACKAGE_INTERNAL_URI).expect("static URI"),
                defined_line: 0,
                defined_column: 0,
                defined_end_column: crate::utf16::utf16_len(name),
                signature: None,
                is_declared: false,
            });
        }
        self.layers
            .iter()
            .find_map(|layer| layer.get(name).cloned())
    }

    pub(crate) fn contains(&self, name: &str) -> bool {
        matches!(name, "self" | "private" | "super")
            || self.layers.iter().any(|layer| layer.contains_key(name))
    }

    pub(crate) fn apply(&self, symbols: &mut HashMap<Arc<str>, ScopedSymbol>) {
        for layer in self.layers.iter().rev() {
            symbols.extend(
                layer
                    .iter()
                    .map(|(name, symbol)| (name.clone(), symbol.clone())),
            );
        }
        for name in ["self", "private", "super"] {
            symbols.insert(
                Arc::from(name),
                self.symbol_for(name).expect("runtime binding"),
            );
        }
    }
}

#[derive(Default)]
pub(crate) struct ResolvedScopes {
    pub(crate) methods: HashMap<FunctionScopeInterval, Arc<MethodEnvironment>>,
    captured_bases: Vec<(Position, Position, ScopedSymbol)>,
}

impl ResolvedScopes {
    pub(crate) fn captured_base(&self, position: Position) -> Option<&ScopedSymbol> {
        let index = self
            .captured_bases
            .partition_point(|(start, _, _)| *start <= position);
        let (_, end, symbol) = self.captured_bases.get(index.checked_sub(1)?)?;
        (position < *end).then_some(symbol)
    }
}

/// A missing isolated sibling can use compact package facts. A truncated or
/// unavailable graph neighborhood cannot be treated as an empty environment.
pub(crate) enum CreatorScope {
    Complete {
        scope: Box<ScopeAtPosition>,
        uncertain_names: HashSet<Arc<str>>,
    },
    MissingFile,
    Incomplete,
}

/// Resolve each class once, with cached creator scopes and shared member layers.
/// The scope adapter returns completed creator scopes without instance contributions;
/// superclass lookup must never depend on a method's local variables.
pub(crate) fn resolve_methods(
    facts: &Arc<FileFacts>,
    creator_uri: &Url,
    package: Option<&PackageClasses>,
    get_facts: impl Fn(&Url) -> Option<Arc<FileFacts>>,
    mut get_scope: impl FnMut(&Url) -> CreatorScope,
    is_cancelled: &dyn Fn() -> bool,
) -> ResolvedScopes {
    let mut scopes = HashMap::<Url, CreatorScope>::new();
    let mut resolved = ResolvedScopes::default();
    let mut fact_cache = HashMap::<Url, Option<Arc<FileFacts>>>::new();
    for index in 0..facts.classes.len() {
        if is_cancelled() {
            break;
        }
        // R6 installs methods before fields in the public/private environments.
        // Public fields win over public methods, then private fields/methods;
        // derived declarations win over bases only within the same category.
        let mut layers: [Vec<_>; 4] = Default::default();
        let mut methods = Vec::new();
        let mut current = (facts.clone(), index, creator_uri.clone());
        let mut visited = HashSet::new();
        let mut member_count = 0;
        for depth in 0..MAX_INHERITANCE_DEPTH {
            let class = &current.0.classes[current.1];
            if is_cancelled() || !visited.insert((current.2.clone(), current.1)) {
                break;
            }
            let needs_scope = class.bare_constructor
                || class.lists.iter().any(|list| list.bare)
                || class.inherit.is_some();
            let creator_scope = needs_scope.then(|| {
                &*scopes
                    .entry(current.2.clone())
                    .or_insert_with(|| get_scope(&current.2))
            });
            let unknown_creator = match creator_scope {
                Some(CreatorScope::Incomplete) => true,
                Some(CreatorScope::MissingFile) => current.0.requires_creator_context,
                _ => false,
            };
            let (scope, uncertain_names) = match creator_scope {
                Some(CreatorScope::Complete {
                    scope,
                    uncertain_names,
                }) => (Some(scope.as_ref()), Some(uncertain_names)),
                _ => (None, None),
            };
            let uncertain = |name: &str| uncertain_names.is_some_and(|names| names.contains(name));
            let helper_masked = |name: &str| {
                unknown_creator
                    || uncertain(name)
                    || package.is_some_and(|package| package.masked_helpers.contains(name))
                    || scope
                        .as_ref()
                        .and_then(|scope| scope.symbols.get(name))
                        .is_some_and(|symbol| symbol.source_uri.scheme() == "file")
            };
            if class.bare_constructor && helper_masked("R6Class") {
                break;
            }
            let list_masked = helper_masked("list");
            let lists: Vec<_> = class
                .lists
                .iter()
                .filter(|list| !list.bare || !list_masked)
                .collect();
            if depth == 0 {
                methods.extend(lists.iter().flat_map(|list| &list.methods).copied());
            }
            // Ambiguity is a namespace-wide veto, including same-file bases.
            // Otherwise a proven source() overwrite takes precedence over the
            // package fallback, which only supplies absent sibling bindings.
            let namespace_candidate = class.inherit.as_ref().and_then(|base| {
                package
                    .filter(|package| package.files.contains_key(&current.2))
                    .and_then(|package| package.classes.get(base))
            });
            let ambiguous = matches!(namespace_candidate, Some(None));
            if depth == 0
                && !ambiguous
                && class.top_level
                && class.default_parent
                && let Some((start, end)) = class.inherit_range
                && let Some(name) = &class.inherit
                && !uncertain(name)
                && let Some(symbol) = scope.as_ref().and_then(|scope| scope.symbols.get(name))
            {
                resolved.captured_bases.push((start, end, symbol.clone()));
            }
            if !class.nonportable {
                break;
            }
            member_count += lists
                .iter()
                .map(|list| list.fields.len() + list.functions.len())
                .sum::<usize>();
            if member_count > MAX_MEMBERS {
                break;
            }
            for list in lists {
                let category = if list.private { 2 } else { 0 };
                layers[category].push(list.fields.clone());
                layers[category + 1].push(list.functions.clone());
            }
            let Some(base) = class
                .inherit
                .as_ref()
                .filter(|_| class.top_level && class.default_parent && !ambiguous)
            else {
                break;
            };
            if unknown_creator || uncertain(base) {
                break;
            }
            let ordinary = scope.and_then(|scope| scope.symbols.get(base));
            let next = if let Some(symbol) = ordinary {
                if let Some(index) = current.0.class_for_symbol(symbol) {
                    Some((current.0.clone(), index, current.2.clone()))
                } else {
                    // Contributor keys are authoritative provider/graph URIs;
                    // symbols retain the editor's display spelling. Match the
                    // exact declaration site within visible contributors, never
                    // a same-named class elsewhere in the workspace.
                    let mut providers: Vec<_> = scope
                        .expect("resolved symbol has a creator scope")
                        .visible_positions
                        .keys()
                        .cloned()
                        .collect();
                    providers.sort();
                    if !providers.contains(&symbol.source_uri) {
                        providers.push(symbol.source_uri.clone());
                    }
                    providers.into_iter().find_map(|provider| {
                        if is_cancelled() {
                            return None;
                        }
                        let candidate = fact_cache
                            .entry(provider.clone())
                            .or_insert_with(|| {
                                get_facts(&provider).or_else(|| {
                                    package.and_then(|p| p.files.get(&provider).cloned())
                                })
                            })
                            .as_ref()?;
                        candidate
                            .class_for_symbol(symbol)
                            .map(|index| (candidate.clone(), index, provider))
                    })
                }
            } else if scope.is_some_and(|scope| scope.removed_names.contains(base)) {
                None
            } else {
                package
                    .and_then(|package| package.classes.get(base).cloned().flatten())
                    .map(|(facts, index)| {
                        let provider = facts.classes[index].uri.clone();
                        (facts, index, provider)
                    })
            };
            let Some(next) = next else { break };
            current = next;
        }
        if !methods.is_empty() {
            let environment = Arc::new(MethodEnvironment {
                layers: layers.into_iter().flatten().collect(),
            });
            for method in methods {
                resolved.methods.insert(method, environment.clone());
            }
        }
    }
    resolved.captured_bases.sort_by_key(|(start, _, _)| *start);
    resolved
}

/// Extract from the existing parse and shared capture/binding analysis. The
/// ordinary EOF scope is used solely to identify exported class declarations.
pub(crate) fn extract<'tree>(
    uri: &Url,
    root: Node<'tree>,
    content: &str,
    bindings: &mut LazyStaticBindings<'tree, '_>,
    completed_scope: &ScopeAtPosition,
    timeline: &[ScopeEvent],
) -> FileFacts {
    if !content.contains("R6Class") {
        return FileFacts::default();
    }
    let mut facts = FileFacts {
        requires_creator_context: timeline.iter().any(|event| {
            matches!(
                event,
                ScopeEvent::Source {
                    function_scope: None,
                    ..
                } | ScopeEvent::SourceBatch { .. }
                    | ScopeEvent::Removal {
                        function_scope: None,
                        ..
                    }
                    | ScopeEvent::SelectiveImport {
                        function_scope: None,
                        ..
                    }
                    | ScopeEvent::DataLoad {
                        function_scope: None,
                        ..
                    }
            )
        }),
        ..FileFacts::default()
    };
    let lines = LineIndex::new(content);
    super::visit_runtime_reachable_scope_syntax(root, content, bindings, &mut |node, bindings| {
        if let Some(class) = extract_class(uri, node, content, &lines, bindings) {
            facts.classes.push(class);
        }
    });
    for (index, class) in facts
        .classes
        .iter()
        .enumerate()
        .filter(|(_, class)| class.top_level)
    {
        if let Some((name, position)) = &class.binding
            && completed_scope.symbols.get(name).is_some_and(|symbol| {
                symbol.source_uri == *uri
                    && Position::new(symbol.defined_line, symbol.defined_column) == *position
            })
        {
            facts.exported_classes.insert(name.clone(), index);
        }
    }
    facts
}

fn call_identity(node: Node, content: &str, namespace: &str, name: &str) -> Option<bool> {
    let function = node.child_by_field_name("function")?;
    if plain_identifier_name(function, content) == Some(name) {
        return Some(true);
    }
    (function.kind() == "namespace_operator"
        && function
            .child_by_field_name("lhs")
            .and_then(|n| plain_identifier_name(n, content))
            == Some(namespace)
        && function
            .child_by_field_name("rhs")
            .and_then(|n| plain_identifier_name(n, content))
            == Some(name)
        && function
            .child_by_field_name("operator")
            .is_some_and(|n| super::node_text(n, content) == "::"))
    .then_some(false)
}

fn extract_class<'tree>(
    uri: &Url,
    node: Node<'tree>,
    content: &str,
    lines: &LineIndex,
    bindings: &mut LazyStaticBindings<'tree, '_>,
) -> Option<Class> {
    if node.kind() != "call" || node.has_error() {
        return None;
    }
    let bare_constructor = call_identity(node, content, "R6", "R6Class")?;
    if bare_constructor
        && bindings
            .get()
            .named_local_binding_may_shadow_without_helper_uncertainty("R6Class", node, true)
    {
        return None;
    }
    let matched = match_call_arguments(
        node.child_by_field_name("arguments")?,
        content,
        FORMALS,
        CallMatchMode::Strict,
    )?;
    let value = |index| match matched[index] {
        Some(CallActual::Value(node)) => Some(node),
        _ => None,
    };
    let mut class = Class {
        uri: uri.clone(),
        binding: None,
        top_level: false,
        bare_constructor,
        nonportable: value(7).is_some_and(|node| node.kind() == "false"),
        inherit: value(4)
            .and_then(|node| plain_identifier_name(node, content))
            .map(Arc::from),
        inherit_range: value(4)
            .filter(|node| plain_identifier_name(*node, content).is_some())
            .map(|node| {
                (
                    position(node.start_position(), lines),
                    position(node.end_position(), lines),
                )
            }),
        default_parent: value(10).is_none(),
        lists: Vec::new(),
    };
    let mut member_count = 0;
    for slot in 1..=3 {
        let Some(list) = value(slot) else { continue };
        if list.kind() == "null" {
            continue;
        }
        if list.kind() != "call" {
            continue;
        }
        let Some(bare) = call_identity(list, content, "base", "list") else {
            continue;
        };
        if bare
            && bindings
                .get()
                .named_local_binding_may_shadow_without_helper_uncertainty("list", list, true)
        {
            continue;
        }
        let mut members = BTreeMap::new();
        let mut methods = Vec::new();
        let Some(arguments) = list.child_by_field_name("arguments") else {
            continue;
        };
        for argument in arguments
            .named_children(&mut arguments.walk())
            .filter(|n| n.kind() == "argument")
        {
            let (Some(tag), Some(value)) = (
                argument.child_by_field_name("name"),
                argument.child_by_field_name("value"),
            ) else {
                continue;
            };
            let Some(name) = plain_argument_name(tag, content).filter(|name| !name.is_empty())
            else {
                continue;
            };
            let method = super::unwrap_function_definition(value);
            if let Some(function) = method
                && let Some(ScopeEvent::FunctionScope {
                    start_line,
                    start_column,
                    end_line,
                    end_column,
                    ..
                }) = super::try_extract_function_scope(function, lines, uri)
            {
                methods.push(FunctionScopeInterval::from_tuple((
                    start_line,
                    start_column,
                    end_line,
                    end_column,
                )));
            }
            if member_count >= MAX_MEMBERS {
                continue;
            }
            member_count += 1;
            let position = position(tag.start_position(), lines);
            let name: Arc<str> = Arc::from(name.as_ref());
            let callable = method.filter(|_| slot != 3);
            members.insert(
                name.clone(),
                ScopedSymbol {
                    name: name.clone(),
                    kind: if callable.is_some() {
                        SymbolKind::Function
                    } else {
                        SymbolKind::Variable
                    },
                    source_uri: uri.clone(),
                    defined_line: position.line,
                    defined_column: position.column,
                    defined_end_column: position.column
                        + crate::utf16::utf16_len(super::node_text(tag, content)),
                    signature: callable.map(|function| {
                        super::extract_function_signature(function, &name, content)
                    }),
                    is_declared: false,
                },
            );
        }
        let (functions, fields) = members
            .into_iter()
            .partition(|(_, symbol)| symbol.kind == SymbolKind::Function);
        class.lists.push(MemberList {
            bare,
            private: slot == 2,
            fields: Arc::new(fields),
            functions: Arc::new(functions),
            methods,
        });
    }
    let mut expression = node;
    while expression
        .parent()
        .is_some_and(|parent| parent.kind() == "parenthesized_expression")
    {
        expression = expression.parent()?;
    }
    if let Some(assignment) = expression
        .parent()
        .filter(|parent| parent.kind() == "binary_operator")
    {
        let operator = assignment
            .child_by_field_name("operator")
            .map(|node| super::node_text(node, content));
        let target = match operator {
            Some("<-" | "=") if assignment.child_by_field_name("rhs") == Some(expression) => {
                assignment.child_by_field_name("lhs")
            }
            Some("->") if assignment.child_by_field_name("lhs") == Some(expression) => {
                assignment.child_by_field_name("rhs")
            }
            _ => None,
        };
        class.binding = target.and_then(|target| {
            plain_identifier_name(target, content)
                .map(|name| (Arc::from(name), position(target.start_position(), lines)))
        });
        let mut parent = assignment.parent();
        while parent.is_some_and(|node| node.kind() == "braced_expression") {
            parent = parent.and_then(|node| node.parent());
        }
        class.top_level = parent.is_some_and(|node| node.kind() == "program");
    }
    Some(class)
}

fn position(point: tree_sitter::Point, lines: &LineIndex) -> Position {
    Position::new(
        point.row as u32,
        crate::utf16::byte_offset_to_utf16_column(lines.get_line(point.row), point.column),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn artifacts(code: &str) -> super::super::ScopeArtifacts {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&tree_sitter_r::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code, None).unwrap();
        super::super::compute_artifacts(&Url::parse("file:///r6.R").unwrap(), &tree, code)
    }

    #[test]
    fn r6_late_positional_base_has_binding_provenance() {
        let code = r#"Child <- R6 :: R6Class(public = base::list(
  own = 1, run = function() c(own, inherited)),
  classname = "Child", inherit = Base, portable = FALSE)
Base <- R6::R6Class("Base", list(inherited = 2), portable = FALSE)
"#;
        let artifacts = artifacts(code);
        assert_eq!(artifacts.r6.classes.len(), 2, "{:#?}", artifacts.r6);
        assert!(
            artifacts.r6.classes[1]
                .lists
                .iter()
                .any(|list| list.fields.contains_key("inherited")),
            "{:#?}",
            artifacts.r6
        );
        assert!(
            artifacts.r6.exported_classes.contains_key("Base"),
            "{:#?}",
            artifacts.r6
        );
        let artifacts = Arc::new(artifacts);
        let scopes = resolve_methods(
            &artifacts.r6,
            &Url::parse("file:///r6.R").unwrap(),
            None,
            |_| Some(artifacts.r6.clone()),
            |uri| CreatorScope::Complete {
                scope: Box::new(super::super::scope_at_position_with_graph(
                    uri,
                    u32::MAX,
                    u32::MAX,
                    &|_| Some(artifacts.clone()),
                    &|_| None,
                    &crate::cross_file::dependency::DependencyGraph::default(),
                    None,
                    20,
                    &HashSet::new(),
                    true,
                    crate::cross_file::config::BackwardDependencyMode::default(),
                    &|| false,
                    None,
                    None,
                )),
                uncertain_names: HashSet::new(),
            },
            &|| false,
        );
        assert!(
            scopes
                .methods
                .values()
                .all(|scope| scope.contains("inherited")),
            "{:?}",
            scopes.methods
        );
    }

    #[test]
    fn body_endpoint_changes_refresh_ownership_without_changing_interface() {
        let before = "C <- R6::R6Class(portable=FALSE, public=list(run=function() { 1 }))";
        let after = before.replace("{ 1 }", "{ 11111 }");
        let old = artifacts(before);
        let new = artifacts(&after);
        assert_eq!(old.r6, new.r6);
        assert_eq!(old.interface_hash, new.interface_hash);
        let old_end = old.r6.classes[0].lists[0].methods[0].end.column;
        let new_end = new.r6.classes[0].lists[0].methods[0].end.column;
        assert!(new_end > old_end);
        let point = Position::new(0, old_end + 1);
        assert!(!old.r6.contains_scope_point(point));
        assert!(new.r6.contains_scope_point(point));
        for edit in [
            before.replace("run=", "other="),
            before.replace("function()", "function(arg)"),
            before.replace("FALSE", "TRUE"),
            before.replace("portable=", "inherit=Base, portable="),
        ] {
            let changed = artifacts(&edit);
            assert_ne!(old.r6, changed.r6, "{edit}");
            assert_ne!(old.interface_hash, changed.interface_hash, "{edit}");
        }
    }

    #[test]
    fn r6_cold_package_creator_ignores_ineligible_parent_edges() {
        use crate::cross_file::config::BackwardDependencyMode;
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("R")).unwrap();
        let root = Url::from_directory_path(dir.path()).unwrap();
        let base_uri = root.join("R/base.R").unwrap();
        let child_uri = root.join("R/child.R").unwrap();
        let caller_uri = root.join("caller.R").unwrap();
        let base_code = "Base <- R6::R6Class(portable=FALSE, public=list(inherited=1))";
        std::fs::write(base_uri.to_file_path().unwrap(), base_code).unwrap();
        let child_code = "Child <- R6::R6Class(inherit=Base, portable=FALSE, public=list(run=function() inherited))";
        let parse = |uri: &Url, text: &str| {
            let mut parser = tree_sitter::Parser::new();
            parser
                .set_language(&tree_sitter_r::LANGUAGE.into())
                .unwrap();
            let tree = parser.parse(text, None).unwrap();
            Arc::new(super::super::compute_artifacts(uri, &tree, text))
        };
        let base = parse(&base_uri, base_code);
        let child = parse(&child_uri, child_code);
        let names = BTreeSet::from(["Base".to_owned()]);
        let contribution = crate::package_state::PackageScopeContribution {
            workspace_root: Some(dir.path().to_path_buf()),
            r6: Arc::new(PackageClasses::build(std::iter::once((&names, &base.r6)))),
            ..Default::default()
        };
        let mut graph = crate::cross_file::dependency::DependencyGraph::new();
        let metadata = crate::cross_file::extract_metadata("source('R/base.R')");
        graph.update_file(&caller_uri, &metadata, Some(&root), |_| None);
        assert_eq!(graph.get_dependents(&base_uri).len(), 1);
        for (mode, non_lending, visible) in [
            (BackwardDependencyMode::Explicit, false, true),
            (BackwardDependencyMode::Auto, false, false),
            (BackwardDependencyMode::Auto, true, true),
        ] {
            if non_lending {
                graph.make_forward_edges_non_lending(&caller_uri);
            }
            let scope = super::super::scope_at_position_with_graph(
                &child_uri,
                0,
                child_code.find("inherited").unwrap() as u32,
                &|uri| (uri == &child_uri).then(|| child.clone()),
                &|_| None,
                &graph,
                Some(&root),
                20,
                &HashSet::new(),
                true,
                mode,
                &|| false,
                Some(&contribution),
                None,
            );
            assert_eq!(
                scope.symbols.contains_key("inherited"),
                visible,
                "{mode:?}/{non_lending}"
            );
        }
    }

    /// All consumers cross the same stream/point seam; check actual provenance,
    /// not just whether a diagnostic happened to be suppressed elsewhere.
    fn query(code: &str, needle: &str) -> ScopeAtPosition {
        use super::super::{ParentPrefixCache, ScopeStream};
        let artifacts = Arc::new(artifacts(code));
        let uri = Url::parse("file:///r6.R").unwrap();
        let offset = code.find(needle).unwrap();
        let before = &code[..offset];
        let line = before.bytes().filter(|b| *b == b'\n').count() as u32;
        let column = crate::utf16::utf16_len(before.rsplit('\n').next().unwrap());
        let get_artifacts = |_: &Url| Some(artifacts.clone());
        let get_metadata = |_: &Url| None;
        let graph = crate::cross_file::dependency::DependencyGraph::default();
        let exports = HashSet::new();
        let mode = crate::cross_file::config::BackwardDependencyMode::default();
        let cache = std::cell::RefCell::new(ParentPrefixCache::default());
        let mut stream = ScopeStream::new(
            &uri,
            &get_artifacts,
            &get_metadata,
            &graph,
            None,
            20,
            &exports,
            true,
            mode,
            &|| false,
            &cache,
            None,
            None,
        );
        let stream = stream.as_mut().unwrap();
        stream.advance_to(line, column);
        let streamed = stream.snapshot();
        let point = super::super::scope_at_position_with_graph(
            &uri,
            line,
            column,
            &get_artifacts,
            &get_metadata,
            &graph,
            None,
            20,
            &exports,
            true,
            mode,
            &|| false,
            None,
            None,
        );
        assert_eq!(streamed.symbols, point.symbols, "point/stream: {needle}");
        for (name, symbol) in &point.symbols {
            assert!(stream.is_visible(name), "visibility: {name} at {needle}");
            assert_eq!(
                stream.symbol_for(name).as_ref(),
                Some(symbol),
                "lookup: {name} at {needle}"
            );
        }
        point
    }

    #[test]
    fn r6_members_have_declaration_provenance_and_method_signatures() {
        let code = r#"field <- 999
C <- R6::R6Class(portable = FALSE, public = base::list(
  run = function(value = field) { sibling(1); active_value; secret },
  field = 1, sibling = function(x, y = 2) x + y),
  private = base::list(secret = 2),
  active = base::list(active_value = function() field))
"#;
        for needle in ["field) {", "sibling(1)", "field))"] {
            let scope = query(code, needle);
            assert_eq!(scope.symbols["field"].defined_line, 3);
            let sibling = &scope.symbols["sibling"];
            assert_eq!(sibling.kind, SymbolKind::Function);
            assert!(sibling.signature.as_ref().unwrap().contains("y = 2"));
            assert_eq!(sibling.defined_line, 3);
            assert_eq!(scope.symbols["active_value"].kind, SymbolKind::Variable);
            assert!(scope.symbols["active_value"].signature.is_none());
            assert!(scope.symbols.contains_key("secret"));
        }
    }

    #[test]
    fn r6_local_parameters_nested_closures_and_removal_preserve_precedence() {
        let code = r#"field <- 999
C <- R6::R6Class(portable = FALSE, public = list(field = 1,
  run = function(field = 2) {
    field + 0
    nested <- function() field + 1
    field <- 3
    field + 2
    rm(field)
    field + 3
  }))
"#;
        for (needle, definition_line) in [
            ("field + 0", 2),
            ("field + 1", 2),
            ("field + 2", 5),
            ("field + 3", 1),
        ] {
            assert_eq!(
                query(code, needle).symbols["field"].defined_line,
                definition_line,
                "{needle}"
            );
        }
    }

    #[test]
    fn r6_recognition_is_qualified_capture_aware_and_conservative() {
        for (code, member) in [
            (
                "R6Class <- function(...) base::list(...)\nC <- R6::R6Class(portable=FALSE, public=base::list(x=1, run=function() x + 0))",
                true,
            ),
            (
                "R6Class <- function(...) base::list(...)\nC <- R6Class(portable=FALSE, public=base::list(x=1, run=function() x + 0))",
                false,
            ),
            (
                "list <- function(...) base::list(...)\nC <- R6::R6Class(portable=FALSE, public=list(x=1, run=function() x + 0))",
                false,
            ),
            (
                "C <- quote(R6::R6Class(portable=FALSE, public=list(x=1, run=function() x + 0)))",
                false,
            ),
            (
                "C <- R6::R6Class(portable=F, public=list(x=1, run=function() x + 0))\nF <- FALSE",
                false,
            ),
            (
                "C <- R6::R6Class(public=list(x=1, run=function() x + 0))",
                false,
            ),
            (
                "C <- R6::R6Class(portable=TRUE, public=list(x=1, run=function() x + 0))",
                false,
            ),
            (
                "C <- R6::R6Class(portable=FALSE, inherit=unknown(), public=list(x=1, run=function() x + 0))",
                true,
            ),
            (
                "make <- function() R6::R6Class(portable=FALSE, public=list(x=1, run=function() x + 0))",
                true,
            ),
        ] {
            assert_eq!(
                query(code, "x + 0").symbols.contains_key("x"),
                member,
                "{code}"
            );
        }
    }

    #[test]
    fn r6_unknown_parent_cycles_and_depth_budget_retain_proven_own_members() {
        let unknown = "C <- R6::R6Class(portable=FALSE, inherit=Unknown, public=list(own=1, run=function() own + 0))";
        assert!(query(unknown, "own + 0").symbols.contains_key("own"));
        let cycle = r#"A <- R6::R6Class(portable=FALSE, inherit=B, public=list(a=1, run=function() a + 0))
B <- R6::R6Class(portable=FALSE, inherit=A, public=list(b=2))"#;
        let scope = query(cycle, "a + 0");
        assert!(scope.symbols.contains_key("a") && scope.symbols.contains_key("b"));
        let mut deep = String::new();
        for index in 0..=MAX_INHERITANCE_DEPTH {
            deep.push_str(&format!("C{index} <- R6::R6Class(portable=FALSE, inherit=C{}, public=base::list(m{index}=1, run=function() m{index} + 0))\n", index + 1));
        }
        let scope = query(&deep, "m0 + 0");
        assert!(scope.symbols.contains_key("m0"));
        assert!(scope.symbols.contains_key("m31"));
        assert!(!scope.symbols.contains_key("m32"));
    }

    #[test]
    fn r6_public_fields_precede_methods_and_private_members_across_inheritance() {
        for (base, child) in [
            ("public=list(x=1)", "private=list(x=2)"),
            (
                "public=list(x=1)",
                "public=list(x=function(a)a, run=function() x + 0)",
            ),
            ("private=list(x=1)", "private=list(x=function(a)a)"),
        ] {
            let child = if child.contains("run=") {
                child.to_owned()
            } else {
                format!("{child}, public=list(run=function() x + 0)")
            };
            let code = format!(
                "B <- R6::R6Class(portable=FALSE, {base})\nC <- R6::R6Class(portable=FALSE, inherit=B, {child})\n"
            );
            let symbol = query(&code, "x + 0").symbols["x"].clone();
            assert_eq!(symbol.defined_line, 0, "{code}");
            assert_eq!(symbol.kind, SymbolKind::Variable);
            assert!(symbol.signature.is_none());
        }
    }
}
