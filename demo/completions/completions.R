# Demonstration of intelligent autocomplete

library(dplyr)

# Variable completion — type "mtc" and see mtcars appear
data <- mtcars

# Function completion — type "summ" and see summary, summarise, etc.
# [Type "summ" and pause to show dropdown]

# Column/accessor completion — type "data$" and see column names
# [Type "data$m" and see mpg appear]

# Package function completion — type "dplyr::" and see exported functions
# [Type "dplyr::filt" and see filter]

# Parameter completion — type inside function call
# [Type "read.csv(" and see file=, header=, sep=, etc.]

# User-defined function completion
my_helper <- function(x, threshold = 0.5) {
  x[x > threshold]
}

# [Type "my_h" and see my_helper; type "my_helper(" and see x, threshold]
