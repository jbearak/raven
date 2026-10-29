# Debugger prior art for a Raven DAP debugger for R

Date: 2026-10-29. Status: research notes. This is not a design.

This document surveys existing interactive debuggers, to inform a Debug Adapter Protocol (DAP) debugger built into `raven console` (`crates/raven/src/console/`).

The console's architecture shapes what matters here:
- It embeds libR in-process.
- It answers R's `ReadConsole` callbacks and already detects `Browse[n]>` prompts.
- It runs every R call it initiates under `R_ToplevelExec` (`shim.c`).
- It talks to the VS Code extension over a Unix socket.

**Method.** The findings come from primary sources only: source code read at pinned commits through `gh`, official docs, the DAP spec, R's own sources and NEWS, and first-party issue trackers. Claims we could not verify are marked "(unverified)". Claims inferred from reading code, rather than stated by the source, say so. GitHub search hit rate limits during the work, so the issue lists are representative, not exhaustive.

Pinned commits:

| Repo | Commit |
|---|---|
| microsoft/vscode-js-debug | `a9df0307` |
| microsoft/debugpy | `10993112` |
| julia-vscode/DebugAdapter.jl | `a39a4bc` |
| JuliaDebug/JuliaInterpreter.jl | `0c3adb4` |
| JuliaDebug/Debugger.jl | `dc7b480` |
| julia-vscode/julia-vscode | `dbbc6e3` |
| posit-dev/ark | `445aebc1` |
| ManuelHentschel/vscDebugger | `db7d69f` |
| ManuelHentschel/VSCode-R-Debugger | `54fa5b4` |
| rstudio/rstudio | `46f72e0` |
| wch/r-source (trunk) | `8d4f968` |

Positron links point to `main`.

## Contents

