# Annotation

Two different things in this project get checked by humans, because two
different things can be wrong. Do not confuse them.

| | Verdict validation pass | Step-evidence gold set |
|---|---|---|
| What is judged | The scenarios themselves: is proceed-or-hold the right answer for each one? | Model outputs: did a model's written rationale use a specific evidence item? |
| Tool | `scripts/label.mjs` (terminal) | `scripts/label-web.mjs` (browser) |
| Raters | Three, anonymized ids | Three, anonymized ids |
| What it protects | The benchmark's own answer keys | The process-reward path: an automated step grader is trusted only after it matches these human answers at 0.75 Fleiss kappa or better |

The three-vendor model panel (`scripts/run-annotators.mjs`) is neither of
these. It is the cheap reproducibility check that runs beside the human
passes: humans are the authority, the panel measures whether labels are
independently derivable at scale. The same division applies to steps: the
human-annotated gold labels are the reference, and a model-based step grader,
once validated against them, does the high-volume grading. That grader uses the
runner's existing key setup (`OPENAI_API_KEY`, `AI_GATEWAY_API_KEY` in
`.env`), the same way the panel already does.

## There is no database

An answer is one appended line in `annotations/step-labels.<rater>.jsonl`.
A flag is the same kind of line with `"flag"` as the value. The
"adjudication queue" is a list of card ids inside a report file that
`scripts/step-label-report.mjs` writes when someone runs it. Review means
a person opens that report and looks at the listed cards. Files in a
folder, every answer hash-bound to the exact card it judged; the
`annotations/` folder is gitignored local working data, like `runs/`.

## Files in this folder

| File | What it is |
|---|---|
| `ANNOTATION_GUIDELINES.md` | The rater-facing rules for the step-evidence task. Pilot-seed draft; rebuilt from the owner pilot before any qualifying pass |
| `calibration-queue.jsonl` | Settled practice cards (currently nine, target about twenty after the owner pilot) |
| `calibration-key.json` | Their answers with reasons. Draft until both benchmark owners adjudicate it |

## How a rater works (the runbook)

1. Receive the repository and your anonymized rater id.
2. Read `ANNOTATION_GUIDELINES.md`, then qualify:
   `node scripts/label-web.mjs --queue docs/annotation/calibration-queue.jsonl --calibration-key docs/annotation/calibration-key.json`
   The finish screen scores you; at or above 80% you proceed.
3. Label your assigned queue:
   `node scripts/label-web.mjs --queue <assigned-queue.jsonl>`
4. Return your single answer file, `annotations/step-labels.<your-id>.jsonl`.
   The hash on every line lets us verify it matches the queue exactly.

Do not discuss cards with other raters during a pass, and do not use AI
assistants to answer cards. The value of the gold set is independent
human judgment.

## Adjudication convention

Disagreements and flags surface in the report. Resolutions are recorded,
one line each, in `adjudications.jsonl` next to the labels:

```json
{"item_id": "...", "final_answer": "no", "reason": "one sentence", "resolved_by": "owner_1"}
```

Adjudication reasons seed the next guidelines version. Guidelines never
change during a pass.
