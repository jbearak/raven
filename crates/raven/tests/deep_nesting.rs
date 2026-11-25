//! Deeply nested expressions through the real binary (issue #882).
//!
//! R parses an operator chain as a left-nested tree, so a 2000-term sum is
//! 2000 levels deep. `raven check`, `raven graph`, `raven parse`, and the
//! language server used to abort with a stack overflow on such input. They now
//! run on the large stacks set up by `raven::analysis_stack`.
//!
//! Everything here runs `raven` as a subprocess: only the binary sets those
//! stacks up, and a test thread's 2 MiB would overflow on the same input.
//!
//! Deep `raven parse` output and deep language-server responses are checked as
//! text. `serde_json` refuses to decode past 128 levels, and a decoded value
//! would recurse again when dropped.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Output, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// `fit <- lm(y ~ term0 + ... , data = d)`: the generated-model-formula shape.
fn formula(terms: usize) -> String {
    format!("fit <- lm(y ~ {}, data = d)\n", sum(terms))
}

/// `z <- term0 + term1 + ...`: a tree as deep as it has terms.
fn chain(terms: usize) -> String {
    format!("z <- {}\n", sum(terms))
}

/// The terms are `term0`, `term1`, ... rather than the issue's `x0`, `x1`, ...
/// because `x11` is a base R function, which would not be reported undefined.
fn sum(terms: usize) -> String {
    let names: Vec<String> = (0..terms).map(|i| format!("term{i}")).collect();
    names.join(" + ")
}

fn parens(depth: usize) -> String {
    format!("p <- {}1{}\n", "(".repeat(depth), ")".repeat(depth))
}

/// A workspace of `files`, with the package library off so no test needs R.
fn workspace(files: &[(&str, String)]) -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join("raven.toml"),
        "[packages]\nenabled = false\n",
    )
    .unwrap();
    for (name, contents) in files {
        std::fs::write(tmp.path().join(name), contents).unwrap();
    }
    tmp
}

/// One-line files beside the deep one. With several files the workspace scan
/// spreads over the rayon pool, which is where the issue's five-file and
/// nine-file reproductions overflowed.
fn with_helpers(deep: (&str, String), helpers: usize) -> tempfile::TempDir {
    let mut files = vec![deep];
    let names: Vec<String> = (1..=helpers).map(|i| format!("f{i}.R")).collect();
    for (i, name) in names.iter().enumerate() {
        files.push((name, format!("v{} <- 1\n", i + 1)));
    }
    workspace(&files)
}

/// Run `raven` in `ws`. Panics unless it exits with `code`: a stack overflow
/// ends the process with a signal, so it has no exit code at all.
fn raven(ws: &Path, args: &[&str], code: i32) -> Output {
    let output = Command::new(env!("CARGO_BIN_EXE_raven"))
        .args(args)
        .current_dir(ws)
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(code),
        "raven {args:?} ended with {:?}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

/// `(message, line, start character)` of each diagnostic `raven check` prints.
fn check(ws: &Path, code: i32) -> Vec<(String, u64, u64)> {
    let output = raven(ws, &["check", "--format", "json", "."], code);
    let diagnostics: Value = serde_json::from_slice(&output.stdout).unwrap();
    diagnostics
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            let diagnostic = &entry["diagnostic"];
            assert_eq!(diagnostic["code"], "undefined-variable", "{entry}");
            let start = &diagnostic["range"]["start"];
            (
                diagnostic["message"].as_str().unwrap().to_string(),
                start["line"].as_u64().unwrap(),
                start["character"].as_u64().unwrap(),
            )
        })
        .collect()
}

/// Asserts `raven graph` reports a complete graph of `files` parsed files.
fn assert_graph(ws: &Path, files: usize) {
    let output = raven(ws, &["graph", "--format", "json"], 0);
    let graph: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(graph["complete"], true, "{graph}");
    let listed = graph["files"].as_array().unwrap();
    assert_eq!(listed.len(), files, "{graph}");
    for file in listed {
        assert_eq!(file["indexed"], true, "{file}");
        assert_eq!(file["syntax_errors"], false, "{file}");
    }
    assert_eq!(graph["edges"], json!([]), "{graph}");
}

