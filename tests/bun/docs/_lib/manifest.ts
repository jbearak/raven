import { readFileSync } from "node:fs";
import path from "node:path";

export const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");

export interface ManifestPage {
  file: string;
  title: string;
  kind: "guide" | "reference";
  description: string;
}

export interface Manifest {
  site_url: string;
  readmes: string[];
  internal: string[];
  groups: { title: string; pages: ManifestPage[] }[];
}

export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(path.join(repoRoot, "docs", "user-pages.json"), "utf8"));
}

/** Repo-relative paths of every manifest page (`docs/<file>`). */
export function userPagePaths(m: Manifest = loadManifest()): string[] {
  return m.groups.flatMap((g) => g.pages.map((p) => `docs/${p.file}`));
}

export function pageGroup(file: string, m: Manifest = loadManifest()): string | undefined {
  return m.groups.find((g) => g.pages.some((p) => `docs/${p.file}` === file))?.title;
}

export function pageKind(file: string, m: Manifest = loadManifest()): ManifestPage["kind"] | undefined {
  for (const g of m.groups) for (const p of g.pages) if (`docs/${p.file}` === file) return p.kind;
  return undefined;
}
