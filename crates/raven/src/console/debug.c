/*
 * debug.c — the debugger's native helpers (see src/console/dap/mod.rs).
 *
 * Two kinds of entry point live here:
 *
 *   - Functions Rust calls on the R thread (raven_dbg_*). Any that touch R in
 *     a way that may allocate or jump run their body under R_ToplevelExec,
 *     exactly like shim.c, so a longjmp never crosses a Rust frame.
 *   - `.Call` routines R code calls (registered on the embedding DLL, so the
 *     R helpers reach them with getNativeSymbolInfo()). These run inside R's
 *     own evaluation; the only one that calls Rust is the RPC routine, and
 *     Rust's side of it never touches R.
 *
 * libR is loaded with RTLD_GLOBAL, so symbols are resolved here with dlsym
 * rather than threaded through shim.c's table. Required symbols missing at
 * init disable the debugger (the console itself still runs); optional ones
 * (R 4.6's binding API) fall back to older accessors.
 */

#include <dlfcn.h>
#include <math.h>
#include <limits.h>
#include <stdio.h>
#include <stddef.h>
#include <string.h>

typedef void *SEXP;
typedef ptrdiff_t R_xlen_t;

#define NILSXP 0
#define SYMSXP 1
#define LISTSXP 2
#define CLOSXP 3
#define ENVSXP 4
#define PROMSXP 5
#define LGLSXP 10
#define INTSXP 13
#define REALSXP 14
#define STRSXP 16
#define VECSXP 19
#define CE_UTF8 1

typedef struct {
    const char *name;
    void *fun;
    int numArgs;
} R_CallMethodDef;

static struct {
    int (*R_ToplevelExec)(void (*fun)(void *), void *data);
    SEXP (*R_GetCurrentSrcref)(int skip);
    SEXP (*Rf_getAttrib)(SEXP x, SEXP name);
    SEXP (*Rf_install)(const char *name);
    SEXP (*Rf_findVarInFrame)(SEXP env, SEXP sym);
    int (*TYPEOF)(SEXP x);
    int (*Rf_length)(SEXP x);
    R_xlen_t (*Rf_xlength)(SEXP x);
    int *(*INTEGER)(SEXP x);
    SEXP (*STRING_ELT)(SEXP x, R_xlen_t i);
    const char *(*R_CHAR)(SEXP x);
    SEXP (*Rf_mkString)(const char *s);
    SEXP (*Rf_mkCharCE)(const char *s, int enc);
    SEXP (*Rf_allocVector)(unsigned int type, R_xlen_t n);
    void (*SET_STRING_ELT)(SEXP x, R_xlen_t i, SEXP v);
    SEXP (*SET_VECTOR_ELT)(SEXP x, R_xlen_t i, SEXP v);
    SEXP (*Rf_protect)(SEXP x);
    void (*Rf_unprotect)(int n);
    SEXP (*Rf_ScalarLogical)(int x);
    SEXP (*Rf_ScalarReal)(double x);
    int (*RDEBUG)(SEXP x);
    void (*SET_RDEBUG)(SEXP x, int v);
    int (*R_BindingIsActive)(SEXP sym, SEXP env);
    int (*R_existsVarInFrame)(SEXP env, SEXP sym);
    SEXP (*PRVALUE)(SEXP x);
    SEXP (*PRCODE)(SEXP x);
    int (*ALTREP)(SEXP x);
    const void *(*DATAPTR_OR_NULL)(SEXP x);
    SEXP (*TAG)(SEXP x);
    SEXP (*CAR)(SEXP x);
    SEXP (*CDR)(SEXP x);
    SEXP (*ATTRIB)(SEXP x);
    SEXP (*PRINTNAME)(SEXP x);
    SEXP (*SETCDR)(SEXP x, SEXP v);
    void *(*R_getEmbeddingDllInfo)(void);
    int (*R_registerRoutines)(void *info, const void *c, const R_CallMethodDef *call,
                              const void *f, const void *e);
    int (*R_useDynamicSymbols)(void *info, int value);
    /* Optional (R >= 4.6). */
    int (*R_GetBindingType)(SEXP sym, SEXP env);
    SEXP (*R_DelayedBindingExpression)(SEXP sym, SEXP env);
    SEXP *R_GlobalEnv;
    SEXP *R_NilValue;
    SEXP *R_UnboundValue;
    int *R_NaInt;
} r;

