import * as fs from 'fs/promises';
import * as path from 'path';

export const RAVEN_PROFILE_FILENAME = 'r-profile.R';

export type BuildEnvInputs = {
    profile_path: string;
    session_port: number;
    session_token: string;
    r_session_id: string;
    previous_r_profile_user: string | undefined;
};

export type RavenPlotEnv = {
    R_PROFILE_USER: string;
    RAVEN_ORIGINAL_R_PROFILE_USER: string;
    RAVEN_SESSION_PORT: string;
    RAVEN_SESSION_TOKEN: string;
    RAVEN_R_SESSION_ID: string;
};

export function build_terminal_env(inputs: BuildEnvInputs): RavenPlotEnv {
    return {
        R_PROFILE_USER: inputs.profile_path,
        RAVEN_ORIGINAL_R_PROFILE_USER: inputs.previous_r_profile_user ?? '',
        RAVEN_SESSION_PORT: String(inputs.session_port),
        RAVEN_SESSION_TOKEN: inputs.session_token,
        RAVEN_R_SESSION_ID: inputs.r_session_id,
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

local({
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
                                     blocking = TRUE, open = "r+",
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

    # 1. Source the original user profile if any.
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

    # 2. Verify httpgd >= 2.0.2 is available.
    if (!requireNamespace("httpgd", quietly = TRUE)) {
        .raven_log("plots require the httpgd package. Install with: install.packages(\\"httpgd\\")")
        return(invisible(NULL))
    }
    if (!(utils::packageVersion("httpgd") >= "2.0.2")) {
        .raven_log(paste0(
            "httpgd >= 2.0.2 is required (found ",
            as.character(utils::packageVersion("httpgd")), "). Run: install.packages(\\"httpgd\\")"
        ))
        return(invisible(NULL))
    }

    # 3. Start httpgd device.
    tryCatch({
        httpgd::hgd(host = "127.0.0.1", port = 0, token = TRUE, silent = TRUE)
    }, error = function(e) {
        .raven_log(paste0("could not start httpgd: ", conditionMessage(e)))
        return(invisible(NULL))
    })

    .raven_details <- tryCatch(httpgd::hgd_details(), error = function(e) NULL)
    if (is.null(.raven_details)) {
        .raven_log("httpgd_details() unavailable; aborting plot bridge")
        return(invisible(NULL))
    }

    .raven_session_id <- Sys.getenv("RAVEN_R_SESSION_ID")
    if (!nzchar(.raven_session_id)) {
        return(invisible(NULL))
    }

    # 4. POST session-ready.
    .raven_post("/session-ready", paste0(
        "{",
        "\\"sessionId\\":", .raven_json_str(.raven_session_id), ",",
        "\\"httpgdHost\\":", .raven_json_str(as.character(.raven_details$host)), ",",
        "\\"httpgdPort\\":", as.integer(.raven_details$port), ",",
        "\\"httpgdToken\\":", .raven_json_str(as.character(.raven_details$token)),
        "}"
    ))

    # 5. addTaskCallback to push plot-available on hgd_state changes.
    .raven_state <- list(hsize = -1L, upid = -1L)
    addTaskCallback(function(...) {
        tryCatch({
            s <- httpgd::hgd_state()
            hsize <- as.integer(s$hsize)
            upid <- as.integer(s$upid)
            if (!is.null(hsize) && !is.null(upid) &&
                (hsize != .raven_state$hsize || upid != .raven_state$upid)) {
                .raven_state$hsize <<- hsize
                .raven_state$upid <<- upid
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
        }, error = function(e) {
            .raven_log(paste0("plot-available callback error: ", conditionMessage(e)))
        })
        TRUE
    }, name = "raven-plot-bridge")

    invisible(NULL)
})
`;
}
