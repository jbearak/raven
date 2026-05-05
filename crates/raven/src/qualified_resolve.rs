//! Resolve and enumerate candidates for the RHS identifier of `$` and `@`.
//!
//! See `docs/superpowers/specs/2026-05-02-dollar-rhs-goto-def-design.md`.
//!
//! For `foo$bar` (or `foo@bar`) where the cursor is on `bar`:
//!
//! 1. Resolve `foo` via the existing position-aware scope.
//! 2. Collect candidates from the defining file and the files that actually
//!    contribute to the cursor's resolved cross-file scope:
//!    - **Defining file**: `foo$bar <- ...` member-assignments,
//!      statically named string-subscript assignments like
//!      `foo[["bar"]] <- ...`, and any constructor-call named argument
//!      from the allowlist. Filtered by same-function-scope and
//!      "effect position at or after the binding".
//!      Defining-file candidates are also filtered by
//!      `candidate_effect_visible_in_scope`, which excludes candidates past
//!      the parent file's `source()` site that made the cursor file visible.
//!    - **Every non-defining file in the cursor scope's contributor chain**:
//!      each `foo$bar <- ...` or statically named string-subscript site is
//!      validated by re-resolving `foo` at that site's position via cross-file
//!      scope; only sites where `foo` resolves to the *same* binding are kept.
//!      Using the resolved scope's `chain` and per-file visible cutoffs avoids
//!      false positives from files that merely depend on the cursor file or
//!      from parent files past the `source()` call site that brought the cursor
//!      file into scope.
//! 3. Tie-break: `pick_winner` partitions all candidates by whether their
//!    `uri` equals the cursor's. The in-cursor-file partition is filtered
//!    by `effect <= cursor`, then the candidate with the latest effect
//!    wins. If no in-cursor-file candidate qualifies, the other-file
//!    partition first chooses the file with the shortest dependency-graph
//!    distance from the cursor file, then chooses that file's latest-effect
//!    candidate. Contributor-chain order and URI only break ties where graph
//!    distance is equal or unavailable.
//!
//!    In the **same-file case** (cursor file = defining file), defining-file
//!    candidates live in the cursor partition and are filtered by
//!    `effect <= cursor`. Non-defining contributor-chain candidates can still
//!    be used as a fallback if no cursor-file candidate qualifies.
//! 4. Never fall back to free-identifier lookup.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet, VecDeque};

use tower_lsp::lsp_types::{Location, Position, Range, Url};
use tree_sitter::{Node, Tree};

use crate::cross_file::scope::LineIndex;
use crate::extract_op::ExtractOp;
use crate::handlers::DiagCancelToken;
use crate::state::WorldState;
use crate::utf16::{byte_offset_to_utf16_column, utf16_column_to_byte_offset};

/// Identifier we attach to a candidate's enclosing function-definition node,
/// so two candidates can be checked for "same function scope". `None`
/// represents top-level (outside any function_definition).
type FunctionScopeId = Option<usize>;

const CONSTRUCTOR_ALLOWLIST: &[&str] = &[
    "list",
    "c",
    "data.frame",
    "tibble",
    "data.table",
    "environment",
    "list2env",
    "new",
];

/// Position at which a candidate's binding becomes visible. Stored in
/// UTF-16 columns (the LSP `Position.character` unit) so it can be compared
/// directly against an LSP cursor position.
#[derive(Debug, Clone, Copy)]
struct EffectPos {
    line: u32,
    utf16_column: u32,
}

impl EffectPos {
    fn from_node_end(node: Node, line_index: &LineIndex) -> Self {
        let p = node.end_position();
        let line_text = line_index.get_line(p.row);
        Self {
            line: p.row as u32,
            utf16_column: byte_offset_to_utf16_column(line_text, p.column),
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn member_assignment_candidate_from_extract(
    assignment: Node,
    target: Node,
    text: &str,
    line_index: &LineIndex,
    file_uri: &Url,
    lhs_name: &str,
    rhs_name: Option<&str>,
    op: ExtractOp,
) -> Option<Candidate> {
    if target.kind() != "extract_operator" {
        return None;
    }
    let target_op = target.child_by_field_name("operator")?;
    if !matches!(
        (target_op.kind(), op),
        ("$", ExtractOp::Dollar) | ("@", ExtractOp::At)
    ) {
        return None;
    }
    let t_lhs = target.child_by_field_name("lhs")?;
    let t_rhs = target.child_by_field_name("rhs")?;
    if t_lhs.kind() != "identifier" || t_rhs.kind() != "identifier" {
        return None;
    }
    let member_name = node_text(t_rhs, text);
    if node_text(t_lhs, text) != lhs_name
        || rhs_name.is_some_and(|rhs_name| member_name != rhs_name)
    {
        return None;
    }
    let lhs_range = node_range_in_text(t_lhs, line_index);
    Some(Candidate {
        name: member_name.to_string(),
        uri: file_uri.clone(),
        effect: EffectPos::from_node_end(assignment, line_index),
        name_range: node_range_in_text(t_rhs, line_index),
        fn_scope: enclosing_function_id(assignment),
        lhs_pos: lhs_range.start,
    })
}

#[allow(clippy::too_many_arguments)]
fn member_assignment_candidate_from_string_subscript(
    assignment: Node,
    target: Node,
    text: &str,
    line_index: &LineIndex,
    file_uri: &Url,
    lhs_name: &str,
    rhs_name: Option<&str>,
    op: ExtractOp,
) -> Option<Candidate> {
    if op != ExtractOp::Dollar || !matches!(target.kind(), "subset" | "subset2") {
        return None;
    }
    let t_lhs = target.child_by_field_name("function")?;
    if t_lhs.kind() != "identifier" || node_text(t_lhs, text) != lhs_name {
        return None;
    }
    let args = target.child_by_field_name("arguments")?;
    let string_node = first_direct_string_argument(args)?;
    let member_name = simple_string_literal_value(string_node, text)?;
    if rhs_name.is_some_and(|rhs_name| member_name != rhs_name) {
        return None;
    }
    let lhs_range = node_range_in_text(t_lhs, line_index);
    Some(Candidate {
        name: member_name.to_string(),
        uri: file_uri.clone(),
        effect: EffectPos::from_node_end(assignment, line_index),
        name_range: node_range_in_text(string_node, line_index),
        fn_scope: enclosing_function_id(assignment),
        lhs_pos: lhs_range.start,
    })
}

fn first_direct_string_argument(args: Node) -> Option<Node> {
    let mut walker = args.walk();
    for child in args.children(&mut walker) {
        if child.kind() == "string" {
            return Some(child);
        }
        if child.kind() == "argument" {
            if let Some(value) = child.child_by_field_name("value") {
                if value.kind() == "string" {
                    return Some(value);
                }
            }
        }
    }
    None
}

fn simple_string_literal_value<'a>(node: Node, text: &'a str) -> Option<&'a str> {
    if node.kind() != "string" {
        return None;
    }
    let raw = node_text(node, text);
    let bytes = raw.as_bytes();
    let (&quote, rest) = bytes.split_first()?;
    if !matches!(quote, b'\'' | b'"') || rest.last().copied()? != quote || raw.len() < 2 {
        return None;
    }
    let value = &raw[1..raw.len() - 1];
    if value.is_empty() || value.contains('\\') || value.contains('\n') || value.contains('\r') {
        return None;
    }
    Some(value)
}

#[derive(Debug, Clone)]
struct Candidate {
    /// Member/slot name (`bar` in `foo$bar <- ...`, or the named argument in
    /// `foo <- list(bar = ...)`).
    name: String,
    /// File the candidate lives in. For defining-file candidates this is
    /// `defining_uri`; for cross-file candidates this is the file containing
    /// the validated member-assignment site.
    uri: Url,
    effect: EffectPos,
    name_range: Range,
    /// `None` for top-level, else the `function_definition` node id of the
    /// closest enclosing function scope. Tree-local — only meaningful when
    /// comparing candidates collected from the *same* tree (i.e. defining
    /// file vs the binding's `symbol_fn_scope`). For non-defining-file
    /// candidates this is recorded but unused (a per-site scope-resolve
    /// replaces the `fn_scope` correctness gate across files).
    fn_scope: FunctionScopeId,
    /// Position of the LHS identifier (`foo` in `foo$bar <- ...`). Used as
    /// the query position when re-resolving `foo` for non-defining-file
    /// candidates; ignored for defining-file candidates.
    lhs_pos: Position,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QualifiedMemberCompletion {
    pub name: String,
    pub uri: Url,
    pub name_range: Range,
}

struct CandidateBatch {
    candidates: Vec<Candidate>,
    cursor_uri: Url,
    cursor: Position,
    contributor_ranks: HashMap<Url, usize>,
    contributor_distances: HashMap<Url, usize>,
}

/// Resolves go-to-definition for a qualified member RHS (`bar` in `foo$bar` or
/// `foo@bar`).
///
/// Snapshot-scope invariant: the shared candidate collector creates one
/// `ParentPrefixCache` per request and reuses it for the initial cursor lookup
/// plus all non-defining-file candidate validations. Callers must hold a
/// `WorldState` read guard (as `goto_definition` does) while calling this
/// function so `get_cross_file_scope_with_cache` and subsequent scope lookups,
/// including `candidate_lhs_matches_symbol`, observe the same graph/artifacts
/// snapshot.
///
/// This stable convenience API delegates to
/// [`resolve_qualified_member_with_cancel`] with [`DiagCancelToken::never`],
/// so callers that do not have a request-scoped cancellation token keep the
/// same uncancelled behavior.
pub fn resolve_qualified_member(
    state: &WorldState,
    uri: &Url,
    position: Position,
    lhs_node_kind: &str,
    lhs_name: &str,
    rhs_name: &str,
    op: ExtractOp,
) -> Option<Location> {
    resolve_qualified_member_with_cancel(
        state,
        uri,
        position,
        lhs_node_kind,
        lhs_name,
        rhs_name,
        op,
        &DiagCancelToken::never(),
    )
}

/// Cancellation-aware variant of [`resolve_qualified_member`].
///
/// Same snapshot-scope invariant: callers must hold a `WorldState` read guard
/// (as `goto_definition_with_cancel` does) so the shared collector's single
/// `ParentPrefixCache`, the initial `get_cross_file_scope_with_cache` lookup,
/// and every non-defining-file `candidate_lhs_matches_symbol` re-resolve all
/// observe the same graph/artifacts snapshot.
///
/// `cancel` is polled cooperatively at scope-lookup and loop boundaries.
/// Returns `None` on cancellation; passing [`DiagCancelToken::never`] yields
/// the same behavior as [`resolve_qualified_member`].
pub fn resolve_qualified_member_with_cancel(
    state: &WorldState,
    uri: &Url,
    position: Position,
    lhs_node_kind: &str,
    lhs_name: &str,
    rhs_name: &str,
    op: ExtractOp,
    cancel: &DiagCancelToken,
) -> Option<Location> {
    let batch = collect_qualified_member_candidates_with_cancel(
        state,
        uri,
        position,
        lhs_node_kind,
        lhs_name,
        Some(rhs_name),
        op,
        cancel,
    )?;
    pick_winner(
        batch.candidates,
        &batch.cursor_uri,
        batch.cursor,
        &batch.contributor_ranks,
        &batch.contributor_distances,
    )
    .map(|c| Location {
        uri: c.uri,
        range: c.name_range,
    })
}

/// Enumerate visible `$`/`@` member candidates for completion.
///
/// This stable convenience API delegates to
/// [`complete_qualified_members_with_cancel`] with [`DiagCancelToken::never`].
pub fn complete_qualified_members(
    state: &WorldState,
    uri: &Url,
    position: Position,
    lhs_node_kind: &str,
    lhs_name: &str,
    op: ExtractOp,
) -> Vec<QualifiedMemberCompletion> {
    complete_qualified_members_with_cancel(
        state,
        uri,
        position,
        lhs_node_kind,
        lhs_name,
        op,
        &DiagCancelToken::never(),
    )
}

/// Cancellation-aware variant of [`complete_qualified_members`].
///
/// Candidates are de-duplicated by member label. For duplicate visible
/// definitions of the same label, the chosen candidate is the same winner that
/// [`resolve_qualified_member_with_cancel`] would use at the cursor.
pub fn complete_qualified_members_with_cancel(
    state: &WorldState,
    uri: &Url,
    position: Position,
    lhs_node_kind: &str,
    lhs_name: &str,
    op: ExtractOp,
    cancel: &DiagCancelToken,
) -> Vec<QualifiedMemberCompletion> {
    let Some(batch) = collect_qualified_member_candidates_with_cancel(
        state,
        uri,
        position,
        lhs_node_kind,
        lhs_name,
        None,
        op,
        cancel,
    ) else {
        return Vec::new();
    };

    let mut best_by_name: HashMap<String, Candidate> = HashMap::new();
    for candidate in batch.candidates {
        if cancel.is_cancelled() {
            return Vec::new();
        }

        if !completion_candidate_is_eligible(
            &candidate,
            &batch.cursor_uri,
            batch.cursor,
            &batch.contributor_ranks,
        ) {
            continue;
        }

        match best_by_name.entry(candidate.name.clone()) {
            std::collections::hash_map::Entry::Occupied(mut entry) => {
                if completion_candidate_wins(
                    &candidate,
                    entry.get(),
                    &batch.cursor_uri,
                    batch.cursor,
                    &batch.contributor_ranks,
                    &batch.contributor_distances,
                ) {
                    entry.insert(candidate);
                }
            }
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(candidate);
            }
        }
    }

