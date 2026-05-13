# R Snippets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 65 R code snippets as a pure declarative VS Code contribution (snippets JSON + `package.json` registration + a structural test suite + README bullet), satisfying GitHub issue #204.

**Architecture:** One snippets JSON file at `editors/vscode/snippets/r.json` registered under the `r` language ID in `editors/vscode/package.json`. A new Mocha test file at `editors/vscode/src/test/snippets.test.ts` performs structural and placeholder-grammar validation. No Rust, no TypeScript runtime, no LSP changes. See `docs/superpowers/specs/2026-05-12-r-snippets-design.md` for the full design rationale.

**Tech Stack:** Pure JSON; TypeScript Mocha test running in the existing `vscode-test` harness; `assert` for assertions; node `fs`/`path` for file I/O.

---

## File Structure

Files created or modified by this plan:

```text
editors/vscode/
├── snippets/
│   └── r.json                                # NEW — the 65 snippets
├── package.json                              # MODIFY — add contributes.snippets
└── src/test/
    └── snippets.test.ts                      # NEW — structural + grammar validation

editors/vscode/README.md                      # MODIFY — add Snippets bullet under Code intelligence

docs/superpowers/plans/
└── 2026-05-12-r-snippets.md                  # THIS PLAN
```

Each file has one responsibility:
- `r.json` — snippet definitions (single source of truth for what ships).
- `package.json` — VS Code contribution declaration.
- `snippets.test.ts` — guarantees the JSON file is well-formed, prefixes are unique, placeholder syntax is valid, and the registration in `package.json` points at an existing file.
- `README.md` — one-line user-facing mention so the feature is discoverable.

---

## Task 1: Scaffold the snippets directory and registration

**Files:**
- Create: `editors/vscode/snippets/r.json`
- Modify: `editors/vscode/package.json` (insert `contributes.snippets` between `contributes.grammars` and `contributes.configurationDefaults`)

- [ ] **Step 1: Create the snippets directory and empty JSON skeleton**

Create `editors/vscode/snippets/r.json` with an empty object so it's valid JSON but contains no snippets yet (this lets the upcoming test fail meaningfully on "no snippets defined"):

```json
{}
```

- [ ] **Step 2: Register the snippets file in `package.json`**

Open `editors/vscode/package.json`. Locate the `contributes.grammars` array (currently around line 251–262, containing the `jags` and `stan` grammars). Insert a new `snippets` key directly after `grammars`. The block must look like this:

```json
    "snippets": [
      {
        "language": "r",
        "path": "./snippets/r.json"
      }
    ],
```

It belongs between the closing `]` of `grammars` and the start of `configurationDefaults`. Do not change any other key.

- [ ] **Step 3: Verify the package.json is still valid JSON and the build still works**

Run from `editors/vscode/`:

```bash
bun run typecheck
```

Expected: TypeScript compilation succeeds (no errors). Snippet JSON is not parsed by TypeScript, so this only validates the existing TS surface still compiles.

Run:

```bash
node -e "JSON.parse(require('fs').readFileSync('editors/vscode/package.json', 'utf8'))" && echo "package.json OK"
node -e "JSON.parse(require('fs').readFileSync('editors/vscode/snippets/r.json', 'utf8'))" && echo "r.json OK"
```

Expected: both `OK` lines printed, no parse errors.

- [ ] **Step 4: Commit the scaffold**

```bash
git add editors/vscode/snippets/r.json editors/vscode/package.json
git commit -m "feat(vscode): scaffold R snippets contribution (#204)"
```

---

## Task 2: Write the structural and placeholder-grammar test suite

This task creates the test file *before* the snippet content is populated. Running the suite at the end of this task will mostly pass (empty object satisfies most checks) but fail on the "at least one snippet" assertion, which is our TDD failing test. Task 4 turns it green.

**Files:**
- Create: `editors/vscode/src/test/snippets.test.ts`

- [ ] **Step 1: Write the failing test**

Create `editors/vscode/src/test/snippets.test.ts` with the following exact contents. The test reads from the built layout (`out/test/`); `path.resolve(__dirname, '..', '..')` walks back to `editors/vscode/`, the same pattern `helper.ts` uses.

