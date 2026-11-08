//! What R's lexer makes of a literal or a quoted name: a number's type and
//! value, a string's decoded value, a backticked name's decoded name.
//!
//! The rules follow R's own lexer (`NumericValue` and `StringValue` in
//! `src/main/gram.y`), so the type a literal reports is the one R gives it,
//! not the one its spelling suggests (`1.0L` is an integer, `1.5L` a double).
//!
//! Where R rejects a literal, decoding returns a [`LiteralError`] carrying R's
//! message and the byte range of the offending escape; where R accepts a
//! literal but warns, [`NumberClass`] names the case. Both are for the
//! document's parse-errors list; the tree itself only omits a value R never
//! produces.

use std::ops::Range;

/// What R's lexer makes of a number literal. Each variant names one of R's
/// cases, including the two where R warns, so the parse-errors list can
/// report R's warning for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NumberClass {
    /// No suffix: `1`, `1e3`, `0x10`, `0x1p3`.
    Double,
    /// An `L` literal R keeps as an integer: `1L`, `1e3L`, `0x10L`.
    Integer,
    /// `1.0L`: an integer, but R warns "integer literal 1.0L contains
    /// unnecessary decimal point".
    IntegerWithDecimal,
    /// `1.5L`, `.5L`: not a whole number, written with a `.` and no exponent.
    /// R uses the double and warns "integer literal 1.5L contains decimal;
    /// using numeric value".
    DoubleFromDecimalL,
    /// `1e-3L`, `100000000000L`: not an integer R can hold. R uses the double
    /// and warns "non-integer value 1e-3L qualified with L; using numeric
    /// value".
    DoubleFromNonIntegerL,
    /// An `i` literal: `1i`, `0x10i`.
    Complex,
}

impl NumberClass {
    /// The literal's type, as R's `typeof()` names it.
    pub(crate) fn r_type(self) -> &'static str {
        match self {
            NumberClass::Double
            | NumberClass::DoubleFromDecimalL
            | NumberClass::DoubleFromNonIntegerL => "double",
            NumberClass::Integer | NumberClass::IntegerWithDecimal => "integer",
            NumberClass::Complex => "complex",
        }
    }
}

/// A number literal as R reads it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Number {
    pub(crate) class: NumberClass,
    /// The value (a complex literal's imaginary part). `None` when the text
    /// isn't a number R reads (a parse error, such as `1e`). Overflow is
    /// `Some(inf)`, as in R.
    pub(crate) value: Option<f64>,
}

/// Classify a number token as written (`1`, `1e3L`, `0x1p3`, `2i`).
pub(crate) fn number(text: &str) -> Number {
    if let Some(body) = text.strip_suffix('i') {
        return Number {
            class: NumberClass::Complex,
            value: number_value(body),
        };
    }
    let Some(body) = text.strip_suffix('L') else {
        return Number {
            class: NumberClass::Double,
            value: number_value(text),
        };
    };
    let value = number_value(body);
    let hex = is_hex(body);
    // R's "decimal" warnings are for a `.` without an exponent; a hex
    // literal's exponent is its `p`, since `e` is a hex digit there.
    let has_exponent = if hex {
        body.contains(['p', 'P'])
    } else {
        body.contains(['e', 'E'])
    };
    let decimal = body.contains('.') && !has_exponent;
    // R keeps the integer when `(double)(int)a == a`: a whole number an
    // `int` holds. (The literal has no sign, so only the upper bound bites.)
    let integer = value.is_some_and(|a| a.fract() == 0.0 && a <= f64::from(i32::MAX));
    let class = match (integer, decimal) {
        (true, false) => NumberClass::Integer,
        (true, true) => NumberClass::IntegerWithDecimal,
        (false, true) => NumberClass::DoubleFromDecimalL,
        (false, false) => NumberClass::DoubleFromNonIntegerL,
    };
    Number { class, value }
}

fn is_hex(text: &str) -> bool {
    text.starts_with("0x") || text.starts_with("0X")
}