    let mut completions: Vec<_> = best_by_name
        .into_values()
        .map(|winner| QualifiedMemberCompletion {
            name: winner.name,
            uri: winner.uri,
            name_range: winner.name_range,
        })
        .collect();
    completions.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| a.uri.as_str().cmp(b.uri.as_str()))
            .then_with(|| {
                (a.name_range.start.line, a.name_range.start.character)
                    .cmp(&(b.name_range.start.line, b.name_range.start.character))
            })
    });
    completions
}

fn collect_qualified_member_candidates_with_cancel(
    state: &WorldState,
    uri: &Url,
    position: Position,
    lhs_node_kind: &str,
    lhs_name: &str,
    rhs_name: Option<&str>,
    op: ExtractOp,
    cancel: &DiagCancelToken,
) -> Option<CandidateBatch> {
    if lhs_node_kind != "identifier" || cancel.is_cancelled() {
        return None;
    }
    let mut prefix_cache = crate::cross_file::scope::ParentPrefixCache::new();

    let scope = crate::handlers::get_cross_file_scope_with_cache(
        state,
        uri,
        position.line,
        position.character,
        cancel,
        &mut prefix_cache,
    );
    if cancel.is_cancelled() {
        return None;
    }
    let symbol = scope.symbols.get(lhs_name)?;

    if symbol.source_uri.as_str().starts_with("package:") {
        return None;
    }

    let defining_uri = symbol.source_uri.clone();
    let cursor_uri = uri.clone();

    let mut defining_candidates: Vec<Candidate> = Vec::new();
    {
        let (defining_text, defining_tree) =
            crate::parameter_resolver::get_text_and_tree(state, &defining_uri)?;
        let defining_line_index = LineIndex::new(&defining_text);
        let symbol_fn_scope = function_scope_at(
            &defining_tree,
            &defining_text,
            symbol.defined_line,
            symbol.defined_column,
        );
        let symbol_effect = symbol_visible_from_position(
            &defining_tree,
            &defining_text,
            &defining_line_index,
            symbol.defined_line,
            symbol.defined_column,
            lhs_name,
        );

        collect_member_assignments(
            defining_tree.root_node(),
            &defining_text,
            &defining_line_index,
            &defining_uri,
            lhs_name,
            rhs_name,
            op,
            &mut defining_candidates,
        );
        if let Some(rhs_name) = rhs_name {
            if let Some(candidate) = collect_constructor_candidate(
                &defining_tree,
                &defining_text,
                &defining_line_index,
                &defining_uri,
                symbol.defined_line,
                symbol.defined_column,
                lhs_name,
                rhs_name,
            ) {
                defining_candidates.push(candidate);
            }
        } else {
            collect_constructor_candidates(
                &defining_tree,
                &defining_text,
                &defining_line_index,
                &defining_uri,
                symbol.defined_line,
                symbol.defined_column,
                lhs_name,
                rhs_name,
                &mut defining_candidates,
            );
        }

        // Defining-file candidates are collected from the same tree that owns
        // the resolved `lhs_name` binding. The textual LHS match, same-function
        // check, and effect-after-definition check are the local identity proof;
        // re-running cross-file scope once per member site is redundant and
        // makes same-file/defining-file completion scale with N scope queries.
        //
        // Non-defining contributor files still go through
        // `candidate_lhs_matches_symbol` below because their LHS binding can
        // only be validated by resolving scope at the candidate site.
        defining_candidates.retain(|c| {
            c.fn_scope == symbol_fn_scope
                && effect_at_or_after(c.effect, symbol_effect)
                && candidate_effect_visible_in_scope(c, &scope.visible_positions)
        });
        if cancel.is_cancelled() {
            return None;
        }
    }

    let mut cross_file_candidates: Vec<Candidate> = Vec::new();
    let contributor_ranks = contributor_file_ranks(&scope.chain);
    for candidate_uri in scope
        .chain
        .iter()
        .filter(|candidate_uri| **candidate_uri != defining_uri)
    {
        if cancel.is_cancelled() {
            return None;
        }
        if let Some((candidate_text, candidate_tree)) =
            crate::parameter_resolver::get_text_and_tree(state, candidate_uri)
        {
            let candidate_line_index = LineIndex::new(&candidate_text);
            collect_member_assignments(
                candidate_tree.root_node(),
                &candidate_text,
                &candidate_line_index,
                candidate_uri,
                lhs_name,
                rhs_name,
                op,
                &mut cross_file_candidates,
            );
        }
    }
    cross_file_candidates.retain(|c| {
        candidate_effect_visible_in_scope(c, &scope.visible_positions)
            && candidate_lhs_matches_symbol(state, c, lhs_name, symbol, cancel, &mut prefix_cache)
    });
    if cancel.is_cancelled() {
        return None;
    }

    let mut all_candidates = defining_candidates;
    all_candidates.extend(cross_file_candidates);
    let contributor_distances = contributor_file_distances(
        &state.cross_file_graph,
        &cursor_uri,
        &scope.chain,
        &scope.visible_positions,
        all_candidates.iter().map(|candidate| &candidate.uri),
    );

    Some(CandidateBatch {
        candidates: all_candidates,
        cursor_uri,
        cursor: position,
        contributor_ranks,
        contributor_distances,
    })
}

fn contributor_file_ranks(chain: &[Url]) -> HashMap<Url, usize> {
    let mut ranks = HashMap::new();
    for (idx, uri) in chain.iter().enumerate() {
        ranks.entry(uri.clone()).or_insert(idx);
    }
    ranks
}
/// Compute shortest directed contributor-chain distances from the cursor file
/// to candidate files. The traversal follows only forward dependency edges
/// (`edge.from -> edge.to`) that are both in the cursor scope's contributor
/// chain and visible at the contributing position recorded in
/// `visible_positions`.
///
/// `scope.chain` remains the source of truth for which files are allowed to
/// contribute, so both intermediate nodes and traversed edges are restricted to
/// files that can contribute to the cursor's resolved scope. The walk never
/// enters dependents or aggregators and intentionally has no dependent-file
/// shortcuts; otherwise an unrelated parent that sources both the cursor file
/// and a candidate file could create a path that does not correspond to files
/// the cursor executes to build its contributing scope.
///
/// These distances only rank already-retained candidates so that file-local
/// effect positions are never compared across files.
fn contributor_file_distances<'a, I>(
    graph: &crate::cross_file::dependency::DependencyGraph,
    cursor_uri: &Url,
    contributor_chain: &[Url],
    visible_positions: &HashMap<Url, (u32, u32)>,
    candidate_uris: I,
) -> HashMap<Url, usize>
where
    I: IntoIterator<Item = &'a Url>,
{
    let contributor_files: HashSet<Url> = contributor_chain.iter().cloned().collect();
    let mut remaining: HashSet<Url> = candidate_uris
        .into_iter()
        .filter(|uri| *uri != cursor_uri)
        .cloned()
        .collect();
    let mut distances = HashMap::new();
    if remaining.is_empty() {
        return distances;
    }

    let mut visited: HashSet<Url> = HashSet::new();
    let mut queue: VecDeque<(Url, usize)> = VecDeque::from([(cursor_uri.clone(), 0)]);

    while let Some((uri, distance)) = queue.pop_front() {
        if !visited.insert(uri.clone()) {
            continue;
        }

        if remaining.remove(&uri) {
            distances.insert(uri.clone(), distance);
            if remaining.is_empty() {
                break;
            }
        }

        for edge in graph.get_dependencies(&uri) {
            if contributor_files.contains(&edge.to)
                && !visited.contains(&edge.to)
                && edge_call_site_visible(edge, visible_positions)
            {
                queue.push_back((edge.to.clone(), distance + 1));
            }
        }
    }

    distances
}

fn edge_call_site_visible(
    edge: &crate::cross_file::dependency::DependencyEdge,
    visible_positions: &HashMap<Url, (u32, u32)>,
) -> bool {
    match (edge.call_site_line, edge.call_site_column) {
        (Some(line), Some(column)) => visible_positions
            .get(&edge.from)
            .map(|&cutoff| (line, column) <= cutoff)
            .unwrap_or(false),
        _ => true,
    }
}

fn candidate_effect_visible_in_scope(
    candidate: &Candidate,
    visible_positions: &HashMap<Url, (u32, u32)>,
) -> bool {
    visible_positions
        .get(&candidate.uri)
        .map(|&(line, column)| {
            (candidate.effect.line, candidate.effect.utf16_column) <= (line, column)
        })
        .unwrap_or(false)
}

/// Re-resolve `lhs_name` at the candidate's LHS-identifier position via the
/// position-aware cross-file scope, and check it points to the same binding
/// as the one the user navigated from. This is the cross-file replacement
/// for the same-tree `fn_scope` gate: it correctly excludes candidates inside
/// unrelated function bodies (where `foo` shadows the imported one) and
/// candidates appearing before the import is in scope.
fn candidate_lhs_matches_symbol(
    state: &WorldState,
    c: &Candidate,
    lhs_name: &str,
    symbol: &crate::cross_file::scope::ScopedSymbol,
    cancel: &DiagCancelToken,
    prefix_cache: &mut crate::cross_file::scope::ParentPrefixCache,
) -> bool {
    if cancel.is_cancelled() {
        return false;
    }
    let scope = crate::handlers::get_cross_file_scope_with_cache(
        state,
        &c.uri,
        c.lhs_pos.line,
        c.lhs_pos.character,
        cancel,
        prefix_cache,
    );
    if cancel.is_cancelled() {
        return false;
    }
    scope
        .symbols
        .get(lhs_name)
        .map(|s| s == symbol)
        .unwrap_or(false)
}

fn effect_at_or_after(a: EffectPos, b: EffectPos) -> bool {
    (a.line, a.utf16_column) >= (b.line, b.utf16_column)
}
fn completion_candidate_is_eligible(
    candidate: &Candidate,
    cursor_uri: &Url,
    cursor: Position,
    contributor_ranks: &HashMap<Url, usize>,
) -> bool {
    if &candidate.uri == cursor_uri {
        (candidate.effect.line, candidate.effect.utf16_column) <= (cursor.line, cursor.character)
    } else {
        contributor_ranks.contains_key(&candidate.uri)
    }
}

