# Tidyverse Corpus Triage Implementation Plan (issue #423)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-idiom triage of the 986 tidyverse known-FP ledger entries (replacing disjunctive catch-all reasons with one-idiom classifications), fixing Raven where a cluster is a fixable bug, verifying the 5 accepted-real entries, and keeping the full 4-group strict corpus run green.

**Architecture:** Cluster-based review. Group the 986 entries by (package, path, message-kind), fetch the real package sources once with `RAVEN_CORPUS_KEEP_TEMP=1`, dispatch parallel read-only review agents per package to classify each entry against the actual code site, then apply the classifications to the TOML with a block-preserving rewrite script. Fixable clusters become TDD'd Raven fixes; cleared entries are pruned and confirmed by a strict re-run.

**Tech Stack:** Rust (raven), Python 3 (tomllib for analysis; line-based rewrite for edits), cargo test corpus harness.

**Branch:** `triage/tidyverse-corpus` (worktree via superpowers:using-git-worktrees).

---

## Background facts (verified 2026-06-10)

- Ledger: `crates/raven/tests/fixtures/package_corpus/known_false_positives.toml` (2422 entries, 986 in tidyverse-group packages).
- Accepted-real: `crates/raven/tests/fixtures/package_corpus/accepted_real_diagnostics.toml` (72 entries, 5 tidyverse: ggplot2 geom-text.R mixed-precedence, lubridate coercion.r `class(x)` param mismatch, dbplyr verb-pivot-wider.R `error_call` ×2, httr demo/oauth2-yelp.R `token`).
- Tidyverse packages with FP entries (27): broom 69, cli 173, dbplyr 59, dplyr 170, dtplyr 32, forcats 17, ggplot2 34, googledrive 46, googlesheets4 10, haven 1, httr 42, lubridate 13, magrittr 14, modelr 6, pillar 7, purrr 8, ragg 31, readr 6, readxl 4, reprex 4, rlang 164, rvest 24, stringr 5, tibble 8, tidyr 33, tidyverse 3, xml2 3.
- Catch-all / disjunctive reasons to eliminate (tidyverse counts):
  - `Test file referencing fixture data, package dataset, or data-masked column` (289)
  - `Vignette cross-chunk variable or attached package dataset` (85)
  - `Runtime-context dependency not resolvable statically` (76)
  - any other reason naming ≥2 alternative idioms with "or"
- Corpus runner: `crates/raven/tests/package_corpus.rs`. Strict tidyverse run:
  `cargo build --release -p raven && RAVEN_CORPUS_GROUPS=tidyverse cargo test --release -p raven --test package_corpus -- --ignored --nocapture`
- `RAVEN_CORPUS_KEEP_TEMP=1` preserves fetched sources; the run prints `package corpus kept temp root: <path>`.

## Candidate fixable clusters (decide at Task 5 checkpoint with real-site evidence)

- magrittr pipe dot placeholder (10 entries) — `.` inside `x %>% f(.)` chains.
- R6 class method `self`/`private` (57 entries) — bind `self`/`private` inside functions appearing in `R6Class(...)` `public =`/`private =`/`active =` lists.
- Vignette cross-chunk variables (85 + 37 man-page Rmd) — Rmd chunks are first-class in Raven (cross-chunk scope should already work); investigate why these sites flag before assuming inherent.

Everything else observed so far (sysdata.rda internal data, NAMESPACE importFrom without installed package, eval/parse dynamic code, exec/ scripts run with the package attached) is presumed an inherent static-analysis limitation: keep ledger entries, make reasons specific.

---

### Task 1: Worktree, branch, baseline strict run

**Files:** none modified.

- [ ] **Step 1.1:** Create isolated worktree + branch `triage/tidyverse-corpus` (superpowers:using-git-worktrees).
- [ ] **Step 1.2:** Build release binary: `cargo build --release -p raven`. Expected: success on toolchain 1.96.0.
- [ ] **Step 1.3:** Baseline strict run, keeping sources:

```bash
RAVEN_CORPUS_GROUPS=tidyverse RAVEN_CORPUS_KEEP_TEMP=1 \
  cargo test --release -p raven --test package_corpus -- --ignored --nocapture 2>&1 | tee /tmp/tidyverse-baseline.log
```

Expected: PASS, `0 unclassified`, and a line `package corpus kept temp root: <TEMP>`. Record `<TEMP>` — every later task reads package sources from `<TEMP>/sources/<cache-key>/`.

