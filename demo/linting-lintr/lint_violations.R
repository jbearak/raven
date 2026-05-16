# This file intentionally triggers lint rules for smoke testing.
# Open this folder as a workspace in VS Code to see diagnostics.

# Line length violation (over 80 chars):
very_long_variable_name <- "this is a string that is intentionally made very long to exceed the default line length limit of eighty characters"

# Trailing whitespace:
x <- 1   

# Assignment operator (uses = instead of <-):
y = 2

# Object name violation (camelCase instead of snake_case):
myVariable <- 3

# T/F symbol:
flag <- T

# Infix spaces violation:
z <-1+2
