import { expect } from "bun:test";

/**
 * Docs checks that the in-progress docs rewrite has not yet satisfied. A
 * check whose category is listed here prints its violations instead of
 * failing, in CI as well as locally, so the branch stays green while pages
 * are rewritten. Removing a category makes it gating. The redesign ends with
 * this set empty (docs/superpowers/plans/2026-10-29-docs-redesign-plan.md).
 *
 * Categories: "lints" (style and template), "examples" (doc/corpus binding
 * and unmarked CLI output), "hub" (hub coverage), "readme-parity",
 * "images" (image alt text).
 */
export const PENDING = new Set<string>([]);

/**
 * Assert a list of violations is empty, unless its category is pending.
 * `DOCS_LINT_REPORT=1` forces report mode for every category, for local
 * triage only.
 */
export function expectNoViolations(category: string, label: string, violations: string[]): void {
  if (PENDING.has(category) || process.env.DOCS_LINT_REPORT === "1") {
    if (violations.length) console.log(`\n[${label}] ${violations.length} violation(s)\n  ${violations.join("\n  ")}`);
    return;
  }
  expect(violations, label).toEqual([]);
}
