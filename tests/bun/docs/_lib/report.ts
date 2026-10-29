import { expect } from "bun:test";

/**
 * Assert a list of violations is empty. With DOCS_LINT_REPORT=1 (used only
 * locally while rewriting pages) violations are printed instead of failing.
 * CI never sets it.
 */
export function expectNoViolations(label: string, violations: string[]): void {
  if (process.env.DOCS_LINT_REPORT === "1") {
    if (violations.length) console.log(`\n[${label}] ${violations.length} violation(s)\n  ${violations.join("\n  ")}`);
    return;
  }
  expect(violations, label).toEqual([]);
}
