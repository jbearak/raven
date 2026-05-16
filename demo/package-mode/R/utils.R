# Utility functions for demopackage
validate_input <- function(x) {
  if (!is.numeric(x)) stop("x must be numeric")
  x
}
