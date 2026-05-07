# Design: `raven.sendToR.sendMethod` setting

**Date:** 2026-05-07
**Status:** Approved, ready for implementation

## Overview

Add a `raven.sendToR.sendMethod` setting that lets users control whether Raven sends code to R via direct paste, bracketed paste, or a temp file. The default (`auto`) preserves current behavior.

## Background

Raven currently uses two different mechanisms depending on the code being sent:

- **Single-line code** → `terminal.sendText()` (direct paste)
- **Multi-line code** → writes to a temp file, then `source()`s it

The tempfile path exists because pasting multi-line code over stdin can silently drop or corrupt lines — terminals deliver characters faster than R's readline can consume them. This affects the standard R console as well as arf and radian. `source(echo = TRUE)` also produces cleaner, more predictable output than a raw paste.

REditorSupport pastes directly for all code. Users migrating from it may be surprised by the tempfile behavior, or may have specific reasons to prefer one mode.

## Setting spec

**Name:** `raven.sendToR.sendMethod`
**Type:** enum
**Default:** `"auto"`

| Value | Single-line behavior | Multi-line behavior |
|-------|---------------------|---------------------|
| `"auto"` | `terminal.sendText()` | temp file + `source(echo = TRUE)` |
| `"paste"` | `terminal.sendText()` | bracketed paste (`\x1b[200~`...`\x1b[201~`) |
| `"tempfile"` | temp file + `source(echo = TRUE)` | temp file + `source(echo = TRUE)` |

**Scope:** applies to both the Raven-managed terminal (`handle_send`) and the Terminal submenu (`handle_terminal_send`). The `sourceFile` command — which runs `source()` against the document's saved path — is unaffected in all modes.

## Settings UI description (package.json)

> Controls how Raven sends code to R. `auto` (default) pastes single-line code directly and uses a temp file for multi-line blocks. `paste` always pastes, using bracketed paste mode for multi-line code. `tempfile` always writes to a temp file and runs `source()`.

## User-facing docs (docs/send-to-r.md)

### Configuration table

Add to the Configuration Options table:

| `raven.sendToR.sendMethod` | enum | `"auto"` | How code is sent to R: `"auto"`, `"paste"`, or `"tempfile"` |

### New subsection: "Send Method"

Insert after the existing "Cursor Advancement" subsection.

---

By default (`auto`), Raven pastes single-line code directly and writes multi-line code to a temporary file, executing it with `source()`. Override this with `raven.sendToR.sendMethod`:

- **`paste`** — always pastes. For multi-line code, uses bracketed paste mode to deliver the block as a single unit.
- **`tempfile`** — always writes to a temp file and runs `source()`. Use this for maximum consistency, or when even single-line paste is unreliable.

**Why Raven defaults to temp files for multi-line code**

When multi-line code is pasted, the terminal delivers characters to R's stdin faster than readline can process them, which can silently drop or corrupt lines. This affects the standard R console as well as arf and radian. Writing to a temp file sidesteps this entirely: R reads from disk rather than stdin, so there is no buffering race, no size limit, and no sensitivity to connection speed.

`source(echo = TRUE)` also produces cleaner output: code is echoed line-by-line with `+` continuation prompts, matching how R normally displays interactive input.

REditorSupport pastes directly for all code. If you prefer that behavior — for example, because you want raw paste output rather than `source()` echoing — set `raven.sendToR.sendMethod` to `"paste"`.

---

## Implementation notes

### commands.ts changes

The dispatch logic in `handle_send` (line 86–91) and `handle_terminal_send` (line 112–121) needs to read the new setting and branch accordingly.

```
auto    + single-line  →  terminal.sendText(code)
auto    + multi-line   →  send_via_tempfile(terminal, code)
paste   + single-line  →  terminal.sendText(code)
paste   + multi-line   →  terminal.sendText('\x1b[200~' + code + '\x1b[201~')
tempfile + any         →  send_via_tempfile(terminal, code)
```

The `sourceFile` mode short-circuits before the dispatch point in both handlers and is unaffected.

`sendMethod` is read directly from `vscode.workspace.getConfiguration('raven.sendToR')` in the command handlers — it is a client-side-only setting and does not go through `initializationOptions.ts`.

### package.json changes

Add `raven.sendToR.sendMethod` to the `contributes.configuration` block with enum values `["auto", "paste", "tempfile"]`, `enumDescriptions`, and `default: "auto"`.

## Out of scope

- No change to `sourceFile` behavior
- No per-command override (one setting controls all send commands)
- No separate setting for the Terminal submenu vs. the Raven terminal
