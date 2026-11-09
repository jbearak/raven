//! Name resolution: what each call's function, and each name used as a value,
//! resolves to at its position.
//!
//! Resolution reads the scope `raven check`'s undefined-variable collector
//! reads: the snapshot `raven check` builds for the file
//! (`DiagnosticsSnapshot`), walked by the same streaming scope
//! (`DiagnosticsSnapshot::with_scope_stream`), in document order, once per
//! file. Which bindings and which packages are visible at a position (function
//! scopes, `source()`d definitions, `library()` calls, what callers lend) is
//! whatever that scope says. It answers "is this name defined"; R's lookup
//! also needs an order, which is added here, in R's order:
//!
//! 1. An enclosing function's binding (`ScopeLayer::Function`).
//! 2. The global environment: this file's and its sourced files' definitions,
//!    then its callers' (the scope's layers above the default exports).
//!    Inside a function body, with `hoistGlobalsInFunctions` on, that is the
//!    file's whole top level, later definitions included, as `raven check`
//!    reads it.
//! 3. Attached packages, most recently attached first ([`FileResolver::search_order`]):
//!    the scope keeps the loaded packages as a set, so the order comes from
//!    the file's own package-load events and `source()` call sites. Packages
//!    only the callers attached come last.
//! 4. The default-attached packages (the scope's `base_exports` seed), then
//!    R's builtins.
//!
//! Where a caller's definition or attachment decides the result, each caller's
//! own view (its scope at its call site) is computed, and callers that
//! disagree give `ambiguous`. `docs/cli.md` (`raven parse`, "Name
//! resolution") is the contract.
//!
//! The positions the scope uses count lines by `\n` only, and the document's
//! also end a line at a lone `\r`. [`ScopePoints`] converts both ways: a
//! query's position into the scope's lines, and a definition's position back
//! into the document lines of the file that holds the definition, so a
//! `workspace` or `local` range counts lines as every other range does.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;

use serde::Serialize;
use tower_lsp::lsp_types::Url;
use tree_sitter::Node as TsNode;

use super::document::{Position, Range};
use super::literals;
use crate::cross_file::scope::{self, ScopeLayer, ScopedSymbol};
use crate::handlers::{DiagCancelToken, DiagnosticsSnapshot, SnapshotScopeStream};

/// What a name resolves to. Open enum: a consumer reads an unknown `kind` as
/// "other".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum Resolution {
    /// An object of an installed or known package. For `pkg::f`, `pkg` as
    /// written.
    Package { package: String },
    /// A definition in a workspace file: its path (as the graph prints it)
    /// and the defined name's range.
    Workspace { path: String, range: Range },
    /// A `# raven: func` / `# raven: var` declaration (or an `exists()` call
    /// Raven reads as one): the file and the 0-based line.
    Declared { path: String, line: u32 },
    /// A parameter or variable of an enclosing function, with the range of
    /// its binding.
    Local { range: Range },
    /// Raven sees no binding.
    Unresolved {
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<&'static str>,
        /// For `no_package_data`: the attached packages Raven has no export
        /// names for.
        #[serde(skip_serializing_if = "Vec::is_empty")]
        packages: Vec<String>,
    },
    /// The function position isn't a name or a namespace access.
    Dynamic,
    /// The file's callers disagree: one candidate per caller.
    Ambiguous { candidates: Vec<Candidate> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Candidate {
    pub(crate) path: String,
    pub(crate) resolution: Resolution,
}

impl Resolution {
    fn unresolved(reason: &'static str) -> Self {
        Resolution::Unresolved {
            reason: Some(reason),
            packages: Vec::new(),
        }
    }
}

/// A name to resolve: a call's function name, or a name used as a value.
#[derive(Debug)]
pub(crate) struct NameQuery {
    /// The name as R reads it (backticks and string quotes decoded).
    pub(crate) name: String,
    /// Byte offset of the name in the decoded text.
    pub(crate) at: usize,
    /// A value, not a call's function. A value's resolution is kept only when
    /// it is a package object.
    pub(crate) value: bool,
}

/// Resolves names for one file's text.
pub(crate) trait NameResolver {
    /// One result per query, in the queries' order. `None` drops a value's
    /// resolution; a call's is always `Some`.
    fn resolve(&self, text: &str, queries: &[NameQuery]) -> Vec<Option<Resolution>>;
}

/// The resolutions of one file's tree, by node byte range.
#[derive(Debug, Default)]
pub(crate) struct Resolutions {
    calls: HashMap<(usize, usize), Resolution>,
    values: HashMap<(usize, usize), Resolution>,
}

impl Resolutions {
    /// A `call` node's resolution. Present for every call.
    pub(crate) fn call(&self, node: TsNode<'_>) -> Option<&Resolution> {
        self.calls.get(&(node.start_byte(), node.end_byte()))
    }

    /// An identifier's resolution, when it is a value resolved to a package
    /// object.
    pub(crate) fn value(&self, node: TsNode<'_>) -> Option<&Resolution> {
        self.values.get(&(node.start_byte(), node.end_byte()))
    }
}

/// How a call names its function.
enum Callee {
    Name(String, usize),
    Namespace(String),
    Dynamic,
}

/// Resolve every call and every value name in the tree under `root`.
pub(crate) fn resolve_tree(root: TsNode<'_>, text: &str, names: &dyn NameResolver) -> Resolutions {
    let mut resolutions = Resolutions::default();
    let mut queries = Vec::new();
    // Which node each query belongs to: (byte range, is a call).
    let mut owners = Vec::new();
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        let key = (node.start_byte(), node.end_byte());
        match node.kind() {
            "call" => match callee(node, text) {
                Callee::Name(name, at) => {
                    queries.push(NameQuery {
                        name,
                        at,
                        value: false,
                    });
                    owners.push((key, true));
                }
                Callee::Namespace(package) => {
                    resolutions
                        .calls
                        .insert(key, Resolution::Package { package });
                }
                Callee::Dynamic => {
                    resolutions.calls.insert(key, Resolution::Dynamic);
                }
            },
            "identifier" if is_value(node, text) => {
                if let Some(name) = name_of(node, text) {
                    queries.push(NameQuery {
                        name,
                        at: node.start_byte(),
                        value: true,
                    });
                    owners.push((key, false));
                }
            }
            _ => {}
        }
        let mut cursor = node.walk();
        stack.extend(node.children(&mut cursor));
    }
    let results = names.resolve(text, &queries);
    for ((key, is_call), result) in owners.into_iter().zip(results) {
        match (is_call, result) {
            (true, result) => {
                let result = result.unwrap_or(Resolution::Unresolved {
                    reason: None,
                    packages: Vec::new(),
                });
                resolutions.calls.insert(key, result);
            }
            (false, Some(result)) => {
                resolutions.values.insert(key, result);
            }
            (false, None) => {}
        }
    }
    resolutions
}

