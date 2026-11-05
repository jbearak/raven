source("R/top.R")
source("R/b.R", local = TRUE)
d <- local({ source("R/a.R", local = TRUE); d })
f <- function() source("R/fn.R", local = TRUE)
e <- new.env(); source("R/env.R", local = e)
sys.source("R/sys1.R")
sys.source("R/sys2.R", envir = globalenv())
source("R/chdir.R", chdir = TRUE)
if (file.exists("R/maybe.R")) source("R/maybe.R")
source("R/missing.R")
source("excluded/x.R")
source("../outside.R")
source(system.file("scripts", "x.R", package = "raven.not.installed"))
# raven: source R/sup.R
# raven: source R/sup.R line=eof
source("R/sup.R")
# raven: source R/fd_plain.R
# raven: source R/fd_line.R line=19
# raven: source R/fd_eof.R line=eof
# raven: source R/dup.R line=30
# raven: source R/dup.R line=30
source("R/top.R")
source("R/cyc1.R")
source("report.Rmd")
