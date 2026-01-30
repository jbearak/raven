# Test function parameters and built-in functions

# Function with parameters - should NOT have undefined variable warnings
add <- function(a, b) {
  result <- a + b
  return(result)
}

# Using built-in functions - should NOT have undefined variable warnings
test_builtins <- function(x) {
  if (any(is.na(x))) {
    warning("Found NA values")
    return(NULL)
  }
  
  msg <- sprintf("Sum: %d", sum(x))
  print(msg)
  
  return(mean(x))
}

# Nested functions
outer_func <- function(x) {
  inner_func <- function(y) {
    x + y
  }
  return(inner_func)
}
