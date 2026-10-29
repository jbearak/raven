// GitHub-compatible heading slugs, matching github-slugger (the algorithm
// github.com uses for Markdown heading anchors): lowercase, drop every
// character that isn't a letter, number, mark, `_`, `-`, or space, then turn
// each space into `-`. Repeated slugs in one document get `-1`, `-2`, ...

const STRIP = /[^\p{L}\p{M}\p{N}\p{Pc} -]/gu;

/** Slug for one heading's plain text, ignoring duplicates. */
export function slugify(text: string): string {
  return text.toLowerCase().replace(STRIP, "").replace(/ /g, "-");
}

/** Stateful slugger that applies GitHub's duplicate suffixes. */
export class Slugger {
  private occurrences = new Map<string, number>();

  // Mirrors github-slugger's `BananaSlug.slug`.
  slug(text: string): string {
    const original = slugify(text);
    let result = original;
    while (this.occurrences.has(result)) {
      const n = (this.occurrences.get(original) ?? 0) + 1;
      this.occurrences.set(original, n);
      result = `${original}-${n}`;
    }
    this.occurrences.set(result, 0);
    return result;
  }
}

/**
 * Reduce a heading's inline Markdown to the text GitHub slugs: code spans
 * keep their content, links and images keep their text, emphasis markers and
 * HTML tags are dropped.
 */
export function headingText(inline: string): string {
  return inline
    .replace(/<[^>]+>/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .trim();
}