/// The name an `identifier` or `string` node stands for, as R reads it.
fn name_of(node: TsNode<'_>, text: &str) -> Option<String> {
    let source = &text[node.byte_range()];
    match node.kind() {
        "string" => literals::string(source).1.text(),
        "identifier" if source.starts_with('`') => literals::backtick_name(source).text(),
        "identifier" | "dots" | "dot_dot_i" if source != "_" => Some(source.to_string()),
        _ => None,
    }
}

fn callee(call: TsNode<'_>, text: &str) -> Callee {
    let Some(function) = call.child_by_field_name("function") else {
        return Callee::Dynamic;
    };
    match function.kind() {
        "identifier" | "string" | "dots" | "dot_dot_i" => match name_of(function, text) {
            Some(name) => Callee::Name(name, function.start_byte()),
            None => Callee::Dynamic,
        },
        "namespace_operator" => match function
            .child_by_field_name("lhs")
            .and_then(|lhs| name_of(lhs, text))
        {
            Some(package) => Callee::Namespace(package),
            None => Callee::Dynamic,
        },
        _ => Callee::Dynamic,
    }
}

/// Whether an `identifier` is used as a value: not a call's function, an
/// assignment's target, a `for` variable, an argument's or parameter's name,
/// either side of `::`, the right side of `$`/`@`, or the pipe placeholder.
fn is_value(node: TsNode<'_>, text: &str) -> bool {
    if &text[node.byte_range()] == "_" {
        return false;
    }
    let Some(parent) = node.parent() else {
        return true;
    };
    let is = |field: &str| parent.child_by_field_name(field) == Some(node);
    match parent.kind() {
        "call" => !is("function"),
        "binary_operator" => {
            let operator = parent
                .child_by_field_name("operator")
                .map_or("", |op| op.kind());
            match operator {
                "<-" | "<<-" | "=" | ":=" => !is("lhs"),
                "->" | "->>" => !is("rhs"),
                _ => true,
            }
        }
        "argument" | "parameter" => !is("name"),
        "namespace_operator" => false,
        "extract_operator" => !is("rhs"),
        "for_statement" => !is("variable"),
        _ => true,
    }
}

/// Converts between a file's byte offsets, the positions the scope uses, and
/// the document's positions.
///
/// The scope counts lines by `\n` only, with columns in UTF-16 units from that
/// line's start ([`Self::at`]). The document also ends a line at a lone `\r`
/// (`LineIndex`), so a definition's scope position is converted back
/// ([`Self::document_position`]) using the text of the file that holds it.
/// Without a lone `\r` the two agree and the conversion is the identity.
struct ScopePoints<'t> {
    text: Cow<'t, str>,
    /// Byte offset of each `\n`.
    newlines: Vec<usize>,
    /// Byte offset of each `\r` not followed by `\n`.
    lone_crs: Vec<usize>,
}

impl<'t> ScopePoints<'t> {
    fn new(text: impl Into<Cow<'t, str>>) -> Self {
        let text = text.into();
        let bytes = text.as_bytes();
        let mut newlines = Vec::new();
        let mut lone_crs = Vec::new();
        for (i, &b) in bytes.iter().enumerate() {
            match b {
                b'\n' => newlines.push(i),
                b'\r' if bytes.get(i + 1) != Some(&b'\n') => lone_crs.push(i),
                _ => {}
            }
        }
        ScopePoints {
            text,
            newlines,
            lone_crs,
        }
    }

    /// The scope's position of byte `offset`.
    fn at(&self, offset: usize) -> (u32, u32) {
        let line = self.newlines.partition_point(|&nl| nl < offset);
        let start = self.line_start(line);
        let column = self.text[start..offset].encode_utf16().count();
        (line as u32, column as u32)
    }

    /// Byte offset where the scope's `line` starts.
    fn line_start(&self, line: usize) -> usize {
        if line == 0 {
            0
        } else {
            self.newlines[line - 1] + 1
        }
    }

