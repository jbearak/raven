// lib.rs — Exposes internal modules for benchmarks and integration tests.
//
// The main binary entry point remains in main.rs. This file re-exports
// the subset of modules that benches/ and tests/ need.
//
// NOTE: Only modules required by benchmarks/tests are included here.
// The full module set lives in main.rs (the binary crate root).

pub mod cli;
pub mod cross_file;
pub mod parser_pool;
pub mod reserved_words;
pub mod state;
// test_utils is only available in test builds (uses dev-dependencies like tempfile).
// Benchmarks access fixture_workspace via #[path] include instead.
#[cfg(test)]
pub mod test_utils;

// Transitive dependencies of the above modules:
pub mod backend;
pub mod builtins;
pub mod completion_context;
pub mod content_provider;
pub mod document_store;
pub mod file_path_intellisense;
pub mod handlers;
pub mod help;
pub mod namespace_parser;
pub mod package_library;
pub mod parameter_resolver;
pub mod perf;
pub mod r_env;
pub mod r_subprocess;
pub mod roxygen;
pub mod workspace_index;
