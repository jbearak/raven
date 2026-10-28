/*
 * shim.c — the console's only code that runs R operations which may longjmp.
 *
 * R reports errors and interrupts with longjmp. Jumping over a Rust frame is
 * undefined behaviour unless the frame is trivially destructible, and keeping
 * every Rust frame on such a path trivially destructible is a fragile
 * invariant. So every R operation the console starts on its own initiative
 * (helper calls, parse probes, event pumping) runs inside R_ToplevelExec with
 * a callback written in C, here: any jump lands in R_ToplevelExec's own
 * context, unwinds only C frames, and comes back to Rust as a status code.
 *
 * The console loads libR at runtime, so this file cannot link against it.
 * Rust resolves the R entry points with dlsym and hands them over in
 * `RavenRApi` before any other function here is called.
 *
 * Rules for this file:
 *   - Only call R through `api`, and only inside a `toplevel_*` callback
 *     (directly or via R_ToplevelExec).
 *   - Values handed back to Rust are R_PreserveObject'ed; Rust releases them
 *     with raven_release().
 */

#include <stddef.h>

typedef void *SEXP;

typedef struct RavenRApi {
    int (*R_ToplevelExec)(void (*fun)(void *), void *data);
    SEXP (*R_ParseVector)(SEXP text, int n, int *status, SEXP srcfile);
    SEXP (*Rf_mkString)(const char *s);
    SEXP (*Rf_mkCharCE)(const char *s, int encoding);
    SEXP (*Rf_allocVector)(unsigned int type, ptrdiff_t n);
    void (*SET_STRING_ELT)(SEXP x, ptrdiff_t i, SEXP v);
    SEXP (*Rf_protect)(SEXP s);
    void (*Rf_unprotect)(int n);
    SEXP (*Rf_eval)(SEXP e, SEXP env);
    SEXP (*VECTOR_ELT)(SEXP x, ptrdiff_t i);
    int (*Rf_length)(SEXP x);
    SEXP (*Rf_findVarInFrame)(SEXP env, SEXP sym);
    SEXP (*Rf_install)(const char *name);
    SEXP (*Rf_lcons)(SEXP car, SEXP cdr);
    SEXP (*Rf_cons)(SEXP car, SEXP cdr);
    void (*R_PreserveObject)(SEXP x);
    void (*R_ReleaseObject)(SEXP x);
    /* Unix event loop. NULL where unavailable. */
    void *(*R_checkActivity)(int usec, int ignore_stdin);
    void (*R_runHandlers)(void *handlers, void *mask);
    void **R_InputHandlers;      /* address of the InputHandler* global */
    void (**R_PolledEvents)(void); /* address of the function-pointer global */
    SEXP (*Rf_GetOption1)(SEXP tag);
    int (*TYPEOF)(SEXP x);
    SEXP (*STRING_ELT)(SEXP x, ptrdiff_t i);
    const char *(*R_CHAR)(SEXP x);
    void (*R_CheckUserInterrupt)(void);
    int *R_interrupts_pending;   /* NULL if libR doesn't export it */
    SEXP *R_GlobalEnv;           /* addresses of R's data symbols */
    SEXP *R_NilValue;
    SEXP *R_UnboundValue;
} RavenRApi;

#define STRSXP 16
#define CE_UTF8 1

static RavenRApi api;
static int api_ready = 0;

void raven_shim_init(const RavenRApi *table) {
    api = *table;
    api_ready = 1;
}

/* ---- evaluating fixed internal code ------------------------------------ */

typedef struct {
    const char *code;
    SEXP env;
    SEXP result;
    int parse_status;
} EvalPayload;

static void toplevel_eval(void *data) {
    EvalPayload *p = (EvalPayload *)data;
    SEXP text = api.Rf_protect(api.Rf_mkString(p->code));
    int status = 0;
    SEXP exprs = api.Rf_protect(api.R_ParseVector(text, -1, &status, *api.R_NilValue));
    p->parse_status = status;
    if (status != 1 /* PARSE_OK */) {
        api.Rf_unprotect(2);
        return;
    }
    SEXP value = *api.R_NilValue;
    int n = api.Rf_length(exprs);
    for (int i = 0; i < n; i++) {
        value = api.Rf_eval(api.VECTOR_ELT(exprs, i), p->env);
    }
    api.R_PreserveObject(value);
    p->result = value;
    api.Rf_unprotect(2);
}

/*
 * Parse and evaluate `code` (UTF-8) in `env` (NULL = global env).
 * Returns 0 and stores the preserved last value in *out on success,
 * 1 on a parse error, 2 when R jumped (error or interrupt).
 */
int raven_eval(const char *code, SEXP env, SEXP *out) {
    if (!api_ready) return 2;
    EvalPayload p = {code, env ? env : *api.R_GlobalEnv, NULL, 0};
    int ok = api.R_ToplevelExec(toplevel_eval, &p);
    if (!ok) {
        if (p.result) api.R_ReleaseObject(p.result);
        return 2;
    }
    if (p.parse_status != 1) return 1;
    *out = p.result;
    return 0;
}

/* ---- calling a helper with string arguments ---------------------------- */

typedef struct {
    SEXP fun;
    int nargs;
    const char *const *args;
    SEXP result;
} CallPayload;

