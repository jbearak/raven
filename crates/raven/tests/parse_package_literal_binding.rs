//! End-to-end check that `raven parse` resolves a call in a package's `R/`
//! file past that file's own non-function binding of the name, as R's
//! function lookup does. The package's namespace is the file's global
//! environment, so the name-only package contribution must not stand in for
//! the binding the lookup just passed over.

use std::path::Path;
use std::process::Command;

use serde_json::{Value, json};

fn write(root: &Path, relative: &str, contents: &str) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

/// Every `call` node in a document, depth first.
fn calls(value: &Value) -> Vec<&Value> {
    fn walk<'v>(value: &'v Value, out: &mut Vec<&'v Value>) {
        match value {
            Value::Object(map) => {
                if map.get("kind").and_then(Value::as_str) == Some("call") {
                    out.push(value);
                }
                map.values().for_each(|child| walk(child, out));
            }
            Value::Array(items) => items.iter().for_each(|item| walk(item, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(value, &mut out);
    out
}

fn resolution_of<'d>(doc: &'d Value, function: &str, line: u64) -> &'d Value {
    let found: Vec<&Value> = calls(doc)
        .into_iter()
        .filter(|call| {
            call["function"]["name"] == function && call["range"]["start"]["line"] == line
        })
        .collect();
    assert_eq!(found.len(), 1, "one `{function}()` call on line {line}");
    &found[0]["resolution"]
}

#[test]
fn a_package_call_passes_over_the_files_own_literal_binding() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("ws");
    // No R subprocess and no names database: base R's names are built in.
    write(
        &ws,
        "raven.toml",
        "[packages]\nenabled = true\nrPath = \"/nonexistent/raven-test/R\"\n",
    );
    write(&ws, "DESCRIPTION", "Package: ravenTest\nVersion: 0.1\n");
    write(&ws, "NAMESPACE", "export(fn)\n");
    write(
        &ws,
        "R/fn.R",
        concat!(
            "mean <- 7\n",
            "fn <- function(x) mean(x)\n",
            "mean(1:3)\n",
            "foo <- 1\n",
            "g <- function() foo()\n",
            "h <- function() other()\n",
            "helper <- function(x) x\n",
            "k <- function() helper(1)\n",
        ),
    );
    write(&ws, "R/other.R", "other <- function() 1\n");

    let user_data = tmp.path().join("user-data");
    let output = Command::new(env!("CARGO_BIN_EXE_raven"))
        .args(["parse", "--workspace", ws.to_str().unwrap(), "R/fn.R"])
        .env("RAVEN_NAMES_DB", "")
        .env("XDG_DATA_HOME", &user_data)
        .env("LOCALAPPDATA", &user_data)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    let doc: Value = serde_json::from_slice(&output.stdout).unwrap();

    let base = json!({"kind": "package", "package": "base"});
    // R skips `mean <- 7` and calls base's `mean`, from a function body and
    // at top level.
    assert_eq!(*resolution_of(&doc, "mean", 1), base);
    assert_eq!(*resolution_of(&doc, "mean", 2), base);
    // Nothing else provides `foo`: R finds no function.
    assert_eq!(
        *resolution_of(&doc, "foo", 4),
        json!({"kind": "unresolved", "reason": "not_found"})
    );
    // Another file's definition is still the package's, and the file's own
    // function is still its own.
    assert_eq!(
        *resolution_of(&doc, "other", 5),
        json!({"kind": "package", "package": "ravenTest"})
    );
    assert_eq!(resolution_of(&doc, "helper", 7)["kind"], "workspace");
}
