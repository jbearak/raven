# Troubleshooting

[Docs](README.md) › Help

Work through these steps in order when Raven does something you don't expect. Most problems are solved by step 3 or 4, and the rest end with an issue you can file in a few minutes.

## 1. Check the version

Many problems are already fixed in a newer release.

- **VS Code:** open the Extensions view and look at Raven's version. The extension's built-in language server has the same version.
- **Command line:** run `raven --version`.

Compare with the [latest release](https://github.com/jbearak/raven/releases).

## 2. Look at the log

In VS Code, open **View › Output** and pick **Raven** from the drop-down. Server start-up problems and errors appear there.

For more detail, set `raven.trace.server` to `"messages"` (or `"verbose"`, which includes why each diagnostic was or wasn't reported), then run **Raven: Restart Language Server** from the Command Palette.

In other editors, the server writes its log to standard error, which your editor's LSP client log usually captures (for example Neovim's `:LspLog`). Set the environment variable `RUST_LOG=raven=debug` before starting the editor for more detail.

## 3. Reproduce on the command line

`raven check` runs the same analysis as the editor, with no editor state involved. In your project folder:

```sh
raven check path/to/file.R
```

If the CLI shows the same problem, the cause is in the analysis, and the command and its output are the best possible bug report. If the CLI is right and the editor is wrong, note that too: it points at editor state, such as an unsaved buffer or a stale package cache.

## 4. Match your symptom

| Symptom | Likely cause and fix |
|---|---|
| A variable is reported as undefined, but it exists | The name comes from somewhere Raven can't see: a file sourced through a path it can't resolve, or a run-time mechanism like `attach()`. Check the `source()` path, or declare the name with [`# raven: var`](directives.md#declaration-directives). |
| A column name inside a function call is flagged | The function uses non-standard evaluation Raven doesn't know about. Declare it with [`# raven: nse`](non-standard-evaluation.md). |
| Names from a sourced file aren't found | Open the folder that contains your project, not a parent or a single file. Raven resolves paths from the workspace root. If the file is sourced from somewhere Raven can't detect, add [`# raven: sourced-by`](directives.md). See [Cross-file analysis](cross-file.md). |
| Package functions are flagged or not completed | Raven needs to know the package's exports. Check that R is found (step 2 log), then run **Raven: Refresh package cache**. Without R, see [Package database](package-database.md). |
| Duplicate completions | vscode-R's language server is also running. Set `r.lsp.enabled` to `false`, or keep both. See [Using Raven with other R tools](coexistence.md#run-raven-next-to-vscode-r). |
| Raven's R console, plot viewer, or data viewer is missing | They step aside in Positron. See [Why Raven's console stepped aside](coexistence.md#why-ravens-console-stepped-aside). If `raven.rConsole.activation` is `"disabled"`, set it to `"auto"` or `"enabled"`. |
| A file has no diagnostics | In VS Code, diagnostics are shown for files open in a tab. JAGS and Stan diagnostics are off by default. See [Diagnostics](diagnostics.md). |
| The server doesn't start in Neovim, Zed, Helix, or Emacs | The editor can't find `raven`. Put it on your `PATH` or use the full path, then use the editor's check in [Editor setup](editor-integrations.md). |
| `raven check` reports packages as missing in CI | CI usually has no R. Run `raven packages update` first, or commit a package list. See [Raven in CI](ci.md). |

## 5. File an issue

Open an issue at [github.com/jbearak/raven/issues](https://github.com/jbearak/raven/issues). Include:

- Raven's version (step 1), your editor and its version, and your operating system.
- The smallest R code that shows the problem. Two short files are fine if the problem is cross-file.
- What you expected and what happened, ideally as `raven check` output (step 3).
- The relevant part of the log (step 2), if the problem is in the editor.
- Your `raven.toml` or `.lintr`, if you have one.

## See also

- [FAQ](faq.md)
- [Limitations](limitations.md): what Raven doesn't do yet, which may explain the behavior.
- [Editor setup](editor-integrations.md)
