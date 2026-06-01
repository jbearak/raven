//
// main.rs
//
// Copyright (C) 2022-2025 Posit Software, PBC. All rights reserved.
// Modifications copyright (C) 2026 Jonathan Marc Bearak
//

// The library crate (`src/lib.rs`) owns the entire module tree. This binary is
// a thin shim over it: it parses argv and dispatches into `raven::cli` /
// `raven::backend`, linking the already-compiled library rather than
// recompiling every module a second time as a separate bin-crate module tree.
use raven::{backend, cli};
use std::env;

fn print_usage() {
    println!(
        "raven {}, a static R Language Server.",
        env!("CARGO_PKG_VERSION")
    );
    print!(
        r#"
Usage: raven [OPTIONS]
       raven check [PATHS...] [--workspace DIR]
       raven lint [PATHS...]
       raven analysis-stats <path> [--csv] [--only <phase>]
       raven packages <fetch|freeze|update|build-shipped-db> [OPTIONS]
       raven freeze [ARGS]          (alias for: raven packages freeze)
       raven fetch  [ARGS]          (alias for: raven packages fetch)

Available options:

--stdio                      Start the LSP server using stdio transport
--version                    Print the version
--help                       Print this help message

Subcommands:

check [PATHS...]             Index the workspace and report full diagnostics
                             (syntax, semantic, cross-file, package, lints)
  --workspace DIR            Workspace root to index (default: current directory)
lint [PATHS...]              Run the native style linter on files / directories
analysis-stats <path>        Profile workspace analysis phases
  --csv                      Output results in CSV format
  --only <phase>             Run only the specified phase
                             (scan, parse, metadata, scope, packages)
packages <subcommand>        Generate / maintain package databases
  fetch                      Fetch a repo's Tier 2 .raven/packages.json from r-universe (R-free)
  freeze                     Write a repo's Tier 2 .raven/packages.json
  update                     Download names.db and base-exports.json sidecars
  build-shipped-db           Maintainer-only Tier 3 names.db builder
freeze, fetch                Top-level aliases for raven packages freeze/fetch

"#
    );
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut argv = env::args();
    argv.next(); // skip executable name

    let mut use_stdio = false;

    // Collect args to peek at the first one for subcommand detection
    let args: Vec<String> = argv.collect();

    match args.first().map(String::as_str) {
        Some("analysis-stats") => {
            env_logger::init();
            let mut rest = args.into_iter().skip(1);
            match cli::analysis_stats::parse_args(&mut rest) {
                Ok(stats_args) => {
                    let results = cli::analysis_stats::run_analysis_stats(&stats_args);
                    if stats_args.csv {
                        cli::analysis_stats::print_results_csv(&results);
                    } else {
                        cli::analysis_stats::print_results(&results);
                    }
                    return Ok(());
                }
                Err(e) => {
                    return Err(anyhow::anyhow!("analysis-stats: {}", e));
                }
            }
        }
        Some("lint") => {
            env_logger::init();
            let rest = args.into_iter().skip(1);
            match cli::lint::parse_args(rest) {
                Ok(lint_args) => {
                    let code = cli::lint::run(lint_args);
                    std::process::exit(code);
                }
                Err(msg) if msg == "HELP" => {
                    cli::lint::print_help();
                    return Ok(());
                }
                Err(msg) => {
                    return Err(anyhow::anyhow!("raven lint: {}", msg));
                }
            }
        }
        Some("check") => {
            env_logger::init();
            let rest = args.into_iter().skip(1);
            match cli::check::parse_args(rest) {
                Ok(check_args) => {
                    // `main` is already `#[tokio::main]`, so await directly —
                    // no nested runtime.
                    let code = cli::check::run(check_args).await;
                    std::process::exit(code);
                }
                Err(msg) if msg == "HELP" => {
                    cli::check::print_help();
                    return Ok(());
                }
                Err(msg) => {
                    return Err(anyhow::anyhow!("raven check: {}", msg));
                }
            }
        }
        Some("packages") => {
            env_logger::init();
            let rest = args.into_iter().skip(1);
            match cli::packages::run(rest).await {
                Ok(()) => return Ok(()),
                Err(msg) if msg == "HELP" => {
                    cli::packages::print_help();
                    return Ok(());
                }
                Err(msg) => {
                    return Err(anyhow::anyhow!("raven packages: {}", msg));
                }
            }
        }
        Some(tok) if cli::packages_top_level_alias(tok).is_some() => {
            env_logger::init();
            let alias = args[0].clone();
            let rest = args.into_iter();
            match cli::packages::run(rest).await {
                Ok(()) => return Ok(()),
                Err(msg) if msg == "HELP" => {
                    cli::packages::print_help();
                    return Ok(());
                }
                Err(msg) => {
                    return Err(anyhow::anyhow!("raven {}: {}", alias, msg));
                }
            }
        }
        _ => {}
    }

    for arg in &args {
        match arg.as_str() {
            "--stdio" => use_stdio = true,
            "--version" => {
                println!("raven {}", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            "--help" => {
                print_usage();
                return Ok(());
            }
            other => {
                return Err(anyhow::anyhow!("Unknown argument: '{other}'"));
            }
        }
    }

    if !use_stdio {
        print_usage();
        return Ok(());
    }

    env_logger::init();

    backend::start_lsp().await
}
