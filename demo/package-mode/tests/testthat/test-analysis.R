# Tests can see R/ symbols (one-way visibility), testthat exports (because
# `Suggests: testthat` plus the tests/testthat.R runner), and helper-*.R
# top-level defs (here, demo_fixture_input from helper-fixtures.R).
test_that("run_analysis works", {
  result <- run_analysis(demo_fixture_input)
  expect_equal(result, 2)
})

# This helper is local to tests — R/ files should NOT see it
test_only_helper <- function() "only in tests"