/// The value of an unsuffixed number: decimal, or hex with an optional
/// fraction and binary exponent.
fn number_value(text: &str) -> Option<f64> {
    if is_hex(text) {
        hex_value(&text[2..])
    } else {
        text.parse().ok()
    }
}

/// `1f`, `1.8p1`, `.8`, `ffp-2`: hex digits with an optional `.` and an
/// optional `p` exponent (the part after `0x`).
fn hex_value(text: &str) -> Option<f64> {
    let (digits, exponent) = match text.find(['p', 'P']) {
        Some(at) => (&text[..at], exponent(&text[at + 1..])?),
        None => (text, 0),
    };
    let mut mantissa: u128 = 0;
    // Binary exponent adjustment: -4 per fraction digit, +4 per digit
    // dropped for not fitting the mantissa.
    let mut shift: i64 = i64::from(exponent);
    let mut seen_dot = false;
    for ch in digits.chars() {
        if ch == '.' {
            if seen_dot {
                return None;
            }
            seen_dot = true;
            continue;
        }
        let digit = u128::from(ch.to_digit(16)?);
        if mantissa >> 120 == 0 {
            mantissa = mantissa * 16 + digit;
            if seen_dot {
                shift -= 4;
            }
        } else if !seen_dot {
            shift += 4;
        }
    }
    Some(scale_by_power_of_two(mantissa as f64, shift))
}

/// A binary exponent (`3`, `-2`, `+10`). One past any double's range
/// saturates, as R reads it: `0x1p99999999999` is `Inf`, `0x1p-99999999999`
/// is `0`.
fn exponent(text: &str) -> Option<i32> {
    let digits = text.trim_start_matches(['+', '-']);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let negative = text.starts_with('-');
    Some(match text.parse::<i32>() {
        Ok(exponent) => exponent,
        Err(_) if negative => -100_000,
        Err(_) => 100_000,
    })
}

/// `value * 2^shift`, in steps that can't overflow or underflow early.
fn scale_by_power_of_two(mut value: f64, mut shift: i64) -> f64 {
    while shift != 0 && value != 0.0 && value.is_finite() {
        let step = shift.clamp(-1000, 1000);
        value *= 2f64.powi(step as i32);
        shift -= step;
    }
    value
}

/// A literal or name R's lexer rejects, with R's message (without its
/// location suffix) and the byte range, within the token, of what it
/// rejects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LiteralError {
    pub(crate) range: Range<usize>,
    pub(crate) message: String,
}

/// What decoding a quoted string or name gives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Decoded {
    /// The value R reads, as Unicode text.
    Text(String),
    /// R reads it, but the result isn't Unicode text a JSON string can hold:
    /// byte escapes that aren't valid UTF-8 (`"\xe9"`) or a lone surrogate
    /// (`"\ud800"`, which R reads with a warning).
    NotUnicode,
    /// R rejects it.
    Error(LiteralError),
}

impl Decoded {
    pub(crate) fn text(self) -> Option<String> {
        match self {
            Decoded::Text(text) => Some(text),
            Decoded::NotUnicode | Decoded::Error(_) => None,
        }
    }
}

/// A string literal's delimiters as written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StringForm {
    /// `"` or `'`.
    pub(crate) quote: char,
    /// A raw string (`r"(...)"`).
    pub(crate) raw: bool,
    /// Everything before the content: `"`, or `r"---(` for a raw string.
    pub(crate) open: String,
    /// Everything after it: `"`, or `)---"`.
    pub(crate) close: String,
}

/// A string token's delimiters and its decoded value. A raw string's value is
/// its content as written; an ordinary string's has R's escapes applied.
/// Either way a line ending inside the string reads as `\n`, as R reads the
/// file line by line.
pub(crate) fn string(text: &str) -> (StringForm, Decoded) {
    let (form, decoded, _) = string_with_warnings(text);
    (form, decoded)
}