    /// The document position of the scope's `line` and UTF-16 `column`. A
    /// line past the text's last is returned unchanged.
    fn document_position(&self, line: u32, column: u32) -> Position {
        let unchanged = Position {
            line,
            character: column,
        };
        let scope_line = line as usize;
        if self.lone_crs.is_empty() || scope_line > self.newlines.len() {
            return unchanged;
        }
        let start = self.line_start(scope_line);
        let end = self
            .newlines
            .get(scope_line)
            .copied()
            .unwrap_or(self.text.len());
        let line_text = &self.text[start..end];
        let line_text = line_text.strip_suffix('\r').unwrap_or(line_text);
        let offset = start + crate::utf16::utf16_column_to_byte_offset(line_text, column);
        // Every `\n` before `offset` is on an earlier scope line; every lone
        // `\r` before it ends one more document line.
        let crs = self.lone_crs.partition_point(|&cr| cr < offset);
        let document_start = match crs {
            0 => start,
            _ => start.max(self.lone_crs[crs - 1] + 1),
        };
        Position {
            line: line + crs as u32,
            character: self.text[document_start..offset].encode_utf16().count() as u32,
        }
    }

    /// A symbol's defined-name range in document positions. The name is on
    /// one line, so the end keeps the start's line and the name's width.
    fn symbol_range(&self, symbol: &ScopedSymbol) -> Range {
        let start = self.document_position(symbol.defined_line, symbol.defined_column);
        let width = symbol
            .defined_end_column
            .saturating_sub(symbol.defined_column);
        Range {
            start,
            end: Position {
                line: start.line,
                character: start.character + width,
            },
        }
    }
}

/// Resolves names against the workspace, as `raven check` sees it.
pub(crate) struct WorkspaceNames {
    snapshot: DiagnosticsSnapshot,
    uri: Url,
    root: PathBuf,
}

impl WorkspaceNames {
    pub(crate) fn new(snapshot: DiagnosticsSnapshot, uri: Url, root: PathBuf) -> Self {
        WorkspaceNames {
            snapshot,
            uri,
            root,
        }
    }
}

impl NameResolver for WorkspaceNames {
    fn resolve(&self, text: &str, queries: &[NameQuery]) -> Vec<Option<Resolution>> {
        let points = ScopePoints::new(text);
        let positions: Vec<(u32, u32)> = queries.iter().map(|q| points.at(q.at)).collect();
        // The stream's cursor only moves forward.
        let mut order: Vec<usize> = (0..queries.len()).collect();
        order.sort_by_key(|&i| positions[i]);
        let mut out: Vec<Option<Resolution>> = vec![None; queries.len()];
        let cancel = DiagCancelToken::never();
        let mut file = FileResolver::new(self, &cancel, &points);
        self.snapshot
            .with_scope_stream(&self.uri, &cancel, |stream| {
                let Some(stream) = stream else {
                    for i in order {
                        out[i] = (!queries[i].value).then_some(Resolution::Unresolved {
                            reason: None,
                            packages: Vec::new(),
                        });
                    }
                    return;
                };
                for i in order {
                    let (line, column) = positions[i];
                    stream.advance_to(line, column);
                    out[i] = file.resolve(stream, &queries[i], line, column);
                }
            });
        out
    }
}

/// One file's resolution state: the callers that lend it scope, and each
/// caller's scope once computed.
struct FileResolver<'w> {
    names: &'w WorkspaceNames,
    cancel: &'w DiagCancelToken,
    /// This file's text, for its definitions' document positions.
    points: &'w ScopePoints<'w>,
    /// Other files' texts, read once, for their definitions' document
    /// positions. `None` for a file that can't be read.
    other_points: RefCell<HashMap<Url, Option<Rc<ScopePoints<'static>>>>>,
    /// The earliest lending call site of each distinct caller, sorted by
    /// printed path.
    callers: Vec<(Url, u32, u32)>,
    /// Whether some caller lends nothing to the file's scope: a file with a
    /// `# raven: sourced-by` directive has its scope from the directive's
    /// callers only (see [`scope::parent_edge_lends_scope`]), yet R runs it
    /// from its other `source()` callers too.
    hidden_callers: bool,
    caller_scopes: HashMap<(usize, bool), scope::ScopeAtPosition>,
    /// Each top-level definition's position in this file, by name.
    top_level_defs: Option<HashMap<String, Vec<(u32, u32)>>>,
    /// Each file's package loads and the files it sources, read once from its
    /// timeline and the graph.
    attach_sites: HashMap<Url, AttachSites>,
}

/// Where a file attaches packages: its package loads (`library()` and
/// kin), and its `source()` calls by target.
#[derive(Default)]
struct AttachSites {
    loads: Vec<PackageLoad>,
    sources: HashMap<Url, (u32, u32)>,
}

/// A file's attached packages at a position (see
/// [`FileResolver::search_order`]).
struct SearchOrder {
    /// Search order, with where each package came from.
    order: Vec<(String, Attached)>,
    /// Every package the file and the files it sources have loaded, callers'
    /// attachments it repeats included, most recent first.
    loaded: Vec<String>,
}

/// When a package was attached, compared in order: a position in the file
/// being resolved, then, for a package a sourced file attached, its position
/// in that file.
type AttachRank = Vec<(u32, u32)>;

struct PackageLoad {
    package: String,
    at: (u32, u32),
    function_scope: Option<scope::FunctionScopeInterval>,
}

/// Where an attached package came from, relative to the file being resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Attached {
    /// This file attached it, or a file it sources did.
    Here,
    /// A caller attached it before its `source()` call.
    Callers,
}

