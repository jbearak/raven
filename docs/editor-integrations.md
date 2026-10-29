# Editor setup

[Docs](README.md) › Start here

Raven is a language server, so any editor with an LSP client can use it; this page gives the setup and a quick check for each one.

<a id="editor-integrations"></a>

| Your editor | What to do |
|---|---|
| VS Code, Cursor, Positron, VSCodium | Install the Raven extension. It bundles the `raven` binary. |
| Neovim, Zed, Helix, Emacs, or another LSP client | Install the `raven` binary, then point the editor's LSP client at `raven --stdio`. |

Every section ends with the same check. Open an R file containing this line:

```r
x <- undefined_thing
```

Raven underlines `undefined_thing` with the warning `undefined_thing is not defined`. If you see it, Raven is running.

## Getting the binary

The VS Code extension bundles the binary, so skip this step for the VS Code family. For other editors, install `raven` with the macOS, Ubuntu, or Arch Linux packages listed under [Command line in the README](https://github.com/jbearak/raven/blob/main/README.md#command-line), or download a pre-built binary from the [GitHub releases page](https://github.com/jbearak/raven/releases). Put `raven` on your `PATH`, or use its full path in the snippets below. [Command line](cli.md) describes the binary's commands.

## VS Code, Cursor, Positron, and VSCodium

<a id="vs-code"></a>

**Install.** In VS Code, install Raven from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jbearak.raven-r). In Cursor, Positron, VSCodium, and other VS Code-based editors, install it from [Open VSX](https://open-vsx.org/extension/jbearak/raven-r), or download the `.vsix` file from the [releases page](https://github.com/jbearak/raven/releases) and install it manually. The extension bundles the binary.

**Configure.** Nothing is required. If you also use [vscode-R](https://github.com/REditorSupport/vscode-R), turn off its language server so completions aren't listed twice:

```json
"r.lsp.enabled": false
```

[Coexistence](coexistence.md) explains what else changes when Raven runs next to vscode-R, Positron, or the Quarto extension. If Raven's snippets crowd the completion list, see [Snippets](snippets.md#sort-or-hide-snippets).

**Verify it's working.** Open an `.R` file, then open the Output panel (**View: Toggle Output**) and pick **Raven** from its list; it shows the server's log. Then try the `undefined_thing` line from the top of this page.

**What you get.** Every row of the [feature table](#feature-availability) below.

## Neovim

<a id="neovim"></a>

**Install.** [Get the binary](#getting-the-binary).

**Configure.** In Neovim 0.11 and later, use the built-in `vim.lsp.config` and `vim.lsp.enable`:

```lua
vim.lsp.config("raven", {
  cmd = { "raven", "--stdio" },
  filetypes = { "r", "rmd", "quarto" },
  root_markers = { "raven.toml", "DESCRIPTION", ".git" },
})
vim.lsp.enable("raven")
```

In earlier Neovim versions with [nvim-lspconfig](https://github.com/neovim/nvim-lspconfig), register Raven as a custom server:

```lua
local configs = require("lspconfig.configs")
if not configs.raven then
  configs.raven = {
    default_config = {
      cmd = { "raven", "--stdio" },
      filetypes = { "r", "rmd", "quarto" },
      root_dir = require("lspconfig.util").root_pattern("raven.toml", "DESCRIPTION", ".git"),
    },
  }
end
require("lspconfig").raven.setup({})
```

Without nvim-lspconfig, Neovim 0.8 and later can start Raven from an autocommand:

```lua
vim.api.nvim_create_autocmd("FileType", {
  pattern = { "r", "rmd" },
  callback = function()
    vim.lsp.start({
      name = "raven",
      cmd = { "/path/to/raven", "--stdio" },
      root_dir = vim.fs.dirname(vim.fs.find({ ".git" }, { upward = true })[1]),
    })
  end,
})
```

If you also run `r_language_server` (the R `languageserver` package) for R files, you get results from both servers, such as duplicate completions.

Neovim has no built-in filetype for JAGS or Stan files. To use Raven for them, define filetypes with `vim.filetype.add` and add them to `filetypes`.

**Verify it's working.** Open an R file and run `:checkhealth vim.lsp` (Neovim 0.11+) or `:LspInfo` (nvim-lspconfig). Raven should be listed as attached to the buffer. Then try the `undefined_thing` line.

**What you get.** The "Any LSP editor" column of the [feature table](#feature-availability).

## Zed

<a id="zed"></a>

**Install.** [Get the binary](#getting-the-binary), and install Zed's R extension from the extensions page (`zed: extensions` in the command palette). The R extension defines the `r_language_server` entry that the settings below point at Raven.

**Configure.** Add this to your Zed `settings.json`:

```json
"languages": {
  "R": {
    "language_servers": ["r_language_server"]
  }
},
"lsp": {
  "r_language_server": {
    "binary": {
      "path": "/path/to/raven",
      "arguments": ["--stdio"]
    }
  }
}
```

**Verify it's working.** Run `debug: open language server logs` from the command palette and check that `r_language_server` started without errors. Then try the `undefined_thing` line.

**What you get.** The "Any LSP editor" column of the [feature table](#feature-availability).

## Helix

**Install.** [Get the binary](#getting-the-binary).

**Configure.** Add this to `languages.toml` in your Helix config directory, or in `.helix/` at the project root:

```toml
[language-server.raven]
command = "raven"
args = ["--stdio"]

[[language]]
name = "r"
language-servers = ["raven"]

[[language]]
name = "rmarkdown"
language-servers = ["raven"]
```

**Verify it's working.** Run `hx --health r` in a terminal. The output lists `raven` as the configured language server and shows whether Helix found the binary. Then open an R file and try the `undefined_thing` line. `:log-open` shows Helix's log if the server fails to start.

**What you get.** The "Any LSP editor" column of the [feature table](#feature-availability).

## Emacs (eglot)

**Install.** [Get the binary](#getting-the-binary). Eglot ships with Emacs 29 and later. R buffers need an R major mode such as `ess-r-mode` from ESS.

**Configure.** Add this to your init file:

```elisp
(with-eval-after-load 'eglot
  (add-to-list 'eglot-server-programs
               '((ess-r-mode r-mode) . ("raven" "--stdio"))))
(add-hook 'ess-r-mode-hook #'eglot-ensure)
```

**Verify it's working.** Open an R file. The mode line shows `eglot`, and `M-x eglot-events-buffer` shows the messages exchanged with Raven. Then try the `undefined_thing` line.

**What you get.** The "Any LSP editor" column of the [feature table](#feature-availability).

## Any other LSP client

<a id="generic-lsp-client"></a>

**Install.** [Get the binary](#getting-the-binary).

**Configure.** Any LSP client that supports the stdio transport can run Raven with this command:

```sh
raven --stdio
```

Run it for `.R`, `.r`, `.Rmd`, `.qmd`, `.jags`, `.bugs`, `.bug`, and `.stan` files. Raven matches the JAGS extensions case-insensitively and treats them as strict JAGS. That doesn't mean general OpenBUGS, WinBUGS, MultiBUGS, or NIMBLE compatibility. Some editors filter files case-sensitively before starting Raven, so turn on case-insensitive matching if your editor has it, or list the case variants your project uses.

**Verify it's working.** Check your client's log for a successful start, then try the `undefined_thing` line.

**What you get.** The "Any LSP editor" column of the [feature table](#feature-availability).

## Feature availability

The language server provides the code intelligence in any editor. The rest comes from the VS Code extension.

| Feature | Any LSP editor | VS Code extension |
|---|---|---|
| [Completion](completion.md) and signature help | Yes | Yes |
| [Hover](hover.md) | Yes. The `pkg::name` link opens the help viewer only in VS Code. | Yes |
| [Go to definition](go-to-definition.md) | Yes | Yes |
| [Find references](find-references.md) and workspace symbols | Yes | Yes |
| [Diagnostics](diagnostics.md) | Yes | Yes |
| [Document outline](document-outline.md) | Yes | Yes |
| [Semantic highlighting](syntax-highlighting.md) | Yes, if the editor supports semantic tokens | Yes |
| Grammars for JAGS, Stan, and R package files | No | Yes |
| [On-type indentation](indentation.md) | Yes, if the editor sends on-type formatting requests | Yes |
| Code actions and quick fixes | No | No |
| [Snippets](snippets.md) | No | Yes |
| [R console](r-console.md) | `raven console` in a terminal, without send-from-editor | Yes |
| [Debugger](debugger.md) | No | Yes |
| [Plot](plot-viewer.md), [data](data-viewer.md), and [help](help-viewer.md) viewers | No | Yes |
| [R Markdown preview and export](knit.md) | No | Yes |
| [Quarto preview and render](quarto.md) | No | Yes |

In VS Code, the R console, viewers, and R Markdown preview step aside by default when vscode-R or Positron is active. [Coexistence](coexistence.md) has the details.

## AI coding agents

<a id="agent-integration"></a>

Coding agents that speak LSP can use Raven for diagnostics and navigation in R files.

### Claude Code

Install the `raven-lsp` plugin from the [`jbearak/claude-plugins`](https://github.com/jbearak/claude-plugins) marketplace:

```text
/plugin marketplace add jbearak/claude-plugins
/plugin install raven-lsp@jbearak
```

The plugin configures Claude Code to launch Raven for R files (`.R`, `.r`, `.Rmd`).

### OpenCode

Create `opencode.json` in your project root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "lsp": {
    "r": {
      "command": ["raven", "--stdio"],
      "extensions": [".R", ".r", ".Rmd"]
    }
  }
}
```

### Kiro CLI

Create `lsp.json` in your project root:

```json
{
  "languages": {
    "r": {
      "name": "raven",
      "command": "raven",
      "args": ["--stdio"],
      "file_extensions": ["R", "r", "Rmd"],
      "project_patterns": [".Rproj"]
    }
  }
}
```

### Crush

Create `crush.json` in your project root:

```json
{
  "$schema": "https://charm.land/crush.json",
  "lsp": {
    "r": {
      "command": "raven",
      "args": ["--stdio"],
      "extensions": [".R", ".r", ".Rmd"]
    }
  }
}
```

## Project configuration

Every editor reads `raven.toml` at the project root, so a setting there applies to everyone on the project whatever editor they use. Editor settings, such as VS Code's `raven.linting.lineLength`, fill in only the keys `raven.toml` doesn't set. See [Configuration](configuration.md#project-config-raventoml).

## Troubleshooting

| Problem | What to do |
|---|---|
| The editor can't find the server | Put `raven` on your `PATH`, or give the full path to the binary in the editor's config. |
| No diagnostics | Check the file extension: `.R` or `.r` for R, `.jags`, `.bugs`, or `.bug` for JAGS, `.stan` for Stan. JAGS and Stan diagnostics are off by default; see [JAGS and Stan diagnostics](#jags-and-stan-diagnostics-are-off-by-default). |
| Package completions are out of date | In VS Code, run **Raven: Refresh package cache** from the command palette. In other editors, restart the server. |
| The package watcher stops working on Linux | Raise the inotify limit; see [Package watching on Linux](#package-watching-on-linux). |
| Cross-file features don't work | Open the folder that contains your R project, not a parent directory. Raven resolves `source()` paths against the workspace root. |

## Details

### JAGS and Stan diagnostics are off by default

Raven still discovers model files when their diagnostics are off. To turn diagnostics on, set `jags = "on"` or `stan = "on"` under `[diagnostics]` in `raven.toml`:

```toml
[diagnostics]
jags = "on"
stan = "on"
```

In VS Code, the settings are `raven.diagnostics.jags` and `raven.diagnostics.stan`. JAGS gets syntax diagnostics only. Stan also reports undeclared variables, conservatively, in files with real program blocks. Block-free fragments and files containing `#include` stay silent for that check. Model-file extensions are matched case-insensitively.

### Package watching on Linux

Raven watches every `.libPaths()` directory recursively, which takes about 10 to 20 inotify watches per installed package. On systems still at the legacy limit of 8192 watches, the watcher can fail without an error. Raise the limit:

```sh
sudo sysctl fs.inotify.max_user_watches=524288
```

Add the same setting to `/etc/sysctl.conf` to keep it after a reboot.

## See also

- [Getting started](getting-started.md)
- [Coexistence](coexistence.md)
- [Configuration](configuration.md)
- [Command line](cli.md)
