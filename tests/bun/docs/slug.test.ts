import { describe, expect, test } from "bun:test";

import { anchorsOf, parse } from "./_lib/markdown";
import { headingText, Slugger, slugify } from "./_lib/slug";

// Expected values are the anchors github.com generates for these headings.
describe("GitHub slugs", () => {
  const cases: [string, string][] = [
    ["Quick Reference", "quick-reference"],
    ["Per-line `# raven: ignore`", "per-line--raven-ignore"],
    ["`raven check` & friends: exit codes (v2)", "raven-check--friends-exit-codes-v2"],
    ["Namespace member references (`pkg::member`)", "namespace-member-references-pkgmember"],
    [".Rprofile Startup Prelude", "rprofile-startup-prelude"],
    ["R/ and tests/ visibility", "r-and-tests-visibility"],
    ["snake_case names", "snake_case-names"],
    ["Café — déjà vu", "café--déjà-vu"],
    ["Why Raven exists 🐦", "why-raven-exists-"],
  ];
  for (const [heading, slug] of cases) {
    test(heading, () => expect(slugify(headingText(heading))).toBe(slug));
  }

  test("links and emphasis keep their text", () => {
    expect(slugify(headingText("See [the **CLI**](cli.md) _now_"))).toBe("see-the-cli-now");
  });

  test("duplicates get -1, -2 like github-slugger", () => {
    const s = new Slugger();
    expect([s.slug("Usage"), s.slug("Usage"), s.slug("Usage-1"), s.slug("Usage")]).toEqual([
      "usage",
      "usage-1",
      "usage-1-1",
      "usage-2",
    ]);
  });

  test("parse exposes explicit anchors and ignores headings in fences", () => {
    const doc = parse('# Title\n\n<a id="old-name"></a>\n\n```md\n## Not a heading\n```\n\n## Real\n');
    expect([...anchorsOf(doc)].sort()).toEqual(["old-name", "real", "title"]);
  });
});
