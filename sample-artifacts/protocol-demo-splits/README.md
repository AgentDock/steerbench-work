# Protocol demo: split assignment

`splits.protocol-demo.json` demonstrates the split-assignment protocol on the published steerbench-work-2026-05 set: scenarios group into families by `metadata.legacy_family || domain`, a seeded shuffle orders the families, and a greedy pack places whole families into train/val/test against the 70/15/15 targets while balancing the must-proceed/must-hold mix per split. Regenerate it with `node scripts/assign-splits.mjs --scenario-set-dir scenario-sets/steerbench-work-2026-05 --seed 1 --ratios 70/15/15 --out sample-artifacts/protocol-demo-splits/splits.protocol-demo.json`; the same seed always reproduces the same file.
What it demonstrates: determinism, whole-family integrity (no family straddles splits), and ratio plus direction balancing under whole-family granularity.

What it must never be cited as:
- a held-out test set, a sealed partition, or a binding evaluation contract;
- evidence of generalization for any model trained or tuned on these splits.

All 106 scenarios are public (CC BY 4.0, crawlable), so any recent model must be assumed to have seen every one of them. Direction labels derive from pre-gold owner labels (`label_source: benchmark-owner-pre-gold`). No training result will be reported against this file.