/// [`string`], with the warnings R gives while reading it: one per unpaired
/// surrogate escape (`"\u{d800}"`), with R's message and the escape's range
/// within the token.
pub(crate) fn string_with_warnings(text: &str) -> (StringForm, Decoded, Vec<LiteralError>) {
    let mut warnings = Vec::new();
    let (form, decoded) = string_into(text, &mut warnings);
    (form, decoded, warnings)
}

fn string_into(text: &str, warnings: &mut Vec<LiteralError>) -> (StringForm, Decoded) {
    let first = text.chars().next().unwrap_or('"');
    if first == 'r' || first == 'R' {
        let quote = text[1..].chars().next().unwrap_or('"');
        let dashes = text[2..].bytes().take_while(|&b| b == b'-').count();
        let open_len = 2 + dashes + 1;
        let close_len = open_len - 1;
        let (open, close) = if text.len() >= open_len + close_len {
            (&text[..open_len], &text[text.len() - close_len..text.len()])
        } else {
            (text, "")
        };
        let content = &text[open.len()..text.len() - close.len()];
        let form = StringForm {
            quote,
            raw: true,
            open: open.to_string(),
            close: close.to_string(),
        };
        return (form, Decoded::Text(normalize_line_endings(content)));
    }
    let content = if text.len() >= 2 {
        &text[1..text.len() - 1]
    } else {
        ""
    };
    let form = StringForm {
        quote: first,
        raw: false,
        open: first.to_string(),
        close: first.to_string(),
    };
    (form, decode_escapes(content, 1, false, warnings))
}

/// A backticked name's name: the text between the backticks, with escapes
/// decoded as R decodes them there (as in a string, except that `\u` and
/// `\U` are errors). An empty name is an error.
pub(crate) fn backtick_name(text: &str) -> Decoded {
    let content = text
        .strip_prefix('`')
        .and_then(|rest| rest.strip_suffix('`'))
        .unwrap_or(text);
    if content.is_empty() {
        return Decoded::Error(LiteralError {
            range: 0..text.len(),
            message: "attempt to use zero-length variable name".into(),
        });
    }
    // `\u` and `\U` are errors in backticks, so there are no surrogates to
    // warn about.
    decode_escapes(content, 1, true, &mut Vec::new())
}

