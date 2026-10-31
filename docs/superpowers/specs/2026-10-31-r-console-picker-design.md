# Ask which R console to send code to

Status: approved plan (three review rounds with Terra and Sonnet).

## Problem

Where Raven's send-code commands go is decided by two settings and a rule that's hard to explain:

- `raven.rConsole.activation` = `"auto"` (default) turns off Raven's R console, its send commands, its viewers, and its chunk surfaces whenever the vscode-R (REditorSupport) extension is installed, or the host is Positron. A one-time notification explains this.
- `raven.rTerminal.program` (`raven` default, `R`, `arf`, `radian`) picks the program for Raven's managed R terminal.

Users who have vscode-R installed silently get no Raven console. Users who want arf or radian have to know the setting exists.

## Goal

When the user sends code (Run Line or Selection, chunk runs, Source File, the inspect commands, build commands) and hasn't chosen a console, Raven shows a VS Code quick pick of the consoles it can send to. The user picks one for this session or for all sessions.

Also (user request): the terminal running Raven's console is named `R`, not `R (Raven)`.

## Design

### 1. Setting

`raven.rTerminal.program` gains two values and a new default:

| Value | Meaning |
|---|---|
| `ask` (new default) | Show the console picker on the first send of each session. |
| `raven` | Raven's R console. |
| `R` | Plain R. |
| `arf` | arf. |
| `radian` | radian. |
| `vscode-R` (new) | Send code to vscode-R's R terminal. |

Explicit non-`ask` values keep today's behavior: no picker.

Vocabulary used below: a **target** is one of `raven | R | arf | radian | vscode-R`. A **terminal program** is a target other than `vscode-R`.

### 2. The effective target

```
effective_target() = session_choice ?? (setting === 'ask' ? undefined : setting)
```

The session choice (in memory, per window) wins over the setting, so **Raven: Choose R Console** can override an explicit setting for one session. `undefined` means "ask".

When `raven.rTerminal.program` changes, the listener clears the session choice unless it equals the new user-level value (`inspect().globalValue`) or the new effective value. The picker's own "All sessions" write sets the Global layer to the session choice, so the choice survives whenever the change event arrives, even when a workspace value overrides the Global one; no own-write flag (which would race the event) is needed. An outside edit that changes both to something else clears it, so the setting takes effect. A workspace-only edit while a user-level value equals the choice doesn't clear it: the session choice beats the setting by design, and **Raven: Choose R Console** switches mid-session. The listener no longer clears tracked terminals (§4): a choice selects terminals by program, so they stay valid across setting changes.

### 3. The picker

New module `editors/vscode/src/send-to-r/console-picker.ts`, `pick_console({ include_vscode_r }): Promise<{ target, scope } | undefined>`.

Step 1, a `QuickPick` titled "Send R code to". It opens immediately with the items known so far and `busy = true` while detection runs; detected items are appended when detection finishes.

| Item | Shown when | Detail line |
|---|---|---|
| Raven's R console | always | Completions, debugger, and syntax coloring |
| R command line | always | The standard R console |
| arf | detected | Third-party Rust R console |
| radian | detected | Third-party Python R console |
| vscode-R | `REditorSupport.r` installed, and `include_vscode_r` | Send code to vscode-R's R terminal |

Step 2, a `QuickPick` titled "Use <choice> for": **This session** / **All sessions**. "All sessions" writes `raven.rTerminal.program` at `ConfigurationTarget.Global`. If `inspect()` shows a workspace or workspace-folder value, Raven also shows a warning that this workspace's setting overrides it in other sessions (the session choice still applies now). Escape at either step returns `undefined`.

