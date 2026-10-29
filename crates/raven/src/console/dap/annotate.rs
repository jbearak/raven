//! Breakpoint anchoring and source injection (design §5.2–5.3).
//!
//! Code sent from the editor is rewritten as text before R parses it: each
//! breakpoint gets a probe statement inserted just before the statement it is
//! anchored to, and `#line` directives keep every srcref pointing at the
//! user's file and line. The probe's own lines carry the marker file
//! [`PROBE_FILE`] so the console can step through them unseen.
//!
//! Injection is allowed only where the statement is certain to run as code
//! (§5.3): every enclosing construct must be core syntax, or a call to a
//! function in [`known_callee`] that R confirms (by identity, at feed time) is
//! the expected function, and nothing in the expression may rebind any name
//! the path or the probe relies on. Anything else is left untouched and the
//! breakpoint gets a reason instead.
//!
//! Two phases, because callee identity can only be checked by R: [`plan`]
//! works out anchors and the callees each injection depends on; the caller
//! asks R which callees are genuine; [`render`] writes the text with the
//! accepted probes.

use std::collections::BTreeSet;

use tree_sitter::{Node, Parser, Tree};

/// Marker srcfile name for probe and scaffolding lines.
pub const PROBE_FILE: &str = "<raven-probe>";

/// One breakpoint to place: its id and its 1-based line in the file.
#[derive(Debug, Clone)]
pub struct BpRequest {
    pub id: String,
    pub line: u32,
}

/// A function the path to an injection passes through, which R must confirm.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Callee {
    pub name: String,
    pub pkg: String,
}

/// Where one breakpoint lands.
#[derive(Debug, Clone)]
pub enum Placement {
    /// Inject a probe before the statement starting at `byte` (offset into
    /// the expression text), whose first line is file line `line`. When
    /// `brace_end` is set the statement is an unbraced function body ending
    /// at that byte, which gets braced so the probe runs inside the function.
    Inject {
        id: String,
        byte: usize,
        line: u32,
        callees: Vec<Callee>,
        brace_end: Option<usize>,
    },
    /// Not injectable; `reason` is shown to the user.
    Invalid { id: String, reason: String },
}

/// Result of [`plan`] for one expression (or one file).
#[derive(Debug, Clone, Default)]
pub struct Plan {
    pub placements: Vec<Placement>,
}

impl Plan {
    /// Every injection, ignoring callee confirmation.
    #[cfg(test)]
    pub fn injections(&self) -> Vec<Injection> {
        self.placements
            .iter()
            .filter_map(|p| match p {
                Placement::Inject {
                    id,
                    byte,
                    brace_end,
                    ..
                } => Some(Injection {
                    byte: *byte,
                    id: id.clone(),
                    brace_end: *brace_end,
                }),
                Placement::Invalid { .. } => None,
            })
            .collect()
    }

    /// Every callee any injection depends on (for one batched R check).
    pub fn callees(&self) -> BTreeSet<Callee> {
        let mut out = BTreeSet::new();
        for p in &self.placements {
            if let Placement::Inject { callees, .. } = p {
                out.extend(callees.iter().cloned());
            }
        }
        out
    }
}

/// How a known function treats its arguments.
#[derive(Debug, Clone, Copy)]
enum ArgUse {
    /// Standard evaluation: every argument is evaluated as code (closures,
    /// braced blocks), e.g. `lapply`.
    All,
    /// Only the argument at this position / with this name runs as code
    /// (now or later), e.g. `tryCatch(expr = ...)`.
    Code(&'static [(usize, &'static str)]),
}

