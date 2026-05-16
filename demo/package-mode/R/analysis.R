# Analysis functions — uses validate_input from R/utils.R via mutual visibility
run_analysis <- function(data) {
  validated <- validate_input(data)
  mean(validated)
}