impl<'w> FileResolver<'w> {
    fn new(
        names: &'w WorkspaceNames,
        cancel: &'w DiagCancelToken,
        points: &'w ScopePoints<'w>,
    ) -> Self {
        let snapshot = &names.snapshot;
        let metadata = &snapshot.directive_meta;
        let mode = snapshot.cross_file_config.backward_dependencies;
        // A caller lends the scope its edges, or, for a file a `sourced-by`
        // directive opts out of its other callers in the scope, would lend
        // it without that opt-out (no metadata: no per-file opt-out). Such a
        // caller is hidden: read at its earliest such edge.
        let mut lending: HashMap<Url, (u32, u32)> = HashMap::new();
        let mut hidden: HashMap<Url, (u32, u32)> = HashMap::new();
        for edge in snapshot.cross_file_graph.get_dependents(&names.uri) {
            if metadata.standalone || edge.uses_declared_only_parent_inheritance() {
                continue;
            }
            let earliest = if scope::parent_edge_lends_scope(edge, Some(metadata), mode) {
                &mut lending
            } else if scope::parent_edge_lends_scope(edge, None, mode) {
                &mut hidden
            } else {
                continue;
            };
            let site = (
                edge.call_site_line.unwrap_or(u32::MAX),
                edge.call_site_column.unwrap_or(u32::MAX),
            );
            earliest
                .entry(edge.from.clone())
                .and_modify(|existing| *existing = (*existing).min(site))
                .or_insert(site);
        }
        hidden.retain(|uri, _| !lending.contains_key(uri));
        let hidden_callers = !hidden.is_empty();
        let mut earliest = lending;
        earliest.extend(hidden);
        // Sort by the printed path, the order docs/cli.md promises for
        // `ambiguous` candidates. A URI's order differs for percent-encoded
        // names and for callers outside the root.
        let mut keyed: Vec<(String, Url, u32, u32)> = earliest
            .into_iter()
            .map(|(uri, (line, column))| {
                let path = crate::cli::graph::display_path(&uri, &names.root);
                (path, uri, line, column)
            })
            .collect();
        keyed.sort_by(|a, b| a.0.cmp(&b.0));
        let callers: Vec<(Url, u32, u32)> = keyed
            .into_iter()
            .map(|(_, uri, line, column)| (uri, line, column))
            .collect();
        FileResolver {
            names,
            cancel,
            points,
            other_points: RefCell::new(HashMap::new()),
            callers,
            hidden_callers,
            caller_scopes: HashMap::new(),
            top_level_defs: None,
            attach_sites: HashMap::new(),
        }
    }

    /// `uri`'s attach sites, read once.
    fn attach_sites(&mut self, uri: &Url) -> &AttachSites {
        let snapshot = self.snapshot();
        self.attach_sites.entry(uri.clone()).or_insert_with(|| {
            let loads = snapshot
                .artifacts_map
                .get(uri)
                .iter()
                .flat_map(|artifacts| &artifacts.timeline)
                .filter_map(|event| match event {
                    scope::ScopeEvent::PackageLoad {
                        line,
                        column,
                        package,
                        function_scope,
                        ..
                    } => Some(PackageLoad {
                        package: package.clone(),
                        at: (*line, *column),
                        function_scope: *function_scope,
                    }),
                    _ => None,
                })
                .collect();
            let mut sources: HashMap<Url, (u32, u32)> = HashMap::new();
            for edge in snapshot.cross_file_graph.get_dependencies(uri) {
                let (Some(line), Some(column)) = (edge.call_site_line, edge.call_site_column)
                else {
                    continue;
                };
                sources
                    .entry(edge.to.clone())
                    .and_modify(|first| *first = (*first).min((line, column)))
                    .or_insert((line, column));
            }
            AttachSites { loads, sources }
        })
    }

    /// `symbol`'s defined-name range in the document positions of the file
    /// that defines it: that file's own line endings decide. Another file's
    /// text is read as `raven parse` reads it; one that can't be read keeps
    /// the scope's positions.
    fn symbol_range(&self, symbol: &ScopedSymbol) -> Range {
        let uri = &symbol.source_uri;
        if *uri == self.names.uri {
            return self.points.symbol_range(symbol);
        }
        let points = self
            .other_points
            .borrow_mut()
            .entry(uri.clone())
            .or_insert_with(|| {
                let bytes = std::fs::read(uri.to_file_path().ok()?).ok()?;
                let text = crate::state::decode_source(bytes).ok()?;
                Some(Rc::new(ScopePoints::new(text)))
            })
            .clone();
        match points {
            Some(points) => points.symbol_range(symbol),
            None => ScopePoints::new("").symbol_range(symbol),
        }
    }