/// The table of functions whose code arguments may hold probes. `pkg` is
/// the namespace the identity check compares against.
fn known_callee(name: &str) -> Option<(&'static str, ArgUse)> {
    use ArgUse::*;
    let first: &'static [(usize, &'static str)] = &[(0, "expr")];
    Some(match name {
        "local"
        | "suppressWarnings"
        | "suppressMessages"
        | "suppressPackageStartupMessages"
        | "invisible"
        | "system.time"
        | "withVisible"
        | "force"
        | "identity" => ("base", Code(first)),
        // Handlers are evaluated (to functions) too.
        "try" | "tryCatch" | "withCallingHandlers" => ("base", All),
        "with" => ("base", Code(&[(1, "expr")])),
        "within" => ("base", Code(&[(1, "expr")])),
        "lapply" | "sapply" | "vapply" | "mapply" | "Map" | "Filter" | "Reduce" | "Find"
        | "Position" | "outer" | "apply" | "tapply" | "do.call" | "Recall" | "on.exit"
        | "print" | "return" | "stopifnot" | "structure" | "list" | "c" => ("base", All),
        "test_that" => ("testthat", Code(&[(1, "code")])),
        "describe" => ("testthat", Code(&[(1, "code")])),
        "it" => ("testthat", Code(&[(1, "code")])),
        "observeEvent" => ("shiny", Code(&[(0, "eventExpr"), (1, "handlerExpr")])),
        "eventReactive" => ("shiny", Code(&[(0, "eventExpr"), (1, "valueExpr")])),
        "observe" | "reactive" | "isolate" | "renderPlot" | "renderText" | "renderPrint"
        | "renderUI" | "renderTable" | "renderImage" | "renderDataTable" | "renderCachedPlot" => {
            ("shiny", Code(&[(0, "x"), (0, "expr")]))
        }
        "shinyApp" | "moduleServer" | "shinyServer" => ("shiny", All),
        "R6Class" => ("R6", All),
        // Not setGeneric: a probe in `def` would make it non-standard.
        "setRefClass" | "setMethod" | "setClass" | "setValidity" => ("methods", All),
        "map" | "map_dbl" | "map_chr" | "map_int" | "map_lgl" | "map_dfr" | "map_dfc" | "walk"
        | "imap" | "map2" | "pmap" | "walk2" | "iwalk" | "map_vec" | "modify" | "keep"
        | "discard" | "reduce" => ("purrr", All),
        _ => return None,
    })
}

/// Names whose binding, if changed inside the expression, would change how
/// the probe or the path to it is evaluated (core syntax and the probe's own
/// lookups; §5.2, §5.3).
const CORE_NAMES: &[&str] = &[
    "{", "(", "if", "for", "while", "repeat", "<-", "=", "<<-", "function", "::",
];

/// Calls that change scope dynamically; with any of these in the expression,
/// injections that depend on a callee check are refused (§5.3).
const DYNAMIC_SCOPE: &[&str] = &[
    "eval",
    "evalq",
    "list2env",
    "attach",
    "sys.source",
    "environment<-",
    "sys.function",
];

pub fn parse(text: &str) -> Option<Tree> {
    let mut parser = Parser::new();
    parser.set_language(&tree_sitter_r::LANGUAGE.into()).ok()?;
    parser.parse(text, None)
}

fn node_text<'a>(n: Node, text: &'a str) -> &'a str {
    &text[n.byte_range()]
}

/// An identifier's name without backticks.
fn ident_name(n: Node, text: &str) -> Option<String> {
    match n.kind() {
        "identifier" => {
            let t = node_text(n, text);
            Some(t.trim_matches('`').to_string())
        }
        "string" => {
            let t = node_text(n, text);
            let t = t.trim_start_matches(['r', 'R']);
            Some(t.trim_matches(|c| c == '"' || c == '\'').to_string())
        }
        _ => None,
    }
}

fn is_statement_parent(n: Node) -> bool {
    matches!(n.kind(), "braced_expression" | "program")
}

/// An unbraced function body (`function(x) x + 1`): a statement position
/// once [`render`] braces it.
fn unbraced_body(n: Node) -> bool {
    n.kind() != "braced_expression"
        && n.parent().is_some_and(|p| {
            p.kind() == "function_definition"
                && p.child_by_field_name("body").map(|b| b.id()) == Some(n.id())
        })
}

