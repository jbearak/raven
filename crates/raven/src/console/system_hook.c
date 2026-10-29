/*
 * system_hook.c — flush the console's buffered output before R starts a
 * child process with system(3).
 *
 * The console batches R's output during bursts (see output.rs). A child
 * started by R's system()/system2() writes straight to the terminal, so
 * anything still buffered must be written first or the child's output lands
 * above it. R's macOS builds announce the child with R_Busy(1), which the
 * console hooks; other builds don't, so on Linux the executable defines
 * system() itself. libR is loaded with dlopen, and ELF resolves its call to
 * system() against the executable first (build.rs exports the symbol), so
 * this wrapper runs, flushes, and hands over to the C library's system().
 * macOS binds libR's calls to libSystem directly, and Windows' R.dll binds
 * its own C runtime, so the wrapper is Linux-only.
 *
 * The flush hook is NULL until the console is running, so the language
 * server (same binary) and anything else calling system() just pass through.
 */

typedef void (*flush_fn)(void);

#if defined(__linux__)
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdatomic.h>
#include <stddef.h>

/* Atomic: system() may be called from any thread, at any time. */
static _Atomic(flush_fn) flush_hook;

void raven_set_flush_hook(flush_fn hook) { atomic_store(&flush_hook, hook); }

typedef int (*system_fn)(const char *);

int system(const char *command) {
    /* Racing first calls may both resolve it; they store the same address. */
    static _Atomic(system_fn) real_system;
    system_fn real = atomic_load(&real_system);
    if (!real) {
        real = (system_fn)dlsym(RTLD_NEXT, "system");
        if (!real) return -1;
        atomic_store(&real_system, real);
    }
    flush_fn hook = atomic_load(&flush_hook);
    if (hook) hook();
    return real(command);
}
#else
/* No wrapper to call it (macOS uses R_Busy; Windows R runs children its own
 * way), so nothing stores the hook. */
void raven_set_flush_hook(flush_fn hook) { (void)hook; }
#endif
