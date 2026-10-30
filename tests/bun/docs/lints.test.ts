// Mechanical style rules for the user docs (design §2, §3.5, §5.3, §7).
// Rules apply by page class: guide pages, reference pages (from
// docs/user-pages.json `kind`), and the two READMEs. Legal text in the
// READMEs' License sections is exempt from the voice and source-path rules.

import { describe, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { loadManifest, pageGroup, pageKind, repoRoot, userPagePaths } from "./_lib/manifest";
import { parse, wordCount } from "./_lib/markdown";
import { expectNoViolations } from "./_lib/report";

const manifest = loadManifest();
const pages = userPagePaths(manifest).filter((f) => existsSync(path.join(repoRoot, f)));
// Pages the docs site publishes; links to any other file under docs/ must be absolute.
const sitePages = new Set([...userPagePaths(manifest), "docs/README.md", "docs"]);

const MAX_PARAGRAPH_WORDS = 150;
const TARGET_CELL_WORDS = 40;
const GUIDE_TAIL = ["Settings", "Limitations", "Details", "See also"];
const LEGAL_SECTIONS = new Set(["License"]);

/** Text with inline code spans and double-quoted passages removed. */
function proseOnly(line: string): string {
  return line
    .replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/“[^”]*”/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
}

interface LineCtx {
  text: string;
  line: number;
  section: string | null;
}

/** Prose lines tagged with their enclosing H2 title. */
function linesWithSection(src: string): LineCtx[] {
  const doc = parse(src);
  const h2 = doc.headings.filter((h) => h.level === 2);
  return doc.proseLines.map((l) => {
    const owner = [...h2].reverse().find((h) => h.line <= l.line);
    return { ...l, section: owner?.text ?? null };
  });
}

function contentViolations(file: string, src: string, exemptLegal: boolean): string[] {
  const v: string[] = [];
  let inComment = false;
  for (const { text, line, section } of linesWithSection(src)) {
    if (exemptLegal && section && LEGAL_SECTIONS.has(section)) continue;
    // HTML comments are maintainer notes and example markers, not user prose.
    if (inComment || /<!--/.test(text)) {
      inComment = !/-->/.test(text) && (inComment || /<!--(?![\s\S]*-->)/.test(text));
      continue;
    }
    if (!text.trim().startsWith("|") && /—/.test(proseOnly(text)))
      v.push(`${file}:${line}: em dash in prose; use a period or comma`);
    if (/This page is being written/.test(text)) v.push(`${file}:${line}: stub text left in a page`);
    const prose = proseOnly(text);
    if (/\bissues? #\d+|\(#\d+\)|\bPR #\d+/i.test(text)) v.push(`${file}:${line}: issue/PR number in user docs`);
    if (/\bcrates\/|editors\/vscode\/src\/|\b[\w-]+\.(rs|mjs|cjs)\b|\b[\w-]+\.ts\b(?!x)/.test(text.replace(/https?:\/\/\S+/g, "")))
      v.push(`${file}:${line}: source path in user docs`);
    if (/\b([Ww]e|[Oo]ur|[Oo]urs|us)\b/.test(prose.replace(/\bUS\b/g, ""))) v.push(`${file}:${line}: first person`);
  }
  const doc = parse(src);
  for (const p of doc.paragraphs) {
    const n = wordCount(p.text);
    if (n > MAX_PARAGRAPH_WORDS) v.push(`${file}:${p.line}: paragraph has ${n} words (max ${MAX_PARAGRAPH_WORDS})`);
  }
  for (const d of doc.detailsTags)
    if (!/markdown\s*=\s*"1"/.test(d.tag)) v.push(`${file}:${d.line}: write <details markdown="1"> so the site renders it`);
  return v;
}

function imageViolations(file: string, src: string): string[] {
  return parse(src)
    .links.filter((l) => l.image && l.text.trim() === "")
    .map((l) => `${file}:${l.line}: image without alt text`);
}

function cellWarnings(file: string, src: string): string[] {
  const w: string[] = [];
  for (const { text, line } of parse(src).proseLines) {
    if (!text.trim().startsWith("|")) continue;
    for (const cell of text.split("|")) {
      const n = wordCount(cell);
      if (n > TARGET_CELL_WORDS) w.push(`${file}:${line}: table cell has ${n} words (target ${TARGET_CELL_WORDS})`);
    }
  }
  return w;
}

function structureViolations(file: string, src: string): string[] {
  const v: string[] = [];
  const lines = src.split("\n");
  const nonEmpty = lines.map((t, i) => ({ t, line: i + 1 })).filter((l) => l.t.trim() !== "");
  const group = pageGroup(file, manifest);
  if (!nonEmpty[0]?.t.startsWith("# ")) v.push(`${file}:1: must start with an H1`);
  const crumb = `[Docs](README.md) › ${group}`;
  if (nonEmpty[1]?.t.trim() !== crumb) v.push(`${file}:${nonEmpty[1]?.line ?? 2}: second line must be the breadcrumb "${crumb}"`);
  const lead = nonEmpty[2]?.t ?? "";
  if (!lead || /^(#|```|~~~|\||[-*+] |\d+\. |<|>)/.test(lead.trim()))
    v.push(`${file}:${nonEmpty[2]?.line ?? 3}: third line must be a lead sentence`);

  const doc = parse(src);
  const seen = new Map<string, number>();
  for (const h of doc.headings) {
    const key = h.text.toLowerCase();
    if (seen.has(key)) v.push(`${file}:${h.line}: duplicate heading "${h.text}" (first at line ${seen.get(key)})`);
    else seen.set(key, h.line);
  }

  const h2 = doc.headings.filter((h) => h.level === 2).map((h) => h);
  if (pageKind(file, manifest) === "guide") {
    let tailIndex = -1;
    for (const h of h2) {
      const idx = GUIDE_TAIL.indexOf(h.text);
      if (idx === -1) {
        if (tailIndex >= 0) v.push(`${file}:${h.line}: "${h.text}" comes after "${GUIDE_TAIL[tailIndex]}"; template order is Use it, then ${GUIDE_TAIL.join(", ")}`);
      } else if (idx <= tailIndex) {
        v.push(`${file}:${h.line}: "${h.text}" is out of template order (${GUIDE_TAIL.join(", ")})`);
      } else {
        tailIndex = idx;
      }
    }
  } else {
    const seeAlso = h2.findIndex((h) => h.text === "See also");
    if (seeAlso >= 0 && seeAlso !== h2.length - 1) v.push(`${file}:${h2[seeAlso].line}: "See also" must be the last section`);
  }

  // Links that leave docs/ must be absolute so they work on the docs site too.
  for (const l of doc.links) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(l.target) || l.target.startsWith("#")) continue;
    const resolved = path.posix.normalize(path.posix.join("docs", l.target.split("#")[0]));
    if (!resolved.startsWith("docs/"))
      v.push(`${file}:${l.line}: link "${l.target}" leaves docs/; use https://github.com/jbearak/raven/blob/main/…`);
    else if (!sitePages.has(resolved) && !resolved.startsWith("docs/images/"))
      v.push(`${file}:${l.line}: link "${l.target}" points at a file the docs site doesn't publish; use https://github.com/jbearak/raven/blob/main/${resolved}`);
  }
  return v;
}

describe("docs lints", () => {
  for (const file of pages) {
    test(file, () => {
      const src = readFileSync(path.join(repoRoot, file), "utf8");
      expectNoViolations("lints", `lints ${file}`, [...structureViolations(file, src), ...contentViolations(file, src, false)]);
      expectNoViolations("images", `images ${file}`, imageViolations(file, src));
      const warnings = cellWarnings(file, src);
      if (warnings.length && process.env.DOCS_LINT_REPORT === "1") console.log(`  [cells] ${warnings.join("\n  [cells] ")}`);
    });
  }
  for (const file of manifest.readmes) {
    test(file, () => {
      const src = readFileSync(path.join(repoRoot, file), "utf8");
      expectNoViolations("lints", `lints ${file}`, contentViolations(file, src, true));
      expectNoViolations("images", `images ${file}`, imageViolations(file, src));
    });
  }
});

test("the hub links every manifest page and nothing else in docs/", () => {
  const hubPath = path.join(repoRoot, "docs", "README.md");
  if (!existsSync(hubPath)) return expectNoViolations("hub", "hub", ["docs/README.md is missing"]);
  const doc = parse(readFileSync(hubPath, "utf8"));
  const linked = new Set(
    doc.links.map((l) => l.target.split("#")[0]).filter((t) => t && !/^[a-z]+:/i.test(t) && t.endsWith(".md")),
  );
  const expected = new Set(userPagePaths(manifest).map((p) => p.slice("docs/".length)));
  const v = [
    ...[...expected].filter((p) => !linked.has(p)).map((p) => `hub does not link ${p}`),
    ...[...linked].filter((p) => !expected.has(p)).map((p) => `hub links ${p}, which is not in the manifest`),
  ];
  for (const h of doc.headings.filter((h) => h.level === 2)) {
    const next = doc.headings.find((x) => x.line > h.line && x.level <= 2);
    const inSection = doc.links.filter((l) => l.line > h.line && (!next || l.line < next.line));
    if (inSection.length === 0) v.push(`hub section "${h.text}" is empty`);
  }
  expectNoViolations("hub", "hub", v);
});
