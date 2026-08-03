# SteerBench-Work release v2026-05 — artifact bundle

This folder is the compact, reproducible publication record. The site, paper,
and leaderboard numbers are generated from here.

## Files
- `leaderboard.json` — published rows with metrics + Wilson 95% CIs.
- `scenarios-detail.json` — per-scenario, per-model verdicts and trial splits.
- `overlay-manifest.json` — per (row, scenario) chain of evidence: source root,
  source run id, scenario hash used vs current file hash, prompt hash, config hash.
- `overlay-validator-report.json` — proves every published cell scored the
  current source file (hash match) and recomputes from its trial files.
- `repair-summary.json` — the six-scenario repair: scope, cost, integrity,
  modal flips, before/after headline numbers.
- `release-manifest.json` — scenario hashes, prompt hash, row roster.
- `annotation-audit/` — the three-vendor LLM annotation reproducibility audit
  (agreement report, leak audit, provenance, own checksums). Validation
  evidence for the labels, not leaderboard scoring or label authority. The
  separate three-rater majority is reported as unadjudicated corroboration in
  `human-validation/`. See `annotation-audit/README.md`.
- `checksums.txt` — sha256 of every file in this bundle, including the
  `annotation-audit/` files.

## Provenance model
Raw per-trial request/response artifacts are NOT committed to the main repo
(size). They live in the local/private archive under `runs/`. For the 27
original rows, each published row is an explicit overlay: 100 cells from the
original locked run + 6 cells from the six-scenario repair run, with per-cell
provenance preserved (no run id rewritten). New rows (e.g. claude-opus-4.8 high)
are full native 106-scenario runs against the current source files.

## Integrity claim
Every published number re-derives from `scenarios-detail.json`, and every cell's
scenario hash matches the current source file. Verified by the overlay validator
and the fabrication gate.