fn completion_candidate_wins(
    candidate: &Candidate,
    incumbent: &Candidate,
    cursor_uri: &Url,
    cursor: Position,
    contributor_ranks: &HashMap<Url, usize>,
    contributor_distances: &HashMap<Url, usize>,
) -> bool {
    let candidate_in_cursor = &candidate.uri == cursor_uri;
    let incumbent_in_cursor = &incumbent.uri == cursor_uri;

    match (candidate_in_cursor, incumbent_in_cursor) {
        (true, true) => effect_at_or_after(candidate.effect, incumbent.effect),
        (true, false) => {
            (candidate.effect.line, candidate.effect.utf16_column)
                <= (cursor.line, cursor.character)
        }
        (false, true) => false,
        (false, false) => {
            compare_non_cursor_completion_candidates(
                candidate,
                incumbent,
                contributor_ranks,
                contributor_distances,
            ) == Ordering::Less
        }
    }
}

fn compare_non_cursor_completion_candidates(
    a: &Candidate,
    b: &Candidate,
    contributor_ranks: &HashMap<Url, usize>,
    contributor_distances: &HashMap<Url, usize>,
) -> Ordering {
    if a.uri == b.uri {
        return if effect_at_or_after(a.effect, b.effect) {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }

    let a_distance = contributor_distances
        .get(&a.uri)
        .copied()
        .unwrap_or(usize::MAX);
    let b_distance = contributor_distances
        .get(&b.uri)
        .copied()
        .unwrap_or(usize::MAX);
    let a_rank = contributor_ranks.get(&a.uri).copied().unwrap_or(usize::MAX);
    let b_rank = contributor_ranks.get(&b.uri).copied().unwrap_or(usize::MAX);

    a_distance
        .cmp(&b_distance)
        .then_with(|| a_rank.cmp(&b_rank))
        .then_with(|| a.uri.as_str().cmp(b.uri.as_str()))
}

/// Pick the best candidate.
///
/// Partitions by `uri`: candidates in the cursor's own file always beat
/// candidates in any other file. When the user is in `main.R` and there's
/// a `foo$bar <- ...` right above the cursor, that's almost always what
/// they meant — even if `helpers.R` (where `foo` was defined) has its own
/// `foo$bar <- ...` somewhere.
///
/// Among cursor-file candidates, filter to those whose effect position is
/// at-or-before the cursor (you can't "see" an assignment that hasn't
/// happened yet) and pick the one with the latest effect position.
///
/// If no cursor-file candidate qualifies, fall back to the nearest candidate
/// file by dependency-graph distance from the cursor file, then pick that
/// file's latest effect position. Contributor-chain rank and URI break
/// equal-distance or unavailable-distance ties. Effect positions are only
/// compared within a single file.
fn pick_winner(
    candidates: Vec<Candidate>,
    cursor_uri: &Url,
    cursor: Position,
    contributor_ranks: &HashMap<Url, usize>,
    contributor_distances: &HashMap<Url, usize>,
) -> Option<Candidate> {
    let (mut in_cursor_file, other): (Vec<_>, Vec<_>) =
        candidates.into_iter().partition(|c| &c.uri == cursor_uri);
    // Cursor file: filter to effect <= cursor (unit-consistent UTF-16 cmp).
    in_cursor_file
        .retain(|c| (c.effect.line, c.effect.utf16_column) <= (cursor.line, cursor.character));
    if let Some(c) = in_cursor_file
        .into_iter()
        .max_by_key(|c| (c.effect.line, c.effect.utf16_column))
    {
        return Some(c);
    }

    let mut best_per_file: HashMap<Url, Candidate> = HashMap::new();
    for candidate in other {
        match best_per_file.entry(candidate.uri.clone()) {
            std::collections::hash_map::Entry::Occupied(mut entry) => {
                if effect_at_or_after(candidate.effect, entry.get().effect) {
                    entry.insert(candidate);
                }
            }
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(candidate);
            }
        }
    }

    best_per_file
        .into_values()
        .filter_map(|candidate| {
            let rank = contributor_ranks.get(&candidate.uri).copied()?;
            let distance = contributor_distances
                .get(&candidate.uri)
                .copied()
                .unwrap_or(usize::MAX);
            Some((distance, rank, candidate))
        })
        .min_by(
            |(distance_a, rank_a, candidate_a), (distance_b, rank_b, candidate_b)| {
                distance_a
                    .cmp(distance_b)
                    .then_with(|| rank_a.cmp(rank_b))
                    .then_with(|| candidate_a.uri.as_str().cmp(candidate_b.uri.as_str()))
            },
        )
        .map(|(_, _, candidate)| candidate)
}

/// Compute the resolved symbol's *visible-from* position: the end of its
/// defining assignment if there is one, else the LHS-anchor position.
///
/// Mirrors the cross-file scope rule that a binding becomes visible only
/// after its full assignment statement, so a candidate inside the RHS of the
/// rebinding belongs to the previous `foo`, not the new one.
fn symbol_visible_from_position(
    tree: &Tree,
    text: &str,
    line_index: &LineIndex,
    defined_line: u32,
    defined_column_utf16: u32,
    lhs_name: &str,
) -> EffectPos {
    let fallback = EffectPos {
        line: defined_line,
        utf16_column: defined_column_utf16,
    };
    let Some(line_text) = nth_line(text, defined_line as usize) else {
        return fallback;
    };
    let byte_col = utf16_column_to_byte_offset(line_text, defined_column_utf16);
    let line_byte_len = line_text.len();
    let start = tree_sitter::Point::new(defined_line as usize, byte_col);
    let end = tree_sitter::Point::new(defined_line as usize, (byte_col + 1).min(line_byte_len));
    let Some(id_node) = tree.root_node().descendant_for_point_range(start, end) else {
        return fallback;
    };
    let Some(assignment) = ascend_to_assignment_for(id_node, text, lhs_name) else {
        return fallback;
    };
    EffectPos::from_node_end(assignment, line_index)
}

/// Return the id of the closest enclosing `function_definition` node at the
/// given (UTF-16) position, or `None` if the position is at top-level.
fn function_scope_at(tree: &Tree, text: &str, line: u32, utf16_col: u32) -> FunctionScopeId {
    let line_text = nth_line(text, line as usize)?;
    let byte_col = utf16_column_to_byte_offset(line_text, utf16_col);
    let line_byte_len = line_text.len();
    let start = tree_sitter::Point::new(line as usize, byte_col);
    let end = tree_sitter::Point::new(line as usize, (byte_col + 1).min(line_byte_len));
    let node = tree.root_node().descendant_for_point_range(start, end)?;
    enclosing_function_id(node)
}

/// Walk up from `node` and return the id of the nearest enclosing
/// `function_definition`, or `None` if there isn't one.
fn enclosing_function_id(node: Node) -> FunctionScopeId {
    let mut current = node;
    loop {
        if current.kind() == "function_definition" {
            return Some(current.id());
        }
        match current.parent() {
            Some(p) => current = p,
            None => return None,
        }
    }
}

/// Walk `root` recursively, recording every `binary_operator` whose target
/// is either an `extract_operator` (`foo$bar <- ...`, `foo@bar <- ...`) or,
/// for dollar-member lookup, a statically named string subscript
/// (`foo[["bar"]] <- ...`, `foo["bar"] <- ...`) matching
/// `(lhs_name, op, rhs_name)` when `rhs_name` is provided, otherwise every
/// RHS member. Each candidate records the position of its LHS identifier
/// (`foo` in `foo$bar <- ...`) for use as a query position when validating
/// cross-file candidates.
///
/// Uses a `TreeCursor` traversal instead of a `Vec<Node>` stack to avoid
/// per-node allocation and to skip leaf/atomic subtrees that cannot contain
/// assignment operators.
#[allow(clippy::too_many_arguments)]
fn collect_member_assignments(
    root: Node,
    text: &str,
    line_index: &LineIndex,
    file_uri: &Url,
    lhs_name: &str,
    rhs_name: Option<&str>,
    op: ExtractOp,
    out: &mut Vec<Candidate>,
) {
    let mut cursor = root.walk();
    let mut descended = true; // treat root as just-entered
    loop {
        if descended {
            let node = cursor.node();
            let kind = node.kind();
            // Skip leaf/atomic subtrees that cannot contain assignments.
            let dominated = matches!(
                kind,
                "identifier"
                    | "string"
                    | "string_content"
                    | "comment"
                    | "integer"
                    | "float"
                    | "complex"
                    | "na"
                    | "null"
                    | "inf"
                    | "nan"
                    | "true"
                    | "false"
                    | "dots"
                    | "dot_dot_i"
                    | "special"
            );
            if !dominated {
                if kind == "binary_operator" {
                    try_extract_member_assignment(
                        node, text, line_index, file_uri, lhs_name, rhs_name, op, out,
                    );
                }
                // Descend into children if this node has any.
                if cursor.goto_first_child() {
                    descended = true;
                    continue;
                }
            }
        }
        // Try next sibling, or ascend.
        if cursor.goto_next_sibling() {
            descended = true;
        } else if cursor.goto_parent() {
            descended = false;
        } else {
            break;
        }
    }
}

/// Helper: check a single `binary_operator` node for member-assignment
/// patterns and push a candidate if matched.
#[allow(clippy::too_many_arguments)]
fn try_extract_member_assignment(
    node: Node,
    text: &str,
    line_index: &LineIndex,
    file_uri: &Url,
    lhs_name: &str,
    rhs_name: Option<&str>,
    op: ExtractOp,
    out: &mut Vec<Candidate>,
) {
    let Some(op_node) = node.child_by_field_name("operator") else {
        return;
    };
    let op_text = node_text(op_node, text);
    let target = match op_text {
        "<-" | "=" | "<<-" => node.child_by_field_name("lhs"),
        "->" | "->>" => node.child_by_field_name("rhs"),
        _ => return,
    };
    let Some(target) = target else { return };
    if let Some(candidate) = member_assignment_candidate_from_extract(
        node, target, text, line_index, file_uri, lhs_name, rhs_name, op,
    ) {
        out.push(candidate);
        return;
    }
    if let Some(candidate) = member_assignment_candidate_from_string_subscript(
        node, target, text, line_index, file_uri, lhs_name, rhs_name, op,
    ) {
        out.push(candidate);
    }
}

#[allow(clippy::too_many_arguments)]
fn collect_constructor_candidate(
    tree: &Tree,
    text: &str,
    line_index: &LineIndex,
    file_uri: &Url,
    defined_line: u32,
    defined_column_utf16: u32,
    lhs_name: &str,
    rhs_name: &str,
) -> Option<Candidate> {
    let mut candidates = Vec::new();
    collect_constructor_candidates(
        tree,
        text,
        line_index,
        file_uri,
        defined_line,
        defined_column_utf16,
        lhs_name,
        Some(rhs_name),
        &mut candidates,
    );
    candidates.into_iter().next()
}

