# Demonstration of out-of-scope (forward reference) warning
# This file is standalone — no parent sources it.
# Raven flags variables used before they are defined at top level.

# Variable used before it's defined — forward reference warning
result <- total_count + 10
total_count <- 100