static int ready = 0;

/* Rust's RPC handler: never touches R; returns a NUL-terminated UTF-8
 * string owned by Rust (valid until the next call). */
typedef const char *(*RustRpc)(const char *op, const char *a, const char *b);
static RustRpc rust_rpc = NULL;

void raven_dbg_set_rpc(RustRpc f) { rust_rpc = f; }

#define REQ(field, name)                                         \
    do {                                                          \
        r.field = dlsym(RTLD_DEFAULT, name);                      \
        if (!r.field) {                                           \
            missing = name;                                       \
            goto fail;                                            \
        }                                                         \
    } while (0)
#define OPT(field, name) r.field = dlsym(RTLD_DEFAULT, name)

/* ---- .Call routines (run inside R's evaluation) -------------------------- */

static SEXP str1(const char *s) { return r.Rf_mkString(s ? s : ""); }

static const char *arg_str(SEXP x) {
    if (r.TYPEOF(x) != STRSXP || r.Rf_length(x) < 1) return "";
    return r.R_CHAR(r.STRING_ELT(x, 0));
}

/* .Call(rpc, op, a, b): hand three strings to Rust, return its string. */
static SEXP dbg_rpc(SEXP op, SEXP a, SEXP b) {
    const char *out = rust_rpc ? rust_rpc(arg_str(op), arg_str(a), arg_str(b)) : "";
    return str1(out);
}

/*
 * .Call(binding, env, name): inspect a binding without forcing it or calling
 * an active binding. Returns list(kind, value) where kind is "missing",
 * "active", "promise" (unforced; value is its expression), "forced" (value
 * is the promise's value) or "value".
 */
static SEXP dbg_binding(SEXP env, SEXP name) {
    SEXP sym = r.Rf_install(arg_str(name));
    SEXP out = r.Rf_protect(r.Rf_allocVector(VECSXP, 2));
    const char *kind = "value";
    SEXP value = *r.R_NilValue;
    if (r.TYPEOF(env) != ENVSXP) {
        kind = "missing";
    } else if (!r.R_existsVarInFrame(env, sym)) {
        /* Checked first: looking an active binding up would call it. */
        kind = "missing";
    } else if (r.R_BindingIsActive(sym, env)) {
        kind = "active";
    } else {
        SEXP v = r.Rf_findVarInFrame(env, sym);
        if (v == *r.R_UnboundValue) {
            kind = "missing";
        } else if (r.TYPEOF(v) == PROMSXP) {
            SEXP pv = r.PRVALUE(v);
            if (pv != *r.R_UnboundValue) {
                kind = "forced";
                value = pv;
            } else {
                kind = "promise";
                value = r.PRCODE(v);
            }
        } else {
            value = v;
        }
    }
    r.SET_VECTOR_ELT(out, 0, str1(kind));
    r.SET_VECTOR_ELT(out, 1, value);
    r.Rf_unprotect(1);
    return out;
}

/*
 * An ALTREP class's package and name. TAG(x) is the class object; its
 * attributes hold (class symbol, package symbol, type). Reading these runs
 * no class method.
 */
static int altrep_class(SEXP x, const char **pkg, const char **cls) {
    *pkg = "";
    *cls = "";
    SEXP info = r.ATTRIB(r.TAG(x));
    if (r.TYPEOF(info) != LISTSXP) return 0;
    SEXP c = r.CAR(info);
    SEXP p = r.CAR(r.CDR(info));
    if (r.TYPEOF(c) == SYMSXP) *cls = r.R_CHAR(r.PRINTNAME(c));
    if (r.TYPEOF(p) == SYMSXP) *pkg = r.R_CHAR(r.PRINTNAME(p));
    return 1;
}

