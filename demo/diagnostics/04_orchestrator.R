# Demonstration of cross-file scope-aware diagnostics
# This is the parent file that sources children in order.

# Define shared configuration
data_path <- "data"
output_path <- "output"

# Define helper used across project
clean_data <- function(df) {
  df[complete.cases(df), ]
}

# Create analytic variable
analysis_sample <- TRUE

# Run analyses in order
source("05_analysis.R")
source("06_output.R")
