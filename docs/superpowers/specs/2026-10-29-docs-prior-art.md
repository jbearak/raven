# Documentation prior art for Raven's user docs

Date: 2026-10-29. Status: research notes. This is not a design.

These notes survey how comparable developer tools document themselves. They inform `2026-10-29-docs-redesign-design.md`. The survey covers only projects whose license is compatible with GPL-3.0, so we can adapt their structure and, with attribution, their text.

## Licenses

| Project | License | Notes |
|---|---|---|
| Ruff, ty, Air, Jarl, Ark, vscode-R, mise, Deno (+ `denoland/docs`) | MIT | |
| uv, rust-analyzer, Biome (site repo `biomejs/website` is MIT) | Apache-2.0 + MIT | |
| Typst | Apache-2.0 | |
| Starship | ISC | |
| lintr, languageserver | MIT + file LICENSE | |
| Helix | MPL-2.0 | Compatible, but copied text stays MPL at file level. Borrow structure only. |
| Positron | Posit license agreement | **Excluded**: not open source. |

## Per-project traits

| Project | README role | Information architecture / tooling | Notable traits |
|---|---|---|---|
| Ruff | Full landing page; site index generated from it | Flat nav: Tutorial, Installing, Linter, Formatter, Editors, Configuring, Rules, Settings, Versioning, FAQ. Material for MkDocs | Per-rule pages; generated settings reference; FAQ with quantified comparisons |
| uv | Landing page | Getting started / Guides / Concepts / Reference (incl. Troubleshooting, Policies) | Install right after highlights; every feature shown as a short real terminal session |
| ty | Landing page | Introduction / Guides / Concepts / Features / Reference; rules reference generated from Rust | Language-server page grouped by user task, captioned PNGs, one LSP feature-support table |
| Air | Short | Quarto site: Formatter, CLI, one page per editor, Integrations, Configuration | Teaches by before/after code; states its philosophy and trade-offs openly |
| Jarl | Full landing page copied into site | Getting started, By Example, How-to, Reference (Rules, CLI, Config, Env vars) | Per-rule pages generated from Rust; landing demo is file → `jarl check` output → fixed file |
| rust-analyzer | Pointer | mdBook | Features page generated from source; troubleshooting is an ordered procedure |
| Biome | Landing page | Starlight: Introduction (incl. comparison), Installation, Configuration, Formatter, Analyzer, Reference, Recipes | 3-step quick start ending in next steps; rule pages show invalid/valid code with real output; language-support matrix |
| lintr | README is pkgdown home | Get started, Reference (per-linter), Articles | Opens with a `bad.R` worked example and its full output |
| vscode-R | Pointer to wiki | Getting Started, per-OS install, Configuration, Features, FAQ | No real search; pages missing from sidebar |
| languageserver | README is everything | none | Capability list, client list, settings table, FAQ |
| Deno | n/a | Get started / Guides / Concepts / Reference; one CLI page per subcommand | "View as Markdown", `llms.txt`, edit link per page |
| Typst | n/a | 4-page tutorial with one running example / Guides / Reference | Dedicated entry for people coming from LaTeX |
| Starship | n/a | VitePress | Config reference uses one uniform block per module: options, variables, example |

## Transferable patterns, ranked by impact

1. **Diátaxis-shaped navigation**: Getting started → Guides → Concepts → Reference (uv, ty, Deno, Typst).
2. **One fixed template per diagnostic or rule**: what it does, why, example, fix, options (Ruff, ty, Biome, Jarl).
3. **A rules index table with a legend**: code, category, default, suppressible (Ruff, Jarl).
4. **A generated settings reference with the same fields for every entry** (Ruff, Starship).
5. **A landing page that shows the result before explaining it**: tagline, a real session, install near the top (uv, Jarl, lintr).
6. **A three-step quick start that ends in next steps** (Biome, Deno).
7. **Editor features grouped by user task, plus a capability table** (ty, Biome).
8. **A "coming from X" entry** for migrants (Typst for LaTeX users; for Raven: RStudio, vscode-R, Positron, lintr).
9. **Comparisons as short, factual FAQ answers** (Ruff FAQ, Biome, Jarl's "Related work").
10. **Troubleshooting as an ordered procedure** (rust-analyzer).
11. **A cookbook of input → command → output** (Jarl "By example").
12. **Before/after examples with the reasoning stated** (Air).
13. **`llms.txt` / agent-readable docs** (Ruff, uv, mise, Deno).

## Costly patterns

- Translations, versioned doc switchers, online playgrounds (need a WASM build), interactive widgets.
- A GIF for every feature: GIFs go stale whenever the UI changes.
- Site-only syntax: MkDocs `!!!` and `===` blocks and Quarto `.qmd` do not render on GitHub. Raven's runtime links (the `raven check` footer, a VS Code notification, a setting description) point at `github.com/.../blob/main/docs/*.md`, so GitHub rendering must stay first-class.

## What none of them do

Ruff, ty, Jarl, and Biome generate their rule pages from source, and Biome renders real diagnostic output for its rule examples. But in every project surveyed, the landing-page demo and the prose feature pages are written by hand. Nothing stops the first thing a visitor reads from drifting away from what the tool actually prints.
