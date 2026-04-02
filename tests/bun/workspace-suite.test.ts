import { $ } from "bun";
import { test } from "bun:test";

test(
  "workspace test suite",
  { timeout: 10 * 60 * 1000 },
  async () => {
    await $`cargo test -p raven`;
    await $`bun run test`.cwd("editors/vscode");
  },
);
