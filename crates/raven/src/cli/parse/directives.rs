//! Each comment's `directive`: the `# raven:` / `@lsp-` directive or lintr
//! `# nolint` marker it carries, as Raven reads it, or `null`.
//!
//! Nothing here parses a directive. `# raven:` and `@lsp-` directives come
//! from `cross_file::directive::scan_directives`, the scan `raven check`'s
//! analysis folds into its metadata, so `parse` and `check` can't disagree on
//! what a directive means, where it applies, or whether it is honored. lintr's
//! `# nolint` markers come from the lint track's reader
//! (`linting::nolint::lintr_marker`), and `# raven: ignore-chunk` from the
//! chunk reader (`chunks::parse_ignore_chunk_directive`).
//!
//! On top of what Raven honors, a comment is also reported when it is a
//! directive Raven ignores where it stands (`honored: false` with a
//! `reason`), and with kind `unknown` when it starts like a directive
//! (`# raven:` or `# @lsp-`) but no directive grammar reads it.
//!
//! `docs/cli.md` (`raven parse`, "Parse directives") is the reference for the
//! JSON shape; keep it in step with `Json::directive` and `Json::payload`.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use crate::cross_file::directive::{
    self, DirectivePayload, DirectiveStatus, ScannedDirective, SuppressionKind,
};
use crate::cross_file::types::{LineSuppression, NseScope, SuppressionFlavor};
use crate::linting::nolint::{LintrMarker, lintr_marker};

use super::document::{LineIndex, Range};
use super::statements::CommentSpan;

/// Each directive comment's `directive` object, by the comment's start byte.
/// `text` is the decoded text with each lone `\r` read as `\n` (the text the
/// tree was parsed from), so its lines are the document's lines.
pub(crate) fn directives_by_comment(
    text: &str,
    lines: &LineIndex<'_>,
    comments: &[CommentSpan],
) -> HashMap<usize, Value> {
    let comment_at: HashMap<usize, CommentSpan> = comments.iter().map(|c| (c.start, *c)).collect();
    let builder = Json { lines };
    let mut out = HashMap::new();

    // `# raven:` / `@lsp-` directives, as the analysis reads them.
    let scan = directive::scan_directives(text);
    let mut suppression_lines = std::collections::HashSet::new();
    for scanned in &scan.directives {
        if matches!(scanned.payload, DirectivePayload::Suppression(_)) {
            suppression_lines.insert(scanned.line as usize);
        }
        let start = lines.line_start(scanned.line as usize) + scanned.hash;
        // A `#` the scan reads as a comment that the grammar puts inside a
        // string (a multi-line string's later line) has no comment to carry it.
        if comment_at.contains_key(&start) {
            out.insert(start, builder.scanned(scanned));
        }
    }

    // lintr's `# nolint`: paired among themselves, as the lint track pairs
    // them in a file without `# raven:` blocks.
    let mut nolint = Vec::new();
    for comment in comments {
        if out.contains_key(&comment.start) {
            continue;
        }
        let line = lines.line_of(comment.start);
        // The lint track reads a line's `# raven:` / `@lsp-` marker first.
        if suppression_lines.contains(&line) {
            continue;
        }
        let line_text = &text[lines.line_start(line)..lines.line_end(line)];
        if let Some((hash, marker)) = lintr_marker(line_text)
            && lines.line_start(line) + hash == comment.start
        {
            nolint.push((comment.start, line, marker));
        }
    }
    out.extend(builder.nolint(&nolint));

    // Directives Raven doesn't read where they stand, and unknown ones.
    for comment in comments {
        if out.contains_key(&comment.start) {
            continue;
        }
        let comment_text = &text[comment.start..comment.end];
        let line = lines.line_of(comment.start);
        let own_line = text[lines.line_start(line)..comment.start]
            .trim()
            .is_empty();
        let value = if let Some(what) = crate::chunks::parse_ignore_chunk_directive(comment_text) {
            // R Markdown and Quarto only.
            let fields = builder.suppression("ignore", "chunk", &what, Value::Null);
            Some(builder.directive(
                "suppression",
                "raven",
                "ignore-chunk",
                false,
                Some("chunk_only"),
                fields,
            ))
        } else if !own_line
            && let Some((lsp_alias, keyword, payload)) =
                directive::classify_as_own_line(comment_text)
        {
            let (kind, fields) = builder.payload(&payload, &keyword, line, None);
            Some(builder.directive(
                kind,
                prefix(lsp_alias),
                &keyword,
                false,
                Some("not_own_line"),
                fields,
            ))
        } else if let Some((lsp_alias, word)) = directive::directive_word_start(comment_text) {
            let keyword: String = comment_text[word..]
                .chars()
                .take_while(|c| !c.is_whitespace() && !matches!(c, ':' | '[' | '(' | '#'))
                .collect();
            Some(builder.directive(
                "unknown",
                prefix(lsp_alias),
                &keyword,
                false,
                None,
                Map::new(),
            ))
        } else {
            None
        };
        if let Some(value) = value {
            out.insert(comment.start, value);
        }
    }
    out
}

