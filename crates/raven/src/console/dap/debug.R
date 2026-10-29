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
#     the native helpers, which never dispatch (design §6).
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
        s <- tryCatch({
            s <- gsub("\\", "\\\\", s, fixed = TRUE)
            s <- gsub("\"", "\\\"", s, fixed = TRUE)
            s <- gsub("\n", "\\n", s, fixed = TRUE)
            s <- gsub("\r", "\\r", s, fixed = TRUE)
            s <- gsub("\t", "\\t", s, fixed = TRUE)
            gsub("[[:cntrl:]]", " ", s, useBytes = TRUE)
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
    register <- function(x) {
        id <- state$next_ref
        state$next_ref <- id + 1L
        assign(as.character(id), x, envir = state$refs)
        id
    }
    lookup_ref <- function(id) get0(as.character(id), envir = state$refs, inherits = FALSE)
    env$reset_refs <- function() {
        state$refs <- new.env(parent = emptyenv())
        invisible(NULL)
    }

    # ---- previews (no dispatch) ----------------------------------------------
    xlen <- function(x) .Call(N$xlength, x)
    trunc_str <- function(s, n = 200L) {
        s <- s[1L]
        if (is.na(s)) return("NA")
        if (nchar(s, type = "chars", allowNA = TRUE, keepNA = FALSE) > n) paste0(substr(s, 1L, n), "…") else s
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
                lev <- attr(x, "levels", exact = TRUE)
                out <- as.character(lev[v])
                out[is.na(out)] <- "NA"
                return(out)
            }
            if ("Date" %in% cls && is.numeric(v)) return(civil(v))
            if ("POSIXct" %in% cls && is.numeric(v)) return(fmt_posixct(v, attr(x, "tzone", exact = TRUE)))
            if ("difftime" %in% cls && is.numeric(v)) return(paste(fmt_num(v), attr(x, "units", exact = TRUE)))
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
        n <- xlen(x)
        if (is_df(cls)) {
            nr <- .row_names_info(x, 2L)
            label <- if ("tbl_df" %in% cls) "tibble" else if ("data.table" %in% cls) "data.table" else "data.frame"
            return(sprintf("%s [%s × %s]", label, format(nr), format(n)))
        }
        if (t %in% c("list", "pairlist")) {
            return(sprintf("%s [%s]", if (is.null(cls)) "list" else cls[[1L]], format(n)))
        }
        if (!isTRUE(.Call(N$materialized, x))) {
            return(sprintf("%s [%s] (not materialized)", type_label(x), format(n)))
        }
        if (n == 0) return(sprintf("%s(0)", if (is.null(cls)) typeof(x) else cls[[1L]]))
        k <- min(n, 10)
        shown <- elems(x, seq_len(k))
        s <- paste(shown, collapse = " ")
        if (n > k) s <- paste(s, "…")
        if (n != 1) s <- sprintf("%s [%s] %s", type_label(x), format(n), s)
        trunc_str(s)
    }
    preview <- function(x) tryCatch(preview_(x), error = function(e) "<preview unavailable>")
    env$preview <- preview

    # Counts for DAP's indexedVariables / namedVariables.
    child_counts <- function(x) {
        t <- typeof(x)
        if (t == "environment") return(c(0, length(ls(x, all.names = TRUE, sorted = FALSE))))
        if (t == "S4") return(c(0, length(attributes(x))))
        if (t %in% c("list", "pairlist")) {
            n <- xlen(x)
            if (!is.null(attr(x, "names", exact = TRUE)) || is_df(oldClass(x))) return(c(0, n))
            return(c(n, 0))
        }
        if (t %in% c("logical", "integer", "double", "complex", "character", "raw")) {
            n <- xlen(x)
            if (n > 1 && isTRUE(.Call(N$materialized, x))) return(c(n, 0))
        }
        c(0, 0)
    }
    var_json <- function(name, value, kind = "value") {
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
        ref <- if (sum(counts) > 0) register(value) else 0L
        jobj(name = jstr(name), value = jstr(preview(value)), type = jstr(tryCatch(type_label(value), error = function(e) "?")),
             variablesReference = jnum(ref),
             indexedVariables = if (counts[1] > 0) jnum(counts[1]) else NULL,
             namedVariables = if (counts[2] > 0) jnum(counts[2]) else NULL)
    }
    page <- function(n, start, count) {
        start <- max(0, start)
        if (count <= 0) count <- n
        if (start >= n) return(integer())
        seq.int(start + 1, min(n, start + count))
    }
    children <- function(x, start, count, filter) {
        t <- typeof(x)
        out <- character()
        if (t == "environment") {
            nms <- ls(x, all.names = TRUE, sorted = TRUE)
            for (i in page(length(nms), start, count)) {
                b <- .Call(N$binding, x, nms[[i]])
                out <- c(out, var_json(nms[[i]], b[[2L]], b[[1L]]))
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
            nms <- attr(x, "names", exact = TRUE)
            for (i in page(n, start, count)) {
                nm <- if (!is.null(nms) && nzchar(nms[[i]])) nms[[i]] else sprintf("[[%d]]", i)
                out <- c(out, var_json(nm, .subset2(x, i)))
            }
            return(out)
        }
        if (t %in% c("logical", "integer", "double", "complex", "character", "raw")) {
            n <- xlen(x)
            idx <- page(n, start, count)
            if (length(idx)) {
                vals <- elems(x, idx)
                for (j in seq_along(idx)) {
                    out <- c(out, jobj(name = jstr(sprintf("[%d]", idx[[j]])), value = jstr(vals[[j]]),
                                       type = jstr(type_label(x)), variablesReference = "0"))
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
        jarr(children(x, as.numeric(start), as.numeric(count), filter))
    }, error = function(e) jarr(character())))

    # ---- stops ---------------------------------------------------------------
    srcref_loc <- function(sr) {
        if (is.null(sr) || length(sr) < 6L) return(NULL)
        sf <- attr(sr, "srcfile")
        fn <- if (is.environment(sf)) get0("filename", envir = sf, inherits = FALSE) else NULL
        if (is.null(fn) || !length(fn)) fn <- ""
        wd <- if (is.environment(sf)) get0("wd", envir = sf, inherits = FALSE) else NULL
        if (nzchar(fn) && !startsWith(fn, "/") && !startsWith(fn, "<") && !is.null(wd) && length(wd)) {
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
    # while a promise is being forced (RStudio's capture trick, design §4).
    env$capture <- function() {
        lv <- get0(".Last.value", envir = baseenv())
        internal(tryCatch({
            here <- sys.nframe()
            n <- here - 1L
            if (!is.null(state$cut)) n <- min(n, state$cut)
            calls <- if (n > 0) sys.calls()[seq_len(n)] else list()
            frames <- if (n > 0) sys.frames()[seq_len(n)] else list()
            funs <- if (n > 0) lapply(seq_len(n), function(i) sys.function(i)) else list()
            hidden <- vapply(funs, function(f) {
                identical(environment(f), here) || identical(f, state$hook)
            }, TRUE)
            state$frames <- frames
            state$browse_env <- parent.frame()
            fbp <- n > 0 && any(vapply(state$fbp, function(g) identical(g, funs[[n]]), TRUE))
            env$reset_refs()
            items <- character()
            for (i in rev(seq_len(n))) {
                if (hidden[[i]]) next
                loc <- if (i < n) srcref_loc(attr(calls[[i + 1L]], "srcref")) else NULL
                items <- c(items, jobj(id = jnum(i), name = jstr(call_name(calls[[i]])),
                                       loc = if (is.null(loc)) "null" else jarr(c(jstr(loc[[1L]]), loc[-1L]))))
            }
            gloc <- if (n > 0) srcref_loc(attr(calls[[1L]], "srcref")) else NULL
            items <- c(items, jobj(id = "0", name = jstr("<top level>"),
                                   loc = if (is.null(gloc)) "null" else jarr(c(jstr(gloc[[1L]]), gloc[-1L]))))
            rpc("captured", jarr(items), if (fbp) "fbp" else "")
        }, error = function(e) rpc("captured", "[]")))
        invisible(lv)
    }
    frame_env <- function(frame) {
        frame <- as.integer(frame)
        if (is.na(frame) || frame <= 0L) return(globalenv())
        if (frame <= length(state$frames)) return(state$frames[[frame]])
        globalenv()
    }
    env$scopes <- function(frame) internal(tryCatch({
        e <- frame_env(frame)
        out <- jobj(name = jstr(if (identical(e, globalenv())) "Global" else "Locals"),
                    presentationHint = jstr("locals"), variablesReference = jnum(register(e)),
                    namedVariables = jnum(length(ls(e, all.names = TRUE, sorted = FALSE))),
                    expensive = jbool(identical(e, globalenv())))
        if (!identical(e, globalenv())) {
            p <- parent.env(e)
            if (!identical(p, globalenv()) && !identical(p, emptyenv())) {
                out <- c(out, jobj(name = jstr("Enclosing"), variablesReference = jnum(register(p)), expensive = "true"))
            }
            out <- c(out, jobj(name = jstr("Global"), variablesReference = jnum(register(globalenv())), expensive = "true"))
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
        res <- tryCatch(withVisible(eval(parse(text = expr, keep.source = FALSE), e)),
                        error = function(err) err)
        if (inherits(res, "error")) return(jobj(error = jstr(conditionMessage(res))))
        v <- res$value
        text <- if (identical(context, "repl")) {
            if (isTRUE(res$visible)) paste(utils::capture.output(print(v)), collapse = "\n") else ""
        } else preview(v)
        counts <- tryCatch(child_counts(v), error = function(e) c(0, 0))
        ref <- if (sum(counts) > 0) register(v) else 0L
        jobj(result = jstr(text), type = jstr(tryCatch(type_label(v), error = function(e) "?")),
             variablesReference = jnum(ref),
             indexedVariables = if (counts[1] > 0) jnum(counts[1]) else NULL,
             namedVariables = if (counts[2] > 0) jnum(counts[2]) else NULL)
    }, error = function(e) jobj(error = jstr(conditionMessage(e)))))

    # Hover resolves only forms that run no R code (design §6).
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
                if (is.symbol(key)) key <- as.character(key)
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
        if (!is.environment(container)) return(jobj(error = jstr("only variables in environments can be changed")))
        v <- eval(parse(text = value, keep.source = FALSE), frame_env(frame))
        assign(name, v, envir = container)
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
    # lands on the anchored statement (design §5.2).
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
    find_fun <- function(name) {
        if (grepl("::", name, fixed = TRUE)) {
            p <- strsplit(name, ":::?")[[1L]]
            if (length(p) != 2L) return(NULL)
            return(tryCatch(get(p[[2L]], envir = asNamespace(p[[1L]]), mode = "function"), error = function(e) NULL))
        }
        get0(name, envir = globalenv(), mode = "function")
    }
    env$function_breakpoints <- function(spec) internal(tryCatch({
        names <- if (nzchar(spec)) strsplit(spec, US, fixed = TRUE)[[1L]] else character()
        for (old in names(state$fbp)) {
            if (!old %in% names) {
                f <- state$fbp[[old]]
                if (!is.null(f)) try(undebug(f), silent = TRUE)
                state$fbp[[old]] <- NULL
            }
        }
        out <- character()
        for (nm in names) {
            f <- find_fun(nm)
            if (is.null(f) || !is.function(f) || is.primitive(f)) {
                out <- c(out, jobj(verified = "false", message = jstr(if (is.null(f)) "function not found" else "can't debug a primitive")))
                next
            }
            ok <- tryCatch({ debug(f); TRUE }, error = function(e) FALSE)
            if (ok) state$fbp[[nm]] <- f
            out <- c(out, jobj(verified = jbool(ok), message = if (ok) NULL else jstr("debug() failed")))
        }
        jarr(out)
    }, error = function(e) jarr(character())))

    # ---- callee identity (design §5.3) ---------------------------------------
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
    # Ark's de facto hook (design §5.3, owner decision 1): pkgload >= 1.5 and
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
    env$source_hook <- function(file, local = FALSE, ...) {
        orig <- state$orig_source
        if (is.null(orig)) orig <- base::source
        args <- list(...)
        # `local = TRUE` means the caller's frame, which delegation would lose.
        if (isTRUE(local)) local <- parent.frame()
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
        enc <- if (!is.null(args$encoding)) args$encoding else "unknown"
        lines <- readLines(file, warn = FALSE, encoding = if (identical(enc, "unknown")) "UTF-8" else enc)
        ann <- internal(tryCatch(annotate_file(path, paste(lines, collapse = "\n"), if (is.environment(local)) local else globalenv()),
                                 error = function(e) NULL))
        if (is.null(ann)) return(plain())
        alines <- strsplit(ann, "\n", fixed = TRUE)[[1L]]
        exprs <- parse(text = alines, keep.source = TRUE, srcfile = srcfilecopy(path, alines), encoding = "UTF-8")
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

    # ---- exceptions and pause (design §7) ------------------------------------
    user_frame <- function() {
        n <- sys.nframe()
        for (i in rev(seq_len(n))) {
            f <- sys.function(i)
            if (identical(environment(f), here)) next
            if (!is.null(attr(f, "srcref"))) return(i)
        }
        0L
    }
    on_condition <- function(cnd) {
        if (isTRUE(state$internal)) return(invisible(NULL))
        kind <- if (inherits(cnd, "interrupt")) "interrupt" else if (inherits(cnd, "error")) "error"
                else if (inherits(cnd, "warning")) "warning" else return(invisible(NULL))
        pause <- kind == "interrupt" && identical(rpc("take_pause"), "1")
        filters <- strsplit(rpc("filters"), ",", fixed = TRUE)[[1L]]
        if (!pause && !(kind %in% filters)) return(invisible(NULL))
        k <- user_frame()
        msg <- tryCatch(conditionMessage(cnd), error = function(e) "")
        call <- tryCatch(paste(deparse(conditionCall(cnd), nlines = 1L), collapse = ""), error = function(e) "")
        rpc("exception", if (pause) "pause" else kind, paste(class(cnd)[[1L]], msg, call, sep = US))
        state$cut <- if (k > 0) k else 0L
        on.exit(state$cut <- NULL, add = TRUE)
        if (k > 0) base::eval(quote(base::browser()), sys.frame(k)) else base::eval(quote(base::browser()), globalenv())
        if (kind == "interrupt") tryInvokeRestart("resume")
        invisible(NULL)
    }
    # Fed as hidden input at a level-0 prompt (globalCallingHandlers() must
    # run at R's real top level). Raven's handler is registered first, so it
    # runs after every handler the user has or adds later.
    env$install <- function() {
        lv <- get0(".Last.value", envir = baseenv())
        internal(tryCatch({
            options(raven.debug_hook = hook)
            .Call(N$base_bind, ".raven_dbg_capture", env$capture)
            .Call(N$base_bind, ".ark_annotate_source", env$ark_annotate_source)
            if (!isTRUE(state$handlers)) {
                old <- globalCallingHandlers(NULL)
                globalCallingHandlers(error = on_condition, warning = on_condition, interrupt = on_condition)
                if (length(old)) do.call(globalCallingHandlers, old)
                state$handlers <- TRUE
            }
        }, error = function(e) NULL))
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
