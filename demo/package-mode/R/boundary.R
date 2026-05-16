# This file demonstrates the boundary: test_only_helper is NOT visible from R/
# Raven should flag test_only_helper as undefined here.
boundary_check <- function() {
  test_only_helper()
}