    fn snapshot(&self) -> &'w DiagnosticsSnapshot {
        &self.names.snapshot
    }

    /// R's lookup at the stream's cursor: enclosing functions, then the
    /// global environment (this file's and its callers' definitions), then
    /// attached packages, most recently attached first, then the
    /// default-attached packages.
    fn resolve(
        &mut self,
        stream: &mut SnapshotScopeStream<'_>,
        query: &NameQuery,
        line: u32,
        column: u32,
    ) -> Option<Resolution> {
        let name = query.name.as_str();
        let uri = &self.names.uri;
        let found = stream.symbol_with_layer(name);
        let found = found.filter(|(symbol, layer)| {
            // As the undefined-variable collector: a same-file binding made
            // later is no binding here, unless R binds it late: a global read
            // from inside a function body, which with hoisting on sees the
            // file's whole top level (the stream's global layer there is the
            // completed one), or an R6 instance member.
            stream.is_deferred_binding(symbol)
                || !crate::handlers::is_forward_reference_in_same_file(symbol, uri, line, column)
                || (*layer == ScopeLayer::Global && self.inside_late_binding_function(line, column))
        });
        let mut default_export = None;
        // Whether the callers' views were read, or this file's own frames
        // bind the name, so that no caller can change it.
        let mut settled = true;
        let resolution = match found {
            Some((symbol, ScopeLayer::Function)) => Some(self.local_or_classify(&symbol, name)),
            Some((symbol, _)) if is_default_attached(&symbol) => {
                default_export = Some(symbol);
                settled = false;
                None
            }
            Some((symbol, ScopeLayer::Prefix)) => {
                let merged = self.classify(&symbol, name);
                let packages = stream.package_snapshot();
                let uri = self.names.uri.clone();
                let loaded = self.search_order(&uri, &packages, line, column).loaded;
                Some(self.decided_by_callers(name, merged, &loaded, line, column))
            }
            Some((symbol, layer)) => {
                settled = layer != ScopeLayer::SearchPath;
                Some(self.classify(&symbol, name))
            }
            None => {
                settled = false;
                None
            }
        };
        let resolution = match resolution {
            Some(resolution) => Some(resolution),
            None => match self.attached_export(stream, name, line, column) {
                Some((resolution, Attached::Callers)) => {
                    settled = true;
                    Some(resolution)
                }
                Some((resolution, Attached::Here)) => Some(resolution),
                None => None,
            },
        };
        let resolution = resolution
            .or_else(|| default_export.map(|symbol| self.classify(&symbol, name)))
            .or_else(|| self.builtin(name));
        let resolution = match resolution {
            Some(resolution @ Resolution::Package { .. }) => Some(resolution),
            Some(_) | None if query.value => None,
            Some(resolution) => Some(resolution),
            None => Some(self.unresolved(stream, name, line, column)),
        };
        // A caller the scope doesn't read (see `hidden_callers`) may define
        // or attach what the file's own global environment doesn't bind.
        if settled || !self.hidden_callers {
            return resolution;
        }
        let packages = stream.package_snapshot();
        let uri = self.names.uri.clone();
        let loaded = self.search_order(&uri, &packages, line, column).loaded;
        let merged = resolution.unwrap_or_else(|| Resolution::unresolved("not_found"));
        match self.decided_by_callers(name, merged, &loaded, line, column) {
            resolution @ Resolution::Package { .. } => Some(resolution),
            _ if query.value => None,
            resolution => Some(resolution),
        }
    }

    /// A binding in an enclosing function's frame: `local` when the function
    /// binds it itself, otherwise what bound it (a file it sourced).
    fn local_or_classify(&self, symbol: &ScopedSymbol, name: &str) -> Resolution {
        if symbol.source_uri == self.names.uri
            && !symbol.is_declared
            && scope::package_name_from_uri(&symbol.source_uri).is_none()
        {
            return Resolution::Local {
                range: self.symbol_range(symbol),
            };
        }
        self.classify(symbol, name)
    }

    fn classify(&self, symbol: &ScopedSymbol, name: &str) -> Resolution {
        let snapshot = self.snapshot();
        if symbol.is_declared {
            return Resolution::Declared {
                path: self.display(&symbol.source_uri),
                line: symbol.defined_line,
            };
        }
        if scope::is_package_internal_uri(&symbol.source_uri) {
            return self.own_package();
        }
        if let Some(package) = scope::package_name_from_uri(&symbol.source_uri) {
            if crate::package_library::is_load_all_sentinel(package) {
                return self.own_package();
            }
            let topic = scope::package_export_from_uri(&symbol.source_uri);
            let topic = topic.as_deref().unwrap_or(name);
            let package = if package == "base" {
                default_owner(&snapshot.package_library, topic)
            } else {
                package.to_string()
            };
            return Resolution::Package { package };
        }
        Resolution::Workspace {
            path: self.display(&symbol.source_uri),
            range: self.symbol_range(symbol),
        }
    }

    /// The workspace's own package (package mode), for its internal objects.
    fn own_package(&self) -> Resolution {
        match &self.snapshot().scope_contribution.package_name {
            Some(package) => Resolution::Package {
                package: package.clone(),
            },
            None => Resolution::Unresolved {
                reason: None,
                packages: Vec::new(),
            },
        }
    }

    fn display(&self, uri: &Url) -> String {
        crate::cli::graph::display_path(uri, &self.names.root)
    }

    /// The package export R finds for `name` among the packages attached at
    /// the cursor: this file's (and the files it sources) first, most recent
    /// first, then its callers' (read as [`Self::decided_by_callers`]), and
    /// whose attachment it was.
    fn attached_export(
        &mut self,
        stream: &mut SnapshotScopeStream<'_>,
        name: &str,
        line: u32,
        column: u32,
    ) -> Option<(Resolution, Attached)> {
        let packages = stream.package_snapshot();
        let uri = self.names.uri.clone();
        let SearchOrder { order, loaded } = self.search_order(&uri, &packages, line, column);
        let library = &self.snapshot().package_library;
        let (owner, attached) = order.into_iter().find_map(|(package, attached)| {
            library
                .find_package_owner_for_symbol(name, std::slice::from_ref(&package))
                .map(|owner| (owner, attached))
        })?;
        let found = if crate::package_library::is_load_all_sentinel(&owner) {
            self.own_package()
        } else {
            Resolution::Package { package: owner }
        };
        Some(match attached {
            Attached::Here => (found, attached),
            Attached::Callers => (
                self.decided_by_callers(name, found, &loaded, line, column),
                attached,
            ),
        })
    }

    /// The packages loaded at a position of the file `uri`, whose scope
    /// there is `scope`, in R's search order: those attached in the file
    /// itself or in a file it sources, the most recently attached first
    /// (ranked by their first `library()` call in the file, or by the
    /// `source()` call of the file that attached them and then that file's
    /// own first call); then `NAMESPACE` imports (package mode); then those
    /// its callers attached, by name. A package a caller attached stays the
    /// callers' even when the file attaches it again: R doesn't move an
    /// attached package.
    fn search_order(
        &mut self,
        uri: &Url,
        scope: &scope::ScopeAtPosition,
        line: u32,
        column: u32,
    ) -> SearchOrder {
        let snapshot = self.snapshot();
        let at = scope::Position::new(line, column);
        let origins: Vec<Url> = scope
            .package_origins
            .values()
            .flatten()
            .filter(|origin| origin.as_ref() != uri)
            .map(|origin| origin.as_ref().clone())
            .collect();
        for origin in origins.iter().chain(std::iter::once(uri)) {
            self.attach_sites(origin);
        }
        let all_sites = &self.attach_sites;
        let sites = &all_sites[uri];
        // A sourced file's own first top-level load of `package`.
        let first_top_level_load = |origin: &Url, package: &str| {
            all_sites[origin]
                .loads
                .iter()
                .filter(|load| load.function_scope.is_none() && load.package == package)
                .map(|load| load.at)
                .min()
        };
        let mut first_load: HashMap<&str, (u32, u32)> = HashMap::new();
        for load in sites.loads.iter().filter(|load| {
            load.function_scope
                .is_none_or(|interval| interval.contains(at))
        }) {
            first_load
                .entry(load.package.as_str())
                .and_modify(|first| *first = (*first).min(load.at))
                .or_insert(load.at);
        }
        // Compared in order: a position in this file, then, for a package a
        // sourced file attached, its position in that file.
        let rank = |package: &str| -> Option<AttachRank> {
            let own = first_load.get(package).map(|&at| vec![at]);
            let sourced = scope
                .package_origins
                .get(package)
                .into_iter()
                .flatten()
                .filter(|origin| origin.as_ref() != uri)
                .filter_map(|origin| {
                    let call = sites.sources.get(origin.as_ref())?;
                    Some(
                        std::iter::once(*call)
                            .chain(first_top_level_load(origin, package))
                            .collect(),
                    )
                })
                .min();
            own.into_iter().chain(sourced).min()
        };
        let mut ranked: Vec<(Option<AttachRank>, &String)> = scope
            .loaded_packages
            .iter()
            .map(|package| (rank(package), package))
            .collect();
        // Most recent first; a package with no known position (attached by a
        // file a sourced file sources) ranks as attached before the rest.
        ranked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1)));
        let loaded: Vec<String> = ranked
            .into_iter()
            .map(|(_, package)| package.clone())
            .collect();
        let mut order: Vec<(String, Attached)> = loaded
            .iter()
            .filter(|package| !scope.inherited_packages.contains(*package))
            .map(|package| (package.clone(), Attached::Here))
            .collect();
        let mut imports: Vec<&String> = snapshot
            .scope_contribution
            .full_imports
            .iter()
            .filter(|package| !scope.loaded_packages.contains(*package))
            .collect();
        imports.sort();
        order.extend(
            imports
                .into_iter()
                .map(|package| (package.clone(), Attached::Here)),
        );
        let mut inherited: Vec<&String> = scope
            .inherited_packages
            .iter()
            .filter(|package| !snapshot.scope_contribution.full_imports.contains(*package))
            .collect();
        inherited.sort();
        order.extend(
            inherited
                .into_iter()
                .map(|package| (package.clone(), Attached::Callers)),
        );
        SearchOrder { order, loaded }
    }

    /// A result decided by what the file's callers lend (a caller's
    /// definition or attachment): `merged`, as the file's merged scope has
    /// it, unless the file has callers, whose own views then decide. Callers
    /// that disagree give `ambiguous`; callers that agree on what an
    /// unresolved `merged` leaves unresolved keep its reason. `loaded` is the
    /// file's own [`SearchOrder::loaded`].
    fn decided_by_callers(
        &mut self,
        name: &str,
        merged: Resolution,
        loaded: &[String],
        line: u32,
        column: u32,
    ) -> Resolution {
        if self.callers.is_empty() {
            return merged;
        }
        let late = self.inside_late_binding_function(line, column);
        let mut candidates: Vec<Candidate> = (0..self.callers.len())
            .map(|index| Candidate {
                path: self.display(&self.callers[index].0),
                resolution: self.caller_view(index, late, name, loaded),
            })
            .collect();
        if candidates
            .iter()
            .all(|candidate| candidate.resolution == candidates[0].resolution)
        {
            // Left unresolved: `merged` keeps its own reason.
            if matches!(merged, Resolution::Unresolved { .. })
                && matches!(candidates[0].resolution, Resolution::Unresolved { .. })
            {
                return merged;
            }
            return candidates.swap_remove(0).resolution;
        }
        Resolution::Ambiguous { candidates }
    }

    /// What `name` resolves to in this file as caller `index` alone would
    /// leave it: the caller's definition, else the first package that exports
    /// the name among the file's own attachments the caller hadn't made
    /// (`loaded`, most recent first) and then the caller's attachments at its
    /// call site, else the default-attached packages and R's builtins.
    fn caller_view(
        &mut self,
        index: usize,
        late: bool,
        name: &str,
        loaded: &[String],
    ) -> Resolution {
        let names = self.names;
        let (caller, line, column) = if late {
            (self.callers[index].0.clone(), u32::MAX, u32::MAX)
        } else {
            self.callers[index].clone()
        };
        self.caller_scope(index, late);
        let scope = self
            .caller_scopes
            .remove(&(index, late))
            .expect("computed above");
        let bound = scope
            .symbols
            .get(name)
            .filter(|symbol| symbol.source_uri != names.uri)
            .cloned();
        if let Some(symbol) = bound.as_ref().filter(|symbol| !is_default_attached(symbol)) {
            self.caller_scopes.insert((index, late), scope);
            return self.classify(symbol, name);
        }
        let mut order: Vec<String> = loaded
            .iter()
            .filter(|package| {
                !scope.loaded_packages.contains(*package)
                    && !scope.inherited_packages.contains(*package)
            })
            .cloned()
            .collect();
        let caller_order = self.search_order(&caller, &scope, line, column).order;
        order.extend(caller_order.into_iter().map(|(package, _)| package));
        self.caller_scopes.insert((index, late), scope);
        let library = &self.snapshot().package_library;
        if let Some(owner) = order.into_iter().find_map(|package| {
            library.find_package_owner_for_symbol(name, std::slice::from_ref(&package))
        }) {
            return if crate::package_library::is_load_all_sentinel(&owner) {
                self.own_package()
            } else {
                Resolution::Package { package: owner }
            };
        }
        bound
            .map(|symbol| self.classify(&symbol, name))
            .or_else(|| self.builtin(name))
            .unwrap_or_else(|| Resolution::unresolved("not_found"))
    }

    /// Whether R reads globals late at this position: inside a function body
    /// (not an immediate `local()`) with `hoistGlobalsInFunctions` on. Callers
    /// are then read at their end, as the scope reads them.
    fn inside_late_binding_function(&self, line: u32, column: u32) -> bool {
        let snapshot = self.snapshot();
        snapshot.cross_file_config.hoist_globals_in_functions
            && snapshot
                .artifacts_map
                .get(&self.names.uri)
                .is_some_and(|artifacts| {
                    let tree = &artifacts.function_scope_tree;
                    tree.any_deferring(&tree.query_point(scope::Position::new(line, column)))
                })
    }

    /// Compute caller `index`'s scope at its call site (at its end when
    /// `late`), once.
    fn caller_scope(&mut self, index: usize, late: bool) {
        let snapshot = self.snapshot();
        let (uri, line, column) = &self.callers[index];
        let cancel = self.cancel;
        self.caller_scopes.entry((index, late)).or_insert_with(|| {
            let (line, column) = if late {
                (u32::MAX, u32::MAX)
            } else {
                (*line, *column)
            };
            snapshot.get_scope(uri, line, column, cancel)
        });
    }

    /// R's builtins (`T`, `F`, base functions), owned by the default-attached
    /// package that exports them.
    fn builtin(&self, name: &str) -> Option<Resolution> {
        crate::handlers::is_builtin(name).then(|| Resolution::Package {
            package: default_owner(&self.snapshot().package_library, name),
        })
    }

    /// Why a call name resolved to nothing: an attached package Raven has no
    /// export names for, a definition only later in this file, or none at
    /// all.
    fn unresolved(
        &mut self,
        stream: &mut SnapshotScopeStream<'_>,
        name: &str,
        line: u32,
        column: u32,
    ) -> Resolution {
        let snapshot = self.snapshot();
        let scope = stream.package_snapshot();
        let library = &snapshot.package_library;
        let mut lacking: Vec<String> = scope
            .inherited_packages
            .iter()
            .chain(scope.loaded_packages.iter())
            .chain(snapshot.scope_contribution.full_imports.iter())
            .filter(|package| {
                !crate::package_library::is_load_all_sentinel(package)
                    && library.namespace_member_status_sync(package, name)
                        == crate::package_library::NamespaceMemberStatus::Unknown
            })
            .cloned()
            .collect();
        lacking.sort();
        lacking.dedup();
        if !lacking.is_empty() {
            return Resolution::Unresolved {
                reason: Some("no_package_data"),
                packages: lacking,
            };
        }
        if self.defined_later(name, line, column) {
            return Resolution::unresolved("defined_later");
        }
        Resolution::unresolved("not_found")
    }

    /// Whether this file defines `name` at top level after the position.
    fn defined_later(&mut self, name: &str, line: u32, column: u32) -> bool {
        let snapshot = self.snapshot();
        let uri = &self.names.uri;
        let defs = self.top_level_defs.get_or_insert_with(|| {
            let mut defs: HashMap<String, Vec<(u32, u32)>> = HashMap::new();
            if let Some(artifacts) = snapshot.artifacts_map.get(uri) {
                for event in &artifacts.timeline {
                    if let scope::ScopeEvent::Def {
                        symbol,
                        function_scope: None,
                        ..
                    } = event
                    {
                        defs.entry(symbol.name.to_string())
                            .or_default()
                            .push((symbol.defined_line, symbol.defined_column));
                    }
                }
            }
            defs
        });
        defs.get(name)
            .is_some_and(|positions| positions.iter().any(|&at| at > (line, column)))
    }
}