/// Statement nodes: direct named children of `{}` bodies and of the
/// program, and unbraced function bodies, excluding comments.
fn collect_statements<'t>(root: Node<'t>, out: &mut Vec<Node<'t>>) {
    let mut stack = vec![root];
    while let Some(n) = stack.pop() {
        let mut c = n.walk();
        for child in n.named_children(&mut c) {
            if child.kind() == "comment" {
                continue;
            }
            if is_statement_parent(n) || unbraced_body(child) {
                out.push(child);
            }
            stack.push(child);
        }
    }
}

/// The unbraced body on `row` of a statement that only defines a function
/// (`f <- function(x) x + 1`, or a bare `function(x) x`): stopping where the
/// definition runs shows nothing, so the breakpoint goes inside.
fn defined_body_on_row<'t>(stmt: Node<'t>, text: &str, row: usize) -> Option<Node<'t>> {
    let def = match stmt.kind() {
        "function_definition" => stmt,
        "binary_operator" => {
            let op = stmt
                .child_by_field_name("operator")
                .map(|o| node_text(o, text))?;
            let value = match op {
                "<-" | "=" | "<<-" => stmt.child_by_field_name("rhs")?,
                "->" | "->>" => stmt.child_by_field_name("lhs")?,
                _ => return None,
            };
            (value.kind() == "function_definition").then_some(value)?
        }
        _ => return None,
    };
    let body = def.child_by_field_name("body")?;
    (unbraced_body(body) && body.start_position().row == row).then_some(body)
}

/// What a line holds, for anchoring.
fn line_is_blank_or_closing(line: &str) -> bool {
    let t = line.trim();
    t.is_empty() || t.starts_with('#') || t.chars().all(|c| c == '}' || c.is_whitespace())
}

/// Choose the statement a breakpoint on row `row` (0-based, relative to the
/// text) anchors to.
fn anchor<'t>(
    stmts: &[Node<'t>],
    text: &str,
    lines: &[&str],
    row: usize,
) -> Result<Node<'t>, String> {
    let starting: Vec<&Node> = stmts
        .iter()
        .filter(|s| s.start_position().row == row)
        .collect();
    if let Some(s) = starting.iter().min_by_key(|s| s.start_byte()) {
        return Ok(defined_body_on_row(**s, text, row).unwrap_or(**s));
    }
    let line = lines.get(row).copied().unwrap_or("");
    if line_is_blank_or_closing(line) {
        return Err("no expression on this line".into());
    }
    stmts
        .iter()
        .filter(|s| s.start_position().row < row && s.end_position().row >= row)
        .max_by_key(|s| s.start_byte())
        .copied()
        .ok_or_else(|| "no expression on this line".into())
}

/// Collect every name the expression could bind: assignment targets,
/// parameters, `for` variables, and `assign()`-style string targets.
fn bound_names(root: Node, text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut stack = vec![root];
    while let Some(n) = stack.pop() {
        match n.kind() {
            "binary_operator" => {
                let op = n
                    .child_by_field_name("operator")
                    .map(|o| node_text(o, text))
                    .unwrap_or("");
                let target = match op {
                    "<-" | "=" | "<<-" | ":=" => n.child_by_field_name("lhs"),
                    "->" | "->>" => n.child_by_field_name("rhs"),
                    _ => None,
                };
                if let Some(name) = target.and_then(|t| ident_name(t, text)) {
                    out.insert(name);
                }
            }
            "parameter" => {
                if let Some(name) = n
                    .child_by_field_name("name")
                    .and_then(|t| ident_name(t, text))
                {
                    out.insert(name);
                }
            }
            "for_statement" => {
                if let Some(name) = n
                    .child_by_field_name("variable")
                    .and_then(|t| ident_name(t, text))
                {
                    out.insert(name);
                }
            }
            "call" => {
                let f = n
                    .child_by_field_name("function")
                    .and_then(|f| callee_of(f, text))
                    .map(|(name, _)| name);
                if matches!(
                    f.as_deref(),
                    Some("assign" | "delayedAssign" | "makeActiveBinding")
                ) && let Some(first) = first_arg_value(n)
                    && let Some(name) = ident_name(first, text).filter(|_| first.kind() == "string")
                {
                    out.insert(name);
                }
            }
            _ => {}
        }
        let mut c = n.walk();
        for child in n.named_children(&mut c) {
            stack.push(child);
        }
    }
    out
}

