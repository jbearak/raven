# R help viewer

[Docs](README.md) › R session (VS Code)

Read R help in a VS Code panel for the function that is actually in scope at your cursor.

<a id="why-we-built-this"></a>

| You do | Raven does |
|---|---|
| Hover `filter(...)` after `library(dplyr)` and click the bold `dplyr::filter` heading | Opens `dplyr::filter`'s help beside the editor, not `stats::filter`'s |
| Click "See also: arrange" in the help page | Shows `arrange`'s help in the same panel and enables the back arrow |

Raven picks the package from its scope analysis: namespace qualifiers (`pkg::fn`), `library()` / `require()` / `loadNamespace()` calls in this file and any sourced files, and the standard package search-path order. A name declared with an in-scope `# raven: var` or `# raven: func` directive gets a hover showing where it was declared instead of a package help link. See [Comparison: Hover help](comparison.md#hover-help) for how this differs from other R hover implementations.

The help viewer works whether or not Raven's R console is active: it runs R on demand to render help as HTML, so it needs only an R installation Raven can run. See [Coexistence](coexistence.md#the-ravenrconsoleactivation-setting).

## How to open it

Hover over an identifier, such as `dplyr::filter` or `plot`. When the symbol resolves to a known package, the hover shows a bold `pkg::name` heading at the top. Click it to open the help panel.

In R Markdown (`.Rmd` / `.Rmarkdown`) and Quarto (`.qmd`) files, this works on identifiers inside R code chunks, the same as in `.R` files. Prose, YAML front matter, and non-R chunks produce no hover, so there's no help link there.

There is no Command Palette entry. The panel needs a resolved topic and package, which only the hover link supplies, so `raven.openHelpPanel` and the `raven.help.back` / `raven.help.forward` navigation commands are hidden from the palette.

## Navigation

The panel toolbar has back and forward arrows, which fill as you click cross-reference links (labeled "See also: X") in help pages. They work like a browser's:

- Click a cross-reference to jump to that topic.
- The back arrow is enabled once you've navigated away from the first topic.
- Back takes you to the previous topic and restores its scroll position.
- Forward is available only after you've gone back.
- Opening a new topic after going back clears the forward history.

Cross-references to operator topics such as `` \`[\` `` and `` \`%in%\` `` navigate correctly.

The panel first opens in the column set by `raven.help.viewerColumn` (default `beside`). Once you move it, Raven leaves it where you put it.

## What works

- Most installed-package help pages render, including titles, descriptions, usage, arguments, examples, and see-also sections.
- Cross-references within and across packages open in the panel.
- Operator topics (`` \`[\` ``, `` \`%in%\` ``, `+`, `if`, and so on) render and navigate correctly.
- Images in help pages (for example `?ggplot2::theme`) render from the package's own help directory.
- External links (`https://`, `http://`, `mailto:`) show VS Code's "Do you want to open this URL?" prompt once, then open in your default browser or mail client.
- Links to R's bundled manuals open the manual on CRAN in your browser. This is how the "Writing R Extensions" link in `?utils::package.skeleton` works.
- If a topic can't be opened, the previous topic stays visible and the error appears in the toolbar banner. Back and forward continue from the last topic that opened.

## Settings

<a id="configuration"></a>

| Setting | Default | Effect |
|---|---|---|
| `raven.help.viewerColumn` | `"beside"` | Initial editor column when the help panel first opens: `"active"` or `"beside"`. Once you move the panel, Raven leaves it where you put it. |

See the [settings reference](settings-reference.md) for all settings.

<a id="v1-limitations"></a>

## Limitations

- No search. You can't search across help topics from the panel. Use `?topic` or `??topic` in the R console.
- No examples runner. Clicking in an examples block doesn't run the code; copy it into your R console. The "Run examples" link that R's help normally shows is removed, because it needs R's dynamic help server.
- No vignettes. Vignette links do nothing when clicked.
- No remote images. Images from `https://` or any other non-local source are removed. Only local images shipped with installed packages render.
- One panel per window. Opening a new topic reuses the same panel.
- Rendering differences. Help is rendered with R's `tools::Rd2HTML()` and then sanitized, so topics with unusual Rd structure may look slightly different from RStudio's help pane.

## Details

<a id="manual-smoke-test-plan"></a>

<details markdown="1">
<summary>How links in help pages are resolved</summary>

- When R's HTML help attributes a link to the wrong package (for example `base::plot` linking to `base/plot.default` although `plot.default` lives in `graphics`, or `graphics::plot.default` linking to `graphics/finite` for the `is.finite` alias in `base`), Raven falls back to a global `help()` lookup so the link still opens.
- Links to R's bundled manuals `R-intro`, `R-admin`, `R-data`, `R-exts`, `R-FAQ`, `R-ints`, and `R-lang` are rewritten to `https://cran.r-project.org/doc/manuals/r-release/<name>.html`, with any anchor preserved. Other manual paths (for example `rw-FAQ.html`, or custom and third-party docs) are not rewritten, and clicking them does nothing.
- The "Run examples" and per-package "Index" footer links are removed, because they point at R help-server pages the panel has no equivalent for.
- Vignette links (`../../<pkg>/doc/<vignette>.html`) are disabled in the rendered page.

</details>

## See also

- [Hover](hover.md)
- [R console](r-console.md)
- [Comparison: Hover help](comparison.md#hover-help)