/// If the assignment that defines `lhs_name` at `(defined_line, defined_col)`
/// has a constructor-call RHS in the allowlist, collect candidates for named
/// arguments matching `rhs_name` when provided, otherwise all named arguments.
///
/// We use the position only as a hint to find the *intended* defining
/// assignment — convert `defined_column_utf16` to a byte offset and descend
/// to the smallest node containing `(defined_line, byte_col .. byte_col+1)`
/// (a 1-byte-wide range, since a zero-width range at the very start of the
/// line does not reliably descend into a leaf), then ascend to the enclosing
/// `binary_operator` whose target identifier matches `lhs_name`. R
/// identifiers are ASCII (`[A-Za-z_.][A-Za-z0-9_.]*`) so a 1-byte step is
/// always inside the identifier.
#[allow(clippy::too_many_arguments)]
fn collect_constructor_candidates(
    tree: &Tree,
    text: &str,
    line_index: &LineIndex,
    file_uri: &Url,
    defined_line: u32,
    defined_column_utf16: u32,
    lhs_name: &str,
    rhs_name: Option<&str>,
    out: &mut Vec<Candidate>,
) {
    // LSP columns are UTF-16 units; tree-sitter Point columns are byte offsets.
    // `defined_line` always points to a valid line in `text` (it comes from
    // the artifacts' Def event, which was emitted from a real tree-sitter
    // position); `LineIndex::get_line` returns `""` for out-of-bounds rows,
    // which falls through to a no-op `descendant_for_point_range`.
    let line_text = line_index.get_line(defined_line as usize);
    let byte_col = utf16_column_to_byte_offset(line_text, defined_column_utf16);
    let line_byte_len = line_text.len();
    let start = tree_sitter::Point::new(defined_line as usize, byte_col);
    // Use a 1-byte-wide end to ensure we descend into the identifier leaf even
    // when the symbol sits at column 0 of its line.
    let end_col = (byte_col + 1).min(line_byte_len);
    let end = tree_sitter::Point::new(defined_line as usize, end_col);
    let Some(id_node) = tree.root_node().descendant_for_point_range(start, end) else {
        return;
    };

    // Walk up to the enclosing `binary_operator` whose target identifier is
    // `lhs_name`, then look at its RHS.
    let Some(assignment) = ascend_to_assignment_for(id_node, text, lhs_name) else {
        return;
    };
    let Some(value_node) = assignment_value_node(assignment, text) else {
        return;
    };

    if value_node.kind() != "call" {
        return;
    }
    let Some(func_node) = value_node.child_by_field_name("function") else {
        return;
    };
    if func_node.kind() != "identifier" {
        return;
    }
    let func_name = node_text(func_node, text);
    if !CONSTRUCTOR_ALLOWLIST.contains(&func_name) {
        return;
    }

    let Some(args_node) = value_node.child_by_field_name("arguments") else {
        return;
    };
    let mut walker = args_node.walk();
    for child in args_node.children(&mut walker) {
        if child.kind() != "argument" {
            continue;
        }
        let Some(name_node) = child.child_by_field_name("name") else {
            continue;
        };
        if name_node.kind() != "identifier" {
            continue;
        }
        let member_name = node_text(name_node, text);
        if rhs_name.is_some_and(|rhs_name| member_name != rhs_name) {
            continue;
        }
        let name_range = node_range_in_text(name_node, line_index);
        let effect = EffectPos::from_node_end(assignment, line_index);
        // Constructor candidates become visible only after the defining
        // assignment completes, so use the effect position for the shared
        // symbol identity check.
        let lhs_pos = Position::new(effect.line, effect.utf16_column);
        out.push(Candidate {
            name: member_name.to_string(),
            uri: file_uri.clone(),
            effect,
            name_range,
            fn_scope: enclosing_function_id(assignment),
            lhs_pos,
        });
    }
}

fn ascend_to_assignment_for<'a>(start: Node<'a>, text: &str, lhs_name: &str) -> Option<Node<'a>> {
    let mut current = start;
    loop {
        if current.kind() == "binary_operator" {
            let op_text = current
                .child_by_field_name("operator")
                .map(|n| node_text(n, text));
            let target = match op_text {
                Some("<-") | Some("=") | Some("<<-") => current.child_by_field_name("lhs"),
                Some("->") | Some("->>") => current.child_by_field_name("rhs"),
                _ => None,
            };
            if let Some(t) = target {
                if t.kind() == "identifier" && node_text(t, text) == lhs_name {
                    return Some(current);
                }
            }
        }
        current = current.parent()?;
    }
}

fn assignment_value_node<'a>(assignment: Node<'a>, text: &str) -> Option<Node<'a>> {
    let op_text = node_text(assignment.child_by_field_name("operator")?, text);
    match op_text {
        "<-" | "=" | "<<-" => assignment.child_by_field_name("rhs"),
        "->" | "->>" => assignment.child_by_field_name("lhs"),
        _ => None,
    }
}

fn node_text<'a>(node: Node, text: &'a str) -> &'a str {
    &text[node.byte_range()]
}

/// Convert a tree-sitter node's range into an LSP `Range` whose columns are
/// UTF-16 code units (per the LSP spec / `vscode-languageserver-types`).
fn node_range_in_text(node: Node, line_index: &LineIndex) -> Range {
    let s = node.start_position();
    let e = node.end_position();
    let s_line = line_index.get_line(s.row);
    let e_line = line_index.get_line(e.row);
    Range {
        start: Position::new(s.row as u32, byte_offset_to_utf16_column(s_line, s.column)),
        end: Position::new(e.row as u32, byte_offset_to_utf16_column(e_line, e.column)),
    }
}

/// Return the n-th line of `text`, with any trailing `\r` stripped.
///
/// Uses `lines()` (not `split('\n')`) so CRLF line endings produce the same
/// `\r`-stripped slice that the rest of the codebase (e.g. `LineIndex`) sees.
/// Tree-sitter byte columns are measured against the unstripped buffer, but
/// any byte offset *before* the trailing `\r` is unaffected by the strip, so
/// converting via `byte_offset_to_utf16_column` against the stripped slice is
/// safe and consistent.
fn nth_line(text: &str, n: usize) -> Option<&str> {
    text.lines().nth(n)
}

#[cfg(test)]
mod tests {
    use crate::handlers::{goto_definition, goto_definition_with_cancel, DiagCancelToken};
    use crate::state::{Document, WorldState};
    use std::sync::Arc;
    use std::time::SystemTime;
    use tower_lsp::lsp_types::{GotoDefinitionResponse, Position, Url};

    fn fresh_state() -> WorldState {
        let mut state = WorldState::new(vec![]);
        state.workspace_scan_complete = true;
        state
    }

    fn add_doc(state: &mut WorldState, uri: &str, text: &str) -> Url {
        let url = Url::parse(uri).expect("uri");
        state
            .documents
            .insert(url.clone(), Document::new(text, None));
        url
    }

    fn add_indexed_doc(state: &mut WorldState, uri: &str, text: &str) -> Url {
        let url = Url::parse(uri).expect("uri");
        let doc = Document::new_with_uri(text, None, &url);
        let metadata = Arc::new(crate::cross_file::extract_metadata(text));
        let artifacts = Arc::new(if let Some(tree) = doc.tree.as_ref() {
            crate::cross_file::scope::compute_artifacts_with_metadata(
                &url,
                tree,
                text,
                Some(&metadata),
            )
        } else {
            crate::cross_file::scope::ScopeArtifacts::default()
        });
        let snapshot = crate::cross_file::file_cache::FileSnapshot {
            mtime: SystemTime::UNIX_EPOCH,
            size: text.len() as u64,
            content_hash: None,
        };
        let entry = crate::workspace_index::IndexEntry {
            contents: doc.contents.clone(),
            tree: doc.tree.clone(),
            loaded_packages: doc.loaded_packages.clone(),
            snapshot,
            metadata,
            artifacts,
            indexed_at_version: state.workspace_index_new.version(),
        };
        assert!(state.workspace_index_new.insert(url.clone(), entry));
        url
    }

    fn loc(result: Option<GotoDefinitionResponse>) -> tower_lsp::lsp_types::Location {
        match result {
            Some(GotoDefinitionResponse::Scalar(l)) => l,
            other => panic!("expected Scalar location, got {:?}", other),
        }
    }

    fn completion_names(
        state: &WorldState,
        uri: &Url,
        position: Position,
        lhs_name: &str,
    ) -> Vec<String> {
        super::complete_qualified_members(
            state,
            uri,
            position,
            "identifier",
            lhs_name,
            crate::extract_op::ExtractOp::Dollar,
        )
        .into_iter()
        .map(|completion| completion.name)
        .collect::<Vec<_>>()
    }

    /// Perf reproducer: scales the number of `df$col_K <- ...` assignments and
    /// prints how long `complete_qualified_members` takes. Run with:
    ///
    ///     cargo test --release -p raven -- \
    ///         qualified_resolve::tests::perf_dollar_completion_scaling \
    ///         --nocapture --ignored
    #[test]
    #[ignore]
    fn perf_dollar_completion_scaling() {
        for n in [10usize, 50, 100, 200, 400] {
            let mut code = String::from("df <- list()\n");
            for k in 0..n {
                code.push_str(&format!("df$col_{k} <- {k}\n"));
            }
            // Cursor after the last assignment, on a fresh `df$` line.
            code.push_str("df$\n");
            let cursor_line = (1 + n) as u32;

            let mut state = fresh_state();
            let uri = add_indexed_doc(&mut state, "file:///perf.R", &code);

            // Warm-up to populate any one-shot caches.
            let _ = super::complete_qualified_members(
                &state,
                &uri,
                Position::new(cursor_line, 3),
                "identifier",
                "df",
                crate::extract_op::ExtractOp::Dollar,
            );

            let mut dollar_samples = [std::time::Duration::ZERO; 5];
            for s in &mut dollar_samples {
                let start = std::time::Instant::now();
                let r = super::complete_qualified_members(
                    &state,
                    &uri,
                    Position::new(cursor_line, 3),
                    "identifier",
                    "df",
                    crate::extract_op::ExtractOp::Dollar,
                );
                *s = start.elapsed();
                assert_eq!(r.len(), n, "expected {n} candidates, got {}", r.len());
            }
            dollar_samples.sort();

            // Compare against a single full scope query at the same cursor.
            let mut scope_samples = [std::time::Duration::ZERO; 5];
            for s in &mut scope_samples {
                let cancel = DiagCancelToken::never();
                let mut cache = crate::cross_file::scope::ParentPrefixCache::new();
                let start = std::time::Instant::now();
                let _scope = crate::handlers::get_cross_file_scope_with_cache(
                    &state,
                    &uri,
                    cursor_line,
                    3,
                    &cancel,
                    &mut cache,
                );
                *s = start.elapsed();
            }
            scope_samples.sort();
            // Single-file cached scope queries can hit the timer floor, so use
            // a tiny baseline floor before applying the regression factor.
            let scope_baseline = scope_samples[0].max(std::time::Duration::from_millis(1));
            const PERF_REGRESSION_FACTOR: f64 = 10.0;
            assert!(
                dollar_samples[0] < scope_baseline.mul_f64(PERF_REGRESSION_FACTOR),
                "best dollar completion sample {:?} exceeded {PERF_REGRESSION_FACTOR}x scope baseline {:?} (best scope sample {:?})",
                dollar_samples[0],
                scope_baseline,
                scope_samples[0]
            );

            eprintln!(
                "perf n={n:>4}  dollar_complete={:?}  one_scope_query={:?}  ratio={:.1}x",
                dollar_samples[2],
                scope_samples[2],
                dollar_samples[2].as_secs_f64() / scope_samples[2].as_secs_f64()
            );
        }
    }

    /// Request-scoped cancellation short-circuits qualified-member lookup before
    /// cross-file scope resolution returns a location.
    #[test]
    fn dollar_rhs_cancelled_request_returns_none() {
        let mut state = fresh_state();
        let code = "foo <- list(bar = 1)\nuse(foo$bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        let token = tokio_util::sync::CancellationToken::new();
        token.cancel();
        let cancel = DiagCancelToken::from_token(token);

        let result = goto_definition_with_cancel(&state, &uri, Position::new(1, 9), &cancel);

        assert!(result.is_none());
    }

    /// Cmd-click on the RHS of `$` in `foo$bar` finds the constructor-literal
    /// member when `foo <- list(bar = ...)`.
    #[test]
    fn dollar_rhs_constructor_literal_match() {
        let mut state = fresh_state();
        let code = "foo <- list(bar = 1, baz = 2)\nuse(foo$bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // line 1 col 9 = `bar` in `foo$bar`
        let pos = Position::new(1, 9);
        let result = goto_definition(&state, &uri, pos);
        let l = loc(result);
        assert_eq!(l.uri, uri);
        assert_eq!(l.range.start.line, 0);
        // `bar = 1` lives at col 12 of `foo <- list(bar = 1, baz = 2)`
        assert_eq!(l.range.start.character, 12);
    }