/// A default-attached export, as the scope seeds them (`package:base`).
fn is_default_attached(symbol: &ScopedSymbol) -> bool {
    scope::package_name_from_uri(&symbol.source_uri) == Some("base")
        && symbol.source_uri.fragment().is_none()
}

/// The default-attached package that owns `name`: the package library's
/// owner (`resolve_default_attached_owner`, as hover uses). With package
/// awareness off the library is empty, so the embedded base-R table answers,
/// with the same precedence: `base` first, then the others by name.
fn default_owner(library: &crate::package_library::PackageLibrary, name: &str) -> String {
    let owner = library.resolve_default_attached_owner(name);
    if owner != "base" || !library.base_exports().is_empty() {
        return owner;
    }
    let attached = crate::r_subprocess::get_fallback_base_packages();
    let mut embedded: Vec<_> = crate::package_db::embedded_base::packages()
        .iter()
        .filter(|package| attached.iter().any(|name| name == package.name))
        .collect();
    embedded.sort_by_key(|package| (package.name != "base", package.name));
    embedded
        .into_iter()
        .find(|package| package.exports.contains(&name) || package.datasets.contains(&name))
        .map_or(owner, |package| package.name.to_string())
}

/// Resolves nothing: every call is `unresolved` and no value has a
/// resolution. For a file Raven has no scope for (a path that isn't a file
/// URL), and for unit tests of the rest of the document.
pub(crate) struct NoScope;

