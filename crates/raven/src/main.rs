//
// main.rs
//
// Copyright (C) 2022-2025 Posit Software, PBC. All rights reserved.
// Modifications copyright (C) 2026 Jonathan Marc Bearak
//

mod backend;
mod builtins;
mod cli;
mod completion_context;
mod content_provider;
mod cross_file;
mod document_store;
mod file_path_intellisense;
mod handlers;
mod help;
mod indentation;
mod namespace_parser;
mod package_library;
mod parameter_resolver;
mod parser_pool;
mod perf;
mod r_env;
mod r_subprocess;
mod reserved_words;
mod roxygen;
mod state;
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
       raven analysis-stats <path> [--csv] [--only <phase>]

Available options:

--stdio                      Start the LSP server using stdio transport
--version                    Print the version
--help                       Print this help message

Subcommands:

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
