# Analysis — sourced by 04_orchestrator.R
# Uses variables and functions defined in the parent.
# @lsp-sourced-by 04_orchestrator.R

# Use variable defined in parent — no diagnostic
input_file <- paste0(data_path, "/survey.csv")

# Call function defined in parent — no diagnostic
cleaned <- clean_data(mtcars)

# Use variable created in parent — no diagnostic
if (analysis_sample) {
  print("Running analysis")
}

# Undefined variable — Raven flags this
oops <- nonexistent_variable + 1