/*
 * An ALTREP vector of a class some package defines: its length, data and
 * elements come from that package's methods, which may run arbitrary code.
 * Base R's own classes (compact sequences, deferred strings, wrappers) are
 * known to be safe.
 */
static int foreign_altrep(SEXP x) {
    if (!r.ALTREP || !r.ALTREP(x)) return 0;
    const char *pkg, *cls;
    if (!altrep_class(x, &pkg, &cls)) return 1;
    return strcmp(pkg, "base") != 0;
}

/*
 * .Call(xlength, x): length without S3/S4 dispatch; NA for a foreign ALTREP
 * vector, whose Length method could run package code.
 */
static SEXP dbg_xlength(SEXP x) {
    if (foreign_altrep(x)) return r.Rf_ScalarReal(NAN);
    return r.Rf_ScalarReal((double)r.Rf_xlength(x));
}

/*
 * .Call(materialized, x): TRUE when reading `x` runs no package code:
 * ordinary vectors and base R's own ALTREP classes. Decided from the class
 * alone; nothing of a foreign class is called (not even Dataptr_or_null).
 */
static SEXP dbg_materialized(SEXP x) {
    return r.Rf_ScalarLogical(foreign_altrep(x) ? 0 : 1);
}

/*
 * .Call(nrow, df): a data frame's row count from its row.names attribute,
 * read from the attribute list directly (getAttrib would ask a foreign
 * ALTREP row.names for its length). NA when that can't be done safely.
 */
static SEXP dbg_nrow(SEXP x) {
    SEXP sym = r.Rf_install("row.names");
    for (SEXP a = r.ATTRIB(x); r.TYPEOF(a) == LISTSXP; a = r.CDR(a)) {
        if (r.TAG(a) != sym) continue;
        SEXP v = r.CAR(a);
        if (foreign_altrep(v)) break;
        /* Compact form: c(NA_integer_, -n) or c(NA_integer_, n). */
        if (r.TYPEOF(v) == 13 && r.Rf_xlength(v) == 2 && r.INTEGER(v)[0] == INT_MIN) {
            int n = r.INTEGER(v)[1];
            return r.Rf_ScalarReal((double)(n < 0 ? -n : n));
        }
        return r.Rf_ScalarReal((double)r.Rf_xlength(v));
    }
    return r.Rf_ScalarReal(NAN);
}

/* .Call(altrep_class, x): "pkg::class" of a foreign ALTREP vector, else "". */
static SEXP dbg_altrep_class(SEXP x) {
    if (!foreign_altrep(x)) return r.Rf_mkString("");
    const char *pkg, *cls;
    altrep_class(x, &pkg, &cls);
    char buf[256];
    snprintf(buf, sizeof buf, "%s::%s", pkg, cls);
    return r.Rf_mkString(buf);
}

/* .Call(rdebug, env): is R's step flag set on this frame? */
static SEXP dbg_rdebug(SEXP env) {
    return r.Rf_ScalarLogical(r.TYPEOF(env) == ENVSXP && r.RDEBUG(env) ? 1 : 0);
}

/*
 * .Call(set_rdebug, env, on): set a frame's step flag (`on` 1L or 0L) (what `n` sets on
 * the browsed frame), returning its previous value. Stepping out of a
 * function stops in the caller only when the caller's flag is set.
 */
static SEXP dbg_set_rdebug(SEXP env, SEXP on) {
    if (r.TYPEOF(env) != ENVSXP) return r.Rf_ScalarLogical(0);
    int was = r.RDEBUG(env) ? 1 : 0;
    /* `on` is an integer (13 = INTSXP); anything else clears. */
    r.SET_RDEBUG(env, r.TYPEOF(on) == 13 && r.Rf_length(on) == 1 && r.INTEGER(on)[0] == 1 ? 1 : 0);
    return r.Rf_ScalarLogical(was);
}

/*
 * .Call(base_bind, name, value): bind `name` in the (locked) base
 * environment by writing the symbol's value cell, where base bindings live.
 * This is what Ark's `base_bind` does (ark/crates/ark/src/modules/positron/
 * utils.R, MIT): pkgload and shiny look `.ark_annotate_source` up in
 * baseenv() itself.
 */
