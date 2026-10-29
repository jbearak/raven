#!/usr/bin/env bun
// Generates the files derived from docs/user-pages.json:
//   - docs/README.md      the docs hub (GitHub renders it when you open docs/)
//   - llms.txt            an agent-readable index with absolute URLs
//   - zensical.toml   the `nav = [...]` block, if that file exists
//
// Usage: bun scripts/generate-docs-hub.ts [--check]
// With --check, exits 1 if any generated file is out of date.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadManifest, repoRoot } from "../tests/bun/docs/_lib/manifest";

const BLOB = "https://github.com/jbearak/raven/blob/main";
const check = process.argv.includes("--check");
const m = loadManifest();
const site = m.site_url.replace(/\/$/, "");

function hub(): string {
  const out = [
    "# Raven documentation",
    "",
    "Raven is a static analyzer and language server for R. Start with [Getting started](getting-started.md), or pick a topic below.",
    "",
  ];
  if (site) out.push(`Prefer search? The same pages are on the [documentation site](${site}/).`, "");
  for (const g of m.groups) {
    out.push(`## ${g.title}`, "");
    for (const p of g.pages) out.push(`- [${p.title}](${p.file}): ${p.description}`);
    out.push("");
  }
  out.push(
    "## More",
    "",
    `- [Project README](${BLOB}/README.md): what Raven is, installation, and license.`,
    `- [Report a problem](https://github.com/jbearak/raven/issues). See [Troubleshooting](troubleshooting.md) first for what to include.`,
    "",
    "<!-- Generated from docs/user-pages.json by scripts/generate-docs-hub.ts. Edit the manifest, then regenerate. -->",
    "",
  );
  return out.join("\n");
}

function llms(): string {
  const out = [
    "# Raven",
    "",
    "> Raven is a static analyzer and language server for R. It finds undefined variables and broken `source()` chains across files without running code, and provides completion, navigation, and hover in any LSP editor. Its VS Code extension adds an R console, debugger, plot/data/help viewers, and R Markdown/Quarto preview. The `raven check` CLI runs the same analysis in CI.",
    "",
  ];
  if (site) out.push(`Documentation site: ${site}/`, "");
  for (const g of m.groups) {
    out.push(`## ${g.title}`, "");
    for (const p of g.pages) out.push(`- [${p.title}](${BLOB}/docs/${p.file}): ${p.description}`);
    out.push("");
  }
  out.push("## Optional", "", `- [README](${BLOB}/README.md): overview, installation, and license`, "");
  return out.join("\n");
}

function siteNav(current: string): string {
  const lines = ["nav = [", '  { "Home" = "README.md" },'];
  for (const g of m.groups) {
    lines.push(`  { "${g.title}" = [`);
    for (const p of g.pages) lines.push(`    { "${p.title.replace(/"/g, '\\"')}" = "${p.file}" },`);
    lines.push("  ] },");
  }
  lines.push("]");
  const block = lines.join("\n");
  return current.replace(/# BEGIN GENERATED NAV[\s\S]*# END GENERATED NAV/, `# BEGIN GENERATED NAV\n${block}\n# END GENERATED NAV`);
}

const targets: [string, (current: string) => string][] = [
  ["docs/README.md", () => hub()],
  ["llms.txt", () => llms()],
];
if (existsSync(path.join(repoRoot, "zensical.toml"))) targets.push(["zensical.toml", siteNav]);

let stale = false;
for (const [file, make] of targets) {
  const abs = path.join(repoRoot, file);
  const current = existsSync(abs) ? readFileSync(abs, "utf8") : "";
  const next = make(current);
  if (next === current) continue;
  if (check) {
    console.error(`${file} is out of date; run: bun scripts/generate-docs-hub.ts`);
    stale = true;
  } else {
    writeFileSync(abs, next);
    console.log(`wrote ${file}`);
  }
}
process.exit(stale ? 1 : 0);
