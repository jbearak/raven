clean_names <- function(df) {
  names(df) <- tolower(names(df))
  df
}
