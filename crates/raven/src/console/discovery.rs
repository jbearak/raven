//! Find the R installation the user would get by typing `R`, and recreate the
//! environment R's launcher script would give it.
//!
//! `R` on Unix is a shell script: it exports `R_HOME`, `R_SHARE_DIR`,
//! `R_INCLUDE_DIR`, `R_DOC_DIR`, sources `etc${R_ARCH}/ldpaths` (which puts
//! R's own library directory, and any configured Java/BLAS locations, on the
//! dynamic-loader path), and then execs the real binary. `R RHOME` exits
//! *before* `ldpaths` runs, so knowing R_HOME is not enough. We replay the
//! launcher's own assignments in `sh`, then re-exec this process once with the
//! result, because the dynamic loader only honours its search path from
//! process start — which is when compiled packages' shared objects will later
//! need it.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

/// Marks the re-exec'd child so discovery runs only once.
const BOOTSTRAPPED_ENV: &str = "RAVEN_CONSOLE_BOOTSTRAPPED";
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone)]
pub struct RInstall {
    pub home: PathBuf,
    pub libr: PathBuf,
}

/// Outcome of discovery in the current process.
pub enum Discovered {
    /// The environment is already launcher-equivalent: load R in-process.
    Ready(RInstall),
    /// Environment computed; caller must re-exec with it.
    NeedsReexec(RInstall, Vec<(String, OsString)>),
}

/// Why R can't be embedded, and the installation that was selected, if any —
/// the fallback runs that installation's own launcher, not whatever `R` is
/// first on PATH.
pub struct DiscoverError {
    pub home: Option<PathBuf>,
    pub reason: String,
}

impl From<String> for DiscoverError {
    fn from(reason: String) -> Self {
        Self { home: None, reason }
    }
}

/// Find R. `explicit_home` (from `--r-home`) wins, then a valid `R_HOME`, then
/// `R RHOME` from the `R` on `PATH`.
pub fn discover(explicit_home: Option<&Path>) -> Result<Discovered, DiscoverError> {
    let bootstrapped = std::env::var_os(BOOTSTRAPPED_ENV).is_some();
    let home = if let Some(h) = explicit_home {
        validate_home(h)
            .ok_or_else(|| format!("--r-home {} is not an R installation", h.display()))?
    } else if let Some(h) = std::env::var_os("R_HOME")
        .map(PathBuf::from)
        .and_then(|h| validate_home(&h))
    {
        h
    } else {
        probe_rhome()?
    };
    let Some(libr) = shared_library(&home) else {
        return Err(DiscoverError {
            reason: format!(
                "{} has no shared libR (R was built without --enable-R-shlib)",
                home.display()
            ),
            home: Some(home),
        });
    };
    let install = RInstall { home, libr };
    if bootstrapped {
        // SAFETY: single-threaded at this point (called before any thread is
        // spawned). Removing the marker keeps it out of R's child processes.
        unsafe { std::env::remove_var(BOOTSTRAPPED_ENV) };
        return Ok(Discovered::Ready(install));
    }
    let env = launcher_environment(&install.home).map_err(|reason| DiscoverError {
        reason,
        home: Some(install.home.clone()),
    })?;
    Ok(Discovered::NeedsReexec(install, env))
}

fn validate_home(home: &Path) -> Option<PathBuf> {
    let home = home.canonicalize().ok()?;
    home.join("bin").join("R").is_file().then_some(home)
}

fn shared_library(home: &Path) -> Option<PathBuf> {
    let name = if cfg!(target_os = "macos") {
        "libR.dylib"
    } else {
        "libR.so"
    };
    let p = home.join("lib").join(name);
    p.is_file().then_some(p)
}

/// Ask the `R` on PATH for its home. Takes the last non-empty stdout line, so a
/// launcher warning printed first can never become the path.
fn probe_rhome() -> Result<PathBuf, String> {
    let out = run_with_timeout(Command::new("R").arg("RHOME"))
        .map_err(|e| format!("could not run `R RHOME`: {e}"))?;
    let text = String::from_utf8_lossy(&out);
    let line = parse_rhome_output(&text).ok_or("`R RHOME` printed nothing")?;
    validate_home(Path::new(line))
        .ok_or_else(|| format!("`R RHOME` returned {line}, which is not an R installation"))
}

pub(crate) fn parse_rhome_output(text: &str) -> Option<&str> {
    text.lines().map(str::trim).rfind(|l| !l.is_empty())
}