static SEXP dbg_base_bind(SEXP name, SEXP value) {
    SEXP sym = r.Rf_install(arg_str(name));
    r.SETCDR(sym, value);
    return *r.R_NilValue;
}

static const R_CallMethodDef call_methods[] = {
    {"raven_dbg_rpc", (void *)dbg_rpc, 3},
    {"raven_dbg_binding", (void *)dbg_binding, 2},
    {"raven_dbg_xlength", (void *)dbg_xlength, 1},
    {"raven_dbg_materialized", (void *)dbg_materialized, 1},
    {"raven_dbg_rdebug", (void *)dbg_rdebug, 1},
    {"raven_dbg_altrep_class", (void *)dbg_altrep_class, 1},
    {"raven_dbg_nrow", (void *)dbg_nrow, 1},
    {"raven_dbg_set_rdebug", (void *)dbg_set_rdebug, 2},
    {"raven_dbg_base_bind", (void *)dbg_base_bind, 2},
    {NULL, NULL, 0},
};

/* ---- init ---------------------------------------------------------------- */

static void toplevel_register(void *data) {
    (void)data;
    void *dll = r.R_getEmbeddingDllInfo();
    r.R_registerRoutines(dll, NULL, call_methods, NULL, NULL);
    r.R_useDynamicSymbols(dll, 0);
}

/*
 * Resolve symbols and register the `.Call` routines. Returns 0, or 1 with
 * the first missing symbol's name copied into `err`.
 */
int raven_dbg_init(char *err, int errlen) {
    const char *missing = NULL;
    REQ(R_ToplevelExec, "R_ToplevelExec");
    REQ(R_GetCurrentSrcref, "R_GetCurrentSrcref");
    REQ(Rf_getAttrib, "Rf_getAttrib");
    REQ(Rf_install, "Rf_install");
    REQ(Rf_findVarInFrame, "Rf_findVarInFrame");
    REQ(TYPEOF, "TYPEOF");
    REQ(Rf_length, "Rf_length");
    REQ(Rf_xlength, "Rf_xlength");
    REQ(INTEGER, "INTEGER");
    REQ(STRING_ELT, "STRING_ELT");
    REQ(R_CHAR, "R_CHAR");
    REQ(Rf_mkString, "Rf_mkString");
    REQ(Rf_mkCharCE, "Rf_mkCharCE");
    REQ(Rf_allocVector, "Rf_allocVector");
    REQ(SET_STRING_ELT, "SET_STRING_ELT");
    REQ(SET_VECTOR_ELT, "SET_VECTOR_ELT");
    REQ(Rf_protect, "Rf_protect");
    REQ(Rf_unprotect, "Rf_unprotect");
    REQ(Rf_ScalarLogical, "Rf_ScalarLogical");
    REQ(Rf_ScalarReal, "Rf_ScalarReal");
    REQ(RDEBUG, "RDEBUG");
    REQ(SET_RDEBUG, "SET_RDEBUG");
    REQ(R_BindingIsActive, "R_BindingIsActive");
    REQ(R_existsVarInFrame, "R_existsVarInFrame");
    REQ(PRVALUE, "PRVALUE");
    REQ(PRCODE, "PRCODE");
    REQ(TAG, "TAG");
    REQ(CAR, "CAR");
    REQ(CDR, "CDR");
    REQ(ATTRIB, "ATTRIB");
    REQ(PRINTNAME, "PRINTNAME");
    REQ(SETCDR, "SETCDR");
    REQ(R_getEmbeddingDllInfo, "R_getEmbeddingDllInfo");
    REQ(R_registerRoutines, "R_registerRoutines");
    REQ(R_useDynamicSymbols, "R_useDynamicSymbols");
    REQ(R_GlobalEnv, "R_GlobalEnv");
    REQ(R_NilValue, "R_NilValue");
    REQ(R_UnboundValue, "R_UnboundValue");
    REQ(R_NaInt, "R_NaInt");
    OPT(ALTREP, "ALTREP");
    OPT(DATAPTR_OR_NULL, "DATAPTR_OR_NULL");
    OPT(R_GetBindingType, "R_GetBindingType");
    OPT(R_DelayedBindingExpression, "R_DelayedBindingExpression");
    if (!r.R_ToplevelExec(toplevel_register, NULL)) {
        missing = "R_registerRoutines (failed)";
        goto fail;
    }
    ready = 1;
    return 0;
fail:
    if (err && errlen > 0) {
        strncpy(err, missing ? missing : "?", (size_t)errlen - 1);
        err[errlen - 1] = 0;
    }
    return 1;
}

