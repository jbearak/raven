# Design: `raven.sendToR.sendMethod` setting

**Date:** 2026-05-07
**Status:** Approved, ready for implementation

## Overview

Add a `raven.sendToR.sendMethod` setting that lets users control whether Raven sends code to R via direct paste, bracketed paste, or a temp file. The default (`auto`) preserves the Raven-managed terminal behavior and normalizes the Terminal submenu to the same dispatch rule: direct paste for single-line code, temp file for multi-line code.

## Background

The Raven-managed terminal currently uses two different mechanisms depending on the code being sent:

- **Single-line code** → `terminal.sendText()` (direct paste)
- **Multi-line code** → writes to a temp file, then `source()`s it

The Terminal submenu currently sends every non-`sourceFile` payload through a temp file. This design intentionally changes that path so `auto` means the same thing for both command groups.

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

**Scope:** applies to both the Raven-managed terminal (`handle_send`) and the Terminal submenu (`handle_terminal_send`). The `sourceFile` command — which runs `source()` against the document's saved path — is unaffected in all modes and must bypass `sendMethod` dispatch explicitly.

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

When multi-line code is pasted, the terminal delivers characters to R's stdin faster than readline can process them, which can silently drop or corrupt lines. This affects the standard R console as well as arf and radian. Writing to a temp file sidesteps this entirely: R reads from disk rather than stdin, so there is no terminal paste-buffer race, no practical paste-size limit from stdin buffering, and no sensitivity to connection speed.

`source(echo = TRUE)` also produces cleaner output: code is echoed line-by-line with `+` continuation prompts, matching how R normally displays interactive input.

REditorSupport pastes directly for all code. If you prefer that behavior — for example, because you want raw paste output rather than `source()` echoing — set `raven.sendToR.sendMethod` to `"paste"`.

---

## Implementation notes

### commands.ts changes

The dispatch logic in `handle_send` and `handle_terminal_send` needs to read the new setting and branch accordingly. Both handlers should explicitly send `mode === "file"` payloads with `terminal.sendText(code)` and return before considering `sendMethod`; this prevents `sourceFile` from being routed through a temp file when `sendMethod` is `"tempfile"`.

For all non-file sends:

```text
auto    + single-line  →  terminal.sendText(code)
auto    + multi-line   →  send_via_tempfile(terminal, code)
paste   + single-line  →  terminal.sendText(code)
paste   + multi-line   →  terminal.sendText('\x1b[200~' + code + '\x1b[201~')
tempfile + any non-file → send_via_tempfile(terminal, code)
```

Extract the dispatch decision into a small testable helper rather than duplicating the matrix in both handlers. One acceptable shape:

```ts
type SendMethod = 'auto' | 'paste' | 'tempfile';
type SendTransport = 'direct-paste' | 'bracketed-paste' | 'tempfile';

function choose_send_transport(code: string, sendMethod: SendMethod): SendTransport {
    // Implements the non-file matrix above.
}
```

The command handlers remain responsible for the `mode === "file"` short-circuit, because `sourceFile` is a command-mode rule rather than a code-shape rule.

Add a `send_via_bracketed_paste(terminal, code)` helper for multi-line `"paste"` sends. It should use bracketed paste delimiters:

```ts
terminal.sendText('\x1b[200~' + code + '\x1b[201~');
```

Use `terminal.sendText`'s default execution behavior unless implementation testing shows that an explicit trailing newline or `shouldExecute` value is needed.

`sendMethod` is read directly from `vscode.workspace.getConfiguration('raven.sendToR')` in the command handlers — it is a client-side-only setting and does not go through `initializationOptions.ts`.

### package.json changes

Add `raven.sendToR.sendMethod` to the `contributes.configuration` block with enum values `["auto", "paste", "tempfile"]`, `enumDescriptions`, and `default: "auto"`.

### Tests and verification

Add automated tests for the pure dispatch helper covering:

- `"auto"` + single-line → direct paste
- `"auto"` + multi-line → temp file
- `"paste"` + single-line → direct paste
- `"paste"` + multi-line → bracketed paste
- `"tempfile"` + single-line → temp file
- `"tempfile"` + multi-line → temp file

Also add or update handler-level coverage, if practical, to verify that `mode === "file"` bypasses the helper and always sends the computed `source("path", echo = TRUE)` command directly.

Manual smoke testing should verify that multi-line `"paste"` sends work with standard R. Best-effort verification with arf and radian is desirable because the docs name them as supported consoles.

## Out of scope

- No change to `sourceFile` behavior
- No per-command override (one setting controls all send commands)
- No separate setting for the Terminal submenu vs. the Raven terminal
