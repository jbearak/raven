# Output — sourced by 04_orchestrator.R
# Uses configuration from parent.
# @lsp-sourced-by 04_orchestrator.R

# Use parent's output_path — no diagnostic
save_path <- paste0(output_path, "/results.rds")

# Call parent's helper — no diagnostic
clean_data(iris)