fn normalize_line_endings(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Decode R's escapes in `content`, which starts at byte `base` of its token.
/// `for_symbol` is R's mode for backticked names. R's warnings (unpaired
/// surrogates) go to `warnings`.
///
/// Like R, a high-surrogate escape directly followed by a low-surrogate
/// escape (`\u{d83d}\u{de00}`, in either `\u` or `\U` form) is one
/// character; any other surrogate is unpaired, which R reads with a warning
/// into a string that isn't valid UTF-8.
fn decode_escapes(
    content: &str,
    base: usize,
    for_symbol: bool,
    warnings: &mut Vec<LiteralError>,
) -> Decoded {
    let bytes = content.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut unicode_escape = false;
    let mut byte_escape = false;
    let mut surrogate = false;
    // A high-surrogate escape waiting for its low half: its value and range.
    let mut pending_high: Option<(u32, usize, usize)> = None;
    let mut unpaired = |value: u32, start: usize, end: usize, surrogate: &mut bool| {
        *surrogate = true;
        warnings.push(LiteralError {
            range: base + start..base + end,
            message: format!("unpaired surrogate Unicode point {value:x}"),
        });
    };
    let mut i = 0;
    let error = |start: usize, end: usize, message: String| {
        Decoded::Error(LiteralError {
            range: base + start..base + end,
            message,
        })
    };
    while i < bytes.len() {
        let b = bytes[i];
        let unicode_escape_next = b == b'\\' && matches!(bytes.get(i + 1), Some(b'u' | b'U'));
        if !unicode_escape_next && let Some((value, start, end)) = pending_high.take() {
            unpaired(value, start, end, &mut surrogate);
        }
        if b == b'\r' {
            // `\r\n` or a lone `\r` ends a line; R reads it as `\n`.
            out.push(b'\n');
            i += if bytes.get(i + 1) == Some(&b'\n') {
                2
            } else {
                1
            };
            continue;
        }
        if b != b'\\' {
            out.push(b);
            i += 1;
            continue;
        }
        let start = i;
        i += 1;
        let Some(&c) = bytes.get(i) else {
            // A trailing lone backslash can't close a token; nothing to read.
            return error(start, i, "unexpected end of input".into());
        };
        i += 1;
        match c {
            b'0'..=b'7' => {
                let mut value = u32::from(c - b'0');
                let mut digits = 1;
                while digits < 3 && matches!(bytes.get(i), Some(b'0'..=b'7')) {
                    value = value * 8 + u32::from(bytes[i] - b'0');
                    i += 1;
                    digits += 1;
                }
                if value > 0xFF {
                    return error(
                        start,
                        i,
                        format!(
                            "{} exceeds maximum allowed octal value \\377",
                            &content[start..i]
                        ),
                    );
                }
                if value == 0 {
                    return error(start, i, "nul character not allowed".into());
                }
                out.push(value as u8);
                byte_escape = true;
            }
            b'x' => {
                let (value, digits) = hex_digits(bytes, &mut i, 2);
                if digits == 0 {
                    return error(
                        start,
                        i,
                        "'\\x' used without hex digits in character string".into(),
                    );
                }
                if value == 0 {
                    return error(start, i, "nul character not allowed".into());
                }
                out.push(value as u8);
                byte_escape = true;
            }
            b'u' | b'U' => {
                let (letter, max, braced_form) = if c == b'u' {
                    ("u", 4, "\\u{xxxx}")
                } else {
                    ("U", 8, "\\U{xxxxxxxx}")
                };
                if for_symbol {
                    let digits = if c == b'u' { "xxxx" } else { "xxxxxxxx" };
                    return error(
                        start,
                        i,
                        format!("\\{letter}{digits} sequences not supported inside backticks"),
                    );
                }
                let braced = bytes.get(i) == Some(&b'{');
                if braced {
                    i += 1;
                }
                let (value, digits) = hex_digits(bytes, &mut i, max);
                if digits == 0 {
                    return error(
                        start,
                        i,
                        format!("'\\{letter}' used without hex digits in character string"),
                    );
                }
                if braced {
                    if bytes.get(i) != Some(&b'}') {
                        return error(start, i, format!("invalid {braced_form} sequence"));
                    }
                    i += 1;
                }
                if c == b'U' && value > 0x10FFFF {
                    return error(start, i, format!("invalid {braced_form} value {value:x}"));
                }
                if value == 0 {
                    return error(start, i, "nul character not allowed".into());
                }
                let mut value = value;
                if (0xDC00..=0xDFFF).contains(&value) {
                    match pending_high.take() {
                        Some((high, _, end)) if end == start => {
                            value = 0x10000 + ((high - 0xD800) << 10) + (value - 0xDC00);
                        }
                        other => {
                            if let Some((high, high_start, high_end)) = other {
                                unpaired(high, high_start, high_end, &mut surrogate);
                            }
                            unpaired(value, start, i, &mut surrogate);
                        }
                    }
                } else {
                    if let Some((high, high_start, high_end)) = pending_high.take() {
                        unpaired(high, high_start, high_end, &mut surrogate);
                    }
                    if (0xD800..=0xDBFF).contains(&value) {
                        pending_high = Some((value, start, i));
                    }
                }
                if let Some(ch) = char::from_u32(value) {
                    let mut buffer = [0; 4];
                    out.extend_from_slice(ch.encode_utf8(&mut buffer).as_bytes());
                }
                unicode_escape = true;
            }
            b'a' => out.push(0x07),
            b'b' => out.push(0x08),
            b'f' => out.push(0x0C),
            b'n' => out.push(b'\n'),
            b'r' => out.push(b'\r'),
            b't' => out.push(b'\t'),
            b'v' => out.push(0x0B),
            b'\\' | b'"' | b'\'' | b'`' | b' ' | b'\n' => out.push(c),
            b'\r' => {
                // `\` before a line ending escapes it: a newline.
                out.push(b'\n');
                if bytes.get(i) == Some(&b'\n') {
                    i += 1;
                }
            }
            _ => {
                let ch = content[start + 1..].chars().next().unwrap_or('?');
                let end = start + 1 + ch.len_utf8();
                return error(
                    start,
                    end,
                    format!("'\\{ch}' is an unrecognized escape in character string"),
                );
            }
        }
    }
    if let Some((value, start, end)) = pending_high.take() {
        unpaired(value, start, end, &mut surrogate);
    }
    if unicode_escape && byte_escape {
        return error(
            0,
            content.len(),
            "mixing Unicode and octal/hex escapes in a string is not allowed".into(),
        );
    }
    if surrogate {
        return Decoded::NotUnicode;
    }
    match String::from_utf8(out) {
        Ok(text) => Decoded::Text(text),
        Err(_) => Decoded::NotUnicode,
    }
}

/// Read up to `max` hex digits at `bytes[*i..]`; returns the value and how
/// many digits were read.
fn hex_digits(bytes: &[u8], i: &mut usize, max: usize) -> (u32, usize) {
    let mut value: u32 = 0;
    let mut digits = 0;
    while digits < max {
        let Some(digit) = bytes.get(*i).and_then(|&b| char::from(b).to_digit(16)) else {
            break;
        };
        value = value * 16 + digit;
        *i += 1;
        digits += 1;
    }
    (value, digits)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn class_and_value(text: &str) -> (&'static str, Option<f64>) {
        let n = number(text);
        (n.class.r_type(), n.value)
    }

    /// Every case checked against R 4.6's parser.
    #[test]
    fn number_types_and_values_match_r() {
        let cases: &[(&str, NumberClass, Option<f64>)] = &[
            ("1", NumberClass::Double, Some(1.0)),
            ("1e3", NumberClass::Double, Some(1000.0)),
            ("1L", NumberClass::Integer, Some(1.0)),
            ("1e3L", NumberClass::Integer, Some(1000.0)),
            ("0x10", NumberClass::Double, Some(16.0)),
            ("0x10L", NumberClass::Integer, Some(16.0)),
            ("0xAL", NumberClass::Integer, Some(10.0)),
            ("0x1p3", NumberClass::Double, Some(8.0)),
            ("0x1p3L", NumberClass::Integer, Some(8.0)),
            ("0x1.8p1", NumberClass::Double, Some(3.0)),
            ("0x1.2", NumberClass::Double, Some(1.125)),
            ("0x.p1", NumberClass::Double, Some(0.0)),
            ("1.0L", NumberClass::IntegerWithDecimal, Some(1.0)),
            ("1.L", NumberClass::IntegerWithDecimal, Some(1.0)),
            ("1.5L", NumberClass::DoubleFromDecimalL, Some(1.5)),
            (".5L", NumberClass::DoubleFromDecimalL, Some(0.5)),
            ("1e-3L", NumberClass::DoubleFromNonIntegerL, Some(0.001)),
            (
                "100000000000L",
                NumberClass::DoubleFromNonIntegerL,
                Some(1e11),
            ),
            ("2147483647L", NumberClass::Integer, Some(2147483647.0)),
            (
                "2147483648L",
                NumberClass::DoubleFromNonIntegerL,
                Some(2147483648.0),
            ),
            ("1i", NumberClass::Complex, Some(1.0)),
            (".1i", NumberClass::Complex, Some(0.1)),
            ("0x10i", NumberClass::Complex, Some(16.0)),
            ("1e999", NumberClass::Double, Some(f64::INFINITY)),
            (
                "1e999L",
                NumberClass::DoubleFromNonIntegerL,
                Some(f64::INFINITY),
            ),
            ("1e", NumberClass::Double, None),
        ];
        for &(text, class, value) in cases {
            assert_eq!(number(text), Number { class, value }, "{text}");
        }
        assert_eq!(class_and_value("1.0L").0, "integer");
        assert_eq!(class_and_value("1.5L").0, "double");
        assert_eq!(class_and_value("1i").0, "complex");
        // Many hex digits don't overflow the mantissa.
        assert_eq!(
            class_and_value("0x10000000000000000000000000000000000").1,
            Some(2f64.powi(136))
        );
        assert_eq!(class_and_value("0x1p-1074").1, Some(f64::from_bits(1)));
        assert_eq!(class_and_value("0x1p99999").1, Some(f64::INFINITY));
        // Exponents beyond `i32` saturate, as in R.
        assert_eq!(class_and_value("0x1p2147483648").1, Some(f64::INFINITY));
        assert_eq!(class_and_value("0x1p-2147483649").1, Some(0.0));
    }

    fn decoded(text: &str) -> Decoded {
        string(text).1
    }

    fn error_message(decoded: Decoded) -> String {
        match decoded {
            Decoded::Error(e) => e.message,
            other => panic!("expected an error, got {other:?}"),
        }
    }

    /// Values and messages checked against R 4.6's parser.
    #[test]
    fn string_escapes_decode_as_r_decodes_them() {
        let ok = |text: &str, value: &str| {
            assert_eq!(decoded(text), Decoded::Text(value.into()), "{text}");
        };
        ok(r#""\x41""#, "A");
        ok(r#""\101""#, "A");
        ok(r#""\1234""#, "S4");
        ok(r#""\x4g""#, "\u{4}g");
        ok(r#""\u{00e9}""#, "é");
        ok(r#""\u00e9""#, "é");
        ok(r#""\u12345""#, "\u{1234}5");
        ok(r#""\U{1F600}""#, "😀");
        ok(r#""\U0001F600""#, "😀");
        ok(r#""\a\b\f\v\t\r\n""#, "\u{7}\u{8}\u{c}\u{b}\t\r\n");
        ok(r#""\\\"\'\`\ ""#, "\\\"'` ");
        ok(r#"'it\'s'"#, "it's");
        ok(r#""\xc3\xa9""#, "é");
        ok("\"a\\\nb\"", "a\nb");
        ok("\"a\\\r\nb\"", "a\nb");
        ok("\"a\r\nb\rc\"", "a\nb\nc");
        ok(r#""""#, "");

        assert_eq!(decoded(r#""\xe9""#), Decoded::NotUnicode);
        assert_eq!(decoded(r#""\ud800""#), Decoded::NotUnicode);
        assert_eq!(decoded(r#""\U{D800}""#), Decoded::NotUnicode);

        let err = |text: &str, message: &str| {
            assert_eq!(error_message(decoded(text)), message, "{text}");
        };
        err(
            r#""\q""#,
            r"'\q' is an unrecognized escape in character string",
        );
        err(
            r#""\8""#,
            r"'\8' is an unrecognized escape in character string",
        );
        err(
            r#""\😀""#,
            r"'\😀' is an unrecognized escape in character string",
        );
        err(
            r#""\777""#,
            r"\777 exceeds maximum allowed octal value \377",
        );
        err(r#""\0""#, "nul character not allowed");
        err(r#""\x0""#, "nul character not allowed");
        err(
            r#""\x""#,
            r"'\x' used without hex digits in character string",
        );
        err(
            r#""\u""#,
            r"'\u' used without hex digits in character string",
        );
        err(
            r#""\uZ""#,
            r"'\u' used without hex digits in character string",
        );
        err(
            r#""\U""#,
            r"'\U' used without hex digits in character string",
        );
        err(r#""\u{12""#, r"invalid \u{xxxx} sequence");
        err(r#""\U{12""#, r"invalid \U{xxxxxxxx} sequence");
        err(r#""\U{110000}""#, r"invalid \U{xxxxxxxx} value 110000");
        err(r#""\U{FFFFFFFF}""#, r"invalid \U{xxxxxxxx} value ffffffff");
        err(
            r#""\u00e9\x41""#,
            "mixing Unicode and octal/hex escapes in a string is not allowed",
        );

        // The error's range is the escape, within the token.
        match decoded(r#""ab\qc""#) {
            Decoded::Error(e) => assert_eq!(e.range, 3..5),
            other => panic!("{other:?}"),
        }
    }

    /// R joins a high-surrogate escape and the low-surrogate escape right
    /// after it into one character, and warns about any other surrogate.
    /// Checked against R 4.6's parser.
    #[test]
    fn surrogate_escapes_pair_as_r_pairs_them() {
        let read = |text: &str| string_with_warnings(text);
        let (_, value, warnings) = read(r#""\u{d83d}\u{de00}""#);
        assert_eq!((value, warnings), (Decoded::Text("😀".into()), vec![]));
        let (_, value, warnings) = read(r#""\u{d83d}\U{de00}x""#);
        assert_eq!((value, warnings), (Decoded::Text("😀x".into()), vec![]));

        let unpaired = |range: Range<usize>, point: &str| LiteralError {
            range,
            message: format!("unpaired surrogate Unicode point {point}"),
        };
        let (_, value, warnings) = read(r#""\u{d800}""#);
        assert_eq!(value, Decoded::NotUnicode);
        assert_eq!(warnings, [unpaired(1..9, "d800")]);
        let (_, value, warnings) = read(r#""\u{d83d}x""#);
        assert_eq!(value, Decoded::NotUnicode);
        assert_eq!(warnings, [unpaired(1..9, "d83d")]);
        // Low before high: neither pairs, warned in order.
        let (_, _, warnings) = read(r#""\u{de00}\u{d83d}""#);
        assert_eq!(warnings, [unpaired(1..9, "de00"), unpaired(9..17, "d83d")]);
        // Two highs then a low: the second high pairs.
        let (_, value, warnings) = read(r#""\u{d83d}\u{d83d}\u{de00}""#);
        assert_eq!(value, Decoded::NotUnicode);
        assert_eq!(warnings, [unpaired(1..9, "d83d")]);
        // `string` itself drops the warnings.
        assert_eq!(string(r#""\u{d800}""#).1, Decoded::NotUnicode);
    }

    #[test]
    fn raw_strings_keep_their_content_and_delimiters() {
        let (form, value) = string(r#"r"(a\nb)""#);
        assert_eq!(value, Decoded::Text(r"a\nb".into()));
        assert_eq!(
            form,
            StringForm {
                quote: '"',
                raw: true,
                open: "r\"(".into(),
                close: ")\"".into()
            }
        );
        let (form, value) = string(r#"R"---[x]---""#);
        assert_eq!(value, Decoded::Text("x".into()));
        assert_eq!(
            (form.open.as_str(), form.close.as_str()),
            ("R\"---[", "]---\"")
        );
        let (form, value) = string("r'{a)\"b}'");
        assert_eq!(value, Decoded::Text("a)\"b".into()));
        assert_eq!(form.quote, '\'');
        let (_, value) = string("r\"(a\r\nb)\"");
        assert_eq!(value, Decoded::Text("a\nb".into()));
        let (form, _) = string("'x'");
        assert_eq!(
            form,
            StringForm {
                quote: '\'',
                raw: false,
                open: "'".into(),
                close: "'".into()
            }
        );
    }

    #[test]
    fn backticked_names_decode_as_r_decodes_them() {
        assert_eq!(backtick_name("`größe`"), Decoded::Text("größe".into()));
        assert_eq!(backtick_name(r"`a\nb`"), Decoded::Text("a\nb".into()));
        assert_eq!(backtick_name(r"`a\`b`"), Decoded::Text("a`b".into()));
        assert_eq!(backtick_name(r"`\x41`"), Decoded::Text("A".into()));
        assert_eq!(
            error_message(backtick_name(r"`\u00e9`")),
            r"\uxxxx sequences not supported inside backticks"
        );
        assert_eq!(
            error_message(backtick_name(r"`\U00e9`")),
            r"\Uxxxxxxxx sequences not supported inside backticks"
        );
        assert_eq!(
            error_message(backtick_name(r"`a\qb`")),
            r"'\q' is an unrecognized escape in character string"
        );
        assert_eq!(
            error_message(backtick_name("``")),
            "attempt to use zero-length variable name"
        );
    }
}
