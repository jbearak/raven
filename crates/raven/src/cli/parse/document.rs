//! The per-file document `raven parse` prints: the envelope (`schema_version`,
//! `raven_version`, `path`, `encoding`, `line_count`), the error document for a
//! file Raven can't read or decode, and the position unit every `range` uses.
//!
//! Positions are into the decoded text with any byte-order mark removed:
//! 0-based lines and a character offset in UTF-16 code units, end-exclusive.
//! `\n`, `\r\n` and a lone `\r` each end a line and are not part of the line's
//! characters (see [`LineIndex`]).

use std::path::Path;

use serde::Serialize;

use super::errors::ParseError;
use super::statements::{Comment, Statement, build_document_body};

/// JSON schema version. Removing or renaming a field, changing a field's
/// type, or changing what a field or value means increments it; adding a
/// field, a node kind or an enum value doesn't.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Position {
    pub(crate) line: u32,
    pub(crate) character: u32,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub(crate) struct Range {
    pub(crate) start: Position,
    pub(crate) end: Position,
}

/// One printed document: a parsed file, or the error document for a file Raven
/// couldn't read. A consumer tells them apart by the presence of `error`.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub(crate) enum Document {
    Parsed(Box<ParsedDocument>),
    Error(ErrorDocument),
}

impl Document {
    pub(crate) fn is_error(&self) -> bool {
        matches!(self, Document::Error(_))
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct ParsedDocument {
    pub(crate) schema_version: u32,
    pub(crate) raven_version: &'static str,
    pub(crate) path: String,
    pub(crate) encoding: Encoding,
    pub(crate) line_count: u32,
    pub(crate) statements: Vec<Statement>,
    /// Comments no statement or block owns: every comment in a file without
    /// statements, and own-line comments after the last top-level statement.
    pub(crate) comments: Vec<Comment>,
    /// What R's parser would reject or warn about, in source order.
    pub(crate) errors: Vec<ParseError>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ErrorDocument {
    pub(crate) schema_version: u32,
    pub(crate) raven_version: &'static str,
    pub(crate) path: String,
    pub(crate) error: ErrorInfo,
}

#[derive(Debug, Serialize)]
pub(crate) struct ErrorInfo {
    pub(crate) message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct Encoding {
    /// `UTF-8`, `UTF-16LE` or `UTF-16BE`.
    pub(crate) name: &'static str,
    /// A byte-order mark was present (and stripped).
    pub(crate) bom: bool,
    /// `lf`, `crlf`, `cr`, `mixed`, or `none` for a file without one.
    pub(crate) line_endings: &'static str,
}

pub(crate) fn error_document(path: String, message: String) -> Document {
    Document::Error(ErrorDocument {
        schema_version: SCHEMA_VERSION,
        raven_version: env!("CARGO_PKG_VERSION"),
        path,
        error: ErrorInfo { message },
    })
}

/// Read, decode and parse the file at `fs_path`, printed as `path`. A file that
/// can't be opened or isn't valid in its encoding gets the error document; no
/// replacement decoding.
pub(crate) fn document_for_file(fs_path: &Path, path: String) -> Document {
    let bytes = match std::fs::read(fs_path) {
        Ok(bytes) => bytes,
        Err(e) => return error_document(path, e.to_string()),
    };
    let detected = crate::state::detect_source_encoding(&bytes);
    match crate::state::decode_source(bytes) {
        Ok(text) => document_from_text(path, detected, &text),
        Err(e) => error_document(path, e.to_string()),
    }
}

/// The parsed document for already-decoded `text` (BOM removed).
pub(crate) fn document_from_text(
    path: String,
    detected: crate::state::SourceEncoding,
    text: &str,
) -> Document {
    use crate::state::SourceEncoding as E;
    let (name, bom) = match detected {
        E::Utf8 => ("UTF-8", false),
        E::Utf8Bom => ("UTF-8", true),
        E::Utf16Le => ("UTF-16LE", true),
        E::Utf16Be => ("UTF-16BE", true),
    };
    let lines = LineIndex::new(text);
    let (statements, comments, errors) = build_document_body(text, &lines);
    Document::Parsed(Box::new(ParsedDocument {
        schema_version: SCHEMA_VERSION,
        raven_version: env!("CARGO_PKG_VERSION"),
        path,
        encoding: Encoding {
            name,
            bom,
            line_endings: line_endings(text),
        },
        line_count: lines.line_count(),
        statements,
        comments,
        errors,
    }))
}

/// `lf`, `crlf`, `cr`, `mixed` (more than one kind), or `none`.
fn line_endings(text: &str) -> &'static str {
    let (mut lf, mut crlf, mut cr) = (false, false, false);
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => {
                crlf = true;
                i += 1;
            }
            b'\r' => cr = true,
            b'\n' => lf = true,
            _ => {}
        }
        i += 1;
    }
    match (lf, crlf, cr) {
        (false, false, false) => "none",
        (true, false, false) => "lf",
        (false, true, false) => "crlf",
        (false, false, true) => "cr",
        _ => "mixed",
    }
}

/// Line starts of a decoded text, for byte offset → [`Position`].
///
/// A line ends at `\n`, `\r\n`, or a lone `\r` (as R's own reader treats a
/// lone `\r`), and the ending is not part of the line's characters. Characters
/// are counted in UTF-16 code units.
pub(crate) struct LineIndex<'a> {
    text: &'a str,
    /// Byte offset where each line starts. Always has the first line's `0`.
    starts: Vec<usize>,
}

