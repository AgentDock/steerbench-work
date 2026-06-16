# Tinker cookbook smoke report

Exports produced by this repo were loaded through the official
tinker-cookbook dataset builders. No training run was started; the deepest
step is building one tokenized training datum in memory.

## Environment

- python 3.13.11 (venv), tinker SDK 0.22.3 (PyPI), tinker-cookbook 0.4.2
  (github.com/thinking-machines-lab/tinker-cookbook @ 26ae14b, installed
  --no-deps -e), torch 2.12.0, transformers <=5.5.3, datasets, blobfile,
  chz, pillow, tiktoken.

## Inputs under test

- /tmp/accept-sft/sft.jsonl: full 106-row export from
  `node scripts/export-sft.mjs --scenario-set-dir scenario-sets/steerbench-work-2026-05 --out /tmp/accept-sft`
- sample-artifacts/training-views-sample/sft.sample.jsonl (committed 12-row sample)
- /tmp/accept-pref/all.jsonl: 360 pairs from
  `node scripts/export-preferences.mjs --runs-dir runs --scenario-set-dir scenario-sets/steerbench-work-2026-05 --max-pairs-per-scenario 6 --seed 1 --out /tmp/accept-pref`

## Results

| Check (official cookbook code path) | Result |
|---|---|
| FromConversationFileBuilder on the full 106-row SFT export | PASS, dataset built, 106 rows |
| FromConversationFileBuilder on the committed 12-row sample | PASS |
| Negative control: line without "messages" | PASS, official DataFormatError raised |
| Tokenized Datum via renderer "qwen3" + Qwen/Qwen3-8B tokenizer | PASS, Datum built, model_input 708 tokens |
| Comparison / LabeledComparison objects from our pairs | PASS, 25/25 constructed |
| ComparisonBuilderFromJsonl.get_train_and_test_datasets on our pairs | PASS, 360 rows loaded |
| example_to_labeled_comparison over 50 rows | PASS, labels A/B only, no Tie |
| Reward adapter vs official ProblemEnv method surface | PASS, get_question / check_answer / check_format present |

## Notes and limits

- Renderer warning observed: train_on_what=ALL_ASSISTANT_MESSAGES with the
  qwen3 renderer lacks the extension property. Benign for these exports:
  every row holds exactly one assistant message, so ALL_ASSISTANT_MESSAGES
  and LAST_ASSISTANT_MESSAGE select the same tokens. A future training run
  should still set train_on_what explicitly.
- Labels in all inputs are pre-gold (label_source benchmark-owner-pre-gold);
  artifacts regenerate after the three-rater human validation pass.
- No Tinker account, API key, or paid training run was used. The only
  network fetch was the public Qwen tokenizer from Hugging Face.

## Replaying this smoke

The exact test is checked in at `integrations/tinker/run_cookbook_smoke.py`;
its module docstring carries the one-time environment setup and the two
export commands that produce the inputs. From the repo root:

```bash
/tmp/tinker-venv/bin/python integrations/tinker/run_cookbook_smoke.py
```

Exit code 0 with `7 pass / 0 fail` reproduces every row of the results
table above (the loader and label checks on the pairs file run as one
combined check in the replay script, so 8 table rows map to 7 records).