    /// Cmd-click on the RHS of `$` in `foo$bar` finds the member-assignment
    /// when `foo$bar <- ...` exists in scope.
    #[test]
    fn dollar_rhs_member_assignment_match() {
        let mut state = fresh_state();
        let code = "foo <- list()\nfoo$bar <- 99\nuse(foo$bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // line 2 col 8 = `bar` in `use(foo$bar)`
        let pos = Position::new(2, 8);
        let result = goto_definition(&state, &uri, pos);
        let l = loc(result);
        assert_eq!(l.uri, uri);
        assert_eq!(l.range.start.line, 1);
        // `bar` in `foo$bar <- 99` is at col 4
        assert_eq!(l.range.start.character, 4);
    }

    /// Completion enumeration returns all visible constructor and member
    /// assignment names for the resolved object.
    #[test]
    fn dollar_member_completion_enumerates_constructor_and_assignment_names() {
        let mut state = fresh_state();
        let code = "foo <- list(alpha = 1)\nfoo$beta <- 2\nfoo$\n";
        let uri = add_doc(&mut state, "file:///t.R", code);

        assert_eq!(
            completion_names(&state, &uri, Position::new(2, 4), "foo"),
            vec!["alpha", "beta"]
        );
    }

    /// Completion enumeration treats statically named string-subscript
    /// assignments as list-member definitions too. Large R projects often mix
    /// `foo$bar <- ...` with `foo[["baz"]] <- ...`; both create members that
    /// should be offered after `foo$`.
    #[test]
    fn dollar_member_completion_includes_string_subscript_assignments() {
        let mut state = fresh_state();
        let code = "\
foo <- list(alpha = 1)
foo[[\"beta\"]] <- 2
foo['gamma'] <- 3
foo$
";
        let uri = add_doc(&mut state, "file:///t.R", code);

        assert_eq!(
            completion_names(&state, &uri, Position::new(3, 4), "foo"),
            vec!["alpha", "beta", "gamma"]
        );
    }

    /// Completion enumeration is position-aware: a member assignment after the
    /// cursor is not a visible candidate.
    #[test]
    fn dollar_member_completion_excludes_future_assignment() {
        let mut state = fresh_state();
        let code = "foo <- list()\nfoo$\nfoo$late <- 1\n";
        let uri = add_doc(&mut state, "file:///t.R", code);

        assert!(completion_names(&state, &uri, Position::new(1, 4), "foo").is_empty());
    }

    /// Position-aware tie-break: literal then member-assignment, cursor after both
    /// → member-assignment wins (latest effect position before cursor).
    #[test]
    fn dollar_rhs_literal_then_assignment_assignment_wins() {
        let mut state = fresh_state();
        let code = "foo <- list(bar = 1)\nfoo$bar <- 99\nuse(foo$bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        let pos = Position::new(2, 8);
        let l = loc(goto_definition(&state, &uri, pos));
        assert_eq!(
            l.range.start.line, 1,
            "expected member-assignment on line 1"
        );
    }

    /// Cursor between literal and a later member-assignment → literal wins
    /// (member-assignment's effect position is after the cursor).
    #[test]
    fn dollar_rhs_cursor_between_literal_and_assignment() {
        let mut state = fresh_state();
        let code = "foo <- list(bar = 1)\nuse(foo$bar)\nfoo$bar <- 99\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // line 1 col 8 = `bar` in `use(foo$bar)`
        let pos = Position::new(1, 8);
        let l = loc(goto_definition(&state, &uri, pos));
        assert_eq!(l.range.start.line, 0, "expected literal on line 0");
        assert_eq!(l.range.start.character, 12);
    }

    /// Regression: cmd-click on `bar` in `foo$bar` does NOT jump to a free
    /// `bar <- ...` when no `foo` is in scope. (This is the bug the user
    /// reported.)
    #[test]
    fn dollar_rhs_no_fallback_to_free_identifier() {
        let mut state = fresh_state();
        let code = "bar <- 1\nuse(foo$bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        let pos = Position::new(1, 8);
        let result = goto_definition(&state, &uri, pos);
        assert!(
            result.is_none(),
            "expected None — must not fall back to free `bar`",
        );
    }

    /// `@` parity: constructor-literal match.
    #[test]
    fn at_rhs_new_call_constructor_literal() {
        let mut state = fresh_state();
        let code = "foo <- new(\"Cls\", bar = 1)\nuse(foo@bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        let pos = Position::new(1, 9);
        let l = loc(goto_definition(&state, &uri, pos));
        assert_eq!(l.range.start.line, 0);
    }

    /// `@` parity: member-assignment match (`foo@bar <- ...`).
    #[test]
    fn at_rhs_member_assignment() {
        let mut state = fresh_state();
        let code = "foo <- list()\nfoo@bar <- 99\nuse(foo@bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        let pos = Position::new(2, 8);
        let l = loc(goto_definition(&state, &uri, pos));
        assert_eq!(l.range.start.line, 1);
    }

    /// `@` parity: no fallback when `foo` is unresolvable.
    #[test]
    fn at_rhs_no_fallback_to_free_identifier() {
        let mut state = fresh_state();
        let code = "bar <- 1\nuse(foo@bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        let pos = Position::new(1, 8);
        assert!(goto_definition(&state, &uri, pos).is_none());
    }

    /// Chained access `foo$bar$baz` returns None (Step-1 limitation,
    /// documented in the spec).
    #[test]
    fn chained_access_returns_none() {
        let mut state = fresh_state();
        let code = "foo <- list(bar = list(baz = 1))\nuse(foo$bar$baz)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // cursor on `baz`
        let pos = Position::new(1, 13);
        assert!(goto_definition(&state, &uri, pos).is_none());
    }

    /// LHS-shape gate: parenthesized LHS → None.
    #[test]
    fn parenthesized_lhs_returns_none() {
        let mut state = fresh_state();
        let code = "foo <- list(bar = 1)\nuse((foo)$bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // cursor on `bar`
        let pos = Position::new(1, 11);
        assert!(goto_definition(&state, &uri, pos).is_none());
    }

    /// LHS-shape gate: namespaced LHS → None.
    #[test]
    fn namespace_lhs_returns_none() {
        let mut state = fresh_state();
        let code = "use(pkg::obj$bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        let pos = Position::new(0, 13);
        assert!(goto_definition(&state, &uri, pos).is_none());
    }

    /// LHS-shape gate: call-result LHS → None.
    #[test]
    fn call_result_lhs_returns_none() {
        let mut state = fresh_state();
        let code = "use(make()$bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        let pos = Position::new(0, 11);
        assert!(goto_definition(&state, &uri, pos).is_none());
    }

    /// Negative: a same-named member of an *unrelated* object must not match.
    #[test]
    fn unrelated_object_does_not_match() {
        let mut state = fresh_state();
        let code = "other <- list(bar = 1)\nfoo <- list()\nuse(foo$bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // cursor on `bar` in `foo$bar`
        let pos = Position::new(2, 8);
        assert!(goto_definition(&state, &uri, pos).is_none());
    }

    /// Constructor allowlist: `c(bar = 1)` is recognized.
    #[test]
    fn constructor_c_named_arg() {
        let mut state = fresh_state();
        let code = "foo <- c(bar = 1L)\nuse(foo$bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        let pos = Position::new(1, 9);
        let l = loc(goto_definition(&state, &uri, pos));
        assert_eq!(l.range.start.line, 0);
    }

    /// Function-scope isolation: a `foo$bar <- ...` inside an unrelated
    /// function must not match a top-level `foo`.
    #[test]
    fn member_assignment_inside_unrelated_function_does_not_match() {
        let mut state = fresh_state();
        let code = "\
foo <- list()
g <- function() {
  foo <- list()
  foo$bar <- 99
}
use(foo$bar)
";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // line 5 col 8 = `bar` in `use(foo$bar)`
        let pos = Position::new(5, 8);
        assert!(
            goto_definition(&state, &uri, pos).is_none(),
            "must not match `foo$bar <- 99` inside g(); that's a different `foo`",
        );
    }

    /// A `foo$bar <- ...` nested inside the RHS of the *current* `foo`
    /// rebinding bound the previous `foo`, so it must not match.
    #[test]
    fn member_assignment_inside_defining_rhs_does_not_match() {
        let mut state = fresh_state();
        let code = "\
foo <- list()
foo <- { foo$bar <- 1; list() }
use(foo$bar)
";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // line 2 col 8 = `bar` in `use(foo$bar)`
        let pos = Position::new(2, 8);
        assert!(
            goto_definition(&state, &uri, pos).is_none(),
            "must not match `foo$bar <- 1` nested inside the rebinding RHS",
        );
    }

    /// Re-binding `foo` invalidates earlier member-assignments and earlier
    /// constructor literals against the *previous* `foo`.
    #[test]
    fn rebinding_foo_invalidates_earlier_candidates() {
        let mut state = fresh_state();
        let code = "\
foo <- list(bar = 1)
foo$bar <- 99
foo <- list()
use(foo$bar)
";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // line 3 col 8 = `bar` in `use(foo$bar)`
        let pos = Position::new(3, 8);
        assert!(
            goto_definition(&state, &uri, pos).is_none(),
            "must not match candidates that bound an earlier `foo`",
        );
    }

    /// Cross-file regression: the defining `foo <- list(bar = 1)` lives in
    /// `helpers.R`, sourced from the cursor's file. Goto-def must resolve to a
    /// `Location` whose `uri` is the *defining* document, exercising the
    /// `same_file = false` branch in `pick_winner`.
    #[test]
    fn dollar_rhs_cross_file_resolves_to_defining_uri() {
        let mut state = fresh_state();

        let main_code = "source(\"helpers.R\")\nuse(foo$bar)\n";
        let helpers_code = "foo <- list(bar = 1)\n";

        let main_uri = add_doc(&mut state, "file:///workspace/main.R", main_code);
        let helpers_uri = add_doc(&mut state, "file:///workspace/helpers.R", helpers_code);

        // Wire up the cross-file graph so `source("helpers.R")` is resolved.
        state.cross_file_graph.update_file(
            &main_uri,
            &crate::cross_file::extract_metadata(main_code),
            None,
            |_| None,
        );
        state.cross_file_graph.update_file(
            &helpers_uri,
            &crate::cross_file::extract_metadata(helpers_code),
            None,
            |_| None,
        );

        // Cursor on `bar` in `foo$bar` (line 1, col 8 in main.R).
        let pos = Position::new(1, 8);
        let l = loc(goto_definition(&state, &main_uri, pos));
        assert_eq!(l.uri, helpers_uri, "must resolve to the defining document");
        assert_eq!(l.range.start.line, 0);
        // `bar = 1` lives at col 12 of `foo <- list(bar = 1)`.
        assert_eq!(l.range.start.character, 12);
    }

    /// UTF-16 regression: a non-BMP character (🦀, 4 bytes / 2 UTF-16 units)
    /// precedes the `bar` token on the defining line, so byte-column ≠
    /// UTF-16-column. Confirms `EffectPos` / `node_range_in_text` correctly
    /// convert tree-sitter byte offsets into UTF-16 LSP columns.
    #[test]
    fn dollar_rhs_utf16_non_bmp_on_defining_line() {
        let mut state = fresh_state();
        // `foo <- list("🦀", bar = 1)` — `🦀` sits before `bar`.
        // Byte offsets: `foo <- list("` = 13, `🦀` = +4 bytes, `", ` = +3,
        //   so `bar` starts at byte 20.
        // UTF-16 cols:  13 + 2 + 3 = 18.
        let code = "foo <- list(\"🦀\", bar = 1)\nuse(foo$bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // Cursor on `bar` in `foo$bar` (line 1 has no non-BMP chars, so col 9).
        let pos = Position::new(1, 9);
        let l = loc(goto_definition(&state, &uri, pos));
        assert_eq!(l.uri, uri);
        assert_eq!(l.range.start.line, 0);
        assert_eq!(
            l.range.start.character, 18,
            "expected UTF-16 column of `bar` after the non-BMP `🦀` literal"
        );
    }

    /// Non-allowlisted constructor: arbitrary `make_thing(bar = 1)` is not
    /// resolved, returns None (we cannot know its semantics).
    #[test]
    fn non_allowlisted_constructor_returns_none() {
        let mut state = fresh_state();
        let code = "foo <- make_thing(bar = 1)\nuse(foo$bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        let pos = Position::new(1, 9);
        assert!(goto_definition(&state, &uri, pos).is_none());
    }

    /// Helper: wire up a two-file workspace with `source()` from `main.R` to
    /// `helpers.R`, returning both URIs.
    fn setup_two_file_workspace(
        state: &mut WorldState,
        main_code: &str,
        helpers_code: &str,
    ) -> (Url, Url) {
        let main_uri = add_doc(state, "file:///workspace/main.R", main_code);
        let helpers_uri = add_doc(state, "file:///workspace/helpers.R", helpers_code);
        state.cross_file_graph.update_file(
            &main_uri,
            &crate::cross_file::extract_metadata(main_code),
            None,
            |_| None,
        );
        state.cross_file_graph.update_file(
            &helpers_uri,
            &crate::cross_file::extract_metadata(helpers_code),
            None,
            |_| None,
        );
        (main_uri, helpers_uri)
    }

    /// Completion enumeration follows the same cross-file visibility as
    /// go-to-definition: constructor names from the defining file and validated
    /// member assignments from the cursor file are both offered.
    #[test]
    fn dollar_member_completion_includes_cross_file_candidates() {
        let mut state = fresh_state();
        let main_code = "\
source(\"helpers.R\")
foo$local <- 2
foo$
";
        let helpers_code = "\
foo <- list(alpha = 1)
foo$remote <- 1
";
        let (main_uri, _helpers_uri) =
            setup_two_file_workspace(&mut state, main_code, helpers_code);

        assert_eq!(
            completion_names(&state, &main_uri, Position::new(2, 4), "foo"),
            vec!["alpha", "local", "remote"]
        );
    }

    /// Completion de-duplication should use the same winner semantics as
    /// go-to-definition: a visible cursor-file member assignment beats a
    /// same-named constructor literal from the defining file.
    #[test]
    fn dollar_member_completion_prefers_cursor_file_duplicate_candidate() {
        let mut state = fresh_state();
        let main_code = "\
source(\"helpers.R\")
foo$alpha <- 99
foo$
";
        let helpers_code = "foo <- list(alpha = 1)\n";
        let (main_uri, _helpers_uri) =
            setup_two_file_workspace(&mut state, main_code, helpers_code);

        let completions = super::complete_qualified_members(
            &state,
            &main_uri,
            Position::new(2, 4),
            "identifier",
            "foo",
            crate::extract_op::ExtractOp::Dollar,
        );

        assert_eq!(completions.len(), 1);
        assert_eq!(completions[0].name, "alpha");
        assert_eq!(completions[0].uri, main_uri);
        assert_eq!(completions[0].name_range.start.line, 1);
    }

    /// Completion enumeration must also work when the sourced file is closed
    /// and available only through the unified workspace index. This mirrors
    /// the normal editor runtime more closely than tests that put every file
    /// in the open-document map.
    #[test]
    fn dollar_member_completion_includes_closed_indexed_sourced_file_candidates() {
        let mut state = fresh_state();
        let main_code = "\
source(\"scripts/data.R\")
ww$c.oos <- 1
ww$seeds <- 2
ww$
";
        let data_code = "\
ww <- list()
ww$name.w <- 1
ww$income.group.i <- 2
";
        let main_uri = add_doc(&mut state, "file:///workspace/main.R", main_code);
        let data_uri = add_indexed_doc(&mut state, "file:///workspace/scripts/data.R", data_code);

        for (uri, code) in [(&main_uri, main_code), (&data_uri, data_code)] {
            state.cross_file_graph.update_file(
                uri,
                &crate::cross_file::extract_metadata(code),
                None,
                |_| None,
            );
        }

        assert_eq!(
            completion_names(&state, &main_uri, Position::new(3, 3), "ww"),
            vec!["c.oos", "income.group.i", "name.w", "seeds"]
        );
    }
    /// Regression for workspaces where another file sources the cursor file:
    /// parent-prefix symbols are available at the start of `main.R`, but a
    /// direct `source()` inside `main.R` executes later and should become the
    /// binding used for `$` member completion.
    #[test]
    fn dollar_member_completion_direct_source_overrides_inherited_parent_binding() {
        let mut state = fresh_state();
        let main_code = "\
source(\"scripts/data.R\")
ww$c.oos <- 1
ww$seeds <- 2
ww$
";
        let data_code = "\
ww <- list()
ww$name.w <- 1
ww$income.group.i <- 2
";
        let runner_code = "\
make_parent_ww <- function() list()
ww <- make_parent_ww()
source(\"main.R\")
";
        let main_uri = add_doc(&mut state, "file:///workspace/main.R", main_code);
        let data_uri = add_indexed_doc(&mut state, "file:///workspace/scripts/data.R", data_code);
        let runner_uri = add_indexed_doc(&mut state, "file:///workspace/runner.R", runner_code);

        for (uri, code) in [
            (&main_uri, main_code),
            (&data_uri, data_code),
            (&runner_uri, runner_code),
        ] {
            state.cross_file_graph.update_file(
                uri,
                &crate::cross_file::extract_metadata(code),
                None,
                |_| None,
            );
        }

        assert_eq!(
            completion_names(&state, &main_uri, Position::new(3, 3), "ww"),
            vec!["c.oos", "income.group.i", "name.w", "seeds"]
        );
    }

    /// Regression for workspaces where `main.R` first sources an unrelated
    /// helper before the file that actually defines `ww`. The helper inherits a
    /// parent-prefix `ww` through the graph, but sourcing it should not consume
    /// the opportunity for a later direct source to override that inherited
    /// binding.
    #[test]
    fn dollar_member_completion_direct_source_override_survives_unrelated_prior_source() {
        let mut state = fresh_state();
        let main_code = "\
source(\"helpers.R\")
source(\"scripts/data.R\")
ww$local <- 1
ww$
";
        let helpers_code = "helper <- function() NULL\n";
        let data_code = "\
ww <- list()
ww$remote <- 1
";
        let runner_code = "\
ww <- list()
ww$parent <- 1
source(\"helpers.R\")
source(\"main.R\")
";
        let main_uri = add_doc(&mut state, "file:///workspace/main.R", main_code);
        let helpers_uri = add_indexed_doc(&mut state, "file:///workspace/helpers.R", helpers_code);
        let data_uri = add_indexed_doc(&mut state, "file:///workspace/scripts/data.R", data_code);
        let runner_uri = add_indexed_doc(&mut state, "file:///workspace/runner.R", runner_code);

        for (uri, code) in [
            (&main_uri, main_code),
            (&helpers_uri, helpers_code),
            (&data_uri, data_code),
            (&runner_uri, runner_code),
        ] {
            state.cross_file_graph.update_file(
                uri,
                &crate::cross_file::extract_metadata(code),
                None,
                |_| None,
            );
        }

        assert_eq!(
            completion_names(&state, &main_uri, Position::new(3, 3), "ww"),
            vec!["local", "remote"]
        );
    }

    /// Regression: resolving an earlier sibling source can recursively visit a
    /// later direct source target at EOF. That path-local cycle guard must not
    /// poison the later sibling source; `source("scripts/data.R")` in
    /// `main.R` still has to execute and provide the `ww` binding used for
    /// completion.
    #[test]
    fn dollar_member_completion_later_direct_source_survives_prior_recursive_sibling_visit() {
        let mut state = fresh_state();
        let main_code = "\
source(\"helpers.R\")
source(\"scripts/data.R\")
ww$local <- 1
ww$
";
        let helpers_code = "helper <- function() NULL\n";
        let data_code = "\
ww <- list()
ww$remote <- 1
";
        let runner_code = "\
source(\"main.R\")
source(\"helpers.R\")
";
        let main_uri = add_doc(&mut state, "file:///workspace/main.R", main_code);
        let helpers_uri = add_indexed_doc(&mut state, "file:///workspace/helpers.R", helpers_code);
        let data_uri = add_indexed_doc(&mut state, "file:///workspace/scripts/data.R", data_code);
        let runner_uri = add_indexed_doc(&mut state, "file:///workspace/runner.R", runner_code);

        for (uri, code) in [
            (&runner_uri, runner_code),
            (&main_uri, main_code),
            (&helpers_uri, helpers_code),
            (&data_uri, data_code),
        ] {
            state.cross_file_graph.update_file(
                uri,
                &crate::cross_file::extract_metadata(code),
                None,
                |_| None,
            );
        }

        assert_eq!(
            completion_names(&state, &main_uri, Position::new(3, 3), "ww"),
            vec!["local", "remote"]
        );
    }

    /// Regression for a nested sourced file that later sources a helper which
    /// is also sourced by an unrelated report/runner file. The helper does not
    /// define `ww`; its unrelated parent-prefix `ww` must not replace the
    /// `ww` from `scripts/data.R` or member completions lose earlier data
    /// assignments.
    #[test]
    fn dollar_member_completion_ignores_unrelated_child_parent_prefix_binding() {
        let mut state = fresh_state();
        let main_code = "\
source(\"scripts/data.R\")
ww$local <- 1
ww$
";
        let data_code = "\
ww <- list()
source(\"data/outcomes.R\")
";
        let outcomes_code = "\
ww$early <- 1
source(\"outcomes/late_helper.R\")
ww$late <- 2
";
        let helper_code = "helper <- function() NULL\n";
        let report_code = "\
ww <- list()
ww$report <- 1
source(\"scripts/data/outcomes/late_helper.R\")
";
        let main_uri = add_doc(&mut state, "file:///workspace/main.R", main_code);
        let data_uri = add_indexed_doc(&mut state, "file:///workspace/scripts/data.R", data_code);
        let outcomes_uri = add_indexed_doc(
            &mut state,
            "file:///workspace/scripts/data/outcomes.R",
            outcomes_code,
        );
        let helper_uri = add_indexed_doc(
            &mut state,
            "file:///workspace/scripts/data/outcomes/late_helper.R",
            helper_code,
        );
        let report_uri = add_indexed_doc(&mut state, "file:///workspace/report.R", report_code);

        // Update the unrelated report first so its backward edge is present
        // before the real caller edge from `outcomes.R`, reproducing the
        // parent-selection shape from larger workspaces.
        for (uri, code) in [
            (&report_uri, report_code),
            (&main_uri, main_code),
            (&data_uri, data_code),
            (&outcomes_uri, outcomes_code),
            (&helper_uri, helper_code),
        ] {
            state.cross_file_graph.update_file(
                uri,
                &crate::cross_file::extract_metadata(code),
                None,
                |_| None,
            );
        }

        assert_eq!(
            completion_names(&state, &main_uri, Position::new(2, 3), "ww"),
            vec!["early", "late", "local"]
        );
    }
    /// A sourced file can itself source setup/data files before and between
    /// many `ww$... <-` assignments. Completion should keep all direct member
    /// assignments in that file, not only the final assignments after the last
    /// nested `source()` call.
    #[test]
    fn dollar_member_completion_keeps_sourced_file_assignments_around_nested_sources() {
        let mut state = fresh_state();
        let main_code = "\
source(\"scripts/data.R\")
ww$local <- 1
ww$
";
        let data_code = "\
ww <- list()
source(\"data/outcomes.R\")
";
        let outcomes_code = "\
source(\"outcomes/abortions.R\")
source(\"outcomes/intention.R\")
ww$N <- 1
ww$c.n <- 2
source(\"outcomes/failure.R\")
ww$H <- 3
ww$point.h <- 4
source(\"outcomes/intention.bias.terms.R\")
ww$e.q <- 5
ww$name.e <- 6
";
        let abortions_code = "abortions <- data.frame()\n";
        let intention_code = "intention <- data.frame()\n";
        let failure_code = "failure.points <- data.frame()\n";
        let bias_code = "bias.terms <- list()\n";

        let main_uri = add_doc(&mut state, "file:///workspace/main.R", main_code);
        let data_uri = add_indexed_doc(&mut state, "file:///workspace/scripts/data.R", data_code);
        let outcomes_uri = add_indexed_doc(
            &mut state,
            "file:///workspace/scripts/data/outcomes.R",
            outcomes_code,
        );
        let abortions_uri = add_indexed_doc(
            &mut state,
            "file:///workspace/scripts/data/outcomes/abortions.R",
            abortions_code,
        );
        let intention_uri = add_indexed_doc(
            &mut state,
            "file:///workspace/scripts/data/outcomes/intention.R",
            intention_code,
        );
        let failure_uri = add_indexed_doc(
            &mut state,
            "file:///workspace/scripts/data/outcomes/failure.R",
            failure_code,
        );
        let bias_uri = add_indexed_doc(
            &mut state,
            "file:///workspace/scripts/data/outcomes/intention.bias.terms.R",
            bias_code,
        );

        for (uri, code) in [
            (&main_uri, main_code),
            (&data_uri, data_code),
            (&outcomes_uri, outcomes_code),
            (&abortions_uri, abortions_code),
            (&intention_uri, intention_code),
            (&failure_uri, failure_code),
            (&bias_uri, bias_code),
        ] {
            state.cross_file_graph.update_file(
                uri,
                &crate::cross_file::extract_metadata(code),
                None,
                |_| None,
            );
        }

        assert_eq!(
            completion_names(&state, &main_uri, Position::new(2, 3), "ww"),
            vec!["H", "N", "c.n", "e.q", "local", "name.e", "point.h"]
        );
    }

    /// Completion enumeration rejects member assignments where the LHS object
    /// resolves to a shadowing local binding rather than the imported object.
    #[test]
    fn dollar_member_completion_rejects_shadowed_cross_file_assignment() {
        let mut state = fresh_state();
        let main_code = "\
source(\"helpers.R\")
g <- function() {
  foo <- list()
  foo$shadow <- 99
}
foo$
";
        let helpers_code = "foo <- list(alpha = 1)\n";
        let (main_uri, _helpers_uri) =
            setup_two_file_workspace(&mut state, main_code, helpers_code);

        assert_eq!(
            completion_names(&state, &main_uri, Position::new(5, 4), "foo"),
            vec!["alpha"]
        );
    }

    /// The "skeleton-and-attach" pattern: `foo` is defined as an empty
    /// `list()` in `helpers.R`, and a member is attached in `main.R`. Cmd-click
    /// on `$bar` in `print(foo$bar)` (also in `main.R`) must resolve to the
    /// `foo$bar <- 1` line in `main.R`, NOT return None.
    #[test]
    fn dollar_rhs_member_assignment_in_cursor_file_cross_file_foo() {
        let mut state = fresh_state();
        let main_code = "\
source(\"helpers.R\")
foo$bar <- 1
print(foo$bar)
";
        let helpers_code = "foo <- list()\n";
        let (main_uri, _helpers_uri) =
            setup_two_file_workspace(&mut state, main_code, helpers_code);

        // line 2 col 10 = `bar` in `print(foo$bar)`
        let pos = Position::new(2, 10);
        let l = loc(goto_definition(&state, &main_uri, pos));
        assert_eq!(l.uri, main_uri, "must resolve to the cursor's own file");
        assert_eq!(l.range.start.line, 1, "expected `foo$bar <- 1` on line 1");
        // `bar` in `foo$bar <- 1` is at col 4.
        assert_eq!(l.range.start.character, 4);
    }

    /// Same as above but using `@`-slot assignment.
    #[test]
    fn at_rhs_member_assignment_in_cursor_file_cross_file_foo() {
        let mut state = fresh_state();
        let main_code = "\
source(\"helpers.R\")
foo@bar <- 1
print(foo@bar)
";
        let helpers_code = "foo <- list()\n";
        let (main_uri, _helpers_uri) =
            setup_two_file_workspace(&mut state, main_code, helpers_code);

        let pos = Position::new(2, 10);
        let l = loc(goto_definition(&state, &main_uri, pos));
        assert_eq!(l.uri, main_uri);
        assert_eq!(l.range.start.line, 1);
    }

    /// Cursor-file candidate beats defining-file candidate: prefer the local
    /// member-assignment over a constructor literal in the imported file.
    #[test]
    fn cursor_file_member_assignment_beats_defining_file_constructor() {
        let mut state = fresh_state();
        let main_code = "\
source(\"helpers.R\")
foo$bar <- 99
print(foo$bar)
";
        let helpers_code = "foo <- list(bar = 1)\n";
        let (main_uri, _) = setup_two_file_workspace(&mut state, main_code, helpers_code);

        let pos = Position::new(2, 10);
        let l = loc(goto_definition(&state, &main_uri, pos));
        assert_eq!(
            l.uri, main_uri,
            "cursor-file candidate should win over defining-file candidate"
        );
        assert_eq!(l.range.start.line, 1);
    }

    /// Negative: `foo$bar <- 99` inside an unrelated function in the cursor
    /// file (where `foo` is shadowed by a local) must NOT match. The per-site
    /// scope-resolve should reject it because `foo` there resolves to the
    /// local, not the imported one.
    #[test]
    fn cursor_file_member_assignment_in_shadowing_function_does_not_match() {
        let mut state = fresh_state();
        let main_code = "\
source(\"helpers.R\")
g <- function() {
  foo <- list()
  foo$bar <- 99
}
print(foo$bar)
";
        let helpers_code = "foo <- list(bar = 1)\n";
        let (main_uri, helpers_uri) = setup_two_file_workspace(&mut state, main_code, helpers_code);

        // line 5 col 10 = `bar` in `print(foo$bar)`
        let pos = Position::new(5, 10);
        let l = loc(goto_definition(&state, &main_uri, pos));
        // The cursor-file `foo$bar <- 99` lives inside g(), where `foo` is a
        // local (different binding) — so it must NOT win. The defining-file
        // constructor literal is the correct fallback.
        assert_eq!(
            l.uri, helpers_uri,
            "must not jump to shadowed `foo$bar <- 99` inside g()"
        );
        assert_eq!(l.range.start.line, 0);
    }

    /// Negative: `foo$bar <- 99` in the cursor file appears *before* the
    /// `source()` that brings `foo` into scope. The per-site scope-resolve at
    /// the assignment site sees no `foo` (the import hasn't happened yet) and
    /// must reject the candidate.
    #[test]
    fn cursor_file_member_assignment_before_source_does_not_match() {
        let mut state = fresh_state();
        let main_code = "\
foo$bar <- 99
source(\"helpers.R\")
print(foo$bar)
";
        let helpers_code = "foo <- list(bar = 1)\n";
        let (main_uri, helpers_uri) = setup_two_file_workspace(&mut state, main_code, helpers_code);

        // line 2 col 10 = `bar` in `print(foo$bar)`
        let pos = Position::new(2, 10);
        let l = loc(goto_definition(&state, &main_uri, pos));
        // Cursor-file candidate is rejected by per-site scope-check; defining
        // file's constructor literal wins.
        assert_eq!(l.uri, helpers_uri);
        assert_eq!(l.range.start.line, 0);
    }
    /// Regression: a defining-file member assignment after the `source()` site
    /// that brought the cursor file into scope is not visible to that child.
    #[test]
    fn dollar_rhs_defining_file_visibility_cutoff() {
        let mut state = fresh_state();

        let a_code = "\
foo <- list()
source(\"b.R\")
foo$bar <- 1
";
        let b_code = "print(foo$bar)\n";

        let a_uri = add_doc(&mut state, "file:///workspace/a.R", a_code);
        let b_uri = add_doc(&mut state, "file:///workspace/b.R", b_code);

        for (uri, code) in [(&a_uri, a_code), (&b_uri, b_code)] {
            state.cross_file_graph.update_file(
                uri,
                &crate::cross_file::extract_metadata(code),
                None,
                |_| None,
            );
        }

        // line 0 col 10 = `bar` in `print(foo$bar)`
        let pos = Position::new(0, 10);
        assert!(
            goto_definition(&state, &b_uri, pos).is_none(),
            "must not see `foo$bar <- 1` after the `source(\"b.R\")` cutoff in a.R",
        );
    }

    /// CRLF regression: with `\r\n` line endings, position columns must
    /// remain correct (no off-by-one). The resolved range should match the
    /// LF-equivalent test exactly.
    #[test]
    fn dollar_rhs_crlf_line_endings_preserve_columns() {
        let mut state = fresh_state();
        let code = "foo <- list(bar = 1)\r\nuse(foo$bar)\r\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // line 1 col 9 = `bar` in `foo$bar`
        let pos = Position::new(1, 9);
        let l = loc(goto_definition(&state, &uri, pos));
        assert_eq!(l.range.start.line, 0);
        assert_eq!(
            l.range.start.character, 12,
            "CRLF should not shift the resolved column"
        );
    }

    /// Multiple imports of the same name from different sourced files: pin
    /// the deterministic "first source() wins" behavior. Cross-file scope
    /// merging uses `entry(name).or_insert(symbol)`, so whichever sourced
    /// file the timeline visits first owns `foo`, and qualified resolution
    /// follows that into its defining file. A regression that flipped to
    /// last-wins (or non-deterministic) would silently change which file
    /// cmd-click jumps into.
    #[test]
    fn dollar_rhs_multiple_imports_first_source_wins() {
        let mut state = fresh_state();
        let main_code = "\
source(\"a.R\")
source(\"b.R\")
use(foo$bar)
";
        let a_code = "foo <- list(bar = 1)\n";
        let b_code = "foo <- list(bar = 999)\n";

        let main_uri = add_doc(&mut state, "file:///workspace/main.R", main_code);
        let a_uri = add_doc(&mut state, "file:///workspace/a.R", a_code);
        let b_uri = add_doc(&mut state, "file:///workspace/b.R", b_code);

        for (uri, code) in [(&main_uri, main_code), (&a_uri, a_code), (&b_uri, b_code)] {
            state.cross_file_graph.update_file(
                uri,
                &crate::cross_file::extract_metadata(code),
                None,
                |_| None,
            );
        }

        // line 2 col 8 = `bar` in `use(foo$bar)`
        let pos = Position::new(2, 8);
        let l = loc(goto_definition(&state, &main_uri, pos));
        assert_eq!(
            l.uri, a_uri,
            "first-sourced file (`a.R`) should win — `or_insert` in scope merging",
        );
        assert_ne!(
            l.uri, b_uri,
            "second-sourced file (`b.R`) must NOT win under or_insert semantics",
        );
        assert_eq!(l.range.start.line, 0);
        // `bar = 1` lives at col 12 of `foo <- list(bar = 1)`.
        assert_eq!(l.range.start.character, 12);
    }

    /// `foo` is defined in `a.R`, `foo$bar <- 1` lives in the middle file
    /// `b.R`, and the cursor is in `c.R`. The contributor-aware cross-file
    /// scan must find the b.R member assignment even though it is neither the
    /// cursor file nor the defining file.
    #[test]
    fn dollar_rhs_third_file_member_assignment_resolves_to_intermediate_file() {
        let mut state = fresh_state();

        let c_code = "\
source(\"b.R\")
print(foo$bar)
";
        let b_code = "\
source(\"a.R\")
foo$bar <- 1
";
        let a_code = "foo <- list()\n";

        let c_uri = add_doc(&mut state, "file:///workspace/c.R", c_code);
        let b_uri = add_doc(&mut state, "file:///workspace/b.R", b_code);
        let a_uri = add_doc(&mut state, "file:///workspace/a.R", a_code);

        for (uri, code) in [(&c_uri, c_code), (&b_uri, b_code), (&a_uri, a_code)] {
            state.cross_file_graph.update_file(
                uri,
                &crate::cross_file::extract_metadata(code),
                None,
                |_| None,
            );
        }

        // line 1 col 10 = `bar` in `print(foo$bar)`
        let pos = Position::new(1, 10);
        let l = loc(goto_definition(&state, &c_uri, pos));
        assert_eq!(l.uri, b_uri, "must resolve to the intermediate file");
        assert_eq!(l.range.start.line, 1);
        assert_eq!(l.range.start.character, 4);
    }

    /// Regression: files that depend on the cursor file are in the undirected
    /// neighborhood but do not contribute to the cursor's scope. Their member
    /// assignments must not be considered fallback definitions.
    #[test]
    fn dollar_rhs_dependent_file_member_assignment_does_not_match() {
        let mut state = fresh_state();

        let main_code = "\
source(\"helpers.R\")
print(foo$bar)
";
        let helpers_code = "foo <- list()\n";
        let runner_code = "\
source(\"main.R\")
foo$bar <- 1
";

        let main_uri = add_doc(&mut state, "file:///workspace/main.R", main_code);
        let helpers_uri = add_doc(&mut state, "file:///workspace/helpers.R", helpers_code);
        let runner_uri = add_doc(&mut state, "file:///workspace/runner.R", runner_code);

        for (uri, code) in [
            (&main_uri, main_code),
            (&helpers_uri, helpers_code),
            (&runner_uri, runner_code),
        ] {
            state.cross_file_graph.update_file(
                uri,
                &crate::cross_file::extract_metadata(code),
                None,
                |_| None,
            );
        }

        // line 1 col 10 = `bar` in `print(foo$bar)`
        let pos = Position::new(1, 10);
        assert!(
            goto_definition(&state, &main_uri, pos).is_none(),
            "must not jump to runner.R; dependent files do not contribute to main.R's scope",
        );
    }

    /// Regression: across contributing files, prefer the file that runs later
    /// in the cursor's source chain rather than comparing unrelated file-local
    /// line numbers.
    #[test]
    fn dollar_rhs_prefers_closer_contributing_file_over_later_line_in_defining_file() {
        let mut state = fresh_state();

        let c_code = "\
source(\"b.R\")
print(foo$bar)
";
        let b_code = "\
source(\"a.R\")
foo$bar <- 2
";
        let a_code = "\
foo <- list()



foo$bar <- 1
";

        let c_uri = add_doc(&mut state, "file:///workspace/c.R", c_code);
        let b_uri = add_doc(&mut state, "file:///workspace/b.R", b_code);
        let a_uri = add_doc(&mut state, "file:///workspace/a.R", a_code);

        for (uri, code) in [(&c_uri, c_code), (&b_uri, b_code), (&a_uri, a_code)] {
            state.cross_file_graph.update_file(
                uri,
                &crate::cross_file::extract_metadata(code),
                None,
                |_| None,
            );
        }

        // line 1 col 10 = `bar` in `print(foo$bar)`
        let pos = Position::new(1, 10);
        let l = loc(goto_definition(&state, &c_uri, pos));
        assert_eq!(l.uri, b_uri, "b.R runs after a.R in c.R's source chain");
        assert_ne!(
            l.uri, a_uri,
            "must not compare file-local line numbers across files"
        );
        assert_eq!(l.range.start.line, 1);
        assert_eq!(l.range.start.character, 4);
    }

    /// Regression for issue #154: contributor-chain order can visit an
    /// indirect branch before a directly sourced file. Non-cursor fallback
    /// ranking must prefer the graph-closer file, not whichever contributor
    /// appeared first and not whichever file has the later local line number.
    #[test]
    fn dollar_rhs_prefers_graph_closer_file_over_earlier_contributor_rank() {
        let mut state = fresh_state();

        let d_code = "\
source(\"x.R\")
source(\"b.R\")
print(foo$bar)
";
        let x_code = "source(\"c.R\")\n";
        let c_code = "\
source(\"a.R\")




foo$bar <- 2
";
        let b_code = "\
source(\"a.R\")
foo$bar <- 1
";
        let a_code = "foo <- list()\n";

        let d_uri = add_doc(&mut state, "file:///workspace/d.R", d_code);
        let x_uri = add_doc(&mut state, "file:///workspace/x.R", x_code);
        let c_uri = add_doc(&mut state, "file:///workspace/c.R", c_code);
        let b_uri = add_doc(&mut state, "file:///workspace/b.R", b_code);
        let a_uri = add_doc(&mut state, "file:///workspace/a.R", a_code);

        for (uri, code) in [
            (&d_uri, d_code),
            (&x_uri, x_code),
            (&c_uri, c_code),
            (&b_uri, b_code),
            (&a_uri, a_code),
        ] {
            state.cross_file_graph.update_file(
                uri,
                &crate::cross_file::extract_metadata(code),
                None,
                |_| None,
            );
        }

        // line 2 col 10 = `bar` in `print(foo$bar)`
        let pos = Position::new(2, 10);
        let l = loc(goto_definition(&state, &d_uri, pos));
        assert_eq!(
            l.uri, b_uri,
            "directly sourced b.R should beat indirectly reached c.R"
        );
        assert_ne!(
            l.uri, c_uri,
            "must not use contributor-chain rank or cross-file line numbers as the primary tiebreak",
        );
        assert_eq!(l.range.start.line, 1);
        assert_eq!(l.range.start.character, 4);
    }

    /// Regression: an unrelated runner that sources both the cursor file and a
    /// farther contributor must not create an undirected shortcut path that
    /// makes the farther contributor appear as close as the actually-nearer
    /// file in the cursor's contributing scope.
    #[test]
    fn dollar_rhs_distance_ignores_unrelated_runner_shortcut_paths() {
        let mut state = fresh_state();

        let d_code = "\
source(\"y.R\")
source(\"v.R\")
print(foo$bar)
";
        let y_code = "source(\"z.R\")\n";
        let z_code = "source(\"c.R\")\n";
        let c_code = "\
source(\"a.R\")
foo$bar <- 2
";
        let v_code = "source(\"b.R\")\n";
        let b_code = "\
source(\"a.R\")
foo$bar <- 1
";
        let a_code = "foo <- list()\n";
        let runner_code = "\
source(\"d.R\")
source(\"c.R\")
";

        let d_uri = add_doc(&mut state, "file:///workspace/d.R", d_code);
        let y_uri = add_doc(&mut state, "file:///workspace/y.R", y_code);
        let z_uri = add_doc(&mut state, "file:///workspace/z.R", z_code);
        let c_uri = add_doc(&mut state, "file:///workspace/c.R", c_code);
        let v_uri = add_doc(&mut state, "file:///workspace/v.R", v_code);
        let b_uri = add_doc(&mut state, "file:///workspace/b.R", b_code);
        let a_uri = add_doc(&mut state, "file:///workspace/a.R", a_code);
        let runner_uri = add_doc(&mut state, "file:///workspace/runner.R", runner_code);

        for (uri, code) in [
            (&d_uri, d_code),
            (&y_uri, y_code),
            (&z_uri, z_code),
            (&c_uri, c_code),
            (&v_uri, v_code),
            (&b_uri, b_code),
            (&a_uri, a_code),
            (&runner_uri, runner_code),
        ] {
            state.cross_file_graph.update_file(
                uri,
                &crate::cross_file::extract_metadata(code),
                None,
                |_| None,
            );
        }

        // line 2 col 10 = `bar` in `print(foo$bar)`
        let pos = Position::new(2, 10);
        let l = loc(goto_definition(&state, &d_uri, pos));
        assert_eq!(
            l.uri, b_uri,
            "b.R is closer in d.R's contributing scope; runner.R must not shorten c.R"
        );
        assert_ne!(
            l.uri, c_uri,
            "must not rank through unrelated non-contributing runner.R"
        );
        assert_eq!(l.range.start.line, 1);
        assert_eq!(l.range.start.character, 4);
    }

    /// Negative: the contributor-aware scan sees `b.R`, but the only
    /// `foo$bar <- 99` candidate there is inside a function where `foo` is
    /// shadowed. The per-site scope-resolve must reject it.
    #[test]
    fn dollar_rhs_third_file_shadowed_assignment_does_not_match() {
        let mut state = fresh_state();

        let c_code = "\
source(\"b.R\")
print(foo$bar)
";
        let b_code = "\
source(\"a.R\")
g <- function() {
  foo <- list()
  foo$bar <- 99
}
";
        let a_code = "foo <- list()\n";

        let c_uri = add_doc(&mut state, "file:///workspace/c.R", c_code);
        let b_uri = add_doc(&mut state, "file:///workspace/b.R", b_code);
        let a_uri = add_doc(&mut state, "file:///workspace/a.R", a_code);

        for (uri, code) in [(&c_uri, c_code), (&b_uri, b_code), (&a_uri, a_code)] {
            state.cross_file_graph.update_file(
                uri,
                &crate::cross_file::extract_metadata(code),
                None,
                |_| None,
            );
        }

        // line 1 col 10 = `bar` in `print(foo$bar)`
        let pos = Position::new(1, 10);
        assert!(
            goto_definition(&state, &c_uri, pos).is_none(),
            "must not match `foo$bar <- 99` inside g(); that's a different `foo`",
        );
    }

    /// Negative: a matching-looking `foo$bar <- 99` in a document outside the
    /// cursor's contributing cross-file files is not scanned.
    #[test]
    fn dollar_rhs_member_assignment_outside_connected_component_does_not_match() {
        let mut state = fresh_state();

        let c_code = "\
source(\"b.R\")
print(foo$bar)
";
        let b_code = "source(\"a.R\")\n";
        let a_code = "foo <- list()\n";
        let unrelated_code = "\
foo <- list()
foo$bar <- 99
";

        let c_uri = add_doc(&mut state, "file:///workspace/c.R", c_code);
        let b_uri = add_doc(&mut state, "file:///workspace/b.R", b_code);
        let a_uri = add_doc(&mut state, "file:///workspace/a.R", a_code);
        let unrelated_uri = add_doc(&mut state, "file:///workspace/unrelated.R", unrelated_code);

        for (uri, code) in [
            (&c_uri, c_code),
            (&b_uri, b_code),
            (&a_uri, a_code),
            (&unrelated_uri, unrelated_code),
        ] {
            state.cross_file_graph.update_file(
                uri,
                &crate::cross_file::extract_metadata(code),
                None,
                |_| None,
            );
        }

        // line 1 col 10 = `bar` in `print(foo$bar)`
        let pos = Position::new(1, 10);
        assert!(
            goto_definition(&state, &c_uri, pos).is_none(),
            "must not scan unrelated.R outside c.R's connected component",
        );
    }

    /// Chained-LHS rejection: `collect_member_assignments` requires the
    /// extract's LHS to be a bare identifier, so `foo$inner$bar <- 99` is
    /// silently skipped. With the cursor on `inner` in `foo$inner`, today's
    /// behavior is `None` — we don't treat the chained assignment as a
    /// definition of `foo$inner`. Pin this so a future relaxation that
    /// recognizes the deeper LHS as also defining `foo$inner` has a clear
    /// breaking point.
    #[test]
    fn chained_lhs_member_assignment_not_collected() {
        let mut state = fresh_state();
        let code = "\
foo <- list()
foo$inner$bar <- 99
use(foo$inner)
";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // line 2 col 8 = `inner` in `use(foo$inner)`
        let pos = Position::new(2, 8);
        assert!(
            goto_definition(&state, &uri, pos).is_none(),
            "chained `foo$inner$bar <- 99` (outer extract's LHS is itself \
             an extract, not a bare identifier) must not be collected as a \
             candidate for `foo$inner`",
        );
    }
}
