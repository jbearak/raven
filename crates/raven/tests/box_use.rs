//! End-to-end `raven check` coverage for static `box::use()` imports.
//!
//! These fixtures verify that the CLI consumes the same selective-import scope,
//! export privacy, path diagnostics, and revalidation-ready metadata as the LSP.

use std::process::Command;

fn raven_binary() -> std::path::PathBuf {
    let mut path = std::env::current_exe().unwrap();
    path.pop();
    path.pop();
    path.push("raven");
    path
}

fn run_check(workspace: &std::path::Path) -> String {
    let output = Command::new(raven_binary())
        .args(["check", "--workspace"])
        .arg(workspace)
        .args(["--max-severity", "off", "--no-color"])
        .output()
        .expect("failed to execute raven check");
    let code = output.status.code();
    assert!(
        matches!(code, Some(0) | Some(1)),
        "raven check did not complete cleanly (exit {code:?}).\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    String::from_utf8_lossy(&output.stdout).to_string()
}

#[test]
fn static_local_imports_resolve_and_preserve_privacy() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("mod.r"),
        "box::export(public)\npublic <- function() 1\nprivate <- function() 2\n",
    )
    .unwrap();
    std::fs::write(
        dir.path().join("main.R"),
        "box::use(./mod, ./mod[attached = public])\n\
         value <- mod$public() + attached()\n\
         leaked <- private()\n",
    )
    .unwrap();

    let output = run_check(dir.path());
    assert!(
        !output.contains("mod is not defined")
            && !output.contains("public is not defined")
            && !output.contains("attached is not defined"),
        "static box namespace and attached bindings must resolve in raven check:\n{output}"
    );
    assert!(
        output.contains("private is not defined"),
        "a non-exported module binding must not leak into the importer:\n{output}"
    );
}

#[test]
fn missing_module_and_complete_export_absence_are_reported() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("mod.r"),
        "box::export(public)\npublic <- 1\n",
    )
    .unwrap();
    std::fs::write(
        dir.path().join("main.R"),
        "box::use(./mod[missing])\nbox::use(./absent)\n",
    )
    .unwrap();

    let output = run_check(dir.path());
    assert!(
        output.contains("box-export-not-found"),
        "a name absent from a complete export set must be reported:\n{output}"
    );
    assert!(
        output.contains("box-module-not-found"),
        "an unresolved static local module must be reported:\n{output}"
    );
}

#[test]
fn rhino_qualified_imports_and_reexports_work_from_nested_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("apps/demo");
    std::fs::create_dir_all(root.join("app/logic/greetings")).unwrap();
    std::fs::create_dir_all(root.join("app/view")).unwrap();
    std::fs::write(root.join("rhino.yml"), "").unwrap();
    std::fs::write(
        root.join("app/logic/say_hello.R"),
        "box::export(say_hello)\nsay_hello <- function(name) name\nprivate <- 1\n",
    )
    .unwrap();
    std::fs::write(
        root.join("app/logic/greetings/__init__.R"),
        "#' @export\nbox::use(app/logic/say_hello[greet = say_hello])\n",
    )
    .unwrap();
    std::fs::write(root.join("app/view/hello.R"),
        "box::use(\n  app/logic/say_hello,\n  app/logic/greetings[greet],\n)\nsay_hello$say_hello('world')\ngreet('world')\nprivate\n").unwrap();
    let output = run_check(dir.path());
    for unexpected in [
        "say_hello is not defined",
        "greet is not defined",
        "app is not defined",
        "logic is not defined",
        "box-module-not-found",
        "box-export-not-found",
    ] {
        assert!(!output.contains(unexpected), "{unexpected}:\n{output}");
    }
    assert!(output.contains("private is not defined"), "{output}");
    std::fs::write(
        root.join("app/view/broken.R"),
        "box::use(app/logic/absent, app/logic/say_hello[private])\n",
    )
    .unwrap();
    let output = run_check(dir.path());
    assert!(output.contains("box-module-not-found"), "{output}");
    assert!(output.contains("box-export-not-found"), "{output}");
}
