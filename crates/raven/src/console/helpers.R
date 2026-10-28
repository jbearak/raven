# Raven console helpers. Evaluated once at startup into a private environment
# that is attached nowhere; the console calls these functions through its C
# shim. Every entry point catches its own errors so the shim's last-resort
# jump guard is never the normal error path.
local({
    env <- new.env(parent = baseenv())

    # Completion for the text left of the cursor. Returns c(token, candidates):
    # `token` is the suffix of `line` the candidates replace.
    env$complete <- function(line) {
        tryCatch({
            pkg <- regmatches(line, regexec(
                "(?:library|require|requireNamespace|loadNamespace)\\(\\s*['\"]?([A-Za-z0-9._]*)$",
                line, perl = TRUE))[[1L]]
            if (length(pkg) == 2L) {
                tok <- pkg[[2L]]
                all <- env$installed_packages()
                return(c(tok, all[startsWith(all, tok)]))
            }
            utils:::.assignLinebuffer(line)
            utils:::.assignEnd(nchar(line, type = "chars"))
            token <- utils:::.guessTokenFromLine()
            utils:::.completeToken()
            c(token, utils:::.retrieveCompletions())
        }, error = function(e) character(), interrupt = function(e) character())
    }

    # Installed packages, cached until a library directory changes.
    env$pkg_cache <- NULL
    env$installed_packages <- function() {
        libs <- .libPaths()
        key <- paste(libs, file.mtime(libs), collapse = "\r")
        if (is.null(env$pkg_cache) || !identical(env$pkg_cache$key, key)) {
            env$pkg_cache <- list(key = key, pkgs = sort(unique(.packages(all.available = TRUE))))
        }
        env$pkg_cache$pkgs
    }

    # Keep options(width) equal to the terminal width, unless the user has set
    # it to something else themselves since we last set it.
    env$last_width <- NULL
    env$set_width <- function(w) {
        tryCatch({
            w <- max(10L, min(10000L, as.integer(w)))
            cur <- getOption("width")
            if (is.null(env$last_width) || identical(cur, env$last_width)) {
                if (!identical(cur, w)) options(width = w)
                env$last_width <- w
            }
            invisible(NULL)
        }, error = function(e) NULL)
    }

    # R's condition headers in the session's language, for stderr styling.
    # Returns c("E", <error headers>, "W", <warning headers>).
    env$headers <- function() {
        tryCatch({
            g <- function(x) {
                s <- gettext(x, domain = "R")
                s <- sub("\n$", "", s)
                sub("%.*$", "", s)
            }
            err <- unique(c(g("Error in "), g("Error: "), "Error in ", "Error: "))
            warn <- unique(c(g("Warning message:\n"), g("Warning messages:\n"),
                             g("Warning in %s :"), g("Warning: %s\n"), g("In addition: "),
                             "Warning message", "Warning in ", "Warning: ", "In addition: "))
            c("E", err[nzchar(err)], "W", warn[nzchar(warn)])
        }, error = function(e) character())
    }

    # Another package (colorout) replaced the console's output hook. Ask it
    # to restore the previous hook; returns the package name for the notice.
    env$release_output_hook <- function() {
        tryCatch({
            if ("colorout" %in% loadedNamespaces()) {
                getExportedValue("colorout", "noColorOut")()
                return("colorout")
            }
            ""
        }, error = function(e) "")
    }

    env
})