fn prefix(lsp_alias: bool) -> &'static str {
    if lsp_alias { "lsp" } else { "raven" }
}

struct Json<'a> {
    lines: &'a LineIndex<'a>,
}

impl Json<'_> {
    /// The object every directive has: `kind`, `prefix`, `keyword`,
    /// `honored`, `reason`, then the kind's own fields.
    fn directive(
        &self,
        kind: &str,
        prefix: &str,
        keyword: &str,
        honored: bool,
        reason: Option<&str>,
        fields: Map<String, Value>,
    ) -> Value {
        let mut object = Map::new();
        object.insert("kind".into(), kind.into());
        object.insert("prefix".into(), prefix.into());
        object.insert("keyword".into(), keyword.into());
        object.insert("honored".into(), honored.into());
        object.insert("reason".into(), reason.map_or(Value::Null, Value::from));
        object.extend(fields);
        Value::Object(object)
    }

    fn range(&self, range: Range) -> Value {
        serde_json::to_value(range).expect("a range serializes")
    }

    /// Lines `first..=last`, from the first's start to the last's end.
    fn lines_range(&self, first: usize, last: usize) -> Value {
        let last = last.min(self.lines.line_count().saturating_sub(1) as usize);
        self.range(Range {
            start: self.lines.line_range(first).start,
            end: self.lines.line_range(last).end,
        })
    }

    fn line_range(&self, line: usize) -> Value {
        if line < self.lines.line_count() as usize {
            self.range(self.lines.line_range(line))
        } else {
            Value::Null
        }
    }

    /// Every line, from the first's start to the last's end.
    fn whole_file(&self) -> Value {
        self.lines_range(0, self.lines.line_count() as usize)
    }

    fn suppression(
        &self,
        family: &str,
        scope: &str,
        what: &LineSuppression,
        target: Value,
    ) -> Map<String, Value> {
        let codes = match what {
            LineSuppression::All => Vec::new(),
            LineSuppression::Codes(codes) => codes.clone(),
        };
        let mut fields = Map::new();
        fields.insert("family".into(), family.into());
        fields.insert("scope".into(), scope.into());
        fields.insert("codes".into(), codes.into());
        fields.insert("target".into(), target);
        fields
    }

    /// A payload's kind and fields. `keyword` is the directive word as
    /// written; `status` is the scan's verdict, for a suppression's target
    /// (`None` for a comment Raven doesn't read there).
    fn payload(
        &self,
        payload: &DirectivePayload,
        keyword: &str,
        line: usize,
        status: Option<DirectiveStatus>,
    ) -> (&'static str, Map<String, Value>) {
        let honored = matches!(
            status,
            Some(
                DirectiveStatus::Honored
                    | DirectiveStatus::BlockStart { .. }
                    | DirectiveStatus::BlockEnd { .. }
            )
        );
        let object = |value: Value| match value {
            Value::Object(map) => map,
            _ => unreachable!("json! of an object"),
        };
        match payload {
            DirectivePayload::Forward { path, line: at } => (
                "forward",
                object(json!({
                    "call_type": call_type_of(keyword),
                    "path": path,
                    "line": line_parameter(at.as_deref()),
                })),
            ),
            DirectivePayload::Backward {
                path,
                line: at,
                match_pattern,
            } => (
                "backward",
                object(json!({
                    "call_type": call_type_of(keyword),
                    "path": path,
                    "line": line_parameter(at.as_deref()),
                    "match": match_pattern,
                })),
            ),
            DirectivePayload::WorkingDirectory { path } => {
                ("working_directory", object(json!({"path": path})))
            }
            DirectivePayload::SelfContained => ("self_contained", Map::new()),
            DirectivePayload::Variable { name } => ("variable", object(json!({"name": name}))),
            DirectivePayload::Function { name, formals } => {
                let (package, name) = qualified(name, honored);
                (
                    "function",
                    object(json!({"name": name, "package": package, "formals": formals})),
                )
            }
            DirectivePayload::Nse {
                declaration,
                name,
                scope,
            } => {
                let (package, name) = qualified(name, honored);
                let formals = match scope {
                    Some(NseScope::Formals(formals)) => json!(formals),
                    Some(NseScope::WholeCall) | None => Value::Null,
                };
                (
                    "nse",
                    object(json!({
                        "declaration": declaration,
                        "name": name,
                        "package": package,
                        "formals": formals,
                    })),
                )
            }
            DirectivePayload::Suppression(marker) => {
                let family = match marker.flavor {
                    SuppressionFlavor::Ignore => "ignore",
                    SuppressionFlavor::Expect => "expect",
                };
                let (scope, target) = match marker.kind {
                    SuppressionKind::SameLine => ("line", self.line_range(line)),
                    SuppressionKind::NextLine => ("next", self.line_range(line + 1)),
                    SuppressionKind::File => ("file", self.whole_file()),
                    SuppressionKind::BlockStart => ("start", self.block_target(line, status)),
                    SuppressionKind::BlockEnd => ("end", self.block_target(line, status)),
                };
                // A directive Raven doesn't read there has no target.
                let target = if status.is_some() {
                    target
                } else {
                    Value::Null
                };
                (
                    "suppression",
                    self.suppression(family, scope, &marker.what, target),
                )
            }
        }
    }

    /// A block's lines: from its `-start` to its `-end`, or to the last line
    /// when nothing closes it.
    fn block_target(&self, line: usize, status: Option<DirectiveStatus>) -> Value {
        let last = self.lines.line_count() as usize;
        match status {
            Some(DirectiveStatus::BlockStart { end_line }) => {
                self.lines_range(line, end_line.map_or(last, |end| end as usize))
            }
            Some(DirectiveStatus::BlockEnd { start_line }) => {
                self.lines_range(start_line as usize, line)
            }
            _ => Value::Null,
        }
    }

    fn scanned(&self, scanned: &ScannedDirective) -> Value {
        let line = scanned.line as usize;
        let (kind, fields) = self.payload(
            &scanned.payload,
            &scanned.keyword,
            line,
            Some(scanned.status),
        );
        let (honored, reason) = match scanned.status {
            DirectiveStatus::Honored
            | DirectiveStatus::BlockStart { end_line: Some(_) }
            | DirectiveStatus::BlockEnd { .. } => (true, None),
            DirectiveStatus::BlockStart { end_line: None } => (true, Some("unpaired")),
            DirectiveStatus::OutsideHeader => (false, Some("outside_header")),
            DirectiveStatus::NestedStart => (false, Some("nested")),
            DirectiveStatus::UnpairedEnd => (false, Some("unpaired")),
            DirectiveStatus::Malformed => (false, Some("malformed")),
        };
        self.directive(
            kind,
            prefix(scanned.lsp_alias),
            &scanned.keyword,
            honored,
            reason,
            fields,
        )
    }

    /// lintr's markers, `(comment start, line, marker)` in source order,
    /// with `start`/`end` paired as the lint track pairs them: a `start`
    /// while a block is open, and an `end` with none open, do nothing; a
    /// `start` nothing closes runs to the last line.
    fn nolint(&self, markers: &[(usize, usize, LintrMarker)]) -> Vec<(usize, Value)> {
        let last = self.lines.line_count() as usize;
        let mut pairs: HashMap<usize, usize> = HashMap::new();
        let mut open: Option<usize> = None;
        let mut nested = Vec::new();
        let mut unpaired_ends = Vec::new();
        for (index, (_, _, marker)) in markers.iter().enumerate() {
            match marker {
                LintrMarker::Start(_) if open.is_some() => nested.push(index),
                LintrMarker::Start(_) => open = Some(index),
                LintrMarker::End => match open.take() {
                    Some(start) => {
                        pairs.insert(start, index);
                        pairs.insert(index, start);
                    }
                    None => unpaired_ends.push(index),
                },
                LintrMarker::Line(_) => {}
            }
        }
        markers
            .iter()
            .enumerate()
            .map(|(index, (start, line, marker))| {
                let line = *line;
                let paired_line = pairs.get(&index).map(|&other| markers[other].1);
                let (scope, what, target, honored, reason) = match marker {
                    LintrMarker::Line(what) => {
                        ("line", what.clone(), self.line_range(line), true, None)
                    }
                    LintrMarker::Start(what) if nested.contains(&index) => {
                        ("start", what.clone(), Value::Null, false, Some("nested"))
                    }
                    LintrMarker::Start(what) => match paired_line {
                        Some(end) => (
                            "start",
                            what.clone(),
                            self.lines_range(line, end),
                            true,
                            None,
                        ),
                        None => (
                            "start",
                            what.clone(),
                            self.lines_range(line, last),
                            true,
                            Some("unpaired"),
                        ),
                    },
                    LintrMarker::End => match paired_line {
                        Some(begin) => (
                            "end",
                            LineSuppression::All,
                            self.lines_range(begin, line),
                            true,
                            None,
                        ),
                        None => (
                            "end",
                            LineSuppression::All,
                            Value::Null,
                            false,
                            Some("unpaired"),
                        ),
                    },
                };
                let fields = self.suppression("nolint", scope, &what, target);
                let value =
                    self.directive("suppression", "nolint", "nolint", honored, reason, fields);
                (*start, value)
            })
            .collect()
    }
}

/// `source`, `run` or `include`, from a forward or backward directive word.
fn call_type_of(keyword: &str) -> &'static str {
    match keyword {
        "run" | "run-by" => "run",
        "include" | "included-by" => "include",
        _ => "source",
    }
}

/// `line=` as written: a number, or the string `eof` or `end`.
fn line_parameter(written: Option<&str>) -> Value {
    match written {
        None => Value::Null,
        Some(digits) => digits
            .parse::<u64>()
            .map_or_else(|_| Value::from(digits), Value::from),
    }
}

/// A declared name's package and bare name: `pkg::f` is `pkg` and `f`. A
/// name Raven rejects is reported whole, with no package.
fn qualified(name: &str, honored: bool) -> (Option<&str>, &str) {
    match name.split_once("::") {
        Some((package, bare)) if honored => (Some(package), bare),
        _ => (None, name),
    }
}
