# Manual smoke tests for the data viewer — run by hand before declaring v1 done.
# Each section is independent; source individually or run interactively.

# ── 1. 10M-row × 50-column synthetic frame ────────────────────────────────────
# Scroll aggressively in the viewer; watch RSS stay bounded in Activity Monitor.
set.seed(42)
big <- as.data.frame(
  matrix(rnorm(10e6 * 50), nrow = 10e6, ncol = 50,
         dimnames = list(NULL, paste0("col", seq_len(50))))
)
View(big)


# ── 2. NHANES via haven (variable labels + Labels toggle) ─────────────────────
# install.packages("haven")   # if needed
if (requireNamespace("haven", quietly = TRUE)) {
  # Downloads ~500 KB; skip if already cached.
  url  <- "https://wwwn.cdc.gov/Nchs/Data/Nhanes/Public/2017/DataFiles/DEMO_J.xpt"
  dest <- tempfile(fileext = ".xpt")
  download.file(url, dest, mode = "wb")
  nhanes <- haven::read_xpt(dest)   # labelled vectors with variable-label attrs

  str(nhanes[1:3])            # confirm <labelled> with label attr

  View(nhanes)
  # Expected:
  #   hover a column header  → tooltip shows variable label
  #   Labels toggle ON       → numeric codes swap for label strings (e.g. 1 → "Male")
} else {
  message("Skipping NHANES section: install 'haven' to run it.")
}


# ── 3. Format toggle: digits=2 vs digits=6 ────────────────────────────────────
wide_floats <- data.frame(
  matrix(runif(500 * 8, min = 0, max = 1e6), nrow = 500,
         dimnames = list(NULL, paste0("x", seq_len(8))))
)
View(wide_floats)
# Use the Digits control in the viewer toolbar:
#   digits=2 → e.g. 123456.78
#   digits=6 → e.g. 123456.789012
# Verify column widths reflow correctly at both settings.


# ── 4. Copy 1000-row × 5-col selection → paste into spreadsheet ───────────────
copy_me <- data.frame(
  id      = seq_len(1000L),
  name    = paste0("item_", seq_len(1000L)),
  score   = round(rnorm(1000, mean = 50, sd = 10), 3),
  flag    = sample(c(TRUE, FALSE), 1000, replace = TRUE),
  created = as.Date("2024-01-01") + seq_len(1000L)
)
View(copy_me)
# Select all 1000 rows × 5 cols (click top-left, Shift+click bottom-right,
# or Ctrl/Cmd+A), then Ctrl/Cmd+C.
# Paste into Excel / Google Sheets / LibreOffice Calc.
# Expected: 5 tab-separated columns, 1000 data rows + 1 header row;
#           booleans, dates, and decimals round-trip without mangling.