Detection (`detect_consoles()`): run once per session, lazily on first picker open, memoized as a promise. Not the persistent `programValidated.*` cache, so uninstalling is noticed next session.
- macOS/Linux: one interactive-login-shell call, `command -v arf; command -v radian; true`. A program counts as detected only if a line is an absolute path whose last component is its name; that labels each result, ignores rc-file noise, and rejects aliases and shell functions (which print a definition or bare name), since the terminal launches the program directly. (Implementation note: an earlier draft used a `for … do` loop printing markers; that syntax fails in fish login shells, so the shell-agnostic form above replaced it.) 5 s timeout; timeout = neither detected. The parser is a pure function, unit-tested for each program alone, both, neither, and alias output.
- Windows: `where.exe arf` and `where.exe radian` (exit status), in parallel.

A console picked from the picker skips the existing "not found in PATH, switch to R?" prompt; that prompt stays for explicit settings.

Single flight: at most one picker is open. A caller that arrives while one is open awaits it, then re-runs resolution (§4) from the top against the updated session choice instead of taking the result directly. So a profile request that joins a send's picker and sees `vscode-R` chosen then finds that `effective_target()` isn't a terminal program and opens its own terminal-only picker; a send that joins a profile picker uses the terminal program it picked. Tested in both arrival orders.

**Raven: Choose R Console** (`raven.chooseRConsole`, palette entry gated on `raven.rConsoleEnabled`) opens the picker and sets the choice. Existing terminals keep running; see §4 for which terminal the next send uses.

### 4. Terminal tracking and resolution

The manager tracks each managed terminal's target: `managed_terminals: Map<vscode.Terminal, TerminalProgram>` (replaces `profile_terminals`), and `last_active_terminal` becomes "most recently active managed terminal" as today.

```ts
type SendTarget =
    | { kind: 'terminal'; terminal: vscode.Terminal }
    | { kind: 'vscode-r' };

/** null = the user cancelled the picker. */
async function resolve_send_target(): Promise<SendTarget | null>;
```

1. `t = effective_target()`.
2. If `t` is undefined:
   - if a live managed terminal exists (opened from the profile dropdown or by the debugger before any choice): use the most recent one. No picker; the user already chose a console by opening it.
   - otherwise open the picker (with vscode-R). Cancel → `null`. Else set the session choice (and setting if "All sessions"); `t` = the pick.
3. `t === 'vscode-R'` → `{ kind: 'vscode-r' }`.
4. Otherwise reuse the most recently active managed terminal whose tracked program is `t`; if none, create one with program `t` (existing `create_r_terminal`, through the `creation_in_flight` guard keyed by program).

`_dispose_cached_r_terminal_for_test` clears `managed_terminals` as it cleared `profile_terminals`. A choice is authoritative: a terminal running a different program is never selected implicitly, even if it was active more recently.

Stale creation: (implementation note) no generation counter is needed. Terminals are selected by the program they run, never by a single "slot", so a terminal whose creation finishes after the choice changed is tracked with its own program and is only reused when that program is chosen again.

Ordering: sends are serialized through a module-level promise chain (`enqueue_send`), so a send issued while the picker is open runs after the first, in invocation order, against the same resolved target.

### 5. Delivery to vscode-R

`await getExtension('REditorSupport.r')?.activate()` (its commands register only after activation), then `executeCommand('r.runCommand', code)`. vscode-R's `runCommand(rCommand)` sends the text to its R terminal (creating one if needed); it's the command behind vscode-R's documented custom keybindings (`"command": "r.runCommand", "args": "..."`), so it exists in all current versions. Verified in vscode-R's `src/rTerminal.ts`: `runCommand(rCommand)` is `await runTextInTerm(rCommand)`, which creates or chooses vscode-R's terminal and sends multi-line text with bracketed paste or line by line per `r.bracketedPaste`.

`raven.sendToR.sendMethod` doesn't apply to vscode-R; vscode-R's own `r.bracketedPaste` setting does. Source File sends `source("<path>", echo = TRUE)` as today. If the command is missing (vscode-R uninstalled mid-session), Raven shows an error with a **Choose R Console** button.

### 6. Callers