fn first_arg_value(call: Node) -> Option<Node> {
    let args = call.child_by_field_name("arguments")?;
    let mut c = args.walk();
    let first = args
        .named_children(&mut c)
        .find(|a| a.kind() == "argument")?;
    first.child_by_field_name("value")
}

/// `(name, explicit_pkg)` for a call's function position.
fn callee_of(f: Node, text: &str) -> Option<(String, Option<String>)> {
    match f.kind() {
        "identifier" => ident_name(f, text).map(|n| (n, None)),
        "namespace_operator" => {
            let pkg = f
                .child_by_field_name("lhs")
                .and_then(|l| ident_name(l, text))?;
            let name = f
                .child_by_field_name("rhs")
                .and_then(|r| ident_name(r, text))?;
            Some((name, Some(pkg)))
        }
        _ => None,
    }
}

fn calls_any(root: Node, text: &str, names: &[&str]) -> bool {
    let mut stack = vec![root];
    while let Some(n) = stack.pop() {
        if n.kind() == "call"
            && let Some((name, _)) = n
                .child_by_field_name("function")
                .and_then(|f| callee_of(f, text))
            && names.contains(&name.as_str())
        {
            return true;
        }
        let mut c = n.walk();
        for child in n.named_children(&mut c) {
            stack.push(child);
        }
    }
    false
}

/// The position (0-based, among unnamed arguments) and name of `arg` within
/// its call.
fn arg_slot(argument: Node, text: &str) -> (Option<usize>, Option<String>) {
    let name = argument
        .child_by_field_name("name")
        .and_then(|n| ident_name(n, text));
    if name.is_some() {
        return (None, name);
    }
    let Some(args) = argument.parent() else {
        return (None, None);
    };
    let mut c = args.walk();
    let mut pos = 0usize;
    for a in args.named_children(&mut c) {
        if a.kind() != "argument" {
            continue;
        }
        if a.id() == argument.id() {
            return (Some(pos), None);
        }
        if a.child_by_field_name("name").is_none() {
            pos += 1;
        }
    }
    (None, None)
}

/// Walk from `stmt` up to the root, checking that every enclosing construct
/// runs its contents as code. Returns the callees that must be confirmed.
fn executable_path(stmt: Node, text: &str) -> Result<Vec<Callee>, String> {
    let mut callees = Vec::new();
    let mut node = stmt;
    while let Some(parent) = node.parent() {
        match parent.kind() {
            "program" => break,
            "braced_expression" | "parenthesized_expression" => {}
            "if_statement" | "for_statement" | "while_statement" | "repeat_statement" => {
                // Condition, sequence and bodies are all evaluated.
            }
            "function_definition" => {
                let body = parent.child_by_field_name("body");
                if body.map(|b| b.id()) != Some(node.id()) {
                    return Err(
                        "inside a default argument: Raven can't verify this runs as code".into(),
                    );
                }
            }
            "binary_operator" => {
                let op = parent
                    .child_by_field_name("operator")
                    .map(|o| node_text(o, text))
                    .unwrap_or("");
                let value_side = match op {
                    "<-" | "=" | "<<-" => parent.child_by_field_name("rhs"),
                    "->" | "->>" => parent.child_by_field_name("lhs"),
                    _ => None,
                };
                if value_side.map(|v| v.id()) != Some(node.id()) {
                    return Err(format!(
                        "inside `{op}`: Raven can't verify this runs as code"
                    ));
                }
            }
            "argument" => {
                let args = parent.parent().ok_or("malformed call")?;
                let call = args.parent().ok_or("malformed call")?;
                if call.kind() != "call" {
                    return Err(
                        "inside an index expression: Raven can't verify this runs as code".into(),
                    );
                }
                let Some((name, pkg)) = call
                    .child_by_field_name("function")
                    .and_then(|f| callee_of(f, text))
                else {
                    return Err("inside a call to a computed function: Raven can't verify this runs as code".into());
                };
                let Some((table_pkg, usage)) = known_callee(&name) else {
                    return Err(format!(
                        "inside `{name}()`: Raven can't verify this runs as code"
                    ));
                };
                if let Some(p) = pkg.as_deref()
                    && p != table_pkg
                {
                    return Err(format!(
                        "inside `{p}::{name}()`: Raven can't verify this runs as code"
                    ));
                }
                let ok = match usage {
                    ArgUse::All => true,
                    ArgUse::Code(slots) => {
                        let (pos, aname) = arg_slot(parent, text);
                        slots.iter().any(|(p, n)| {
                            aname.as_deref() == Some(*n) || (aname.is_none() && pos == Some(*p))
                        })
                    }
                };
                if !ok {
                    return Err(format!(
                        "inside `{name}()`: this argument isn't run as code"
                    ));
                }
                callees.push(Callee {
                    name,
                    pkg: table_pkg.to_string(),
                });
                node = call;
                continue;
            }
            "unary_operator" => {
                let op = parent
                    .child_by_field_name("operator")
                    .map(|o| node_text(o, text))
                    .unwrap_or("");
                if op == "~" {
                    return Err("inside a formula: captured as data".into());
                }
            }
            other => {
                return Err(format!(
                    "inside `{}`: Raven can't verify this runs as code",
                    other.replace('_', " ")
                ));
            }
        }
        node = parent;
    }
    Ok(callees)
}

