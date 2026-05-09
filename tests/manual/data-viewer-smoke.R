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


# ── 2. NHANES via haven (variable labels only) ────────────────────────────────
# SAS XPORT files carry variable labels but not value labels — those live in a
# separate SAS format catalog (.sas7bcat) that NHANES doesn't ship. Use this
# section to exercise variable labels; section 2b below exercises value labels.
if (requireNamespace("haven", quietly = TRUE)) {
  # Downloads ~500 KB; skip if already cached.
  url  <- "https://wwwn.cdc.gov/Nchs/Data/Nhanes/Public/2017/DataFiles/DEMO_J.xpt"
  dest <- tempfile(fileext = ".xpt")
  download.file(url, dest, mode = "wb")
  nhanes <- haven::read_xpt(dest)

  View(nhanes)
  # Expected:
  #   hover a column header  → tooltip shows "<NAME>: <variable label>"
  #                            (e.g. "RIAGENDR: Gender")
  #   Labels toggle ON       → no visible change (NHANES XPT has no value labels)
} else {
  message("Skipping NHANES section: install 'haven' to run it.")
}


# ── 2b. Synthetic haven_labelled (variable labels + value labels) ─────────────
# Builds a tibble with explicit value labels so the Labels toggle has something
# to swap in. Stand-in for a haven::read_sav / read_dta workflow without needing
# a real .sav / .dta file on disk.
if (requireNamespace("haven", quietly = TRUE)) {
  labelled_demo <- data.frame(
    id       = 1:6,
    sex      = haven::labelled(
      c(1, 2, 1, 2, 1, 2),
      labels = c(Male = 1, Female = 2),
      label  = "Sex of the participant"
    ),
    handedness = haven::labelled(
      c(1L, 2L, 1L, 3L, 2L, 1L),
      labels = c(Right = 1L, Left = 2L, Ambidextrous = 3L),
      label  = "Self-reported handedness"
    ),
    score    = c(0.71, 0.42, 0.85, 0.13, 0.66, 0.30)
  )

  View(labelled_demo)
  # Expected:
  #   hover "sex" header     → tooltip shows "sex: Sex of the participant"
  #   Labels toggle ON       → sex column shows "Male" / "Female" instead of 1 / 2
  #                            handedness shows "Right" / "Left" / "Ambidextrous"
  #   Labels toggle OFF      → numeric codes are visible again
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
