# Editor Integrations

Raven runs over stdio (`raven --stdio`) and works with any editor that has an LSP client.

## VS Code

Install the extension (which bundles the binary) from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jbearak.raven-r) or [OpenVSX](https://open-vsx.org/extension/jbearak/raven-r).

To use alongside [vscode-R](https://github.com/REditorSupport/vscode-R) (for running code, viewing plots, etc.), disable its language server to avoid duplicate completions:

```json
"r.lsp.enabled": false
```

You may also want:

```json
"editor.snippetSuggestions": "bottom"
```

## Zed

Add to your `settings.json`:

```json
"languages": {
  "R": {
    "language_servers": ["r_language_server"],
    "enable_language_server": true
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

## Neovim

Configure via `lspconfig` or manual setup:

```lua
vim.lsp.start({
  name = "raven",
  cmd = { "/path/to/raven", "--stdio" },
  filetypes = { "r", "rmd" },
  root_dir = vim.fs.dirname(vim.fs.find({ ".git" }, { upward = true })[1]),
})
```

## Generic LSP Client

Any LSP client that supports stdio transport:

```bash
raven --stdio
```

Configure your editor's LSP client to run this command for `.R`, `.r`, `.Rmd`, `.jags`, `.bugs`, and `.stan` files.

## Agent Integration

### Claude Code

Install the `raven-lsp` plugin from the
[`jbearak/claude-plugins`](https://github.com/jbearak/claude-plugins)
marketplace:

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

## Troubleshooting

- **Server not found**: Ensure `raven` is on your PATH, or specify the full path to the binary.
- **No diagnostics**: Check that files have `.R` or `.r` extension. JAGS/Stan files have diagnostics suppressed by design.
- **Stale package completions**: Run **Raven: Refresh package cache** from the command palette, or restart the server.
- **Package watcher issues on Linux**: Raven watches `.libPaths()` recursively (~10–20 watches per installed package). On systems with the legacy 8192 inotify limit, the watcher can fail silently. Raise the limit: `sudo sysctl fs.inotify.max_user_watches=524288` (persist via `/etc/sysctl.conf`).
- **Cross-file features not working**: Ensure the workspace root is set correctly (Raven uses it for `source()` path resolution). Open the folder containing your R project, not a parent directory.
