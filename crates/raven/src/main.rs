//
// main.rs
//
// Copyright (C) 2022-2025 Posit Software, PBC. All rights reserved.
// Modifications copyright (C) 2026 Jonathan Marc Bearak
//

mod backend;
mod builtins;
mod chunks;
mod cli;
mod completion_context;
mod config_file;
mod content_provider;
mod cross_file;
mod document_store;
mod extract_op;
mod file_path_intellisense;
mod file_type;
mod handlers;
mod help;
mod indentation;
mod jags_builtins;
mod libpath_watcher;
mod linting;
mod namespace_parser;
mod package_library;
mod package_namespace;
mod package_state;
mod parameter_resolver;
mod parser_pool;
mod perf;
mod qualified_resolve;
mod r_env;
mod r_subprocess;
mod reserved_words;
mod roxygen;
mod stan_builtins;
mod state;
mod utf16;
mod workspace_index;

#[cfg(any(test, feature = "test-support"))]
#[allow(dead_code)]
mod test_utils;

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

    if let Some(first) = args.first() {
        if first == "analysis-stats" {
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

        if first == "lint" {
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

        if first == "check" {
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
