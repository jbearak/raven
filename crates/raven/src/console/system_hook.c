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
 * macOS binds libR's calls to libSystem directly, so the wrapper is
 * Linux-only.
 *
 * The flush hook is NULL until the console is running, so the language
 * server (same binary) and anything else calling system() just pass through.
 */

#define _GNU_SOURCE
#include <stddef.h>

static void (*flush_hook)(void);

void raven_set_flush_hook(void (*hook)(void)) { flush_hook = hook; }

#if defined(__linux__)
#include <dlfcn.h>

int system(const char *command) {
    static int (*real_system)(const char *);
    if (!real_system) {
        real_system = (int (*)(const char *))dlsym(RTLD_NEXT, "system");
        if (!real_system) return -1;
    }
    if (flush_hook) flush_hook();
    return real_system(command);
}
#endif
