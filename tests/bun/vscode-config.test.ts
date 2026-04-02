import { expect, test } from "bun:test";
import fs from "fs";
import path from "path";

import {
  getInitializationOptions,
  type RavenConfigurationInspection,
  type RavenWorkspaceConfiguration,
} from "../../editors/vscode/src/initializationOptions";

function createMockConfig(
  configuredSettings: Map<string, unknown>,
): RavenWorkspaceConfiguration {
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      const value = configuredSettings.get(key) as T | undefined;
      return value !== undefined ? value : defaultValue;
    },
    inspect<T>(key: string): RavenConfigurationInspection<T> | undefined {
      const value = configuredSettings.get(key);
      if (value !== undefined) {
        return {
          globalValue: value as T,
        };
      }
      return {};
    },
  };
}

test("initialization options keep diagnostics enabled by default", () => {
  const options = getInitializationOptions(createMockConfig(new Map()));
  expect(options.diagnostics).toEqual({ enabled: true });
});

test("initialization options forward explicitly configured settings", () => {
  const options = getInitializationOptions(
    createMockConfig(
      new Map<string, unknown>([
        ["crossFile.backwardDependencies", "explicit"],
        ["crossFile.maxChainDepth", 42],
        ["completion.triggerOnOpenParen", false],
        ["packages.additionalLibraryPaths", ["/tmp/libA", "/tmp/libB"]],
        ["indentation.style", "rstudio-minus"],
      ]),
    ),
  );

  expect(options.crossFile).toMatchObject({
    backwardDependencies: "explicit",
    maxChainDepth: 42,
  });
  expect(options.completion).toEqual({ triggerOnOpenParen: false });
  expect(options.packages).toEqual({
    additionalLibraryPaths: ["/tmp/libA", "/tmp/libB"],
  });
  expect(options.indentation).toEqual({ style: "rstudio-minus" });
});

test("VS Code package metadata registers mixed-case JAGS and Stan extensions", () => {
  const packageJsonPath = path.join(
    import.meta.dir,
    "..",
    "..",
    "editors",
    "vscode",
    "package.json",
  );
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const languages = pkg.contributes.languages as Array<{
    id: string;
    extensions: string[];
  }>;

  const jags = languages.find((language) => language.id === "jags");
  const stan = languages.find((language) => language.id === "stan");

  expect(jags?.extensions).toEqual([
    ".jags",
    ".Jags",
    ".JAGS",
    ".bugs",
    ".Bugs",
    ".BUGS",
  ]);
  expect(stan?.extensions).toEqual([".stan", ".Stan", ".STAN"]);
});

test("VS Code package metadata activates on JAGS and Stan languages", () => {
  const packageJsonPath = path.join(
    import.meta.dir,
    "..",
    "..",
    "editors",
    "vscode",
    "package.json",
  );
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

  expect(pkg.activationEvents).toContain("onLanguage:r");
  expect(pkg.activationEvents).toContain("onLanguage:jags");
  expect(pkg.activationEvents).toContain("onLanguage:stan");
});
