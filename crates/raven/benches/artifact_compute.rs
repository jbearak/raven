// Serial micro-benchmark for `compute_artifacts` (the per-file artifact pass
// that workspace_scan runs on every file). Unlike the `workspace_scan` bench
// in `startup.rs`, this is single-threaded and does no file I/O, so it
// isolates the AST-traversal cost and is far less sensitive to machine load —
// suitable for A/B comparison of changes to the traversal.
//
// Run with: cargo bench --bench artifact_compute --features test-support

use criterion::{Criterion, black_box, criterion_group, criterion_main};
use url::Url;

use raven::cross_file::compute_artifacts;

/// Build a representative ~400-line R source with a realistic mix of
/// assignments, function definitions, pipes, and many *non-call* nodes
/// (operators, identifiers, literals) so the cost of any whole-tree walk is
/// reflected, not just the per-call recognizers.
fn representative_source() -> String {
    let mut s = String::with_capacity(16_000);
    for i in 0..40 {
        s.push_str(&format!(
            r#"
helper_{i} <- function(x, y = {i}) {{
  z <- x + y * {i} - (x / 2)
  vals <- c(1, 2, 3, {i}, x, y)
  out <- vapply(vals, function(v) v^2 + z, numeric(1))
  res <- data.frame(a = out, b = rev(out), g = seq_along(out))
  res <- res[res$a > {i}, , drop = FALSE]
  total <- sum(res$a) + mean(res$b) - max(res$g)
  if (total > {i}) {{
    message("big", total)
  }} else {{
    warning("small")
  }}
  list(z = z, total = total, vals = vals)
}}

acc_{i} <- helper_{i}({i}, y = {i} + 1)
stopifnot(is.list(acc_{i}))
"#
        ));
    }
    s
}

fn bench_compute_artifacts(c: &mut Criterion) {
    let content = representative_source();
    let uri = Url::parse("file:///bench/representative.R").unwrap();
    let tree = raven::parser_pool::with_parser(|parser| parser.parse(&content, None))
        .expect("parse failed");

    let mut group = c.benchmark_group("artifact_compute");
    group.bench_function("representative_400loc", |b| {
        b.iter(|| {
            black_box(compute_artifacts(
                black_box(&uri),
                black_box(&tree),
                black_box(&content),
            ))
        })
    });
    group.finish();
}

criterion_group!(benches, bench_compute_artifacts);
criterion_main!(benches);
