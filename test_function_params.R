my_func <- function(x, y = 42, ...) {
  result <- x + y
  list(result, ...)
}

another_func <- function() {
  return(42)
}