| Caller | Change |
|---|---|
| `send-to-r/commands.ts` `handle_send` | `resolve_send_target`; route; advance the cursor only after a delivery. |
| `chunks/chunk-commands.ts` `send_to_r` (managed target) | Same. Returns `boolean` (delivered). The `previousAndMove`, `nextAndMove`, `currentAndMove` paths move only when it returns `true`. Multi-chunk modes already send one combined block, so cancel aborts all of it. The `active` target (Terminal submenu) is unchanged. |
| `send-to-r/inspect-commands.ts` | Same. |
| `build-commands.ts` `run_simple('r-console')` | Same. |
| `build-commands.ts` Install and Restart | Same for terminal targets. With vscode-R, Raven can't restart vscode-R's session, so it sends only `devtools::install(<pkg>)` (no `quit()`) and shows "Sent devtools::install() to vscode-R's terminal. When it finishes, restart R there to load the new version." (the terminal API can't observe completion, so the message makes no success claim) The docs say so. |
| `build-commands.ts` package-tasks terminal | `resolve_terminal_program()` (below), never prompts. Its config listener (`build-commands.ts:235`) drops the tasks terminal only when `resolve_terminal_program()` changes, not on every write to the setting. |
| debugger `choose_console` | New `get_or_create_raven_console()`: reuse a live managed terminal that has a console socket (`console_socket_of`), else create a Raven console. It joins `managed_terminals` as `raven` but doesn't change the session choice. Update the error text at `debugger/index.ts:402`, which names `program = "raven"`. |
| data viewer Re-run | The panel stores the `sessionId` from its `ViewDataEvent`, and `replace()` updates it together with the data and expression on every successful replacement (the manager reuses a panel by name, so a later `View()` from another session takes the panel over). Re-run sends to the managed terminal with that session id (new lookup: walk `managed_terminals` and compare `terminal_to_session_id.get(t)`; the WeakMap itself can't be iterated). If that terminal has closed: "The R session that opened this view has ended. Run View() again." |
| extension API `sendToRTerminal` (test hook) | `get_or_create_r_terminal()` with no picker: most recent managed terminal, else create with `resolve_terminal_program()`. |
| terminal profile provider (dropdown "R") | Program = `effective_target()` if it's a terminal program; else the picker without the vscode-R item; cancel throws `CancellationError`. A pick here sets the session choice like any other pick. |

`resolve_terminal_program()` = `effective_target()` if it's a terminal program, else `raven`.

### 7. Terminal names and profile association

Names: `R` for Raven's console, `R (plain)` for plain R, `arf`, `radian`. The package-tasks terminal keeps `R: Package Tasks`.

The name is no longer identity. The FIFO queues (`pending_profile_creation_count`, `pending_profile_session_ids`, `pending_profile_sockets`) are replaced by one map of pending entries keyed by id. Every Raven-launched terminal gets an env var `RAVEN_TERMINAL_ID=<uuid>`. Each pending profile entry carries its id (plus socket, session id, program). `handle_terminal_opened` matches `terminal.creationOptions.env?.RAVEN_TERMINAL_ID` against the pending entries and ignores terminals without a matching id, so an unrelated terminal named `R` is never claimed, and overlapping profile launches with different programs associate correctly. VS Code passes the profile's launch config, including `env`, to the extension host's `$acceptTerminalOpened`, so `creationOptions.env` is present for profile-provided terminals. Implementation verifies this first in the test host; there is no name-based fallback. If verification fails, the fallback carries the id in `creationOptions.shellArgs` instead, which is unique per launch: Raven's console already gets a per-launch `--ipc <socket>` path, and plain R gets `--args raven-terminal-id=<uuid>` (R ignores everything after `--args`). arf and radian profile launches would then go unassociated (no plot session id), which is documented; no name-based matching either way. Tests: an unrelated terminal named `R` opened while a profile launch is pending isn't claimed; two overlapping profile launches (different programs) opening in reverse order each get their own socket and session id.

### 8. Activation (`raven.rConsole.activation`)

`auto` no longer steps aside for vscode-R; it still steps aside in Positron, which has its own console. Remove `AutoDisableReason 'reditorsupport'`, its notice text, and the vscode-R branch of `registerActivationReactivity`'s `extensions.onDidChange` listener (dead once vscode-R doesn't affect resolution). Update the `knit-commands.ts` and `quarto-commands.ts` strings that blame REditorSupport.

Coexistence with vscode-R's `Cmd+Enter`: both extensions bind `Cmd+Enter` (`Ctrl+Enter`) in R files, and VS Code's choice between two extensions' bindings isn't something either can control. The docs say so plainly: if vscode-R's binding wins, `Cmd+Enter` goes to vscode-R's terminal without the picker; Raven's commands (Run menu ▶, CodeLens, palette) still ask. To make `Cmd+Enter` run Raven's command, add a user keybinding (given in the docs; user keybindings beat extension ones). A one-time notice, shown once (globalState key) at activation when vscode-R is installed and the `raven.rConsole.activation` setting is `auto`, says: "Raven's R console now runs alongside vscode-R. When you send code, Raven asks which console to use." Buttons: **Learn more**, **Don't show again**.

Raven's plot and data viewers hook only terminals Raven launches (through the R profile it passes in their environment), so `plot()` and `View()` in vscode-R's terminal still go to vscode-R's viewers; the docs say so. Chunk CodeLens rows from both extensions appear in `.Rmd`; documented, with `raven.chunks.codeLens.commands: []` to hide Raven's.

### 9. Docs and manifest

- `docs/r-console.md`: "Open the console" and "Choose a console" rewritten around the picker; setting table with `ask` and `vscode-R`; Raven: Choose R Console; drop the vscode-R note.
- `docs/coexistence.md`: table, "Why Raven's console stepped aside" (Positron only now), the activation table, the Cmd+Enter section with the user keybinding, the Quarto section's vscode-R wording.
- `docs/debugger.md:15`, `docs/comparison.md:93`, `docs/r-package-dev.md`, README: wording that assumes the default is `raven`.
- `package.json`: enum, enumDescriptions, description, default; descriptions that say "(raven.rTerminal.program = 'raven')" for `raven.console.editMode`, `raven.console.colorOutput`, `raven.debugger.enabled` reworded to "Raven's R console"; `raven.rConsole.activation` description and enum text; the new command and its palette entry. Regenerate `docs/settings-reference.md`.
- `extension.ts:404` comment.
- Docs tests in `tests/bun/docs` that cover these pages.

### 10. Tests

VS Code suite (`src/test/send-to-r/`), with a picker test seam (`_set_picker_for_test`) and a detection seam:
- effective-target order: session choice beats explicit setting; explicit setting skips picker; `ask` + live terminal reuses it; `ask` + nothing opens picker.
- cancel: no send, cursor unchanged, including all three `*AndMove` chunk commands.
- "All sessions" writes Global and keeps the session choice, including when the change event is fired after `update` resolves and when a workspace value overrides the Global one; an outside change to a different value clears the session choice.
- a choice never routes to a terminal with a different program.
- concurrent first sends open one picker and deliver in order.
- vscode-R routing: register a fake `r.runCommand` in the test and assert the code string.
- debugger console: with each non-Raven choice, `get_or_create_raven_console` returns a socketed terminal.
- profile association: an unrelated terminal named `R` isn't claimed.
- data viewer Re-run goes to the originating session's terminal, follows the session of a same-name `View()` from a second session, and reports a closed one.
- detection marker parser (alone/both/neither/alias); Install and Restart with vscode-R sends no `quit()`.
- Existing suites that assume the default was `raven` set `raven.rTerminal.program` to `raven` explicitly (chunks, debugger, data viewer, build commands, `sendToRTerminal` users). `chunks.test.ts:175` terminal name updated.
- Settings mapping / settings reference drift tests.

### Out of scope

- Positron's console as a picker item.
- Detecting other R consoles.
- Making Raven's `Cmd+Enter` win over vscode-R's automatically.
