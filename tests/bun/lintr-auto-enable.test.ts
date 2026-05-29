import { expect, test } from "bun:test";

import {
  dotLintrAutoEnableAllowed,
  reditorSupportLintPathActive,
} from "../../editors/vscode/src/lintr-auto-enable";
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
        return { globalValue: value as T };
      }
      return undefined;
    },
  };
}

/** Minimal `r.*` config double matching `Pick<WorkspaceConfiguration, 'get'>`. */
function rConfig(values: Record<string, unknown>) {
  return {
    get<T>(key: string, fallback?: T): T | undefined {
      const v = values[key] as T | undefined;
      return v !== undefined ? v : fallback;
    },
  };
}

// --- reditorSupportLintPathActive -------------------------------------------

test("REditorSupport lint path is inactive when the extension is absent", () => {
  expect(reditorSupportLintPathActive(false, rConfig({}))).toBe(false);
});

test("REditorSupport lint path is active when installed with LSP defaults", () => {
  // r.lsp.enabled and r.lsp.diagnostics both default to true in REditorSupport.
  expect(reditorSupportLintPathActive(true, rConfig({}))).toBe(true);
});

test("REditorSupport lint path is inactive when r.lsp.diagnostics is off", () => {
  expect(
    reditorSupportLintPathActive(true, rConfig({ "lsp.diagnostics": false })),
  ).toBe(false);
});

test("REditorSupport lint path is inactive when r.lsp.enabled is off", () => {
  expect(
    reditorSupportLintPathActive(true, rConfig({ "lsp.enabled": false })),
  ).toBe(false);
});

// --- dotLintrAutoEnableAllowed ----------------------------------------------

test("a .lintr may auto-enable when neither REditorSupport nor Positron is active", () => {
  expect(dotLintrAutoEnableAllowed(false, false)).toBe(true);
});

test("a .lintr must not auto-enable when REditorSupport's lint path is live", () => {
  expect(dotLintrAutoEnableAllowed(true, false)).toBe(false);
});

test("a .lintr must not auto-enable inside Positron", () => {
  expect(dotLintrAutoEnableAllowed(false, true)).toBe(false);
});

// --- initialization options field -------------------------------------------

test("autoEnableFromDotLintr is included in linting when passed false", () => {
  const options = getInitializationOptions(createMockConfig(new Map()), false);
  expect(options.linting?.autoEnableFromDotLintr).toBe(false);
});

test("autoEnableFromDotLintr is included in linting when passed true", () => {
  const options = getInitializationOptions(createMockConfig(new Map()), true);
  expect(options.linting?.autoEnableFromDotLintr).toBe(true);
});

test("autoEnableFromDotLintr is omitted when the argument is not provided", () => {
  // Back-compat: the CLI / older callers omit the signal; the server then
  // defaults to allowing .lintr auto-enable.
  const options = getInitializationOptions(createMockConfig(new Map()));
  expect(options.linting).toBeDefined();
  expect("autoEnableFromDotLintr" in (options.linting ?? {})).toBe(false);
});