/// Work out where each breakpoint in `bps` lands in `text`, an expression
/// (or file) whose first character is at file line `first_line` (1-based).
/// Breakpoints outside the text's lines are ignored.
pub fn plan(text: &str, first_line: u32, bps: &[BpRequest]) -> Plan {
    let mut out = Plan::default();
    let n_lines = text.lines().count().max(1) as u32;
    let relevant: Vec<&BpRequest> = bps
        .iter()
        .filter(|b| b.line >= first_line && b.line < first_line + n_lines)
        .collect();
    if relevant.is_empty() {
        return out;
    }
    let Some(tree) = parse(text) else {
        for b in relevant {
            out.placements.push(Placement::Invalid {
                id: b.id.clone(),
                reason: "couldn't parse this code".into(),
            });
        }
        return out;
    };
    let root = tree.root_node();
    let lines: Vec<&str> = text.lines().collect();
    let mut stmts = Vec::new();
    collect_statements(root, &mut stmts);
    let bound = bound_names(root, text);
    let dynamic = calls_any(root, text, DYNAMIC_SCOPE);
    let core_rebound: Vec<&str> = CORE_NAMES
        .iter()
        .copied()
        .filter(|n| bound.contains(*n))
        .collect();
    for b in relevant {
        let row = (b.line - first_line) as usize;
        let placement = match anchor(&stmts, text, &lines, row) {
            Err(reason) => Placement::Invalid {
                id: b.id.clone(),
                reason,
            },
            Ok(stmt) => match executable_path(stmt, text) {
                Err(reason) => Placement::Invalid {
                    id: b.id.clone(),
                    reason,
                },
                Ok(callees) => {
                    if let Some(name) = core_rebound.first() {
                        Placement::Invalid {
                            id: b.id.clone(),
                            reason: format!("`{name}` may be rebound in this code"),
                        }
                    } else if let Some(c) = callees.iter().find(|c| bound.contains(&c.name)) {
                        Placement::Invalid {
                            id: b.id.clone(),
                            reason: format!("`{}` may be rebound in this code", c.name),
                        }
                    } else if !callees.is_empty() && dynamic {
                        Placement::Invalid {
                            id: b.id.clone(),
                            reason: "this code changes scope dynamically (eval, attach, …): Raven can't verify the calls around this line".into(),
                        }
                    } else {
                        Placement::Inject {
                            id: b.id.clone(),
                            byte: stmt.start_byte(),
                            line: first_line + stmt.start_position().row as u32,
                            callees,
                            brace_end: unbraced_body(stmt).then(|| stmt.end_byte()),
                        }
                    }
                }
            },
        };
        out.placements.push(placement);
    }
    out
}