```typescript
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Structural and placeholder-grammar tests for the R snippets file.
 *
 * Pure file/JSON assertions — no `vscode` API needed beyond the harness.
 * Validates: JSON parses, every entry has the right shape, prefixes are
 * unique, placeholder syntax is well-formed, and package.json's
 * `contributes.snippets` points at the on-disk file.
 *
 * We intentionally do NOT snapshot exact body strings or assert a hard
 * count — both make routine edits churn-y without catching real bugs.
 */

// Mocha globals available in the vscode-test harness.
declare const suite: Mocha.SuiteFunction;
declare const test: Mocha.TestFunction;

// __dirname at runtime is editors/vscode/out/test. Walk back to editors/vscode/.
const vscodeRoot = path.resolve(__dirname, '..', '..');
const snippetsRelativePath = './snippets/r.json';
const snippetsAbsolutePath = path.join(vscodeRoot, 'snippets', 'r.json');
const packageJsonPath = path.join(vscodeRoot, 'package.json');

interface SnippetEntry {
    prefix: string;
    body: string | string[];
    description: string;
}

function loadSnippets(): Record<string, SnippetEntry> {
    const raw = fs.readFileSync(snippetsAbsolutePath, 'utf8');
    return JSON.parse(raw) as Record<string, SnippetEntry>;
}

function loadPackageJson(): Record<string, unknown> {
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
}

function bodyToString(body: string | string[]): string {
    return Array.isArray(body) ? body.join('\n') : body;
}

suite('R snippets', () => {
    test('snippets file parses as JSON', () => {
        assert.doesNotThrow(() => loadSnippets(), 'r.json must be valid JSON');
    });

    test('contains at least one snippet', () => {
        const snippets = loadSnippets();
        assert.ok(
            Object.keys(snippets).length > 0,
            'r.json must define at least one snippet',
        );
    });

    test('every snippet has required fields with correct types', () => {
        const snippets = loadSnippets();
        for (const [name, entry] of Object.entries(snippets)) {
            assert.ok(
                typeof entry.prefix === 'string' && entry.prefix.length > 0,
                `Snippet "${name}" must have a non-empty string prefix`,
            );
            const bodyIsString = typeof entry.body === 'string';
            const bodyIsStringArray = Array.isArray(entry.body)
                && entry.body.every((line) => typeof line === 'string');
            assert.ok(
                bodyIsString || bodyIsStringArray,
                `Snippet "${name}" body must be a string or array of strings`,
            );
            assert.ok(
                typeof entry.description === 'string' && entry.description.length > 0,
                `Snippet "${name}" must have a non-empty string description`,
            );
        }
    });

    test('prefixes are unique across all snippets', () => {
        const snippets = loadSnippets();
        const seen = new Map<string, string>(); // prefix -> first snippet name
        for (const [name, entry] of Object.entries(snippets)) {
            const prior = seen.get(entry.prefix);
            assert.ok(
                prior === undefined,
                `Prefix "${entry.prefix}" is used by both "${prior}" and "${name}" — `
                + 'duplicates silently overwrite each other in VS Code',
            );
            seen.set(entry.prefix, name);
        }
    });

    test('placeholder grammar is well-formed in every snippet body', () => {
        const snippets = loadSnippets();
        // Matches:
        //   ${N}          (placeholder, no default)
        //   ${N:default}  (placeholder with default — default may contain
        //                   nested ${...} for recursive snippets)
        //   $N            (bare tab stop)
        // We use a permissive matcher then validate balance separately.
        const tabStopPattern = /\$\{(\d+)(?::([^}]*))?\}|\$(\d+)/g;

        for (const [name, entry] of Object.entries(snippets)) {
            const body = bodyToString(entry.body);

            // 1. No unterminated `${` — count must balance.
            const openCount = (body.match(/\$\{/g) || []).length;
            const closeAfterOpen = countBalancedClosers(body);
            assert.strictEqual(
                openCount,
                closeAfterOpen,
                `Snippet "${name}" has unbalanced \${...} placeholders`,
            );

            // 2. Collect tab-stop numbers found in the body.
            const tabStopNumbers: number[] = [];
            let match: RegExpExecArray | null;
            tabStopPattern.lastIndex = 0;
            while ((match = tabStopPattern.exec(body)) !== null) {
                const numStr = match[1] ?? match[3];
                if (numStr !== undefined) {
                    tabStopNumbers.push(parseInt(numStr, 10));
                }
            }

            // 3. At most one ${0} (or $0). Zero is allowed (cursor lands at body end).
            const zeroCount = tabStopNumbers.filter((n) => n === 0).length;
            assert.ok(
                zeroCount <= 1,
                `Snippet "${name}" has ${zeroCount} \${0} placeholders — at most one is allowed`,
            );

            // 4. No duplicate non-zero tab-stop numbers within one snippet.
            const nonZero = tabStopNumbers.filter((n) => n !== 0);
            const duplicates = nonZero.filter((n, i) => nonZero.indexOf(n) !== i);
            assert.deepStrictEqual(
                duplicates,
                [],
                `Snippet "${name}" has duplicate tab-stop numbers: ${[...new Set(duplicates)].join(', ')}`,
            );
        }
    });

    test('package.json registers the snippets file under the r language', () => {
        const pkg = loadPackageJson();
        const contributes = pkg.contributes as Record<string, unknown> | undefined;
        assert.ok(contributes, 'package.json must have a contributes section');
        const snippetEntries = contributes.snippets as Array<{ language?: string; path?: string }> | undefined;
        assert.ok(
            Array.isArray(snippetEntries),
            'package.json contributes.snippets must be an array',
        );
        const rEntries = snippetEntries.filter((e) => e.language === 'r');
        assert.strictEqual(
            rEntries.length,
            1,
            'Exactly one snippet entry must be registered for language "r"',
        );
        assert.strictEqual(
            rEntries[0].path,
            snippetsRelativePath,
            `R snippet entry must point at ${snippetsRelativePath}`,
        );
    });

    test('registered snippets path resolves to an existing file', () => {
        const pkg = loadPackageJson();
        const contributes = pkg.contributes as Record<string, unknown>;
        const snippetEntries = contributes.snippets as Array<{ language: string; path: string }>;
        const rEntry = snippetEntries.find((e) => e.language === 'r');
        assert.ok(rEntry, 'No snippet entry found for r language');
        // Path in package.json is relative to the extension root, which is vscodeRoot.
        const resolvedPath = path.resolve(vscodeRoot, rEntry.path);
        assert.ok(
            fs.existsSync(resolvedPath),
            `Registered snippets file does not exist on disk: ${resolvedPath}`,
        );
    });
});

/**
 * Count how many `${` openers in the body are matched by a `}` that
 * also closes the placeholder (skipping `{` and `}` that appear inside
 * a default value as part of nested `${...}`). This is a simple state
 * machine — VS Code's snippet engine itself is recursive, but for our
 * "are placeholders balanced?" check we only need to know the opener
 * count matches the corresponding closer count at the same depth.
 */
function countBalancedClosers(body: string): number {
    let depth = 0;
    let matched = 0;
    for (let i = 0; i < body.length; i++) {
        if (body[i] === '$' && body[i + 1] === '{') {
            depth++;
            i++; // skip the '{'
        } else if (body[i] === '}' && depth > 0) {
            depth--;
            matched++;
        }
    }
    return matched;
}
```

- [ ] **Step 2: Compile the tests**

Run from `editors/vscode/`:

```bash
bun run compile:test
```

Expected: TypeScript compiles cleanly, producing `out/test/snippets.test.js`. If you see "Cannot find name 'Mocha'", the `Mocha.SuiteFunction` typing is already provided by `@types/mocha` which is a devDependency in `package.json`. If the compile fails for another reason, fix and re-run.

- [ ] **Step 3: Run the test suite and watch it fail**

Run from `editors/vscode/`:

```bash
bun run test
```

Expected: the `R snippets` suite runs. The `parses as JSON`, `every snippet has required fields`, `prefixes are unique`, `placeholder grammar`, `package.json registers`, and `registered snippets path resolves` tests should all PASS (the empty `{}` is valid JSON with zero entries; the registration is in place; the file exists). The `contains at least one snippet` test should FAIL with `r.json must define at least one snippet`. This is our TDD failing test — Task 4 will turn it green.

- [ ] **Step 4: Commit the test scaffold**

```bash
git add editors/vscode/src/test/snippets.test.ts
git commit -m "test(vscode): add structural + grammar validation for R snippets (#204)"
```

---

## Task 3: Populate `r.json` with all 65 snippets

This is one task — not eleven — because there's no logic per category; it's all static JSON. Splitting would just churn commits without providing meaningful checkpoints.

**Files:**
- Modify: `editors/vscode/snippets/r.json`

- [ ] **Step 1: Replace `r.json` contents with the full snippet set**

Open `editors/vscode/snippets/r.json` and replace its contents (currently `{}`) with the following. Each key is the snippet name (used internally by VS Code); `prefix` is the trigger; `body` is the expansion (array of strings, one per line); `description` is the popup label.

Note JSON escaping rules: `\n` becomes a newline, `\t` becomes a tab, `\\` is a literal backslash, `\"` is a literal quote, `$` is literal `$` (no escaping needed in JSON, but `${N:default}` placeholders embed literally).

```json
{
  "if": {
    "prefix": "if",
    "body": ["if (${1:condition}) {", "\t${0}", "}"],
    "description": "if block"
  },
  "if-else": {
    "prefix": "ife",
    "body": ["if (${1:condition}) {", "\t${2}", "} else {", "\t${0}", "}"],
    "description": "if/else block"
  },
  "else-if": {
    "prefix": "el",
    "body": ["else if (${1:condition}) {", "\t${0}", "}"],
    "description": "else if chain (after a closing brace)"
  },
  "for": {
    "prefix": "for",
    "body": ["for (${1:i} in ${2:seq_along(${3:x})}) {", "\t${0}", "}"],
    "description": "for loop"
  },
  "while": {
    "prefix": "while",
    "body": ["while (${1:condition}) {", "\t${0}", "}"],
    "description": "while loop"
  },
  "repeat": {
    "prefix": "repeat",
    "body": ["repeat {", "\t${1}", "\tif (${2:condition}) break", "}"],
    "description": "repeat/break loop"
  },
  "switch": {
    "prefix": "switch",
    "body": ["switch(${1:expr},", "\t${2:case1} = ${3},", "\t${0:default}", ")"],
    "description": "switch expression"
  },
  "trycatch": {
    "prefix": "trycatch",
    "body": ["tryCatch(", "\t${1:expr},", "\terror = function(e) ${0:NULL}", ")"],
    "description": "tryCatch block"
  },
  "withCallingHandlers": {
    "prefix": "wch",
    "body": ["withCallingHandlers(", "\t${1:expr},", "\twarning = function(w) ${0}", ")"],
    "description": "withCallingHandlers"
  },

  "function": {
    "prefix": "fun",
    "body": ["${1:name} <- function(${2:args}) {", "\t${0}", "}"],
    "description": "Function definition"
  },
  "lambda": {
    "prefix": "lam",
    "body": "\\(${1:x}) ${0}",
    "description": "Anonymous lambda (R >= 4.1)"
  },
  "lapply": {
    "prefix": "lapply",
    "body": "lapply(${1:x}, function(${2:el}) ${0})",
    "description": "lapply over list"
  },
  "sapply": {
    "prefix": "sapply",
    "body": "sapply(${1:x}, function(${2:el}) ${0})",
    "description": "sapply over list"
  },
  "vapply": {
    "prefix": "vapply",
    "body": "vapply(${1:x}, function(${2:el}) ${3}, ${0:character(1)})",
    "description": "vapply (type-safe)"
  },
  "mapply": {
    "prefix": "mapply",
    "body": "mapply(function(${1:a}, ${2:b}) ${3}, ${4:x}, ${0:y})",
    "description": "mapply multi-arg"
  },
  "apply": {
    "prefix": "apply",
    "body": "apply(${1:X}, ${2:MARGIN}, ${0:FUN})",
    "description": "apply over matrix"
  },
  "do.call": {
    "prefix": "docall",
    "body": "do.call(${1:what}, ${0:args})",
    "description": "do.call"
  },

  "Map": {
    "prefix": "Map",
    "body": "Map(function(${1:a}, ${2:b}) ${3}, ${4:x}, ${0:y})",
    "description": "Map over multiple"
  },
  "Reduce": {
    "prefix": "Reduce",
    "body": "Reduce(function(${1:acc}, ${2:x}) ${3}, ${4:x}, ${0:init})",
    "description": "Reduce to scalar"
  },
  "Filter": {
    "prefix": "Filter",
    "body": "Filter(function(${1:x}) ${2}, ${0:x})",
    "description": "Filter by predicate"
  },

  "data.frame": {
    "prefix": "df",
    "body": ["data.frame(", "\t${1:col1} = ${2},", "\t${0}", ")"],
    "description": "data.frame"
  },
  "list": {
    "prefix": "lst",
    "body": ["list(", "\t${1:name} = ${2},", "\t${0}", ")"],
    "description": "Named list"
  },
  "matrix": {
    "prefix": "mat",
    "body": "matrix(${1:data}, nrow = ${2}, ncol = ${3})${0}",
    "description": "matrix"
  },
  "vector": {
    "prefix": "vec",
    "body": "c(${0})",
    "description": "c() vector"
  },
  "seq": {
    "prefix": "seq",
    "body": "seq(${1:from}, ${2:to}, by = ${3:1})${0}",
    "description": "seq()"
  },
  "seq_along": {
    "prefix": "seq_along",
    "body": "seq_along(${0:x})",
    "description": "seq_along(x)"
  },
  "seq_len": {
    "prefix": "seq_len",
    "body": "seq_len(${0:n})",
    "description": "seq_len(n)"
  },
  "rep": {
    "prefix": "rep",
    "body": "rep(${1:x}, ${2:times})${0}",
    "description": "rep()"
  },

  "pipe": {
    "prefix": "pipe",
    "body": "|> ${0}",
    "description": "Native pipe |>"
  },
  "magrittr": {
    "prefix": "magrittr",
    "body": "%>% ${0}",
    "description": "Magrittr pipe %>%"
  },

  "read.csv": {
    "prefix": "readcsv",
    "body": "read.csv(${0:\"path.csv\"})",
    "description": "read.csv"
  },
  "write.csv": {
    "prefix": "writecsv",
    "body": "write.csv(${1:x}, ${2:\"path.csv\"}, row.names = ${3:FALSE})${0}",
    "description": "write.csv"
  },
  "readRDS": {
    "prefix": "readrds",
    "body": "readRDS(${0:\"path.rds\"})",
    "description": "readRDS"
  },
  "saveRDS": {
    "prefix": "saverds",
    "body": "saveRDS(${1:object}, ${2:\"path.rds\"})${0}",
    "description": "saveRDS"
  },
  "source": {
    "prefix": "source",
    "body": "source(${0:\"path.R\"})",
    "description": "source() call"
  },
  "library": {
    "prefix": "lib",
    "body": "library(${0:pkg})",
    "description": "library call"
  },
  "require": {
    "prefix": "req",
    "body": "require(${0:pkg})",
    "description": "require call"
  },

  "cat": {
    "prefix": "cat",
    "body": "cat(${1:...}, sep = ${2:\"\\n\"})${0}",
    "description": "cat"
  },
  "print": {
    "prefix": "print",
    "body": "print(${0:x})",
    "description": "print"
  },
  "paste": {
    "prefix": "paste",
    "body": "paste(${1:...}, sep = ${2:\" \"})${0}",
    "description": "paste"
  },
  "paste0": {
    "prefix": "paste0",
    "body": "paste0(${0:...})",
    "description": "paste0"
  },
  "sprintf": {
    "prefix": "sprintf",
    "body": "sprintf(${1:\"%s\"}, ${0:args})",
    "description": "sprintf"
  },
  "message": {
    "prefix": "msg",
    "body": "message(${0:\"...\"})",
    "description": "message"
  },
  "warning": {
    "prefix": "warn",
    "body": "warning(${0:\"...\"})",
    "description": "warning"
  },
  "stop": {
    "prefix": "stop",
    "body": "stop(${0:\"...\"})",
    "description": "stop"
  },

  "plot": {
    "prefix": "plot",
    "body": "plot(${1:x}, ${2:y})${0}",
    "description": "Base plot"
  },
  "ggplot": {
    "prefix": "ggplot",
    "body": ["ggplot(${1:data}, aes(x = ${2}, y = ${3})) +", "\t${0}"],
    "description": "ggplot scaffold"
  },
  "geom_point": {
    "prefix": "geom_point",
    "body": "geom_point(${0})",
    "description": "geom_point()"
  },
  "geom_line": {
    "prefix": "geom_line",
    "body": "geom_line(${0})",
    "description": "geom_line()"
  },
  "geom_bar": {
    "prefix": "geom_bar",
    "body": "geom_bar(${0})",
    "description": "geom_bar()"
  },

  "lm": {
    "prefix": "lm",
    "body": "lm(${1:y} ~ ${2:x}, data = ${3:df})${0}",
    "description": "Linear model"
  },
  "glm": {
    "prefix": "glm",
    "body": "glm(${1:y} ~ ${2:x}, data = ${3:df}, family = ${4:gaussian()})${0}",
    "description": "Generalized linear model"
  },
  "loess": {
    "prefix": "loess",
    "body": "loess(${1:y} ~ ${2:x}, data = ${3:df})${0}",
    "description": "Local regression"
  },

  "roxygen-block": {
    "prefix": "rox",
    "body": [
      "#' ${1:Title}",
      "#'",
      "#' ${2:Description}",
      "#'",
      "#' @param ${3:name} ${4:description}",
      "#' @return ${5:return value}",
      "#' @export",
      "#'",
      "#' @examples",
      "#' ${0:example}"
    ],
    "description": "Full roxygen block"
  },
  "roxygen-param": {
    "prefix": "@param",
    "body": "@param ${1:name} ${0:description}",
    "description": "@param name desc"
  },
  "roxygen-return": {
    "prefix": "@return",
    "body": "@return ${0:description}",
    "description": "@return desc"
  },
  "roxygen-export": {
    "prefix": "@export",
    "body": "@export",
    "description": "@export tag"
  },
  "roxygen-title": {
    "prefix": "@title",
    "body": "@title ${0:title}",
    "description": "@title desc"
  },
  "roxygen-description": {
    "prefix": "@description",
    "body": "@description ${0:description}",
    "description": "@description desc"
  },
  "roxygen-examples": {
    "prefix": "@examples",
    "body": ["@examples", "#' ${0:example}"],
    "description": "@examples block"
  },
  "roxygen-inheritParams": {
    "prefix": "@inheritParams",
    "body": "@inheritParams ${0:source_fun}",
    "description": "@inheritParams source"
  },
  "roxygen-seealso": {
    "prefix": "@seealso",
    "body": "@seealso \\code{\\link{${0:fun}}}",
    "description": "@seealso link"
  },
  "roxygen-noRd": {
    "prefix": "@noRd",
    "body": "@noRd",
    "description": "@noRd tag"
  },

  "test_that": {
    "prefix": "tc",
    "body": ["test_that(\"${1:description}\", {", "\t${0}", "})"],
    "description": "test_that block"
  },
  "load_all": {
    "prefix": "loadall",
    "body": "devtools::load_all(${0})",
    "description": "devtools::load_all()"
  }
}
```

- [ ] **Step 2: Verify the JSON parses**

```bash
node -e "const s = JSON.parse(require('fs').readFileSync('editors/vscode/snippets/r.json', 'utf8')); console.log('snippet count:', Object.keys(s).length)"
```

Expected: `snippet count: 65`. If you get a JSON parse error, recheck the file — common mistakes are missing commas between entries or unescaped quotes inside body strings.

- [ ] **Step 3: Re-run the test suite**

Run from `editors/vscode/`:

```bash
bun run compile:test && bun run test
```

Expected: ALL tests in the `R snippets` suite pass — including the `contains at least one snippet` test that was failing. If anything else fails:
- A `placeholder grammar` failure points to a malformed `${...}` or duplicate tab-stop number — fix it in the snippet's body.
- A `prefixes are unique` failure means you have two snippets with the same `prefix` value — rename one.
- A `every snippet has required fields` failure points to a missing or wrong-typed `prefix`/`body`/`description`.

- [ ] **Step 4: Commit the snippet content**

```bash
git add editors/vscode/snippets/r.json
git commit -m "feat(vscode): add 65 R code snippets (#204)"
```

---

## Task 4: Update the README

**Files:**
- Modify: `editors/vscode/README.md`

- [ ] **Step 1: Add a Snippets bullet to the Code intelligence section**

Open `editors/vscode/README.md`. Locate the **Code intelligence** section (currently around lines 13–26). Find the existing bullet `- **Smart indentation** — Context-aware auto-indent with RStudio-style alignment` and insert a new bullet **after** it, but **before** `- **[Cross-file awareness]**`. The new bullet:

```markdown
- **Snippets** — Built-in snippets for common R patterns (control flow, apply family, ggplot2 scaffolds, roxygen2 tags)
```

The result should look like:

```markdown
- **[Smart indentation](https://github.com/jbearak/raven/blob/main/docs/indentation.md)** — Context-aware auto-indent with RStudio-style alignment
- **Snippets** — Built-in snippets for common R patterns (control flow, apply family, ggplot2 scaffolds, roxygen2 tags)
- **[Cross-file awareness](https://github.com/jbearak/raven/blob/main/docs/cross-file.md)** — Follows `source()` chains to resolve scope across files
```

Note: no separate `docs/snippets.md` page — the spec is explicit that the snippets file itself is the source of truth and VS Code's completion popup is the discovery surface.

- [ ] **Step 2: Commit the README update**

```bash
git add editors/vscode/README.md
git commit -m "docs(vscode): mention R snippets in feature list (#204)"
```

---

## Task 5: Manual verification

This step opens the VS Code Extension Development Host to confirm snippets actually appear and expand as expected. Automated tests cover structure but not the actual completion UX.

**Files:**
- None modified.

- [ ] **Step 1: Build and launch the Extension Development Host**

Run from `editors/vscode/`:

```bash
bun run compile
```

Expected: bundle succeeds, producing `dist/extension.js`. Then in VS Code, open the `editors/vscode` folder and press F5 (or run "Debug: Start Debugging" from the command palette). A new VS Code window labeled `[Extension Development Host]` opens with the Raven extension loaded.

- [ ] **Step 2: Open or create a `.R` file and test each category**

In the Extension Development Host window, create a new file `scratch.R` (or open any existing `.R` file). For each of the following triggers, type the trigger, observe that it appears in the completion popup with the description, press Tab/Enter, and confirm the expansion lands the cursor at the expected `${0}` position (or end of expression):

Triggers to spot-check (one per category):
- `if` → `if (condition) { … }`
- `fun` → `name <- function(args) { … }`
- `Map` → `Map(function(a, b) …, x, y)`
- `df` → `data.frame(col1 = …, …)`
- `pipe` → `|>` followed by a trailing space and cursor
- `source` → `source("path.R")`
- `cat` → `cat(..., sep = "\n")`
- `ggplot` → `ggplot(data, aes(x = , y = )) + …`
- `lm` → `lm(y ~ x, data = df)`
- `rox` → multi-line roxygen block with `#'` lines and proper tab stops
- `@param` → `@param name description`
- `tc` → `test_that("description", { … })`

If any expansion looks wrong (cursor in the wrong place, malformed body, missing tab-stops), trace it to the corresponding entry in `r.json`, fix, recompile, reload the Extension Development Host (Cmd+R / Ctrl+R in that window), and re-test.

- [ ] **Step 3: Sanity-check in a `.qmd` or `.rmd` file**

In the same Extension Development Host window, create `scratch.qmd` and confirm typing `if` shows the snippet (this verifies the spec's stated behavior that plain-R snippets surface in shared-language-ID files; it's expected and acceptable).

- [ ] **Step 4: Close the Extension Development Host, no commit needed**

Manual verification produces no new file changes. If you found and fixed bugs in r.json during this step, those edits should have already been committed with an amendment or a follow-up `fix:` commit. Confirm `git status` is clean:

```bash
git status
```

Expected: `nothing to commit, working tree clean`.

---

## Task 6: Push the branch and open the PR

**Files:**
- None modified.

- [ ] **Step 1: Verify the full test suite passes once more**

Run from `editors/vscode/`:

```bash
bun run typecheck && bun run test
```

Expected: typecheck succeeds; the vscode-test harness runs and all tests pass, including the `R snippets` suite. If anything fails, fix and commit before pushing.

- [ ] **Step 2: Push the branch to origin**

```bash
git push -u origin feat/r-snippets
```

Expected: branch published; remote tracking set.

- [ ] **Step 3: Open the PR**

Run:

```bash
gh pr create --title "feat(vscode): add R code snippets (#204)" --body "$(cat <<'EOF'
## Summary

- Ship 65 R code snippets as a pure declarative VS Code contribution, addressing #204.
- Snippet file at \`editors/vscode/snippets/r.json\` registered under the \`r\` language ID.
- New structural + placeholder-grammar test suite at \`editors/vscode/src/test/snippets.test.ts\`.
- Updated extension README's Code intelligence section with a snippets bullet.

The set is a **curated subset** of vscode-R's snippets — not strict parity. We omit one-call snippets whose triggers are nearly the same length as the function name (\`factor\`, \`merge\`, \`mean\`, etc.); they add menu clutter without saving keystrokes. Shiny scaffolds are deferred until there's clear demand. R Markdown / Quarto chunk snippets are deferred to #209.

Design spec: \`docs/superpowers/specs/2026-05-12-r-snippets-design.md\`.

## Test plan

- [x] \`bun run typecheck\` passes
- [x] \`bun run test\` passes, including the new \`R snippets\` suite
- [x] Manual verification in Extension Development Host: typed each category's representative trigger in an \`.R\` file, observed completion popup, expanded with Tab, cursor landed in the expected place
- [x] Sanity check in a \`.qmd\` file confirmed plain-R snippets surface there too (expected, see spec)
EOF
)"
```

Expected: `gh` prints the PR URL. Report the URL to the user.

---

## Self-Review

After writing this plan I checked it against the spec at `docs/superpowers/specs/2026-05-12-r-snippets-design.md`:

**Spec coverage:**
- Snippets file at `editors/vscode/snippets/r.json` → Task 1, Task 3
- `package.json` registration under `r` language → Task 1
- 65 snippets across 11 categories → Task 3 (full content listed inline)
- Style conventions (tab placeholders, `${0}` at end) → Task 3 (bodies follow the spec exactly)
- Conflict acknowledgment (function-name triggers intentional) → no code change needed; spec documents the rationale
- Coexistence with vscode-R → no code change needed; spec documents
- Test plan (parse, fields, unique prefixes, placeholder grammar, package.json wiring, file exists) → Task 2 (all six assertions implemented)
- README bullet → Task 4
- Manual verification → Task 5
- PR → Task 6
- "Out of scope" items (Rmd chunks, customization UI, LSP completions, auto-trigger) → not addressed, which is the right behavior

**Placeholder scan:** No TBDs, TODOs, "implement later", or hand-wavy steps. Every step has an exact command or exact code block.

**Type consistency:** The `SnippetEntry` interface in Task 2 matches the JSON shape produced in Task 3. The test's `rEntry.path` comparison against `snippetsRelativePath` matches the value inserted into `package.json` in Task 1.

**Risks worth flagging to the implementer:**
- JSON escaping in `r.json` bodies is the most common slip — `\n` and `\t` are literal escape sequences; `\\(` for the lambda is one backslash escaped as JSON; `\"` inside strings.
- The vscode-test compiled output sometimes lags behind source. If tests report stale failures, run `bun run compile:test` again before re-running.
- If the test placeholder-grammar regex needs adjustment (e.g., to allow placeholder choices like `${1|foo,bar|}`), that's a forward-compat concern — we don't ship any choice placeholders, so the simple regex is fine for the 65 entries.