impl NameResolver for NoScope {
    fn resolve(&self, _text: &str, queries: &[NameQuery]) -> Vec<Option<Resolution>> {
        queries
            .iter()
            .map(|query| {
                (!query.value).then_some(Resolution::Unresolved {
                    reason: None,
                    packages: Vec::new(),
                })
            })
            .collect()
    }
}

/// The resolver for the file at `fs_path` with decoded `text`: the snapshot
/// `raven check` builds for it. An indexed file reuses its index entry, as
/// `raven check`'s parallel pass does; any other file is opened from `text`
/// for the snapshot and closed again, as `raven check` does its disk-fallback
/// targets.
pub(crate) fn workspace_names(
    state: &mut crate::state::WorldState,
    fs_path: &std::path::Path,
    text: &str,
    root: &std::path::Path,
) -> Box<dyn NameResolver> {
    let Ok(uri) = Url::from_file_path(fs_path) else {
        return Box::new(NoScope);
    };
    let indexed = state.workspace_index.contains(&uri);
    if !indexed {
        crate::cli::check::open_disk_fallback_target(state, &uri, fs_path, text);
    }
    let plan = crate::cli::check::prepare_cli_contextual_providers(state, &uri);
    let snapshot = match state.workspace_index.get(&uri).filter(|_| indexed) {
        Some(entry) => {
            let document = crate::state::document_from_workspace_entry(
                &uri,
                &entry,
                crate::chunks::classify_chunk_document(uri.path()),
            );
            let mut open_documents = crate::open_document_store::OpenDocumentStore::new();
            open_documents.open_prepared(
                uri.clone(),
                document,
                entry.metadata.clone(),
                entry.artifacts.clone(),
                None,
            );
            DiagnosticsSnapshot::build_with_open_documents_and_extra_providers(
                state,
                &uri,
                &open_documents,
                &plan.extras,
                plan.divergence,
            )
        }
        None => {
            let snapshot = DiagnosticsSnapshot::build_with_open_documents_and_extra_providers(
                state,
                &uri,
                &state.documents,
                &plan.extras,
                plan.divergence,
            );
            state.close_document(&uri);
            snapshot
        }
    };
    match snapshot {
        Some(snapshot) => Box::new(WorkspaceNames::new(snapshot, uri, root.to_path_buf())),
        None => Box::new(NoScope),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_points_count_newlines_and_utf16() {
        let text = "a\r\nb😀c\rd\ne";
        let points = ScopePoints::new(text);
        assert_eq!(points.at(0), (0, 0));
        assert_eq!(points.at(text.find('b').unwrap()), (1, 0));
        // `😀` is two UTF-16 units.
        assert_eq!(points.at(text.find('c').unwrap()), (1, 3));
        // A lone `\r` doesn't end a line for the scope.
        assert_eq!(points.at(text.find('d').unwrap()), (1, 5));
        assert_eq!(points.at(text.find('e').unwrap()), (2, 0));
    }

    #[test]
    fn scope_positions_convert_back_to_document_positions() {
        let text = "a\r\nb😀c\rd\ne";
        let points = ScopePoints::new(text);
        let document = super::super::document::LineIndex::new(text);
        // Every character a name can start at: not a line ending.
        for (offset, _) in text
            .char_indices()
            .filter(|(_, ch)| !matches!(ch, '\r' | '\n'))
        {
            let (line, column) = points.at(offset);
            assert_eq!(
                points.document_position(line, column),
                document.position(offset),
                "offset {offset}"
            );
        }
        // Without a lone `\r` the positions are the scope's.
        let crlf = ScopePoints::new("a\r\nb\nc");
        assert_eq!(
            crlf.document_position(1, 0),
            Position {
                line: 1,
                character: 0
            }
        );
    }
}