/// The probe statement for breakpoint `id` (§5.2): nothing in it is looked
/// up by a name user code can mask except `::` and the bare `browser`, which
/// must stay bare so R's JIT leaves the function uncompiled.
pub fn probe(id: &str, pid: u32) -> String {
    format!(
        "base::`if`(base::identical(base::Sys.getpid(), {pid}L), base::getOption(\"raven.debug_hook\", base::alist)(\"{id}\", base::environment(), browser()))"
    )
}

/// An R string literal's body is not escaped by `#line`; refuse paths that
/// would end it early.
pub fn line_directive_safe(path: &str) -> bool {
    !path.contains('"') && !path.contains('\n')
}

/// How [`render`] frames the text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wrap {
    /// REPL input: R's interactive REPL honours `#line` only inside a braced
    /// expression **[probe]**, so the text goes inside `{ … }` (§3).
    Braced,
    /// Text R parses with `parse(text=)` (the `source()` and pkgload hooks),
    /// where `#line` works at top level, so the file's own top-level
    /// expressions (and `source(echo=)`) are kept as they are.
    File,
}

/// One probe for [`render`]: before the statement at `byte`, bracing it up
/// to `brace_end` when set (see [`Placement`]).
#[derive(Debug, Clone)]
pub struct Injection {
    pub byte: usize,
    pub id: String,
    pub brace_end: Option<usize>,
}

