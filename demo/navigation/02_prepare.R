# Data preparation — sourced by 01_main.R
# Cmd-click on `normalize` below jumps to its definition in 01_main.R.
# @lsp-sourced-by 01_main.R

raw_data <- mtcars[, c("mpg", "hp", "wt")]

# Go-to-definition: Cmd-click `normalize` → jumps to 01_main.R line 5
scaled <- as.data.frame(lapply(raw_data, normalize))

# Find references: right-click `normalize` → shows usages here and in 03_model.R
