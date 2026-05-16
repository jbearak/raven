# Demonstration of out-of-scope (forward reference) warning
# @lsp-sourced-by 04_orchestrator.R

# Variable used before it's defined — forward reference warning
result <- total_count + 10
total_count <- 100
