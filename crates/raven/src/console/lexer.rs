//! A tiny single-pass R scanner for things that must be cheap on every
//! keystroke and only cosmetic if wrong: bracket matching, auto-pair vetoes,
//! and continuation indentation. Whether input is *complete* is decided by R's
//! own parser (see `editor::RValidator`), never here.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Code,
    Str(u8),
    Comment,
}

#[derive(Debug, Default)]
pub struct Scan {
    /// Bracket tokens outside strings/comments: (byte offset, byte, length).
    brackets: Vec<(usize, u8, usize)>,
    end_state_code: bool,
    open_depth: usize,
    /// Last significant (non-space, non-comment) code token text.
    last_token: String,
}

pub fn scan(s: &str) -> Scan {
    let b = s.as_bytes();
    let mut st = State::Code;
    let mut out = Scan::default();
    let mut stack: Vec<usize> = Vec::new(); // lengths of open brackets
    let mut i = 0;
    let mut last_start = None;
    while i < b.len() {
        let c = b[i];
        match st {
            State::Comment => {
                if c == b'\n' {
                    st = State::Code;
                }
                i += 1;
            }
            State::Str(q) => {
                if c == b'\\' {
                    i += 2;
                } else {
                    if c == q {
                        st = State::Code;
                        last_start = Some((i, i + 1));
                    }
                    i += 1;
                }
            }
            State::Code => match c {
                b'#' => {
                    st = State::Comment;
                    i += 1;
                }
                b'"' | b'\'' | b'`' => {
                    st = State::Str(c);
                    i += 1;
                }
                b'(' | b'{' => {
                    out.brackets.push((i, c, 1));
                    stack.push(1);
                    last_start = Some((i, i + 1));
                    i += 1;
                }
                b'[' => {
                    let len = if b.get(i + 1) == Some(&b'[') { 2 } else { 1 };
                    out.brackets.push((i, c, len));
                    stack.push(len);
                    last_start = Some((i, i + len));
                    i += len;
                }
                b')' | b'}' | b']' => {
                    // `]]` is one token only when it closes a `[[`.
                    let len =
                        if c == b']' && b.get(i + 1) == Some(&b']') && stack.last() == Some(&2) {
                            2
                        } else {
                            1
                        };
                    out.brackets.push((i, c, len));
                    stack.pop();
                    last_start = Some((i, i + len));
                    i += len;
                }
                b' ' | b'\t' | b'\r' | b'\n' => i += 1,
                _ => {
                    let start = i;
                    if c.is_ascii_alphanumeric() || c == b'.' || c == b'_' || c >= 0x80 {
                        while i < b.len()
                            && (b[i].is_ascii_alphanumeric()
                                || b[i] == b'.'
                                || b[i] == b'_'
                                || b[i] >= 0x80)
                        {
                            i += 1;
                        }
                    } else if c == b'%' {
                        i += 1;
                        while i < b.len() && b[i] != b'%' && b[i] != b'\n' {
                            i += 1;
                        }
                        i = (i + 1).min(b.len());
                    } else {
                        while i < b.len() && b"+-*/^<>=!&|~$@:?,;".contains(&b[i]) {
                            i += 1;
                        }
                        if i == start {
                            i += 1;
                        }
                    }
                    last_start = Some((start, i));
                }
            },
        }
    }
    out.end_state_code = st == State::Code;
    out.open_depth = stack.len();
    if let Some((a, z)) = last_start {
        out.last_token = s[a..z.min(s.len())].to_string();
    }
    out
}

impl Scan {
    pub fn in_string_or_comment(&self) -> bool {
        !self.end_state_code
    }

    pub fn open_depth(&self) -> usize {
        self.open_depth
    }

    /// The input ends with a binary operator that makes R expect more input
    /// on the next line (`|>`, `+`, `<-`, `%>%`, ...). A trailing comma is not
    /// counted: it only appears inside brackets, which already indent.
    pub fn ends_with_operator(&self) -> bool {
        let t = self.last_token.as_str();
        if t.starts_with('%') && t.ends_with('%') && t.len() >= 2 {
            return true;
        }
        matches!(
            t,
            "+" | "-"
                | "*"
                | "/"
                | "^"
                | "|>"
                | "|"
                | "||"
                | "&"
                | "&&"
                | "~"
                | "<-"
                | "<<-"
                | "="
                | "=="
                | "!="
                | "<"
                | ">"
                | "<="
                | ">="
                | "->"
                | "->>"
                | ":"
                | "$"
                | "@"
        )
    }

    pub fn bracket_len(&self, pos: usize) -> usize {
        self.brackets
            .iter()
            .find(|b| b.0 == pos)
            .map(|b| b.2)
            .unwrap_or(1)
    }

    /// When the cursor is on, or just after, a bracket, the pair it belongs to.
    pub fn matching_bracket(&self, cursor: usize) -> Option<(usize, usize)> {
        let idx = self
            .brackets
            .iter()
            .position(|b| b.0 == cursor)
            .or_else(|| self.brackets.iter().position(|b| b.0 + b.2 == cursor))?;
        let (_, c, _) = self.brackets[idx];
        let open = matches!(c, b'(' | b'[' | b'{');
        let mut depth = 0i32;
        if open {
            for j in idx..self.brackets.len() {
                let k = self.brackets[j].1;
                if matches!(k, b'(' | b'[' | b'{') {
                    depth += 1
                } else {
                    depth -= 1
                }
                if depth == 0 {
                    return Some((self.brackets[idx].0, self.brackets[j].0));
                }
            }
        } else {
            for j in (0..=idx).rev() {
                let k = self.brackets[j].1;
                if matches!(k, b'(' | b'[' | b'{') {
                    depth -= 1
                } else {
                    depth += 1
                }
                if depth == 0 {
                    return Some((self.brackets[j].0, self.brackets[idx].0));
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brackets_in_strings_and_comments_are_ignored() {
        let s = scan("f(\"(\", x) # )");
        assert_eq!(s.open_depth(), 0);
        assert_eq!(s.matching_bracket(1), Some((1, 8)));
        assert!(s.in_string_or_comment()); // ends inside the comment
    }

    #[test]
    fn operators_at_end() {
        assert!(scan("x |>").ends_with_operator());
        assert!(scan("x %>%").ends_with_operator());
        assert!(scan("ggplot() +").ends_with_operator());
        assert!(!scan("f(a,").ends_with_operator());
        assert!(!scan("x").ends_with_operator());
    }

    #[test]
    fn double_bracket_matches() {
        let s = scan("x[[1]]");
        assert_eq!(s.matching_bracket(1), Some((1, 4)));
    }
}
