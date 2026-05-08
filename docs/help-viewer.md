# R Help Viewer

The extension provides a built-in help viewer that renders R help (Rd) documentation directly in VS Code. When you click on a function name in a hover, the help panel opens beside the editor and displays the topic's documentation, usage, arguments, and examples. Navigate across topics via cross-references, with full back/forward history support.

## How to open it

There are two ways to trigger the help viewer:

- **From a hover**: Hover over any function call (e.g., `dplyr::filter(...)` or `plot(1:10)`). The hover bubble displays a bold `pkg::name` heading at the top — click it to open the help panel.
- **From the command palette**: Run `Raven: Open R Help Panel` (requires a topic argument; typically triggered indirectly via the hover link).

## Navigation

The help panel toolbar includes back and forward arrows, populated as you click cross-reference links (labeled "See also: X") within rendered help pages. Navigation works like a browser:

- Click a cross-reference to jump to that topic.
- The back arrow becomes enabled once you've navigated away from the initial topic.
- Back takes you to the previous topic and restores scroll position.
- Forward is only available after you've used back to return to an earlier topic.
- Navigating to a new topic from a back-position clears the forward stack.

Internal cross-references are rewritten to a custom URL scheme that correctly round-trips operator topics like `` \`[\` `` and `` \`%in%\` ``.

**Panel placement**: The initial column is controlled by `raven.help.viewerColumn` (default `beside`). Once you move the panel manually in VS Code, Raven leaves it in its new location.

## What works

- Most installed-package help pages render, including titles, descriptions, usage, arguments, examples, and see-also sections.
- Cross-references within and across packages navigate in-panel.
- Operator topics (`` \`[\` ``, `` \`%in%\` ``, `+`, `if`, etc.) render and navigate correctly.
- Images embedded in help pages (e.g., `?ggplot2::theme`) render — local files are served via webview URIs from package help directories.
- External links (`https://`, `http://`, `mailto:`) open via `vscode.env.openExternal`.

## v1 Limitations

- **No search**: There is no way to search across help topics from the panel. Use `?topic` or `??topic` in the R console.
- **No examples runner**: Clicking inside an examples block does not execute the code. Copy-paste it into your R console.
- **No vignettes**: Vignette links (`` \`../../<pkg>/doc/<vignette>.html\` ``) are neutralized in the rendered HTML; clicking them does nothing. Vignettes are out of scope for v1.
- **Remote images dropped**: `<img>` tags pointing to `https://` or any non-local source are stripped by the sanitizer. Only local images shipped with installed packages render.
- **Singleton panel**: Only one help panel per VS Code window. Navigating to a new topic reuses the same panel.
- **Help format support**: `tools::Rd2HTML()` output is sanitized via ammonia. Topics with unusual Rd structure may render slightly differently than RStudio's help pane.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `raven.help.viewerColumn` | `"beside"` | Initial editor column when the help panel first opens. Values: `"active"`, `"beside"`. Once you move the panel, Raven leaves it where you put it. |

## Manual smoke test plan

1. Hover over `dplyr::filter` in an R file → bold `dplyr::filter` heading at the top of hover; click → panel opens beside.
2. Panel shows R help with package header, title, usage, arguments, examples.
3. Click "See also: arrange" → panel navigates, back arrow now enabled.
4. Back arrow → returns to filter, scroll position restored.
5. Hover `plot(1:5)` → bold `graphics::plot` heading; click → navigates correctly even cross-package.
6. Hover an operator: `` ?\`[\` `` or `` ?\`%in%\` `` → bold heading uses the operator, click navigates and renders correctly (verifies percent-encoding round-trip and `is_valid_help_topic`).
7. Trigger a help page with images (e.g., `?ggplot2::theme` if installed) → images load.
8. Trigger an unknown topic by directly invoking the command → panel shows the not-found message; previous content & history preserved.
9. Configure a non-default R via `raven.packages.rPath` and verify help renders against that R installation (open a topic only available in a package installed for that R; should succeed where it would fail against system R).
