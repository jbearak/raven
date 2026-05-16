# Tests can see R/ symbols (one-way visibility)
test_that("run_analysis works", {
  result <- run_analysis(c(1, 2, 3))
  expect_equal(result, 2)
})

# This helper is local to tests — R/ files should NOT see it
test_only_helper <- function() "only in tests"