/* ---- current location ---------------------------------------------------- */

typedef struct {
    int skip;
    int found;
    int lines[4]; /* first line, first col, last line, last col (1-based) */
    char *file;
    int filelen;
} SrcrefPayload;

static void copy_str(char *dst, int len, const char *src) {
    if (!dst || len < 1) return;
    int i = 0;
    for (; src && src[i] && i < len - 1; i++) dst[i] = src[i];
    dst[i] = 0;
}

static void toplevel_srcref(void *data) {
    SrcrefPayload *p = (SrcrefPayload *)data;
    SEXP sr = r.R_GetCurrentSrcref(p->skip);
    if (!sr || sr == *r.R_NilValue || r.TYPEOF(sr) != INTSXP || r.Rf_length(sr) < 6) return;
    r.Rf_protect(sr);
    int *v = r.INTEGER(sr);
    p->lines[0] = v[0];
    p->lines[1] = v[4]; /* character columns */
    p->lines[2] = v[2];
    p->lines[3] = v[5];
    SEXP srcfile = r.Rf_getAttrib(sr, r.Rf_install("srcfile"));
    if (r.TYPEOF(srcfile) == ENVSXP) {
        SEXP fname = r.Rf_findVarInFrame(srcfile, r.Rf_install("filename"));
        if (r.TYPEOF(fname) == PROMSXP) fname = r.PRVALUE(fname);
        if (r.TYPEOF(fname) == STRSXP && r.Rf_length(fname) > 0) {
            const char *f = r.R_CHAR(r.STRING_ELT(fname, 0));
            /* Relative names are resolved against the srcfile's wd. */
            SEXP wd = r.Rf_findVarInFrame(srcfile, r.Rf_install("wd"));
            if (r.TYPEOF(wd) == PROMSXP) wd = r.PRVALUE(wd);
            if (f[0] != '/' && f[0] != '<' && r.TYPEOF(wd) == STRSXP && r.Rf_length(wd) > 0) {
                const char *w = r.R_CHAR(r.STRING_ELT(wd, 0));
                int n = 0;
                for (; w[n] && n < p->filelen - 2; n++) p->file[n] = w[n];
                p->file[n++] = '/';
                copy_str(p->file + n, p->filelen - n, f);
            } else {
                copy_str(p->file, p->filelen, f);
            }
        }
    }
    p->found = 1;
    r.Rf_unprotect(1);
}

/*
 * The evaluator's current srcref (R_GetCurrentSrcref; `skip` is NA_INTEGER
 * on R >= 4.5, where NA means "search", and 0 before). Returns 1 and fills
 * `lines` and `file` when there is one, else 0.
 */
int raven_dbg_current_srcref(int use_na, int lines[4], char *file, int filelen) {
    if (!ready) return 0;
    SrcrefPayload p = {use_na ? *r.R_NaInt : 0, 0, {0, 0, 0, 0}, file, filelen};
    if (file && filelen > 0) file[0] = 0;
    if (!r.R_ToplevelExec(toplevel_srcref, &p)) return 0;
    if (!p.found) return 0;
    for (int i = 0; i < 4; i++) lines[i] = p.lines[i];
    return 1;
}

/*
 * Clear R's step flag on the global environment. R leaves it set when
 * stepping runs off the end of a top-level `{` block, and the next
 * top-level input would then stop (design §4).
 */
void raven_dbg_clear_global_rdebug(void) {
    if (ready && r.RDEBUG(*r.R_GlobalEnv)) r.SET_RDEBUG(*r.R_GlobalEnv, 0);
}
