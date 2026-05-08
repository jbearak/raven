import { $ } from "bun";
import { test } from "bun:test";
import { join } from "node:path";

const VSCODE_DIR = join(import.meta.dir, "../../editors/vscode");

test(
  "workspace test suite",
  { timeout: 10 * 60 * 1000 },
  async () => {
    await $`cargo test -p raven`;
    await $`bun run test`.cwd(VSCODE_DIR);
  },
);
