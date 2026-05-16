# Model fitting — sourced by 01_main.R
# Cmd-click on `compute_score` or `scaled` to navigate to their definitions.
# @lsp-sourced-by 01_main.R

# Go-to-definition: Cmd-click `scaled` → jumps to 02_prepare.R
# Go-to-definition: Cmd-click `compute_score` → jumps to 01_main.R
weights <- c(0.4, 0.3, 0.3)
scores <- compute_score(scaled, weights)

# Find references on `compute_score`: shows definition in 01_main.R + usage here
final <- normalize(scores)
