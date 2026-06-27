import * as fs from 'fs/promises';
import * as path from 'path';

export const RAVEN_PROFILE_FILENAME = 'r-profile.R';

export type BuildEnvInputs = {
    profile_path: string;
    session_port: number;
    session_token: string;
    r_session_id: string;
    previous_r_profile_user: string | undefined;
    /** Absolute path to the per-extension data-viewer storage directory.
     *  The R View() override writes its Arrow files here. May be empty
     *  when the data viewer is disabled. */
    data_viewer_dir?: string;
};

export type RavenPlotEnv = {
    R_PROFILE_USER: string;
    RAVEN_ORIGINAL_R_PROFILE_USER: string;
    RAVEN_SESSION_PORT: string;
    RAVEN_SESSION_TOKEN: string;
    RAVEN_R_SESSION_ID: string;
    RAVEN_DATA_VIEWER_DIR: string;
};

export function build_terminal_env(inputs: BuildEnvInputs): RavenPlotEnv {
    return {
        R_PROFILE_USER: inputs.profile_path,
        RAVEN_ORIGINAL_R_PROFILE_USER: inputs.previous_r_profile_user ?? '',
        RAVEN_SESSION_PORT: String(inputs.session_port),
        RAVEN_SESSION_TOKEN: inputs.session_token,
        RAVEN_R_SESSION_ID: inputs.r_session_id,
        RAVEN_DATA_VIEWER_DIR: inputs.data_viewer_dir ?? '',
    };
}

export async function write_profile_file(
    global_storage_dir: string,
    content: string,
): Promise<string> {
    await fs.mkdir(global_storage_dir, { recursive: true });
    const profile_path = path.join(global_storage_dir, RAVEN_PROFILE_FILENAME);
    const tmp_path = `${profile_path}.tmp.${process.pid}`;
    await fs.writeFile(tmp_path, content, { encoding: 'utf8' });
    try {
        await fs.rename(tmp_path, profile_path);
    } catch (err) {
        await fs.unlink(tmp_path).catch(() => undefined);
        throw err;
    }
    return profile_path;
}

/**
 * Returns the static R source code Raven writes to its bootstrap profile.
 *
 * Content depends only on the extension version, so concurrent regeneration is
 * idempotent. Per-session state (port/token/session id) is read at runtime
 * from environment variables, not embedded here.
 */