static void toplevel_call(void *data) {
    CallPayload *p = (CallPayload *)data;
    int nprot = 0;
    SEXP arglist = *api.R_NilValue;
    for (int i = p->nargs - 1; i >= 0; i--) {
        SEXP s = api.Rf_protect(api.Rf_allocVector(STRSXP, 1));
        api.SET_STRING_ELT(s, 0, api.Rf_mkCharCE(p->args[i], CE_UTF8));
        arglist = api.Rf_protect(api.Rf_cons(s, arglist));
        nprot += 2;
    }
    SEXP call = api.Rf_protect(api.Rf_lcons(p->fun, arglist));
    nprot++;
    SEXP value = api.Rf_eval(call, *api.R_GlobalEnv);
    api.R_PreserveObject(value);
    p->result = value;
    api.Rf_unprotect(nprot);
}

/*
 * Call the closure `fun` with `nargs` UTF-8 string arguments (each passed as
 * a length-1 character vector, never spliced into code). Returns 0 and the
 * preserved result in *out, or 2 when R jumped.
 */
int raven_call(SEXP fun, int nargs, const char *const *args, SEXP *out) {
    if (!api_ready) return 2;
    CallPayload p = {fun, nargs, args, NULL};
    int ok = api.R_ToplevelExec(toplevel_call, &p);
    if (!ok) {
        if (p.result) api.R_ReleaseObject(p.result);
        return 2;
    }
    *out = p.result;
    return 0;
}

void raven_release(SEXP x) {
    if (api_ready && x) api.R_ReleaseObject(x);
}

/* ---- parse probe -------------------------------------------------------- */

typedef struct {
    const char *code;
    int status;
} ParsePayload;

static void toplevel_parse(void *data) {
    ParsePayload *p = (ParsePayload *)data;
    SEXP text = api.Rf_protect(api.Rf_mkString(p->code));
    int status = 0;
    api.R_ParseVector(text, -1, &status, *api.R_NilValue);
    p->status = status;
    api.Rf_unprotect(1);
}

/*
 * R's own verdict on `code`: R's ParseStatus (0 NULL, 1 OK, 2 INCOMPLETE,
 * 3 ERROR, 4 EOF), or -1 when R jumped.
 */
int raven_parse_status(const char *code) {
    if (!api_ready) return -1;
    ParsePayload p = {code, 3};
    if (!api.R_ToplevelExec(toplevel_parse, &p)) return -1;
    return p.status;
}

/* ---- reading an option --------------------------------------------------- */

typedef struct {
    const char *name;
    char *buf;
    int buflen;
    int found;
} OptionPayload;

static void toplevel_option(void *data) {
    OptionPayload *p = (OptionPayload *)data;
    /* Rf_install may allocate (and so may jump): that is why this is here. */
    SEXP v = api.Rf_GetOption1(api.Rf_install(p->name));
    if (api.TYPEOF(v) != STRSXP || api.Rf_length(v) < 1) return;
    const char *s = api.R_CHAR(api.STRING_ELT(v, 0));
    int i = 0;
    for (; s[i] && i < p->buflen - 1; i++) p->buf[i] = s[i];
    p->buf[i] = 0;
    p->found = 1;
}

/*
 * Copy the first string of getOption(name) into buf (NUL-terminated,
 * truncated to buflen). Returns 1 if it is a string option, else 0.
 */
int raven_option_string(const char *name, char *buf, int buflen) {
    if (!api_ready || buflen < 1) return 0;
    OptionPayload p = {name, buf, buflen, 0};
    if (!api.R_ToplevelExec(toplevel_option, &p)) return 0;
    return p.found;
}

/* ---- ReadConsole --------------------------------------------------------- */

typedef int (*RustReadConsole)(const char *prompt, unsigned char *buf, int len, int hist, int *interrupt);
static RustReadConsole rust_read_console = NULL;

void raven_set_read_console(RustReadConsole f) { rust_read_console = f; }

/*
 * Installed as ptr_R_ReadConsole. The Rust side reads the input; when the
 * user pressed Ctrl-C at a prompt where that means "interrupt" (readline(),
 * a continuation line), it says so and this C frame raises R's interrupt
 * after the Rust frames have returned — the jump crosses only C.
 */
int raven_read_console(const char *prompt, unsigned char *buf, int len, int hist) {
    int interrupt = 0;
    int r = rust_read_console ? rust_read_console(prompt, buf, len, hist, &interrupt) : 0;
    if (interrupt && api.R_interrupts_pending && api.R_CheckUserInterrupt) {
        *api.R_interrupts_pending = 1;
        api.R_CheckUserInterrupt(); /* jumps to the top level */
    }
    return r;
}

/* ---- event pump --------------------------------------------------------- */

static void toplevel_pump(void *data) {
    (void)data;
    if (api.R_PolledEvents && *api.R_PolledEvents) (*api.R_PolledEvents)();
    if (!api.R_checkActivity || !api.R_runHandlers || !api.R_InputHandlers) return;
    /* Drain ready file-descriptor handlers (later, httpuv, the help server),
     * but bounded so a busy handler cannot starve the editor. */
    for (int i = 0; i < 16; i++) {
        void *mask = api.R_checkActivity(0, 1);
        if (!mask) break;
        api.R_runHandlers(*api.R_InputHandlers, mask);
    }
}

/*
 * Service R's event loop once without blocking: polled events (Tcl/Tk,
 * graphics devices) and ready input handlers. Returns 1, or 0 when an event
 * handler errored or was interrupted (R has already reported it).
 */
int raven_pump_events(void) {
    if (!api_ready) return 0;
    return api.R_ToplevelExec(toplevel_pump, NULL);
}