/// Write `text` with a probe before each accepted injection; `#line`
/// directives map every user line back to `path` (§3). `first_col` is the
/// column (in characters) where `text` starts.
pub fn render(
    text: &str,
    path: &str,
    first_line: u32,
    first_col: usize,
    injections: &[Injection],
    pid: u32,
    wrap: Wrap,
) -> String {
    // Edits in text order. At one byte, closing braces come before probes,
    // and an inner (later-opened) brace closes before an outer one.
    enum Edit<'a> {
        Close,
        Open(&'a Injection),
    }
    let mut edits: Vec<(usize, u8, std::cmp::Reverse<usize>, Edit)> = Vec::new();
    for inj in injections {
        edits.push((inj.byte, 1, std::cmp::Reverse(0), Edit::Open(inj)));
        if let Some(end) = inj.brace_end {
            edits.push((end, 0, std::cmp::Reverse(inj.byte), Edit::Close));
        }
    }
    edits.sort_by_key(|e| (e.0, e.1, e.2));
    // File line and column of byte `at`.
    let position = |at: usize| {
        let line_start = text[..at].rfind('\n').map(|i| i + 1).unwrap_or(0);
        let mut col = text[line_start..at].chars().count();
        if line_start == 0 {
            col += first_col;
        }
        let line = first_line + text[..at].matches('\n').count() as u32;
        (line, col)
    };
    let mut out = String::with_capacity(text.len() + 128 * (edits.len() + 1));
    if wrap == Wrap::Braced {
        out.push_str("{\n");
    }
    out.push_str(&format!("#line {first_line} \"{path}\"\n"));
    out.push_str(&" ".repeat(first_col));
    let mut last = 0usize;
    for (byte, _, _, edit) in edits {
        out.push_str(&text[last..byte]);
        last = byte;
        let (line, col) = position(byte);
        if matches!(edit, Edit::Open(inj) if inj.brace_end.is_some()) {
            out.push('{');
        }
        out.push_str(&format!("\n#line 1 \"{PROBE_FILE}\"\n"));
        match edit {
            Edit::Close => out.push_str("}\n"),
            Edit::Open(inj) => {
                out.push_str(&probe(&inj.id, pid));
                out.push('\n');
            }
        }
        out.push_str(&format!("#line {line} \"{path}\"\n"));
        out.push_str(&" ".repeat(col));
    }
    out.push_str(&text[last..]);
    if !out.ends_with('\n') {
        out.push('\n');
    }
    if wrap == Wrap::Braced {
        out.push_str("}\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bp(id: &str, line: u32) -> BpRequest {
        BpRequest {
            id: id.into(),
            line,
        }
    }

    fn injected(plan: &Plan) -> Vec<(String, u32)> {
        plan.placements
            .iter()
            .filter_map(|p| match p {
                Placement::Inject { id, line, .. } => Some((id.clone(), *line)),
                _ => None,
            })
            .collect()
    }

    fn invalid(plan: &Plan) -> Vec<(String, String)> {
        plan.placements
            .iter()
            .filter_map(|p| match p {
                Placement::Invalid { id, reason } => Some((id.clone(), reason.clone())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn anchors_statements_inside_function_bodies() {
        let src = "f <- function(x) {\n  y <- x + 1\n  z <- y * 2\n  z\n}\n";
        let p = plan(src, 10, &[bp("a", 11), bp("b", 13), bp("c", 14)]);
        assert_eq!(injected(&p), vec![("a".into(), 11), ("b".into(), 13)]);
        assert_eq!(invalid(&p).len(), 1, "the closing brace can't hold one");
    }

    #[test]
    fn closing_brace_and_blank_lines_are_invalid() {
        let src = "f <- function(x) {\n  y <- 1\n\n}\n";
        let p = plan(src, 1, &[bp("a", 3), bp("b", 4)]);
        assert!(injected(&p).is_empty());
        assert_eq!(invalid(&p).len(), 2);
        assert!(invalid(&p)[0].1.contains("no expression"));
    }

    #[test]
    fn continuation_lines_move_to_the_statement_start() {
        let src = "f <- function() {\n  x <- c(1,\n         2)\n}\n";
        let p = plan(src, 1, &[bp("a", 3)]);
        assert_eq!(injected(&p), vec![("a".into(), 2)]);
    }

    #[test]
    fn top_level_statements_are_injectable() {
        let src = "x <- 1\n";
        let p = plan(src, 5, &[bp("a", 5)]);
        assert_eq!(injected(&p), vec![("a".into(), 5)]);
    }

    #[test]
    fn unknown_callee_arguments_are_left_alone() {
        let src = "foo({\n  x <- 1\n})\n";
        let p = plan(src, 1, &[bp("a", 2)]);
        assert!(injected(&p).is_empty());
        assert!(invalid(&p)[0].1.contains("foo()"));
    }

    #[test]
    fn known_callees_need_confirmation() {
        let src = "local({\n  x <- 1\n})\n";
        let p = plan(src, 1, &[bp("a", 2)]);
        match &p.placements[0] {
            Placement::Inject { callees, .. } => {
                assert_eq!(callees[0].name, "local");
                assert_eq!(callees[0].pkg, "base");
            }
            other => panic!("expected injection, got {other:?}"),
        }
    }

    #[test]
    fn unbraced_function_bodies_are_braced() {
        // A body on its own line, and a one-line definition: both stop when
        // the function runs, not when it is defined.
        let src = "f <- function(x)\n  x + 1\ng <- function(y) y * 2; h()\n";
        let p = plan(src, 1, &[bp("a", 2), bp("b", 3)]);
        assert_eq!(injected(&p), vec![("a".into(), 2), ("b".into(), 3)]);
        let out = render(src, "/a.R", 1, 0, &p.injections(), 1, Wrap::File);
        assert!(out.contains("f <- function(x)\n  {\n#line 1"), "{out}");
        assert!(
            out.contains(
                "#line 2 \"/a.R\"\n  x + 1\n#line 1 \"<raven-probe>\"\n}\n#line 2 \"/a.R\"\n"
            ),
            "{out}"
        );
        // `h()` keeps its column after the closing brace.
        assert!(
            out.contains("#line 3 \"/a.R\"\n                      ; h()"),
            "{out}"
        );
        // Plain top-level statements are not functions' bodies.
        let p = plan("x <- y + 1\n", 1, &[bp("c", 1)]);
        assert!(p.injections()[0].brace_end.is_none());
    }

    #[test]
    fn only_code_arguments_qualify() {
        let src = "with({\n  a()\n}, {\n  b()\n})\n";
        let p = plan(src, 1, &[bp("a", 2), bp("b", 4)]);
        assert_eq!(injected(&p), vec![("b".into(), 4)]);
        assert!(invalid(&p)[0].1.contains("isn't run as code"));
    }

    #[test]
    fn condition_handlers_and_class_methods_qualify() {
        let src = "tryCatch(a(), error = function(e) {\n  b()\n})\nR6Class(\"C\", public = list(m = function() {\n  c()\n}))\nsetMethod(\"show\", \"C\", function(object) {\n  d()\n})\n";
        let p = plan(src, 1, &[bp("b", 2), bp("c", 5), bp("d", 8)]);
        assert_eq!(
            injected(&p),
            vec![("b".into(), 2), ("c".into(), 5), ("d".into(), 8)]
        );
    }

    #[test]
    fn local_rebinding_of_a_callee_is_refused() {
        let src = "f <- function() {\n  local <- function(x) substitute(x)\n  local({\n    x <- 1\n  })\n}\n";
        let p = plan(src, 1, &[bp("a", 4)]);
        assert!(injected(&p).is_empty());
        assert!(invalid(&p)[0].1.contains("`local` may be rebound"));
    }

    #[test]
    fn rebinding_core_syntax_is_refused() {
        let src = "f <- function() {\n  `if` <- function(...) NULL\n  x <- 1\n}\n";
        let p = plan(src, 1, &[bp("a", 3)]);
        assert!(injected(&p).is_empty());
        assert!(invalid(&p)[0].1.contains("`if`"));
    }

    #[test]
    fn formulas_and_quoting_are_refused() {
        let src = "g <- quote({\n  x <- 1\n})\n";
        let p = plan(src, 1, &[bp("a", 2)]);
        assert!(injected(&p).is_empty());
    }

    #[test]
    fn data_table_style_indexing_is_refused() {
        let src = "dt[, {\n  x <- 1\n}]\n";
        let p = plan(src, 1, &[bp("a", 2)]);
        assert!(injected(&p).is_empty());
    }

    #[test]
    fn render_keeps_user_lines_and_marks_probes() {
        let src = "f <- function() {\n  y <- 1\n}";
        let p = plan(src, 7, &[bp("a", 8)]);
        let out = render(src, "/w/a.R", 7, 0, &p.injections(), 42, Wrap::Braced);
        assert!(out.starts_with("{\n#line 7 \"/w/a.R\"\n"));
        assert!(out.contains("#line 1 \"<raven-probe>\"\n"));
        assert!(out.contains("Sys.getpid(), 42L"));
        assert!(out.contains("#line 8 \"/w/a.R\"\n  y <- 1"));
        assert!(out.trim_end().ends_with('}'));
    }

    #[test]
    fn render_pads_the_first_line_to_its_column() {
        let out = render("x <- 1", "/a.R", 3, 4, &[], 1, Wrap::Braced);
        assert_eq!(out, "{\n#line 3 \"/a.R\"\n    x <- 1\n}\n");
    }

    #[test]
    fn file_mode_has_no_wrapper() {
        let out = render(
            "a <- 1\nb <- 2",
            "/a.R",
            1,
            0,
            &[Injection {
                byte: 7,
                id: "x".into(),
                brace_end: None,
            }],
            1,
            Wrap::File,
        );
        assert!(out.starts_with("#line 1 \"/a.R\"\na <- 1\n"));
        assert!(out.contains("#line 2 \"/a.R\"\nb <- 2"));
        assert!(!out.contains('{'));
    }

    #[test]
    fn namespace_qualified_known_callee() {
        let src = "testthat::test_that(\"t\", {\n  expect_true(TRUE)\n})\n";
        let p = plan(src, 1, &[bp("a", 2)]);
        assert_eq!(injected(&p), vec![("a".into(), 2)]);
    }
}
