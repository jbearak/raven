# Argument order is fixed: [1]=topic, [2]=package-or-empty, [3]=tempfile path.
args <- commandArgs(trailingOnly = TRUE)
topic <- args[1]
pkg <- if (nzchar(args[2])) args[2] else NULL
meta_path <- args[3]
h <- help(topic, package = (pkg))
rd <- utils:::.getHelpFile(h)
# In R 4.6, attr(rd, "package") is no longer populated; extract from the help path.
help_path <- as.character(h)
help_dir <- dirname(help_path)
resolved_pkg <- basename(dirname(help_dir))
# "\\alias" in R source is \a (BEL) + "lias"; use "\\\\alias" for a literal backslash.
aliases <- vapply(
  Filter(function(x) attr(x, "Rd_tag") == "\\\\alias", rd),
  function(x) as.character(x[[1]]),
  character(1)
)
canonical_topic <- if (length(aliases) >= 1) aliases[1] else topic
lib_paths <- .libPaths()
con <- file(meta_path, "w")
on.exit(close(con))
cat("topic\t", canonical_topic, "\n", sep = "", file = con)
cat("package\t", resolved_pkg, "\n", sep = "", file = con)
cat("helpDir\t", help_dir, "\n", sep = "", file = con)
for (lp in lib_paths) cat("libPath\t", lp, "\n", sep = "", file = con)
tools::Rd2HTML(rd, out = stdout(), package = resolved_pkg)