### Task 2: Cluster manifest

**Files:** Create (throwaway, not committed): `/tmp/tidyverse-clusters.json`

- [ ] **Step 2.1:** Emit one JSON record per tidyverse FP entry with package, path, range, message, current reason, plus a cluster key `(package, path, message-prefix)`:

```python
#!/usr/bin/env python3
# /tmp/make_clusters.py
import tomllib, json, collections
TIDY = {'broom','cli','conflicted','dbplyr','dplyr','dtplyr','forcats','ggplot2',
        'googledrive','googlesheets4','haven','hms','httr','jsonlite','lubridate',
        'magrittr','modelr','pillar','purrr','ragg','readr','readxl','reprex',
        'rlang','rstudioapi','rvest','stringr','tibble','tidyr','tidyverse','xml2'}
with open('crates/raven/tests/fixtures/package_corpus/known_false_positives.toml','rb') as f:
    fps = tomllib.load(f)['false_positive']
recs = []
for i, e in enumerate(fps):
    if e['package'] not in TIDY: continue
    msg = e['message']
    kind = msg.split(':')[0] if ':' in msg else msg[:40]
    recs.append({'package': e['package'], 'path': e['path'], 'message': msg,
                 'reason': e['reason'], 'range': e['range'], 'kind': kind})
by_pkg = collections.defaultdict(list)
for r in recs: by_pkg[r['package']].append(r)
json.dump(dict(by_pkg), open('/tmp/tidyverse-clusters.json','w'), indent=1)
print(len(recs), 'entries,', len(by_pkg), 'packages')
```

Run: `python3 /tmp/make_clusters.py`. Expected: `986 entries, 27 packages`.

### Task 3: Per-package site review (parallel subagents)

**Files:** Create (throwaway): `/tmp/review/<package>.json`

- [ ] **Step 3.1:** Dispatch read-only review agents in batches (≤6 concurrent), one per package (batch tiny packages together). Each agent gets: its package's records from `/tmp/tidyverse-clusters.json`, the source root `<TEMP>/sources/...`, and these instructions:
  - For every entry, open the file at the diagnostic range and identify the *single concrete idiom* that makes the code correct despite the diagnostic. Name the construct (e.g. "testthat fixture loaded by helper-*.R", "dplyr data-masked column in across()", "knitr child chunk", "R6 self in public method", "eval(parse()) codegen").
  - Output per entry: `{path, start_line, message, idiom, fixable: yes/no/maybe, fix_note, misfiled_real: bool, evidence}` — `misfiled_real` when the code is actually buggy and the entry belongs in accepted-real.
  - Group identical idioms; do NOT invent disjunctive reasons ("X or Y" is forbidden).
- [ ] **Step 3.2:** Validate every entry got a verdict: total across `/tmp/review/*.json` == 986.

### Task 4: Verify the 5 accepted-real entries

- [ ] **Step 4.1:** For each of the 5 entries listed in Background, open the fetched source at the recorded range and confirm the evidence still holds (genuine upstream bug, not an FP). Record confirm/refute + one-line justification each.
- [ ] **Step 4.2:** If any is refuted, move it to the FP ledger with a specific reason (same rewrite mechanism as Task 6).

### Task 5: Fix/no-fix decision checkpoint

