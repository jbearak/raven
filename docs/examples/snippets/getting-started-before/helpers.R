summarize_scores <- function(scores) {
  c(mean = mean(scores), best = max(scores))
}