impl<'a> LineIndex<'a> {
    pub(crate) fn new(text: &'a str) -> Self {
        let bytes = text.as_bytes();
        let mut starts = vec![0];
        for (i, &b) in bytes.iter().enumerate() {
            match b {
                b'\n' => starts.push(i + 1),
                b'\r' if bytes.get(i + 1) != Some(&b'\n') => starts.push(i + 1),
                _ => {}
            }
        }
        LineIndex { text, starts }
    }

    /// The line holding byte `offset` (a line ending belongs to its line).
    pub(crate) fn line_of(&self, offset: usize) -> usize {
        self.starts.partition_point(|&start| start <= offset) - 1
    }

    pub(crate) fn position(&self, offset: usize) -> Position {
        let line = self.line_of(offset);
        let start = self.starts[line];
        let character = self.text[start..offset].encode_utf16().count();
        Position {
            line: line as u32,
            character: character as u32,
        }
    }

    pub(crate) fn range(&self, bytes: std::ops::Range<usize>) -> Range {
        Range {
            start: self.position(bytes.start),
            end: self.position(bytes.end),
        }
    }

    /// The byte offset of `position`: the inverse of [`Self::position`]. A
    /// character past the line's end clamps to it, and a line past the last
    /// to the text's end.
    pub(crate) fn offset(&self, position: Position) -> usize {
        let line = position.line as usize;
        let Some(&start) = self.starts.get(line) else {
            return self.text.len();
        };
        let end = self.line_end(line);
        let mut units = 0;
        for (index, ch) in self.text[start..end].char_indices() {
            if units >= position.character as usize {
                return start + index;
            }
            units += ch.len_utf16();
        }
        end
    }

    /// The byte offset where `line` starts.
    pub(crate) fn line_start(&self, line: usize) -> usize {
        self.starts[line]
    }

    /// The byte offset where `line`'s characters end, before its line ending.
    pub(crate) fn line_end(&self, line: usize) -> usize {
        let start = self.starts[line];
        let rest = &self.text[start..];
        start + rest.find(['\r', '\n']).unwrap_or(rest.len())
    }

    /// The range of `line`'s characters, without its line ending.
    pub(crate) fn line_range(&self, line: usize) -> Range {
        self.range(self.line_start(line)..self.line_end(line))
    }

    /// The number of lines. A final line ending doesn't start another line,
    /// so `"a\nb\n"` and `"a\nb"` both have 2 and an empty file has 0.
    pub(crate) fn line_count(&self) -> u32 {
        let lines = if self.text.is_empty() {
            0
        } else if *self.starts.last().expect("line 0") == self.text.len() {
            self.starts.len() - 1
        } else {
            self.starts.len()
        };
        lines as u32
    }

    /// Whether the line holds nothing but whitespace.
    pub(crate) fn is_blank(&self, line: usize) -> bool {
        let start = self.starts[line];
        let end = self
            .starts
            .get(line + 1)
            .copied()
            .unwrap_or(self.text.len());
        self.text[start..end].trim().is_empty()
    }

    /// Whether any line strictly between `after` and `before` is blank.
    /// `after` is `None` for the start of the file, so line 0 counts.
    pub(crate) fn blank_between(&self, after: Option<usize>, before: usize) -> bool {
        let first = after.map_or(0, |line| line + 1);
        (first..before).any(|line| self.is_blank(line))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_index_counts_utf16_units_and_every_line_ending() {
        let text = "größe\r\n😀x\ry\nz";
        let lines = LineIndex::new(text);
        // `ö` and `ß` are one UTF-16 unit each (two UTF-8 bytes); `😀` is two
        // units (four bytes).
        assert_eq!(
            lines.position("größe".len()),
            Position {
                line: 0,
                character: 5
            }
        );
        let x = text.find('x').unwrap();
        assert_eq!(
            lines.position(x),
            Position {
                line: 1,
                character: 2
            }
        );
        let y = text.find('y').unwrap();
        assert_eq!(
            lines.position(y),
            Position {
                line: 2,
                character: 0
            }
        );
        assert_eq!(lines.line_count(), 4);
        assert_eq!(line_endings(text), "mixed");
    }

    #[test]
    fn line_count_and_endings() {
        assert_eq!(LineIndex::new("").line_count(), 0);
        assert_eq!(LineIndex::new("a").line_count(), 1);
        assert_eq!(LineIndex::new("a\n").line_count(), 1);
        assert_eq!(LineIndex::new("a\n\n").line_count(), 2);
        assert_eq!(LineIndex::new("a\r\nb\r\n").line_count(), 2);
        assert_eq!(line_endings("a"), "none");
        assert_eq!(line_endings("a\nb\n"), "lf");
        assert_eq!(line_endings("a\r\nb\r\n"), "crlf");
        assert_eq!(line_endings("a\rb\r"), "cr");
    }
}