/// Replay the launcher's environment setup in `sh`. The resource-directory
/// assignments are taken from the installation's own `bin/R` (so relocated
/// layouts such as Debian's `/usr/share/R/share` are honoured) and `ldpaths`
/// is sourced exactly as the launcher does.
fn launcher_environment(home: &Path) -> Result<Vec<(String, OsString)>, String> {
    const VARS: [&str; 6] = [
        "R_SHARE_DIR",
        "R_INCLUDE_DIR",
        "R_DOC_DIR",
        "R_ARCH",
        "LD_LIBRARY_PATH",
        "DYLD_FALLBACK_LIBRARY_PATH",
    ];
    // `printf` is a shell builtin, so macOS SIP never strips the DYLD_ value
    // on its way out.
    let script = r#"
R_HOME="$1"; export R_HOME
: ${R_ARCH=}
eval "$(grep -E '^(R_SHARE_DIR|R_INCLUDE_DIR|R_DOC_DIR)=' "$R_HOME/bin/R")"
: ${R_SHARE_DIR="$R_HOME/share"} ${R_INCLUDE_DIR="$R_HOME/include"} ${R_DOC_DIR="$R_HOME/doc"}
. "$R_HOME/etc$R_ARCH/ldpaths"
printf '%s\0' "$R_SHARE_DIR" "$R_INCLUDE_DIR" "$R_DOC_DIR" "$R_ARCH" "$LD_LIBRARY_PATH" "$DYLD_FALLBACK_LIBRARY_PATH"
"#;
    let out = run_with_timeout(
        Command::new("/bin/sh")
            .arg("-c")
            .arg(script)
            .arg("sh")
            .arg(home),
    )
    .map_err(|e| format!("could not read R's launcher environment: {e}"))?;
    let fields: Vec<&[u8]> = out.split(|b| *b == 0).collect();
    if fields.len() < VARS.len() {
        return Err("R's launcher environment script produced unexpected output".into());
    }
    let mut env = vec![("R_HOME".to_string(), home.as_os_str().to_owned())];
    for (name, value) in VARS.iter().zip(fields) {
        if value.is_empty() && name.ends_with("LIBRARY_PATH") {
            continue;
        }
        if *name == "DYLD_FALLBACK_LIBRARY_PATH" && !cfg!(target_os = "macos") {
            continue;
        }
        if *name == "LD_LIBRARY_PATH" && cfg!(target_os = "macos") {
            continue;
        }
        env.push(((*name).to_string(), bytes_to_os(value)));
    }
    env.push((BOOTSTRAPPED_ENV.to_string(), OsString::from("1")));
    Ok(env)
}

#[cfg(unix)]
fn bytes_to_os(b: &[u8]) -> OsString {
    use std::os::unix::ffi::OsStringExt;
    OsString::from_vec(b.to_vec())
}

fn run_with_timeout(cmd: &mut Command) -> std::io::Result<Vec<u8>> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut stdout = child.stdout.take().expect("piped");
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut stdout, &mut buf).map(|_| buf)
    });
    let deadline = std::time::Instant::now() + PROBE_TIMEOUT;
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "timed out",
            ));
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    reader
        .join()
        .map_err(|_| std::io::Error::other("reader thread panicked"))?
}

/// Replace this process with itself, with `env` applied. Only returns on error.
pub fn reexec(env: &[(String, OsString)]) -> std::io::Error {
    use std::os::unix::process::CommandExt;
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(e) => return e,
    };
    let mut cmd = Command::new(exe);
    cmd.args(std::env::args_os().skip(1));
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.exec()
}

/// Replace this process with plain R (the automatic fallback). Prefers the
/// launcher of the installation already selected so the fallback runs the same
/// R; otherwise the `R` on PATH. Only returns on error.
pub fn exec_plain_r(home: Option<&Path>, r_args: &[OsString]) -> std::io::Error {
    use std::os::unix::process::CommandExt;
    let program: OsString = home
        .map(|h| h.join("bin").join("R").into_os_string())
        .unwrap_or_else(|| OsString::from("R"));
    let mut cmd = Command::new(program);
    cmd.args(r_args);
    cmd.env_remove(BOOTSTRAPPED_ENV);
    cmd.exec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rhome_output_takes_last_nonempty_line() {
        assert_eq!(parse_rhome_output("/opt/R\n"), Some("/opt/R"));
        assert_eq!(
            parse_rhome_output("WARNING: ignoring environment value of R_HOME\n/usr/lib/R\n\n"),
            Some("/usr/lib/R")
        );
        assert_eq!(parse_rhome_output("\n  \n"), None);
    }
}
