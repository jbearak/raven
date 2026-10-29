// Configuration snippets in the user docs must at least parse: JSON/JSONC
// (VS Code settings, possibly a fragment of key/value pairs), TOML
// (raven.toml), and Lua (Neovim, checked with `luac -p` when available).

import { describe, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadManifest, repoRoot, userPagePaths } from "./_lib/manifest";
import { parse } from "./_lib/markdown";
import { expectNoViolations } from "./_lib/report";

const manifest = loadManifest();
const files = [...manifest.readmes, ...userPagePaths(manifest)].filter((f) => existsSync(path.join(repoRoot, f)));
const hasLuac = spawnSync("luac", ["-v"]).status === 0;

// Strip line and block comments and trailing commas outside strings.
function jsoncToJson(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function jsonError(body: string): string | null {
  const text = jsoncToJson(body).trim();
  if (text === "") return null;
  for (const candidate of [text, `{${text.replace(/,\s*$/, "")}}`]) {
    try {
      JSON.parse(candidate);
      return null;
    } catch {}
  }
  try {
    JSON.parse(text);
  } catch (e) {
    return String(e);
  }
  return null;
}

describe("config snippets parse", () => {
  for (const file of files) {
    test(file, () => {
      const v: string[] = [];
      for (const f of parse(readFileSync(path.join(repoRoot, file), "utf8")).fences) {
        const lang = f.info.split(/\s+/)[0].toLowerCase();
        if (lang === "json" || lang === "jsonc") {
          const e = jsonError(f.body);
          if (e) v.push(`${file}:${f.line}: ${lang} block does not parse: ${e}`);
        } else if (lang === "toml") {
          try {
            Bun.TOML.parse(f.body);
          } catch (e) {
            v.push(`${file}:${f.line}: toml block does not parse: ${e}`);
          }
        } else if (lang === "lua" && hasLuac) {
          const dir = mkdtempSync(path.join(tmpdir(), "docs-lua-"));
          const p = path.join(dir, "snippet.lua");
          writeFileSync(p, f.body);
          const r = spawnSync("luac", ["-p", p], { encoding: "utf8" });
          if (r.status !== 0) v.push(`${file}:${f.line}: lua block does not parse: ${r.stderr.trim()}`);
        }
      }
      expectNoViolations("snippets", `snippets ${file}`, v);
    });
  }
});