1. [At a glance](#at-a-glance)
2. [vscode-js-debug](#vscode-js-debug)
3. [debugpy / pydevd](#debugpy--pydevd)
4. [Julia: DebugAdapter.jl / JuliaInterpreter.jl / Debugger.jl](#julia-debugadapterjl--juliainterpreterjl--debuggerjl)
5. [R: Ark (Positron)](#r-ark-positron)
6. [R: VSCode-R-Debugger / vscDebugger](#r-vscode-r-debugger--vscdebugger)
7. [R: RStudio](#r-rstudio)
8. [R primitives for debuggers](#r-primitives-for-debuggers)
9. [Lessons for Raven](#lessons-for-raven)

## At a glance

| | Where the DAP server runs | How it stops | Line breakpoints | Cond / hit / log | Exception filters | Variable paging | License |
|---|---|---|---|---|---|---|---|
| vscode-js-debug | Extension host. Talks CDP to the runtime | V8 `Debugger.paused` | Runtime binds by URL. Predicted from source maps | Yes / adapter-side / yes (never pauses) | all, uncaught | `indexedVariables` + start/count | MIT |
| debugpy / pydevd | Separate adapter process. pydevd server in the debuggee | Trace callback (`sys.monitoring` on 3.12+) | Keyed by file:line, so they bind lazily on first run | Yes / yes / yes | raised, uncaught, userUnhandled | Synthetic `[from:to]` buckets | MIT (debugpy), EPL-1.0 (pydevd) |
| Julia (DebugAdapter.jl) | In the debuggee (REPL) process | Interpreter checks a per-statement bp slot | Applied lazily when a `FrameCode` is built | Cond only | error, throw | start/count | MIT |
| Ark (Positron) | In the R kernel process, own thread | `browser()` prompt | **Injected into source text before parse** | Yes / yes / yes (2026.04) | error, warning, interrupt | **None** | MIT (Positron: Elastic-2.0) |
| vscDebugger | Inside R, running in the browser frame | `browser()` prompt | `trace(at=)` + custom `source()` | No | `options(error=)` | start/count | MIT |
| RStudio | In the `rsession` process (embedded R) | `browser()` prompt | `trace(at=)` on live function + `debugSource` | No (unverified) | `options(error=)` modes | n/a (env pane) | AGPL-3.0 |

---

## vscode-js-debug

Links pin to `https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/`.

### License

**SPDX: `MIT`.** The GitHub license API reports `spdx_id: MIT`, and [LICENSE](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/LICENSE) reads "MIT License, Copyright (c) Microsoft Corporation".

### Architecture

**Process model**

- The adapter runs in the VS Code extension host and serves DAP over a named pipe (`DebugAdapterNamedPipeServer`) ([vsCodeSessionManager.ts#L57-L70](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/ui/vsCodeSessionManager.ts#L57-L70)). A standalone DAP server also exists for other clients ([dapDebugServer.ts](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/dapDebugServer.ts)).
- Each debuggee target gets one DAP session, and each session has one DAP thread. `stopped` and `continued` are sent with `allThreadsStopped:false` ([binder.ts#L409-L432](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/binder.ts#L409-L432), [threads.ts#L1928-L1946](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/threads.ts#L1928-L1946)).
- **Launch gating.** The target is held paused (`--inspect-brk`) until `launchBlocker()` resolves, which happens once pending breakpoint sets and predictions finish. Only then does `runIfWaitingForDebugger()` run. Each breakpoint set is raced against a timeout ([binder.ts#L428-L432](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/binder.ts#L428-L432), [breakpoints.ts#L468-L524](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/breakpoints.ts#L468-L524)).
- **Node injection.** A bootloader on `NODE_OPTIONS` opens the inspector and spawns a watchdog process that bridges to the adapter ([autoAttachLauncher.ts#L155](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/targets/node/autoAttachLauncher.ts#L155), [bootloader.ts#L113-L135](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/targets/node/bootloader.ts#L113-L135)).
- **Ordering of control requests.** Resume, pause, and step are serialized through a `StateQueue` ([threads.ts#L195](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/threads.ts#L195), [#L276-L345](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/threads.ts#L276-L345)). A `delay(0)` precedes each `stopped` event, because a fast debuggee can pause again before the step response is sent ([threads.ts#L1920-L1926](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/threads.ts#L1920-L1926)).

**DAP↔CDP translation**

- One handler per request is wired in the `DebugAdapter` constructor. Execution control goes to `Thread`, which calls `Debugger.*`/`Runtime.*` ([debugAdapter.ts#L83-L133](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/debugAdapter.ts#L83-L133)).
- Custom DAP requests: `toggleSkipFileStatus`, `prettyPrintSource`, `setExcludedCallers`, `requestCDPProxy`, … ([debugAdapter.ts#L110-L130](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/debugAdapter.ts#L110-L130)).

**Stopping**

- The runtime pauses, and `_onPaused` classifies the pause: source-map instrumentation, inspect-brk, cross-thread step, or a user breakpoint that is subject to the hit-count vote. Pauses that need nothing shown are resumed silently, so the client only sees `stopped` when the adapter decides to stay paused ([threads.ts#L1000-L1060](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/threads.ts#L1000-L1060)).
- `_expectedPauseReason` is set before each step, pause, or restartFrame, and cleared on the next pause ([threads.ts#L290-L339](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/threads.ts#L290-L339), [#L1901-L1903](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/threads.ts#L1901-L1903)).

### Breakpoints

- **Storage.** Breakpoints are indexed by case-normalized path and by `sourceReference`. CDP ids map back through `_resolvedBreakpoints` ([breakpoints.ts#L75-L125](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/breakpoints.ts#L75-L125)).
- **setBreakpoints diffing.** Each request is diffed against the previous set. Equivalent breakpoints (same condition, hit condition, …) are reused; removed ones become `unbound` ([breakpoints.ts#L526-L640](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/breakpoints.ts#L526-L640), [userDefinedBreakpoint.ts#L45-L55](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/breakpoints/userDefinedBreakpoint.ts#L45-L55)).
- **Setting before code loads.** `Debugger.setBreakpointByUrl` (URL or regex) makes V8 bind the breakpoint when the script parses later. Each CDP reference is Pending or Applied. `updateForNewLocations` re-places breakpoints on each new script ([breakpointBase.ts#L18-L81](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/breakpoints/breakpointBase.ts#L18-L81), [#L176-L320](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/breakpoints/breakpointBase.ts#L176-L320), [#L470-L645](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/breakpoints/breakpointBase.ts#L470-L645)).
- **Instrumentation pause.** `setInstrumentationBreakpoint('beforeScriptWithSourceMapExecution')` stops every source-mapped script before it runs. The adapter loads the map, sets breakpoints, then continues (or stays stopped if a breakpoint is at that spot) ([threads.ts#L1987-L2010](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/threads.ts#L1987-L2010), [breakpoints.ts#L495-L510](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/breakpoints.ts#L495-L510)). The overhead is documented in [OPTIONS.md#L24](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/OPTIONS.md?plain=1#L24).
- **Prediction.** `BreakpointsPredictor` scans `outFiles` source maps ahead of time to work out where a source breakpoint will land, and caches the result in `bp-predict.json` ([breakpointPredictor.ts#L43-L75](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/breakpointPredictor.ts#L43-L75), [#L268-L400](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/breakpointPredictor.ts#L268-L400)).
- **Verification.**
  - A breakpoint is `verified:true` once at least one CDP location resolves. Otherwise it reports `verified:false, message:'Unbound breakpoint'`, and the source still says `TODO: Put a useful message here` ([userDefinedBreakpoint.ts#L81-L100](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/breakpoints/userDefinedBreakpoint.ts#L81-L100)).
  - Binding that happens later is pushed as a `breakpoint` event with `reason:'changed'`, skipped if the breakpoint was removed in the meantime ([#1406](https://github.com/microsoft/vscode-js-debug/issues/1406); [breakpoints.ts#L676-L697](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/breakpoints.ts#L676-L697)).
  - V8 can send `breakpointResolved` before the response to the set request; the adapter retries on the next tick ([breakpoints.ts#L413-L425](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/breakpoints.ts#L413-L425)).
- **breakpointLocations.** Maps source ranges to generated ranges, calls `getPossibleBreakpoints`, and maps the results back ([breakpoints.ts#L340-L405](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/breakpoints.ts#L340-L405)).

### Stepping

- Over, in, and out map to `Debugger.stepOver`, `stepInto({breakOnAsyncCall})`, and `stepOut`. The generated ranges for the current original line are passed as `skipList`, so one step moves one *source* line ([threads.ts#L300-L372](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/threads.ts#L300-L372)).
- **Smart step.** If a step lands in an unmapped or blackboxed frame, the adapter repeats the same step automatically. It never does this after a breakpoint, exception, entry, or explicit pause. After 256 automatic steps it gives up and steps out. Frames it passed through are marked `deemphasize` ([smartStepping.ts](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/smartStepping.ts), [threads.ts#L1118-L1150](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/threads.ts#L1118-L1150), [stackTrace.ts#L576](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/stackTrace.ts#L576)).
- **skipFiles.** Globs become `setBlackboxPatterns`/`setBlackboxedRanges`, and can be toggled at runtime ([scriptSkipper/implementation.ts#L111-L190](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/scriptSkipper/implementation.ts#L111-L190)).
- **stepInTargets.** Call sites come from `getPossibleBreakpoints` on the current line. Stepping into one sets a one-shot breakpoint there and resumes ([threads.ts#L818-L875](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/threads.ts#L818-L875)).

### Variables and scopes

- **Reference lifetimes.** There are two `VariableStore`s:
  - The session store backs REPL results.
  - The per-pause store is created at each pause and dropped on resume, which invalidates every reference handed out during that pause ([threads.ts#L1150](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/threads.ts#L1150), [#L1220-L1228](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/threads.ts#L1220-L1228)).
- **Scopes.** Global and module scopes are `expensive:true`. Scope `presentationHint` is `locals` or `arguments` ([stackTrace.ts#L464-L530](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/stackTrace.ts#L464-L530)).
- **Variable kinds.** One class per kind: Object, Array, SetOrMap, Function, Getter, Error, … ([variableStore.ts#L275-L295](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/variableStore.ts#L275-L295)).
- **Paging.** Arrays over 100 elements report `indexedVariables`, and `filter:'indexed'` with start/count fetches a slice ([variableStore.ts#L1173-L1235](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/variableStore.ts#L1173-L1235)).
- **Getters.** Shown with `presentationHint.lazy:true`, so they run only when the user expands them ([variableStore.ts#L1276-L1310](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/variableStore.ts#L1276-L1310)). This maps to R promises and active bindings.
- **Visibility and attributes.** Non-enumerable properties are `visibility:'internal'`, and read-only ones carry `attributes:['readOnly']` ([variableStore.ts#L465-L600](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/variableStore.ts#L465-L600)).
- **Preview budgets** depend on where the preview is shown: hover 1000 chars, repl 100k, copy unlimited ([objectPreview/contexts.ts#L42-L65](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/objectPreview/contexts.ts#L42-L65)).
- **User-defined display.** `customDescriptionGenerator`, `customPropertiesGenerator`, and `Symbol.for('debug.description')` let users control how their types render ([variableStore.ts#L320-L410](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/variableStore.ts#L320-L410)).
- **setVariable / setExpression.** Scope variables use `Debugger.setVariableValue`; object properties are assigned through `callFunctionOn` ([variableStore.ts#L742-L760](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/variableStore.ts#L742-L760)).

### Evaluate

- With a frame selected, evaluation uses `evaluateOnCallFrame`; otherwise `Runtime.evaluate` ([threads.ts#L536-L672](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/threads.ts#L536-L672)).
- Hover evaluation has a 500 ms timeout (`timeouts.hoverEvaluation`) ([threads.ts#L674-L684](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/threads.ts#L674-L684)).
- The `repl` context wraps object literals and rewrites top-level `await`. The `clipboard` context serializes the value to JSON.
- `$returnValue` exposes the frame's return value ([evaluator.ts#L177-L230](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/evaluator.ts#L177-L230)).

### Sources and pretty print

- `sourceReference` is a 31-bit hash of the URL. `loadedSource` events fire as `new` or `removed` ([sourceContainer.ts#L325-L340](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/sourceContainer.ts#L325-L340), [#L830-L855](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/sourceContainer.ts#L830-L855)).
- Pretty print produces a synthetic source map and moves existing breakpoints onto it ([source.ts#L218-L250](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/source.ts#L218-L250), [breakpoints.ts#L225-L270](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/breakpoints.ts#L225-L270)).

### Notable features

| Feature | Status / mechanism | Source |
|---|---|---|
| Conditional | Compiled into V8's own `condition`, so no round trip to the adapter. Errors are logged and treated as false | [expression.ts#L60-L64](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/breakpoints/conditions/expression.ts#L60-L64) |
| Hit count | `(>\|>=\|=\|<\|<=\|%)N`, counted **in the adapter**, so every hit costs a pause and resume | [hitCount.ts#L13-L66](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/breakpoints/conditions/hitCount.ts#L13-L66), [breakpoints.ts#L745-L797](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/breakpoints.ts#L745-L797) |
| Logpoints | Compiled to `console.log(...), false` as the condition, so they never pause. A `sourceURL` comment hides the generated code from stacks | [logPoint.ts#L23-L100](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/breakpoints/conditions/logPoint.ts#L23-L100), [#1191](https://github.com/microsoft/vscode-js-debug/issues/1191) |
| Exception filters | `all` and `uncaught`, both with `supportsCondition` | [exceptionPauseService.ts#L115-L166](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/exceptionPauseService.ts#L115-L166) |
| Function breakpoints | No | [#952](https://github.com/microsoft/vscode-js-debug/issues/952) |
| Data breakpoints | No. Blocked on V8 | [#502](https://github.com/microsoft/vscode-js-debug/issues/502) |
| Excluded callers | Custom request: suppress a breakpoint when a given frame is on the stack | [README.md#L123-L130](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/README.md?plain=1#L123-L130) |
| Restart frame | `Debugger.restartFrame({mode:'StepInto'})`. Async frames refused | [threads.ts#L383-L419](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/adapter/threads.ts#L383-L419) |
| Hot reload | Not implemented. `Debugger.setScriptSource` is never called (grep). `restart` means reconnect | [restartPolicy.ts](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/targets/node/restartPolicy.ts) |
| Child sessions | Each child target becomes its own DAP session, started via `startDebugging` with `__pendingTargetId` | [sessionManager.ts#L225-L250](https://github.com/microsoft/vscode-js-debug/blob/a9df0307248dcdcdfcb37c83fc9ecb9f614d9f0d/src/sessionManager.ts#L225-L250) |

### Weaknesses worth learning from

- **"Unbound breakpoint" gives no reason.** It is the most common failure report: [#2228](https://github.com/microsoft/vscode-js-debug/issues/2228), [#2325](https://github.com/microsoft/vscode-js-debug/issues/2325), [#2350](https://github.com/microsoft/vscode-js-debug/issues/2350), [#2183](https://github.com/microsoft/vscode-js-debug/issues/2183). Raven should put a concrete reason in `message`.
- **Path matching is fragile.** An extra slash prevents binding ([#519](https://github.com/microsoft/vscode-js-debug/issues/519)).
- **No check that the running code matches the file on disk** ([#996](https://github.com/microsoft/vscode-js-debug/issues/996)). The R equivalent is a buffer edited after `source()`.
- **Event and response ordering races**, already covered above: the `breakpointResolved` retry and the `delay(0)` before `stopped`.
- **Detaching leaves runtime state behind** ([#2344](https://github.com/microsoft/vscode-js-debug/issues/2344)). For R, this means clearing `trace()` hooks and `options(error=)` on disconnect.
- **Open request to have a language server enrich debug values** ([#284](https://github.com/microsoft/vscode-js-debug/issues/284)). Raven ships both pieces.

### Files most worth studying

| Path | Why |
|---|---|
| `src/adapter/debugAdapter.ts` | Full capabilities object and request dispatch |
| `src/adapter/threads.ts` | Pause classification, step state machine, `StateQueue`, evaluate contexts, stepInTargets |
| `src/adapter/breakpoints.ts` | setBreakpoints diffing, launch blocker, hit-count vote, breakpointLocations |
| `src/adapter/breakpoints/breakpointBase.ts` | Pending/Applied binding for code that loads later (maps to binding at `source()` time) |
| `src/adapter/breakpoints/userDefinedBreakpoint.ts` | verified/unbound reporting, equivalence |
| `src/adapter/breakpoints/conditions/` | Small condition, hit-count, and logpoint compilers |
| `src/adapter/breakpointPredictor.ts` | Ahead-of-time binding prediction with a disk cache (compare Raven's static `source()` graph) |
| `src/adapter/smartStepping.ts` | Automatic stepping with a cutoff |
| `src/adapter/scriptSkipper/implementation.ts` | skipFiles (maps to skipping base and recommended packages) |
| `src/adapter/variableStore.ts` | Per-pause and session stores, paging, lazy variables, hints |
| `src/adapter/objectPreview/contexts.ts` | Preview budgets per context |
| `src/adapter/stackTrace.ts` | Paged frames, `totalFrames`, scope and frame hints |
| `src/adapter/exceptionPauseService.ts` | Exception filters with conditions |
| `src/adapter/sourceContainer.ts` | sourceReference allocation, loadedSource events |

### DAP features it relies on that an R debugger needs

Spec: <https://microsoft.github.io/debug-adapter-protocol/specification>.

- [`breakpointLocations`](https://microsoft.github.io/debug-adapter-protocol/specification#Requests_BreakpointLocations): Raven could answer statically from tree-sitter.
- The [`breakpoint` event](https://microsoft.github.io/debug-adapter-protocol/specification#Events_Breakpoint) with `reason:'changed'`, plus `verified`/`message`.
- [`loadedSources`](https://microsoft.github.io/debug-adapter-protocol/specification#Requests_LoadedSources) and [`source`](https://microsoft.github.io/debug-adapter-protocol/specification#Requests_Source) with `sourceReference`: for deparsed functions that have no srcref.
- `supportsDelayedStackTraceLoading` (`startFrame`/`levels`/`totalFrames`): R stacks get deep under purrr and dplyr.
- The [`invalidated` event](https://microsoft.github.io/debug-adapter-protocol/specification#Events_Invalidated): needed after console evals change state while stopped.
- [`VariablePresentationHint`](https://microsoft.github.io/debug-adapter-protocol/specification#Types_VariablePresentationHint) `lazy`/`visibility`/`kind`/`attributes`: for promises and active bindings.
- `indexedVariables`/`namedVariables` with `variables.filter/start/count`: for long vectors and lists.
- `Scope.expensive` and `presentationHint`, and `StackFrame.presentationHint` (`subtle`/`deemphasize`/`label`).
- `exceptionBreakpointFilters` with `supportsCondition`, `supportsExceptionFilterOptions`, and `exceptionInfo`.
- `supportsConditionalBreakpoints`, `supportsHitConditionalBreakpoints`, `supportsLogPoints`.
- `supportsEvaluateForHovers` and the `context` values hover/repl/watch/clipboard. `supportsCompletionsRequest` could be served by Raven's LSP completion engine.
- `supportsStepInTargetsRequest`, `supportsSetVariable`, `supportsSetExpression`, `supportsRestartFrame`. Restart frame is doubtful for R.
- `supportsANSIStyling`: for cli and crayon output.
- `supportsConfigurationDoneRequest`: hold launch until breakpoints are set.
- The [`startDebugging`](https://microsoft.github.io/debug-adapter-protocol/specification#Reverse_Requests_StartDebugging) reverse request.

---

## debugpy / pydevd

Paths are relative to `https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/`. pydevd (upstream [fabioz/PyDev.Debugger](https://github.com/fabioz/PyDev.Debugger)) is vendored under `_vendored/pydevd`.

### License

| Component | SPDX | Evidence |
|---|---|---|
| debugpy (adapter, launcher, server glue) | `MIT` | [LICENSE](https://github.com/microsoft/debugpy/blob/10993112/LICENSE), [setup.py#L157](https://github.com/microsoft/debugpy/blob/10993112/setup.py#L157). The GitHub API says `NOASSERTION` because of the notices file |
| pydevd | `EPL-1.0` | [LICENSE-EPL](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/LICENSE-EPL), [ThirdPartyNotices.txt#L25](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/ThirdPartyNotices.txt#L25) |

### Process model

| Piece | Role | Source |
|---|---|---|
| Adapter (own process) | Speaks DAP to the client. A `Session` has one client plus a launcher and/or a debug server | [adapter/sessions.py#L22-L54](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/adapter/sessions.py#L22-L54) |
| Launcher | Spawned by the adapter (directly or via `runInTerminal`). Starts the debuggee and reports pid, output, and exit | [adapter/launchers.py#L69-L131](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/adapter/launchers.py#L69-L131) |
| Debug server (pydevd in the debuggee) | `debugpy.listen()` spawns an adapter, then calls `pydevd.settrace(..., block_until_connected=True)`. Calling `listen()` twice is an error (it would hang) | [server/api.py#L138-L160](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/server/api.py#L138-L160), [#L293-L311](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/server/api.py#L293-L311) |
| Wire | DAP over Content-Length framing on every hop. pydevd speaks DAP natively (it also keeps a legacy XML protocol) | [common/messaging.py#L252](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/common/messaging.py#L252) |
| Trust boundary | Adapter and server swap tokens (`pydevdAuthorize`). The adapter refuses to forward server-originated requests such as `runInTerminal`, because a compromised debuggee could use them to run commands | [adapter/servers.py#L184-L197](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/adapter/servers.py#L184-L197), [#L313-L322](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/adapter/servers.py#L313-L322) |
| I/O threads | Reader and writer daemon threads, hidden from the user's thread list | [pydevd_comm.py#L155](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_comm.py#L155), [#L365](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_comm.py#L365) |

**How execution stops.**
1. A trace callback calls `set_suspend` and then `do_wait_suspend`.
2. The stopped thread loops in `_do_wait_suspend`. On each pass it pops internal commands queued *for this thread* and runs them on it (evaluate, variables, step-in targets). It then waits on an event with a slow or fast timeout, and calls GUI input hooks.
3. When the loop exits, pydevd applies the pending step by re-arming tracing ([pydevd.py#L2187](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/pydevd.py#L2187), [#L2291-L2373](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/pydevd.py#L2291-L2373)).

**This is the shape Raven needs.** Raven's main thread, sitting at `Browse[n]>` in `ReadConsole`, would service DAP work queued for it.

### Tracing back-ends

| Mode | When | Mechanism | Source |
|---|---|---|---|
| `sys.monitoring` (PEP 669) | Default on 3.12+ | Registers tool `"pydevd"`. Enables `PY_START`/`LINE`/`JUMP`/`PY_RETURN` events, plus `RAISE`/`PY_UNWIND` only when exception filters are on. Uses `set_local_events` per code object where needed, and returns `DISABLE` to silence a location. `update_monitor_events()` runs on every breakpoint change | [_pydevd_sys_monitoring.py#L731-L761](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_sys_monitoring/_pydevd_sys_monitoring.py#L731-L761), [#L1744-L2010](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_sys_monitoring/_pydevd_sys_monitoring.py#L1744-L2010) |
| Per-code-object cache | All modes | `FuncCodeInfo` is cached and invalidated by a global `mtime` that bumps on every breakpoint change | [#L564-L585](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_sys_monitoring/_pydevd_sys_monitoring.py#L564-L585) |
| `sys.settrace` | Below 3.12 | `trace_dispatch` returns `None` on `call` for frames with no breakpoints and no step, so untouched functions run untraced | [pydevd_frame.py#L344-L367](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_frame.py#L344-L367), [#L535-L590](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_frame.py#L535-L590) |
| Frame evaluation (PEP 523) | 3.6–3.10 with Cython only | Swaps `eval_frame` and injects breakpoint bytecode into code objects that have breakpoints. Not available on 3.11+, and off for gevent ([#189](https://github.com/microsoft/debugpy/issues/189)) | [pydevd_frame_eval_main.py#L24-L60](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_frame_eval/pydevd_frame_eval_main.py#L24-L60), [pydevd_modify_bytecode.py#L239](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_frame_eval/pydevd_modify_bytecode.py#L239) |
| Cython speedups | Optional | `# IFDEF CYTHON` blocks in the `.py` files generate the `.pyx`, so one source yields both builds | [generate_code.py#L33](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/build_tools/generate_code.py#L33) |

### Capabilities

Source: [pydevd_process_net_command_json.py#L277-L318](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_process_net_command_json.py#L277-L318).

- **Supported:**
  - conditional, hit-count, and log breakpoints; function breakpoints
  - hover evaluation, setVariable, setExpression
  - goto targets (set next statement), completions, modules
  - exception options and exception info
  - delayed stack loading, step-in targets, clipboard context
- **Not supported:** restartFrame, loaded sources, data breakpoints.

### Breakpoints

- **Storage and binding.** Breakpoints live in `py_db.breakpoints[canonical_filename][line]`. Setting a source replaces all of that file's breakpoints, then bumps `mtime` and re-arms monitoring. Code that hasn't loaded yet matches by filename when it first runs, **so no special mechanism is needed for breakpoints set early** ([#L850-L917](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_process_net_command_json.py#L850-L917), [pydevd_api.py#L605-L620](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_api.py#L605-L620)).
- **Line validation.** pydevd compiles the file, collects `dis.findlinestarts` recursively, and snaps the breakpoint to the nearest **preceding** valid line ([pydevd_api.py#L72-L95](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_api.py#L72-L95), [#L535-L546](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_api.py#L535-L546)).
- **Verification messages.** Each failure has its own message: file not found, excluded by filters (with a justMyCode hint), "Waiting for code to be loaded", or invalid line. Later changes are sent as `breakpoint` events with `reason:"changed"` ([#L919-L955](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_process_net_command_json.py#L919-L955)).
- **Conditions.** Evaluated with `eval(cond, f_globals, f_locals)`. If the condition raises, pydevd **suspends anyway** and attaches the error ([pydevd.py#L1007-L1044](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/pydevd.py#L1007-L1044)).
- **Hit counts.** `hitCondition` is rewritten to `@HIT@ …`, backed by a per-breakpoint counter protected by a lock ([#L757-L782](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_process_net_command_json.py#L757-L782), [pydevd_breakpoints.py#L48-L75](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_breakpoints.py#L48-L75)).
- **Logpoints.** `{x}` templates become a `%`-format expression, evaluated and emitted without stopping ([pydevd_utils.py#L237-L245](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_utils.py#L237-L245), [pydevd.py#L1046-L1054](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/pydevd.py#L1046-L1054)).
- **Function breakpoints.** Matched by name on `PY_START` ([_pydevd_sys_monitoring.py#L1767-L1775](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_sys_monitoring/_pydevd_sys_monitoring.py#L1767-L1775)).

### Stepping and justMyCode

- **Step commands.** `next`, `stepIn`, and `stepOut` map to `CMD_STEP_OVER`, `CMD_STEP_INTO`, and `CMD_STEP_RETURN`, or their `*_MY_CODE` variants ([#L643-L660](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_process_net_command_json.py#L643-L660)). Step state is per-thread (`pydev_step_cmd`, plus the anchor frame `pydev_step_stop`) ([pydevd_frame.py#L540-L575](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_frame.py#L540-L575)).
- **Step-into targets.** Found by interpreting the current line's bytecode. Each target id is a bytecode offset, and the step stops only when a callee's call offset matches ([#L660-L739](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_process_net_command_json.py#L660-L739), [pydevd_bytecode_utils.py#L883-L920](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_bytecode_utils.py#L883-L920)).
- **justMyCode.** "Project" means under the project roots and not under a longer library-root match. Library roots default to sysconfig's stdlib, purelib, and platlib plus the user site directory ([pydevd_filtering.py#L87-L299](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_filtering.py#L87-L299)). Users find the on/off switch too coarse ([#1331](https://github.com/microsoft/debugpy/issues/1331), [#1914](https://github.com/microsoft/debugpy/issues/1914)). The R analogue is `.libPaths()` versus the workspace.

### Variables

- **Stack and scopes.** `stackTrace` honours `startFrame` and `levels`. There are two scopes, Locals and Globals ([#L1061-L1128](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_process_net_command_json.py#L1061-L1128)).
- **References.** `variablesReference = id(value)`, tracked per suspension and dropped on resume ([pydevd_suspended_frames.py#L316-L438](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_suspended_frames.py#L316-L438)).
- **Expansion.** Type-dispatched resolvers produce children ([pydevd_resolver.py#L64-L790](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_resolver.py#L64-L790)). Extension points: `TypeResolveProvider` and `StrPresentationProvider` ([pydevd_extension_api.py#L62-L95](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_extension_api.py#L62-L95)).
- **Grouping.** Special, protected, function, and class variables are grouped, and each group can be shown grouped, inline, or hidden ([pydevd_suspended_frames.py#L112-L151](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_suspended_frames.py#L112-L151)).
- **Hints.** Strings get `rawString`. Return-value pseudo-variables get `readOnly`. `evaluateName` is always set ([#L37-L101](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_suspended_frames.py#L37-L101)).
- **Large collections.**
  - The first 100 items are shown inline, then `[from:to]` buckets of 1000. Dicts, sets, and numpy arrays are capped at 500 ([pydevd_constants.py#L296-L315](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_constants.py#L296-L315)).
  - These synthetic buckets are used instead of DAP `start`/`count`. No `start`/`count` handling was seen (unverified).
  - `SafeRepr` caps output at 64 KiB at the top level and 128 chars when nested ([pydevd_safe_repr.py#L19-L33](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_safe_repr.py#L19-L33)).
- **pandas.** Display limits are lowered temporarily (60 rows, 10 cols), and expensive attributes are replaced with "skipped" placeholders ([pydevd_plugin_pandas_types.py#L84-L115](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/pydevd_plugins/extensions/types/pydevd_plugin_pandas_types.py#L84-L115)).
- **Timeouts.**
  - A slow repr (more than 0.5 s) triggers a warning.
  - If expanding a variable while all threads are suspended blocks for more than 3 s, the other threads are resumed, because a getter can wait on a suspended thread ([pydevd_constants.py#L346-L387](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_constants.py#L346-L387), [pydevd_comm.py#L805-L815](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_comm.py#L805-L815)).

### Evaluate and setVariable

- **Where it runs.** On the suspended thread, in the frame. pydevd tries `eval` first; in `repl` context, if the text fails to compile as an expression, it falls back to `exec`, which allows multi-line statements and top-level await ([pydevd_comm.py#L1190-L1306](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_comm.py#L1190-L1306), [pydevd_vars.py#L420-L530](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_vars.py#L420-L530)).
- **Locals.** Globals and locals are merged into one dict for evaluation, and changes are written back afterwards. This works around comprehensions not seeing new names ([#815](https://github.com/microsoft/debugpy/issues/815)).
- **Hover has no side-effect guard.** It is a plain `eval`, found by reading the code. The only protection is timeouts: a warning at 3 s, an optional unblock of other threads, and an optional interrupt (Ctrl+C emulation on the main thread; `PyThreadState_SetAsyncExc` elsewhere, which cannot break out of I/O) ([pydevd_vars.py#L314-L405](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_vars.py#L314-L405), [pydevd_timeout.py#L201-L231](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_timeout.py#L201-L231)).
- **setVariable.** The new value is evaluated in the frame and assigned. Before 3.13, pydevd also calls `PyFrame_LocalsToFast` ([pydevd_vars.py#L635-L684](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_vars.py#L635-L684)).

### Exception breakpoints

- **Filters.** `raised` (default off), `uncaught` (on), and `userUnhandled` (off). The last means the exception unwinds from user code into library code ([#L956-L1058](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_process_net_command_json.py#L956-L1058), [pydevd_frame.py#L1108-L1145](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_frame.py#L1108-L1145)).
- **Cost.** RAISE and UNWIND events are enabled only when a filter is on ([_pydevd_sys_monitoring.py#L1966-L1980](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydevd_sys_monitoring/_pydevd_sys_monitoring.py#L1966-L1980)).
- **Side effect.** Holding exceptions keeps their objects alive longer, which changes program behaviour ([#1999](https://github.com/microsoft/debugpy/issues/1999)).

### Attach and subprocesses

- **Attach by PID.** The injector uses gdb on Linux, lldb on macOS, and DLL injection on Windows ([add_code_to_python_process.py#L428-L556](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/pydevd_attach_to_process/add_code_to_python_process.py#L428-L556)).
- **Subprocesses.** `pydev_monkey` patches `exec*`, `spawn*`, `fork`, and `CreateProcess` so child processes connect back. The adapter then sends `debugpyAttach` to open a child session ([pydev_monkey.py#L382](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/_vendored/pydevd/_pydev_bundle/pydev_monkey.py#L382), [adapter/clients.py#L449-L577](https://github.com/microsoft/debugpy/blob/10993112/src/debugpy/adapter/clients.py#L449-L577)).

### Known weaknesses

| Theme | Issues |
|---|---|
| Tracing overhead | Tight loops at least 2× slower ([#1378](https://github.com/microsoft/debugpy/issues/1378)); slow imports on 3.12 ([#1496](https://github.com/microsoft/debugpy/issues/1496)); slow stepping ([#1405](https://github.com/microsoft/debugpy/issues/1405)) |
| **Variables pane hangs** (the dominant theme) | [#1660](https://github.com/microsoft/debugpy/issues/1660), [#1729](https://github.com/microsoft/debugpy/issues/1729), [#1310](https://github.com/microsoft/debugpy/issues/1310), [#952](https://github.com/microsoft/debugpy/issues/952), [#2053](https://github.com/microsoft/debugpy/issues/2053), [#1391](https://github.com/microsoft/debugpy/issues/1391) |
| Deadlocks | `set_trace` under Ansible ([#1519](https://github.com/microsoft/debugpy/issues/1519)); gevent combined with frame-eval ([#189](https://github.com/microsoft/debugpy/issues/189)) |
| sys.monitoring regressions | [#1757](https://github.com/microsoft/debugpy/issues/1757), [#1970](https://github.com/microsoft/debugpy/issues/1970), [#1887](https://github.com/microsoft/debugpy/issues/1887) |
| Frame model mismatch | IPython's per-cell frames break stepping ([#869](https://github.com/microsoft/debugpy/issues/869)). R's per-top-level-expression REPL evaluation has the same problem |

### Files most worth studying

| Path | Why |
|---|---|
| `_vendored/pydevd/_pydevd_bundle/pydevd_process_net_command_json.py` | Every DAP handler: capabilities, verification messages, hit parsing |
| `_vendored/pydevd/pydevd.py` | The suspend loop: commands run on the paused thread |
| `_vendored/pydevd/_pydevd_sys_monitoring/_pydevd_sys_monitoring.py` | Event-based, per-code-object tracing |
| `_vendored/pydevd/_pydevd_bundle/pydevd_frame.py` | Step-skip logic, user-unhandled rules |
| `_vendored/pydevd/_pydevd_bundle/pydevd_api.py` | `add_breakpoint`: line snapping, error codes |
| `_vendored/pydevd/_pydevd_bundle/pydevd_suspended_frames.py` | Reference lifetime, grouping, hints |
| `_vendored/pydevd/_pydevd_bundle/pydevd_resolver.py` | Type-dispatched expansion and buckets |
| `_vendored/pydevd/_pydevd_bundle/pydevd_vars.py` | eval/exec in a frame, timeouts, setVariable |
| `_vendored/pydevd/_pydevd_bundle/pydevd_safe_repr.py` | Bounded repr |
| `_vendored/pydevd/pydevd_plugins/extensions/types/pydevd_plugin_pandas_types.py` | Data-frame display limits (compare data.frame and tibble) |
| `_vendored/pydevd/_pydevd_bundle/pydevd_timeout.py` | Timeout thread and interrupting the evaluation |
| `adapter/servers.py`, `adapter/sessions.py` (MIT) | Adapter/server split, token auth, trust boundary |

---

## Julia: DebugAdapter.jl / JuliaInterpreter.jl / Debugger.jl

Julia, like R, has no cheap line-tracing hook. The whole debugging stack therefore runs on an **interpreter over lowered IR**. Before each statement, `step_expr!` checks a per-statement breakpoint slot ([interpret.jl#L1000](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/interpret.jl#L1000), [commands.jl#L12-L19](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/commands.jl#L12-L19)).

Interpretation is slow. To recover speed, a "compiled" allow-list runs selected code natively. **Breakpoints in code that runs natively are silently missed** ([Debugger.jl README#L235-L256](https://github.com/JuliaDebug/Debugger.jl/blob/dc7b4806f68bb303525c89113112c445d05bdf88/README.md#L235-L256)).

The DAP server runs **in the debuggee process**: the REPL process for `@enter`/`@run`, and a fresh process for launch. This is the closest match to Raven's embedded console.

### Process model

| Piece | Role | Source |
|---|---|---|
| JuliaInterpreter.jl | Interpreter, frames, stepping, breakpoint registry, `locals`, `eval_code` | [packagedef.jl#L48-L56](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/packagedef.jl#L48-L56) |
| Debugger.jl | Terminal front end (`@enter`, `debug>` mode) | [Debugger.jl#L98-L161](https://github.com/JuliaDebug/Debugger.jl/blob/dc7b4806f68bb303525c89113112c445d05bdf88/src/Debugger.jl#L98-L161) |
| DebugAdapter.jl | DAP server in Julia: `DebugSession` handles the protocol, `DebugEngine` drives the interpreter | [DebugEngines.jl#L5-L51](https://github.com/julia-vscode/DebugAdapter.jl/blob/a39a4bcc83734a77e5d39175709be2c9591c05eb/src/DebugEngines.jl#L5-L51) |
| julia-vscode (TS) | `DebugAdapterNamedPipeServer` for both launch and attach | [debugFeature.ts#L377-L495](https://github.com/julia-vscode/julia-vscode/blob/dbbc6e32b323fdd19f14b895ce012379c576b41e/src/debugger/debugFeature.ts#L377-L495) |

**Launch.**
- The extension opens a "ready" pipe and spawns `julia run_debugger.jl <ready> <dap> <crash>` as a Task.
- Julia binds the DAP pipe and reports back the name it actually bound, falling back to another name if the proposed path is too long ([VSCodeDebugger.jl#L60-L138](https://github.com/julia-vscode/julia-vscode/blob/dbbc6e32b323fdd19f14b895ce012379c576b41e/scripts/packages/VSCodeDebugger/src/VSCodeDebugger.jl#L60-L138)).

**REPL `@enter`/`@run`.**
1. The macro sends a JSON-RPC `debugger/attach {pipename}` to the extension.
2. The extension calls `vscode.debug.startDebugging({request:'attach', pipename, …})`.
3. VS Code connects to a pipe served by an `@async` task in the REPL process.
4. The macro blocks in `DebugAdapter.debug_code(session, Main, string(expr), file)` until the code finishes ([VSCodeServer/debugger.jl#L71-L154](https://github.com/julia-vscode/julia-vscode/blob/dbbc6e32b323fdd19f14b895ce012379c576b41e/scripts/packages/VSCodeServer/src/debugger.jl#L71-L154), [repl.ts#L525-L535](https://github.com/julia-vscode/julia-vscode/blob/dbbc6e32b323fdd19f14b895ce012379c576b41e/src/interactive/repl.ts#L525-L535), [packagedef.jl#L213-L229](https://github.com/julia-vscode/DebugAdapter.jl/blob/a39a4bcc83734a77e5d39175709be2c9591c05eb/src/packagedef.jl#L213-L229)).

The expression is passed as a **string** and parsed again, and its return value is discarded ("TODO", [L83](https://github.com/julia-vscode/julia-vscode/blob/dbbc6e32b323fdd19f14b895ce012379c576b41e/scripts/packages/VSCodeServer/src/debugger.jl#L83)).

**Threading.**
- Each DAP message is handled in its own `@async` task. The engine blocks on a `Channel`, and step requests just `put!` a command and reply immediately ([packagedef.jl#L96-L116](https://github.com/julia-vscode/DebugAdapter.jl/blob/a39a4bcc83734a77e5d39175709be2c9591c05eb/src/packagedef.jl#L96-L116), [DebugEngines.jl#L451-L568](https://github.com/julia-vscode/DebugAdapter.jl/blob/a39a4bcc83734a77e5d39175709be2c9591c05eb/src/DebugEngines.jl#L451-L568)).
- The adapter reports a single "Main Thread", and interpreter state is process-global and not thread-safe ([index.md#L8-L12](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/docs/src/index.md#L8-L12)).
- Because the registry is global and one REPL process hosts many sessions, `initialize` wipes all file breakpoints and the client re-sends them ([debugger_requests.jl#L44-L54](https://github.com/julia-vscode/DebugAdapter.jl/blob/a39a4bcc83734a77e5d39175709be2c9591c05eb/src/debugger_requests.jl#L44-L54)).

### Interpreter core

- **Frame types.**
  - `FrameCode` holds the static data for each method: lowered `CodeInfo`, a local method cache, and a **breakpoint slot per statement** ([types.jl#L132-L164](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/types.jl#L132-L164)).
  - `FrameData` holds the runtime values ([L289-L324](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/types.jl#L289-L324)).
  - `Frame` is a linked stack with a world age ([L335-L366](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/types.jl#L335-L366)).
- **Interpreters.** `RecursiveInterpreter` interprets callees; `NonRecursiveInterpreter`/`Compiled` runs them natively; `BreakOnCall` is used for step-in ([types.jl#L1-L38](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/types.jl#L1-L38)).
- **Compiled lists.** `compiled_modules`, `compiled_methods`, and `interpreted_methods`. Code on the compiled lists never gets a FrameCode, **so it can never hold a breakpoint** ([construct.jl#L17-L34](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/construct.jl#L17-L34), [#L374-L377](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/construct.jl#L374-L377)). Some methods are hard-wired as compiled for correctness ([packagedef.jl#L58-L129](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/packagedef.jl#L58-L129)).
- **Top-level code.** `ExprSplitter` produces one frame per top-level expression. When a frame finishes, the engine moves to the next and stops there if stepping ([construct.jl#L648-L712](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/construct.jl#L648-L712), [DebugEngines.jl#L287-L370](https://github.com/julia-vscode/DebugAdapter.jl/blob/a39a4bcc83734a77e5d39175709be2c9591c05eb/src/DebugEngines.jl#L287-L370)). This is the analogue of stepping over a script's top-level expressions.
- **`include` from interpreted code** interprets the included file too, as nested top-level frames that can hit breakpoints ([internals.md#L260-L274](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/docs/src/internals.md#L260-L274)). This is the analogue of `source()`.

### Breakpoints

| Kind | Mechanism | Source |
|---|---|---|
| Registry | Global `_breakpoints` holding method breakpoints and file:line breakpoints. Each tracks the `(framecode, stmt)` pairs it was applied to | [breakpoints.jl#L3-L14](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/breakpoints.jl#L3-L14) |
| Method | `breakpoint(f, sig, line, cond)`, matched by `sig <: meth.sig`. Line 0 means the first statement | [#L74-L171](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/breakpoints.jl#L74-L171) |
| File:line | Normalized path plus realpath, matched by equality or path suffix | [#L185-L230](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/breakpoints.jl#L185-L230) |
| Line → statements | Applies the Revise line offset. A breakpoint on `end` moves to the next statement | [utils.jl#L563-L606](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/utils.jl#L563-L606) |
| Not-yet-defined code | **Lazy.** Each new FrameCode scans the registry when it is built, and setting a breakpoint patches FrameCodes already cached | [types.jl#L263-L282](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/types.jl#L263-L282), [breakpoints.jl#L63-L72](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/breakpoints.jl#L63-L72) |
| Function breakpoint on an undefined name | Parked, then retried after every debug command | [DebugEngines.jl#L225-L245](https://github.com/julia-vscode/DebugAdapter.jl/blob/a39a4bcc83734a77e5d39175709be2c9591c05eb/src/DebugEngines.jl#L225-L245) |
| Conditional | Compiled once into a closure that binds the slot names | [breakpoints.jl#L232-L294](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/breakpoints.jl#L232-L294) |
| `break_on(:error)` / `(:throw)` | Global flags. `:error` stops only if no handler will catch the error | [#L377-L414](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/breakpoints.jl#L377-L414) |
| In-source `@bp` | Becomes an active breakpoint slot (like `browser()`) | [#L478-L506](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/breakpoints.jl#L478-L506) |
| DAP | Exception filters: `error` (default on) and `throw`. A condition that fails to parse silently becomes an unconditional breakpoint | [debugger_requests.jl#L218-L271](https://github.com/julia-vscode/DebugAdapter.jl/blob/a39a4bcc83734a77e5d39175709be2c9591c05eb/src/debugger_requests.jl#L218-L271) |

**Weaknesses.**
- Every breakpoint is reported `verified:true`, and `breakpointLocations` returns an empty list ([debugger_requests.jl#L250](https://github.com/julia-vscode/DebugAdapter.jl/blob/a39a4bcc83734a77e5d39175709be2c9591c05eb/src/debugger_requests.jl#L250), [#L1138-L1140](https://github.com/julia-vscode/DebugAdapter.jl/blob/a39a4bcc83734a77e5d39175709be2c9591c05eb/src/debugger_requests.jl#L1138-L1140)).
- No hit counts and no logpoints.

### Stepping

`debug_command(interp, frame, cmd)` is the single entry point for stepping ([commands.jl#L634-L790](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/commands.jl#L634-L790)).

| Cmd | Semantics | DAP |
|---|---|---|
| `:n` | Run until the line or file changes, then advance to the next "interesting" statement (a call, return, or named assignment) | next |
| `:s` | Advance to the next call and enter it with `BreakOnCall`, skipping kwarg and wrapper frames | stepIn |
| `:finish` | Finish the frame and return to the caller | stepOut |
| `:c` | Run until a breakpoint or the end | continue |
| `:nc :se :si :sl :sr :until :sg` | Finer-grained steps | Debugger.jl only |

- **Line logic:** [commands.jl#L190-L259](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/commands.jl#L190-L259).
- **stepInTargets.** Targets are the calls on the line, identified by statement index. Stepping into one repeats `:nc` until reaching it (at most 100 times), then runs `:s` ([debugger_utils.jl#L15-L50](https://github.com/julia-vscode/DebugAdapter.jl/blob/a39a4bcc83734a77e5d39175709be2c9591c05eb/src/debugger_utils.jl#L15-L50), [DebugEngines.jl#L465-L488](https://github.com/julia-vscode/DebugAdapter.jl/blob/a39a4bcc83734a77e5d39175709be2c9591c05eb/src/DebugEngines.jl#L465-L488)).
- **restartFrame.** Sets `pc=1` without undoing side effects ([debugger_requests.jl#L988-L1014](https://github.com/julia-vscode/DebugAdapter.jl/blob/a39a4bcc83734a77e5d39175709be2c9591c05eb/src/debugger_requests.jl#L988-L1014)).
- **No `pause`.** Also, breakpoints cannot change while code runs. The open design calls for a per-statement callback ([JuliaInterpreter#381](https://github.com/JuliaDebug/JuliaInterpreter.jl/issues/381)).

### Variables and evaluate

- **Scopes.** `Local`; `Global`, which lists the GlobalRefs the method uses and is collected via `code_typed`, which compiles the method; and `Global (Module)`, marked `expensive` ([debugger_requests.jl#L540-L574](https://github.com/julia-vscode/DebugAdapter.jl/blob/a39a4bcc83734a77e5d39175709be2c9591c05eb/src/debugger_requests.jl#L540-L574), [#L711-L745](https://github.com/julia-vscode/DebugAdapter.jl/blob/a39a4bcc83734a77e5d39175709be2c9591c05eb/src/debugger_requests.jl#L711-L745)).
- **Locals.** `locals(frame)` keeps the most recently assigned of any duplicate slot names and includes closure captures ([utils.jl#L669-L715](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/utils.jl#L669-L715)). Variable handles are cleared on every stop ([packagedef.jl#L139](https://github.com/julia-vscode/DebugAdapter.jl/blob/a39a4bcc83734a77e5d39175709be2c9591c05eb/src/packagedef.jl#L139)).
- **Paging.** start/count are honoured, and responses report `namedVariables`/`indexedVariables` ([debugger_requests.jl#L642-L890](https://github.com/julia-vscode/DebugAdapter.jl/blob/a39a4bcc83734a77e5d39175709be2c9591c05eb/src/debugger_requests.jl#L642-L890)).
- **Defensive rendering.** Values are printed into a 1000-byte limited IO, and any user `show` that throws becomes a `#error:` placeholder ([debugger_utils.jl#L100-L135](https://github.com/julia-vscode/DebugAdapter.jl/blob/a39a4bcc83734a77e5d39175709be2c9591c05eb/src/debugger_utils.jl#L100-L135), [DebugAdapter#101](https://github.com/julia-vscode/DebugAdapter.jl/issues/101)).
- **eval_code.** Wraps the expression in `let <locals> ; expr end`, runs it with `Core.eval` in the frame's module, and writes reassigned locals back. It **cannot create new locals** ([utils.jl#L785-L880](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/utils.jl#L785-L880)).

### Source mapping

- **Lines.** `linenumber` gives the static line. `CodeTracking.whereis` gives the line adjusted for Revise edits ([utils.jl#L472-L550](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/utils.jl#L472-L550)).
- **Stack-frame sources** fall back in this order: the real file path; then `definition(String, m)` as a `sourceReference`; then pretty-printed lowered IR as a virtual source ([debugger_requests.jl#L344-L538](https://github.com/julia-vscode/DebugAdapter.jl/blob/a39a4bcc83734a77e5d39175709be2c9591c05eb/src/debugger_requests.jl#L344-L538)).
- **Phantom return.** Lowering attributes the implicit trailing `return` to the previous line, and Debugger.jl detects this ([locationinfo.jl#L14-L31](https://github.com/JuliaDebug/Debugger.jl/blob/dc7b4806f68bb303525c89113112c445d05bdf88/src/locationinfo.jl#L14-L31)).

### Performance tradeoffs

- **Measured slowdown.** `a .*= 2` on 100k elements took 0.000153 s natively and 4.48 s under the debugger, about 29,000×. The maintainer said this is expected ([julia-vscode#2951](https://github.com/julia-vscode/julia-vscode/issues/2951)). Related: [JuliaInterpreter#297](https://github.com/JuliaDebug/JuliaInterpreter.jl/issues/297), [Debugger.jl#192](https://github.com/JuliaDebug/Debugger.jl/issues/192).
- **Default mitigation.** `julia.debuggerDefaultCompiled = ["ALL_MODULES_EXCEPT_MAIN"]`, so only `Main` is interpreted and **breakpoints in packages are missed** unless the user edits the "Compiled Code" tree. Users find that tree confusing ([package.json#L1366-L1373](https://github.com/julia-vscode/julia-vscode/blob/dbbc6e32b323fdd19f14b895ce012379c576b41e/package.json#L1366-L1373), [DebugEngines.jl#L145-L223](https://github.com/julia-vscode/DebugAdapter.jl/blob/a39a4bcc83734a77e5d39175709be2c9591c05eb/src/DebugEngines.jl#L145-L223), [julia-vscode#3335](https://github.com/julia-vscode/julia-vscode/issues/3335)).
- **Compiled mode.** Code that is stepped over runs natively, and breakpoints inside it are missed ([commands.jl#L743](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/src/commands.jl#L743)).
- **Cache pitfall.** `clear_caches()` dropped the FrameCodes of paused frames, so breakpoint edits made mid-session were lost. Caches are now cleared only when the compiled set changes ([DebugEngines.jl#L127-L143](https://github.com/julia-vscode/DebugAdapter.jl/blob/a39a4bcc83734a77e5d39175709be2c9591c05eb/src/DebugEngines.jl#L127-L143), [DebugAdapter#99](https://github.com/julia-vscode/DebugAdapter.jl/issues/99)).
- **Proposed, not shipped.** Run compiled code until reaching a method that contains a breakpoint ([JuliaInterpreter#306](https://github.com/JuliaDebug/JuliaInterpreter.jl/issues/306), [#298](https://github.com/JuliaDebug/JuliaInterpreter.jl/issues/298)).

### Open issues

- No pause, and no live breakpoint edits ([#381](https://github.com/JuliaDebug/JuliaInterpreter.jl/issues/381)).
- No debugging of spawned Tasks ([#413](https://github.com/JuliaDebug/JuliaInterpreter.jl/issues/413)).
- Stepping goes into macro expansions, which is noisy ([#151](https://github.com/JuliaDebug/JuliaInterpreter.jl/issues/151)).
- No remote processes ([#276](https://github.com/JuliaDebug/JuliaInterpreter.jl/issues/276)).
- Cannot handle calls into R via RCall ([#342](https://github.com/JuliaDebug/JuliaInterpreter.jl/issues/342)).
- World-age bugs ([#262](https://github.com/JuliaDebug/JuliaInterpreter.jl/issues/262)).
- Requests that arrive after the debuggee finishes must get error responses rather than crash the adapter ([debugger_requests.jl#L3-L42](https://github.com/julia-vscode/DebugAdapter.jl/blob/a39a4bcc83734a77e5d39175709be2c9591c05eb/src/debugger_requests.jl#L3-L42)).

### Licenses

| Repo | SPDX |
|---|---|
| DebugAdapter.jl | `MIT` ([LICENSE](https://github.com/julia-vscode/DebugAdapter.jl/blob/a39a4bcc83734a77e5d39175709be2c9591c05eb/LICENSE)) |
| JuliaInterpreter.jl | `MIT` ("Expat"; the API reports `NOASSERTION`) ([LICENSE.md](https://github.com/JuliaDebug/JuliaInterpreter.jl/blob/0c3adb4859401971b3b1040e5767bdc2d9414d08/LICENSE.md)) |
| Debugger.jl | `MIT` ([LICENSE](https://github.com/JuliaDebug/Debugger.jl/blob/dc7b4806f68bb303525c89113112c445d05bdf88/LICENSE)) |
| julia-vscode | `MIT`. The licenses of the vendored `scripts/packages/*` are unverified ([LICENSE](https://github.com/julia-vscode/julia-vscode/blob/dbbc6e32b323fdd19f14b895ce012379c576b41e/LICENSE)) |

### Files most worth studying

| Path | Why |
|---|---|
| JuliaInterpreter `src/commands.jl` | Step semantics and the "interesting statement" heuristics |
| JuliaInterpreter `src/breakpoints.jl` | Global registry, path matching, compiled conditions, `break_on` |
| JuliaInterpreter `src/types.jl` | Frame/FrameCode split; breakpoints applied lazily when a FrameCode is built |
| JuliaInterpreter `src/utils.jl` | Line mapping, `locals`, `eval_code` |
| JuliaInterpreter `src/construct.jl` | The compiled/interpreted gate, `ExprSplitter` |
| DebugAdapter `src/DebugEngines.jl` | Engine loop, sequencing of top-level frames, deferred function breakpoints |
| DebugAdapter `src/debugger_requests.jl` | Every DAP handler, paging, defensive rendering |
| julia-vscode `scripts/packages/VSCodeServer/src/debugger.jl` | DAP listener inside the REPL process. **Closest analogue to `raven console`** |
| julia-vscode `src/debugger/debugFeature.ts` | Named-pipe adapter factory and the handshake |
| Debugger.jl `src/locationinfo.jl` | Phantom-return line fix |

---

## R: Ark (Positron)

Links pin ark to `445aebc13e702342234316be5657154dbc647e7d`.

### Licensing

| Component | SPDX | Source |
|---|---|---|
| ark (including `harp` and `amalthea`) | `MIT` | [LICENSE](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/LICENSE), [Cargo.toml L19](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/Cargo.toml#L19) |
| Positron (`positron-r`, `DapComm.ts`, the debugger schema patches) | `Elastic-2.0` plus an education exception. GitHub reports `NOASSERTION` | [LICENSE.txt](https://github.com/posit-dev/positron/blob/main/LICENSE.txt), [DapComm.ts header](https://github.com/posit-dev/positron/blob/main/extensions/positron-supervisor/src/DapComm.ts#L1-L4) |
| `dap` crate (`sztomi/dap-rs`) | `MIT` per GitHub. A `LICENSE.Apache2.0` file is also present, so it may be dual-licensed (unverified) | [Cargo.toml L55](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/Cargo.toml#L55), [dap-rs](https://github.com/sztomi/dap-rs) |
| pkgload, shiny | `MIT + file LICENSE` | [pkgload DESCRIPTION](https://github.com/r-lib/pkgload/blob/552a11f852a6af7fdb7812fad97d18d4cc3222f8/DESCRIPTION#L16), [shiny DESCRIPTION](https://github.com/rstudio/shiny/blob/7aaacda3cfc283e680133bacbb5bd26a1347d79a/DESCRIPTION#L72) |

### File map (`crates/ark/src/`)

| File | Role |
|---|---|
| [`dap/dap_server.rs`](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_server.rs) | Transport-agnostic `DapHandler` (a request produces a response, DAP events, and console events), the TCP server, and the event pump |
| [`dap/dap_state.rs`](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_state.rs) | Shared `Dap` state behind `Arc<Mutex>`: the breakpoint model, variable-reference maps, and verification |
| [`dap/dap_variables.rs`](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_variables.rs) | Formats SEXPs as DAP variables |
| [`dap/dap_jupyter_handler.rs`](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_jupyter_handler.rs#L8-L16), [`dap/dap_notebook.rs`](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_notebook.rs#L8-L13) | Jupyter Debug Protocol transport, and the mapping from notebook cells to temp files |
| [`console/console_debug.rs`](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_debug.rs) | Runs on the R thread: builds the stack, filters hidden frames, evaluates condition/hit/log breakpoints, and exposes the verify and exception `.Call`s |
| [`console/console_annotate.rs`](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_annotate.rs) | Rewrites source at parse time: breakpoint injection, `#line` directives, and verify calls |
| [`console/console_repl.rs`](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_repl.rs) | The `read_console` state machine, browser-prompt detection, auto-step, and evaluation in the selected frame |
| [`console/console_filter.rs`](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_filter.rs#L7-L24) | Captures and suppresses the `debug at`/`debug:`/`Called from:` output |
| [`modules/positron/debug.R`](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/modules/positron/debug.R) | Builds the stack on the R side; defines `.ark_breakpoint`, `.ark_auto_step`, and `.ark_verify_breakpoints_range` |
| [`modules/positron/hooks_source.R`](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/modules/positron/hooks_source.R) | Overrides `base::source`; defines `.ark_annotate_source` |
| [`modules/positron/errors.R`](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/modules/positron/errors.R) | Global calling handlers that implement the exception filters |
| [`srcref.rs`](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/srcref.rs#L213-L230) | `ark:` virtual-document URIs and regeneration of namespace srcrefs |

There is no `dap_r_main.rs` any more; its role moved into `console_debug.rs` and `console_repl.rs`. The files `debug.rs` and `debug.c` are lldb/gdb helpers and have nothing to do with DAP ([debug.c](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/debug.c#L1-L15)).

### Architecture and threading

**Transport and session lifetime**
- **Transport.** TCP on `127.0.0.1:0`. The port is announced through a Jupyter comm. Each connection gets a `DapServer` plus an `ark-dap-events` thread ([dap_server.rs#L757-L905](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_server.rs#L757-L905)). The server comm stays alive across TCP sessions ([ark#901](https://github.com/posit-dev/ark/pull/901)).
- **Always attached.** Positron's `DapComm` starts an `attach` session with `debugServer: port` and suppresses the toolbar and status bar. The DAP session stays connected for the whole kernel lifetime so that breakpoint updates keep flowing ([DapComm.ts](https://github.com/posit-dev/positron/blob/main/extensions/positron-supervisor/src/DapComm.ts)). `start_debug` and `stop_debug` only toggle whether the session is in the foreground, and `stop_debug` is debounced by 100 ms. On exit, ark sends `Continued` rather than `Terminated` ([dap_state.rs#L436-L502](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_state.rs#L436-L502)).
- **Positron-only debugger flags.** Positron added `sendBreakpointsOnAllSaves`, `verifyBreakpointsInDirtyDocuments`, and `supportsFrameSelection` ([debugSchemas.ts](https://github.com/posit-dev/positron/blob/main/src/vs/workbench/contrib/debug/common/debugSchemas.ts), [positron-r package.json](https://github.com/posit-dev/positron/blob/main/extensions/positron-r/package.json)). **Stock VS Code has none of these.**
- **One thread.** `THREAD_ID = -1`, named "R console" ([dap_state.rs#L44-L45](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_state.rs#L44-L45)).

**From the DAP thread to the R thread**
- **Steps.** Step requests become `DebugCommand`s. When a frontend is attached, they **round-trip through the frontend as an `execute`**, so the user sees `n`/`c` echoed in the console ([dap_server.rs#L979-L1011](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_server.rs#L979-L1011)).
- **variables.** Runs in `r_task()` ([L635-L657](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_server.rs#L635-L657)).
- **evaluate.** Runs as `RTask::send_idle_any_prompt`, which also runs at a browser prompt. Its response is sent asynchronously ([L933-L959](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_server.rs#L933-L959), [L1029-L1051](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_server.rs#L1029-L1051)).

**From the R thread to DAP**
- A crossbeam channel carries events back ([dap_state.rs#L512-L536](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_state.rs#L512-L536)).

**Lock discipline (lesson from [positron#5024](https://github.com/posit-dev/positron/issues/5024))**
- Never hold the `Dap` mutex across an R evaluation. An R longjmp skips `Drop` and leaves the mutex locked, and the DAP thread waiting in `r_task()` can deadlock against the R thread waiting on the lock ([dap_server.rs#L714-L724](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_server.rs#L714-L724), [dap_state.rs#L884-L891](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_state.rs#L884-L891)).
- The fix, [ark#992](https://github.com/posit-dev/ark/pull/992), takes the lock only on the R thread.

### browser() prompt → `stopped`

1. **Detect the prompt.** The prompt matches `Browse\[\d+\]` ([console_repl.rs#L30](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_repl.rs#L30)).
2. **Capture R's debug output.** `debug at <file>#<line>: <expr>` and `debug: <expr>` are captured from WriteConsole and suppressed by default (option `ark.debugger.filter_debug_output`) ([console_filter.rs#L7-L24](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_filter.rs#L7-L24), [console_repl.rs#L944-L969](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_repl.rs#L944-L969)).
3. **Auto-step check.** If the stop is in an injected helper, ark steps on silently. Otherwise, if no queued input remains, it calls `debug_start` ([L970-L1010](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_repl.rs#L970-L1010)).
4. **Send `stopped`.** The reason is `Step` for both steps and breakpoints, with no `hitBreakpointIds`. Condition stops use `Exception` with the class and message ([dap_state.rs#L165-L222](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_state.rs#L165-L222)).
5. **Transient evals.** When the user types code at `Browse>`, ark compares the stack at the next prompt by `FrameInfoId`. If the stack is unchanged it sends only `Invalidated{variables}`, so the editor does not jump. If it changed, ark tears the debug session down and starts it again ([console_debug.rs#L94-L145](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_debug.rs#L94-L145), [positron#3151](https://github.com/posit-dev/positron/issues/3151)).
6. **Console eval in the selected frame.**
   - Ark evaluates each top-level expression itself with `Rf_eval` in the selected frame, after setting `R_Srcref`.
   - It then hands R the input `base::.ark_last_value`, so R only prints the result ([L1754-L1834](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_repl.rs#L1754-L1834)).
   - The frontend signals frame selection with `evaluate(".positron_selected_frame", frameId)` ([dap_server.rs#L60-L63](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_server.rs#L60-L63)).

### Stack frames

- **Inputs.** Rust gathers `sys.function()`, `sys.frames()`, `sys.calls()`, `R_Srcref` (a C NULL is mapped to `R_NilValue`, [positron#8979](https://github.com/posit-dev/positron/issues/8979)), the `debug:` text, the last start line, and the eval env. It then calls R's `debugger_stack_info()` ([console_debug.rs#L196-L270](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_debug.rs#L196-L270)).
- **Locating each frame.** The frame for function *i* uses the srcref of call *i+1*. A `<global>` frame comes first. A synthetic `<current>` frame is added when the eval env is not `sys.frame(n)`, for example while a promise is being forced ([debug.R#L59-L181](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/modules/positron/debug.R#L59-L181), [ark#797](https://github.com/posit-dev/ark/pull/797)).
- **Fallback when there is no srcref** ([debug.R#L279-L822](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/modules/positron/debug.R#L279-L822), [ark#249](https://github.com/posit-dev/ark/pull/249)):
  - Deparse the function and prefix it with `name <-`.
  - Reparse with `keep.source`, first replacing tokens that cannot be parsed (`<environment>`, `<bytecode>`, …).
  - Find the current expression by matching the whitespace-stripped `debug:` text, then fall back to a leaf-only partial match plus the last start line.
- **Virtual documents.** Fallback sources are served as `ark:ark-<pid>/debug/session<N>/<hash>/<name>.R`, passed in `Source.path`. They are fetched through the `ark:` text-content provider via ark's LSP; `sourceReference` is not used ([console_debug.rs#L279-L299](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_debug.rs#L279-L299), [dap_server.rs#L1053-L1106](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_server.rs#L1053-L1106), [ark#852](https://github.com/posit-dev/ark/pull/852)). Namespace srcrefs are regenerated into `ark:…/namespace/<pkg>.R` ([srcref.rs#L20-L120](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/srcref.rs#L20-L120)).
- **Hidden frames.** The option `ark.debugger.show_hidden_frames` controls two kinds ([console_debug.rs#L337-L461](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_debug.rs#L337-L461)):
  - *internal*: handler frames, `.handleSimpleError`, `withRestarts`, …
  - *fenced*: frames between shiny's `..stacktraceon..` and `..stacktraceoff..`.
- **Columns.** R's inclusive end column is converted to an exclusive one ([L525-L530](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_debug.rs#L525-L530)). `stackTrace` honours `startFrame`/`levels`.

### Scopes, variables, evaluate

- **Scopes.** One `Locals` scope per frame. References are rebuilt on every stop, but the counter resets only at `stop_debug`, which avoids stale-reference races ([dap_state.rs#L351-L377](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_state.rs#L351-L377)).
- **No paging.** `start`, `count`, and `filter` are ignored ([dap_server.rs#L624-L633](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_server.rs#L624-L633)).
- **What expands, and what is never forced.** Only environments and lists are expandable. Atomic vectors are shown via `vec_format(x, 5)`. **Promises are never forced**: ark shows the value if already forced, otherwise the expression. Active bindings are not evaluated ([dap_variables.rs#L85-L420](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_variables.rs#L85-L420)).
- **evaluate.**
  - Runs `parse_eval0` in the frame env with a timeout, so a watch expression cannot hang the session ([positron#14481](https://github.com/posit-dev/positron/issues/14481)).
  - A `/print ` prefix returns the printed output.
  - Hover is supported ([dap_server.rs#L690-L746](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_server.rs#L690-L746)).

### Stepping

| DAP | R input | Notes |
|---|---|---|
| continue | `c` | |
| next | `n` | Rewritten to `f` after an exception or pause stop, to leave the hidden handler frame ([console_repl.rs#L1680-L1693](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_repl.rs#L1680-L1693)) |
| stepIn | `s` | Calls `compiler::enableJIT(0)` first and restores it at the next prompt, to avoid stepping into compiler internals ([L1717-L1725](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_repl.rs#L1717-L1725), [positron#11890](https://github.com/posit-dev/positron/issues/11890)) |
| stepOut | `f` | |
| disconnect (while debugging) | `Q` | |
| pause | SIGINT | The global interrupt handler calls `browser()` ([dap_server.rs#L677-L688](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_server.rs#L677-L688)) |

**Auto-step.** Ark silently feeds `n` in two cases ([L2293-L2330](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_repl.rs#L2293-L2330)):
- the `debug at` text starts with `base::.ark_auto_step`, or
- `sys.function()` inherits class `ark_breakpoint`.

### Breakpoints: parse-time injection

- **Rationale** (comment at [console_annotate.rs#L35-L169](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_annotate.rs#L35-L169)): ark injects into the source **before R parses it**, instead of tracing live closures the way RStudio does. That avoids having to find every copy of a function (exports, S3/R6/S7 tables) and keeps srcrefs correct.
- **What gets injected.**
  - The injected form is `base::.ark_auto_step(base::.ark_breakpoint(browser(), "<uri>", "<id>"))`, followed by `#line N "<uri>"` and the target expression.
  - It uses a bare `browser()`, because `base::browser()` would trigger byte-compilation ([L938-L947](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_annotate.rs#L938-L947)).
  - `.ark_breakpoint` verifies itself, checks condition, hit count, and log message, and only then forces the promised `browser()`. That promise lives in the caller's environment, so the auto-step `n` lands on the real expression ([debug.R#L833-L866](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/modules/positron/debug.R#L833-L866)).
  - The helpers are bound into `baseenv` ([debug.R#L8-L23](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/modules/positron/debug.R#L8-L23)).
- **The rewriter.**
  - It is a Biome `SyntaxRewriter` over ark's own R parser.
  - A breakpoint anchors to the next expression whose span reaches the breakpoint's line, and that anchored line is reported back to the client ([`match_breakpoints` L471](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_annotate.rs#L471), [dap_state.rs#L71-L100](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_state.rs#L71-L100)).
  - Breakpoints on a closing `}` or inside an empty `{}` are marked `Invalid` with a message.
- **When it annotates.**
  - Ark annotates only when an execute request carries Positron's `positron.code_location`, that is, code sent from an editor ([execute_request.rs#L40-L105](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/amalthea/src/wire/execute_request.rs#L40-L105), [console_repl.rs#L1546-L1577](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_repl.rs#L1546-L1577)).
  - It prepends `#line <start+1> "<uri>"` and pads to the starting column.
  - It injects only inside `{}`. A top-level breakpoint in sent code stays `Unverified`.
  - Notebook cells are wrapped in `{}` so that top-level breakpoints work ([ark#1278](https://github.com/posit-dev/ark/pull/1278)).
- **`source()`.**
  - `base::source` is rebound. Annotation happens only for `source(file)` (plus `echo`/`local`) when that file has breakpoints; otherwise the original `source` runs. The option `ark.source_hook=FALSE` turns this off ([hooks_source.R#L1-L176](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/modules/positron/hooks_source.R#L1-L176)).
  - The whole file is wrapped in `{ #line 1 "uri" … }`. A range-verify call is inserted after each statement that contains breakpoints, and the result is wrapped in `withVisible` ([console_annotate.rs#L228-L290](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_annotate.rs#L228-L290)).
- **Verification states** ([dap_state.rs#L679-L832](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_state.rs#L679-L832), [dap_server.rs#L240-L458](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_server.rs#L240-L458)):
  - Each breakpoint starts as `Unverified`.
  - It becomes `Verified` when the statement containing it finishes evaluating, or when it is hit.
  - Unchecking it makes it `Disabled`, which keeps the verification so re-checking restores `Verified` without re-sourcing.
- **Edits.**
  - Every LSP `didChange` drops **all** breakpoints for that file to `verified:false` ([state_handlers.rs#L386-L391](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/lsp/state_handlers.rs#L386-L391), [dap_state.rs#L761-L781](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_state.rs#L761-L781)).
  - `setBreakpoints` stores a blake3 hash of the file on disk. If the hash differs on a later send, all breakpoints for that file are replaced with fresh ids.
- **Path identity.** The editor path is the key, with a secondary index of canonicalized paths for srcrefs that went through `normalizePath()` ([dap_state.rs#L224-L320](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_state.rs#L224-L320)).
- **Condition, hit count, logpoint** ([console_debug.rs#L541-L660](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_debug.rs#L541-L660)):
  - The condition is wrapped as `if ({cond}) TRUE else FALSE`. An error or non-logical result **breaks** and prints the error.
  - Hit counts use `>=` and reset at the top-level prompt.
  - Logpoints use `glue` when it is installed.
  - PRs: [ark#1064](https://github.com/posit-dev/ark/pull/1064), [#1086](https://github.com/posit-dev/ark/pull/1086), [#1087](https://github.com/posit-dev/ark/pull/1087). Shipped in Positron 2026.04 ([release notes](https://github.com/posit-dev/positron/releases/tag/2026.04.0-269)).
- **When breakpoints shipped.** The base feature came in [ark#1003](https://github.com/posit-dev/ark/pull/1003) and [positron#1766](https://github.com/posit-dev/positron/issues/1766), released in Positron 2026.02 ([release notes](https://github.com/posit-dev/positron/releases/tag/2026.02.0-139)).

### Exception filters (error / warning / interrupt)

- **Advertised filters.** `error`, `warning`, and `interrupt`, all off by default ([dap_server.rs#L190-L238](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/dap/dap_server.rs#L190-L238)).
- **Mechanism.** Ark appends handlers to `globalCallingHandlers()`, so other handlers run first. Each handler checks the active filters, records the class and message, and calls `browser()`. Interrupts then call `.tryResumeInterrupt()` ([errors.R#L8-L120](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/modules/positron/errors.R#L8-L120), [#L265-L323](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/modules/positron/errors.R#L265-L323)).
- **Errors caught by an inner `tryCatch` never reach them.** This is inferred from R's handler semantics, not tested.
- **When it shipped.** [ark#1036](https://github.com/posit-dev/ark/pull/1036) was merged 2026-02-25 and closed [positron#11797](https://github.com/posit-dev/positron/issues/11797) and [#11799](https://github.com/posit-dev/positron/issues/11799). It shipped in Positron 2026.03 according to the dates; the [release notes](https://github.com/posit-dev/positron/releases/tag/2026.03.0-212) don't mention it (unverified).

### Cooperation hooks in other packages

- **pkgload ≥ 1.5.0** ([NEWS](https://github.com/r-lib/pkgload/blob/552a11f852a6af7fdb7812fad97d18d4cc3222f8/NEWS.md#L24-L26)): `source_one()` looks up `.ark_annotate_source` in `baseenv()`. If found, it builds a `file:///` URI from `normalizePath` and replaces the source lines with the annotated ones before calling `srcfilecopy()` and `parse()`. On failure it only warns ([R/source.R#L21-L51](https://github.com/r-lib/pkgload/blob/552a11f852a6af7fdb7812fad97d18d4cc3222f8/R/source.R#L21-L51)).
- **shiny ≥ 1.13.0** ([NEWS](https://github.com/rstudio/shiny/blob/7aaacda3cfc283e680133bacbb5bd26a1347d79a/NEWS.md#L81-L86)): `maybeAnnotateSourceForArk()` uses the same recipe, inside `..stacktraceon..({ #line 1 … })` ([R/utils.R#L1374-L1420](https://github.com/rstudio/shiny/blob/7aaacda3cfc283e680133bacbb5bd26a1347d79a/R/utils.R#L1374-L1420)).
- **The contract.** Ark's only contract with these packages is the function `.ark_annotate_source(source, uri, with_visible)` bound in `baseenv`, which returns `NULL` when there are no breakpoints ([hooks_source.R#L178-L186](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/modules/positron/hooks_source.R#L178-L186), [console_annotate.rs#L965-L1012](https://github.com/posit-dev/ark/blob/445aebc13e702342234316be5657154dbc647e7d/crates/ark/src/console/console_annotate.rs#L965-L1012)).

### Known issues

| Issue | State | Gist |
|---|---|---|
| [positron#5024](https://github.com/posit-dev/positron/issues/5024) | closed | Deadlock between the DAP `variables` request and the R thread over the `Dap` lock. Fixed by [ark#992](https://github.com/posit-dev/ark/pull/992) |
| [ark#1402](https://github.com/posit-dev/ark/issues/1402) | open | `debug()` on a base function that ark itself uses breaks ark |
| [ark#1056](https://github.com/posit-dev/ark/issues/1056) | open | `debugonce(eval)` hangs, because srcref generation calls `eval` |
| [positron#15355](https://github.com/posit-dev/positron/issues/15355) | open | **No dynamic breakpoints.** The code must be re-evaluated or re-sourced; a regression compared with RStudio |
| [positron#16275](https://github.com/posit-dev/positron/issues/16275) | open | Repeated `s` exits the debugger in the console but not in the editor |
| [positron#15532](https://github.com/posit-dev/positron/issues/15532) | open | Step Out from a `for` loop doesn't pause after the loop |
| [positron#15533](https://github.com/posit-dev/positron/issues/15533) | open | Restarting disables breakpoints |
| [positron#15838](https://github.com/posit-dev/positron/issues/15838) | open | `ECONNREFUSED` after an R restart |
| [positron#11940](https://github.com/posit-dev/positron/issues/11940) | open | Keep the debug session alive while the console is in the background |
| [positron#2282](https://github.com/posit-dev/positron/issues/2282) | open | No virtual documents for dangling srcrefs |
| [positron#8979](https://github.com/posit-dev/positron/issues/8979) / [#12021](https://github.com/posit-dev/positron/issues/12021) | closed | Segfault on a C-NULL `R_Srcref`. Fixed by [ark#1047](https://github.com/posit-dev/ark/pull/1047) |
| [positron#12642](https://github.com/posit-dev/positron/issues/12642) | closed | An error inside `browser()` dropped to the global env. Fixed by [ark#1125](https://github.com/posit-dev/ark/pull/1125) |
| [positron#15709](https://github.com/posit-dev/positron/issues/15709) | closed | Breakpoints couldn't be set on `else if` lines |
| [positron#11558](https://github.com/posit-dev/positron/issues/11558) | closed | Windows paths. Fixed by [ark#1016](https://github.com/posit-dev/ark/pull/1016) |

### Files most worth studying

| Path | Why |
|---|---|
| `crates/ark/src/console/console_annotate.rs` | Injection design, anchoring, rules for invalid breakpoints, `#line`. Its tests and snapshots work as a specification |
| `crates/ark/src/dap/dap_state.rs` | Breakpoint state machine, file hashing, canonical-path index |
| `crates/ark/src/dap/dap_server.rs` | Handler/transport split, async evaluate, steps routed through the console |
| `crates/ark/src/console/console_debug.rs` | Stack capture, transient evals, frame filtering, condition/hit/log |
| `crates/ark/src/modules/positron/debug.R` | Frame construction, fallback matching when there is no srcref, `.ark_breakpoint`/`.ark_auto_step` |
| `crates/ark/src/console/console_repl.rs` | Browser handling in `read_console`, auto-step, command remapping, JIT toggle. **Closest match to Raven's console** |
| `crates/ark/src/console/console_filter.rs` | Capturing `debug at` output between WriteConsole and ReadConsole |
| `crates/ark/src/modules/positron/hooks_source.R` | `source()` override with a conservative fallback |
| `crates/ark/src/modules/positron/errors.R` | Exception and interrupt breakpoints via global handlers |
| `crates/ark/src/dap/dap_variables.rs` | Displaying SEXPs without forcing promises or active bindings |
| `crates/ark/src/srcref.rs` | Virtual-document URIs and namespace srcrefs |
| pkgload `R/source.R`, shiny `R/utils.R` | The external `.ark_annotate_source` contract |
| Positron `DapComm.ts`, `debugSchemas.ts` (Elastic-2.0, read only, do not copy) | The always-attached session, and the non-standard flags Positron needed |

---

## R: VSCode-R-Debugger / vscDebugger

**Status (checked 2026-10-29).** Both repos are active, not archived, and have no deprecation notice.
- **VSCode-R-Debugger:** MIT. Last commit 2026-10-28 ("Update R path resolution (#200)"). Releases: `v0.5.6` on 2025-11-27 and a rolling `latest` tag. 39 open issues.
- **vscDebugger:** MIT, version 0.5.9. Last commit 2026-10-04. Releases: `v0.5.9` on 2026-08-12 and `v0.5.8` on 2026-07-07. 12 open issues.
- Licence files: [VSCode-R-Debugger LICENSE.md](https://github.com/ManuelHentschel/VSCode-R-Debugger/blob/54fa5b404f8dbb550d6648d0831b56bc80eab01c/LICENSE.md) and [vscDebugger LICENSE.md](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/LICENSE.md).
- **SPDX: `MIT` for both.** The GitHub API reports `MIT` for both repos.
- Version and dependency facts: [DESCRIPTION](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/DESCRIPTION), [package.json L5](https://github.com/ManuelHentschel/VSCode-R-Debugger/blob/54fa5b404f8dbb550d6648d0831b56bc80eab01c/package.json#L5).

In the links below, `VD` means `https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479` and `VRD` means `https://github.com/ManuelHentschel/VSCode-R-Debugger/blob/54fa5b404f8dbb550d6648d0831b56bc80eab01c`.

### Architecture / process model
- **Launch mode: the extension spawns a separate R child process.** It runs R with `--quiet --no-save --interactive` (`--ess` on Windows) through `child.spawn(..., {shell:true})` ([VRD/src/utils.ts#L165-L169](https://github.com/ManuelHentschel/VSCode-R-Debugger/blob/54fa5b404f8dbb550d6648d0831b56bc80eab01c/src/utils.ts#L165-L169), [VRD/src/rSession.ts#L187-L203](https://github.com/ManuelHentschel/VSCode-R-Debugger/blob/54fa5b404f8dbb550d6648d0831b56bc80eab01c/src/rSession.ts#L187-L203)).
- **Two loopback TCP servers in the extension.** One carries DAP traffic and one is a "sink" socket for R output ([VRD/src/rSession.ts#L64-L100](https://github.com/ManuelHentschel/VSCode-R-Debugger/blob/54fa5b404f8dbb550d6648d0831b56bc80eab01c/src/rSession.ts#L64-L100)). It passes their ports to R ([VRD/src/debugRuntime.ts#L144-L155](https://github.com/ManuelHentschel/VSCode-R-Debugger/blob/54fa5b404f8dbb550d6648d0831b56bc80eab01c/src/debugRuntime.ts#L144-L155)).
- **R answers DAP only while it's at a prompt.** The extension scans R's stdout for the regex `/Browse\[\d+\]> /` or a custom top-level prompt string. When it sees one, it types `vscDebugger::.vsc.listenForDAP(timeout = -1)` into R's stdin ([VRD/src/debugRuntime.ts#L276-L300](https://github.com/ManuelHentschel/VSCode-R-Debugger/blob/54fa5b404f8dbb550d6648d0831b56bc80eab01c/src/debugRuntime.ts#L276-L300), [#L364-L399](https://github.com/ManuelHentschel/VSCode-R-Debugger/blob/54fa5b404f8dbb550d6648d0831b56bc80eab01c/src/debugRuntime.ts#L364-L399)).
  - That R function busy-polls a non-blocking `socketConnection` with `readChar` and `Sys.sleep(0.001)`. It parses `Content-Length` frames and dispatches DAP requests in R until a step or continue request sets `stopListeningOnPort` ([VD/R/communications.R#L2-L91](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/communications.R#L2-L91)).
  - **So the DAP server is written in R and runs inside the browser frame.** The TypeScript side is mostly a proxy plus a stdin writer.
- **Attach mode:** the user runs `.vsc.listen()`, which is an alias of `.vsc.listenForDAP` ([VD/R/communications.R#L96-L97](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/communications.R#L96-L97)). An optional server built on Tcl/Tk (R's `tcltk` package) also exists ([VD/R/tclServer.R](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/tclServer.R)).
- **Dependencies:** `jsonlite`, `R6`, `tcltk`, plus compiled C code ([VD/DESCRIPTION#L31-L34](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/DESCRIPTION#L31-L34)).
- **JIT:** launch calls `compiler::enableJIT(getOption('vsc.enableJIT', 0))`. The source comment says the JIT "messes with source info" ([VD/R/launch.R#L364-L365](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/launch.R#L364-L365)).

### How it stops
- **Breakpoints:** an injected `browser()` call.
- **Errors:** launch installs `options(error = .vsc.onError)` ([VD/R/launch.R#L370-L371](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/launch.R#L370-L371)).
  - The handler sends a DAP `stopped` event with reason `exception`, then calls `browser()` as its last statement ([VD/R/flow.R#L8-L44](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/flow.R#L8-L44)).
  - There are two exception filters, `fromFile` and `fromEval` ([VD/R/launch.R#L38-L50](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/launch.R#L38-L50)).
- **"Am I in the browser?"** is answered by calling `browserText()` and catching its error. The source notes that this "Does not work when called via `addTaskCallback()`" ([VD/R/utils.R#L55-L63](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/utils.R#L55-L63)). The R primitives section below explains why.

### Breakpoints
There are two mechanisms.
1. **For functions that already exist** ("Debug R-Function" mode, and packages):
   - `findLineNum(path, line, envir=env, lastenv=env)` locates the function and step.
   - `trace(what, tracer = quote({vscDebugger::.vsc.preBreakpoint(); browser()}), at = ..., where = env)` injects the stop. All breakpoints in one function go in a single `trace()` call, because tracing doesn't nest.
   - The extension then copies srcrefs onto the injected steps ([VD/R/breakpoints.R#L17-L20](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/breakpoints.R#L17-L20), [#L45-L74](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/breakpoints.R#L45-L74), [#L131-L159](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/breakpoints.R#L131-L159)).
   - `.vsc.preBreakpoint()` queues an `n` to be written to stdin and emits `stopped(breakpoint)`. That `n` moves past the `browser()` call to the user's statement ([VD/R/breakpointsHelpers.R#L4-L14](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/breakpointsHelpers.R#L4-L14)).
2. **For files** ("Debug R-File" and workspace modes), `.vsc.debugSource()` is a custom `source()`:
   - It calls `parse(keep.source=TRUE)`. Before each top-level expression it rewrites the body, replacing the target statement with `{ cat('Tracing debugSourceBreakpoint step XXX'); .vsc.preDebugSourceBreakpoint(); .doTrace(browser()); <stmt> }` and replicating srcrefs.
   - It evaluates each expression with `withVisible(eval(expr, envir))` ([VD/R/debugSource.R#L22-L84](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/debugSource.R#L22-L84), [#L136-L173](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/debugSource.R#L136-L173)).
   - When `overwriteSource` is enabled, `source` is masked by the `.vsc.*` versions. Rebuilding breakpoints after `load_all()` or `source()` is documented at [VD/R/overwrites.R#L242-L250](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/overwrites.R#L242-L250).
- **Packages:** breakpoints only land in packages named in `debuggedPackages`/`loadPackages`, or everywhere if `setBreakpointsInPackages` is on. Installed packages need `--with-keep.source` ([VD/vignettes/breakpoints.Rmd#L78-L100](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/vignettes/breakpoints.Rmd#L78-L100), [VD/R/breakpointsManagement.R#L64-L125](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/breakpointsManagement.R#L64-L125)).
- **Conditional breakpoints, logpoints and hit counts are not implemented.**
  - The request conversion ignores `condition`, `hitCondition` and `logMessage` ([VD/R/breakpointsManagement.R#L173-L188](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/breakpointsManagement.R#L173-L188)).
  - There is an open feature request: [VRD#190](https://github.com/ManuelHentschel/VSCode-R-Debugger/issues/190).
  - `supportsBreakpointLocationsRequest` is false ([VD/R/launch.R#L34](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/launch.R#L34)).

### Stepping
- `next`, `stepIn` and `stepOut` are implemented by writing the browser commands `n`, `s` and `f` to R's stdin through a custom `writeToStdin` event.
- `continue` writes `c`. `terminate` and `reverseContinue` write `Q` ([VD/R/flow.R#L113-L178](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/flow.R#L113-L178), [#L221-L243](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/flow.R#L221-L243), [VD/R/debugAdapter.R#L290-L297](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/debugAdapter.R#L290-L297)).
- The extension hides echoed `^[ncsfQ]$` lines from the output ([VRD/src/debugRuntime.ts#L286-L291](https://github.com/ManuelHentschel/VSCode-R-Debugger/blob/54fa5b404f8dbb550d6648d0831b56bc80eab01c/src/debugRuntime.ts#L286-L291)).
- There is no pause request for running code: [VRD#175](https://github.com/ManuelHentschel/VSCode-R-Debugger/issues/175).

### Variables / scopes / stack
- **Data model:** an R6 tree of stack, frame, scope and variable nodes ([VD/R/stackTree.R](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/stackTree.R)). Frames come from `sys.call()`/`sys.frame()`, with the debugger's own entry frames masked through `registerEntryFrame` ([VD/R/frameManagement.R](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/frameManagement.R)).
- **Paging:** each node reports `indexedVariables`/`namedVariables` and honours `start`/`count` ([VD/R/stackTree.R#L532-L557](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/stackTree.R#L532-L557), [#L637-L660](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/stackTree.R#L637-L660)).
- **Formatting is extensible.** A `varInfo` table holds entries such as `childVars`, `nChildVars`, `toString`, `type` and `printFunc`, and users can add their own with `.vsc.addVarInfo` ([VD/R/customVarInfo.R#L6-L35](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/customVarInfo.R#L6-L35), [VD/R/defaultVarInfo.R](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/defaultVarInfo.R)).
- **Promises are previewed without being forced**, through C code ([VD/src/promise.c#L3-L37](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/src/promise.c#L3-L37)).
  - Before R 4.6 it uses `PRVALUE`/`PRCODE`/`PRENV`.
  - On R ≥ 4.6 it uses the new API: `R_GetBindingType`, `R_DelayedBindingExpression` and `R_DelayedBindingEnvironment`.
- `setVariable` is supported ([VD/R/setVar.R](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/setVar.R)).

### Evaluate
- Code runs in `sys.frame(convertFrameId(frameId))`, or in `.GlobalEnv` when no browser is active.
- Watch expressions run with `tracingState(FALSE)` and errors caught, so a watch can't hit a breakpoint.
- `clipboard` context is refused ([VD/R/evaluate.R#L2-L60](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/evaluate.R#L2-L60), [#L147-L148](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/evaluate.R#L147-L148)).
- `supportsEvaluateForHovers` is false. Debug Console completions are supported ([VD/R/launch.R#L21-L28](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/launch.R#L21-L28)).

### Notable features
- Replacement `print`, `cat`, `message` and `str` that attach a source-file link to output ([VD/R/overwrites.R#L1-L80](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/overwrites.R#L1-L80)).
- A `load_all` wrapper that re-applies package breakpoints ([VD/R/launch.R#L310](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/R/launch.R#L310)).
- A data viewer and help panel. The README feature list is at [VRD/readme.md](https://github.com/ManuelHentschel/VSCode-R-Debugger/blob/54fa5b404f8dbb550d6648d0831b56bc80eab01c/readme.md).

### Known weaknesses
- **Breakpoints can't be added to the function that is currently executing.** Its body can't be modified mid-call, and the docs say the most reliable approach is to set breakpoints before launch ([VD/vignettes/breakpoints.Rmd#L19-L37](https://github.com/ManuelHentschel/vscDebugger/blob/db7d69f021591d7272ba615f0c61ea33524e6479/vignettes/breakpoints.Rmd#L19-L37)).
- **Fragile stdin/prompt-scraping protocol.** There are "ghost" sessions ([VRD#197](https://github.com/ManuelHentschel/VSCode-R-Debugger/issues/197)) and failures to break in attach mode ([VRD#193](https://github.com/ManuelHentschel/VSCode-R-Debugger/issues/193)).
- **Breakpoints missed in some workflows:**
  - `box` modules ([VRD#188](https://github.com/ManuelHentschel/VSCode-R-Debugger/issues/188))
  - `devtools::test`/testthat ([VRD#187](https://github.com/ManuelHentschel/VSCode-R-Debugger/issues/187))
  - `targets` ([VRD#151](https://github.com/ManuelHentschel/VSCode-R-Debugger/issues/151))
  - general misses ([VRD#165](https://github.com/ManuelHentschel/VSCode-R-Debugger/issues/165))
  - R Markdown ([VRD#153](https://github.com/ManuelHentschel/VSCode-R-Debugger/issues/153))
  - Shiny ([VRD#162](https://github.com/ManuelHentschel/VSCode-R-Debugger/issues/162))
- **The `skipCalls` argument of `browser()` is ignored** ([VRD#201](https://github.com/ManuelHentschel/VSCode-R-Debugger/issues/201)).
- **Can't step into base/compiled functions:**
  - `rowSums()` shows "Unknown Source" ([VRD#195](https://github.com/ManuelHentschel/VSCode-R-Debugger/issues/195))
  - [VRD#174](https://github.com/ManuelHentschel/VSCode-R-Debugger/issues/174)
- **Install and packaging pain:**
  - [VRD#189](https://github.com/ManuelHentschel/VSCode-R-Debugger/issues/189)
  - [VD#182](https://github.com/ManuelHentschel/vscDebugger/issues/182) (UCRT)
  - not on CRAN ([VD#187](https://github.com/ManuelHentschel/vscDebugger/issues/187))
- **Output overrides break testthat/tinytest output expectations** ([VD#196](https://github.com/ManuelHentschel/vscDebugger/issues/196)).
- **`.vsc.debugSource("")` hangs** ([VD#201](https://github.com/ManuelHentschel/vscDebugger/issues/201)).

### Top files to study
| Path | Why |
|---|---|
| `vscDebugger/R/breakpoints.R` | `findLineNum` + `trace(at=)` + srcref fix-up: the canonical way to set breakpoints in existing functions |
| `vscDebugger/R/debugSource.R` | A custom `source()` that rewrites each top-level expression to inject `browser()` while keeping srcrefs |
| `vscDebugger/R/flow.R` | Stepping by browser command, plus the `options(error=)` → `browser()` pattern for stopping on errors |
| `vscDebugger/R/communications.R` | A DAP server written in R, running inside the browser frame (the design to avoid in-process) |
| `vscDebugger/R/stackTree.R`, `R/customVarInfo.R` | Variable tree, paging, pluggable formatters |
| `vscDebugger/src/promise.c` | Inspecting promises without forcing them, on both sides of the R 4.6 API change |
| `VSCode-R-Debugger/src/debugRuntime.ts` | Prompt detection and the queue of text to write at each prompt |

---

## R: RStudio

**LICENSE.** RStudio is AGPL v3, with a commercial licence offered as an alternative.
- [COPYING](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/COPYING) says RStudio "is licensed to you under the AGPLv3" unless you hold a Posit commercial licence. Each source file's header says "version 3 of the GNU Affero General Public License" ([SessionBreakpoints.R#L1-L13](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/session/modules/SessionBreakpoints.R#L1-L13)).
- The GitHub API reports `NOASSERTION`.
- **SPDX: `AGPL-3.0-only`.** "Only" rather than "or-later" is my inference from the "version 3" wording; it is unverified. If Raven is under a different licence, **don't copy code; study the design only.**

In the links below, `RS` means `https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb`.

### Architecture
- **R is embedded in the `rsession` C++ process**, which installs R's console callbacks. That is the same model as Raven.
- **The console callback tracks browser state.** In `RReadConsole`:
  - **Detection:** it treats the session as browsing when the prompt matches `Browse\[\d+\]> ` and R's `hist == 1` flag is set (REPL prompts set it; `readline()`/`scan()` prompts don't), and skips continuation prompts.
  - **Capture trick:** on the first browse prompt it doesn't show the prompt to the user. Instead it returns `as.environment("tools:rstudio")$.rs.captureCurrentEnvironment()` as the input line. R evaluates that in the browser's environment, so `parent.frame()` is the environment being debugged, even while a promise is being forced. R then re-issues the prompt, which goes to the user ([RS/src/cpp/r/session/RStdCallbacks.cpp#L271-L345](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/r/session/RStdCallbacks.cpp#L271-L345), [RS/src/cpp/session/modules/SessionEnvironment.R#L1114-L1117](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/session/modules/SessionEnvironment.R#L1114-L1117)).
  - **Browse-active rule:** `isBrowseActive()` requires both a browse prompt and a captured environment. `R_GlobalEnv` counts as a valid captured environment, for top-level `debugSource` ([RS/src/cpp/r/session/RSession.cpp#L555-L572](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/r/session/RSession.cpp#L555-L572)).
- **Stepping:** the UI sends `n`, `s`, `f`, `c` and `Q` as console input ([RS/src/cpp/r/session/RStdCallbacks.cpp#L202-L206](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/r/session/RStdCallbacks.cpp#L202-L206)).

### Breakpoint mechanism
- **Function breakpoints:**
  - `.rs.setFunctionBreakpoints` unlocks the binding, then calls `trace(what, where, at = steps, tracer = browser, print = FALSE)`.
  - It then rewrites srcrefs in `@.Data`, because assigning to the public body would drop the trace. It also patches the registered S3 method table copy ([RS/src/cpp/session/modules/SessionBreakpoints.R#L280-L347](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/session/modules/SessionBreakpoints.R#L280-L347), `tracedSourceRefs` [#L164-L210](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/session/modules/SessionBreakpoints.R#L164-L210)).
  - Steps are computed from srcrefs by `getFunctionSteps`/`stepsAtLine` ([#L70-L265](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/session/modules/SessionBreakpoints.R#L70-L265)).
  - S7 methods get special handling ([#L664-L785](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/session/modules/SessionBreakpoints.R#L664-L785)).
- **Sync check.** `isFunctionInSync` compares the deparsed srcref text of the live, untraced function against the file's current lines ([#L414-L454](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/session/modules/SessionBreakpoints.R#L414-L454)).
  - If they don't match, the client keeps the breakpoint **inactive** "the next time the file is sourced or the package is rebuilt" ([RS/src/gwt/.../BreakpointManager.java#L195-L216](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/gwt/src/org/rstudio/studio/client/common/debugging/BreakpointManager.java#L195-L216)).
  - If the function is on the active call stack, setting is deferred ([#L177-L188](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/gwt/src/org/rstudio/studio/client/common/debugging/BreakpointManager.java#L177-L188)).
- **Top-level breakpoints and `debugSource`:**
  - The global `debugSource()` calls `.Call(rs_debugSourceFile)`, which calls `.rs.executeDebugSource` ([SessionBreakpoints.R#L601-L611](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/session/modules/SessionBreakpoints.R#L601-L611), [SessionBreakpoints.cpp#L434-L475](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/session/modules/SessionBreakpoints.cpp#L434-L475)).
  - That parses the file with `keep.source = TRUE` and builds a "source-equivalent" function whose body is the file ([#L552-L598](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/session/modules/SessionBreakpoints.R#L552-L598)).
  - It `trace()`s the breakpoint lines into that function, runs it, and then strips any `.doTrace(browser())` left in closures the file defined. It does the stripping in place in C, via `on.exit` ([#L456-L517](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/session/modules/SessionBreakpoints.R#L456-L517)).
  - The client spots `source('...')` in console input with a regex and replays the file's breakpoints ([BreakpointManager.java#L349-L354](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/gwt/src/org/rstudio/studio/client/common/debugging/BreakpointManager.java#L349-L354)).
  - An end-to-end test is titled "top-level breakpoint pauses when the file is sourced" ([RS/e2e/rstudio/tests/panes/debugger/debugger.test.ts#L90](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/e2e/rstudio/tests/panes/debugger/debugger.test.ts#L90)).
- **Shiny:** `registerShinyDebugHook` adds breakpoints to Shiny-stored functions ([#L614-L632](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/session/modules/SessionBreakpoints.R#L614-L632)).

### Call stack / environment pane while browsing
- **The stack is built at R level** by `.rs.callFrames` from `sys.calls()`, `sys.parents()`, `sys.function()` and `sys.frame()`, dropping its own frame.
  - The browser frame is matched by `identical(sys.frame(i), capturedBrowserEnv)`.
  - Frames whose function carries the `hideFromDebugger` attribute, and error handlers, are flagged ([RS/src/cpp/session/modules/SessionEnvironment.R#L1322-L1440](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/session/modules/SessionEnvironment.R#L1322-L1440), `getFunctionContext` [#L1126](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/session/modules/SessionEnvironment.R#L1126)).
- **The current line comes from R's evaluator position**, which R-level `sys.*()` can't see. C++ calls `R_GetCurrentSrcref(skip)` with `NA_INTEGER` on R ≥ 4.5 and `0` before ([RS/src/cpp/session/modules/environment/SessionEnvironment.cpp#L421-L436](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/session/modules/environment/SessionEnvironment.cpp#L421-L436), [#L1077-L1083](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/session/modules/environment/SessionEnvironment.cpp#L1077-L1083)).
  - It uses that value only if the frame's function has a srcref, is a primitive, or the environment is global (`canUseCurrentSrcref`, [SessionEnvironment.R#L1215-L1221](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/session/modules/SessionEnvironment.R#L1215-L1221)).
- **As a fallback it scrapes R's console output:** the regex `debug at ([^#]*+)#([^:]++): ` and the literal `Called from: ` ([SessionEnvironment.cpp#L1460-L1494](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/session/modules/environment/SessionEnvironment.cpp#L1460-L1494)).
- **Variables:** unevaluated promises are detected by binding type, not by forcing ([RS/src/cpp/session/modules/environment/EnvironmentUtils.cpp#L146-L149](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/session/modules/environment/EnvironmentUtils.cpp#L146-L149)).

### Debug-on-error and traceback
- **`setErrorManagementType` maps the error-handling modes onto `options(error=)`** ([RS/src/cpp/session/modules/SessionErrors.R#L271-L283](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/session/modules/SessionErrors.R#L271-L283)):
  - "message" sets `options(error = NULL)`.
  - "traceback" sets `.rs.recordUserTraceback` or `.rs.recordAnyTraceback`.
  - "break" sets `.rs.breakOnUserError` or `.rs.breakOnAnyError`.
  - The mode names come from code. The UI labels, including "Break in Code", are unverified.
- **`breakOnError`:**
  - With `userOnly`, it looks for a frame whose untraced function has a srcref with a srcfile, skipping `source()` frames.
  - It then evaluates `browser(skipCalls = …)` in `sys.frame(frame)`, one frame above a `stop`/`stopifnot` call ([#L189-L245](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/session/modules/SessionErrors.R#L189-L245)).
  - A code comment admits that a "magic value 2" frame offset is fragile.
- **Error output** goes through `globalCallingHandlers(error=, warning=, message=)`. It is installed *at R's top-level context*: "globalCallingHandlers() refuses to run with local condition handlers on the stack" ([RS/src/cpp/r/R/GlobalCallingHandlers.R#L63-L108](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/r/R/GlobalCallingHandlers.R#L63-L108)).
- **Traceback frames** come from `sys.status()`, cut at the global handler frame ([SessionErrors.R#L31-L68](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/cpp/session/modules/SessionErrors.R#L31-L68)).

### Known weaknesses
- **Breakpoints go stale when the live function doesn't match the file.** The breakpoint stays inactive until a re-source or rebuild (sync check above).
- **Package breakpoints are marked inactive on R restart** ([BreakpointManager.java#L476-L492](https://github.com/rstudio/rstudio/blob/46f72e0fec433e64ff9503c112d08858ab6e60bb/src/gwt/src/org/rstudio/studio/client/common/debugging/BreakpointManager.java#L476-L492)).
- **Breakpoints in executing functions are deferred** until the function returns.
- **Open issues:**
  - R6 methods: [rstudio#8390](https://github.com/rstudio/rstudio/issues/8390)
  - functions inside S4 methods: [#8153](https://github.com/rstudio/rstudio/issues/8153)
  - gutter glitch: [#8245](https://github.com/rstudio/rstudio/issues/8245)
  - `dump.frames()` entry: [#13811](https://github.com/rstudio/rstudio/issues/13811)
  - promise/NSE error in debugger: [#15461](https://github.com/rstudio/rstudio/issues/15461)
- **Source-call detection is a console-input regex.** It misses `sys.source()` and `source()` called from other code; this is my inference from the regex.

### Top files to study
| Path | Why |
|---|---|
| `src/cpp/session/modules/SessionBreakpoints.R` | `trace()` and srcref surgery, source-equivalent function for `debugSource`, sync check, S3/S7/Shiny cases |
| `src/cpp/r/session/RStdCallbacks.cpp` (L271-345) | Browse-prompt detection plus the injected environment-capture line (directly portable to Raven's `ReadConsole`) |
| `src/cpp/session/modules/SessionEnvironment.R` (`callFrames`, `getFunctionContext`) | Building the call stack from `sys.*` while browsing |
| `src/cpp/session/modules/environment/SessionEnvironment.cpp` | `R_GetCurrentSrcref` use and the `debug at` output-scraping fallback |
| `src/cpp/session/modules/SessionErrors.R`, `src/cpp/r/R/GlobalCallingHandlers.R` | Debug-on-error modes and installing global handlers in an embedded R |
| `src/gwt/.../common/debugging/BreakpointManager.java` | Breakpoint states (active, inactive, pending) and when they're re-applied |

---

## R primitives for debuggers

In the links below, `RSRC` means `https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2` (trunk on 2026-10-28; the latest commit there is "R_GetCurrentSrcref returns R_NilValue instead of C NULL (PR19222)").

| Primitive | What it gives a debugger | Caveats |
|---|---|---|
| `browser(text, condition, expr, skipCalls)` | Opens a nested REPL in the calling environment. `text`/`condition` exist "to allow helper programs (e.g., external debuggers) to insert specific values" so a debugger can tell which breakpoint fired ([browser.Rd#L9-L31](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/library/base/man/browser.Rd#L9-L31)). | `expr=FALSE` returns before anything else; documented as the "illusion" of conditional debugging ([#L33-L40](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/library/base/man/browser.Rd#L33-L40)). Only prints `Called from:` when `RDEBUG(rho)` is not already set ([main.c#L1482-L1503](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/main.c#L1482-L1503)). Errors if `_R_CHECK_BROWSER_NONINTERACTIVE_` is set in a non-interactive session ([#L1466-L1470](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/main.c#L1466-L1470)). |
| `do_browser` internals | Pushes a `CTXT_BROWSER` context, then a `CTXT_RESTART` context with a `"browser"` restart, then calls `R_ReplConsole`. That REPL calls **`R_ReadConsole` with the `"Browse[n]> "` prompt as a nested call** ([main.c#L1408-L1567](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/main.c#L1408-L1567), prompt [#L126-L144](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/main.c#L126-L144)). | The prompt text is not translated, but it is empty under `R_NoEcho` (`--no-echo`). There's a `browser.hook` option path behind `#ifdef USE_BROWSER_HOOK` ([#L1360-L1405](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/main.c#L1360-L1405)). I found no `#define` for it, so treat it as not built (unverified). |
| Browser commands `n s f c cont Q where help r`, empty line | Handled in `ParseBrowser` by setting the `RDEBUG` flag, `R_BrowserLastCommand` and `cntxt->browserfinish`; `Q` calls `jump_to_toplevel()` ([main.c#L1285-L1338](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/main.c#L1285-L1338); docs [browser.Rd#L47-L78](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/library/base/man/browser.Rd#L47-L78)). An empty line repeats `n` (or `s`) unless `browserNLdisabled` is set ([main.c#L236-L237](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/main.c#L236-L237)). | Commands are only recognised when they're a bare symbol. A user variable named `n` has to be typed as `(n)`. For byte-compiled functions stopped by a `browser()` call, "`n` is equivalent to `c`" ([browser.Rd#L60-L65](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/library/base/man/browser.Rd#L60-L65)). An expression evaluated at the prompt temporarily clears `RDEBUG`, so it isn't stepped (PR#15770/#18885, [main.c#L253-L258](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/main.c#L253-L258)). `R_BrowserLastCommand` is internal (`extern0`, hidden: [Defn.h#L1692](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/include/Defn.h#L1692)). |
| Step output: `debug at <file>#<line>: `, `debugging in:`, `exiting from:`, `Called from:` | The current location, printed by `SrcrefPrompt` ([eval.c#L1297-L1315](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/eval.c#L1297-L1315)), at closure entry ([#L2366-L2408](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/eval.c#L2366-L2408)) and per `{` step ([#L2991-L3003](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/eval.c#L2991-L3003)). | The `"%s at %s#%d: "` format is wrapped in `_()`, so it's **translated** (`LANGUAGE`/`Sys.setLanguage()`). `debugging in:` and `Called from:` are not. Don't build on scraping this output; prefer `R_GetCurrentSrcref`. |
| `debug` / `debugonce` / `undebug` / `isdebugged` / `debuggingState` | Sets the per-closure `RDEBUG` flag; each step opens a new browser context ([debug.Rd#L14-L18, L43-L74](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/library/base/man/debug.Rd#L43-L74)). Debugged closures run the AST, not bytecode ([eval.c#L2378-L2380](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/eval.c#L2378-L2380), [#L7515-L7517](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/eval.c#L7515-L7517)). | The flag is lost if the function is replaced. `signature=` (S4) uses `trace` instead. R 4.5 fixed S4-generic string `fun` (PR#18822/18824) ([NEWS.Rd#L2390-L2396](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/doc/NEWS.Rd#L2390-L2396)). |
| `trace(what, tracer, exit, at, print, signature, where, edit)` / `untrace` / `tracingState` | Builds a modified function that extends `"function"` and keeps the original. `at=` injects before body steps, and nested `list(c(3,4))` reaches inner steps. This is how both tools set line breakpoints ([trace.Rd#L23-L27, L100-L146](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/library/base/man/trace.Rd#L100-L146)). `tracingState(FALSE)` turns tracing off globally, which is useful during evaluate/watch. | `at=` requires a `{}` body. Tracing doesn't nest: each call **replaces** earlier tracing, so all of a function's breakpoints go in one call ([#L162-L167](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/library/base/man/trace.Rd#L162-L167)). Breaks if the function uses `on.exit(add=FALSE)` ([#L151-L160](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/library/base/man/trace.Rd#L151-L160)). Namespace and exported copies both need `where=`. Primitives are poorly supported ([#L178](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/library/base/man/trace.Rd#L178)). Already-running frames aren't affected. R-devel adds support for S7 multi-class functions ([NEWS.Rd#L247-L249](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/doc/NEWS.Rd#L247-L249)). |
| `findLineNum` / `setBreakpoint` (utils) | Maps file and line to `(function name, env, at)` using srcrefs; `setBreakpoint` wraps `trace` ([findLineNum.Rd#L8-L90](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/library/utils/man/findLineNum.Rd#L44-L90)). | Only scans **named** functions found by `lsf.str` in `envir` and its parents ([findLineNum.R#L100-L116](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/library/utils/R/findLineNum.R#L100-L116)). It won't find top-level script statements, anonymous functions, closures in lists (e.g. R6), or not-yet-sourced code; that's why both tools ship a custom `debugSource`. Matches on `basename` by default. S4 needs `lastenv = emptyenv()`. |
| srcref / `srcfile` / `getSrcref` / `getParseData` / `options(keep.source)` | Line and column mapping. Parse data gives a token table ([getParseData.Rd#L36-L42](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/library/utils/man/getParseData.Rd#L36-L42)). | `keep.source` defaults to `interactive()`, and `keep.source.pkgs` is FALSE unless `R_KEEP_PKG_SOURCE=yes` ([options.Rd#L213-L225](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/library/base/man/options.Rd#L213-L225)). Raven's embedded R must make sure it's TRUE. R 4.4 fixes: `withAutoprint` keeps srcrefs ([NEWS.Rd#L3336](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/doc/NEWS.Rd#L3336)); `getParseData(f)` works for the first package file ([#L3300](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/doc/NEWS.Rd#L3300)); `removeSource` is more thorough ([#L3395](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/doc/NEWS.Rd#L3395)). |
| `R_GetCurrentSrcref(skip)` (C) | The location the evaluator is currently at, which R-level `sys.*` can't see. `NA_INTEGER` checks the live position first, then walks outward ([errors.c#L2353-L2394](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/errors.c#L2353-L2394)). | **R 4.5 changed its semantics:** `skip` now counts calls, and `NA` means "search" ([NEWS.Rd#L2261-L2267](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/doc/NEWS.Rd#L2261-L2267), [#L2441-L2444](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/doc/NEWS.Rd#L2441-L2444)). It can return a *caller's* srcref when the stepped function has no srcrefs (see RStudio's `canUseCurrentSrcref`). PR19222 (trunk, newer than the NEWS entries I read) returns `R_NilValue` instead of C `NULL`. Which header declares it is unverified. |
| `sys.calls` / `sys.frames` / `sys.function` / `sys.call` / `sys.parents` / `parent.frame` / `sys.status` | Stack, environments and functions for the stack, scopes and variables views. `sys.call` attaches a srcref attribute from the context ([context.c#L463-L505](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/context.c#L463-L505)). | The `sys.*` contexts themselves aren't counted ([sys.parent.Rd#L72-L74](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/library/base/man/sys.parent.Rd#L72-L74)). Index from the debugger's own frame, as RStudio does with `sys.nframe() - 1`. The browsed environment can differ from every `sys.frame()` while a promise is being forced, hence RStudio's capture trick. |
| `browserText` / `browserCondition` / `browserSetDebug(n)` | Reads `text`/`condition` from the nth browser context; `browserSetDebug` arms the debug flag n functions up ([browserText.Rd#L19-L39](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/library/base/man/browserText.Rd#L19-L39)). | The context walk **stops at `R_ToplevelContext`** ([context.c#L555-L617](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/context.c#L555-L617)), so it errors under `R_ToplevelExec` or task callbacks. That matches vscDebugger's comment. |
| `R_ToplevelExec` (C; `R_tryEval` uses it) | A safe boundary for Raven's own R calls ([context.c#L783-L822](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/context.c#L783-L822), [#L876-L899](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/context.c#L876-L899)). | Starts a `CTXT_TOPLEVEL` linked to the current stack and **sets `R_HandlerStack`/`R_RestartStack` to NULL**. By my reading of the code (not tested at runtime), several things follow. `framedepth`/`R_sysframe`/`R_syscall` walk `nextcontext` until `NULL`, crossing `CTXT_TOPLEVEL` ([#L380-L461](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/context.c#L380-L461)), so **`sys.frames()` inside Raven's calls still shows the user's frames**. But `countContexts`, `browserText`, `getLexicalContext` and `jump_to_toplevel`/`Q` all stop at the *new* top-level context ([#L534-L548](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/context.c#L534-L548), [#L633-L644](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/context.c#L633-L644), [errors.c#L1086](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/errors.c#L1086)). The user's calling and global handlers aren't visible inside. It also restores `R_Visible`. |
| `R_ReplDLLdo1` / `Rf_ReplIteration` / `R_ReplConsole` | The top-level REPL step. The browser runs its own `R_ReplConsole` loop nested inside `eval` ([main.c#L203-L302](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/main.c#L203-L302), [#L304-L326](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/main.c#L304-L326), [#L355-L400](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/main.c#L355-L400)). | `R_ReplDLLdo1` always uses browse level 0 and `R_GlobalEnv` (source comment: "gets out of sync with" `Rf_ReplIteration`). Browse prompts reach Raven only as **re-entrant `ReadConsole` calls** from inside `do_browser`. `Rf_ReplIteration` is `attribute_hidden`. |
| `R_Visible` | Whether the last value should be auto-printed; reset before each REPL eval ([main.c#L260](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/main.c#L260)). | Declared in internal `Defn.h` ([#L1603](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/include/Defn.h#L1603)), not the API. For DAP `evaluate`, use `withVisible()` in R instead. |
| `options(error=)` | Runs **before unwinding**, while the failing frames are still on the stack, so `browser()`/`recover` work there ([errors.c#L1008-L1031](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/errors.c#L1008-L1031); [options.Rd#L174-L184](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/library/base/man/options.Rd#L174-L184)). This is the hook both tools use for break-on-error. | Not called for errors caught by `try`/`tryCatch`. By my code reading (not tested), errors inside Raven's `R_tryEval` calls also go through `jump_to_top_ex`, so they trigger a user-set `options(error=)` and overwrite `.Traceback` ([errors.c#L1066-L1086](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/errors.c#L1066-L1086)). Shield internal calls from this. |
| `options(warn=, browserNLdisabled=, deparse.max.lines=)` | `warn=2` turns warnings into errors, so a debugger can break on them ([options.Rd#L458-L470](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/library/base/man/options.Rd#L458-L470)). Set `browserNLdisabled=TRUE` so a stray newline isn't treated as `n` ([#L85-L86](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/library/base/man/options.Rd#L85-L86)). `deparse.max.lines` limits how much of a call is printed on entry ([#L136-L140](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/library/base/man/options.Rd#L136-L140)). | These are global options; save and restore the user's values. |
| `recover` / `dump.frames` / `debugger` | Post-mortem browsing of saved frames ([debugger.Rd#L16-L18, L89-L100](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/library/utils/man/debugger.Rd#L16-L18)). | Dumped frames are copies, not live frames; RStudio has a bug when the debugger is entered from `dump.frames()` ([#13811](https://github.com/rstudio/rstudio/issues/13811)). |
| `traceback` / `.Traceback` | Calls from the last uncaught error ([traceback.Rd#L36-L56](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/library/base/man/traceback.Rd#L36-L56)). | Errors caught by `try`/`tryCatch` don't set it. |
| `globalCallingHandlers()` (R ≥ 4.0) | A last-resort calling handler that runs *before* `options(error)`, with the stack still live ([conditions.Rd#L183-L201](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/library/base/man/conditions.Rd#L183-L201)). Good for break-on-condition for errors, warnings or custom classes. | `do_addGlobHands` errors if any local handlers are on the stack, and writes into **`R_ToplevelContext->handlerstack`** ([errors.c#L2621-L2648](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/main/errors.c#L2621-L2648)). If Raven calls it inside `R_ToplevelExec`, it lands on the temporary context and is lost when that context ends. Install it from the real REPL top level, as RStudio does. |
| `tryCatch` / `withCallingHandlers` vs browser | The browser establishes a `"browser"` restart. Errors typed at the prompt go back to the prompt, which also **stops error handlers set up before the breakpoint from running** ([browser.Rd#L101-L135](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/src/library/base/man/browser.Rd#L101-L135)). | Warning and other handlers can still transfer control out of the browser. The stepped frame may sit inside a `doTryCatch` promise. |
| R 4.4 / 4.5 / 4.6 / devel changes | 4.4: the browser prompt level now counts only browser contexts ([NEWS.Rd#L3351-L3352](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/doc/NEWS.Rd#L3351-L3352)). 4.5: `R_GetCurrentSrcref` semantics changed (above); `RDEBUG`/`SET_RDEBUG` are now flagged as non-API ([#L2232-L2243](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/doc/NEWS.Rd#L2232-L2243)). 4.6: `if(TRUE)` no longer adds a browser level (PR#18885, [#L1306-L1309](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/doc/NEWS.Rd#L1306-L1309)); new binding API `R_GetBindingType` / `R_DelayedBindingExpression` / `R_DotsElt`… for inspecting promises without forcing them; `PRCODE`/`PRVALUE`/`PRENV` uses become check WARNINGs ([#L1199-L1225](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/doc/NEWS.Rd#L1199-L1225)). Devel: `objectNotFoundError`/`functionNotFoundError` condition classes ([#L52-L58](https://github.com/wch/r-source/blob/8d4f968b7b17f4517ec74260059bb320b21ebac2/doc/NEWS.Rd#L52-L58)), useful for exception filters. | For promise inspection, use the 4.6 binding API, falling back below 4.6 as vscDebugger's `promise.c` does. Don't use `RDEBUG`; drive stepping with browser commands, or `debug()`/`browserSetDebug()`. |

---

## Lessons for Raven

These are recommendations synthesized from the sections above. Anything stated about Raven's own code was checked against `crates/raven/src/console/mod.rs` and `shim.c`.

### Best ideas to adopt

1. **Serve DAP from inside `raven console`, with one thread, called "R console".**
   - Ark, DebugAdapter.jl, and RStudio all keep the debugger in the process that owns R. Raven already has the pieces: a socket thread that never touches R, and a main thread that owns R.
   - Requests that need R (stackTrace, scopes, variables, evaluate, setVariable) are queued to the main thread and serviced inside `read_console` while R sits at `Browse[n]>`. That is the same pattern as pydevd's internal-command loop on the paused thread, and ark's `r_task`/`send_idle_any_prompt`.
   - Transport options:
     - a second socket served by the console, where the extension returns `DebugAdapterNamedPipeServer` (as julia-vscode does);
     - multiplex DAP onto the existing IPC socket, which today is request/response only, so it would need server-pushed events for `stopped`, `output`, and `breakpoint`.
2. **Know which file and line the code came from, then inject breakpoints before parsing (ark's model).**
   - Raven's console already receives "run line/selection/source file/run chunk" from the editor, so it can carry a `code_location` the way Positron does.
   - Inject `browser()` plus `#line` and verify calls into the source text.
   - Bind a `.ark_annotate_source`-compatible function so pkgload ≥ 1.5 and shiny ≥ 1.13 cooperate for free. That means impersonating ark's API name; decide this deliberately, and consider asking r-lib for a neutral hook name.
3. **Add live-function breakpoints via `trace(at=)` as a second mechanism.**
   - Ark's top open gap is "no dynamic breakpoints" ([positron#15355](https://github.com/posit-dev/positron/issues/15355)), which RStudio and vscDebugger handle with `findLineNum` plus one `trace()` per function.
   - Use it only when the live function's srcref text matches the buffer (RStudio's `isFunctionInSync`). Otherwise leave the breakpoint unverified with a reason.
4. **Report breakpoint verification honestly, with concrete reasons.**
   - Use states like ark's Unverified/Verified/Invalid/Disabled. Set `message` to things like "file not sourced since edit", "no expression on this line", or "path mismatch".
   - js-debug's bare "Unbound breakpoint" is its most-reported problem, and Julia's always-`verified:true` hides real failures.
   - Send later binding as `breakpoint` events with `reason:'changed'`.
5. **Use Raven's static knowledge, which nobody else has in-process.**
   - Answer `breakpointLocations` from tree-sitter, so breakpoints snap to expressions and `}` is rejected up front.
   - Predict where breakpoints will bind from the cross-file `source()` graph. This is the analogue of js-debug's `BreakpointsPredictor`.
   - Serve debug-console completions from the LSP engine.
   - Detect buffer/srcref drift from document versions.
6. **Get the location from R APIs, not by scraping text.**
   - `R_GetCurrentSrcref(NA_INTEGER)` on R ≥ 4.5 (semantics changed in 4.5, and trunk now returns `R_NilValue` rather than C NULL). The `debug at %s#%d` prefix is translated by `_()`.
   - Keep ark's no-srcref fallback: deparse, reparse, text-match, and publish a virtual source via `sourceReference` or a Raven URI scheme.
   - Use RStudio's trick of feeding a one-line capture call at the first `Browse>` to pin down the environment being browsed. This also works while R is forcing a promise.
7. **Implement stepping as browser commands typed into R's own REPL.**
   - `n`/`s`/`f`/`c`/`Q`, echoed so the console stays consistent (ark routes them through the frontend).
   - Set `options(browserNLdisabled=TRUE)` while debugging.
   - Disable the JIT around `s`.
   - Rewrite `n` to `f` after an exception or pause stop.
   - Auto-step through injected helpers.
   - Smart-step out of frames that have no srcref or belong to skipped packages, with a cutoff (js-debug stops after 256 steps).
8. **Implement exception filters with `globalCallingHandlers`, appended so user handlers run first.**
   - Filters: `error`, `warning`, `interrupt`, plus devel R's `objectNotFoundError` classes as candidates.
   - Pause works as SIGINT → interrupt handler → `browser()`.
9. **Make variables safe by construction.**
   - Never force promises or active bindings. Mark them `presentationHint.lazy`, and use R 4.6's `R_GetBindingType`/`R_DelayedBindingExpression`, falling back for older R like vscDebugger's `promise.c`.
   - Bound every `format`/`print` call by size and time, and catch errors so they render as placeholders (pydevd `SafeRepr`, Julia `sprintlimited`).
   - Implement real `indexedVariables` with start/count paging, which ark lacks.
   - Mark global and package environments `expensive`.
   - Send `invalidated` after a console eval at `Browse>` that leaves the stack unchanged (ark's transient-eval logic).
10. **Evaluate in the selected frame's environment, with a timeout.**
    - Evaluate in the selected frame's environment, and run watch/hover with `tracingState(FALSE)` so they cannot hit breakpoints.
    - Use a hover budget around 500 ms, and use `withVisible` instead of internal `R_Visible`.

### Pitfalls to avoid

- **`R_ToplevelExec` boundaries.**
  - Raven runs every R call it initiates under `R_ToplevelExec`. Inside that context, `browserText()`/`browserCondition()`, the browser-level count, and `Q`/`jump_to_toplevel` all stop at the new top-level context.
  - User calling handlers are not visible there.
  - `globalCallingHandlers()` writes to `R_ToplevelContext->handlerstack`, so calling it from inside `R_ToplevelExec` installs the handler on a temporary context that is then discarded.
  - `sys.calls()`/`sys.frames()` do still see the user's frames.
  - So: install global handlers from the real REPL top level (e.g., a hidden input line at the first top-level prompt, or as part of startup code R itself evaluates). Never ask for browser context from inside a shim call.
  - This comes from reading `context.c`/`errors.c`; it has not been tested at runtime.
- **The user's `options(error=)` can fire inside Raven's internal calls.** Errors inside `R_tryEval`/`R_ToplevelExec` still go through `jump_to_top_ex`, so they can trigger `options(error=)` and overwrite `.Traceback`. Shield internal calls (inferred from code, not tested).
- **Never hold a Rust lock across an R evaluation** ([positron#5024](https://github.com/posit-dev/positron/issues/5024)). A longjmp skips `Drop`. `shim.c` already keeps longjmps out of Rust frames; keep DAP state locks off the R-calling path entirely.
- **Raven's own use of base R is exposed to the user's `debug()`.** If the user debugs a base function the console uses internally, the console breaks ([ark#1402](https://github.com/posit-dev/ark/issues/1402), [ark#1056](https://github.com/posit-dev/ark/issues/1056)). Auto-continue on unexpected browser prompts that come from Raven's own calls, or avoid calling R-level functions there.
- **Driving the debugger by scraping stdin/stdout is fragile** (vscDebugger's ghost sessions and missed breaks). Raven owns `ReadConsole`/`WriteConsoleEx`, so use structured state instead.
- **Breakpoints go stale silently.** Clear or downgrade them on edit (ark drops all of a file's breakpoints on `didChange`; RStudio keeps them "inactive until re-sourced"). Don't bind to line numbers that are out of date.
- **Global options and leftover hooks.** Save and restore `options(error, warn, browserNLdisabled)` and the JIT level. On disconnect, untrace everything and remove handlers (compare js-debug [#2344](https://github.com/microsoft/vscode-js-debug/issues/2344)).
- **Ordering races.** Send the `stopped` event only after the step response has gone out, and send `breakpoint` changed events only for breakpoints that still exist (js-debug).
- **Top-level expressions.** `trace(at=)` needs a `{}` body and does not nest. `findLineNum` cannot see top-level script statements or anonymous functions. Any `source()`/run-file path therefore needs the injection approach (ark, vscDebugger `debugSource`, RStudio `debugSource`).
- **Stock VS Code lacks Positron's debugger extensions** (`sendBreakpointsOnAllSaves`, `verifyBreakpointsInDirtyDocuments`, `supportsFrameSelection`). Raven needs extension-side workarounds, e.g. listen to `onDidSaveTextDocument` and `debug.onDidChangeActiveStackItem`.
- **Windows port.** Avoid baking in Unix-only assumptions such as SIGINT for pause or Unix-socket paths. julia-vscode's named-pipe name fallback is a useful reference.

### License compatibility

Raven is **GPL-3.0**. The [LICENSE](../../../LICENSE) file is the GPLv3 text, and `Cargo.toml` and `editors/vscode/package.json` both say `"GPL-3.0"`. That is a deprecated SPDX id, and the manifests don't say whether it means `-only` or `-or-later` (unverified).

| Project | SPDX | Can Raven copy or adapt its code? |
|---|---|---|
| vscode-js-debug | MIT | Yes. Keep the copyright notice and license text |
| debugpy (adapter, launcher) | MIT | Yes, with notice |
| pydevd | EPL-1.0 | **No.** The FSF lists EPL-1.0 as GPL-incompatible. Study only |
| DebugAdapter.jl, JuliaInterpreter.jl, Debugger.jl, julia-vscode | MIT | Yes, with notice |
| ark (+ harp, amalthea) | MIT | Yes, with notice. This is the most directly reusable code (Rust, R helpers) |
| dap-rs (`dap` crate) | MIT (possibly also Apache-2.0, unverified) | Yes as a dependency. Apache-2.0 is compatible with GPLv3 |
| Positron (`positron-r`, `positron-supervisor`, debug schema) | Elastic-2.0 | **No.** Not an open-source license and not GPL-compatible. Read for design only |
| VSCode-R-Debugger, vscDebugger | MIT | Yes, with notice |
| RStudio | AGPL-3.0 (unverified whether `-only`) | Avoid copying. GPLv3 §13 permits combining with AGPLv3 code, but the copied part stays under AGPL network terms. Design reference only |
| pkgload, shiny | MIT | Raven calls into them at runtime rather than copying code. No issue |
| R (libR, loaded via dlopen) | GPL-2 \| GPL-3 | Compatible. Raven already embeds it |

Attribution practice: when adapting MIT code, keep the upstream copyright line in a header comment on the adapted file, cite the upstream path and commit, and keep the upstream license text with Raven's third-party notices. Where Raven keeps those notices was not checked.
