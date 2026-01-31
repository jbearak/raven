# Test file for loop iterator detection
for (i in 1:10) {
  print(i)
}

# Iterator should persist after loop
result <- i + 1

# Nested loops
for (outer in 1:3) {
  for (inner in 1:2) {
    print(outer, inner)
  }
}

# Both iterators should be available
final <- outer + inner