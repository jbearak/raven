# Demo: Function parameters and built-ins should NOT show undefined warnings

# Example from the issue - should work without warnings
f <- function(a, b) {
  return(a+b)
}

# Built-in functions mentioned in the issue - should work without warnings
test_builtins <- function(data) {
  if (any(is.na(data))) {
    warning("Found NA values")
  }
  message <- sprintf("Processing %d items", length(data))
  print(message)
}
