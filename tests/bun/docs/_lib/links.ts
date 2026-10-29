import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { repoRoot } from "./manifest";
import { anchorsOf, parse } from "./markdown";

const REPO_URL = /^https:\/\/github\.com\/jbearak\/raven\/(?:blob|tree)\/main\/([^?#]*)(?:\?[^#]*)?(#.*)?$/;
const RAW_URL = /^https:\/\/raw\.githubusercontent\.com\/jbearak\/raven\/(?:refs\/heads\/)?main\/([^?#]*)(#.*)?$/;

const anchorCache = new Map<string, Set<string>>();
function anchorsFor(repoPath: string): Set<string> {
  let a = anchorCache.get(repoPath);
  if (!a) {
    a = anchorsOf(parse(readFileSync(path.join(repoRoot, repoPath), "utf8")));
    anchorCache.set(repoPath, a);
  }
  return a;
}

/**
 * Check one link target written in `fromFile` (repo-relative). Returns an
 * error string, or null when the target resolves. External URLs other than
 * this repo's `main` branch are not checked.
 */
export function checkTarget(fromFile: string, target: string): string | null {
  let repoPath: string;
  let fragment = "";
  const repo = REPO_URL.exec(target) ?? RAW_URL.exec(target);
  if (repo) {
    repoPath = decodeURIComponent(repo[1]).replace(/\/$/, "");
    fragment = repo[2] ?? "";
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    return null;
  } else {
    const hash = target.indexOf("#");
    const p = hash >= 0 ? target.slice(0, hash) : target;
    fragment = hash >= 0 ? target.slice(hash) : "";
    const clean = decodeURIComponent(p.replace(/\?.*$/, ""));
    repoPath = clean === "" ? fromFile : path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), clean));
  }
  if (repoPath === "" || repoPath.startsWith("..")) return `${target}: resolves outside the repo`;
  const abs = path.join(repoRoot, repoPath);
  if (!existsSync(abs)) return `${target}: ${repoPath} does not exist`;
  if (fragment.length > 1 && repoPath.endsWith(".md") && statSync(abs).isFile()) {
    const slug = decodeURIComponent(fragment.slice(1));
    if (!anchorsFor(repoPath).has(slug)) return `${target}: no heading or <a id> "${slug}" in ${repoPath}`;
  }
  return null;
}

/** Repo URLs (`blob/main/...`) that appear anywhere in a non-Markdown source file. */
export function repoUrlsIn(source: string): string[] {
  return [...source.matchAll(/https:\/\/(?:github\.com\/jbearak\/raven\/(?:blob|tree)|raw\.githubusercontent\.com\/jbearak\/raven)\/main\/[^\s"'`)<>\]]+/g)].map(
    (m) => m[0].replace(/[.,;:]+$/, ""),
  )
    // Template strings in scripts (`${path}`) are not literal URLs.
    .filter((u) => !u.includes("${"));
}
