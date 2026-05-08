//! HTML help fetch — R subprocess running tools::Rd2HTML, metadata via tempfile.
//!
//! Sync function (mirrors `get_help`); callers wrap in `tokio::task::spawn_blocking`.
//! See spec "Server-side help renderer" for the full contract.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tempfile::NamedTempFile;

use super::rewrite::rewrite_help_html;
use super::sanitize::sanitize_help_html;
use super::types::{HelpHtml, HelpHtmlError};
use super::validate::is_valid_help_topic;

pub const HELP_HTML_TIMEOUT: Duration = Duration::from_secs(10);
pub const HELP_HTML_MAX_BYTES: usize = 8 * 1024 * 1024;

pub fn get_help_html(
    topic: &str,
    package: Option<&str>,
    r_path: &Path,
) -> Result<HelpHtml, HelpHtmlError> {
    // 1) Validate inputs.
    if !is_valid_help_topic(topic) {
        return Err(HelpHtmlError::InvalidTopic {
            message: format!("invalid topic: {}", topic.escape_debug()),
        });
    }
    if let Some(p) = package {
        if !crate::r_subprocess::is_valid_package_name(p) {
            return Err(HelpHtmlError::InvalidTopic {
                message: format!("invalid package: {}", p.escape_debug()),
            });
        }
    }

    // 2) Tempfile (RAII cleanup).
    let meta = NamedTempFile::new().map_err(|e| HelpHtmlError::RenderFailed {
        message: format!("tempfile create: {e}"),
    })?;
    let meta_path = meta.path().to_path_buf();

    // 3) Build the R snippet — hard-coded since this never sees user input directly.
    let r_code = include_str!("rd_to_html.R");

    // 4) Spawn R with the fixed three-arg ordering: topic, package-or-empty, meta-path.
    let pkg_arg = package.unwrap_or("");
    let mut cmd = Command::new(r_path);
    cmd.args([
        "--slave",
        "--no-save",
        "--no-restore",
        "-e",
        r_code,
        "--args",
        topic,
        pkg_arg,
    ]);
    cmd.arg(meta_path.as_os_str());
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| HelpHtmlError::RUnavailable {
        message: format!("R spawn failed: {e}"),
    })?;
    let pid = child.id();

    // 5) Watchdog (mirrors get_help in text.rs).
    let exited = Arc::new(AtomicBool::new(false));
    let exited_clone = exited.clone();
    std::thread::spawn(move || {
        std::thread::sleep(HELP_HTML_TIMEOUT);
        if !exited_clone.load(Ordering::SeqCst) {
            super::text::kill_process_by_pid(pid);
        }
    });

    // 6) Drain stdout up to the cap.
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let stdout_thread = std::thread::spawn(move || -> Result<Vec<u8>, HelpHtmlError> {
        let mut buf = Vec::with_capacity(64 * 1024);
        let mut reader = stdout;
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    if buf.len() + n > HELP_HTML_MAX_BYTES {
                        return Err(HelpHtmlError::TooLarge);
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                Err(e) => {
                    return Err(HelpHtmlError::RenderFailed {
                        message: format!("stdout read: {e}"),
                    });
                }
            }
        }
        Ok(buf)
    });
    let stderr_thread = std::thread::spawn(move || -> Vec<u8> {
        let mut buf = Vec::new();
        let mut s = stderr;
        let _ = s.read_to_end(&mut buf);
        buf
    });

    let wait_result = child.wait();
    exited.store(true, Ordering::SeqCst);
    let stdout_bytes = stdout_thread.join().unwrap_or(Err(HelpHtmlError::RenderFailed {
        message: "stdout thread panicked".into(),
    }))?;
    let stderr_bytes = stderr_thread.join().unwrap_or_default();

    let status = wait_result.map_err(|e| HelpHtmlError::RenderFailed {
        message: format!("wait: {e}"),
    })?;

    if !status.success() {
        let err = String::from_utf8_lossy(&stderr_bytes).to_string();
        if err.contains("there is no package called") {
            return Err(HelpHtmlError::PackageNotInstalled);
        }
        if err.contains("No documentation") || err.contains("no help found") {
            return Err(HelpHtmlError::NotFound);
        }
        return Err(HelpHtmlError::RenderFailed { message: err });
    }

    // 7) Parse metadata tempfile.
    let meta_text = std::fs::read_to_string(&meta_path).map_err(|e| HelpHtmlError::RenderFailed {
        message: format!("metadata read: {e}"),
    })?;
    drop(meta); // RAII cleanup
    let mut meta_topic = None;
    let mut meta_pkg = None;
    let mut meta_help_dir = None;
    let mut meta_lib_paths: Vec<std::path::PathBuf> = Vec::new();
    for line in meta_text.lines() {
        if let Some((k, v)) = line.split_once('\t') {
            match k {
                "topic" => meta_topic = Some(v.to_string()),
                "package" => meta_pkg = Some(v.to_string()),
                "helpDir" => meta_help_dir = Some(std::path::PathBuf::from(v)),
                "libPath" => meta_lib_paths.push(std::path::PathBuf::from(v)),
                _ => {}
            }
        }
    }
    let canonical_topic = meta_topic.ok_or(HelpHtmlError::RenderFailed {
        message: "missing topic in metadata".into(),
    })?;
    let canonical_pkg = meta_pkg.ok_or(HelpHtmlError::RenderFailed {
        message: "missing package in metadata".into(),
    })?;
    let help_dir = meta_help_dir.ok_or(HelpHtmlError::RenderFailed {
        message: "missing helpDir in metadata".into(),
    })?;
    if meta_lib_paths.is_empty() {
        return Err(HelpHtmlError::RenderFailed {
            message: "missing libPath entries in metadata".into(),
        });
    }

    // 8) Sanitize and rewrite (catch_unwind around sanitize).
    let html_raw = String::from_utf8_lossy(&stdout_bytes).to_string();
    let sanitized = std::panic::catch_unwind(|| sanitize_help_html(&html_raw))
        .map_err(|_| HelpHtmlError::RenderFailed {
            message: "ammonia panic".into(),
        })?;
    let rewritten = rewrite_help_html(&sanitized, &canonical_pkg);

    // 9) Title from first <h2>.
    let title = extract_h2_title(&rewritten).unwrap_or_else(|| canonical_topic.clone());

    Ok(HelpHtml {
        topic: canonical_topic,
        package: canonical_pkg,
        title,
        html: rewritten,
        help_dir,
        lib_paths: meta_lib_paths,
    })
}