/// The JSON lines `raven parse` prints for `files`, one per file.
fn parse(ws: &Path, files: &[&str]) -> Vec<String> {
    let mut args = vec!["parse"];
    args.extend(files);
    let output = raven(ws, &args, 0);
    let lines: Vec<String> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect();
    assert_eq!(lines.len(), files.len());
    for line in &lines {
        assert!(line.ends_with(r#""errors":[]}"#), "parse errors reported");
    }
    lines
}

fn count(haystack: &str, needle: &str) -> usize {
    haystack.matches(needle).count()
}

/// The issue's first reproduction: a 400-term model formula beside four
/// one-line files. The one diagnostic is the one a short formula gets.
#[test]
fn formula_with_400_terms_checks_graphs_and_parses() {
    let source = formula(400);
    let ws = with_helpers(("chain.R", source.clone()), 4);

    let d_column = source.rfind("d)").unwrap() as u64;
    assert_eq!(
        check(ws.path(), 1),
        [("d is not defined".to_string(), 0, d_column)]
    );
    assert_graph(ws.path(), 5);

    let lines = parse(ws.path(), &["chain.R", "f1.R", "f2.R", "f3.R", "f4.R"]);
    assert_eq!(count(&lines[0], r#""kind":"formula""#), 1);
    assert_eq!(count(&lines[0], r#""kind":"binary""#), 399);
    assert_eq!(count(&lines[0], r#""name":"term399""#), 1);
}

/// The issue's single-file reproduction: a 2000-term sum, which overflowed
/// even the 8 MiB main thread. Every term is reported, in source order, at its
/// own column, exactly as for a three-term sum.
#[test]
fn sum_of_2000_terms_checks_graphs_and_parses() {
    let source = chain(2000);
    let ws = workspace(&[("chain.R", source.clone())]);

    let mut expected = Vec::new();
    let mut column = "z <- ".len();
    for i in 0..2000 {
        let name = format!("term{i}");
        expected.push((format!("{name} is not defined"), 0, column as u64));
        column += name.len() + " + ".len();
    }
    assert_eq!(check(ws.path(), 1), expected);
    assert_graph(ws.path(), 1);

    let lines = parse(ws.path(), &["chain.R"]);
    assert_eq!(count(&lines[0], r#""kind":"binary""#), 1999);
    let whole_statement = format!(
        r#""range":{{"start":{{"line":0,"character":0}},"end":{{"line":0,"character":{}}}}}"#,
        source.trim_end().len()
    );
    assert!(lines[0].contains(&whole_statement));
}

/// The issue's third reproduction: 500 nested parentheses beside eight
/// one-line files. R itself stops parsing at 50, but an editor buffer can hold
/// anything.
#[test]
fn parentheses_nested_500_deep_check_graph_and_parse() {
    let ws = with_helpers(("deep.R", parens(500)), 8);

    assert_eq!(check(ws.path(), 0), []);
    assert_graph(ws.path(), 9);

    let lines = parse(ws.path(), &["deep.R"]);
    assert_eq!(count(&lines[0], r#""kind":"parenthesized""#), 500);
}

/// A long pipeline, the other shape users write: 2000 `|>` steps.
#[test]
fn pipeline_of_2000_steps_checks_graphs_and_parses() {
    let source = format!(
        "x <- 1\nf <- function(v) v\nr <- x{}\n",
        " |>\n  f()".repeat(2000)
    );
    let ws = workspace(&[("pipe.R", source)]);

    assert_eq!(check(ws.path(), 0), []);
    assert_graph(ws.path(), 1);
    let lines = parse(ws.path(), &["pipe.R"]);
    assert_eq!(count(&lines[0], r#""kind":"call""#), 2000);
}

/// The top-level members of a JSON object as `(key, raw value)` pairs, found
/// with a flat scan so a deeply nested value costs no recursion.
fn top_level_members(json: &str) -> Vec<(&str, &str)> {
    let bytes = json.as_bytes();
    let mut members = Vec::new();
    let mut depth = 0usize;
    let mut key = None;
    let mut value_start = None;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                let start = i + 1;
                i += 1;
                while bytes[i] != b'"' {
                    if bytes[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
                if depth == 1 && key.is_none() {
                    key = Some(&json[start..i]);
                }
            }
            b'{' | b'[' => depth += 1,
            b'}' | b']' => {
                depth -= 1;
                if depth == 0
                    && let (Some(key), Some(start)) = (key.take(), value_start.take())
                {
                    members.push((key, json[start..i].trim()));
                }
            }
            b':' if depth == 1 && value_start.is_none() => value_start = Some(i + 1),
            b',' if depth == 1 => {
                members.push((
                    key.take().unwrap(),
                    json[value_start.take().unwrap()..i].trim(),
                ));
            }
            _ => {}
        }
        i += 1;
    }
    members
}

fn member<'a>(message: &'a str, key: &str) -> Option<&'a str> {
    top_level_members(message)
        .into_iter()
        .find_map(|(name, value)| (name == key).then_some(value))
}

/// A minimal client for `raven --stdio`.
struct Server {
    child: Child,
    /// `None` once `shutdown` has closed it.
    stdin: Option<ChildStdin>,
    messages: Receiver<String>,
    next_id: u64,
}

impl Server {
    const TIMEOUT: Duration = Duration::from_secs(180);

    fn start(ws: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_raven"))
            .arg("--stdio")
            .current_dir(ws)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let (sender, messages) = channel();
        std::thread::spawn(move || {
            loop {
                let mut length = None;
                loop {
                    let mut line = String::new();
                    if stdout.read_line(&mut line).unwrap_or(0) == 0 {
                        return;
                    }
                    let line = line.trim();
                    if line.is_empty() {
                        break;
                    }
                    if let Some(value) = line.strip_prefix("Content-Length:") {
                        length = value.trim().parse::<usize>().ok();
                    }
                }
                let mut body = vec![0; length.expect("Content-Length header")];
                if stdout.read_exact(&mut body).is_err() {
                    return;
                }
                if sender.send(String::from_utf8(body).unwrap()).is_err() {
                    return;
                }
            }
        });
        let mut server = Self {
            child,
            stdin: Some(stdin),
            messages,
            next_id: 1,
        };
        let root = url::Url::from_directory_path(ws).unwrap();
        server.request(
            "initialize",
            json!({
                "processId": null,
                "rootUri": root,
                "capabilities": {
                    "textDocument": {
                        "documentSymbol": {"hierarchicalDocumentSymbolSupport": true}
                    }
                },
                "workspaceFolders": [{"uri": root, "name": "ws"}],
            }),
        );
        server.notify("initialized", json!({}));
        server
    }

    fn send(&mut self, message: Value) {
        let body = message.to_string();
        let stdin = self.stdin.as_mut().expect("server stdin is open");
        write!(stdin, "Content-Length: {}\r\n\r\n{body}", body.len()).unwrap();
        stdin.flush().unwrap();
    }

    fn notify(&mut self, method: &str, params: Value) {
        self.send(json!({"jsonrpc": "2.0", "method": method, "params": params}));
    }

    /// The next message accepted by `wanted`. Answers the server's own
    /// requests on the way: it handles one message at a time and waits for
    /// each reply. Panics if the server exits or stays silent.
    fn wait_for<T>(&mut self, what: &str, mut wanted: impl FnMut(&str) -> Option<T>) -> T {
        let deadline = Instant::now() + Self::TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let message = match self.messages.recv_timeout(left) {
                Ok(message) => message,
                Err(RecvTimeoutError::Timeout) => panic!("timed out waiting for {what}"),
                // `try_wait`: the output can close while the server lives.
                Err(RecvTimeoutError::Disconnected) => panic!(
                    "server output closed while waiting for {what}: {:?}",
                    self.child.try_wait()
                ),
            };
            if member(&message, "method").is_some()
                && let Some(id) = member(&message, "id")
            {
                let id: Value = serde_json::from_str(id).unwrap();
                self.send(json!({"jsonrpc": "2.0", "id": id, "result": null}));
                continue;
            }
            if let Some(found) = wanted(&message) {
                return found;
            }
        }
    }

    /// Send a request and return the raw text of its result. Panics on an
    /// error response.
    fn request(&mut self, method: &str, params: Value) -> String {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        self.wait_for(method, |message| {
            if member(message, "method").is_some()
                || member(message, "id") != Some(id.to_string().as_str())
            {
                return None;
            }
            assert!(
                member(message, "error").is_none(),
                "{method} failed: {}",
                &message[..message.len().min(400)]
            );
            Some(member(message, "result").unwrap_or("null").to_string())
        })
    }

    /// The messages of the next diagnostics published for `uri` that satisfy
    /// `accept`. Earlier publications (an older version, a first pass) are
    /// skipped.
    fn diagnostics(&mut self, uri: &url::Url, accept: impl Fn(&[String]) -> bool) -> Vec<String> {
        self.wait_for("diagnostics", |message| {
            if member(message, "method") != Some(r#""textDocument/publishDiagnostics""#) {
                return None;
            }
            // Diagnostics are flat, so decoding them is safe at any depth.
            let params: Value = serde_json::from_str(member(message, "params")?).unwrap();
            if params["uri"] != uri.as_str() {
                return None;
            }
            let messages: Vec<String> = params["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .map(|diagnostic| diagnostic["message"].as_str().unwrap().to_string())
                .collect();
            accept(&messages).then_some(messages)
        })
    }

    fn shutdown(mut self) {
        // `shutdown` takes no params.
        let id = self.next_id;
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": "shutdown"}));
        self.wait_for("shutdown", |message| {
            (member(message, "id") == Some(id.to_string().as_str())).then_some(())
        });
        self.send(json!({"jsonrpc": "2.0", "method": "exit"}));
        self.stdin = None;
        let deadline = Instant::now() + Self::TIMEOUT;
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "server did not exit");
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(status.success(), "server ended with {status:?}");
    }
}

/// A failed assertion must not leave the server running.
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Open `name` in the server, wait for the diagnostics `expected` describes,
/// and exercise the requests an editor sends for a visible file. `probe` is
/// text on line 0 to aim the position-based requests at, and `ancestors` the
/// least nesting a selection range from there must report.
fn open_and_query(
    server: &mut Server,
    ws: &Path,
    name: &str,
    source: &str,
    expected: &[String],
    probe: &str,
    ancestors: usize,
) {
    // A short function after the deep statement, so folding ranges, symbols,
    // and semantic tokens each have something to return.
    let text = format!("{source}helper <- function(a) {{\n  a + 1\n}}\nhelper(1)\n");
    let uri = url::Url::from_file_path(ws.join(name)).unwrap();
    let document = json!({"uri": uri});
    server.notify(
        "textDocument/didOpen",
        json!({"textDocument": {"uri": uri, "languageId": "r", "version": 1, "text": text}}),
    );
    let published = server.diagnostics(&uri, |messages| messages.len() == expected.len());
    assert_eq!(published, expected, "{name}");

    let position = json!({"line": 0, "character": source.find(probe).unwrap()});
    server.request(
        "textDocument/hover",
        json!({"textDocument": document, "position": position}),
    );
    let symbols = server.request(
        "textDocument/documentSymbol",
        json!({"textDocument": document}),
    );
    assert!(symbols.contains(r#""name":"helper""#), "{name}: {symbols}");
    let folds = server.request(
        "textDocument/foldingRange",
        json!({"textDocument": document}),
    );
    assert!(folds.contains("startLine"), "{name}: {folds}");
    let tokens = server.request(
        "textDocument/semanticTokens/full",
        json!({"textDocument": document}),
    );
    assert!(tokens.contains(r#""data":["#), "{name}: {tokens}");
    let selection = server.request(
        "textDocument/selectionRange",
        json!({"textDocument": document, "positions": [position]}),
    );
    assert!(
        count(&selection, r#""parent""#) >= ancestors,
        "{name}: selection range has {} ancestors",
        count(&selection, r#""parent""#)
    );
    server.request(
        "textDocument/onTypeFormatting",
        json!({
            "textDocument": document,
            "position": {"line": 1, "character": 0},
            "ch": "\n",
            "options": {"tabSize": 2, "insertSpaces": true},
        }),
    );

    // An edit is analysed too: the new undefined name is reported on top of
    // what was there.
    server.notify(
        "textDocument/didChange",
        json!({
            "textDocument": {"uri": uri, "version": 2},
            "contentChanges": [{"text": format!("{text}later <- not_defined_marker\n")}],
        }),
    );
    let marker = "not_defined_marker is not defined".to_string();
    let after_edit = server.diagnostics(&uri, |messages| messages.contains(&marker));
    assert_eq!(after_edit.len(), expected.len() + 1, "{name}");
}

/// The language server analyses the same three files, answers the requests an
/// editor sends for an open file, and shuts down cleanly. Before the fix it
/// died on the first `didOpen`: its worker threads had 2 MiB stacks, so a
/// 400-term formula was already too deep.
#[test]
fn language_server_survives_deep_files() {
    let files = [
        ("formula.R", formula(400)),
        ("chain.R", chain(2000)),
        ("parens.R", parens(500)),
    ];
    // The files are on disk too, so the startup workspace scan meets them
    // before any is opened.
    let ws = workspace(&files);
    let mut server = Server::start(ws.path());

    let undefined_terms: Vec<String> = (0..2000)
        .map(|i| format!("term{i} is not defined"))
        .collect();
    open_and_query(
        &mut server,
        ws.path(),
        "formula.R",
        &files[0].1,
        &["d is not defined".to_string()],
        "term0",
        399,
    );
    open_and_query(
        &mut server,
        ws.path(),
        "chain.R",
        &files[1].1,
        &undefined_terms,
        "term0",
        1999,
    );
    open_and_query(
        &mut server,
        ws.path(),
        "parens.R",
        &files[2].1,
        &[],
        "1)",
        500,
    );
    server.shutdown();
}
