# Raven debugger helpers (see src/console/dap/mod.rs and
# docs/superpowers/specs/2026-10-29-r-debugger-design.md).
#
# Evaluated once at startup into a private environment whose parent is the
# base environment, so every function used here resolves to base R's own
# definition however the user's session masks names. Rust calls these
# through the console's C shim; R code reaches Rust only through the
# registered `.Call` routines in debug.c.
#
# Rules:
#   - Nothing on a default path calls a generic on a user object: previews
#     and hover use typeof(), oldClass(), attr(), .subset()/.subset2() and
#     the native helpers, which never dispatch (design sec. 6).
#   - Every entry point catches its own errors and sets `state$internal`, so
#     Raven's own work never triggers the user's handlers or breakpoints.
base::local(envir = base::new.env(parent = base::baseenv()), {
    # Functions defined here close over this environment, whose parent is
    # base, so a user's global definitions can't shadow what they call.
    here <- environment()
    env <- new.env(parent = baseenv())
    sym <- function(name) getNativeSymbolInfo(name)
    N <- list(
        rpc = sym("raven_dbg_rpc"),
        binding = sym("raven_dbg_binding"),
        xlength = sym("raven_dbg_xlength"),
        materialized = sym("raven_dbg_materialized"),
        rdebug = sym("raven_dbg_rdebug"),
        altrep_class = sym("raven_dbg_altrep_class"),
        nrow = sym("raven_dbg_nrow"),
        set_rdebug = sym("raven_dbg_set_rdebug"),
        base_bind = sym("raven_dbg_base_bind")
    )
    env$N <- N
    rpc <- function(op, a = "", b = "") .Call(N$rpc, op, a, b)
    state <- new.env(parent = emptyenv())
    state$internal <- FALSE
    state$refs <- new.env(parent = emptyenv())
    state$next_ref <- 1L
    state$frames <- list()
    state$cut <- NULL
    state$fbp <- list()
    state$handlers <- FALSE
    state$orig_source <- NULL
    env$state <- state
    US <- "\x1f"

    # ---- JSON ----------------------------------------------------------------
    jstr <- function(s) {
        s <- tryCatch(enc2utf8(as.character(s)), error = function(e) "<unprintable>")
        s[is.na(s)] <- "NA"
        # Invalid UTF-8 shows its bytes rather than failing the whole value.
        s <- iconv(s, "UTF-8", "UTF-8", sub = "byte")
        s[is.na(s)] <- "<unprintable>"
        s <- tryCatch({
            s <- gsub("\\", "\\\\", s, fixed = TRUE)
            s <- gsub("\"", "\\\"", s, fixed = TRUE)
            s <- gsub("\n", "\\n", s, fixed = TRUE)
            s <- gsub("\r", "\\r", s, fixed = TRUE)
            s <- gsub("\t", "\\t", s, fixed = TRUE)
            # ASCII control characters only: matched as bytes, `[[:cntrl:]]`
            # also hits UTF-8 continuation bytes and mangles non-ASCII text.
            gsub("[\001-\037\177]", " ", s, perl = TRUE)
        }, error = function(e) rep("<unprintable>", length(s)))
        paste0("\"", s, "\"")
    }
    jnum <- function(n) if (length(n) == 0L || is.na(n[[1L]])) "0" else format(as.numeric(n[[1L]]), scientific = FALSE)
    jbool <- function(b) if (isTRUE(b)) "true" else "false"
    jobj <- function(...) {
        x <- list(...)
        x <- x[!vapply(x, is.null, TRUE)]
        if (!length(x)) return("{}")
        paste0("{", paste0(jstr(names(x)), ":", unlist(x, use.names = FALSE), collapse = ","), "}")
    }
    jarr <- function(v) paste0("[", paste(v, collapse = ","), "]")
    env$jstr <- jstr

    internal <- function(expr) {
        old <- state$internal
        state$internal <- TRUE
        on.exit(state$internal <- old)
        expr
    }

    # ---- references ----------------------------------------------------------
    # `expr` is the R expression that reaches `x` from the selected frame
    # (DAP evaluateName: Watch, Copy as Expression, Open in Data Viewer);
    # "" for a frame environment itself.
    # `path` says where `x` lives, for Set Value on its children: an
    # environment and the steps (a binding name, then `[[` indices) from it.
    register <- function(x, expr = NULL, path = NULL) {
        id <- state$next_ref
        state$next_ref <- id + 1L
        assign(as.character(id), x, envir = state$refs)
        if (!is.null(expr)) assign(as.character(id), expr, envir = state$exprs)
        if (!is.null(path)) assign(as.character(id), path, envir = state$paths)
        id
    }
    lookup_expr <- function(id) get0(as.character(id), envir = state$exprs, inherits = FALSE)
    lookup_path <- function(id) get0(as.character(id), envir = state$paths, inherits = FALSE)
    # The position of each child row of a list or vector, by its label.
    # Row labels of a list's or vector's elements `idx`: the name when it is
    # unique, else the name with the position (`a [[2]]`, `a [2]`), else the
    # position (`[[3]]`, `[3]`, `[2,1]` in a matrix). Computed from the whole
    # names vector, so a label means the same whichever rows were fetched.
    child_labels <- function(x, idx) {
        listy <- typeof(x) %in% c("list", "pairlist")
        d <- sattr(x, "dim")
        out <- if (listy) sprintf("[[%d]]", idx)
               else if (length(d) == 2L) sprintf("[%d,%d]", (idx - 1) %% d[[1L]] + 1, (idx - 1) %/% d[[1L]] + 1)
               else sprintf("[%d]", idx)
        nms <- sattr(x, "names")
        if (!is.null(nms)) {
            nm <- nms[idx]
            named <- !is.na(nm) & nzchar(nm)
            dup <- nm %in% nms[duplicated(nms)]
            out[named & !dup] <- nm[named & !dup]
            out[named & dup] <- sprintf(if (listy) "%s [[%d]]" else "%s [%d]", nm[named & dup], idx[named & dup])
        }
        out
    }
    # The one element a row label names; a label that names two (a real name
    # equal to a generated `a [[1]]`) gives NA, and Set Value refuses it.
    find_child <- function(x, label) {
        w <- which(child_labels(x, seq_len(xlen(x))) == label)
        if (length(w) == 1L) w else if (length(w)) NA_integer_ else NULL
    }
    bt <- function(n) if (identical(make.names(n), n)) n else paste0("`", gsub("`", "\\`", n), "`")
    child_expr <- function(parent, name = NULL, index = NULL, atomic = FALSE) {
        if (is.null(parent)) return(NULL)
        if (!is.null(name)) return(if (nzchar(parent)) paste0(parent, "$", bt(name)) else bt(name))
        if (!nzchar(parent)) return(NULL)
        if (atomic) paste0(parent, "[", index, "]") else paste0(parent, "[[", index, "]]")
    }
    lookup_ref <- function(id) get0(as.character(id), envir = state$refs, inherits = FALSE)
    state$exprs <- new.env(parent = emptyenv())
    state$paths <- new.env(parent = emptyenv())
    env$reset_refs <- function() {
        state$refs <- new.env(parent = emptyenv())
        state$exprs <- new.env(parent = emptyenv())
        state$paths <- new.env(parent = emptyenv())
        invisible(NULL)
    }

    # ---- previews (no dispatch) ----------------------------------------------
    xlen <- function(x) .Call(N$xlength, x)
    # An attribute, or NULL when it is a vector some package implements
    # (ALTREP): attributes are read like values, so the same rule applies.
    sattr <- function(x, which) {
        a <- attr(x, which, exact = TRUE)
        if (!is.null(a) && !isTRUE(.Call(N$materialized, a))) NULL else a
    }
    trunc_str <- function(s, n = 200L) {
        s <- s[1L]
        if (is.na(s)) return("NA")
        if (nchar(s, type = "chars", allowNA = TRUE, keepNA = FALSE) > n) paste0(substr(s, 1L, n), "...") else s
    }
    short_type <- function(t) {
        switch(t, double = "num", integer = "int", character = "chr", logical = "lgl",
               complex = "cplx", raw = "raw", list = "list", t)
    }
    type_label <- function(x) {
        cls <- oldClass(x)
        if (!is.null(cls)) cls[[1L]] else short_type(typeof(x))
    }
    is_df <- function(cls) !is.null(cls) && "data.frame" %in% cls
    fmt_num <- function(v) {
        out <- formatC(v, digits = 7L, format = "g")
        out <- trimws(out)
        out[is.na(v)] <- "NA"
        out[is.nan(v)] <- "NaN"
        out
    }
    civil <- function(z) {
        ok <- !is.na(z) & is.finite(z)
        out <- rep("NA", length(z))
        if (!any(ok)) return(out)
        z <- floor(z[ok]) + 719468
        era <- floor(z / 146097)
        doe <- z - era * 146097
        yoe <- floor((doe - floor(doe / 1460) + floor(doe / 36524) - floor(doe / 146096)) / 365)
        y <- yoe + era * 400
        doy <- doe - (365 * yoe + floor(yoe / 4) - floor(yoe / 100))
        mp <- floor((5 * doy + 2) / 153)
        d <- doy - floor((153 * mp + 2) / 5) + 1
        m <- mp + ifelse(mp < 10, 3, -9)
        y <- y + (m <= 2)
        out[ok] <- sprintf("%04d-%02d-%02d", as.integer(y), as.integer(m), as.integer(d))
        out
    }
    fmt_posixct <- function(v, tz) {
        tz <- if (is.null(tz) || !length(tz)) "" else tz[[1L]]
        lt <- tryCatch(
            as.POSIXlt.POSIXct(structure(v, class = c("POSIXct", "POSIXt"), tzone = tz), tz = tz),
            error = function(e) NULL)
        if (is.null(lt)) return(paste(fmt_num(v), "s"))
        g <- function(f) .subset2(lt, f)
        out <- sprintf("%04d-%02d-%02d %02d:%02d:%02d", as.integer(g("year")) + 1900L,
                       as.integer(g("mon")) + 1L, as.integer(g("mday")), as.integer(g("hour")),
                       as.integer(g("min")), as.integer(floor(g("sec"))))
        zone <- g("zone")
        if (!is.null(zone)) out <- paste(out, zone)
        out[is.na(v)] <- "NA"
        out
    }
    elems <- function(x, i) {
        cls <- oldClass(x)
        v <- .subset(x, i)
        if (!is.null(cls)) {
            if ("factor" %in% cls && typeof(v) == "integer") {
                lev <- sattr(x, "levels")
                out <- as.character(lev[v])
                out[is.na(out)] <- "NA"
                return(out)
            }
            if ("Date" %in% cls && is.numeric(v)) return(civil(v))
            if ("POSIXct" %in% cls && is.numeric(v)) return(fmt_posixct(v, sattr(x, "tzone")))
            if ("difftime" %in% cls && is.numeric(v)) return(paste(fmt_num(v), sattr(x, "units")))
        }
        switch(typeof(v),
            logical = ifelse(is.na(v), "NA", ifelse(v, "TRUE", "FALSE")),
            integer = ifelse(is.na(v), "NA", as.character(v)),
            double = fmt_num(v),
            complex = as.character(v),
            character = ifelse(is.na(v), "NA", encodeString(v, quote = "\"")),
            raw = as.character(v),
            rep("?", length(v)))
    }
    env_label <- function(x) {
        cls <- oldClass(x)
        if (identical(x, globalenv())) return("<environment: R_GlobalEnv>")
        if (identical(x, baseenv())) return("<environment: base>")
        if (!is.null(cls) && "R6" %in% cls) return(sprintf("<%s>", cls[[1L]]))
        nm <- environmentName(x)
        if (nzchar(nm)) sprintf("<environment: %s>", nm) else "<environment>"
    }
    # Lengths and dims as plain integers (100000, not 1e+05).
    fmt_len <- function(n) format(n, scientific = FALSE, trim = TRUE)
    # "[3 x 4]" for a matrix or array, "[12]" otherwise.
    dims_label <- function(x, n) {
        d <- sattr(x, "dim")
        if (is.null(d)) fmt_len(n) else paste(fmt_len(d), collapse = " x ")
    }
    fn_label <- function(x) {
        args <- tryCatch(names(formals(x)), error = function(e) NULL)
        sprintf("function(%s)", paste(args, collapse = ", "))
    }
    preview_ <- function(x) {
        t <- typeof(x)
        cls <- oldClass(x)
        if (t == "S4") return(sprintf("<S4 %s>", if (is.null(cls)) "object" else cls[[1L]]))
        if (t == "environment") return(env_label(x))
        if (t %in% c("closure", "builtin", "special")) return(trunc_str(fn_label(x)))
        if (t == "symbol") return(as.character(x))
        if (t %in% c("language", "expression")) return(trunc_str(deparse(x, nlines = 1L, width.cutoff = 200L)[1L]))
        if (t == "NULL") return("NULL")
        if (!t %in% c("logical", "integer", "double", "complex", "character", "raw", "list", "pairlist")) {
            return(sprintf("<%s>", t))
        }
        if (foreign(x)) {
            return(sprintf("%s <ALTREP %s: not read>", type_label(x), .Call(N$altrep_class, x)))
        }
        n <- xlen(x)
        if (is_df(cls)) {
            nr <- .Call(N$nrow, x)
            if (is.na(nr)) nr <- "?"
            label <- if ("tbl_df" %in% cls) "tibble" else if ("data.table" %in% cls) "data.table" else "data.frame"
            return(sprintf("%s [%s x %s]", label, fmt_len(nr), fmt_len(n)))
        }
        if (t %in% c("list", "pairlist")) {
            return(sprintf("%s [%s]", if (is.null(cls)) "list" else cls[[1L]], fmt_len(n)))
        }
        if (!isTRUE(.Call(N$materialized, x))) {
            return(sprintf("%s [%s] (not materialized)", type_label(x), fmt_len(n)))
        }
        if (n == 0) return(sprintf("%s(0)", if (is.null(cls)) typeof(x) else cls[[1L]]))
        k <- min(n, 10)
        shown <- elems(x, seq_len(k))
        s <- paste(shown, collapse = " ")
        if (n > k) s <- paste(s, "...")
        if (n != 1 || !is.null(sattr(x, "dim"))) {
            s <- sprintf("%s [%s] %s", type_label(x), dims_label(x, n), s)
        }
        trunc_str(s)
    }
    preview <- function(x) tryCatch(preview_(x), error = function(e) "<preview unavailable>")
    env$preview <- preview

    # Counts for DAP's indexedVariables / namedVariables.
    # A vector whose class some package implements (ALTREP): its length and
    # elements come from that package's code, which must not run.
    foreign <- function(x) !isTRUE(.Call(N$materialized, x))
    child_counts <- function(x) {
        t <- typeof(x)
        if (t %in% c("list", "logical", "integer", "double", "complex", "character", "raw") && foreign(x)) {
            return(c(0, 0))
        }
        if (t == "environment") return(c(0, length(ls(x, all.names = TRUE, sorted = FALSE))))
        if (t == "S4") return(c(0, length(attributes(x))))
        if (t %in% c("list", "pairlist")) {
            n <- xlen(x)
            if (!is.null(sattr(x, "names")) || is_df(oldClass(x))) return(c(0, n))
            return(c(n, 0))
        }
        if (t %in% c("logical", "integer", "double", "complex", "character", "raw")) {
            n <- xlen(x)
            if (n > 1 && isTRUE(.Call(N$materialized, x))) return(c(n, 0))
        }
        c(0, 0)
    }
    var_json <- function(name, value, kind = "value", expr = NULL, path = NULL) {
        if (kind == "promise") {
            return(jobj(name = jstr(name), value = jstr(paste0("<promise: ", trunc_str(deparse(value, nlines = 1L, width.cutoff = 200L)[1L]), ">")),
                        type = jstr("promise"), variablesReference = "0",
                        presentationHint = jobj(kind = jstr("data"), lazy = "true")))
        }
        if (kind == "active") {
            return(jobj(name = jstr(name), value = jstr("<active binding>"), type = jstr("active binding"),
                        variablesReference = "0", presentationHint = jobj(kind = jstr("data"), lazy = "true")))
        }
        counts <- tryCatch(child_counts(value), error = function(e) c(0, 0))
        ref <- if (sum(counts) > 0) register(value, expr, path) else 0L
        jobj(name = jstr(name), value = jstr(preview(value)), type = jstr(tryCatch(type_label(value), error = function(e) "?")),
             variablesReference = jnum(ref),
             evaluateName = if (!is.null(expr)) jstr(expr) else NULL,
             indexedVariables = if (counts[1] > 0) jnum(counts[1]) else NULL,
             namedVariables = if (counts[2] > 0) jnum(counts[2]) else NULL)
    }
    page <- function(n, start, count) {
        start <- max(0, start)
        if (count <= 0) count <- n
        if (start >= n) return(integer())
        seq.int(start + 1, min(n, start + count))
    }
    children <- function(x, start, count, filter, pexpr = NULL, ppath = NULL) {
        t <- typeof(x)
        out <- character()
        if (t != "environment" && t != "S4" && foreign(x)) return(out)
        if (t == "environment") {
            nms <- ls(x, all.names = TRUE, sorted = TRUE)
            for (i in page(length(nms), start, count)) {
                b <- .Call(N$binding, x, nms[[i]])
                out <- c(out, var_json(nms[[i]], b[[2L]], b[[1L]], child_expr(pexpr, name = nms[[i]]),
                                       list(env = x, steps = list(nms[[i]]))))
            }
            return(out)
        }
        if (t == "S4") {
            a <- attributes(x)
            nms <- names(a)
            for (i in page(length(a), start, count)) out <- c(out, var_json(paste0("@", nms[[i]]), a[[i]]))
            return(out)
        }
        if (t %in% c("list", "pairlist")) {
            n <- xlen(x)
            nms <- sattr(x, "names")
            idx <- page(n, start, count)
            labels <- child_labels(x, idx)
            for (j in seq_along(idx)) {
                i <- idx[[j]]
                nm <- labels[[j]]
                # `x$a` finds the first `a`: a repeated name needs its index.
                unique_name <- !is.null(nms) && identical(nm, nms[[i]])
                ex <- if (unique_name) child_expr(pexpr, name = nms[[i]]) else child_expr(pexpr, index = i)
                cpath <- if (!is.null(ppath)) list(env = ppath$env, steps = c(ppath$steps, list(as.integer(i))))
                out <- c(out, var_json(nm, .subset2(x, i), "value", ex, cpath))
            }
            return(out)
        }
        if (t %in% c("logical", "integer", "double", "complex", "character", "raw")) {
            n <- xlen(x)
            idx <- page(n, start, count)
            if (length(idx)) {
                vals <- elems(x, idx)
                labels <- child_labels(x, idx)
                for (j in seq_along(idx)) {
                    i <- idx[[j]]
                    ex <- child_expr(pexpr, index = i, atomic = TRUE)
                    label <- labels[[j]]
                    out <- c(out, jobj(name = jstr(label), value = jstr(vals[[j]]),
                                       type = jstr(type_label(x)), variablesReference = "0",
                                       evaluateName = if (!is.null(ex)) jstr(ex) else NULL))
                }
            }
            return(out)
        }
        out
    }
    env$variables <- function(ref, start, count, filter) internal(tryCatch({
        x <- lookup_ref(as.integer(ref))
        if (is.null(x) && !exists(as.character(ref), envir = state$refs, inherits = FALSE)) {
            return(jarr(character()))
        }
        jarr(children(x, as.numeric(start), as.numeric(count), filter, lookup_expr(as.integer(ref)),
                      lookup_path(as.integer(ref))))
    }, error = function(e) jarr(character())))

    # ---- stops ---------------------------------------------------------------
    srcref_loc <- function(sr) {
        if (is.null(sr) || length(sr) < 6L) return(NULL)
        sf <- attr(sr, "srcfile")
        fn <- if (is.environment(sf)) get0("filename", envir = sf, inherits = FALSE) else NULL
        if (is.null(fn) || !length(fn)) fn <- ""
        wd <- if (is.environment(sf)) get0("wd", envir = sf, inherits = FALSE) else NULL
        # Absolute: `/x`, and on Windows `\x`, `C:/x`, `C:\x`.
        if (nzchar(fn) && !grepl("^([A-Za-z]:)?[/\\\\]", fn) && !startsWith(fn, "<") && !is.null(wd) && length(wd)) {
            fn <- file.path(wd, fn)
        }
        c(fn, sr[[1L]], sr[[5L]], sr[[3L]], sr[[6L]])
    }
    call_name <- function(cl) {
        f <- tryCatch(cl[[1L]], error = function(e) NULL)
        if (is.symbol(f)) return(as.character(f))
        if (is.call(f)) return(trunc_str(deparse(f, nlines = 1L, width.cutoff = 60L)[1L], 60L))
        "<anonymous>"
    }
    # Called as hidden console input at a Browse> prompt: R evaluates it in
    # the browsed environment, so parent.frame() is that environment even
    # while a promise is being forced (RStudio's capture trick, design sec. 4).
    env$capture <- function() {
        lv <- get0(".Last.value", envir = baseenv())
        internal(tryCatch({
            depth <- sys.nframe()
            n <- depth - 1L
            if (!is.null(state$cut)) n <- min(n, state$cut)
            calls <- if (n > 0) sys.calls()[seq_len(n)] else list()
            frames <- if (n > 0) sys.frames()[seq_len(n)] else list()
            funs <- if (n > 0) lapply(seq_len(n), function(i) sys.function(i)) else list()
            hidden <- vapply(funs, function(f) {
                identical(environment(f), here) || identical(f, state$hook)
            }, TRUE)
            state$frames <- frames
            state$funs <- funs
            state$browse_env <- parent.frame()
            fbp <- n > 0 && any(vapply(state$fbp, function(g) identical(g, funs[[n]]), TRUE))
            items <- character()
            top_nosrc <- FALSE
            entry <- NULL
            first <- TRUE
            for (i in rev(seq_len(n))) {
                if (hidden[[i]]) next
                loc <- if (i < n) {
                    srcref_loc(attr(calls[[i + 1L]], "srcref"))
                } else if (!is.null(state$cut) && n < length(sys.calls())) {
                    # An exception or pause stop: the top frame is where the
                    # condition was signalled; the call it was running then
                    # (`stop(...)`) has the line. Some R versions report no
                    # current srcref for the browser opened there.
                    srcref_loc(attr(sys.calls()[[n + 1L]], "srcref"))
                }
                f <- funs[[i]]
                # A function with no srcref (base R, an installed package)
                # gets its deparsed text as a virtual source (design sec. 6).
                nosrc <- is.function(f) && !is.primitive(f) && is.null(attr(f, "srcref"))
                if (first) {
                    top_nosrc <- nosrc
                    first <- FALSE
                    # The line of the body's opening brace: a step into the
                    # function first stops there, on the whole body.
                    b <- if (!nosrc && is.function(f) && !is.primitive(f)) body(f)
                    if (is.call(b) && identical(b[[1L]], quote(`{`))) {
                        bs <- attr(b, "srcref")
                        if (length(bs)) entry <- as.integer(bs[[1L]])[[1L]]
                    }
                }
                fsrc <- if (nosrc) {
                    tryCatch(paste(deparse(f, width.cutoff = 80L, nlines = 2000L), collapse = "\n"),
                             error = function(e) NULL)
                } else NULL
                items <- c(items, jobj(id = jnum(i), name = jstr(call_name(calls[[i]])),
                                       loc = if (is.null(loc)) "null" else jarr(c(jstr(loc[[1L]]), loc[-1L])),
                                       fsrc = if (!is.null(fsrc)) jstr(paste0(call_name(calls[[i]]), " <- ", fsrc)) else NULL))
            }
            gloc <- if (n > 0) srcref_loc(attr(calls[[1L]], "srcref")) else state$top_loc
            items <- c(items, jobj(id = "0", name = jstr("<top level>"),
                                   loc = if (is.null(gloc)) "null" else jarr(c(jstr(gloc[[1L]]), gloc[-1L]))))
            rpc("captured", jarr(items), paste(c(if (fbp) "fbp", if (top_nosrc) "nosrc",
                                                 if (!is.null(entry)) paste0("entry:", entry)), collapse = ","))
        }, error = function(e) rpc("captured", "[]")))
        invisible(lv)
    }
    frame_env <- function(frame) {
        frame <- as.integer(frame)
        if (is.na(frame) || frame <= 0L) return(globalenv())
        if (frame <= length(state$frames)) return(state$frames[[frame]])
        globalenv()
    }
    # Debug Console completions: R's own completer (as at the console
    # prompt) plus the selected frame's names, which it can't see.
    env$completions <- function(head, frame) internal(tryCatch({
        e <- frame_env(frame)
        utils:::.assignLinebuffer(head)
        utils:::.assignEnd(nchar(head, type = "chars"))
        token <- utils:::.guessTokenFromLine()
        utils:::.completeToken()
        items <- utils:::.retrieveCompletions()
        if (grepl("^[.A-Za-z][.A-Za-z0-9_]*$", token) && !identical(e, globalenv())) {
            local <- ls(e, all.names = startsWith(token, "."))
            items <- c(local[startsWith(local, token)], items)
        }
        jobj(token = jstr(token), items = jarr(jstr(unique(items))))
    }, error = function(e) "{}"))
    env$scopes <- function(frame) internal(tryCatch({
        e <- frame_env(frame)
        out <- jobj(name = jstr(if (identical(e, globalenv())) "Global" else "Locals"),
                    presentationHint = jstr("locals"), variablesReference = jnum(register(e, "", list(env = e, steps = list()))),
                    namedVariables = jnum(length(ls(e, all.names = TRUE, sorted = FALSE))),
                    expensive = jbool(identical(e, globalenv())))
        if (!identical(e, globalenv())) {
            p <- parent.env(e)
            # Expressions for these must not resolve to a shadowing local:
            # globals are reached explicitly; an enclosing environment has
            # no reliable name, so its values get none.
            if (!identical(p, globalenv()) && !identical(p, emptyenv())) {
                out <- c(out, jobj(name = jstr("Enclosing"), variablesReference = jnum(register(p)), expensive = "true"))
            }
            out <- c(out, jobj(name = jstr("Global"), variablesReference = jnum(register(globalenv(), "base::globalenv()")), expensive = "true"))
        }
        jarr(out)
    }, error = function(e) jarr(character())))

    # ---- evaluate / hover / set ----------------------------------------------
    env$evaluate <- function(expr, frame, context, timeout) internal(tryCatch({
        e <- frame_env(frame)
        old <- tracingState(FALSE)
        on.exit(tracingState(old), add = TRUE)
        lim <- as.numeric(timeout)
        if (is.finite(lim) && lim > 0) {
            setTimeLimit(elapsed = lim, transient = TRUE)
            on.exit(setTimeLimit(elapsed = Inf), add = TRUE)
        }
        # Everything the expression prints, messages and warnings included,
        # goes to the Debug Console rather than the terminal.
        notes <- character()
        res <- NULL
        printed <- utils::capture.output(
            res <- tryCatch(
                withCallingHandlers(
                    withVisible(eval(parse(text = expr, keep.source = FALSE), e)),
                    message = function(m) {
                        notes <<- c(notes, sub("\n$", "", conditionMessage(m)))
                        invokeRestart("muffleMessage")
                    },
                    warning = function(w) {
                        notes <<- c(notes, paste("Warning:", conditionMessage(w)))
                        invokeRestart("muffleWarning")
                    }),
                error = function(err) err),
            type = "output")
        if (inherits(res, "error")) {
            msg <- paste(c(printed, notes, paste("Error:", conditionMessage(res))), collapse = "\n")
            return(jobj(error = jstr(msg)))
        }
        v <- res$value
        text <- if (context %in% c("repl", "clipboard")) {
            shown <- if (isTRUE(res$visible)) utils::capture.output(print(v)) else character()
            paste(c(printed, notes, shown), collapse = "\n")
        } else preview(v)
        counts <- tryCatch(child_counts(v), error = function(e) c(0, 0))
        ref <- if (sum(counts) > 0) register(v, paste0("(", expr, ")")) else 0L
        jobj(result = jstr(text), type = jstr(tryCatch(type_label(v), error = function(e) "?")),
             variablesReference = jnum(ref),
             indexedVariables = if (counts[1] > 0) jnum(counts[1]) else NULL,
             namedVariables = if (counts[2] > 0) jnum(counts[2]) else NULL)
    }, error = function(e) jobj(error = jstr(conditionMessage(e)))))

    # Hover resolves only forms that run no R code (design sec. 6).
    resolve <- function(e, scope) {
        if (is.symbol(e)) {
            name <- as.character(e)
            s <- scope
            while (!identical(s, emptyenv())) {
                b <- .Call(N$binding, s, name)
                kind <- b[[1L]]
                if (kind == "value" || kind == "forced") return(list(ok = TRUE, value = b[[2L]]))
                if (kind == "promise") return(list(ok = TRUE, value = b[[2L]], promise = TRUE))
                if (kind == "active") return(list(ok = FALSE))
                s <- parent.env(s)
            }
            return(list(ok = FALSE))
        }
        if (is.numeric(e) || is.character(e) || is.logical(e)) return(list(ok = TRUE, value = e))
        if (is.call(e) && length(e) == 3L && is.symbol(e[[1L]])) {
            op <- as.character(e[[1L]])
            if (op %in% c("$", "[[", "@")) {
                target <- resolve(e[[2L]], scope)
                if (!isTRUE(target$ok) || isTRUE(target$promise)) return(list(ok = FALSE))
                x <- target$value
                key <- e[[3L]]
                # `x$a` names `a`; in `x[[i]]` the symbol is a variable,
                # which hover doesn't evaluate.
                if (is.symbol(key)) {
                    if (op != "$") return(list(ok = FALSE))
                    key <- as.character(key)
                }
                if (!(is.character(key) || is.numeric(key)) || length(key) != 1L) return(list(ok = FALSE))
                if (op == "@") {
                    if (!isS4(x) || !is.character(key)) return(list(ok = FALSE))
                    return(list(ok = TRUE, value = attr(x, key, exact = TRUE)))
                }
                cls <- oldClass(x)
                if (typeof(x) == "environment" && is.character(key) && (is.null(cls) || "R6" %in% cls)) {
                    b <- .Call(N$binding, x, key)
                    if (b[[1L]] %in% c("value", "forced")) return(list(ok = TRUE, value = b[[2L]]))
                    return(list(ok = FALSE))
                }
                if (typeof(x) == "list" && (is.null(cls) || all(cls %in% c("data.frame", "tbl_df", "tbl", "data.table")))) {
                    # A package-implemented list (or names vector) would run
                    # that package's code on indexing.
                    if (foreign(x) || (is.character(key) && is.null(sattr(x, "names")) &&
                                       !is.null(attr(x, "names", exact = TRUE)))) {
                        return(list(ok = FALSE))
                    }
                    v <- tryCatch(.subset2(x, key, exact = TRUE), error = function(err) NULL)
                    return(list(ok = TRUE, value = v))
                }
            }
        }
        list(ok = FALSE)
    }
    env$hover <- function(expr, frame) internal(tryCatch({
        e <- str2lang(expr)
        r <- resolve(e, frame_env(frame))
        if (!isTRUE(r$ok)) return(jobj(error = jstr("not available")))
        if (isTRUE(r$promise)) {
            return(jobj(result = jstr(paste0("<promise: ", trunc_str(deparse(r$value, nlines = 1L)[1L]), ">")),
                        variablesReference = "0"))
        }
        v <- r$value
        counts <- tryCatch(child_counts(v), error = function(e) c(0, 0))
        ref <- if (sum(counts) > 0) register(v) else 0L
        jobj(result = jstr(preview(v)), type = jstr(type_label(v)), variablesReference = jnum(ref),
             indexedVariables = if (counts[1] > 0) jnum(counts[1]) else NULL,
             namedVariables = if (counts[2] > 0) jnum(counts[2]) else NULL)
    }, error = function(e) jobj(error = jstr("not available"))))

    env$set_variable <- function(ref, name, value, frame) internal(tryCatch({
        container <- lookup_ref(as.integer(ref))
        if (is.environment(container)) {
            # The new value is an expression in the variable's own scope (a
            # frame's locals see each other), as typing it at Browse> would be.
            v <- eval(parse(text = value, keep.source = FALSE), container)
            assign(name, v, envir = container)
        } else {
            # An element of a list or vector: assign through the path from
            # the environment that holds it, `x[["a"]][[2]] <- v`, as R would.
            p <- lookup_path(as.integer(ref))
            i <- find_child(container, name)
            if (is.null(p) || !length(p$steps) || is.null(i)) {
                return(jobj(error = jstr("this value can't be changed from here")))
            }
            if (is.na(i)) return(jobj(error = jstr("two elements have this name; change it from the Debug Console")))
            v <- eval(parse(text = value, keep.source = FALSE), p$env)
            target <- as.name(p$steps[[1L]])
            for (st in p$steps[-1L]) target <- call("[[", target, st)
            # Quoted: `v` is the value itself, not code to run again (a
            # language object would otherwise be evaluated).
            eval(call("<-", call("[[", target, as.integer(i)), call("quote", v)), p$env)
        }
        counts <- tryCatch(child_counts(v), error = function(e) c(0, 0))
        jobj(value = jstr(preview(v)), type = jstr(type_label(v)),
             variablesReference = jnum(if (sum(counts) > 0) register(v) else 0L))
    }, error = function(e) jobj(error = jstr(conditionMessage(e)))))

    # ---- breakpoints ---------------------------------------------------------
    hit_ok <- function(cond, count) {
        cond <- trimws(cond)
        m <- regmatches(cond, regexec("^(>=|<=|==|>|<|%)?\\s*([0-9]+)$", cond))[[1L]]
        if (length(m) != 3L) return(TRUE)
        n <- as.numeric(m[[3L]])
        op <- if (nzchar(m[[2L]])) m[[2L]] else ">="
        switch(op, ">=" = count >= n, "<=" = count <= n, "==" = count == n,
               ">" = count > n, "<" = count < n, "%" = n > 0 && count %% n == 0, TRUE)
    }
    interpolate <- function(msg, scope) {
        m <- gregexpr("\\{[^{}]+\\}", msg)
        parts <- regmatches(msg, m)[[1L]]
        if (!length(parts)) return(msg)
        vals <- vapply(parts, function(p) {
            code <- substr(p, 2L, nchar(p) - 1L)
            tryCatch(paste(format(eval(parse(text = code, keep.source = FALSE), scope)), collapse = " "),
                     error = function(e) paste0("<", conditionMessage(e), ">"))
        }, "")
        regmatches(msg, m) <- list(vals)
        msg
    }
    # The probe's hook (installed as option `raven.debug_hook`). It must force
    # `b` as its very last action so the single hidden `n` that follows a hit
    # lands on the anchored statement (design sec. 5.2).
    hook <- function(id, env, b) {
        if (isTRUE(state$internal)) return(invisible(NULL))
        info <- rpc("bp", id)
        if (!nzchar(info)) return(invisible(NULL))
        f <- strsplit(info, US, fixed = TRUE)[[1L]]
        f <- c(f, "", "", "")[1:3]
        if (nzchar(f[[1L]])) {
            ok <- internal(tryCatch(isTRUE(eval(parse(text = f[[1L]], keep.source = FALSE), env)),
                                    error = function(e) {
                                        rpc("log", id, paste0("Breakpoint condition failed: ", conditionMessage(e)))
                                        TRUE
                                    }))
            if (!ok) return(invisible(NULL))
        }
        count <- as.numeric(rpc("hit", id))
        if (nzchar(f[[2L]]) && !hit_ok(f[[2L]], count)) return(invisible(NULL))
        if (nzchar(f[[3L]])) {
            rpc("log", id, internal(interpolate(f[[3L]], env)))
            return(invisible(NULL))
        }
        verdict <- rpc("stop", id, if (isTRUE(.Call(N$rdebug, env))) "1" else "0")
        if (!identical(verdict, "stop")) return(invisible(NULL))
        if (identical(get0("browser", envir = env, mode = "function"), base::browser)) b
        else base::eval(quote(base::browser()), env)
    }
    state$hook <- hook

    # Function breakpoints (DAP setFunctionBreakpoints): `debug()` on each.
    find_fun <- function(name, where = globalenv()) {
        if (grepl("::", name, fixed = TRUE)) {
            p <- strsplit(name, ":::?")[[1L]]
            if (length(p) != 2L) return(NULL)
            # Never load a package as a side effect; it binds once loaded.
            if (!isNamespaceLoaded(p[[1L]])) return(NULL)
            return(tryCatch(get(p[[2L]], envir = asNamespace(p[[1L]]), mode = "function"), error = function(e) NULL))
        }
        get0(name, envir = where, mode = "function")
    }
    # `state$fbp_names` are the requested names; `state$fbp` the closures
    # currently debug()ged for them. Names are re-resolved at every top-level
    # prompt, so a function defined (or redefined) later binds then.
    state$fbp_names <- character()
    state$fbp_owned <- list()
    state$fbp_local <- list()
    # `state$fbp_owned[[nm]]`: Raven turned debugging on for that closure
    # (it wasn't already debug()ged by the user), so Raven may turn it off.
    release_fbp <- function(nm) {
        old <- state$fbp[[nm]]
        if (!is.null(old) && isTRUE(state$fbp_owned[[nm]])) try(undebug(old), silent = TRUE)
        state$fbp[[nm]] <- NULL
        state$fbp_owned[[nm]] <- NULL
        state$fbp_local[[nm]] <- NULL
    }
    # `where`: the environment names resolve from, global at prompts, or
    # the environment a file is being sourced into (`source(local = TRUE)`).
    # A function bound from such a local environment stays bound at later
    # prompts while no global function of that name exists.
    bind_fbp <- function(nm, where = globalenv()) {
        f <- find_fun(nm, where)
        old <- state$fbp[[nm]]
        if (is.null(f) && identical(where, globalenv()) && !is.null(old) && isTRUE(state$fbp_local[[nm]])) {
            return("")
        }
        # The old closure may live on elsewhere (`old <- f`): whenever the
        # name no longer resolves to it, it must stop stopping.
        why <- if (is.null(f) || !is.function(f)) "function not found"
               else if (is.primitive(f)) "can't debug a primitive"
               else ""
        if (!is.null(old) && (nzchar(why) || !identical(old, f))) release_fbp(nm)
        if (nzchar(why)) return(why)
        if (!is.null(state$fbp[[nm]]) && isdebugged(f)) return("")
        owned <- !isdebugged(f)
        ok <- tryCatch({ debug(f); TRUE }, error = function(e) FALSE)
        if (!ok) return("debug() failed")
        state$fbp[[nm]] <- f
        state$fbp_owned[[nm]] <- owned
        state$fbp_local[[nm]] <- !identical(where, globalenv())
        ""
    }
    fbp_status <- function(where = globalenv()) {
        vapply(state$fbp_names, bind_fbp, "", where = where)
    }
    env$function_breakpoints <- function(spec) internal(tryCatch({
        names <- if (nzchar(spec)) strsplit(spec, US, fixed = TRUE)[[1L]] else character()
        for (old in names(state$fbp)) {
            if (!old %in% names) release_fbp(old)
        }
        state$fbp_names <- names
        st <- fbp_status()
        jarr(vapply(st, function(m) jobj(verified = jbool(!nzchar(m)), message = if (nzchar(m)) jstr(m) else NULL), ""))
    }, error = function(e) jarr(character())))

    # ---- per-stop state (design sec. 4, sec. 5.4.6) -----------------------------------
    # While stopped, an empty line must not repeat `n`; R's JIT is off for
    # the duration of a step-in (Ark's fix for positron#11890). Each change
    # is undone only if the value is still the one Raven set (sec. 8.3).
    # A new stop (not a re-capture of the same one after typed input, whose
    # Variables references the client may still be using).
    env$on_stop <- function() internal(tryCatch({
        env$reset_refs()
        if (is.null(state$nl_saved)) {
            state$nl_saved <- list(getOption("browserNLdisabled"))
            options(browserNLdisabled = TRUE)
        }
        "ok"
    }, error = function(e) "err"))
    # Step Over / Step Out leaving a function stop in its caller, as in
    # other debuggers. R keeps stepping in the caller only if the caller's
    # frame has its step flag set, which it has only when the user stepped
    # into this function, not when a breakpoint stopped here. So flag the
    # nearest caller with source (skipping base R and package frames such as
    # lapply's), and remember it: Continue must not stop there.
    state$step_flags <- list()
    flag_caller <- function() {
        frames <- state$frames
        funs <- state$funs
        k <- 0L
        for (i in rev(seq_along(frames))) {
            if (identical(frames[[i]], state$browse_env)) {
                k <- i
                break
            }
        }
        if (k <= 1L) return(invisible(NULL))
        for (i in rev(seq_len(k - 1L))) {
            f <- funs[[i]]
            if (!is.function(f) || is.primitive(f)) next
            if (identical(environment(f), here) || identical(f, state$hook)) next
            if (is.null(attr(f, "srcref"))) next
            was <- .Call(N$set_rdebug, frames[[i]], 1L)
            if (!isTRUE(was)) state$step_flags[[length(state$step_flags) + 1L]] <- frames[[i]]
            break
        }
        invisible(NULL)
    }
    clear_step_flags <- function() {
        for (e in state$step_flags) .Call(N$set_rdebug, e, 0L)
        state$step_flags <- list()
    }
    env$on_resume <- function(cmd) internal(tryCatch({
        if (identical(cmd, "s") && is.null(state$jit_saved)) state$jit_saved <- compiler::enableJIT(0L)
        if (cmd %in% c("n", "f")) {
            # Leaving this frame by Step Out: it runs on unstepped (the
            # console feeds `c`), so its breakpoints stop as usual.
            if (identical(cmd, "f")) .Call(N$set_rdebug, state$browse_env, 0L)
            flag_caller()
        } else if (cmd %in% c("c", "Q")) {
            # Continue runs to the next breakpoint, as in other debuggers. R's
            # own `c` clears only this frame's step flag; callers flagged by
            # earlier steps (R's or Raven's) would stop again on return.
            for (e in state$frames) if (is.environment(e)) .Call(N$set_rdebug, e, 0L)
            clear_step_flags()
        }
        "ok"
    }, error = function(e) "err"))
    # The traceback to print at this top-level prompt (a JSON array), and
    # the candidate is gone either way. Printed only when R reset the console
    # since the last prompt (an uncaught error or interrupt; an interrupt
    # already cleared the candidate) and R's last error message is this one:
    # signalCondition() of an error object reaches the handler but needn't
    # end anything. When in doubt, nothing is printed.
    take_traceback <- function(reset) {
        cand <- state$err_cand
        state$err_cand <- NULL
        if (is.null(cand) || !reset) return("[]")
        if (nzchar(cand$msg) && !grepl(substr(cand$msg, 1L, 200L), geterrmessage(), fixed = TRUE)) return("[]")
        jarr(jstr(cand$lines))
    }
    env$at_prompt <- function(top, reset = "FALSE") internal(tryCatch({
        if (!is.null(state$jit_saved)) {
            if (identical(compiler::enableJIT(-1L), 0L)) compiler::enableJIT(state$jit_saved)
            state$jit_saved <- NULL
        }
        if (isTRUE(as.logical(top))) {
            clear_step_flags()
            if (!is.null(state$nl_saved)) {
                if (isTRUE(getOption("browserNLdisabled"))) options(browserNLdisabled = state$nl_saved[[1L]])
                state$nl_saved <- NULL
            }
            st <- fbp_status()
            return(paste0(masked_names(), "\x1e", paste(ifelse(nzchar(st), "0", "1"), collapse = ""),
                          "\x1e", take_traceback(isTRUE(as.logical(reset)))))
        }
        ""
    }, error = function(e) ""))

    # ---- callee identity (design sec. 5.3) ---------------------------------------
    lazy_promise <- function(expr) is.call(expr) && identical(expr[[1L]], quote(lazyLoadDBfetch))
    lookup_fun <- function(name, from) {
        s <- from
        while (!identical(s, emptyenv())) {
            if (exists(name, envir = s, inherits = FALSE)) {
                b <- .Call(N$binding, s, name)
                kind <- b[[1L]]
                if (kind == "active") return(list(ok = FALSE))
                if (kind == "promise") {
                    pkgenv <- isNamespace(s) || identical(s, baseenv()) ||
                        startsWith(environmentName(s), "package:")
                    if (!lazy_promise(b[[2L]]) || !pkgenv) return(list(ok = FALSE))
                    v <- get(name, envir = s, inherits = FALSE)
                } else {
                    v <- b[[2L]]
                }
                if (is.function(v)) return(list(ok = TRUE, value = v))
            }
            s <- parent.env(s)
        }
        list(ok = FALSE)
    }
    same_fun <- function(found, expected) {
        if (identical(found, expected)) return(TRUE)
        if (isS4(found) && methods::is(found, "standardGeneric")) {
            d <- tryCatch(methods::getMethod(found, "ANY"), error = function(e) NULL)
            return(!is.null(d) && identical(body(d), body(expected)) && identical(formals(d), formals(expected)))
        }
        FALSE
    }
    # Core syntax and base functions in the known-callee table that a
    # function binding in the global or an attached environment now masks
    # (the advisory rebinding detector, design sec. 5.3 rule 2).
    watched <- c("{", "(", "if", "for", "while", "repeat", "<-", "=", "<<-", "function", "::", "browser",
                 "local", "tryCatch", "withCallingHandlers", "try", "suppressWarnings", "suppressMessages",
                 "with", "within", "system.time", "invisible", "lapply", "sapply", "vapply", "Map", "Filter",
                 "Reduce", "do.call")
    masked_names <- function() {
        out <- character()
        for (nm in watched) {
            expected <- get(nm, envir = baseenv())
            found <- lookup_fun(nm, globalenv())
            if (!isTRUE(found$ok) || !same_fun(found$value, expected)) out <- c(out, nm)
        }
        paste(out, collapse = US)
    }

    # `spec` is "pkg::name" entries joined by US; returns the confirmed ones.
    env$verify_callees <- function(spec, from = globalenv()) internal(tryCatch({
        items <- if (nzchar(spec)) strsplit(spec, US, fixed = TRUE)[[1L]] else character()
        ok <- character()
        for (it in items) {
            p <- strsplit(it, "::", fixed = TRUE)[[1L]]
            if (length(p) != 2L || !isNamespaceLoaded(p[[1L]])) next
            expected <- tryCatch(getExportedValue(p[[1L]], p[[2L]]), error = function(e) NULL)
            if (is.null(expected)) next
            found <- lookup_fun(p[[2L]], from)
            if (isTRUE(found$ok) && same_fun(found$value, expected)) ok <- c(ok, it)
        }
        paste(ok, collapse = US)
    }, error = function(e) ""))

    # Top-level expressions of a submission: one c(first line, first col,
    # last line, last col) per expression (character columns), or "" when
    # R can't parse it (the console then feeds it raw).
    env$split_exprs <- function(text) internal(tryCatch({
        ex <- parse(text = text, keep.source = TRUE)
        sr <- attr(ex, "srcref")
        if (length(ex) == 0L || length(sr) != length(ex)) return("")
        jarr(vapply(sr, function(s) jarr(c(s[[1L]], s[[5L]], s[[3L]], s[[6L]])), ""))
    }, error = function(e) ""))

    # ---- file-level injection (source() and pkgload/shiny) -------------------
    annotate_file <- function(path, text, from) {
        need <- rpc("plan_file", path, text)
        if (identical(need, "-")) return(NULL)
        verified <- env$verify_callees(need, from)
        out <- rpc("render_file", path, verified)
        if (nzchar(out)) out else NULL
    }
    # Ark's de facto hook (design sec. 5.3, owner decision 1): pkgload >= 1.5 and
    # shiny >= 1.13 call it with the file's text and a file:/// URI and parse
    # whatever text it returns.
    env$ark_annotate_source <- function(source, uri, with_visible = FALSE) {
        if (isTRUE(state$internal)) return(NULL)
        internal(tryCatch({
            path <- sub("^file://", "", uri)
            text <- paste(source, collapse = "\n")
            annotate_file(path, text, globalenv())
        }, error = function(e) NULL))
    }
    source_args <- c("local", "echo", "print.eval", "verbose", "prompt.echo", "max.deparse.length",
                     "width.cutoff", "deparseCtrl", "spaced", "keep.source", "chdir", "encoding", "skip.echo")
    # A top-level probe in a sourced file would call browser() outside any
    # braces, where the console's hidden `n` finishes the probe and source()
    # runs on past the statement. Fuse each top-level probe with the
    # statement it guards into `{probe; statement}`, with srcrefs, so the
    # step lands on the statement as it does inside functions.
    is_probe <- function(s) identical(utils::getSrcFilename(s), "<raven-probe>")
    fuse_probes <- function(exprs) {
        sr <- attr(exprs, "srcref")
        if (is.null(sr) || length(sr) != length(exprs)) return(exprs)
        probe <- vapply(sr, is_probe, TRUE)
        if (!any(probe)) return(exprs)
        out <- list()
        osr <- list()
        i <- 1L
        n <- length(exprs)
        while (i <= n) {
            if (probe[[i]] && i < n && !probe[[i + 1L]]) {
                blk <- call("{", exprs[[i]], exprs[[i + 1L]])
                attr(blk, "srcref") <- list(sr[[i + 1L]], sr[[i]], sr[[i + 1L]])
                out[[length(out) + 1L]] <- blk
                osr[[length(osr) + 1L]] <- sr[[i + 1L]]
                i <- i + 2L
            } else {
                out[length(out) + 1L] <- list(exprs[[i]])
                osr[[length(osr) + 1L]] <- sr[[i]]
                i <- i + 1L
            }
        }
        res <- as.expression(out)
        attr(res, "srcref") <- osr
        attr(res, "srcfile") <- attr(exprs, "srcfile")
        attr(res, "wholeSrcref") <- attr(exprs, "wholeSrcref")
        res
    }
    # A function breakpoint whose function a sourced file defines must bind
    # before the file goes on to call it, not at the next prompt: after each
    # top-level assignment to a watched name, run a binding pass. The
    # statement keeps its srcref, so echo is unchanged.
    # Wraps the assignment, so the file's last value (`source()$value`)
    # and its invisibility are unchanged; binds from the environment the
    # assignment ran in.
    rebind_after <- function(value) {
        force(value)
        where <- parent.frame()
        internal(tryCatch(fbp_status(where), error = function(e) NULL))
        invisible(value)
    }
    assigned_name <- function(e) {
        if (is.call(e) && identical(e[[1L]], quote(`{`)) && length(e) == 3L) e <- e[[3L]]
        if (is.call(e) && length(e) == 3L && as.character(e[[1L]])[[1L]] %in% c("<-", "=", "<<-") &&
            is.name(e[[2L]])) as.character(e[[2L]]) else ""
    }
    bind_fbps_after_definitions <- function(exprs) {
        names <- state$fbp_names
        if (!length(names)) return(NULL)
        hits <- vapply(as.list(exprs), function(e) assigned_name(e) %in% names, TRUE)
        if (!any(hits)) return(NULL)
        for (i in which(hits)) exprs[[i]] <- as.call(list(rebind_after, exprs[[i]]))
        exprs
    }
    # `source(echo = TRUE)` echoes the lines each top-level srcref spans in its
    # srcfile, which for annotated text would show `#line` directives and
    # probes. Point the srcrefs at the user's own lines (the `#line`-mapped
    # numbers), and give each top-level probe the span of the statement it
    # guards: the statement echoes before its probe stops, and not again.
    # Only the echo reads these;
    # stops use the srcrefs inside the expressions, which are untouched.
    echo_original <- function(exprs, path, lines) {
        sr <- attr(exprs, "srcref")
        if (is.null(sr) || !length(sr)) return(exprs)
        of <- srcfilecopy(path, lines)
        out <- vector("list", length(sr))
        nxt <- NULL
        for (i in rev(seq_along(sr))) {
            if (is_probe(sr[[i]])) {
                out[[i]] <- nxt
            } else {
                out[[i]] <- nxt <- srcref(of, as.integer(sr[[i]])[1:6])
            }
        }
        attr(exprs, "srcref") <- out
        attr(exprs, "srcfile") <- of
        attr(exprs, "wholeSrcref") <- srcref(of, c(1L, 1L, length(lines), 1L, 1L, 1L))
        exprs
    }
    env$source_hook <- function(file, local = FALSE, ...) {
        # Scripts find their own path with `sys.frame(1)$ofile`, which
        # base source() binds. With this wrapper in place, frame 1 is this
        # one, so bind it here too.
        if (!missing(file)) ofile <- file
        orig <- state$orig_source
        if (is.null(orig)) orig <- base::source
        args <- list(...)
        # `local = TRUE` means the caller's frame, which delegation would lose.
        if (isTRUE(local)) local <- parent.frame()
        if (missing(file)) return(do.call(orig, c(list(local = local), args)))
        plain <- function() do.call(orig, c(list(file, local = local), args))
        unnamed <- length(args) && (is.null(names(args)) || any(!nzchar(names(args))))
        if (isTRUE(state$internal) || unnamed || !is.character(file) || length(file) != 1L ||
            grepl("^(https?|ftp|file)://", file) || !file.exists(file) ||
            !all(names(args) %in% source_args)) {
            if (is.character(file) && length(file) == 1L && file.exists(file)) {
                rpc("unsupported_source", normalizePath(file, mustWork = FALSE))
            }
            return(plain())
        }
        path <- normalizePath(file, mustWork = TRUE)
        # Files without breakpoints, and encodings base source() would have
        # to guess between, go to the original untouched.
        line_bps <- !identical(rpc("has_bps", path), "0")
        if (!line_bps && !length(state$fbp_names)) return(plain())
        enc <- if (!is.null(args$encoding)) args$encoding else "unknown"
        if (length(enc) != 1L) return(plain())
        lines <- readLines(file, warn = FALSE, encoding = if (identical(enc, "unknown")) "UTF-8" else enc)
        ann <- if (line_bps) {
            internal(tryCatch(annotate_file(path, paste(lines, collapse = "\n"), if (is.environment(local)) local else globalenv()),
                              error = function(e) NULL))
        }
        alines <- if (is.null(ann)) lines else strsplit(ann, "\n", fixed = TRUE)[[1L]]
        exprs <- tryCatch(parse(text = alines, keep.source = TRUE, srcfile = srcfilecopy(path, alines), encoding = "UTF-8"),
                          error = function(e) NULL)
        if (is.null(exprs)) return(plain())
        exprs <- fuse_probes(exprs)
        bound <- bind_fbps_after_definitions(exprs)
        # Nothing to change: base source() exactly as called.
        if (is.null(ann) && is.null(bound)) return(plain())
        if (!is.null(bound)) exprs <- bound
        if (isTRUE(args$echo)) exprs <- tryCatch(echo_original(exprs, path, lines), error = function(e) exprs)
        if (isTRUE(args$chdir)) {
            owd <- setwd(dirname(path))
            on.exit(setwd(owd), add = TRUE)
        }
        args$chdir <- NULL
        args$encoding <- NULL
        do.call(orig, c(list(exprs = exprs, local = local), args))
    }
    env$set_source_hook <- function(on) internal(tryCatch({
        on <- isTRUE(as.logical(on))
        cur <- get("source", envir = baseenv())
        if (on && is.null(state$orig_source)) {
            state$orig_source <- cur
            unlockBinding("source", baseenv())
            assign("source", env$source_hook, envir = baseenv())
            lockBinding("source", baseenv())
        } else if (!on && !is.null(state$orig_source)) {
            if (identical(cur, env$source_hook)) {
                unlockBinding("source", baseenv())
                assign("source", state$orig_source, envir = baseenv())
                lockBinding("source", baseenv())
            }
            state$orig_source <- NULL
        }
        "ok"
    }, error = function(e) conditionMessage(e)))

    # ---- exceptions and pause (design sec. 7) ------------------------------------
    user_frame <- function() {
        n <- sys.nframe()
        for (i in rev(seq_len(n))) {
            f <- sys.function(i)
            if (identical(environment(f), here)) next
            if (!is.null(attr(f, "srcref"))) return(i)
        }
        0L
    }
    # Error and warning stops are for code from a file: editor sends with a
    # location (`#line`), source(), load_all(). Code typed at the prompt has
    # srcrefs too, but with filename "". A builtin's error at top level
    # carries its file srcref only on the `.handleSimpleError()` call, so
    # every frame but the debugger's own is checked. Sends that fall back to
    # untagged text (an unsaved buffer, a path `#line` can't carry) have no
    # file, so they don't stop; nor does source(keep.source = FALSE), unless
    # the file has a breakpoint (the source() wrapper parses with srcrefs).
    file_srcref <- function(sr) {
        if (!inherits(sr, "srcref")) return(FALSE)
        loc <- srcref_loc(sr)
        !is.null(loc) && nzchar(loc[[1L]]) && !startsWith(loc[[1L]], "<")
    }
    from_file <- function() {
        for (i in seq_len(sys.nframe())) {
            f <- sys.function(i)
            if (identical(environment(f), here)) next
            if (file_srcref(attr(sys.call(i), "srcref")) || file_srcref(attr(f, "srcref"))) return(TRUE)
        }
        FALSE
    }
    # Where a top-level line from a file signalled: the innermost call with
    # a file srcref. R 4.3 reports no current srcref for a browser opened in
    # globalenv(), so the `<top level>` frame takes its line from here.
    top_file_loc <- function() {
        for (i in rev(seq_len(sys.nframe()))) {
            if (identical(environment(sys.function(i)), here)) next
            sr <- attr(sys.call(i), "srcref")
            if (file_srcref(sr)) return(srcref_loc(sr))
        }
        NULL
    }
    # ---- traceback (printed at the next top-level prompt) ---------------------
    # An absolute file location, or NULL: a relative name with no srcfile$wd
    # can't be resolved against the terminal's directory.
    abs_loc <- function(sr) {
        if (!file_srcref(sr)) return(NULL)
        loc <- srcref_loc(sr)
        if (grepl("^([A-Za-z]:)?[/\\\\]", loc[[1L]])) loc else NULL
    }
    # The stack as the traceback shows it, innermost first: each frame with
    # the line in it that called the next one (as the debugger's call stack
    # does), keeping only lines in files. NULL when no line is in a file.
    error_traceback <- function() {
        out <- character()
        for (j in rev(seq_len(sys.nframe()))) {
            if (identical(environment(sys.function(j)), here)) next
            if (j > 1L && identical(environment(sys.function(j - 1L)), here)) next
            loc <- abs_loc(attr(sys.call(j), "srcref"))
            if (is.null(loc)) next
            who <- if (j == 1L) "<top level>"
                   else trunc_str(paste(deparse(sys.call(j - 1L), nlines = 1L), collapse = ""), 60L)
            out <- c(out, paste0(who, " at ", loc[[1L]], ":", loc[[2L]]))
        }
        if (length(out)) out else NULL
    }
    # The candidate traceback for the error being signalled, or NULL. It is
    # printed only if the error really ends at the prompt; see at_prompt.
    error_candidate <- function(cnd) internal(tryCatch({
        if (identical(rpc("at_browser"), "1") || !from_file()) return(NULL)
        lines <- error_traceback()
        if (is.null(lines)) NULL
        else list(lines = lines, msg = tryCatch(conditionMessage(cnd), error = function(e) ""))
    }, error = function(e) NULL))
    # Every error and interrupt replaces the candidate. It is set only once
    # stop_or_pass() returns: Stop (`Q`) at an exception stop unwinds past
    # here, leaving none, as R then prints no error.
    on_condition <- function(cnd) {
        if (isTRUE(state$internal)) return(invisible(NULL))
        if (inherits(cnd, "error") || inherits(cnd, "interrupt")) state$err_cand <- NULL
        cand <- if (inherits(cnd, "error")) error_candidate(cnd)
        stop_or_pass(cnd)
        if (!is.null(cand)) state$err_cand <- cand
        invisible(NULL)
    }
    stop_or_pass <- function(cnd) {
        kind <- if (inherits(cnd, "interrupt")) "interrupt" else if (inherits(cnd, "error")) "error"
                else if (inherits(cnd, "warning")) "warning" else return(invisible(NULL))
        taken <- if (kind == "interrupt") rpc("take_pause") else ""
        # Stop while running: let the interrupt return R to the prompt.
        if (identical(taken, "abort")) return(invisible(NULL))
        pause <- identical(taken, "1")
        filters <- strsplit(rpc("filters"), ",", fixed = TRUE)[[1L]]
        if (!pause && !(kind %in% filters)) return(invisible(NULL))
        if (!pause && kind != "interrupt" && !from_file()) return(invisible(NULL))
        k <- user_frame()
        msg <- tryCatch(conditionMessage(cnd), error = function(e) "")
        call <- tryCatch(paste(deparse(conditionCall(cnd), nlines = 1L), collapse = ""), error = function(e) "")
        rpc("exception", if (pause) "pause" else kind, paste(class(cnd)[[1L]], msg, call, sep = US))
        state$cut <- if (k > 0) k else 0L
        state$top_loc <- if (k == 0 && !pause && kind != "interrupt") top_file_loc()
        on.exit({ state$cut <- NULL; state$top_loc <- NULL }, add = TRUE)
        if (k > 0) base::eval(quote(base::browser()), sys.frame(k)) else base::eval(quote(base::browser()), globalenv())
        if (kind == "interrupt") tryInvokeRestart("resume")
        invisible(NULL)
    }
    # Fed as hidden input at a level-0 prompt (globalCallingHandlers() must
    # run at R's real top level). Raven's handler is registered first, so it
    # runs after every handler the user has or adds later.
    # globalCallingHandlers() refuses to run with any local handler on the
    # stack, so this part must not be inside tryCatch(); the calls below
    # can't fail at R's top level.
    env$install <- function() {
        lv <- get0(".Last.value", envir = baseenv())
        internal(tryCatch({
            options(raven.debug_hook = hook)
            .Call(N$base_bind, ".raven_dbg_capture", env$capture)
            .Call(N$base_bind, ".ark_annotate_source", env$ark_annotate_source)
        }, error = function(e) NULL))
        if (!isTRUE(state$handlers) && sys.nframe() == 1L) {
            old <- globalCallingHandlers(NULL)
            globalCallingHandlers(error = on_condition, warning = on_condition, interrupt = on_condition)
            if (length(old)) do.call(globalCallingHandlers, old)
            state$handlers <- TRUE
        }
        invisible(lv)
    }
    env$install_hook_only <- function() internal(tryCatch({
        options(raven.debug_hook = hook)
        .Call(N$base_bind, ".raven_dbg_capture", env$capture)
        .Call(N$base_bind, ".raven_dbg_install", env$install)
        .Call(N$base_bind, ".ark_annotate_source", env$ark_annotate_source)
        "ok"
    }, error = function(e) conditionMessage(e)))

    env
})
