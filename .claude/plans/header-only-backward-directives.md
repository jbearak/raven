# Header-Only Backward Directives

## Goal

Match Sight's behavior: backward directives (`@lsp-sourced-by`, `@lsp-run-by`, `@lsp-included-by`) and working directory directives (`@lsp-cd`, `@lsp-wd`, etc.) must appear in the file header — before any code. Forward directives, declaration directives, and ignore directives remain full-file.

## What Sight does

Sight defines the "header" as consecutive blank and comment lines from the start of the file. Parsing stops at the first non-blank, non-comment line. For R, a comment line starts with `#` (after optional whitespace).

| Directive type | Sight location | Raven current | Raven proposed |
|---|---|---|---|
| Backward (`@lsp-sourced-by`, etc.) | Header only | Anywhere | **Header only** |
| Working directory (`@lsp-cd`, etc.) | Header only | Anywhere | **Header only** |
| Forward (`@lsp-source`, etc.) | Anywhere | Anywhere | Anywhere (no change) |
| Declaration (`@lsp-var`, `@lsp-func`) | Anywhere | Anywhere | Anywhere (no change) |
| Ignore (`@lsp-ignore`, `@lsp-ignore-next`) | Anywhere | Anywhere | Anywhere (no change) |

## Implementation

### Single-pass with header tracking in `parse_directives`

Add a `in_header` boolean flag. On each line (before the `@lsp-` pre-filter), check whether the trimmed line is blank or starts with `#`. On the first line that is neither, set `in_header = false`. Only check backward and working-dir patterns while `in_header` is true.

```rust
let mut in_header = true;

for (line_num, line) in content.lines().enumerate() {
    let line_num = line_num as u32;

    // Track header boundary (before @lsp- pre-filter)
    if in_header {
        let trimmed = line.trim();
        if !trimmed.is_empty() && !trimmed.starts_with('#') {
            in_header = false;
        }
    }

    if !line.contains("@lsp-") {
        continue;
    }

    // Header-only directives
    if in_header {
        // Check backward directives
        // Check working directory directive
    }

    // Full-file directives (always checked)
    // Check forward, ignore, ignore-next, declare-var, declare-func
}
```

### Why single-pass, not two passes

- More efficient (one iteration)
- The `in_header` flag adds negligible cost (a trim + two checks per line)
- The `@lsp-` pre-filter already means we skip most non-directive lines for regex work
- Cleaner code: no need to split directive types across two functions

### Tests to update

No existing tests have backward or working-dir directives after code lines. The existing tests already place them at the top. The `test_multiple_directives` test has backward + wd in the header and forward after code — perfectly aligned with the new behavior.

New tests to add:
1. Backward directive after code line → not recognized
2. Working directory directive after code line → not recognized
3. Backward directive with blank lines and comments before code → recognized
4. Forward directive after code → still recognized (no change)
5. Declaration directive after code → still recognized (no change)

### Documentation updates

1. `docs/cross-file.md`: Document that backward and working-dir directives must appear in the file header (before any code). Define "header" as consecutive blank/comment lines from start of file.
2. `CLAUDE.md` learnings: Add note about header-only constraint for backward/wd directives.
