// A small, fence-aware Markdown scanner for the docs tests. It is not a full
// CommonMark parser: it recognizes exactly the constructs the user docs use
// (ATX headings, fenced code, inline links and images, `<a id>` anchors,
// `<details>` blocks, tables, and GitHub alerts) and reports line numbers so
// failures point at the source.

import { headingText, Slugger } from "./slug";

export interface Heading {
  level: number;
  text: string;
  slug: string;
  line: number;
}

export interface Link {
  target: string;
  text: string;
  image: boolean;
  line: number;
}

export interface Fence {
  info: string;
  body: string;
  /** Line number of the opening fence. */
  line: number;
  /** The nearest preceding HTML comment, if only blank lines separate them. */
  marker: string | null;
}

export interface Paragraph {
  text: string;
  line: number;
}

export interface Doc {
  headings: Heading[];
  links: Link[];
  /** Explicit `<a id="…">` / `<a name="…">` targets. */
  anchors: Set<string>;
  fences: Fence[];
  /** Prose paragraphs outside code, tables, `<details>`, and HTML blocks. */
  paragraphs: Paragraph[];
  /** Every `<details …>` opening tag with its line. */
  detailsTags: { tag: string; line: number }[];
  /** Lines outside fenced code, for line-oriented lints. */
  proseLines: { text: string; line: number }[];
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const ANCHOR = /<a\s+[^>]*?(?:id|name)\s*=\s*"([^"]+)"[^>]*>/gi;
const COMMENT_LINE = /^\s*<!--([\s\S]*?)-->\s*$/;

/** Strip inline code spans so link syntax inside them is ignored. */
function withoutCodeSpans(line: string): string {
  return line.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, (m) => " ".repeat(m.length));
}

function scanLinks(line: string, lineNo: number, out: Link[]): void {
  const clean = withoutCodeSpans(line);
  // Inline links/images: [text](target "title")
  const inline = /(!?)\[((?:[^\][]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  for (const m of clean.matchAll(inline)) {
    out.push({ image: m[1] === "!", text: m[2], target: m[3], line: lineNo });
  }
  // Reference definitions: [label]: target
  const def = /^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/.exec(clean);
  if (def) out.push({ image: false, text: "", target: def[1], line: lineNo });
  // HTML links and images
  for (const m of clean.matchAll(/<a\s[^>]*href\s*=\s*"([^"]+)"/gi)) {
    out.push({ image: false, text: "", target: m[1], line: lineNo });
  }
  for (const m of clean.matchAll(/<img\s[^>]*src\s*=\s*"([^"]+)"/gi)) {
    out.push({ image: true, text: "", target: m[1], line: lineNo });
  }
}

export function parse(source: string): Doc {
  const lines = source.split("\n");
  const doc: Doc = {
    headings: [],
    links: [],
    anchors: new Set(),
    fences: [],
    paragraphs: [],
    detailsTags: [],
    proseLines: [],
  };
  const slugger = new Slugger();

  let fence: { char: string; len: number; info: string; line: number; body: string[]; marker: string | null } | null =
    null;
  let lastComment: string | null = null;
  let detailsDepth = 0;
  let para: { lines: string[]; line: number } | null = null;

  const flushPara = () => {
    if (para) {
      doc.paragraphs.push({ text: para.lines.join(" ").trim(), line: para.line });
      para = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;

    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.char === "`" ? "`" : "~"}{${fence.len},}\\s*$`);
      if (close.test(raw)) {
        doc.fences.push({ info: fence.info, body: fence.body.join("\n"), line: fence.line, marker: fence.marker });
        fence = null;
      } else {
        fence.body.push(raw);
      }
      continue;
    }

    const open = FENCE_OPEN.exec(raw);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      flushPara();
      fence = {
        char: open[1][0],
        len: open[1].length,
        info: open[2].trim(),
        line: lineNo,
        body: [],
        marker: lastComment,
      };
      lastComment = null;
      continue;
    }

    doc.proseLines.push({ text: raw, line: lineNo });

    const comment = COMMENT_LINE.exec(raw);
    if (comment) {
      flushPara();
      lastComment = comment[1].trim();
      continue;
    }
    if (raw.trim() === "") {
      flushPara();
      continue;
    }

    for (const m of raw.matchAll(ANCHOR)) doc.anchors.add(m[1]);
    for (const m of raw.matchAll(/<details\b[^>]*>/gi)) doc.detailsTags.push({ tag: m[0], line: lineNo });
    const opens = (raw.match(/<details\b/gi) ?? []).length;
    const closes = (raw.match(/<\/details>/gi) ?? []).length;
    scanLinks(raw, lineNo, doc.links);

    const h = HEADING.exec(raw);
    if (h) {
      flushPara();
      lastComment = null;
      const text = headingText(h[2]);
      doc.headings.push({ level: h[1].length, text, slug: slugger.slug(text), line: lineNo });
      continue;
    }

    lastComment = null;
    const trimmed = raw.trim();
    const isTable = trimmed.startsWith("|");
    const isHtml = /^<\/?[a-zA-Z][^>]*>\s*$/.test(trimmed) || /^<\/?(details|summary|a|br|img|p|div)\b/i.test(trimmed);
    const inDetails = detailsDepth > 0 || opens > 0;
    detailsDepth = Math.max(0, detailsDepth + opens - closes);
    if (isTable || isHtml || inDetails) {
      flushPara();
      continue;
    }
    // A list item or blockquote line starts a new paragraph unit.
    const startsBlock = /^\s*([-*+]|\d+[.)])\s/.test(raw) || /^\s*>/.test(raw);
    if (startsBlock) flushPara();
    if (!para) para = { lines: [], line: lineNo };
    para.lines.push(trimmed.replace(/^>\s?/, "").replace(/^([-*+]|\d+[.)])\s+/, ""));
  }
  flushPara();
  return doc;
}

/** Every anchor a document exposes: heading slugs plus explicit `<a id>`. */
export function anchorsOf(doc: Doc): Set<string> {
  const all = new Set(doc.anchors);
  for (const h of doc.headings) all.add(h.slug);
  return all;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
