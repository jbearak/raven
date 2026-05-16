# Demonstration of cross-file navigation
# Cmd-click (go-to-definition) and Find References work across source() chains.

# Define shared helpers
normalize <- function(x) {
  (x - min(x)) / (max(x) - min(x))
}

compute_score <- function(data, weights) {
  rowSums(data * weights)
}

# Source child scripts
source("02_prepare.R")
source("03_model.R")