fn extract_h2_title(html: &str) -> Option<String> {
    let start = html.find("<h2")?;
    let after_open = &html[start..];
    let close_open = after_open.find('>')? + 1;
    let body = &after_open[close_open..];
    let end = body.find("</h2>")?;
    let inner = &body[..end];
    // Strip any nested tags by removing `< ... >` substrings.
    let mut out = String::with_capacity(inner.len());
    let mut in_tag = false;
    for c in inner.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let trimmed = out.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_h2_basic() {
        assert_eq!(extract_h2_title("<h2>Title</h2>"), Some("Title".into()));
        assert_eq!(
            extract_h2_title(r#"<h2 class="x">Title <em>Sub</em></h2>"#),
            Some("Title Sub".into())
        );
        assert_eq!(extract_h2_title("<p>no h2</p>"), None);
    }

    use crate::r_subprocess::RSubprocess;

    fn r_path() -> Option<std::path::PathBuf> {
        RSubprocess::new(None).map(|s| s.r_path().clone())
    }

    #[test]
    fn renders_base_mean() {
        let Some(r) = r_path() else { eprintln!("skip: no R"); return; };
        let res = get_help_html("mean", Some("base"), &r).expect("render");
        assert_eq!(res.package, "base");
        assert!(res.html.contains("Arithmetic Mean") || res.title.contains("Mean"));
        assert!(res.help_dir.ends_with("help"));
        assert!(!res.lib_paths.is_empty());
    }

    #[test]
    fn invalid_topic_short_circuits() {
        // Path doesn't exist; this should still fail BEFORE spawning R.
        let bogus = std::path::PathBuf::from("/no/such/R");
        let res = get_help_html("with\nnewline", None, &bogus);
        assert!(matches!(res, Err(HelpHtmlError::InvalidTopic { .. })));
    }

    #[test]
    fn unknown_topic_returns_not_found() {
        let Some(r) = r_path() else { eprintln!("skip: no R"); return; };
        let res = get_help_html("definitely_not_a_real_topic_zzz", Some("base"), &r);
        assert!(matches!(res, Err(HelpHtmlError::NotFound) | Err(HelpHtmlError::RenderFailed { .. })));
    }

    #[test]
    fn unknown_package_returns_package_not_installed() {
        let Some(r) = r_path() else { eprintln!("skip: no R"); return; };
        let res = get_help_html("filter", Some("totally_not_installed_pkg_xyz"), &r);
        assert!(matches!(
            res,
            Err(HelpHtmlError::PackageNotInstalled) | Err(HelpHtmlError::RenderFailed { .. })
        ));
    }

    #[test]
    fn operator_topic_works() {
        let Some(r) = r_path() else { eprintln!("skip: no R"); return; };
        let res = get_help_html("[", Some("base"), &r).expect("render");
        assert_eq!(res.package, "base");
    }
}
