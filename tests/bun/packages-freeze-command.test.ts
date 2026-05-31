import { test, expect } from "bun:test";
import pkg from "../../editors/vscode/package.json";

test("freeze command is contributed in package.json", () => {
  const commands = (pkg.contributes?.commands ?? []) as Array<{ command: string; title: string }>;
  const freeze = commands.find((c) => c.command === "raven.packages.freeze");
  expect(freeze).toBeDefined();
  expect(freeze!.title).toContain("Generate Package Database");
});