- [ ] **Step 5.1:** Aggregate idiom clusters across packages; for each cluster decide: **fix Raven** (clear root cause in Raven's model, contained change, testable per surface) or **keep ledger** (inherent limitation). Use the candidate list in Background as the starting hypothesis set; require site evidence from Task 3.
- [ ] **Step 5.2:** For each chosen fix, append a TDD fix task to this plan (failing unit test in the owning module + e2e per surface: editor diagnostics via handlers tests, `raven check` via CLI test, Rmd chunk surface where applicable — see memory: Rmd chunks first-class). Each fix task ends with pruning its cleared ledger entries and a tidyverse strict re-run.
- [ ] **Step 5.3:** Commit checkpoint: cluster manifest results summarized in the PR description draft, no code yet.

### Task 6: Apply specific reasons to the ledger

**Files:** Modify: `crates/raven/tests/fixtures/package_corpus/known_false_positives.toml`

- [ ] **Step 6.1:** Build `/tmp/reasons.json` mapping `(package, path, start_line, start_character, message) -> new_reason` from `/tmp/review/*.json` (apply a controlled vocabulary: one idiom per reason string, reuse identical strings across packages).
- [ ] **Step 6.2:** Rewrite reasons block-preserving (no TOML re-serialization; only `reason = ` lines change):

```python
#!/usr/bin/env python3
# /tmp/apply_reasons.py
import json, re, sys
path = 'crates/raven/tests/fixtures/package_corpus/known_false_positives.toml'
mapping = {tuple(k.split('\x00')): v for k, v in json.load(open('/tmp/reasons.json')).items()}
lines = open(path).read().split('\n')
out, i, applied = [], 0, 0
cur = {}
def flush_block(block):
    global applied
    key = (cur.get('package'), cur.get('path'), cur.get('sl'), cur.get('sc'), cur.get('message'))
    new = mapping.get(key)
    if new is None: return block
    applied += 1
    return [re.sub(r'^reason = ".*"$', 'reason = ' + json.dumps(new), l) for l in block]
block = []
for line in lines:
    if line == '[[false_positive]]' and block:
        out.extend(flush_block(block)); block = []; cur = {}
    block.append(line)
    m = re.match(r'^(package|path|message) = "(.*)"$', line)
    if m: cur[m.group(1)] = m.group(2).encode().decode('unicode_escape')
    m = re.match(r'^start_line = (\d+)$', line)
    if m: cur['sl'] = m.group(1)
    m = re.match(r'^start_character = (\d+)$', line)
    if m: cur['sc'] = m.group(1)
out.extend(flush_block(block))
open(path, 'w').write('\n'.join(out))
print('applied', applied)
```

Expected: `applied` == number of mapped entries (== 986 minus entries pruned by fixes).
- [ ] **Step 6.3:** Sanity: `python3 -c "import tomllib; d=tomllib.load(open('crates/raven/tests/fixtures/package_corpus/known_false_positives.toml','rb')); print(len(d['false_positive']))"` parses and count is unchanged.
- [ ] **Step 6.4:** Grep gate for acceptance criterion 1 — zero disjunctive reasons among tidyverse entries (script: list tidyverse reasons containing `" or "`). Expected: none.
- [ ] **Step 6.5:** Strict tidyverse re-run (reasons don't affect matching, this guards against typos breaking entry identity):

```bash
RAVEN_CORPUS_GROUPS=tidyverse cargo test --release -p raven --test package_corpus -- --ignored --nocapture
```

Expected: PASS, 0 unclassified, 0 stale.
- [ ] **Step 6.6:** Commit: `corpus: per-idiom reclassification of tidyverse known-FP ledger (#423)`.

### Task 7: Full 4-group strict run

- [ ] **Step 7.1:**

```bash
RAVEN_CORPUS_GROUPS=base,recommended,tidyverse,dt \
  cargo test --release -p raven --test package_corpus -- --ignored --nocapture 2>&1 | tee /tmp/full-strict.log
```

Expected: 61 packages, 0 unclassified / 0 stale acceptances / 0 stale FPs.

### Task 8: Docs + checkpoint update

**Files:** Modify: `docs/package-corpus-checkpoint.md`

- [ ] **Step 8.1:** Replace the `### Tidyverse (31 packages)` section ("Not yet triaged") with the triage summary (counts per idiom cluster, fixes landed, final accepted/FP counts). Update header totals (72 accepted / 2422 FP) if they changed. Remove `Triage tidyverse package group` from Remaining work. Update Validation numbers from the Task 7 log.
- [ ] **Step 8.2:** If any Raven fix changed user-visible diagnostics behavior, update `docs/diagnostics.md` (and `docs/cross-file.md` if scope semantics changed).
- [ ] **Step 8.3:** Commit: `docs: record tidyverse corpus triage in checkpoint`.

### Task 9: CI gates + PR

- [ ] **Step 9.1:** `cargo fmt --all` then `cargo fmt --all --check`. Expected: clean.
- [ ] **Step 9.2:** `cargo clippy --workspace --all-targets --features test-support -- -D warnings`. Expected: zero warnings.
- [ ] **Step 9.3:** `cargo test -p raven` (non-ignored suite). Expected: all pass.
- [ ] **Step 9.4:** Push branch; `gh pr create` with summary: triage methodology, idiom-cluster table, fixes landed (with test coverage per surface), accepted-real verification verdicts, strict-run results. Link `Closes #423`.
