# Test fixture: nonexistent_sentinel_var is intentionally undefined (sentinel for diagnostics).
# ddply() depends on plyr being inherited from the sibling source() chain — see lsp.test.ts.
z <- nonexistent_sentinel_var + 1
result <- ddply(mtcars, "cyl", identity)
