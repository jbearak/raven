# R debugger for Raven: design

Date: 2026-10-29. Status: **agreed by both reviewers** (Sonnet and Terra, round 8), pending the P0 prototype gate. v1–v8 were each reviewed independently; §13 maps every finding to a change.

Companion: [`2026-10-29-debugger-prior-art.md`](2026-10-29-debugger-prior-art.md) (the survey, cited as *survey §…*).

Two markers flag the status of facts:
- **[probe]**: checked on R 4.6.1 on this machine with scripted R sessions, by the author or a reviewer.
- **[P0]**: an open question with pass/fail criteria, settled in the prototype phase (§10).

## 1. Goal and honest scope

The goal is a graphical R debugger for stock VS Code. It speaks the Debug Adapter Protocol (DAP) and is served from `raven console` (`crates/raven/src/console/`).

The bar is that **for VS Code users on macOS and Linux running Raven's console**, it is the best R debugger available overall, and as close to js-debug and debugpy as R allows. It is *not* a strict superset of every existing tool: the gaps below list the concrete capabilities others have that Raven won't, at least at first. The table compares capabilities.

| # | Capability | Ark (Positron) | RStudio | vscDebugger | Raven |
|---|---|---|---|---|---|
| C1 | Stop at `browser()`, `debug()`, `debugonce()`; stack; variables; stepping; evaluate in a frame | ✓ | ✓ | ✓ | ✓ |
| C2 | Line breakpoints in code run from the editor: selection, chunk, Source, nested `source()` | ✓ except top-level statements in sent code (*survey §Ark: Breakpoints*, from reading the code) | Source only | custom launch | ✓ including top-level statements (§5.3) |
| C3 | Conditional breakpoints, hit counts, logpoints | ✓ | ✗ | ✗ | ✓ |
| C4 | Function breakpoints | ✗ | ✗ | ✗ | ✓ (§5.1) |
| C5 | Breakpoint state with a concrete reason, including predictions from Raven's cross-file `source()` graph | partial | partial | ✗ | ✓ (§5.5) |
| C6 | The `stopped` event says why execution stopped; `exceptionInfo` request | always "step" | n/a | partial | ✓ |
| C7 | Error, warning and interrupt filters; pause | ✓ | error only | error only | ✓ (§7) |
| C8 | Variables: paged, promise-safe, readable formatting for base classes, link to the data viewer | not paged | environment pane | ✓ paged, extensible | ✓ (§6) |
| C9 | Typing in the console and using the UI are equivalent | via a round-trip through the frontend | ✓ | scraped from stdin | ✓ (one process sees every prompt) |
| C10 | **Experimental:** breakpoints bind to code that has already run, with no re-run, including uncompiled closures that are running now (§5.4) | ✗ ([positron#15355](https://github.com/posit-dev/positron/issues/15355)) | named functions, rebound via `trace()` | named functions | experimental: discovered closures, with coverage reported |

### Gaps (others do better, or R can't do it)

- **Platforms and processes.**
  - Windows needs the console port first.
  - Console only: there is no attach to plain R, radian or arf. vscDebugger can launch its own R.
  - Knit and Quarto render processes can't be debugged.
- **Package development and Shiny depend on Ark's hook name.** Raven implements Ark's de facto hook, `.ark_annotate_source` (§5.3), which pkgload ≥ 1.5 and shiny ≥ 1.13 already call. So `load_all()` and Shiny app files get breakpoints injected at load time, as in Ark.
  - **Older versions.** With older pkgload or shiny, breakpoints there bind only through experimental live patching.
  - **If Ark changes the hook's contract,** Raven must follow.
- **vscDebugger features Raven doesn't match.**
  - User-extensible variable formatters (`.vsc.addVarInfo`). Raven's default path runs no user code (§6); an opt-in hook is future work.
  - Source links attached to `print`/`cat` output. vscDebugger replaces those functions, which breaks testthat output expectations (*survey §vscDebugger*). Raven won't do that.
- **Breakpoints inside arguments of masked or unknown functions.** Send-time injection into a braced argument requires the callee to be verified at send time (§5.3). Anything else stays uninstrumented.
- **Limits of the instrumentation contract (§5.3).**
  - A later rebinding can change the results of instrumented code until it is re-run. This covers non-inlined known functions (`with`, `lapply`, `tryCatch` …) rebound to quoting functions. It also covers core syntax (`if`, `{`) rebound after instrumentation in code that isn't compiled.
  - The detector flags such rebinding only in the global and attached environments. Rebinding in closure, factory or namespace environments goes undetected.
  - The probe assumes `::` keeps its base meaning.
  - Calls nested inside `eval`/`list2env`-style dynamic scope aren't instrumented.
- **In compiled frames, `n` acts like `c` after a stop that comes through a hook.** A pause, or an exception stop, landing in a frame that is already compiled produces a stop where Step Over continues to the end, as in plain R **[probe]**. No JIT policy fixes this for code that has already run. Raven says so in the Debug Console when it happens. It doesn't affect breakpoints: injected code is never compiled.
- **Instrumented functions are slower and look different.**
  - A function containing a probe is never byte-compiled. Measured **[probe]** with the v8 probe: a 200,000-iteration loop took about 0.44 s with the hook unset (0.25 s with a trivial hook), against about 0.01 s unprobed and compiled. Each `::` call in the probe is itself a closure call.
  - `print(f)` shows the probe lines for functions defined from injected text.
- **Caught errors.** Errors caught by `tryCatch` or `try`, and warnings muffled locally, never reach a global hook **[probe]**.
- **Live patching (C10) and the JIT.**
  - With R's JIT on, a function with a loop is compiled on its first call, and any other function on its second **[probe]**. Live patching therefore only reaches closures that are still uncompiled.
  - In practice C10 needs the JIT off, which happens when live patching is turned on (§5.4.6). That makes user-defined R functions slower. Package code stays byte-compiled.
  - A compiled frame that is already running never sees a patch.
- **Not offered:** data breakpoints, restart frame, step back, and edit-and-continue.

## 2. Architecture

```
VS Code ──DAP (Unix socket / named pipe)──▶ raven console: DAP thread ─queue─▶ R main thread
   ▲                                                                     (prompt service points)
   └── extension ◀── control connection (subscribe; push events) ── raven console
```

- **DAP transport.** Each console process serves DAP on its own socket, and the extension connects with `vscode.DebugAdapterNamedPipeServer`.
  - **Access control.** A DAP `evaluate` request runs arbitrary code, so the socket gets the same protection as the existing IPC socket: mode 0600, created under umask 077, inside a directory created with mode 0700.
  - **F5 and "Debug R File".** These reuse the active Raven console, or start one if there is none. They then attach, and run Source File on the current file.
  - A session is bound to one console.
  - Breakpoint mirroring and live patches belong to the **console's breakpoint table**, not to a session.
  - The extension mirrors VS Code breakpoints to every console.
  - `contributes.breakpoints` lists `r`, `rmd` and `quarto`.
- **Threads.** The DAP thread owns plain-data state and never calls R. Work that needs R goes on a main-thread queue, and is served at the service points below.
- **Service points.** These are the places the R thread drains the queue. One mechanism, `service()`, runs at every one of them:
  - the reedline **idle callback** at depth-1 prompts. It does not set the break flag, so a half-typed line is never stashed or repainted;
  - the **nested read** at depth ≥ 2. `plain_read` today is a blocking `read(0)`. It becomes `poll()` on stdin plus a wake fd, and calls `service()` whenever it wakes. Without this, a breakpoint hit inside `later`, `httpuv` or plumber callbacks run from the event pump would hang the debugger. This is a P1 gate.
  - the **polled-events tick** while R is busy. Raven installs its own `R_PolledEvents` and chains to the previous one, because tcltk sets it too.
    - The tick runs only queued **patch applications** (§5.4). They run no R code. Every node and srcref attribute is built ahead of time at a prompt, so a tick only swaps pointers (`SETCAR` and attribute-pointer stores) on preserved objects.
    - Measured **[probe]**: it fires about every 1,000 evaluations in both interpreted and compiled loops, and during `Sys.sleep`. It never fires inside long native calls such as `sort()` or `system()`.
- **Priority input channel.** Hidden input goes here and never through `pending`, so `route_submission` can't park it:
  - auto-steps;
  - environment capture;
  - the one-time handler install;
  - console-output filtering for those hidden steps. The console drops R's `debug: …` and `Called from: …` lines for them, as Ark's `console_filter.rs` does.
- **Locks.** No lock is held across an R call (the lesson from positron#5024).
- **Errors inside Raven's own evaluations.** Every R evaluation Raven starts runs in an R-level `tryCatch` inside the shim. The shim also sets an "internal" flag that `reset_console` respects. A Debug Console error must never discard the parked rest of the user's submission.
- **Control connection.** A new IPC op, `subscribe`, opens one persistent connection per console. Over it the console pushes `stopped{generation}`, `running{generation}` and `breakpointState`.

### 2.1 Session state machine (per console)

`stopGeneration` increases on every stop. Every stop-related event and response carries it, and anything stale is dropped.

| State | VS Code shows | Transitions |
|---|---|---|
| **Idle** | plain gutter breakpoints, plus a status-bar summary of their states and reasons (§5.5) | → Interactive when R stops (`raven.debugger.attach = onStop`, the default; `never` turns this off) or when the user starts debugging |
| **Interactive** | toolbar, stack, variables, gutter verification | → Idle when R reaches a level-0 prompt |

- **Attach only when R stops (owner's decision).** No session exists while R runs. The always-attached "Quiet" session and its session swaps are **not built**; they could be reconsidered later if breakpoint states before the first stop turn out to matter.
- **Session end vs detach.** The session ending because R returned to the prompt **keeps** all instrumentation and starts no cooldown. Only a *user* disconnect counts as a detach.
  - **Detach** (Disconnect) lets R continue with `c`, as attach sessions in other debuggers do; the next stop attaches again. (An earlier draft left R paused and suppressed auto-attach for 30 s; with no session, a paused R had nothing to show it, so 1.0 resumes instead.)
  - **Terminate** (Stop) sends `Q`.
- **Handshake.** `initialize` → `attach` → `initialized` → `setBreakpoints` / `setExceptionBreakpoints` → `configurationDone` → replay of `stopped` for the current generation, if R is still stopped. Each new session receives `breakpoint` events with the current state of every breakpoint.
- **P0 checks** (pass/fail):
  - starting a session on a stop and ending it at the prompt, with no visible flicker in typical use;
  - event ordering under rapid continue and stop;
  - two consoles;
  - extension reload.

## 3. Knowing where code came from

**[probe]** In R's interactive REPL, a `#line N "path"` line is ignored at top level but honoured inside a braced expression.

- **When a submission is tagged.** The IPC `execute` op gains `location {path, line, col}`. Tagging applies only when all of these hold:
  1. R is at a **level-0 `>` prompt**;
  2. no expression is half-entered;
  3. `R_ParseVector` parses the whole submission into complete expressions.

  Everything else is fed raw, exactly as today: continuation sends, sends at a `Browse>` prompt, and syntax errors.
- **Wrapping.** Each top-level expression is fed as `{\n#line L "path"\n<its lines>\n}`, with the first line padded to its starting column.
- **What wrapping preserves [probe].** All of these are identical to unwrapped input:
  - autoprint, invisibility and `.Last.value`;
  - `Error:` versus `Error in f() :` call text;
  - warning text;
  - `for` and `if`/`else`;
  - srcref filename and line.
- **Known differences (documented).**
  - A user-rebound `` `{` `` in the global environment applies to the wrapper.
  - Echo is per expression. Original lines are echoed just before their expression is fed, so output still interleaves between expressions as before.
- **Rollout.** Wrapping is behind `raven.console.tagSendLocations`, on by default after P2's differential tests pass.
- **What P2 tests.** Visibility, `.Last.value`, warnings, errors, `addTaskCallback`, echo order, incomplete input and a nested `browser()`.
- **Beyond the debugger,** wrapping also fixes tracebacks and `getSrcref` for code sent from the editor.

## 4. Stops, stepping, location

- **What counts as a stop.** A stop is `read_console` with a `Browse[n]> ` prompt, `hist = 1` and level ≥ 1. On a stop the console:
  1. feeds `.raven_capture()` on the priority channel. This is RStudio's trick: `parent.frame()` there is the browsed environment, even while a promise is being forced;
  2. reads the location with `R_GetCurrentSrcref(NA_INTEGER)` on R ≥ 4.5, or `0` on older R. The symbol is exported **[probe]**;
  3. snapshots the stack (§6);
  4. bumps the generation;
  5. emits `stopped` with the true reason.
- **Two kinds of hidden stops.** The console never shows either of these.
  1. **Breakpoint hits.** When the hook decides to stop, it records `{id, env}` in Rust before it opens the browser.
     - The resulting prompt sits at the probe, one step *before* the anchored statement. Reported **[probe]**: with `NA_INTEGER`, `R_GetCurrentSrcref` returns the probe's srcref.
     - The console feeds exactly **one** hidden `n`. That stops on the anchored statement before it runs, in the user's own debug context **[probe]**.
     - Only then does it emit `stopped{reason: breakpoint, hitBreakpointIds}`, with the location taken from the breakpoint table.
     - Every later `n`/`s`/`f` behaves exactly as R defines it, from the user's frame. Without this hidden step, the first `n` would land on the same line again, and `f` would only finish the hook's frame **[probe]**.
  2. **Scaffolding steps.** These happen when the user steps *onto* a probed line. Probes and patch scaffolding carry srcrefs whose srcfile is the marker `<raven-probe>` (§5.2).
     - The hit record is consumed when the stop it caused is reported, and cleared at every resume. So a stale record can never make a later scaffolding stop visible.
     - If a step stops on a marker srcref and no hit was recorded, the console auto-steps with `n` until the srcref is the user's again, at most 4 times.
     - Each `n` is fed only while the current srcref is a marker, so no user statement ever runs unseen.
     - The result: stepping onto a breakpoint line produces exactly one visible stop. Without markers it produced three **[probe]**.

  P0/P2 tests both paths with: the condition false, true or erroring; logpoints; `n`/`s`/`f`/`c`/`Q` from a hit stop; nested browsers; bytecode.
- **No double stop on a probe the step already reaches.** The hook suppresses its own browser only when **both** of these hold:
  1. `RDEBUG(env)` is set on the probe's **own frame** (exported **[probe]**, read through the shim);
  2. the last resume command the console fed was `n` or `s`.

  Then R's stepping is certain to stop at the next statement of that frame. The hook counts the hit and runs any logpoint.
  - **How the console labels that stop.** It reports the step's stop as `breakpoint` only when the breakpoint *qualifies to stop*: no log message, the condition is true, and the hit condition is met. The hook records those results separately from the hit count. A false condition or a logpoint leaves the stop labelled as a plain `step`.
  - **After `f` the hook never suppresses, and after `c` it never suppresses either.** **[probe]** After `f`, `RDEBUG` stays set on the frame being finished, yet R doesn't stop there, because `do_begin` also checks `browserfinish`. So `RDEBUG` alone would silently lose a breakpoint later in the same function.
  - **Not suppressing is always safe.** The worst case is a nested browser, which the hidden `n` (above) turns into a single visible stop.
  - **Tests:**
    - breakpoints inside callees during Next and during Step Out;
    - a breakpoint later in the **same frame** after `f`, including inside a loop in that frame and in the top-level wrapper;
    - each with conditions and logpoints.
- **Stepping commands.**

  | DAP request | Fed to R |
  |---|---|
  | `next` | `n` |
  | `stepIn` | `s` |
  | `stepOut` | `f` |
  | `continue` | `c` |
  | terminate | `Q` |

  - Commands go through the priority channel and are echoed dimmed.
  - `options(browserNLdisabled = TRUE)` is set while R is stopped, and restored if Raven still owns it.
  - The JIT is turned off around `s` (Ark).
  - After an exception or pause stop, `n` becomes `f`.
- **Just my code (default on, `raven.debugger.justMyCode`).** When `s` lands in a frame with no srcref inside an installed package, the console steps out again, at most 64 times. This is debugpy's default.
- **Leaked debug flag.** When stepping runs off the end of a top-level wrapper, `RDEBUG(R_GlobalEnv)` stays set, and the *next* input stops **[probe]**.
  - **Fix:** at a level-0 prompt after a stop, the console calls `SET_RDEBUG(R_GlobalEnv, 0)`. `SET_RDEBUG` is exported **[probe]** but non-API since R 4.5, so it is loaded with `dlsym`.
  - **Fallback** if the symbol is missing: a terminal marker probe at the end of each wrapper, where `n` is rewritten to `c`. P0 tests that this never skips user code.
- **Top-level stepping across expressions.** This covers tagged sends and `.raven_source` alike. A top-level breakpoint is a real `browser()` stop inside its expression's wrapper.
  - **Running off the end:** when step-over leaves the expression, the console injects a one-shot marker probe at the start of the next queued expression and continues.
  - **Continue** removes the one-shot probe.
  - `.raven_source` evaluates expression by expression, using the same one-shot rule.

## 5. Breakpoints

### 5.1 Model

- **Line breakpoints.**
  - **Key.** Each is keyed by `(canonical path, line)`.
  - **Fields.** An id, a condition, a hit condition, a log message, a state, a reason, and the source version it was bound to. The state is one of `pending`, `verified`, `partial`, `invalid` or `disabled`.
  - **Line snapping.** `breakpointLocations` comes from Raven's parser. A breakpoint snaps to the first expression that starts on or after its line. On a line with several statements, it anchors to the first.
- **Function breakpoints.** `supportsFunctionBreakpoints` maps to `debug(name)`, or `debugonce` when the breakpoint is a one-shot. The name resolves in the global environment, or as `pkg::fun`.

### 5.2 The probe

A probe is a **separate statement**, never a wrapper around the user's statement. Wrapping would change `stop()`'s error call to the helper's; a separate statement keeps the user's call text and invisibility **[probe]**. In both text and AST form it is the same expression:

```r
base::`if`(base::identical(base::Sys.getpid(), <pid>L),
           base::getOption("raven.debug_hook", base::alist)("<id>", base::environment(), browser()))
```

- **The user's environment is passed explicitly.** `base::environment()` is a promise in the user's frame. A `parent.frame()` inside `h` would not be the user's frame **[probe]**. `h` evaluates the condition, hit count and log message in `env`.
- **The probe looks up no maskable name except `::` and `browser`.** It has no lambda, and no bare `if`, `&&`, `<-`, `(` or `function`. Every operation is a `base::`-qualified call in functional form.
  - **Laziness.** `` base::`if` `` is a special primitive, so its branch, and with it `browser()`, stays unevaluated unless the pid matches.
  - **Default when the hook option is unset:** `base::alist`, which returns its arguments without evaluating them, so the probe does nothing.
  - **Assumptions.** The only lookups left are `::` itself (R's namespace mechanism, assumed like `base` itself) and the bare `browser` (below). If `::` is masked, the probe throws an error, aborting the user's call, rather than silently doing nothing. That's acceptable, since masking `::` also breaks most packages. The instrumentation contract (§5.3) assumes `::` keeps its base meaning, and a test documents the error.
  - **[probe]** With `environment`, `if`, `&&`, `(` and `function` all masked locally in the function, the probe still reaches the hook with the user's frame. With the hook unset, the function returns its normal result. The literal `browser()` still keeps the JIT away.
- **The hook forces `b` as its very last action.** That is, its body ends with `if (stop) b`, or with the masked-`browser` fallback, and nothing follows it. All condition, hit-count and logpoint work happens first.
  - **Why.** **[probe]** If anything follows the force, the hidden `n` (§4) stops inside the hook instead of at the user's anchored statement.
  - **P0 test:** a single hidden `n` lands on the anchored statement.
- **Except `browser`, which stays bare.** The `browser()` argument has to be bare. **[probe]** Only a bare `browser()` call in the user's function body stops R's JIT from compiling it; neither `base::browser()` nor a bare `browser()` inside the lambda's own body has that effect.
  - **When `h` decides to stop,** it forces `b` only if `browser` in `env` is still base R's own function. Otherwise it runs `base::eval(quote(base::browser()), env)`. Either way the browser opens in the user's frame.
  - **Base-name tests** cover both the text form and the AST form, with `environment`, `Sys.getpid`, `getOption`, `if`, `&&`, `(`, `function` and `browser` shadowed, globally and locally.
  - **Errors.** A condition that errors stops and reports the error. It never aborts the user's program.
  - **Logpoints** emit a DAP `output` event and never stop.
- **The probe needs nothing outside base R.** The probe is plain text, so it works when fed through the REPL. It also serializes and travels to workers. In another process, including forks, it does nothing, because the pid differs and the option is unset there. It refers only to base functions, never to a Raven name, so it can't fail with "could not find function".
  - **Text form:** each probe line sits under its own `#line 1 "<raven-probe>"` directive, followed by `#line N "path"` for the next user line.
  - **AST form:** the probe expression is built once per console, and its srcref gets the marker srcfile.
- **The literal `browser()`** keeps R's JIT from compiling the function **[probe]**.
- **Helpers.** `baseenv` is locked **[probe]**, so helpers live in Raven's private environment. `.raven_capture` is reached through an attached `tools:raven`, which is used only by hidden input in this process. Attaching it is a new, user-visible entry in `search()`, as RStudio's `tools:rstudio` is. The docs mention it.

### 5.3 Send-time injection

This covers tagged sends (§3), Run Chunk (the `#line` path is the `.Rmd` or `.qmd` file), `.raven_source`, and the `source()` hook.

- **Anchoring and invalid lines.** These follow Ark's rules (`console_annotate.rs`, MIT). A breakpoint on a line holding only `}`, or on an empty `{}`, is `invalid`.
- **Inject only where the code is certain to run as code.** A position qualifies only if every call on the path from the wrapper (or the function body) down to it is one of:
  - **core syntax:** `{`, `(`, `if`, `for`, `while`, `repeat`, the value side of `<-`/`=`/`<<-`, or a function literal's body;
  - **a callee checked immediately before its own top-level expression is fed** (per expression, so an earlier expression in the same send that masks `local` or `with` is already in effect). The check runs at a level-0 prompt with R idle. The console looks up the callee's name as the code will (in the global environment for a send; in the closure's environment for a live patch). It requires the result to be `identical()` to the expected function in a table of known functions, so a masked function never qualifies.
    - **That check alone isn't enough.** A call can still resolve to a **nearer binding** at run time, for example `local <- function(x) substitute(x)` assigned inside the enclosing function (Terra, R 4.6.1).
    - **So the callee must also pass a static check.** Raven's scope analysis has to show that nothing in the enclosing top-level expression or function can bind the callee's name, at any depth. That covers `local()`, `with()` and `eval` environments, not only function scopes. That rules out:
      - parameters;
      - assignments by `<-`, `=`, `<<-` or `assign()`;
      - `delayedAssign`/`makeActiveBinding`;
      - any construct that changes scope dynamically: `eval`/`evalq` with a non-literal environment, `list2env`, `attach`, `sys.function` tricks, `environment<-`.

      If the check can't rule a binding out, the argument stays unchanged and the breakpoint is `invalid`: "`<f>` may be rebound inside this function".
    - **The checks force nothing that could run user code.**
      - **Package lazy-load promises are the one exception.** In a fresh session, `test_that`, `observeEvent` and even `base::with` are still unforced lazy-load promises **[probe]**. When a binding is a promise whose expression is R's own `lazyLoadDBfetch(...)` call (read with `R_DelayedBindingExpression`), and it lives in a package or base environment, the check forces it. That runs R's loader, which can load another namespace that the value refers to, and so run that package's `.onLoad`. It never runs code from the user's session.
      - **Everything else stays unverified.** Any other promise (such as a user's `delayedAssign`) and any active binding are never forced, and count as "not verified".
    - **Tests:**
      - local assignment, a parameter named like the callee, active bindings, delayed assignment, `eval` with a computed environment, and a rebinding inside a nested `local()`/`with()`;
      - a **fresh session**, where `test_that`, `observeEvent` and `with` are still lazy-load promises.

  **The table of known functions.** Built from Raven's NSE tables, it lists which argument of each function is evaluated as code, either in place or later:
  - **in place:** `local`, `tryCatch`, `withCallingHandlers`, `try`, `suppressWarnings`, `with`, `system.time`, …;
  - **standard evaluation, for function-literal arguments:** `lapply`, `sapply`, `Map`, …;
  - **evaluated later as code:** `testthat::test_that`, `shiny::observeEvent`, `shiny::reactive`, `shiny::render*`, `shiny::isolate`, …

  **Everywhere else, nothing is injected:** quoting functions, unknown functions, user-defined functions, and masked names. A breakpoint there gets one of three reasons:
  - "captured as data";
  - "inside `<f>()`: Raven can't verify this runs as code";
  - "`<f>` is masked".

  **What the check can't catch.** A callee rebound *while* the same expression is running is a documented limitation.

  **Tests:** a masked `local <- function(e) substitute(e)`, a replaced `pkg::f` binding, and a dynamically chosen callee.
- **The instrumentation contract (later rebinding).** No instrumentation of R code can be sound against every later rebinding; even the top-level wrapper's `{` can be masked. Raven checks names when it instruments code, as R's byte compiler does at its default optimisation level (2).
  - **Where R's compiler goes further.** For **core syntax and the functions it inlines** (`{`, `if`, `local`, …), it also keeps their base meaning after a later rebinding.
  - **Where it doesn't.** Compiled calls to the rest of the known-function table (`lapply`, `with`, `tryCatch`, `suppressWarnings`) do see a later rebinding **[probe]**.
  - **What that means for Raven.** For those functions, a later rebinding to a function that **quotes** its argument **can change program results**: the captured expression then contains the probe. This lasts until the code is re-run. The detector below flags it at the next prompt when the rebinding is in the global or an attached environment; elsewhere it goes undetected.
  - **What R's compiler does.** It checks for shadowing when it compiles a function, then keeps the base meaning of core syntax and base functions even if they're rebound later. **[probe]** After `` `if` <- function(...) substitute(list(...)) `` and `local <- function(x) substitute(x)` at the global level, compiled `function() if (TRUE) { 42 }` and `function() local({ 42 })` still return `42`; only uncompiled code sees the rebinding.
  - **Raven's matching rules:**
    1. **Check at instrumentation time.** Core syntax (`{`, `(`, `if`, `for`, `while`, `repeat`, `<-`, `=`, `<<-`, `function`) gets an identity check when code is injected or patched. It also gets a **literal-binding** static check: a parameter, `<-`, `assign("if", …)`, or the name in `delayedAssign`/`makeActiveBinding`.
       - **Where the broader check applies.** The dynamic-scope clause (`eval` with a computed environment, `list2env`, …) applies only to calls nested inside known functions. Applying it to core syntax would invalidate every breakpoint in such a function body; the cost of not doing so is listed in the gaps.
       - If a form is shadowed at that point, nothing beneath it is injected.
    2. **Detect later rebinding, per name, as advice only.** At each level-0 prompt, the console looks up each core or known-function name the way a function lookup would.
       - **Where it looks:** the global environment, then attached environments down to base. That is about 40 lookups, none of which force anything.
       - **What counts as a mask:** a function-valued binding that isn't `identical()` to the expected function, or an active binding, or a promise that isn't a package or base-env `lazyLoadDBfetch` promise. Unforced lazy-load exports, such as `test_that` in a fresh session, are treated as not masked, by the same rule the instrumentation check uses.
       - **What doesn't:** plain data variables such as `local <- TRUE`, which function lookup skips. Nor do S4 generics whose default method is the expected function, as S4Vectors' `with` and `lapply` are.
       - **What happens on a mask.** The breakpoints whose probes sit beneath that name get the reason "`<name>` was rebound; re-run instrumented code to drop probes", and those probes are marked stale. New sends and patches are already covered by rule 1, name by name, so nothing is switched off globally.
       - **When the mask goes away,** the reasons clear and the probes are re-armed.
       - **While `{` itself is rebound,** location tagging (§3) is turned off, which restores exactly today's behaviour.
       - **What the detector doesn't see (outside its coverage, and not claimed):** rebinding in namespace imports, closure or factory frames (including a change made later through `environment(f)`), `local()`/`sys.source` environments, and the namespaces live patching targets. Those are checked only when code is instrumented. A later rebinding there goes unnoticed; this window is documented.
  - **Tests:** a global mask after definition; a local mask; a masked `if` or `{`; a mask in an attached environment; the detector's notice and the shutdown of injection.
- **One-line functions** such as `function(x) x + 1` are braced in the injected text.
- **`.raven_source(path, ...)`** is what Raven's Source File command calls. It parses with `keep.source`, then injects **one expression at a time, just before evaluating it**, so the identity checks see what earlier expressions did. It injects into the language objects (no text munging), and evaluates expression by expression like `source(exprs=…)`.
- **The pkgload and Shiny hook (`.ark_annotate_source`).** pkgload ≥ 1.5 looks this function up in `baseenv()` **without inheritance**, with `rlang::env_get(baseenv(), ".ark_annotate_source", default = NULL)`. shiny ≥ 1.13 uses `get0(..., baseenv())`.
  - **What they do with it.** Both call it as `(lines, uri)`, where `uri` is `file:///…`. If it returns text, they parse and evaluate that text in place of the file.
  - **Binding it.** `baseenv` is locked, so Raven binds the function the way Ark does (`base_bind` in Ark's `utils.R`): from the shim, it writes the value straight into the symbol's value cell, which is where base bindings live.
  - **What it returns.** `NULL` when the file has no armed breakpoints; otherwise the file's text with probes injected and `#line` directives added (§5.3 rules). The text is verified per top-level expression, and callee checks run against the package namespace.
  - **Coexistence with Ark.** Ark and Raven never share an R process; Raven's console is off in Positron. So there is no conflict over the name.
  - **Contract.** It follows Ark's documented signature, `(source, uri, with_visible)`. Tests run against the pkgload and shiny versions that call it.
- **The `source()` hook.** It covers nested `source()` calls in scripts.
  - **When it's installed:** whenever **any armed breakpoint** (mirrored or from a session) is in a file that may be sourced. It does not wait for a session to start.
  - **How:** `unlockBinding("source", baseenv())`, assign, then lock again. Calls written as `base::source` reach the same binding.
  - **What it handles:** `file` plus `local`, `echo`, `print.eval`, `chdir` and `encoding`, with `local` resolved against the caller's frame. Anything else (connections, URLs, other arguments) is delegated to the original `source()` unchanged. Breakpoints in a file loaded that way get a reason, "sourced via an unsupported `source()` form", rather than silently staying pending.
  - **Removal:** it is removed when no breakpoints remain, and only if the binding still holds Raven's function.
  - **Tests:** the default `attach: onStop` workflow, the `base::` qualified call, unsupported arguments, and restoration.

### 5.4 Live patching (experimental: `raven.debugger.livePatching`, off by default until P3 passes)

1. **Discovery**, at a prompt or after a top-level evaluation, never at the tick.
   - **Which closures.** Those whose srcref filename, resolved against the srcfile's `wd`, matches the file and whose range covers the line.
   - **Where it looks.** The global environment, attached environments, loaded namespaces that have srcrefs, and lists two levels deep.
   - **Budget.** 50,000 bindings. If the budget runs out, the breakpoint becomes `partial`, with the reason "search incomplete".
   - **What it claims.** Discovery promises nothing beyond the closures it actually found.
2. **Sync check.** It compares the closure's srcref text against the function's text in the current buffer, using an offset map so unrelated edits don't matter. On a mismatch the breakpoint is `pending`, with the reason "function changed since it was run".
3. **In-place patch for uncompiled bodies.** The anchored statement cell is replaced with `{ <probe>; <original statement> }`.
   - **Srcrefs.** The inner block gets a three-entry `srcref` attribute: the marker for the `{` and the probe, then the statement's own srcref.
   - **Reach.** The patch reaches every closure that shares that body object: copies made with `environment<-` (R6 instances, factories) and a frame that is already running **[probe]**. Closures with independently parsed or copied bodies are not reached.
   - **Ownership.** Raven calls `R_PreserveObject` on both the original and the installed node. It restores a cell only if the cell still holds Raven's node; otherwise it drops its record. `trace()` copies bodies, so it doesn't conflict with a patch.
4. **Applying patches.** A patch is applied at the next service point. That can be the tick while R is busy, because applying a patch only swaps pointers to nodes and srcref attributes that were built and preserved ahead of time.
   - `setBreakpoints` answers `pending` immediately. A `breakpoint` event follows once the patch is applied.
   - Inside native code the patch may never apply before the line runs. That is documented.
   - **P0 pass/fail:** applying a patch at the tick under `gctorture`, during interrupts, and across the shim's longjmp boundary.
5. **Compiled closures.** `SET_BODY` is not exported **[probe]**, so a compiled closure can't be reverted in place. Instead, each *discovered binding* holding one is rebound to a fresh closure with the patched AST and copied attributes:
   - `R_mkClosure` on R ≥ 4.5, which is exported **[probe]**;
   - `as.function` on older R.

   Locked namespace bindings are unlocked, assigned and locked again. On detach a binding is restored only if it still holds Raven's closure.
   - **Rebinding is visible.** Rebinding changes `identical()` and the identity of S3/S4 table entries.
   - **Reported state.** The breakpoint reports `partial: N bindings rebound; other compiled copies aren't reached`. If a compiled frame on the stack belongs to that function, the reason adds "running call is compiled — takes effect on next call".
6. **JIT policy (decided: policy A, recommended independently by Sonnet and Terra).** This follows Ark, with one addition.
   - **What Ark does.** It leaves R's JIT alone, except that it turns it off around Step Into (`s`) and restores it at the next prompt, so stepping doesn't land in compiler internals (positron#11890). Ark needs nothing more, because it has no live patching. Its injected probes contain a bare `browser()`, which already keeps the functions that hold breakpoints uncompiled.
   - **Default: the same as Ark.** Nothing else is changed, so code without breakpoints runs at full speed. Send-time injection (§5.3) doesn't need the JIT off, for the same reason as Ark's.
   - **With `raven.debugger.livePatching` on:** the JIT is turned off from the moment the setting takes effect. If the setting is on at console start, that's from the start. Turning it off from the first breakpoint (the earlier `onBreakpoint` default) is too late: by then the functions that matter have usually been compiled. And when live patching is off, it costs speed for no benefit.
   - **Turning the JIT off doesn't undo earlier compilation.** **[probe]** `enableJIT(0)` doesn't uncompile closures that are already compiled. So no policy can rescue code that has already run. Policies B–D (JIT off at the first breakpoint, during sessions, or from console start) were rejected: they cost speed without fixing that.
     - **The measured cost:** hand-written scalar loops run about 2.5× slower with the JIT off. Vectorised data-frame code is unaffected.
   - **Function breakpoints don't need the JIT off.** R runs the plain syntax tree of any closure flagged with `debug()`, compiled or not **[probe]**.
   - **The Step Into toggle is kept, and cheap.** Neither reviewer could reproduce positron#11890 on R 4.6.1. P3's matrix on R 4.3–4.6 includes "`s` into a compiled callee with the JIT on". Restoring the level after `s` follows the ownership rule.
   - **Notice.** Turning on live patching mid-session prints a notice that functions which have already run once or twice won't be patchable until they're re-run.
   - **Ownership.** Raven restores the user's JIT level only if it still owns it.
7. **Retry.** Raven retries discovery only while live-patch breakpoints are pending. It doesn't wait for the file to change, because loading an unchanged file changes the heap, not the file.
   - **Triggers.** Some events always cause an immediate retry: `.raven_source` or the `source()` hook finishing, `load_all` returning, and a tagged send that defined functions. Apart from those, a retry runs after a top-level evaluation with exponential backoff: after 1, 2, 4 … up to 64 evaluations.
   - **Cost limits.** Each retry has a **10 ms latency budget**, measured with the session's own clock. It resumes the walk where it stopped last time, rather than starting over.
   - **What discovery won't touch.** It never forces promises (including lazy-load ones) or active bindings.
   - **Tests:** an unchanged file loaded after a failed first attempt eventually binds; console latency is measured with 1,000 pending breakpoints.

### 5.5 Verification and edits

- **Verified.** A probe for the breakpoint exists in code loaded from source version V. It is set when injected code evaluates (Ark's range-verify approach) or when a patch is installed. It is never inferred from a matching path and line alone.
- **Partial.** Some, but provably not all, reachable copies are bound.
- **Reasons.** Every state other than `verified` carries one. Examples:
  - "no expression on this line"
  - "not run since edit"
  - "file not run in this session — will bind when `main.R` runs (it sources this file)" (predicted from Raven's cross-file `source()` graph)
  - "captured as data"
  - "Raven can't tell whether this runs as code"
  - "partial: …"
  - "takes effect on next call"
- **Edits.** On `didChange`, Raven recomputes state per function or top-level expression by text sync. Only changed functions are invalidated; Ark invalidates the whole file. `breakpoint` events with reason `changed` go out, but only for breakpoints that still exist.
- **Idle state.** Without a session, a status-bar item shows "R breakpoints: 3 verified, 1 pending", and its tooltip lists the reasons.

## 6. Stack, scopes, variables, evaluate

- **Stack.**
  - **Sources.** `sys.calls()`, `sys.frames()` and `sys.function()`, which see across `R_ToplevelExec` **[probe]**, plus the captured environment and `R_GetCurrentSrcref`.
  - **Frame location.** Each frame's location is the srcref of the next call (Ark's `debug.R`, MIT).
  - **Hidden frames.** The hook's frame, Raven helpers, handler internals, and Shiny's fenced frames are hidden.
  - **Frames without a srcref** get a virtual source for the whole function: the deparsed function, via `sourceReference`.
- **Transient evaluation.** If the stack is unchanged at the next prompt, Raven sends `invalidated{variables}`; otherwise it sends a new `stopped`.
- **Scopes.** Locals, then Enclosing (lazy, `expensive`), then Global (`expensive`).
- **Variables run no user R code by default.**
  - **Previews are built in C** from the value's type: length, dim, class, names, and the first few atomic elements.
  - **Base classes get readable previews** built entirely in Rust/C from the underlying data and its attributes. These previews call **no R functions**, base formatters included: `base:::format.data.frame` calls `format()` on each column, which can dispatch to a user method (Terra, R 4.6.1). Each is chosen by **underlying type plus the attributes it needs**, not by an exact class match. So tibbles, data.tables, ordered factors and `c("POSIXct", "POSIXt")` all get readable previews, and the full class vector is shown alongside. Exact matching isn't needed, because these previews never dispatch:
    - **factor:** level labels, looked up from the codes;
    - **Date:** days since the epoch, rendered as `YYYY-MM-DD`;
    - **POSIXct:** seconds rendered in the object's `tzone` attribute. Raven uses its own copy of the time-zone database, or shows UTC plus the `tzone` name when it can't resolve the zone;
    - **difftime:** the value followed by its `units` attribute;
    - **data.frame:** dimensions and column names, with each column previewed by these same rules. A column of any other class shows its class and underlying type.
  - **Tests:** custom column classes with their own `format`/`print` methods, and overridden base methods. None may run.
  - **Other classed objects.** S4 shows its slots (non-active only). R6 objects and environments show their children, as bindings. Any other S3 object shows its class and underlying type.
  - **Never forced.** Promises and active bindings are never forced. A promise shows its expression, using R 4.6's `R_GetBindingType` and `R_DelayedBindingExpression`, which are exported **[probe]**. On older R, Raven falls back to `PRCODE`, after vscDebugger's `promise.c`.
  - **ALTREP** previews read only data that is already materialized **[P0]**.
  - **Paging.** `indexedVariables` and `namedVariables` with start/count.
  - **Explicit actions.** These run R code and are labelled as doing so:
    - **Show printed value** runs `print` under `setTimeLimit`. This is cooperative: native code that never checks for interrupts can't be stopped.
    - **Open in Data Viewer** opens Raven's existing data viewer.
  - **Not on the default path:** vscDebugger-style user formatters. That keeps the default path free of user code.
- **Evaluate.**
  - **REPL and watch:** `withVisible(eval(parse(text=…), frameEnv))` inside `tryCatch` under the shim, with `tracingState(FALSE)`, the probe hook paused, and a cooperative time limit.
  - **Hover runs no R code.** It resolves only:
    - a symbol with a regular binding, or a promise that has **already been forced** (its value is read through the R 4.6 binding API, or `PRVALUE` on older R). Most function parameters are forced promises. Unforced promises and active bindings are never touched;
    - `$` or `[[` with a literal name or index, on **unclassed** lists, on environments (regular bindings), and on objects whose class vector contains only `data.frame`, `tbl_df`, `tbl` and `data.table`. For those, Raven reads the named column in C, from the underlying list. It never calls a `$` or `[[` method;
    - `@` on a non-active S4 slot.

    Everything is done in C, with no dispatch. Anything else shows the variables-tree preview or nothing.
  - **Also supported:** `setVariable` and `setExpression` in the frame environment; completion from the console's `complete` helper; `exceptionInfo` with the condition's class, message and call.
- **Terminal versus Debug Console.** Input typed in the terminal at `Browse>` evaluates in R's browsed frame. The Debug Console evaluates in the frame selected in the UI. When they differ, the prompt shows a dim hint.
- **Viewers.** Plots (httpgd) and the data viewer keep working while R is stopped.
- **Inline values (P4).** An LSP `textDocument/inlineValue` handler uses Raven's scope analysis.

## 7. Exceptions and pause

| Filter | Default | Mechanism |
|---|---|---|
| Errors (uncaught) | off | Raven's global calling handler. It runs before the stack unwinds, then calls `browser()` in place. |
| Warnings (not muffled) | off | Same handler, for warnings. |
| Interrupts | off | Same handler, for interrupts, then `.tryResumeInterrupt()`. |

- **Which frame an exception stop opens in.** The handler doesn't open the browser in its own frame. It finds the innermost frame that passes just-my-code (it has a srcref and isn't an installed package's internals) and runs `base::eval(quote(base::browser()), sys.frame(k))` there. RStudio's break-in-code works the same way. The qualified `base::browser()` means a frame that binds `browser` can't hijack the stop. Tests mask `browser` in the chosen frame, then check the captured environment and stepping after the stop.
  - So typed `Browse>` input and the stack's top frame both refer to the user's code, not to handler internals.
  - If no such frame exists, the stop opens in the frame that signalled the condition.
- **What the filters can't see.** Errors caught locally and warnings muffled locally never reach a global handler **[probe]**. The filter labels and the docs say so.
- **One handler, installed once.** Raven installs it **once**, at the first level-0 prompt of the console session, on the priority channel (it must run at R's real top level).
  - **Order.** `globalCallingHandlers()` runs the newest handler first **[probe]**. Raven therefore removes any existing global handlers, registers **its own first**, then re-registers the user's in their original order. Raven's handler ends up last, and handlers the user adds later also run before it.
  - **Toggling.** Filters toggle a flag the handler checks, so changing them while stopped takes effect immediately. The handler is never removed while the console runs.
  - **Tests:** several user handlers, muffling, later user registrations.
- **Pause is cooperative.** It sends SIGINT (on Windows, sets `UserBreak`) with a pause flag set, and the handler calls `browser()` in place. This works in interpreted loops **[probe]**. It can't stop native code that never checks for interrupts, and a user's interrupt handler can swallow it. Both limits are documented.

## 8. Safety rules

1. **Internal flag.** Raven's own R calls run with a flag set (`.raven_internal`). Raven's handler and probe hook do nothing while it's set. Those calls also run with `options(error = NULL)` in effect.
2. **A `Browse` prompt inside a Raven-started call** (shim depth > 0) gets an automatic `c` and a warning in the Debug Console. Raven never calls `undebug` on the user's functions.
3. **Restore only what Raven still owns.** For each global change, Raven records the value it installed: options, JIT level, the `source` binding, rebound bindings, patched cells. It restores the original only if the current value is still Raven's.
4. **Message ordering.** A step's response goes out before its `stopped`. `breakpoint` events go out only for breakpoints that still exist.
5. **No hard time limits are promised.** Default paths run no user R code. Explicit actions are cooperative.

## 9. Windows

Three things differ by platform, each behind a small seam:

| Seam | macOS / Linux | Windows |
|---|---|---|
| Transport | Unix socket | named pipe |
| Pause | SIGINT | `UserBreak` |
| Event tick | `R_PolledEvents` | `R_ProcessEvents` |

Porting the console to Windows is a prerequisite.

## 10. Phases

| Phase | Ships | Gate (pass/fail) |
|---|---|---|
| P0 | A throwaway prototype | **Sessions:** the criteria in §2.1. **Patching:** at the tick under `gctorture`, interrupts and the longjmp boundary. **Stepping:** auto-step never runs user code unseen; the `SET_RDEBUG` path and its fallback. **Other:** ALTREP-safe previews; nested-read servicing. |
| P1 | `subscribe`, the DAP socket, the state machine, service points (including nested reads), stops, stack, variables, evaluate, stepping, just-my-code, function breakpoints, `exceptionInfo`, Data Viewer link | Stock VS Code CI covering: rapid stop/continue, two terminals, extension reload, attach failure, and a breakpoint inside a `later` callback |
| P2 | Location tagging, injection, top-level stepping, `.raven_source` and the `source()` hook, verification and its reasons, conditions, hit counts, logpoints | Differential REPL tests (§3). Injection snapshot tests in the style of Ark. Probe tests: locals, shadowing, promises, nested calls, workers, `saveRDS` |
| P3 | Live patching (experimental), the JIT policy, sync by text, retry | Patch matrix on R 4.3–4.6 (checking exported symbols first): interpreted, compiled and running frames; copies; nested patches; `gctorture`; `trace()`; serialization; locked bindings; discovery failure |
| P4 | Exception filters, pause, inline values | — |

## 11. Licensing

These are adapted with their MIT notice kept in the adapted file's header and in third-party notices:
- Ark: anchoring in `console_annotate.rs`, frame building in `debug.R`, `console_filter.rs`;
- vscDebugger: `promise.c`;
- js-debug: variable paging.

pydevd (EPL-1.0), Positron (Elastic-2.0) and RStudio (AGPL-3.0) inform the design only; no code is taken from them.

## 12. Owner decisions

1. **Package and Shiny hook:** implement Ark's de facto `.ark_annotate_source` (§5.3).
2. **JIT:** policy A (§5.4.6). Follow Ark (leave the JIT alone except around Step Into), and turn it off only when the user opts into live patching. Sonnet and Terra recommended it independently.
3. **Attach:** only when R stops (§2.1). The Quiet session is not built.

## 13. Review response

### v1 → v2

| Finding | Change |
|---|---|
| Compiled running frames ignore patches; no patching while busy; unproven mutation safety | Claims narrowed; tick application; experimental flag; ownership rules |
| `RDEBUG(R_GlobalEnv)` leak | `SET_RDEBUG` + fallback |
| Wrapper changed REPL behaviour | Tag only complete level-0 input; differential tests |
| Synthetic top-level stops | Real `browser()` stops + one-shot probes |
| Filters overclaimed | Honest labels |
| Time bounds | Default paths run no R code |
| `baseenv` locked; probe leaks to workers | Self-contained probe with pid guard |
| `source()` replacement; NSE; retry; ownership on restore; internal-call isolation; lifecycle; S5 without session; break flag; hover; missing DAP features; over-engineering; overclaimed scope | See v2 notes, superseded below |

### v2 → v3

| Finding | Source | Change |
|---|---|---|
| `parent.frame()` in `h` is the helper frame | Terra | `environment()` passed explicitly (§5.2) |
| Hover not free of side effects (active bindings, `$`/`[[` dispatch, Shiny `reactivevalues`) | both | Hover in C only, no dispatch, regular bindings only (§6) |
| Handler order reversed | Terra | Raven registers first so it runs last; installed once and gated by a flag (§7) |
| Unknown contexts were still modified | Terra | Never modified; reported `invalid` with a reason (§5.3) |
| Retry keyed on changed files misses loads | Terra | Retry after every top-level evaluation (§5.4.7) |
| A2/A3 overstated | both | Recast as experimental C10, discovered closures only; JIT `always` explained (§1, §5.4) |
| Closure object can't travel through REPL text | Terra | Inline lambda, identical in text and AST (§5.2) |
| `source()` hook inactive before a session under `onStop`; locked binding | Terra | Installed whenever breakpoints are armed; unlock/lock specified (§5.3) |
| Swap vs detach | both | Swap token; instrumentation tied to the console, not the session (§2, §2.1) |
| P0 safety criteria | Terra | Pass/fail list (§10) |
| Stepping onto a probed line: extra stops; nested browser while stepping | Sonnet | Marker srcfile for scaffolding; universal auto-step; hook doesn't stop while stepping (§4) |
| Nested reads (depth ≥ 2) can't serve DAP | Sonnet | `plain_read` polls and serves; P1 gate (§2) |
| Default previews worse than vscDebugger's | Sonnet | Base-class allowlist (§6) |
| Tick details: chaining, pending-then-event, JIT race | Sonnet | Chained `R_PolledEvents`; tick only applies; JIT policy (§2, §5.4) |
| Error paths: hook errors, logpoint output, `reset_console` wiping parked input | Sonnet | §5.2, §2 |
| Filters can't be toggled while stopped | Sonnet | Installed once, gated by a flag (§7) |
| Smart step off; `breakpointLocations`; R < 4.5 symbols; hidden-step output; `.raven_source` stepping | Sonnet | Just-my-code on; §5.1; `as.function` fallback and symbol check; output filter; same one-shot rule |
| C-row honesty (Ark top-level claim unverified; RStudio already equivalent on console/UI) | Terra | Table recast as a capability checklist with the evidence basis stated (§1) |

### v3 → v4

| Finding | Source | Change |
|---|---|---|
| A breakpoint-hit stop sits at the probe; the marker rule would skip real hits; `n` repeats the line; `f` leaves only the hook | Sonnet | Hits recorded by the hook; exactly one hidden `n` lands on the anchored statement; markers only for scaffolding steps (§4) |
| A global "stepping" flag suppresses breakpoints in callees stepped over or out of | both | Suppress only when `RDEBUG` is set on the probe's own frame (§4) |
| Probe resolved base functions in the user's environment | Terra | Every base function written as `base::`; bare `browser()` kept for the JIT guard **[probe]**, with a fallback when `browser` is masked (§5.2) |
| Name-based allowlist unsound under masking | Terra | Core syntax, or a callee verified with `identical()` at send/patch time; otherwise nothing is injected and a reason is given (§5.3) |
| Shiny braced arguments rejected | Sonnet | "Evaluated later as code" class, identity-verified (§5.3) |
| "Superset" bar conflicts with the gaps | Terra | Bar changed to "best overall"; vscDebugger formatters, output links, masked-callee and probe-cost gaps listed (§1) |
| Unbounded retry | both | Triggers, backoff, 10 ms budget, resumable walk, never forcing promises (§5.4.7) |
| Hover excluded forced-promise parameters | Sonnet | Forced promises read; unforced ones never touched (§6) |
| Exception stops open in the handler frame | Sonnet | `browser()` evaluated in the innermost just-my-code frame (§7) |
| Delegated `source()` forms silently pending | Sonnet | Explicit reason (§5.3) |

### v4 → v5

| Finding | Source | Change |
|---|---|---|
| After `f`, `RDEBUG` stays set but R doesn't stop, so `RDEBUG`-only suppression loses later breakpoints in the same frame | Sonnet **[probe]** | Suppress only when `RDEBUG(env)` is set **and** the last resume was `n`/`s`; tests for the same frame after `f` (§4) |
| A multi-expression send could verify a callee before an earlier expression masks it | Sonnet | Identity check runs per expression, just before it is fed (§5.3) |
| `setAttrib` at the tick can allocate | Sonnet | Nodes and attributes are built ahead of time; the tick only swaps pointers (§2, §5.4) |
| A stale hit record could expose a scaffolding stop | Sonnet | The record is consumed when its stop is reported and cleared at every resume (§4) |

### v5 → v6

| Finding | Source | Change |
|---|---|---|
| Send-time callee identity misses nearer bindings created at run time (e.g. a local `local <- function(x) substitute(x)`) | Terra **[R 4.6.1]** | Identity check plus a static check that no enclosing scope can rebind the name; no forcing during checks; otherwise unchanged and `invalid` (§5.3) |
| `base:::format.data.frame` dispatches `format()` on columns, so previews could run user methods | Terra **[R 4.6.1]** | Base-class previews built entirely in Rust/C with no R calls; tests with custom column methods (§6) |
| Exception stop used a bare `browser()` | Terra | `quote(base::browser())`; masking tests (§7) |
| A suppressed probe with a false condition or a logpoint was still reported as `breakpoint` | Terra | `breakpoint` only for a qualifying stopping breakpoint; otherwise `step` (§4) |

### v6 → v6.1 (Sonnet's conditional AGREE)

| Finding | Change |
|---|---|
| "Never force" would leave `test_that`, `observeEvent` and `with` unverified in a fresh session (unforced lazy-load promises **[probe]**) | Force only `lazyLoadDBfetch` promises in package or base environments; fresh-session tests (§5.3) |
| Static rebinding check limited to function scopes | Any binding in the enclosing expression or function, including `local`/`with`/`eval` environments (§5.3) |
| Exact-class previews skip tibble, data.table, ordered factors, POSIXct/POSIXt | Chosen by underlying type and attributes; full class shown (§6) |
| `df$col` hover on data frames | C read of the column for data.frame, tibble and data.table (§6) |
| `load_all()` gap understated | Gap spelled out; Q1 is a P2 dependency (§1) |
| F5 behaviour, DAP socket permissions, `tools:raven` in `search()` | Specified (§2, §5.2) |

### v6 → v7 (Terra)

| Finding | Change |
|---|---|
| A callee verified at definition time can be rebound before the call runs (global or closure) | Explicit instrumentation contract matching R's byte compiler at its default level, which also ignores later rebinding of base functions in compiled code **[probe]**; a prompt-time rebinding detector turns injection and patching off and says why (§5.3) |
| Core syntax (`if`, `{`) can be masked | Core syntax gets the same identity and static checks at instrumentation time; covered by the detector and the contract (§5.3) |

### v7 → v7.1 (Sonnet's AGREE, minor fixes)

| Finding | Change |
|---|---|
| The detector gave false positives (S4 generics, data variables, legitimate package functions), switched everything off, and never resumed | Per-name and advisory; only function-valued masks that aren't `identical()`; S4 generics accepted by their default method; re-armed when the mask goes away (§5.3) |
| The compiler analogy holds only for core syntax and inlined functions | Reworded; the exposure window for non-inlined table functions is stated (§5.3, §1 gaps) |
| The detector's coverage was overstated | Undetected environments listed (§5.3) |
| The dynamic-scope clause would invalidate most bodies | Core syntax uses literal-binding checks; the dynamic clause applies only under known functions (§5.3) |
| Wrapping continued while `{` was rebound | Tagging turned off while `{` is rebound (§5.3) |
| `lazyLoadDBfetch` can run another package's `.onLoad`; `.raven_source` injection timing | Stated; injection happens one expression at a time (§5.3) |

### v7 → v8 (Terra)

| Finding | Change |
|---|---|
| The probe's own syntax (`if`, `&&`, `<-`, lambda) is maskable, independently of the path to the breakpoint | Probe rewritten with no maskable lookups except `::` and `browser`: `` base::`if` `` in functional form, `base::alist` as the lazy no-op default, no lambda **[probe]** (§5.2) |
| Closure-private rebinding between prompts isn't detected | Listed explicitly as outside the detector's coverage, including `environment(f)` changes; no claim is made (§5.3, §1 gaps) |
| "Same contract as the compiler" understated the consequence | It now says a later rebinding of a non-inlined known function to a quoting one *can change program results* (§5.3) |

### v8 → v8.1 (Sonnet's AGREE, minor fixes)

| Finding | Change |
|---|---|
| The hook must force `b` last, or the hidden `n` stops inside the hook | Stated, with a P0 test (§5.2) |
| Stale probe-cost figure | Re-measured for the v8 probe (§1 gaps) |
| Leftover "lambda" wording | Reworded; the hook's frame is hidden (§5.2, §6) |
| The detector could flag unforced lazy-load exports as masks | Uses the same `lazyLoadDBfetch` rule as the instrumentation check (§5.3) |
| A masked `::` errors rather than doing nothing | Disclosed (§5.2) |

### v8 → final (Terra's AGREE, minor fixes)

| Finding | Change |
|---|---|
| The probe still depends on `::` | Headline reworded; `::` added to the contract, with a test (§5.2) |
| The §1 gap understated later-rebinding consequences | Core syntax and undetected private environments added; §5.3 qualified |