export function generate_profile_source(): string {
    return `# Raven bootstrap profile. Do not edit; regenerated each terminal launch.

# Source the user's original .Rprofile exactly once, before either bridge,
# so neither block needs to gate on profile-loaded state and the data viewer
# block isn't suppressed by a plot-bridge early return.
local({
    .raven_log <- function(msg) message(paste0("Raven: ", msg))
    .raven_orig <- Sys.getenv("RAVEN_ORIGINAL_R_PROFILE_USER")
    .raven_candidate <- if (nzchar(.raven_orig)) {
        .raven_orig
    } else if (file.exists(".Rprofile")) {
        ".Rprofile"
    } else if (file.exists("~/.Rprofile")) {
        path.expand("~/.Rprofile")
    } else {
        ""
    }
    if (nzchar(.raven_candidate) && file.access(.raven_candidate, mode = 4) == 0) {
        tryCatch(sys.source(.raven_candidate, envir = globalenv()),
                  error = function(e) {
                      .raven_log(paste0(
                          "could not source user profile '", .raven_candidate,
                          "': ", conditionMessage(e)
                      ))
                  })
    }
})

# Raven data viewer block — overrides View() in globalenv so the Raven
# extension renders data.frames and matrices in a virtualized webview.
# Independent of the plot bridge: a missing httpgd does not affect this.
local({
    .raven_log <- function(msg) message(paste0("Raven: ", msg))

    .raven_dv_dir <- Sys.getenv("RAVEN_DATA_VIEWER_DIR")
    if (!nzchar(.raven_dv_dir)) {
        # Data viewer is disabled in this terminal — stay silent so users
        # who never opted in don't see the "install arrow" message.
        return(invisible(NULL))
    }
    if (!dir.exists(.raven_dv_dir)) {
        tryCatch(dir.create(.raven_dv_dir, recursive = TRUE, showWarnings = FALSE),
                 error = function(e) {})
    }

    .raven_session_id <- Sys.getenv("RAVEN_R_SESSION_ID")

    # ----- helpers ---------------------------------------------------------

    .raven_post <- function(path, body_str) {
        port <- as.integer(Sys.getenv("RAVEN_SESSION_PORT"))
        token <- Sys.getenv("RAVEN_SESSION_TOKEN")
        if (is.na(port) || port <= 0L || !nzchar(token)) return(invisible(NULL))
        tryCatch({
            con <- socketConnection(host = "127.0.0.1", port = port,
                                     blocking = TRUE, open = "r+b", timeout = 2)
            on.exit(close(con), add = TRUE)
            body_bytes <- charToRaw(body_str)
            hdr <- paste0(
                "POST ", path, " HTTP/1.0\\r\\n",
                "Host: 127.0.0.1\\r\\n",
                "X-Raven-Session-Token: ", token, "\\r\\n",
                "Content-Type: application/json\\r\\n",
                "Content-Length: ", length(body_bytes), "\\r\\n",
                "Connection: close\\r\\n",
                "\\r\\n"
            )
            writeBin(charToRaw(hdr), con)
            writeBin(body_bytes, con)
            flush(con)
            invisible(NULL)
        }, error = function(e) {
            .raven_log(paste0("data viewer POST failed: ", conditionMessage(e)))
        })
    }

    .raven_json_str <- function(x) {
        x <- gsub("\\\\\\\\", "\\\\\\\\\\\\\\\\", x, fixed = TRUE)
        x <- gsub("\\"", "\\\\\\"", x, fixed = TRUE)
        x <- gsub("\\n", "\\\\n", x, fixed = TRUE)
        x <- gsub("\\r", "\\\\r", x, fixed = TRUE)
        x <- gsub("\\t", "\\\\t", x, fixed = TRUE)
        paste0("\\"", x, "\\"")
    }

    .raven_truncate_utf8 <- function(s, max_bytes = 1024L) {
        if (length(s) == 0L || is.na(s)) return(s)
        # Treat each element scalar.
        out <- s
        bytes <- nchar(s, type = "bytes")
        too_long <- which(!is.na(bytes) & bytes > max_bytes)
        for (i in too_long) {
            chars <- s[i]
            # Successively shorter substrings until under the byte limit
            # by codepoint count. UTF-8 worst case 4 bytes per char.
            keep <- as.integer(max_bytes / 4L)
            while (keep > 0L && nchar(substr(chars, 1L, keep), type = "bytes") > max_bytes - 3L) {
                keep <- keep - 1L
            }
            out[i] <- paste0(substr(chars, 1L, keep), "\\u2026")
        }
        out
    }

    # Detect non-auto-generated rownames (non-NULL, character, and not the
    # default "1".."N" sequence).
    .raven_meaningful_rownames <- function(x) {
        rn <- rownames(x)
        if (is.null(rn)) return(FALSE)
        n <- nrow(x)
        if (length(rn) != n) return(FALSE)
        any(rn != as.character(seq_len(n)))
    }

    # Stamp a named list of equal-length columns as an n-row data.frame
    # WITHOUT data.frame() — a bare class assignment preserves each
    # column's class/attributes (factor levels, haven_labelled labels) so
    # they survive into .raven_encode_col, which data.frame() would coerce
    # away.
    .raven_bare_df <- function(cols, n) {
        class(cols) <- "data.frame"
        attr(cols, "row.names") <- .set_row_names(n)
        cols
    }

    # Build a 1- or 2-column data.frame from an atomic / factor /
    # haven_labelled vector: a leading "name" column when names() is
    # non-NULL, plus a "value" (length 1) / "values" column.
    .raven_vector_to_df <- function(x) {
        n <- length(x)
        cols <- list()
        nm <- names(x)
        if (!is.null(nm)) cols[["name"]] <- as.character(nm)
        cols[[if (n == 1L) "value" else "values"]] <- unname(x)
        .raven_bare_df(cols, n)
    }

    # Is a list element a plain scalar/vector (so a flat list can become a
    # table)? NULL is allowed (→ an all-NA column). Nested lists,
    # data.frames, multi-dimensional objects, and raw are rejected.
    .raven_list_elem_ok <- function(el) {
        is.null(el) ||
            ((is.atomic(el) || is.factor(el) || inherits(el, "haven_labelled")) &&
             is.null(dim(el)) && !is.raw(el))
    }

    # Pad a single scalar/vector element to length n, preserving class.
    # We index with NA for the out-of-range positions rather than
    # over-indexing (el[seq_len(n)]): base vectors and factors NA-pad on
    # over-index, but vctrs/haven_labelled's [ method ERRORS on
    # out-of-bounds subscripts. Indexing existing positions plus NA works
    # for all three and keeps factor levels / haven_labelled labels.
    .raven_pad_to <- function(el, n) {
        if (is.null(el)) return(rep(NA, n))
        idx <- seq_len(n)
        idx[idx > length(el)] <- NA_integer_
        unname(el[idx])
    }

    # Build a data.frame from a flat (non-recursive) list: one column per
    # element, NA-padded to the longest element (see .raven_pad_to). A
    # literal NULL element has no type and becomes a logical NA column.
    # Column names come from names(); blank/NA names are filled "V<i>".
    # Explicit names are authoritative: the "V<i>" placeholders are made
    # unique against them first, so a user's real column named e.g. "V1"
    # keeps its name and the placeholder yields (not the reverse).
    .raven_list_to_df <- function(x) {
        k <- length(x)
        n <- max(c(0L, lengths(x)))
        nm <- names(x)
        if (is.null(nm)) nm <- rep("", k)
        blank <- is.na(nm) | !nzchar(nm)
        if (any(blank)) {
            fill <- make.unique(c(nm[!blank], paste0("V", seq_len(k))))
            nm[blank] <- tail(fill, k)[blank]
        }
        nm <- make.unique(nm)
        cols <- vector("list", k)
        for (i in seq_len(k)) cols[[i]] <- .raven_pad_to(x[[i]], n)
        names(cols) <- nm
        .raven_bare_df(cols, n)
    }

    # Pre-encode one column for arrow:
    # - factor: keep as-is (arrow handles dictionary)
    # - haven_labelled: strip class, keep underlying numeric/character
    # - integer/double/logical/character/Date/POSIXct: keep
    # - list / S4 / complex / raw / unrecognized: format() per element,
    #   1 KiB-truncated
    .raven_encode_col <- function(col) {
        cls <- class(col)
        if (is.factor(col)) return(col)
        if ("haven_labelled" %in% cls) {
            x <- unclass(col)
            # exact = TRUE: a bare attr(col, "label") partial-matches the
            # "labels" attribute when there is no variable label, which
            # would stamp a bogus length-2 "label" onto the encoded column.
            attr(x, "label") <- attr(col, "label", exact = TRUE)
            attr(x, "labels") <- attr(col, "labels", exact = TRUE)
            return(x)
        }
        if (is.integer(col) || is.double(col) || is.logical(col) ||
            is.character(col) || inherits(col, "Date") || inherits(col, "POSIXct")) {
            return(col)
        }
        # Fallback: stringify with bounded length.
        out <- vapply(col, function(v) {
            if (is.null(v) || (length(v) == 1L && is.na(v))) return(NA_character_)
            tryCatch(.raven_truncate_utf8(format(v))[1L], error = function(e) NA_character_)
        }, character(1L))
        out
    }

    .raven_value_labels_json <- function(col) {
        if (is.factor(col)) {
            lv <- levels(col)
            if (length(lv) == 0L) return("")
            # 1-based codes mapped to level strings (matches as.integer(factor))
            entries <- vapply(seq_along(lv), function(i) {
                paste0("\\"", as.character(i), "\\":", .raven_json_str(lv[[i]]))
            }, character(1L))
            return(paste0("{", paste(entries, collapse = ","), "}"))
        }
        # exact = TRUE so a "label" / "labelsomething" attribute can't
        # partial-match where an exact "labels" is absent.
        labs <- attr(col, "labels", exact = TRUE)
        if (is.null(labs)) labs <- attr(col, "value.labels", exact = TRUE)
        if (is.null(labs) || is.null(names(labs))) return("")
        entries <- vapply(seq_along(labs), function(i) {
            key <- as.character(labs[[i]])
            paste0(.raven_json_str(key), ":", .raven_json_str(names(labs)[[i]]))
        }, character(1L))
        paste0("{", paste(entries, collapse = ","), "}")
    }

    .raven_field_metadata <- function(name, col) {
        md <- list()
        # exact = TRUE: without it, attr(col, "label") partial-matches the
        # "labels" (value-label) attribute on a haven_labelled column that
        # has no variable label, returning a length-2 vector that then
        # breaks the && below. The length(lbl) == 1L guard is belt-and-
        # suspenders against a non-standard multi-element "label" attribute
        # (same hazard guarded in the format.* loop below).
        lbl <- attr(col, "label", exact = TRUE)
        if (!is.null(lbl) && length(lbl) == 1L && nzchar(as.character(lbl))) {
            md[["raven.variable_label"]] <- as.character(lbl)
        }
        vlj <- .raven_value_labels_json(col)
        if (nzchar(vlj)) md[["raven.value_labels"]] <- vlj
        oc <- paste(class(col), collapse = "/")
        if (nzchar(oc)) md[["raven.original_class"]] <- oc
        # Source-file format string. Try Stata, SAS (haven::read_xpt),
        # SPSS (haven::read_sav) in that order; the first non-empty wins.
        # Used downstream to detect integer-formatted Float columns
        # (e.g. SAS "F8.0" — stored as double, intended as integer).
        for (attr_nm in c("format.stata", "format.sas", "format.spss")) {
            # exact = TRUE + the length(fmt) == 1L guard: attr_nm is a
            # variable, so partial matching is live; a partial match could
            # return a length>1 vector and turn the nzchar() check into a
            # length>1 condition (a hard error in the && on R >= 4.4).
            fmt <- attr(col, attr_nm, exact = TRUE)
            if (!is.null(fmt) && length(fmt) == 1L && nzchar(as.character(fmt))) {
                md[["raven.format"]] <- as.character(fmt)
                break
            }
        }
        md
    }

    .raven_write_arrow <- function(df, file_path, schema_md = list()) {
        # Per-field metadata isn't settable through the public R arrow API
        # (Field$create's metadata arg raises "metadata= is currently
        # ignored" through 2025-era versions). Encode per-field metadata
        # as a single JSON blob attached to the schema-level KV metadata
        # under the key "raven.fields"; the JS reader unpacks it into
        # ColumnSchema fields.
        tbl <- arrow::arrow_table(df)
        per_field <- list()
        for (nm in names(df)) {
            md <- .raven_field_metadata(nm, df[[nm]])
            if (length(md) > 0L) per_field[[nm]] <- md
        }
        meta <- as.list(schema_md)
        if (length(per_field) > 0L) {
            entries <- vapply(names(per_field), function(nm) {
                fld <- per_field[[nm]]
                kv <- vapply(names(fld), function(k) {
                    paste0(.raven_json_str(k), ":", .raven_json_str(fld[[k]]))
                }, character(1L))
                paste0(.raven_json_str(nm), ":{", paste(kv, collapse = ","), "}")
            }, character(1L))
            meta[["raven.fields"]] <- paste0("{", paste(entries, collapse = ","), "}")
        }
        if (length(meta) > 0L) tbl <- tbl$ReplaceSchemaMetadata(meta)
        # apache-arrow JS does not ship LZ4/Zstd codecs, so write uncompressed.
        arrow::write_feather(tbl, file_path, chunk_size = 65536L, compression = "uncompressed")
    }

    .raven_view <- function(x, title) {
        if (!requireNamespace("arrow", quietly = TRUE)) {
            msg <- "Raven data viewer requires the 'arrow' package. Install with: install.packages(\\"arrow\\")"
            warning(msg, call. = FALSE)
            .raven_post("/data-viewer-warning", paste0(
                "{",
                "\\"sessionId\\":", .raven_json_str(.raven_session_id), ",",
                "\\"reason\\":\\"missing-arrow\\",",
                "\\"message\\":", .raven_json_str(msg),
                "}"
            ))
            return(invisible(NULL))
        }
        # Resolve panel name.
        panel_name <- if (!missing(title) && !is.null(title)) {
            as.character(title)[[1L]]
        } else {
            s <- tryCatch(deparse1(substitute(x), collapse = " "),
                          error = function(e) "View")
            if (nchar(s, type = "bytes") > 256L) {
                # truncate_utf8 already appends a single "…" when it cuts.
                s <- .raven_truncate_utf8(s, 256L)
            }
            s
        }

        # Type dispatch: matrix and data.frame are tested first (a
        # data.frame is also a list). Then an atomic / factor /
        # haven_labelled vector — the !is.null(x) guard matters because
        # is.atomic(NULL) is TRUE on R < 4.4, and !is.raw(x) excludes raw
        # (no NA for ragged-list padding). Finally a flat list. Anything
        # else errors with the Positron-style message.
        df <- if (is.matrix(x)) {
            d <- as.data.frame(x, stringsAsFactors = FALSE)
            if (.raven_meaningful_rownames(x)) {
                d <- cbind(rowname = rownames(x), d, stringsAsFactors = FALSE)
            }
            rownames(d) <- NULL
            d
        } else if (is.data.frame(x)) {
            x
        } else if (!is.null(x) && is.null(dim(x)) && !is.raw(x) &&
                   (is.atomic(x) || is.factor(x) || inherits(x, "haven_labelled"))) {
            .raven_vector_to_df(x)
        } else if (is.list(x) && length(x) > 0L &&
                   all(vapply(x, .raven_list_elem_ok, logical(1L)))) {
            .raven_list_to_df(x)
        } else {
            stop("Can't \`View()\` an object of class \`",
                 paste(class(x), collapse = "/"), "\`", call. = FALSE)
        }
        # Pre-encode every column.
        for (nm in names(df)) df[[nm]] <- .raven_encode_col(df[[nm]])

        nr <- nrow(df)
        path <- file.path(.raven_dv_dir,
                           paste0(.raven_session_id, "-",
                                   format(as.numeric(Sys.time()) * 1e6, scientific = FALSE),
                                   "-", sample.int(.Machine$integer.max, 1L), ".arrow"))

        tryCatch(
            .raven_write_arrow(df, path),
            error = function(e) {
                stop("data viewer write failed: ", conditionMessage(e), call. = FALSE)
            })

        body <- paste0(
            "{",
            "\\"sessionId\\":", .raven_json_str(.raven_session_id), ",",
            "\\"panelName\\":", .raven_json_str(panel_name), ",",
            "\\"filePath\\":", .raven_json_str(path), ",",
            "\\"nrow\\":", as.character(nr),
            "}"
        )
        .raven_post("/view-data", body)
        invisible(NULL)
    }

    assign("View", .raven_view, envir = globalenv())
})

# Plot bridge block — depends on httpgd. Independent of the data viewer
# block above; if httpgd is missing, View() still works.
# Skip entirely in non-interactive R processes (e.g. R CMD INSTALL subprocesses
# spawned by install.packages): those inherit R_PROFILE_USER but must not load
# or lock the httpgd namespace.
local({
    if (!interactive()) return(invisible(NULL))
    .raven_log <- function(msg) {
        message(paste0("Raven: ", msg))
    }

    .raven_post <- function(path, body_str) {
        port <- as.integer(Sys.getenv("RAVEN_SESSION_PORT"))
        token <- Sys.getenv("RAVEN_SESSION_TOKEN")
        if (is.na(port) || port <= 0L || !nzchar(token)) {
            return(invisible(NULL))
        }
        tryCatch({
            con <- socketConnection(host = "127.0.0.1", port = port,
                                     blocking = TRUE, open = "r+b",
                                     timeout = 2)
            on.exit(close(con), add = TRUE)
            body_bytes <- charToRaw(body_str)
            hdr <- paste0(
                "POST ", path, " HTTP/1.0\\r\\n",
                "Host: 127.0.0.1\\r\\n",
                "X-Raven-Session-Token: ", token, "\\r\\n",
                "Content-Type: application/json\\r\\n",
                "Content-Length: ", length(body_bytes), "\\r\\n",
                "Connection: close\\r\\n",
                "\\r\\n"
            )
            writeBin(charToRaw(hdr), con)
            writeBin(body_bytes, con)
            flush(con)
            invisible(NULL)
        }, error = function(e) {
            .raven_log(paste0("session POST failed: ", conditionMessage(e)))
        })
    }

    .raven_json_str <- function(x) {
        # Tiny JSON-string escaper (subset sufficient for our payloads).
        x <- gsub("\\\\\\\\", "\\\\\\\\\\\\\\\\", x, fixed = TRUE)
        x <- gsub("\\"", "\\\\\\"", x, fixed = TRUE)
        paste0("\\"", x, "\\"")
    }

    # 2. Start httpgd device, post session-ready, and register the
    #    plot-available callback. Factored out so it can be called both at
    #    startup and by the retry callback after install.packages("httpgd").
    .raven_init_httpgd <- function() {
        tryCatch({
            httpgd::hgd(host = "127.0.0.1", port = 0, token = TRUE, silent = TRUE)
        }, error = function(e) {
            .raven_log(paste0("could not start httpgd: ", conditionMessage(e)))
        })

        .raven_details <- tryCatch(httpgd::hgd_details(), error = function(e) NULL)
        if (is.null(.raven_details)) {
            .raven_log("httpgd_details() unavailable; aborting plot bridge")
            return(invisible(NULL))
        }

        .raven_session_id <- Sys.getenv("RAVEN_R_SESSION_ID")
        if (!nzchar(.raven_session_id)) return(invisible(NULL))

        # 3. POST session-ready.
        .raven_post("/session-ready", paste0(
            "{",
            "\\"sessionId\\":", .raven_json_str(.raven_session_id), ",",
            "\\"httpgdHost\\":", .raven_json_str(as.character(.raven_details$host)), ",",
            "\\"httpgdPort\\":", as.integer(.raven_details$port), ",",
            "\\"httpgdToken\\":", .raven_json_str(as.character(.raven_details$token)),
            "}"
        ))

        # 4. addTaskCallback to push plot-available on state changes.
        #    The hgd state function was removed in httpgd 2.0; query the /state
        #    HTTP endpoint via httpgd::hgd_url(endpoint = "state") instead.
        .raven_state <- list(hsize = -1L, upid = -1L)
        addTaskCallback(function(...) {
            tryCatch({
                state_url <- httpgd::hgd_url(endpoint = "state")
                body <- tryCatch({
                    con <- url(state_url, open = "r")
                    on.exit(close(con), add = TRUE)
                    paste(readLines(con, warn = FALSE), collapse = "")
                }, error = function(e) "")
                hsize_match <- regmatches(body, regexpr('"hsize"\\\\s*:\\\\s*-?\\\\d+', body))
                upid_match  <- regmatches(body, regexpr('"upid"\\\\s*:\\\\s*-?\\\\d+',  body))
                if (length(hsize_match) == 1L && length(upid_match) == 1L) {
                    hsize <- as.integer(sub('.*:\\\\s*', '', hsize_match))
                    upid  <- as.integer(sub('.*:\\\\s*', '', upid_match))
                    if (!is.na(hsize) && !is.na(upid) &&
                        (hsize != .raven_state$hsize || upid != .raven_state$upid)) {
                        .raven_state$hsize <<- hsize
                        .raven_state$upid  <<- upid
                        if (hsize > 0L) {
                            .raven_post("/plot-available", paste0(
                                "{",
                                "\\"sessionId\\":", .raven_json_str(.raven_session_id), ",",
                                "\\"hsize\\":", hsize, ",",
                                "\\"upid\\":", upid,
                                "}"
                            ))
                        }
                    }
                }
            }, error = function(e) {
                .raven_log(paste0("plot-available callback error: ", conditionMessage(e)))
            })
            TRUE
        }, name = "raven-plot-bridge")

        invisible(NULL)
    }

    # Helper: defer the VS Code popup to the user's first plot attempt, and
    # warn on every subsequent plot until httpgd is installed. Combines:
    #   - A permanent PDF fallback in options(device=) so plot() never errors
    #     with "no active device" — output is discarded since there's no UI
    #     to render to until httpgd is available.
    #   - Hooks on plot.new and grid.newpage so the warning fires on every
    #     plot (base R + grid/ggplot2), not just the first.
    # The VS Code popup is posted only on the first plot to avoid stacking
    # notifications. Both the hook and the popup self-disable once httpgd
    # becomes available, so installing it mid-session doesn't require a
    # restart.
    .raven_deferred_warn <- function(msg, reason) {
        .raven_original_device <- getOption("device")
        options(device = function() {
            try(grDevices::pdf(tempfile(fileext = ".pdf")), silent = TRUE)
        })
        .raven_first_plot <- TRUE
        .raven_warn_hook <- function(...) {
            # Once httpgd is available, become a no-op so plots flow through
            # to the VS Code panel normally.
            if (requireNamespace("httpgd", quietly = TRUE) &&
                utils::packageVersion("httpgd") >= "2.0.2") {
                return(invisible(NULL))
            }
            if (.raven_first_plot) {
                .raven_post("/plot-warning", paste0(
                    "{",
                    "\\"sessionId\\":", .raven_json_str(Sys.getenv("RAVEN_R_SESSION_ID")), ",",
                    "\\"reason\\":", .raven_json_str(reason), ",",
                    "\\"message\\":", .raven_json_str(msg),
                    "}"
                ))
                .raven_first_plot <<- FALSE
            }
            warning(msg, call. = FALSE)
        }
        setHook("plot.new", .raven_warn_hook)
        setHook("grid.newpage", .raven_warn_hook)
        .raven_original_device
    }

    .raven_register_httpgd_retry <- function(.raven_original_device) {
        # Retry after each R expression: initialize the plot bridge as soon as
        # httpgd is available and new enough (e.g. after install.packages("httpgd")).
        addTaskCallback(function(...) {
            if (!requireNamespace("httpgd", quietly = TRUE)) return(TRUE)
            if (!(utils::packageVersion("httpgd") >= "2.0.2")) return(TRUE)
            # Remove the device wrapper now that httpgd is ready.
            options(device = .raven_original_device)
            .raven_init_httpgd()
            FALSE
        }, name = "raven-httpgd-pending")
    }

    # 5. Verify httpgd >= 2.0.2 is available.
    if (!requireNamespace("httpgd", quietly = TRUE)) {
        # Console: full context. Popup: short enough to fit on one VS Code
        # notification line without the user needing to expand it.
        .raven_log("To view R plots in VS Code, install the httpgd package: install.packages(\\"httpgd\\")")
        # Show the VS Code popup only when the user first tries to plot, not at
        # session start, to avoid overwhelming new users during setup.
        .raven_original_device <- .raven_deferred_warn(
            "To view R plots in VS Code: install.packages(\\"httpgd\\")", "missing-httpgd")
        .raven_register_httpgd_retry(.raven_original_device)
        return(invisible(NULL))
    }
    if (!(utils::packageVersion("httpgd") >= "2.0.2")) {
        .raven_log(paste0(
            "To view R plots in VS Code, update httpgd to >= 2.0.2 (installed: ",
            as.character(utils::packageVersion("httpgd")), "): install.packages(\\"httpgd\\")"
        ))
        .raven_original_device <- .raven_deferred_warn(
            "To view R plots in VS Code, update httpgd: install.packages(\\"httpgd\\")", "outdated-httpgd")
        .raven_register_httpgd_retry(.raven_original_device)
        return(invisible(NULL))
    }

    .raven_init_httpgd()
    invisible(NULL)
})
`;
}
