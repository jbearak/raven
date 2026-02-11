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
// test_utils is available in test builds and when the `test-support` feature is enabled.
// This allows benchmarks and integration tests to import directly instead of #[path] hacks.
#[cfg(any(test, feature = "test-support"))]
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
pub mod indentation;
pub mod namespace_parser;
pub mod package_library;
pub mod parameter_resolver;
pub mod perf;
pub mod r_env;
pub mod r_subprocess;
pub mod roxygen;
pub mod utf16;
pub mod workspace_index;
