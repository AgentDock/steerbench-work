# Category Lineage

One-page map of how SteerBench-Work's 4-axis classification is built on top of the published refusal, abstention, and agent-safety literature.

## What changed and why

The first draft of SteerBench-Work had six functional categories on Axis 2: `procedural-authorization`, `surface-pattern-match`, `scheduling-vs-interactive`, `bounded-mechanical`, `evidence-incompleteness`, `lexical-overfitting`. Two of these (`lexical-overfitting`, `evidence-incompleteness`) had clean prior-art anchors. Four (`procedural-authorization`, `surface-pattern-match`, `scheduling-vs-interactive`, `bounded-mechanical`) were coined locally and would fail a reviewer-recognition check.

The revised taxonomy collapses the six into four categories that every category name is the exact term used by an existing published paper.

## Old -> new mapping

| Old (coined) | New (published) | Citation that names the new term |
|---|---|---|
| `lexical-overfitting` | `lexical-overfitting` (KEEP, already a published term) | Röttger et al. NAACL 2024, [arxiv 2308.01263](https://arxiv.org/abs/2308.01263) |
| `surface-pattern-match` | merges into `lexical-overfitting` for 9 of 10 cases; 1 case (`calendar-invite-prompt-injection-004`) reclassifies to `instruction-hierarchy-confusion` because it is an indirect-prompt-injection scenario, not a keyword-match scenario | Röttger et al. NAACL 2024 for the merge; Greshake et al. AISec '23 + Wallace et al. 2024 for the reclassified case |
| `procedural-authorization` | `instruction-hierarchy-confusion` | Wallace, Xiao, Leike, Weng, Heidecke, Beutel 2024, [arxiv 2404.13208](https://arxiv.org/abs/2404.13208) |
| `scheduling-vs-interactive` | merges into `instruction-hierarchy-confusion`; the single corpus case (`secret-rotation-in-vault-adversarial-008`) is the agent failing to recognize a signed scheduler service account as a higher-trust principal | Wallace et al. 2024 (signed scheduler payload is a privileged-instruction signal) |
| `bounded-mechanical` | `unwarranted-abstention` | Wen et al. TACL 2024, [arxiv 2407.18418](https://arxiv.org/abs/2407.18418); reinforced by Mu, Helyar, Schulman, Weng et al. NeurIPS 2024, [arxiv 2411.01111](https://arxiv.org/abs/2411.01111) |
| `evidence-incompleteness` (under-refusal direction) | `missing-information` | Scale Labs HiL-Bench 2026, [arxiv 2604.09408](https://arxiv.org/abs/2604.09408) |
| `evidence-incompleteness` (over-refusal direction) | reclassifies to `unwarranted-abstention` because the agent refuses despite verifiable-complete evidence (Robodebt-mirror, Horizon-mirror, Bard-mirror are signed-pass-then-refuse cases) | Wen et al. TACL 2024 |

## Per-category citation chain

### `lexical-overfitting`

```
XSTest (Röttger et al. NAACL 2024)
    "overly simplistic and superficial decision rules"
        |
        | (we extend from chat-prompt to agent-action setting)
        v
SteerBench-Work `lexical-overfitting`
    surface keyword | file path | category label | integrity-flag name | numeric heuristic
```

Old terms collapsed in: `lexical-overfitting` (verbatim keep) + `surface-pattern-match` (9 of 10 cases).

### `instruction-hierarchy-confusion`

```
Greshake et al. (AISec '23)                Wallace et al. (2024)             RBR (Mu/Schulman/Weng, NeurIPS 2024)
"indirect prompt injection"                "instruction hierarchy"          response classes `Comply` / `Hard Refuse`
"untrusted text inherits role authority"   system > user > tool             metric: Not-Overrefuse on authorized requests
                          \                       |                                  /
                           \                      v                                 /
                            \           SteerBench-Work `instruction-hierarchy-confusion`         /
                              under-refusal direction: lower-trust input promoted to authority
                              over-refusal direction: higher-trust signed grant ignored
```

Old terms collapsed in: `procedural-authorization` (all 19 cases) + `scheduling-vs-interactive` (1 case) + `surface-pattern-match` (1 indirect-injection case).

### `missing-information`

```
HiL-Bench (Scale Labs 2026)
three blocker types: missing information / ambiguous / contradictory
the agent skill: "selective escalation"
        |
        | (we extend from coding+text-to-SQL domains to high-impact agent actions)
        v
SteerBench-Work `missing-information`
    missing supervisor approval | missing per-recipient eligibility |
    missing fairness audit | missing citation verification | missing liquidity gate |
    missing per-document consent | missing regulator-clearance step
```

Old terms collapsed in: `evidence-incompleteness` (under-refusal direction, all 16 cases).

### `unwarranted-abstention`

```
Wen et al. (TACL 2024) survey                       RBR (Mu/Schulman/Weng, NeurIPS 2024)
"over-abstention: abstain unnecessarily"           "Not-Overrefuse" metric
"insufficient confidence" perspective              behavior class `Comply`
                          \                          /
                           \                        /
                            v                      v
                    AbstentionBench (Meta 2025). operationalization
                    "abstention warranted vs unwarranted"
                                   |
                                   | (we extend from question-answering abstention to
                                   |  agent-action abstention over signed-pass evidence)
                                   v
                  SteerBench-Work `unwarranted-abstention`
                  diff stat signed pass | bounded translation chunk |
                  fact-check signed pass | regulatory-eligibility signed pass |
                  reconciliation report signed pass | dual-control signed pass
```

Old terms collapsed in: `bounded-mechanical` (all 11 cases) + `evidence-incompleteness` (over-refusal direction, 3 cases).

## Citation graph: how our 4 axes extend HiL-Bench's 3 axes

HiL-Bench's evaluation is structured on three axes: blocker type (missing / ambiguous / contradictory), domain (SWE vs text-to-SQL), and the Ask-F1 metric (precision x recall of when to ask).

SteerBench-Work's evaluation is structured on four axes:

```
                  HiL-Bench (Scale Labs 2026)                       SteerBench-Work
                  ----------------------------                       ----------------------------
Axis 1            blocker type (3 values)                            direction (2 values)
                                                                     -- under-refusal: agent acted
                                                                     -- over-refusal: agent refused
                                                                     borrowed from OR-Bench
                                                                     (Cui et al. ICML 2025)
                                                                     and RBR (Mu et al. NeurIPS 2024)

Axis 2            (implicit, single failure mode)                    functional_category (4 values)
                                                                     -- lexical-overfitting (XSTest)
                                                                     -- instruction-hierarchy-confusion
                                                                        (Wallace et al. 2024)
                                                                     -- missing-information (HiL-Bench)
                                                                     -- unwarranted-abstention
                                                                        (Wen et al. TACL 2024)

Axis 3            domain (2 values: SWE, text-to-SQL)                domain (12 values)
                                                                     extended to high-impact
                                                                     agent settings: medical, legal,
                                                                     financial, safety-critical, etc.

Axis 4            (implicit, all author-constructed)                 source_provenance (5 values)
                                                                     -- real-world-cited (49)
                                                                     -- incident-mirror (13)
                                                                     -- benchmark-adapted (5)
                                                                     -- literature + analogous incident (1)
                                                                     -- author-constructed (8)
                                                                     mirror methodology adapted from
                                                                     XSTest's contrast-pair design
```

The Axis-2 expansion is the substantive extension. HiL-Bench tests one failure mode (the agent does not ask for help when it should). SteerBench-Work tests four, anchored to four prior papers, and orthogonalizes them against the over/under direction so each cell is its own evaluation cell.

The Axis-4 expansion (source_provenance) borrows the mirror methodology from XSTest's pairing of safe-prompts with structurally-matched unsafe-prompts, and extends it to incident mirrors: every `incident-mirror` row is the deliberate inverse-verification-state of a `real-world-cited` row sharing the same surface shape.

## Provenance pointers, one citation per old term

- "exaggerated safety" / "over-refusal" / "false refusal" framing: Röttger et al. NAACL 2024 (XSTest); Cui et al. ICML 2025 (OR-Bench); Mu et al. NeurIPS 2024 (RBR); Han et al. 2024 (WildGuardMix, [arxiv 2406.18495](https://arxiv.org/abs/2406.18495)).
- "lexical overfitting" / "superficial decision rules": Röttger et al. NAACL 2024.
- "instruction hierarchy" / "privileged instructions" / "role confusion": Wallace, Xiao, Leike, Weng et al. 2024; Lin et al. 2026 ([arxiv 2603.12277](https://arxiv.org/abs/2603.12277)); Greshake et al. AISec '23.
- "missing information" / "selective escalation" / "help-seeking calibration": Scale Labs HiL-Bench 2026.
- "abstention" / "over-abstention" / "under-abstention": Wen et al. TACL 2024; AbstentionBench (Feng et al. Meta FAIR 2025, [arxiv 2506.09038](https://arxiv.org/abs/2506.09038)).
- "when not to call" / "follow-up question" / "unable to answer": NVIDIA When2Call 2025 ([arxiv 2504.18851](https://arxiv.org/abs/2504.18851)).
- "irrelevance detection" / "relevance detection": Berkeley Function-Calling Leaderboard ([leaderboard](https://gorilla.cs.berkeley.edu/leaderboard.html)).
- "interactivity" / "steering agents during long-horizon tasks" / "real-time presence vs background reasoning": active research area covering how human users supervise and redirect agents mid-task.

Every functional-category name in `taxonomy.functional_category` resolves to one of the citations above.
