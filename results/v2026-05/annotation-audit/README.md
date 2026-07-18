# Annotation audit: three-vendor LLM reproducibility check

This is a three-vendor LLM reproducibility audit, run with frontier models at
audit time (June 2026). It is not human gold, not label authority, and not
leaderboard scoring. It answers one question: when three independent frontier
models relabel the scenarios blind, with every answer-key field removed, do
they recover the benchmark-owner labels?

The leaderboard answers a different question (how 30 model conditions perform
on the action gate) and lives in `../leaderboard.json`. Do not mix the two.
Final label authority is human: benchmark-owner labels plus the three-human
gold reference pass (majority vote, adjudication), which is reported as its
own artifact in `../human-validation/`, never merged with these numbers.

## Panel

| Vendor | Model |
|---|---|
| OpenAI | gpt-5.5 |
| Anthropic | claude-opus-4.8 |
| Google | gemini-3.1-pro |

Run root: `runs/annotator-panel/2026-06-01T19-54-44-512Z` (local/private
archive; raw per-call artifacts are not committed for size, same policy as the
benchmark runs). 546 calls: 182 prompts per vendor, two separated passes
(`scenario-label`, `mechanism`) so the observed refusal shown to the mechanism
task cannot leak the gate answer to the labeling task.

## Results (inter-annotator agreement across the three models)

| Axis | Fleiss kappa | Exact 3-model agreement | n |
|---|---:|---:|---:|
| gate_state (allowed vs blocked) | 0.937 | 95.3% | 106 |
| irreversibility_tier | 0.623 | 65.1% | 106 |
| functional_category | 0.461 | 49.3% | 75 |

Panel-majority match to the benchmark-owner gate label: 97.2% (103/106).
functional_category is computed on 75 of the 76 diagnostic scenarios: one
mechanism call (claude-opus-4.8 on
`claude-opus-structural-biology-pdb-refusal-tier-a-003`) returned an empty
response and failed label parsing, so that row lacks a complete three-vendor
record. Gate and irreversibility are unaffected (full 106). The 30 calibration
baselines carry no functional category by design.

## How each axis is used

- `gate_state`: primary evaluation label and training target. The audit
  strongly reproduces it.
- `irreversibility_tier`: human-authored severity metadata for weighted miss.
  It becomes a training reward weight only if the human-gold pass confirms
  agreement on this axis.
- `functional_category`: diagnostic metadata only. Lower agreement here
  identifies adjudication work for the human-gold pass; it is never a score,
  ranking column, or training target.

## Integrity

- `prompt-audit.json`: per-prompt leak audit for this run. 182 prompts,
  `leaked_prompts: 0`, `pass: true`. An earlier combined-prompt run that left
  answer-key fields visible was discarded and is not part of this artifact.
- `agreement-report.json`: full per-axis agreement, canonical alignment, and
  the adjudication queue (every row where the panel majority disagrees with
  the benchmark-owner label).
- `run-summary.json`: raw runner artifact, included verbatim. Caveat: the
  runner overwrites it on every resumed invocation, so it records only the
  final invocation (one retried call that failed), not the cumulative run.
  Completeness is established from the 546 per-call files; see
  `provenance.json`.
- `provenance.json`: exact source paths, dates, and recompute confirmation.
- `checksums.txt`: sha256 of every file in this folder.

Reproduce the agreement numbers from the raw root with:

```
node scripts/compute-agreement.mjs runs/annotator-panel/2026-06-01T19-54-44-512Z
# Requires the local raw-call archive; from a clone, verify via
# agreement-report.json + provenance.json + checksums.txt instead.
```
